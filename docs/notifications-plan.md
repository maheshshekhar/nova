# Nova — Notifications & Integrations Plan (M14)

> Design spec. Companion to [open-source-plan.md](open-source-plan.md),
> [domain-runbooks-settings-plan.md](domain-runbooks-settings-plan.md) and
> [implementation-plan.md](implementation-plan.md).
> Status: **DESIGN — ready to implement**. Builds on the finished M0–M13 core.

## Problem

Nova can *open* incidents (inbound `/api/alerts`) and *act* on them (approve-to-run
runbooks via the `ActionExecutor`), but it cannot **tell humans**. There is no
outbound path to PagerDuty, Slack, Teams, email, or a generic webhook when an
incident opens, an RCA is ready, or a remediation is approved. Earlier design notes
implied it ("ownership → notifications", the "is this worth paging" SLO comment) but
it was never built.

This closes the loop: **detect → analyse → remediate → _notify_**.

Distinct from what exists:
- **Inbound alerts** (`/api/alerts`): Alertmanager → *opens* an incident. Unchanged.
- **Runbook actions** (`ActionExecutor`, `/api/remediate`): *change the world*, gated by
  approval + RBAC + audit. A notification only *informs* — no approval needed.

---

## Concept: a `NotificationChannel` port + an event bus

Follow the exact ports-and-adapters pattern used for logs/persistence: a small port,
many adapters, resolved from config through an `AdapterRegistry`, each verified by a
shared contract-test kit.

```
emitEvent(NovaEvent)          # fired from the incident flow (non-blocking)
   └─> NotificationRouter     # routes an event to the subscribed channels
          └─> NotificationChannel[]   # slack | pagerduty | webhook | email | msteams
```

### Event model

```ts
type NovaEventType =
  | "incident.opened"
  | "incident.updated"
  | "incident.resolved"
  | "rca.generated"
  | "remediation.approved"

interface NovaEvent {
  type: NovaEventType
  at: number
  incident: {                    // a redacted, notification-safe projection
    id: string
    title: string
    service: string
    severity: string
    status: string
    domain?: string
    owner?: string               // from the domain service catalog
    url?: string                 // deep link to the incident in the dashboard
  }
  summary?: string               // e.g. the RCA executive summary (redacted)
}
```

### Ports & interfaces (`lib/notify/`)

```ts
// channel.ts
export interface NotificationChannel {
  readonly id: string
  notify(event: NovaEvent): Promise<NotifyResult>   // never throws to the caller
}
export interface NotifyResult { status: "sent" | "skipped" | "error"; detail: string }

// bus.ts
export function emitEvent(event: NovaEvent): void      // fire-and-forget fan-out
```

- The **bus is fire-and-forget**: a channel failure is logged + recorded, but never
  blocks or fails the incident operation that triggered it.
- Every event payload is scrubbed with `redactSecrets` (M13) before egress.

---

## Adapters (`lib/notify/adapters/`)

| Adapter | Transport | Notes |
|---|---|---|
| `webhook` | `POST` JSON to a URL | Generic; the escape hatch (Zapier, custom automation). |
| `slack` | Incoming Webhook (tier 1) → Bot API (tier 2) | Block Kit message: title, severity colour, service/owner, RCA summary, incident link. |
| `pagerduty` | Events API v2 | `incident.opened` → `trigger` (dedup_key = incident id); `incident.resolved` → `resolve`. Bidirectional lifecycle. |
| `email` | SMTP (nodemailer) | For teams without chat-ops. |
| `msteams` | Incoming Webhook (Adaptive Card) | Parity with Slack tier 1. |

Each adapter is pure over an injected client (`fetch` / SMTP transport) so it is
unit-testable without a live endpoint. Secrets (webhook URLs, PD routing keys, SMTP
creds) come from env via `${ENV}` — never the config file.

---

## Routing

The `NotificationRouter` decides which channels receive an event:

```yaml
notifications:
  channels:
    - { id: pd-payments, type: pagerduty, routingKeyEnv: PD_PAYMENTS_KEY }
    - { id: slack-sre,   type: slack,     webhookUrlEnv: SLACK_SRE_WEBHOOK }
  routes:
    # First matching route wins; a route with no filters is the default.
    - { when: { severity: [critical, high] }, channels: [pd-payments, slack-sre] }
    - { when: { severity: [medium, low] },     channels: [slack-sre] }
  # Optional: map a domain service's `owner` to a channel (ownership-based paging).
  ownerRouting:
    payments-team: pd-payments
  events: [incident.opened, incident.resolved, rca.generated]
```

- **Filters:** `severity`, `service`, `domain`, `failureType`, `event type`.
- **Owner routing:** the service catalog `owner` (Domain Pack) → a channel, so incidents
  page the team that owns the failing service.
- Routing is a **pure function** (`resolveChannels(event, config) → channelIds`) — the
  heart of the M14 test suite.

---

## Config schema (`lib/config/schema.ts`)

Add a `notifications` section (default `{ enabled: false, channels: [], routes: [] }`
so nothing sends until configured — behaviour-preserving):

```yaml
notifications:
  enabled: true
  dedupeWindowSec: 300          # suppress duplicate sends for the same incident+type
  channels: [ ... ]
  routes: [ ... ]
  ownerRouting: { ... }
  events: [ incident.opened, incident.resolved ]
```

`NotificationChannelSchema` is a discriminated union on `type` (each with its own
`*Env` secret-name fields), validated on load; a malformed channel is skipped with a
clear error (same resilience as runbooks/domains).

---

## Where events are emitted

Thread `emitEvent` through the existing flows (thin, non-blocking calls):

| Trigger | Event |
|---|---|
| `PersistenceStore.createIncident` (live incident) / `/api/alerts` | `incident.opened` |
| `PersistenceStore.updateIncident` | `incident.updated` |
| `resolveIncident` / recover | `incident.resolved` |
| `/api/analyze` after an RCA is saved | `rca.generated` |
| `ActionExecutor` on a successful approved run | `remediation.approved` |

Emission is centralised so channels/routing stay decoupled from business logic.

---

## Safety

- **Non-blocking:** the incident flow never awaits or fails on a notification.
- **Redaction:** every payload runs through `redactSecrets`.
- **Dedup:** a per-incident+type window (`dedupeWindowSec`) prevents alert storms.
- **Retry:** bounded retry with backoff per channel; give up + audit after N.
- **Audit:** reuse/extend the M7 audit sink so every send/skip/error is recorded.
- **Secrets:** channel credentials are env-only; the Settings view shows "set via env".

---

## Testing

- **Contract kit** `runNotificationContract(makeChannel)` — every channel adapter: builds
  the correct payload for each event type, reports `error` (not throw) on a failed send,
  and never leaks a secret into the payload.
- **Router** unit tests: severity/service/domain/owner filters, first-match precedence,
  default route, dedup window, disabled state emits nothing.
- **Per-adapter** payload tests against injected `fetch`/SMTP: Slack Block Kit shape,
  PagerDuty Events v2 `trigger`/`resolve` with a stable `dedup_key`, webhook JSON body.
- **Integration:** `emitEvent` on a fixture incident fans out to the routed channels only.

---

## Phases

1. **M14a — Outbound core.** Port + bus + router + `webhook` + `slack` (incoming webhook)
   + `pagerduty` (Events v2) + config + emission points + contract kit. High value, low
   surface.
2. **M14b — Breadth.** `email` (SMTP) + `msteams`. Owner-based routing polish.
3. **M14c — Interactive (later).** Slack app with "Approve remediation" buttons →
   Nova's approve endpoint; bidirectional PagerDuty sync (ack/resolve back into Nova).
   Requires a signed inbound interactions endpoint + request verification.

---

## Backward-compat

`notifications.enabled` defaults **false** and `channels` empty → nothing sends, output
unchanged. The event bus with no channels is a no-op. Fully additive.

---

## Open questions

- **Interactive approval via Slack/PD** — how much of the approval+RBAC+audit gate moves
  to the chat surface vs. staying dashboard-only? (Security-sensitive.)
- **Delivery guarantees** — fire-and-forget vs. a small durable outbox for at-least-once?
- **Templating** — should channel messages be user-editable templates (like `prompts/`)?
- **Rate/cost** — global send rate limits to avoid paging storms on a cascade.
