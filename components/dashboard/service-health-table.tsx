"use client"

import { useDashboardConfig } from "@/hooks/use-dashboard-config"
import { useRealMetrics, type RealServiceMetric } from "@/hooks/use-real-metrics"
import { appServices } from "@/lib/dashboard/service-filter"
import {
  getDescriptor,
  evaluateHealth,
  type MetricDescriptor,
  type MetricThresholds,
} from "@/lib/metrics/descriptors"
import { Server } from "lucide-react"

// Default column order when `dashboard.serviceTable.columns` is "auto". Every key
// maps to a real field a source can report; a column is only rendered if at least
// one service actually reports that field — so latency/RPS (Prometheus-only)
// appear automatically when present and stay hidden for the CPU/mem-only collector.
const AUTO_COLUMNS = ["status", "errorRate", "latencyP95", "avgCpu", "avgMemory", "rps", "readyPods"]

function StatusDot({ status }: { status: string }) {
  const cfg: Record<string, { color: string; label: string; pulse: boolean }> = {
    healthy: { color: "bg-[var(--neon-green)]", label: "Healthy", pulse: false },
    degraded: { color: "bg-[var(--neon-orange)]", label: "Degraded", pulse: true },
    critical: { color: "bg-[var(--neon-red)]", label: "Critical", pulse: true },
    warning: { color: "bg-[var(--neon-yellow)]", label: "Warning", pulse: true },
  }
  const c = cfg[status] ?? cfg.healthy
  return (
    <div className="flex items-center gap-1.5">
      <span className="relative flex h-2 w-2">
        {c.pulse && <span className={`animate-ping absolute inline-flex h-full w-full rounded-full ${c.color} opacity-75`} />}
        <span className={`relative inline-flex rounded-full h-2 w-2 ${c.color}`} />
      </span>
      <span
        className={`text-[10px] font-mono ${
          status === "healthy"
            ? "text-[var(--neon-green)]"
            : status === "critical"
            ? "text-[var(--neon-red)]"
            : status === "warning"
            ? "text-[var(--neon-yellow)]"
            : "text-[var(--neon-orange)]"
        }`}
      >
        {c.label}
      </span>
    </div>
  )
}

function MiniBar({ value, warn, crit }: { value: number; warn: number; crit: number }) {
  const color =
    value >= crit
      ? "bg-[var(--neon-red)]"
      : value >= warn
      ? "bg-[var(--neon-orange)]"
      : "bg-[var(--neon-cyan)]"
  return (
    <div className="flex items-center gap-2">
      <div className="w-16 h-1.5 bg-border rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
      </div>
      <span suppressHydrationWarning className={`text-[10px] font-mono ${value >= crit ? "text-[var(--neon-red)]" : value >= warn ? "text-[var(--neon-orange)]" : "text-muted-foreground"}`}>
        {Math.round(value)}%
      </span>
    </div>
  )
}

const healthColor: Record<string, string> = {
  healthy: "text-[var(--neon-green)]",
  warn: "text-[var(--neon-orange)]",
  critical: "text-[var(--neon-red)]",
  unknown: "text-foreground/80",
}

// Merge descriptor thresholds with any per-metric config override.
function mergeThresholds(
  descriptor: MetricDescriptor,
  override?: { warn?: number; critical?: number }
): MetricThresholds {
  const base = descriptor.thresholds ?? { direction: "neutral" as const }
  return {
    direction: base.direction,
    warn: override?.warn ?? base.warn,
    critical: override?.critical ?? base.critical,
  }
}

