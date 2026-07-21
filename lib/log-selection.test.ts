import { describe, expect, it } from "vitest"
import {
  countCheckoutFailures,
  selectIncidentLogEntries,
  selectIncidentLogs,
  type RawLogEntry,
} from "@/lib/log-selection"

// Characterization tests for the smart log-selection pipeline (dedupe, priority,
// window, budget) and the checkout-failure impact counter. These lock behaviour
// before M4 (context engine) and M6 (config-driven impact signal) refactor it.

const ISO = (ms: number) => new Date(ms).toISOString()
const BASE = 1_768_382_100_000

describe("selectIncidentLogEntries — dedupe", () => {
  it("collapses near-identical lines (volatile ids/timestamps stripped) and counts them", () => {
    const logs: RawLogEntry[] = [
      { level: "ERROR", service: "payment", message: "pool.connect() timeout after 5000ms" },
      { level: "ERROR", service: "payment", message: "pool.connect() timeout after 4200ms" },
      { level: "ERROR", service: "payment", message: "pool.connect() timeout after 9100ms" },
    ]
    const out = selectIncidentLogEntries(logs)
    expect(out).toHaveLength(1)
    expect(out[0].count).toBe(3)
  })

  it("keeps distinct messages separate", () => {
    const logs: RawLogEntry[] = [
      { level: "ERROR", message: "pool exhausted" },
      { level: "ERROR", message: "circuit breaker OPEN" },
    ]
    expect(selectIncidentLogEntries(logs)).toHaveLength(2)
  })
})

describe("selectIncidentLogEntries — prioritisation", () => {
  it("orders ERROR > WARN > INFO > DEBUG, then by original order", () => {
    const logs: RawLogEntry[] = [
      { level: "INFO", message: "started" },
      { level: "DEBUG", message: "trace" },
      { level: "ERROR", message: "boom" },
      { level: "WARN", message: "slowish thing" },
    ]
    const levels = selectIncidentLogEntries(logs).map((d) => (d.entry.level || "").toUpperCase())
    expect(levels).toEqual(["ERROR", "WARN", "INFO", "DEBUG"])
  })

  it("preserves original order when prioritize=false", () => {
    const logs: RawLogEntry[] = [
      { level: "INFO", message: "a" },
      { level: "ERROR", message: "b" },
    ]
    const msgs = selectIncidentLogEntries(logs, { prioritize: false }).map((d) => d.entry.message)
    expect(msgs).toEqual(["a", "b"])
  })
})

describe("selectIncidentLogEntries — window + budget", () => {
  it("filters out entries outside the window but keeps undated entries", () => {
    const logs: RawLogEntry[] = [
      { level: "ERROR", timestamp: ISO(BASE - 10_000), message: "before window" },
      { level: "ERROR", timestamp: ISO(BASE + 10_000), message: "inside window" },
      { level: "ERROR", message: "undated kept" },
    ]
    const out = selectIncidentLogEntries(logs, { windowStart: BASE })
    const msgs = out.map((d) => d.entry.message)
    expect(msgs).toContain("inside window")
    expect(msgs).toContain("undated kept")
    expect(msgs).not.toContain("before window")
  })

  it("caps the result to the budget", () => {
    // Distinct messages that differ by NON-digit content (dedupeKey collapses
    // digit runs, so numbering them would fold them into one line).
    const logs: RawLogEntry[] = Array.from({ length: 50 }, (_, i) => ({
      level: "ERROR",
      message: `distinct message ${"a".repeat(i + 1)}`,
    }))
    expect(selectIncidentLogEntries(logs, { budget: 5 })).toHaveLength(5)
  })
})

describe("selectIncidentLogs — formatting", () => {
  it("emits a formatted string with level, pod and (xN) repeat marker", () => {
    const logs: RawLogEntry[] = [
      { level: "ERROR", pod: "pay-1", message: "pool timeout 100" },
      { level: "ERROR", pod: "pay-1", message: "pool timeout 200" },
    ]
    const [line] = selectIncidentLogs(logs)
    expect(line).toContain("ERROR")
    expect(line).toContain("[pay-1]")
    expect(line).toContain("(x2)")
  })
})

describe("countCheckoutFailures", () => {
  it("counts 503 / service-unavailable / pool-timeout / too-many-connections signals", () => {
    const logs: RawLogEntry[] = [
      { message: "POST /api/checkout 503 Service Unavailable" },
      { message: "pool.connect() timeout after 5000ms" },
      { message: "FATAL: too many connections for role payment_svc" },
      { message: "checkout completed ok" }, // not a failure
    ]
    expect(countCheckoutFailures(logs)).toBe(3)
  })

  it("bounds counting to the incident window when given", () => {
    const logs: RawLogEntry[] = [
      { timestamp: ISO(BASE - 60_000), message: "503 before window" },
      { timestamp: ISO(BASE + 60_000), message: "503 inside window" },
    ]
    expect(countCheckoutFailures(logs, { windowStart: BASE })).toBe(1)
  })

  it("returns 0 when there are no failure signals", () => {
    expect(countCheckoutFailures([{ message: "all good" }])).toBe(0)
  })
})
