import "server-only"
import { AdapterRegistry } from "@/lib/config/registry"
import { getConfig } from "@/lib/config/loader"
import type { MetricsConfig } from "@/lib/config/schema"
import type { MetricsSource } from "./source"
import { PrometheusMetricsSource } from "./prometheus-source"

// Metrics-source registry — resolves `config.metrics.provider` to a concrete
// MetricsSource. Mirrors the log-source registry.
//
// Only `prometheus` is registered here. `http` (today's metrics-collector proxy)
// and `none` are handled directly by `app/api/metrics/route.ts`, which owns the
// pod-inventory endpoints (namespaces/deployments) the collector serves.

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
    serviceLabel: cfg.serviceLabel,
    signals: cfg.signals,
    authToken,
  })
})

let cached: MetricsSource | undefined

/** The configured MetricsSource. Only valid when `metrics.provider` is registered
 * (i.e. `prometheus`); the route guards against calling this for `http`/`none`. */
export function getMetricsSource(): MetricsSource {
  if (cached) return cached
  const metrics = getConfig().metrics
  cached = metricsSourceRegistry.create(metrics.provider, metrics)
  return cached
}

export function resetMetricsSourceCache(): void {
  cached = undefined
}
