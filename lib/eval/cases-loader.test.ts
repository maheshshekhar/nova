import { describe, expect, it } from "vitest"
import { loadGoldenCases, EvalCaseSchema, GoldenCasesSchema } from "@/lib/eval/cases-loader"
import { EVAL_CASES } from "@/lib/eval/cases"
import { NovaConfigSchema } from "@/lib/config/schema"

const cfg = (goldenCases?: string) =>
  NovaConfigSchema.parse(goldenCases ? { eval: { goldenCases } } : {})

describe("loadGoldenCases", () => {
  it("returns the built-in EVAL_CASES when no goldenCases path is configured", () => {
    expect(loadGoldenCases(cfg())).toBe(EVAL_CASES)
  })

  it("loads + validates cases from a configured file", () => {
    const cases = loadGoldenCases(cfg("test/fixtures/eval/golden.yaml"))
    expect(cases).toHaveLength(1)
    expect(cases[0].id).toBe("fixture-case")
    expect(cases[0].mode).toBe("triage")
    expect(cases[0].expectations.rootCauseMustInclude).toContain("OOMKilled")
  })

  it("throws when the configured dataset file does not exist", () => {
    expect(() => loadGoldenCases(cfg("test/fixtures/eval/missing.yaml"))).toThrow()
  })
})

describe("EvalCaseSchema — validation", () => {
  it("fills expectation defaults for a minimal case", () => {
    const c = EvalCaseSchema.parse({
      id: "c",
      title: "t",
      failureType: "network",
      mode: "rca",
      logs: ["x"],
      context: "ctx",
      expectations: {},
    })
    expect(c.expectations.rootCauseMustInclude).toEqual([])
    expect(c.expectations.forbiddenClaims).toEqual([])
  })

  it("rejects an invalid mode", () => {
    expect(() =>
      EvalCaseSchema.parse({ id: "c", title: "t", failureType: "network", mode: "bogus", logs: [], context: "" })
    ).toThrow()
  })

  it("rejects an empty golden dataset", () => {
    expect(() => GoldenCasesSchema.parse([])).toThrow()
  })
})
