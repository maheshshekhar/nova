import type { NovaConfig } from "@/lib/config/schema"
import type { Domain } from "@/lib/domain/schema"

// A safe, read-only projection of the resolved configuration for the Settings UI.
// Nova config is file-authoritative (D4), so the UI is read-only and shows
// provenance. Crucially this view NEVER contains a secret value: API keys live in
// env and are surfaced only as "<ENV_VAR> (set|unset)", never their value; URLs
// with embedded credentials are redacted. Pure + injectable env ⇒ fully testable.

export interface SettingsRow {
  key: string
  value: string
  /** True when this row reports an env-managed secret's presence (never its value). */
  secret?: boolean
}

export interface SettingsTab {
  id: string
  title: string
  rows: SettingsRow[]
}

export interface SettingsView {
  /** Config is file-authoritative → the UI is read-only. */
  editable: false
  source: string
  tabs: SettingsTab[]
}

type Env = Record<string, string | undefined>

// Redact credentials embedded in a URL (scheme://user:pass@host → scheme://***@host).
export function redactUrl(url: string): string {
  return url.replace(/(^[a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/i, "$1***@")
}

/** Report an env-managed secret by NAME + presence only — never its value. */
function secretRow(key: string, envVar: string | undefined, env: Env): SettingsRow {
  if (!envVar) return { key, value: "not configured", secret: true }
  const present = env[envVar] !== undefined && env[envVar] !== ""
  return { key, value: `${envVar} (${present ? "set" : "unset"})`, secret: true }
}

export function buildSettingsView(
  config: NovaConfig,
  domain: Domain,
  env: Env = process.env
): SettingsView {
  const { ai, logs, persistence, metrics, prompts, eval: evalCfg, detection, features } = config

  const providers: SettingsTab = {
    id: "providers",
    title: "Providers",
    rows: [
      { key: "AI provider", value: ai.provider },
      { key: "AI model", value: ai.model ?? "(provider default)" },
      secretRow("AI API key", ai.apiKeyEnv, env),
      { key: "Logs provider", value: logs.provider },
      { key: "Logs URL", value: redactUrl(logs.url) },
      { key: "Persistence provider", value: persistence.provider },
      { key: "Persistence seed", value: persistence.seed },
      { key: "Metrics provider", value: metrics.provider },
      { key: "Metrics URL", value: metrics.url ? redactUrl(metrics.url) : "(none)" },
    ],
  }

  const logScope: SettingsTab = {
    id: "log-scope",
    title: "Log scope",
    rows: [
      { key: "Include", value: JSON.stringify(logs.scope.include ?? []) },
      { key: "Exclude", value: JSON.stringify(logs.scope.exclude ?? []) },
      { key: "Field: namespace", value: logs.fields.namespace },
      { key: "Field: service", value: logs.fields.service },
      { key: "Field: level", value: logs.fields.level },
      { key: "Field: timestamp", value: logs.fields.timestamp },
    ],
  }

  const domainTab: SettingsTab = {
    id: "domain",
    title: "Domain",
    rows: [
      { key: "Domain id", value: domain.id },
      { key: "Display name", value: domain.displayName ?? "—" },
      { key: "Glossary terms", value: String(domain.glossary.length) },
      { key: "Services", value: String(domain.services.length) },
      { key: "Impact unit", value: domain.impactSignal.unit ?? domain.impactSignal.label },
      { key: "Failure types", value: domain.failureTypes.join(", ") || "(none)" },
    ],
  }

  const promptsTab: SettingsTab = {
    id: "prompts",
    title: "Prompts",
    rows: [
      { key: "Triage template", value: prompts.triage },
      { key: "RCA template", value: prompts.rca },
      { key: "Chat template", value: prompts.chat },
      { key: "Judge template", value: prompts.judge },
      { key: "Custom variables", value: String(Object.keys(prompts.variables).length) },
    ],
  }

  const runbooksTab: SettingsTab = {
    id: "runbooks",
    title: "Runbooks",
    rows: [
      { key: "Domain runbooks", value: domain.runbooks ?? "(built-in only)" },
    ],
  }

  const evalTab: SettingsTab = {
    id: "eval",
    title: "Evaluation",
    rows: [
      { key: "Enabled", value: String(evalCfg.enabled) },
      { key: "Grade incidents", value: String(evalCfg.gradeIncidents) },
      { key: "Judge model", value: evalCfg.judge.model ?? "(default)" },
      secretRow("Judge API key", evalCfg.judge.apiKeyEnv, env),
      { key: "Pass threshold", value: String(evalCfg.scoring.passThreshold) },
      {
        key: "Weights",
        value: `deterministic ${evalCfg.scoring.weights.deterministic} / judge ${evalCfg.scoring.weights.judge}`,
      },
    ],
  }

  const detectionTab: SettingsTab = {
    id: "detection",
    title: "Detection",
    rows: [
      { key: "Auto-detect", value: String(detection.autoDetect) },
      { key: "Source", value: detection.source },
      { key: "Impact label", value: detection.impactSignal.label },
      { key: "Severity rules", value: String(detection.severityRules.length) },
    ],
  }

  const featuresTab: SettingsTab = {
    id: "features",
    title: "Features",
    rows: [
      { key: "Chat", value: String(features.chat) },
      { key: "Eval", value: String(features.eval) },
      { key: "Auto-remediation", value: String(features.autoRemediation) },
    ],
  }

  const notifications = config.notifications
  const notificationsTab: SettingsTab = {
    id: "notifications",
    title: "Notifications",
    rows: [
      { key: "Enabled", value: String(notifications.enabled) },
      {
        key: "Channels",
        value:
          notifications.channels.map((c) => `${c.id} (${c.type})`).join(", ") || "(none)",
      },
      { key: "Routes", value: String(notifications.routes.length) },
      { key: "Slack interactions", value: String(notifications.interactive.slack.enabled) },
      { key: "PagerDuty webhook", value: String(notifications.interactive.pagerduty.enabled) },
    ],
  }

  return {
    editable: false,
    source: config.domain ? "nova.config.yaml" : "defaults",
    tabs: [
      providers,
      logScope,
      domainTab,
      promptsTab,
      runbooksTab,
      evalTab,
      detectionTab,
      featuresTab,
      notificationsTab,
    ],
  }
}
