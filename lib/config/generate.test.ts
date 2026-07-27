import { describe, expect, it } from "vitest"
import yaml from "js-yaml"
import { generateMetricsYaml, suggestionToYaml } from "@/lib/config/generate"
import { MetricsConfigSchema } from "@/lib/config/schema"
import { buildReport } from "@/lib/discovery/fingerprint"

// Parse the generated fragment and validate its `metrics` block through the real
// schema — the guarantee that generated YAML is committable and round-trips.
function parseMetrics(fragment: string) {
  const doc = yaml.load(fragment) as { metrics?: unknown }
  return MetricsConfigSchema.parse(doc?.metrics ?? {})
}

describe("generateMetricsYaml", () => {
  it("produces a valid metrics block that round-trips through the schema", () => {
    const yamlOut = generateMetricsYaml({
      url: "http://prom:9090",
      serviceLabel: "service",
      preset: "red-prom-client",
      queries: {
        errorRate: 'sum by (service)(rate(http_requests_total{code=~"5.."}[5m]))',
        rps: "sum by (service)(rate(http_requests_total[5m]))",
      },
    })
    const parsed = parseMetrics(yamlOut)
    expect(parsed.provider).toBe("prometheus")
    expect(parsed.serviceLabel).toBe("service")
    expect(parsed.preset).toBe("red-prom-client")
    expect(parsed.queries.errorRate).toContain("http_requests_total")
    expect(parsed.queries.rps).toContain("http_requests_total")
  })

  it("emits the URL as a ${PROMETHEUS_URL:-…} env placeholder (no hardcoded host committed)", () => {
    const out = generateMetricsYaml({ url: "http://prom.monitoring:9090", serviceLabel: "job", queries: {} })
    expect(out).toContain("url: ${PROMETHEUS_URL:-http://prom.monitoring:9090}")
  })

  it("preserves single quotes in PromQL by doubling them (valid YAML)", () => {
    const tricky = "label_replace(x, 'a', 'b', 'c', 'd')"
    const out = generateMetricsYaml({ serviceLabel: "service", queries: { rps: tricky } })
    // Round-trips back to the exact original string.
    expect(parseMetrics(out).queries.rps).toBe(tricky)
  })

  it("includes authTokenEnv (a name, never a value) when provided", () => {
    const out = generateMetricsYaml({ serviceLabel: "service", authTokenEnv: "PROM_TOKEN", queries: {} })
    expect(out).toContain("authTokenEnv: PROM_TOKEN")
  })

  it("omits the queries block when there are none", () => {
    const out = generateMetricsYaml({ serviceLabel: "service", queries: {} })
    expect(out).not.toContain("queries:")
    expect(parseMetrics(out).provider).toBe("prometheus")
  })
})

describe("suggestionToYaml", () => {
  it("turns a discovery suggestion into a committable metrics block", () => {
    // Drive it from the real discovery pipeline for an istio fingerprint.
    const report = buildReport("http://prom:9090", [
      "istio_requests_total",
      "istio_request_duration_milliseconds_bucket",
    ])
    const istio = report.suggestions.find((s) => s.presetId === "istio")!
    const out = suggestionToYaml(istio, { url: report.url })
    const parsed = parseMetrics(out)
    expect(parsed.preset).toBe("istio")
    expect(parsed.serviceLabel).toBe("destination_service_name")
    expect(parsed.queries.rps).toContain("istio_requests_total")
    // No unexpanded template token leaks into the committed file.
    expect(out).not.toContain("$SVC")
  })
})
