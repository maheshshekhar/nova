import "server-only"
import type { RawLogEntry } from "@/lib/log-selection"
import { queryLoki } from "./loki-source"

// Server-side access to the REAL incident logs. Fluent Bit ships production pod
// logs into Loki (retained ~24h), so the dashboard server can pull the exact
// incident window directly via LogQL — independent of the browser's short-lived
// in-memory capture. This is what makes the RCA robust to page reloads and to
// being generated minutes after the incident.

function toMs(value: unknown): number | undefined {
  if (value == null) return undefined
  if (typeof value === "number") return value
  const t = new Date(value as string).getTime()
  return Number.isNaN(t) ? undefined : t
}

/**
 * Fetch real logs for a service from Loki, optionally restricted to logs at/after
 * `sinceMs` (ms epoch or ISO string). Returns [] when Loki is unreachable so
 * callers can fall back to whatever the client supplied.
 */
export async function fetchCollectorLogs(
  service: string,
  sinceMs?: number | string
): Promise<RawLogEntry[]> {
  try {
    return await queryLoki({
      service,
      startMs: toMs(sinceMs),
      endMs: Date.now(),
    })
  } catch {
    return []
  }
}
