"use client"

import { AlertTriangle, ArrowLeft, ArrowUpRight, CheckCircle2, Clock, Filter, Search, Users, Zap } from "lucide-react"
import { useEffect, useState } from "react"
import Link from "next/link"

// Shape returned by GET /api/incidents (subset the list page needs).
type ApiIncident = {
  id: string
  title: string
  service: string
  severity: string
  status: string
  startedAt: number
  resolvedAt: number | null
  durationMin: number | null
  affectedUsers?: number
}

function agoLabel(ms: number): string {
  const diff = Date.now() - ms
  const min = Math.round(diff / 60000)
  if (min < 1) return "just now"
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.round(hr / 24)
  if (day < 30) return `${day}d ago`
  const mo = Math.round(day / 30)
  if (mo < 12) return `${mo}mo ago`
  return `${Math.round(mo / 12)}y ago`
}

function durationLabel(min: number | null): string {
  if (!min) return "—"
  if (min < 60) return `${min}min`
  const h = Math.floor(min / 60)
  const m = min % 60
  return m ? `${h}h ${m}min` : `${h}h`
}

const severityConfig = {
  critical: {
    bg: "bg-[var(--neon-red)]/10",
    border: "border-[var(--neon-red)]/30",
    text: "text-[var(--neon-red)]",
    badge: "bg-[var(--neon-red)]/15 text-[var(--neon-red)] border-[var(--neon-red)]/30",
    dot: "bg-[var(--neon-red)]",
  },
  high: {
    bg: "bg-[var(--neon-orange)]/10",
    border: "border-[var(--neon-orange)]/30",
    text: "text-[var(--neon-orange)]",
    badge: "bg-[var(--neon-orange)]/15 text-[var(--neon-orange)] border-[var(--neon-orange)]/30",
    dot: "bg-[var(--neon-orange)]",
  },
  medium: {
    bg: "bg-[var(--neon-yellow)]/10",
    border: "border-[var(--neon-yellow)]/30",
    text: "text-[var(--neon-yellow)]",
    badge: "bg-[var(--neon-yellow)]/15 text-[var(--neon-yellow)] border-[var(--neon-yellow)]/30",
    dot: "bg-[var(--neon-yellow)]",
  },
  low: {
    bg: "bg-[var(--neon-cyan)]/10",
    border: "border-[var(--neon-cyan)]/30",
    text: "text-[var(--neon-cyan)]",
    badge: "bg-[var(--neon-cyan)]/15 text-[var(--neon-cyan)] border-[var(--neon-cyan)]/30",
    dot: "bg-[var(--neon-cyan)]",
  },
} as const

const statusLabel: Record<string, string> = {
  investigating: "FIRING",
  mitigating: "MITIGATING",
  monitoring: "MONITORING",
}

