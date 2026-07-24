import { describe, it, expect } from "vitest"
import {
  getDescriptor,
  hasDescriptor,
  knownMetricKeys,
  evaluateHealth,
  type MetricDescriptor,
} from "./descriptors"

describe("metric descriptors — curated keys", () => {
  it("exposes descriptors for every real collector field", () => {
    const keys = knownMetricKeys()
    for (const k of ["avgCpu", "avgMemory", "errorRate", "podCount", "readyPods", "crashedPods", "status"]) {
      expect(keys).toContain(k)
      expect(hasDescriptor(k)).toBe(true)
    }
  })

  it("exposes descriptors for the Prometheus-backed latency/throughput keys", () => {
    for (const k of ["latencyP50", "latencyP95", "latencyP99", "rps"]) {
      expect(hasDescriptor(k)).toBe(true)
    }
    const p95 = getDescriptor("latencyP95")
    expect(p95.unit).toBe("ms")
    expect(p95.thresholds?.direction).toBe("lower-better")
  })

  it("does NOT expose keys no configured source provides", () => {
    for (const k of ["requestCount", "uptime", "region", "apdex", "saturation"]) {
      expect(hasDescriptor(k)).toBe(false)
    }
  })

  it("returns the curated descriptor for a known key", () => {
    const d = getDescriptor("avgCpu")
    expect(d.label).toBe("CPU")
    expect(d.unit).toBe("%")
    expect(d.format).toBe("percent")
    expect(d.generic).toBeUndefined()
  })
})

describe("metric descriptors — generic fallback", () => {
  it("synthesizes a descriptor for unknown keys", () => {
    const d = getDescriptor("customThroughput")
    expect(d.generic).toBe(true)
    expect(d.key).toBe("customThroughput")
    expect(d.viz).toBe("stat")
    expect(d.format).toBe("number")
  })

  it("humanizes camelCase, snake_case and kebab-case keys", () => {
    expect(getDescriptor("avgLatencyMs").label).toBe("Avg Latency Ms")
    expect(getDescriptor("request_count").label).toBe("Request Count")
    expect(getDescriptor("queue-depth").label).toBe("Queue Depth")
  })

  it("falls back gracefully for an empty key", () => {
    const d = getDescriptor("")
    expect(d.generic).toBe(true)
    expect(d.label).toBe("")
  })
})

describe("evaluateHealth", () => {
  const cpu = getDescriptor("avgCpu")
  const ready = getDescriptor("readyPods")
  const status = getDescriptor("status")

  it("evaluates lower-better metrics", () => {
    expect(evaluateHealth(cpu, 10)).toBe("healthy")
    expect(evaluateHealth(cpu, 75)).toBe("warn")
    expect(evaluateHealth(cpu, 95)).toBe("critical")
  })

  it("evaluates higher-better metrics", () => {
    // readyPods: healthy when high; warn/critical thresholds unset -> healthy
    expect(evaluateHealth(ready, 5)).toBe("healthy")
  })

  it("higher-better with thresholds crosses correctly", () => {
    const d: MetricDescriptor = {
      key: "readyRatio",
      label: "Ready",
      unit: "",
      format: "ratio",
      viz: "stat",
      thresholds: { direction: "higher-better", warn: 3, critical: 1 },
    }
    expect(evaluateHealth(d, 4)).toBe("healthy")
    expect(evaluateHealth(d, 2)).toBe("warn")
    expect(evaluateHealth(d, 1)).toBe("critical")
  })

  it("returns unknown for neutral or non-finite values", () => {
    expect(evaluateHealth(status, 1)).toBe("unknown")
    expect(evaluateHealth(cpu, Number.NaN)).toBe("unknown")
    expect(evaluateHealth(cpu, Number.POSITIVE_INFINITY)).toBe("unknown")
  })
})
