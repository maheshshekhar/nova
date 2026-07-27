"use client"

import { useMemo, useState } from "react"
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts"
import { useLiveMetrics } from "@/lib/metrics-live"
import { SAMPLES_PER_MIN } from "@/lib/metrics-series"
import { TrendingUp, TrendingDown, Activity } from "lucide-react"

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

// Error Rate — 100% real. Driven entirely by the shared live series, which is the
// smoothed mean of every reporting service's inferred error rate (0 when nothing
// is erroring). When the collector is unreachable the chart shows an empty state
// instead of a simulated line.
export function ErrorRateChart() {
  const { realMetrics, errorSeries } = useLiveMetrics()
  const [windowMins, setWindowMins] = useState(3)
  const live = realMetrics.available

  const viewData = useMemo(
    () => errorSeries.slice(-Math.min(windowMins * SAMPLES_PER_MIN, errorSeries.length)),
    [errorSeries, windowMins]
  )

  if (!live) {
    return (
      <div className="card-glass rounded-lg p-4 flex flex-col gap-4">
        <h3 className="text-xs font-mono font-semibold text-muted-foreground tracking-widest uppercase">
          Error Rate
        </h3>
        <div className="h-40 flex flex-col items-center justify-center gap-2 text-center">
          <Activity className="w-6 h-6 text-muted-foreground" />
          <p className="text-xs font-mono text-muted-foreground">No live metrics</p>
          <p className="text-[10px] font-mono text-muted-foreground/70 max-w-xs">
            Point Nova at a workload's metrics-collector to chart its real error rate.
          </p>
        </div>
      </div>
    )
  }

  const current = viewData.length ? viewData[viewData.length - 1].rate : 0
  const prev = viewData.length ? viewData[Math.max(0, viewData.length - 6)].rate : 0
  const isUp = current > prev
  // Guard against a 0 baseline (no traffic) so the delta reads 0.0% instead of NaN%.
  const pctChange = prev > 0 ? Math.abs(((current - prev) / prev) * 100) : 0

  // Show a sparse set of x labels to avoid crowding.
  const step = Math.max(1, Math.floor(viewData.length / 7))

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
          <p className="text-[10px] text-muted-foreground mt-0.5">mean across reporting services</p>
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
              tickFormatter={(v, i) => (i % step === 0 ? v : "")}
            />
            <YAxis
              tick={{ fill: "oklch(0.5 0.04 220)", fontSize: 9, fontFamily: "monospace" }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v) => `${v}%`}
            />
            <Tooltip content={<ChartTooltipContent formatter={(v: number) => `${v.toFixed(2)}%`} />} />
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
