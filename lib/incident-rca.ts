import type {
  FailureType,
  IncidentSeverity,
  TimelineEntry,
} from "./incident-types"
import { FAILURE_LABELS } from "./incident-types"

const DAY = 86_400_000

// Structured RCA inputs each failure-type template declares. These are composed
// into a full, management-ready RCA document (Executive Summary → Lessons Learned)
// at seed time, using the incident's real timestamps / duration / users.
export interface RcaParts {
  cause: string
  blast: string
  remediation: string[]
  prevention: string[]
  confidence: string
  // Optional per-type contributing factors; a sensible generic set is used otherwise.
  contributingFactors?: string[]
}

function pad(n: number): string {
  return n.toString().padStart(2, "0")
}
function stamp(ms: number): string {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`
}
function clockMs(ms: number): string {
  const d = new Date(ms)
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`
}
function dateOnly(ms: number): string {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}
function addDaysDate(ms: number, days: number): string {
  return dateOnly(ms + days * DAY)
}
function sentenceJoin(items: string[]): string {
  return items.map((s) => (s.trim().endsWith(".") ? s.trim() : s.trim() + ".")).join(" ")
}
// Lowercase only the first character so mid-sentence text flows while acronyms
// and units (Mi, Gi, HPA, OOMKilled, …) stay intact.
function decap(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1)
}

const SEV_MAP: Record<IncidentSeverity, string> = {
  critical: "SEV-1",
  high: "SEV-2",
  medium: "SEV-3",
  low: "SEV-4",
}
const SEV_WORD: Record<IncidentSeverity, string> = {
  critical: "critical",
  high: "high-severity",
  medium: "moderate",
  low: "low-severity",
}
const SEV_RATIONALE: Record<IncidentSeverity, string> = {
  critical:
    "Critical production functionality was degraded, with direct, at-scale customer or revenue impact.",
  high: "A major service path was significantly degraded, with elevated errors or latency affecting a subset of users.",
  medium:
    "A non-critical component was degraded with limited or no direct user-facing impact, but with risk of escalation.",
  low: "A minor or background component was affected with negligible user-facing impact.",
}

export interface DetailedRcaInput {
  id: string
  service: string
  severity: IncidentSeverity
  failureType: FailureType
  startedAt: number
  resolvedAt: number
  durationMin: number
  affectedUsers: number
  timeline: TimelineEntry[]
  parts: RcaParts
}

