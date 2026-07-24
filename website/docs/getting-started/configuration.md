# Configuration

Nova is configured by a single, typed `nova.config.yaml`. It is validated against a Zod
schema, so a partial config is **deep-filled** with defaults and invalid config fails fast
with a clear error. Secrets and URLs use `${ENV}` interpolation and stay in the environment.

```yaml
ai:
  provider: openrouter          # openrouter | anthropic | openai | azure | ollama
  apiKeyEnv: OPENROUTER_API_KEY  # the ENV VAR name — the key stays in env

logs:
  provider: loki                # loki | elasticsearch | opensearch | mcp | ...
  url: ${LOKI_URL:-http://loki:3100}

metrics:
  provider: prometheus          # prometheus | http | none
  url: ${PROM_URL:-http://prometheus:9090}

persistence:
  provider: file                # file (Mongo/Postgres/S3 are adapter-ready)
  seed: none

# domain: ./domains/payments.yaml   # optional Domain Pack (else the built-in default)
```

## Sections at a glance

| Section | What it controls |
|---|---|
| `ai` | LLM provider, model, token budgets, temperature |
| `logs` | Log backend + **log scope** (backend-neutral selectors) |
| `metrics` | Metrics source (Prometheus PromQL, or the http collector) |
| `persistence` | Incident/RCA/eval store (file, or a DB adapter) |
| `dashboard` | Presentation curation — infra workloads, table columns, stat tiles, thresholds |
| `detection` | Auto-detection source, impact signal, severity rules |
| `context` | Which context providers feed the AI, and the token budget |
| `prompts` | Editable prompt templates + variables |
| `eval` | LLM-as-judge scoring + golden cases |
| `notifications` | Slack / PagerDuty / Teams / webhook / email + routing |
| `domain` | Path to a Domain Pack that grounds the AI in your world |

!!! note "Everything defaults to today's behaviour"
    `NovaConfigSchema.parse({})` yields a fully-working config. You only override what differs.

See the [config schema reference](../reference/config.md) for every field, and the guides for
[Prometheus](../guides/prometheus.md), [logs](../guides/logs.md), and
[notifications](../guides/notifications.md).
