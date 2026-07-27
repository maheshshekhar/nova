import type { Signal, SignalSeverity } from "../signal"
import { LogTemplateMiner } from "./template"
import { matchSignatures, type LogSignature } from "./signatures"

// The log analog of extract.ts: turn a single log line into detection Signals
// (the same currency the Correlator consumes). Two independent lenses today:
//   1. Signature matches — known technical failures (hard or soft).
//   2. Template novelty — a never-seen-before log shape after warm-up (soft).
// Rate/volume-shift is added next. Pure + injectable clock ⇒ unit-testable.

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
  /** Deployment-supplied signatures, matched alongside the built-ins. */
  extraSignatures?: LogSignature[]
  now?: () => number
}

const MAX_MSG = 240

function truncate(s: string): string {
  const one = s.replace(/\s+/g, " ").trim()
  return one.length > MAX_MSG ? one.slice(0, MAX_MSG - 1) + "…" : one
}

export class LogAnalyzer {
  private readonly miner: LogTemplateMiner
  private readonly extra: LogSignature[]
  private readonly now: () => number

  constructor(opts: LogAnalyzerOptions = {}) {
    this.miner = opts.miner ?? new LogTemplateMiner()
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

    return signals
  }
}
