// Pure (React-free) helpers for the live error-rate series that drives the
// overview Error Rate chart AND the top stat tiles. Kept here — with no React or
// recharts imports — so both the lightweight MetricsLiveProvider and the heavy
// chart components can share the exact same math without an import cycle.
//
// De-static: this file derives its series ONLY from real, source-reported error
// rates. There is no latency series (the collector does not measure latency) and
// no error-rate amplification — the chart shows the raw, smoothed rate. The caller
// passes the already-filtered set of application services, so nothing here
// references a specific service by name.

// Number of samples kept in the live rolling window (~3s cadence). 1200 ≈ 1 hour,
// so past incident spikes stay visible in the chart until they age out of the hour.
const WINDOW = 1200
// ~20 samples per minute at the 3s poll cadence.
export const SAMPLES_PER_MIN = 20

// The collector's per-scrape values are jagged (pods flap through CrashLoopBackOff),
// so smooth each new sample with an exponential moving average — like a Prometheus
// rate() over a window — giving an elevated plateau during the incident and a clean
// decline on recovery instead of a sawtooth.
const SMOOTH_ALPHA = 0.3
const ema = (prev: number, next: number) =>
  Math.round((prev + SMOOTH_ALPHA * (next - prev)) * 100) / 100

export type ErrorPoint = { time: string; rate: number }

// Structural subset of the real metrics a series sample is derived from.
type SeriesService = { name: string; errorRate: number }

const clockLabel = (t = Date.now()) =>
  new Date(t).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })

// Times spaced ~3s apart ending at now — used to seed a full-looking rolling chart.
const seedTimes = (): string[] =>
  Array.from({ length: WINDOW }, (_, i) => clockLabel(Date.now() - (WINDOW - 1 - i) * 3000))

// Seed the live series flat at zero so a cluster with no error traffic starts
// clean; real samples then stream in from the right and ramp the line up when
// services actually report elevated error rates.
export const seedErrorSeries = (): ErrorPoint[] =>
  seedTimes().map((time) => ({ time, rate: 0 }))

// Aggregate (fleet) error rate: the mean raw error rate across the provided
// services. The caller passes the already-filtered set of application services
// (infra workloads removed via config), so this stays domain-agnostic and never
// references a specific service by name. No amplification — raw values only.
export function aggregateErrorRate(services: { errorRate: number }[]): number {
  if (services.length === 0) return 0
  const sum = services.reduce(
    (a, s) => a + (Number.isFinite(s.errorRate) ? s.errorRate : 0),
    0
  )
  return Math.round((sum / services.length) * 100) / 100
}

// Advance the rolling error-rate series by one smoothed sample from the real
// (aggregate) service error rate.
export function advanceErrorSeries(prev: ErrorPoint[], services: SeriesService[]): ErrorPoint[] {
  const agg = aggregateErrorRate(services)
  const last = prev[prev.length - 1]
  const rate = ema(last?.rate ?? 0, agg)
  return [...prev.slice(1), { time: clockLabel(), rate }]
}

// ── Persistence ───────────────────────────────────────────────────────────────
// Persist the series to localStorage so incident spikes survive a full page
// reload (the 1-hour window is retained across refreshes). The payload is stamped
// with `savedAt` and discarded when stale, so a cluster teardown+restart (which
// takes several minutes and stops the poll) starts from a clean healthy baseline
// instead of resurrecting the previous session's lines / error rate.
export const ERROR_KEY = "nova-error-series"
// Persisted series older than this is treated as belonging to a previous cluster
// session and dropped. Long enough to survive a page reload, short enough that a
// teardown+setup cycle never brings back stale lines.
const SERIES_STALE_MS = 5 * 60 * 1000

export function loadStore<T>(key: string): T[] | null {
  if (typeof window === "undefined") return null
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    // Legacy bare-array payloads have no timestamp — treat as stale (fresh seed).
    if (Array.isArray(parsed)) return null
    const savedAt = parsed?.savedAt
    const data = parsed?.data
    if (typeof savedAt !== "number" || Date.now() - savedAt > SERIES_STALE_MS) return null
    return Array.isArray(data) && data.length ? (data as T[]) : null
  } catch {
    return null
  }
}

export function saveStore(key: string, data: unknown): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(key, JSON.stringify({ savedAt: Date.now(), data }))
  } catch {
    // Quota / serialization issues are non-fatal.
  }
}
