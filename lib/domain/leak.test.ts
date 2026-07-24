import { describe, expect, it } from "vitest"
import { loadDomainPack } from "@/lib/domain/loader"
import { DEFAULT_DOMAIN } from "@/lib/domain/defaults"
import { renderTemplateFile } from "@/lib/ai/prompt-template"
import { getConfig } from "@/lib/config/loader"
import { renderContext } from "@/lib/ai/context/engine"
import { defaultContextProviders, type ContextInput, type ContextDomain } from "@/lib/ai/context/providers"
import type { Domain } from "@/lib/domain/schema"

// The core carries ZERO domain knowledge. Loading a non-payments pack must yield
// NO payment vocabulary anywhere in the assembled context or rendered prompts. If
// a payment assumption ever leaks back into core code, this test fails.

const PAYMENT_VOCAB = /payment-service|checkout|load-generator|pool\.connect|connection pool|postgres/i

const toContextDomain = (d: Domain): ContextDomain => ({
  displayName: d.displayName,
  glossary: d.glossary,
  services: d.services,
})

function genericContextInput(domain: ContextDomain): ContextInput {
  return {
    now: new Date(1_700_000_000_000),
    timezone: "UTC",
    phase: "incident",
    fmt: (d) => `@${d.getTime()}`,
    active: {
      id: "INC-1",
      service: "api-gateway",
      severity: "critical",
      title: "Elevated 5xx on api-gateway",
      failureType: "OOMKilled",
      startedAt: 1000,
      users: 10,
    },
    past: [],
    pastDefaults: { severity: "high", users: 5, title: "prior", failureType: "OOMKilled" },
    archive: [],
    storedRcas: [],
    evalRuns: [],
    runbooks: [
      {
        id: "RB-1",
        title: "Restart crashlooping pod",
        failureTypes: ["OOMKilled"],
        diagnosis: "pod OOMKilled.",
        actions: ["increase memory limit"],
        eta: "5m",
      },
    ],
    cluster: {
      available: true,
      namespaces: [{ name: "default", status: "healthy", podCount: 2, services: ["api-gateway"] }],
      services: [
        {
          name: "api-gateway",
          namespace: "default",
          podCount: 2,
          readyPods: 1,
          crashedPods: 1,
          avgCpu: 30,
          avgMemory: 80,
          status: "degraded",
          errorRate: 4,
        },
      ],
    },
    logs: {
      label: "api-gateway",
      entries: [{ timestamp: "2024-01-01T00:00:00Z", level: "ERROR", message: "OOMKilled", pod: "p1", service: "api-gateway" }],
    },
    domain,
  }
}

describe("domain leak — generic-k8s pack contains no payment vocabulary", () => {
  const generic = loadDomainPack({ path: "domains/generic-k8s.yaml" })

  it("assembled context (with generic domain + generic data) has no payment vocab", () => {
    const out = renderContext(defaultContextProviders, genericContextInput(toContextDomain(generic)))
    expect(out).not.toMatch(PAYMENT_VOCAB)
    // …but it DOES surface the generic domain grounding block.
    expect(out).toContain("DOMAIN: Generic Kubernetes")
  })

  it("rendered triage/rca/chat prompts have no payment vocab under the generic pack", () => {
    const { prompts } = getConfig()
    const vars = { ...generic.promptVars, context: "CTX", logs: "L1" } as Record<string, string>
    const triage = renderTemplateFile(prompts.triage, vars)
    const rca = renderTemplateFile(prompts.rca, vars)
    const chat = renderTemplateFile(prompts.chat, { ...generic.promptVars, context: "CTX" } as Record<string, string>)
    expect(triage).not.toMatch(PAYMENT_VOCAB)
    expect(rca).not.toMatch(PAYMENT_VOCAB)
    expect(chat).not.toMatch(PAYMENT_VOCAB)
  })
})

describe("domain leak — positive controls (the test can actually detect a leak)", () => {
  it("the payments pack's domain block DOES contain payment vocab", () => {
    const payments = loadDomainPack({ path: "domains/payments.yaml" })
    const out = renderContext(
      defaultContextProviders,
      genericContextInput(toContextDomain(payments))
    )
    expect(out).toMatch(PAYMENT_VOCAB)
  })

  it("the default domain carries NO payment vocab (core is domain-agnostic)", () => {
    const { prompts } = getConfig()
    const triage = renderTemplateFile(prompts.triage, {
      ...DEFAULT_DOMAIN.promptVars,
      context: "CTX",
      logs: "L1",
    } as Record<string, string>)
    expect(triage).not.toMatch(PAYMENT_VOCAB)
  })
})
