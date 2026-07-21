// Pure (React-free) helpers for the live error-rate / latency series that drive
// the overview charts AND the top stat tiles. Kept here — with no React or
// recharts imports — so both the lightweight MetricsLiveProvider and the heavy
// chart components can share the exact same math without an import cycle.

import { amplifyErrorRate } from "@/lib/dashboard-data"

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

export type ErrorPoint = { time: string; rate: number; p99: number }
export type LatencyPoint = { time: string; p50: number; p95: number; p99: number }

// Structural subset of the real metrics a series sample is derived from.
type SeriesService = { name: string; errorRate: number; avgCpu: number }

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

// Seed the live series flat at zero so an infra-only cluster (no app traffic yet)
// starts clean instead of showing a fabricated baseline; real samples then stream
// in from the right and ramp the lines up once app services are serving traffic.
export const seedErrorSeries = (): ErrorPoint[] =>
  seedTimes().map((time) => ({ time, rate: 0, p99: 0 }))

export const seedLatencySeries = (): LatencyPoint[] =>
  seedTimes().map((time) => ({ time, p50: 0, p95: 0, p99: 0 }))

// Monitored app services whose incidents drive the charts + stat tiles.
const MONITORED_SERVICES = ["payment-service", "config-service", "transaction-service"]

// Aggregate error rate: sum of per-service amplified error (each capped) so two or
// three concurrent incidents read progressively higher instead of a single incident
// already saturating the amplified cap.
export function aggregateErrorRate(services: { name: string; errorRate: number }[]): number {
  const total = MONITORED_SERVICES.reduce((sum, n) => {
    const s = services.find((x) => x.name === n)
    return s ? sum + Math.min(amplifyErrorRate(s.errorRate), 14) : sum
  }, 0)
  return Math.min(Math.round(total * 100) / 100, 42)
}

// Highest CPU across the monitored services (for latency derivation).
function worstMonitoredCpu(services: { name: string; avgCpu: number }[]): number {
  return Math.max(
    0,
    ...MONITORED_SERVICES.map((n) => services.find((s) => s.name === n)?.avgCpu ?? 0)
  )
}

// Advance the rolling error-rate series by one smoothed sample from the real
// (aggregate) service error rate.
export function advanceErrorSeries(prev: ErrorPoint[], services: SeriesService[]): ErrorPoint[] {
  const agg = aggregateErrorRate(services)
  const last = prev[prev.length - 1]
  const rate = ema(last.rate, agg)
  return [...prev.slice(1), { time: clockLabel(), rate, p99: Math.round(rate * 1.35 * 100) / 100 }]
}

// Advance the rolling latency series. Latency isn't collected directly, so p50/p95/
// p99 are derived from the real CPU + (amplified) aggregate error. The payment
// failure is a connection-pool WAIT (not CPU-bound), so CPU stays low and the error
// term carries the spike — weighted so a single active incident breaches the 500ms SLO.
export function advanceLatencySeries(prev: LatencyPoint[], services: SeriesService[]): LatencyPoint[] {
  // No monitored app service present (infra-only) → no traffic → latency decays to
  // zero, so the chart + tiles fall back to 0 when the app namespace is removed.
  const hasApp = MONITORED_SERVICES.some((n) => services.some((s) => s.name === n))
  const agg = aggregateErrorRate(services)
  const cpu = worstMonitoredCpu(services)
  const last = prev[prev.length - 1]
  const p50base = hasApp ? 40 + Math.max(0, cpu - 30) * 3.5 : 0
  return [
    ...prev.slice(1),
    {
      time: clockLabel(),
      p50: ema(last.p50, p50base),
      p95: ema(last.p95, hasApp ? p50base * 2.6 + agg * 45 : 0),
      p99: ema(last.p99, hasApp ? p50base * 3.8 + agg * 90 : 0),
    },
  ]
}

// ── Persistence ───────────────────────────────────────────────────────────────
// Persist the series to localStorage so incident spikes survive a full page
// reload (the 1-hour window is retained across refreshes). The payload is stamped
// with `savedAt` and discarded when stale, so a cluster teardown+restart (which
// takes several minutes and stops the poll) starts from a clean healthy baseline
// instead of resurrecting the previous session's lines / error rate.
export const ERROR_KEY = "nova-error-series"
export const LATENCY_KEY = "nova-latency-series"
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
