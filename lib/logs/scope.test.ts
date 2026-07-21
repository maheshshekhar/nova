import { describe, expect, it } from "vitest"
import { compileScopeToLogQL, resolveScope } from "@/lib/logs/scope"
import { DEFAULT_CONFIG } from "@/lib/config/defaults"
import { LogFieldsSchema, type LogScope, type LogFields } from "@/lib/config/schema"

const DEFAULT_SCOPE = DEFAULT_CONFIG.logs.scope
const DEFAULT_FIELDS = DEFAULT_CONFIG.logs.fields

describe("resolveScope — precedence + include/exclude merge", () => {
  const config: LogScope = {
    include: [{ namespace: "production" }],
    exclude: [{ service: "load-generator" }],
  }

  it("uses the config default when nothing else is specified", () => {
    expect(resolveScope({ config })).toEqual(config)
  })

  it("lets an incident scope override include while inheriting the config exclude", () => {
    const incident: LogScope = { include: [{ namespace: "payments" }] }
    expect(resolveScope({ incident, config })).toEqual({
      include: [{ namespace: "payments" }],
      exclude: [{ service: "load-generator" }],
    })
  })

  it("prefers the incident scope over a UI override for the same part", () => {
    const incident: LogScope = { include: [{ namespace: "payments" }] }
    const override: LogScope = { include: [{ namespace: "checkout" }] }
    expect(resolveScope({ incident, override, config }).include).toEqual([
      { namespace: "payments" },
    ])
  })

  it("uses the UI override when the incident does not specify that part", () => {
    const override: LogScope = { exclude: [{ container: "istio-proxy" }] }
    const resolved = resolveScope({ override, config })
    // include falls through to config; exclude comes from the override.
    expect(resolved.include).toEqual([{ namespace: "production" }])
    expect(resolved.exclude).toEqual([{ container: "istio-proxy" }])
  })

  it("treats a present-but-empty array as a deliberate choice (not a fall-through)", () => {
    const override: LogScope = { include: [] }
    // Empty include ⇒ cluster-wide; must NOT fall back to the config include.
    expect(resolveScope({ override, config }).include).toEqual([])
  })
})

describe("compileScopeToLogQL — default config is byte-identical to today", () => {
  it("compiles the default scope with no service to the exact legacy query", () => {
    expect(compileScopeToLogQL(DEFAULT_SCOPE, DEFAULT_FIELDS)).toBe(
      `{namespace="production", app!="load-generator"}`
    )
  })

  it("drops the load-generator exclusion when a service pins the app field", () => {
    expect(
      compileScopeToLogQL(DEFAULT_SCOPE, DEFAULT_FIELDS, { service: "payment-service" })
    ).toBe(`{namespace="production", app="payment-service"}`)
  })

  it("appends the case-insensitive level line filter", () => {
    expect(
      compileScopeToLogQL(DEFAULT_SCOPE, DEFAULT_FIELDS, {
        service: "payment-service",
        levels: ["ERROR", "WARN"],
      })
    ).toBe(`{namespace="production", app="payment-service"} |~ "(?i)(ERROR|WARN)"`)
  })
})

describe("compileScopeToLogQL — scope translation", () => {
  it("turns an array of values into a regex alternation (=~)", () => {
    const scope: LogScope = { include: [{ namespace: ["payments", "checkout"] }] }
    expect(compileScopeToLogQL(scope, DEFAULT_FIELDS)).toBe(
      `{namespace=~"payments|checkout"}`
    )
  })

  it("merges values for the same dimension across multiple include groups", () => {
    const scope: LogScope = {
      include: [{ namespace: "payments" }, { namespace: "checkout" }],
    }
    expect(compileScopeToLogQL(scope, DEFAULT_FIELDS)).toBe(
      `{namespace=~"payments|checkout"}`
    )
  })

  it("keeps distinct dimensions as AND-ed matchers in first-seen order", () => {
    const scope: LogScope = {
      include: [{ namespace: "platform", service: "api-gateway" }],
    }
    expect(compileScopeToLogQL(scope, DEFAULT_FIELDS)).toBe(
      `{namespace="platform", app="api-gateway"}`
    )
  })

  it("compiles a {regex} matcher into a =~ matcher", () => {
    const scope: LogScope = { include: [{ namespace: { regex: "team-.+" } }] }
    expect(compileScopeToLogQL(scope, DEFAULT_FIELDS)).toBe(`{namespace=~"team-.+"}`)
  })

  it("compiles an exclude array into a negative regex matcher (!~)", () => {
    const scope: LogScope = {
      include: [{ namespace: "production" }],
      exclude: [{ service: ["load-generator", "synthetics"] }],
    }
    expect(compileScopeToLogQL(scope, DEFAULT_FIELDS)).toBe(
      `{namespace="production", app!~"load-generator|synthetics"}`
    )
  })

  it("passes an unknown logical dimension through as a verbatim backend label", () => {
    const scope: LogScope = { include: [{ namespace: "production", team: "core" }] }
    expect(compileScopeToLogQL(scope, DEFAULT_FIELDS)).toBe(
      `{namespace="production", team="core"}`
    )
  })

  it("respects a custom field mapping for the namespace/service dimensions", () => {
    const fields: LogFields = LogFieldsSchema.parse({
      namespace: "k8s_namespace",
      service: "container_name",
    })
    const scope: LogScope = { include: [{ namespace: "prod", service: "api" }] }
    expect(compileScopeToLogQL(scope, fields)).toBe(
      `{k8s_namespace="prod", container_name="api"}`
    )
  })

  it("escapes regex metacharacters in exact array values", () => {
    const scope: LogScope = { include: [{ namespace: ["a.b", "c+d"] }] }
    expect(compileScopeToLogQL(scope, DEFAULT_FIELDS)).toBe(
      `{namespace=~"a\\.b|c\\+d"}`
    )
  })

  it("returns an empty selector when scope has no include or exclude", () => {
    expect(compileScopeToLogQL({}, DEFAULT_FIELDS)).toBe(`{}`)
  })
})
