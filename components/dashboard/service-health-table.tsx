"use client"

import { useEffect, useRef, useState } from "react"
import { useRealMetrics, type RealServiceMetric } from "@/hooks/use-real-metrics"
import { Server, Activity } from "lucide-react"

type FlashDirection = "up" | "down"
type FlashMap = Record<string, FlashDirection>

const flashKey = (name: string, field: string) => `${name}:${field}`

function flashClass(flashes: FlashMap, name: string, field: string) {
  const dir = flashes[flashKey(name, field)]
  if (!dir) return ""
  return dir === "up"
    ? "bg-[var(--neon-red)]/15 transition-colors duration-500"
    : "bg-[var(--neon-green)]/15 transition-colors duration-500"
}

function StatusDot({ status }: { status: string }) {
  const cfg: Record<string, { color: string; label: string; pulse: boolean }> = {
    healthy: { color: "bg-[var(--neon-green)]", label: "Healthy", pulse: false },
    degraded: { color: "bg-[var(--neon-orange)]", label: "Degraded", pulse: true },
    critical: { color: "bg-[var(--neon-red)]", label: "Critical", pulse: true },
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
            : "text-[var(--neon-orange)]"
        }`}
      >
        {c.label}
      </span>
    </div>
  )
}

function MiniBar({ value, warn = 70, crit = 85 }: { value: number; warn?: number; crit?: number }) {
  const color =
    value >= crit
      ? "bg-[var(--neon-red)]"
      : value >= warn
      ? "bg-[var(--neon-orange)]"
      : "bg-[var(--neon-cyan)]"
  return (
    <div className="flex items-center gap-2">
      <div className="w-16 h-1.5 bg-border rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${value}%` }} />
      </div>
      <span suppressHydrationWarning className={`text-[10px] font-mono ${value >= crit ? "text-[var(--neon-red)]" : value >= warn ? "text-[var(--neon-orange)]" : "text-muted-foreground"}`}>
        {value}%
      </span>
    </div>
  )
}

// Service Health — 100% real. Rows come straight from the metrics collector
// (pod CPU/mem/status/count + inferred error rate) across every namespace. When
// the collector is unreachable the table shows an explicit empty state instead of
// any simulated data.
export function ServiceHealthTable() {
  const realMetrics = useRealMetrics()
  const services = realMetrics.services
  const [flashes, setFlashes] = useState<FlashMap>({})
  const prevRef = useRef<Map<string, RealServiceMetric>>(new Map())

  // Flash cells whose real values changed since the last poll.
  useEffect(() => {
    const prev = prevRef.current
    const newFlashes: FlashMap = {}
    for (const svc of services) {
      const before = prev.get(svc.name)
      if (before) {
        ;(["errorRate", "avgCpu", "avgMemory"] as const).forEach((field) => {
          if (svc[field] !== before[field]) {
            newFlashes[flashKey(svc.name, field)] = svc[field] > before[field] ? "up" : "down"
          }
        })
      }
    }
    prevRef.current = new Map(services.map((s) => [s.name, s] as const))
    if (Object.keys(newFlashes).length) setFlashes(newFlashes)
  }, [services])

  useEffect(() => {
    if (Object.keys(flashes).length === 0) return
    const t = setTimeout(() => setFlashes({}), 500)
    return () => clearTimeout(t)
  }, [flashes])

  const healthy = services.filter((s) => s.status === "healthy").length

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <h2 className="text-xs font-mono font-semibold text-muted-foreground tracking-widest uppercase">
            Service Health
          </h2>
          {realMetrics.available && (
            <span className="text-[10px] font-mono text-muted-foreground">
              {healthy}/{services.length} healthy
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
        {!realMetrics.available || services.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
            <Activity className="w-6 h-6 text-muted-foreground" />
            <p className="text-xs font-mono text-muted-foreground">
              {realMetrics.available ? "No services reporting metrics yet" : "No live metrics"}
            </p>
            <p className="text-[10px] font-mono text-muted-foreground/70 max-w-sm">
              Deploy a workload with its metrics-collector and point Nova at it to see real service health.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border bg-secondary/30">
                  <th className="text-left py-2.5 px-4 font-mono text-[10px] text-muted-foreground uppercase tracking-wider">Service</th>
                  <th className="text-left py-2.5 px-4 font-mono text-[10px] text-muted-foreground uppercase tracking-wider">Namespace</th>
                  <th className="text-left py-2.5 px-4 font-mono text-[10px] text-muted-foreground uppercase tracking-wider">Status</th>
                  <th className="text-right py-2.5 px-4 font-mono text-[10px] text-muted-foreground uppercase tracking-wider">Err%</th>
                  <th className="text-left py-2.5 px-4 font-mono text-[10px] text-muted-foreground uppercase tracking-wider">CPU</th>
                  <th className="text-left py-2.5 px-4 font-mono text-[10px] text-muted-foreground uppercase tracking-wider">Mem</th>
                  <th className="text-right py-2.5 px-4 font-mono text-[10px] text-muted-foreground uppercase tracking-wider">Pods</th>
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
                        <p className="font-mono font-semibold text-foreground text-xs">{svc.name}</p>
                      </div>
                    </td>
                    <td className="py-3 px-4">
                      <span className="font-mono text-[10px] text-muted-foreground">{svc.namespace ?? "—"}</span>
                    </td>
                    <td className="py-3 px-4">
                      <StatusDot status={svc.status} />
                    </td>
                    <td className={`py-3 px-4 text-right ${flashClass(flashes, svc.name, "errorRate")}`}>
                      <span suppressHydrationWarning className={`font-mono text-xs ${svc.errorRate > 1 ? "text-[var(--neon-red)]" : "text-foreground/80"}`}>
                        {svc.errorRate.toFixed(2)}%
                      </span>
                    </td>
                    <td className={`py-3 px-4 ${flashClass(flashes, svc.name, "avgCpu")}`}>
                      <MiniBar value={svc.avgCpu} />
                    </td>
                    <td className={`py-3 px-4 ${flashClass(flashes, svc.name, "avgMemory")}`}>
                      <MiniBar value={svc.avgMemory} />
                    </td>
                    <td className="py-3 px-4 text-right">
                      <span suppressHydrationWarning className={`font-mono text-xs ${svc.readyPods < svc.podCount ? "text-[var(--neon-orange)]" : "text-foreground/80"}`}>
                        {svc.readyPods}/{svc.podCount}
                      </span>
                    </td>
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
