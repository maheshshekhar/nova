"use client"

import { useEffect, useState } from "react"
import { Sparkles } from "lucide-react"

type StatusView = {
  dryRun: boolean
  scope: string
  logs: boolean
  ageSec: number
  stale: boolean
  active: boolean
} | null

// Compact Nova Sentinel liveness indicator for the topbar. Polls the heartbeat
// endpoint the companion posts to. Hidden entirely when Sentinel has never
// checked in (so clusters not running it see no clutter).
export function SentinelStatus() {
  const [status, setStatus] = useState<StatusView>(null)
  const [everSeen, setEverSeen] = useState(false)

  useEffect(() => {
    let cancelled = false
    const load = () =>
      fetch("/api/sentinel/status", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (cancelled) return
          const s: StatusView = d?.status ?? null
          setStatus(s)
          if (s) setEverSeen(true)
        })
        .catch(() => {})
    load()
    const id = setInterval(load, 15000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])

  if (!everSeen || !status) return null

  const { dot, label, color } = status.stale
    ? { dot: "bg-muted-foreground", label: "OFFLINE", color: "text-muted-foreground" }
    : status.dryRun
      ? { dot: "bg-[var(--neon-yellow)]", label: "DRY-RUN", color: "text-[var(--neon-yellow)]" }
      : { dot: "bg-[var(--neon-blue)]", label: "ACTIVE", color: "text-[var(--neon-blue)]" }

  const title = status.stale
    ? "Nova Sentinel: no heartbeat — companion appears to be down"
    : `Nova Sentinel ${status.dryRun ? "dry-run (not opening incidents)" : "live"} — scope ${status.scope}, logs ${status.logs ? "on" : "off"}`

  return (
    <div
      title={title}
      className="hidden sm:flex items-center gap-1.5 text-xs font-mono bg-secondary/60 px-2.5 py-1 rounded-md border border-border"
    >
      <Sparkles className="w-3 h-3 text-[var(--neon-blue)]" />
      <span className="text-muted-foreground">SENTINEL</span>
      <span className={`w-1.5 h-1.5 rounded-full ${dot} ${status.stale ? "" : "animate-pulse"}`} />
      <span className={color}>{label}</span>
    </div>
  )
}
