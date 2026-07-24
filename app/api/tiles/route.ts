import { NextRequest, NextResponse } from "next/server"
import { getConfig } from "@/lib/config/loader"
import { getMetricsSource } from "@/lib/metrics/registry"

export const dynamic = "force-dynamic"

// Server-side executor for PromQL-backed dashboard tiles. The browser references a
// tile ONLY by its `id`; the PromQL lives in server config and is looked up here,
// so arbitrary/free-form queries can never reach Prometheus (SSRF/injection-safe).
// GET /api/tiles?id=<tileId>
export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id")
  if (!id) return NextResponse.json({ error: "missing tile id" }, { status: 400 })

  const cfg = getConfig()
  const tiles = cfg.dashboard.stats.tiles
  if (tiles === "auto" || !Array.isArray(tiles)) {
    return NextResponse.json({ error: "no configured tiles" }, { status: 404 })
  }
  const tile = tiles.find((t) => t.id === id)
  if (!tile) return NextResponse.json({ error: `unknown tile "${id}"` }, { status: 404 })
  if (!tile.query) {
    return NextResponse.json({ error: `tile "${id}" is not a query tile` }, { status: 400 })
  }
  if (cfg.metrics.provider !== "prometheus") {
    return NextResponse.json(
      { error: "query tiles require metrics.provider=prometheus" },
      { status: 400 }
    )
  }

  try {
    const source = getMetricsSource()
    if (typeof source.queryScalar !== "function") {
      return NextResponse.json({ error: "metrics source cannot run queries" }, { status: 400 })
    }
    const value = await source.queryScalar(tile.query)
    return NextResponse.json({ id, value })
  } catch (err: any) {
    return NextResponse.json(
      { id, value: null, error: err.message, fallback: true },
      { status: 503 }
    )
  }
}
