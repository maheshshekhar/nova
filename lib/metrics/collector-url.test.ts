import { describe, expect, it } from "vitest"
import { resolveCollectorUrl, DEFAULT_COLLECTOR_URL } from "@/lib/metrics/collector-url"

describe("resolveCollectorUrl", () => {
  it("http provider: the collector IS metrics.url", () => {
    expect(resolveCollectorUrl({ provider: "http", url: "http://collector:3001" })).toBe(
      "http://collector:3001"
    )
  })

  it("http provider without url falls back to the default", () => {
    expect(resolveCollectorUrl({ provider: "http" })).toBe(DEFAULT_COLLECTOR_URL)
  })

  it("prometheus provider: the collector is metrics.collectorUrl (NOT the prometheus url)", () => {
    expect(
      resolveCollectorUrl({
        provider: "prometheus",
        url: "http://prometheus:9090",
        collectorUrl: "http://collector:3001",
      })
    ).toBe("http://collector:3001")
  })

  it("prometheus provider without collectorUrl falls back to the default (never the prometheus url)", () => {
    const out = resolveCollectorUrl({ provider: "prometheus", url: "http://prometheus:9090" })
    expect(out).toBe(DEFAULT_COLLECTOR_URL)
    expect(out).not.toContain("9090")
  })

  it("never reads process.env (config is the single source)", () => {
    const prev = process.env.METRICS_COLLECTOR_URL
    process.env.METRICS_COLLECTOR_URL = "http://should-not-be-used:9999"
    try {
      expect(resolveCollectorUrl({ provider: "http", url: "http://collector:3001" })).toBe(
        "http://collector:3001"
      )
      expect(resolveCollectorUrl({ provider: "http" })).toBe(DEFAULT_COLLECTOR_URL)
    } finally {
      if (prev === undefined) delete process.env.METRICS_COLLECTOR_URL
      else process.env.METRICS_COLLECTOR_URL = prev
    }
  })
})
