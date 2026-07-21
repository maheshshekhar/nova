import { describe, expect, it } from "vitest"
import { buildSettingsView, redactUrl } from "@/lib/settings/view"
import { NovaConfigSchema } from "@/lib/config/schema"
import { DEFAULT_DOMAIN } from "@/lib/domain/defaults"

const cfg = (o: Record<string, unknown> = {}) => NovaConfigSchema.parse(o)

describe("redactUrl", () => {
  it("strips embedded credentials, leaves clean URLs untouched", () => {
    expect(redactUrl("https://user:pass@es:9200")).toBe("https://***@es:9200")
    expect(redactUrl("http://loki:3100")).toBe("http://loki:3100")
  })
})

describe("buildSettingsView — structure", () => {
  it("produces the read-only config tabs", () => {
    const view = buildSettingsView(cfg(), DEFAULT_DOMAIN, {})
    expect(view.editable).toBe(false)
    expect(view.tabs.map((t) => t.id)).toEqual([
      "providers",
      "log-scope",
      "domain",
      "prompts",
      "runbooks",
      "eval",
      "detection",
      "features",
      "notifications",
    ])
  })

  it("summarises notifications without leaking secrets", () => {
    const view = buildSettingsView(
      cfg({ notifications: { enabled: true, channels: [{ id: "slack-sre", type: "slack", webhookUrlEnv: "SLACK_WEBHOOK" }] } }),
      DEFAULT_DOMAIN,
      { SLACK_WEBHOOK: "https://hooks.slack.test/super-secret" }
    )
    const tab = view.tabs.find((t) => t.id === "notifications")!
    expect(tab.rows).toContainEqual({ key: "Channels", value: "slack-sre (slack)" })
    // The channel's webhook secret must never appear.
    expect(JSON.stringify(view)).not.toContain("super-secret")
  })

  it("reports the default providers and log scope", () => {
    const view = buildSettingsView(cfg(), DEFAULT_DOMAIN, {})
    const providers = view.tabs.find((t) => t.id === "providers")!
    expect(providers.rows).toContainEqual({ key: "Logs provider", value: "loki" })
    expect(providers.rows).toContainEqual({ key: "Persistence provider", value: "file" })
    const evalTab = view.tabs.find((t) => t.id === "eval")!
    expect(evalTab.rows).toContainEqual({ key: "Pass threshold", value: "0.8" })
  })

  it("marks the source as defaults with no domain, nova.config.yaml with one", () => {
    expect(buildSettingsView(cfg(), DEFAULT_DOMAIN, {}).source).toBe("defaults")
    expect(
      buildSettingsView(cfg({ domain: "./domains/payments.yaml" }), DEFAULT_DOMAIN, {}).source
    ).toBe("nova.config.yaml")
  })
})

describe("buildSettingsView — secrets are never leaked", () => {
  const config = cfg({ ai: { apiKeyEnv: "OPENROUTER_API_KEY" } })

  it("reports an API key by env-var name + presence, never its value", () => {
    const view = buildSettingsView(config, DEFAULT_DOMAIN, { OPENROUTER_API_KEY: "sk-super-secret" })
    const row = view.tabs
      .find((t) => t.id === "providers")!
      .rows.find((r) => r.key === "AI API key")!
    expect(row.secret).toBe(true)
    expect(row.value).toBe("OPENROUTER_API_KEY (set)")
    // The secret value must appear NOWHERE in the serialized view.
    expect(JSON.stringify(view)).not.toContain("sk-super-secret")
  })

  it("reports unset when the env var is absent", () => {
    const view = buildSettingsView(config, DEFAULT_DOMAIN, {})
    const row = view.tabs
      .find((t) => t.id === "providers")!
      .rows.find((r) => r.key === "AI API key")!
    expect(row.value).toBe("OPENROUTER_API_KEY (unset)")
  })

  it("redacts credentials embedded in the logs URL", () => {
    const view = buildSettingsView(
      cfg({ logs: { url: "https://user:pass@es:9200" } }),
      DEFAULT_DOMAIN,
      {}
    )
    const row = view.tabs
      .find((t) => t.id === "providers")!
      .rows.find((r) => r.key === "Logs URL")!
    expect(row.value).toBe("https://***@es:9200")
    expect(JSON.stringify(view)).not.toContain("user:pass")
  })
})
