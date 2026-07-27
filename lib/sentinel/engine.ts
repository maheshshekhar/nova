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
  private readonly log: (message: string) => void
  private readonly now: () => number

  constructor(opts: SentinelEngineOptions) {
    this.sink = opts.sink
    this.correlator = opts.correlator ?? new Correlator()
    this.index = opts.index ?? new PodServiceIndex()
    this.analyzer = opts.analyzer ?? new LogAnalyzer({ now: opts.now })
    this.dryRun = opts.dryRun ?? false
    this.log = opts.logger ?? ((m) => console.log(m))
    this.now = opts.now ?? Date.now
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

  private async process(signals: Signal[]): Promise<void> {
    if (signals.length === 0) return
    const decisions = this.correlator.ingest(signals, this.now())
    if (decisions.length === 0) return
    if (this.dryRun) {
      for (const d of decisions) {
        this.log(`[dry-run] would open incident: ${d.reason} (confidence ${Math.round(d.confidence * 100)}%)`)
      }
      return
    }
    await this.sink.post(decisions.map((d) => decisionToAlert(d, this.now())))
  }
}
