"use client"

import { useState, useEffect, type ReactNode } from "react"
import { AlertTriangle, ArrowUpRight, CheckCircle2, Clock, Users, Zap } from "lucide-react"
import { makeActiveIncident } from "@/lib/dashboard-data"
import { useLiveState } from "@/lib/live-state"
import { useIncidentMetrics } from "@/hooks/use-incident-metrics"
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
    glow: "neon-glow-red",
  },
  high: {
    bg: "bg-[var(--neon-orange)]/10",
    border: "border-[var(--neon-orange)]/30",
    text: "text-[var(--neon-orange)]",
    badge: "bg-[var(--neon-orange)]/15 text-[var(--neon-orange)] border-[var(--neon-orange)]/30",
    dot: "bg-[var(--neon-orange)]",
    glow: "neon-glow-orange",
  },
  medium: {
    bg: "bg-[var(--neon-yellow)]/10",
    border: "border-[var(--neon-yellow)]/30",
    text: "text-[var(--neon-yellow)]",
    badge: "bg-[var(--neon-yellow)]/15 text-[var(--neon-yellow)] border-[var(--neon-yellow)]/30",
    dot: "bg-[var(--neon-yellow)]",
    glow: "",
  },
  resolved: {
    bg: "bg-[var(--neon-green)]/10",
    border: "border-[var(--neon-green)]/30",
    text: "text-[var(--neon-green)]",
    badge: "bg-[var(--neon-green)]/15 text-[var(--neon-green)] border-[var(--neon-green)]/30",
    dot: "bg-[var(--neon-green)]",
    glow: "",
  },
} as const

