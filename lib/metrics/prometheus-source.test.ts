import { describe, it, expect } from "vitest"
import { PrometheusMetricsSource } from "./prometheus-source"

// Build a fake fetch that returns a canned Prometheus instant-vector response
// keyed by which query was asked for (matched via a substring of the PromQL).
function fakeProm(
  responders: Record<string, Array<{ service?: string; value: number; extraLabels?: Record<string, string> }>>,
  opts: { captureAuth?: (auth: string | null) => void } = {}
): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    opts.captureAuth?.(((init?.headers as Record<string, string>) || {}).Authorization ?? null)
    const u = new URL(url)
    const query = u.searchParams.get("query") || ""
    const key = Object.keys(responders).find((k) => query.includes(k))
    const rows = key ? responders[key] : []
    return {
      ok: true,
      json: async () => ({
        status: "success",
        data: {
          resultType: "vector",
          result: rows.map((r) => ({
            metric: { service: r.service, ...(r.extraLabels ?? {}) },
            value: [1700000000, String(r.value)],
          })),
        },
      }),
    } as Response
  }) as unknown as typeof fetch
}

describe("PrometheusMetricsSource.getServiceMetrics", () => {
  it("maps PromQL vectors into RealServiceMetric grouped by service label", async () => {
    const src = new PrometheusMetricsSource({
      url: "http://prom:9090",
      serviceLabel: "service",
      queries: {
        avgCpu: "CPU_QUERY",
        avgMemory: "MEM_QUERY",
        errorRate: "ERR_QUERY",
        latencyP95: "P95_QUERY",
        rps: "RPS_QUERY",
      },
      fetchImpl: fakeProm({
        CPU_QUERY: [{ service: "checkout", value: 42.4 }, { service: "orders", value: 10 }],
        MEM_QUERY: [{ service: "checkout", value: 61.6 }],
        ERR_QUERY: [{ service: "checkout", value: 7.2 }, { service: "orders", value: 0.1 }],
        P95_QUERY: [{ service: "checkout", value: 1200 }],
        RPS_QUERY: [{ service: "checkout", value: 340.5 }],
      }),
    })

    const out = await src.getServiceMetrics()
    // Sorted by name: checkout, orders
    expect(out.map((s) => s.name)).toEqual(["checkout", "orders"])

    const checkout = out[0]
    expect(checkout.avgCpu).toBe(42) // rounded
    expect(checkout.avgMemory).toBe(62)
    expect(checkout.errorRate).toBe(7.2)
    expect(checkout.latencyP95).toBe(1200)
    expect(checkout.rps).toBe(340.5)
    // errorRate 7.2 (>5 critical) → critical
    expect(checkout.status).toBe("critical")
  })

  it("leaves optional latency/rps absent when not configured", async () => {
    const src = new PrometheusMetricsSource({
      url: "http://prom:9090",
      serviceLabel: "service",
      queries: { errorRate: "ERR_QUERY" },
      fetchImpl: fakeProm({ ERR_QUERY: [{ service: "svc-a", value: 0.2 }] }),
    })
    const [svc] = await src.getServiceMetrics()
    expect(svc.errorRate).toBe(0.2)
    expect(svc.latencyP95).toBeUndefined()
    expect(svc.rps).toBeUndefined()
    // healthy error rate, no latency → healthy
    expect(svc.status).toBe("healthy")
    // required fields default to 0
    expect(svc.podCount).toBe(0)
    expect(svc.avgCpu).toBe(0)
  })

  it("derives 'degraded' from a warn-level p95 even when error rate is fine", async () => {
    const src = new PrometheusMetricsSource({
      url: "http://prom:9090",
      serviceLabel: "service",
      queries: { errorRate: "ERR_QUERY", latencyP95: "P95_QUERY" },
      fetchImpl: fakeProm({
        ERR_QUERY: [{ service: "svc-a", value: 0.1 }],
        P95_QUERY: [{ service: "svc-a", value: 600 }], // warn (>=500, <1000)
      }),
    })
    const [svc] = await src.getServiceMetrics()
    expect(svc.status).toBe("degraded")
  })

  it("respects a custom service label and ignores rows missing it", async () => {
    const src = new PrometheusMetricsSource({
      url: "http://prom:9090",
      serviceLabel: "app",
      queries: { errorRate: "ERR_QUERY" },
      fetchImpl: (async (url: string) => {
        const query = new URL(url).searchParams.get("query")
        return {
          ok: true,
          json: async () => ({
            status: "success",
            data: {
              resultType: "vector",
              result: [
                { metric: { app: "web" }, value: [1, "1.5"] },
                { metric: { notservice: "x" }, value: [1, "9"] }, // no `app` label → ignored
              ],
            },
          }),
        } as Response
      }) as unknown as typeof fetch,
    })
    const out = await src.getServiceMetrics()
    expect(out.map((s) => s.name)).toEqual(["web"])
  })

  it("ignores non-finite values", async () => {
    const src = new PrometheusMetricsSource({
      url: "http://prom:9090",
      serviceLabel: "service",
      queries: { errorRate: "ERR_QUERY", rps: "RPS_QUERY" },
      fetchImpl: (async (url: string) => {
        const query = new URL(url).searchParams.get("query") || ""
        const value = query.includes("RPS") ? "NaN" : "2.5"
        return {
          ok: true,
          json: async () => ({
            status: "success",
            data: { resultType: "vector", result: [{ metric: { service: "svc-a" }, value: [1, value] }] },
          }),
        } as Response
      }) as unknown as typeof fetch,
    })
    const [svc] = await src.getServiceMetrics()
    expect(svc.errorRate).toBe(2.5)
    expect(svc.rps).toBeUndefined()
  })

  it("sends a bearer token when configured", async () => {
    let seenAuth: string | null = "unset"
    const src = new PrometheusMetricsSource({
      url: "http://prom:9090",
      authToken: "secret-token",
      serviceLabel: "service",
      queries: { errorRate: "ERR_QUERY" },
      fetchImpl: fakeProm(
        { ERR_QUERY: [{ service: "svc-a", value: 1 }] },
        { captureAuth: (a) => (seenAuth = a) }
      ),
    })
    await src.getServiceMetrics()
    expect(seenAuth).toBe("Bearer secret-token")
  })

  it("throws on a non-ok Prometheus response", async () => {
    const src = new PrometheusMetricsSource({
      url: "http://prom:9090",
      serviceLabel: "service",
      queries: { errorRate: "ERR_QUERY" },
      fetchImpl: (async () => ({ ok: false, status: 502, json: async () => ({}) }) as Response) as unknown as typeof fetch,
    })
    await expect(src.getServiceMetrics()).rejects.toThrow(/Prometheus query failed: 502/)
  })

  it("returns [] when Prometheus reports no results", async () => {
    const src = new PrometheusMetricsSource({
      url: "http://prom:9090",
      serviceLabel: "service",
      queries: { errorRate: "ERR_QUERY" },
      fetchImpl: fakeProm({ ERR_QUERY: [] }),
    })
    expect(await src.getServiceMetrics()).toEqual([])
  })
})

