# Logs & log scope

Nova reads logs from your backend through a **backend-neutral scope** — a set of logical
selectors that each adapter compiles into its native query (LogQL, ES DSL, …). You describe
*where* to look once; the adapter translates.

## Configure

```yaml
logs:
  provider: loki                # loki | elasticsearch | opensearch | mcp | cloudwatch | datadog | http | file
  url: ${LOKI_URL:-http://loki:3100}
  fields:                       # map your backend's fields onto Nova's logical dimensions
    namespace: namespace
    service: app
    level: level
    message: message
    timestamp: timestamp
  scope:                        # WHERE Nova reads logs (backend-neutral)
    include:
      - { namespace: production }
    exclude:
      - { service: load-generator }
```

Selectors accept an exact value, a list, or a `{ regex: "..." }` — and compile to the right
query for each backend.

## Adapters

| Provider | Notes |
|---|---|
| `loki` | Grafana Loki via LogQL |
| `elasticsearch` / `opensearch` | Same wire protocol; set `index` |
| `mcp` | Consume any MCP server as a log backend — Nova calls the tool directly (deterministic, never via the LLM) |
| `cloudwatch` / `datadog` / `http` / `file` | Contract-ready adapter slots |

## How logs are used

Real logs feed the incident detail page (Related Logs + Timeline), ground the AI RCA, and power
the log viewer. There is **no static fallback stream** — before the first poll lands, or when the
backend is unreachable, Nova shows an honest empty/offline state.
