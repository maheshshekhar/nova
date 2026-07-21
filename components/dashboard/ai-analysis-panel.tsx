"use client"

import { useState, useEffect } from "react"
import Link from "next/link"
import { aiAnalysis, incidentDetails, mockLogs } from "@/lib/dashboard-data"
import { useLiveState } from "@/lib/live-state"
import { defaultLogSource } from "@/lib/logs/log-source"
import { selectIncidentLogs } from "@/lib/log-selection"
import { Brain, ChevronRight, Copy, GitPullRequest, Lightbulb, Loader2, Search, ShieldAlert, Sparkles, Terminal } from "lucide-react"
import { Button } from "@/components/ui/button"

const evidenceIcons: Record<string, React.ElementType> = {
  metric: Search,
  log: Terminal,
  trace: GitPullRequest,
  deploy: ShieldAlert,
}

const severityColors: Record<string, string> = {
  critical: "text-[var(--neon-red)] bg-[var(--neon-red)]/10 border-[var(--neon-red)]/25",
  high: "text-[var(--neon-orange)] bg-[var(--neon-orange)]/10 border-[var(--neon-orange)]/25",
  info: "text-[var(--neon-cyan)] bg-[var(--neon-cyan)]/10 border-[var(--neon-cyan)]/25",
}

// Fallback logs (used only when the metrics-collector has no real logs, e.g. no
// cluster connected): the incident's related logs plus payment-service ERROR lines.
function buildStaticIncidentLogs(): string[] {
  const related = incidentDetails["INC-2847"].relatedLogs.map(
    (l) => `${l.timestamp} ${l.level} ${l.message}`
  )
  const paymentErrors = mockLogs
    .filter((l) => l.service === "payment-service" && l.level === "ERROR")
    .map((l) => `${l.timestamp} ${l.level} ${l.message}`)
  return [...related, ...paymentErrors]
}

// Resolve the logs sent to Claude: prefer REAL payment-service logs from the
// metrics-collector (via the LogSource adapter), run them through smart
// incident-window selection, and fall back to static logs when none are live.
async function resolveIncidentLogs(): Promise<string[]> {
  try {
    const real = await defaultLogSource.queryLogs({ service: "payment-service" })
    if (real.length) {
      const selected = selectIncidentLogs(real, { budget: 12 })
      if (selected.length) return selected
    }
  } catch {
    // fall through to static
  }
  return buildStaticIncidentLogs()
}

