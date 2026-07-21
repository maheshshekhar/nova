import "server-only"
import type { RawLogEntry } from "@/lib/log-selection"
import { DEFAULT_CONFIG } from "@/lib/config/defaults"
import { compileScopeToEs } from "./es-query"
import { classifyLevel, finalizeEntries, toIsoTimestamp } from "./normalize"
import type { LogQueryInput, LogSource } from "./source"

// Elasticsearch / OpenSearch adapter (server-only). Same wire protocol for both.
// Compiles the LogScope into an ES bool query, POSTs to `_search`, and maps
// `hits.hits[]._source` into `RawLogEntry` using the configured field mapping.

const DEFAULT_ES_URL = process.env.ELASTICSEARCH_URL || "http://elasticsearch:9200"
const DEFAULT_ES_INDEX = process.env.ELASTICSEARCH_INDEX || "logs-*"

export interface ElasticsearchLogSourceOptions {
  url?: string
  index?: string
  fetchImpl?: typeof fetch
}

interface EsHit {
  _source?: Record<string, unknown>
}

export class ElasticsearchLogSource implements LogSource {
  constructor(private readonly opts: ElasticsearchLogSourceOptions = {}) {}

  async queryLogs(input: LogQueryInput): Promise<RawLogEntry[]> {
    const endMs = input.endMs ?? Date.now()
    const startMs = input.startMs ?? endMs - 30 * 60 * 1000
    const limit = input.limit ?? 5000
    const scope = input.scope ?? DEFAULT_CONFIG.logs.scope
    const fields = input.fields ?? DEFAULT_CONFIG.logs.fields

    const body = compileScopeToEs(scope, fields, {
      service: input.service,
      levels: input.levels,
      startMs,
      endMs,
      limit,
    })

    const url = this.opts.url ?? DEFAULT_ES_URL
    const index = this.opts.index ?? DEFAULT_ES_INDEX
    const doFetch = this.opts.fetchImpl ?? fetch

    const res = await doFetch(`${url}/${index}/_search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    })
    if (!res.ok) {
      throw new Error(`Elasticsearch query failed: ${res.status}`)
    }
    const data = (await res.json()) as { hits?: { hits?: EsHit[] } }
    const hits = data?.hits?.hits
    if (!Array.isArray(hits)) return []

    const out: RawLogEntry[] = hits.map((hit) => {
      const src = hit._source ?? {}
      const message = String(src[fields.message] ?? "")
      const rawLevel = src[fields.level]
      return {
        timestamp: toIsoTimestamp(src[fields.timestamp]),
        // Prefer the backend's structured level; fall back to classifying the text.
        level: rawLevel ? String(rawLevel).toUpperCase() : classifyLevel(message),
        message,
        pod: typeof src.pod === "string" ? src.pod : undefined,
        service: (src[fields.service] as string) ?? input.service,
      }
    })
    return finalizeEntries(out)
  }
}
