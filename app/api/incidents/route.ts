import { NextRequest, NextResponse } from "next/server"
import { listIncidents, createIncident } from "@/lib/incident-store"
import type {
  IncidentFilter,
  IncidentRange,
  IncidentSeverity,
  FailureType,
  IncidentStatus,
} from "@/lib/incident-types"

// Never cache — the store is the source of truth and changes at runtime.
export const dynamic = "force-dynamic"

// GET /api/incidents?range=week&service=payment-service&severity=critical&failureType=OOMKilled&from=<ms>&to=<ms>
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  const filter: IncidentFilter = {}

  const range = sp.get("range")
  if (range) filter.range = range as IncidentRange
  const from = sp.get("from")
  if (from) filter.from = Number(from)
  const to = sp.get("to")
  if (to) filter.to = Number(to)
  const service = sp.get("service")
  if (service) filter.service = service
  const severity = sp.get("severity")
  if (severity) filter.severity = severity as IncidentSeverity
  const failureType = sp.get("failureType")
  if (failureType) filter.failureType = failureType as FailureType
  const status = sp.get("status")
  if (status) filter.status = status as IncidentStatus

  const incidents = await listIncidents(filter)
  return NextResponse.json({ incidents, count: incidents.length })
}

// POST /api/incidents — create a new (live) incident record.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  if (!body || !body.title || !body.service || !body.severity || !body.failureType) {
    return NextResponse.json(
      { error: "title, service, severity and failureType are required" },
      { status: 400 }
    )
  }

  const incident = await createIncident({
    id: body.id,
    title: body.title,
    severity: body.severity,
    service: body.service,
    status: body.status,
    failureType: body.failureType,
    startedAt: body.startedAt,
    affectedUsers: body.affectedUsers,
    description: body.description ?? "",
    timeline: body.timeline,
    relatedLogs: body.relatedLogs,
    rca: body.rca ?? null,
  })

  return NextResponse.json({ incident }, { status: 201 })
}
