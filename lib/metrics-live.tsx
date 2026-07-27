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
  advanceErrorSeries,
  loadStore,
  saveStore,
  seedErrorSeries,
  type ErrorPoint,
} from "@/lib/metrics-series"

export function MetricsLiveProvider({ children }: { children: ReactNode }) {
  // The one and only metrics poll for the dashboard.
  const realMetrics = useStandaloneRealMetrics(3000, true)

  // Rolling error series, seeded from localStorage (survives reload) or a clean
  // baseline. Living in this provider (mounted in the root layout) means the
  // series also survives client-side navigation between tabs.
  const [errorSeries, setErrorSeries] = useState<ErrorPoint[]>(
    () => loadStore<ErrorPoint>(ERROR_KEY) ?? seedErrorSeries()
  )
  const lastTsRef = useRef<number | null>(null)

  useEffect(() => {
    // Advance the live series whenever the collector is reachable. The series math
    // decays toward zero when nothing is erroring, so the chart falls back to 0 on
    // a quiet cluster and ramps up once services report errors again.
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
  }, [realMetrics])

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
