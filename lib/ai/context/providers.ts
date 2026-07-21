import type { RawLogEntry } from "@/lib/log-selection"
import { selectIncidentLogEntries } from "@/lib/log-selection"
import { formatLocalTime, parseRawLogLine } from "@/lib/local-time"
import type { ContextBlock, ContextProvider } from "./engine"

// ── Input shapes (structural — the assistant's richer state types satisfy these) ──

export interface ContextActiveIncident {
  id: string
  service: string
  severity: string
  title: string
  failureType: string
  startedAt: number | null
  users: number
}

export interface ContextPastIncident {
  id: string
  service: string
  startedAt: number
  resolvedAt: number
}

export interface ContextArchiveIncident {
  id: string
  title: string
  service: string
  severity: string
  status: string
  failureType: string
  startedAt: number
  durationMin: number | null
  affectedUsers: number
  rca: { text: string; generatedAt: string } | null
}

export interface ContextRca {
  id: string
  text: string
  generatedAt: string
}

export interface ContextEvalRun {
  id: string
  finishedAt: string
  generatorModel: string
  judgeModel: string | null
  aggregate: number
  caseCount: number
  kind?: "golden" | "incident"
  incidentId?: string
  results: Array<{
    caseId: string
    overall: number
    judge: { groundedness: number; hallucinationPass: boolean } | null
  }>
}

export interface ContextRunbook {
  id: string
  title: string
  failureTypes: string[]
  services?: string[]
  diagnosis: string
  actions: string[]
  eta: string
}

export interface ContextNamespace {
  name: string
  status: string
  podCount: number
  services: string[]
}

export interface ContextService {
  name: string
  namespace?: string
  podCount: number
  readyPods: number
  crashedPods: number
  avgCpu: number
  avgMemory: number
  status: string
  errorRate: number
}

// Active domain (glossary + service catalog) used to ground the assistant/RCA in
// the operator's world. Omitted / empty ⇒ the domain block is hidden.
export interface ContextDomain {
  displayName?: string
  glossary: Array<{ term: string; meaning: string }>
  services: Array<{ name: string; tier?: number; owner?: string; dependsOn?: string[] }>
}

export interface ContextInput {
  now: Date
  timezone: string
  /** "healthy" | "degrading" | anything else ⇒ active incident. */
  phase: string
  /** Locale/timezone-aware short formatter (injected so providers stay pure). */
  fmt: (d: Date) => string

  active: ContextActiveIncident | null
  past: ContextPastIncident[]
  /** Defaults applied to past-incident rows (from the primary incident). */
  pastDefaults: { severity: string; users: number; title: string; failureType: string }
  archive: ContextArchiveIncident[]

  storedRcas: ContextRca[]
  evalRuns: ContextEvalRun[]
  runbooks: ContextRunbook[]
  cluster: { available: boolean; namespaces: ContextNamespace[]; services: ContextService[] }
  logs: { label: string; entries: RawLogEntry[] }
  /** Active Domain Pack grounding (glossary + catalog). */
  domain?: ContextDomain
}

// ── Providers ────────────────────────────────────────────────────────────────

export const statusProvider: ContextProvider<ContextInput> = {
  id: "status",
  priority: 10,
  build({ now, timezone, phase, fmt }) {
    return {
      id: "status",
      priority: 10,
      lines: [
        `Today is ${fmt(now)} (${timezone}).`,
        `Current system status: ${
          phase === "healthy"
            ? "all systems operational"
            : phase === "degrading"
            ? "a service is degrading"
            : "an active incident is in progress"
        }.`,
      ],
    }
  },
}

export const domainProvider: ContextProvider<ContextInput> = {
  id: "domain",
  priority: 15,
  build({ domain }) {
    if (!domain || (!domain.glossary.length && !domain.services.length)) return null
    const lines: string[] = [
      "",
      `DOMAIN: ${domain.displayName ?? "—"} (glossary + service catalog for grounding):`,
    ]
    if (domain.glossary.length) {
      lines.push("Glossary:")
      for (const g of domain.glossary) {
        lines.push(`- ${g.term}: ${g.meaning}`)
      }
    }
    if (domain.services.length) {
      lines.push("Services:")
      for (const s of domain.services) {
        const meta = [
          s.tier != null ? `tier ${s.tier}` : null,
          s.owner ? `owner ${s.owner}` : null,
          s.dependsOn && s.dependsOn.length ? `depends on ${s.dependsOn.join(", ")}` : null,
        ]
          .filter(Boolean)
          .join("; ")
        lines.push(`- ${s.name}${meta ? ` (${meta})` : ""}`)
      }
    }
    return { id: "domain", priority: 15, lines }
  },
}

