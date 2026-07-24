import "server-only"
import { AdapterRegistry } from "@/lib/config/registry"
import { getConfig } from "@/lib/config/loader"
import type { MetricsConfig } from "@/lib/config/schema"
import type { MetricsSource } from "./source"
import { PrometheusMetricsSource } from "./prometheus-source"

// Metrics-source registry — resolves `config.metrics.provider` to a concrete
// MetricsSource. Only `prometheus` resolves here today; `http` (the custom
// collector proxy) and `none` are handled directly by app/api/metrics/route.ts.
// Add datadog/grafana adapters here as they land.
export const metricsSourceRegistry = new AdapterRegistry<MetricsConfig, MetricsSource>(
  "metrics source"
)

metricsSourceRegistry.register("prometheus", (cfg) => {
  if (!cfg.url) {
    throw new Error("metrics.provider=prometheus requires metrics.url")
  }
  const authToken = cfg.authTokenEnv ? process.env[cfg.authTokenEnv] : undefined
  return new PrometheusMetricsSource({
    url: cfg.url,
    authToken,
    serviceLabel: cfg.serviceLabel,
    queries: cfg.queries,
  })
})

/** Resolve the configured metrics source. Only valid when provider === "prometheus". */
export function getMetricsSource(): MetricsSource {
  const metrics = getConfig().metrics
  return metricsSourceRegistry.create(metrics.provider, metrics)
}
