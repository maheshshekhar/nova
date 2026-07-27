import type { MetricsConfig } from "@/lib/config/schema"

// Resolve the Kubernetes metrics-collector endpoint from CONFIG (never from an
// env var at runtime) so nova-config.yaml is the single source of truth — the
// same way logs already resolves its URL from config.
//
//   • provider http      → the collector IS the metrics source ⇒ use `metrics.url`
//   • provider prometheus → the collector only ENRICHES Prometheus with pod
//                            inventory ⇒ use `metrics.collectorUrl`
//
// The env var `METRICS_COLLECTOR_URL` still exists, but only as the `${...}`
// interpolation default inside nova-config.yaml (filled in at config load) — it
// is no longer read directly by the request path.

export const DEFAULT_COLLECTOR_URL = "http://metrics-collector:3001"

export function resolveCollectorUrl(
  metrics: Pick<MetricsConfig, "provider" | "url" | "collectorUrl">
): string {
  if (metrics.provider === "prometheus") {
    return metrics.collectorUrl ?? DEFAULT_COLLECTOR_URL
  }
  // http (and any non-prometheus): the collector is the primary source.
  return metrics.url ?? metrics.collectorUrl ?? DEFAULT_COLLECTOR_URL
}
