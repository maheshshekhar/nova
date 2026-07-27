# Nova: Config Simplification + Sentinel Detection — Plan (tracked)

> **Status:** DESIGN. Implementation gated — each item is checked off only when
> its code + tests land. This plan turns Nova from "a dashboard you point at
> backends" into an **intelligent, zero-instrumentation early-detection layer that
> sits beside your stack** and flags issues before threshold tools do.

## Locked decisions (from the design discussion, 2026-07-27)

- **Nova sits *beside*, never replaces** Prometheus / Alertmanager / Loki / k8s.
- **Zero-instrumentation.** Nova NEVER requires apps to log `ERROR` or any format.
  It detects from whatever signals already exist.
- **Detection is watch-based and real-time — NOT cron.** A long-running controller
  (a lightweight operator) reacts the instant something starts going wrong.
- **Precision > recall.** A candidate→confirm pipeline; false incidents cost money
  and trust. Hard signals fire immediately; soft signals must corroborate.
- **Detection creates an *evidenced* incident; it does NOT auto-attach an RCA.**
  The existing **"Analyse with AI"** action runs `prompts/rca.md` on demand.
- **`nova-config.yaml` is the single source of truth** (logs already works this way;
  metrics must too). Secrets stay in env; everything else in one file.
- **Honest boundary:** Nova can only detect what is *signaled somehow* (log, k8s
  object/event, or metric). Totally silent failures are invisible to everyone.

---

## Part A — Config simplification (immediate, small)

### A1. Metrics = single source of truth (match logs)  ✅
- [x] `app/api/metrics/route.ts`: resolves the collector URL from **config** via
      `resolveCollectorUrl()`, not `process.env.METRICS_COLLECTOR_URL` directly (the
      env stays only as the `${...}` interpolation default in `nova-config.yaml`).
- [x] Schema: added `metrics.collectorUrl` — a real config field so the `http`
      path reads config like the `prometheus` path already does.
- [x] Tests: `lib/metrics/collector-url.ts` resolver (5) — http uses `url`,
      prometheus uses `collectorUrl` (never the prometheus url), defaults, and a
      guard that it never reads `process.env`. 408 total green, tsc clean, build OK.

### A2. Reframe the provider model to "what you have"  ⬜
- [ ] Providers read as: `prometheus` ("I have Prometheus" → RED metrics),
      `kubernetes` ("read pod health from the k8s API" — today's collector, reframed,
      optional), `none`. Keep `http` as a back-compat alias for `kubernetes`.
- [ ] `prometheus` auto-adds k8s pod-health when available (existing hybrid merge).
- [ ] Docs + Settings/Signals wording: pick a provider by what your cluster exposes.

**Outcome:** the engineer edits ONE file (`nova-config.yaml`) to declare logs +
metrics; no `dashboard.yaml` env juggling; no split pointers.

---

## Part B — Nova Sentinel (the intelligent detection engine)

### Where each piece lives — code vs config vs domain pack (READ FIRST)

The intelligence **ships as code**; the engineer never configures the algorithms.
Config is only for **opt-in + tuning + business-specific declarations**. Three layers:

| Layer | Holds | Configured by engineer? |
|---|---|---|
| **Code (shipped in Nova)** | k8s signal catalog (B1), correlation/candidate→confirm engine (B2), incident+evidence builder (B3), anomaly engine + generic technical signature library (B4) | **No** — works out of the box |
| **`nova-config.yaml` → `detection:`** | knobs: `enabled`, `dryRun`, `sensitivity`, `dedupeWindowSec`, per-source toggles, custom signature additions, absence baselines (B6) | **Optional** — sensible defaults |
| **`domains/*.yaml` (Domain Packs)** | business meaning Nova can't know: impact patterns, `severityRules` (B5) | **Optional** — generic default ships |

Per item: **B2, B3, B4 = code** (config exposes only `sensitivity`/`dedupeWindowSec`
and optional signature additions). **B5 = domain pack + a little config** (business
impact patterns + absence baselines). **B6 = the `detection:` schema** that surfaces
the knobs. **With an empty config, B1–B3 still fully work** — zero-config detection.

The complete surface an engineer would ever touch (all optional):

```yaml
# nova-config.yaml — knobs only; the intelligence is built-in
detection:
  enabled: true
  dryRun: false               # detect but don't open incidents (tuning)
  sensitivity: medium         # low | medium | high
  dedupeWindowSec: 300
  sources: { kubernetes: true, logs: true, metrics: true }
  logSignatures:              # OPTIONAL: extend the shipped library
    - { id: my-svc-quirk, pattern: "saga rollback", severity: high }
  absence:                    # OPTIONAL: business KPIs (B5)
    - { id: checkouts, signal: "checkout completed", dropPct: 80, windowSec: 300 }

# domains/payments.yaml — OPTIONAL business meaning (B5)
domain:
  impactSignal: { match: { pattern: "5\\d\\d|pool.connect\\(\\) timeout" }, unit: "failed checkouts" }
  severityRules: [ { when: { errorRatePct: ">5" }, severity: critical } ]
```

### B0. Runtime architecture  ⬜
- [ ] Ship a **companion Deployment `nova-sentinel`** (Node, shares `lib/` + config)
      in the Helm chart. **Always-on, watch-based — NOT a CronJob.**
