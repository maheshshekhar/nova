"use client"

import { useEffect, useRef, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { getLiveServiceMetrics, services } from "@/lib/dashboard-data"
import { useLiveState, type LivePhase } from "@/lib/live-state"
import { useRealMetrics } from "@/hooks/use-real-metrics"
import { ArrowUpRight, Server } from "lucide-react"

type ServiceMetric = (typeof services)[number]
type FlashDirection = "up" | "down"
type FlashMap = Record<string, FlashDirection>

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))
const lerp = (a: number, b: number, p: number) => a + (b - a) * clamp(p, 0, 1)

// App workloads deployed by deploy-app (postgres lives separately). They only
// belong in the Service Health table once they actually exist in the cluster, so
// an infra-only setup (just `cluster`, no `deploy-app`) doesn't show phantom rows.
const APP_SERVICES = new Set(["payment-service", "config-service", "transaction-service"])

// payment-service values during the HEALTHY / DEGRADING phases.
function phasePayment(svc: ServiceMetric, phase: LivePhase, t: number): ServiceMetric {
  if (phase === "healthy") {
    return { ...svc, status: "healthy", errorRate: 0.08, cpu: 34, memory: 52 }
  }
  // degrading: 0-30s healthy & climbing, 30-59s degraded & climbing
  if (t < 30) {
    const p = t / 30
    return {
      ...svc,
      status: "healthy",
      cpu: Math.round(clamp(lerp(34, 70, p), 0, 100)),
      memory: Math.round(clamp(lerp(52, 70, p), 0, 100)),
      errorRate: Number(clamp(lerp(0.08, 0.5, p), 0, 100).toFixed(2)),
    }
  }
  const p = (t - 30) / 30
  return {
    ...svc,
    status: "degraded",
    cpu: Math.round(clamp(lerp(70, 91, p), 0, 100)),
    memory: Math.round(clamp(lerp(70, 87, p), 0, 100)),
    errorRate: Number(clamp(lerp(0.5, 5.21, p), 0, 100).toFixed(2)),
  }
}

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

