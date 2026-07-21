// Notification event model. A NovaEvent is a redacted, notification-safe projection
// of an incident lifecycle moment — never the full record, never secrets.

export type NovaEventType =
  | "incident.opened"
  | "incident.updated"
  | "incident.resolved"
  | "rca.generated"
  | "remediation.approved"

export interface NovaEventIncident {
  id: string
  title: string
  service: string
  severity: string
  status: string
  failureType?: string
  domain?: string
  /** From the domain service catalog — drives ownership-based routing. */
  owner?: string
  /** Deep link to the incident in the dashboard (when NOVA_BASE_URL is set). */
  url?: string
}

export interface NovaEvent {
  type: NovaEventType
  at: number
  incident: NovaEventIncident
  /** Short human summary (e.g. the RCA executive summary), already redacted. */
  summary?: string
  /** A matched, actionable runbook — when present, interactive channels render an
   * "Approve & Run" affordance. */
  runbook?: { id: string; title: string }
}
