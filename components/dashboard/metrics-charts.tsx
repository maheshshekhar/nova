"use client"

import { useState, useEffect, useRef } from "react"
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
import { useLiveMetrics } from "@/lib/metrics-live"
import { useDashboardConfig } from "@/hooks/use-dashboard-config"
import { appServices } from "@/lib/dashboard/service-filter"
import { getDescriptor } from "@/lib/metrics/descriptors"
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

function ChartEmptyState({ title, message }: { title: string; message?: string }) {
  return (
    <div className="card-glass rounded-lg p-4 flex flex-col gap-4">
      <h3 className="text-xs font-mono font-semibold text-muted-foreground tracking-widest uppercase">
        {title}
      </h3>
      <div className="h-40 flex flex-col items-center justify-center gap-2 text-center">
        <Activity className="w-6 h-6 text-muted-foreground/50" />
        <p className="text-xs font-mono text-muted-foreground">
          {message ?? "Metrics collector unreachable"}
        </p>
        <p className="text-[10px] font-mono text-muted-foreground/70">
          No data to display — waiting for a live source.
        </p>
      </div>
    </div>
  )
}

export function ErrorRateChart() {
  const { realMetrics, errorSeries } = useLiveMetrics()
  const { config } = useDashboardConfig()
  const [windowMins, setWindowMins] = useState(3)

  // Source-driven only: with no reachable collector there is no data to show.
  if (!realMetrics.available) return <ChartEmptyState title="Error Rate" />

  const descriptor = getDescriptor("errorRate")
  const override = config.thresholds.errorRate
  const warn = override?.warn ?? descriptor.thresholds?.warn ?? 1
  const critical = override?.critical ?? descriptor.thresholds?.critical ?? 5

  const viewData = errorSeries.slice(-Math.min(windowMins * SAMPLES_PER_MIN, errorSeries.length))
  const current = viewData.length ? viewData[viewData.length - 1].rate : 0
  const prev = viewData.length ? viewData[Math.max(0, viewData.length - 6)].rate : 0
  const isUp = current > prev
  // Guard against a 0 baseline (no traffic) so the delta reads 0.0% not NaN%.
  const pctChange = prev > 0 ? Math.abs(((current - prev) / prev) * 100) : 0

  const tickIndices = new Set([0, 8, 16, 24, 32, 40, 47])

  return (
    <div className="card-glass rounded-lg p-4 flex flex-col gap-4">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-xs font-mono font-semibold text-muted-foreground tracking-widest uppercase">
            {descriptor.label}
          </h3>
          <div className="flex items-baseline gap-2 mt-1">
            <span
              suppressHydrationWarning
              className={`text-2xl font-mono font-bold ${current >= critical ? "text-[var(--neon-red)]" : current >= warn ? "text-[var(--neon-orange)]" : "text-[var(--neon-green)]"}`}
            >
              {current.toFixed(2)}%
            </span>
            <span
              suppressHydrationWarning
              className={`text-xs font-mono flex items-center gap-0.5 ${isUp ? "text-[var(--neon-red)]" : "text-[var(--neon-green)]"}`}
            >
              {isUp ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
              {pctChange.toFixed(1)}%
            </span>
          </div>
          <p className="text-[10px] text-muted-foreground mt-0.5">fleet mean · vs 1h ago</p>
        </div>
        <div className="flex items-center gap-3 text-[10px] font-mono">
          <span className="flex items-center gap-1 text-muted-foreground">
            <span className="w-2.5 h-0.5 rounded bg-[var(--neon-red)] inline-block" /> error %
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
            <Tooltip content={<ChartTooltipContent formatter={(v: number) => `${v.toFixed(2)}%`} />} />
            <ReferenceLine y={critical} stroke="oklch(0.6 0.22 25)" strokeDasharray="4 2" strokeOpacity={0.5} />
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
        <span className="text-[var(--neon-red)]/70">— threshold {critical}%</span>
        {current >= critical && (
          <span className="ml-3 text-[var(--neon-red)]/70">error rate above threshold</span>
        )}
      </div>
    </div>
  )
}

// Response-latency (p95) chart — driven ONLY by a real latency source (Prometheus).
// It maintains a rolling window of the fleet-mean p95 across application services.
// When no service reports latency (e.g. the CPU/mem-only collector), it shows an
// empty state rather than fabricating a line.
export function LatencyChart() {
  const { realMetrics } = useLiveMetrics()
  const { config } = useDashboardConfig()
  const [windowMins, setWindowMins] = useState(3)
  const [series, setSeries] = useState<{ time: string; p95: number }[]>([])
  const lastTsRef = useRef<number | null>(null)

  useEffect(() => {
    if (!realMetrics.available) return
    const ts = realMetrics.lastUpdated ?? Date.now()
    if (ts === lastTsRef.current) return
    lastTsRef.current = ts
    const apps = appServices(realMetrics.services, config.infraWorkloads)
    const lat = apps
      .map((s) => s.latencyP95)
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
    if (lat.length === 0) return // no real latency this tick → don't advance
    const mean = Math.round(lat.reduce((a, b) => a + b, 0) / lat.length)
    const time = new Date().toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    })
    setSeries((prev) => [...prev, { time, p95: mean }].slice(-1200))
  }, [realMetrics, config.infraWorkloads])

  if (!realMetrics.available) return <ChartEmptyState title="Response Latency (p95)" />
  if (series.length === 0) {
    return (
      <ChartEmptyState
        title="Response Latency (p95)"
        message="No latency source — connect Prometheus to see p95."
      />
    )
  }

  const descriptor = getDescriptor("latencyP95")
  const override = config.thresholds.latencyP95
  const warn = override?.warn ?? descriptor.thresholds?.warn ?? 500
  const critical = override?.critical ?? descriptor.thresholds?.critical ?? 1000

  const viewData = series.slice(-Math.min(windowMins * SAMPLES_PER_MIN, series.length))
  const current = viewData[viewData.length - 1].p95
  const prev = viewData[Math.max(0, viewData.length - 6)].p95
  const isUp = current > prev
  const tickIndices = new Set([0, 8, 16, 24, 32, 40, 47])

  return (
    <div className="card-glass rounded-lg p-4 flex flex-col gap-4">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-xs font-mono font-semibold text-muted-foreground tracking-widest uppercase">
            Response Latency (p95)
          </h3>
          <div className="flex items-baseline gap-2 mt-1">
            <span
              suppressHydrationWarning
              className={`text-2xl font-mono font-bold ${current >= critical ? "text-[var(--neon-red)]" : current >= warn ? "text-[var(--neon-orange)]" : "text-[var(--neon-green)]"}`}
            >
              {current}ms
            </span>
            <span
              suppressHydrationWarning
              className={`text-xs font-mono flex items-center gap-0.5 ${isUp ? "text-[var(--neon-red)]" : "text-[var(--neon-green)]"}`}
            >
              {isUp ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
            </span>
          </div>
          <p className="text-[10px] text-muted-foreground mt-0.5">fleet mean · live</p>
        </div>
        <div className="flex items-center gap-3 text-[10px] font-mono">
          <span className="flex items-center gap-1 text-muted-foreground">
            <span className="w-2.5 h-0.5 rounded bg-[var(--neon-orange)] inline-block" /> p95
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
            <Tooltip content={<ChartTooltipContent formatter={(v: number) => `${Math.round(v)}ms`} />} />
            <ReferenceLine y={critical} stroke="oklch(0.6 0.22 25)" strokeDasharray="4 2" strokeOpacity={0.5} />
            <Line
              type="monotone"
              dataKey="p95"
              name="p95"
              stroke="oklch(0.75 0.18 55)"
              strokeWidth={2}
              dot={false}
              isAnimationActive={viewData.length <= 120}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="text-[10px] font-mono text-muted-foreground border-t border-border/50 pt-2">
        <span className="text-[var(--neon-red)]/70">— SLO {critical}ms (p95)</span>
        {current >= critical && <span className="ml-3 text-[var(--neon-red)]/70">SLO breach</span>}
      </div>
    </div>
  )
}

