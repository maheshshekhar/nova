"use client"

import { useEffect, useRef, useState } from "react"
import { Bot, Send, Loader2, Sparkles, X, MessageSquare } from "lucide-react"
import { useLiveState } from "@/lib/live-state"
import { PRIMARY_INCIDENT } from "@/lib/dashboard-data"
import { useRealMetrics, useRealLogs } from "@/hooks/use-real-metrics"
import { getStoredRcas } from "@/components/dashboard/rca-document-modal"
import { RUNBOOKS } from "@/lib/runbooks"
import { renderContext } from "@/lib/ai/context/engine"
import { defaultContextProviders } from "@/lib/ai/context/providers"

type Msg = { role: "user" | "assistant"; content: string }

const SUGGESTED = [
  "How many incidents this month?",
  "Summarize incidents from the last week",
  "Show me all OOMKilled incidents this year",
  "What's the latest RCA?",
  "Summarize the AI quality evals",
  "How many pods are running?",
]

// Persisted incident archive (seeded history + live runs) fetched from the store.
// Gives the assistant real dates + RCAs to answer time-range questions ("today",
// "last week", "this month", "this year", monthly/yearly summaries).
type ApiIncident = {
  id: string
  title: string
  service: string
  severity: string
  status: string
  failureType: string
  startedAt: number
  resolvedAt: number | null
  durationMin: number | null
  affectedUsers: number
  rca: { text: string; provider: string; generatedAt: string } | null
}

function fmt(d: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d)
}

// AI quality eval runs (from /api/eval) so the assistant can summarize eval scores.
type EvalCaseResult = {
  caseId: string
  overall: number
  deterministic: { rootCausePass: boolean; remediationPass: boolean; noHallucinationPass: boolean }
  judge: { groundedness: number; hallucinationPass: boolean } | null
}
type EvalRunSummary = {
  id: string
  finishedAt: string
  generatorModel: string
  judgeModel: string | null
  aggregate: number
  caseCount: number
  kind?: "golden" | "incident"
  incidentId?: string
  results: EvalCaseResult[]
}

