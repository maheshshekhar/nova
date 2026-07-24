// Nova configuration schema (single source of truth).
//
// Every field carries a default that reproduces TODAY's behaviour, so
// `NovaConfigSchema.parse({})` yields the current-behaviour config and a partial
// user `nova.config.yaml` is deep-filled by zod. Adapters are selected by the
// `provider` discriminator on each section and resolved via the adapter registry.
//
// Provider-specific sub-objects use `.passthrough()` so backend-specific keys
// (index, uri, logGroupNames, …) survive validation without being enumerated here
// before the adapters that consume them exist (M2/M3/M9).

import { z } from "zod"

// ── Log scope (see docs/log-scope-agnostic-plan.md) ──────────────────────────
// A backend-neutral selector: logical dimension → exact value(s) or a regex.
export const SelectorSchema = z.record(
  z.union([z.string(), z.array(z.string()), z.object({ regex: z.string() })])
)
export type Selector = z.infer<typeof SelectorSchema>

export const LogScopeSchema = z
  .object({
    include: z.array(SelectorSchema).optional(),
    exclude: z.array(SelectorSchema).optional(),
  })
  .default({})
export type LogScope = z.infer<typeof LogScopeSchema>

// ── AI generation ────────────────────────────────────────────────────────────
export const AiConfigSchema = z
  .object({
    provider: z
      .enum(["openrouter", "anthropic", "openai", "azure", "ollama"])
      .default("openrouter"),
    // Left undefined by default so adapters keep falling back to their env-based
    // model resolution (behaviour-neutral until explicitly configured).
    model: z.string().optional(),
    apiKeyEnv: z.string().optional(),
    maxTokens: z
      .object({
        triage: z.number().int().positive().default(400),
        rca: z.number().int().positive().default(4000),
        chat: z.number().int().positive().default(1200),
      })
      .default({}),
    temperature: z.number().min(0).max(2).default(0),
  })
  .default({})
export type AiConfig = z.infer<typeof AiConfigSchema>

// ── Logging backend ──────────────────────────────────────────────────────────
export const LogFieldsSchema = z
  .object({
    namespace: z.string().default("namespace"),
    service: z.string().default("app"),
    level: z.string().default("level"),
    message: z.string().default("message"),
    timestamp: z.string().default("timestamp"),
  })
  .default({})
export type LogFields = z.infer<typeof LogFieldsSchema>

export const LogsConfigSchema = z
  .object({
    provider: z
      .enum(["loki", "elasticsearch", "opensearch", "mcp", "cloudwatch", "datadog", "http", "file"])
      .default("loki"),
    url: z.string().default("http://loki:3100"),
    fields: LogFieldsSchema,
    // Default reproduces today's `{namespace="production", app!="load-generator"}`.
    // (D5: a real deployment must set its own scope; this default matches the
    // demo's namespace so existing behaviour is unchanged.)
    scope: LogScopeSchema.default({
      include: [{ namespace: "production" }],
      exclude: [{ service: "load-generator" }],
    }),
    // MCP log source (experimental — provider: mcp). Nova calls the tool directly.
    mcp: z
      .object({
        transport: z.enum(["stdio", "http", "sse"]).default("stdio"),
        command: z.array(z.string()).default([]), // stdio
        url: z.string().optional(), // http / sse
        tool: z.string(),
        argMap: z.record(z.string()).default({}),
        resultPath: z.string().default(""),
        scopeFormat: z.enum(["logql", "json"]).default("logql"),
      })
      .optional(),
    discovery: z
      .object({
        enabled: z.boolean().default(false),
        dimension: z.string().default("namespace"),
        refreshSec: z.number().int().positive().default(300),
        deny: z.array(z.string()).default([]),
      })
      .passthrough()
      .optional(),
    defaultWindowMin: z.number().int().positive().default(30),
    maxEntries: z.number().int().positive().default(5000),
  })
  .passthrough()
  .default({})
export type LogsConfig = z.infer<typeof LogsConfigSchema>

