import { Correlator } from "./correlate"
import { extractPodSignals, type EventLike, type PodLike } from "./extract"
import { extractEventSignal } from "./extract"
import { decisionToAlert } from "./incident"
import { serviceNameFromLabels } from "./signal"
import type { Signal } from "./signal"
import type { IncidentSink } from "./sink"
import { PodServiceIndex } from "./service-index"
import { LogAnalyzer, type LogLine } from "./logs/analyzer"

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
    this.log = opts.logger ?? ((m) => console.log(m))
    this.now = opts.now ?? Date.now
    this.startedAt = this.now()
  }

  async onPod(pod: PodLike): Promise<void> {
    this.index.upsert(pod)
    const signals = extractPodSignals(pod)
    if (signals.length === 0 && isPodReady(pod)) {
      // Recovery observed → re-arm detection for this service. Safe: the
      // /api/alerts pipeline owns incident lifecycle and de-dupes live incidents,
      // so re-arming never creates a duplicate.
      const namespace = pod.metadata?.namespace ?? "default"
      const service = serviceNameFromLabels(pod.metadata?.labels, pod.metadata?.name ?? "unknown")
      this.correlator.resolve(namespace, service)
      return
    }
    await this.process(signals)
  }

  onPodDeleted(pod: PodLike): void {
    this.index.remove(pod)
  }

  async onEvent(event: EventLike): Promise<void> {
    const signal = extractEventSignal(event, this.index.resolve)
    if (signal) await this.process([signal])
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
