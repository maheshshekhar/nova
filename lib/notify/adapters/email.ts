import type { NovaEvent } from "../event"
import type { NotificationChannel } from "../channel"

// Email channel over SMTP. The transport is injected (an `EmailTransport`) so the
// adapter is testable without a real mail server; the registry supplies a
// nodemailer-backed transport built from the SMTP URL. Never throws.

export interface EmailMessage {
  from: string
  to: string[]
  subject: string
  text: string
}

export interface EmailTransport {
  sendMail(message: EmailMessage): Promise<unknown>
}

const VERB: Record<string, string> = {
  "incident.opened": "opened",
  "incident.updated": "updated",
  "incident.resolved": "resolved",
  "rca.generated": "RCA ready",
  "remediation.approved": "remediation approved",
}

export function formatEmail(event: NovaEvent): { subject: string; text: string } {
  const inc = event.incident
  const verb = VERB[event.type] ?? event.type
  const subject = `[Nova] ${inc.severity.toUpperCase()} ${inc.id} ${verb}: ${inc.title}`
  const lines = [
    `Incident: ${inc.id}`,
    `Title:    ${inc.title}`,
    `Service:  ${inc.service}`,
    `Severity: ${inc.severity}`,
    `Status:   ${inc.status}`,
  ]
  if (inc.owner) lines.push(`Owner:    ${inc.owner}`)
  if (inc.url) lines.push(`Link:     ${inc.url}`)
  if (event.summary) lines.push("", event.summary)
  return { subject, text: lines.join("\n") }
}

export function makeEmailChannel(
  id: string,
  transport: EmailTransport,
  opts: { from: string; to: string[] }
): NotificationChannel {
  return {
    id,
    async notify(event: NovaEvent) {
      try {
        const { subject, text } = formatEmail(event)
        await transport.sendMail({ from: opts.from, to: opts.to, subject, text })
        return { status: "sent" as const, detail: `email → ${opts.to.join(", ")}` }
      } catch (err) {
        return { status: "error" as const, detail: (err as Error).message }
      }
    },
  }
}
