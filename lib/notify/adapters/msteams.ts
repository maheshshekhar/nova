import type { NovaEvent } from "../event"
import type { NotificationChannel } from "../channel"

// Microsoft Teams channel via an Incoming Webhook, posting a legacy MessageCard
// (broadly supported by Teams connectors). Parity with the Slack tier-1 adapter.

const THEME_COLOR: Record<string, string> = {
  critical: "D7263D",
  high: "F46036",
  medium: "F6C700",
  low: "2E86AB",
}

export function buildTeamsCard(event: NovaEvent) {
  const inc = event.incident
  const facts = [
    { name: "Incident", value: inc.id },
    { name: "Service", value: inc.service },
    { name: "Severity", value: inc.severity },
    { name: "Status", value: inc.status },
  ]
  if (inc.owner) facts.push({ name: "Owner", value: inc.owner })
  return {
    "@type": "MessageCard",
    "@context": "https://schema.org/extensions",
    themeColor: THEME_COLOR[inc.severity] ?? "808080",
    summary: `${inc.id} ${inc.title}`,
    title: `${inc.severity.toUpperCase()} — ${inc.title}`,
    sections: [{ facts, text: event.summary ?? "" }],
    potentialAction: inc.url
      ? [{ "@type": "OpenUri", name: "Open in Nova", targets: [{ os: "default", uri: inc.url }] }]
      : undefined,
  }
}

export function makeMsTeamsChannel(
  id: string,
  webhookUrl: string,
  fetchImpl: typeof fetch = fetch
): NotificationChannel {
  return {
    id,
    async notify(event: NovaEvent) {
      if (!webhookUrl) return { status: "skipped" as const, detail: "no webhook url" }
      try {
        const res = await fetchImpl(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(buildTeamsCard(event)),
        })
        return res.ok
          ? { status: "sent" as const, detail: `msteams → ${res.status}` }
          : { status: "error" as const, detail: `msteams returned ${res.status}` }
      } catch (err) {
        return { status: "error" as const, detail: (err as Error).message }
      }
    },
  }
}
