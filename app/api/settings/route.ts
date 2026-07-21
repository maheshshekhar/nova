import { NextResponse } from "next/server"
import { getConfig } from "@/lib/config/loader"
import { getDomain } from "@/lib/domain/loader"
import { buildSettingsView } from "@/lib/settings/view"

// Read-only settings view. Returns a secret-free projection of the resolved
// configuration + active domain for the Settings UI. Config is file-authoritative,
// so this endpoint is GET-only (no edits via the API in this milestone).
export async function GET() {
  const view = buildSettingsView(getConfig(), getDomain(), process.env)
  return NextResponse.json(view)
}
