import { Correlator } from "./correlate"
import { extractPodSignals, podMemoryLimits, extractDeploymentSignals, type EventLike, type PodLike, type DeploymentLike } from "./extract"
import { extractEventSignal } from "./extract"
import { decisionToAlert } from "./incident"
import { serviceNameFromLabels } from "./signal"
import type { Signal } from "./signal"
import type { IncidentSink } from "./sink"
import { PodServiceIndex } from "./service-index"
import { LogAnalyzer, type LogLine } from "./logs/analyzer"
import { RestartAccelerationMonitor, MemoryTrendMonitor } from "./leading"

// The Sentinel engine — the pure decision core the informer worker drives.
//
// The runtime (run.ts) owns the Kubernetes watch/I/O and simply forwards each
// observed object here: `onPod` / `onEvent` / `onPodDeleted` / `onLog`. The engine
// keeps the pod→service index current, extracts signals, runs them through the
// correlation engine, and (unless in dry-run) posts the resulting incidents to
// the sink. Decoupled from the k8s client ⇒ fully unit-testable with fixtures.

export interface SentinelEngineOptions {
  sink: IncidentSink
  correlator?: Correlator
  index?: PodServiceIndex
  analyzer?: LogAnalyzer
  /** When true, decisions are logged, never posted. */
  dryRun?: boolean
  /** Services to never open incidents for (noisy jobs, load generators, …). */
  mute?: Iterable<string>
  /** Storm control: max NEW incidents opened per `rateWindowMs` (0 = unlimited). */
  maxIncidentsPerWindow?: number
  rateWindowMs?: number
  /** Suppress incident emission for this long after start (still learns baselines
   * and de-dups) so the initial informer sync of pre-existing state can't storm. */
  startupGraceMs?: number
  logger?: (message: string) => void
  now?: () => number
}

function isPodReady(pod: PodLike): boolean {
  if (pod.status?.phase !== "Running") return false
  const cs = pod.status?.containerStatuses
  if (!cs || cs.length === 0) return false
  return cs.every((c) => c.ready === true)
}

export class SentinelEngine {
  readonly index: PodServiceIndex
  private readonly correlator: Correlator
  private readonly analyzer: LogAnalyzer
  private readonly sink: IncidentSink
  private readonly dryRun: boolean
  private readonly mute: Set<string>
  private readonly maxIncidents: number
  private readonly rateWindowMs: number
  private readonly startupGraceMs: number
  private readonly startedAt: number
  private readonly emitted: number[] = [] // recent emission timestamps (storm control)
  private readonly restartAccel: RestartAccelerationMonitor
  private readonly memTrend: MemoryTrendMonitor
  private readonly memLimits = new Map<string, number>() // ns/pod/container → limit bytes
  private readonly log: (message: string) => void
  private readonly now: () => number

  constructor(opts: SentinelEngineOptions) {
    this.sink = opts.sink
    this.correlator = opts.correlator ?? new Correlator()
    this.index = opts.index ?? new PodServiceIndex()
    this.analyzer = opts.analyzer ?? new LogAnalyzer({ now: opts.now })
    this.dryRun = opts.dryRun ?? false
    this.mute = new Set(opts.mute ?? [])
    this.maxIncidents = opts.maxIncidentsPerWindow ?? 0
    this.rateWindowMs = opts.rateWindowMs ?? 60_000
    this.startupGraceMs = opts.startupGraceMs ?? 0
    this.restartAccel = new RestartAccelerationMonitor({ now: opts.now })
    this.memTrend = new MemoryTrendMonitor({ now: opts.now })
    this.log = opts.logger ?? ((m) => console.log(m))
    this.now = opts.now ?? Date.now
    this.startedAt = this.now()
  }

  /** Leading indicator: restart cadence accelerating (per container). */
  private restartSignals(pod: PodLike): Signal[] {
    const namespace = pod.metadata?.namespace ?? "default"
    const podName = pod.metadata?.name ?? "unknown"
    const service = serviceNameFromLabels(pod.metadata?.labels, podName)
    const out: Signal[] = []
    for (const c of pod.status?.containerStatuses ?? []) {
      const container = c.name ?? "container"
      const key = `${namespace}/${podName}/${container}`
      const sig = this.restartAccel.observe(key, service, namespace, container, c.restartCount ?? 0)
      if (sig) out.push(sig)
    }
    return out
  }

