// Smart incident-log selection.
//
// Turns a raw stream of collected log lines into a small, high-signal set that
// is worth sending to the model: filter to the incident time window, prioritise
// ERROR > WARN > INFO, collapse repeated lines, and cap to a token-ish budget.
//
// Pure (no React / no server deps) so it is usable from client components,
// server routes and the eval harness alike.

import { countImpactSignals } from "@/lib/domain/impact"
import { DEFAULT_DOMAIN } from "@/lib/domain/defaults"

export interface RawLogEntry {
  timestamp?: string | number | Date
  level?: string
  message: string
  pod?: string
  service?: string
}

export interface SelectOptions {
  /** Only keep logs at/after this instant (ms epoch or Date/ISO). */
  windowStart?: number | string | Date
  /** Only keep logs at/before this instant. */
  windowEnd?: number | string | Date
  /** Max number of lines to emit after prioritisation + dedupe. */
  budget?: number
  /** When true (default) sort ERROR > WARN > INFO > DEBUG before budgeting. */
  prioritize?: boolean
  /** IANA timezone (e.g. "Asia/Kolkata"). When set, formatted log timestamps are
   * rendered as local HH:MM:SS.mmm in this zone (and the duplicated leading
   * timestamp/level is stripped from the message) so the prompt's log lines stay
   * consistent with the local-time incident bookends in the RCA context. */
  tz?: string
}

const LEVEL_RANK: Record<string, number> = {
  ERROR: 0,
  WARN: 1,
  INFO: 2,
  DEBUG: 3,
}

function toMs(value: number | string | Date | undefined): number | undefined {
  if (value == null) return undefined
  if (value instanceof Date) return value.getTime()
  if (typeof value === "number") return value
  const t = new Date(value).getTime()
  return Number.isNaN(t) ? undefined : t
}

/** Normalise a level string to one of ERROR/WARN/INFO/DEBUG (defaults INFO). */
function normLevel(level?: string): keyof typeof LEVEL_RANK {
  const up = (level || "").toUpperCase()
  if (up in LEVEL_RANK) return up as keyof typeof LEVEL_RANK
  return "INFO"
}

/** Strip volatile bits (leading timestamp, ids, numbers) so near-identical
 * repeated lines collapse into one dedupe key. */
function dedupeKey(entry: RawLogEntry): string {
  return `${normLevel(entry.level)}|${entry.service ?? ""}|${entry.message
    // drop a leading "[ISO]" or bare ISO timestamp
    .replace(/^\[?\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?\]?\s*/, "")
    // collapse long digit runs (ids, ports, counts, durations)
    .replace(/\d+/g, "#")
    .trim()
    .toLowerCase()}`
}

/** Extract the best per-line event timestamp: prefer the real event time embedded
 * in the raw pod line ("[<ISO>] LEVEL ..."), else the collector's own timestamp. */
function extractTs(entry: RawLogEntry): string | undefined {
  const m = typeof entry.message === "string" ? entry.message.match(/^\[([^\]]+)\]/) : null
  if (m && !Number.isNaN(new Date(m[1]).getTime())) return m[1]
  if (entry.timestamp != null) {
    return typeof entry.timestamp === "string"
      ? entry.timestamp
      : new Date(entry.timestamp).toISOString()
  }
  return undefined
}

/** Drop a leading "[ISO]" and/or LEVEL token from a raw line so they aren't
 * duplicated next to the row's own timestamp/level. */
function stripLeadingMeta(message: string): string {
  return message
    .replace(/^\[[^\]]+\]\s*/, "")
    .replace(/^(ERROR|WARN|INFO|DEBUG)\s+/i, "")
    .trim()
}

/** Format an ISO instant as HH:MM:SS.mmm in the given IANA timezone (mirrors the
 * client's local-time log rendering). Falls back to the raw string on any error. */
function formatTsInTz(iso: string, tz: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      fractionalSecondDigits: 3,
      hour12: false,
    }).format(d)
  } catch {
    return iso
  }
}

