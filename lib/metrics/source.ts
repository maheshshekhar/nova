import type { RealServiceMetric } from "@/hooks/use-real-metrics"

// The MetricsSource port. A metrics backend (Prometheus today; others later)
// implements this one method: return per-service metrics normalised into the
// shape the dashboard already consumes (`RealServiceMetric`). The adapter owns
// translating its native query language (PromQL) + response into that shape.
//
// Throws on a network/HTTP failure so callers can distinguish "backend
// unreachable" (→ 503 / offline state) from "no services" (→ []).
export interface MetricsSource {
  getServiceMetrics(): Promise<RealServiceMetric[]>
  /** Run a single PromQL expression and return its scalar value (or null when
   * the query yields nothing). Optional — only query-capable sources implement it. */
  queryScalar?(promql: string): Promise<number | null>
}

// Metric keys the adapters can populate. Numeric, and every one has a descriptor
// in lib/metrics/descriptors.ts. Only the keys an operator configures a query for
// are populated; the rest stay absent.
export const NUMERIC_METRIC_KEYS = [
  "avgCpu",
  "avgMemory",
  "errorRate",
  "podCount",
  "readyPods",
  "crashedPods",
  "latencyP50",
  "latencyP95",
  "latencyP99",
  "rps",
] as const

export type NumericMetricKey = (typeof NUMERIC_METRIC_KEYS)[number]
