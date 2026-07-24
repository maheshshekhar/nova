import { describe, it, expect } from "vitest"
import { mergeServiceSources, collectorServicesFromPayload } from "./inventory"
import type { RealServiceMetric } from "@/hooks/use-real-metrics"

const svc = (name: string, extra: Partial<RealServiceMetric> = {}): RealServiceMetric => ({
  name,
  podCount: 0,
  readyPods: 0,
  crashedPods: 0,
  avgCpu: 0,
  avgMemory: 0,
  status: "healthy",
  errorRate: 0,
  ...extra,
})

describe("collectorServicesFromPayload", () => {
  it("maps a collector payload into RealServiceMetric[]", () => {
    const out = collectorServicesFromPayload({
      services: [
        { name: "checkout", podCount: 3, readyPods: 0, crashedPods: 3, avgCpu: 80, status: "critical", errorRate: 12 },
        { name: "orders", podCount: 2, readyPods: 2, crashedPods: 0 },
      ],
    })
    expect(out.map((s) => s.name)).toEqual(["checkout", "orders"])
    expect(out[0].status).toBe("critical")
    expect(out[0].crashedPods).toBe(3)
    expect(out[1].readyPods).toBe(2)
  })

  it("returns [] for a malformed / fallback payload", () => {
    expect(collectorServicesFromPayload({ fallback: true })).toEqual([])
    expect(collectorServicesFromPayload(null)).toEqual([])
    expect(collectorServicesFromPayload({ services: "nope" })).toEqual([])
  })

  it("defaults missing numeric fields and normalises status", () => {
    const [s] = collectorServicesFromPayload({ services: [{ name: "x", status: "weird" }] })
    expect(s).toMatchObject({ name: "x", podCount: 0, avgCpu: 0, status: "healthy" })
  })
})

describe("mergeServiceSources", () => {
  it("enriches prometheus services with collector pod counts, preserving rich metrics", () => {
    const prom = [svc("checkout", { latencyP95: 900, errorRate: 4, rps: 12 })]
    const collector = [svc("checkout", { podCount: 3, readyPods: 2, crashedPods: 1 })]
    const [out] = mergeServiceSources(prom, collector)
    expect(out.podCount).toBe(3)
    expect(out.readyPods).toBe(2)
    expect(out.latencyP95).toBe(900)
    expect(out.rps).toBe(12)
  })

  it("unions in collector-only services (e.g. a crashing pod Prometheus can't scrape)", () => {
    const prom = [svc("orders", { latencyP95: 50 })]
    const collector = [
      svc("payment-service", { status: "critical", crashedPods: 3, podCount: 3, errorRate: 60 }),
    ]
    const out = mergeServiceSources(prom, collector)
    expect(out.map((s) => s.name).sort()).toEqual(["orders", "payment-service"])
    const payment = out.find((s) => s.name === "payment-service")!
    expect(payment.status).toBe("critical")
    expect(payment.crashedPods).toBe(3)
    expect(payment.latencyP95).toBeUndefined()
  })

  it("with no collector, returns the prometheus services unchanged", () => {
    const prom = [svc("a", { avgCpu: 10 }), svc("b")]
    expect(mergeServiceSources(prom, [])).toHaveLength(2)
    expect(mergeServiceSources(prom, [])[0].avgCpu).toBe(10)
  })
})