/** Format one entry as a single log string for the prompt. When `tz` is given the
 * timestamp is rendered as local HH:MM:SS.mmm and the duplicated leading
 * timestamp/level is stripped from the message so it matches the local-time
 * bookends in the context. */
function formatLine(entry: RawLogEntry, count: number, tz?: string): string {
  const rawTs = extractTs(entry)
  const ts = rawTs ? (tz ? formatTsInTz(rawTs, tz) : rawTs) : ""
  const level = normLevel(entry.level)
  const pod = entry.pod ? ` [${entry.pod}]` : ""
  const repeat = count > 1 ? ` (x${count})` : ""
  const message = tz ? stripLeadingMeta(entry.message) : entry.message
  return `${ts} ${level}${pod} ${message}${repeat}`.trim()
}

/**
 * Select the most relevant incident log ENTRIES (deduped + prioritised +
 * budgeted), each paired with how many raw lines it collapsed. Callers that
 * need custom formatting (e.g. local-time rendering) use this; those that just
 * want prompt-ready strings use `selectIncidentLogs`.
 */
export function selectIncidentLogEntries(
  logs: RawLogEntry[],
  opts: SelectOptions = {}
): { entry: RawLogEntry; count: number }[] {
  const { budget = 20, prioritize = true } = opts
  const start = toMs(opts.windowStart)
  const end = toMs(opts.windowEnd)

  // 1. Window filter (entries without a parseable timestamp are kept — better to
  //    include an undated line than silently drop signal).
  const windowed = logs.filter((l) => {
    const t = toMs(l.timestamp)
    if (t === undefined) return true
    if (start !== undefined && t < start) return false
    if (end !== undefined && t > end) return false
    return true
  })

  // 2. Dedupe near-identical lines, keeping the first occurrence + a count.
  const byKey = new Map<string, { entry: RawLogEntry; count: number; order: number }>()
  windowed.forEach((entry, i) => {
    const key = dedupeKey(entry)
    const existing = byKey.get(key)
    if (existing) existing.count += 1
    else byKey.set(key, { entry, count: 1, order: i })
  })

  let deduped = Array.from(byKey.values())

  // 3. Prioritise by severity, then original order (stable-ish).
  if (prioritize) {
    deduped = deduped.sort((a, b) => {
      const rank = LEVEL_RANK[normLevel(a.entry.level)] - LEVEL_RANK[normLevel(b.entry.level)]
      return rank !== 0 ? rank : a.order - b.order
    })
  } else {
    deduped = deduped.sort((a, b) => a.order - b.order)
  }

  // 4. Budget cap.
  return deduped.slice(0, budget).map((d) => ({ entry: d.entry, count: d.count }))
}

/**
 * Select the most relevant incident log lines for the model.
 * Returns an array of formatted log strings, longest-signal first.
 */
export function selectIncidentLogs(
  logs: RawLogEntry[],
  opts: SelectOptions = {}
): string[] {
  return selectIncidentLogEntries(logs, opts).map((d) => formatLine(d.entry, d.count, opts.tz))
}

// A failed checkout looks like a 503 / "Service Unavailable" on /api/checkout, or
// the pool-exhaustion timeout that directly causes it. This is now expressed as
// the DEFAULT domain's impact signal (lib/domain/defaults.ts) and counted through
// the generic, domain-agnostic matcher — `countCheckoutFailures` is a thin,
// back-compatible wrapper so existing call sites keep working unchanged.

/**
 * Count checkout-failure signals (HTTP 503 on payment-service) in the given logs,
 * optionally restricted to an incident window. Returns 0 when there are none —
 * callers fall back to a static estimate in that case.
 */
export function countCheckoutFailures(
  logs: RawLogEntry[],
  opts: { windowStart?: number | string | Date; windowEnd?: number | string | Date } = {}
): number {
  return countImpactSignals(logs, DEFAULT_DOMAIN.impactSignal, {
    windowStart: opts.windowStart,
    windowEnd: opts.windowEnd,
  })
}
