# Nova Metrics Architecture — Design Plan (tracked)

> **⚠️ BRANCH RECONCILIATION (2026-07-27):** This plan was first drafted on the
> `feat-2` branch, which did **not** have `main`'s metrics adapter. On `main`,
> `lib/metrics/` **already exists and is more complete** than the feat-2 Phase 1
> (it has `source.ts`, `registry.ts`, `prometheus-source.ts`, **`descriptors.ts`**,
> **`inventory.ts`** for the k8s+Prometheus hybrid merge, and **`app/api/tiles/`**).
> Therefore, on `main`:
> - **Phase 0 (doc re-baseline) — N/A.** The "docs say complete but code absent"
>   problem was a feat-2 artifact; `main`'s roadmap is accurate.
> - **Phase 1 (adapter layer) — already DONE on `main`** (more complete). The feat-2
>   duplicate is dropped.
> - **Work continues from Phase 2**, re-scoped against `main`'s existing `lib/metrics`
>   (the synthetic-p99 kill, the signal/capability model, the Signals Settings tab,
>   discovery + presets, and scale hardening are still to build).
>
> **Status:** DESIGN. Implementation is gated — each phase is checked off only when
> its code + tests land. This document is the single source of truth for the work
> that makes Nova's metrics **real, agnostic, and self-configuring** for any
> workload from a handful of pods to thousands.
>
> **Owner decisions locked (2026-07-27):**
> - **Config authorship = pure GitOps.** The discovery helper *authors* a
>   `nova.config.yaml` fragment for the operator to commit. Git remains the source
>   of truth; Nova stays file-authoritative (no settings-write-to-disk backdoor).
> - **Auto-detection posture = advisory only (strict auto-suggest).** Detected
>   exporters are **never** rendered as live tiles on their own. Discovery is a
>   helper surface that shows what it found and generates the YAML to commit; the
>   dashboard renders richer signals only once they are pinned in git. The always-on
>   k8s built-ins (pod health, CPU, memory, inferred error rate) still render with
>   zero config, so a fresh deploy is never blank. This guarantees **what you see on
>   the dashboard maps 1:1 to what's in git** — the confidence property the
>   open-source engineer needs.> - **Preset library = ship broad, tiered, standard-first.** Versioned declarative
>   presets (YAML + fingerprint + confidence), OTel semconv as the primary standard;
>   Tier 1 OTel/RED + kube-state-metrics + cAdvisor → Tier 2 mesh/ingress → Tier 3
>   runtimes/db. Advisory-only posture is what makes "broad" safe.
> - **Signals panel = a new Settings tab** (behind the gear icon) plus a dismissible
>   first-run banner.> - **Scope = all 5 phases**, delivered in order, tracked here.

---

## 0. Why this document exists (reality check)

`docs/observability-roadmap.md` marks **"Phase A — Prometheus metrics adapter" as
complete**, and the published website (`website/site/concepts/adapters/index.html`,
`website/site/reference/api/index.html`) documents `lib/metrics/registry.ts` and a
`/api/tiles` endpoint. **None of that exists in the code today:**

- `lib/metrics/` — **absent**.
- `app/api/tiles/` — **absent**.
- `app/api/metrics/route.ts` — still a **plain proxy** to `METRICS_COLLECTOR_URL`;
  it ignores `metrics.provider` entirely.
- p99 is still **synthetic** (`rate * 1.35` in `lib/metrics-series.ts`).
- The Settings UI is **read-only** (`lib/settings/view.ts`, D4 file-authoritative)
  and exposes only metrics `provider` + `url`.

So Phase A was *designed and documented* (even shipped to the docs site) but never
landed in code, or was reverted. **Phase 0 of this plan is to re-baseline** the
roadmap + website so the docs stop claiming an implementation that isn't there.

