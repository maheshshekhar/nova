import { describe, expect, it, vi } from "vitest"
import {
  ActionRegistry,
  ApprovalRequiredError,
  ForbiddenError,
  UnknownActionTypeError,
  defaultRegistry,
  executeAction,
  manualExecutor,
  type AuditEntry,
} from "@/lib/actions/executor"
import { ActionSpecSchema, type ActionExecutor } from "@/lib/actions/types"

const spec = (o: unknown) => ActionSpecSchema.parse(o)

function auditCollector() {
  const entries: AuditEntry[] = []
  return { sink: (e: AuditEntry) => entries.push(e), entries }
}

describe("executeAction — manual runbooks never execute", () => {
  it("returns a manual result without approval and audits it as manual", async () => {
    const audit = auditCollector()
    const result = await executeAction(spec({ type: "manual" }), {}, { audit: audit.sink })
    expect(result.status).toBe("manual")
    expect(audit.entries.at(-1)?.outcome).toBe("manual")
  })
})

describe("executeAction — approval gate", () => {
  const action = spec({ type: "http-webhook", url: "https://x.test", requiresApproval: true })

  it("refuses to run an unapproved executable action (and does NOT call the executor)", async () => {
    const fetchImpl = vi.fn()
    const registry = new ActionRegistry().register({
      type: "http-webhook",
      execute: async () => {
        fetchImpl()
        return { status: "executed", detail: "ran" }
      },
    })
    const audit = auditCollector()

    await expect(
      executeAction(action, { roles: ["operator"] }, { registry, audit: audit.sink })
    ).rejects.toBeInstanceOf(ApprovalRequiredError)

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(audit.entries.at(-1)?.outcome).toBe("denied-approval")
  })

  it("runs once approved by an authorised operator", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 202 }) as Response)
    const registry = new ActionRegistry().register({
      type: "http-webhook",
      execute: async (a) => ({ status: "executed", detail: `POST ${a.url}` }),
    } as ActionExecutor)
    const audit = auditCollector()

    const result = await executeAction(
      action,
      { approved: true, roles: ["operator"], actor: "alice" },
      { registry, audit: audit.sink }
    )
    expect(result.status).toBe("executed")
    expect(audit.entries.at(-1)).toMatchObject({ outcome: "executed", actor: "alice" })
    void fetchImpl
  })
})

describe("executeAction — RBAC", () => {
  it("denies an executable action to an actor without an operator/admin role", async () => {
    const audit = auditCollector()
    const action = spec({ type: "http-webhook", url: "https://x.test", requiresApproval: false })
    await expect(
      executeAction(action, { approved: true, roles: ["viewer"], actor: "bob" }, { audit: audit.sink })
    ).rejects.toBeInstanceOf(ForbiddenError)
    expect(audit.entries.at(-1)?.outcome).toBe("denied-rbac")
  })

  it("allows a manual action for anyone (no role required)", async () => {
    const result = await executeAction(spec({ type: "manual" }), { roles: [] })
    expect(result.status).toBe("manual")
  })
})

describe("executeAction — executor receives the exact action", () => {
  it("passes the resolved target and params through to the executor", async () => {
    const seen: { action?: unknown; ctx?: unknown } = {}
    const fakeK8s: ActionExecutor = {
      type: "k8s",
      execute: async (action, ctx) => {
        seen.action = action
        seen.ctx = ctx
        return { status: "executed", detail: "scaled" }
      },
    }
    const registry = new ActionRegistry().register(manualExecutor).register(fakeK8s)
    const audit = auditCollector()

    const action = spec({
      type: "k8s",
      operation: "scale",
      target: { kind: "deployment", name: "payment-service", namespace: "production" },
      params: { replicas: 6 },
      requiresApproval: true,
    })

    const result = await executeAction(
      action,
      { approved: true, roles: ["admin"], actor: "carol" },
      { registry, audit: audit.sink }
    )

    expect(result.detail).toBe("scaled")
    expect(seen.action).toMatchObject({
      operation: "scale",
      target: { name: "payment-service", namespace: "production" },
      params: { replicas: 6 },
    })
    expect(seen.ctx).toMatchObject({ actor: "carol", approved: true })
    expect(audit.entries.at(-1)).toMatchObject({
      outcome: "executed",
      actionType: "k8s",
      operation: "scale",
    })
  })

  it("audits an error and rethrows when the action type has no executor", async () => {
    const audit = auditCollector()
    const action = spec({ type: "k8s", requiresApproval: false })
    await expect(
      executeAction(action, { roles: ["admin"] }, { registry: defaultRegistry(), audit: audit.sink })
    ).rejects.toBeInstanceOf(UnknownActionTypeError)
    expect(audit.entries.at(-1)?.outcome).toBe("error")
  })
})

describe("httpWebhookExecutor", () => {
  it("POSTs the action payload to the webhook url", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 }) as Response)
    const registry = new ActionRegistry()
    const { httpWebhookExecutor } = await import("@/lib/actions/executor")
    registry.register(httpWebhookExecutor(fetchImpl))

    const action = spec({
      type: "http-webhook",
      url: "https://hooks.test/run",
      operation: "restart",
      params: { deployment: "worker" },
      requiresApproval: false,
    })
    const result = await executeAction(action, { roles: ["operator"], actor: "dave" }, { registry })

    expect(result.status).toBe("executed")
    expect(fetchImpl).toHaveBeenCalledOnce()
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("https://hooks.test/run")
    expect(init.method).toBe("POST")
    expect(JSON.parse(init.body as string)).toMatchObject({
      operation: "restart",
      params: { deployment: "worker" },
      actor: "dave",
    })
  })
})
