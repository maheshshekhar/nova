import type { Signal } from "./signal"

// Leading indicators — "tell before it breaks".
//
// These two monitors watch trends rather than states, so Nova can flag a service
// that is DEGRADING before it hard-fails:
//   • RestartAccelerationMonitor — restarts becoming more frequent (a container
//     that is starting to flap, before CrashLoopBackOff's backoff kicks in).
//   • MemoryTrendMonitor — working set climbing toward its limit (before OOMKill).
// Both emit SOFT signals (they corroborate; the correlator confirms). Pure +
// injectable clock ⇒ unit-testable.

// ── Restart acceleration ─────────────────────────────────────────────────────

export interface RestartAccelerationOptions {
  /** Restart events must fall within this window to count as "recent" (default 10m). */
  windowMs?: number
  /** The latest interval must be this fraction (or less) of the previous one to
   * count as accelerating (default 0.6 ⇒ ~40% faster). */
  speedupRatio?: number
  now?: () => number
}

interface RestartState {
  service: string
  namespace: string
  lastCount: number
  /** Timestamps of observations where the restart count increased. */
  events: number[]
}

export class RestartAccelerationMonitor {
  private readonly windowMs: number
  private readonly speedupRatio: number
  private readonly now: () => number
  private readonly state = new Map<string, RestartState>()

  constructor(opts: RestartAccelerationOptions = {}) {
    this.windowMs = opts.windowMs ?? 10 * 60 * 1000
    this.speedupRatio = opts.speedupRatio ?? 0.6
    this.now = opts.now ?? Date.now
  }

  /** Feed one container's cumulative restart count. Returns a signal when the
   * restart cadence is accelerating. */
  observe(
    key: string,
    service: string,
    namespace: string,
    container: string,
    restartCount: number,
    at?: number
  ): Signal | null {
    const t = at ?? this.now()
    let st = this.state.get(key)
    if (!st) {
      // First observation is the baseline — never flag on it (avoids counting a
      // pod that was already restarting before Nova started).
      this.state.set(key, { service, namespace, lastCount: restartCount, events: [] })
      return null
    }

    if (restartCount < st.lastCount) {
      // Counter reset (pod recreated) — rebaseline.
      st.lastCount = restartCount
      st.events = []
      return null
    }
    if (restartCount === st.lastCount) return null

    // One or more new restarts since the last observation.
    st.lastCount = restartCount
    st.events.push(t)
    st.events = st.events.filter((e) => t - e <= this.windowMs)
    if (st.events.length > 6) st.events = st.events.slice(-6)

    if (st.events.length >= 3) {
      const e = st.events
      const gapRecent = e[e.length - 1] - e[e.length - 2]
      const gapPrev = e[e.length - 2] - e[e.length - 3]
      if (gapPrev > 0 && gapRecent <= gapPrev * this.speedupRatio) {
        return {
          kind: "RestartsAccelerating",
          service,
          namespace,
          severity: "warning",
          hard: false,
          message: `Container ${container} restarts are accelerating (${st.events.length} in the last ${Math.round(this.windowMs / 60000)}m, cadence speeding up)`,
          source: { kind: "Pod", name: key.split("/")[1] ?? service },
        }
      }
    }
    return null
  }
}

// ── Memory trend toward limit ────────────────────────────────────────────────

export interface MemoryTrendOptions {
  /** Trend window (default 10m). */
  windowMs?: number
  /** Fraction of the limit above which a rising trend is flagged (default 0.85). */
  highWatermark?: number
  /** Minimum samples in the window before flagging (default 3). */
  minSamples?: number
  now?: () => number
}

interface MemSample {
  used: number
  at: number
}

interface MemState {
  service: string
  namespace: string
  container: string
  pod: string
  limit: number
  samples: MemSample[]
  flagged: boolean
}

export class MemoryTrendMonitor {
  private readonly windowMs: number
  private readonly highWatermark: number
  private readonly minSamples: number
  private readonly now: () => number
  private readonly state = new Map<string, MemState>()

  constructor(opts: MemoryTrendOptions = {}) {
    this.windowMs = opts.windowMs ?? 10 * 60 * 1000
    this.highWatermark = opts.highWatermark ?? 0.85
    this.minSamples = opts.minSamples ?? 3
    this.now = opts.now ?? Date.now
  }

  /** Feed one container's memory usage + limit. Returns a signal when usage is
   * both HIGH (>= highWatermark of the limit) and RISING across the window. */
  observe(
    key: string,
    service: string,
    namespace: string,
    pod: string,
    container: string,
    usedBytes: number,
    limitBytes: number,
    at?: number
  ): Signal | null {
    if (!(limitBytes > 0) || !(usedBytes >= 0)) return null
    const t = at ?? this.now()
    let st = this.state.get(key)
    if (!st) {
      st = { service, namespace, container, pod, limit: limitBytes, samples: [], flagged: false }
      this.state.set(key, st)
    }
    st.limit = limitBytes
    st.samples.push({ used: usedBytes, at: t })
    st.samples = st.samples.filter((s) => t - s.at <= this.windowMs)

    const frac = usedBytes / limitBytes
    if (frac < this.highWatermark) {
      st.flagged = false // recovered below the mark — re-arm
      return null
    }
    if (st.samples.length < this.minSamples) return null
    if (st.flagged) return null // one signal per sustained climb

    const first = st.samples[0]
    const last = st.samples[st.samples.length - 1]
    const rising = last.used > first.used * 1.05 // >5% growth across the window
    if (!rising) return null

    st.flagged = true
    return {
      kind: "MemoryPressureRising",
      service,
      namespace,
      severity: "warning",
      hard: false,
      message: `Container ${container} memory at ${Math.round(frac * 100)}% of limit and rising (${fmtMB(usedBytes)} / ${fmtMB(limitBytes)}) — trending toward OOM`,
      source: { kind: "Pod", name: pod },
    }
  }
}

function fmtMB(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))}Mi`
}
