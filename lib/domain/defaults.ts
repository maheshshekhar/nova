import { DomainSchema, type Domain } from "./schema"

// The built-in default domain. Reproduces today's (payments-reference) behaviour
// so Nova with NO `domain:` configured is byte-for-byte unchanged: the prompt
// variables carry the exact wording the prompts used to hardcode, and the impact
// signal reproduces the checkout-503 counter. Glossary/services are empty so the
// domain context block stays hidden by default (behaviour-preserving) until a
// real Domain Pack is configured.
//
// This is DATA, not code scattered through prompts — swap it by pointing
// `nova.config.yaml` `domain:` at an example pack (domains/*.yaml).

export const DEFAULT_DOMAIN: Domain = DomainSchema.parse({
  id: "default",
  displayName: "Default (payments reference)",
  glossary: [],
  services: [],
  impactSignal: {
    match: {
      pattern: "503|service unavailable|pool\\.connect\\(\\)\\s*timeout|too many connections",
    },
    unit: "failed checkout transactions",
  },
  severityRules: [
    { when: { errorRatePct: ">5" }, severity: "critical" },
    { when: { errorRatePct: ">1" }, severity: "high" },
  ],
  promptVars: {
    remediationGuidance:
      "Known remediation playbook for this service: scale payment-service to 6 replicas and stop the load-generator Job. All workloads run in the Kubernetes namespace `production` — always use `-n production` (never `prod` or `default`) in kubectl commands, e.g. `kubectl scale deployment payment-service --replicas=6 -n production` and `kubectl delete job load-generator -n production`. If the evidence supports it, lead with this as remediation step 1.",
    namespaceGuidance:
      "All Kubernetes workloads run in the namespace `production` — whenever you reference a kubectl command or namespace, use `production` exactly (never `prod` or `default`).",
    rootCauseHint: "(the connection-pool exhaustion cascade)",
    resolutionHint: "reference stopping the load and scaling to 6 replicas",
  },
  failureTypes: ["db-pool-exhaustion"],
})
