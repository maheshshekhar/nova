import type { LogLine } from "./analyzer"

// Parse a raw pod-log line into a normalized LogLine the analyzer understands.
// Handles JSON structured logs (extracting message + level from common field
// names) and plain text (a conservative level heuristic near the line start).
// Pure ⇒ unit-testable.

export interface LogMeta {
  service: string
  namespace?: string
  pod?: string
}

const LEVEL_RE = /\b(TRACE|DEBUG|INFO|NOTICE|WARN(?:ING)?|ERROR|ERR|CRIT(?:ICAL)?|FATAL|PANIC|EMERG|ALERT)\b/i

function normalizeLevel(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined
  const v = raw.trim()
  return v.length > 0 ? v : undefined
}

/** Best-effort level detection: only look near the start so a level word buried
 * in a message body doesn't get mistaken for the line's level. */
function detectLevel(line: string): string | undefined {
  const head = line.slice(0, 48)
  const m = head.match(LEVEL_RE)
  return m ? m[1].toUpperCase() : undefined
}

export function parseLogLine(raw: string, meta: LogMeta, at?: number): LogLine | null {
  const line = raw.trim()
  if (!line) return null

  if (line.startsWith("{") && line.endsWith("}")) {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>
      const message = obj.message ?? obj.msg ?? obj.log ?? obj.event
      if (typeof message === "string" && message.length > 0) {
        return {
          service: meta.service,
          namespace: meta.namespace,
          pod: meta.pod,
          message,
          level: normalizeLevel(obj.level ?? obj.severity ?? obj.lvl),
          at,
        }
      }
    } catch {
      // fall through to plain-text handling
    }
  }

  return {
    service: meta.service,
    namespace: meta.namespace,
    pod: meta.pod,
    message: line,
    level: detectLevel(line),
    at,
  }
}
