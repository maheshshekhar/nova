// LogSource — pluggable log backend abstraction.
//
// Nova reasons over logs but does NOT own their storage. Every AI path queries
// logs through this interface, so swapping the backing store (today: Grafana
// Loki, fed by Fluent Bit; alternatively Elasticsearch/OpenSearch or Datadog) is
// a drop-in adapter change with zero churn in the UI/AI code.
//
// The default client adapter (LokiApiLogSource) queries Loki via the Next.js
// `/api/logs` route. A Datadog adapter would implement the same `queryLogs`
// contract against the Datadog Logs API.

import type { RawLogEntry } from "@/lib/log-selection"

export interface LogQuery {
  /** Restrict to a single service (app label). Omit for all monitored services. */
  service?: string
  /** Only logs at/after this instant (ms epoch, ISO string or Date). */
  since?: number | string | Date
  /** Only logs at/before this instant. */
  until?: number | string | Date
  /** Restrict to these levels (e.g. ["ERROR","WARN"]). Omit for all. */
  levels?: string[]
  /** Hard cap on returned entries (most recent kept). */
  limit?: number
}

export interface LogSource {
  /** Human-readable adapter name (for diagnostics / the eval + logs UI). */
  readonly name: string
  /** Fetch log entries matching the query. Returns [] when unavailable. */
  queryLogs(query?: LogQuery): Promise<RawLogEntry[]>
}

function toMs(value: number | string | Date | undefined): number | undefined {
  if (value == null) return undefined
  if (value instanceof Date) return value.getTime()
  if (typeof value === "number") return value
  const t = new Date(value).getTime()
  return Number.isNaN(t) ? undefined : t
}

/**
 * Loki adapter (client) — queries Loki through the Next.js `/api/logs` route
 * (the browser can't reach Loki directly). Time-window / level / limit filtering
 * is pushed down to the route as LogQL query params.
 */
export class LokiApiLogSource implements LogSource {
  readonly name = "loki"

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async queryLogs(query: LogQuery = {}): Promise<RawLogEntry[]> {
    const params = new URLSearchParams()
    if (query.service) params.set("service", query.service)
    const since = toMs(query.since)
    if (since !== undefined) params.set("since", String(since))
    const until = toMs(query.until)
    if (until !== undefined) params.set("until", String(until))
    if (query.levels?.length) params.set("levels", query.levels.join(","))
    if (query.limit) params.set("limit", String(query.limit))

    let data: { logs?: RawLogEntry[]; fallback?: boolean }
    try {
      const res = await this.fetchImpl(`/api/logs?${params.toString()}`, {
        cache: "no-store",
      })
      data = await res.json()
    } catch {
      return []
    }
    if (data.fallback || !Array.isArray(data.logs)) return []
    return data.logs
  }
}

/** Default adapter used by the app today. Swap here to change backends. */
export const defaultLogSource: LogSource = new LokiApiLogSource()
