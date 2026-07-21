import { NextResponse } from "next/server"
import { getConfig } from "@/lib/config/loader"
import { verifySlackSignature } from "@/lib/notify/interactive/verify"
import { parseSlackInteraction } from "@/lib/notify/interactive/parse"
import { APPROVE_REMEDIATION_ACTION } from "@/lib/notify/adapters/slack"
import { getIncident } from "@/lib/incident-store"
import { matchStoredRunbook } from "@/lib/runbook-store"
import { executeAction, defaultRegistry } from "@/lib/actions/executor"
import { emitIncidentEvent } from "@/lib/notify/bus"

// Inbound Slack interactivity — an "Approve & Run" button click. Security gates,
// in order: verify the Slack request signature → approver allowlist (RBAC) →
// then run the matched runbook's action through the audited ActionExecutor.
export async function POST(req: Request) {
  const cfg = getConfig().notifications.interactive.slack
  if (!cfg.enabled) {
    return NextResponse.json({ error: "slack interactions disabled" }, { status: 404 })
  }

  const secret = process.env[cfg.signingSecretEnv]
  const raw = await req.text()
  const timestamp = req.headers.get("x-slack-request-timestamp") ?? ""
  const signature = req.headers.get("x-slack-signature") ?? ""
  if (
    !secret ||
    !verifySlackSignature({ signingSecret: secret, timestamp, rawBody: raw, signature })
  ) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 })
  }

  const interaction = parseSlackInteraction(raw)
  if (!interaction) return NextResponse.json({ text: "Unrecognised interaction." })

  // RBAC: only allow-listed Slack users may approve (empty list ⇒ deny all).
  if (!cfg.approvers.includes(interaction.userId)) {
    return NextResponse.json({ text: "You are not authorised to approve remediations." })
  }
  if (interaction.actionId !== APPROVE_REMEDIATION_ACTION) {
    return NextResponse.json({ text: "Unhandled action." })
  }

  const incidentId = interaction.value
  const incident = await getIncident(incidentId)
  if (!incident) return NextResponse.json({ text: `Unknown incident ${incidentId}.` })

  const runbook = matchStoredRunbook(incident.failureType, incident.service)
  if (!runbook?.action) {
    return NextResponse.json({
      text: `No automated runbook for ${incidentId} — approve in the dashboard.`,
    })
  }

  try {
    const result = await executeAction(
      runbook.action,
      { approved: true, actor: `slack:${interaction.userId}`, roles: ["operator"] },
      { registry: defaultRegistry() }
    )
    emitIncidentEvent("remediation.approved", incident)
    return NextResponse.json({ text: `✅ Approved *${runbook.id}* for ${incidentId}: ${result.detail}` })
  } catch (err) {
    return NextResponse.json({ text: `⚠️ ${(err as Error).message}` })
  }
}
