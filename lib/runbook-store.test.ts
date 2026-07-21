import { describe, expect, it } from "vitest"
import { loadRunbookDir } from "@/lib/runbook-store"

describe("loadRunbookDir — validation & resilience", () => {
  it("loads valid runbooks and SKIPS a malformed file with a captured error", () => {
    const { runbooks, errors } = loadRunbookDir("test/fixtures/runbooks")
    expect(runbooks.map((r) => r.id)).toEqual(["GOOD-RB"])
    expect(errors).toHaveLength(1)
    expect(errors[0].file).toBe("bad.yaml")
    expect(errors[0].error).toBeTruthy()
  })

  it("returns an empty result for a directory that does not exist", () => {
    expect(loadRunbookDir("test/fixtures/does-not-exist")).toEqual({ runbooks: [], errors: [] })
  })

  it("loads the shipped payments authoring example with its executable action", () => {
    const { runbooks, errors } = loadRunbookDir("domains/payments/runbooks")
    expect(errors).toEqual([])
    const rb = runbooks.find((r) => r.id === "DB-POOL-SCALE")
    expect(rb).toBeDefined()
    expect(rb?.domain).toBe("payments")
    expect(rb?.action?.type).toBe("k8s")
    expect(rb?.action?.params.replicas).toBe(6)
    expect(rb?.action?.requiresApproval).toBe(true)
  })
})
