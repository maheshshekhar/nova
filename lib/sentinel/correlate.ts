import type { Signal, SignalSeverity } from "./signal"

// The correlation engine — candidate → confirm.
//
// Signals stream in per service. This engine decides WHEN they add up to an
// incident, with precision as the priority (a false incident costs money and
// trust):
//   • a HARD signal (CrashLoop, OOMKilled, missing Secret) opens an incident
//     immediately, and
//   • SOFT signals (rising restarts, probe failures) open one only when they
//     CORROBORATE — at least `softConfirmKinds` DISTINCT soft kinds within the
//     rolling window.
// Once open, a service is de-duplicated (no second incident) until `resolve()`.
// Pure + injectable clock ⇒ fully unit-testable, no cluster required.

export interface IncidentDecision {
  service: string
  namespace: string
  severity: SignalSeverity
  /** Human "why flagged" summary (the distinct signal kinds). */
  reason: string
  /** 0..1 — hard signals score higher than corroborated soft signals. */
  confidence: number
  /** The evidence that triggered the incident (fed to the AI RCA step). */
  signals: Signal[]
}

export interface CorrelatorOptions {
  /** Rolling window a signal counts for (default 10 min). */
  windowMs?: number
  /** Distinct SOFT signal kinds required to confirm a soft-only incident (default 2). */
  softConfirmKinds?: number
  /** Injectable clock. */
  now?: () => number
}

interface Tracked {
  signal: Signal
  at: number
}

interface ServiceState {
  signals: Tracked[]
  open: boolean
}

const DEFAULT_WINDOW_MS = 10 * 60 * 1000
const DEFAULT_SOFT_CONFIRM = 2

export class Correlator {
  private readonly windowMs: number
  private readonly softConfirmKinds: number
  private readonly now: () => number
  private readonly state = new Map<string, ServiceState>()

  constructor(opts: CorrelatorOptions = {}) {
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS
    this.softConfirmKinds = opts.softConfirmKinds ?? DEFAULT_SOFT_CONFIRM
    this.now = opts.now ?? Date.now
  }

  private static key(s: { namespace: string; service: string }): string {
    return `${s.namespace}/${s.service}`
  }

  /**
   * Ingest a batch of signals observed at `at` (defaults to now). Returns the
   * NEW incident decisions this batch triggered (empty when nothing crosses the
   * bar or the service already has an open incident).
   */
  ingest(signals: Signal[], at?: number): IncidentDecision[] {
    const t = at ?? this.now()
    const touched = new Set<string>()

    for (const sig of signals) {
      const k = Correlator.key(sig)
      let st = this.state.get(k)
      if (!st) {
        st = { signals: [], open: false }
        this.state.set(k, st)
      }
      st.signals.push({ signal: sig, at: t })
      touched.add(k)
    }

    const decisions: IncidentDecision[] = []
    for (const k of touched) {
      const st = this.state.get(k)!
      // Prune signals that have aged out of the window.
      st.signals = st.signals.filter((x) => t - x.at <= this.windowMs)
      if (st.open) continue // dedup: one open incident per service
      const decision = this.evaluate(st.signals)
      if (decision) {
        st.open = true
        decisions.push(decision)
      }
    }
    return decisions
  }

  private evaluate(tracked: Tracked[]): IncidentDecision | null {
    const sigs = tracked.map((x) => x.signal)
    if (sigs.length === 0) return null

    const hasHard = sigs.some((s) => s.hard)
    const distinctSoftKinds = new Set(sigs.filter((s) => !s.hard).map((s) => s.kind)).size
    const shouldOpen = hasHard || distinctSoftKinds >= this.softConfirmKinds
    if (!shouldOpen) return null

    const severity: SignalSeverity = sigs.some((s) => s.severity === "critical")
      ? "critical"
      : "warning"
    const kinds = [...new Set(sigs.map((s) => s.kind))]
    return {
      service: sigs[0].service,
      namespace: sigs[0].namespace,
      severity,
      confidence: hasHard ? 0.9 : 0.6,
      reason: `${kinds.join(", ")} on ${sigs[0].service}`,
      signals: sigs,
    }
  }

  /** Clear a service's state so it can flag again after recovery. */
  resolve(namespace: string, service: string): void {
    this.state.delete(`${namespace}/${service}`)
  }
}