// ── Persistence ──────────────────────────────────────────────────────────────
export const PersistenceConfigSchema = z
  .object({
    provider: z.enum(["file", "mongo", "postgres", "s3"]).default("file"),
    // File adapter default: keep using the DATA_DIR env / ./data as today.
    dataDir: z.string().optional(),
    // The bundled demo incident history was removed (de-static work): the store
    // now always starts empty and is driven entirely by live incidents. The
    // `seed` field is retained for backward-compatibility and defaults to "none";
    // "demo" is still accepted but no longer ships any content.
    seed: z.enum(["demo", "none"]).default("none"),
  })
  .passthrough()
  .default({})
export type PersistenceConfig = z.infer<typeof PersistenceConfigSchema>

// ── Metrics ──────────────────────────────────────────────────────────────────
export const MetricsConfigSchema = z
  .object({
    provider: z.enum(["prometheus", "http", "none"]).default("http"),
    url: z.string().optional(),
    // Prometheus adapter (provider: prometheus). Nova is only a PromQL CLIENT —
    // it queries an existing Prometheus, it never scrapes. The queries below are
    // config-driven so the adapter stays domain-agnostic: each entry maps a
    // metric key (see lib/metrics/descriptors.ts) to a PromQL expression that
    // MUST return an instant vector labelled by `serviceLabel`. Only the keys the
    // operator configures are populated; everything else is simply absent.
    authTokenEnv: z.string().optional(),
    serviceLabel: z.string().default("service"),
    queries: z.record(z.string()).default({}),
  })
  .passthrough()
  .default({})
export type MetricsConfig = z.infer<typeof MetricsConfigSchema>

// ── Dashboard (de-static: source-driven, config-curated presentation) ────────
// The dashboard renders only values that come from a real source. This section
// lets an integrator *curate* that presentation without hardcoding any service
// or value: which workloads are infrastructure vs application, which service-
// table columns / stat tiles to show, and per-metric threshold overrides.
//
// Every field defaults to "auto" behaviour so `parse({})` reproduces the
// capability-driven auto-discovery (columns/tiles appear only when a real value
// exists). A tile's `metric` binds to a real metric key (see
// lib/metrics/descriptors.ts) — tiles with no real source never render.
export const DashboardTileSchema = z
  .object({
    id: z.string(),
    label: z.string().optional(),
    // A tile is bound EITHER to a real metric key (`metric`, a fleet aggregate)
    // OR to a PromQL expression (`query`, executed server-side against the
    // configured Prometheus — never in the browser). At least one is required.
    metric: z.string().optional(),
    query: z.string().optional(),
    // Display suffix for query tiles (e.g. "ms", "%", "/s").
    unit: z.string().optional(),
    // Per-tile tone thresholds (lower-better assumed).
    thresholds: z
      .object({ warn: z.number().optional(), critical: z.number().optional() })
      .strict()
      .optional(),
  })
  .passthrough()
  .refine((t) => !!t.metric || !!t.query, {
    message: "a dashboard tile requires either `metric` or `query`",
  })
export type DashboardTile = z.infer<typeof DashboardTileSchema>

export const ThresholdOverrideSchema = z
  .object({
    warn: z.number().optional(),
    critical: z.number().optional(),
  })
  .strict()
export type ThresholdOverride = z.infer<typeof ThresholdOverrideSchema>

export const DashboardConfigSchema = z
  .object({
    // Workload name(s) or substrings treated as infrastructure and excluded
    // from the "application services" view. Domain-agnostic: empty by default.
    infraWorkloads: z.array(z.string()).default([]),
    serviceTable: z
      .object({
        // "auto" = show a column for every metric field the source reports.
        // A list pins an explicit ordered set of metric keys.
        columns: z.union([z.literal("auto"), z.array(z.string())]).default("auto"),
      })
      .default({}),
    stats: z
      .object({
        // "auto" = derive stat tiles from real aggregates. A list pins explicit
        // tile definitions, each bound to a real metric key.
        tiles: z.union([z.literal("auto"), z.array(DashboardTileSchema)]).default("auto"),
      })
      .default({}),
    // Per-metric threshold overrides (metric key → { warn, critical }) applied
    // on top of the descriptor defaults in lib/metrics/descriptors.ts.
    thresholds: z.record(ThresholdOverrideSchema).default({}),
  })
  .default({})
