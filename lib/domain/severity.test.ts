import { describe, expect, it } from "vitest"
import { severityFor } from "@/lib/domain/severity"
import { SeverityRuleSchema } from "@/lib/config/schema"

const rules = (arr: unknown[]) => arr.map((r) => SeverityRuleSchema.parse(r))

describe("severityFor — threshold operators", () => {
  const r = rules([
    { when: { errorRatePct: ">5" }, severity: "critical" },
    { when: { errorRatePct: ">1" }, severity: "high" },
  ])

  it("returns the first rule whose condition is satisfied", () => {
    expect(severityFor({ errorRatePct: 6 }, r)).toBe("critical")
    expect(severityFor({ errorRatePct: 2 }, r)).toBe("high")
  })

  it("distinguishes a strict > boundary (>5 excludes exactly 5)", () => {
    // 5 is NOT > 5, so it falls through the critical rule to high (>1).
    expect(severityFor({ errorRatePct: 5 }, r)).toBe("high")
  })

  it("returns null when no rule matches", () => {
    expect(severityFor({ errorRatePct: 0.5 }, r)).toBeNull()
  })
})

describe("severityFor — operator coverage", () => {
  it("supports >=, <=, <, =/== and a bare number (equality)", () => {
    expect(severityFor({ x: 5 }, rules([{ when: { x: ">=5" }, severity: "critical" }]))).toBe(
      "critical"
    )
    expect(severityFor({ x: 5 }, rules([{ when: { x: "<=5" }, severity: "high" }]))).toBe("high")
    expect(severityFor({ x: 4 }, rules([{ when: { x: "<5" }, severity: "medium" }]))).toBe(
      "medium"
    )
    expect(severityFor({ x: 5 }, rules([{ when: { x: "=5" }, severity: "low" }]))).toBe("low")
    expect(severityFor({ x: 5 }, rules([{ when: { x: "==5" }, severity: "low" }]))).toBe("low")
    // Bare number ⇒ equality.
    expect(severityFor({ x: 3 }, rules([{ when: { x: 3 }, severity: "medium" }]))).toBe("medium")
    expect(severityFor({ x: 4 }, rules([{ when: { x: 3 }, severity: "medium" }]))).toBeNull()
  })
})

describe("severityFor — multiple conditions and missing metrics", () => {
  it("requires EVERY condition in a rule's `when` to match (AND)", () => {
    const r = rules([{ when: { errorRatePct: ">5", latencyMs: ">1000" }, severity: "critical" }])
    expect(severityFor({ errorRatePct: 6, latencyMs: 1500 }, r)).toBe("critical")
    expect(severityFor({ errorRatePct: 6, latencyMs: 500 }, r)).toBeNull()
  })

  it("never matches a condition on a metric that is absent", () => {
    const r = rules([{ when: { errorRatePct: ">5" }, severity: "critical" }])
    expect(severityFor({ latencyMs: 9999 }, r)).toBeNull()
  })

  it("returns null for an empty ruleset", () => {
    expect(severityFor({ errorRatePct: 99 }, [])).toBeNull()
  })
})