const statusLabel: Record<string, string> = {
  investigating: "FIRING",
  mitigating: "MITIGATING",
  monitoring: "MONITORING",
  resolved: "STABILIZED",
  detecting: "DETECTING",
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

type AlertRow = {
  id: string
  title: string
  service: string
  severity: string
  status: string
  started: string
  affectedUsers: number
  impactLabel?: string
  detecting: boolean
}

export function IncidentAlerts() {
  const { phase, secondsElapsed, resolvedIncidents: resolvedIds, currentIncidentId } = useLiveState()

  // The payment-service cascade (scripted via live-state phase).
  const detecting = phase === "degrading" && secondsElapsed >= 45
  const active = makeActiveIncident(currentIncidentId)
  const paymentVisible = phase === "incident" || detecting

  // Canonical per-incident figures via the shared hook (single source of truth) so
  // the overview matches the incident page, AI analysis and RCA exactly.
  const activeMetrics = useIncidentMetrics({ record: null, isActive: true, resolved: false })
  const activeStarted = activeMetrics.startedAtMs != null ? agoLabel(activeMetrics.startedAtMs) : active.started
  // Use the LIVE checkout-503 count (ramps up from 0 and freezes at resolve). Do
  // NOT fall back to the static PRIMARY_INCIDENT figure — that made a freshly
  // detected incident briefly flash 1,842 before the real count accrued.
  const activeAffected = activeMetrics.impactCount
  const activeImpactLabel = activeMetrics.impactCount > 0 ? "impacted checkouts (503)" : "users affected"

  // Live incidents (e.g. config-service / transaction-service from
  // inject-config-failure) — polled so they appear and clear automatically.
  const [liveIncidents, setLiveIncidents] = useState<AlertRow[]>([])
  useEffect(() => {
    let cancelled = false
    const load = () =>
      fetch("/api/incidents?range=all")
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (cancelled) return
          type RawIncident = {
            id: string
            title: string
            service: string
            severity: string
            status: string
            startedAt: number
            affectedUsers?: number
            origin?: string
          }
          const raw: RawIncident[] = (d?.incidents ?? []).filter(
            (i: RawIncident) =>
              i.origin === "live" && i.status !== "resolved" && i.id !== currentIncidentId
          )
          // Dedupe by service — re-running an inject script creates another record
          // for the same outage; only the earliest (canonical) one is shown.
          const bySvc = new Map<string, RawIncident>()
          for (const i of raw) {
            const existing = bySvc.get(i.service)
            if (!existing || i.startedAt < existing.startedAt) bySvc.set(i.service, i)
          }
          const rows: AlertRow[] = Array.from(bySvc.values())
            .sort((a, b) => a.startedAt - b.startedAt)
            .map((i) => ({
              id: i.id,
              title: i.title,
              service: i.service,
              severity: i.severity,
              status: i.status,
              started: agoLabel(i.startedAt),
              affectedUsers: i.affectedUsers ?? 0,
              detecting: false,
            }))
          setLiveIncidents(rows)
        })
        .catch(() => {})
    load()
    const t = setInterval(load, 5000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [currentIncidentId])

  const visibleIncidents: AlertRow[] = [
    ...(paymentVisible
      ? [
          {
            id: active.id,
            title: active.title,
            service: active.service,
            severity: active.severity,
            status: active.status,
            started: activeStarted,
            affectedUsers: activeAffected,
            impactLabel: activeImpactLabel,
            detecting,
          },
        ]
      : []),
    // The active payment cascade above already represents the payment-service
    // outage — drop any live payment-service record so the same incident never
    // appears twice.
    ...liveIncidents.filter((row) => !(paymentVisible && row.service === active.service)),
  ]

  const activeCount = visibleIncidents.filter((inc) => !resolvedIds.includes(inc.id)).length

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <h2 className="text-xs font-mono font-semibold text-muted-foreground tracking-widest uppercase">
            Active Incidents
          </h2>
          <span className={`w-5 h-5 rounded-full text-[10px] font-bold flex items-center justify-center ${
            activeCount > 0
              ? "bg-[var(--neon-red)]/15 border border-[var(--neon-red)]/30 text-[var(--neon-red)]"
              : "bg-[var(--neon-green)]/15 border border-[var(--neon-green)]/30 text-[var(--neon-green)]"
          }`}>
            {activeCount}
          </span>
        </div>
        <Link href="/incidents" className="text-xs text-primary hover:text-[var(--neon-cyan)] transition-colors flex items-center gap-1">
          View all <ArrowUpRight className="w-3 h-3" />
        </Link>
      </div>

      {visibleIncidents.length === 0 ? (
        <div className="card-glass rounded-lg px-4 py-6 flex items-center justify-center gap-2 border border-[var(--neon-green)]/20 bg-[var(--neon-green)]/5">
          <CheckCircle2 className="w-4 h-4 text-[var(--neon-green)]" />
          <span className="text-xs font-mono font-semibold text-[var(--neon-green)]">All systems operational</span>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {visibleIncidents.map((inc) => {
            const incidentResolved = resolvedIds.includes(inc.id)
            const isDetecting = inc.detecting
            const effectiveSeverity = incidentResolved ? "resolved" : inc.severity
            const effectiveStatus = incidentResolved ? "resolved" : isDetecting ? "detecting" : inc.status
            const cfg = severityConfig[effectiveSeverity as keyof typeof severityConfig] ?? severityConfig.medium
            return (
              <FadeIn key={inc.id}>
                <Link
                  href={`/incidents/${inc.id}`}
                  className={`${cfg.bg} ${cfg.border} border rounded-lg px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-3 cursor-pointer hover:opacity-90 transition-opacity`}
                >
                  {/* Left: severity indicator */}
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <div className="relative shrink-0">
                      {incidentResolved ? (
                        <CheckCircle2 className={`w-4 h-4 ${cfg.text}`} />
                      ) : (
                        <>
                          <AlertTriangle className={`w-4 h-4 ${cfg.text}`} />
                          {inc.severity === "critical" && !isDetecting && (
                            <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-[var(--neon-red)] animate-ping" />
                          )}
                        </>
                      )}
                    </div>

                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`text-[10px] font-mono font-bold border px-1.5 py-0.5 rounded ${cfg.badge}`}>
                          {incidentResolved ? "RESOLVED" : inc.severity.toUpperCase()}
                        </span>
                        <span className="text-[10px] font-mono text-muted-foreground">{inc.id}</span>
                      </div>
                      <p className="text-sm font-medium text-foreground mt-0.5 truncate">{inc.title}</p>
                      <div className="flex items-center gap-3 mt-1">
                        <span className="text-[10px] font-mono text-muted-foreground flex items-center gap-1">
                          <Zap className="w-2.5 h-2.5" /> {inc.service}
                        </span>
                        <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                          <Clock className="w-2.5 h-2.5" /> {inc.started}
                        </span>
                        {inc.affectedUsers > 0 && (
                          <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                            <Users className="w-2.5 h-2.5" />
                            {inc.affectedUsers.toLocaleString()} {inc.impactLabel ?? "users affected"}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Status badge */}
                  <div className="flex items-center gap-2 shrink-0">
                    <div className={`flex items-center gap-1.5 text-[10px] font-mono font-semibold ${cfg.text}`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot} ${incidentResolved ? "" : "animate-pulse"}`} />
                      {statusLabel[effectiveStatus]}
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
