import { NextResponse } from "next/server"
import { getConfig } from "@/lib/config/loader"
import { getMetricsSource } from "@/lib/metrics/registry"

// Metrics API. Resolves `config.metrics.provider`:
//   • http (default) → proxy every endpoint to the metrics-collector, unchanged.
//   • prometheus     → per-service metrics come from the PromQL adapter; the
//                      pod-inventory endpoints (namespaces/deployments) still
//                      proxy to the collector when one is present (best-effort).
//   • none           → 503 fallback (the dashboard shows its empty states).

const COLLECTOR_URL = process.env.METRICS_COLLECTOR_URL || "http://metrics-collector:3001"

async function proxyToCollector(endpoint: string, qs: string): Promise<unknown> {
  const target = `${COLLECTOR_URL}/${endpoint}${qs ? `?${qs}` : ""}`
  const response = await fetch(target, { next: { revalidate: 0 } })
  if (!response.ok) {
    throw new Error(`Metrics collector returned ${response.status}`)
  }
  return response.json()
}

function fallback(message: string) {
  // Null-ish data so the dashboard falls back to its empty states.
  return NextResponse.json({ error: message, fallback: true }, { status: 503 })
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const endpoint = searchParams.get("endpoint") || "metrics"
  // Forward any remaining query params (e.g. ?service=config-service).
  searchParams.delete("endpoint")
  const qs = searchParams.toString()

  const provider = getConfig().metrics.provider

  if (provider === "none") {
    return fallback("metrics provider is 'none'")
  }

  try {
    // The Prometheus source owns per-service RED metrics. Pod inventory
    // (namespaces/deployments) still comes from the k8s collector when present.
    if (provider === "prometheus" && (endpoint === "metrics/services" || endpoint === "metrics")) {
      const result = await getMetricsSource().getServiceMetrics()
      if (endpoint === "metrics/services") return NextResponse.json(result)
      // Bare "metrics": merge best-effort pod inventory from the collector.
      const inventory = await proxyToCollector("metrics", qs).catch(() => ({}))
      return NextResponse.json({ ...(inventory as object), ...result })
    }

    // http provider (default) and all inventory endpoints → proxy unchanged.
    const data = await proxyToCollector(endpoint, qs)
    return NextResponse.json(data)
  } catch (err: any) {
    return fallback(err?.message ?? "metrics unavailable")
  }
}
