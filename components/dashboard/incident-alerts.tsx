"use client"

import { useState, useEffect, type ReactNode } from "react"
import { AlertTriangle, ArrowUpRight, CheckCircle2, Clock, Users, Zap } from "lucide-react"
import Link from "next/link"

// Fades its children in on first mount (used when an incident first appears).
function FadeIn({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setShown(true), 30)
    return () => clearTimeout(t)
  }, [])
  return (
    <div className={`transition-opacity duration-700 ${shown ? "opacity-100" : "opacity-0"}`}>
      {children}
    </div>
  )
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
  resolved: "STABILIZED",
}

function agoLabel(ms: number): string {
  const diff = Date.now() - ms
  const min = Math.round(diff / 60000)
  if (min < 1) return "just now"
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h ago`
  return `${Math.round(hr / 24)}d ago`
}

type RawIncident = {
  id: string
  title: string
  service: string
  severity: string
  status: string
  startedAt: number
  affectedUsers?: number
}

// Overview "Active Incidents" widget — driven entirely by the real incident store
// (/api/incidents). Shows every open (non-resolved) incident; no scripted or
// fabricated incident.
export function IncidentAlerts() {
  const [incidents, setIncidents] = useState<RawIncident[]>([])

  useEffect(() => {
    let cancelled = false
    const load = () =>
      fetch("/api/incidents?range=all", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (cancelled) return
          const open: RawIncident[] = (d?.incidents ?? []).filter(
            (i: RawIncident) => i.status !== "resolved"
          )
          // Dedupe by service — a re-run inject creates another record for the same
          // outage; keep the earliest (canonical) one.
          const bySvc = new Map<string, RawIncident>()
          for (const i of open) {
            const existing = bySvc.get(i.service)
            if (!existing || i.startedAt < existing.startedAt) bySvc.set(i.service, i)
          }
          setIncidents(
            Array.from(bySvc.values()).sort((a, b) => b.startedAt - a.startedAt)
          )
        })
        .catch(() => {})
    load()
    const t = setInterval(load, 5000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [])

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <h2 className="text-xs font-mono font-semibold text-muted-foreground tracking-widest uppercase">
            Active Incidents
          </h2>
          <span className={`w-5 h-5 rounded-full text-[10px] font-bold flex items-center justify-center ${
            incidents.length > 0
              ? "bg-[var(--neon-red)]/15 border border-[var(--neon-red)]/30 text-[var(--neon-red)]"
              : "bg-[var(--neon-green)]/15 border border-[var(--neon-green)]/30 text-[var(--neon-green)]"
          }`}>
            {incidents.length}
          </span>
        </div>
        <Link href="/incidents" className="text-xs text-primary hover:text-[var(--neon-cyan)] transition-colors flex items-center gap-1">
          View all <ArrowUpRight className="w-3 h-3" />
        </Link>
      </div>

      {incidents.length === 0 ? (
        <div className="card-glass rounded-lg px-4 py-6 flex items-center justify-center gap-2 border border-[var(--neon-green)]/20 bg-[var(--neon-green)]/5">
          <CheckCircle2 className="w-4 h-4 text-[var(--neon-green)]" />
          <span className="text-xs font-mono font-semibold text-[var(--neon-green)]">All systems operational</span>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {incidents.map((inc) => {
            const cfg = severityConfig[inc.severity as keyof typeof severityConfig] ?? severityConfig.medium
            const affected = inc.affectedUsers ?? 0
            return (
              <FadeIn key={inc.id}>
                <Link
                  href={`/incidents/${inc.id}`}
                  className={`${cfg.bg} ${cfg.border} border rounded-lg px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-3 cursor-pointer hover:opacity-90 transition-opacity`}
                >
                  {/* Left: severity indicator */}
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <div className="relative shrink-0">
                      <AlertTriangle className={`w-4 h-4 ${cfg.text}`} />
                      {inc.severity === "critical" && (
                        <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-[var(--neon-red)] animate-ping" />
                      )}
                    </div>

                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`text-[10px] font-mono font-bold border px-1.5 py-0.5 rounded ${cfg.badge}`}>
                          {inc.severity.toUpperCase()}
                        </span>
                        <span className="text-[10px] font-mono text-muted-foreground">{inc.id}</span>
                      </div>
                      <p className="text-sm font-medium text-foreground mt-0.5 truncate">{inc.title}</p>
                      <div className="flex items-center gap-3 mt-1">
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

                  {/* Status badge */}
                  <div className="flex items-center gap-2 shrink-0">
                    <div className={`flex items-center gap-1.5 text-[10px] font-mono font-semibold ${cfg.text}`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot} animate-pulse`} />
                      {statusLabel[inc.status] ?? inc.status.toUpperCase()}
                    </div>
                  </div>
                </Link>
              </FadeIn>
            )
          })}
        </div>
      )}
    </section>
  )
}
