# Adapters & registry

An **adapter registry** is the runtime mechanism that turns a `provider` string in your config
into a concrete adapter instance. Each plug point (logs, metrics, persistence, notifications)
owns one registry.

```ts
// lib/metrics/registry.ts
export const metricsSourceRegistry =
  new AdapterRegistry<MetricsConfig, MetricsSource>("metrics source")

metricsSourceRegistry.register("prometheus", (cfg) => {
  if (!cfg.url) throw new Error("metrics.provider=prometheus requires metrics.url")
  return new PrometheusMetricsSource({ url: cfg.url, queries: cfg.queries, ... })
})

export function getMetricsSource(): MetricsSource {
  const metrics = getConfig().metrics
  return metricsSourceRegistry.create(metrics.provider, metrics) // provider → adapter
}
```

Unknown providers fail with a helpful error listing the registered ones, and a provider can
never be silently registered twice.

## Why this matters

- **Swap backends with one line.** `logs.provider: loki` → `logs.provider: elasticsearch`.
- **Contracts before implementations.** Mongo/Postgres/S3 persistence are typed contracts you
  can implement on demand — the rest of Nova already talks to the interface.
- **Testable in isolation.** Every adapter takes an injectable `fetch`, so its query
  construction and response parsing are unit-tested without a live backend.

## Adding an adapter

1. Implement the port interface (e.g. `MetricsSource`).
2. Register it under a new `provider` key in the relevant registry.
3. Add its config fields to the Zod schema (with defaults).
4. Add unit tests for query construction + response parsing.

That's it — no changes to the dashboard, context engine, or any other adapter.
