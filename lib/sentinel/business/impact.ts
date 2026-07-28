import { compileMatch, type MatchFn, type SignalMatch } from "./signal-match"

// Declared business-impact detection.
//
// A Domain Pack declares what *customer impact* looks like in the logs the app
// already emits (payments: "pool.connect() timeout" = a failed checkout). This
// monitor counts those matches per service per bucket and flags a burst: a soft
// signal once impact crosses `minImpact`, upgraded to a hard signal on a severe
// spike. Business impact is the ground truth of an outage, so it corroborates
// (or, when severe, opens) an incident regardless of the underlying cause.
//
// Pure + injectable clock ⇒ unit-testable.

export interface ImpactMonitorOptions {
  /** What counts as impact (Domain Pack `impactSignal.match`). */
  match: SignalMatch
  /** Bucket width in ms (default 60s). */
  bucketMs?: number
  /** Matches within a bucket to raise a soft impact signal (default 5). */
  minImpact?: number
  /** Multiple of `minImpact` that upgrades to a hard signal (default 3). */
  hardMultiple?: number
  /** Human unit of impact for the message (e.g. "failed checkouts"). */
  label?: string
  now?: () => number
}

export interface ImpactHit {
  count: number
  hard: boolean
  label: string
}

interface Bucket {
  count: number
  flaggedSoft: boolean
  flaggedHard: boolean
}

export class ImpactMonitor {
  private readonly matchFn: MatchFn | null
  private readonly bucketMs: number
  private readonly minImpact: number
  private readonly hardThreshold: number
  private readonly label: string
  private readonly now: () => number
  private readonly buckets = new Map<string, Bucket>() // key: service/bucketIdx

  constructor(opts: ImpactMonitorOptions) {
    this.matchFn = compileMatch(opts.match)
    this.bucketMs = opts.bucketMs ?? 60_000
    this.minImpact = opts.minImpact ?? 5
    this.hardThreshold = this.minImpact * (opts.hardMultiple ?? 3)
    this.label = opts.label ?? "impacted requests"
    this.now = opts.now ?? Date.now
  }

  observe(service: string, message: string, level?: string, at?: number): ImpactHit | null {
    if (!this.matchFn || !this.matchFn(message, level)) return null

    const t = at ?? this.now()
    const idx = Math.floor(t / this.bucketMs)
    const key = `${service}/${idx}`
    const bucket = this.buckets.get(key) ?? { count: 0, flaggedSoft: false, flaggedHard: false }
    bucket.count++
    this.buckets.set(key, bucket)
    this.prune(idx)

    if (!bucket.flaggedHard && bucket.count >= this.hardThreshold) {
      bucket.flaggedHard = true
      bucket.flaggedSoft = true
      return { count: bucket.count, hard: true, label: this.label }
    }
    if (!bucket.flaggedSoft && bucket.count >= this.minImpact) {
      bucket.flaggedSoft = true
      return { count: bucket.count, hard: false, label: this.label }
    }
    return null
  }

  // Keep only the current + previous bucket; impact is evaluated within a bucket.
  private prune(idx: number): void {
    for (const key of this.buckets.keys()) {
      const bi = Number(key.slice(key.lastIndexOf("/") + 1))
      if (bi < idx - 1) this.buckets.delete(key)
    }
  }
}
