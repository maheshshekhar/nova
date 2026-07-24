# Point Nova at Prometheus

Nova can source per-service metrics — CPU, memory, error rate, **p95 latency, RPS** — from a
real Prometheus. Nova is only a **PromQL client**: it queries your existing Prometheus, it
never scrapes (your `ServiceMonitor` / `scrape_configs` own that, and your apps expose
`/metrics`).

## Configure

You declare, in config, which PromQL produces which metric key — so it stays domain-agnostic:

```yaml
metrics:
  provider: prometheus
  url: ${PROM_URL:-http://prometheus:9090}
  authTokenEnv: PROM_TOKEN          # env var holding a bearer token (optional)
  serviceLabel: service             # PromQL label that identifies the service
  queries:
    errorRate:  'sum by (service)(rate(http_requests_total{code=~"5.."}[5m])) / sum by (service)(rate(http_requests_total[5m])) * 100'
    latencyP95: 'histogram_quantile(0.95, sum by (service,le)(rate(http_request_duration_seconds_bucket[5m]))) * 1000'
    rps:        'sum by (service)(rate(http_requests_total[5m]))'
    avgCpu:     'avg by (service)(app_cpu_percent)'
    avgMemory:  'avg by (service)(app_memory_percent)'
```

Each query **must return an instant vector labelled by `serviceLabel`**. Only the keys you
configure are populated; the rest stay absent (and the dashboard renders only present fields).

## What lights up

- The **Service Health table** grows real **p95** and **RPS** columns (presence-filtered).
- The **latency chart** shows real fleet p95 (instead of an empty state).
- The auto **stat tiles** compute from real aggregates.

## Custom PromQL tiles

Add your own stat tiles under `dashboard.stats.tiles`. Each tile's query is executed
**server-side** — the browser only references it by `id`, so no free-form PromQL ever reaches
Prometheus (SSRF/injection-safe):

```yaml
dashboard:
  stats:
    tiles:
      - { id: db-pool, label: "DB pool", query: "max(db_pool_in_use_percent)", unit: "%", thresholds: { warn: 70, critical: 90 } }
```

!!! tip "Hybrid with the collector"
    Prometheus has no pod-count concept, and can't scrape a CrashLooping pod. When a metrics
    collector is also available, Nova **merges** its pod counts and **unions** in services
    Prometheus can't see — so the most important service never disappears during its own
    incident.
