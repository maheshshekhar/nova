// A compiled matcher for a "declared signal" — the same shape the Domain Pack's
// `impactSignal.match` uses (an optional level filter + an optional message
// regex). Shared by the business-impact and absence detectors so Sentinel reuses
// exactly what a deployment already declares once in its Domain Pack.

export interface SignalMatch {
  /** Case-insensitive exact level match (e.g. "ERROR"). */
  level?: string
  /** Case-insensitive substring regex tested against the message. */
  pattern?: string
}

export type MatchFn = (message: string, level?: string) => boolean

/** Compile a match spec once. Returns null when the spec matches nothing (no
 * level and no pattern) so callers can cheaply skip it. */
export function compileMatch(m: SignalMatch): MatchFn | null {
  if (!m.level && !m.pattern) return null
  const level = m.level?.toUpperCase()
  const re = m.pattern ? new RegExp(m.pattern, "i") : null
  return (message: string, lineLevel?: string): boolean => {
    if (level && (lineLevel ?? "").toUpperCase() !== level) return false
    if (re && !re.test(message)) return false
    return true
  }
}
