import { NextRequest, NextResponse } from "next/server"
import { getIncident, updateIncident, resolveIncident } from "@/lib/incident-store"

export const dynamic = "force-dynamic"

// GET /api/incidents/:id — full incident record (including RCA if present).
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const incident = await getIncident(id)
  if (!incident) {
    return NextResponse.json({ error: `Incident ${id} not found` }, { status: 404 })
  }
  return NextResponse.json({ incident })
}

// PATCH /api/incidents/:id — update status / resolve / attach RCA or logs.
// Body may include: { status, resolvedAt, resolve: true, affectedUsers, rca, timeline, relatedLogs }.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const body = await req.json().catch(() => ({} as Record<string, unknown>))

  // Convenience: { resolve: true } marks resolved with a server timestamp.
  const incident =
    body.resolve === true
      ? await resolveIncident(id, typeof body.resolvedAt === "number" ? body.resolvedAt : undefined)
      : await updateIncident(id, {
          status: body.status,
          resolvedAt: body.resolvedAt,
          affectedUsers: body.affectedUsers,
          rca: body.rca,
          timeline: body.timeline,
          relatedLogs: body.relatedLogs,
        })

  if (!incident) {
    return NextResponse.json({ error: `Incident ${id} not found` }, { status: 404 })
  }
  return NextResponse.json({ incident })
}
