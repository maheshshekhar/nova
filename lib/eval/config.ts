import { getConfig } from "@/lib/config/loader"
import type { NovaConfig } from "@/lib/config/schema"

// Eval configuration accessors. Judge model, scoring weights, pass threshold and
// the enable/grade toggles now come from `nova.config.yaml` (eval.*) instead of
// being hardcoded or env-only. Every helper takes an optional config (defaulting
// to the loaded one) so it is trivially unit-testable. Defaults reproduce today's
// behaviour. See open-source-plan §11.

export function getScoringWeights(cfg: NovaConfig = getConfig()) {
  return cfg.eval.scoring.weights
}

export function getPassThreshold(cfg: NovaConfig = getConfig()): number {
  return cfg.eval.scoring.passThreshold
}

export function isEvalEnabled(cfg: NovaConfig = getConfig()): boolean {
  return cfg.eval.enabled
}

export function shouldGradeIncidents(cfg: NovaConfig = getConfig()): boolean {
  return cfg.eval.gradeIncidents
}

export function getJudgeTemperature(cfg: NovaConfig = getConfig()): number {
  return cfg.eval.judge.temperature
}

/**
 * Resolve the judge model: config `eval.judge.model` wins, then `EVAL_JUDGE_MODEL`,
 * then the built-in default (OpenRouter vs Anthropic). Config default is unset, so
 * with no config this matches the previous env-based resolution exactly.
 */
export function resolveJudgeModel(cfg: NovaConfig = getConfig()): string {
  const configModel = cfg.eval.judge.model
  if (configModel) return configModel
  return (
    process.env.EVAL_JUDGE_MODEL ||
    (process.env.OPENROUTER_API_KEY ? "anthropic/claude-opus-4.1" : "claude-opus-4-1")
  )
}

/** Whether a 0–1 score passes the configured (or given) threshold. */
export function passed(score: number, threshold: number = getPassThreshold()): boolean {
  return score >= threshold
}
