// Shared context for the single live-metrics poller. Kept in its own module so
// both `hooks/use-real-metrics.ts` and `lib/metrics-live.tsx` can import the
// context object without a runtime import cycle (the type imports below are
// erased at compile time).

import { createContext } from "react"
import type { RealMetricsState } from "@/hooks/use-real-metrics"
import type { ErrorPoint, LatencyPoint } from "@/lib/metrics-series"

export interface MetricsLiveValue {
  // The latest real cluster metrics (single shared poll).
  realMetrics: RealMetricsState
  // Smoothed rolling series, advanced once per poll tick so every consumer
  // (both charts + the stat tiles) reads identical numbers on the same tick.
  errorSeries: ErrorPoint[]
  latencySeries: LatencyPoint[]
}

export const MetricsLiveContext = createContext<MetricsLiveValue | null>(null)
