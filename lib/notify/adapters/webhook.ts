import type { NovaEvent } from "../event"
import type { NotificationChannel } from "../channel"

// Generic webhook channel — POSTs the (already redacted) NovaEvent as JSON. The
// escape hatch for any custom automation.
export function makeWebhookChannel(
  id: string,
  url: string,
  fetchImpl: typeof fetch = fetch
): NotificationChannel {
  return {
    id,
    async notify(event: NovaEvent) {
      if (!url) return { status: "skipped" as const, detail: "no url configured" }
      try {
        const res = await fetchImpl(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(event),
        })
        return res.ok
          ? { status: "sent" as const, detail: `POST ${url} → ${res.status}` }
          : { status: "error" as const, detail: `webhook returned ${res.status}` }
      } catch (err) {
        return { status: "error" as const, detail: (err as Error).message }
      }
    },
  }
}
