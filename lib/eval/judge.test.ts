import { describe, expect, it } from "vitest"
import { combineScore, runDeterministicChecks, type JudgeScores } from "@/lib/eval/judge"
import type { EvalCase } from "@/lib/eval/cases"

// Characterization tests for the deterministic scoring + score-combination math.
// These lock the objective checks and the 0.55/0.45 weighting before M8 makes the
// weights configurable — M8 must reproduce these numbers with the default config.

function makeCase(overrides: Partial<EvalCase["expectations"]> = {}): EvalCase {
  return {
    id: "case-1",
    title: "test case",
    failureType: "db-pool-exhaustion",
    mode: "rca",
    logs: [],
    context: "",
    expectations: {
      rootCauseMustInclude: ["connection pool", "exhaust"],
      remediationMustInclude: ["scale"],
      forbiddenClaims: ["memory leak"],
      requiredSections: ["Root Cause", "Timeline"],
      ...overrides,
    },
  }
}

describe("runDeterministicChecks", () => {
  it("passes when all must-include terms and sections are present and no forbidden claim appears", () => {
    const output =
      "Root Cause: the connection pool was exhausted under load. Timeline: ... Remediation: scale the deployment."
    const r = runDeterministicChecks(makeCase(), output)
    expect(r.rootCausePass).toBe(true)
    expect(r.remediationPass).toBe(true)
    expect(r.noHallucinationPass).toBe(true)
    expect(r.sectionsPass).toBe(true)
    expect(r.score).toBe(1)
    expect(r.details).toEqual([])
  })

  it("fails root-cause and records the missing terms", () => {
    const output = "Root Cause: DNS issue. Timeline: ... scale it."
    const r = runDeterministicChecks(makeCase(), output)
    expect(r.rootCausePass).toBe(false)
    expect(r.details.join(" ")).toContain("connection pool")
  })

  it("flags a forbidden claim as a hallucination", () => {
    const output = "Root cause: a connection pool exhaust plus a memory leak. Timeline. scale."
    const r = runDeterministicChecks(makeCase(), output)
    expect(r.noHallucinationPass).toBe(false)
    expect(r.details.join(" ")).toContain("memory leak")
  })

  it("scores the fraction of applicable checks that passed", () => {
    // rootCause ✓, remediation ✗ (no 'scale'), hallucination ✓, sections ✓ ⇒ 3/4
    const output = "connection pool exhaust happened. Root Cause and Timeline present."
    const r = runDeterministicChecks(makeCase(), output)
    expect(r.remediationPass).toBe(false)
    expect(r.score).toBeCloseTo(0.75, 5)
  })

  it("treats requiredSections as optional (auto-pass) when none are specified", () => {
    const output = "connection pool exhaust. scale it."
    const r = runDeterministicChecks(makeCase({ requiredSections: [] }), output)
    expect(r.sectionsPass).toBe(true)
    expect(r.score).toBe(1)
  })
})

describe("combineScore", () => {
  const judge = (o: Partial<JudgeScores>): JudgeScores => ({
    groundedness: 1,
    formatCompliance: 1,
    remediationCorrectness: 1,
    hallucinationPass: true,
    rationale: "",
    judgeModel: "test",
    ...o,
  })

  it("returns the deterministic score when there is no judge", () => {
    const det = runDeterministicChecks(makeCase(), "connection pool exhaust. Root Cause Timeline. scale.")
    expect(combineScore(det, null)).toBe(det.score)
  })

  it("weights deterministic 0.55 and judge-average 0.45, rounded to 2dp", () => {
    const det = { score: 0.5 } as ReturnType<typeof runDeterministicChecks>
    // judgeAvg = (1 + 1 + 1 + 0)/4 = 0.75 ; 0.5*0.55 + 0.75*0.45 = 0.6125 → 0.61
    expect(combineScore(det, judge({ hallucinationPass: false }))).toBe(0.61)
  })

  it("returns 1 for a perfect deterministic + judge result", () => {
    const det = { score: 1 } as ReturnType<typeof runDeterministicChecks>
    expect(combineScore(det, judge({}))).toBe(1)
  })
})
