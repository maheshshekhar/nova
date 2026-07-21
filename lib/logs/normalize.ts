import type { RawLogEntry } from "@/lib/log-selection"
import { redactSecrets } from "@/lib/security/redact"

// Shared log normalisation used by every LogSource adapter, so a Loki line, an
// Elasticsearch hit and a CloudWatch event all become the SAME `RawLogEntry`
// shape with the same level classification and truncation rules. Pure.

/** Heuristic level classification from a log message (fallback when the backend
 * carries no structured level). Kept identical to the original Loki behaviour. */
export function classifyLevel(message: string): string {
  const lower = message.toLowerCase()
  if (
    lower.includes("error") ||
    lower.includes("fatal") ||
    lower.includes("exception") ||
    lower.includes("503") ||
    lower.includes("failed")
  )
    return "ERROR"
  if (
    lower.includes("warn") ||
    lower.includes("timeout") ||
    lower.includes("retry") ||
    lower.includes("slow")
  )
    return "WARN"
  if (lower.includes("debug")) return "DEBUG"
  return "INFO"
}

// A shipper often pushes each line as a JSON object with the real text under
// `message` (CRI parser) — fall back to `log` or the raw line for other shippers.
export function extractMessage(line: string): string {
  const trimmed = line.trim()
  if (trimmed.startsWith("{")) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>
      if (typeof obj.message === "string") return obj.message.replace(/\n+$/, "")
      if (typeof obj.log === "string") return obj.log.replace(/\n+$/, "")
    } catch {
      /* not JSON — use the raw line */
    }
  }
  return line
}

/** Coerce a backend timestamp (ms epoch, seconds, or ISO string) to an ISO string. */
export function toIsoTimestamp(value: unknown): string {
  if (typeof value === "number") {
    // Heuristic: <1e12 ⇒ seconds, else milliseconds.
    const ms = value < 1e12 ? value * 1000 : value
    return new Date(ms).toISOString()
  }
  const s = String(value ?? "")
  const t = new Date(s).getTime()
  return Number.isNaN(t) ? s : new Date(t).toISOString()
}

/** Final step every adapter runs: redact secrets/PII, truncate messages to 400
 * chars, and sort ascending by timestamp (callers may re-sort, but this keeps a
 * capped, newest-first backend fetch presented oldest-first like the pipeline
 * expects). */
export function finalizeEntries(entries: RawLogEntry[]): RawLogEntry[] {
  const out = entries.map((e) => ({
    ...e,
    message: redactSecrets(String(e.message)).slice(0, 400),
  }))
  out.sort(
    (a, b) => new Date(a.timestamp as string).getTime() - new Date(b.timestamp as string).getTime()
  )
  return out
}