interface Row {
  id: string
  service: string
  severity: string
  status: string
  started: Date
  durationMin?: number
  users: number
  title: string
  failureType?: string
}

export const incidentsProvider: ContextProvider<ContextInput> = {
  id: "incidents",
  priority: 20,
  build({ now, phase, fmt, active, past, pastDefaults, archive }) {
    const rows: Row[] = []
    const seen = new Set<string>()
    const addRow = (r: Row) => {
      if (seen.has(r.id)) return
      seen.add(r.id)
      rows.push(r)
    }

    // Active incident (live).
    if (phase !== "healthy" && active) {
      addRow({
        id: active.id,
        service: active.service,
        severity: active.severity,
        status: "ACTIVE",
        started: active.startedAt ? new Date(active.startedAt) : now,
        users: active.users,
        title: active.title,
        failureType: active.failureType,
      })
    }
    // This session's resolved runs.
    for (const p of past) {
      addRow({
        id: p.id,
        service: p.service,
        severity: pastDefaults.severity,
        status: "resolved",
        started: new Date(p.startedAt),
        durationMin: Math.max(1, Math.round((p.resolvedAt - p.startedAt) / 60000)),
        users: pastDefaults.users,
        title: pastDefaults.title,
        failureType: pastDefaults.failureType,
      })
    }
    // Persisted archive (seeded history + past live runs).
    for (const h of archive) {
      addRow({
        id: h.id,
        service: h.service,
        severity: h.severity,
        status: h.status,
        started: new Date(h.startedAt),
        durationMin: h.durationMin ?? undefined,
        users: h.affectedUsers,
        title: h.title,
        failureType: h.failureType,
      })
    }

    rows.sort((a, b) => b.started.getTime() - a.started.getTime())
    const lines: string[] = [
      "",
      `INCIDENTS (${rows.length} total, most recent first — columns: id | date | service | severity | status | duration | failure-type | users | title):`,
    ]
    for (const r of rows) {
      const dur = r.durationMin ? `${r.durationMin}m` : "ongoing"
      lines.push(
        `- ${r.id} | ${fmt(r.started)} | ${r.service} | ${r.severity.toUpperCase()} | ${r.status} | ${dur} | ${r.failureType ?? "unknown"} | ${r.users.toLocaleString()} users | ${r.title}`
      )
    }
    if (!rows.length) {
      lines.push("", "INCIDENTS: none recorded — all systems nominal.")
    }
    return { id: "incidents", priority: 20, lines }
  },
}

export const rcasProvider: ContextProvider<ContextInput> = {
  id: "rcas",
  priority: 30,
  build({ archive, storedRcas }) {
    const rcaById = new Map<string, ContextRca>()
    for (const h of archive) {
      if (h.rca?.text?.trim()) {
        rcaById.set(h.id, { id: h.id, text: h.rca.text, generatedAt: h.rca.generatedAt })
      }
    }
    for (const r of storedRcas) {
      if (r.text?.trim()) rcaById.set(r.id, { id: r.id, text: r.text, generatedAt: r.generatedAt })
    }
    const rcas = [...rcaById.values()].sort((a, b) => (a.generatedAt < b.generatedAt ? 1 : -1))
    if (!rcas.length) return null

    const lines: string[] = ["", `RCA SUMMARIES (${rcas.length} available, newest first):`]
    rcas.forEach((r, i) => {
      const budget = i < 6 ? 1000 : 300
      lines.push(`--- ${r.id} (generated ${r.generatedAt || "recently"}) ---`, r.text.slice(0, budget))
    })
    return { id: "rcas", priority: 30, lines }
  },
}

