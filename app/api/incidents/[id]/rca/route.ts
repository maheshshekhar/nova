import { NextRequest, NextResponse } from "next/server"
import { saveRca, getIncident } from "@/lib/incident-store"
import { fetchCollectorLogs } from "@/lib/logs/server-log-source"
import { selectIncidentLogEntries } from "@/lib/log-selection"

export const dynamic = "force-dynamic"

// POST /api/incidents/:id/rca — persist a generated RCA document for an incident.
// Body: { text: string, provider?: string, generatedAt?: string, additionalDetails?: string }
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const body = await req.json().catch(() => null)
  if (!body || typeof body.text !== "string" || !body.text.trim()) {
    return NextResponse.json({ error: "rca text is required" }, { status: 400 })
  }

  // Prefer the EXACT logs the client generated the RCA from (same order IDs /
  // timestamps as the document) so the incident eval grades against real evidence.
  // Fall back to a server-side re-pull only when the client didn't send them —
  // note a re-pull captures DIFFERENT log lines (the load-generator emits fresh
  // random order IDs), which is why it must not override the generation logs.
  let logsSnapshot: { timestamp: string; level: string; message: string; pod: string }[] | undefined
  if (Array.isArray(body?.logsSnapshot) && body.logsSnapshot.length) {
    logsSnapshot = body.logsSnapshot
      .filter((l: any) => l && typeof l.message === "string")
      .map((l: any) => ({
        timestamp:
          typeof l.timestamp === "string" ? l.timestamp : new Date(l.timestamp ?? Date.now()).toISOString(),
        level: (l.level || "INFO").toString().toUpperCase(),
        message: l.message,
        pod: typeof l.pod === "string" ? l.pod : "",
      }))
  } else {
    try {
      const existing = await getIncident(id)
      if (existing?.service) {
        const real = await fetchCollectorLogs(existing.service, existing.startedAt || undefined)
        const entries = selectIncidentLogEntries(real, { budget: 40 })
        if (entries.length) {
          logsSnapshot = entries.map(({ entry }) => ({
            timestamp: typeof entry.timestamp === "string" ? entry.timestamp : new Date(entry.timestamp ?? Date.now()).toISOString(),
            level: (entry.level || "INFO").toUpperCase(),
            message: entry.message,
            pod: entry.pod || "",
          }))
        }
      }
    } catch {
      // Snapshot is best-effort — never block persisting the RCA text.
    }
  }

  const incident = await saveRca(id, {
    text: body.text,
    provider: typeof body.provider === "string" ? body.provider : "ai",
    generatedAt: typeof body.generatedAt === "string" ? body.generatedAt : new Date().toISOString(),
    ...(typeof body.additionalDetails === "string" && body.additionalDetails.trim()
      ? { additionalDetails: body.additionalDetails }
      : {}),
    ...(typeof body.context === "string" && body.context.trim() ? { context: body.context } : {}),
    ...(logsSnapshot ? { logsSnapshot } : {}),
  })

  if (!incident) {
    return NextResponse.json({ error: `Incident ${id} not found` }, { status: 404 })
  }
  return NextResponse.json({ incident })
}

// GET /api/incidents/:id/rca — fetch just the stored RCA (or 404 if none yet).
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const incident = await getIncident(id)
  if (!incident) {
    return NextResponse.json({ error: `Incident ${id} not found` }, { status: 404 })
  }
  return NextResponse.json({ id, rca: incident.rca })
}
