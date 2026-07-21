import type {
  IncidentRecord,
  FailureType,
  IncidentSeverity,
  TimelineEntry,
  RelatedLog,
} from "./incident-types"
import { buildDetailedRca, type RcaParts } from "./incident-rca"

// ── Time helpers ──────────────────────────────────────────────────────────────
const MIN = 60_000
const DAY = 86_400_000

function pad(n: number): string {
  return n.toString().padStart(2, "0")
}
function clock(base: number, addMin: number): string {
  const d = new Date(base + addMin * MIN)
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
}
function iso(base: number, addSec: number): string {
  return new Date(base + addSec * 1000).toISOString()
}
function tl(
  start: number,
  steps: Array<[number, string, TimelineEntry["type"]]>
): TimelineEntry[] {
  return steps.map(([m, event, type]) => ({ time: clock(start, m), event, type }))
}
function lg(start: number, lines: Array<[number, string, string]>): RelatedLog[] {
  return lines.map(([s, level, message]) => ({ timestamp: iso(start, s), level, message }))
}

// ── RCA content (structured) — composed into a full document at seed time ──────
// rcaDoc is an identity helper so each template declares its RCA inputs inline;
// buildDetailedRca (lib/incident-rca) turns these into the full report.
function rcaDoc(opts: RcaParts): RcaParts {
  return opts
}

interface Template {
  defaultSeverity: IncidentSeverity
  forceService?: string
  title: (svc: string) => string
  description: (svc: string) => string
  timeline: (svc: string, start: number) => TimelineEntry[]
  logs: (svc: string, start: number) => RelatedLog[]
  rca: (svc: string) => RcaParts
}

