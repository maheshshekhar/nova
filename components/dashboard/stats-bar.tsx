"use client"

import { useMemo, useState, useEffect } from "react"
import { useLiveMetrics } from "@/lib/metrics-live"
import { useDashboardConfig } from "@/hooks/use-dashboard-config"
import type { DashboardTileView } from "@/lib/dashboard/config-view"
import { useLiveDeployments } from "@/components/dashboard/deployment-cards"
import { useOpenIncidents } from "@/hooks/use-open-incidents"
import { appServices } from "@/lib/dashboard/service-filter"
import { aggregateErrorRate } from "@/lib/metrics-series"
import { getDescriptor, evaluateHealth } from "@/lib/metrics/descriptors"
import { Activity, AlertOctagon, CheckCircle2, Cpu, MemoryStick, Shield } from "lucide-react"

type Tone = "good" | "warn" | "bad" | "neutral"

const toneColor: Record<Tone, string> = {
  good: "text-[var(--neon-green)]",
  warn: "text-[var(--neon-orange)]",
  bad: "text-[var(--neon-red)]",
  neutral: "text-[var(--neon-cyan)]",
}

const subColor: Record<Tone, string> = {
  good: "text-[var(--neon-green)]/80",
  warn: "text-[var(--neon-orange)]/80",
  bad: "text-[var(--neon-red)]/80",
  neutral: "text-muted-foreground",
}

interface Tile {
  label: string
  value: string
  sub: string
  tone: Tone
  icon: typeof Activity
}

// Map a metric's health level to a tile tone.
function levelTone(level: string): Tone {
  return level === "critical" ? "bad" : level === "warn" ? "warn" : level === "healthy" ? "good" : "neutral"
}

const mean = (nums: number[]): number =>
  nums.length ? Math.round(nums.reduce((a, n) => a + n, 0) / nums.length) : 0

// Shared tile card used by both the auto bar and configured tiles.
function TileCard({ t }: { t: Tile }) {
  const Icon = t.icon
  return (
    <div className="card-glass rounded-lg p-3 flex flex-col gap-2 hover:border-border/60 transition-all">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider leading-tight">{t.label}</span>
        <Icon className={`w-3.5 h-3.5 ${toneColor[t.tone]} shrink-0`} />
      </div>
      <span suppressHydrationWarning className={`text-xl font-mono font-bold ${toneColor[t.tone]}`}>{t.value}</span>
      <span suppressHydrationWarning className={`text-[9px] font-mono ${subColor[t.tone]}`}>{t.sub}</span>
    </div>
  )
}

// The dashboard stats bar. Renders the curated auto tiles by default, or the
// operator's explicitly configured `stats.tiles` (metric + PromQL query tiles).
export function StatsBar() {
  const { config } = useDashboardConfig()
  if (config.stats.tiles !== "auto") {
    return <ConfiguredStatsTiles tiles={config.stats.tiles} />
  }
  return <AutoStatsBar />
}

