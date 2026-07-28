import { NextResponse } from "next/server"
import { getConfig } from "@/lib/config/loader"
import { getMetricsSource } from "@/lib/metrics/registry"
import { mergeServiceSources, collectorServicesFromPayload } from "@/lib/metrics/inventory"
import { SingleFlightCache } from "@/lib/metrics/cache"
import { resolveCollectorUrl } from "@/lib/metrics/collector-url"
import { getKubernetesReader } from "@/lib/metrics/kube-client"
import type { ClusterState } from "@/lib/metrics/kubernetes-reader"

// Coalesce upstream calls: many open dashboards polling at once share ONE call
// to Prometheus / the collector per key within this window (back-pressure at
// scale). Short TTL so a single client's poll cadence still sees fresh data.
const CACHE_TTL_MS = 1000
const cache = new SingleFlightCache(CACHE_TTL_MS)

// Map a native ClusterState onto the endpoint slice the dashboard requested
// (mirrors the collector's /metrics, /metrics/services|namespaces|deployments).
function sliceState(state: ClusterState, endpoint: string): unknown {
  switch (endpoint) {
    case "metrics/services":
      return { services: state.services, timestamp: state.timestamp, lastUpdated: state.lastUpdated }
    case "metrics/namespaces":
      return { namespaces: state.namespaces, timestamp: state.timestamp, lastUpdated: state.lastUpdated }
    case "metrics/deployments":
      return { deployments: state.deployments, timestamp: state.timestamp, lastUpdated: state.lastUpdated }
    default:
      return state
  }
}

/** Read the cluster once (coalesced) via the in-process native reader. */
function nativeClusterState(): Promise<ClusterState> {
  return cache.get("native:cluster", () => getKubernetesReader().readClusterState())
}

// Proxy an endpoint to the custom metrics-collector (legacy `http` provider).
// Returns a 503 fallback when the collector is unreachable — the dashboard
// renders empty states.
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

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const endpoint = searchParams.get("endpoint") || "metrics"
  const metrics = getConfig().metrics
  const provider = metrics.provider

  // ── Prometheus provider ──────────────────────────────────────────────────
  // Per-service metrics come from Prometheus (PromQL), unioned with Nova's native
  // k8s inventory: Prometheus services get real pod counts, and services
  // Prometheus can't scrape (crashing pods) are still shown. Namespace/deployment
  // inventory comes from the native reader too.
  if (provider === "prometheus") {
    if (endpoint === "metrics/services") {
      try {
        const [services, state] = await Promise.all([
          cache.get("prom:services", () => getMetricsSource().getServiceMetrics()),
          nativeClusterState(),
        ])
        return NextResponse.json({
          services: mergeServiceSources(services, collectorServicesFromPayload({ services: state.services })),
          lastUpdated: Date.now(),
        })
      } catch (err: any) {
        return NextResponse.json({ error: err.message, fallback: true }, { status: 503 })
      }
    }
    // namespaces / deployments → native k8s inventory, best-effort.
    try {
      return NextResponse.json(sliceState(await nativeClusterState(), endpoint))
    } catch (err: any) {
      return NextResponse.json({ error: err.message, fallback: true }, { status: 503 })
    }
  }

  // ── No metrics source configured ─────────────────────────────────────────
  if (provider === "none") {
    return NextResponse.json({ fallback: true }, { status: 503 })
  }

  // ── http provider (legacy): proxy the external metrics-collector sidecar ──
  if (provider === "http") {
    const collectorBase = resolveCollectorUrl(metrics)
    return proxyCollector(collectorBase, endpoint, searchParams)
  }

  // ── kubernetes provider (default): read the cluster in-process (no sidecar) ─
  try {
    return NextResponse.json(sliceState(await nativeClusterState(), endpoint))
  } catch (err: any) {
    return NextResponse.json({ error: err.message, fallback: true }, { status: 503 })
  }
}
