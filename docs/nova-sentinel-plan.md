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

### A2. Reframe the provider model to "what you have"  ✅
- [x] Providers now read as: `kubernetes` (**default** — "read pod/workload health
      from the k8s API"), `prometheus` ("I have Prometheus" → **optional** app RED
      metrics), `none`. `http` kept as a **legacy alias** for `kubernetes`.
- [x] Behaviour-neutral: `kubernetes`/`http` share the same collector path today;
      the collector is superseded by Nova's own informer reader in B0/B1.
- [x] Docs (schema, `nova.config.example.yaml`, demo `nova-config.yaml`) reframed to
      "pick by what you have"; `prometheus` clearly marked OPTIONAL (app RED only).
- [x] Tests: default is `kubernetes`; `http` legacy alias still accepted;
      `resolveCollectorUrl` covers `kubernetes`. 410 total green, tsc clean, build OK.

> **ARCHITECTURE CORRECTION (2026-07-27) — no baggage.** After pressure-testing:
> **k8s informers are the backbone** (they scale like any operator; the earlier
> "direct read won't scale" worry was wrong). Therefore:
> - **KSM + cAdvisor via Prometheus is DROPPED** — it's a redundant pipeline for
>   data the informer already has. Not recommended, not required.
> - **Prometheus is scoped to app RED metrics ONLY** (error rate / latency / RPS) —
>   the one thing the k8s API can't provide. Optional enrichment; detection works
>   fully from **k8s + logs** without it.
> - **The custom `nova/metrics-collector` is retired** once B0/B1 lands (Nova's own
>   informer reader takes over). Until then it remains as the transitional impl.
> - Final sources: **k8s informers** (detection + pod/workload health) ·
>   **metrics-server** (CPU/mem, optional) · **logs** (app detection) ·
>   **Prometheus** (optional app RED). Nothing else.

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

### B0. Runtime architecture  ✅
- [x] Ship a **companion Deployment `nova-sentinel`** (Node, shares `lib/` + config)
      in the Helm chart. **Always-on, watch-based — NOT a CronJob.**
- [x] Read-only k8s RBAC (pods, events, nodes, deployments, pods/log, metrics.k8s.io).
      Resource limits. Kill switch / **dry-run mode** (detect + log, don't open
      incidents — for tuning).
- [x] Opens incidents via `/api/alerts` (Alertmanager-shaped POST), reusing its
      per-service idempotency so it never double-fires with external alerts.

### B1. Tier 1 — Kubernetes-native signals (build FIRST; most robust, no logs needed)  ✅
- [x] **Normalised `Signal` model** (`lib/sentinel/signal.ts`): `{ kind, service,
      namespace, severity, hard, message, source }` + `hard` vs `soft` classification.
- [x] **Pure pod → signal extraction** (`lib/sentinel/extract.ts`,
      `extractPodSignals`): `CrashLoopBackOff`, `OOMKilled` (exit 137),
      `ImagePullBackOff`/`ErrImagePull`, `CreateContainerConfigError` (missing
      Secret/ConfigMap, keeps the message), `RunContainerError`/`Error`,
      `HighRestarts` (soft, leading indicator), `Unschedulable`. Deterministic,
      decoupled from the k8s client. **12 tests** with realistic fixtures.
- [x] **Event extraction** (`extractEventSignal`): `FailedMount`, `Unhealthy` probe,
      `FailedScheduling`, `FailedCreatePodSandBox`, `BackOff` — with an injectable
      `ServiceResolver` (informer pod cache maps object → service). 6 tests.
- [x] k8s **informer/watch** wiring that feeds real pods/events through the extractors
      (`lib/sentinel/run.ts` — pod + event informers, operator-grade).
- [x] rollout health: progress-deadline slipping — `extractDeploymentSignals`
      flags a Deployment whose `Progressing` condition is `ProgressDeadlineExceeded`
      as a hard `BadRollout` (→ `bad-deploy`); a deployments informer feeds it.
      Ignores normal mid-rollout unavailability (low false-positive).

### B2. Correlation + candidate→confirm engine  ✅ (core)
- [x] Per-service, in-memory signal accumulation with a rolling window
      (`lib/sentinel/correlate.ts`, `Correlator`, injectable clock).