// Turn a raw model id (e.g. "anthropic/claude-sonnet-4-6") into a friendly label
// ("Claude Sonnet 4.6") for the header pill.
function prettifyModel(model: string): string {
  const id = model.includes("/") ? model.split("/").pop()! : model
  return id
    .replace(/-(\d{6,})$/, "") // drop trailing date stamps like -20251001
    .split("-")
    .map((part) => (/^\d+$/.test(part) ? part.replace(/(\d)(?=\d)/g, "$1.") : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(" ")
}

export function DevOpsAssistant() {
  const { phase, currentIncidentId, pastIncidents, incidentStartedAt, impactCount } = useLiveState()
  const realMetrics = useRealMetrics()
  const { logs: realLogs } = useRealLogs()
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState("")
  const [busy, setBusy] = useState(false)
  const [provider, setProvider] = useState<{ name: string; model: string } | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Persisted incident archive — refreshed on open and on phase change so the
  // assistant always grounds time-range answers in the current dataset.
  const [archive, setArchive] = useState<ApiIncident[]>([])
  useEffect(() => {
    let cancelled = false
    fetch("/api/incidents?range=all")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled) setArchive(d?.incidents ?? [])
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [open, phase])

  // AI quality eval runs — refreshed on open so the assistant can summarize the
  // latest eval scores (golden benchmark + incident-grounded runs).
  const [evalRuns, setEvalRuns] = useState<EvalRunSummary[]>([])
  useEffect(() => {
    let cancelled = false
    fetch("/api/eval")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled) setEvalRuns(Array.isArray(d?.runs) ? d.runs : [])
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [open, phase])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" })
  }, [messages, open])

  const buildContext = (): string => {
    const now = new Date()
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    return renderContext(defaultContextProviders, {
      now,
      timezone: tz,
      phase,
      fmt,
      active:
        phase !== "healthy"
          ? {
              id: currentIncidentId,
              service: PRIMARY_INCIDENT.service,
              severity: PRIMARY_INCIDENT.severity,
              title: PRIMARY_INCIDENT.title,
              failureType: "db-pool-exhaustion",
              startedAt: incidentStartedAt ?? null,
              users: impactCount,
            }
          : null,
      past: pastIncidents.map((p) => ({
        id: p.id,
        service: p.service,
        startedAt: p.startedAt,
        resolvedAt: p.resolvedAt,
      })),
      pastDefaults: {
        severity: PRIMARY_INCIDENT.severity,
        users: PRIMARY_INCIDENT.affectedUsers,
        title: PRIMARY_INCIDENT.title,
        failureType: "db-pool-exhaustion",
      },
      archive,
      storedRcas: getStoredRcas(),
      evalRuns,
      runbooks: RUNBOOKS,
      cluster: {
        available: realMetrics.available,
        namespaces: realMetrics.namespaces,
        services: realMetrics.services,
      },
      // Log-block label is data-driven (the incident's service), not a hardcoded
      // domain literal — the engine has no payment-service string baked in.
      logs: { label: PRIMARY_INCIDENT.service, entries: realLogs },
    })
  }

  const send = async (text: string) => {
    const q = text.trim()
    if (!q || busy) return
    const context = buildContext()
    const next: Msg[] = [...messages, { role: "user", content: q }]
    setMessages([...next, { role: "assistant", content: "" }])
    setInput("")
    setBusy(true)
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next, context }),
      })
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({ error: "Request failed" }))
        setMessages((prev) => {
          const copy = [...prev]
          copy[copy.length - 1] = { role: "assistant", content: `⚠️ ${error || "Chat failed"}` }
          return copy
        })
        return
      }
      const aiProvider = res.headers.get("X-AI-Provider")
      const aiModel = res.headers.get("X-AI-Model")
      if (aiProvider && aiModel) setProvider({ name: aiProvider, model: aiModel })
      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let acc = ""
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        acc += decoder.decode(value, { stream: true })
        setMessages((prev) => {
          const copy = [...prev]
          copy[copy.length - 1] = { role: "assistant", content: acc }
          return copy
        })
      }
    } catch {
      setMessages((prev) => {
        const copy = [...prev]
        copy[copy.length - 1] = { role: "assistant", content: "⚠️ Network error." }
        return copy
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col items-end gap-3">
      {open && (
        <div className="w-[min(92vw,400px)] h-[min(78vh,560px)] card-glass rounded-xl border border-[var(--neon-cyan)]/25 shadow-2xl flex flex-col overflow-hidden">
          {/* Header */}
          <div className="shrink-0 px-4 py-3 border-b border-border/60 bg-primary/5 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Bot className="w-4 h-4 text-[var(--neon-cyan)]" />
              <span className="text-sm font-mono font-bold text-foreground">Nova AI</span>
              <span
                title={provider ? `Answered by ${prettifyModel(provider.model)} via ${provider.name}` : "AI-powered"}
                className="flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded bg-primary/10 border border-primary/20 text-[var(--neon-cyan)]"
              >
                <Sparkles className="w-2.5 h-2.5" />{" "}
                {provider ? `${prettifyModel(provider.model)} · ${provider.name}` : "AI"}
              </span>
            </div>
            <button
              onClick={() => setOpen(false)}
              aria-label="Close"
              className="w-7 h-7 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Messages */}
          <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-4 py-3 flex flex-col gap-3">
            {messages.length === 0 && (
              <>
                <p className="text-[11px] text-muted-foreground">
                  Ask Nova about live status, incidents, RCA summaries, pod health, and recent logs.
                </p>
                <div className="flex flex-wrap gap-2">
                  {SUGGESTED.map((s) => (
                    <button
                      key={s}
                      onClick={() => send(s)}
                      className="text-[11px] font-mono px-2.5 py-1 rounded-md bg-secondary/60 border border-border text-foreground/80 hover:text-foreground hover:border-[var(--neon-cyan)]/40 transition-colors"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[85%] rounded-lg px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap ${
                    m.role === "user"
                      ? "bg-[var(--neon-cyan)]/10 border border-[var(--neon-cyan)]/25 text-foreground"
                      : "bg-background/60 border border-border/60 text-foreground/90"
                  }`}
                >
                  {m.content ||
                    (busy && i === messages.length - 1 ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--neon-cyan)]" />
                    ) : null)}
                </div>
              </div>
            ))}
          </div>

          {/* Input */}
          <form
            onSubmit={(e) => {
              e.preventDefault()
              send(input)
            }}
            className="shrink-0 m-3 flex items-center gap-2 bg-background/50 rounded-md border border-border/50 px-3 py-2"
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask Nova about incidents…"
              disabled={busy}
              className="flex-1 bg-transparent text-sm font-mono text-foreground placeholder:text-muted-foreground outline-none disabled:opacity-60"
            />
            <button
              type="submit"
              disabled={busy || !input.trim()}
              className="flex items-center justify-center w-8 h-8 rounded-md bg-[var(--neon-cyan)]/10 border border-[var(--neon-cyan)]/30 text-[var(--neon-cyan)] hover:bg-[var(--neon-cyan)]/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            </button>
          </form>
        </div>
      )}

      {/* Floating action button */}
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label={open ? "Close Nova AI" : "Open Nova AI"}
        className="w-14 h-14 rounded-full flex items-center justify-center bg-[var(--neon-cyan)]/15 border border-[var(--neon-cyan)]/40 text-[var(--neon-cyan)] shadow-lg hover:bg-[var(--neon-cyan)]/25 transition-all backdrop-blur"
      >
        {open ? <X className="w-6 h-6" /> : <MessageSquare className="w-6 h-6" />}
      </button>
    </div>
  )
}
