import { z } from "zod"

// Backend-neutral action model for runbook remediations. A runbook may carry an
// OPTIONAL executable `action`; omit it entirely for a manual/checklist-only
// runbook. `type` decouples the runbook from Kubernetes so an action can be a
// manual step, an external webhook, a shell command, or a k8s operation.
// See docs/domain-runbooks-settings-plan.md Part 2.

export const ActionTypeSchema = z.enum(["manual", "http-webhook", "shell", "k8s"])
export type ActionType = z.infer<typeof ActionTypeSchema>

export const ActionSpecSchema = z.object({
  type: ActionTypeSchema.default("manual"),
  operation: z.string().optional(),
  target: z
    .object({
      kind: z.string().optional(),
      name: z.string().optional(),
      namespace: z.string().optional(),
    })
    .passthrough()
    .optional(),
  params: z.record(z.unknown()).default({}),
  // http-webhook only: the endpoint to POST to.
  url: z.string().optional(),
  // Executable actions require explicit approval before they run (safe default).
  requiresApproval: z.boolean().default(true),
})
export type ActionSpec = z.infer<typeof ActionSpecSchema>

export interface ActionContext {
  /** Has an operator explicitly approved this run? */
  approved?: boolean
  /** Who is running it (for audit + RBAC). */
  actor?: string
  /** The actor's roles (RBAC). */
  roles?: string[]
}

export interface ActionResult {
  status: "executed" | "manual"
  detail: string
}

export interface ActionExecutor {
  readonly type: ActionType
  execute(action: ActionSpec, ctx: ActionContext): Promise<ActionResult>
}
