import { describe, expect, it } from "vitest"
import { NovaConfigSchema, LogScopeSchema, SeverityRuleSchema } from "@/lib/config/schema"
import { DEFAULT_CONFIG } from "@/lib/config/defaults"

// M1: the schema is the single source of truth for "today's" behaviour. These
// tests pin the key defaults (so an accidental change is caught) and prove the
// schema accepts valid partial configs and rejects malformed ones with clear errors.

describe("NovaConfigSchema — defaults reproduce today's behaviour", () => {
  it("defaults to the file store, Loki logs, http metrics and openrouter AI", () => {
    expect(DEFAULT_CONFIG.persistence.provider).toBe("file")
    expect(DEFAULT_CONFIG.logs.provider).toBe("loki")
    expect(DEFAULT_CONFIG.logs.url).toBe("http://loki:3100")
    expect(DEFAULT_CONFIG.metrics.provider).toBe("http")
    expect(DEFAULT_CONFIG.ai.provider).toBe("openrouter")
  })

  it("defaults the log scope to the production namespace, excluding load-generator", () => {
    expect(DEFAULT_CONFIG.logs.scope.include).toEqual([{ namespace: "production" }])
    expect(DEFAULT_CONFIG.logs.scope.exclude).toEqual([{ service: "load-generator" }])
  })

  it("maps log fields with the Loki `app` label as the service dimension", () => {
    expect(DEFAULT_CONFIG.logs.fields.service).toBe("app")
    expect(DEFAULT_CONFIG.logs.fields.namespace).toBe("namespace")
  })

  it("defaults eval scoring to the current 0.55/0.45 weighting and 0.8 threshold", () => {
    expect(DEFAULT_CONFIG.eval.scoring.weights.deterministic).toBe(0.55)
    expect(DEFAULT_CONFIG.eval.scoring.weights.judge).toBe(0.45)
    expect(DEFAULT_CONFIG.eval.scoring.passThreshold).toBe(0.8)
  })

  it("defaults AI token budgets to the values used by the routes today", () => {
    expect(DEFAULT_CONFIG.ai.maxTokens).toEqual({ triage: 400, rca: 4000, chat: 1200 })
  })

  it("keeps autoRemediation off by default (D8/D9)", () => {
    expect(DEFAULT_CONFIG.features.autoRemediation).toBe(false)
  })

  it("parsing an empty object yields the full default config", () => {
    expect(NovaConfigSchema.parse({})).toEqual(DEFAULT_CONFIG)
  })
})

describe("NovaConfigSchema — deep-fill of partial configs", () => {
  it("fills every missing field when only one value is provided", () => {
    const cfg = NovaConfigSchema.parse({ logs: { provider: "elasticsearch" } })
    expect(cfg.logs.provider).toBe("elasticsearch")
    // untouched nested defaults still present
    expect(cfg.logs.fields.service).toBe("app")
    expect(cfg.persistence.provider).toBe("file")
  })

  it("preserves backend-specific keys via passthrough", () => {
    const cfg = NovaConfigSchema.parse({
      persistence: { provider: "mongo", uri: "mongodb://x", database: "nova" },
    })
    expect((cfg.persistence as Record<string, unknown>).uri).toBe("mongodb://x")
    expect((cfg.persistence as Record<string, unknown>).database).toBe("nova")
  })
})

describe("NovaConfigSchema — rejects invalid config", () => {
  it("rejects an unknown logs provider", () => {
    const r = NovaConfigSchema.safeParse({ logs: { provider: "splunk" } })
    expect(r.success).toBe(false)
    if (!r.success) expect(JSON.stringify(r.error.issues)).toContain("provider")
  })

  it("rejects an unknown persistence provider", () => {
    expect(NovaConfigSchema.safeParse({ persistence: { provider: "sqlite" } }).success).toBe(false)
  })

  it("rejects a non-numeric token budget", () => {
    expect(
      NovaConfigSchema.safeParse({ ai: { maxTokens: { triage: "lots" } } }).success
    ).toBe(false)
  })

  it("rejects a temperature outside 0–2", () => {
    expect(NovaConfigSchema.safeParse({ ai: { temperature: 5 } }).success).toBe(false)
  })
})

describe("SeverityRuleSchema", () => {
  it("requires a valid severity enum", () => {
    expect(SeverityRuleSchema.safeParse({ when: {}, severity: "sev1" }).success).toBe(false)
    expect(SeverityRuleSchema.safeParse({ when: {}, severity: "critical" }).success).toBe(true)
  })
})

describe("LogScopeSchema — selector shapes", () => {
  it("accepts string, string[] and regex selector values", () => {
    const r = LogScopeSchema.safeParse({
      include: [{ namespace: ["a", "b"], service: "x", env: { regex: "prod|stage" } }],
    })
    expect(r.success).toBe(true)
  })

  it("rejects a numeric selector value", () => {
    expect(LogScopeSchema.safeParse({ include: [{ namespace: 5 }] }).success).toBe(false)
  })
})
