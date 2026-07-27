import { describe, expect, it, vi } from "vitest"
import {
  matchPresets,
  expandQueries,
  buildReport,
  fetchMetricNames,
  unpinnedDetectedKeys,
} from "@/lib/discovery/fingerprint"
import { PRESETS } from "@/lib/discovery/presets"

// Metric-name fixtures per exporter shape.
const PROM_CLIENT = ["http_requests_total", "http_request_duration_seconds_bucket", "process_cpu_seconds_total"]
const ISTIO = ["istio_requests_total", "istio_request_duration_milliseconds_bucket", "istio_tcp_sent_bytes_total"]
const OTEL = ["http_server_request_duration_seconds_bucket", "http_server_request_duration_seconds_count"]
const NGINX = ["nginx_ingress_controller_requests", "nginx_ingress_controller_request_duration_seconds_bucket"]

describe("matchPresets", () => {
  it("matches the generic RED preset for prom-client metric names", () => {
    const matches = matchPresets(PROM_CLIENT)
    expect(matches.map((m) => m.preset.id)).toContain("red-prom-client")
    const red = matches.find((m) => m.preset.id === "red-prom-client")!
    expect(red.confidence).toBeGreaterThan(0)
    expect(red.matched).toContain("http_requests_total")
  })

  it("matches Istio for mesh metric names", () => {
    const matches = matchPresets(ISTIO)
    expect(matches[0].preset.id).toBe("istio")
    expect(matches[0].confidence).toBe(1)
  })

  it("matches the OTel semconv preset", () => {
    expect(matchPresets(OTEL).map((m) => m.preset.id)).toContain("otel-http")
  })

  it("matches NGINX ingress", () => {
    expect(matchPresets(NGINX)[0].preset.id).toBe("nginx-ingress")
  })

  it("returns nothing when no fingerprint is present", () => {
    expect(matchPresets(["up", "go_goroutines"])).toEqual([])
  })

  it("ranks by confidence (highest first)", () => {
    const matches = matchPresets([...ISTIO, ...NGINX])
    for (let i = 1; i < matches.length; i++) {
      expect(matches[i - 1].confidence).toBeGreaterThanOrEqual(matches[i].confidence)
    }
  })

  it("respects fingerprint.all (does not match when a required name is absent)", () => {
    // istio requires istio_requests_total; without it there is no istio match.
    const matches = matchPresets(["istio_request_duration_milliseconds_bucket"])
    expect(matches.map((m) => m.preset.id)).not.toContain("istio")
  })
})

describe("expandQueries", () => {
  it("substitutes $SVC with the preset's service label", () => {
    const istio = PRESETS.find((p) => p.id === "istio")!
    const q = expandQueries(istio)
    expect(q.rps).toContain("by (destination_service_name)")
    expect(q.rps).not.toContain("$SVC")
  })

  it("honours an overridden service label", () => {
    const red = PRESETS.find((p) => p.id === "red-prom-client")!
    const q = expandQueries(red, "app")
    expect(q.errorRate).toContain("by (app)")
    expect(q.latencyP95).toContain("by (app, le)")
  })
})

describe("buildReport", () => {
  it("produces ranked suggestions with expanded queries ready for metrics.queries", () => {
    const report = buildReport("http://prom:9090", PROM_CLIENT)
    expect(report.reachable).toBe(true)
    expect(report.metricNameCount).toBe(PROM_CLIENT.length)
    const red = report.suggestions.find((s) => s.presetId === "red-prom-client")!
    expect(red.queries.rps).toContain("http_requests_total")
    expect(red.queries.rps).not.toContain("$SVC")
    expect(red.serviceLabel).toBe("service")
  })

  it("reports a reason when nothing matches", () => {
    const report = buildReport("http://prom:9090", ["up"])
    expect(report.suggestions).toEqual([])
    expect(report.reason).toMatch(/No known exporter/)
  })
})

describe("unpinnedDetectedKeys", () => {
  it("returns detected signal keys that are not already pinned", () => {
    const report = buildReport("http://prom:9090", [
      "istio_requests_total",
      "istio_request_duration_milliseconds_bucket",
    ])
    report.pinnedKeys = ["errorRate"] // already committed
    const keys = unpinnedDetectedKeys(report)
    expect(keys).not.toContain("errorRate")
    expect(keys).toContain("rps")
    expect(keys).toContain("latencyP95")
  })

  it("returns nothing when everything detected is already pinned", () => {
    const report = buildReport("http://prom:9090", [
      "istio_requests_total",
      "istio_request_duration_milliseconds_bucket",
    ])
    const allKeys = new Set<string>()
    report.suggestions.forEach((s) => Object.keys(s.queries).forEach((k) => allKeys.add(k)))
    report.pinnedKeys = [...allKeys]
    expect(unpinnedDetectedKeys(report)).toEqual([])
  })

  it("returns nothing when Prometheus is unreachable", () => {
    expect(unpinnedDetectedKeys({ reachable: false, suggestions: [] })).toEqual([])
  })
})

describe("fetchMetricNames", () => {
  it("returns the label values on success", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ status: "success", data: ["http_requests_total", "up"] }),
    }) as Response)
    const names = await fetchMetricNames("http://prom:9090/", { fetchImpl })
    expect(names).toEqual(["http_requests_total", "up"])
    expect(String(fetchImpl.mock.calls[0][0])).toBe("http://prom:9090/api/v1/label/__name__/values")
  })

  it("sends a bearer token when provided", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({ ok: true, json: async () => ({ status: "success", data: [] }) }) as Response)
    await fetchMetricNames("http://prom:9090", { authToken: "tok", fetchImpl })
    expect((fetchImpl.mock.calls[0][1] as RequestInit).headers).toMatchObject({ Authorization: "Bearer tok" })
  })

  it("throws on a non-OK response", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({ ok: false, status: 503 }) as Response)
    await expect(fetchMetricNames("http://prom:9090", { fetchImpl })).rejects.toThrow(/503/)
  })
})
