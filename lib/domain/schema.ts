import { z } from "zod"
import { ImpactSignalSchema, SeverityRuleSchema } from "@/lib/config/schema"

// Domain Pack — a single swappable bundle describing the *world* Nova operates in:
// vocabulary, services, what "impact" means, severity thresholds, prompt wording
// and failure taxonomy. Nova core carries ZERO domain knowledge; a pack supplies
// it. See docs/domain-runbooks-settings-plan.md Part 1.

export const GlossaryEntrySchema = z.object({
  term: z.string(),
  meaning: z.string(),
})
export type GlossaryEntry = z.infer<typeof GlossaryEntrySchema>

export const DomainServiceSchema = z
  .object({
    name: z.string(),
    tier: z.number().int().optional(),
    owner: z.string().optional(),
    dependsOn: z.array(z.string()).default([]),
  })
  .passthrough()
export type DomainService = z.infer<typeof DomainServiceSchema>

// Prompt variables merged into the prompt templates (see open-source-plan §8).
// The known keys have NEUTRAL, domain-free defaults so a pack that omits them —
// or the generic-k8s pack — never leaks another domain's vocabulary. The built-in
// DEFAULT_DOMAIN (lib/domain/defaults.ts) overrides them with today's wording so
// no-config behaviour is unchanged. Extra keys pass through for custom templates.
export const PromptVarsSchema = z
  .object({
    remediationGuidance: z
      .string()
      .default(
        "Recommend the standard remediation for this failure mode, using specific kubectl commands where applicable. If the evidence supports it, lead with the most impactful action as remediation step 1."
      ),
    namespaceGuidance: z
      .string()
      .default(
        "Reference the relevant Kubernetes namespace(s) explicitly in any kubectl command you give."
      ),
    rootCauseHint: z.string().default("(the underlying failure mechanism)"),
    resolutionHint: z
      .string()
      .default("describe how the incident was mitigated and resolved"),
  })
  .passthrough()
  .default({})
export type PromptVars = z.infer<typeof PromptVarsSchema>

export const DomainSchema = z.object({
  id: z.string(),
  displayName: z.string().optional(),
  glossary: z.array(GlossaryEntrySchema).default([]),
  services: z.array(DomainServiceSchema).default([]),
  impactSignal: ImpactSignalSchema,
  severityRules: z.array(SeverityRuleSchema).default([]),
  promptVars: PromptVarsSchema,
  failureTypes: z.array(z.string()).default([]),
  // Path to this domain's runbooks (consumed at M7).
  runbooks: z.string().optional(),
})
export type Domain = z.infer<typeof DomainSchema>

export const DomainPackSchema = z.object({ domain: DomainSchema })
export type DomainPack = z.infer<typeof DomainPackSchema>
