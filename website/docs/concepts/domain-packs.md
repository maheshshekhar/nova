# Domain packs

Nova's core carries **zero business-domain knowledge**. Everything domain-specific — your
vocabulary, service catalog, what "impact" means, severity rules, remediation guidance,
runbooks — lives in a **Domain Pack**: one YAML file you point at with `domain:`.

```yaml
# nova.config.yaml
domain: ./domains/payments.yaml
```

```yaml
# domains/payments.yaml
domain:
  id: payments
  displayName: Payments Platform
  glossary:
    - { term: checkout, meaning: the customer payment-completion flow }
  services:
    - { name: payment-service, tier: 1, owner: payments-team, dependsOn: [postgres] }
  impactSignal:
    match: { pattern: "503|pool.connect|too many connections" }
    unit: failed checkout transactions
  severityRules:
    - { when: { errorRatePct: ">5" }, severity: critical }
  runbooks: ./domains/payments/runbooks
```

## What a pack grounds

- **The AI prompts** — glossary + service catalog + impact wording are woven into triage / RCA.
- **Detection** — the impact signal and severity rules classify incidents.
- **Runbooks** — matched by failure type + service, offering a pre-approved remediation.

## Domain-agnostic by default

With no `domain:` set, Nova uses a **generic** default (neutral prompts, a generic
5xx/timeout impact signal). Point at `domains/generic-k8s.yaml`, `domains/payments.yaml`,
`domains/streaming.yaml`, or write your own — swapping one file re-domains Nova with **no code
change**. A leak test guarantees no domain's vocabulary bleeds into the core.
