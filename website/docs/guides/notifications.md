# Notifications

Nova can fire on incident lifecycle events (opened, resolved, RCA generated) to Slack,
PagerDuty, Microsoft Teams, a generic webhook, or email — with routing rules and interactive
approval. Secrets are referenced by **env var name** and resolved at send time — never stored
in the config file.

```yaml
notifications:
  enabled: true
  dedupeWindowSec: 300          # suppress duplicate sends per incident+event
  events: [incident.opened, incident.resolved, rca.generated]
  channels:
    - { id: slack-sre,   type: slack,     webhookUrlEnv: SLACK_SRE_WEBHOOK }
    - { id: pd-payments, type: pagerduty, routingKeyEnv: PD_PAYMENTS_KEY }
    # - { id: teams, type: msteams, webhookUrlEnv: TEAMS_WEBHOOK }
    # - { id: hook,  type: webhook, urlEnv: NOVA_WEBHOOK_URL }
    # - { id: email-oncall, type: email, urlEnv: SMTP_URL, from: nova@example.com, to: [oncall@example.com] }
  routes:
    - when: { severity: [critical], service: [payment-service] }
      channels: [pd-payments, slack-sre]
```

## Routing

Routes match on severity, service, domain, failure type, or event, and fan out to one or more
channels. An owner-routing map can page a domain service's `owner` directly.

## Interactive approval

Inbound integrations (Slack, PagerDuty) can drive **human-approved remediation** — each inbound
request verifies its signature before acting, and an approver allowlist controls who can approve.
