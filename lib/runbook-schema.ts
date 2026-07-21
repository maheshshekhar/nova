import { z } from "zod"
import { ActionSpecSchema } from "@/lib/actions/types"

// Schema for a user-authored runbook (loaded from a Domain Pack's runbooks
// directory). Validated on load so a malformed runbook is skipped with a clear
// error rather than crashing Nova. See docs/domain-runbooks-settings-plan.md
// Part 2 for the authoring example.
//
// Authoring uses `steps` for the human checklist; the parsed output also exposes
// them as `actions` so it lines up with the built-in Runbook shape used by the
// context/UI.

export const RunbookSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    failureTypes: z.array(z.string()).min(1),
    services: z.array(z.string()).optional(),
    domain: z.string().optional(),
    symptom: z.string().default(""),
    diagnosis: z.string().default(""),
    steps: z.array(z.string()).default([]),
    approvalPrompt: z.string().default(""),
    eta: z.string().default(""),
    // Optional executable action. Omit ⇒ a manual/checklist-only runbook.
    action: ActionSpecSchema.optional(),
  })
  .transform((rb) => ({ ...rb, actions: rb.steps }))

export type StoredRunbook = z.infer<typeof RunbookSchema>
