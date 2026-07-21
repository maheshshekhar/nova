"use client"

// Single source of truth for live cluster metrics on the dashboard. ONE poll
// every 3s (via useStandaloneRealMetrics) feeds both the smoothed error/latency
// series and the raw metrics. Because every consumer — the Error Rate chart, the
// Response Latency chart, and the top stat tiles (Avg Error Rate, P95 Latency) —
// reads from this same context, they all re-render on the SAME tick with the SAME
// numbers. This removes the old lag where the tiles trailed the charts by a poll
// (they used to read a module-level store one render behind).

import { useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useStandaloneRealMetrics } from "@/hooks/use-real-metrics"
import { MetricsLiveContext } from "@/lib/metrics-live-context"
import {
  ERROR_KEY,
  LATENCY_KEY,
  advanceErrorSeries,
  advanceLatencySeries,
  loadStore,
  saveStore,
  seedErrorSeries,
  seedLatencySeries,
  type ErrorPoint,
  type LatencyPoint,
} from "@/lib/metrics-series"

export function MetricsLiveProvider({ children }: { children: ReactNode }) {
  // The one and only metrics poll for the dashboard.
  const realMetrics = useStandaloneRealMetrics(3000, true)

  // Rolling series, seeded from localStorage (survives reload) or a healthy
  // baseline. Living in this provider (mounted in the root layout) means the
  // series also survive client-side navigation between tabs.
  const [errorSeries, setErrorSeries] = useState<ErrorPoint[]>(
    () => loadStore<ErrorPoint>(ERROR_KEY) ?? seedErrorSeries()
  )
  const [latencySeries, setLatencySeries] = useState<LatencyPoint[]>(
    () => loadStore<LatencyPoint>(LATENCY_KEY) ?? seedLatencySeries()
  )
  const lastTsRef = useRef<number | null>(null)

  useEffect(() => {
    // Advance the live series whenever the collector is reachable. The series math
    // decays toward zero when no app service is present, so the charts + tiles fall
    // back to 0 on an infra-only cluster (or when the app namespace is removed) and
    // ramp back up once app services are serving traffic again.
    if (!realMetrics.available) return
    // Advance exactly once per new collector sample (dedupe on lastUpdated so a
    // re-render without fresh data never double-advances the window).
    const ts = realMetrics.lastUpdated ?? Date.now()
    if (ts === lastTsRef.current) return
    lastTsRef.current = ts

    setErrorSeries((prev) => {
      const next = advanceErrorSeries(prev, realMetrics.services)
      saveStore(ERROR_KEY, next)
      return next
    })
    setLatencySeries((prev) => {
      const next = advanceLatencySeries(prev, realMetrics.services)
      saveStore(LATENCY_KEY, next)
      return next
    })
  }, [realMetrics])

  const value = useMemo(
    () => ({ realMetrics, errorSeries, latencySeries }),
    [realMetrics, errorSeries, latencySeries]
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
