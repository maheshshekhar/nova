import { describe, expect, it } from "vitest"
import { LogRateMonitor } from "@/lib/sentinel/logs/rate"
import { LogAnalyzer } from "@/lib/sentinel/logs/analyzer"
import { LogTemplateMiner } from "@/lib/sentinel/logs/template"

const MIN = 60_000

/** Feed `perBucket` lines/bucket for `buckets` buckets starting at bucket 0. */
function warmBaseline(mon: LogRateMonitor, service: string, buckets: number, perBucket: number, isError = false) {
  for (let b = 0; b < buckets; b++) {
    for (let i = 0; i < perBucket; i++) mon.observe(service, b * MIN + i, isError)
  }
}

describe("LogRateMonitor", () => {
  it("stays silent during baseline warm-up", () => {
    const mon = new LogRateMonitor({ minBaselineBuckets: 5, spikeFactor: 4, minCount: 20 })
    // only 3 prior buckets → below minBaselineBuckets, no flag even on a burst
    warmBaseline(mon, "svc", 3, 5)
    let shifts: ReturnType<LogRateMonitor["observe"]> = []
    for (let i = 0; i < 100; i++) shifts = mon.observe("svc", 3 * MIN + i)
    expect(shifts).toHaveLength(0)
  })

  it("flags a volume spike once per bucket after baseline is established", () => {
    const mon = new LogRateMonitor({ minBaselineBuckets: 5, windowBuckets: 15, spikeFactor: 4, minCount: 20 })
    warmBaseline(mon, "svc", 6, 5) // baseline ~5 lines/bucket
    // bucket 6: pump 100 lines (>> 4*5) — spike should fire exactly once
    const fires: number[] = []
    for (let i = 0; i < 100; i++) {
      const s = mon.observe("svc", 6 * MIN + i)
      if (s.length) fires.push(i)
    }
    expect(fires.length).toBe(1)
    const [only] = mon.observe("svc", 6 * MIN + 999) // still same bucket → no second fire
    expect(only).toBeUndefined()
  })

  it("does NOT flag ordinary fluctuation within the spike factor", () => {
    const mon = new LogRateMonitor({ minBaselineBuckets: 5, spikeFactor: 4, minCount: 20 })
    warmBaseline(mon, "svc", 6, 10) // baseline 10
    let any = 0
    for (let i = 0; i < 25; i++) any += mon.observe("svc", 6 * MIN + i).length // 25 < 4*10
    expect(any).toBe(0)
  })

  it("flags an error-rate spike even when total volume is normal", () => {
    const mon = new LogRateMonitor({ minBaselineBuckets: 5, spikeFactor: 4, minErrorCount: 5, minCount: 1000 })
    // baseline: 10 lines/bucket, 0 errors
    warmBaseline(mon, "svc", 6, 10, false)
    // bucket 6: 10 lines but 8 of them errors → error spike (baseErr ~0)
    let errShift = false
    for (let i = 0; i < 10; i++) {
      const s = mon.observe("svc", 6 * MIN + i, i < 8)
      if (s.some((x) => x.kind === "LogErrorSpike")) errShift = true
    }
    expect(errShift).toBe(true)
  })

  it("tracks services independently", () => {
    const mon = new LogRateMonitor({ minBaselineBuckets: 2, spikeFactor: 4, minCount: 20 })
    warmBaseline(mon, "a", 3, 5)
    warmBaseline(mon, "b", 3, 5)
    let bFired = 0
    for (let i = 0; i < 100; i++) bFired += mon.observe("b", 3 * MIN + i).length
    // a saw no bucket-3 burst
    const aShift = mon.observe("a", 3 * MIN)
    expect(bFired).toBeGreaterThan(0)
    expect(aShift.some((x) => x.kind === "LogVolumeSpike")).toBe(false)
  })
})

describe("LogAnalyzer rate integration", () => {
  it("emits a soft LogVolumeSpike signal on a burst", () => {
    const rate = new LogRateMonitor({ minBaselineBuckets: 3, spikeFactor: 4, minCount: 20 })
    // silence novelty by using a huge warm-up so only rate fires
    const a = new LogAnalyzer({ rate, miner: new LogTemplateMiner({ warmupLines: 100000 }) })
    for (let b = 0; b < 4; b++) for (let i = 0; i < 5; i++) a.observe({ service: "svc", message: "steady tick", at: b * MIN + i })
    let volumeSignal = false
    for (let i = 0; i < 100; i++) {
      const s = a.observe({ service: "svc", message: "steady tick", at: 4 * MIN + i })
      if (s.some((x) => x.kind === "LogVolumeSpike")) volumeSignal = true
    }
    expect(volumeSignal).toBe(true)
  })

  it("uses the level field to detect error spikes (opportunistic)", () => {
    const rate = new LogRateMonitor({ minBaselineBuckets: 3, spikeFactor: 4, minErrorCount: 5, minCount: 100000 })
    const a = new LogAnalyzer({ rate, miner: new LogTemplateMiner({ warmupLines: 100000 }) })
    for (let b = 0; b < 4; b++) for (let i = 0; i < 10; i++) a.observe({ service: "svc", message: "ok", level: "info", at: b * MIN + i })
    let errSignal = false
    for (let i = 0; i < 10; i++) {
      const s = a.observe({ service: "svc", message: "boom", level: "error", at: 4 * MIN + i })
      if (s.some((x) => x.kind === "LogErrorSpike")) errSignal = true
    }
    expect(errSignal).toBe(true)
  })
})
