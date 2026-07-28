import { NextRequest, NextResponse } from "next/server"
import { getSentinelStatus, setSentinelStatus } from "@/lib/sentinel/status-store"
import { statusView } from "@/lib/sentinel/status"

// Nova Sentinel heartbeat endpoint. The companion POSTs its liveness/mode here
// every ~30s; the dashboard GETs it to show a status indicator.
export const dynamic = "force-dynamic"

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== "object") {
    return NextResponse.json({ ok: false }, { status: 400 })
  }
  setSentinelStatus({
    dryRun: !!body.dryRun,
    scope: typeof body.scope === "string" && body.scope ? body.scope : "all",
    logs: !!body.logs,
    updatedAt: Date.now(),
  })
  return NextResponse.json({ ok: true })
}

export async function GET() {
  return NextResponse.json({ status: statusView(getSentinelStatus(), Date.now()) })
}