- [x] Scoring: **hard** signals (CrashLoop, OOMKilled, missing Secret) → open
      immediately; **soft** signals → open only when corroborated (≥ `softConfirmKinds`
      DISTINCT soft kinds in the window).
- [x] Dedup (one open incident per service until `resolve()`); window expiry so
      aged signals don't confirm; `confidence` (0.9 hard / 0.6 soft) + severity +
      `reason` + evidence attached to each `IncidentDecision`.
- [x] Tests: 8 — hard-immediate, single-soft-candidate, same-kind-no-confirm,
      distinct-soft-confirm, dedup, window-expiry, resolve-reflag, multi-service.
- [x] **Leading indicators** ("tell before") — `lib/sentinel/leading.ts`:
      `RestartAccelerationMonitor` flags a container whose restart *cadence* is
      speeding up (before CrashLoop backoff masks it); `MemoryTrendMonitor` flags a
      container whose working set is high (≥ 85% of limit) AND rising (before an
      OOMKill), fed by a metrics-server poll. Both SOFT (corroborate); wired into
      `engine.onPod`/`engine.onMemory`. `parseQuantity` for memory limits. 11 tests
      + engine integration.

### B3. Incident creation with evidence (no auto-RCA)  ✅
- [x] `decisionToAlert()` (`lib/sentinel/incident.ts`) — pure map from a correlator
      `IncidentDecision` to an Alertmanager-shaped payload (severity + failure_type +
      `source: nova-sentinel` provenance; evidence signals in the description). No LLM.
- [x] `collectSignals()` (`lib/sentinel/pipeline.ts`) — pure glue: pods+events →
      extractors → signals (fed to the `Correlator`).
- [x] `IncidentSink` + `HttpAlertSink` (`lib/sentinel/sink.ts`) — Sentinel POSTs to the
      **existing** `/api/alerts` pipeline, reusing its per-service idempotency, incident
      store and notifications. Sentinel "sits beside" external alerts on the same path.
- [x] Tests: mapping (failure types, hard-signal primary, evidence), end-to-end
      pod→decision, sink post/no-op/error (`lib/sentinel/worker.test.ts`).
- [x] **Informer runtime** (`lib/sentinel/run.ts`) — watches Pods + Events with
      `@kubernetes/client-node` informers (operator-grade, no polling), forwarding
      each object to a pure, tested `SentinelEngine` (`lib/sentinel/engine.ts`).
      `PodServiceIndex` (`lib/sentinel/service-index.ts`) resolves Event→service.
      Recovery observed (healthy pod) re-arms detection. Env-driven config
      (NOVA_URL / namespaces / dry-run / window / soft-confirm) — no server-only.
- [x] **Companion Deployment** (`deploy/helm/nova/templates/sentinel.yaml`, gated by
      `sentinel.enabled`) — separate pod, **read-only** RBAC (get/list/watch on
      pods, events, nodes), hardened SecurityContext, dry-run mode. Image via
      `deploy/sentinel/Dockerfile` (tsx runtime).
- [x] Tests: `PodServiceIndex` + engine (open/dedup/event-resolve/dry-run/recovery)
      in `lib/sentinel/engine.test.ts`. 454 tests green; helm renders clean.
- [x] Ensure the existing **"Analyse with AI"** action consumes that evidence with
      `prompts/rca.md` on demand — already wired: the RCA context includes
      `Description: ${incident.description}`, which carries Sentinel's evidence.
- [ ] Retire the custom `nova/metrics-collector` + its `url:` config line once
      Sentinel is the detection backbone.

### B4. Tier 2 — Log signals by *anomaly*, not keyword  ✅
- [x] Continuous log tail: the runtime (`lib/sentinel/run.ts`) follows the logs of
      in-scope pods via the Kubernetes log API (one follow-stream per container,
      started on Running, aborted on delete; only new logs via `sinceSeconds` so
      history never opens incidents). `parseLogLine` (`lib/sentinel/logs/parse.ts`)
      normalizes JSON + plain-text lines; `SentinelEngine.onLog` feeds them to the
      analyzer → correlator. `SENTINEL_LOGS=false` disables it; RBAC adds `pods/log`.
