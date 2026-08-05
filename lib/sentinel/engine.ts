import { Correlator, type AmbiguousCluster } from "./correlate"
import { extractPodSignals, podMemoryLimits, extractDeploymentSignals, type EventLike, type PodLike, type DeploymentLike } from "./extract"
import { extractEventSignal } from "./extract"
import { decisionToAlert } from "./incident"
import { serviceNameFromLabels } from "./signal"
import type { Signal } from "./signal"
import type { IncidentSink } from "./sink"
import { PodServiceIndex } from "./service-index"
import { LogAnalyzer, type LogLine } from "./logs/analyzer"
import { RestartAccelerationMonitor, MemoryTrendMonitor } from "./leading"
import { toJudgeInput, type SignalJudge } from "./judge"

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
  /** Per-resource readiness grace: suppress a decision whose signals ALL originate
   * from pods that are not yet Ready, or have been Ready for less than this long.
   * Kills first-boot transient noise. 0 disables the gate. */
  resourceReadyGraceMs?: number
  /** Optional on-demand AI judge for ambiguous soft-signal clusters. When set,
   * soft-only clusters below the auto-confirm bar are reasoned over (never
   * invented) and opened only if the judge confirms. Absent ⇒ today's behaviour. */
  judge?: SignalJudge
  /** Storm/cost cap: max AI judgments per `rateWindowMs` (0 = unlimited). */
  maxJudgementsPerWindow?: number
  /** Minimum judge confidence required to open an incident (default 0.6). */
  minJudgeConfidence?: number
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
  private readonly resourceReadyGraceMs: number
  private readonly startedAt: number
  private readonly emitted: number[] = [] // recent emission timestamps (storm control)
  private readonly restartAccel: RestartAccelerationMonitor
  private readonly memTrend: MemoryTrendMonitor
  private readonly memLimits = new Map<string, number>() // ns/pod/container → limit bytes
  private readonly judge?: SignalJudge
  private readonly maxJudgements: number
  private readonly minJudgeConfidence: number
  private readonly judgeCalls: number[] = [] // recent judge-call timestamps (cost/storm cap)
  private readonly pendingJudge = new Set<string>() // services with an in-flight judgment
  private readonly inFlight = new Set<Promise<void>>() // outstanding judgment promises
  private readonly log: (message: string) => void
  private readonly now: () => number

  constructor(opts: SentinelEngineOptions) {
    this.sink = opts.sink
    this.correlator = opts.correlator ?? new Correlator()
    this.index = opts.index ?? new PodServiceIndex({ now: opts.now })
    this.analyzer = opts.analyzer ?? new LogAnalyzer({ now: opts.now })
    this.dryRun = opts.dryRun ?? false
    this.mute = new Set(opts.mute ?? [])
    this.maxIncidents = opts.maxIncidentsPerWindow ?? 0
    this.rateWindowMs = opts.rateWindowMs ?? 60_000
    this.startupGraceMs = opts.startupGraceMs ?? 0
    this.resourceReadyGraceMs = opts.resourceReadyGraceMs ?? 0
    this.restartAccel = new RestartAccelerationMonitor({ now: opts.now })
    this.memTrend = new MemoryTrendMonitor({ now: opts.now })
    this.judge = opts.judge
    this.maxJudgements = opts.maxJudgementsPerWindow ?? 0
    this.minJudgeConfidence = opts.minJudgeConfidence ?? 0.6
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
    let kept = this.mute.size ? signals.filter((s) => !this.mute.has(s.service)) : signals
    if (kept.length === 0) return

    // Storm/precision guard 2 — per-resource readiness grace: drop signals from
    // pods still inside their startup window (freshly Ready, or not-yet-Ready but
    // only just observed) BEFORE correlation, so a still-starting resource never
    // opens an incident — yet a pod that stays broken PAST the grace (e.g. a real
    // CrashLoopBackOff) flows through and opens normally.
    if (this.resourceReadyGraceMs > 0) {
      const at = this.now()
      kept = kept.filter((s) => {
        if (this.signalWithinReadinessGrace(s, at)) {
          this.log(`[readiness-grace] suppressed signal from starting resource: ${s.kind} on ${s.service}`)
          return false
        }
        return true
      })
      if (kept.length === 0) return
    }

    const now = this.now()
    const { decisions, ambiguous } = this.correlator.ingestDetailed(kept, now)

    // Storm/precision guard 3 — startup grace: suppress during the initial sync
    // (covers both auto-confirmed decisions AND on-demand judging).
    if (this.startupGraceMs > 0 && now - this.startedAt < this.startupGraceMs) {
      for (const d of decisions) this.log(`[startup-grace] suppressed incident: ${d.reason}`)
      return
    }

    // On-demand AI judgment for ambiguous soft clusters (non-blocking; the main
    // signal flow never waits on a network call).
    if (this.judge && ambiguous.length) this.dispatchJudgements(ambiguous, now)

    if (decisions.length === 0) return

    // Storm/precision guard 4 — global rate cap (backpressure).
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

  /** True when a signal comes from a pod still inside its startup window — either
   * freshly Ready (Ready < grace) or not-yet-Ready but only just observed
   * (age < grace). A signal from an established pod (Ready ≥ grace, or not-Ready
   * for LONGER than the grace — a real crashloop) or an unknown source is kept.
   * Precision over recall: only the genuine first-boot window is suppressed. */
  private signalWithinReadinessGrace(s: Signal, now: number): boolean {
    const r = this.index.readinessOf(s.namespace, s.source.name)
    if (!r) return false // unknown source → treat as established, keep
    const established = r.ready
      ? r.readySince != null && now - r.readySince >= this.resourceReadyGraceMs
      : now - r.firstSeen >= this.resourceReadyGraceMs // not-Ready too long ⇒ real problem
    return !established
  }

  /** Fire off AI judgments for ambiguous clusters WITHOUT blocking the caller.
   * Bounded by an in-flight-per-service guard and a per-window cost cap. */
  private dispatchJudgements(clusters: AmbiguousCluster[], now: number): void {
    for (const cluster of clusters) {
      const key = `${cluster.namespace}/${cluster.service}`
      if (this.pendingJudge.has(key)) continue // one in-flight judgment per service
      if (!this.admitJudge(now)) break // cost/storm cap reached this window
      this.pendingJudge.add(key)
      const p = this.runJudge(cluster).finally(() => {
        this.pendingJudge.delete(key)
        this.inFlight.delete(p)
      })
      this.inFlight.add(p)
    }
  }

  /** Await any in-flight AI judgments — for graceful shutdown and deterministic
   * tests (the judge path is otherwise fire-and-forget). */
  async whenIdle(): Promise<void> {
    while (this.inFlight.size) await Promise.all([...this.inFlight])
  }

  /** Ask the judge about one ambiguous cluster and, if it confirms with enough
   * confidence, open the incident through the same emission guards. Precision-
   * first: any hold/low-confidence/error simply drops (no incident). */
  private async runJudge(cluster: AmbiguousCluster): Promise<void> {
    const key = `${cluster.namespace}/${cluster.service}`
    let verdict
    try {
      verdict = await this.judge!.judge(toJudgeInput(cluster))
    } catch (e) {
      this.log(`[ai-judge] error judging ${key}: ${e}`)
      return
    }
    if (!verdict.confirm) {
      this.log(`[ai-judge] held ${key}: ${verdict.reason}`)
      return
    }
    if (verdict.confidence < this.minJudgeConfidence) {
      this.log(`[ai-judge] held ${key}: confidence ${verdict.confidence.toFixed(2)} < ${this.minJudgeConfidence}`)
      return
    }
    const at = this.now()
    const decision = this.correlator.confirmAmbiguous(
      cluster.namespace,
      cluster.service,
      verdict.confidence,
      verdict.reason,
      at
    )
    if (!decision) return // opened/recovered meanwhile, or no soft signals remain
    if (this.dryRun) {
      this.log(`[dry-run] ai-judge would open incident: ${decision.reason} (confidence ${Math.round(decision.confidence * 100)}%)`)
      return
    }
    if (this.admit(1, at) < 1) {
      this.log(`[storm-control] ai-judge incident suppressed (rate cap)`)
      return
    }
    await this.sink.post([decisionToAlert(decision, at)])
    this.log(`[ai-judge] opened incident: ${decision.reason} (confidence ${Math.round(decision.confidence * 100)}%)`)
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

  /** Cost/storm cap for AI judge calls. Returns whether one more call is allowed
   * now, recording it if so. 0 maxJudgements ⇒ unlimited. */
  private admitJudge(now: number): boolean {
    const cutoff = now - this.rateWindowMs
    while (this.judgeCalls.length && this.judgeCalls[0] < cutoff) this.judgeCalls.shift()
    if (this.maxJudgements > 0 && this.judgeCalls.length >= this.maxJudgements) return false
    this.judgeCalls.push(now)
    return true
  }
}