  async onPod(pod: PodLike): Promise<void> {
    this.index.upsert(pod)
    this.recordMemLimits(pod)
    const signals = extractPodSignals(pod)
    const leading = this.restartSignals(pod)
    if (signals.length === 0 && leading.length === 0 && isPodReady(pod)) {
      // Recovery observed → re-arm detection for this service. Safe: the
      // /api/alerts pipeline owns incident lifecycle and de-dupes live incidents,
      // so re-arming never creates a duplicate.
      const namespace = pod.metadata?.namespace ?? "default"
      const service = serviceNameFromLabels(pod.metadata?.labels, pod.metadata?.name ?? "unknown")
      this.correlator.resolve(namespace, service)
      return
    }
    await this.process([...signals, ...leading])
  }

  private recordMemLimits(pod: PodLike): void {
    const namespace = pod.metadata?.namespace ?? "default"
    const podName = pod.metadata?.name
    if (!podName) return
    for (const [container, limit] of podMemoryLimits(pod)) {
      this.memLimits.set(`${namespace}/${podName}/${container}`, limit)
    }
  }

  onPodDeleted(pod: PodLike): void {
    this.index.remove(pod)
    const namespace = pod.metadata?.namespace ?? "default"
    const podName = pod.metadata?.name
    if (podName) {
      const prefix = `${namespace}/${podName}/`
      for (const k of this.memLimits.keys()) if (k.startsWith(prefix)) this.memLimits.delete(k)
    }
  }

  /** Leading indicator: feed a container's memory usage (from metrics-server) so
   * the trend monitor can flag a climb toward the limit before an OOMKill. */
  async onMemory(
    namespace: string,
    service: string,
    pod: string,
    container: string,
    usedBytes: number,
    at?: number
  ): Promise<void> {
    const key = `${namespace}/${pod}/${container}`
    const limit = this.memLimits.get(key)
    if (limit == null) return
    const sig = this.memTrend.observe(key, service, namespace, pod, container, usedBytes, limit, at ?? this.now())
    if (sig) await this.process([sig])
  }

  async onEvent(event: EventLike): Promise<void> {
    const signal = extractEventSignal(event, this.index.resolve)
    if (signal) await this.process([signal])
  }

  /** Rollout health: a Deployment stuck past its progress deadline (bad deploy). */
  async onDeployment(dep: DeploymentLike): Promise<void> {
    await this.process(extractDeploymentSignals(dep))
  }

  /** Feed one log line through the log-anomaly analyzer (signatures + novelty +
   * rate) and correlate any resulting signals. */
  async onLog(line: LogLine): Promise<void> {
    await this.process(this.analyzer.observe(line))
  }

  /** Clock-driven pass (once per bucket) for absence/baseline detection —
   * catches success signals that have gone silent. Driven by the runtime timer. */
  async tick(): Promise<void> {
    await this.process(this.analyzer.tick(this.now()))
  }

  private async process(signals: Signal[]): Promise<void> {
    // Storm/precision guard 1 — drop muted services entirely (before correlation).
    const kept = this.mute.size ? signals.filter((s) => !this.mute.has(s.service)) : signals
    if (kept.length === 0) return
    const decisions = this.correlator.ingest(kept, this.now())
    if (decisions.length === 0) return

    const now = this.now()
    // Storm/precision guard 2 — startup grace: suppress during the initial sync.
    if (this.startupGraceMs > 0 && now - this.startedAt < this.startupGraceMs) {
      for (const d of decisions) this.log(`[startup-grace] suppressed incident: ${d.reason}`)
      return
    }

    // Storm/precision guard 3 — global rate cap (backpressure).
    const admitted = this.admit(decisions.length, now)
    if (admitted < decisions.length) {
      this.log(`[storm-control] rate cap reached (${this.maxIncidents}/${Math.round(this.rateWindowMs / 1000)}s); suppressed ${decisions.length - admitted} incident(s)`)
    }
    const toEmit = decisions.slice(0, admitted)
    if (toEmit.length === 0) return

    if (this.dryRun) {
      for (const d of toEmit) {
        this.log(`[dry-run] would open incident: ${d.reason} (confidence ${Math.round(d.confidence * 100)}%)`)
      }
      return
    }
    await this.sink.post(toEmit.map((d) => decisionToAlert(d, now)))
  }

  /** Token accounting for the storm cap. Returns how many of `n` may be emitted
   * now, recording those that are. 0 maxIncidents ⇒ unlimited. */
  private admit(n: number, now: number): number {
    if (this.maxIncidents <= 0) return n
    const cutoff = now - this.rateWindowMs
    while (this.emitted.length && this.emitted[0] < cutoff) this.emitted.shift()
    const room = Math.max(0, this.maxIncidents - this.emitted.length)
    const grant = Math.min(room, n)
    for (let i = 0; i < grant; i++) this.emitted.push(now)
    return grant
  }
}
