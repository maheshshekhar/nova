"use client"

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { FileText, Copy, Download, Loader2, Check, Sparkles, RefreshCw, Plus, ShieldCheck } from "lucide-react"
import { formatLocalTime, formatLocalStamp, parseRawLogLine } from "@/lib/local-time"
import { selectIncidentLogEntries, countCheckoutFailures } from "@/lib/log-selection"
import { deriveIncidentMetrics } from "@/lib/incident-metrics"
import { useAiAnalysis } from "@/hooks/use-ai-analysis"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

type RcaIncident = {
  id: string
  title: string
  severity: string
  service: string
  started: string
  affectedUsers: number
  description: string
  timeline: { time: string; event: string }[]
  relatedLogs: { timestamp: string; level: string; message: string }[]
}

type RealLog = { timestamp: string; level: string; message: string; pod: string }

// Accurate resolution per failure type so the RCA's remediation matches the REAL
// fix for THIS incident. Domain-agnostic: keyed on the failure type, never on a
// specific service name.
function resolutionFor(_service: string, failureType?: string): string {
  switch (failureType) {
    case "db-pool-exhaustion":
      return "Resolved by shedding load and scaling the affected deployment to restore database connection-pool headroom."
    case "secret-missing":
      return "Resolved by restoring the missing Secret from its source of truth and rolling the deployment so pods passed config validation and became Ready."
    case "config-missing":
      return "Resolved by restoring the missing configuration value (env var / ConfigMap key) from its source of truth and rolling the deployment so pods passed config validation."
    case "probe-failure":
    case "CrashLoopBackOff":
      return "Resolved by clearing the bad startup state and rolling the deployment; pods then passed their readiness/liveness probes and traffic was restored."
    default:
      return "Resolved by the on-call team rolling the affected deployment back to a healthy state."
  }
}

// Persist generated RCA documents (keyed by incident id) across modal close/open
// and page navigation, so reopening shows the same document instead of silently
// regenerating. Use the "Regenerate" button to explicitly produce a new one.
type RcaCache = { text: string; provider: string; generatedAt: string; startedLabel: string; additionalDetails?: string; approved?: boolean }
const rcaStore: Record<string, RcaCache> = {}

// Expose generated RCAs so other surfaces (e.g. the Nova AI assistant) can ground
// answers in the same AI-written root-cause analysis. Only APPROVED RCAs are
// surfaced — an un-approved draft hasn't been agreed on yet. Newest first.
export function getStoredRcas(): { id: string; text: string; provider: string; generatedAt: string }[] {
  return Object.entries(rcaStore)
    .filter(([, r]) => r.approved && r.text?.trim())
    .map(([id, r]) => ({ id, text: r.text, provider: r.provider, generatedAt: r.generatedAt }))
    .sort((a, b) => (a.generatedAt < b.generatedAt ? 1 : -1))
}

/* ── Lightweight markdown renderer (headings / bold / lists / rules) ── */

function renderInline(text: string): ReactNode[] {
  // Split on **bold** and `code`, keeping the delimiters.
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={i} className="font-semibold text-foreground">{part.slice(2, -2)}</strong>
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code key={i} className="text-[var(--neon-cyan)] bg-[var(--neon-cyan)]/5 px-1 py-0.5 rounded text-[0.85em]">
          {part.slice(1, -1)}
        </code>
      )
    }
    return <span key={i}>{part}</span>
  })
}

