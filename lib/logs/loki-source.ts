import "server-only"
import type { RawLogEntry } from "@/lib/log-selection"
import { DEFAULT_CONFIG } from "@/lib/config/defaults"
import { compileScopeToLogQL } from "./scope"
import { classifyLevel, extractMessage, finalizeEntries } from "./normalize"
import type { LogQueryInput, LogSource } from "./source"

// Loki adapter (server-only). Nova reasons over logs but does not own their
// storage — Fluent Bit ships pod logs into Loki, and this adapter pulls them back
// out via LogQL and normalises them into `RawLogEntry[]` so the downstream
// selection → prompt → RCA pipeline is unchanged.
//
// Throws on a network/HTTP failure so callers can distinguish "Loki unreachable"
// (fall back / 503) from "no matching logs" (returns []).

const DEFAULT_LOKI_URL = process.env.LOKI_URL || "http://loki:3100"

/** @deprecated use LogQueryInput. Kept for existing call sites. */
export type LokiQueryOptions = LogQueryInput

export interface LokiLogSourceOptions {
  url?: string
  fetchImpl?: typeof fetch
}

export class LokiLogSource implements LogSource {
  constructor(private readonly opts: LokiLogSourceOptions = {}) {}

  async queryLogs(input: LogQueryInput): Promise<RawLogEntry[]> {
    const endMs = input.endMs ?? Date.now()
    const startMs = input.startMs ?? endMs - 30 * 60 * 1000
    const limit = input.limit ?? 5000
    const scope = input.scope ?? DEFAULT_CONFIG.logs.scope
    const fields = input.fields ?? DEFAULT_CONFIG.logs.fields
    const query = compileScopeToLogQL(scope, fields, { service: input.service, levels: input.levels })

    const params = new URLSearchParams({
      query,
      start: String(Math.floor(startMs) * 1_000_000), // ms → ns
      end: String(Math.ceil(endMs) * 1_000_000),
      limit: String(limit),
      // Newest-first so a capped result keeps the most recent lines; callers re-sort.
      direction: "backward",
    })

    const url = this.opts.url ?? DEFAULT_LOKI_URL
    const doFetch = this.opts.fetchImpl ?? fetch
    const res = await doFetch(`${url}/loki/api/v1/query_range?${params.toString()}`, {
      cache: "no-store",
    })
    if (!res.ok) {
      throw new Error(`Loki query failed: ${res.status}`)
    }
    const data = (await res.json()) as {
      data?: { result?: Array<{ stream?: Record<string, string>; values?: [string, string][] }> }
    }

    const streams = data?.data?.result
    if (!Array.isArray(streams)) return []

    const out: RawLogEntry[] = []
    for (const stream of streams) {
      const labels = stream.stream || {}
      const service = labels[fields.service] || input.service
      const pod = labels.pod
      for (const [tsNs, rawLine] of stream.values || []) {
        const message = extractMessage(String(rawLine))
        out.push({
          timestamp: new Date(Number(tsNs) / 1_000_000).toISOString(),
          level: classifyLevel(message),
          message,
          pod,
          service,
        })
      }
    }
    return finalizeEntries(out)
  }
}

const defaultLokiSource = new LokiLogSource()

/** Back-compat functional wrapper around the default Loki adapter. */
export function queryLoki(opts: LogQueryInput = {}): Promise<RawLogEntry[]> {
  return defaultLokiSource.queryLogs(opts)
}
