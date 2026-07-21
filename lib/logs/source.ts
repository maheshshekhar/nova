import type { RawLogEntry } from "@/lib/log-selection"
import type { LogScope, LogFields } from "@/lib/config/schema"

// The LogSource port. Every logging backend (Loki, Elasticsearch/OpenSearch,
// CloudWatch, Datadog, files…) implements this one method: take a backend-neutral
// query (a LogScope + window + optional service/levels) and return normalised
// `RawLogEntry[]`. The adapter owns translating the LogScope into its native
// query and its response into `RawLogEntry`. See docs/log-scope-agnostic-plan.md.

export interface LogQueryInput {
  /** Restrict to a single service (the service field). */
  service?: string
  /** Window start (ms epoch). Defaults to 30 minutes before `endMs`. */
  startMs?: number
  /** Window end (ms epoch). Defaults to now. */
  endMs?: number
  /** Restrict to these levels (e.g. ["ERROR","WARN"]). */
  levels?: string[]
  /** Hard cap on returned entries. */
  limit?: number
  /** Where to look. Defaults to the config default scope. */
  scope?: LogScope
  /** Backend field mapping. Defaults to the config default fields. */
  fields?: LogFields
}

export interface LogSource {
  /** Query the backend. Throws on a network/HTTP failure (so callers can
   * distinguish "backend unreachable" from "no matching logs" ⇒ []). */
  queryLogs(input: LogQueryInput): Promise<RawLogEntry[]>
}
