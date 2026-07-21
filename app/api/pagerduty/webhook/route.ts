import { NextResponse } from "next/server"
import { getConfig } from "@/lib/config/loader"
import { verifyPagerDutySignature } from "@/lib/notify/interactive/verify"
import { parsePagerDutyWebhook } from "@/lib/notify/interactive/parse"
import { resolveIncident, updateIncident } from "@/lib/incident-store"

// Inbound PagerDuty v3 webhook — syncs an acknowledge/resolve in PagerDuty back to
// the Nova incident. The request signature is verified before any state change;
// the Nova incident id is carried in the PD incident's dedup_key (set on trigger).
export async function POST(req: Request) {
  const cfg = getConfig().notifications.interactive.pagerduty
  if (!cfg.enabled) {
    return NextResponse.json({ error: "pagerduty webhook disabled" }, { status: 404 })
  }

  const secret = process.env[cfg.secretEnv]
  const raw = await req.text()
  const signatureHeader = req.headers.get("x-pagerduty-signature") ?? ""
  if (!secret || !verifyPagerDutySignature({ secret, rawBody: raw, signatureHeader })) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 })
  }

  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 })
  }

  const intent = parsePagerDutyWebhook(body)
  if (intent.incidentId) {
    if (intent.statusChange === "resolved") {
      await resolveIncident(intent.incidentId)
    } else if (intent.statusChange === "acknowledged") {
      await updateIncident(intent.incidentId, { status: "investigating" })
    }
  }

  return NextResponse.json({ ok: true, applied: intent.statusChange ?? "ignored" })
}