export function ServiceHealthTable() {
  const realMetrics = useRealMetrics()
  const { config } = useDashboardConfig()

  const services = realMetrics.available
    ? appServices(realMetrics.services, config.infraWorkloads)
    : []

  // Resolve the columns to render. "auto" derives from the fields actually present
  // in the data; an explicit list is honoured as-is.
  const columnKeys =
    config.serviceTable.columns === "auto"
      ? AUTO_COLUMNS.filter((key) =>
          key === "readyPods"
            ? services.some((s) => typeof s.podCount === "number")
            : services.some((s) => typeof (s as unknown as Record<string, unknown>)[key] !== "undefined")
        )
      : config.serviceTable.columns

  const healthyCount = services.filter((s) => s.status === "healthy").length

  function renderCell(key: string, svc: RealServiceMetric) {
    const descriptor = getDescriptor(key)
    const thresholds = mergeThresholds(descriptor, config.thresholds[key])

    if (key === "status") return <StatusDot status={svc.status} />

    if (key === "readyPods" || key === "podCount") {
      const crashed = svc.crashedPods > 0
      const notReady = svc.readyPods < svc.podCount
      return (
        <span
          suppressHydrationWarning
          className={`font-mono text-xs ${crashed ? "text-[var(--neon-red)]" : notReady ? "text-[var(--neon-orange)]" : "text-foreground/80"}`}
        >
          {svc.readyPods}/{svc.podCount}
        </span>
      )
    }

    const raw = (svc as unknown as Record<string, unknown>)[key]
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      return <span className="font-mono text-xs text-muted-foreground">—</span>
    }

    if (descriptor.format === "percent" && descriptor.viz === "gauge") {
      return <MiniBar value={raw} warn={thresholds.warn ?? 70} crit={thresholds.critical ?? 90} />
    }

    const level = evaluateHealth({ ...descriptor, thresholds }, raw)
    const suffix = descriptor.format === "percent" ? "%" : descriptor.unit
    const display = descriptor.format === "percent" ? raw.toFixed(2) : String(raw)
    return (
      <span suppressHydrationWarning className={`font-mono text-xs font-semibold ${healthColor[level]}`}>
        {display}
        {suffix}
      </span>
    )
  }

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <h2 className="text-xs font-mono font-semibold text-muted-foreground tracking-widest uppercase">
            Service Health
          </h2>
          {realMetrics.available && (
            <span className="text-[10px] font-mono text-muted-foreground">
              {healthyCount}/{services.length} healthy
            </span>
          )}
          <span className="flex items-center gap-1 text-[10px] font-mono">
            <span className={`w-1.5 h-1.5 rounded-full ${realMetrics.available ? "bg-[var(--neon-green)]" : "bg-muted-foreground"}`} />
            <span className={realMetrics.available ? "text-[var(--neon-green)]" : "text-muted-foreground"}>
              {realMetrics.available ? "LIVE" : "OFFLINE"}
            </span>
          </span>
        </div>
      </div>

      <div className="card-glass rounded-lg overflow-hidden">
        {!realMetrics.available ? (
          <div className="py-10 px-4 flex flex-col items-center justify-center gap-2 text-center">
            <Server className="w-6 h-6 text-muted-foreground/50" />
            <p className="text-xs font-mono text-muted-foreground">Metrics collector unreachable</p>
            <p className="text-[10px] font-mono text-muted-foreground/70">
              No service data to display — waiting for a live source.
            </p>
          </div>
        ) : services.length === 0 ? (
          <div className="py-10 px-4 flex flex-col items-center justify-center gap-2 text-center">
            <Server className="w-6 h-6 text-muted-foreground/50" />
            <p className="text-xs font-mono text-muted-foreground">No application services reported</p>
            <p className="text-[10px] font-mono text-muted-foreground/70">
              The collector is live but no application workloads were found.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border bg-secondary/30">
                  <th className="text-left py-2.5 px-4 font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
                    Service
                  </th>
                  {columnKeys.map((key) => (
                    <th
                      key={key}
                      className="text-left py-2.5 px-4 font-mono text-[10px] text-muted-foreground uppercase tracking-wider"
                    >
                      {getDescriptor(key).label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {services.map((svc, i) => (
                  <tr
                    key={`${svc.namespace ?? ""}/${svc.name}`}
                    className={`border-b border-border/40 transition-colors hover:bg-secondary/20 ${
                      i === services.length - 1 ? "border-b-0" : ""
                    } ${svc.status === "critical" ? "bg-[var(--neon-red)]/3" : ""}`}
                  >
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-2">
                        <Server className="w-3 h-3 text-muted-foreground shrink-0" />
                        <div>
                          <p className="font-mono font-semibold text-foreground text-xs">{svc.name}</p>
                          {svc.namespace && (
                            <p className="text-[9px] text-muted-foreground font-mono">{svc.namespace}</p>
                          )}
                        </div>
                      </div>
                    </td>
                    {columnKeys.map((key) => (
                      <td key={key} className="py-3 px-4">
                        {renderCell(key, svc)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  )
}
