import { NextResponse } from "next/server"
import { getConfig } from "@/lib/config/loader"
import { buildDashboardConfigView } from "@/lib/dashboard/config-view"

// Read-only, secret-free projection of the resolved `dashboard` config for the
// browser. Config is file-authoritative, so this endpoint is GET-only. The
// dashboard is source-driven; this only tells the UI how to *present* real data.
export async function GET() {
  return NextResponse.json(buildDashboardConfigView(getConfig().dashboard))
}
