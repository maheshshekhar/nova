// Pure parsers for interactive payloads: turn a Slack interaction or a PagerDuty
// webhook body into a small, typed intent the endpoints act on. No I/O.

export interface SlackInteraction {
  /** The action_id of the clicked element (e.g. "approve_remediation"). */
  actionId: string
  /** The button's value — we encode the incident id here. */
  value: string
  /** The Slack user who clicked (for the approver allowlist). */
  userId: string
  /** Slack's response_url for posting an ephemeral reply. */
  responseUrl?: string
}

/**
 * Parse a Slack interactive request. Slack sends
 * `application/x-www-form-urlencoded` with a single `payload` field holding JSON.
 * Returns null when the body is not a recognisable block-action interaction.
 */
export function parseSlackInteraction(rawBody: string): SlackInteraction | null {
  const params = new URLSearchParams(rawBody)
  const raw = params.get("payload")
  if (!raw) return null
  let payload: any
  try {
    payload = JSON.parse(raw)
  } catch {
    return null
  }
  const action = payload?.actions?.[0]
  if (!action?.action_id) return null
  return {
    actionId: String(action.action_id),
    value: String(action.value ?? ""),
    userId: String(payload?.user?.id ?? ""),
    responseUrl: typeof payload?.response_url === "string" ? payload.response_url : undefined,
  }
}

export type IncidentStatusChange = "acknowledged" | "resolved" | null

export interface PagerDutyWebhookIntent {
  eventType: string
  /** The Nova incident id, taken from the PD incident's dedup_key. */
  incidentId?: string
  /** The incident status Nova should move to, or null for events we ignore. */
  statusChange: IncidentStatusChange
}

// Map a PagerDuty v3 webhook event type to a Nova status change.
function mapEventType(eventType: string): IncidentStatusChange {
  switch (eventType) {
    case "incident.acknowledged":
      return "acknowledged"
    case "incident.resolved":
      return "resolved"
    default:
      return null
  }
}

/**
 * Parse a PagerDuty v3 webhook body. The Nova incident id is carried in the PD
 * incident's `dedup_key` (Nova sets it when triggering). Unknown event types
 * yield `statusChange: null` (ignored).
 */
export function parsePagerDutyWebhook(body: unknown): PagerDutyWebhookIntent {
  const event = (body as any)?.event ?? {}
  const eventType = String(event?.event_type ?? "")
  const dedup = event?.data?.dedup_key ?? event?.data?.dedupKey
  return {
    eventType,
    incidentId: typeof dedup === "string" && dedup ? dedup : undefined,
    statusChange: mapEventType(eventType),
  }
}
