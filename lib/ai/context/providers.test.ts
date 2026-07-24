import { describe, expect, it } from "vitest"
import {
  clusterProvider,
  defaultContextProviders,
  domainProvider,
  evalsProvider,
  incidentsProvider,
  logsProvider,
  rcasProvider,
  runbooksProvider,
  statusProvider,
  type ContextInput,
} from "@/lib/ai/context/providers"
import { renderContext } from "@/lib/ai/context/engine"

// Deterministic formatter so date-derived output is stable across machines/tz.
const fmt = (d: Date) => `@${d.getTime()}`

function baseInput(overrides: Partial<ContextInput> = {}): ContextInput {
  return {
    now: new Date(1_700_000_000_000),
    timezone: "UTC",
    phase: "healthy",
    fmt,
    active: null,
    past: [],
    pastDefaults: { severity: "critical", users: 1234, title: "Primary", failureType: "db-pool-exhaustion" },
    archive: [],
    storedRcas: [],
    evalRuns: [],
    runbooks: [],
    cluster: { available: false, namespaces: [], services: [] },
    logs: { label: "service-a", entries: [] },
    ...overrides,
  }
}

describe("statusProvider", () => {
  it("reports the date, timezone, and the healthy status line", () => {
    const b = statusProvider.build(baseInput())!
    expect(b.lines).toEqual([
      "Today is @1700000000000 (UTC).",
      "Current system status: all systems operational.",
    ])
  })

  it("reports an active-incident status when phase is not healthy/degrading", () => {
    const b = statusProvider.build(baseInput({ phase: "incident" }))!
    expect(b.lines[1]).toBe("Current system status: an active incident is in progress.")
  })
})

describe("domainProvider", () => {
  it("returns null when no domain is provided (behaviour-preserving default)", () => {
    expect(domainProvider.build(baseInput())).toBeNull()
  })

  it("returns null when the domain has no glossary and no services", () => {
    expect(domainProvider.build(baseInput({ domain: { glossary: [], services: [] } }))).toBeNull()
  })

  it("renders the glossary and service catalog for grounding", () => {
    const b = domainProvider.build(
      baseInput({
        domain: {
          displayName: "Payments Platform",
          glossary: [{ term: "checkout", meaning: "the payment-completion flow" }],
          services: [
            { name: "payment-service", tier: 1, owner: "payments-team", dependsOn: ["postgres"] },
          ],
        },
      })
    )!
    expect(b.lines[1]).toBe("DOMAIN: Payments Platform (glossary + service catalog for grounding):")
    expect(b.lines).toContain("- checkout: the payment-completion flow")
    expect(b.lines).toContain(
      "- payment-service (tier 1; owner payments-team; depends on postgres)"
    )
  })
})

describe("incidentsProvider", () => {
  it("renders active + past + archive rows, deduped by id and sorted newest-first", () => {
    const input = baseInput({
      phase: "incident",
      active: {
        id: "INC-900",
        service: "service-a",
        severity: "critical",
        title: "Live cascade",
        failureType: "db-pool-exhaustion",
        startedAt: 3000,
        users: 50,
      },
      past: [{ id: "INC-800", service: "service-a", startedAt: 1000, resolvedAt: 1000 + 120000 }],
      archive: [
        {
          id: "INC-700",
          title: "Old one",
          service: "cart",
          severity: "high",
          status: "resolved",
          failureType: "OOMKilled",
          startedAt: 2000,
          durationMin: 5,
          affectedUsers: 10,
          rca: null,
        },
        // Duplicate id of the active row — must be ignored (active wins).
        {
          id: "INC-900",
          title: "dup",
          service: "x",
          severity: "low",
          status: "resolved",
          failureType: "x",
          startedAt: 9999,
          durationMin: 1,
          affectedUsers: 1,
          rca: null,
        },
      ],
    })
    const b = incidentsProvider.build(input)!
    expect(b.lines[0]).toBe("")
    expect(b.lines[1]).toContain("INCIDENTS (3 total")
    // Sorted by startedAt desc: 3000 (active), 2000 (archive), 1000 (past).
    expect(b.lines[2]).toBe(
      "- INC-900 | @3000 | service-a | CRITICAL | ACTIVE | ongoing | db-pool-exhaustion | 50 users | Live cascade"
    )
    expect(b.lines[3]).toBe(
      "- INC-700 | @2000 | cart | HIGH | resolved | 5m | OOMKilled | 10 users | Old one"
    )
    expect(b.lines[4]).toBe(
      "- INC-800 | @1000 | service-a | CRITICAL | resolved | 2m | db-pool-exhaustion | 1,234 users | Primary"
    )
  })

  it("emits an explicit empty-state line when there are no incidents", () => {
    const b = incidentsProvider.build(baseInput())!
    expect(b.lines).toContain("INCIDENTS: none recorded — all systems nominal.")
  })

  it("omits the active row when phase is healthy", () => {
    const input = baseInput({
      active: {
        id: "INC-1",
        service: "s",
        severity: "critical",
        title: "t",
        failureType: "f",
        startedAt: 1,
        users: 1,
      },
    })
    const b = incidentsProvider.build(input)!
    expect(b.lines[1]).toContain("INCIDENTS (0 total")
  })
})

