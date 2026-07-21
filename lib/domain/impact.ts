import type { RawLogEntry } from "@/lib/log-selection"
import type { ImpactSignal } from "@/lib/config/schema"

// Domain-agnostic impact counter. "Customer impact" is whatever the active
// Domain Pack's `impactSignal` says it is — a level filter and/or a message
// regex — replacing the hardcoded checkout/503 counter. Pure (no server deps) so
// every surface (client incident views, server routes, eval) can share it.

export interface ImpactWindow {
  windowStart?: number | string | Date
  windowEnd?: number | string | Date
}

function toMs(value: number | string | Date | undefined): number | undefined {
  if (value == null) return undefined
  if (value instanceof Date) return value.getTime()
  if (typeof value === "number") return value
  const t = new Date(value).getTime()
  return Number.isNaN(t) ? undefined : t
}

/**
 * Count log entries that match the domain's impact signal, optionally restricted
 * to a time window. An entry matches when BOTH (when present) hold:
 *  - `match.level` equals the entry's level (case-insensitive), and
 *  - `match.pattern` (a case-insensitive regex) is found in the message.
 * A signal with neither matcher counts nothing (there is no impact to detect).
 */
export function countImpactSignals(
  logs: RawLogEntry[],
  signal: ImpactSignal,
  window: ImpactWindow = {}
): number {
  const level = signal.match.level?.toUpperCase()
  const pattern = signal.match.pattern
  if (!level && !pattern) return 0

  const re = pattern ? new RegExp(pattern, "i") : null
  const start = toMs(window.windowStart)
  const end = toMs(window.windowEnd)

  return logs.filter((l) => {
    const t = toMs(l.timestamp)
    if (start !== undefined && t !== undefined && t < start) return false
    if (end !== undefined && t !== undefined && t > end) return false
    if (level && (l.level || "").toUpperCase() !== level) return false
    if (re && !re.test(l.message)) return false
    return true
  }).length
}
