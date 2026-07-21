import { describe, expect, it } from "vitest"
import { RunbookSchema } from "@/lib/runbook-schema"

describe("RunbookSchema — validation", () => {
  it("parses a full runbook and exposes steps as `actions` too", () => {
    const rb = RunbookSchema.parse({
      id: "RB-1",
      title: "Fix it",
      failureTypes: ["OOMKilled"],
      services: ["worker"],
      domain: "generic-k8s",
      steps: ["step one", "step two"],
      action: { type: "http-webhook", url: "https://example.test/hook" },
    })
    expect(rb.id).toBe("RB-1")
    expect(rb.actions).toEqual(["step one", "step two"])
    expect(rb.action?.type).toBe("http-webhook")
    // requiresApproval defaults to true (safe by default).
    expect(rb.action?.requiresApproval).toBe(true)
  })

  it("treats a runbook with no `action` as manual/checklist-only", () => {
    const rb = RunbookSchema.parse({
      id: "RB-MANUAL",
      title: "Checklist",
      failureTypes: ["disk-pressure"],
      steps: ["free up disk"],
    })
    expect(rb.action).toBeUndefined()
  })

  it("defaults an action with no type to `manual`", () => {
    const rb = RunbookSchema.parse({
      id: "RB-2",
      title: "t",
      failureTypes: ["network"],
      action: {},
    })
    expect(rb.action?.type).toBe("manual")
  })

  it("rejects a runbook missing a required id", () => {
    expect(() => RunbookSchema.parse({ title: "no id", failureTypes: ["network"] })).toThrow()
  })

  it("rejects a runbook with an empty failureTypes list", () => {
    expect(() => RunbookSchema.parse({ id: "x", title: "t", failureTypes: [] })).toThrow()
  })
})
