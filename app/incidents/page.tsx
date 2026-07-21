"use client"

import { AlertTriangle, ArrowLeft, ArrowUpRight, CheckCircle2, Clock, Filter, Search, Users, Zap } from "lucide-react"
import { makeActiveIncident } from "@/lib/dashboard-data"
import { useLiveState } from "@/lib/live-state"
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
  origin?: string
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
} as const

const statusLabel: Record<string, string> = {
  investigating: "FIRING",
  mitigating: "MITIGATING",
  monitoring: "MONITORING",
}

const resolvedConfig = {
  bg: "bg-[var(--neon-green)]/5",
  border: "border-[var(--neon-green)]/20",
  text: "text-[var(--neon-green)]",
  badge: "bg-[var(--neon-green)]/15 text-[var(--neon-green)] border-[var(--neon-green)]/30",
  dot: "bg-[var(--neon-green)]",
}

export default function IncidentsPage() {
  // Resolved state is in-memory live-state context (resets on full page load).
  const { phase, resolvedIncidents: resolvedIds, currentIncidentId, pastIncidents, impactCount } = useLiveState()

  // Full persisted archive (seeded history + any live incidents), from the store.
  const [apiIncidents, setApiIncidents] = useState<ApiIncident[]>([])
  useEffect(() => {
    let cancelled = false
    const load = () =>
      fetch("/api/incidents?range=all")
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (!cancelled) setApiIncidents(d?.incidents ?? [])
        })
        .catch(() => {})
    load()
    // Poll so live-injected incidents (config/transaction) appear/clear without a
    // manual reload — the payment `phase` doesn't change for those.
    const interval = setInterval(load, 5000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  // A single active incident per run (the payment-service cascade) with the
  // current incrementing id — shown while the system is degraded and unresolved.
  // Impact uses the LIVE checkout-503 count (ramps from 0), never the static
  // PRIMARY_INCIDENT 1,842 seed.
  const active = { ...makeActiveIncident(currentIncidentId), affectedUsers: impactCount }
  const showActive =
    (phase === "incident" || phase === "degrading") && !resolvedIds.includes(currentIncidentId)
  const activeIncidents = showActive ? [active] : []

  // Recently resolved this session (green "Just now"): the current incident once
  // resolved, plus archived past runs from Nova.
  const sessionResolved = [
    ...(resolvedIds.includes(currentIncidentId)
      ? [{ id: currentIncidentId, title: active.title, service: active.service }]
      : []),
    ...pastIncidents.map((p) => ({ id: p.id, title: p.title, service: p.service })),
  ]
  const sessionIds = new Set(sessionResolved.map((r) => r.id))

  // The persisted historical archive — everything resolved that isn't the live
  // active incident or already shown as a session-resolved card above.
  const historical = apiIncidents.filter(
    (i) =>
      i.status === "resolved" &&
      !sessionIds.has(i.id) &&
      !(showActive && i.id === currentIncidentId)
  )

  // Live incidents injected outside the payment cascade (e.g. a config-service
  // outage from inject-config-failure) — shown as active so the operator can
  // open them and approve the matched runbook.
  const liveActive = apiIncidents.filter(
    (i) => i.origin === "live" && i.status !== "resolved" && i.id !== currentIncidentId
  )

  // Header counts cover both the payment cascade and any live-injected incidents.
  const totalActive = activeIncidents.length + liveActive.length
  const totalCritical =
    activeIncidents.filter((i) => i.severity === "critical").length +
    liveActive.filter((i) => i.severity === "critical").length

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
              {totalActive} active incidents —{" "}
              {totalCritical} critical
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
        {activeIncidents.length === 0 && liveActive.length === 0 && (
          <div className="card-glass rounded-lg px-5 py-8 flex items-center justify-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-[var(--neon-green)]" />
            <span className="text-sm font-mono text-[var(--neon-green)]">
              All systems operational — no active incidents
            </span>
          </div>
        )}
        {liveActive.map((inc) => {
          const cfg =
            severityConfig[inc.severity as keyof typeof severityConfig] ?? severityConfig.high
          return (
            <Link
              key={inc.id}
              href={`/incidents/${inc.id}`}
              className={`${cfg.bg} ${cfg.border} border rounded-lg px-5 py-4 flex items-center gap-3 cursor-pointer hover:opacity-90 transition-all hover:scale-[1.005] group`}
            >
              <AlertTriangle className={`w-5 h-5 ${cfg.text} shrink-0`} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`text-[10px] font-mono font-bold border px-1.5 py-0.5 rounded ${cfg.badge}`}>
                    {inc.severity.toUpperCase()}
                  </span>
                  <span className="text-[10px] font-mono text-muted-foreground">{inc.id}</span>
                  <span className="text-[10px] font-mono text-muted-foreground flex items-center gap-1">
                    <Zap className="w-2.5 h-2.5" /> {inc.service}
                  </span>
                </div>
                <p className="text-sm font-medium text-foreground mt-1 truncate group-hover:text-[var(--neon-cyan)] transition-colors">
                  {inc.title}
                </p>
              </div>
              <div className="flex items-center gap-1.5 text-[10px] font-mono font-semibold text-[var(--neon-orange)] shrink-0">
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--neon-orange)] animate-pulse" />
                RUNBOOK READY
              </div>
              <ArrowUpRight className="w-4 h-4 text-muted-foreground group-hover:text-[var(--neon-cyan)] transition-colors shrink-0" />
            </Link>
          )
        })}
        {activeIncidents.map((inc) => {
          const cfg = severityConfig[inc.severity as keyof typeof severityConfig]
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
                      <Clock className="w-2.5 h-2.5" /> {inc.started}
                    </span>
                    {inc.affectedUsers > 0 && (
                      <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                        <Users className="w-2.5 h-2.5" />
                        {inc.affectedUsers.toLocaleString()} users affected
                      </span>
                    )}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-4 shrink-0">
                <div className={`flex items-center gap-1.5 text-[10px] font-mono font-semibold ${cfg.text}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot} animate-pulse`} />
                  {statusLabel[inc.status]}
                </div>
                <ArrowUpRight className="w-4 h-4 text-muted-foreground group-hover:text-[var(--neon-cyan)] transition-colors" />
              </div>
            </Link>
          )
        })}
      </div>

      {/* Recently resolved */}
      <div>
        <h2 className="text-xs font-mono font-semibold text-muted-foreground tracking-widest uppercase mb-3">
          Recently Resolved
        </h2>
        <div className="flex flex-col gap-2">
          {/* Dynamic — incidents resolved during this session */}
          {sessionResolved.map((inc) => (
            <Link
              key={inc.id}
              href={`/incidents/${inc.id}`}
              className={`${resolvedConfig.bg} ${resolvedConfig.border} border rounded-lg px-5 py-3 flex items-center gap-3 opacity-80 hover:opacity-100 transition-opacity`}
            >
              <div className="w-5 h-5 rounded-full bg-[var(--neon-green)]/10 border border-[var(--neon-green)]/30 flex items-center justify-center shrink-0">
                <CheckCircle2 className="w-3 h-3 text-[var(--neon-green)]" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-mono text-muted-foreground">{inc.id}</span>
                  <span className="text-[10px] font-mono text-[var(--neon-green)] border border-[var(--neon-green)]/30 bg-[var(--neon-green)]/10 px-1.5 py-0.5 rounded">
                    RESOLVED
                  </span>
                </div>
                <p className="text-sm text-muted-foreground mt-0.5 truncate">{inc.title}</p>
              </div>
              <div className="text-right shrink-0">
                <p className="text-[10px] font-mono text-[var(--neon-green)]">Just now</p>
                <p className="text-[10px] font-mono text-muted-foreground">Stabilized</p>
              </div>
            </Link>
          ))}
        </div>
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