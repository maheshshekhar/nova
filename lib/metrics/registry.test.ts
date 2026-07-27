import { afterEach, describe, expect, it } from "vitest"
import { resetConfigCache } from "@/lib/config/loader"
import {
  metricsSourceRegistry,
  getMetricsSource,
  resetMetricsSourceCache,
} from "@/lib/metrics/registry"
import { PrometheusMetricsSource } from "@/lib/metrics/prometheus-source"

afterEach(() => {
  resetMetricsSourceCache()
  resetConfigCache()
})

describe("metricsSourceRegistry", () => {
  it("registers only the prometheus provider (http/none are route-handled)", () => {
    expect(metricsSourceRegistry.providers()).toEqual(["prometheus"])
  })

  it("constructs a PrometheusMetricsSource for provider=prometheus", () => {
    const src = metricsSourceRegistry.create("prometheus", {
      provider: "prometheus",
      url: "http://prom:9090",
      serviceLabel: "service",
      signals: { errorRate: "up" },
    } as any)
    expect(src).toBeInstanceOf(PrometheusMetricsSource)
  })

  it("throws a helpful error when prometheus is selected without a url", () => {
    expect(() =>
      metricsSourceRegistry.create("prometheus", {
        provider: "prometheus",
        serviceLabel: "service",
        signals: {},
      } as any)
    ).toThrow(/requires metrics.url/)
  })

  it("throws for an unregistered provider (http/none)", () => {
    expect(() => metricsSourceRegistry.create("http", {} as any)).toThrow(/Unknown metrics source/)
  })
})
