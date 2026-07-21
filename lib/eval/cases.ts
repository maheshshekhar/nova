// Golden eval dataset.
//
// A small, fixed set of incident scenarios used to measure AI output quality.
// Each case feeds realistic logs + context through the SAME prompts the product
// uses (lib/ai/prompts), then output is scored by deterministic checks +
// LLM-as-judge (lib/eval/judge).
//
// Keep these stable — changing a case changes its scores. Add new cases rather
// than mutating existing ones when expanding coverage.

export type EvalMode = "triage" | "rca"

export interface EvalExpectations {
  /** Substrings that MUST all appear in the root-cause reasoning (case-insensitive). */
  rootCauseMustInclude: string[]
  /** Substrings that MUST all appear in the remediation. */
  remediationMustInclude: string[]
  /** Claims that MUST NOT appear (hallucination traps for this scenario). */
  forbiddenClaims: string[]
  /** For rca mode: section headings that must be present. */
  requiredSections?: string[]
}

export interface EvalCase {
  id: string
  title: string
  failureType: string
  mode: EvalMode
  logs: string[]
  context: string
  expectations: EvalExpectations
}

const RCA_SECTIONS = [
  "Executive Summary",
  "Root Cause",
  "Timeline",
  "Action Items",
]

export const EVAL_CASES: EvalCase[] = [
  {
    id: "db-pool-exhaustion-triage",
    title: "Payment-service DB connection pool exhaustion (triage)",
    failureType: "db-pool-exhaustion",
    mode: "triage",
    logs: [
      "2026-07-14T09:12:03.114Z WARN [payment-service-prod-7c] pool.waitQueueSize 18 rising, max 3 connections per pod",
      "2026-07-14T09:13:41.882Z ERROR [payment-service-prod-7c] pool.connect() timeout after 5000ms — no free connection",
      "2026-07-14T09:13:42.004Z ERROR [payment-service-prod-9d] FATAL: too many connections for role \"payment_svc\"",
      "2026-07-14T09:14:10.551Z ERROR [payment-service-prod-7c] POST /api/checkout — 503 Service Unavailable (upstream timeout)",
      "2026-07-14T09:15:02.900Z ERROR [payment-service-prod-2a] Circuit breaker OPEN after 10 consecutive failures",
    ],
    context:
      "INC-2847: payment-service cascading failure. Checkout endpoint returning 503 errors. 1842 users affected. Postgres max_connections is low and each pod holds up to 3 connections.",
    expectations: {
      rootCauseMustInclude: ["connection pool", "exhaust"],
      remediationMustInclude: ["scale", "6 replicas"],
      forbiddenClaims: ["memory leak", "OOMKilled", "DNS", "TLS certificate"],
    },
  },
  {
    id: "db-pool-exhaustion-rca",
    title: "Payment-service DB pool exhaustion (full RCA)",
    failureType: "db-pool-exhaustion",
    mode: "rca",
    logs: [
      "09:12 WARN [payment-service-prod-7c] pool.waitQueueSize 18 rising, max 3 connections per pod",
      "09:13 ERROR [payment-service-prod-7c] pool.connect() timeout after 5000ms — no free connection",
      "09:14 ERROR [payment-service-prod-9d] FATAL: too many connections for role \"payment_svc\"",
      "09:15 ERROR [payment-service-prod-2a] POST /api/checkout — 503 Service Unavailable",
      "09:22 INFO [payment-service-prod-2a] scaled to 6 replicas, pool pressure easing",
    ],
    context:
      "INC-2847: payment-service. Severity: critical (SEV-1). Users affected: 1842. The incident began at 09:12 and was resolved at approximately 09:24. Total incident duration: 12 minute(s). Resolution: stopped the load-generator and scaled payment-service to 6 replicas.",
    expectations: {
      rootCauseMustInclude: ["connection pool", "exhaust"],
      remediationMustInclude: ["scale", "load"],
      forbiddenClaims: ["memory leak", "[date]", "[time]"],
      requiredSections: RCA_SECTIONS,
    },
  },
  {
    id: "oomkilled-triage",
    title: "Transaction-service OOMKilled (triage)",
    failureType: "OOMKilled",
    mode: "triage",
    logs: [
      "2026-07-14T11:02:10.001Z WARN [transaction-service-5f] container memory 486Mi / 512Mi limit (95%)",
      "2026-07-14T11:03:12.400Z ERROR [transaction-service-5f] OOMKilled — exit code 137, restarting container",
      "2026-07-14T11:03:44.220Z ERROR [transaction-service-5f] readiness probe failed: connection refused (restarting)",
      "2026-07-14T11:05:01.110Z WARN [transaction-service-8a] restartCount=3 in 5 minutes",
    ],
    context:
      "INC-3120: transaction-service pods breaching their 512Mi memory limit under sustained load, repeatedly OOMKilled by the kubelet (exit 137).",
    expectations: {
      rootCauseMustInclude: ["memory", "limit"],
      remediationMustInclude: ["memory"],
      forbiddenClaims: ["connection pool", "Postgres", "database"],
    },
  },
  {
    id: "crashloop-config-triage",
    title: "Config-service CrashLoopBackOff — missing config (triage)",
    failureType: "CrashLoopBackOff",
    mode: "triage",
    logs: [
      "2026-07-14T08:00:01.000Z ERROR [config-service-1b] Missing required config key: FEATURE_FLAGS_URL",
      "2026-07-14T08:00:01.500Z ERROR [config-service-1b] Error: startup validation failed — exiting",
      "2026-07-14T08:00:33.220Z WARN [config-service-1b] Back-off restarting failed container (restartCount=4)",
      "2026-07-14T08:01:04.900Z ERROR [config-service-1b] CrashLoopBackOff: last state Terminated (exit code 1)",
    ],
    context:
      "INC-3140: config-service stuck in CrashLoopBackOff. Container exits 1 on startup; 0/3 replicas ready.",
    expectations: {
      rootCauseMustInclude: ["config", "startup"],
      remediationMustInclude: ["config"],
      forbiddenClaims: ["memory leak", "OOMKilled", "connection pool"],
    },
  },
  {
    id: "probe-failure-triage",
    title: "Payment-service readiness probe failures (triage)",
    failureType: "probe-failure",
    mode: "triage",
    logs: [
      "2026-07-14T14:20:00.000Z WARN [payment-service-prod-3e] GC pause 220ms exceeds threshold (50ms)",
      "2026-07-14T14:20:31.000Z ERROR [payment-service-prod-3e] readiness probe failed: HTTP 500 on /healthz",
      "2026-07-14T14:21:10.000Z WARN [payment-service-prod-3e] pod removed from Service endpoints (not ready)",
      "2026-07-14T14:23:02.000Z INFO [payment-service-prod-3e] readiness probe passing again",
    ],
    context:
      "INC-3155: payment-service pods intermittently failing readiness probes due to long GC pauses, being pulled from the Service load balancer.",
    expectations: {
      rootCauseMustInclude: ["probe"],
      remediationMustInclude: ["probe"],
      forbiddenClaims: ["OOMKilled", "connection pool exhausted", "DNS"],
    },
  },
]

export function getCase(id: string): EvalCase | undefined {
  return EVAL_CASES.find((c) => c.id === id)
}