- [x] **Log-template clustering** (Drain-style) → **novelty** detection
      (`lib/sentinel/logs/template.ts`): `templatize()` masks variable tokens
      (numbers, UUIDs, IPs, timestamps, hex, quoted strings); `LogTemplateMiner`
      learns per-service templates silently during warm-up, then flags a
      never-seen shape as novel (no `ERROR` keyword required). LRU-bounded.
- [x] **Volume / rate-shift** detection per service (`lib/sentinel/logs/rate.ts`):
      `LogRateMonitor` buckets time per service and flags a bucket whose line
      count (or error count, via the opportunistic `level`) exceeds a rolling
      baseline by a factor — once per bucket, after a warm-up. Folded into
      `LogAnalyzer` as a third soft lens.
- [x] **Generic technical signature library** (`lib/sentinel/logs/signatures.ts`,
      config-extendable via `extraSignatures`): DB (pool exhausted, unavailable,
      deadlock, `SQLSTATE`), network (reset/refused/timeout/DNS/TLS), runtime
      (panic, OOM, segfault, stack overflow, tracebacks), HTTP 5xx (status-context
      only), resource (disk full, throttling). Conservative (precision-first):
      unambiguous fatals are `hard`, the rest `soft`.
- [x] `LogAnalyzer` (`lib/sentinel/logs/analyzer.ts`) turns a log line into the
      same `Signal`s the Correlator consumes (signatures + novelty). Opportunistic
      `level` field is accepted, never required.
- [x] Tests: templatize masking, novelty warm-up/eviction, signature matches
      across formats + false-positive guards, analyzer signals, rate spikes,
      log-line parsing, and engine `onLog` incident creation. 488 tests green.