// Compose a full post-incident RCA document from the structured template parts.
export function buildDetailedRca(inc: DetailedRcaInput): string {
  const { parts } = inc
  const sev = SEV_MAP[inc.severity]
  const label = FAILURE_LABELS[inc.failureType]
  const date = dateOnly(inc.startedAt)
  const startClock = clockMs(inc.startedAt)
  const endClock = clockMs(inc.resolvedAt)
  const dur = inc.durationMin
  const users = inc.affectedUsers

  const usersClause =
    users > 0
      ? `, affecting approximately ${users.toLocaleString()} users`
      : `, with no direct end-user impact`
  const impactUsers =
    users > 0
      ? `${users.toLocaleString()} users affected during the ${dur}-minute window.`
      : `No direct end-user impact; the effect was contained to internal / background processing.`

  const detectSignal = inc.timeline[0]?.event
    ? inc.timeline[0].event.charAt(0).toLowerCase() + inc.timeline[0].event.slice(1)
    : `health signals on ${inc.service} crossed alerting thresholds`

  const factors =
    parts.contributingFactors && parts.contributingFactors.length
      ? parts.contributingFactors
      : [
          `**Primary trigger:** ${parts.cause}`,
          `**Limited headroom:** \`${inc.service}\` was running with little margin for the affected resource, so a modest deviation was enough to cross into failure.`,
          `**Insufficient early warning:** the condition surfaced through its downstream symptoms rather than a dedicated alert, so the first observable signal was already impacting.`,
          `**Manual remediation path:** recovery depended on on-call intervention rather than an automated safeguard, extending time-to-resolution.`,
        ]

  const owners = ["Service Owner", "Platform / SRE", "SRE", "Platform", "Engineering / QA"]
  const items: string[] = []
  parts.prevention.forEach((p, i) => {
    const pr = i === 0 ? "P1" : i === 1 ? "P2" : "P3"
    const owner = owners[i % owners.length]
    items.push(
      `**Preventive · ${pr}** — ${owner}: ${p}. (target: ${addDaysDate(inc.resolvedAt, 7 * (i + 1))})`
    )
  })
  items.push(
    `**Corrective · P2** — SRE: Capture this incident's remediation (${decap(parts.remediation[0])}) as a documented runbook and add an automated check for this failure mode. (target: ${addDaysDate(inc.resolvedAt, 14)})`
  )

  const timelineLines = inc.timeline.map((t) => `- **${t.time}** — ${t.event}`)
  timelineLines.push(
    `- **${endClock}** — Incident resolved; ${decap(parts.remediation[0])}, returning \`${inc.service}\` to baseline.`
  )

  return [
    `# Root Cause Analysis`,
    ``,
    `**Incident ID:** ${inc.id}  `,
    `**Severity:** ${inc.severity.toUpperCase()}  `,
    `**Service:** ${inc.service}  `,
    `**Users affected:** ${users.toLocaleString()}  `,
    `**Started:** ${date} ${startClock}  `,
    `**Report generated:** ${stamp(inc.resolvedAt)}`,
    ``,
    `---`,
    ``,
    `**Incident:** ${inc.id}`,
    `**Service:** \`${inc.service}\``,
    `**Date:** ${date}`,
    `**Status:** Resolved`,
    ``,
    `---`,
    ``,
    `## Executive Summary`,
    ``,
    `On ${date}, \`${inc.service}\` experienced a ${SEV_WORD[inc.severity]} incident (${label})${usersClause}. ${parts.cause} The incident lasted approximately ${dur} minute(s) and was resolved by the on-call team — ${decap(parts.remediation[0])}.`,
    ``,
    `---`,
    ``,
    `## Severity & Impact`,
    ``,
    `- **Severity:** ${sev} — ${SEV_RATIONALE[inc.severity]}`,
    `- **Duration:** ${startClock} → ${endClock} (${dur} minute(s))`,
    `- **Customer impact:** ${parts.blast} ${impactUsers}`,
    ``,
    `---`,
    ``,
    `## Detection`,
    ``,
    `The incident was surfaced by automated monitoring on \`${inc.service}\` when ${detectSignal}, first recorded at ${startClock} on ${date}. Detection was near-immediate relative to onset, indicating alerting was in place for this signal.`,
    ``,
    `---`,
    ``,
    `## Timeline`,
    ``,
    ...timelineLines,
    ``,
    `---`,
    ``,
    `## Root Cause`,
    ``,
    parts.cause,
    ``,
    `---`,
    ``,
    `## Contributing Factors`,
    ``,
    ...factors.map((f) => `- ${f}`),
    ``,
    `---`,
    ``,
    `## Resolution`,
    ``,
    `${sentenceJoin(parts.remediation)} The incident was declared resolved at ${endClock}, approximately ${dur} minute(s) after onset. No data loss or corruption was identified as part of the resolution.`,
    ``,
    `---`,
    ``,
    `## Action Items`,
    ``,
    ...items.map((it, i) => `${i + 1}. ${it}`),
    ``,
    `---`,
    ``,
    `## Lessons Learned`,
    ``,
    `- **What went well:** Automated monitoring detected the ${label} condition on \`${inc.service}\` promptly, and the on-call response contained the incident to ${dur} minute(s).`,
    `- **What went wrong:** The conditions that led to this ${label} incident were not caught before they became user- or service-impacting; ${decap(parts.prevention[0])} would have reduced or prevented the impact.`,
    `- **Confidence:** ${parts.confidence}`,
  ].join("\n")
}
