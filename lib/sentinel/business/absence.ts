import { compileMatch, type MatchFn, type SignalMatch } from "./signal-match"

// Absence / success-drop detection.
//
// The hardest failures are the silent ones: no error is logged, the app just
// stops doing its job ("checkouts aren't happening"). This monitor baselines a
// countable SUCCESS signal per service (a Domain Pack success pattern) and, on a
// timer, flags a bucket whose success count has collapsed far below the rolling
// baseline. Unlike the per-line lenses this needs a `tick()` — an absence is
// detected by the absence of observations, so a clock must drive it.
//
// Pure + injectable clock ⇒ unit-testable.

export interface AbsenceMonitorOptions {
  /** What a success looks like (Domain Pack success pattern). */
  match: SignalMatch
  /** Bucket width in ms (default 60s). */
  bucketMs?: number
  /** Baseline history window in buckets (default 15). */
  windowBuckets?: number
  /** Prior buckets with data required before flagging (default 5). */
  minBaselineBuckets?: number
  /** Minimum baseline successes/bucket to bother (ignore low-traffic services). */
  minBaseline?: number
  /** current < baseline / dropFactor ⇒ a drop (default 5). */
  dropFactor?: number
  /** Human unit for the message (e.g. "checkouts"). */
  label?: string
  now?: () => number
}

export interface AbsenceHit {
  service: string
  namespace: string
  current: number
  baseline: number
  label: string
}

interface SvcState {
  namespace: string
  buckets: Map<number, number> // bucketIdx → success count
  lastEvaluated: number
}

export class AbsenceMonitor {
  private readonly matchFn: MatchFn | null
  private readonly bucketMs: number
  private readonly windowBuckets: number
  private readonly minBaselineBuckets: number
  private readonly minBaseline: number
  private readonly dropFactor: number
  private readonly label: string
  private readonly now: () => number
  private readonly services = new Map<string, SvcState>()

  constructor(opts: AbsenceMonitorOptions) {
    this.matchFn = compileMatch(opts.match)
    this.bucketMs = opts.bucketMs ?? 60_000
    this.windowBuckets = opts.windowBuckets ?? 15
    this.minBaselineBuckets = opts.minBaselineBuckets ?? 5
    this.minBaseline = opts.minBaseline ?? 10
    this.dropFactor = opts.dropFactor ?? 5
    this.label = opts.label ?? "successful requests"
    this.now = opts.now ?? Date.now
  }

  /** Whether an absence baseline is being tracked at all. */
  get enabled(): boolean {
    return this.matchFn !== null
  }

  observe(service: string, namespace: string, message: string, level?: string, at?: number): void {
    if (!this.matchFn || !this.matchFn(message, level)) return
    const t = at ?? this.now()
    const idx = Math.floor(t / this.bucketMs)
    let svc = this.services.get(service)
    if (!svc) {
      svc = { namespace, buckets: new Map(), lastEvaluated: idx - 1 }
      this.services.set(service, svc)
    }
    svc.namespace = namespace
    svc.buckets.set(idx, (svc.buckets.get(idx) ?? 0) + 1)
  }

  /** Evaluate the last COMPLETE bucket for every tracked service. */
  tick(now?: number): AbsenceHit[] {
    if (!this.matchFn) return []
    const t = now ?? this.now()
    const lastComplete = Math.floor(t / this.bucketMs) - 1
    const hits: AbsenceHit[] = []

    for (const [service, svc] of this.services) {
      // Drop buckets outside the window.
      const cutoff = lastComplete - this.windowBuckets
      for (const bi of svc.buckets.keys()) if (bi < cutoff) svc.buckets.delete(bi)

      if (svc.lastEvaluated >= lastComplete) continue

      // Baseline over prior buckets with data (exclude the bucket under test).
      let sum = 0
      let n = 0
      for (const [bi, c] of svc.buckets) {
        if (bi >= lastComplete) continue
        sum += c
        n++
      }
      svc.lastEvaluated = lastComplete
      if (n < this.minBaselineBuckets) continue

      const baseline = sum / n
      if (baseline < this.minBaseline) continue

      const current = svc.buckets.get(lastComplete) ?? 0
      if (current * this.dropFactor < baseline) {
        hits.push({ service, namespace: svc.namespace, current, baseline: Math.round(baseline), label: this.label })
      }
    }
    return hits
  }
}