function MarkdownLite({ text }: { text: string }) {
  const lines = text.split("\n")
  const blocks: ReactNode[] = []
  let list: { ordered: boolean; items: string[] } | null = null
  let key = 0

  const flushList = () => {
    if (!list) return
    const items = list.items.map((it, i) => (
      <li key={i} className="text-sm text-foreground/85 leading-relaxed">{renderInline(it)}</li>
    ))
    blocks.push(
      list.ordered ? (
        <ol key={key++} className="list-decimal ml-5 flex flex-col gap-1.5 my-2">{items}</ol>
      ) : (
        <ul key={key++} className="list-disc ml-5 flex flex-col gap-1.5 my-2">{items}</ul>
      )
    )
    list = null
  }

  // Fenced code block (``` ... ```) accumulator — rendered verbatim (no inline
  // markdown), so kubectl commands display cleanly instead of stray ``` markers.
  let code: string[] | null = null
  const flushCode = () => {
    if (code === null) return
    const body = [...code]
    while (body.length && body[0].trim() === "") body.shift()
    while (body.length && body[body.length - 1].trim() === "") body.pop()
    blocks.push(
      <pre
        key={key++}
        className="my-3 rounded-md border border-border/60 bg-secondary/40 px-3 py-2 overflow-x-auto"
      >
        <code className="block text-[12px] font-mono text-[var(--neon-cyan)] whitespace-pre">{body.join("\n")}</code>
      </pre>
    )
    code = null
  }

  for (const raw of lines) {
    const line = raw.trimEnd()
    const trimmed = line.trim()

    // Toggle fenced code block on a ``` line (optionally with a language hint).
    if (trimmed.startsWith("```")) {
      if (code === null) { flushList(); code = [] }
      else flushCode()
      continue
    }
    if (code !== null) { code.push(line); continue }

    // Do NOT end an open list on a blank line. LLMs commonly emit ordered items
    // as "1. …\n\n1. …" with blank lines between them; flushing here would split
    // each item into its own <ol>, and every single-item list-decimal <ol>
    // restarts numbering at 1 (so everything renders as "1."). The list is
    // flushed instead when a non-list block (rule, heading, paragraph) or a
    // different list type appears, or at end of input.
    if (trimmed === "") { continue }
    if (trimmed === "---" || trimmed === "***") {
      flushList()
      blocks.push(<hr key={key++} className="my-4 border-border/60" />)
      continue
    }

    const bullet = trimmed.match(/^[-*]\s+(.*)$/)
    const numbered = trimmed.match(/^\d+\.\s+(.*)$/)
    if (bullet) {
      if (!list || list.ordered) { flushList(); list = { ordered: false, items: [] } }
      list.items.push(bullet[1])
      continue
    }
    if (numbered) {
      if (!list || !list.ordered) { flushList(); list = { ordered: true, items: [] } }
      list.items.push(numbered[1])
      continue
    }

    flushList()
    if (trimmed.startsWith("### ")) {
      blocks.push(<h3 key={key++} className="text-sm font-mono font-bold text-foreground mt-4 mb-1">{renderInline(trimmed.slice(4))}</h3>)
    } else if (trimmed.startsWith("## ")) {
      blocks.push(<h2 key={key++} className="text-[13px] font-mono font-bold uppercase tracking-wider text-[var(--neon-cyan)] mt-5 mb-2">{renderInline(trimmed.slice(3))}</h2>)
    } else if (trimmed.startsWith("# ")) {
      blocks.push(<h1 key={key++} className="text-lg font-mono font-bold text-foreground mb-2">{renderInline(trimmed.slice(2))}</h1>)
    } else {
      blocks.push(<p key={key++} className="text-sm text-foreground/85 leading-relaxed my-1.5">{renderInline(trimmed)}</p>)
    }
  }
  flushList()
  flushCode()

  return <div>{blocks}</div>
}

/* ── RCA generator button + streaming modal ── */

