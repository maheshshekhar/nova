# Config schema reference

`nova.config.yaml` is validated against a Zod schema. Every field has a default, so a partial
config is deep-filled. Below is the surface; see `nova.config.example.yaml` for a fully
commented example.

## `ai`

| Field | Default | Notes |
|---|---|---|
| `provider` | `openrouter` | `openrouter \| anthropic \| openai \| azure \| ollama` |
| `model` | *(provider default)* | model id |
| `apiKeyEnv` | — | ENV VAR name holding the key |
| `maxTokens` | `{ triage: 400, rca: 4000, chat: 1200 }` | per-task budgets |
| `temperature` | `0` | 0–2 |

## `logs`

| Field | Default | Notes |
|---|---|---|
| `provider` | `loki` | `loki \| elasticsearch \| opensearch \| mcp \| cloudwatch \| datadog \| http \| file` |
| `url` | `http://loki:3100` | backend URL (`${ENV}` interpolation) |
| `fields` | Loki-style | map backend fields → logical dimensions |
| `scope` | production namespace | backend-neutral include/exclude selectors |

## `metrics`

| Field | Default | Notes |
|---|---|---|
| `provider` | `http` | `prometheus \| http \| none` |
| `url` | — | Prometheus / collector URL |
| `serviceLabel` | `service` | PromQL label identifying the service |
| `queries` | `{}` | metric key → PromQL (see the [Prometheus guide](../guides/prometheus.md)) |
| `authTokenEnv` | — | ENV VAR name for a bearer token |

## `dashboard`

| Field | Default | Notes |
|---|---|---|
| `infraWorkloads` | `[]` | names/substrings treated as infrastructure |
| `serviceTable.columns` | `auto` | `auto` or an explicit ordered list of metric keys |
| `stats.tiles` | `auto` | `auto` or explicit tiles (metric- or PromQL-`query`-bound) |
| `thresholds` | `{}` | per-metric `warn`/`critical` overrides |

## Other sections

`persistence` · `detection` · `context` · `prompts` · `eval` · `notifications` · `server` ·
`domain` — see [Configuration](../getting-started/configuration.md) for the overview and the
example file for every field.

!!! note "Secrets never live in the file"
    URLs and keys use `${ENV}` / `${ENV:-fallback}` interpolation. The browser only ever
    receives a **secret-free projection** of the resolved config.
