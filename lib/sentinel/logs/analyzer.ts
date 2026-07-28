import type { Signal, SignalSeverity } from "../signal"
import { LogTemplateMiner } from "./template"
import { matchSignatures, type LogSignature } from "./signatures"
import { LogRateMonitor } from "./rate"
import { ImpactMonitor } from "../business/impact"
import { AbsenceMonitor } from "../business/absence"

// The log analog of extract.ts: turn a single log line into detection Signals
// (the same currency the Correlator consumes). Four per-line lenses:
//   1. Signature matches — known technical failures (hard or soft).
//   2. Template novelty — a never-seen-before log shape after warm-up (soft).
//   3. Rate shift — a volume or error-rate spike vs the service's norm (soft).
//   4. Business impact — a burst of the Domain Pack's declared impact signal.
// Plus one clock-driven lens exposed via `tick()`:
//   5. Absence — a countable success signal that has collapsed vs its baseline.
// Pure + injectable clock ⇒ unit-testable.

export interface LogLine {
  service: string
  namespace?: string
  message: string
  /** Opportunistic — used if present, never required. */
  level?: string
  pod?: string
  /** Observation time (ms epoch). Defaults to now. */
  at?: number
}

export interface LogAnalyzerOptions {
  miner?: LogTemplateMiner
  rate?: LogRateMonitor
  /** Optional business-impact monitor (built from the Domain Pack impactSignal). */
  impact?: ImpactMonitor
  /** Optional absence monitor (built from a Domain Pack success pattern). */
  absence?: AbsenceMonitor
  /** Deployment-supplied signatures, matched alongside the built-ins. */
  extraSignatures?: LogSignature[]
  now?: () => number
}

// Levels that mark a line as an error for error-rate detection (opportunistic).
const ERROR_LEVELS = new Set(["error", "err", "fatal", "critical", "crit", "panic", "emerg", "alert"])

const MAX_MSG = 240

function truncate(s: string): string {
  const one = s.replace(/\s+/g, " ").trim()
  return one.length > MAX_MSG ? one.slice(0, MAX_MSG - 1) + "…" : one
}

export class LogAnalyzer {
  private readonly miner: LogTemplateMiner
  private readonly rate: LogRateMonitor
  private readonly impact: ImpactMonitor | null
  private readonly absence: AbsenceMonitor | null
  private readonly extra: LogSignature[]
  private readonly now: () => number

  constructor(opts: LogAnalyzerOptions = {}) {
    this.miner = opts.miner ?? new LogTemplateMiner()
    this.rate = opts.rate ?? new LogRateMonitor()
    this.impact = opts.impact ?? null
    this.absence = opts.absence ?? null
    this.extra = opts.extraSignatures ?? []
    this.now = opts.now ?? Date.now
  }

  observe(line: LogLine): Signal[] {
    const at = line.at ?? this.now()
    const namespace = line.namespace ?? "default"
    const source = { kind: "Log", name: line.pod ?? line.service }
    const signals: Signal[] = []

    const mk = (kind: string, severity: SignalSeverity, hard: boolean, message: string): Signal => ({
      kind,
      service: line.service,
      namespace,
      severity,
      hard,
      message,
      source,
    })

    // 1. Signatures.
    for (const sig of matchSignatures(line.message, this.extra)) {
      signals.push(mk(`Log:${sig.kind}`, sig.severity, sig.hard, `${sig.category} log signature ${sig.kind}: ${truncate(line.message)}`))
    }

    // 2. Novelty (learned per service, silent during warm-up).
    const obs = this.miner.observe(line.service, line.message, at)
    if (obs.novel) {
      signals.push(mk("LogNovelty", "warning", false, `New log pattern for ${line.service}: ${truncate(obs.template)}`))
    }

    // 3. Rate / error-rate shift vs the service's rolling baseline.
    const isError = line.level !== undefined && ERROR_LEVELS.has(line.level.toLowerCase())
    for (const shift of this.rate.observe(line.service, at, isError)) {
      const what = shift.kind === "LogErrorSpike" ? "error rate" : "log volume"
      signals.push(
        mk(shift.kind, "warning", false, `${what} spike for ${line.service}: ${shift.current}/bucket vs baseline ~${shift.baseline}`)
      )
    }

    // 4. Declared business impact (Domain Pack impactSignal), when configured.
    const hit = this.impact?.observe(line.service, line.message, line.level, at)
    if (hit) {
      signals.push(
        mk("BusinessImpact", hit.hard ? "critical" : "warning", hit.hard, `Business impact for ${line.service}: ${hit.count} ${hit.label} this minute`)
      )
    }

    // Feed the absence baseline (a success observation produces no signal here;
    // absences surface on tick()).
    this.absence?.observe(line.service, namespace, line.message, line.level, at)

    return signals
  }

  /** Clock-driven lens: flag services whose success signal has collapsed vs its
   * baseline. Called periodically by the engine (once per bucket). */
  tick(now?: number): Signal[] {
    const t = now ?? this.now()
    const out: Signal[] = []
    for (const hit of this.absence?.tick(t) ?? []) {
      out.push({
        kind: "SuccessDrop",
        service: hit.service,
        namespace: hit.namespace,
        severity: "critical",
        hard: true,
        message: `Success signal collapsed for ${hit.service}: ${hit.current} ${hit.label} vs baseline ~${hit.baseline}/min`,
        source: { kind: "Log", name: hit.service },
      })
    }
    return out
  }
}
