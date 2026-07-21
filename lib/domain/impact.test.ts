import { describe, expect, it } from "vitest"
import { countImpactSignals } from "@/lib/domain/impact"
import { ImpactSignalSchema } from "@/lib/config/schema"
import { DEFAULT_DOMAIN } from "@/lib/domain/defaults"
import type { RawLogEntry } from "@/lib/log-selection"

const sig = (o: unknown) => ImpactSignalSchema.parse(o)

describe("countImpactSignals — pattern matching", () => {
  const logs: RawLogEntry[] = [
    { level: "ERROR", message: "POST /api/checkout 503 Service Unavailable" },
    { level: "ERROR", message: "pool.connect() timeout after 5000ms" },
    { level: "INFO", message: "checkout completed ok" },
  ]

  it("counts entries whose message matches the regex (case-insensitive)", () => {
    expect(countImpactSignals(logs, sig({ match: { pattern: "503|timeout" } }))).toBe(2)
  })

  it("returns 0 when the pattern matches nothing", () => {
    expect(countImpactSignals(logs, sig({ match: { pattern: "OOMKilled" } }))).toBe(0)
  })

  it("counts nothing when the signal has neither a level nor a pattern", () => {
    expect(countImpactSignals(logs, sig({ match: {} }))).toBe(0)
  })
})

describe("countImpactSignals — level matching", () => {
  const logs: RawLogEntry[] = [
    { level: "ERROR", message: "boom" },
    { level: "error", message: "lowercase level still matches" },
    { level: "WARN", message: "boom" },
  ]

  it("filters by level case-insensitively", () => {
    expect(countImpactSignals(logs, sig({ match: { level: "ERROR" } }))).toBe(2)
  })

  it("requires BOTH level and pattern when both are given", () => {
    expect(
      countImpactSignals(logs, sig({ match: { level: "ERROR", pattern: "boom" } }))
    ).toBe(1)
  })
})

describe("countImpactSignals — window", () => {
  const logs: RawLogEntry[] = [
    { timestamp: 1000, level: "ERROR", message: "503" },
    { timestamp: 5000, level: "ERROR", message: "503" },
  ]

  it("only counts entries at/after windowStart", () => {
    expect(
      countImpactSignals(logs, sig({ match: { pattern: "503" } }), { windowStart: 2000 })
    ).toBe(1)
  })

  it("only counts entries at/before windowEnd", () => {
    expect(
      countImpactSignals(logs, sig({ match: { pattern: "503" } }), { windowEnd: 2000 })
    ).toBe(1)
  })
})

describe("default domain impact signal reproduces the legacy checkout counter", () => {
  it("matches 503 / service unavailable / pool.connect timeout / too many connections", () => {
    const logs: RawLogEntry[] = [
      { message: "503 Service Unavailable" },
      { message: "Service Unavailable" },
      { message: "pool.connect() timeout" },
      { message: "FATAL: too many connections" },
      { message: "everything is fine" },
    ]
    expect(countImpactSignals(logs, DEFAULT_DOMAIN.impactSignal)).toBe(4)
  })
})
