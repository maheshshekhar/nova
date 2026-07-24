# Roadmap

Nova's core (source-driven dashboard, config-driven adapters, deterministic AI, domain packs,
notifications, eval) is in place. Here's what's planned next — tracked in
`docs/observability-roadmap.md`.

| Item | Status |
|---|---|
| **Prometheus metrics adapter** — real latency/RPS/error via PromQL, custom query tiles | <span class="nova-badge">shipped</span> |
| **Proactive operator** — scheduled health checks + deployment verification that open incidents on their own | planned |
| **Traces (OpenTelemetry)** — Tempo / Jaeger, flagged & opt-in; the third pillar | planned |
| **Deep Investigate (agentic)** — opt-in, bounded, fully-audited tool-calling for novel incidents | designed, later |
| **More adapters** — Datadog, Grafana, Mongo/Postgres/S3 persistence | on demand |

## Guiding principles for new work

- **Config-driven, domain-agnostic** — declared in config, never hardcoded.
- **Additive & default-off** — new capabilities don't change existing behaviour until opted in.
- **Deterministic stays the default** — agentic is an explicit, guarded escape hatch.
- **Read-only by default** — the only write path stays human-approved remediation.
- **Nova is a client** — it queries your Prometheus/Tempo/Loki; it doesn't own your stack.