export const evalsProvider: ContextProvider<ContextInput> = {
  id: "evals",
  priority: 40,
  build({ evalRuns, fmt }) {
    if (!evalRuns.length) return null
    const p = (n: number) => `${Math.round(n * 100)}%`
    const lines: string[] = [
      "",
      `AI QUALITY EVALS (${evalRuns.length} runs, newest first — deterministic checks + LLM-as-judge):`,
    ]
    evalRuns.slice(0, 8).forEach((run) => {
      const when = run.finishedAt ? fmt(new Date(run.finishedAt)) : "recently"
      const kind = run.kind === "incident" ? `incident ${run.incidentId ?? ""}`.trim() : "golden suite"
      lines.push(
        `- ${run.id} | ${when} | ${kind} | aggregate ${p(run.aggregate)} | ${run.caseCount} case(s) | gen: ${run.generatorModel} | judge: ${run.judgeModel ?? "n/a"}`
      )
      run.results.slice(0, 6).forEach((r) => {
        const j = r.judge ? `, grounded ${p(r.judge.groundedness)}, halluc ${r.judge.hallucinationPass ? "pass" : "fail"}` : ""
        lines.push(`    · ${r.caseId}: overall ${p(r.overall)}${j}`)
      })
    })
    return { id: "evals", priority: 40, lines }
  },
}

export const runbooksProvider: ContextProvider<ContextInput> = {
  id: "runbooks",
  priority: 50,
  build({ runbooks }) {
    const lines: string[] = [
      "",
      "RUNBOOKS (known remediations — when an incident matches by failure-type/service, cite the runbook id and recommend approving it):",
    ]
    for (const rb of runbooks) {
      const scope = rb.services ? `; services: ${rb.services.join(", ")}` : ""
      lines.push(
        `- ${rb.id} ${rb.title} [failure-types: ${rb.failureTypes.join(", ")}${scope}] — Diagnosis: ${rb.diagnosis} Remediation: ${rb.actions.join("; ")}. (ETA ${rb.eta})`
      )
    }
    return { id: "runbooks", priority: 50, lines }
  },
}

export const clusterProvider: ContextProvider<ContextInput> = {
  id: "cluster",
  priority: 60,
  build({ cluster }) {
    if (!cluster.available || !cluster.services.length) return null
    const lines: string[] = []
    // Namespace inventory — lets the assistant answer "what namespaces exist".
    if (cluster.namespaces.length) {
      lines.push("", "CLUSTER NAMESPACES (live, all namespaces):")
      for (const ns of cluster.namespaces) {
        const svc = ns.services.length ? ` — services: ${ns.services.join(", ")}` : ""
        lines.push(`- ${ns.name} (${ns.status}, ${ns.podCount} pods)${svc}`)
      }
    }
    lines.push("", "LIVE CLUSTER STATE (real-time, all namespaces):")
    for (const s of cluster.services) {
      const nsLabel = s.namespace ? `[${s.namespace}] ` : ""
      lines.push(
        `- ${nsLabel}${s.name}: ${s.readyPods}/${s.podCount} pods ready` +
          (s.crashedPods ? `, ${s.crashedPods} crashing` : "") +
          `, status ${s.status}, CPU ${s.avgCpu}%, mem ${s.avgMemory}%, error rate ${s.errorRate}%`
      )
    }
    return { id: "cluster", priority: 60, lines }
  },
}

export const logsProvider: ContextProvider<ContextInput> = {
  id: "logs",
  priority: 70,
  build({ logs }) {
    if (!logs.entries.length) return null
    const lines: string[] = ["", `RECENT ${logs.label} LOGS (real, most relevant first):`]
    // Smart selection: dedupe repeated lines, prioritise ERROR/WARN, cap the budget.
    const selected = selectIncidentLogEntries(logs.entries, { budget: 20 })
    for (const { entry: l, count } of selected) {
      const p = parseRawLogLine(l.message)
      const repeat = count > 1 ? ` (x${count})` : ""
      lines.push(`${formatLocalTime(p.ts ?? String(l.timestamp ?? ""))} ${l.level} [${l.pod}] ${p.message}${repeat}`)
    }
    return { id: "logs", priority: 70, lines }
  },
}

/** The assistant's context providers, in priority order. */
export const defaultContextProviders: ReadonlyArray<ContextProvider<ContextInput>> = [
  statusProvider,
  domainProvider,
  incidentsProvider,
  rcasProvider,
  evalsProvider,
  runbooksProvider,
  clusterProvider,
  logsProvider,
]