export type DashboardConfig = z.infer<typeof DashboardConfigSchema>

// ── Detection & impact (consumed at M6) ──────────────────────────────────────
export const ImpactSignalSchema = z
  .object({
    match: z
      .object({ level: z.string().optional(), pattern: z.string().optional() })
      .passthrough()
      .default({}),
    label: z.string().default("failed requests"),
    // Human-readable unit of impact (e.g. "failed checkout transactions").
    unit: z.string().optional(),
  })
  .default({})
export type ImpactSignal = z.infer<typeof ImpactSignalSchema>

export const SeverityRuleSchema = z.object({
  when: z.record(z.union([z.string(), z.number()])).default({}),
  severity: z.enum(["critical", "high", "medium", "low"]),
})
export type SeverityRule = z.infer<typeof SeverityRuleSchema>

export const DetectionConfigSchema = z
  .object({
    autoDetect: z.boolean().default(true),
    source: z.enum(["alerts", "log-rule", "metrics-threshold"]).default("alerts"),
    impactSignal: ImpactSignalSchema,
    severityRules: z.array(SeverityRuleSchema).default([]),
  })
  .default({})
export type DetectionConfig = z.infer<typeof DetectionConfigSchema>

// ── Context assembly (consumed at M4) ────────────────────────────────────────
export const ContextProviderConfigSchema = z
  .object({ id: z.string(), enabled: z.boolean().default(true) })
  .passthrough()

export const ContextConfigSchema = z
  .object({
    maxTokens: z.number().int().positive().default(12000),
    providers: z
      .array(ContextProviderConfigSchema)
      .default([
        { id: "incidents", enabled: true },
        { id: "rcas", enabled: true },
        { id: "logs", enabled: true },
        { id: "metrics", enabled: true },
        { id: "runbooks", enabled: true },
        { id: "evals", enabled: true },
      ]),
    retrieval: z
      .object({ mode: z.enum(["dump", "filtered", "vector"]).default("dump") })
      .default({}),
  })
  .default({})
export type ContextConfig = z.infer<typeof ContextConfigSchema>

// ── Prompts (consumed at M5) ─────────────────────────────────────────────────
export const PromptsConfigSchema = z
  .object({
    rca: z.string().default("./prompts/rca.md"),
    triage: z.string().default("./prompts/triage.md"),
    chat: z.string().default("./prompts/chat-system.md"),
    judge: z.string().default("./prompts/judge.md"),
    variables: z.record(z.string()).default({}),
  })
  .default({})
export type PromptsConfig = z.infer<typeof PromptsConfigSchema>

// ── Evaluation & judge (consumed at M8) ──────────────────────────────────────
export const EvalConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    judge: z
      .object({
        provider: z
          .enum(["openrouter", "anthropic", "openai", "azure", "ollama"])
          .default("anthropic"),
        model: z.string().optional(),
        apiKeyEnv: z.string().optional(),
        temperature: z.number().min(0).max(2).default(0),
      })
      .default({}),
    // Matches today's combineScore weighting (deterministic 0.55 / judge 0.45).
    scoring: z
      .object({
        weights: z
          .object({
            deterministic: z.number().min(0).max(1).default(0.55),
            judge: z.number().min(0).max(1).default(0.45),
          })
          .default({}),
        passThreshold: z.number().min(0).max(1).default(0.8),
      })
      .default({}),
    goldenCases: z.string().optional(),
    gradeIncidents: z.boolean().default(true),
  })
  .default({})
export type EvalConfig = z.infer<typeof EvalConfigSchema>

// ── Feature toggles ──────────────────────────────────────────────────────────
export const FeaturesConfigSchema = z
  .object({
    chat: z.boolean().default(true),
    eval: z.boolean().default(true),
    autoRemediation: z.boolean().default(false),
  })
  .default({})
