import "server-only"
import type { RealServiceMetric } from "@/hooks/use-real-metrics"
import { getDescriptor, evaluateHealth, type HealthLevel } from "./descriptors"
import { NUMERIC_METRIC_KEYS, type MetricsSource, type NumericMetricKey } from "./source"

// Prometheus metrics adapter (server-only). Nova is a PromQL CLIENT — it queries
// an existing Prometheus, it never scrapes. The operator supplies a query map
// (metric key → PromQL); each expression must return an instant vector labelled
// by `serviceLabel`. This adapter runs them, groups results by service, and maps
// them into the dashboard's `RealServiceMetric` shape. Domain-agnostic: no
// service name or query is hardcoded.
//
// Throws on a network/HTTP failure so the route can return a 503/offline state.

export interface PrometheusSourceOptions {
  /** Base Prometheus URL, e.g. http://prometheus:9090 (no trailing slash needed). */
  url: string
  /** Optional bearer token (already resolved from its env var by the caller). */
  authToken?: string
  /** PromQL label that identifies the service in query results (e.g. "service"). */
  serviceLabel: string
  /** metric key → PromQL instant-vector expression. */
  queries: Record<string, string>
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch
}

interface PromVectorResult {
  metric: Record<string, string>
  value: [number, string]
}

interface PromQueryResponse {
  status?: string
  data?: { resultType?: string; result?: PromVectorResult[] }
}

const isNumericKey = (k: string): k is NumericMetricKey =>
  (NUMERIC_METRIC_KEYS as readonly string[]).includes(k)

const round = (n: number) => Math.round(n)
const round2 = (n: number) => Math.round(n * 100) / 100

// Combine two health levels, keeping the worst (critical > warn > healthy).
function worstLevel(a: HealthLevel, b: HealthLevel): HealthLevel {
  if (a === "critical" || b === "critical") return "critical"
  if (a === "warn" || b === "warn") return "warn"
  if (a === "healthy" || b === "healthy") return "healthy"
  return "unknown"
}

// Derive a coarse status from the signals Prometheus can give us (error rate +
// p95 latency), using the descriptor thresholds so it matches the rest of the UI.
function derivePromStatus(
  errorRate: number,
  latencyP95: number | undefined
): RealServiceMetric["status"] {
  const errLevel = evaluateHealth(getDescriptor("errorRate"), errorRate)
  const latLevel =
    latencyP95 !== undefined ? evaluateHealth(getDescriptor("latencyP95"), latencyP95) : "unknown"
  const worst = worstLevel(errLevel, latLevel)
  return worst === "critical" ? "critical" : worst === "warn" ? "degraded" : "healthy"
}

export class PrometheusMetricsSource implements MetricsSource {
  constructor(private readonly opts: PrometheusSourceOptions) {}

  private async instant(query: string): Promise<PromVectorResult[]> {
    const doFetch = this.opts.fetchImpl ?? fetch
    const params = new URLSearchParams({ query })
    const headers: Record<string, string> = {}
    if (this.opts.authToken) headers.Authorization = `Bearer ${this.opts.authToken}`
    const base = this.opts.url.replace(/\/$/, "")
    const res = await doFetch(`${base}/api/v1/query?${params.toString()}`, {
      cache: "no-store",
      headers,
    })
    if (!res.ok) throw new Error(`Prometheus query failed: ${res.status}`)
    const data = (await res.json()) as PromQueryResponse
    if (data?.status !== "success") return []
    // A scalar query returns `data.result = [ts, "value"]` with resultType
    // "scalar"; a vector returns an array of rows. Normalise scalar → vector.
    const result = data.data?.result
    if (data.data?.resultType === "scalar" && Array.isArray(result) && result.length === 2) {
      return [{ metric: {}, value: result as unknown as [number, string] }]
    }
    if (!Array.isArray(result)) return []
    return result as PromVectorResult[]
  }

  /** Run one PromQL expression and return a single scalar (first result's value),
   * or null when the query yields nothing. Used by the /api/tiles executor. */
  async queryScalar(promql: string): Promise<number | null> {
    const rows = await this.instant(promql)
    if (rows.length === 0) return null
    const raw = Number(rows[0].value?.[1])
    return Number.isFinite(raw) ? raw : null
  }

  async getServiceMetrics(): Promise<RealServiceMetric[]> {
    const svcLabel = this.opts.serviceLabel
    const entries = Object.entries(this.opts.queries).filter(([k]) => isNumericKey(k)) as [
      NumericMetricKey,
      string,
    ][]

    // Run every configured query; group each result row by its service label.
    const results = await Promise.all(
      entries.map(async ([key, promql]) => ({ key, rows: await this.instant(promql) }))
    )

    const byService = new Map<string, Partial<Record<NumericMetricKey, number>>>()
    for (const { key, rows } of results) {
      for (const row of rows) {
        const svc = row.metric?.[svcLabel]
        if (!svc) continue
        const val = Number(row.value?.[1])
        if (!Number.isFinite(val)) continue
        const bucket = byService.get(svc) ?? {}
        bucket[key] = val
        byService.set(svc, bucket)
      }
    }

    const out: RealServiceMetric[] = []
    for (const [name, f] of byService) {
      const errorRate = f.errorRate ?? 0
      out.push({
        name,
        podCount: f.podCount ?? 0,
        readyPods: f.readyPods ?? 0,
        crashedPods: f.crashedPods ?? 0,
        avgCpu: round(f.avgCpu ?? 0),
        avgMemory: round(f.avgMemory ?? 0),
        errorRate: round2(errorRate),
        status: derivePromStatus(errorRate, f.latencyP95),
        ...(f.latencyP50 !== undefined ? { latencyP50: round(f.latencyP50) } : {}),
        ...(f.latencyP95 !== undefined ? { latencyP95: round(f.latencyP95) } : {}),
        ...(f.latencyP99 !== undefined ? { latencyP99: round(f.latencyP99) } : {}),
        ...(f.rps !== undefined ? { rps: round2(f.rps) } : {}),
      })
    }
    out.sort((a, b) => a.name.localeCompare(b.name))
    return out
  }
}
