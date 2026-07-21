import { describe, expect, it } from "vitest"
import {
  getPassThreshold,
  getScoringWeights,
  getJudgeTemperature,
  isEvalEnabled,
  passed,
  resolveJudgeModel,
  shouldGradeIncidents,
} from "@/lib/eval/config"
import { combineScore, type JudgeScores } from "@/lib/eval/judge"
import { NovaConfigSchema } from "@/lib/config/schema"

const cfg = (evalOverrides: Record<string, unknown>) =>
  NovaConfigSchema.parse({ eval: evalOverrides })

describe("eval config — defaults reproduce today's behaviour", () => {
  it("scoring weights default to deterministic 0.55 / judge 0.45", () => {
    expect(getScoringWeights()).toEqual({ deterministic: 0.55, judge: 0.45 })
  })

  it("pass threshold defaults to 0.8; enabled + gradeIncidents default true; judge temp 0", () => {
    expect(getPassThreshold()).toBe(0.8)
    expect(isEvalEnabled()).toBe(true)
    expect(shouldGradeIncidents()).toBe(true)
    expect(getJudgeTemperature()).toBe(0)
  })
})

describe("eval config — reads overrides from config", () => {
  it("reflects custom weights, threshold and toggles", () => {
    const c = cfg({
      enabled: false,
      gradeIncidents: false,
      scoring: { weights: { deterministic: 0.7, judge: 0.3 }, passThreshold: 0.9 },
    })
    expect(getScoringWeights(c)).toEqual({ deterministic: 0.7, judge: 0.3 })
    expect(getPassThreshold(c)).toBe(0.9)
    expect(isEvalEnabled(c)).toBe(false)
    expect(shouldGradeIncidents(c)).toBe(false)
  })

  it("prefers the configured judge model over env/defaults", () => {
    const c = cfg({ judge: { model: "anthropic/claude-3.7" } })
    expect(resolveJudgeModel(c)).toBe("anthropic/claude-3.7")
  })

  it("falls back to a built-in judge model when none is configured", () => {
    // No config model ⇒ env / default resolution (never the empty string).
    expect(resolveJudgeModel(cfg({}))).toBeTruthy()
  })
})

describe("passed — threshold boundary", () => {
  it("passes at or above the threshold, fails below", () => {
    expect(passed(0.8, 0.8)).toBe(true)
    expect(passed(0.81, 0.8)).toBe(true)
    expect(passed(0.79, 0.8)).toBe(false)
  })

  it("uses the configured default threshold when none is given", () => {
    expect(passed(0.8)).toBe(true) // default 0.8
    expect(passed(0.5)).toBe(false)
  })
})

describe("combineScore — honours configurable weights", () => {
  const det = { rootCausePass: true, remediationPass: true, noHallucinationPass: true, sectionsPass: true, score: 0.5, details: [] }
  const judge: JudgeScores = {
    groundedness: 1,
    formatCompliance: 1,
    remediationCorrectness: 1,
    hallucinationPass: true,
    rationale: "",
    judgeModel: "test",
  }

  it("weights deterministic vs judge per the supplied weights", () => {
    // judgeAvg = 1; det.score = 0.5. With 0.7/0.3 ⇒ 0.5*0.7 + 1*0.3 = 0.65.
    expect(combineScore(det, judge, { deterministic: 0.7, judge: 0.3 })).toBe(0.65)
  })

  it("defaults to the config weights (0.55/0.45) when none are passed", () => {
    // 0.5*0.55 + 1*0.45 = 0.725 → 0.73 (rounded 2dp).
    expect(combineScore(det, judge)).toBe(0.73)
  })
})