export function AiAnalysisPanel() {
  const { phase, aiState: state, analyzeIncident: analyze, currentIncidentId, impactCount } = useLiveState()
  const [copied, setCopied] = useState(false)

  // Live config/transaction incidents (outside the payment cascade), so the AI
  // Root Cause Analysis section still appears for those on the overview.
  const [liveIncidents, setLiveIncidents] = useState<
    { id: string; service: string; title: string; severity: string }[]
  >([])
  useEffect(() => {
    let cancelled = false
    const load = () =>
      fetch("/api/incidents?range=all")
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
            origin?: string
          }
          const raw: RawIncident[] = (d?.incidents ?? []).filter(
            (i: RawIncident) =>
              i.origin === "live" && i.status !== "resolved" && i.id !== currentIncidentId
          )
          // Dedupe by service — a re-run inject script records the same outage twice.
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

  if (phase !== "incident") {
    if (liveIncidents.length === 0) return null
    // Compact AI RCA entry per live config/transaction incident — each links to
    // the incident page where the full analysis is generated from live logs.
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
  // Supporting evidence / recommendations / similar incidents are reference
  // content — only reveal them once the live analysis has fully streamed, so the
  // panel doesn't look pre-baked while Claude is still writing.
  const showDetails = state.status === "success"

  const handleReanalyze = async () => {
    const logs = await resolveIncidentLogs()
    // Use the canonical impact count from live-state (single source of truth) so
    // the blast-radius figure matches the overview and RCA exactly.
    const affected = impactCount > 0 ? impactCount : null
    const impact =
      affected != null
        ? `Approximately ${affected.toLocaleString()} failed checkout requests (HTTP 503) observed in the live logs.`
        : `Customer impact is being quantified from the live checkout 503 count.`
    analyze(
      logs,
      `${currentIncidentId}: payment-service cascading failure. Checkout endpoint returning 503 errors. ${impact}`,
      { service: "payment-service", sinceMs: Date.now() - 30 * 60 * 1000, impact: affected ?? undefined }
    )
  }

  const handleCopy = () => {
    const text =
      state.status === "success" || state.status === "streaming" ? state.text : aiAnalysis.rootCause
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
        {/* Header bar */}
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
                {hasResult ? aiAnalysis.summary : "Click Analyze with AI to correlate signals and identify root cause"}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {showDetails ? (
              <span className="flex items-center gap-1.5 text-[10px] font-mono font-semibold px-2 py-1 rounded bg-[var(--neon-green)]/10 border border-[var(--neon-green)]/25 text-[var(--neon-green)]">
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--neon-green)]" />
                {aiAnalysis.signalLabel}
              </span>
            ) : isAnalyzing ? (
              <span className="flex items-center gap-1.5 text-[10px] font-mono font-semibold px-2 py-1 rounded bg-primary/10 border border-primary/20 text-[var(--neon-cyan)]">
                <Loader2 className="w-2.5 h-2.5 animate-spin" />
                Correlating signals…
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-[10px] font-mono font-semibold px-2 py-1 rounded bg-secondary/60 border border-border text-muted-foreground">
                Not yet analyzed
              </span>
            )}
          </div>
        </div>

        {state.status === "idle" && (
          <div className="p-6 flex items-center justify-center text-center">
            <p className="text-xs text-muted-foreground max-w-sm">
              Click <span className="text-foreground font-medium">Analyze with AI</span> above to correlate
              telemetry, logs, and traces for this incident.
            </p>
          </div>
        )}

        {hasResult && (
          <div className="p-4 flex flex-col gap-4">
            {/* Root cause / live analysis — shown as soon as streaming starts */}
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
                  <p className="text-sm text-foreground/90 leading-relaxed">{aiAnalysis.rootCause}</p>
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
                  Correlating evidence and recommendations… {state.elapsed}s
                </p>
              )}
            </div>

            {/* Evidence / recommendations / similar incidents — only once the live
                analysis has fully streamed, so they don't look pre-baked. */}
            {showDetails && (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {/* Evidence */}
                <div>
                  <h4 className="text-[10px] font-mono font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                    Supporting Evidence
                  </h4>
                  <div className="flex flex-col gap-1.5">
                    {aiAnalysis.evidence.map((ev, i) => {
                      const Icon = evidenceIcons[ev.type] ?? Search
                      return (
                        <div
                          key={i}
                          className={`flex items-start gap-2.5 p-2 rounded-md border text-xs ${severityColors[ev.severity] ?? severityColors.info}`}
                        >
                          <Icon className="w-3 h-3 mt-0.5 shrink-0" />
                          <div className="min-w-0">
                            <span className="font-mono font-semibold">{ev.label}: </span>
                            <span className="font-mono opacity-80">{ev.value}</span>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>

                {/* Recommendations + similar */}
                <div className="flex flex-col gap-3">
                  <div>
                    <h4 className="text-[10px] font-mono font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                      AI Recommendations
                    </h4>
                    <div className="flex flex-col gap-2">
                      {aiAnalysis.recommendations.map((rec, i) => (
                        <div
                          key={i}
                          className="flex items-start gap-2.5 p-2.5 rounded-md bg-secondary/40 border border-border/60 group hover:border-primary/25 transition-colors cursor-pointer"
                        >
                          <div className="w-5 h-5 rounded bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0 mt-0.5">
                            <Lightbulb className="w-2.5 h-2.5 text-[var(--neon-cyan)]" />
                          </div>
                          <p className="text-xs text-foreground/80 leading-relaxed group-hover:text-foreground transition-colors">
                            {rec}
                          </p>
                          <ChevronRight className="w-3 h-3 text-muted-foreground shrink-0 mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity" />
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Similar incidents */}
                  <div>
                    <h4 className="text-[10px] font-mono font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                      Similar Incidents
                    </h4>
                    <div className="flex gap-2">
                      {aiAnalysis.similarIncidents.map((si) => (
                        <div
                          key={si.id}
                          className="flex-1 bg-secondary/30 rounded-md p-2.5 border border-border/50 hover:border-primary/25 transition-colors cursor-pointer"
                        >
                          <p className="text-xs font-mono font-semibold text-[var(--neon-cyan)]">{si.id}</p>
                          <p className="text-[10px] text-muted-foreground font-mono mt-0.5">{si.date}</p>
                          <div className="mt-1.5 flex items-center gap-1">
                            <div className="flex-1 h-1 bg-border rounded-full overflow-hidden">
                              <div
                                className="h-full bg-[var(--neon-cyan)] rounded-full"
                                style={{ width: `${si.similarity}%` }}
                              />
                            </div>
                            <span className="text-[9px] font-mono text-[var(--neon-cyan)]">{si.similarity}%</span>
                          </div>
                          <p className="text-[9px] text-muted-foreground mt-0.5">similarity</p>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}
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
              <p className="text-sm font-mono text-foreground">Analyzing telemetry data…</p>
              <p className="text-xs text-muted-foreground mt-1">Correlating traces, logs, and metrics</p>
              <p className="text-[10px] font-mono text-muted-foreground mt-2">{state.elapsed}s</p>
            </div>
          </div>
        )}
      </div>

      {/* Live config/transaction incidents running alongside the payment cascade —
          each gets its own compact AI RCA entry so every incident is covered. */}
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