export function ServiceHealthTable() {
  const router = useRouter()
  const { phase, secondsElapsed, isResolved, currentIncidentId } = useLiveState()
  const realMetrics = useRealMetrics()
  const [metrics, setMetrics] = useState<ServiceMetric[]>(services)
  const [flashes, setFlashes] = useState<FlashMap>({})
  // React to the active incident's resolution: payment-service recovers to healthy.
  const paymentResolved = isResolved(currentIncidentId)
  const prevRef = useRef<ServiceMetric[]>(services)

  useEffect(() => {
    const refresh = () => {
      const next = getLiveServiceMetrics()
      const prev = prevRef.current
      const newFlashes: FlashMap = {}

      next.forEach((svc, i) => {
        const before = prev[i]
        if (!before) return
        ;(["rps", "errorRate", "cpu", "memory"] as const).forEach((field) => {
          if (svc[field] !== before[field]) {
            newFlashes[flashKey(svc.name, field)] = svc[field] > before[field] ? "up" : "down"
          }
        })
      })

      prevRef.current = next
      setMetrics(next)
      setFlashes(newFlashes)
    }

    refresh()
    const interval = setInterval(refresh, 3000)
    return () => clearInterval(interval)
  }, [])

  // Clear the tint shortly after a refresh so it reads as a brief pulse.
  useEffect(() => {
    if (Object.keys(flashes).length === 0) return
    const t = setTimeout(() => setFlashes({}), 500)
    return () => clearTimeout(t)
  }, [flashes])

  // Map of services that exist in the real cluster (via the metrics collector).
  const liveConnected = realMetrics.available
  const realByName = new Map(
    liveConnected ? realMetrics.services.map((s) => [s.name, s] as const) : []
  )

  // Is the REAL failure currently active? (payment-service unhealthy in the cluster,
  // or the load-generator still running). This is what the decorative services and
  // the healthy count track — NOT the latched incident phase — so that once
  // recover actually heals the cluster the whole table reflects recovery, even
  // before the engineer works the recovery checklist.
  const realPayment = realByName.get("payment-service")
  const realLoadGen = realByName.get("load-generator")
  const realIncidentActive =
    liveConnected &&
    (((realPayment && realPayment.status !== "healthy") || (!!realLoadGen && realLoadGen.readyPods > 0)) ?? false)

  // Build the displayed rows.
  //
  // When the cluster is LIVE (collector reachable), the table reflects real cluster
  // health: services that exist in the cluster show their real pod metrics, and the
  // decorative services (no real counterpart) mirror the real incident — they show
  // their degraded/warning narrative while the real failure is active, and go
  // healthy once the cluster has recovered.
  //
  // When OFFLINE (no collector), fall back to the phase-driven simulation.
  const finalMetrics = metrics
    .map((svc) => {
      const real = realByName.get(svc.name)
      if (real) {
        return {
          ...svc,
          cpu: real.avgCpu,
          memory: real.avgMemory,
          errorRate: real.errorRate,
          status: real.status,
          instances: real.podCount,
        }
      }
      // App service with no real counterpart while the collector is live = not
      // deployed yet (deploy-app brings it in) → omit the row entirely.
      if (liveConnected && APP_SERVICES.has(svc.name)) return null
      if (liveConnected) {
        // Decorative service: keep its baseline (degraded/warning) while the real
        // failure is active; present it as healthy once the cluster has recovered.
        if (realIncidentActive) return svc
        return svc.status === "healthy"
          ? svc
          : { ...svc, status: "healthy", errorRate: Math.min(svc.errorRate, 0.2) }
      }
      // Offline fallback: phase-driven simulation.
      if (phase === "incident") {
        return paymentResolved && svc.name === "payment-service"
          ? { ...svc, status: "healthy", errorRate: 0.42, cpu: 34, memory: 52 }
          : svc
      }
      if (svc.name === "payment-service") {
        return phasePayment(svc, phase, secondsElapsed)
      }
      if (svc.status !== "healthy") {
        return { ...svc, status: "healthy", errorRate: Math.min(svc.errorRate, 0.2) }
      }
      return svc
    })
    .filter((svc): svc is ServiceMetric => svc !== null)

  // Live tint only matters in the INCIDENT phase with simulated data; suppress
  // it for real metrics, outside the incident phase, and once payment recovered.
  const cellFlash = (name: string, field: string) =>
    liveConnected || phase !== "incident" || (paymentResolved && name === "payment-service")
      ? ""
      : flashClass(flashes, name, field)

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <h2 className="text-xs font-mono font-semibold text-muted-foreground tracking-widest uppercase">
            Service Health
          </h2>
          <span className="text-[10px] font-mono text-muted-foreground">
            {finalMetrics.filter((s) => s.status === "healthy").length}/{finalMetrics.length} healthy
          </span>
          <span className="flex items-center gap-1 text-[10px] font-mono">
            <span className={`w-1.5 h-1.5 rounded-full ${realMetrics.available ? "bg-[var(--neon-green)]" : "bg-muted-foreground"}`} />
            <span className={realMetrics.available ? "text-[var(--neon-green)]" : "text-muted-foreground"}>
              {realMetrics.available ? "LIVE" : "SIMULATED"}
            </span>
          </span>
        </div>
        <button className="text-xs text-primary hover:text-[var(--neon-cyan)] transition-colors flex items-center gap-1">
          All services <ArrowUpRight className="w-3 h-3" />
        </button>
      </div>

      <div className="card-glass rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border bg-secondary/30">
                <th className="text-left py-2.5 px-4 font-mono text-[10px] text-muted-foreground uppercase tracking-wider">Service</th>
                <th className="text-left py-2.5 px-4 font-mono text-[10px] text-muted-foreground uppercase tracking-wider">Status</th>
                <th className="text-left py-2.5 px-4 font-mono text-[10px] text-muted-foreground uppercase tracking-wider">Uptime</th>
                <th className="text-right py-2.5 px-4 font-mono text-[10px] text-muted-foreground uppercase tracking-wider">RPS</th>
                <th className="text-right py-2.5 px-4 font-mono text-[10px] text-muted-foreground uppercase tracking-wider">p50</th>
                <th className="text-right py-2.5 px-4 font-mono text-[10px] text-muted-foreground uppercase tracking-wider">p95</th>
                <th className="text-right py-2.5 px-4 font-mono text-[10px] text-muted-foreground uppercase tracking-wider">Err%</th>
                <th className="text-left py-2.5 px-4 font-mono text-[10px] text-muted-foreground uppercase tracking-wider">CPU</th>
                <th className="text-left py-2.5 px-4 font-mono text-[10px] text-muted-foreground uppercase tracking-wider">Mem</th>
                <th className="text-right py-2.5 px-4 font-mono text-[10px] text-muted-foreground uppercase tracking-wider">Pods</th>
              </tr>
            </thead>
            <tbody>
              {finalMetrics.map((svc, i) => {
                const isPayment = svc.name === "payment-service"
                return (
                <tr
                  key={svc.name}
                  onClick={isPayment ? () => router.push(`/incidents/${currentIncidentId}`) : undefined}
                  className={`border-b border-border/40 transition-colors ${
                    i === finalMetrics.length - 1 ? "border-b-0" : ""
                  } ${svc.status === "critical" ? "bg-[var(--neon-red)]/3" : ""} ${
                    isPayment
                      ? "cursor-pointer hover:bg-secondary/30 hover:border-[var(--neon-cyan)]/40"
                      : "hover:bg-secondary/20"
                  }`}
                >
                  <td className="py-3 px-4">
                    <div className="flex items-center gap-2">
                      <Server className="w-3 h-3 text-muted-foreground shrink-0" />
                      <div>
                        <p className="font-mono font-semibold text-foreground text-xs">{svc.name}</p>
                        <p className="text-[9px] text-muted-foreground font-mono">{svc.region}</p>
                      </div>
                    </div>
                  </td>
                  <td className="py-3 px-4">
                    <StatusDot status={svc.status} />
                  </td>
                  <td className="py-3 px-4">
                    <span className={`font-mono text-xs ${svc.uptime === "100.00%" ? "text-[var(--neon-green)]" : svc.uptime < "99.80%" ? "text-[var(--neon-red)]" : "text-foreground/80"}`}>
                      {svc.uptime}
                    </span>
                  </td>
                  <td className={`py-3 px-4 text-right ${cellFlash(svc.name, "rps")}`}>
                    <span suppressHydrationWarning className="font-mono text-xs text-foreground/80">
                      {svc.rps >= 1000 ? `${(svc.rps / 1000).toFixed(1)}k` : svc.rps}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-right">
                    <span className="font-mono text-xs text-foreground/80">{svc.latencyP50}ms</span>
                  </td>
                  <td className="py-3 px-4 text-right">
                    <span className={`font-mono text-xs ${svc.latencyP95 > 500 ? "text-[var(--neon-red)]" : svc.latencyP95 > 200 ? "text-[var(--neon-orange)]" : "text-foreground/80"}`}>
                      {svc.latencyP95}ms
                    </span>
                  </td>
                  <td className={`py-3 px-4 text-right ${cellFlash(svc.name, "errorRate")}`}>
                    <span suppressHydrationWarning className={`font-mono text-xs font-semibold ${svc.errorRate > 2.5 ? "text-[var(--neon-red)]" : svc.errorRate > 1.0 ? "text-[var(--neon-orange)]" : "text-[var(--neon-green)]"}`}>
                      {svc.errorRate.toFixed(2)}%
                    </span>
                  </td>
                  <td className={`py-3 px-4 ${cellFlash(svc.name, "cpu")}`}>
                    <MiniBar value={svc.cpu} />
                  </td>
                  <td className={`py-3 px-4 ${cellFlash(svc.name, "memory")}`}>
                    <MiniBar value={svc.memory} warn={75} crit={88} />
                  </td>
                  <td className="py-3 px-4 text-right">
                    <div className="flex items-center justify-end gap-1.5">
                      <span className="font-mono text-xs text-muted-foreground">{svc.instances}x</span>
                      {isPayment && (
                        <Link
                          href={`/incidents/${currentIncidentId}`}
                          onClick={(e) => e.stopPropagation()}
                          className="text-[var(--neon-cyan)] hover:text-[var(--neon-cyan)] transition-colors"
                          aria-label={`View incident ${currentIncidentId}`}
                        >
                          <ArrowUpRight className="w-3 h-3" />
                        </Link>
                      )}
                    </div>
                  </td>
                </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  )
}
