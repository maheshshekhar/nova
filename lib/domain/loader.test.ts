import { afterEach, describe, expect, it } from "vitest"
import { getDomain, loadDomainPack, resetDomainCache } from "@/lib/domain/loader"
import { DEFAULT_DOMAIN } from "@/lib/domain/defaults"

afterEach(() => resetDomainCache())

describe("loadDomainPack — file packs", () => {
  it("loads the payments example pack with its glossary, catalog and impact unit", () => {
    const d = loadDomainPack({ path: "domains/payments.yaml" })
    expect(d.id).toBe("payments")
    expect(d.displayName).toBe("Payments Platform")
    expect(d.glossary.map((g) => g.term)).toContain("checkout")
    expect(d.services.map((s) => s.name)).toContain("payment-service")
    expect(d.impactSignal.unit).toBe("failed checkout transactions")
  })

  it("loads the generic-k8s pack with NEUTRAL prompt defaults (no domain wording)", () => {
    const d = loadDomainPack({ path: "domains/generic-k8s.yaml" })
    expect(d.id).toBe("generic-k8s")
    // promptVars omitted in the file ⇒ the schema's neutral defaults apply.
    expect(d.promptVars.rootCauseHint).toBe("(the underlying failure mechanism)")
    expect(d.impactSignal.match.level).toBe("ERROR")
  })
})

describe("loadDomainPack — validation & defaults", () => {
  it("fills defaults for a minimal pack", () => {
    const d = loadDomainPack({ raw: "domain:\n  id: minimal\n" })
    expect(d.id).toBe("minimal")
    expect(d.glossary).toEqual([])
    expect(d.services).toEqual([])
    expect(d.promptVars.namespaceGuidance).toContain("Kubernetes namespace")
  })

  it("throws when the required domain.id is missing", () => {
    expect(() => loadDomainPack({ raw: "domain:\n  displayName: nope\n" })).toThrow()
  })
})

describe("getDomain — default", () => {
  it("falls back to the built-in default domain when no domain is configured", () => {
    expect(getDomain().id).toBe(DEFAULT_DOMAIN.id)
    expect(getDomain().id).toBe("default")
  })
})
