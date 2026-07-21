import type {
  ActionContext,
  ActionExecutor,
  ActionResult,
  ActionSpec,
  ActionType,
} from "./types"

// Pluggable action execution behind three gates: RBAC → approval → execute, with
// every attempt (allowed or denied) written to an audit sink. Safe by default:
// a manual runbook never executes anything, and an executable action refuses to
// run without explicit approval. See docs/domain-runbooks-settings-plan.md Part 2
// and open-source-plan §13.3.

export class ApprovalRequiredError extends Error {
  constructor(message = "This action requires explicit approval") {
    super(message)
    this.name = "ApprovalRequiredError"
  }
}
export class ForbiddenError extends Error {
  constructor(message = "Not permitted to run this action") {
    super(message)
    this.name = "ForbiddenError"
  }
}
export class UnknownActionTypeError extends Error {
  constructor(type: string) {
    super(`No executor registered for action type "${type}"`)
    this.name = "UnknownActionTypeError"
  }
}

// ── Audit ────────────────────────────────────────────────────────────────────
export type AuditOutcome = "executed" | "manual" | "denied-approval" | "denied-rbac" | "error"

export interface AuditEntry {
  at: number
  actor?: string
  actionType: string
  operation?: string
  target?: unknown
  outcome: AuditOutcome
  detail: string
}
export type AuditSink = (entry: AuditEntry) => void

// ── Built-in executors ───────────────────────────────────────────────────────
export const manualExecutor: ActionExecutor = {
  type: "manual",
  async execute(): Promise<ActionResult> {
    return { status: "manual", detail: "Manual runbook — no automated action performed." }
  },
}

/** POST the action to an external webhook (any automation the operator wires up). */
export function httpWebhookExecutor(
  fetchImpl: typeof fetch = fetch
): ActionExecutor {
  return {
    type: "http-webhook",
    async execute(action, ctx): Promise<ActionResult> {
      if (!action.url) throw new Error("http-webhook action requires a `url`")
      const res = await fetchImpl(action.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operation: action.operation,
          target: action.target,
          params: action.params,
          actor: ctx.actor,
        }),
      })
      if (!res.ok) throw new Error(`webhook returned ${res.status}`)
      return { status: "executed", detail: `Webhook POST ${action.url} → ${res.status}` }
    },
  }
}

// ── Registry ─────────────────────────────────────────────────────────────────
export class ActionRegistry {
  private executors = new Map<ActionType, ActionExecutor>()

  register(executor: ActionExecutor): this {
    if (this.executors.has(executor.type)) {
      throw new Error(`Executor already registered for "${executor.type}"`)
    }
    this.executors.set(executor.type, executor)
    return this
  }

  has(type: ActionType): boolean {
    return this.executors.has(type)
  }

  get(type: ActionType): ActionExecutor {
    const executor = this.executors.get(type)
    if (!executor) throw new UnknownActionTypeError(type)
    return executor
  }
}

/** GA registry: manual + http-webhook. `shell`/`k8s` are intentionally opt-in
 * (register them explicitly once enabled). */
export function defaultRegistry(): ActionRegistry {
  return new ActionRegistry().register(manualExecutor).register(httpWebhookExecutor())
}

/** Default RBAC: manual actions are always allowed; any executable action
 * requires the actor to hold an `operator` or `admin` role. */
export function defaultRbac(action: ActionSpec, ctx: ActionContext): boolean {
  if (action.type === "manual") return true
  const roles = ctx.roles ?? []
  return roles.includes("operator") || roles.includes("admin")
}

export interface ExecuteDeps {
  registry?: ActionRegistry
  audit?: AuditSink
  rbac?: (action: ActionSpec, ctx: ActionContext) => boolean
  now?: () => number
}

/**
 * Run an action through RBAC → approval → execute, auditing every outcome.
 * Throws `ForbiddenError` (RBAC denied) or `ApprovalRequiredError` (unapproved
 * executable action) BEFORE any executor runs; both are audited. A manual action
 * skips the approval gate and never executes anything.
 */
export async function executeAction(
  action: ActionSpec,
  ctx: ActionContext = {},
  deps: ExecuteDeps = {}
): Promise<ActionResult> {
  const registry = deps.registry ?? defaultRegistry()
  const audit = deps.audit ?? (() => {})
  const rbac = deps.rbac ?? defaultRbac
  const now = deps.now ?? Date.now

  const base = {
    at: now(),
    actor: ctx.actor,
    actionType: action.type,
    operation: action.operation,
    target: action.target,
  }

  if (!rbac(action, ctx)) {
    audit({ ...base, outcome: "denied-rbac", detail: `Actor "${ctx.actor ?? "?"}" lacks permission for a ${action.type} action` })
    throw new ForbiddenError(`Not permitted to run a ${action.type} action`)
  }

  if (action.type !== "manual" && action.requiresApproval && !ctx.approved) {
    audit({ ...base, outcome: "denied-approval", detail: "Approval required before execution" })
    throw new ApprovalRequiredError()
  }

  try {
    const result = await registry.get(action.type).execute(action, ctx)
    audit({ ...base, outcome: result.status === "manual" ? "manual" : "executed", detail: result.detail })
    return result
  } catch (err) {
    audit({ ...base, outcome: "error", detail: (err as Error).message })
    throw err
  }
}