function AutoStatsBar() {
  const { realMetrics } = useLiveMetrics()
  const { config } = useDashboardConfig()
  const deployments = useLiveDeployments()
  const incidents = useOpenIncidents()

  const tiles = useMemo<Tile[]>(() => {
    const available = realMetrics.available
    const apps = available ? appServices(realMetrics.services, config.infraWorkloads) : []

    // ── Error Rate (fleet mean, real) ──
    const errDescriptor = getDescriptor("errorRate")
    const errThresholds = {
      direction: errDescriptor.thresholds?.direction ?? ("lower-better" as const),
      warn: config.thresholds.errorRate?.warn ?? errDescriptor.thresholds?.warn,
      critical: config.thresholds.errorRate?.critical ?? errDescriptor.thresholds?.critical,
    }
    const errRate = aggregateErrorRate(apps)
    const errTile: Tile = available
      ? {
          label: "Avg Error Rate",
          value: `${errRate.toFixed(2)}%`,
          sub: apps.length ? "fleet mean · live" : "no app services",
          tone: apps.length ? levelTone(evaluateHealth({ ...errDescriptor, thresholds: errThresholds }, errRate)) : "neutral",
          icon: AlertOctagon,
        }
      : { label: "Avg Error Rate", value: "—", sub: "collector offline", tone: "neutral", icon: AlertOctagon }

    // ── Healthy Services (real) ──
    const healthy = apps.filter((s) => s.status === "healthy").length
    const healthyTile: Tile = available
      ? {
          label: "Healthy Services",
          value: `${healthy} / ${apps.length}`,
          sub:
            apps.length === 0
              ? "no app services"
              : healthy === apps.length
              ? "all operational"
              : `${apps.length - healthy} need attention`,
          tone: apps.length === 0 ? "neutral" : healthy === apps.length ? "good" : "warn",
          icon: CheckCircle2,
        }
      : { label: "Healthy Services", value: "—", sub: "collector offline", tone: "neutral", icon: CheckCircle2 }

    // ── Open Incidents (real store) ──
    const incidentsTile: Tile = {
      label: "Open Incidents",
      value: incidents.available ? String(incidents.open) : "—",
      sub: !incidents.available
        ? "store unavailable"
        : incidents.open === 0
        ? "no active incidents"
        : incidents.critical > 0
        ? `${incidents.critical} critical`
        : `${incidents.open} active`,
      tone: !incidents.available ? "neutral" : incidents.open === 0 ? "good" : incidents.critical > 0 ? "bad" : "warn",
      icon: Shield,
    }

    // ── Active Deployments (real collector) ──
    const running = deployments.filter((d) => d.status === "running").length
    const failed = deployments.filter((d) => d.status === "failed").length
    const deployTile: Tile = {
      label: "Active Deployments",
      value: String(deployments.length),
      sub:
        deployments.length === 0
          ? "none reported"
          : running > 0
          ? `${running} rolling out`
          : failed > 0
          ? `${failed} failed`
          : "all healthy",
      tone: failed > 0 ? "bad" : running > 0 ? "warn" : deployments.length > 0 ? "good" : "neutral",
      icon: Activity,
    }

    // ── CPU / Memory Utilization (real) ──
    const cpuDescriptor = getDescriptor("avgCpu")
    const memDescriptor = getDescriptor("avgMemory")
    const avgCpu = mean(apps.map((s) => s.avgCpu))
    const avgMem = mean(apps.map((s) => s.avgMemory))
    const cpuTile: Tile = available && apps.length
      ? {
          label: "CPU Utilization",
          value: `${avgCpu}%`,
          sub: "avg across services",
          tone: levelTone(evaluateHealth(cpuDescriptor, avgCpu)),
          icon: Cpu,
        }
      : { label: "CPU Utilization", value: "—", sub: available ? "no app services" : "collector offline", tone: "neutral", icon: Cpu }
    const memTile: Tile = available && apps.length
      ? {
          label: "Memory Utilization",
          value: `${avgMem}%`,
          sub: "avg across services",
          tone: levelTone(evaluateHealth(memDescriptor, avgMem)),
          icon: MemoryStick,
        }
      : { label: "Memory Utilization", value: "—", sub: available ? "no app services" : "collector offline", tone: "neutral", icon: MemoryStick }

    return [errTile, healthyTile, incidentsTile, deployTile, cpuTile, memTile]
  }, [realMetrics, config.infraWorkloads, config.thresholds, deployments, incidents])

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3">
      {tiles.map((t) => (
        <TileCard key={t.label} t={t} />
      ))}
    </div>
  )
}

// ── Configured tiles (dashboard.stats.tiles is an explicit list) ─────────────

