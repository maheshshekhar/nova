// Single canonical derivation of the per-incident metrics that appear on multiple
// surfaces (overview card, incident detail header, RCA document). Before this,
// each surface picked between the live-state value and the persisted record
// on its own, with slightly different rules/windows — so the impact count,
// duration and "started N ago" label could disagree between screens. Everything
// now funnels through `deriveIncidentMetrics` (pure) / `useIncidentMetrics` (hook)
// so the numbers are computed ONCE, the same way, everywhere.
//
// (Error rate is intentionally NOT here: it is a live service metric, already
// single-sourced through components/dashboard/metrics-charts.ts, not a per-incident
// stored figure.)

import type { FailureType } from "@/lib/incident-types"

export interface CanonicalIncidentMetrics {
  // Customer-impact count (failed checkout 503s for the payment cascade, else the
  // record's user estimate). Frozen at resolve upstream in live-state.
  impactCount: number
  // Whether to frame impact as "impacted checkouts (503)" (payment cascade) vs
  // "users affected".
  isCheckoutImpact: boolean
  // Incident duration in whole minutes (floored to 1), or null when unknown.
  durationMin: number | null
  // Canonical status string ("resolved" once resolved, else the live/record status).
  status: string
  // Canonical incident start time (epoch ms), or null when unknown. Each surface
  // formats its own relative label from this (the overview uses a compact "Xm
  // ago", the detail/list pages a longer "X min ago / Xmo ago") — the underlying
  // time is shared so they never anchor to different moments.
  startedAtMs: number | null
}

export interface DeriveIncidentMetricsInput {
  // True for the live payment cascade currently in progress.
  isActive: boolean
  resolved: boolean
  failureType?: FailureType
  // Live (live-state) values for the active incident.
  liveImpact?: number
  incidentStartedAt?: number | null
  activeStatus?: string
  // Persisted record values (for resolved / historical / non-active incidents).
  recordAffectedUsers?: number
  recordStartedAt?: number | null
  recordResolvedAt?: number | null
  recordDurationMin?: number | null
  recordStatus?: string
  // Last-resort impact when neither live nor record has a figure (e.g. a windowed
  // recount from logs on the detail page).
  windowedFallback?: number
  // Injected for testability / stable renders.
  now?: number
}
// "3m ago" / "2h ago" / "5d ago" — one implementation so every surface agrees.
export function agoLabel(ms: number, now: number = Date.now()): string {
  const diff = now - ms
  const min = Math.round(diff / 60000)
  if (min < 1) return "just now"
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h ago`
  return `${Math.round(hr / 24)}d ago`
}

export function deriveIncidentMetrics(input: DeriveIncidentMetricsInput): CanonicalIncidentMetrics {
  const {
    isActive,
    resolved,
    failureType,
    liveImpact = 0,
    incidentStartedAt = null,
    activeStatus,
    recordAffectedUsers = 0,
    recordStartedAt = null,
    recordResolvedAt = null,
    recordDurationMin = null,
    recordStatus,
    windowedFallback = 0,
    now = Date.now(),
  } = input

  // Impact: prefer the live canonical count for the active incident, then the
  // record's frozen figure, then a windowed recount. (Mirrors the Tier 1 rule.)
  const impactCount =
    isActive && liveImpact > 0
      ? liveImpact
      : recordAffectedUsers > 0
      ? recordAffectedUsers
      : windowedFallback

  const isCheckoutImpact =
    failureType === "db-pool-exhaustion" ||
    (isActive && liveImpact > 0) ||
    windowedFallback > 0

  // Duration: live elapsed for the active incident, else the record's stored
  // duration, else derived from the record's start/resolve times. Floored to 1.
  let durationMin: number | null = null
  if (isActive && incidentStartedAt != null) {
    durationMin = Math.max(1, Math.round((now - incidentStartedAt) / 60000))
  } else if (typeof recordDurationMin === "number") {
    durationMin = Math.max(1, recordDurationMin)
  } else if (recordStartedAt != null && recordResolvedAt != null) {
    durationMin = Math.max(1, Math.round((recordResolvedAt - recordStartedAt) / 60000))
  }

  // Status: resolved wins; otherwise the live/record status.
  const status = resolved ? "resolved" : (isActive ? activeStatus : recordStatus) ?? recordStatus ?? "investigating"

  // Started time: the one moment every surface anchors its relative label to.
  const startedAtMs = isActive ? incidentStartedAt : recordStartedAt

  return { impactCount, isCheckoutImpact, durationMin, status, startedAtMs }
}
