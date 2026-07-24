"use client"

// Single source of truth for live cluster metrics on the dashboard. ONE poll
// every 3s (via useStandaloneRealMetrics) feeds both the smoothed error-rate
// series and the raw metrics. Because every consumer — the Error Rate chart and
// the top stat tiles (Avg Error Rate) — reads from this same context, they all
// re-render on the SAME tick with the SAME numbers.

import { useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useStandaloneRealMetrics } from "@/hooks/use-real-metrics"
import { useDashboardConfig } from "@/hooks/use-dashboard-config"
import { isInfraWorkload } from "@/lib/dashboard/service-filter"
import { MetricsLiveContext } from "@/lib/metrics-live-context"
import {
  ERROR_KEY,
  advanceErrorSeries,
  loadStore,
  saveStore,
  seedErrorSeries,
  type ErrorPoint,
} from "@/lib/metrics-series"

export function MetricsLiveProvider({ children }: { children: ReactNode }) {
  // The one and only metrics poll for the dashboard.
  const realMetrics = useStandaloneRealMetrics(3000, true)
  const { config } = useDashboardConfig()

  // Rolling series, seeded from localStorage (survives reload) or a flat zero
  // baseline. Living in this provider (mounted in the root layout) means the
  // series also survive client-side navigation between tabs.
  const [errorSeries, setErrorSeries] = useState<ErrorPoint[]>(
    () => loadStore<ErrorPoint>(ERROR_KEY) ?? seedErrorSeries()
  )
  const lastTsRef = useRef<number | null>(null)

  useEffect(() => {
    // Advance the live series whenever the collector is reachable. The series is
    // the mean error rate across the application services (infra workloads removed
    // via config), so it reflects only real, source-reported values.
    if (!realMetrics.available) return
    // Advance exactly once per new collector sample (dedupe on lastUpdated so a
    // re-render without fresh data never double-advances the window).
    const ts = realMetrics.lastUpdated ?? Date.now()
    if (ts === lastTsRef.current) return
    lastTsRef.current = ts

    const appServices = realMetrics.services.filter(
      (s) => !isInfraWorkload(s, config.infraWorkloads)
    )
    setErrorSeries((prev) => {
      const next = advanceErrorSeries(prev, appServices)
      saveStore(ERROR_KEY, next)
      return next
    })
  }, [realMetrics, config.infraWorkloads])

  const value = useMemo(
    () => ({ realMetrics, errorSeries }),
    [realMetrics, errorSeries]
  )

  return <MetricsLiveContext.Provider value={value}>{children}</MetricsLiveContext.Provider>
}

export function useLiveMetrics() {
  const ctx = useContext(MetricsLiveContext)
  if (!ctx) {
    throw new Error("useLiveMetrics must be used within a MetricsLiveProvider")
  }
  return ctx
}