// ── Failure-type templates ────────────────────────────────────────────────────
export const TEMPLATES: Record<FailureType, Template> = {
  OOMKilled: {
    defaultSeverity: "high",
    title: (s) => `${s} pods OOMKilled under sustained load`,
    description: (s) =>
      `${s} pods breached their memory limit and were OOMKilled by the kubelet, causing repeated restarts and dropped in-flight requests. Working set grew past the container limit during peak traffic.`,
    timeline: (s, t) =>
      tl(t, [
        [0, `Memory usage on ${s} crosses 85% of limit`, "warning"],
        [4, `First container OOMKilled — pod restart observed`, "error"],
        [6, `Alert fired — 3 restarts in 5 minutes`, "info"],
        [12, `On-call raised memory limit + reduced batch size`, "info"],
        [24, `Working set stabilised below limit`, "success"],
      ]),
    logs: (s, t) =>
      lg(t, [
        [0, "WARN", `[${s}] container memory 486Mi / 512Mi limit (95%)`],
        [180, "ERROR", `[${s}] OOMKilled — exit code 137, restarting container`],
        [240, "ERROR", `[${s}] readiness probe failed: connection refused (restarting)`],
        [900, "INFO", `[${s}] memory limit raised to 1Gi, working set 612Mi`],
      ]),
    rca: (s) =>
      rcaDoc({
        cause: `The \`${s}\` container's resident set grew beyond its 512Mi memory limit during peak traffic (large response buffering + an unbounded in-memory cache), so the kernel OOM killer (exit 137) reaped it repeatedly.`,
        blast: `Rolling 5xx and dropped requests on \`${s}\` while pods restarted; brief elevated latency on dependents.`,
        remediation: [
          "Raised the memory limit from 512Mi to 1Gi to add headroom",
          "Capped the in-memory response cache and enabled streaming for large payloads",
          "Restarted the deployment to clear leaked buffers",
        ],
        prevention: [
          "Add a memory-based HPA and a PodDisruptionBudget",
          "Load-test with realistic payload sizes before release",
          "Alert on memory > 80% of limit, not only on OOMKilled",
        ],
        confidence: "High (94%) — OOMKilled events correlate directly with the traffic peak and memory saturation.",
      }),
  },

  CrashLoopBackOff: {
    defaultSeverity: "critical",
    title: (s) => `${s} stuck in CrashLoopBackOff after restart`,
    description: (s) =>
      `${s} entered CrashLoopBackOff — the container exits on startup and the kubelet backs off exponentially between restarts. No healthy replicas were available during the window.`,
    timeline: (s, t) =>
      tl(t, [
        [0, `${s} pod exits 1 on startup`, "error"],
        [2, `kubelet backoff — CrashLoopBackOff reported`, "error"],
        [5, `Alert fired — 0/3 replicas ready`, "info"],
        [14, `Root cause found in startup config, hotfix applied`, "info"],
        [21, `Pods pass readiness, traffic restored`, "success"],
      ]),
    logs: (s, t) =>
      lg(t, [
        [0, "ERROR", `[${s}] Error: startup validation failed — exiting`],
        [30, "WARN", `[${s}] Back-off restarting failed container (restartCount=4)`],
        [60, "ERROR", `[${s}] CrashLoopBackOff: last state Terminated (exit code 1)`],
        [800, "INFO", `[${s}] startup succeeded, readiness probe passing`],
      ]),
    rca: (s) =>
      rcaDoc({
        cause: `A malformed environment value caused \`${s}\` to throw during boot and exit 1, so the kubelet placed it in CrashLoopBackOff with exponential backoff. No replica ever reached readiness.`,
        blast: `Full outage of \`${s}\` for the window — 0/3 replicas ready; dependents saw connection-refused errors.`,
        remediation: [
          "Corrected the bad startup value and redeployed",
          "Rolled forward once one replica passed readiness",
        ],
        prevention: [
          "Validate config at build time and in a startup smoke test",
          "Gate rollouts behind a canary that must pass readiness first",
        ],
        confidence: "High (96%) — crash stack trace names the exact config key.",
      }),
  },

  ImagePullBackOff: {
    defaultSeverity: "high",
    title: (s) => `${s} rollout blocked by ImagePullBackOff`,
    description: (s) =>
      `New ${s} pods could not pull their container image (bad tag / registry auth), leaving the rollout stuck with unavailable replicas while the old ones drained.`,
    timeline: (s, t) =>
      tl(t, [
        [0, `${s} deploy references image tag that does not exist`, "error"],
        [2, `ErrImagePull → ImagePullBackOff on new pods`, "error"],
        [6, `Alert fired — rollout progress deadline exceeded`, "info"],
        [11, `Corrected image tag pushed and applied`, "info"],
        [16, `New pods pulled and became ready`, "success"],
      ]),
    logs: (s, t) =>
      lg(t, [
        [0, "ERROR", `[${s}] Failed to pull image "registry/${s}:v4.2.9": not found`],
        [45, "WARN", `[${s}] Back-off pulling image — ImagePullBackOff`],
        [700, "INFO", `[${s}] Successfully pulled image "registry/${s}:v4.2.10"`],
      ]),
    rca: (s) =>
      rcaDoc({
        cause: `The \`${s}\` Deployment referenced an image tag (\`v4.2.9\`) that was never pushed to the registry, so new pods failed \`ErrImagePull\` and backed off. The rollout stalled at the progress deadline.`,
        blast: `Degraded capacity on \`${s}\` (old replicas kept serving) until the rollout was corrected — no full outage.`,
        remediation: [
          "Pushed the correct image tag and re-applied the deployment",
          "Verified pull succeeded before scaling up",
        ],
        prevention: [
          "Fail CI if the built image tag is not present in the registry",
          "Use immutable digests instead of mutable tags in manifests",
        ],
        confidence: "High (98%) — the referenced tag is absent from the registry.",
      }),
  },

  network: {
    defaultSeverity: "high",
    forceService: "api-gateway",
    title: (s) => `DNS resolution failures degrade ${s}`,
    description: (s) =>
      `${s} experienced intermittent DNS resolution failures and connection timeouts to upstream services, driving a spike in 5xx as CoreDNS struggled under query load.`,
    timeline: (s, t) =>
      tl(t, [
        [0, `Upstream lookups from ${s} begin timing out`, "warning"],
        [3, `CoreDNS query latency > 2s, SERVFAIL rate climbing`, "error"],
        [7, `Alert fired — 5xx spike on ${s}`, "info"],
        [15, `CoreDNS scaled up + cache TTL raised`, "info"],
        [26, `Resolution latency back to baseline`, "success"],
      ]),
    logs: (s, t) =>
      lg(t, [
        [0, "WARN", `[${s}] getaddrinfo EAI_AGAIN payment-service: lookup timed out`],
        [40, "ERROR", `[${s}] upstream connect error: DNS resolution failed (SERVFAIL)`],
        [120, "ERROR", `[${s}] 502 Bad Gateway — no healthy upstream`],
        [900, "INFO", `[${s}] upstream resolution recovered, error rate normal`],
      ]),
    rca: (s) =>
      rcaDoc({
        cause: `CoreDNS was under-provisioned for the cluster's query volume; under a traffic burst its latency exceeded the resolver timeout, so \`${s}\` saw \`EAI_AGAIN\`/SERVFAIL and returned 502s.`,
        blast: `Intermittent 5xx across all traffic transiting \`${s}\` for the duration of the DNS degradation.`,
        remediation: [
          "Scaled CoreDNS replicas and enabled NodeLocal DNSCache",
          "Raised negative/positive cache TTLs to cut query volume",
        ],
        prevention: [
          "Autoscale CoreDNS on query rate",
          "Add client-side DNS caching and sensible resolver timeouts",
        ],
        confidence: "High (91%) — SERVFAIL rate tracks CoreDNS latency exactly.",
      }),
  },

  "secret-missing": {
    defaultSeverity: "critical",
    title: (s) => `${s} fails to start — required secret not found`,
    description: (s) =>
      `${s} pods failed to start because a referenced Secret was missing after a namespace change, so the container could not mount the credentials and crashed on boot.`,
    timeline: (s, t) =>
      tl(t, [
        [0, `${s} pod scheduled, secret volume mount fails`, "error"],
        [2, `CreateContainerConfigError — secret "app-credentials" not found`, "error"],
        [6, `Alert fired — ${s} 0 replicas available`, "info"],
        [13, `Missing secret re-created from vault`, "info"],
        [18, `Pods mounted secret and started`, "success"],
      ]),
    logs: (s, t) =>
      lg(t, [
        [0, "ERROR", `[${s}] MountVolume.SetUp failed: secret "app-credentials" not found`],
        [30, "ERROR", `[${s}] CreateContainerConfigError`],
        [700, "INFO", `[${s}] secret mounted, credentials loaded`],
      ]),
    rca: (s) =>
      rcaDoc({
        cause: `The \`${s}\` Deployment referenced the \`app-credentials\` Secret, which was not present in the target namespace (it was not migrated with the workload), so pods failed with \`CreateContainerConfigError\` and never started.`,
        blast: `Full outage of \`${s}\` until the Secret was restored — no replicas could mount credentials.`,
        remediation: [
          "Re-created the Secret from the source of truth (vault)",
          "Restarted the deployment to pick up the mount",
        ],
        prevention: [
          "Manage Secrets declaratively with the workload (GitOps / sealed-secrets)",
          "Add a pre-deploy check that all referenced Secrets exist",
        ],
        confidence: "High (97%) — the mount error names the missing Secret.",
      }),
  },

  "config-missing": {
    defaultSeverity: "high",
    forceService: "config-service",
    title: (s) => `${s} boot failure — ConfigMap key missing`,
    description: (s) =>
      `${s} crashed on startup after a ConfigMap change removed a required key, leaving the app unable to read a mandatory setting.`,
    timeline: (s, t) =>
      tl(t, [
        [0, `${s} reads config, required key absent`, "error"],
        [2, `Startup throws "missing required config: FEATURE_FLAGS_URL"`, "error"],
        [7, `Alert fired — CrashLoop on ${s}`, "info"],
        [12, `ConfigMap key restored`, "info"],
        [17, `Pods healthy`, "success"],
      ]),
    logs: (s, t) =>
      lg(t, [
        [0, "ERROR", `[${s}] Missing required config key: FEATURE_FLAGS_URL`],
        [30, "ERROR", `[${s}] process exited with code 1`],
        [600, "INFO", `[${s}] config loaded, all required keys present`],
      ]),
    rca: (s) =>
      rcaDoc({
        cause: `A ConfigMap edit removed the \`FEATURE_FLAGS_URL\` key that \`${s}\` requires at boot; the app validates config on startup and exited 1 when the key was absent.`,
        blast: `\`${s}\` crash-looped and served no traffic until the key was restored.`,
        remediation: ["Restored the ConfigMap key and rolled the deployment"],
        prevention: [
          "Schema-validate ConfigMaps in CI",
          "Provide safe defaults for non-secret config",
        ],
        confidence: "High (95%) — startup log names the missing key.",
      }),
  },

  "replica-exhaustion": {
    defaultSeverity: "high",
    title: (s) => `${s} saturated — HPA at max replicas`,
    description: (s) =>
      `${s} hit its HPA ceiling under a traffic surge; with no headroom left, queueing drove latency and error rates up until the ceiling was raised.`,
    timeline: (s, t) =>
      tl(t, [
        [0, `${s} traffic surges, HPA scales toward max`, "warning"],
        [5, `HPA at maxReplicas — desired > max, cannot scale further`, "error"],
        [9, `Alert fired — latency > SLO, request queue growing`, "info"],
        [16, `maxReplicas raised + surge capacity added`, "info"],
        [30, `Queue drained, latency normal`, "success"],
      ]),
    logs: (s, t) =>
      lg(t, [
        [0, "WARN", `[${s}] HPA desiredReplicas=20 capped at maxReplicas=20`],
        [60, "ERROR", `[${s}] request queue depth 512 — shedding load (429)`],
        [900, "INFO", `[${s}] maxReplicas raised to 32, queue draining`],
      ]),
    rca: (s) =>
      rcaDoc({
        cause: `Traffic to \`${s}\` exceeded what its HPA ceiling (\`maxReplicas=20\`) could serve; with no scale headroom, requests queued and the service shed load with 429s and elevated latency.`,
        blast: `Elevated latency and partial load-shedding on \`${s}\` during peak until capacity was raised.`,
        remediation: [
          "Raised maxReplicas and pre-warmed surge capacity",
          "Tuned HPA target utilisation lower for faster reaction",
        ],
        prevention: [
          "Size HPA ceilings against forecast peak + margin",
          "Add scheduled scale-ups ahead of known traffic events",
        ],
        confidence: "High (90%) — desiredReplicas pinned at max throughout.",
      }),
  },

  "node-cpu-insufficient": {
    defaultSeverity: "high",
    title: (s) => `${s} pods Pending — insufficient node CPU`,
    description: (s) =>
      `New ${s} pods stayed Pending because no node had enough allocatable CPU to satisfy their requests, blocking the scale-up during peak demand.`,
    timeline: (s, t) =>
      tl(t, [
        [0, `${s} scale-up requested, pods Pending`, "warning"],
        [3, `FailedScheduling: 0/3 nodes have sufficient cpu`, "error"],
        [8, `Alert fired — desired replicas unschedulable`, "info"],
        [18, `Node pool scaled out / requests right-sized`, "info"],
        [29, `Pods scheduled and ready`, "success"],
      ]),
    logs: (s, t) =>
      lg(t, [
        [0, "WARN", `[scheduler] ${s}: 0/3 nodes available: insufficient cpu`],
        [60, "ERROR", `[${s}] pod Pending for 5m — FailedScheduling`],
        [1000, "INFO", `[scheduler] ${s} scheduled onto node worker-4`],
      ]),
    rca: (s) =>
      rcaDoc({
        cause: `\`${s}\`'s CPU requests plus existing reservations exceeded allocatable CPU on every node, so the scheduler left new pods \`Pending\` (\`insufficient cpu\`) and the scale-up never completed.`,
        blast: `\`${s}\` could not add capacity during peak — degraded throughput, no full outage.`,
        remediation: [
          "Scaled out the node pool to add allocatable CPU",
          "Right-sized over-inflated CPU requests",
        ],
        prevention: [
          "Enable cluster-autoscaler with headroom",
          "Review requests/limits against real usage quarterly",
        ],
        confidence: "High (93%) — FailedScheduling cites insufficient cpu.",
      }),
  },

  "disk-pressure": {
    defaultSeverity: "medium",
    title: (s) => `Node DiskPressure evicts ${s} pods`,
    description: (s) =>
      `A node hit the DiskPressure eviction threshold (log/image growth), and the kubelet evicted ${s} pods to reclaim space, causing restarts and rescheduling churn.`,
    timeline: (s, t) =>
      tl(t, [
        [0, `Node ephemeral storage crosses eviction threshold`, "warning"],
        [3, `kubelet taints node with DiskPressure`, "error"],
        [6, `${s} pods evicted and rescheduled`, "error"],
        [14, `Disk reclaimed (log rotation + image GC)`, "info"],
        [24, `Node healthy, pods stable`, "success"],
      ]),
    logs: (s, t) =>
      lg(t, [
        [0, "WARN", `[kubelet] node worker-2 ephemeral-storage 92% — DiskPressure`],
        [60, "ERROR", `[${s}] pod evicted: The node was low on resource: ephemeral-storage`],
        [800, "INFO", `[kubelet] DiskPressure cleared, node schedulable`],
      ]),
    rca: (s) =>
      rcaDoc({
        cause: `Unrotated container logs and stale images filled the node's ephemeral storage past the eviction threshold; the kubelet raised \`DiskPressure\` and evicted \`${s}\` pods to reclaim space.`,
        blast: `Restart churn and brief unavailability of evicted \`${s}\` replicas.`,
        remediation: [
          "Ran image garbage collection and enforced log rotation",
          "Rescheduled evicted pods onto healthy nodes",
        ],
        prevention: [
          "Set container log size/rotation limits",
          "Alert on node ephemeral-storage > 80%",
        ],
        confidence: "Medium (86%) — eviction reason cites ephemeral-storage.",
      }),
  },

  "pvc-full": {
    defaultSeverity: "high",
    forceService: "postgres",
    title: (s) => `${s} writes fail — PersistentVolume full`,
    description: (s) =>
      `${s} ran out of space on its PersistentVolume; writes began failing with "No space left on device" until the volume was expanded.`,
    timeline: (s, t) =>
      tl(t, [
        [0, `${s} PVC usage crosses 95%`, "warning"],
        [4, `Writes fail: No space left on device`, "error"],
        [8, `Alert fired — ${s} write errors`, "info"],
        [17, `PVC expanded, WAL/temp cleaned`, "info"],
        [27, `Writes succeeding, replication caught up`, "success"],
      ]),
    logs: (s, t) =>
      lg(t, [
        [0, "WARN", `[${s}] data volume 96% full`],
        [60, "ERROR", `[${s}] could not write to file: No space left on device`],
        [900, "INFO", `[${s}] volume resized to 100Gi, writes recovered`],
      ]),
    rca: (s) =>
      rcaDoc({
        cause: `\`${s}\`'s PersistentVolume filled up (WAL + temp growth with no headroom), so writes failed with \`No space left on device\` until the PVC was expanded.`,
        blast: `Write failures on \`${s}\` and stalled replication during the window.`,
        remediation: [
          "Expanded the PVC (volume expansion) and cleaned WAL/temp",
          "Restarted stuck writers once space was available",
        ],
        prevention: [
          "Alert on PVC usage > 80% with auto-expansion where supported",
          "Cap WAL retention and archive proactively",
        ],
        confidence: "High (95%) — write errors cite ENOSPC directly.",
      }),
  },

  "tls-cert-expiry": {
    defaultSeverity: "critical",
    forceService: "api-gateway",
    title: (s) => `Expired TLS certificate breaks ${s}`,
    description: (s) =>
      `The TLS certificate served by ${s} expired, so clients rejected the handshake with certificate errors until the cert was renewed and reloaded.`,
    timeline: (s, t) =>
      tl(t, [
        [0, `Certificate for *.novadeploy.io reaches notAfter`, "error"],
        [1, `Clients fail handshake: certificate has expired`, "error"],
        [5, `Alert fired — TLS error rate 100%`, "info"],
        [12, `Renewed cert issued and hot-reloaded`, "info"],
        [15, `Handshakes succeeding`, "success"],
      ]),
    logs: (s, t) =>
      lg(t, [
        [0, "ERROR", `[${s}] TLS handshake error: certificate has expired`],
        [60, "ERROR", `[${s}] 525 SSL handshake failed for *.novadeploy.io`],
        [700, "INFO", `[${s}] new certificate loaded, expires in 90d`],
      ]),
    rca: (s) =>
      rcaDoc({
        cause: `The wildcard TLS certificate presented by \`${s}\` passed its \`notAfter\` date because auto-renewal had silently failed weeks earlier; every client handshake then failed with "certificate has expired".`,
        blast: `Total TLS failure for all HTTPS traffic through \`${s}\` until renewal.`,
        remediation: [
          "Issued and hot-reloaded a fresh certificate",
          "Fixed the broken cert-manager renewal hook",
        ],
        prevention: [
          "Alert on certificate expiry > 21 days out",
          "Monitor cert-manager renewal success, not just presence",
        ],
        confidence: "High (99%) — handshake errors cite expiry with exact notAfter.",
      }),
  },

  "db-pool-exhaustion": {
    defaultSeverity: "critical",
    forceService: "payment-service",
    title: (s) => `${s} 5xx — Postgres connection pool exhausted`,
    description: (s) =>
      `${s}'s Postgres connection pool was exhausted under sustained checkout load; pool.connect() timed out and /api/checkout returned 503s until replicas were scaled and load shed.`,
    timeline: (s, t) =>
      tl(t, [
        [0, `Checkout traffic surges against ${s}`, "info"],
        [4, `Pool utilisation crosses 90%`, "warning"],
        [7, `First 503s — pool.connect() timeout`, "error"],
        [12, `Scaled ${s} to 6 replicas, stopped load`, "info"],
        [21, `Error rate back to baseline`, "success"],
      ]),
    logs: (s, t) =>
      lg(t, [
        [0, "INFO", `[${s}] checkout traffic surging — sustained load from load-generator (k6)`],
        [30, "WARN", `[${s}] pool.waitQueueSize rising, max 2 connections per pod`],
        [240, "WARN", `[${s}] Postgres connection pool utilisation 90% — waitQueue growing`],
        [420, "ERROR", `[${s}] Connection pool exhausted: pool.connect() timeout after 1000ms`],
        [430, "ERROR", `[${s}] FATAL: too many connections for role "payment_svc" (max_connections=5)`],
        [450, "ERROR", `[${s}] POST /api/checkout — 503 Service Unavailable (connection pool exhausted)`],
        [600, "ERROR", `[${s}] circuit breaker did not trip before pool exhaustion — requests queued`],
        [720, "INFO", `[${s}] scaled to 6 replicas, load-generator stopped — connection headroom restored`],
        [1260, "INFO", `[${s}] error rate back to baseline; correlation confidence 94% (pool timeouts match load run)`],
      ]),
    rca: (s) =>
      rcaDoc({
        cause: `\`${s}\`'s per-pod Postgres connection pool (max 2) was exhausted under sustained checkout load against a Postgres capped at \`max_connections=5\`; \`pool.connect()\` timed out and \`/api/checkout\` returned 503s.`,
        blast: `Elevated 5xx on checkout affecting paying users for the incident window.`,
        remediation: [
          "Scaled payment-service to 6 replicas and stopped the load generator",
          "Restored healthy connection headroom",
        ],
        prevention: [
          "Front Postgres with PgBouncer / raise per-pod pool size",
          "Tune the circuit breaker to shed load before pool exhaustion",
        ],
        confidence: "High (94%) — pool timeouts correlate with the load run.",
      }),
  },

  deadlock: {
    defaultSeverity: "high",
    forceService: "transaction-service",
    title: (s) => `${s} latency from database lock contention`,
    description: (s) =>
      `${s} suffered lock contention / deadlocks on a hot row, holding transactions and driving p95 latency far above SLO until the query path was serialised differently.`,
    timeline: (s, t) =>
      tl(t, [
        [0, `${s} p95 latency crosses SLO`, "warning"],
        [4, `Deadlock detected — transactions rolled back`, "error"],
        [8, `Alert fired — request timeouts climbing`, "info"],
        [15, `Query reordered + lock scope reduced`, "info"],
        [27, `Latency back to baseline`, "success"],
      ]),
    logs: (s, t) =>
      lg(t, [
        [0, "WARN", `[${s}] p95 latency 940ms exceeds SLO (500ms)`],
        [45, "ERROR", `[${s}] deadlock detected; Process 4412 waits for ShareLock`],
        [900, "INFO", `[${s}] lock contention cleared, latency normal`],
      ]),
    rca: (s) =>
      rcaDoc({
        cause: `Concurrent transactions in \`${s}\` acquired row locks in inconsistent order on a hot row, producing deadlocks and rollbacks; retries piled up and pushed p95 latency past SLO.`,
        blast: `Elevated latency and transaction retries on \`${s}\` during the window.`,
        remediation: [
          "Serialised the conflicting update path and reduced lock scope",
          "Added bounded retry with backoff",
        ],
        prevention: [
          "Acquire locks in a consistent order",
          "Add deadlock/lock-wait dashboards and alerts",
        ],
        confidence: "High (89%) — deadlock log entries align with latency spikes.",
      }),
  },

  "memory-leak": {
    defaultSeverity: "medium",
    title: (s) => `Gradual memory leak degrades ${s}`,
    description: (s) =>
      `${s} exhibited a slow memory leak; working set climbed over hours until GC pressure raised latency and pods eventually restarted. A recent build introduced an unbounded cache.`,
    timeline: (s, t) =>
      tl(t, [
        [0, `${s} heap trending up steadily over hours`, "info"],
        [30, `GC pause frequency rising, latency creeping`, "warning"],
        [55, `First pod approaches memory limit`, "error"],
        [70, `Rolled back leaking build`, "info"],
        [95, `Heap flat, latency normal`, "success"],
      ]),
    logs: (s, t) =>
      lg(t, [
        [0, "INFO", `[${s}] heap 210Mi and rising`],
        [1800, "WARN", `[${s}] GC pause 180ms (frequent) — heap 430Mi`],
        [3000, "ERROR", `[${s}] heap 500Mi approaching limit, restarting soon`],
        [4500, "INFO", `[${s}] rolled back v3.7.2, heap stable at 220Mi`],
      ]),
    rca: (s) =>
      rcaDoc({
        cause: `Build \`v3.7.2\` of \`${s}\` added an unbounded in-memory cache that never evicted; the heap grew steadily until GC pressure raised latency and pods neared their memory limit.`,
        blast: `Slow latency degradation on \`${s}\` over hours, ending in restarts.`,
        remediation: [
          "Rolled back to the previous build",
          "Restarted pods to reclaim leaked memory",
        ],
        prevention: [
          "Bound cache size with an eviction policy",
          "Add heap-growth alerting and soak tests in CI",
        ],
        confidence: "Medium (85%) — leak onset matches the v3.7.2 deploy.",
      }),
  },

  "bad-deploy": {
    defaultSeverity: "critical",
    title: (s) => `${s} regression after bad deploy`,
    description: (s) =>
      `A new ${s} release introduced a regression that spiked errors immediately after rollout; the deploy was rolled back once the correlation was confirmed.`,
    timeline: (s, t) =>
      tl(t, [
        [0, `${s} vNext rollout begins`, "info"],
        [3, `Error rate spikes right after new pods take traffic`, "error"],
        [7, `Alert fired — deploy-correlated regression`, "info"],
        [11, `Rollback to previous version initiated`, "info"],
        [18, `Errors back to baseline on old version`, "success"],
      ]),
    logs: (s, t) =>
      lg(t, [
        [0, "INFO", `[${s}] rollout v5.3.0 — 50% traffic shifted`],
        [60, "ERROR", `[${s}] TypeError: cannot read property 'id' of undefined`],
        [120, "ERROR", `[${s}] 500 Internal Server Error rate 12%`],
        [800, "INFO", `[${s}] rolled back to v5.2.4, error rate 0.1%`],
      ]),
    rca: (s) =>
      rcaDoc({
        cause: `Release \`v5.3.0\` of \`${s}\` shipped a null-handling regression that threw on a common request shape; errors spiked the moment new pods took traffic.`,
        blast: `Elevated 5xx on \`${s}\` from rollout start until rollback.`,
        remediation: ["Rolled back to v5.2.4", "Held the fix for a patched re-release"],
        prevention: [
          "Canary new releases with automated error-rate gates",
          "Add a regression test for the failing request shape",
        ],
        confidence: "High (97%) — error spike aligns exactly with the rollout.",
      }),
  },

  "rate-limit": {
    defaultSeverity: "medium",
    forceService: "api-gateway",
    title: (s) => `${s} throttling legit traffic (429 storm)`,
    description: (s) =>
      `A misconfigured rate-limit on ${s} throttled legitimate clients with 429s after a limit was lowered by mistake, cutting successful throughput.`,
    timeline: (s, t) =>
      tl(t, [
        [0, `Rate-limit config lowered in a routine change`, "info"],
        [3, `429 rate climbs sharply for valid clients`, "error"],
        [8, `Alert fired — success rate dropping`, "info"],
        [13, `Limit restored to correct value`, "info"],
        [19, `429s back to baseline`, "success"],
      ]),
    logs: (s, t) =>
      lg(t, [
        [0, "WARN", `[${s}] rate limit 100/min applied (was 1000/min)`],
        [60, "ERROR", `[${s}] 429 Too Many Requests — client c-8821 (valid)`],
        [700, "INFO", `[${s}] rate limit reverted to 1000/min`],
      ]),
    rca: (s) =>
      rcaDoc({
        cause: `A config change on \`${s}\` set the per-client rate limit 10x too low (100/min vs 1000/min), so legitimate clients were throttled with 429s and success throughput dropped.`,
        blast: `Reduced successful throughput on \`${s}\` for valid clients during the window.`,
        remediation: ["Reverted the limit to the correct value"],
        prevention: [
          "Require review + staged rollout for rate-limit changes",
          "Alert on 429 rate for authenticated traffic",
        ],
        confidence: "High (96%) — 429 onset matches the config change.",
      }),
  },

  "latency-slo": {
    defaultSeverity: "high",
    forceService: "auth-service",
    title: (s) => `${s} P95 latency breaches SLO`,
    description: (s) =>
      `${s} P95 latency spiked well above its SLO due to a slow downstream dependency, holding requests and risking cascading timeouts until the dependency recovered.`,
    timeline: (s, t) =>
      tl(t, [
        [0, `${s} P95 crosses 500ms SLO`, "warning"],
        [4, `Downstream dependency latency identified`, "error"],
        [9, `Alert fired — timeout rate rising`, "info"],
        [15, `Timeouts tightened + dependency scaled`, "info"],
        [28, `P95 back under SLO`, "success"],
      ]),
    logs: (s, t) =>
      lg(t, [
        [0, "WARN", `[${s}] P95 latency 892ms exceeds SLO (500ms)`],
        [60, "ERROR", `[${s}] downstream call timed out after 3000ms`],
        [900, "INFO", `[${s}] P95 latency 180ms — recovered`],
      ]),
    rca: (s) =>
      rcaDoc({
        cause: `A slow downstream dependency inflated \`${s}\`'s call latency; with generous timeouts, requests piled up and P95 breached the 500ms SLO.`,
        blast: `Elevated latency on \`${s}\` and risk of cascading timeouts during the window.`,
        remediation: [
          "Scaled the slow dependency and tightened client timeouts",
          "Added a fallback path for the slow call",
        ],
        prevention: [
          "Set aggressive timeouts + circuit breakers on dependencies",
          "Alert on P95 SLO burn rate",
        ],
        confidence: "High (90%) — latency tracks the downstream dependency.",
      }),
  },

  "cache-eviction": {
    defaultSeverity: "medium",
    forceService: "cache-layer",
    title: (s) => `${s} eviction storm raises miss rate`,
    description: (s) =>
      `${s} hit a memory ceiling and entered an eviction storm; the cache miss rate jumped past threshold, pushing extra load onto backing stores.`,
    timeline: (s, t) =>
      tl(t, [
        [0, `${s} memory reaches maxmemory`, "warning"],
        [3, `Eviction rate spikes, miss rate crosses threshold`, "error"],
        [8, `Alert fired — downstream load rising`, "info"],
        [14, `maxmemory raised + TTLs tuned`, "info"],
        [24, `Miss rate back under threshold`, "success"],
      ]),
    logs: (s, t) =>
      lg(t, [
        [0, "WARN", `[${s}] memory 5.9GB / 6GB — allkeys-lru evictions rising`],
        [60, "ERROR", `[${s}] cache miss rate 41% exceeds threshold (15%)`],
        [800, "INFO", `[${s}] maxmemory raised to 10GB, miss rate 9%`],
      ]),
    rca: (s) =>
      rcaDoc({
        cause: `\`${s}\` reached its \`maxmemory\` ceiling and the LRU policy evicted hot keys en masse; the miss rate spiked and pushed extra read load onto backing stores.`,
        blast: `Elevated backend load and downstream latency while the miss rate was high.`,
        remediation: [
          "Raised maxmemory and tuned key TTLs",
          "Sharded the hottest keyspace",
        ],
        prevention: [
          "Right-size cache memory to the working set",
          "Alert on eviction rate and miss ratio",
        ],
        confidence: "Medium (87%) — miss-rate spike tracks eviction storm.",
      }),
  },

  "probe-failure": {
    defaultSeverity: "high",
    title: (s) => `${s} pods flapping — readiness probe failures`,
    description: (s) =>
      `${s} readiness probes intermittently failed under load (probe timeout too tight), so Kubernetes yanked pods out of rotation and back, causing capacity flapping.`,
    timeline: (s, t) =>
      tl(t, [
        [0, `${s} readiness probes start timing out under load`, "warning"],
        [3, `Pods flap Ready↔NotReady, endpoints churn`, "error"],
        [8, `Alert fired — available replicas oscillating`, "info"],
        [14, `Probe timeout/threshold relaxed`, "info"],
        [23, `Pods stable in rotation`, "success"],
      ]),
    logs: (s, t) =>
      lg(t, [
        [0, "WARN", `[${s}] Readiness probe failed: timeout (1s) exceeded`],
        [60, "ERROR", `[${s}] pod removed from endpoints — NotReady`],
        [800, "INFO", `[${s}] probe timeout raised to 3s, pods stable`],
      ]),
    rca: (s) =>
      rcaDoc({
        cause: `\`${s}\`'s readiness probe timeout (1s) was too tight for the app's response time under load, so probes failed intermittently and Kubernetes flapped pods in and out of the Service endpoints.`,
        blast: `Oscillating capacity and intermittent errors on \`${s}\` during load.`,
        remediation: [
          "Relaxed probe timeout and failureThreshold",
          "Separated liveness from readiness semantics",
        ],
        prevention: [
          "Tune probes against p99 under load",
          "Alert on endpoint churn / readiness flapping",
        ],
        confidence: "High (88%) — probe timeouts align with endpoint churn.",
      }),
  },

  "mq-backlog": {
    defaultSeverity: "medium",
    forceService: "notifications",
    title: (s) => `${s} consumer lag — message queue backlog`,
    description: (s) =>
      `${s} consumers fell behind producers, growing a large queue backlog and delaying delivery well past SLA until consumer concurrency was increased.`,
    timeline: (s, t) =>
      tl(t, [
        [0, `Producer rate exceeds ${s} consumer throughput`, "warning"],
        [5, `Queue depth and consumer lag climbing`, "error"],
        [10, `Alert fired — delivery delayed > 30s`, "info"],
        [18, `Consumer concurrency scaled up`, "info"],
        [34, `Backlog drained, lag near zero`, "success"],
      ]),
    logs: (s, t) =>
      lg(t, [
        [0, "WARN", `[${s}] consumer lag 12k messages and growing`],
        [60, "ERROR", `[${s}] delivery delayed 47s exceeds SLA (30s)`],
        [1000, "INFO", `[${s}] scaled consumers to 12, lag draining`],
      ]),
    rca: (s) =>
      rcaDoc({
        cause: `Producer throughput to \`${s}\`'s queue outpaced consumer capacity, so lag and queue depth grew and delivery slipped past the 30s SLA.`,
        blast: `Delayed notifications on \`${s}\` (no data loss) until the backlog cleared.`,
        remediation: [
          "Scaled consumer concurrency and partitions",
          "Prioritised the backlog drain",
        ],
        prevention: [
          "Autoscale consumers on lag, not CPU",
          "Alert on consumer lag threshold",
        ],
        confidence: "Medium (86%) — lag growth tracks producer surge.",
      }),
  },

  "pod-eviction": {
    defaultSeverity: "medium",
    title: (s) => `${s} pods evicted during node drain`,
    description: (s) =>
      `A node drain for maintenance evicted ${s} pods faster than they could reschedule (no PDB), briefly dropping available replicas below the safe minimum.`,
    timeline: (s, t) =>
      tl(t, [
        [0, `Node cordoned + drained for maintenance`, "info"],
        [2, `${s} pods evicted, no PDB to cap disruption`, "error"],
        [6, `Alert fired — replicas below minimum`, "info"],
        [12, `Pods rescheduled onto other nodes`, "info"],
        [20, `Replica count restored`, "success"],
      ]),
    logs: (s, t) =>
      lg(t, [
        [0, "INFO", `[kubectl] draining node worker-1 for maintenance`],
        [30, "ERROR", `[${s}] evicted — only 1/3 replicas remain Ready`],
        [700, "INFO", `[${s}] rescheduled, 3/3 replicas Ready`],
      ]),
    rca: (s) =>
      rcaDoc({
        cause: `A maintenance node drain evicted \`${s}\` pods without a PodDisruptionBudget in place, so too many replicas went down at once before rescheduling caught up.`,
        blast: `Brief capacity dip on \`${s}\` below the safe minimum during the drain.`,
        remediation: ["Rescheduled pods and completed the drain gracefully"],
        prevention: [
          "Add PodDisruptionBudgets to critical workloads",
          "Drain nodes one at a time with surge capacity",
        ],
        confidence: "Medium (88%) — eviction coincides with the drain.",
      }),
  },

  "node-notready": {
    defaultSeverity: "high",
    title: (s) => `Node NotReady drops ${s} capacity`,
    description: (s) =>
      `A worker node went NotReady (kubelet lost heartbeat), and its ${s} pods were marked unavailable until they were rescheduled onto healthy nodes.`,
    timeline: (s, t) =>
      tl(t, [
        [0, `Node kubelet stops posting status`, "warning"],
        [3, `Node marked NotReady, pods Unknown`, "error"],
        [8, `Alert fired — ${s} capacity reduced`, "info"],
        [16, `Pods rescheduled after eviction timeout`, "info"],
        [27, `Capacity restored on healthy nodes`, "success"],
      ]),
    logs: (s, t) =>
      lg(t, [
        [0, "WARN", `[node-controller] worker-3 heartbeat missed`],
        [60, "ERROR", `[node-controller] worker-3 NotReady — pods marked Unknown`],
        [1000, "INFO", `[${s}] pods rescheduled to worker-2/worker-4`],
      ]),
    rca: (s) =>
      rcaDoc({
        cause: `\`worker-3\` went \`NotReady\` after its kubelet stopped posting status (host-level issue), so \`${s}\` pods on it were marked \`Unknown\` and only rescheduled after the pod-eviction timeout.`,
        blast: `Reduced \`${s}\` capacity until pods were rescheduled onto healthy nodes.`,
        remediation: [
          "Rescheduled pods onto healthy nodes",
          "Replaced the unhealthy node",
        ],
        prevention: [
          "Lower pod-eviction-timeout for faster failover",
          "Alert on node Ready=false and kubelet heartbeat gaps",
        ],
        confidence: "High (90%) — pod Unknown state tracks the node going NotReady.",
      }),
  },

  "ingress-misconfig": {
    defaultSeverity: "high",
    forceService: "api-gateway",
    title: (s) => `${s} 404/502 from ingress misconfiguration`,
    description: (s) =>
      `An ingress rule change on ${s} pointed a path at the wrong backend service, returning 404/502 for a subset of routes until the rule was corrected.`,
    timeline: (s, t) =>
      tl(t, [
        [0, `Ingress rule updated in a routine change`, "info"],
        [2, `Affected routes return 404/502`, "error"],
        [7, `Alert fired — path-specific error spike`, "info"],
        [12, `Ingress backend reference corrected`, "info"],
        [17, `Routes healthy`, "success"],
      ]),
    logs: (s, t) =>
      lg(t, [
        [0, "WARN", `[${s}] ingress path /api/orders → service "orders-old" (missing)`],
        [60, "ERROR", `[${s}] 502 Bad Gateway — no endpoints for backend`],
        [700, "INFO", `[${s}] ingress corrected → service "orders", routes healthy`],
      ]),
    rca: (s) =>
      rcaDoc({
        cause: `An ingress change on \`${s}\` routed \`/api/orders\` to a non-existent backend service, so those routes returned 404/502 while unaffected paths kept working.`,
        blast: `Path-scoped outage on \`${s}\` for the mis-routed routes only.`,
        remediation: ["Corrected the ingress backend reference"],
        prevention: [
          "Validate ingress backends exist in CI",
          "Canary ingress changes with synthetic route checks",
        ],
        confidence: "High (95%) — errors are scoped to the changed path.",
      }),
  },

  "cronjob-failure": {
    defaultSeverity: "low",
    title: (s) => `${s} scheduled job failing repeatedly`,
    description: (s) =>
      `A ${s} CronJob failed on every run (a dependency it needed was unavailable), so its downstream output went stale until the dependency was restored.`,
    timeline: (s, t) =>
      tl(t, [
        [0, `${s} CronJob run exits non-zero`, "error"],
        [3, `Second consecutive failed run`, "warning"],
        [8, `Alert fired — job backoffLimit exceeded`, "info"],
        [16, `Upstream dependency restored`, "info"],
        [22, `Next run succeeds, output fresh`, "success"],
      ]),
    logs: (s, t) =>
      lg(t, [
        [0, "ERROR", `[${s}] job "nightly-rollup" failed: dependency unreachable`],
        [60, "WARN", `[${s}] backoffLimit reached — job marked Failed`],
        [900, "INFO", `[${s}] job succeeded, rollup output written`],
      ]),
    rca: (s) =>
      rcaDoc({
        cause: `The \`${s}\` CronJob depended on an upstream endpoint that was unavailable, so every run exited non-zero and hit \`backoffLimit\`; downstream output went stale.`,
        blast: `Stale scheduled output from \`${s}\` (no live-traffic impact) until the dependency recovered.`,
        remediation: ["Restored the upstream dependency and re-ran the job"],
        prevention: [
          "Add retries with backoff and alert on Job failure",
          "Make the job idempotent and resumable",
        ],
        confidence: "Medium (84%) — every failed run cites the same dependency.",
      }),
  },
}

