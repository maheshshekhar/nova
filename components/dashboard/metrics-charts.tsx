"use client"

import { useEffect, useMemo, useState } from "react"
import {
  AreaChart,
  Area,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts"
import { generateErrorData, generateLatencyData } from "@/lib/dashboard-data"
import { useLiveState, type LivePhase } from "@/lib/live-state"
import { useLiveMetrics } from "@/lib/metrics-live"
import { SAMPLES_PER_MIN } from "@/lib/metrics-series"
import { TrendingUp, TrendingDown } from "lucide-react"

// Selectable display windows (minutes), capped at 1 hour.
const WINDOW_OPTIONS = [
  { label: "3m", mins: 3 },
  { label: "5m", mins: 5 },
  { label: "15m", mins: 15 },
  { label: "30m", mins: 30 },
  { label: "1h", mins: 60 },
]

function WindowSelect({ value, onChange }: { value: number; onChange: (m: number) => void }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      aria-label="Chart time window"
      className="text-[10px] font-mono bg-secondary/60 border border-border rounded px-1.5 py-0.5 text-muted-foreground hover:text-foreground focus:outline-none cursor-pointer"
    >
      {WINDOW_OPTIONS.map((o) => (
        <option key={o.mins} value={o.mins}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

const makeTimes = (): string[] => {
  const now = Date.now()
  return Array.from({ length: 48 }, (_, i) =>
    new Date(now - (47 - i) * 15 * 60 * 1000).toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
  )
}

// Phase-driven error-rate series: flat (healthy), rising trend (degrading),
// or the full spike at 42-43 (incident, via the original generator).
function generatePhaseError(phase: LivePhase) {
  if (phase === "incident") return generateErrorData()
  return makeTimes().map((time, i) => {
    const rate =
      phase === "healthy"
        ? 0.2 + Math.random() * 0.6
        : 0.3 + Math.pow(i / 47, 2) * 1.4 + Math.random() * 0.2
    return { time, rate, p99: rate * 1.35 }
  })
}

// Phase-driven latency series: flat (healthy), rising (degrading), spike (incident).
function generatePhaseLatency(phase: LivePhase) {
  if (phase === "incident") return generateLatencyData()
  return makeTimes().map((time, i) => {
    if (phase === "healthy") {
      return {
        time,
        p50: 38 + Math.random() * 14,
        p95: 100 + Math.random() * 30,
        p99: 180 + Math.random() * 50,
      }
    }
    const ramp = Math.pow(i / 47, 2)
    return {
      time,
      p50: 40 + ramp * 90 + Math.random() * 15,
      p95: 110 + ramp * 260 + Math.random() * 40,
      p99: 190 + ramp * 600 + Math.random() * 80,
    }
  })
}

function ChartTooltipContent({ active, payload, label, formatter }: any) {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-card border border-border rounded-lg p-2.5 shadow-xl text-xs font-mono">
      <p className="text-muted-foreground mb-2">{label}</p>
      {payload.map((entry: any) => (
        <div key={entry.dataKey} className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full" style={{ background: entry.color }} />
          <span className="text-muted-foreground capitalize">{entry.name}:</span>
          <span className="font-semibold" style={{ color: entry.color }}>
            {formatter ? formatter(entry.value) : entry.value}
          </span>
        </div>
      ))}
    </div>
  )
}

export function ErrorRateChart() {
  const { phase, isResolved, currentIncidentId } = useLiveState()
  const { realMetrics, errorSeries } = useLiveMetrics()
  const resolved = isResolved(currentIncidentId)
  const [windowMins, setWindowMins] = useState(3)

  // Collector reachable → drive the chart from the shared live series (which is 0
  // on an infra-only cluster and ramps up with real traffic). Offline → simulate.
  const live = realMetrics.available

  // OFFLINE fallback: phase-driven simulation (regenerated on phase change).
  const [chartData, setChartData] = useState(() => generatePhaseError("healthy"))
  useEffect(() => {
    setChartData(generatePhaseError(phase))
  }, [phase])

  // Once resolved (incident phase only), decline from the spike (positions
  // 42-43) back to baseline over the following data points.
  const phaseData = useMemo(() => {
    if (!resolved || phase !== "incident") return chartData

    const recovered = chartData.map((d) => ({ ...d }))
    const spikeEnd = 43
    const steps = Math.min(6, recovered.length - 1 - spikeEnd)
    if (steps <= 0) return recovered

    const startRate = recovered[spikeEnd].rate
    const startP99 = recovered[spikeEnd].p99
    const baselineRate = 0.5
    const baselineP99 = 0.7

    for (let k = 1; k <= steps; k++) {
      const idx = spikeEnd + k
      const t = k / steps
      recovered[idx] = {
        ...recovered[idx],
        rate: startRate + (baselineRate - startRate) * t,
        p99: startP99 + (baselineP99 - startP99) * t,
      }
    }
    return recovered
  }, [resolved, phase, chartData])

  const data = live ? errorSeries : phaseData
  const viewData = live ? data.slice(-Math.min(windowMins * SAMPLES_PER_MIN, data.length)) : data

  const current = viewData[viewData.length - 1].rate
  const prev = viewData[Math.max(0, viewData.length - 6)].rate
  const isUp = current > prev
  // Guard against a 0 baseline (infra-only / no traffic) so the delta reads 0.0%
  // instead of NaN%.
  const pctChange = prev > 0 ? Math.abs(((current - prev) / prev) * 100) : 0

  // Show every 8th label to avoid crowding
  const tickIndices = new Set([0, 8, 16, 24, 32, 40, 47])

  return (
    <div className="card-glass rounded-lg p-4 flex flex-col gap-4">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-xs font-mono font-semibold text-muted-foreground tracking-widest uppercase">
            Error Rate
          </h3>
          <div className="flex items-baseline gap-2 mt-1">
            <span suppressHydrationWarning className={`text-2xl font-mono font-bold ${current > 2.5 ? "text-[var(--neon-red)]" : "text-[var(--neon-green)]"}`}>
              {current.toFixed(2)}%
            </span>
            <span suppressHydrationWarning className={`text-xs font-mono flex items-center gap-0.5 ${isUp ? "text-[var(--neon-red)]" : "text-[var(--neon-green)]"}`}>
              {isUp ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
              {pctChange.toFixed(1)}%
            </span>
          </div>
          <p className="text-[10px] text-muted-foreground mt-0.5">vs 1h ago</p>
        </div>
        <div className="flex items-center gap-3 text-[10px] font-mono">
          <span className="flex items-center gap-1 text-muted-foreground">
            <span className="w-2.5 h-0.5 rounded bg-[var(--neon-red)] inline-block" /> error %
          </span>
          <span className="flex items-center gap-1 text-muted-foreground">
            <span className="w-2.5 h-0.5 rounded bg-[var(--neon-orange)] inline-block" /> p99
          </span>
          <WindowSelect value={windowMins} onChange={setWindowMins} />
        </div>
      </div>
      <div className="h-40">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={viewData} margin={{ top: 4, right: 4, left: -24, bottom: 0 }}>
            <defs>
              <linearGradient id="errorGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="oklch(0.6 0.22 25)" stopOpacity={0.4} />
                <stop offset="95%" stopColor="oklch(0.6 0.22 25)" stopOpacity={0.02} />
              </linearGradient>
              <linearGradient id="p99Grad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="oklch(0.75 0.18 55)" stopOpacity={0.25} />
                <stop offset="95%" stopColor="oklch(0.75 0.18 55)" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.22 0.025 240)" vertical={false} />
            <XAxis
              dataKey="time"
              tick={{ fill: "oklch(0.5 0.04 220)", fontSize: 9, fontFamily: "monospace" }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v, i) => (tickIndices.has(i) ? v : "")}
            />
            <YAxis
              tick={{ fill: "oklch(0.5 0.04 220)", fontSize: 9, fontFamily: "monospace" }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v) => `${v}%`}
            />
            <Tooltip
              content={<ChartTooltipContent formatter={(v: number) => `${v.toFixed(2)}%`} />}
            />
            <ReferenceLine y={2.5} stroke="oklch(0.6 0.22 25)" strokeDasharray="4 2" strokeOpacity={0.5} />
            <Area
              type="monotone"
              dataKey="p99"
              name="p99"
              stroke="oklch(0.75 0.18 55)"
              strokeWidth={1.5}
              fill="url(#p99Grad)"
              dot={false}
              isAnimationActive={viewData.length <= 120}
              strokeOpacity={0.8}
            />
            <Area
              type="monotone"
              dataKey="rate"
              name="rate"
              stroke="oklch(0.6 0.22 25)"
              strokeWidth={2}
              fill="url(#errorGrad)"
              dot={false}
              isAnimationActive={viewData.length <= 120}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <div className="text-[10px] font-mono text-muted-foreground border-t border-border/50 pt-2">
        <span className="text-[var(--neon-red)]/70">— threshold 2.5%</span>
        {current > 2.5 && <span className="ml-3 text-[var(--neon-red)]/70">error rate above threshold</span>}
      </div>
    </div>
  )
}

export function LatencyChart() {
  const { phase } = useLiveState()
  const { realMetrics, latencySeries } = useLiveMetrics()
  const [windowMins, setWindowMins] = useState(3)

  // Collector reachable → drive the chart from the shared live series (0 on an
  // infra-only cluster, ramping with real traffic). Offline → simulate.
  const live = realMetrics.available

  // OFFLINE fallback: phase-driven simulation.
  const [phaseData, setPhaseData] = useState(() => generatePhaseLatency("healthy"))
  useEffect(() => {
    setPhaseData(generatePhaseLatency(phase))
  }, [phase])

  const data = live ? latencySeries : phaseData
  const viewData = live ? data.slice(-Math.min(windowMins * SAMPLES_PER_MIN, data.length)) : data

  const latest = viewData[viewData.length - 1]
  const tickIndices = new Set([0, 8, 16, 24, 32, 40, 47])

  return (
    <div className="card-glass rounded-lg p-4 flex flex-col gap-4">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-xs font-mono font-semibold text-muted-foreground tracking-widest uppercase">
            Response Latency
          </h3>
          <div className="flex items-baseline gap-3 mt-1">
            <div>
              <span className="text-[10px] text-muted-foreground font-mono">p50 </span>
              <span suppressHydrationWarning className="text-lg font-mono font-bold text-[var(--neon-cyan)]">{Math.round(latest.p50)}ms</span>
            </div>
            <div>
              <span className="text-[10px] text-muted-foreground font-mono">p95 </span>
              <span suppressHydrationWarning className={`text-lg font-mono font-bold ${latest.p95 > 500 ? "text-[var(--neon-orange)]" : "text-foreground"}`}>
                {Math.round(latest.p95)}ms
              </span>
            </div>
            <div>
              <span className="text-[10px] text-muted-foreground font-mono">p99 </span>
              <span suppressHydrationWarning className={`text-lg font-mono font-bold ${latest.p99 > 1000 ? "text-[var(--neon-red)]" : "text-foreground"}`}>
                {Math.round(latest.p99)}ms
              </span>
            </div>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1 text-[10px] font-mono">
          <span className="flex items-center gap-1 text-muted-foreground">
            <span className="w-2.5 h-0.5 rounded bg-[var(--neon-cyan)] inline-block" /> p50
          </span>
          <span className="flex items-center gap-1 text-muted-foreground">
            <span className="w-2.5 h-0.5 rounded bg-[var(--neon-orange)] inline-block" /> p95
          </span>
          <span className="flex items-center gap-1 text-muted-foreground">
            <span className="w-2.5 h-0.5 rounded bg-[var(--neon-red)] inline-block" /> p99
          </span>
          <WindowSelect value={windowMins} onChange={setWindowMins} />
        </div>
      </div>
      <div className="h-40">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={viewData} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.22 0.025 240)" vertical={false} />
            <XAxis
              dataKey="time"
              tick={{ fill: "oklch(0.5 0.04 220)", fontSize: 9, fontFamily: "monospace" }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v, i) => (tickIndices.has(i) ? v : "")}
            />
            <YAxis
              tick={{ fill: "oklch(0.5 0.04 220)", fontSize: 9, fontFamily: "monospace" }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v) => `${v}ms`}
            />
            <Tooltip
              content={<ChartTooltipContent formatter={(v: number) => `${Math.round(v)}ms`} />}
            />
            <ReferenceLine y={500} stroke="oklch(0.75 0.18 55)" strokeDasharray="4 2" strokeOpacity={0.4} />
            <Line
              type="monotone"
              dataKey="p50"
              name="p50"
              stroke="oklch(0.8 0.18 195)"
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={viewData.length <= 120}
              strokeOpacity={0.9}
            />
            <Line
              type="monotone"
              dataKey="p95"
              name="p95"
              stroke="oklch(0.75 0.18 55)"
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={viewData.length <= 120}
              strokeOpacity={0.9}
            />
            <Line
              type="monotone"
              dataKey="p99"
              name="p99"
              stroke="oklch(0.6 0.22 25)"
              strokeWidth={2}
              dot={false}
              isAnimationActive={viewData.length <= 120}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="text-[10px] font-mono text-muted-foreground border-t border-border/50 pt-2">
        <span className="text-[var(--neon-orange)]/70">— SLO threshold 500ms (p95)</span>
        {phase === "incident" && <span className="ml-3 text-[var(--neon-red)]/70">SLO BREACH</span>}
      </div>
    </div>
  )
}
