import type { FailureType } from "./incident-types"

// Operational runbooks for common, well-understood failure modes. When an
// incident's failure type (and optionally service) matches a runbook, the
// dashboard surfaces the diagnosis + exact remediation and asks the operator to
// approve. On approval the dashboard performs the `action` against the real
// cluster (POST /api/remediate), so "Approve & Run" actually fixes the incident.
//
// NOTE: the payment-service / Postgres connection-pool cascade is deliberately
// NOT covered by a runbook — it is driven live via scripts/inject-failure and
// recovered manually during a live run.
export type RemediationAction = "restart" | "restore-config" | "scale"

export interface Runbook {
  id: string
  title: string
  // Failure types this runbook resolves.
  failureTypes: FailureType[]
  // Optional service scope — a runbook matching both type and service is preferred.
  services?: string[]
  symptom: string
  diagnosis: string
  // The exact, ordered remediation steps the dashboard will apply on approval.
  actions: string[]
  approvalPrompt: string
  eta: string
  // The real cluster action performed on approval.
  action: RemediationAction
  // Target replica count for `scale`.
  replicas?: number
  // Optional domain scope (a runbook with no domain is universal). Set on
  // authored runbooks loaded from a Domain Pack (see lib/runbook-store.ts).
  domain?: string
}

export const RUNBOOKS: Runbook[] = [
  {
    id: "CONFIG-RECOVERY",
    title: "CrashLoopBackOff — Missing Config",
    failureTypes: ["CrashLoopBackOff", "config-missing", "secret-missing"],
    services: ["config-service"],
    symptom:
      "Pods stuck in CrashLoopBackOff / CreateContainerConfigError; the startup log names a missing required config value — an environment variable, a Secret, or a ConfigMap key.",
    diagnosis:
      "A required configuration value is absent from the deployment, so config-service fails validation on boot and never becomes Ready. The crash log states exactly which value is missing and where it should come from (env var / Secret / ConfigMap), so remediation restores that specific value rather than blindly restarting.",
    actions: [
      "Read the crash log to identify the missing config and its kind (env var / Secret / ConfigMap key)",
      "Restore that exact value from its source of truth onto the deployment",
      "Clear the injected crash flag and roll the deployment",
      "Wait for at least one replica to pass readiness",
      "Verify config-service is serving /config again",
    ],
    approvalPrompt:
      "Approve remediation: restore the specific missing config value (named in the crash log) from source of truth and roll the deployment?",
    eta: "~30 seconds",
    action: "restore-config",
  },
  {
    id: "ROLLING-RESTART",
    title: "Unhealthy Pods — Rolling Restart",
    failureTypes: ["OOMKilled", "memory-leak", "probe-failure", "deadlock"],
    services: ["transaction-service", "config-service"],
    symptom:
      "Pods flapping / restarting or leaking memory; readiness probes intermittently failing under load.",
    diagnosis:
      "The pods are in a degraded runtime state that a clean restart clears (leaked memory, stuck workers, wedged connections).",
    actions: [
      "Trigger a rolling restart of the affected deployment",
      "Kubernetes brings up fresh pods with a clean working set",
      "Wait for the new pods to become Ready",
      "Verify error rate / latency returns to baseline",
    ],
    approvalPrompt: "Approve remediation: perform a rolling restart of the deployment?",
    eta: "~30 seconds",
    action: "restart",
  },
]

// Source-agnostic runbook matcher (pure). Works over ANY list of runbook-like
// objects (the built-in RUNBOOKS, or authored runbooks loaded from a Domain
// Pack), so the same logic backs both the client dashboard and the server store.
//
// Matching: optionally restrict to the incident's domain (a runbook with no
// `domain` is universal, one tagged for a different domain is excluded), then
// prefer a runbook scoped to the service, else the first that handles the type.
export function selectRunbook<
  T extends { failureTypes: readonly string[]; services?: string[]; domain?: string }
>(runbooks: readonly T[], failureType: string, service?: string, domain?: string): T | null {
  const inDomain = domain
    ? runbooks.filter((rb) => !rb.domain || rb.domain === domain)
    : runbooks
  const byType = inDomain.filter((rb) => rb.failureTypes.includes(failureType))
  if (byType.length === 0) return null
  if (service) {
    const scoped = byType.find((rb) => rb.services?.includes(service))
    if (scoped) return scoped
  }
  return byType[0]
}

// Find the best runbook for an incident: prefer one scoped to the service, else
// fall back to the first runbook that handles the failure type.
export function matchRunbook(failureType: FailureType, service?: string): Runbook | null {
  return selectRunbook(RUNBOOKS, failureType, service)
}
