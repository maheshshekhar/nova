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
  /** True when an on-demand AI judge confirmed an otherwise sub-threshold soft
   * cluster (rather than a hard signal or auto-corroboration). */
  judged?: boolean
}

/** A soft-only cluster that sits BELOW the auto-confirm bar but has enough
 * corroboration to be worth an on-demand judgment (never auto-opened). */
export interface AmbiguousCluster {
  service: string
  namespace: string
  /** The in-window soft signals that didn't reach `softConfirmKinds`. */
  signals: Signal[]
}

export interface IngestResult {
  /** Auto-confirmed incidents (hard signal, or enough distinct soft kinds). */
  decisions: IncidentDecision[]
  /** Soft-only clusters below the bar, surfaced for optional AI judgment. */
  ambiguous: AmbiguousCluster[]
}

export interface CorrelatorOptions {
  /** Rolling window a signal counts for (default 10 min). */
  windowMs?: number
  /** Distinct SOFT signal kinds required to confirm a soft-only incident (default 2). */
  softConfirmKinds?: number
  /** Min distinct soft kinds for a below-bar cluster to be surfaced as ambiguous
   * (worth an AI judgment). Default 1. Clusters with fewer are ignored. */
  judgeMinSoftKinds?: number
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
const DEFAULT_JUDGE_MIN_SOFT = 1

export class Correlator {
  private readonly windowMs: number
  private readonly softConfirmKinds: number
  private readonly judgeMinSoftKinds: number
  private readonly now: () => number
  private readonly state = new Map<string, ServiceState>()

  constructor(opts: CorrelatorOptions = {}) {
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS
    this.softConfirmKinds = opts.softConfirmKinds ?? DEFAULT_SOFT_CONFIRM
    this.judgeMinSoftKinds = opts.judgeMinSoftKinds ?? DEFAULT_JUDGE_MIN_SOFT
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
    return this.ingestDetailed(signals, at).decisions
  }

  /**
   * Like {@link ingest}, but also surfaces soft-only clusters that sit BELOW the
   * auto-confirm bar (`ambiguous`) so an optional AI judge can reason over them.
   * Ambiguous clusters are NOT opened here — the caller decides via
   * {@link confirmAmbiguous}.
   */
  ingestDetailed(signals: Signal[], at?: number): IngestResult {
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
    const ambiguous: AmbiguousCluster[] = []
    for (const k of touched) {
      const st = this.state.get(k)!
      // Prune signals that have aged out of the window.
      st.signals = st.signals.filter((x) => t - x.at <= this.windowMs)
      if (st.open) continue // dedup: one open incident per service
      const sigs = st.signals.map((x) => x.signal)
      const decision = this.evaluate(sigs)
      if (decision) {
        st.open = true
        decisions.push(decision)
        continue
      }
      const cluster = this.ambiguousCluster(sigs)
      if (cluster) ambiguous.push(cluster)
    }
    return { decisions, ambiguous }
  }

  private evaluate(sigs: Signal[]): IncidentDecision | null {
    if (sigs.length === 0) return null

    const hasHard = sigs.some((s) => s.hard)
    const distinctSoftKinds = new Set(sigs.filter((s) => !s.hard).map((s) => s.kind)).size
    const shouldOpen = hasHard || distinctSoftKinds >= this.softConfirmKinds
    if (!shouldOpen) return null

    return this.buildDecision(sigs, hasHard ? 0.9 : 0.6)
  }

  /** A soft-only, below-the-bar cluster with enough corroboration to be judged. */
  private ambiguousCluster(sigs: Signal[]): AmbiguousCluster | null {
    if (sigs.length === 0) return null
    if (sigs.some((s) => s.hard)) return null // a hard signal already auto-opens
    const distinctSoftKinds = new Set(sigs.map((s) => s.kind)).size
    if (distinctSoftKinds < this.judgeMinSoftKinds || distinctSoftKinds >= this.softConfirmKinds) {
      return null
    }
    return { service: sigs[0].service, namespace: sigs[0].namespace, signals: sigs }
  }

  private buildDecision(sigs: Signal[], confidence: number, judged = false): IncidentDecision {
    const severity: SignalSeverity = sigs.some((s) => s.severity === "critical")
      ? "critical"
      : "warning"
    const kinds = [...new Set(sigs.map((s) => s.kind))]
    return {
      service: sigs[0].service,
      namespace: sigs[0].namespace,
      severity,
      confidence,
      reason: `${kinds.join(", ")} on ${sigs[0].service}`,
      signals: sigs,
      ...(judged ? { judged: true } : {}),
    }
  }

  /**
   * Open an incident for a previously-ambiguous soft cluster that an AI judge
   * confirmed. Builds the decision from the service's CURRENT in-window signals
   * (guarding against a hard signal or auto-confirm having landed meanwhile) and
   * de-dups via the same open-flag. Returns null if the service already opened,
   * recovered, or no soft signals remain in the window.
   */
  confirmAmbiguous(
    namespace: string,
    service: string,
    confidence: number,
    reason: string,
    at?: number
  ): IncidentDecision | null {
    const st = this.state.get(`${namespace}/${service}`)
    if (!st || st.open) return null
    const t = at ?? this.now()
    st.signals = st.signals.filter((x) => t - x.at <= this.windowMs)
    const sigs = st.signals.map((x) => x.signal)
    if (sigs.length === 0) return null
    if (sigs.some((s) => s.hard)) return null // a hard signal opens on its own path
    st.open = true
    const clamped = Math.max(0, Math.min(1, confidence))
    const decision = this.buildDecision(sigs, clamped, true)
    decision.reason = `${decision.reason} — AI-confirmed: ${reason}`
    return decision
  }

  /** Clear a service's state so it can flag again after recovery. */
  resolve(namespace: string, service: string): void {
    this.state.delete(`${namespace}/${service}`)
  }
}
