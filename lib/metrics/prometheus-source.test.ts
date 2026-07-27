import { describe, expect, it, vi } from "vitest"
import { PrometheusMetricsSource } from "@/lib/metrics/prometheus-source"
import type { MetricsSignals } from "@/lib/config/schema"

// A fake Prometheus that returns a canned instant-vector per query. Keyed by a
// substring of the PromQL so a test can map each signal query to a result set.
function fakeProm(byQuery: Record<string, { metric: Record<string, string>; value: [number, string] }[]>) {
  return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input)
    const q = decodeURIComponent(url.split("query=")[1] ?? "")
    const match = Object.keys(byQuery).find((k) => q.includes(k))
    const result = match ? byQuery[match] : []
    return {
      ok: true,
      json: async () => ({ status: "success", data: { resultType: "vector", result } }),
    } as Response
  })
}

const vec = (service: string, value: number) => ({
  metric: { service },
  value: [1700000000, String(value)] as [number, string],
})

describe("PrometheusMetricsSource", () => {
  it("assembles one RealServiceMetric per service across signal queries", async () => {
    const signals: MetricsSignals = {
      errorRate: "err_query",
      latencyP95: "p95_query",
      rps: "rps_query",
    }
    const fetchImpl = fakeProm({
      err_query: [vec("payment", 4.2), vec("config", 0.1)],
      p95_query: [vec("payment", 0.25), vec("config", 0.05)],
      rps_query: [vec("payment", 120), vec("config", 5)],
    })
    const src = new PrometheusMetricsSource({
      url: "http://prom:9090",
      serviceLabel: "service",
      signals,
      fetchImpl,
    })

    const { services } = await src.getServiceMetrics()
    expect(services.map((s) => s.name)).toEqual(["config", "payment"]) // sorted

    const payment = services.find((s) => s.name === "payment")!
    expect(payment.errorRate).toBe(4.2)
    expect(payment.latencyP95).toBe(0.25)
    expect(payment.rps).toBe(120)
    expect(payment.status).toBe("critical") // errorRate > 3
  })

  it("derives status from errorRate thresholds", async () => {
    const fetchImpl = fakeProm({
      err: [vec("healthy", 0.1), vec("degraded", 1.5), vec("critical", 9)],
    })
    const src = new PrometheusMetricsSource({
      url: "http://prom:9090",
      serviceLabel: "service",
      signals: { errorRate: "err" },
      fetchImpl,
    })
    const { services } = await src.getServiceMetrics()
    expect(services.find((s) => s.name === "healthy")!.status).toBe("healthy")
    expect(services.find((s) => s.name === "degraded")!.status).toBe("degraded")
    expect(services.find((s) => s.name === "critical")!.status).toBe("critical")
  })

  it("skips signals with no configured query and never fabricates them", async () => {
    const fetchImpl = fakeProm({ err: [vec("svc", 0.2)] })
    const src = new PrometheusMetricsSource({
      url: "http://prom:9090",
      serviceLabel: "service",
      signals: { errorRate: "err" }, // no latency / rps configured
      fetchImpl,
    })
    const { services } = await src.getServiceMetrics()
    const svc = services[0]
    expect(svc.errorRate).toBe(0.2)
    expect(svc.latencyP95).toBeUndefined()
    expect(svc.rps).toBeUndefined()
    // only the configured query is executed
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it("honours a custom serviceLabel", async () => {
    const fetchImpl = fakeProm({
      err: [{ metric: { app: "checkout" }, value: [1, "2"] as [number, string] }],
    })
    const src = new PrometheusMetricsSource({
      url: "http://prom:9090",
      serviceLabel: "app",
      signals: { errorRate: "err" },
      fetchImpl,
    })
    const { services } = await src.getServiceMetrics()
    expect(services[0].name).toBe("checkout")
  })

  it("sends a bearer token when configured and targets /api/v1/query", async () => {
    const fetchImpl = fakeProm({ err: [] })
    const src = new PrometheusMetricsSource({
      url: "http://prom:9090/",
      serviceLabel: "service",
      signals: { errorRate: "up" },
      authToken: "secret-token",
      fetchImpl,
    })
    await src.getServiceMetrics()
    const [url, init] = fetchImpl.mock.calls[0]
    expect(String(url)).toContain("http://prom:9090/api/v1/query?query=")
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer secret-token" })
  })

  it("throws when the backend returns a non-OK status", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 502 }) as Response)
    const src = new PrometheusMetricsSource({
      url: "http://prom:9090",
      serviceLabel: "service",
      signals: { errorRate: "err" },
      fetchImpl,
    })
    await expect(src.getServiceMetrics()).rejects.toThrow(/502/)
  })

  it("ignores non-numeric and unlabelled series", async () => {
    const fetchImpl = fakeProm({
      err: [
        { metric: { service: "a" }, value: [1, "NaN"] as [number, string] },
        { metric: {}, value: [1, "5"] as [number, string] }, // no service label
        vec("b", 1.2),
      ],
    })
    const src = new PrometheusMetricsSource({
      url: "http://prom:9090",
      serviceLabel: "service",
      signals: { errorRate: "err" },
      fetchImpl,
    })
    const { services } = await src.getServiceMetrics()
    // "a" only ever reports NaN → never created (no real measurement);
    // unlabelled series dropped; "b" = 1.2 is the only real service.
    expect(services.map((s) => s.name)).toEqual(["b"])
    expect(services.find((s) => s.name === "a")).toBeUndefined()
    expect(services.find((s) => s.name === "b")!.errorRate).toBe(1.2)
  })
})
