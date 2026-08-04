"use client"

import { useState, useEffect } from "react"
import Link from "next/link"
import { Brain, ChevronRight, Sparkles, Loader2 } from "lucide-react"
import { useRealLogs } from "@/hooks/use-real-metrics"
import { useAiAnalysis } from "@/hooks/use-ai-analysis"
import type { IncidentRecord } from "@/lib/incident-types"

type RawIncident = {
  id: string
  service: string
  title: string
  severity: string
  status: string
  startedAt: number
}

// Overview "AI Root Cause Analysis" — appears ONLY when there is an OPEN incident
// (nothing when all systems are operational). The most recent open incident gets
// an inline "Analyze with AI" panel that streams a grounded RCA from the service's
// real logs; the rest are compact links. The full Recovery Plan lives on the
// incident page (open the incident to run it).
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

  const top = incidents[0] ?? null
  const rest = incidents.slice(1)

  // Full record for the top incident (failure type / description / impact) so the
  // analysis is grounded in real data.
  const [topRecord, setTopRecord] = useState<IncidentRecord | null>(null)
  useEffect(() => {
    if (!top) {
      setTopRecord(null)
      return
    }
    let cancelled = false
    fetch(`/api/incidents/${top.id}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled) setTopRecord(d?.incident ?? null)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [top?.id])

  const { logs: topLogs } = useRealLogs(top?.service)
  const { state: aiState, analyze, reset } = useAiAnalysis()

  // Reset the analysis when the active incident changes (no stale text).
  useEffect(() => {
    reset()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [top?.id])

  const handleAnalyze = () => {
    if (!top) return
    const logs = topLogs
      .slice(-24)
      .map((l) => `${l.timestamp} ${l.level} ${l.pod ? `[${l.pod}] ` : ""}${l.message}`.trim())
    const impact = topRecord?.affectedUsers ?? 0
    const impactLine = impact > 0 ? ` Approximately ${impact.toLocaleString()} users/requests impacted.` : ""
    const context = `${top.id}: ${top.service} — ${topRecord?.failureType ?? "incident"}. ${topRecord?.description || top.title}.${impactLine}`
    analyze(logs, context, {
      service: top.service,
      sinceMs: topRecord?.startedAt ?? Date.now() - 30 * 60 * 1000,
      impact: impact > 0 ? impact : undefined,
    })
  }

  if (incidents.length === 0) return null

  const analyzing = aiState.status === "loading" || aiState.status === "streaming"
  const hasResult = aiState.status === "streaming" || aiState.status === "success"
  const logsAvailable = topLogs.length > 0

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <h2 className="text-xs font-mono font-semibold text-muted-foreground tracking-widest uppercase">
            AI Root Cause Analysis
          </h2>
          <span className="flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded bg-primary/10 border border-primary/20 text-[var(--neon-cyan)]">
            <Sparkles className="w-2.5 h-2.5" /> AI Powered
          </span>
          {aiState.status === "success" && (
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-primary/10 border border-primary/20 text-[var(--neon-cyan)]">
              {aiState.provider === "openrouter" ? "via OpenRouter" : "via Anthropic"}
            </span>
          )}
          {incidents.length > 1 && (
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[var(--neon-red)]/10 border border-[var(--neon-red)]/25 text-[var(--neon-red)]">
              {incidents.length} incidents
            </span>
          )}
        </div>
        {top && (
          <button
            onClick={handleAnalyze}
            disabled={analyzing}
            className="flex items-center gap-1.5 text-xs font-mono font-semibold text-[var(--neon-cyan)] hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {analyzing ? (
              <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Analyzing…</>
            ) : aiState.status === "idle" ? (
              <><Brain className="w-3.5 h-3.5" /> Analyze with AI →</>
            ) : (
              <><Brain className="w-3.5 h-3.5" /> Re-analyze</>
            )}
          </button>
        )}
      </div>

      <div className="flex flex-col gap-2">
        {/* Top open incident — inline analyze card (streamed). The Recovery Plan
            lives on the incident page. */}
        {top && (
          <div className="card-glass rounded-lg overflow-hidden border border-primary/10">
            <div className="px-4 py-3 border-b border-border/60 flex items-center justify-between gap-3 bg-primary/5">
              <div className="flex items-center gap-3 min-w-0">
                <div className="relative w-8 h-8 rounded-lg bg-primary/10 border border-primary/25 flex items-center justify-center shrink-0">
                  <Brain className="w-4 h-4 text-[var(--neon-cyan)]" />
                  {analyzing && (
                    <span className="absolute inset-0 rounded-lg border border-[var(--neon-cyan)] animate-ping opacity-40" />
                  )}
                </div>
                <div className="min-w-0">
                  <Link
                    href={`/incidents/${top.id}`}
                    className="text-xs font-mono font-bold text-foreground hover:text-[var(--neon-cyan)] transition-colors"
                  >
                    Incident {top.id} — {hasResult ? "Root Cause Identified" : "Awaiting Analysis"}
                  </Link>
                  <p className="text-[10px] text-muted-foreground truncate">
                    {hasResult
                      ? `${top.service} · ${top.title}`
                      : "Click Analyze with AI to correlate signals and identify root cause"}
                  </p>
                </div>
              </div>
              <span
                className={`shrink-0 flex items-center gap-1.5 text-[10px] font-mono font-semibold px-2 py-1 rounded border ${
                  analyzing
                    ? "bg-primary/10 border-primary/20 text-[var(--neon-cyan)]"
                    : hasResult
                    ? "bg-[var(--neon-green)]/10 border-[var(--neon-green)]/25 text-[var(--neon-green)]"
                    : "bg-secondary/60 border-border text-muted-foreground"
                }`}
              >
                {analyzing ? (
                  <><Loader2 className="w-2.5 h-2.5 animate-spin" /> Correlating signals…</>
                ) : hasResult ? (
                  <><span className="w-1.5 h-1.5 rounded-full bg-[var(--neon-green)]" /> Analyzed</>
                ) : logsAvailable ? (
                  "Not yet analyzed"
                ) : (
                  "No live logs"
                )}
              </span>
            </div>

            <div className="p-4">
              {aiState.status === "idle" && (
                <p className="text-xs text-muted-foreground text-center py-2">
                  Click <span className="text-foreground font-medium">Analyze with AI</span> above to correlate
                  telemetry, logs, and traces for this incident.
                </p>
              )}
              {aiState.status === "loading" && (
                <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground py-4">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" /> Correlating traces, logs, and metrics… {aiState.elapsed}s
                </div>
              )}
              {aiState.status === "error" && (
                <p className="text-[10px] font-mono text-[var(--neon-red)]">Analysis failed: {aiState.message}</p>
              )}
              {hasResult && (
                <div>
                  <span className="inline-flex items-center gap-1.5 text-[10px] font-mono font-semibold text-muted-foreground tracking-widest uppercase">
                    {aiState.status === "streaming" && (
                      <span className="w-1.5 h-1.5 rounded-full bg-[var(--neon-cyan)] animate-pulse" />
                    )}
                    Live Analysis
                  </span>
                  <pre className="font-mono text-xs text-foreground/90 whitespace-pre-wrap leading-relaxed mt-2 bg-background/50 rounded-md p-3 border border-border/50 max-h-72 overflow-y-auto">{aiState.text}</pre>
                  <Link
                    href={`/incidents/${top.id}`}
                    className="inline-flex items-center gap-1 mt-3 text-xs font-mono text-[var(--neon-cyan)] hover:underline"
                  >
                    Open incident to generate a Recovery Plan <ChevronRight className="w-3 h-3" />
                  </Link>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Compact cards for the remaining open incidents. */}
        {rest.map((inc) => (
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
