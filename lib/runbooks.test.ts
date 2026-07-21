import { describe, expect, it } from "vitest"
import { matchRunbook, selectRunbook } from "@/lib/runbooks"

// Minimal runbook-like objects for the pure matcher (only the fields it reads).
const rb = (o: {
  id: string
  failureTypes: string[]
  services?: string[]
  domain?: string
}) => o

describe("selectRunbook — matching", () => {
  const runbooks = [
    rb({ id: "TYPE-ONLY", failureTypes: ["OOMKilled"] }),
    rb({ id: "SERVICE-SCOPED", failureTypes: ["OOMKilled"], services: ["worker"] }),
  ]

  it("prefers a runbook scoped to the service over a type-only match", () => {
    expect(selectRunbook(runbooks, "OOMKilled", "worker")?.id).toBe("SERVICE-SCOPED")
  })

  it("falls back to the first type match when no service-scoped runbook applies", () => {
    expect(selectRunbook(runbooks, "OOMKilled", "other")?.id).toBe("TYPE-ONLY")
    expect(selectRunbook(runbooks, "OOMKilled")?.id).toBe("TYPE-ONLY")
  })

  it("returns null when nothing handles the failure type", () => {
    expect(selectRunbook(runbooks, "disk-pressure")).toBeNull()
  })
})

describe("selectRunbook — domain scoping", () => {
  const runbooks = [
    rb({ id: "UNIVERSAL", failureTypes: ["OOMKilled"] }),
    rb({ id: "PAYMENTS", failureTypes: ["OOMKilled"], domain: "payments" }),
    rb({ id: "STREAMING", failureTypes: ["OOMKilled"], domain: "streaming" }),
  ]

  it("excludes runbooks tagged for a different domain, keeps untagged (universal) ones", () => {
    // For the payments domain, STREAMING is excluded; PAYMENTS (service-less) or
    // UNIVERSAL can match — first in list wins after filtering.
    const match = selectRunbook(runbooks, "OOMKilled", undefined, "payments")
    expect(["UNIVERSAL", "PAYMENTS"]).toContain(match?.id)
    expect(match?.id).not.toBe("STREAMING")
  })

  it("prefers a domain-specific service-scoped runbook", () => {
    const list = [
      rb({ id: "UNIVERSAL", failureTypes: ["OOMKilled"] }),
      rb({ id: "PAY-SVC", failureTypes: ["OOMKilled"], services: ["payment-service"], domain: "payments" }),
    ]
    expect(selectRunbook(list, "OOMKilled", "payment-service", "payments")?.id).toBe("PAY-SVC")
  })

  it("does not domain-filter when no domain is given (back-compat)", () => {
    expect(selectRunbook(runbooks, "OOMKilled")?.id).toBe("UNIVERSAL")
  })
})

describe("matchRunbook — over the built-in RUNBOOKS", () => {
  it("returns the service-scoped config recovery runbook for a config-service crash", () => {
    expect(matchRunbook("config-missing", "config-service")?.id).toBe("CONFIG-RECOVERY")
  })

  it("returns the rolling-restart runbook for an OOMKill", () => {
    expect(matchRunbook("OOMKilled")?.id).toBe("ROLLING-RESTART")
  })

  it("returns null for the payment db-pool cascade (intentionally not covered)", () => {
    expect(matchRunbook("db-pool-exhaustion")).toBeNull()
  })
})
