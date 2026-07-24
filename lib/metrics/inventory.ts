import type { RealServiceMetric } from "@/hooks/use-real-metrics"

// Parse the collector's /metrics/services payload into RealServiceMetric[].
// Tolerant of missing fields. The collector provides pod counts + CPU/mem/status/
// errorRate (from the k8s API) but no latency — those fields stay absent.
export function collectorServicesFromPayload(payload: unknown): RealServiceMetric[] {
  const raw = (payload as { services?: unknown })?.services
  if (!Array.isArray(raw)) return []
  const out: RealServiceMetric[] = []
  for (const item of raw) {
    const s = item as Record<string, unknown>
    if (typeof s.name !== "string") continue
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0)
    const status = s.status === "critical" || s.status === "degraded" ? s.status : "healthy"
    out.push({
      name: s.name,
      namespace: typeof s.namespace === "string" ? s.namespace : undefined,
      podCount: num(s.podCount),
      readyPods: num(s.readyPods),
      crashedPods: num(s.crashedPods),
      avgCpu: num(s.avgCpu),
      avgMemory: num(s.avgMemory),
      status,
      errorRate: num(s.errorRate),
    })
  }
  return out
}

// Combine Prometheus service metrics with the collector's k8s inventory:
//   1. Prometheus services are enriched with the collector's pod counts
//      (Prometheus has no pod-count concept).
//   2. Collector-only services — those Prometheus can't see, e.g. a pod in
//      CrashLoopBackOff that can't be scraped — are UNIONED in so the most
//      important service during an incident never disappears from the table.
// Prometheus stays the source of truth for rich metrics (latency/rps) on the
// services it can scrape. With no collector, only the Prometheus services show.
export function mergeServiceSources(
  promServices: RealServiceMetric[],
  collectorServices: RealServiceMetric[]
): RealServiceMetric[] {
  const collectorByName = new Map(collectorServices.map((s) => [s.name, s]))
  const promNames = new Set(promServices.map((s) => s.name))

  const enriched = promServices.map((s) => {
    const c = collectorByName.get(s.name)
    return c
      ? { ...s, podCount: c.podCount, readyPods: c.readyPods, crashedPods: c.crashedPods }
      : s
  })
  const collectorOnly = collectorServices.filter((s) => !promNames.has(s.name))
  return [...enriched, ...collectorOnly]
}
