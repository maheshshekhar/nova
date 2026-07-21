"use client"

import { useLiveState } from "@/lib/live-state"
import type { IncidentRecord } from "@/lib/incident-types"
import {
  deriveIncidentMetrics,
  type CanonicalIncidentMetrics,
} from "@/lib/incident-metrics"

export interface UseIncidentMetricsParams {
  // The persisted record for this incident (null for the live active incident
  // before it is stored, or while loading).
  record: IncidentRecord | null
  // Whether this incident is the live payment cascade currently in progress.
  isActive: boolean
  // Whether the incident is resolved (caller already computes this from
  // live-state + record + archive).
  resolved: boolean
  // Optional last-resort impact when neither the live count nor the record has a
  // figure (e.g. a windowed 503 recount from logs on the detail page).
  windowedFallback?: number
  // Live status for the active incident (e.g. phase-derived), used when unresolved.
  activeStatus?: string
}

/**
 * Single source of truth for the per-incident figures (impact, duration, status,
 * started label) shown across the overview, detail page and RCA. Reads the live
 * canonical impact count from live-state and the persisted record, then runs the
 * one shared derivation so every surface shows identical numbers.
 */
export function useIncidentMetrics(params: UseIncidentMetricsParams): CanonicalIncidentMetrics {
  const { impactCount: liveImpact, incidentStartedAt } = useLiveState()
  const {
    record,
    isActive,
    resolved,
    windowedFallback = 0,
    activeStatus,
  } = params

  return deriveIncidentMetrics({
    isActive,
    resolved,
    failureType: record?.failureType ?? (isActive ? "db-pool-exhaustion" : undefined),
    liveImpact,
    incidentStartedAt,
    activeStatus,
    recordAffectedUsers: record?.affectedUsers,
    recordStartedAt: record?.startedAt ?? null,
    recordResolvedAt: record?.resolvedAt ?? null,
    recordDurationMin: record?.durationMin ?? null,
    recordStatus: record?.status,
    windowedFallback,
  })
}