export function RcaGeneratorButton({
  incident,
  realLogs,
  logsAvailable,
  initialRca,
  incidentStartedAtMs,
  incidentResolvedAtMs,
  incidentFailureType,
}: {
  incident: RcaIncident
  realLogs: RealLog[]
  logsAvailable: boolean
  // Pre-written RCA for a persisted (seeded/historical) incident. When present the
  // modal shows it directly instead of calling the AI to generate one.
  initialRca?: { text: string; provider: string; generatedAt: string; additionalDetails?: string } | null
  // The incident record's REAL onset / resolution times (epoch ms). Authoritative
  // for the RCA's duration — the captured-log span is unreliable (a sub-second burst
  // for payment, minutes of crash-loop noise for config/transaction).
  incidentStartedAtMs?: number
  incidentResolvedAtMs?: number | null
  // The incident's failure type, so the RCA's resolution matches the real fix.
  incidentFailureType?: string
}) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)

  // Hydrate the in-memory cache from a persisted RCA so the modal renders it
  // immediately (and skips auto-generation) for historical incidents.
  if (initialRca?.text?.trim() && !rcaStore[incident.id]) {
    rcaStore[incident.id] = {
      text: initialRca.text,
      provider: initialRca.provider || "seed",
      generatedAt: initialRca.generatedAt || "",
      startedLabel: incident.started,
      additionalDetails: initialRca.additionalDetails,
      // A persisted RCA is one that was already approved.
      approved: true,
    }
  }

  const [generatedAt, setGeneratedAt] = useState(() => rcaStore[incident.id]?.generatedAt ?? "")
  // Live incident duration label (real start time), computed when the RCA is
  // generated; falls back to the incident's static "started" for filler incidents.
  const [startedLabel, setStartedLabel] = useState(() => rcaStore[incident.id]?.startedLabel ?? incident.started)
  // Operator-supplied context (e.g. findings from external / downstream teams) that
  // isn't in the logs. Fed into the next Regenerate and persisted with the RCA.
  const [additionalDetails, setAdditionalDetails] = useState(
    () => rcaStore[incident.id]?.additionalDetails ?? initialRca?.additionalDetails ?? ""
  )
  const [showDetailInput, setShowDetailInput] = useState(false)
  // Customer-impact count. Starts from the incident record's real figure; when the
  // RCA is generated it is re-derived from the real logs within the incident window.
  const [affectedCount, setAffectedCount] = useState(incident.affectedUsers)
  const { state, analyze, reset } = useAiAnalysis()
  // Set when generation is withheld because there is no real log evidence to
  // ground the RCA in (we never fabricate one from static mock data).
  const [blocked, setBlocked] = useState(false)
  // Human-in-the-loop approval. A generated RCA is only PERSISTED to the server
  // (and thus viewable later on the incident list / detail page / Nova chat) once
  // a human clicks Approve. An un-approved RCA means we haven't agreed on it yet
  // and may still need input from other teams. A pre-persisted RCA (initialRca)
  // is by definition already approved. Also restore the approval from the in-memory
  // rcaStore so it survives the modal unmounting on navigation (dashboard ↔ logs).
  const [approved, setApproved] = useState(
    () => !!(rcaStore[incident.id]?.approved || initialRca?.text?.trim())
  )
  const [approving, setApproving] = useState(false)
  // Structured snapshot of the EXACT logs the current RCA draft was generated from,
  // persisted on approve so the incident eval grades the RCA against its real evidence
  // (not a fresh, mismatched re-pull of the collector's logs with different order IDs).
  const genLogsRef = useRef<{ timestamp: string; level: string; message: string; pod: string }[] | null>(null)
  // The exact generation context the RCA was written against, persisted on approve
  // so the incident eval grades the document against the same context the AI saw.
  const genContextRef = useRef<string | null>(null)

  // Build the RCA context and kick off streaming generation.
  const runRca = useCallback(() => {
    // An RCA must be grounded in REAL evidence. If no live / collected logs are
    // available for this service we WITHHOLD generation entirely rather than
    // fabricate a document from static mock data — that fallback could leak
    // stale, unrelated content into the report.
    if (!(logsAvailable && Array.isArray(realLogs) && realLogs.length > 0)) {
      reset()
      setBlocked(true)
      return
    }
    setBlocked(false)

    const nowMs = Date.now()
    setGeneratedAt(formatLocalStamp(new Date(nowMs)))

    // Real incident window. Use the record's real onset when known; otherwise
    // assume a recent window. PROVISIONAL — re-anchored to the real log timestamps
    // below so the declared/resolved bookends never drift from the logs.
    let startedMs =
      incidentStartedAtMs != null && Number.isFinite(incidentStartedAtMs)
        ? incidentStartedAtMs
        : nowMs - 15 * 60 * 1000
    let resolvedMs = nowMs

    const localFromMs = (ms: number) => formatLocalTime(new Date(ms).toISOString())
    const dateStr = new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(nowMs))

    // Smart selection over a generous window (real logs may predate the detected
    // start), dedupe repeated lines, prioritise ERROR/WARN, cap the budget.
    const selectionStart = Math.min(startedMs, nowMs - 30 * 60 * 1000)
    const selected = selectIncidentLogEntries(realLogs, {
      windowStart: selectionStart,
      windowEnd: nowMs,
      budget: 12,
    })
    // Re-anchor the incident window to the real evidence: the earliest selected
    // log marks the start, the latest marks recovery, keeping the "began / resolved"
    // bookends consistent with the log timestamps in the timeline.
    const tsList = selected
      .map(({ entry: l }) => Date.parse(parseRawLogLine(l.message).ts ?? String(l.timestamp ?? "")))
      .filter((ms) => Number.isFinite(ms))
    if (tsList.length) {
      startedMs = Math.min(...tsList)
    }
    // Prefer the incident record's REAL onset / resolution times for the window and
    // duration (authoritative). The captured-log span is unreliable — a sub-second
    // burst for payment, or minutes of crash-loop noise for config/transaction — so
    // deriving duration from it yields wrong values (1 min or 9 min). Fall back to the
    // log-derived start and the generation time when the record lacks these.
    if (incidentStartedAtMs != null && Number.isFinite(incidentStartedAtMs)) startedMs = incidentStartedAtMs
    if (incidentResolvedAtMs != null && Number.isFinite(incidentResolvedAtMs)) resolvedMs = incidentResolvedAtMs
    // Floor to at least 1 minute so a sub-minute window never reads as 0.
    resolvedMs = Math.max(resolvedMs, startedMs + 60_000)
    const liveAffected = countCheckoutFailures(realLogs, { windowStart: startedMs, windowEnd: resolvedMs })
    // Timestamps are converted to the viewer's local time so the RCA reads
    // consistently with the logs / incident pages.
    const logs: string[] = selected.map(({ entry: l, count }) => {
      const parsed = parseRawLogLine(l.message)
      const repeat = count > 1 ? ` (x${count})` : ""
      return `${formatLocalTime(parsed.ts ?? String(l.timestamp ?? ""))} ${l.level} [${l.pod}] ${parsed.message}${repeat}`
    })
    // Persist the EXACT evidence this RCA is generated from (same order IDs / events)
    // so the incident eval later grades the document against what it actually saw,
    // instead of a fresh collector re-pull whose order IDs no longer match.
    genLogsRef.current = selected.map(({ entry: l, count }) => {
      const parsed = parseRawLogLine(l.message)
      const repeat = count > 1 ? ` (x${count})` : ""
      return {
        timestamp: parsed.ts ?? String(l.timestamp ?? ""),
        level: (l.level || "INFO").toUpperCase(),
        message: `${parsed.message}${repeat}`,
        pod: l.pod || "",
      }
    })

    // Finalise the incident window (re-anchored to the real log evidence above)
    // and derive the duration + start label from it.
    const durationMin = Math.max(1, Math.round((resolvedMs - startedMs) / 60000))
    const startedText =
      incidentStartedAtMs != null && Number.isFinite(incidentStartedAtMs)
        ? `${durationMin} min ago`
        : incident.started
    setStartedLabel(startedText)

    // Customer impact via the shared derivation (single source of truth): prefer
    // the record's frozen affectedUsers, falling back to the live windowed count,
    // so the RCA figure is IDENTICAL to the overview and AI-analysis blast radius.
    const m = deriveIncidentMetrics({
      isActive: false,
      resolved: true,
      failureType: incidentFailureType as import("@/lib/incident-types").FailureType | undefined,
      liveImpact: 0,
      incidentStartedAt: incidentStartedAtMs ?? null,
      recordAffectedUsers: incident.affectedUsers,
      windowedFallback: liveAffected,
    })
    const affected = m.impactCount
    setAffectedCount(affected)
    // Whether to frame impact as failed checkouts (payment cascade) vs. users.
    const isCheckoutImpact = m.isCheckoutImpact
    const impactLine =
      isCheckoutImpact
        ? `Approximately ${affected.toLocaleString()} checkout transactions failed (HTTP 503) during the incident window — customers were unable to complete payment. These requests were rejected before payment processing, so no partial charges or double-payments occurred. Use "failed checkout transactions" (not just "requests") in the customer-impact / executive framing, but do NOT state that any payment was captured, lost, or double-charged.`
        : `Users affected: ${affected.toLocaleString()}.`

    const resolution = resolutionFor(incident.service, incidentFailureType)
    const parts = [
      `${incident.id}: ${incident.title}.`,
      `Service: ${incident.service}. Severity: ${incident.severity}. ${impactLine}`,
      `Description: ${incident.description}`,
      `Severity mapping: "critical" = SEV-1, "high" = SEV-2, "medium" = SEV-3. This incident is "${incident.severity}", so report it as the matching SEV level.`,
      `Today's date is ${dateStr}. The incident began at ${localFromMs(startedMs)} and was resolved at approximately ${localFromMs(resolvedMs)}. Total incident duration: ${durationMin} minute(s).`,
      `Build the timeline STRICTLY from the log timestamps below plus the start/resolution times above. Do NOT invent other clock times, do NOT relabel the timezone, and do NOT output placeholder tokens like [date] or [time]. State the duration as exactly ${durationMin} minute(s).`,
      `Customer-impact figure: state it as EXACTLY ${affected.toLocaleString()}${isCheckoutImpact ? " failed checkout transactions (HTTP 503)" : " users affected"} — do NOT state any other number. Some log lines carry a "(xN)" suffix: that is how many times a SINGLE line recurred (a brevity aid) — NEVER sum those counts or use them to derive the impact/transaction total. Ground every specific detail (order IDs, pod names, timestamps, metrics) ONLY in the log lines below; do NOT invent any that are not present.`,
      `Resolution: ${resolution}`,
    ]

    // Fold in any operator-provided context so the AI can weave it into the RCA.
    if (additionalDetails.trim()) {
      parts.push(
        `Additional operator-provided context (gathered from external / downstream teams — treat as authoritative first-hand input and incorporate naturally into the relevant RCA sections):\n${additionalDetails.trim()}`
      )
    }

    const genContext = parts.join("\n")
    genContextRef.current = genContext
    analyze(logs, genContext, { mode: "rca", service: incident.service, sinceMs: startedMs })
  }, [incident, analyze, logsAvailable, realLogs, additionalDetails, reset, incidentStartedAtMs, incidentResolvedAtMs, incidentFailureType])

  // Persist the finished document so it survives close/open and navigation.
  useEffect(() => {
    if (state.status === "success") {
      rcaStore[incident.id] = {
        text: state.text,
        provider: state.provider,
        generatedAt,
        startedLabel,
        additionalDetails: additionalDetails.trim() || undefined,
        // Fresh draft — not approved (and therefore not shared) until a human acts.
        approved: false,
      }
      // NOTE: deliberately NOT persisted to the server here. Persistence (which
      // makes the RCA survive reloads and appear on the incident list / detail
      // page / Nova chat) only happens when a human clicks Approve — see
      // handleApprove. Until then this is a working draft held in memory only.
    }
  }, [state, incident.id, generatedAt, startedLabel, additionalDetails])

  const handleOpenChange = useCallback((next: boolean) => {
    setOpen(next)
    // Keep the document on close (do NOT reset). Only auto-generate the first
    // time — when there's no result in flight/finished and none cached.
    if (
      next &&
      state.status !== "loading" &&
      state.status !== "streaming" &&
      state.status !== "success" &&
      !rcaStore[incident.id]
    ) {
      runRca()
    }
  }, [state.status, incident.id, runRca])

  const handleRegenerate = useCallback(() => {
    // Never wipe a saved report or regenerate from mock data when there's no real
    // log evidence — withhold instead and keep whatever document is already shown.
    if (!(logsAvailable && Array.isArray(realLogs) && realLogs.length > 0)) {
      setBlocked(true)
      return
    }
    delete rcaStore[incident.id]
    reset()
    setShowDetailInput(false)
    // A regenerated document is a fresh draft that must be re-approved.
    setApproved(false)
    runRca()
  }, [incident.id, reset, runRca, logsAvailable, realLogs])

  const liveText =
    state.status === "streaming" || state.status === "success" ? state.text : ""
  const cached = rcaStore[incident.id]
  const streamedText = liveText || cached?.text || ""
  const hasContent = streamedText.trim().length > 0
  const provider = state.status === "success" ? state.provider : cached?.provider

  // Assemble the export doc: inject a metadata block right after the AI's H1 title.
  const assembleMarkdown = useCallback((): string => {
    const meta = [
      `**Incident ID:** ${incident.id}`,
      `**Severity:** ${incident.severity.toUpperCase()}`,
      `**Service:** ${incident.service}`,
      `**Users affected:** ${affectedCount.toLocaleString()}`,
      `**Started:** ${startedLabel}`,
      `**Report generated:** ${generatedAt}`,
    ].join("  \n")
    const body = streamedText.trimStart()
    if (body.startsWith("# ")) {
      const nl = body.indexOf("\n")
      const title = nl === -1 ? body : body.slice(0, nl)
      const rest = nl === -1 ? "" : body.slice(nl + 1)
      return `${title}\n\n${meta}\n\n---\n${rest}`
    }
    return `${meta}\n\n---\n\n${body}`
  }, [incident, generatedAt, streamedText, startedLabel, affectedCount])

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(assembleMarkdown())
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }, [assembleMarkdown])

  const handleDownload = useCallback(() => {
    const blob = new Blob([assembleMarkdown()], { type: "text/markdown;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `RCA-${incident.id}-${new Date().toISOString().slice(0, 10)}.md`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }, [assembleMarkdown, incident.id])

  // Human approval: the ONLY path that persists the RCA server-side (making it
  // viewable later on the incident list / detail page / Nova chat). Idempotent —
  // once approved the button is disabled for this incident.
  const handleApprove = useCallback(() => {
    if (approved || approving || !hasContent) return
    setApproving(true)
    fetch(`/api/incidents/${incident.id}/rca`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: streamedText,
        provider: provider ?? "ai",
        generatedAt: new Date().toISOString(),
        additionalDetails: additionalDetails.trim() || undefined,
        // The exact logs this RCA was written from — persisted as the incident's
        // evidence so the eval grades the document against what it actually saw.
        ...(genLogsRef.current?.length ? { logsSnapshot: genLogsRef.current } : {}),
        // The exact context the RCA was generated against, for the same reason.
        ...(genContextRef.current?.trim() ? { context: genContextRef.current } : {}),
      }),
    })
      .then((r) => {
        if (r.ok) {
          setApproved(true)
          if (rcaStore[incident.id]) rcaStore[incident.id].approved = true
        }
      })
      .catch(() => {
        // Leave un-approved on failure so the human can retry.
      })
      .finally(() => setApproving(false))
  }, [approved, approving, hasContent, incident.id, streamedText, provider, additionalDetails])

  return (
    <>
      <button
        onClick={() => handleOpenChange(true)}
        className="flex items-center gap-2 px-4 py-2 text-xs font-mono font-semibold rounded-md bg-[var(--neon-cyan)]/10 border border-[var(--neon-cyan)]/30 text-[var(--neon-cyan)] hover:bg-[var(--neon-cyan)]/20 hover:border-[var(--neon-cyan)]/50 transition-colors"
      >
        <FileText className="w-3.5 h-3.5" />
        {initialRca?.text?.trim() ? "View RCA Document" : "Generate RCA Document"}
      </button>

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent
          showCloseButton
          style={{
            width: "min(1100px, 94vw)",
            height: "min(820px, 90vh)",
            maxWidth: "96vw",
            maxHeight: "94vh",
            minWidth: "min(520px, 94vw)",
            minHeight: "360px",
            resize: "both",
          }}
          className="flex flex-col p-0 gap-0 overflow-hidden border-primary/20 sm:max-w-none"
        >
          {/* Header */}
          <DialogHeader className="shrink-0 px-6 pt-6 pb-4 border-b border-border/60 bg-primary/5 text-left">
            <DialogTitle className="flex items-center gap-2 text-sm font-mono font-bold">
              <Sparkles className="w-4 h-4 text-[var(--neon-cyan)]" />
              Root Cause Analysis — {incident.id}
              {provider && (
                <span className="text-[10px] font-mono font-normal px-1.5 py-0.5 rounded bg-primary/10 border border-primary/20 text-[var(--neon-cyan)]">
                  {provider === "openrouter" ? "via OpenRouter" : "via Anthropic"}
                </span>
              )}
              {approved && (
                <span className="text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded bg-[var(--neon-green)]/10 border border-[var(--neon-green)]/30 text-[var(--neon-green)] flex items-center gap-1">
                  <Check className="w-3 h-3" /> Approved
                </span>
              )}
            </DialogTitle>
            <div className="mt-2 grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-1 text-[11px] font-mono text-muted-foreground">
              <span><span className="text-foreground/60">Service:</span> {incident.service}</span>
              <span><span className="text-foreground/60">Severity:</span> {incident.severity.toUpperCase()}</span>
              <span><span className="text-foreground/60">Started:</span> {startedLabel}</span>
              <span className="col-span-2"><span className="text-foreground/60">Generated:</span> {generatedAt}</span>
            </div>
          </DialogHeader>

          {/* Body */}
          <div className="flex-1 min-h-0 px-6 py-4 overflow-y-auto">
            {state.status === "loading" && (
              <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
                <Loader2 className="w-6 h-6 animate-spin text-[var(--neon-cyan)]" />
                <p className="text-sm font-mono text-foreground">Drafting the RCA document…</p>
                <p className="text-xs text-muted-foreground">Correlating logs, impact, and remediation · {state.elapsed}s</p>
              </div>
            )}

            {state.status === "error" && (
              <p className="text-sm font-mono text-[var(--neon-red)] py-6 text-center">
                Failed to generate RCA: {state.message}
              </p>
            )}

            {blocked && !hasContent && state.status !== "loading" && (
              <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
                <FileText className="w-6 h-6 text-[var(--neon-orange)]" />
                <p className="text-sm font-mono text-foreground">RCA generation withheld</p>
                <p className="text-xs text-muted-foreground max-w-md leading-relaxed">
                  No live log evidence is being collected for{" "}
                  <span className="text-foreground">{incident.service}</span> right now. To avoid
                  fabricating a report from stale or mock data, generation is withheld until real
                  cluster logs are available. Bring the incident&apos;s pods / load back up so the
                  collector captures logs, then try again.
                </p>
              </div>
            )}

            {blocked && hasContent && (
              <div className="mb-3 rounded-md border border-[var(--neon-orange)]/30 bg-[var(--neon-orange)]/5 px-3 py-2 text-[11px] font-mono text-[var(--neon-orange)]">
                Regeneration needs live log evidence — showing the saved report instead.
              </div>
            )}

            {hasContent && <MarkdownLite text={streamedText} />}
          </div>

          {/* Additional detail input — feeds the next Regenerate so the AI can weave
              in context the logs don't capture (e.g. external / downstream teams). */}
          {showDetailInput && (
            <div className="shrink-0 px-6 pt-3 pb-1 border-t border-border/60 bg-secondary/20">
              <label
                htmlFor={`rca-detail-${incident.id}`}
                className="block text-[11px] font-mono font-semibold text-foreground/70 mb-1.5"
              >
                Additional detail — findings from external / downstream teams, not in the logs
              </label>
              <textarea
                id={`rca-detail-${incident.id}`}
                value={additionalDetails}
                onChange={(e) => setAdditionalDetails(e.target.value)}
                placeholder="e.g. 'Networking team confirmed a CoreDNS upgrade at 09:10 UTC' or 'Payments vendor reported elevated latency on their side'. Then click Regenerate to fold it into the RCA."
                rows={3}
                className="w-full resize-y rounded-md bg-background/60 border border-border px-3 py-2 text-xs font-mono text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:border-[var(--neon-cyan)]/50"
              />
            </div>
          )}

          {/* Toolbar */}
          <div className="shrink-0 px-6 py-4 border-t border-border/60 flex items-center justify-between gap-3">
            <span className="text-[10px] font-mono text-muted-foreground">
              {state.status === "loading"
                ? "Generating…"
                : state.status === "streaming"
                ? "Streaming…"
                : approved
                ? "Approved & saved — viewable later"
                : hasContent
                ? "Draft — approve to save & share (not persisted yet)"
                : "Paste-ready Markdown for Confluence"}
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowDetailInput((v) => !v)}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono font-semibold rounded-md border transition-colors ${
                  showDetailInput || additionalDetails.trim()
                    ? "bg-[var(--neon-cyan)]/10 border-[var(--neon-cyan)]/30 text-[var(--neon-cyan)]"
                    : "bg-secondary/60 border-border text-foreground/80 hover:text-foreground hover:border-primary/30"
                }`}
              >
                <Plus className="w-3.5 h-3.5" />
                Add additional detail
              </button>
              <button
                onClick={handleRegenerate}
                disabled={state.status === "loading" || state.status === "streaming"}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono font-semibold rounded-md bg-secondary/60 border border-border text-foreground/80 hover:text-foreground hover:border-primary/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${state.status === "loading" || state.status === "streaming" ? "animate-spin" : ""}`} />
                Regenerate
              </button>
              <button
                onClick={handleApprove}
                disabled={approved || approving || !hasContent || state.status === "loading" || state.status === "streaming"}
                title={approved ? "This RCA has been approved and saved" : "Approve to save this RCA and make it viewable later"}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono font-semibold rounded-md border transition-colors disabled:cursor-not-allowed ${
                  approved
                    ? "bg-secondary/40 border-border text-muted-foreground opacity-60"
                    : "bg-[var(--neon-green)]/10 border-[var(--neon-green)]/30 text-[var(--neon-green)] hover:bg-[var(--neon-green)]/20 hover:border-[var(--neon-green)]/50 disabled:opacity-40"
                }`}
              >
                {approving ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : approved ? (
                  <Check className="w-3.5 h-3.5" />
                ) : (
                  <ShieldCheck className="w-3.5 h-3.5" />
                )}
                {approved ? "Approved" : approving ? "Approving…" : "Approve RCA"}
              </button>
              <button
                onClick={handleCopy}
                disabled={!hasContent}
                className="relative flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono font-semibold rounded-md bg-secondary/60 border border-border text-foreground/80 hover:text-foreground hover:border-primary/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-[var(--neon-green)]" /> : <Copy className="w-3.5 h-3.5" />}
                {copied ? "Copied!" : "Copy Markdown"}
              </button>
              <button
                onClick={handleDownload}
                disabled={!hasContent}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono font-semibold rounded-md bg-[var(--neon-cyan)]/10 border border-[var(--neon-cyan)]/30 text-[var(--neon-cyan)] hover:bg-[var(--neon-cyan)]/20 hover:border-[var(--neon-cyan)]/50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <Download className="w-3.5 h-3.5" />
                Download .md
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
