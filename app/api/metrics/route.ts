import { NextResponse } from "next/server"
import { getConfig } from "@/lib/config/loader"
import { getMetricsSource } from "@/lib/metrics/registry"
import { mergeServiceSources, collectorServicesFromPayload } from "@/lib/metrics/inventory"
import { SingleFlightCache } from "@/lib/metrics/cache"
import { resolveCollectorUrl } from "@/lib/metrics/collector-url"

// Coalesce upstream calls: many open dashboards polling at once share ONE call
// to Prometheus / the collector per key within this window (back-pressure at
// scale). Short TTL so a single client's poll cadence still sees fresh data.
const CACHE_TTL_MS = 1000
const cache = new SingleFlightCache(CACHE_TTL_MS)

// Proxy an endpoint to the custom metrics-collector (k8s inventory: namespaces,
// deployments, and the http-provider service metrics). Returns a 503 fallback
// when the collector is unreachable — the dashboard renders empty states.
async function proxyCollector(
  base: string,
  endpoint: string,
  searchParams: URLSearchParams
): Promise<Response> {
  searchParams.delete("endpoint")
  const qs = searchParams.toString()
  const target = `${base}/${endpoint}${qs ? `?${qs}` : ""}`
  try {
    const data = await cache.get(`collector:${endpoint}:${qs}`, async () => {
      const response = await fetch(target, { next: { revalidate: 0 } })
      if (!response.ok) throw new Error(`Metrics collector returned ${response.status}`)
      return response.json()
    })
    return NextResponse.json(data)
  } catch (err: any) {
    return NextResponse.json({ error: err.message, fallback: true }, { status: 503 })
  }
}

// Best-effort collector service list, used to enrich Prometheus metrics with pod
// counts AND to union in services Prometheus can't scrape (e.g. CrashLoopBackOff
// pods). Empty when no collector is reachable.
async function collectorServices(base: string) {
  try {
    return await cache.get("collector:services-parsed", async () => {
      const res = await fetch(`${base}/metrics/services`, { next: { revalidate: 0 } })
      if (!res.ok) return []
      return collectorServicesFromPayload(await res.json())
    })
  } catch {
    return []
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const endpoint = searchParams.get("endpoint") || "metrics"
  const metrics = getConfig().metrics
  const provider = metrics.provider
  // Single source of truth: the collector endpoint comes from config, not env.
  const collectorBase = resolveCollectorUrl(metrics)

  // ── Prometheus provider ──────────────────────────────────────────────────
  // Per-service metrics come from Prometheus (PromQL), unioned with the
  // collector's k8s inventory: Prometheus services get real pod counts, and
  // services Prometheus can't scrape (crashing pods) are still shown from the
  // collector. Namespace/deployment inventory is also served from the collector.
  if (provider === "prometheus") {
    if (endpoint === "metrics/services") {
      try {
        const [services, collector] = await Promise.all([
          cache.get("prom:services", () => getMetricsSource().getServiceMetrics()),
          collectorServices(collectorBase),
        ])
        return NextResponse.json({
          services: mergeServiceSources(services, collector),
          lastUpdated: Date.now(),
        })
      } catch (err: any) {
        return NextResponse.json({ error: err.message, fallback: true }, { status: 503 })
      }
    }
    // namespaces / deployments → collector (k8s inventory), best-effort.
    return proxyCollector(collectorBase, endpoint, searchParams)
  }

  // ── No metrics source configured ─────────────────────────────────────────
  if (provider === "none") {
    return NextResponse.json({ fallback: true }, { status: 503 })
  }

  // ── kubernetes / http provider (default): proxy the k8s metrics-collector ──
  // (`http` is a legacy alias for `kubernetes`; both read pod/workload health
  // from the collector today — superseded by Nova's informer reader in B0/B1.)
  return proxyCollector(collectorBase, endpoint, searchParams)
}
