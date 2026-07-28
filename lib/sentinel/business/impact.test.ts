import { describe, expect, it } from "vitest"
import { compileMatch } from "@/lib/sentinel/business/signal-match"
import { ImpactMonitor } from "@/lib/sentinel/business/impact"
import { LogAnalyzer } from "@/lib/sentinel/logs/analyzer"
import { LogTemplateMiner } from "@/lib/sentinel/logs/template"
import { LogRateMonitor } from "@/lib/sentinel/logs/rate"

describe("compileMatch", () => {
  it("returns null when neither level nor pattern is given", () => {
    expect(compileMatch({})).toBeNull()
  })

  it("matches on pattern only (case-insensitive)", () => {
    const fn = compileMatch({ pattern: "pool\\.connect\\(\\) timeout" })!
    expect(fn("checkout: Pool.Connect() Timeout after 30s")).toBe(true)
    expect(fn("all good")).toBe(false)
  })

  it("matches on level only", () => {
    const fn = compileMatch({ level: "ERROR" })!
    expect(fn("anything", "error")).toBe(true)
    expect(fn("anything", "INFO")).toBe(false)
  })

  it("requires BOTH level and pattern when both given", () => {
    const fn = compileMatch({ level: "ERROR", pattern: "declined" })!
    expect(fn("payment declined", "error")).toBe(true)
    expect(fn("payment declined", "info")).toBe(false)
    expect(fn("payment ok", "error")).toBe(false)
  })
})

describe("ImpactMonitor", () => {
  const match = { pattern: "failed checkout" }

  it("does not flag below the minImpact threshold", () => {
    const mon = new ImpactMonitor({ match, minImpact: 5, now: () => 0 })
    let hits = 0
    for (let i = 0; i < 4; i++) if (mon.observe("checkout", "failed checkout for user")) hits++
    expect(hits).toBe(0)
  })

  it("raises a soft impact signal once the threshold is crossed (once per bucket)", () => {
    const mon = new ImpactMonitor({ match, minImpact: 5, hardMultiple: 3, now: () => 0 })
    const hits = []
    for (let i = 0; i < 8; i++) {
      const h = mon.observe("checkout", "failed checkout", undefined, 0)
      if (h) hits.push(h)
    }
    // soft at count 5; hard threshold is 15 (not reached) → exactly one soft hit
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ hard: false, count: 5, label: "impacted requests" })
  })

  it("upgrades to a hard signal on a severe spike", () => {
    const mon = new ImpactMonitor({ match, minImpact: 2, hardMultiple: 3, label: "failed checkouts", now: () => 0 })
    const hits = []
    for (let i = 0; i < 6; i++) {
      const h = mon.observe("checkout", "failed checkout", undefined, 0)
      if (h) hits.push(h)
    }
    // soft at 2, hard at 6
    expect(hits.map((h) => h.hard)).toEqual([false, true])
    expect(hits[1]).toMatchObject({ hard: true, count: 6, label: "failed checkouts" })
  })

  it("ignores non-matching lines", () => {
    const mon = new ImpactMonitor({ match, minImpact: 1, now: () => 0 })
    expect(mon.observe("checkout", "successful checkout")).toBeNull()
  })

  it("counts per bucket (a new minute resets)", () => {
    const mon = new ImpactMonitor({ match, minImpact: 3, bucketMs: 60_000 })
    let hits = 0
    for (let i = 0; i < 3; i++) if (mon.observe("checkout", "failed checkout", undefined, i)) hits++ // bucket 0
    for (let i = 0; i < 3; i++) if (mon.observe("checkout", "failed checkout", undefined, 60_000 + i)) hits++ // bucket 1
    expect(hits).toBe(2)
  })
})

describe("LogAnalyzer business-impact integration", () => {
  it("emits a soft BusinessImpact signal when configured with a domain impactSignal", () => {
    const impact = new ImpactMonitor({ match: { pattern: "failed checkout" }, minImpact: 3, label: "failed checkouts" })
    const a = new LogAnalyzer({
      impact,
      miner: new LogTemplateMiner({ warmupLines: 100000 }),
      rate: new LogRateMonitor({ minBaselineBuckets: 100000 }),
    })
    let sig
    for (let i = 0; i < 3; i++) sig = a.observe({ service: "checkout", message: "failed checkout for user 42", at: i })
    const impactSig = sig!.find((s) => s.kind === "BusinessImpact")
    expect(impactSig).toMatchObject({ hard: false, severity: "warning", service: "checkout" })
    expect(impactSig!.message).toContain("failed checkouts")
  })

  it("emits nothing business-related when no impact monitor is configured", () => {
    const a = new LogAnalyzer({ miner: new LogTemplateMiner({ warmupLines: 100000 }), rate: new LogRateMonitor({ minBaselineBuckets: 100000 }) })
    const sig = a.observe({ service: "checkout", message: "failed checkout for user 42" })
    expect(sig.find((s) => s.kind === "BusinessImpact")).toBeUndefined()
  })
})
