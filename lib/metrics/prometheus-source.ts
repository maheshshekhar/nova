import "server-only"
import type { MetricsSignals } from "@/lib/config/schema"
import {
  SIGNAL_KEYS,
  type MetricsSource,
  type RealServiceMetric,
  type ServiceMetricsResult,
  type SignalKey,
} from "./source"

// Prometheus metrics adapter (server-only). Runs the config-declared PromQL for
// each semantic signal via the instant-query API (`/api/v1/query`), groups the
// resulting series by the configured `serviceLabel`, and assembles one
// `RealServiceMetric` per service.
//
// SSRF-safe by construction: the target host comes only from `metrics.url`
// (config, allowlisted) and the queries come only from `metrics.signals` (config)
// — never from the browser or the LLM. Queries always run server-side.

export interface PrometheusMetricsSourceOptions {
  url: string
  serviceLabel: string
  signals: MetricsSignals
  /** Bearer token value (already resolved from `authTokenEnv`). */
  authToken?: string
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch
}

interface PromVectorResult {
  metric: Record<string, string>
  value: [number, string]
}

const round2 = (n: number) => Math.round(n * 100) / 100

function deriveStatus(errorRate: number): RealServiceMetric["status"] {
  if (errorRate > 3) return "critical"
  if (errorRate > 0.5) return "degraded"
  return "healthy"
}

export class PrometheusMetricsSource implements MetricsSource {
  constructor(private readonly opts: PrometheusMetricsSourceOptions) {}

  async getServiceMetrics(): Promise<ServiceMetricsResult> {
    const { serviceLabel, signals } = this.opts
    const doFetch = this.opts.fetchImpl ?? fetch

    // Only run the signals that have a configured query.
    const queries = SIGNAL_KEYS.map((key) => ({ key, query: signals[key] })).filter(
      (q): q is { key: SignalKey; query: string } =>
        typeof q.query === "string" && q.query.trim().length > 0
    )

    const results = await Promise.all(
      queries.map(async ({ key, query }) => ({
        key,
        vector: await this.instantQuery(query, doFetch),
      }))
    )

    const byService = new Map<string, RealServiceMetric>()
    const ensure = (name: string): RealServiceMetric => {
      let m = byService.get(name)
      if (!m) {
        m = {
          name,
          podCount: 0,
          readyPods: 0,
          crashedPods: 0,
          avgCpu: 0,
          avgMemory: 0,
          status: "healthy",
          errorRate: 0,
        }
        byService.set(name, m)
      }
      return m
    }

    for (const { key, vector } of results) {
      for (const row of vector) {
        const svc = row.metric[serviceLabel]
        if (!svc) continue
        const val = Number(row.value?.[1])
        if (!Number.isFinite(val)) continue
        ensure(svc)[key] = round2(val)
      }
    }

    for (const m of byService.values()) {
      m.status = deriveStatus(m.errorRate)
    }

    const services = [...byService.values()].sort((a, b) => a.name.localeCompare(b.name))
    const now = Date.now()
    return { services, timestamp: new Date(now).toISOString(), lastUpdated: now }
  }

  private async instantQuery(query: string, doFetch: typeof fetch): Promise<PromVectorResult[]> {
    const base = this.opts.url.replace(/\/$/, "")
    const target = `${base}/api/v1/query?query=${encodeURIComponent(query)}`
    const headers: Record<string, string> = {}
    if (this.opts.authToken) headers.Authorization = `Bearer ${this.opts.authToken}`

    const res = await doFetch(target, { headers, cache: "no-store" })
    if (!res.ok) {
      throw new Error(`Prometheus query failed: ${res.status}`)
    }
    const data = (await res.json()) as {
      status?: string
      data?: { resultType?: string; result?: PromVectorResult[] }
    }
    if (data?.status !== "success" || !Array.isArray(data.data?.result)) return []
    return data.data.result
  }
}
