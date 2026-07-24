# Quickstart — the KinD demo

The bundled demo spins up a **full local cluster** — a real failing `payment-service`,
Postgres, Prometheus + Alertmanager, Loki + Fluent Bit, and Nova — so you can watch the
entire detect → analyze → remediate loop end to end.

## Prerequisites

- Docker, `kind`, `kubectl`, `helm`
- (optional) an AI key for RCA generation

## Bring it up

```bash
# 1. build images + install the whole stack into a local KinD cluster
./examples/kind-demo/scripts/cluster

# 2. deploy the demo application (payment / config / transaction services)
./examples/kind-demo/scripts/deploy-app

# 3. add your AI key so RCA can generate (optional but recommended)
kubectl -n nova-monitoring create secret generic ai-keys \
  --from-literal=OPENROUTER_API_KEY='sk-or-...' \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n nova-monitoring rollout restart deploy/dashboard
```

Open the dashboard (via the port-forward the script sets up) and you'll see live service
health, real latency/RPS from Prometheus, and an empty incident list.

## Trigger an incident

```bash
./examples/kind-demo/scripts/inject-failure   # k6 load → payment-service pool exhaustion
```

Within ~20–30s:

1. `payment-service` degrades and starts returning `503`s.
2. The **Loki ruler** detects the ERROR/503 spike and `POST`s to `/api/alerts`, which opens a
   real incident in the store.
3. The dashboard reflects it from `/api/metrics` + `/api/incidents` — real error rate, latency,
   and pod state.
4. Open the incident → **Analyze with AI** streams a grounded RCA from the service's real logs.

## Recover

```bash
./examples/kind-demo/scripts/recover          # stop load + scale → back to green
```

## Tear down

```bash
./examples/kind-demo/scripts/teardown
```

!!! info "Production parity"
    The demo is deliberately production-shaped: the apps expose real Prometheus metrics
    (`http_requests_total`, `http_request_duration_seconds`, …), scraped via a `ServiceMonitor`,
    and Nova queries Prometheus exactly as it would against your cluster.
