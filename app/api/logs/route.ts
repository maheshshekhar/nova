import { NextResponse } from "next/server"
import { getLogSource } from "@/lib/logs/registry"
import { getConfig } from "@/lib/config/loader"
import { resolveScope, type LogScope } from "@/lib/logs/scope"
import { LogScopeSchema } from "@/lib/config/schema"

// Log query proxy. The browser cannot reach Loki directly (no LOKI_URL, CORS), so
// the client log source and useRealLogs hit this route, which runs the LogQL
// query server-side. On a Loki failure it returns { fallback: true } so the UI
// degrades gracefully — mirroring the old metrics-collector proxy semantics.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const service = searchParams.get("service")?.trim() || undefined

  const sinceParam = searchParams.get("since")
  const untilParam = searchParams.get("until")
  const limitParam = searchParams.get("limit")
  const levelsParam = searchParams.get("levels")
  const scopeParam = searchParams.get("scope")

  const startMs = sinceParam ? Number(sinceParam) : Date.now() - 60 * 60 * 1000
  const endMs = untilParam ? Number(untilParam) : Date.now()
  const limit = limitParam ? Number(limitParam) : 5000
  const levels = levelsParam
    ? levelsParam.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined

  const cfg = getConfig().logs

  // A query-time scope override (from the UI picker / an incident) is a
  // JSON-serialized LogScope; ignore it if it doesn't parse against the schema so
  // a malformed param can never break the log view.
  let override: LogScope | undefined
  if (scopeParam) {
    try {
      override = LogScopeSchema.parse(JSON.parse(scopeParam))
    } catch {
      override = undefined
    }
  }

  const scope = resolveScope({ override, config: cfg.scope })

  try {
    const logs = await getLogSource().queryLogs({
      service,
      startMs,
      endMs,
      levels,
      limit,
      scope,
      fields: cfg.fields,
    })
    return NextResponse.json({ logs, service: service || "all", available: true })
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "log backend unavailable", fallback: true, logs: [] },
      { status: 503 }
    )
  }
}
