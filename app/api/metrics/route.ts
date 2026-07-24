import { NextResponse } from "next/server"
import { getConfig } from "@/lib/config/loader"
import { getMetricsSource } from "@/lib/metrics/registry"
import { mergeServiceSources, collectorServicesFromPayload } from "@/lib/metrics/inventory"

const METRICS_URL = process.env.METRICS_COLLECTOR_URL || "http://metrics-collector:3001"

// Proxy an endpoint to the custom metrics-collector (k8s inventory: namespaces,
// deployments, and the http-provider service metrics). Returns a 503 fallback
// when the collector is unreachable — the dashboard renders empty states.
async function proxyCollector(endpoint: string, searchParams: URLSearchParams): Promise<Response> {
  searchParams.delete("endpoint")
  const qs = searchParams.toString()
  const target = `${METRICS_URL}/${endpoint}${qs ? `?${qs}` : ""}`
  try {
    const response = await fetch(target, { next: { revalidate: 0 } })
    if (!response.ok) throw new Error(`Metrics collector returned ${response.status}`)
    return NextResponse.json(await response.json())
  } catch (err: any) {
    return NextResponse.json({ error: err.message, fallback: true }, { status: 503 })
  }
}

// Best-effort collector service list, used to enrich Prometheus metrics with pod
// counts AND to union in services Prometheus can't scrape (e.g. CrashLoopBackOff
// pods). Empty when no collector is reachable.
async function collectorServices() {
  try {
    const res = await fetch(`${METRICS_URL}/metrics/services`, { next: { revalidate: 0 } })
    if (!res.ok) return []
    return collectorServicesFromPayload(await res.json())
  } catch {
    return []
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const endpoint = searchParams.get("endpoint") || "metrics"
  const provider = getConfig().metrics.provider

  // ── Prometheus provider ──────────────────────────────────────────────────
  // Per-service metrics come from Prometheus (PromQL), unioned with the
  // collector's k8s inventory: Prometheus services get real pod counts, and
  // services Prometheus can't scrape (crashing pods) are still shown from the
  // collector. Namespace/deployment inventory is also served from the collector.
  if (provider === "prometheus") {
    if (endpoint === "metrics/services") {
      try {
        const [services, collector] = await Promise.all([
          getMetricsSource().getServiceMetrics(),
          collectorServices(),
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
    return proxyCollector(endpoint, searchParams)
  }

  // ── No metrics source configured ─────────────────────────────────────────
  if (provider === "none") {
    return NextResponse.json({ fallback: true }, { status: 503 })
  }

  // ── http provider (default): proxy the custom metrics-collector ──────────
  return proxyCollector(endpoint, searchParams)
}