- [ ] Read-only k8s RBAC (watch pods, events, deployments, replicasets, configmaps,
      secrets *existence only*, jobs). Resource limits. Kill switch / **dry-run mode**
      (detect + log, don't open incidents — for tuning).
- [ ] Opens incidents via the store / `POST /api/incidents`; **dedupes** against
      incidents already created by `/api/alerts` (reuse per-service idempotency).

### B1. Tier 1 — Kubernetes-native signals (build FIRST; most robust, no logs needed)  ⬜
- [ ] k8s **informer/watch** collectors for:
      - container/pod state: `CrashLoopBackOff`, `OOMKilled` (137), restart **trend**,
        waiting reasons (`CreateContainerConfigError`, `RunContainerError`).
      - Events: `BackOff`, `Unhealthy` (probe failures), `FailedMount`,
        `FailedScheduling`, `ImagePullBackOff`/`ErrImagePull`, `FailedCreatePodSandBox`.
      - **config/secret integrity**: a workload references a Secret/ConfigMap that
        doesn't exist (caught before/at container start).
      - rollout health: progress-deadline slipping; pods `Pending`/unschedulable.
- [ ] Normalise everything into a common `Signal { service, namespace, kind,
      severity, evidence, firstSeen, source }`.
- [ ] Tests: pure signal extraction from k8s object/event **fixtures** (deterministic).

### B2. Correlation + candidate→confirm engine  ⬜
- [ ] Per-service, in-memory signal accumulation with a rolling window.
- [ ] Scoring: **hard** signals (CrashLoop, OOMKilled, missing Secret) → open
      immediately; **soft** signals (log-novelty, volume spike) → open only when
      corroborated (≥ N independent signals or a hard confirm).
- [ ] **Leading indicators** ("tell before"): restarts *accelerating*, memory
      *approaching* limit (OOM risk), rollout *degrading*, error-template frequency
      *rising*.
- [ ] Dedup + suppression windows; confidence attached to each incident.
- [ ] Tests: deterministic scenarios (hard-immediate, soft-confirm, dedup, suppress).

### B3. Incident creation with evidence (no auto-RCA)  ⬜
- [ ] Open an incident carrying the **evidence** (the signals + samples) and a
      human "why flagged" summary. No LLM on the hot path.
- [ ] Ensure the existing **"Analyse with AI"** action consumes that evidence with
      `prompts/rca.md` on demand.

### B4. Tier 2 — Log signals by *anomaly*, not keyword  ⬜
- [ ] Continuous log tail (Loki `tail` / k8s stream) into a rolling window.
- [ ] **Log-template clustering** (Drain-style) → **novelty** detection: a
      never-seen-before template is a signal (no `ERROR` keyword required).
- [ ] **Volume / rate-shift** detection per service.
- [ ] **Generic technical signature library** (shipped, config-extendable):
      DB (pool exhausted, deadlock, `SQLSTATE`, conn refused), network
      (reset/timeout/DNS/TLS), runtime (OOM, `panic:`, segfault, stack traces),
      HTTP 5xx bursts, resource (disk full, throttling).
- [ ] Opportunistic: use a structured `level` or HTTP status **if present** — never required.
- [ ] Tests: template novelty, volume shift, signature matches across formats.

### B5. Tier 3 — Domain + business + absence signals  ⬜
- [ ] Use **Domain Pack** `impactSignal` patterns as declared business signals
      (e.g. payments: `pool.connect() timeout` = failed checkout) — matched against
      logs the app already emits; declared once in config.
- [ ] **Absence/baseline detection** for "checkouts not happening": baseline a
      *countable* success signal (a metric or a success-log rate) and flag a **drop**.
      (Explicitly documented: needs *some* countable signal — silence is undetectable.)
- [ ] Optional **AI judgment** for ambiguous/business-semantic clusters (guarded, on
      demand) — reasons over signals that exist; never invents.

### B6. Config surface — make `detection:` REAL  ⬜
- [ ] Replace the currently-inert `detection:` block with a real, consumed config:
      `enabled`, `dryRun`, `sensitivity`, per-signal toggles, `dedupeWindow`, domain
      signal refs, absence baselines.
- [ ] zod defaults (default `enabled: false` → opt-in, behaviour-neutral) + example
      yaml + defaults test + secret-free settings projection.

### B7. Dashboard surfacing  ⬜
- [ ] Sentinel-detected incidents appear in the incident list with **evidence** and a
      "why flagged / confidence" summary; a signal **timeline** on incident detail.
- [ ] Clear provenance badge: `detected by Nova` vs `from Alertmanager`.

### B8. Production safety  ⬜
- [ ] Precision guards, rate limits, backpressure; read-only RBAC; resource limits.
- [ ] Dry-run/tuning mode surfaced in the UI; per-service mute.

---

## Suggested order

**A1 → A2** (quick config wins) →
**B0 → B1 → B2 → B3** (k8s-native detection MVP — deterministic, high value, no
logs/metrics needed) →
**B4** (log anomaly) → **B5** (domain/absence) → **B6/B7/B8**.

The B0–B3 slice alone already delivers the core promise: Nova opens evidenced
incidents for crashing/OOM/misconfigured/failing-to-schedule workloads **in real
time, before a metric threshold trips**, with zero app changes.

## Cross-cutting done-bar (every item)

- [ ] `vitest` green + `next build` + typecheck.
- [ ] New config: zod default (opt-in) + `nova.config.example.yaml` + defaults test +
      secret-free projection.
- [ ] No behaviour change until opted in (`detection.enabled: false` by default).

## Open questions (resolve before the relevant part)

- **B0:** the `nova-sentinel` worker writes incidents via the **store directly** or
  via `POST /api/incidents`? (Leaning: internal API call — one write path, reuses
  idempotency + notifications.)
- **B4:** ship the Drain-style clusterer in-process (Node) vs a small dependency?
- **B5:** how much AI to allow on the detection path (cost/latency) vs keep it strictly
  on-demand for RCA only? (Leaning: on-demand only; deterministic detection.)