describe("PrometheusMetricsSource.queryScalar", () => {
  const scalarFetch = (resultType: string, result: unknown): typeof fetch =>
    (async () => ({
      ok: true,
      json: async () => ({ status: "success", data: { resultType, result } }),
    }) as Response) as unknown as typeof fetch

  it("parses a scalar result", async () => {
    const src = new PrometheusMetricsSource({
      url: "http://prom:9090",
      serviceLabel: "service",
      queries: {},
      fetchImpl: scalarFetch("scalar", [1700000000, "88.5"]),
    })
    expect(await src.queryScalar("scalar(...)")).toBe(88.5)
  })

  it("parses the first row of a vector result", async () => {
    const src = new PrometheusMetricsSource({
      url: "http://prom:9090",
      serviceLabel: "service",
      queries: {},
      fetchImpl: scalarFetch("vector", [{ metric: { x: "1" }, value: [1700000000, "42"] }]),
    })
    expect(await src.queryScalar("max(...)")).toBe(42)
  })

  it("returns null when the query yields nothing", async () => {
    const src = new PrometheusMetricsSource({
      url: "http://prom:9090",
      serviceLabel: "service",
      queries: {},
      fetchImpl: scalarFetch("vector", []),
    })
    expect(await src.queryScalar("absent")).toBeNull()
  })
})