export type FeaturesConfig = z.infer<typeof FeaturesConfigSchema>

// ── Notifications (M14) ──────────────────────────────────────────────────────
// Outbound channels (Slack/PagerDuty/webhook) that fire on incident lifecycle
// events. Secrets are referenced by ENV VAR NAME (never stored in the file).
export const NotificationChannelSchema = z.discriminatedUnion("type", [
  z.object({ id: z.string(), type: z.literal("webhook"), urlEnv: z.string() }),
  z.object({ id: z.string(), type: z.literal("slack"), webhookUrlEnv: z.string() }),
  z.object({ id: z.string(), type: z.literal("pagerduty"), routingKeyEnv: z.string() }),
  z.object({ id: z.string(), type: z.literal("msteams"), webhookUrlEnv: z.string() }),
  z.object({
    id: z.string(),
    type: z.literal("email"),
    // SMTP connection URL (smtp://user:pass@host:port) referenced by env var name.
    urlEnv: z.string(),
    from: z.string(),
    to: z.array(z.string()).min(1),
  }),
])
export type NotificationChannelConfig = z.infer<typeof NotificationChannelSchema>

export const NotificationRouteSchema = z.object({
  when: z
    .object({
      severity: z.array(z.string()).optional(),
      service: z.array(z.string()).optional(),
      domain: z.array(z.string()).optional(),
      failureType: z.array(z.string()).optional(),
      event: z.array(z.string()).optional(),
    })
    .default({}),
  channels: z.array(z.string()).min(1),
})
export type NotificationRoute = z.infer<typeof NotificationRouteSchema>

export const NotificationsConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    dedupeWindowSec: z.number().int().nonnegative().default(300),
    events: z
      .array(z.string())
      .default(["incident.opened", "incident.resolved", "rca.generated"]),
    channels: z.array(NotificationChannelSchema).default([]),
    routes: z.array(NotificationRouteSchema).default([]),
    // Map a domain service `owner` → one or more channel ids (ownership paging).
    ownerRouting: z.record(z.union([z.string(), z.array(z.string())])).default({}),
    // Interactive inbound integrations (M14c). Each inbound endpoint verifies a
    // request signature before acting; secrets are ENV VAR NAMES.
    interactive: z
      .object({
        slack: z
          .object({
            enabled: z.boolean().default(false),
            signingSecretEnv: z.string().default("SLACK_SIGNING_SECRET"),
            // Slack user ids allowed to approve remediation (RBAC allowlist).
            approvers: z.array(z.string()).default([]),
          })
          .default({}),
        pagerduty: z
          .object({
            enabled: z.boolean().default(false),
            secretEnv: z.string().default("PAGERDUTY_WEBHOOK_SECRET"),
          })
          .default({}),
      })
      .default({}),
  })
  .default({})
export type NotificationsConfig = z.infer<typeof NotificationsConfigSchema>

// ── Server ───────────────────────────────────────────────────────────────────
export const ServerConfigSchema = z
  .object({
    logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
    port: z.number().int().positive().default(3000),
  })
  .default({})
export type ServerConfig = z.infer<typeof ServerConfigSchema>

// ── Root ─────────────────────────────────────────────────────────────────────
export const NovaConfigSchema = z
  .object({
    // Optional path to a Domain Pack (domains/*.yaml). Unset ⇒ the built-in
    // default domain (see lib/domain/defaults.ts), which reproduces today's
    // behaviour. See docs/domain-runbooks-settings-plan.md Part 1.
    domain: z.string().optional(),
    ai: AiConfigSchema,
    logs: LogsConfigSchema,
    persistence: PersistenceConfigSchema,
    metrics: MetricsConfigSchema,
    dashboard: DashboardConfigSchema,
    detection: DetectionConfigSchema,
    context: ContextConfigSchema,
    prompts: PromptsConfigSchema,
    eval: EvalConfigSchema,
    features: FeaturesConfigSchema,
    notifications: NotificationsConfigSchema,
    server: ServerConfigSchema,
  })
  .default({})
export type NovaConfig = z.infer<typeof NovaConfigSchema>
