"use client"

import { useState, useEffect, useCallback, useMemo, useRef } from "react"
import { Sparkles, Brain, ShieldCheck, CheckCircle2, Loader2, Check } from "lucide-react"
import { useAiAnalysis } from "@/hooks/use-ai-analysis"
import type { Runbook } from "@/lib/runbooks"

// AI Root Cause Analysis section — shared by the incident detail page and the
// overview. Inline "Analyze with AI" (streamed, grounded in the incident's REAL
// logs — no service hardcoded) + a dynamic Recovery Plan. The plan's steps come
// from the matched runbook when one applies (authored, config-driven), else a
// generic service-aware manual checklist. Ticking every step resolves the incident.

export type RecoveryLog = { timestamp: string; level: string; message: string; pod: string }

// Fallback steps when no runbook matches — generic but service-aware (dynamic,
// nothing hardcoded to a specific workload).
function genericRecoverySteps(service: string): string[] {
  return [
    `Review the AI root-cause analysis above for ${service}`,
    `Apply the recommended remediation to ${service}`,
    `Roll / restart the affected ${service} workload`,
    `Verify ${service} is healthy and the error rate drops`,
    `Confirm the incident is fully resolved`,
  ]
}

export function AiRootCauseSection({
  incidentId,
  service,
  title,
  description,
  failureType,
  runbook,
  realLogs,
  logsAvailable,
  startedAtMs,
  impact,
  resolved,
  onResolved,
}: {
  incidentId: string
  service: string
  title: string
  description?: string
  failureType?: string
  runbook: Runbook | null
  realLogs: RecoveryLog[]
  logsAvailable: boolean
  startedAtMs?: number
  impact: number
  resolved: boolean
  onResolved: () => void
}) {
  const { state: aiState, analyze } = useAiAnalysis()

  // Recovery steps: the matched runbook's exact actions, else a service-aware list.
  const steps = useMemo(
    () => (runbook?.actions?.length ? runbook.actions : genericRecoverySteps(service)),
    [runbook, service]
  )

  const storageKey = `nova:recovery:${incidentId}`
  const [planOpen, setPlanOpen] = useState(false)
  const [checks, setChecks] = useState<boolean[]>(() => steps.map(() => false))

  // Restore any persisted plan state (survives navigating away + reload).
  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey)
      if (!raw) return
      const saved = JSON.parse(raw) as { open?: boolean; checks?: boolean[] }
      if (saved.open) setPlanOpen(true)
      if (Array.isArray(saved.checks) && saved.checks.length === steps.length) {
        setChecks(saved.checks)
      }
    } catch {
      /* ignore malformed cache */
    }
  }, [storageKey, steps.length])

  const persist = useCallback(
    (open: boolean, c: boolean[]) => {
      try {
        localStorage.setItem(storageKey, JSON.stringify({ open, checks: c }))
      } catch {
        /* storage unavailable — non-fatal */
      }
    },
    [storageKey]
  )

  const showPlan = planOpen || resolved
  const allDone = checks.length === steps.length && checks.every(Boolean)

  // Ticking every step marks the incident resolved (once).
  const resolvedOnce = useRef(false)
  useEffect(() => {
    if (allDone && !resolved && !resolvedOnce.current) {
      resolvedOnce.current = true
      fetch(`/api/incidents/${incidentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolve: true }),
      })
        .catch(() => {})
        .finally(() => onResolved())
    }
  }, [allDone, resolved, incidentId, onResolved])

  const toggle = (i: number) => {
    setChecks((prev) => {
      const next = prev.map((v, idx) => (idx === i ? !v : v))
      persist(true, next)
      return next
    })
  }

  const openPlan = () => {
    setPlanOpen(true)
    persist(true, checks)
  }

  const handleAnalyze = useCallback(() => {
    const logs = realLogs
      .slice(-24)
      .map((l) => `${l.timestamp} ${l.level} ${l.pod ? `[${l.pod}] ` : ""}${l.message}`.trim())
    const impactLine = impact > 0 ? ` Approximately ${impact.toLocaleString()} users/requests impacted.` : ""
    const context = `${incidentId}: ${service} — ${failureType ?? "incident"}. ${description || title}.${impactLine}`
    analyze(logs, context, {
      service,
      sinceMs: startedAtMs ?? Date.now() - 30 * 60 * 1000,
      impact: impact > 0 ? impact : undefined,
    })
  }, [analyze, realLogs, incidentId, service, failureType, description, title, impact, startedAtMs])

  const analyzing = aiState.status === "loading" || aiState.status === "streaming"
  const hasResult = aiState.status === "streaming" || aiState.status === "success"

  return (
    <div className="card-glass rounded-lg p-5 border border-[var(--neon-purple,#a78bfa)]/20 relative overflow-hidden">
      <div className="absolute -top-16 -right-16 w-48 h-48 rounded-full bg-[var(--neon-purple,#a78bfa)]/5 blur-3xl pointer-events-none" />

      <h2 className="text-xs font-mono font-semibold text-muted-foreground tracking-widest uppercase mb-5 flex items-center gap-2">
        <Sparkles className="w-3.5 h-3.5 text-[var(--neon-purple,#a78bfa)]" />
        AI Root Cause Analysis
        {aiState.status === "success" && (
          <span className="flex items-center gap-1 text-[10px] font-mono normal-case tracking-normal px-1.5 py-0.5 rounded bg-primary/10 border border-primary/20 text-[var(--neon-cyan)]">
            {aiState.provider === "openrouter" ? "via OpenRouter" : "via Anthropic"}
          </span>
        )}
      </h2>

      {/* Analyze with AI / Re-analyze */}
      <div className="mb-5">
        <div className="flex items-center gap-3 flex-wrap">
          <button
            onClick={handleAnalyze}
            disabled={analyzing}
            className="flex items-center gap-2 px-4 py-2 text-xs font-mono font-semibold rounded-md bg-[var(--neon-cyan)]/10 border border-[var(--neon-cyan)]/30 text-[var(--neon-cyan)] hover:bg-[var(--neon-cyan)]/20 hover:border-[var(--neon-cyan)]/50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {analyzing ? (
              <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Analyzing…</>
            ) : aiState.status === "idle" ? (
              <><Brain className="w-3.5 h-3.5" /> Analyze with AI →</>
            ) : (
              <><Brain className="w-3.5 h-3.5" /> Re-analyze</>
            )}
          </button>
          <span
            className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${
              logsAvailable
                ? "bg-[var(--neon-green)]/10 border-[var(--neon-green)]/30 text-[var(--neon-green)]"
                : "bg-secondary/60 border-border text-muted-foreground"
            }`}
          >
            {logsAvailable ? "LIVE LOGS" : "NO LIVE LOGS"}
          </span>
          {analyzing && <span className="text-[10px] font-mono text-muted-foreground">{aiState.elapsed}s</span>}
        </div>
        {aiState.status === "error" && (
          <p className="mt-2 text-[10px] font-mono text-[var(--neon-red)]">Analysis failed: {aiState.message}</p>
        )}
      </div>

      {hasResult ? (
        <div className="mb-5">
          <span className="inline-flex items-center gap-1.5 text-[10px] font-mono font-semibold text-muted-foreground tracking-widest uppercase">
            {aiState.status === "streaming" && (
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--neon-cyan)] animate-pulse" />
            )}
            Live Analysis
          </span>
          <pre className="font-mono text-xs text-foreground/90 whitespace-pre-wrap leading-relaxed mt-2 bg-background/50 rounded-md p-3 border border-border/50 max-h-64 overflow-y-auto">{aiState.text}</pre>
        </div>
      ) : aiState.status === "loading" ? (
        <div className="mb-5 flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Correlating traces, logs, and metrics…
        </div>
      ) : (
        <p className="mb-5 text-sm text-muted-foreground">
          Click &ldquo;Analyze with AI&rdquo; above to correlate signals and identify the root cause.
        </p>
      )}

      {/* Recommended Immediate Action — from the matched runbook when present. */}
      {runbook && (
        <div className="mb-5">
          <span className="text-[10px] font-mono font-semibold text-muted-foreground tracking-widest uppercase">
            Recommended Immediate Action
          </span>
          <p className="text-sm text-foreground/90 mt-1 leading-relaxed">{runbook.diagnosis}</p>
        </div>
      )}

      {/* Generate Recovery Plan */}
      {!showPlan && (
        <button
          onClick={openPlan}
          className="flex items-center gap-2 px-4 py-2 text-xs font-mono font-semibold rounded-md bg-[var(--neon-purple,#a78bfa)]/10 border border-[var(--neon-purple,#a78bfa)]/30 text-[var(--neon-purple,#a78bfa)] hover:bg-[var(--neon-purple,#a78bfa)]/20 hover:border-[var(--neon-purple,#a78bfa)]/50 transition-colors"
        >
          <ShieldCheck className="w-3.5 h-3.5" />
          Generate Recovery Plan
        </button>
      )}

      {/* Recovery Plan (inline, manual checklist) */}
      {showPlan && (
        <div className="mt-1 rounded-md bg-background/50 border border-border/50 p-4">
          <h3 className="text-[10px] font-mono font-semibold text-[var(--neon-green)] tracking-widest uppercase mb-1 flex items-center gap-2">
            <ShieldCheck className="w-3.5 h-3.5" />
            Recovery Plan
            {runbook && (
              <span className="normal-case tracking-normal text-[9px] px-1.5 py-0.5 rounded bg-[var(--neon-cyan)]/10 border border-[var(--neon-cyan)]/30 text-[var(--neon-cyan)]">
                {runbook.id}
              </span>
            )}
          </h3>
          <p className="text-[10px] font-mono text-muted-foreground mb-3">
            Execute manually and mark each step complete
          </p>
          <ol className="flex flex-col gap-1">
            {steps.map((step, i) => (
              <RecoveryChecklistItem
                key={i}
                label={step}
                checked={checks[i] ?? false}
                onToggle={() => toggle(i)}
              />
            ))}
          </ol>
          {allDone && (
            <div className="mt-3 flex items-center gap-2 text-sm font-mono text-[var(--neon-green)] bg-[var(--neon-green)]/5 border border-[var(--neon-green)]/25 rounded-md px-3 py-2">
              <CheckCircle2 className="w-4 h-4" /> All steps complete — {service} recovered, incident resolved.
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/* ── Manual recovery checklist item with a custom-styled checkbox ── */
function RecoveryChecklistItem({
  label,
  checked,
  onToggle,
}: {
  label: string
  checked: boolean
  onToggle: () => void
}) {
  return (
    <li
      className={`flex items-center gap-3 text-sm transition-colors duration-300 -mx-2 px-2 py-1.5 rounded-md ${
        checked ? "bg-[var(--neon-green)]/5" : "hover:bg-secondary/30"
      }`}
    >
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        aria-label={label}
        onClick={onToggle}
        className={`shrink-0 w-5 h-5 rounded-md flex items-center justify-center transition-colors duration-300 ${
          checked
            ? "bg-[var(--neon-green)]/15 border border-[var(--neon-green)]/40 text-[var(--neon-green)]"
            : "bg-secondary/60 border border-border text-transparent hover:border-[var(--neon-green)]/40"
        }`}
      >
        <Check className="w-3 h-3" />
      </button>
      <span className={`transition-colors ${checked ? "text-foreground/60 line-through" : "text-foreground/85"}`}>
        {label}
      </span>
    </li>
  )
}