The **logs subsystem is the reference implementation to mirror**: `lib/logs/source.ts`
(the port), `lib/logs/registry.ts` (via `lib/config/registry.ts`'s `AdapterRegistry`),
`loki-source.ts` / `es-source.ts` / `mcp/`, plus `scope.ts` and `field-map.ts`.

---

## Guiding principles (do not violate)

- **Config-driven, domain-agnostic.** Nova ships zero hardcoded service names,
  queries, or thresholds. Every binding is declared in `nova.config.yaml` or derived
  from a generic exporter preset — never from a customer-specific assumption.
- **Never fabricate a signal.** A metric Nova cannot measure is shown as
  *"not configured"* — never as a number. This kills the synthetic p99 and forbids
  its return.
- **Additive & default-safe.** New providers default to the current behaviour
  (`http` collector). Opting into `prometheus` is explicit.
- **Nova is a client, not a platform.** We *query* the customer's Prometheus / Loki /
  Tempo. We never scrape, instrument, or own their stack.
- **SSRF/injection safe.** Any PromQL/TraceQL reaching an upstream runs **server-side**
  against a **config-allowlisted URL**; the browser only ever passes an opaque tile/id.
- **GitOps authorship.** The dashboard renders only from committed config (plus the
  always-on k8s built-ins). Discovery is **advisory**: it proposes YAML to commit and
  never silently drives a tile — so an engineer is always confident that what they see
  maps to what's in git.

---

## The core abstraction: the Signal Capability Model

Everything below hangs off one concept Nova lacks today.

- A **Signal** is a semantic quantity the UI wants, independent of backend:
  `pod_health`, `cpu`, `memory`, `error_rate`, `latency_p50/p95/p99`, `rps`,
  `saturation`, (later) `trace_error`, `trace_latency`.
- A **Capability** is a resolved binding for a signal:
  `signal → { source, method/query, state }` where `state ∈ { real, fallback, unavailable }`.
- **Tiles bind to signals, not fields.** A tile renders only when its signal resolves
  to `real` (or an explicitly-allowed `fallback`); otherwise it hides or shows a
  *"Configure this →"* affordance that deep-links into the wizard.

```
Sources ── discovery/probe ──▶ Capability Registry ◀── nova.config.yaml
  (k8s, Prometheus, Loki, Tempo)          │
                                          ├─▶ capability-bound tiles (real only)
                                          └─▶ discovery helper (advisory: gaps + suggested YAML)
```

**Resolution precedence (deterministic):**
`explicit nova.config.yaml` →
`built-in fallback (k8s pod-derived: pod_health, cpu, memory, inferred error_rate)` →
`hide`. Discovery/detection is **advisory** and is never a resolution source — it only
proposes YAML to commit.

---

## Target config surface (end-state)

```yaml
metrics:
  provider: prometheus              # prometheus | http | none  (http = today's collector)
  url: ${PROMETHEUS_URL}            # allowlisted; server-side only
  authTokenEnv: PROM_TOKEN          # optional bearer, by ENV VAR NAME
  serviceLabel: service             # which label identifies a "service" (app | service | destination_service_name…)
  preset: otel-red                  # auto-suggested; expands into the signal queries below
  signals:                          # explicit queries WIN over the preset
    error_rate:  'sum by (service)(rate(http_requests_total{code=~"5.."}[5m])) / sum by (service)(rate(http_requests_total[5m])) * 100'
    latency_p95: 'histogram_quantile(0.95, sum by (service,le)(rate(http_request_duration_seconds_bucket[5m])))'
    rps:         'sum by (service)(rate(http_requests_total[5m]))'
  scale:
    mode: aggregate                 # aggregate (recording-rules, fleet) | enumerate (small/demo)
    topN: 100                       # cap services rendered; table virtualizes the rest
    pollSec: 15
```

Per-service SLOs/thresholds live in the **domain pack** (extends `lib/domain/schema.ts`,
which today has tier/owner/dependencies but no SLO/query), so ownership and objectives
stay with the domain, not the global metrics block.

---

## Phase 0 — Re-baseline the docs  ✅

- [x] Correct `docs/observability-roadmap.md`: unmark Phase A "complete"; point to this plan.
- [x] `website/site/**` — **N/A**: the site is an **untracked, generated artifact** (0 files in
      git, no mkdocs source in this repo). It will be regenerated from its source once the
      metrics work lands; there is nothing to source-control-fix here.
- [x] Land this document; link it from the roadmap.

## Phase 1 — Metrics adapter layer (foundation)  ✅

Mirror `lib/logs/` exactly.

- [x] `lib/metrics/source.ts` — `MetricsSource` port: `getServiceMetrics()` →
      `RealServiceMetric[]`; plus `ServiceMetricsResult` + `SIGNAL_KEYS`.
      (Range/`queryScalar` helpers deferred to when a query-tile needs them.)
- [x] `lib/metrics/registry.ts` — `AdapterRegistry<MetricsConfig, MetricsSource>`
      (reuse `lib/config/registry.ts`); registers `prometheus`. `http`/`none` are
      **route-handled** (the route owns the collector proxy + inventory endpoints).
- [x] `lib/metrics/prometheus-source.ts` — server-only `/api/v1/query` client,
      injectable `fetch`, bearer from `authTokenEnv`, **SSRF-safe** (host from
      `metrics.url` only, queries from config only). Never fabricates a signal.
- [x] `http` collector behaviour kept **byte-for-byte** in the route (no separate
      adapter needed — it's a pass-through proxy, unlike Prometheus which computes).
- [x] Rewrote `app/api/metrics/route.ts` to resolve `metrics.provider`: `http`
      proxies unchanged, `prometheus` serves services via the adapter (+ best-effort
      collector inventory), `none` → 503.
- [x] Expanded `MetricsConfigSchema` (`serviceLabel`, `authTokenEnv`, `signals`,
      `preset`) with behaviour-neutral defaults. (`scale` lands in Phase 5.)
- [x] Tests: Prometheus adapter (7) — assembly, status thresholds, custom
      serviceLabel, bearer + endpoint, no-fabrication, error propagation; registry (4).
      Full suite green (333), clean typecheck, `next build` OK.

## Phase 2 — Signal/capability model + honest tiles  ✅ (already on `main`)

**Audit finding (2026-07-27):** `main` already delivers Phase 2's substance, so the
formal `lib/signals/` layer is **intentionally not built** — it would duplicate
[lib/metrics/descriptors.ts](../lib/metrics/descriptors.ts). What exists on `main`:

- [x] **No synthetic p99** — `lib/metrics-series.ts` `ErrorPoint` is `{ time, rate }`
      (real error rate only, EMA-smoothed; no `rate * 1.35`, no latency fabrication).
- [x] **Descriptor catalog** = [lib/metrics/descriptors.ts](../lib/metrics/descriptors.ts):
      14 descriptors (label/unit/format/viz/thresholds) + `evaluateHealth()` + a generic
      fallback + `NUMERIC_METRIC_KEYS`. This is the signal-descriptor layer.
- [x] **Honest, capability-bound tiles** — `LatencyChart` shows an empty state when no
      latency source; `service-health-table.tsx` presence-filters latency/RPS columns;
      `stats-bar.tsx` renders real aggregates + config `stats.tiles` (metric/PromQL).
- [x] **Hybrid merge** — [lib/metrics/inventory.ts](../lib/metrics/inventory.ts)
      (`mergeServiceSources` / `collectorServicesFromPayload`) overlays real Prometheus RED
      on real k8s pod-health/CPU/mem.
- [~] The only deferred bit — a `/api/capabilities` state projection — is folded into the
      discovery report + Signals panel (Phases 3–4), where it is actually consumed.

## Phase 3 — Discovery engine (auto-detect any source)  🚧 (core built)

**Preset strategy = ship broad, tiered, standard-first, versioned declarative data.**
Each preset carries a **fingerprint** (the metric names it needs) so detection is just
*"do these series exist?"* + a **confidence score**, and maps those metrics → PromQL.
Broad is safe **only because detection is advisory** (a wrong match is a reviewable
suggestion, never a live tile). Lean on **OpenTelemetry Semantic Conventions** first.

- [x] `lib/discovery/presets.ts` — **typed declarative preset library** (compile-checked,
      test-covered; `$SVC` expansion, latency normalised to ms, `version` per preset).
      Shipped: **OTel HTTP semconv · generic RED (`http_requests_total`) · Istio · NGINX
      ingress**. (More exporters — Linkerd/Envoy/JVM/DB, and cAdvisor/KSM infra — are additive.)
- [x] `lib/discovery/fingerprint.ts` — `fetchMetricNames()` (GET
      `/api/v1/label/__name__/values`, bearer-aware), pure `matchPresets()` (ranked by
      confidence, respects `all`/`any`), `expandQueries()`, `buildReport()`.
- [x] `GET /api/discovery` — server-side, SSRF-safe (host from `metrics.url` only), returns
      a ranked `DiscoveryReport` of ready-to-commit `metrics.queries`. Advisory only.
- [x] Tests: 14 — per-exporter fingerprint match, ranking, `all`-required, `$SVC`
      expansion + label override, report assembly, `fetchMetricNames` (success/bearer/error).
- [ ] `lib/discovery/kubernetes.ts` — read-only probe to auto-find the Prometheus URL
      (`ServiceMonitor`/`PodMonitor` + Prometheus Services) instead of requiring `metrics.url`.
- [ ] `lib/discovery/logs.ts` — log-source reachability + label discovery (reuse `logs.discovery`).
- [ ] Broaden the preset library (Tier 1 infra: kube-state-metrics/cAdvisor; Tier 2/3 the rest).
- [ ] Disambiguation: when multiple presets match, surface the ranked options for the operator
      to **pick one** (resolved in the Phase 4 panel).

## Phase 4 — Discovery helper UI + YAML generation (GitOps)  ⬜

One advisory **Signals panel**, reached two ways (first-run nudge + permanent gear-icon
entry). Detection **never** drives a live tile — it only proposes YAML to commit.

- [ ] **Signals panel** (the shared content): a table of every semantic signal with state
      **Live** (pinned in config, driving a tile) / **Detected** (source found, not in git yet) /
      **Unavailable** (no source), each with its source + the exact query it would use.
- [ ] **Door 1 — first-run banner:** a dismissible callout when Nova detects unpinned signals
      (*"Detected N signals not yet in your config — review"*) that links to the panel.
      A nudge, not a blocking wizard.
- [ ] **Door 2 — gear icon:** the same panel lives permanently as a **Settings tab** so detection
      is **re-runnable anytime** as the cluster evolves.
- [ ] **Disambiguation:** when Phase 3 reports multiple preset matches for a service, the panel
      lets the operator **pick one** before the YAML is generated.
- [ ] `lib/config/generate.ts` — serialize detected + confirmed signals into a valid
      `nova.config.yaml` fragment (round-trips through `NovaConfigSchema`).
- [ ] **Copy / Download YAML** per-signal and for the full `metrics` block (no server write) —
      output goes to source control.
- [ ] Show the **current effective config** (read-only, redacted) alongside, so engineers see
      exactly what drives the dashboard = confidence.
- [ ] Tests: generated YAML parses + reproduces the chosen bindings; redaction (no secrets or
      raw internal PromQL in view/export payloads); **assert tiles never render from detection
      alone** (only from committed config or k8s built-ins).

## Phase 5 — Scale hardening (100s–1000s of pods)  ⬜

- [ ] `scale.mode: aggregate` — fleet aggregates via Prometheus **recording rules** /
      kube-state-metrics instead of listing every pod each tick.
- [ ] Cardinality guards: query by label selector, `topN` cap, **virtualized/paginated**
      service tables.
- [ ] Configurable poll cadence + server-side caching; back-pressure on slow upstreams.
- [ ] Load/perf test at simulated 1–2k services; document limits + recommended recording rules.
- [ ] Tests: aggregation correctness vs enumerate mode; topN + virtualization; cache TTL.

---

## Cross-cutting done-bar (every phase)

- [ ] `vitest` green + `next build` + typecheck.
- [ ] New config fields: zod default + `nova.config.example.yaml` entry + defaults test +
      secret-free settings/API projection.
- [ ] No behaviour change until opted in (`http` collector remains the default).

## Open questions (resolve before the relevant phase)

- **Phase 3/4:** — **decided:** ship the preset library **broad but tiered** (Tier 1 OTel/RED +
  kube-state-metrics + cAdvisor → Tier 2 mesh/ingress → Tier 3 runtimes/db), as versioned
  declarative data with fingerprints + confidence; advisory-only makes broad safe.
- **Phase 4:** — **decided:** Signals panel is a **new Settings tab** (+ a dismissible first-run banner).
- **Phase 5:** require operator-provided recording rules, or have Nova emit a suggested
  `PrometheusRule` manifest as part of the discovery helper output? (Leaning: emit a suggestion.)
