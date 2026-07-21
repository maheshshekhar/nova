import "server-only"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import yaml from "js-yaml"
import { z } from "zod"
import { getConfig } from "@/lib/config/loader"
import type { NovaConfig } from "@/lib/config/schema"
import { EVAL_CASES, type EvalCase } from "./cases"

// Golden eval cases come from `eval.goldenCases` (a YAML/JSON file) when set,
// otherwise the built-in EVAL_CASES. Validated on load so a malformed dataset
// fails loudly rather than silently scoring against nothing.

export const EvalExpectationsSchema = z.object({
  rootCauseMustInclude: z.array(z.string()).default([]),
  remediationMustInclude: z.array(z.string()).default([]),
  forbiddenClaims: z.array(z.string()).default([]),
  requiredSections: z.array(z.string()).optional(),
})

export const EvalCaseSchema = z.object({
  id: z.string(),
  title: z.string(),
  failureType: z.string(),
  mode: z.enum(["triage", "rca"]),
  logs: z.array(z.string()),
  context: z.string(),
  expectations: EvalExpectationsSchema,
})

export const GoldenCasesSchema = z.array(EvalCaseSchema).min(1)

export function loadGoldenCases(cfg: NovaConfig = getConfig()): EvalCase[] {
  const path = cfg.eval.goldenCases
  if (!path) return EVAL_CASES
  const parsed = yaml.load(readFileSync(resolve(process.cwd(), path), "utf8"))
  return GoldenCasesSchema.parse(parsed)
}
