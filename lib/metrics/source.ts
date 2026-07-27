// The MetricsSource port. Every metrics backend (Prometheus today; more later)
// implements this one method: return real per-service metrics in Nova's neutral
// `RealServiceMetric` shape. The adapter owns translating its native query/API
// into that shape. Mirrors the LogSource port in `lib/logs/source.ts`.
//
// This file is deliberately free of `server-only` so the types can be shared with
// client components; the concrete adapters (prometheus-source, registry) are
// server-only.

// A service's live metrics. Pod-level fields (podCount/ready/crashed/cpu/memory)
// come from the k8s collector; the RED fields (errorRate/latency/rps) come from a
// metrics backend. A source populates whatever it can measure and leaves the rest
// at their defaults — Nova never fabricates a signal it cannot measure.
export interface RealServiceMetric {
  name: string
  namespace?: string
  podCount: number
  readyPods: number
  crashedPods: number
  avgCpu: number
  avgMemory: number
  status: "healthy" | "degraded" | "critical"
  errorRate: number
  // Optional real signals — present only when the source can measure them.
  latencyP50?: number
  latencyP95?: number
  latencyP99?: number
  rps?: number
}

export interface ServiceMetricsResult {
  services: RealServiceMetric[]
  timestamp: string
  lastUpdated: number
}

export interface MetricsSource {
  /** Real per-service metrics. Throws on a network/HTTP failure (so callers can
   * distinguish "backend unreachable" from "no matching services" ⇒ []). */
  getServiceMetrics(): Promise<ServiceMetricsResult>
}

/** The numeric RED keys a metrics source may populate, keyed to config `signals`. */
export const SIGNAL_KEYS = [
  "errorRate",
  "latencyP50",
  "latencyP95",
  "latencyP99",
  "rps",
] as const
export type SignalKey = (typeof SIGNAL_KEYS)[number]
