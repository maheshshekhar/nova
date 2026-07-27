// Per-service log volume / error-rate shift detection.
//
// The third log lens (after signatures and template novelty): a service that
// suddenly logs far more than its recent norm — or starts emitting errors it
// normally doesn't — is a signal, regardless of the words. Time is bucketed;
// each bucket is compared to a rolling baseline of prior buckets. A shift is
// reported at most once per bucket per kind. Pure + injectable clock ⇒ testable.

export type RateShiftKind = "LogVolumeSpike" | "LogErrorSpike"

export interface RateShift {
  kind: RateShiftKind
  service: string
  /** Lines (or errors) in the current bucket. */
  current: number
  /** Rolling per-bucket baseline it exceeded. */
  baseline: number
}

export interface LogRateMonitorOptions {
  /** Bucket width in ms (default 60s). */
  bucketMs?: number
  /** How many prior buckets form the baseline window (default 15). */
  windowBuckets?: number
  /** Prior buckets with data required before flagging (warm-up, default 5). */
  minBaselineBuckets?: number
  /** Multiple of baseline a bucket must exceed to be a spike (default 4). */
  spikeFactor?: number
  /** Min lines in a bucket to consider a volume spike (default 20). */
  minCount?: number
  /** Min errors in a bucket to consider an error spike (default 5). */
  minErrorCount?: number
  now?: () => number
}

interface Bucket {
  total: number
  errors: number
}

interface SvcState {
  buckets: Map<number, Bucket>
  flagged: Map<number, Set<RateShiftKind>>
}

export class LogRateMonitor {
  private readonly bucketMs: number
  private readonly windowBuckets: number
  private readonly minBaselineBuckets: number
  private readonly spikeFactor: number
  private readonly minCount: number
  private readonly minErrorCount: number
  private readonly now: () => number
  private readonly services = new Map<string, SvcState>()

  constructor(opts: LogRateMonitorOptions = {}) {
    this.bucketMs = opts.bucketMs ?? 60_000
    this.windowBuckets = opts.windowBuckets ?? 15
    this.minBaselineBuckets = opts.minBaselineBuckets ?? 5
    this.spikeFactor = opts.spikeFactor ?? 4
    this.minCount = opts.minCount ?? 20
    this.minErrorCount = opts.minErrorCount ?? 5
    this.now = opts.now ?? Date.now
  }

  observe(service: string, at?: number, isError = false): RateShift[] {
    const t = at ?? this.now()
    const idx = Math.floor(t / this.bucketMs)

    let svc = this.services.get(service)
    if (!svc) {
      svc = { buckets: new Map(), flagged: new Map() }
      this.services.set(service, svc)
    }

    const cur = svc.buckets.get(idx) ?? { total: 0, errors: 0 }
    cur.total++
    if (isError) cur.errors++
    svc.buckets.set(idx, cur)

    // Drop buckets outside the baseline window.
    const cutoff = idx - this.windowBuckets
    for (const bi of svc.buckets.keys()) if (bi < cutoff) svc.buckets.delete(bi)
    for (const bi of svc.flagged.keys()) if (bi < cutoff) svc.flagged.delete(bi)

    // Baseline over prior buckets with data.
    let sumTotal = 0
    let sumErr = 0
    let n = 0
    for (const [bi, b] of svc.buckets) {
      if (bi === idx) continue
      sumTotal += b.total
      sumErr += b.errors
      n++
    }
    if (n < this.minBaselineBuckets) return []

    const baseTotal = sumTotal / n
    const baseErr = sumErr / n
    const flaggedKinds = svc.flagged.get(idx) ?? new Set<RateShiftKind>()
    const shifts: RateShift[] = []

    if (
      !flaggedKinds.has("LogVolumeSpike") &&
      cur.total >= this.minCount &&
      cur.total > this.spikeFactor * Math.max(baseTotal, 1)
    ) {
      shifts.push({ kind: "LogVolumeSpike", service, current: cur.total, baseline: Math.round(baseTotal) })
      flaggedKinds.add("LogVolumeSpike")
    }

    if (
      !flaggedKinds.has("LogErrorSpike") &&
      cur.errors >= this.minErrorCount &&
      cur.errors > this.spikeFactor * Math.max(baseErr, 1)
    ) {
      shifts.push({ kind: "LogErrorSpike", service, current: cur.errors, baseline: Math.round(baseErr) })
      flaggedKinds.add("LogErrorSpike")
    }

    if (shifts.length > 0) svc.flagged.set(idx, flaggedKinds)
    return shifts
  }
}
