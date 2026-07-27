import type { FailureType, IncidentSeverity } from "@/lib/incident-types"
import type { IncidentDecision } from "./correlate"

// Map a Sentinel incident decision onto an Alertmanager-shaped alert and POST it
// to Nova's existing `/api/alerts` pipeline. This is deliberate: the Sentinel
// "sits beside" the same generic incident-creation path Alertmanager uses, so it
// reuses the built-in per-service idempotency, incident store and notifications —
// no new incident-writing code, and Sentinel + external alerts never double-fire.
//
// Pure mapping (no I/O) so it is fully unit-testable.

/** The Alertmanager-webhook shape `/api/alerts` consumes. */
export interface SentinelAlert {
  status: "firing"
  labels: {
    service: string
    severity: string
    failure_type: string
    /** Provenance so the UI can badge "detected by Nova". */
    source: "nova-sentinel"
  }
  annotations: { summary: string; description: string }
  startsAt: string
}

// Sentinel severity → Nova incident severity.
const SEVERITY: Record<IncidentDecision["severity"], IncidentSeverity> = {
  critical: "critical",
  warning: "high",
  info: "low",
}

// Signal kind → Nova failure taxonomy (lib/incident-types.ts).
const SIGNAL_TO_FAILURE: Record<string, FailureType> = {
  CrashLoopBackOff: "CrashLoopBackOff",
  OOMKilled: "OOMKilled",
  ImagePullBackOff: "ImagePullBackOff",
  CreateContainerConfigError: "config-missing",
  ContainerError: "bad-deploy",
  Unschedulable: "node-cpu-insufficient",
  HighRestarts: "CrashLoopBackOff",
  FailedMount: "secret-missing",
  ProbeFailure: "probe-failure",
  FailedScheduling: "node-cpu-insufficient",
  SandboxError: "network",
  BackOff: "CrashLoopBackOff",
  // Log-derived signals (lib/sentinel/logs). Prefixed "Log:" for signatures.
  "Log:OutOfMemory": "OOMKilled",
  "Log:DBPoolExhausted": "db-pool-exhaustion",
  "Log:DBUnavailable": "db-pool-exhaustion",
  "Log:DBDeadlock": "deadlock",
  "Log:TLSError": "tls-cert-expiry",
  "Log:ConnReset": "network",
  "Log:ConnRefused": "network",
  "Log:NetTimeout": "network",
  "Log:DNSFailure": "network",
  "Log:DiskFull": "disk-pressure",
  "Log:Throttled": "rate-limit",
  "Log:HTTP5xx": "bad-deploy",
  "Log:Panic": "bad-deploy",
  "Log:Segfault": "bad-deploy",
  "Log:StackOverflow": "bad-deploy",
}

export function decisionToAlert(decision: IncidentDecision, at: number = Date.now()): SentinelAlert {
  // Prefer a hard signal as the primary cause; else the first signal.
  const primary = decision.signals.find((s) => s.hard) ?? decision.signals[0]
  const failureType = SIGNAL_TO_FAILURE[primary.kind] ?? "bad-deploy"
  const summary = `Nova detected ${primary.kind} on ${decision.service}`
  const description = [
    `Nova Sentinel flagged ${decision.service} in ${decision.namespace} ` +
      `(confidence ${Math.round(decision.confidence * 100)}%).`,
    "Signals:",
    ...decision.signals.map((s) => `- ${s.kind}: ${s.message}`),
  ].join("\n")

  return {
    status: "firing",
    labels: {
      service: decision.service,
      severity: SEVERITY[decision.severity],
      failure_type: failureType,
      source: "nova-sentinel",
    },
    annotations: { summary, description },
    startsAt: new Date(at).toISOString(),
  }
}