// ── Seed distribution ─────────────────────────────────────────────────────────
// daysAgo values, ascending (newest → oldest), spread over ~2 years and denser in
// recent weeks so time-range queries (day/week/month/quarter/year) have realistic
// counts. Each index maps to one incident; ids are assigned newest = highest.
const DAYS_AGO = [
  0.25, 0.9, 1.6, 2.4, 3.2, 4.7, 6.1, // last week (7)
  8, 11, 14, 17, 20, 24, 27, // rest of last month (7)
  33, 40, 47, 54, 62, 71, 80, 88, // rest of last quarter (8)
  97, 112, 126, 141, 158, 172, 189, 205, 223, 247, 272, 301, 332, 358, // rest of last year (14)
  402, 441, 483, 521, 559, 602, 641, 679, 699, 719, 728, // 1–2 years (11)
]

const FAILURE_ORDER: FailureType[] = [
  "db-pool-exhaustion",
  "OOMKilled",
  "CrashLoopBackOff",
  "network",
  "latency-slo",
  "secret-missing",
  "cache-eviction",
  "replica-exhaustion",
  "bad-deploy",
  "node-cpu-insufficient",
  "ImagePullBackOff",
  "tls-cert-expiry",
  "deadlock",
  "mq-backlog",
  "config-missing",
  "disk-pressure",
  "memory-leak",
  "probe-failure",
  "rate-limit",
  "pvc-full",
  "pod-eviction",
  "node-notready",
  "ingress-misconfig",
  "cronjob-failure",
]

