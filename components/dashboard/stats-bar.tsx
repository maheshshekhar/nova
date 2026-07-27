"use client"

import { useEffect, useState } from "react"
import { useRealMetrics } from "@/hooks/use-real-metrics"
import { useLiveDeployments } from "@/components/dashboard/deployment-cards"
import { Activity, AlertOctagon, CheckCircle2, Cpu, Shield } from "lucide-react"

const GREEN = { color: "text-[var(--neon-green)]", border: "border-[var(--neon-green)]/20", bg: "bg-[var(--neon-green)]/5" }
const ORANGE = { color: "text-[var(--neon-orange)]", border: "border-[var(--neon-orange)]/20", bg: "bg-[var(--neon-orange)]/5" }
const RED = { color: "text-[var(--neon-red)]", border: "border-[var(--neon-red)]/20", bg: "bg-[var(--neon-red)]/5" }
const CYAN = { color: "text-[var(--neon-cyan)]", border: "border-[var(--neon-cyan)]/20", bg: "bg-[var(--neon-cyan)]/5" }
const BLUE = { color: "text-[var(--neon-blue)]", border: "border-[var(--neon-blue)]/20", bg: "bg-[var(--neon-blue)]/5" }
const MUTED = { color: "text-muted-foreground", border: "border-border", bg: "bg-secondary/20" }

interface StatItem {
  label: string
  value: string
  sub: string
  icon: typeof Cpu
  color: string
  border: string
  bg: string
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)

// Poll the real incident store for the open-incident count.
function useOpenIncidentCount() {
  const [count, setCount] = useState<number | null>(null)
  useEffect(() => {
    let cancelled = false
    const load = () =>
      fetch("/api/incidents?range=all", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (cancelled) return
          const list = Array.isArray(d?.incidents) ? d.incidents : []
          setCount(list.filter((i: { status?: string }) => i.status && i.status !== "resolved").length)
        })
        .catch(() => {})
    load()
    const t = setInterval(load, 5000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [])
  return count
}

// Stats bar — 100% real. Only tiles backed by an actual data source are shown:
// service health + CPU + error rate from the metrics collector, deployments from
// the collector, and open incidents from the incident store. Metrics the
// collector cannot provide (request volume, latency, apdex) are intentionally
// omitted rather than simulated. Tiles read "—" when their source is offline.
export function StatsBar() {
  const realMetrics = useRealMetrics()
  const deployments = useLiveDeployments()
  const openIncidents = useOpenIncidentCount()

  const live = realMetrics.available
  const svcs = realMetrics.services
  const healthy = svcs.filter((s) => s.status === "healthy").length
  const avgCpu = Math.round(mean(svcs.map((s) => s.avgCpu)))
  const avgErr = Number(mean(svcs.map((s) => s.errorRate)).toFixed(2))
  const running = deployments.filter((d) => d.status === "running").length
  const failed = deployments.filter((d) => d.status === "failed").length

  const stats: StatItem[] = [
    {
      label: "Healthy Services",
      value: live && svcs.length ? `${healthy} / ${svcs.length}` : "—",
      sub: !live ? "Metrics offline" : svcs.length === 0 ? "No services reporting" : healthy === svcs.length ? "All operational" : `${svcs.length - healthy} need attention`,
      icon: CheckCircle2,
      ...(live && svcs.length && healthy < svcs.length ? ORANGE : live && svcs.length ? GREEN : MUTED),
    },
    {
      label: "Open Incidents",
      value: openIncidents === null ? "—" : String(openIncidents),
      sub: openIncidents === null ? "Store unreachable" : openIncidents === 0 ? "No active incidents" : `${openIncidents} active`,
      icon: Shield,
      ...(openIncidents && openIncidents > 0 ? RED : GREEN),
    },
    {
      label: "Active Deployments",
      value: String(deployments.length),
      sub: running > 0 ? `${running} rolling out` : failed > 0 ? `${failed} failed` : deployments.length ? "all healthy" : "none reported",
      icon: Activity,
      ...(failed > 0 ? RED : BLUE),
    },
    {
      label: "CPU Utilization",
      value: live && svcs.length ? `${avgCpu}%` : "—",
      sub: live && svcs.length ? "Avg across all pods" : "Metrics offline",
      icon: Cpu,
      ...(live && svcs.length ? CYAN : MUTED),
    },
    {
      label: "Avg Error Rate",
      value: live && svcs.length ? `${avgErr}%` : "—",
      sub: live && svcs.length ? "Inferred from pod state" : "Metrics offline",
      icon: AlertOctagon,
      ...(live && svcs.length && avgErr > 1 ? RED : live && svcs.length ? GREEN : MUTED),
    },
  ]

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
      {stats.map((s) => (
        <div key={s.label} className={`card-glass rounded-lg border ${s.border} ${s.bg} p-4`}>
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">{s.label}</span>
            <s.icon className={`w-3.5 h-3.5 ${s.color}`} />
          </div>
          <div suppressHydrationWarning className={`text-2xl font-mono font-semibold ${s.color}`}>{s.value}</div>
          <div className="text-[10px] font-mono text-muted-foreground mt-1">{s.sub}</div>
        </div>
      ))}
    </div>
  )
}
