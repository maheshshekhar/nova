# API routes

Nova's server exposes a small set of App Router endpoints. All are server-rendered on demand.

| Route | Method | Purpose |
|---|---|---|
| `/api/metrics` | GET | Per-service metrics (`?endpoint=metrics/services`), namespaces, deployments. Dispatches to the configured metrics source (Prometheus / collector). |
| `/api/logs` | GET | Real cluster logs for a service, via the configured `LogSource`. |
| `/api/incidents` | GET / POST | List/filter the incident store; create a live incident. |
| `/api/incidents/[id]` | GET / PATCH | Fetch or update (resolve) a single incident. |
| `/api/incidents/[id]/rca` | — | Persisted RCA document for an incident. |
| `/api/alerts` | POST | Alertmanager/ruler webhook → opens a real incident (idempotent per service). |
| `/api/analyze` | POST | Streamed AI triage / RCA from grounded context. |
| `/api/chat` | POST | "Ask the incident" conversational endpoint. |
| `/api/remediate` | POST | Perform a runbook's real cluster remediation. |
| `/api/eval` | GET / POST | Run and read the LLM-as-judge evaluation. |
| `/api/dashboard-config` | GET | Secret-free projection of the `dashboard` config. |
| `/api/tiles` | GET | Execute a configured PromQL stat tile server-side (`?id=`). |
| `/api/settings` | GET | Secret-free settings view (redacted URLs, env-var names only). |
| `/api/health` | GET | Liveness. |

!!! info "Safety"
    Endpoints that reach upstreams (PromQL tiles, log queries) execute **server-side** against
    config-allow-listed hosts. Secrets are referenced by env-var name and never returned to the
    browser.
