"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { CheckCircle2, Loader2, XCircle, ArrowUpRight, Layers, Box } from "lucide-react"

export type Deployment = {
  name: string
  namespace: string
  image: string
  version: string
  replicas: number
  readyReplicas: number
  status: "success" | "running" | "failed"
  updatedAt: string
}

function agoLabel(iso: string): string {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return ""
  const min = Math.round((Date.now() - ms) / 60000)
  if (min < 1) return "just now"
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h ago`
  return `${Math.round(hr / 24)}d ago`
}

// Live deployments from the metrics collector (polled). Shared by the overview
// widget and the full deployments page.
export function useLiveDeployments() {
  const [deployments, setDeployments] = useState<Deployment[]>([])
  useEffect(() => {
    let cancelled = false
    const load = () =>
      fetch("/api/metrics?endpoint=metrics/deployments")
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (!cancelled) setDeployments(d?.deployments ?? [])
        })
        .catch(() => {})
    load()
    const t = setInterval(load, 5000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [])
  return deployments
}

const statusConfig = {
  success: {
    icon: CheckCircle2,
    color: "text-[var(--neon-green)]",
    bg: "bg-[var(--neon-green)]/10",
    border: "border-[var(--neon-green)]/20",
    glow: "neon-glow-green",
    label: "SUCCESS",
  },
  running: {
    icon: Loader2,
    color: "text-[var(--neon-cyan)]",
    bg: "bg-[var(--neon-cyan)]/10",
    border: "border-[var(--neon-cyan)]/20",
    glow: "neon-glow-cyan",
    label: "DEPLOYING",
  },
  failed: {
    icon: XCircle,
    color: "text-[var(--neon-red)]",
    bg: "bg-[var(--neon-red)]/10",
    border: "border-[var(--neon-red)]/20",
    glow: "neon-glow-red",
    label: "FAILED",
  },
} as const

export function DeploymentCards() {
  const deployments = useLiveDeployments()
  const recent = deployments.slice(0, 4)
  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-xs font-mono font-semibold text-muted-foreground tracking-widest uppercase">
          Recent Deployments
        </h2>
        <Link
          href="/deployments"
          className="text-xs text-primary hover:text-[var(--neon-cyan)] transition-colors flex items-center gap-1"
        >
          View all <ArrowUpRight className="w-3 h-3" />
        </Link>
      </div>
      {recent.length === 0 ? (
        <div className="card-glass rounded-lg px-4 py-6 text-center text-xs font-mono text-muted-foreground">
          No deployments reported yet.
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
          {recent.map((dep) => (
            <DeploymentCard key={`${dep.namespace}/${dep.name}`} dep={dep} />
          ))}
        </div>
      )}
    </section>
  )
}

export function DeploymentCard({ dep }: { dep: Deployment }) {
  const cfg = statusConfig[dep.status]
  const Icon = cfg.icon
  return (
    <div className="card-glass rounded-lg p-4 flex flex-col gap-3 hover:border-primary/30 transition-all group">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-mono font-bold text-sm text-foreground truncate group-hover:text-[var(--neon-cyan)] transition-colors">
            {dep.name}
          </p>
          <p className="text-[10px] font-mono text-muted-foreground mt-0.5 truncate">{dep.version}</p>
        </div>
        <div className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold ${cfg.bg} ${cfg.border} border ${cfg.color} shrink-0`}>
          <Icon className={`w-3 h-3 ${dep.status === "running" ? "animate-spin" : ""}`} />
          {cfg.label}
        </div>
      </div>

      {/* Image + replicas */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Box className="w-3 h-3 shrink-0" />
          <span className="truncate font-mono">{dep.image || "—"}</span>
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Layers className="w-3 h-3 shrink-0" />
          <span className="font-mono text-foreground/70">
            {dep.readyReplicas}/{dep.replicas} ready
          </span>
        </div>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between pt-1 border-t border-border/50">
        <span
          className={`text-[9px] font-mono uppercase px-1.5 py-0.5 rounded border ${
            dep.namespace === "production"
              ? "text-[var(--neon-orange)] border-[var(--neon-orange)]/30 bg-[var(--neon-orange)]/5"
              : "text-[var(--neon-blue)] border-[var(--neon-blue)]/30 bg-[var(--neon-blue)]/5"
          }`}
        >
          {dep.namespace}
        </span>
        <span className="text-[10px] text-muted-foreground">{agoLabel(dep.updatedAt)}</span>
      </div>
    </div>
  )
}