export default function IncidentsPage() {
  // Full persisted archive (all live incidents), from the store — polled so new
  // incidents appear / resolve without a manual reload.
  const [apiIncidents, setApiIncidents] = useState<ApiIncident[]>([])
  useEffect(() => {
    let cancelled = false
    const load = () =>
      fetch("/api/incidents?range=all", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (!cancelled) setApiIncidents(d?.incidents ?? [])
        })
        .catch(() => {})
    load()
    const interval = setInterval(load, 5000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  // Active = anything not yet resolved. Dedupe by service (earliest canonical).
  const openBySvc = new Map<string, ApiIncident>()
  for (const i of apiIncidents.filter((i) => i.status !== "resolved")) {
    const existing = openBySvc.get(i.service)
    if (!existing || i.startedAt < existing.startedAt) openBySvc.set(i.service, i)
  }
  const activeIncidents = Array.from(openBySvc.values()).sort((a, b) => b.startedAt - a.startedAt)

  // History = resolved incidents, most recently resolved first.
  const historical = apiIncidents
    .filter((i) => i.status === "resolved")
    .sort((a, b) => (b.resolvedAt ?? b.startedAt) - (a.resolvedAt ?? a.startedAt))

  const totalActive = activeIncidents.length
  const totalCritical = activeIncidents.filter((i) => i.severity === "critical").length

  return (
    <main className="max-w-[1600px] mx-auto px-4 lg:px-6 py-6 flex flex-col gap-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link
            href="/overview"
            className="w-8 h-8 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <div>
            <h1 className="text-lg font-mono font-bold text-foreground tracking-wide">
              Active Incidents
            </h1>
            <p className="text-xs text-muted-foreground font-mono">
              {totalActive} active incidents — {totalCritical} critical
            </p>
          </div>
          <span className="w-6 h-6 rounded-full bg-[var(--neon-red)]/15 border border-[var(--neon-red)]/30 text-[var(--neon-red)] text-xs font-bold flex items-center justify-center">
            {totalActive}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 text-xs font-mono bg-secondary/60 px-3 py-1.5 rounded-md border border-border text-muted-foreground">
            <Search className="w-3 h-3" />
            <span>Search incidents…</span>
          </div>
          <button className="flex items-center gap-1.5 text-xs font-mono bg-secondary/60 px-3 py-1.5 rounded-md border border-border text-muted-foreground hover:text-foreground transition-colors">
            <Filter className="w-3 h-3" />
            <span>Filter</span>
          </button>
        </div>
      </div>

      {/* Active incident cards */}
      <div className="flex flex-col gap-3">
        {activeIncidents.length === 0 && (
          <div className="card-glass rounded-lg px-5 py-8 flex items-center justify-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-[var(--neon-green)]" />
            <span className="text-sm font-mono text-[var(--neon-green)]">
              All systems operational — no active incidents
            </span>
          </div>
        )}
        {activeIncidents.map((inc) => {
          const cfg =
            severityConfig[inc.severity as keyof typeof severityConfig] ?? severityConfig.medium
          const affected = inc.affectedUsers ?? 0
          return (
            <Link
              key={inc.id}
              href={`/incidents/${inc.id}`}
              className={`${cfg.bg} ${cfg.border} border rounded-lg px-5 py-4 flex flex-col sm:flex-row sm:items-center gap-3 cursor-pointer hover:opacity-90 transition-all hover:scale-[1.005] group`}
            >
              <div className="flex items-center gap-3 min-w-0 flex-1">
                <div className="relative shrink-0">
                  <AlertTriangle className={`w-5 h-5 ${cfg.text}`} />
                  {inc.severity === "critical" && (
                    <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-[var(--neon-red)] animate-ping" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`text-[10px] font-mono font-bold border px-1.5 py-0.5 rounded ${cfg.badge}`}>
                      {inc.severity.toUpperCase()}
                    </span>
                    <span className="text-[10px] font-mono text-muted-foreground">{inc.id}</span>
                  </div>
                  <p className="text-sm font-medium text-foreground mt-1 truncate group-hover:text-[var(--neon-cyan)] transition-colors">
                    {inc.title}
                  </p>
                  <div className="flex items-center gap-4 mt-1.5">
                    <span className="text-[10px] font-mono text-muted-foreground flex items-center gap-1">
                      <Zap className="w-2.5 h-2.5" /> {inc.service}
                    </span>
                    <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                      <Clock className="w-2.5 h-2.5" /> {agoLabel(inc.startedAt)}
                    </span>
                    {affected > 0 && (
                      <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                        <Users className="w-2.5 h-2.5" />
                        {affected.toLocaleString()} affected
                      </span>
                    )}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-4 shrink-0">
                <div className={`flex items-center gap-1.5 text-[10px] font-mono font-semibold ${cfg.text}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot} animate-pulse`} />
                  {statusLabel[inc.status] ?? inc.status.toUpperCase()}
                </div>
                <ArrowUpRight className="w-4 h-4 text-muted-foreground group-hover:text-[var(--neon-cyan)] transition-colors" />
              </div>
            </Link>
          )
        })}
      </div>

      {/* Historical archive — persisted incidents (survive redeploy / teardown) */}
      <div>
        <h2 className="text-xs font-mono font-semibold text-muted-foreground tracking-widest uppercase mb-3">
          Incident History
          <span className="ml-2 text-muted-foreground/70 normal-case tracking-normal">
            {historical.length} archived
          </span>
        </h2>
        <div className="flex flex-col gap-2">
          {historical.length === 0 && (
            <div className="card-glass rounded-lg px-5 py-6 text-center">
              <span className="text-xs font-mono text-muted-foreground">No archived incidents yet.</span>
            </div>
          )}
          {historical.map((inc) => (
            <Link
              key={inc.id}
              href={`/incidents/${inc.id}`}
              className="card-glass rounded-lg px-5 py-3 flex items-center gap-3 opacity-70 hover:opacity-100 transition-opacity"
            >
              <div className="w-5 h-5 rounded-full bg-[var(--neon-green)]/10 border border-[var(--neon-green)]/30 flex items-center justify-center shrink-0">
                <span className="w-2 h-2 rounded-full bg-[var(--neon-green)]" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-mono text-muted-foreground">{inc.id}</span>
                  <span className="text-[10px] font-mono text-[var(--neon-green)] border border-[var(--neon-green)]/30 bg-[var(--neon-green)]/10 px-1.5 py-0.5 rounded">
                    RESOLVED
                  </span>
                  <span className="text-[10px] font-mono text-muted-foreground flex items-center gap-1">
                    <Zap className="w-2.5 h-2.5" /> {inc.service}
                  </span>
                </div>
                <p className="text-sm text-muted-foreground mt-0.5 truncate">{inc.title}</p>
              </div>
              <div className="text-right shrink-0">
                <p className="text-[10px] font-mono text-muted-foreground">
                  {inc.resolvedAt ? agoLabel(inc.resolvedAt) : agoLabel(inc.startedAt)}
                </p>
                <p className="text-[10px] font-mono text-muted-foreground">
                  Duration: {durationLabel(inc.durationMin)}
                </p>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </main>
  )
}
