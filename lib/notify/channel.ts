import type { NovaEvent } from "./event"

// A NotificationChannel sends a NovaEvent to one destination. It NEVER throws to
// the caller — a failed send is reported as an "error" NotifyResult so the event
// bus can carry on to the other channels and the incident flow is never disrupted.

export interface NotifyResult {
  status: "sent" | "skipped" | "error"
  detail: string
}

export interface NotificationChannel {
  readonly id: string
  notify(event: NovaEvent): Promise<NotifyResult>
}
