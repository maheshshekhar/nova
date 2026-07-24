import { DomainSchema, type Domain } from "./schema"

// The built-in default domain is intentionally GENERIC and domain-agnostic: Nova
// with NO `domain:` configured carries zero business-domain vocabulary. The
// prompt variables fall back to the schema's neutral defaults, and the impact
// signal counts generic server-error impact (5xx / unavailable / timeout).
//
// Domain-specific behaviour (e.g. the payments-reference playbook) lives ONLY in
// an example Domain Pack — point `nova.config.yaml` `domain:` at one
// (domains/payments.yaml, domains/streaming.yaml, …). This is DATA, not code
// scattered through prompts.

export const DEFAULT_DOMAIN: Domain = DomainSchema.parse({
  id: "default",
  displayName: "Default",
  glossary: [],
  services: [],
  impactSignal: {
    match: {
      // Generic server-error impact: 5xx status codes, "service unavailable",
      // and timeouts. A Domain Pack can narrow this to its own signal.
      pattern: "5\\d\\d|service unavailable|timeout",
    },
    unit: "failed requests",
  },
  severityRules: [
    { when: { errorRatePct: ">5" }, severity: "critical" },
    { when: { errorRatePct: ">1" }, severity: "high" },
  ],
  // promptVars omitted → the schema's NEUTRAL defaults apply (no domain vocab).
  failureTypes: [],
})