- [x] Log-tail runtime wiring into the Sentinel engine (env-driven; the typed
      `detection.logs` config block is folded into B6's `detection:` schema).
      Log signal kinds mapped to failure types in `incident.ts`.

### B5. Tier 3 — Domain + business + absence signals  🚧
- [x] Use **Domain Pack** `impactSignal` patterns as declared business signals
      (`lib/sentinel/business/impact.ts` + `signal-match.ts`): `ImpactMonitor`
      counts matches of the declared impact pattern per service per bucket and
      raises a soft `BusinessImpact` signal at `minImpact`, upgraded to hard on a
      severe spike. Wired into `LogAnalyzer` as a fourth lens. `compileMatch`
      reuses the exact `impactSignal.match` shape (level + pattern).
- [x] **Absence/baseline detection** for "checkouts not happening"
      (`lib/sentinel/business/absence.ts`): `AbsenceMonitor` baselines a countable
      **success** signal per service and, on a `tick()` (once per bucket, driven by
      the runtime timer + `SentinelEngine.tick`), flags a hard `SuccessDrop` when a
      completed bucket collapses below `baseline / dropFactor` — guarded by
      `minBaseline`/`minBaselineBuckets` so low-traffic services never false-flag.
- [ ] Optional **AI judgment** for ambiguous/business-semantic clusters (guarded, on
      demand) — reasons over signals that exist; never invents.
- [x] Tests: `compileMatch`, impact thresholds/hard-upgrade/per-bucket, absence
      warm-up/collapse/low-traffic/once-per-bucket, analyzer + engine `tick`
      integration. 508 tests green. `BusinessImpact`/`SuccessDrop` → `latency-slo`.

### B6. Config surface — make `sentinel:` REAL  ✅
- [x] Typed `sentinel:` block (`SentinelConfigSchema` in `lib/config/schema.ts`):
      `enabled`, `dryRun`, `namespaces`, `dedupeWindowSec`, `softConfirmKinds`,
      `sensitivity`, `logs.{enabled,warmupLines,extraSignatures}`,
      `impact.{enabled,pattern,level,minImpact,label}`,
      `absence.{enabled,successPattern,level,minBaseline,dropFactor,label}`.
- [x] zod defaults with `enabled: false` (opt-in, behaviour-neutral); every field
      defaults to today's code behaviour.
- [x] `buildSentinel(cfg)` (`lib/sentinel/config.ts`) — pure mapper config →
      Correlator + LogAnalyzer (impact/absence monitors, compiled extra signatures,
      sensitivity → rate spike factor). `loadSentinelConfig()` reads the block
      standalone (no server-only) so the companion consumes the same file.
- [x] Runtime consumes the config (`run.ts`), with a few env overrides retained;
      Helm mounts the shared `nova.config.yaml` into the Sentinel pod.
- [x] Example yaml (`nova.config.example.yaml`) + defaults/loader tests
      (`lib/sentinel/config.test.ts`).

### B7. Dashboard surfacing  🚧
- [x] Provenance persisted end-to-end: `IncidentRecord.detectedBy` +
      `CreateIncidentInput.detectedBy`; the `/api/alerts` route captures the alert
      `source` label (`nova-sentinel`) and the store persists it.
- [x] Clear provenance badge (`components/dashboard/nova-badge.tsx`) rendered on the
      overview widget, the incidents list (active + resolved) and the incident
      detail header — distinguishing `detected by Nova` from external/inject paths.
- [x] Sentinel evidence (the signal list + confidence "why flagged" summary) already
      rides in the incident description that the detail page renders.
- [x] Tests: store persists/round-trips `detectedBy`; absent for external paths.
- [ ] Optional: a dedicated signal **timeline** panel on incident detail (structured
      evidence beyond the description).

### B8. Production safety  ✅
- [x] **Storm control / backpressure** (`SentinelEngine`): a global cap on NEW
      incidents per window (`maxIncidentsPerMin`, sliding-window token accounting)
      sheds a cluster-wide meltdown instead of opening thousands of incidents.
- [x] **Per-service mute** (`mute: []`): drop signals for noisy services (load
      generators, batch jobs) before correlation.
- [x] **Startup grace** (`startupGraceSec`): suppress emission for N seconds after
      start (still learns baselines + de-dups) so the initial informer sync of
      pre-existing state can't storm.
- [x] Read-only RBAC + resource limits (Helm) already in place; dry-run mode.
- [x] Config surface (`mute`/`maxIncidentsPerMin`/`startupGraceSec`) + example yaml;
      tests: mute, storm cap + window refill, startup grace. 521 tests green.
- [x] **Log-tail resilience + scale**: streams auto-restart on error (no thrash);
      a bounded, priority-aware `TailScheduler` (`lib/sentinel/log-scheduler.ts`)
      caps concurrent follow-streams (`logs.maxConcurrentTails`) and tails
      already-unhealthy pods first — fixes the E2E-found silent stream-exhaustion.
      Verified live (business-impact incident now fires). 528 tests.
- [x] **Dry-run/status surfaced in the dashboard UI**: the companion posts a
      liveness heartbeat (`/api/sentinel/status`) every 30s; the topbar shows a
      Sentinel `ACTIVE` / `DRY-RUN` / `OFFLINE` indicator (`sentinel-status.tsx`,
      `lib/sentinel/status.ts`). Hidden when Sentinel never checked in. 532 tests.

### Carry-overs
- [x] **"Analyse with AI" consumes Sentinel evidence** — already wired: the RCA
      context includes `Description: ${incident.description}`, and Sentinel writes
      its full evidence (signal list + confidence "why flagged") into that
      description. Verified in `rca-document-modal.tsx`.
- [ ] **Retire the custom metrics-collector** — larger, riskier refactor (it also
      serves the RCA's real logs via `fetchCollectorLogs`); needs its own effort to
      move metrics to the `lib/metrics` adapter + logs to a backend. Deferred.

### E2E validation (kind `nova-platform`, otel-demo)  ✅ / findings
- [x] Config-driven deploy (mounted `nova.config.yaml`): `impact=true`, `mute`, cap
      all read from the `sentinel:` block.
- [x] k8s hard signal → incident (ImagePullBackOff).
- [x] Log-signature → incident (`panic:` → `Log:Panic`).
- [x] **Mute works**: a crashing `load-generator` pod opened **no** incident.
- [x] Storm/grace guards active; a fresh pod's log line is detected (tail restart OK).
- [ ] **Known limitation found**: per-pod log follow-streams are bounded by the
      client/apiserver concurrent-stream limit, so in a busy namespace (30+ pods)
      some pods aren't tailed → log-anomaly/business-impact/absence can be missed
      for those pods. Engines are unit-tested & correct; this is a tailing-transport
      scale gap. **Follow-up**: bounded/rotating tails or a log-backend tail path.
- [ ] **Provenance badge** needs the dashboard image rebuilt with B7 (the running
      dashboard predates B7, so `detectedBy` came back empty end-to-end).

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
