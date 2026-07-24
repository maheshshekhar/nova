/**
 * Metric descriptor registry.
 *
 * De-static work: the dashboard renders values that come from a real source
 * (the metrics-collector `/api/metrics`), never fabricated data. A descriptor
 * tells the UI *how* to present a given metric key — its human label, unit,
 * number formatting, health thresholds, and preferred visualization — without
 * hardcoding any particular service or value.
 *
 * Only keys the collector actually reports have a curated descriptor. Any other
 * key (e.g. a field an integrator's own collector exposes) resolves through
 * `getDescriptor`, which falls back to a generic, domain-agnostic descriptor so
 * the tile still renders sensibly instead of being dropped or faked.
 */

export type MetricFormat = "number" | "percent" | "ratio" | "bytes" | "duration" | "count" | "text"
export type MetricViz = "stat" | "gauge" | "sparkline" | "badge" | "table-cell"

/**
 * `higher-better` (e.g. ready pods) inverts threshold comparison relative to
 * `lower-better` (e.g. CPU, error rate). `neutral` means thresholds don't imply
 * good/bad and no health colour is applied.
 */
export type ThresholdDirection = "higher-better" | "lower-better" | "neutral"

export interface MetricThresholds {
  /** Comparison direction used when mapping a value to a health level. */
  direction: ThresholdDirection
  /** Value at/after which the metric is considered a warning. Optional. */
  warn?: number
  /** Value at/after which the metric is considered critical. Optional. */
  critical?: number
}

export interface MetricDescriptor {
  /** The canonical metric key (matches the source field name). */
  key: string
  /** Human-readable label for headers / tile titles. */
  label: string
  /** Short unit suffix rendered after the value (e.g. "%", "ms"). Empty for none. */
  unit: string
  /** How to format the raw numeric/textual value. */
  format: MetricFormat
  /** Preferred visualization for this metric. */
  viz: MetricViz
  /** Optional health thresholds. Absent = no health colouring. */
  thresholds?: MetricThresholds
  /** True when this descriptor was synthesized as a generic fallback. */
  generic?: boolean
}

/**
 * Curated descriptors for the keys the collector actually reports today.
 * (See `RealServiceMetric` in `hooks/use-real-metrics.ts`.)
 *
 * Deliberately NOT present: latency (p50/p95/p99), rps/requestCount, uptime,
 * region, apdex — the collector does not measure these, so they must not appear
 * as tiles. They return only if a real source starts reporting them (Path B).
 */
const DESCRIPTORS: Record<string, MetricDescriptor> = {
  avgCpu: {
    key: "avgCpu",
    label: "CPU",
    unit: "%",
    format: "percent",
    viz: "gauge",
    thresholds: { direction: "lower-better", warn: 70, critical: 90 },
  },
  avgMemory: {
    key: "avgMemory",
    label: "Memory",
    unit: "%",
    format: "percent",
    viz: "gauge",
    thresholds: { direction: "lower-better", warn: 75, critical: 90 },
  },
  errorRate: {
    key: "errorRate",
    label: "Error Rate",
    unit: "%",
    format: "percent",
    viz: "stat",
    thresholds: { direction: "lower-better", warn: 1, critical: 5 },
  },
  podCount: {
    key: "podCount",
    label: "Pods",
    unit: "",
    format: "count",
    viz: "stat",
    thresholds: { direction: "neutral" },
  },
  readyPods: {
    key: "readyPods",
    label: "Ready",
    unit: "",
    format: "count",
    viz: "stat",
    thresholds: { direction: "higher-better" },
  },
  crashedPods: {
    key: "crashedPods",
    label: "Crashed",
    unit: "",
    format: "count",
    viz: "stat",
    thresholds: { direction: "lower-better", warn: 1, critical: 2 },
  },
  status: {
    key: "status",
    label: "Status",
    unit: "",
    format: "text",
    viz: "badge",
    thresholds: { direction: "neutral" },
  },
  // Latency / throughput — only available from a source that measures them
  // (e.g. the Prometheus adapter). Absent by default; a tile/column appears only
  // when a real value exists.
  latencyP50: {
    key: "latencyP50",
    label: "p50",
    unit: "ms",
    format: "duration",
    viz: "stat",
    thresholds: { direction: "lower-better", warn: 300, critical: 800 },
  },
  latencyP95: {
    key: "latencyP95",
    label: "p95",
    unit: "ms",
    format: "duration",
    viz: "stat",
    thresholds: { direction: "lower-better", warn: 500, critical: 1000 },
  },
  latencyP99: {
    key: "latencyP99",
    label: "p99",
    unit: "ms",
    format: "duration",
    viz: "stat",
    thresholds: { direction: "lower-better", warn: 800, critical: 1500 },
  },
  rps: {
    key: "rps",
    label: "RPS",
    unit: "/s",
    format: "number",
    viz: "sparkline",
    thresholds: { direction: "neutral" },
  },
}

/** True when a curated descriptor exists for `key`. */
export function hasDescriptor(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(DESCRIPTORS, key)
}

/**
 * Turn a camelCase / snake_case / kebab-case key into a Title Case label.
 * e.g. `avgCpu` -> "Avg Cpu", `request_count` -> "Request Count".
 */
function humanizeKey(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
  if (!spaced) return key
  return spaced
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")
}

/**
 * Resolve a descriptor for any metric key. Curated keys return their descriptor;
 * unknown keys get a generic, domain-agnostic descriptor so the value still
 * renders (as a neutral stat) instead of being dropped or fabricated.
 */
export function getDescriptor(key: string): MetricDescriptor {
  const curated = DESCRIPTORS[key]
  if (curated) return curated
  return {
    key,
    label: humanizeKey(key),
    unit: "",
    format: "number",
    viz: "stat",
    thresholds: { direction: "neutral" },
    generic: true,
  }
}

/** All curated metric keys (stable order for iteration/tests). */
export function knownMetricKeys(): string[] {
  return Object.keys(DESCRIPTORS)
}

export type HealthLevel = "healthy" | "warn" | "critical" | "unknown"

/**
 * Map a numeric value to a health level using a descriptor's thresholds.
 * Returns "unknown" when the metric has no meaningful thresholds (neutral or
 * unset) or when the value is not a finite number.
 */
export function evaluateHealth(descriptor: MetricDescriptor, value: number): HealthLevel {
  const t = descriptor.thresholds
  if (!t || t.direction === "neutral") return "unknown"
  if (typeof value !== "number" || !Number.isFinite(value)) return "unknown"

  const { direction, warn, critical } = t
  if (direction === "lower-better") {
    if (critical !== undefined && value >= critical) return "critical"
    if (warn !== undefined && value >= warn) return "warn"
    return "healthy"
  }
  // higher-better
  if (critical !== undefined && value <= critical) return "critical"
  if (warn !== undefined && value <= warn) return "warn"
  return "healthy"
}
