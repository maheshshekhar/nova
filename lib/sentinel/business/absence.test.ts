import { describe, expect, it } from "vitest"
import { AbsenceMonitor } from "@/lib/sentinel/business/absence"
import { LogAnalyzer } from "@/lib/sentinel/logs/analyzer"
import { LogTemplateMiner } from "@/lib/sentinel/logs/template"
import { LogRateMonitor } from "@/lib/sentinel/logs/rate"

const MIN = 60_000
const match = { pattern: "checkout complete" }

/** Feed `perBucket` successes/bucket for buckets [0, buckets). */
function warm(mon: AbsenceMonitor, service: string, ns: string, buckets: number, perBucket: number) {
  for (let b = 0; b < buckets; b++) {
    for (let i = 0; i < perBucket; i++) mon.observe(service, ns, "checkout complete for user", "info", b * MIN + i)
  }
}

describe("AbsenceMonitor", () => {
  it("is disabled when the match spec is empty", () => {
    const mon = new AbsenceMonitor({ match: {} })
    expect(mon.enabled).toBe(false)
    expect(mon.tick(10 * MIN)).toHaveLength(0)
  })

  it("stays silent during baseline warm-up", () => {
    const mon = new AbsenceMonitor({ match, minBaselineBuckets: 5, minBaseline: 10, dropFactor: 5 })
    warm(mon, "checkout", "prod", 3, 20) // only 3 prior buckets
    // last complete bucket = 3; baseline from buckets 0..2 → n=3 < 5 → no flag
    expect(mon.tick(4 * MIN)).toHaveLength(0)
  })

  it("flags when the success signal collapses vs a healthy baseline", () => {
    const mon = new AbsenceMonitor({ match, minBaselineBuckets: 5, minBaseline: 10, dropFactor: 5, label: "checkouts" })
    warm(mon, "checkout", "prod", 6, 50) // buckets 0..5 have 50 each
    // bucket 6 gets ZERO successes (nobody calls observe). Evaluate at start of bucket 7.
    const hits = mon.tick(7 * MIN)
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ service: "checkout", namespace: "prod", current: 0, label: "checkouts" })
    expect(hits[0].baseline).toBeGreaterThan(10)
  })

  it("does NOT flag a low-traffic service below minBaseline", () => {
    const mon = new AbsenceMonitor({ match, minBaselineBuckets: 5, minBaseline: 10, dropFactor: 5 })
    warm(mon, "rare", "prod", 6, 2) // baseline ~2 < minBaseline 10
    expect(mon.tick(7 * MIN)).toHaveLength(0)
  })

  it("does NOT flag when traffic continues at a healthy level", () => {
    const mon = new AbsenceMonitor({ match, minBaselineBuckets: 5, minBaseline: 10, dropFactor: 5 })
    warm(mon, "checkout", "prod", 7, 50) // bucket 6 also has 50
    expect(mon.tick(7 * MIN)).toHaveLength(0)
  })

  it("evaluates each completed bucket only once", () => {
    const mon = new AbsenceMonitor({ match, minBaselineBuckets: 5, minBaseline: 10, dropFactor: 5 })
    warm(mon, "checkout", "prod", 6, 50)
    expect(mon.tick(7 * MIN)).toHaveLength(1)
    expect(mon.tick(7 * MIN)).toHaveLength(0) // same tick time → already evaluated
  })
})

describe("LogAnalyzer.tick (absence integration)", () => {
  it("emits a hard SuccessDrop signal via tick()", () => {
    const absence = new AbsenceMonitor({ match, minBaselineBuckets: 5, minBaseline: 10, dropFactor: 5, label: "checkouts" })
    const a = new LogAnalyzer({
      absence,
      miner: new LogTemplateMiner({ warmupLines: 100000 }),
      rate: new LogRateMonitor({ minBaselineBuckets: 100000 }),
    })
    for (let b = 0; b < 6; b++) for (let i = 0; i < 50; i++) a.observe({ service: "checkout", namespace: "prod", message: "checkout complete", level: "info", at: b * MIN + i })
    const signals = a.tick(7 * MIN)
    expect(signals).toHaveLength(1)
    expect(signals[0]).toMatchObject({ kind: "SuccessDrop", hard: true, severity: "critical", service: "checkout", namespace: "prod" })
  })

  it("tick returns nothing when no absence monitor is configured", () => {
    const a = new LogAnalyzer()
    expect(a.tick(7 * MIN)).toHaveLength(0)
  })
})
