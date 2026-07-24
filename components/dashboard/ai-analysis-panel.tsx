"use client"

import { useState, useEffect } from "react"
import Link from "next/link"
import { Brain, ChevronRight, Sparkles } from "lucide-react"

type RawIncident = {
  id: string
  service: string
  title: string
  severity: string
  status: string
  startedAt: number
}

// Overview "AI Root Cause Analysis" entry point — driven entirely by the real
// incident store. For each OPEN incident it shows a compact card linking to the
// incident page, where the AI RCA is generated on demand from the service's real
// pod logs (streamed by the configured LLM). No fabricated analysis; when the AI
// provider isn't configured the incident page surfaces that.
export function AiAnalysisPanel() {
  const [incidents, setIncidents] = useState<RawIncident[]>([])

  useEffect(() => {
    let cancelled = false
    const load = () =>
      fetch("/api/incidents?range=all", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (cancelled) return
          const raw: RawIncident[] = (d?.incidents ?? []).filter(
            (i: RawIncident) => i.status !== "resolved"
          )
          // Dedupe by service — a re-run inject records the same outage twice.
          const bySvc = new Map<string, RawIncident>()
          for (const i of raw) {
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

  if (incidents.length === 0) return null

  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <h2 className="text-xs font-mono font-semibold text-muted-foreground tracking-widest uppercase">
          AI Root Cause Analysis
        </h2>
        <span className="flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded bg-primary/10 border border-primary/20 text-[var(--neon-cyan)]">
          <Sparkles className="w-2.5 h-2.5" /> AI Powered
        </span>
        {incidents.length > 1 && (
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[var(--neon-red)]/10 border border-[var(--neon-red)]/25 text-[var(--neon-red)]">
            {incidents.length} incidents
          </span>
        )}
      </div>
      <div className="flex flex-col gap-2">
        {incidents.map((inc) => (
          <Link
            key={inc.id}
            href={`/incidents/${inc.id}`}
            className="card-glass rounded-lg border border-primary/10 px-4 py-4 flex items-center gap-3 hover:border-[var(--neon-cyan)]/40 transition-colors group"
          >
            <div className="w-9 h-9 rounded-lg bg-primary/10 border border-primary/25 flex items-center justify-center shrink-0">
              <Brain className="w-4 h-4 text-[var(--neon-cyan)]" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-mono font-bold text-foreground">
                Incident {inc.id} — {inc.service}
              </p>
              <p className="text-[11px] text-muted-foreground truncate">
                {inc.title} · open the incident to generate the AI RCA from live logs
              </p>
            </div>
            <ChevronRight className="w-4 h-4 text-muted-foreground group-hover:text-[var(--neon-cyan)] transition-colors shrink-0" />
          </Link>
        ))}
      </div>
    </section>
  )
}
