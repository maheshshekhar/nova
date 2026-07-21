import "server-only"
import { complete } from "@/lib/ai/complete"
import { getConfig } from "@/lib/config/loader"
import { renderTemplateFile } from "@/lib/ai/prompt-template"
import { getScoringWeights, getJudgeTemperature, resolveJudgeModel } from "./config"
import type { EvalCase } from "./cases"

// Scoring for a single eval case: cheap deterministic checks + an LLM-as-judge
// (a separate, stronger model) for the nuanced dimensions.

export interface DeterministicChecks {
  rootCausePass: boolean
  remediationPass: boolean
  noHallucinationPass: boolean
  sectionsPass: boolean
  /** 0–1 fraction of the applicable deterministic checks that passed. */
  score: number
  details: string[]
}

export interface JudgeScores {
  groundedness: number // 0–1
  formatCompliance: number // 0–1
  remediationCorrectness: number // 0–1
  hallucinationPass: boolean
  rationale: string
  judgeModel: string
}

export interface CaseResult {
  caseId: string
  title: string
  mode: EvalCase["mode"]
  output: string
  deterministic: DeterministicChecks
  judge: JudgeScores | null
  /** Combined 0–1 score used for ranking / aggregate. */
  overall: number
  error?: string
}

function includesAll(haystack: string, needles: string[]): { pass: boolean; missing: string[] } {
  const lower = haystack.toLowerCase()
  const missing = needles.filter((n) => !lower.includes(n.toLowerCase()))
  return { pass: missing.length === 0, missing }
}

function includesAny(haystack: string, needles: string[]): string[] {
  const lower = haystack.toLowerCase()
  return needles.filter((n) => lower.includes(n.toLowerCase()))
}

export function runDeterministicChecks(c: EvalCase, output: string): DeterministicChecks {
  const details: string[] = []

  const rc = includesAll(output, c.expectations.rootCauseMustInclude)
  if (!rc.pass) details.push(`root-cause missing: ${rc.missing.join(", ")}`)

  const rem = includesAll(output, c.expectations.remediationMustInclude)
  if (!rem.pass) details.push(`remediation missing: ${rem.missing.join(", ")}`)

  const hallucinated = includesAny(output, c.expectations.forbiddenClaims)
  const noHallucinationPass = hallucinated.length === 0
  if (!noHallucinationPass) details.push(`forbidden claims present: ${hallucinated.join(", ")}`)

  let sectionsPass = true
  if (c.expectations.requiredSections?.length) {
    const missingSections = c.expectations.requiredSections.filter(
      (s) => !output.toLowerCase().includes(s.toLowerCase())
    )
    sectionsPass = missingSections.length === 0
    if (!sectionsPass) details.push(`missing sections: ${missingSections.join(", ")}`)
  }

  const applicable = [rc.pass, rem.pass, noHallucinationPass]
  if (c.expectations.requiredSections?.length) applicable.push(sectionsPass)
  const score = applicable.filter(Boolean).length / applicable.length

  return {
    rootCausePass: rc.pass,
    remediationPass: rem.pass,
    noHallucinationPass,
    sectionsPass,
    score,
    details,
  }
}

function buildJudgePrompt(c: EvalCase, output: string): string {
  const { prompts } = getConfig()
  return renderTemplateFile(prompts.judge, {
    ...prompts.variables,
    context: c.context,
    logs: c.logs.join("\n"),
    rootCauseMustInclude: c.expectations.rootCauseMustInclude.join(", "),
    remediationMustInclude: c.expectations.remediationMustInclude.join(", "),
    forbiddenClaims: c.expectations.forbiddenClaims.join(", "),
    output,
    modeDescription: c.mode === "rca" ? "full RCA document" : "concise triage response",
  })
}

function parseJudge(text: string): Omit<JudgeScores, "judgeModel"> {
  // Be tolerant of code fences / stray prose around the JSON.
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) throw new Error("judge returned no JSON")
  const raw = JSON.parse(match[0])
  const clamp = (n: any) => Math.max(0, Math.min(1, Number(n) || 0))
  return {
    groundedness: clamp(raw.groundedness),
    formatCompliance: clamp(raw.formatCompliance),
    remediationCorrectness: clamp(raw.remediationCorrectness),
    hallucinationPass: Boolean(raw.hallucinationPass),
    rationale: typeof raw.rationale === "string" ? raw.rationale : "",
  }
}

export async function runJudge(c: EvalCase, output: string): Promise<JudgeScores> {
  // A separate / stronger model grades the output to reduce self-scoring bias.
  const judgeModel = resolveJudgeModel()

  const { text } = await complete({
    prompt: buildJudgePrompt(c, output),
    model: judgeModel,
    maxTokens: 500,
    temperature: getJudgeTemperature(),
  })
  return { ...parseJudge(text), judgeModel }
}

/** Combine deterministic + judge into a single 0–1 overall score. */
export function combineScore(
  det: DeterministicChecks,
  judge: JudgeScores | null,
  weights = getScoringWeights()
): number {
  if (!judge) return det.score
  const judgeAvg =
    (judge.groundedness +
      judge.formatCompliance +
      judge.remediationCorrectness +
      (judge.hallucinationPass ? 1 : 0)) /
    4
  // Deterministic checks are objective ground truth → weighted a bit higher by
  // default (config `eval.scoring.weights`).
  return Math.round((det.score * weights.deterministic + judgeAvg * weights.judge) * 100) / 100
}
