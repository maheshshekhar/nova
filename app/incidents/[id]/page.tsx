"use client"

import { use, useState, useEffect } from "react"
import Link from "next/link"
import { ArrowLeft, AlertTriangle, Clock, Users, Zap, Terminal, ExternalLink, Brain, ShieldCheck, Sparkles, CheckCircle2, Loader2, FileText, BookOpen, Play } from "lucide-react"
import { useRealLogs } from "@/hooks/use-real-metrics"
import { RcaGeneratorButton } from "@/components/dashboard/rca-document-modal"
import { matchRunbook, type Runbook } from "@/lib/runbooks"
import { formatLocalTime, formatLocalClock, parseRawLogLine } from "@/lib/local-time"
import type { IncidentRecord } from "@/lib/incident-types"

type CapturedLog = { timestamp: string; level: string; message: string; pod: string }

// Relative "x ago" label for a persisted incident's start time.
function startedAgoLabel(ms: number): string {
  const diff = Date.now() - ms
  const min = Math.round(diff / 60000)
  if (min < 1) return "just now"
  if (min < 60) return `${min} min ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.round(hr / 24)
  if (day < 30) return `${day}d ago`
  const mo = Math.round(day / 30)
  if (mo < 12) return `${mo}mo ago`
  return `${Math.round(mo / 12)}y ago`
}

// Map a persisted store record into the shape this page renders.
function recordToDetail(r: IncidentRecord) {
  return {
    id: r.id,
    title: r.title,
    severity: r.severity,
    service: r.service,
    started: startedAgoLabel(r.startedAt),
    status: r.status,
    affectedUsers: r.affectedUsers,
    description: r.description,
    timeline: r.timeline,
    relatedLogs: r.relatedLogs.map((l) => ({
      timestamp: l.timestamp,
      level: l.level,
      message: l.message,
    })),
  }
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
  resolved: {
    bg: "bg-[var(--neon-green)]/10",
    border: "border-[var(--neon-green)]/30",
    text: "text-[var(--neon-green)]",
    badge: "bg-[var(--neon-green)]/15 text-[var(--neon-green)] border-[var(--neon-green)]/30",
    dot: "bg-[var(--neon-green)]",
  },
} as const

const statusLabel: Record<string, string> = {
  investigating: "FIRING",
  mitigating: "MITIGATING",
  monitoring: "MONITORING",
  resolved: "STABILIZED",
}

const logLevelColors: Record<string, string> = {
  ERROR: "text-[var(--neon-red)]",
  WARN: "text-[var(--neon-orange)]",
  INFO: "text-[var(--neon-cyan)]",
  DEBUG: "text-muted-foreground",
}

const timelineTypeColors: Record<string, { dot: string; line: string }> = {
  info: { dot: "bg-[var(--neon-cyan)]", line: "border-[var(--neon-cyan)]/30" },
  warning: { dot: "bg-[var(--neon-orange)]", line: "border-[var(--neon-orange)]/30" },
  error: { dot: "bg-[var(--neon-red)]", line: "border-[var(--neon-red)]/30" },
  success: { dot: "bg-[var(--neon-green)]", line: "border-[var(--neon-green)]/30" },
}

export default function IncidentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)

  // Load the persisted incident record from the store. This is the single source
  // of truth — the page renders only what the store holds (no scripted template).
  const [record, setRecord] = useState<IncidentRecord | null>(null)
  const [recordLoaded, setRecordLoaded] = useState(false)
  const [refreshTick, setRefreshTick] = useState(0)
  useEffect(() => {
    let cancelled = false
    setRecordLoaded(false)
    fetch(`/api/incidents/${id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled) {
          setRecord(d?.incident ?? null)
          setRecordLoaded(true)
        }
      })
      .catch(() => {
        if (!cancelled) setRecordLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [id, refreshTick])

  const incident = record ? recordToDetail(record) : null
  const resolved = record?.status === "resolved"
  const isOpen = !!record && !resolved

  // Live pod logs for this incident's service (only meaningful for live incidents).
  const { logs: realLogs } = useRealLogs(record?.service)

  // Snapshot the real cluster logs while the incident is live. useRealLogs only
  // keeps recent logs, so by the time the RCA is generated (post-recovery) the
  // live errors have aged out — the snapshot keeps the Timeline / Related Logs
  // real. Persisted RCA snapshot is the final fallback across reloads.
  const [capturedLogs, setCapturedLogs] = useState<CapturedLog[]>([])
  useEffect(() => {
    if (realLogs.length > 0) setCapturedLogs(realLogs)
  }, [realLogs])

  // Runbook match — the dashboard recognises well-known failure modes and offers a
  // pre-approved remediation. Failure type comes from the persisted record.
  const failureType = record?.failureType
  const matchedRunbook = failureType ? matchRunbook(failureType, record?.service) : null

  // Local-time formatting is client-only (avoids SSR hydration mismatch).
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  if (!incident) {
    if (!recordLoaded) {
      return (
        <main className="max-w-[1600px] mx-auto px-4 lg:px-6 py-6">
          <div className="card-glass rounded-lg p-8 flex items-center justify-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin text-[var(--neon-cyan)]" />
            <span className="text-sm font-mono text-muted-foreground">Loading incident {id}…</span>
          </div>
        </main>
      )
    }
    return (
      <main className="max-w-[1600px] mx-auto px-4 lg:px-6 py-6">
        <div className="flex items-center gap-3 mb-6">
          <Link
            href="/incidents"
            className="w-8 h-8 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <h1 className="text-lg font-mono font-bold text-foreground">Incident Not Found</h1>
        </div>
        <div className="card-glass rounded-lg p-8 text-center">
          <p className="text-muted-foreground font-mono">Incident {id} was not found.</p>
          <Link href="/incidents" className="text-[var(--neon-cyan)] text-sm mt-2 inline-block hover:underline">
            ← Back to incidents
          </Link>
        </div>
      </main>
    )
  }

  const effectiveSeverity = resolved ? "resolved" : incident.severity
  const effectiveStatus = resolved ? "resolved" : incident.status
  const cfg = severityConfig[effectiveSeverity as keyof typeof severityConfig] ?? severityConfig.medium

  // Prefer current real logs; fall back to the ones captured during the incident,
  // then the persisted RCA snapshot so real evidence survives buffer expiry + reload.
  const snapshotLogs = record?.rca?.logsSnapshot ?? []
  const effectiveRealLogs =
    realLogs.length > 0 ? realLogs : capturedLogs.length > 0 ? capturedLogs : snapshotLogs

  // Show live cluster logs for a live incident; otherwise render the record's logs.
  const isLiveIncident = record?.origin === "live"
  const useRealRelated = isLiveIncident && effectiveRealLogs.length > 0

  const displayAffected = record?.affectedUsers ?? incident.affectedUsers
  const startedLabel = record ? startedAgoLabel(record.startedAt) : incident.started

  const relatedLogsToShow = useRealRelated
    ? effectiveRealLogs.slice(-40).map((log) => {
        const parsed = parseRawLogLine(log.message)
        return {
          timestamp: parsed.ts ?? log.timestamp,
          level: log.level,
          message: `[${log.pod}] ${parsed.message}`,
        }
      })
    : incident.relatedLogs

  // When live, drive the Timeline from the fresh cluster logs instead of the
  // record's stored timeline, so it doesn't show stale times next to live logs.
  const timelineToShow: { time: string; event: string; type: "info" | "warning" | "error" | "success"; live?: boolean }[] =
    useRealRelated
      ? effectiveRealLogs.slice(-8).map((log) => {
          const parsed = parseRawLogLine(log.message)
          return {
            time: parsed.ts ?? log.timestamp,
            event: parsed.message,
            type: log.level === "ERROR" ? "error" : log.level === "WARN" ? "warning" : "info",
            live: true,
          }
        })
      : incident.timeline

  return (
    <main className="max-w-[1600px] mx-auto px-4 lg:px-6 py-6 flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-start gap-3">
        <Link
          href="/incidents"
          className="w-8 h-8 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors mt-1"
        >
          <ArrowLeft className="w-4 h-4" />
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className={`text-[10px] font-mono font-bold border px-1.5 py-0.5 rounded ${cfg.badge}`}>
              {resolved ? "RESOLVED" : incident.severity.toUpperCase()}
            </span>
            <span className="text-xs font-mono text-muted-foreground">{incident.id}</span>
            <span className={`flex items-center gap-1.5 text-[10px] font-mono font-semibold ${cfg.text}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot} ${resolved ? "" : "animate-pulse"}`} />
              {statusLabel[effectiveStatus] ?? effectiveStatus.toUpperCase()}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-mono font-bold text-foreground">{incident.title}</h1>
          </div>
          <div className="flex items-center gap-4 mt-2">
            <span className="text-xs font-mono text-muted-foreground flex items-center gap-1">
              <Zap className="w-3 h-3" /> {incident.service}
            </span>
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <Clock className="w-3 h-3" /> Started {startedLabel}
            </span>
            {displayAffected > 0 && (
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                <Users className="w-3 h-3" />
                {displayAffected.toLocaleString()} affected
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Description */}
      <div className={`${cfg.bg} ${cfg.border} border rounded-lg px-5 py-4`}>
        <div className="flex items-center gap-2 mb-2">
          {resolved ? (
            <CheckCircle2 className={`w-4 h-4 ${cfg.text}`} />
          ) : (
            <AlertTriangle className={`w-4 h-4 ${cfg.text}`} />
          )}
          <span className="text-xs font-mono font-semibold text-muted-foreground tracking-widest uppercase">Description</span>
        </div>
        <p className="text-sm text-foreground/90 leading-relaxed">
          {resolved && !incident.description
            ? "Incident stabilized."
            : incident.description || "No description provided."}
        </p>
      </div>

      {/* Matched runbook — the dashboard recognises this failure mode and offers a
          pre-approved, one-click remediation that runs against the real cluster. */}
      {matchedRunbook && (
        <RunbookPanel
          runbook={matchedRunbook}
          service={incident.service}
          incidentId={id}
          resolved={resolved}
          onResolved={() => setRefreshTick((t) => t + 1)}
        />
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Timeline */}
        <div className="card-glass rounded-lg p-5">
          <h2 className="text-xs font-mono font-semibold text-muted-foreground tracking-widest uppercase mb-4">
            Timeline
          </h2>
          {timelineToShow.length === 0 ? (
            <p className="text-xs font-mono text-muted-foreground">No timeline entries.</p>
          ) : (
            <div className="flex flex-col gap-0">
              {timelineToShow.map((entry, i) => {
                const colors = timelineTypeColors[entry.type]
                const displayTime = !mounted
                  ? entry.time
                  : entry.live
                  ? formatLocalTime(entry.time)
                  : formatLocalClock(entry.time)
                return (
                  <div key={i} className="flex gap-3 relative">
                    <div className="flex flex-col items-center">
                      <div className={`w-2.5 h-2.5 rounded-full ${colors.dot} shrink-0 mt-1 z-10`} />
                      {i < timelineToShow.length - 1 && (
                        <div className={`w-px flex-1 border-l ${colors.line}`} />
                      )}
                    </div>
                    <div className="pb-4 min-w-0">
                      <span className="text-[10px] font-mono text-muted-foreground">{displayTime}</span>
                      <p className="text-sm text-foreground/90 mt-0.5">{entry.event}</p>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Related Logs */}
        <div className="card-glass rounded-lg p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xs font-mono font-semibold text-muted-foreground tracking-widest uppercase flex items-center gap-2">
              <Terminal className="w-3.5 h-3.5" /> Related Logs
              {useRealRelated && (
                <span className="flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded bg-[var(--neon-green)]/10 border border-[var(--neon-green)]/25 text-[var(--neon-green)]">
                  LIVE
                </span>
              )}
            </h2>
            <Link
              href="/logs"
              className="text-xs text-primary hover:text-[var(--neon-cyan)] transition-colors flex items-center gap-1"
            >
              View all logs <ExternalLink className="w-3 h-3" />
            </Link>
          </div>
          {relatedLogsToShow.length === 0 ? (
            <p className="text-xs font-mono text-muted-foreground">No related logs.</p>
          ) : (
            <div className="flex flex-col gap-1 font-mono text-xs bg-background/50 rounded-md p-3 border border-border/50">
              {relatedLogsToShow.map((log, i) => (
                <div key={i} className="flex gap-2 py-1 border-b border-border/20 last:border-0">
                  <span className="text-[10px] text-muted-foreground shrink-0 w-24 truncate">
                    {mounted ? formatLocalTime(log.timestamp) : log.timestamp.split("T")[1]?.replace("Z", "") ?? log.timestamp}
                  </span>
                  <span className={`shrink-0 w-12 text-[10px] font-bold ${logLevelColors[log.level]}`}>
                    {log.level}
                  </span>
                  <span className="text-foreground/80 break-all">{log.message}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* AI Root Cause Analysis — generated on demand from the service's real pod
          logs (streamed by the configured LLM). Shown while the incident is open. */}
      {isOpen && (
        <div className="card-glass rounded-lg p-5 border border-[var(--neon-purple,#a78bfa)]/20">
          <h2 className="text-xs font-mono font-semibold text-muted-foreground tracking-widest uppercase mb-2 flex items-center gap-2">
            <Sparkles className="w-3.5 h-3.5 text-[var(--neon-purple,#a78bfa)]" /> AI Root Cause Analysis
          </h2>
          <p className="text-sm text-foreground/70 mb-4 max-w-2xl leading-relaxed">
            Generate an AI root-cause analysis for {incident.id} from {incident.service}&apos;s
            {useRealRelated ? " live pod logs" : " incident record"} — streamed by AI and grounded
            in the real cluster signal.
          </p>
          <RcaGeneratorButton
            incident={incident}
            realLogs={useRealRelated ? effectiveRealLogs : []}
            logsAvailable={useRealRelated}
            initialRca={record?.rca ?? null}
            incidentStartedAtMs={record?.startedAt}
            incidentResolvedAtMs={record?.resolvedAt ?? undefined}
            incidentFailureType={record?.failureType}
          />
        </div>
      )}

      {/* Post-Incident Report — RCA document generator, shown once resolved. */}
      {resolved && (
        <div className="card-glass rounded-lg p-5 border border-[var(--neon-cyan)]/20">
          <h2 className="text-xs font-mono font-semibold text-muted-foreground tracking-widest uppercase mb-2 flex items-center gap-2">
            <FileText className="w-3.5 h-3.5 text-[var(--neon-cyan)]" /> Post-Incident Report
          </h2>
          <p className="text-sm text-foreground/70 mb-4 max-w-2xl leading-relaxed">
            Generate the management-ready RCA writeup for {incident.id} from this incident&apos;s
            logs and remediation — streamed live by AI, ready to copy into Confluence.
          </p>
          <RcaGeneratorButton
            incident={incident}
            realLogs={useRealRelated ? effectiveRealLogs : []}
            logsAvailable={useRealRelated}
            initialRca={record?.rca ?? null}
            incidentStartedAtMs={record?.startedAt}
            incidentResolvedAtMs={record?.resolvedAt ?? undefined}
            incidentFailureType={record?.failureType}
          />
        </div>
      )}

      {/* Actions */}
      <div className="card-glass rounded-lg p-5">
        <h2 className="text-xs font-mono font-semibold text-muted-foreground tracking-widest uppercase mb-3 flex items-center gap-2">
          <Brain className="w-3.5 h-3.5" /> Quick Actions
        </h2>
        <div className="flex flex-wrap gap-2">
          {["Acknowledge", "Escalate", "Run Playbook", "Add Responder", "Post Update"].map((action) => (
            <button
              key={action}
              className="px-3 py-1.5 text-xs font-mono rounded-md bg-secondary/60 border border-border text-muted-foreground hover:text-foreground hover:border-primary/30 transition-colors"
            >
              {action}
            </button>
          ))}
        </div>
      </div>
    </main>
  )
}

/* ── Matched Runbook panel ── */

function RunbookPanel({
  runbook,
  service,
  incidentId,
  resolved,
  onResolved,
}: {
  runbook: Runbook
  service: string
  incidentId: string
  resolved: boolean
  onResolved: () => void
}) {
  const [state, setState] = useState<"idle" | "applying" | "applied" | "error">(
    resolved ? "applied" : "idle"
  )
  const [message, setMessage] = useState("")

  // Poll the live cluster status for `service` until its pods are all Ready again
  // (or a timeout). This is what turns the panel from orange (applying) to green.
  const waitForHealthy = async (): Promise<boolean> => {
    const deadline = Date.now() + 120_000
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000))
      try {
        const res = await fetch("/api/metrics?endpoint=metrics/services", { cache: "no-store" })
        const data = await res.json()
        const svc = (data.services || []).find((s: { name: string }) => s.name === service) as
          | { readyPods: number; podCount: number; crashedPods?: number; status: string }
          | undefined
        if (svc) {
          setMessage(
            `Rolling out — ${svc.readyPods}/${svc.podCount} pods Ready` +
              (svc.crashedPods ? `, ${svc.crashedPods} still crashing` : "")
          )
          if (
            svc.podCount > 0 &&
            svc.readyPods === svc.podCount &&
            (svc.crashedPods || 0) === 0 &&
            svc.status === "healthy"
          ) {
            return true
          }
        } else {
          setMessage("Rolling out — waiting for pods to come up…")
        }
      } catch {
        // transient — keep polling
      }
    }
    return false
  }

  const handleApprove = async () => {
    if (state === "applying") return
    setState("applying")
    setMessage("Applying remediation — patching deployment…")
    try {
      // Perform the real cluster remediation defined by the runbook.
      const res = await fetch("/api/remediate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service, action: runbook.action, replicas: runbook.replicas }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) throw new Error(data.error || "Remediation failed")

      // Watch the real pods roll out; only go green once the service is healthy.
      setMessage("Remediation applied — waiting for pods to become Ready…")
      const healthy = await waitForHealthy()

      if (!healthy) {
        setState("error")
        setMessage(
          "Remediation applied, but the service hasn't returned to healthy yet — still rolling out. Check the cluster."
        )
        return
      }

      // Pods are Ready again — now persist the incident as resolved.
      await fetch(`/api/incidents/${incidentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolve: true }),
      }).catch(() => {})

      setState("applied")
      setMessage(`Recovered — ${service} pods are Ready.`)
      setTimeout(onResolved, 1200)
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Remediation failed")
      setState("error")
    }
  }

  const toneBorder =
    state === "applied"
      ? "border-[var(--neon-green)]/40"
      : state === "applying"
      ? "border-[var(--neon-orange)]/50"
      : state === "error"
      ? "border-[var(--neon-red)]/40"
      : "border-[var(--neon-cyan)]/25"

  return (
    <div className={`card-glass rounded-lg p-5 border ${toneBorder} relative overflow-hidden transition-colors`}>
      <div className="absolute -top-16 -right-16 w-48 h-48 rounded-full bg-[var(--neon-cyan)]/5 blur-3xl pointer-events-none" />
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-xs font-mono font-semibold text-muted-foreground tracking-widest uppercase flex items-center gap-2">
          <BookOpen className="w-3.5 h-3.5 text-[var(--neon-cyan)]" /> Matched Runbook
        </h2>
        <span className="text-[10px] font-mono font-bold border px-1.5 py-0.5 rounded bg-[var(--neon-cyan)]/10 border-[var(--neon-cyan)]/30 text-[var(--neon-cyan)]">
          {runbook.id}
        </span>
      </div>

      <div className="flex items-center gap-2 mb-2">
        <ShieldCheck className="w-4 h-4 text-[var(--neon-cyan)]" />
        <h3 className="text-sm font-mono font-bold text-foreground">{runbook.title}</h3>
      </div>
      <p className="text-sm text-foreground/80 leading-relaxed mb-1">
        <span className="text-muted-foreground font-mono text-xs">Diagnosis: </span>
        {runbook.diagnosis}
      </p>
      <p className="text-xs text-muted-foreground leading-relaxed mb-4">
        <span className="font-mono">Symptom: </span>
        {runbook.symptom}
      </p>

      <div className="bg-background/50 rounded-md p-4 border border-border/50 mb-4">
        <p className="text-[10px] font-mono font-semibold text-muted-foreground tracking-widest uppercase mb-2">
          Remediation plan · target {service} · ETA {runbook.eta}
        </p>
        <ol className="flex flex-col gap-1.5">
          {runbook.actions.map((a, i) => (
            <li key={i} className="flex items-start gap-2 text-sm text-foreground/85">
              <span className="mt-0.5 w-4 h-4 shrink-0 rounded-full bg-[var(--neon-cyan)]/10 border border-[var(--neon-cyan)]/30 text-[var(--neon-cyan)] text-[9px] font-bold flex items-center justify-center">
                {i + 1}
              </span>
              {a}
            </li>
          ))}
        </ol>
      </div>

      {state === "applied" ? (
        <div className="flex items-center gap-2 text-sm font-mono text-[var(--neon-green)]">
          <CheckCircle2 className="w-4 h-4" />
          {resolved && !message
            ? "Runbook remediation applied — incident resolved."
            : message || "Recovered — service healthy."}
        </div>
      ) : state === "applying" ? (
        <div className="flex items-center gap-2 text-sm font-mono text-[var(--neon-orange)]">
          <Loader2 className="w-4 h-4 animate-spin" />
          {message || "Applying remediation…"}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <p className="text-sm text-foreground/80 flex-1">{runbook.approvalPrompt}</p>
            <button
              onClick={handleApprove}
              className="flex items-center gap-2 px-4 py-2 text-xs font-mono font-semibold rounded-md bg-[var(--neon-green)]/10 border border-[var(--neon-green)]/40 text-[var(--neon-green)] hover:bg-[var(--neon-green)]/20 transition-colors shrink-0"
            >
              <Play className="w-3.5 h-3.5" /> Approve &amp; Run
            </button>
          </div>
          {state === "error" && (
            <p className="text-xs font-mono text-[var(--neon-red)] leading-relaxed">⚠ {message}</p>
          )}
        </div>
      )}
    </div>
  )
}