const ROTATION_SERVICES = [
  "payment-service",
  "auth-service",
  "search-service",
  "media-service",
  "user-profile",
  "notifications",
  "order-service",
  "inventory-service",
  "config-service",
  "transaction-service",
]

const SEVERITY_USERS: Record<IncidentSeverity, [number, number]> = {
  critical: [820, 2200],
  high: [180, 640],
  medium: [20, 200],
  low: [0, 40],
}

// Deterministic pseudo-random from an integer seed (so seeded data is stable and
// test counts are reproducible across boots).
function rand(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453
  return x - Math.floor(x)
}

// Build the full historical incident set. `now` is captured once at first seed and
// the resulting absolute timestamps are persisted, so dates don't drift on reboot.
export function buildSeedIncidents(now: number): IncidentRecord[] {
  const records: IncidentRecord[] = []

  DAYS_AGO.forEach((daysAgo, i) => {
    const failureType = FAILURE_ORDER[i % FAILURE_ORDER.length]
    const tpl = TEMPLATES[failureType]
    const service = tpl.forceService ?? ROTATION_SERVICES[i % ROTATION_SERVICES.length]
    const severity = tpl.defaultSeverity

    const r = rand(i + 1)
    const durationMin = 12 + Math.floor(r * 58) // 12–70 min
    const [uMin, uMax] = SEVERITY_USERS[severity]
    const affectedUsers = uMin + Math.floor(rand(i + 101) * (uMax - uMin))

    // Start time: daysAgo back, at a plausible hour of day.
    const hourOfDay = 6 + Math.floor(rand(i + 201) * 14) // 06:00–20:00
    const dayStart = now - Math.round(daysAgo * DAY)
    const startedAt =
      new Date(dayStart).setUTCHours(hourOfDay, Math.floor(rand(i + 301) * 60), 0, 0)
    const resolvedAt = startedAt + durationMin * MIN

    const idNum = 2846 - i // newest = 2846, descending with age
    const id = `INC-${idNum}`
    const seedTimeline = tpl.timeline(service, startedAt)

    records.push({
      id,
      title: tpl.title(service),
      severity,
      service,
      status: "resolved",
      failureType,
      startedAt,
      resolvedAt,
      durationMin,
      affectedUsers,
      description: tpl.description(service),
      timeline: seedTimeline,
      relatedLogs: tpl.logs(service, startedAt),
      rca: {
        text: buildDetailedRca({
          id,
          service,
          severity,
          failureType,
          startedAt,
          resolvedAt,
          durationMin,
          affectedUsers,
          timeline: seedTimeline,
          parts: tpl.rca(service),
        }),
        provider: "seed",
        generatedAt: new Date(resolvedAt).toISOString(),
      },
      origin: "seed",
    })
  })

  return records
}
