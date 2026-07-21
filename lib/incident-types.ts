// Shared incident types — safe to import from both server (store/API) and client
// (pages/chat). No runtime deps so it can cross the server/client boundary freely.

export type IncidentSeverity = "critical" | "high" | "medium" | "low"

export type IncidentStatus =
  | "investigating"
  | "mitigating"
  | "monitoring"
  | "resolved"

// Extensible failure taxonomy. The original six Nova cares about plus a wide
// set of real-world Kubernetes / production failure modes. Add new members here —
// the store, API and UI treat it as an open string-backed enum.
export type FailureType =
  | "OOMKilled"
  | "CrashLoopBackOff"
  | "ImagePullBackOff"
  | "network"
  | "secret-missing"
  | "config-missing"
  | "replica-exhaustion"
  | "node-cpu-insufficient"
  | "disk-pressure"
  | "pvc-full"
  | "tls-cert-expiry"
  | "db-pool-exhaustion"
  | "deadlock"
  | "memory-leak"
  | "bad-deploy"
  | "rate-limit"
  | "latency-slo"
  | "cache-eviction"
  | "probe-failure"
  | "mq-backlog"
  | "pod-eviction"
  | "node-notready"
  | "ingress-misconfig"
  | "cronjob-failure"

export interface TimelineEntry {
  time: string
  event: string
  type: "info" | "warning" | "error" | "success"
}

export interface RelatedLog {
  timestamp: string
  level: string
  message: string
}

export interface IncidentRca {
  text: string
  provider: string
  generatedAt: string
  // Optional operator-supplied context (e.g. info from external/downstream teams)
  // that was fed into the AI when (re)generating this RCA. Persisted so it can be
  // shown again and edited on a subsequent regenerate.
  additionalDetails?: string
  // The exact context string fed to the model when generating this RCA (impact
  // count, error rates, pool size, dates, resolution). Persisted so the incident
  // eval grades the document against the same facts the author had.
  context?: string
  // Real cluster log snapshot captured (server-side) at RCA generation. Persisted
  // so the incident's real evidence survives beyond the collector's ~30-min buffer
  // and across page reloads — used to hydrate Related Logs / regeneration.
  logsSnapshot?: { timestamp: string; level: string; message: string; pod: string }[]
}

export interface IncidentRecord {
  id: string
  title: string
  severity: IncidentSeverity
  service: string
  status: IncidentStatus
  failureType: FailureType
  // Epoch milliseconds.
  startedAt: number
  resolvedAt: number | null
  durationMin: number | null
  affectedUsers: number
  description: string
  timeline: TimelineEntry[]
  relatedLogs: RelatedLog[]
  rca: IncidentRca | null
  // Where the record came from: pre-seeded history vs a live run.
  origin: "seed" | "live"
}

// Human-friendly labels for each failure type (used in UI badges / chat context).
export const FAILURE_LABELS: Record<FailureType, string> = {
  OOMKilled: "OOMKilled",
  CrashLoopBackOff: "CrashLoopBackOff",
  ImagePullBackOff: "ImagePullBackOff",
  network: "Network failure",
  "secret-missing": "Secret not found",
  "config-missing": "Config missing",
  "replica-exhaustion": "Replica exhaustion",
  "node-cpu-insufficient": "Insufficient node CPU",
  "disk-pressure": "Disk pressure",
  "pvc-full": "PVC full",
  "tls-cert-expiry": "TLS certificate expiry",
  "db-pool-exhaustion": "DB pool exhaustion",
  deadlock: "Deadlock / lock contention",
  "memory-leak": "Memory leak",
  "bad-deploy": "Bad deploy / rollout failure",
  "rate-limit": "Rate limiting / throttling",
  "latency-slo": "Latency SLO breach",
  "cache-eviction": "Cache eviction storm",
  "probe-failure": "Liveness/readiness probe failure",
  "mq-backlog": "Message queue backlog",
  "pod-eviction": "Pod eviction / node drain",
  "node-notready": "Node NotReady",
  "ingress-misconfig": "Ingress misconfiguration",
  "cronjob-failure": "CronJob failure",
}

export type IncidentRange = "day" | "week" | "month" | "quarter" | "year" | "all"

export interface IncidentFilter {
  range?: IncidentRange
  from?: number
  to?: number
  service?: string
  severity?: IncidentSeverity
  failureType?: FailureType
  status?: IncidentStatus
}
