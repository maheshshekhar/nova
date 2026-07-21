// Simple UTC → local-time display helpers for Nova.
//
// The mock logs / incident data carry fixed UTC timestamps. For a presentation
// we display the same historical moment in the viewer's local timezone (e.g.
// 09:22 UTC → 14:52 IST) — a plain timezone conversion, no "anchor to now".

// Parse a timestamp string into a Date. Handles both full ISO
// ("2025-05-14T09:22:01.334Z") and time-only ("09:14:22.341Z", "09:00 UTC")
// forms — the latter is interpreted as a UTC time-of-day on today's date so the
// (DST-correct) local offset applies.
export function toLocalDate(ts: string): Date {
  if (ts.includes("T")) {
    const d = new Date(ts)
    if (!isNaN(d.getTime())) return d
  }
  const m = ts.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?/)
  const now = new Date()
  if (!m) return now
  const [, h, min, s = "0", ms = "0"] = m
  return new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      Number(h),
      Number(min),
      Number(s),
      Number(ms.padEnd(3, "0"))
    )
  )
}

// Local HH:MM:SS.mmm (24h) — for log rows.
export function formatLocalTime(ts: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hour12: false,
  }).format(toLocalDate(ts))
}

// Local HH:MM (24h) + short timezone — for the incident timeline labels.
export function formatLocalClock(ts: string): string {
  const hm = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(toLocalDate(ts))
  return `${hm} ${tzAbbr()}`
}

// Local "YYYY-MM-DD HH:MM:SS TZ" — for the RCA "generated" stamp.
export function formatLocalStamp(d: Date): string {
  const date = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d)
  const time = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(d)
  return `${date} ${time} ${tzAbbr()}`
}

// Real pod log lines are emitted as "[<ISO>] <LEVEL> <message>" (see
// payment-service). The collector keeps the whole raw line as `message` and
// stamps `timestamp` with the collection time. Pull the embedded per-line
// timestamp out and strip the "[ts] LEVEL " prefix so the row's dedicated
// timestamp/level columns aren't duplicated inside the message text.
export function parseRawLogLine(raw: string): { ts: string | null; message: string } {
  const m = raw.match(/^\[([^\]]+)\]\s+(?:(?:ERROR|WARN|INFO|DEBUG)\s+)?(.*)$/)
  if (!m) return { ts: null, message: raw }
  return { ts: m[1], message: m[2] || raw }
}

// Short local timezone name, e.g. "IST" or "GMT+5:30".
export function tzAbbr(): string {
  try {
    const parts = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" }).formatToParts(new Date())
    return parts.find((p) => p.type === "timeZoneName")?.value ?? ""
  } catch {
    return ""
  }
}
