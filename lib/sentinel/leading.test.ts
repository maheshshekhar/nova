import { describe, expect, it } from "vitest"
import { parseQuantity } from "@/lib/sentinel/quantity"
import { RestartAccelerationMonitor, MemoryTrendMonitor } from "@/lib/sentinel/leading"

describe("parseQuantity", () => {
  it("parses binary suffixes", () => {
    expect(parseQuantity("1Ki")).toBe(1024)
    expect(parseQuantity("512Mi")).toBe(512 * 1024 * 1024)
    expect(parseQuantity("2Gi")).toBe(2 * 1024 ** 3)
  })
  it("parses decimal suffixes and plain bytes", () => {
    expect(parseQuantity("1M")).toBe(1_000_000)
    expect(parseQuantity("1000")).toBe(1000)
    expect(parseQuantity(2048)).toBe(2048)
  })
  it("returns null for junk / empty", () => {
    expect(parseQuantity("")).toBeNull()
    expect(parseQuantity("abc")).toBeNull()
    expect(parseQuantity(undefined)).toBeNull()
  })
})

const MIN = 60_000

describe("RestartAccelerationMonitor", () => {
  it("never flags on the first (baseline) observation", () => {
    const m = new RestartAccelerationMonitor()
    expect(m.observe("prod/p/app", "svc", "prod", "app", 5, 0)).toBeNull()
  })

  it("flags when restart cadence speeds up", () => {
    const m = new RestartAccelerationMonitor({ speedupRatio: 0.6 })
    const k = "prod/p/app"
    expect(m.observe(k, "svc", "prod", "app", 0, 0)).toBeNull() // baseline
    // restarts at t=0 (baseline had 0), then gaps: 4m, 4m, then 1m (speeding up)
    expect(m.observe(k, "svc", "prod", "app", 1, 0 * MIN)).toBeNull() // event 1
    expect(m.observe(k, "svc", "prod", "app", 2, 4 * MIN)).toBeNull() // event 2 (gap 4m)
    expect(m.observe(k, "svc", "prod", "app", 3, 8 * MIN)).toBeNull() // event 3 (gap 4m) — not accel
    const sig = m.observe(k, "svc", "prod", "app", 4, 9 * MIN) // event 4 (gap 1m << 4m)
    expect(sig).toMatchObject({ kind: "RestartsAccelerating", hard: false, severity: "warning" })
  })

  it("does NOT flag steady (non-accelerating) restarts", () => {
    const m = new RestartAccelerationMonitor({ windowMs: 60 * MIN })
    const k = "prod/p/app"
    m.observe(k, "svc", "prod", "app", 0, 0)
    let sig = null
    for (let i = 1; i <= 5; i++) sig = m.observe(k, "svc", "prod", "app", i, i * 3 * MIN) // steady 3m gaps
    expect(sig).toBeNull()
  })

  it("rebaselines when the restart counter resets (pod recreated)", () => {
    const m = new RestartAccelerationMonitor()
    const k = "prod/p/app"
    m.observe(k, "svc", "prod", "app", 10, 0)
    expect(m.observe(k, "svc", "prod", "app", 0, MIN)).toBeNull() // reset → no flag
  })
})

describe("MemoryTrendMonitor", () => {
  const k = "prod/p/app"
  const LIMIT = 100 * 1024 * 1024 // 100Mi

  it("does not flag while below the high-water mark", () => {
    const m = new MemoryTrendMonitor({ highWatermark: 0.85, minSamples: 3 })
    let sig = null
    for (let i = 0; i < 4; i++) sig = m.observe(k, "svc", "prod", "p", "app", 50 * 1024 * 1024, LIMIT, i * MIN)
    expect(sig).toBeNull()
  })

  it("flags when usage is high AND rising", () => {
    const m = new MemoryTrendMonitor({ highWatermark: 0.85, minSamples: 3 })
    // climbing: 86% -> 90% -> 95% of limit
    m.observe(k, "svc", "prod", "p", "app", 86 * 1024 * 1024, LIMIT, 0)
    m.observe(k, "svc", "prod", "p", "app", 90 * 1024 * 1024, LIMIT, 1 * MIN)
    const sig = m.observe(k, "svc", "prod", "p", "app", 95 * 1024 * 1024, LIMIT, 2 * MIN)
    expect(sig).toMatchObject({ kind: "MemoryPressureRising", hard: false, severity: "warning" })
  })

  it("does not flag high-but-flat usage", () => {
    const m = new MemoryTrendMonitor({ highWatermark: 0.85, minSamples: 3 })
    let sig = null
    for (let i = 0; i < 4; i++) sig = m.observe(k, "svc", "prod", "p", "app", 90 * 1024 * 1024, LIMIT, i * MIN)
    expect(sig).toBeNull()
  })

  it("emits once per sustained climb (not every sample)", () => {
    const m = new MemoryTrendMonitor({ highWatermark: 0.85, minSamples: 3 })
    m.observe(k, "svc", "prod", "p", "app", 86 * 1024 * 1024, LIMIT, 0)
    m.observe(k, "svc", "prod", "p", "app", 90 * 1024 * 1024, LIMIT, 1 * MIN)
    const first = m.observe(k, "svc", "prod", "p", "app", 95 * 1024 * 1024, LIMIT, 2 * MIN)
    const second = m.observe(k, "svc", "prod", "p", "app", 97 * 1024 * 1024, LIMIT, 3 * MIN)
    expect(first).not.toBeNull()
    expect(second).toBeNull()
  })
})
