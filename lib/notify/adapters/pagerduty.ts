import type { NovaEvent } from "../event"
import type { NotificationChannel } from "../channel"

// PagerDuty channel via Events API v2. `incident.opened` triggers an alert;
// `incident.resolved` resolves it. A stable `dedup_key` (the incident id) makes
// the lifecycle idempotent — a re-trigger updates the same PD alert, and the
// resolve closes it.

const PD_ENDPOINT = "https://events.pagerduty.com/v2/enqueue"

// Nova severity → PagerDuty severity (critical | error | warning | info).
function pdSeverity(severity: string): string {
  switch (severity) {
    case "critical":
      return "critical"
    case "high":
      return "error"
    case "medium":
      return "warning"
    default:
      return "info"
  }
}

export function buildPagerDutyPayload(routingKey: string, event: NovaEvent) {
  const inc = event.incident
  const action = event.type === "incident.resolved" ? "resolve" : "trigger"
  const base = {
    routing_key: routingKey,
    event_action: action,
    dedup_key: inc.id,
  }
  if (action === "resolve") return base
  return {
    ...base,
    payload: {
      summary: `${inc.id} ${inc.severity}: ${inc.title}`,
      severity: pdSeverity(inc.severity),
      source: inc.service,
      component: inc.service,
      group: inc.domain,
      custom_details: { status: inc.status, failureType: inc.failureType, summary: event.summary },
    },
    links: inc.url ? [{ href: inc.url, text: "Open in Nova" }] : undefined,
  }
}

export function makePagerDutyChannel(
  id: string,
  routingKey: string,
  fetchImpl: typeof fetch = fetch
): NotificationChannel {
  return {
    id,
    async notify(event: NovaEvent) {
      if (!routingKey) return { status: "skipped" as const, detail: "no routing key" }
      try {
        const res = await fetchImpl(PD_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(buildPagerDutyPayload(routingKey, event)),
        })
        // PagerDuty returns 202 Accepted on success.
        return res.ok
          ? { status: "sent" as const, detail: `pagerduty → ${res.status}` }
          : { status: "error" as const, detail: `pagerduty returned ${res.status}` }
      } catch (err) {
        return { status: "error" as const, detail: (err as Error).message }
      }
    },
  }
}
