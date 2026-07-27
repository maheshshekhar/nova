"use client"

import { useState, useEffect } from "react"
import Link from "next/link"
import { useLiveState } from "@/lib/live-state"
import { defaultLogSource } from "@/lib/logs/log-source"
import { selectIncidentLogs } from "@/lib/log-selection"
import { Brain, ChevronRight, Copy, Loader2, Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"

// Resolve the logs sent to the model: REAL logs from the configured LogSource
// (Loki via the metrics collector), run through smart incident-window selection.
// There is no static fallback — if no live logs are available, analysis simply
// isn't offered.
async function resolveIncidentLogs(): Promise<string[]> {
  try {
    const real = await defaultLogSource.queryLogs({})
    if (real.length) {
      const selected = selectIncidentLogs(real, { budget: 12 })
      if (selected.length) return selected
    }
  } catch {
    // no live logs → empty
  }
  return []
}

export function AiAnalysisPanel() {
  const { phase, aiState: state, analyzeIncident: analyze, currentIncidentId, impactCount } = useLiveState()
  const [copied, setCopied] = useState(false)

  // Active incidents from the real store (config/transaction/etc.), so the AI RCA
  // section still surfaces them on the overview with a link to generate the RCA.
  const [liveIncidents, setLiveIncidents] = useState<
    { id: string; service: string; title: string; severity: string }[]
  >([])
  useEffect(() => {
    let cancelled = false
    const load = () =>
      fetch("/api/incidents?range=all", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (cancelled) return
          type RawIncident = {
            id: string
            service: string
            title: string
            severity: string
            status: string
            startedAt: number
          }
          const raw: RawIncident[] = (d?.incidents ?? []).filter(
            (i: RawIncident) => i.status && i.status !== "resolved" && i.id !== currentIncidentId
          )
          const bySvc = new Map<string, RawIncident>()
          for (const i of raw) {
            const existing = bySvc.get(i.service)
            if (!existing || i.startedAt < existing.startedAt) bySvc.set(i.service, i)
          }
          setLiveIncidents(
            Array.from(bySvc.values())
              .sort((a, b) => a.startedAt - b.startedAt)
              .map((a) => ({ id: a.id, service: a.service, title: a.title, severity: a.severity }))
          )
        })
        .catch(() => {})
    load()
    const t = setInterval(load, 5000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [currentIncidentId])

  // When there is no active cascade in progress, show compact links to any real
  // open incidents (or nothing at all — no scripted/pre-baked analysis).
  if (phase !== "incident") {
    if (liveIncidents.length === 0) return null
    return (
      <section>
        <div className="flex items-center gap-2 mb-3">
          <h2 className="text-xs font-mono font-semibold text-muted-foreground tracking-widest uppercase">
            AI Root Cause Analysis
          </h2>
          <span className="flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded bg-primary/10 border border-primary/20 text-[var(--neon-cyan)]">
            <Sparkles className="w-2.5 h-2.5" /> AI Powered
          </span>
          {liveIncidents.length > 1 && (
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[var(--neon-red)]/10 border border-[var(--neon-red)]/25 text-[var(--neon-red)]">
              {liveIncidents.length} incidents
            </span>
          )}
        </div>
        <div className="flex flex-col gap-2">
          {liveIncidents.map((inc) => (
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

  const isAnalyzing = state.status === "loading" || state.status === "streaming"
  const hasResult = state.status === "streaming" || state.status === "success" || state.status === "error"

  const handleReanalyze = async () => {
    const logs = await resolveIncidentLogs()
    if (logs.length === 0) return
    const affected = impactCount > 0 ? impactCount : null
    const impact =
      affected != null
        ? `Approximately ${affected.toLocaleString()} failed requests observed in the live logs.`
        : `Customer impact is being quantified from the live logs.`
    analyze(
      logs,
      `${currentIncidentId}: active incident. Correlate the attached live logs to identify the root cause. ${impact}`,
      { sinceMs: Date.now() - 30 * 60 * 1000, impact: affected ?? undefined }
    )
  }

  const handleCopy = () => {
    const text = state.status === "success" || state.status === "streaming" ? state.text : ""
    if (!text) return
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

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
          {state.status === "success" && (
            <span className="flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded bg-primary/10 border border-primary/20 text-[var(--neon-cyan)]">
              {state.provider === "openrouter" ? "via OpenRouter" : "via Anthropic"}
            </span>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="text-xs text-muted-foreground hover:text-foreground h-7 px-2.5 gap-1.5"
          onClick={handleReanalyze}
          disabled={isAnalyzing}
        >
          {isAnalyzing ? (
            <><Loader2 className="w-3 h-3 animate-spin" /> Analyzing…</>
          ) : state.status === "idle" ? (
            <><Brain className="w-3 h-3" /> Analyze with AI</>
          ) : (
            <><Brain className="w-3 h-3" /> Re-analyze</>
          )}
        </Button>
      </div>

      {state.status === "error" && (
        <p className="text-[10px] font-mono text-[var(--neon-red)] text-right mb-2">
          Analysis failed: {state.message}
        </p>
      )}

      <div className="card-glass rounded-lg overflow-hidden border border-primary/10">
        <div className="px-4 py-3 border-b border-border/60 flex items-center justify-between bg-primary/5">
          <div className="flex items-center gap-3">
            <div className="relative w-8 h-8 rounded-lg bg-primary/10 border border-primary/25 flex items-center justify-center">
              <Brain className="w-4 h-4 text-[var(--neon-cyan)]" />
              {isAnalyzing && (
                <span className="absolute inset-0 rounded-lg border border-[var(--neon-cyan)] animate-ping opacity-40" />
              )}
            </div>
            <div>
              <p className="text-xs font-mono font-bold text-foreground">
                Incident {currentIncidentId} — {hasResult ? "Root Cause Identified" : "Awaiting Analysis"}
              </p>
              <p className="text-[10px] text-muted-foreground">
                {hasResult
                  ? "Generated from live logs"
                  : "Click Analyze with AI to correlate live logs and identify root cause"}
              </p>
            </div>
          </div>
        </div>

        {state.status === "idle" && (
          <div className="p-6 flex items-center justify-center text-center">
            <p className="text-xs text-muted-foreground max-w-sm">
              Click <span className="text-foreground font-medium">Analyze with AI</span> above to correlate
              the live logs for this incident.
            </p>
          </div>
        )}

        {hasResult && (
          <div className="p-4 flex flex-col gap-4">
            <div>
              <h4 className="text-[10px] font-mono font-semibold text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1.5">
                {state.status === "streaming" && (
                  <span className="w-1.5 h-1.5 rounded-full bg-[var(--neon-cyan)] animate-pulse" />
                )}
                {state.status === "streaming" || state.status === "success" ? "Live Analysis" : "Root Cause"}
              </h4>
              <div className="relative bg-secondary/40 rounded-md p-3 border border-border/60">
                {state.status === "streaming" || state.status === "success" ? (
                  <pre className="font-mono text-xs text-foreground/90 whitespace-pre-wrap leading-relaxed max-h-80 overflow-y-auto">{state.text}</pre>
                ) : (
                  <p className="text-sm text-muted-foreground">Analysis unavailable — retry when live logs are present.</p>
                )}
                <button
                  className="absolute top-2 right-2 p-1 rounded text-muted-foreground hover:text-foreground transition-colors"
                  onClick={handleCopy}
                >
                  <Copy className="w-3 h-3" />
                  {copied && <span className="absolute -top-5 -left-4 text-[9px] text-[var(--neon-green)] font-mono">Copied!</span>}
                </button>
              </div>
              {state.status === "streaming" && (
                <p className="text-[10px] font-mono text-muted-foreground mt-2">
                  Correlating evidence… {state.elapsed}s
                </p>
              )}
            </div>
          </div>
        )}

        {state.status === "loading" && (
          <div className="p-8 flex flex-col items-center justify-center gap-4">
            <div className="relative w-12 h-12">
              <div className="absolute inset-0 rounded-full border-2 border-primary/20 animate-ping" />
              <div className="absolute inset-2 rounded-full border-2 border-primary/40 animate-ping delay-150" />
              <div className="w-12 h-12 rounded-full bg-primary/10 border border-primary/30 flex items-center justify-center">
                <Brain className="w-5 h-5 text-[var(--neon-cyan)]" />
              </div>
            </div>
            <div className="text-center">
              <p className="text-sm font-mono text-foreground">Analyzing live logs…</p>
              <p className="text-[10px] font-mono text-muted-foreground mt-2">{state.elapsed}s</p>
            </div>
          </div>
        )}
      </div>

      {liveIncidents.length > 0 && (
        <div className="mt-3 flex flex-col gap-2">
          {liveIncidents.map((inc) => (
            <Link
              key={inc.id}
              href={`/incidents/${inc.id}`}
              className="card-glass rounded-lg border border-primary/10 px-4 py-3 flex items-center gap-3 hover:border-[var(--neon-cyan)]/40 transition-colors group"
            >
              <div className="w-8 h-8 rounded-lg bg-primary/10 border border-primary/25 flex items-center justify-center shrink-0">
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
      )}
    </section>
  )
}