// Fetch a single PromQL-backed tile's scalar value from the server-side executor.
// The browser only ever passes the tile id — the PromQL stays in server config.
function useTile(id: string | null): { value: number | null; loaded: boolean } {
  const [state, setState] = useState<{ value: number | null; loaded: boolean }>({
    value: null,
    loaded: false,
  })
  useEffect(() => {
    if (!id) return
    let cancelled = false
    const load = () =>
      fetch(`/api/tiles?id=${encodeURIComponent(id)}`, { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (cancelled) return
          setState({ value: d && typeof d.value === "number" ? d.value : null, loaded: true })
        })
        .catch(() => {
          if (!cancelled) setState((s) => ({ ...s, loaded: true }))
        })
    load()
    const t = setInterval(load, 5000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [id])
  return state
}

// A metric tile = the fleet mean of a real metric key across application services.
function metricTileToTile(
  tile: DashboardTileView,
  apps: { [k: string]: unknown }[],
  available: boolean,
  overrides: Record<string, { warn?: number; critical?: number }>
): Tile {
  const key = tile.metric ?? ""
  const descriptor = getDescriptor(key)
  const label = tile.label ?? descriptor.label
  if (!available || apps.length === 0) {
    return { label, value: "—", sub: available ? "no app services" : "collector offline", tone: "neutral", icon: Activity }
  }
  const vals = apps
    .map((s) => s[key])
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
  if (vals.length === 0) return { label, value: "—", sub: "no data", tone: "neutral", icon: Activity }
  const v = mean(vals)
  const override = overrides[key] ?? tile.thresholds
  const thresholds = {
    direction: descriptor.thresholds?.direction ?? ("lower-better" as const),
    warn: override?.warn ?? descriptor.thresholds?.warn,
    critical: override?.critical ?? descriptor.thresholds?.critical,
  }
  const tone = levelTone(evaluateHealth({ ...descriptor, thresholds }, v))
  const suffix = descriptor.format === "percent" ? "%" : descriptor.unit
  return { label, value: `${v}${suffix}`, sub: "fleet mean · live", tone, icon: Activity }
}

// A query tile = a PromQL scalar fetched from /api/tiles.
function queryTileToTile(tile: DashboardTileView, q: { value: number | null; loaded: boolean }): Tile {
  const label = tile.label ?? tile.id
  if (!q.loaded) return { label, value: "…", sub: "loading", tone: "neutral", icon: Activity }
  if (q.value === null) return { label, value: "—", sub: "no data", tone: "neutral", icon: Activity }
  const v = Math.round(q.value * 100) / 100
  const warn = tile.thresholds?.warn
  const crit = tile.thresholds?.critical
  const tone: Tone =
    crit !== undefined && v >= crit
      ? "bad"
      : warn !== undefined && v >= warn
      ? "warn"
      : warn !== undefined || crit !== undefined
      ? "good"
      : "neutral"
  return { label, value: `${v}${tile.unit ?? ""}`, sub: "live · query", tone, icon: Activity }
}

function TileSlot({
  tile,
  apps,
  available,
  overrides,
}: {
  tile: DashboardTileView
  apps: { [k: string]: unknown }[]
  available: boolean
  overrides: Record<string, { warn?: number; critical?: number }>
}) {
  // Always call the hook (no-op when not a query tile) to keep hook order stable.
  const q = useTile(tile.kind === "query" ? tile.id : null)
  const t = tile.kind === "query" ? queryTileToTile(tile, q) : metricTileToTile(tile, apps, available, overrides)
  return <TileCard t={t} />
}

function ConfiguredStatsTiles({ tiles }: { tiles: DashboardTileView[] }) {
  const { realMetrics } = useLiveMetrics()
  const { config } = useDashboardConfig()
  const available = realMetrics.available
  const apps = (available ? appServices(realMetrics.services, config.infraWorkloads) : []) as unknown as {
    [k: string]: unknown
  }[]
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3">
      {tiles.map((tile) => (
        <TileSlot key={tile.id} tile={tile} apps={apps} available={available} overrides={config.thresholds} />
      ))}
    </div>
  )
}
