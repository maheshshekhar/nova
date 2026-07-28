import { NextRequest, NextResponse } from "next/server"
import { listIncidents, createIncident } from "@/lib/incident-store"
import type { FailureType, IncidentSeverity, SentinelEvidence } from "@/lib/incident-types"

/** Parse Nova Sentinel's structured evidence annotation (best-effort). */
function parseEvidence(raw?: string): SentinelEvidence[] | undefined {
  if (!raw) return undefined
  try {
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return undefined
    const out = arr
      .filter((e) => e && typeof e.kind === "string" && typeof e.message === "string")
      .map((e) => ({
        kind: String(e.kind),
        message: String(e.message),
        severity: String(e.severity ?? "warning"),
        hard: !!e.hard,
      }))
    return out.length ? out : undefined
  } catch {
    return undefined
  }
}

// Alertmanager webhook. The Loki ruler fires ERROR-spike alerts (per service),
// Alertmanager batches and POSTs them here, and we open a live incident — but
// only if one isn't already open for that service. This idempotency is what lets
// the log-driven path coexist with the deterministic inject scripts without ever
// producing duplicate incidents for the same outage.
export const dynamic = "force-dynamic"

interface AmAlert {
  status?: string
  labels?: Record<string, string>
  annotations?: Record<string, string>
  startsAt?: string
}

const SEVERITIES: IncidentSeverity[] = ["critical", "high", "medium", "low"]

function toSeverity(v?: string): IncidentSeverity {
  const s = (v || "").toLowerCase()
  return (SEVERITIES.includes(s as IncidentSeverity) ? s : "high") as IncidentSeverity
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  const alerts: AmAlert[] = Array.isArray(body?.alerts) ? body.alerts : []
  if (!alerts.length) {
    return NextResponse.json({ received: 0, results: [] }, { status: 200 })
  }

  const results: { service: string; id: string; created: boolean }[] = []

  for (const alert of alerts) {
    // Only act on firing alerts — recovery is handled by the remediate flow.
    if (alert.status && alert.status !== "firing") continue

    const labels = alert.labels || {}
    const service = labels.service || labels.app
    if (!service) continue

    // Idempotency: skip if a non-resolved live incident already exists for this
    // service (from an inject script or an earlier alert in this batch).
    const forService = await listIncidents({ service })
    const existing = forService.find(
      (i) => i.origin === "live" && i.status !== "resolved"
    )
    if (existing) {
      results.push({ service, id: existing.id, created: false })
      continue
    }

    const severity = toSeverity(labels.severity)
    const failureType = (labels.failure_type as FailureType) || "latency-slo"
    const title =
      alert.annotations?.summary || `${service} — elevated error rate detected in logs`
    const description =
      alert.annotations?.description ||
      `Loki ruler detected a sustained spike of ERROR log lines for ${service}.`
    const parsedStart = alert.startsAt ? new Date(alert.startsAt).getTime() : NaN
    const startedAt = Number.isNaN(parsedStart) ? Date.now() : parsedStart

    const evidence = parseEvidence(alert.annotations?.nova_signals)
    const confRaw = Number(alert.annotations?.nova_confidence)
    const confidence = Number.isFinite(confRaw) && confRaw > 0 ? confRaw : undefined

    const incident = await createIncident({
      title,
      severity,
      service,
      failureType,
      startedAt,
      description,
      detectedBy: labels.source,
      evidence,
      confidence,
    })
    results.push({ service, id: incident.id, created: true })
  }

  return NextResponse.json({ received: alerts.length, results }, { status: 200 })
}