describe("rcasProvider", () => {
  it("returns null when there are no RCAs", () => {
    expect(rcasProvider.build(baseInput())).toBeNull()
  })

  it("merges archive + stored RCAs (stored wins), newest-first, with per-item budget", () => {
    const input = baseInput({
      archive: [
        {
          id: "INC-1",
          title: "t",
          service: "s",
          severity: "high",
          status: "resolved",
          failureType: "f",
          startedAt: 1,
          durationMin: 1,
          affectedUsers: 1,
          rca: { text: "archive rca text", generatedAt: "2024-01-01T00:00:00Z" },
        },
      ],
      storedRcas: [{ id: "INC-2", text: "stored rca text", generatedAt: "2024-02-01T00:00:00Z" }],
    })
    const b = rcasProvider.build(input)!
    expect(b.lines[1]).toBe("RCA SUMMARIES (2 available, newest first):")
    // Newest (INC-2, Feb) before older (INC-1, Jan).
    expect(b.lines[2]).toContain("--- INC-2 (generated 2024-02-01T00:00:00Z) ---")
    expect(b.lines[3]).toBe("stored rca text")
    expect(b.lines[4]).toContain("--- INC-1")
  })

  it("skips RCAs whose text is blank", () => {
    const input = baseInput({
      storedRcas: [{ id: "INC-3", text: "   ", generatedAt: "2024-01-01T00:00:00Z" }],
    })
    expect(rcasProvider.build(input)).toBeNull()
  })
})

describe("evalsProvider", () => {
  it("returns null when there are no eval runs", () => {
    expect(evalsProvider.build(baseInput())).toBeNull()
  })

  it("renders run summaries with percentages and per-case judge scores", () => {
    const input = baseInput({
      evalRuns: [
        {
          id: "run-1",
          finishedAt: "",
          generatorModel: "gpt",
          judgeModel: "claude",
          aggregate: 0.912,
          caseCount: 2,
          kind: "golden",
          results: [
            { caseId: "c1", overall: 0.8, judge: { groundedness: 0.9, hallucinationPass: true } },
            { caseId: "c2", overall: 0.5, judge: null },
          ],
        },
      ],
    })
    const b = evalsProvider.build(input)!
    expect(b.lines[1]).toContain("AI QUALITY EVALS (1 runs")
    expect(b.lines[2]).toBe(
      "- run-1 | recently | golden suite | aggregate 91% | 2 case(s) | gen: gpt | judge: claude"
    )
    expect(b.lines[3]).toBe("    · c1: overall 80%, grounded 90%, halluc pass")
    expect(b.lines[4]).toBe("    · c2: overall 50%")
  })
})

describe("runbooksProvider", () => {
  it("renders each runbook with its failure-types, service scope, diagnosis and ETA", () => {
    const input = baseInput({
      runbooks: [
        {
          id: "RB-1",
          title: "Fix pool",
          failureTypes: ["db-pool-exhaustion"],
          services: ["payment-service"],
          diagnosis: "pool exhausted.",
          actions: ["scale up", "shed load"],
          eta: "5m",
        },
      ],
    })
    const b = runbooksProvider.build(input)!
    expect(b.lines[2]).toBe(
      "- RB-1 Fix pool [failure-types: db-pool-exhaustion; services: payment-service] — Diagnosis: pool exhausted. Remediation: scale up; shed load. (ETA 5m)"
    )
  })
})

