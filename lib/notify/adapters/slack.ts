import type { NovaEvent } from "../event"
import type { NotificationChannel } from "../channel"

// Slack channel via an Incoming Webhook (tier 1). Posts a compact message with a
// severity emoji, the incident id/service, and (when present) the RCA summary + a
// link. Bot API + interactivity are tier 2 (see docs/notifications-plan.md).

const SEVERITY_EMOJI: Record<string, string> = {
  critical: "🔴",
  high: "🟠",
  medium: "🟡",
  low: "🔵",
}

const ACTION_VERB: Record<string, string> = {
  "incident.opened": "opened",
  "incident.updated": "updated",
  "incident.resolved": "resolved",
  "rca.generated": "RCA ready for",
  "remediation.approved": "remediation approved for",
}

export function formatSlackText(event: NovaEvent): string {
  const inc = event.incident
  const emoji = SEVERITY_EMOJI[inc.severity] ?? "⚪️"
  const verb = ACTION_VERB[event.type] ?? event.type
  const owner = inc.owner ? ` · owner ${inc.owner}` : ""
  const link = inc.url ? ` <${inc.url}|open>` : ""
  const summary = event.summary ? `\n${event.summary}` : ""
  return `${emoji} *${inc.id}* ${verb} — *${inc.severity}* ${inc.service}: ${inc.title}${owner}${link}${summary}`
}

// Block Kit blocks with an "Approve & Run" button for a matched runbook. The
// button value carries the incident id; the interactions endpoint verifies the
// Slack signature + approver allowlist before running anything (see M14c).
export const APPROVE_REMEDIATION_ACTION = "approve_remediation"

export function buildSlackApprovalBlocks(event: NovaEvent, runbookTitle?: string): unknown[] {
  return [
    { type: "section", text: { type: "mrkdwn", text: formatSlackText(event) } },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          style: "primary",
          text: {
            type: "plain_text",
            text: runbookTitle ? `Approve & Run: ${runbookTitle}` : "Approve & Run",
          },
          action_id: APPROVE_REMEDIATION_ACTION,
          value: event.incident.id,
        },
      ],
    },
  ]
}

export function makeSlackChannel(
  id: string,
  webhookUrl: string,
  fetchImpl: typeof fetch = fetch
): NotificationChannel {
  return {
    id,
    async notify(event: NovaEvent) {
      if (!webhookUrl) return { status: "skipped" as const, detail: "no webhook url" }
      try {
        // With a matched actionable runbook, send interactive blocks with an
        // "Approve & Run" button; otherwise a plain text message.
        const payload = event.runbook
          ? { text: formatSlackText(event), blocks: buildSlackApprovalBlocks(event, event.runbook.title) }
          : { text: formatSlackText(event) }
        const res = await fetchImpl(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        })
        return res.ok
          ? { status: "sent" as const, detail: `slack → ${res.status}` }
          : { status: "error" as const, detail: `slack returned ${res.status}` }
      } catch (err) {
        return { status: "error" as const, detail: (err as Error).message }
      }
    },
  }
}