describe("clusterProvider", () => {
  it("returns null when metrics are unavailable or there are no services", () => {
    expect(clusterProvider.build(baseInput())).toBeNull()
    expect(
      clusterProvider.build(baseInput({ cluster: { available: true, namespaces: [], services: [] } }))
    ).toBeNull()
  })

  it("renders namespace inventory + live service state", () => {
    const input = baseInput({
      cluster: {
        available: true,
        namespaces: [{ name: "production", status: "healthy", podCount: 4, services: ["payment-service"] }],
        services: [
          {
            name: "payment-service",
            namespace: "production",
            podCount: 3,
            readyPods: 2,
            crashedPods: 1,
            avgCpu: 40,
            avgMemory: 55,
            status: "degraded",
            errorRate: 5,
          },
        ],
      },
    })
    const b = clusterProvider.build(input)!
    expect(b.lines).toContain("- production (healthy, 4 pods) — services: payment-service")
    expect(b.lines).toContain(
      "- [production] payment-service: 2/3 pods ready, 1 crashing, status degraded, CPU 40%, mem 55%, error rate 5%"
    )
  })
})

describe("logsProvider", () => {
  it("returns null when there are no log entries", () => {
    expect(logsProvider.build(baseInput())).toBeNull()
  })

  it("labels the block from the input (no hardcoded domain string)", () => {
    const entries = [
      { timestamp: "2024-01-01T00:00:00Z", level: "ERROR", message: "boom", pod: "p1", service: "svc" },
    ]
    const generic = logsProvider.build(baseInput({ logs: { label: "video-service", entries } }))!
    expect(generic.lines[1]).toBe("RECENT video-service LOGS (real, most relevant first):")
    const payments = logsProvider.build(baseInput({ logs: { label: "payment-service", entries } }))!
    expect(payments.lines[1]).toBe("RECENT payment-service LOGS (real, most relevant first):")
    // The rendered log line carries the level, pod and message.
    expect(payments.lines[2]).toContain("ERROR [p1]")
    expect(payments.lines[2]).toContain("boom")
  })
})

describe("full render — block ordering (characterization)", () => {
  it("emits sections in status → incidents → rcas → evals → runbooks → cluster → logs order", () => {
    const input = baseInput({
      phase: "incident",
      active: {
        id: "INC-900",
        service: "payment-service",
        severity: "critical",
        title: "Live cascade",
        failureType: "db-pool-exhaustion",
        startedAt: 5000,
        users: 50,
      },
      storedRcas: [{ id: "INC-900", text: "rca body", generatedAt: "2024-02-01T00:00:00Z" }],
      evalRuns: [
        {
          id: "run-1",
          finishedAt: "",
          generatorModel: "gpt",
          judgeModel: null,
          aggregate: 0.9,
          caseCount: 1,
          kind: "golden",
          results: [{ caseId: "c1", overall: 0.9, judge: null }],
        },
      ],
      runbooks: [
        {
          id: "RB-1",
          title: "Fix",
          failureTypes: ["db-pool-exhaustion"],
          diagnosis: "d.",
          actions: ["a"],
          eta: "5m",
        },
      ],
      cluster: {
        available: true,
        namespaces: [],
        services: [
          {
            name: "payment-service",
            podCount: 3,
            readyPods: 3,
            crashedPods: 0,
            avgCpu: 1,
            avgMemory: 1,
            status: "healthy",
            errorRate: 0,
          },
        ],
      },
      logs: {
        label: "payment-service",
        entries: [{ timestamp: "2024-01-01T00:00:00Z", level: "ERROR", message: "boom", pod: "p1", service: "svc" }],
      },
    })

    const out = renderContext(defaultContextProviders, input)
    const idx = (s: string) => out.indexOf(s)

    expect(idx("Current system status:")).toBeGreaterThanOrEqual(0)
    expect(idx("Current system status:")).toBeLessThan(idx("INCIDENTS ("))
    expect(idx("INCIDENTS (")).toBeLessThan(idx("RCA SUMMARIES ("))
    expect(idx("RCA SUMMARIES (")).toBeLessThan(idx("AI QUALITY EVALS ("))
    expect(idx("AI QUALITY EVALS (")).toBeLessThan(idx("RUNBOOKS ("))
    expect(idx("RUNBOOKS (")).toBeLessThan(idx("LIVE CLUSTER STATE"))
    expect(idx("LIVE CLUSTER STATE")).toBeLessThan(idx("RECENT payment-service LOGS"))
  })
})
