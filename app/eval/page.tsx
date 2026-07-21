"use client"

import { useEffect, useState } from "react"
import { Brain, Loader2, Play, CheckCircle2, XCircle, AlertTriangle, History, ChevronDown } from "lucide-react"

type Judge = {
  groundedness: number
  formatCompliance: number
  remediationCorrectness: number
  hallucinationPass: boolean
  rationale: string
  judgeModel: string
} | null

type Deterministic = {
  rootCausePass: boolean
  remediationPass: boolean
  noHallucinationPass: boolean
  sectionsPass: boolean
  score: number
  details: string[]
}

type CaseResult = {
  caseId: string
  title: string
  mode: "triage" | "rca"
  output: string
  deterministic: Deterministic
  judge: Judge
  overall: number
  error?: string
}

type EvalRun = {
  id: string
  startedAt: string
  finishedAt: string
  generatorModel: string
  judgeModel: string | null
  aggregate: number
  caseCount: number
  results: CaseResult[]
  kind?: "golden" | "incident"
  incidentId?: string
}

type ResolvedIncident = {
  id: string
  title: string
  service: string
  severity: string
  failureType: string
}

const CASES: { id: string; title: string; mode: string }[] = [
  { id: "db-pool-exhaustion-triage", title: "Payment-service DB pool exhaustion (triage)", mode: "triage" },
  { id: "db-pool-exhaustion-rca", title: "Payment-service DB pool exhaustion (full RCA)", mode: "rca" },
  { id: "oomkilled-triage", title: "Transaction-service OOMKilled (triage)", mode: "triage" },
  { id: "crashloop-config-triage", title: "Config-service CrashLoopBackOff (triage)", mode: "triage" },
  { id: "probe-failure-triage", title: "Payment-service readiness probe failures (triage)", mode: "triage" },
]

function scoreColor(score: number): string {
  if (score >= 0.85) return "text-[var(--neon-green)]"
  if (score >= 0.6) return "text-[var(--neon-orange)]"
  return "text-[var(--neon-red)]"
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`
}

function Pill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded border ${
        ok
          ? "text-[var(--neon-green)] bg-[var(--neon-green)]/10 border-[var(--neon-green)]/25"
          : "text-[var(--neon-red)] bg-[var(--neon-red)]/10 border-[var(--neon-red)]/25"
      }`}
    >
      {ok ? <CheckCircle2 className="w-2.5 h-2.5" /> : <XCircle className="w-2.5 h-2.5" />}
      {label}
    </span>
  )
}

export default function EvalPage() {
  const [runningAll, setRunningAll] = useState(false)
  const [runningCase, setRunningCase] = useState<string | null>(null)
  const [current, setCurrent] = useState<EvalRun | null>(null)
  const [history, setHistory] = useState<EvalRun[]>([])
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  // Per-case results merged from single-case runs so the table stays populated.
  const [caseResults, setCaseResults] = useState<Record<string, CaseResult>>({})
  const [viewingRunId, setViewingRunId] = useState<string | null>(null)

  // Incident-grounded evals: resolved incidents that have an approved RCA to grade.
  const [incidents, setIncidents] = useState<ResolvedIncident[]>([])
  const [selectedIncidentId, setSelectedIncidentId] = useState<string>("")
  const [runningIncident, setRunningIncident] = useState(false)
  const [incidentResult, setIncidentResult] = useState<CaseResult | null>(null)

  // Load a run's full report into the case table + summary.
  const loadRun = (run: EvalRun) => {
    setCurrent(run)
    setViewingRunId(run.id)
    // Incident runs carry a single result keyed by `incident:<id>` that the golden
    // case table can't render — surface it in the Incident evals section instead.
    const isIncidentRun =
      run.kind === "incident" || run.results.every((r) => r.caseId.startsWith("incident:"))
    if (isIncidentRun) {
      setIncidentResult(run.results[0] ?? null)
      if (run.incidentId) setSelectedIncidentId(run.incidentId)
      return
    }
    const merged: Record<string, CaseResult> = {}
    for (const r of run.results) merged[r.caseId] = r
    setCaseResults(merged)
    // Viewing a golden run — hide any incident result so it doesn't linger stale.
    setIncidentResult(null)
  }

  // Fetch history. On initial mount (hydrate=true) also restore the most recent
  // saved run so a page reload never loses the last report.
  const loadHistory = async (hydrate = false) => {
    try {
      const res = await fetch("/api/eval", { cache: "no-store" })
      const data = await res.json()
      if (Array.isArray(data.runs)) {
        setHistory(data.runs)
        if (hydrate && data.runs.length > 0) loadRun(data.runs[0])
      }
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    loadHistory(true)
  }, [])

  // Resolved incidents that carry an approved RCA can be graded.
  const loadIncidents = async () => {
    try {
      const res = await fetch("/api/incidents?status=resolved", { cache: "no-store" })
      const data = await res.json()
      const list = (Array.isArray(data.incidents) ? data.incidents : [])
        .filter((i: any) => i?.rca?.text?.trim())
        .map((i: any) => ({
          id: i.id,
          title: i.title,
          service: i.service,
          severity: i.severity,
          failureType: i.failureType,
        })) as ResolvedIncident[]
      setIncidents(list)
      setSelectedIncidentId((prev) => prev || (list[0]?.id ?? ""))
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    loadIncidents()
  }, [])

  const runAll = async () => {
    setRunningAll(true)
    setError(null)
    try {
      const res = await fetch("/api/eval", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Eval failed")
      loadRun(data.run)
      loadHistory()
    } catch (e: any) {
      setError(e?.message || "Eval failed")
    } finally {
      setRunningAll(false)
    }
  }

  const runOne = async (caseId: string) => {
    setRunningCase(caseId)
    setError(null)
    try {
      const res = await fetch("/api/eval", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caseId }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Eval failed")
      const result = (data.run.results as CaseResult[])[0]
      if (result) setCaseResults((prev) => ({ ...prev, [caseId]: result }))
      loadHistory()
    } catch (e: any) {
      setError(e?.message || "Eval failed")
    } finally {
      setRunningCase(null)
    }
  }

  const runIncident = async () => {
    if (!selectedIncidentId) return
    setRunningIncident(true)
    setError(null)
    try {
      const res = await fetch("/api/eval", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ incidentId: selectedIncidentId }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Incident eval failed")
      // Load the fresh run as the current view (also highlights it in history and
      // renders its result), so running and viewing-from-history behave the same.
      loadRun(data.run)
      loadHistory()
    } catch (e: any) {
      setError(e?.message || "Incident eval failed")
    } finally {
      setRunningIncident(false)
    }
  }

  const anyRunning = runningAll || runningCase !== null || runningIncident
  const results = CASES.map((c) => caseResults[c.id]).filter(Boolean) as CaseResult[]
  const liveAggregate =
    results.length > 0
      ? Math.round((results.reduce((s, r) => s + r.overall, 0) / results.length) * 100) / 100
      : null

  return (
    <main className="max-w-[1600px] mx-auto px-4 lg:px-6 py-6 flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-primary/10 border border-primary/25 flex items-center justify-center">
              <Brain className="w-4 h-4 text-[var(--neon-cyan)]" />
            </div>
            <h1 className="text-lg font-mono font-bold text-foreground">AI Quality Evals</h1>
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-primary/10 border border-primary/20 text-[var(--neon-cyan)]">
              on-demand
            </span>
          </div>
          <p className="text-xs text-muted-foreground mt-1 max-w-2xl">
            Runs the golden incident set through the same prompts the product uses, then scores each
            output with deterministic checks + an LLM-as-judge (groundedness, format, remediation,
            hallucination).
          </p>
        </div>
        <button
          onClick={runAll}
          disabled={anyRunning}
          className="inline-flex items-center gap-2 text-xs font-mono font-semibold px-4 py-2 rounded-md bg-primary/10 border border-primary/25 text-[var(--neon-cyan)] hover:bg-primary/20 transition-colors disabled:opacity-50"
        >
          {runningAll ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
          {runningAll ? "Running…" : "Run all"}
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-xs font-mono text-[var(--neon-red)] bg-[var(--neon-red)]/10 border border-[var(--neon-red)]/25 rounded-md px-3 py-2">
          <AlertTriangle className="w-3.5 h-3.5" /> {error}
        </div>
      )}

      {/* Aggregate card */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="card-glass rounded-lg border border-primary/10 p-4">
          <p className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest">Aggregate score</p>
          <p className={`text-2xl font-mono font-bold mt-1 ${liveAggregate != null ? scoreColor(liveAggregate) : "text-muted-foreground"}`}>
            {liveAggregate != null ? pct(liveAggregate) : "—"}
          </p>
        </div>
        <div className="card-glass rounded-lg border border-primary/10 p-4">
          <p className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest">Cases scored</p>
          <p className="text-2xl font-mono font-bold mt-1 text-foreground">{results.length} / {CASES.length}</p>
        </div>
        <div className="card-glass rounded-lg border border-primary/10 p-4">
          <p className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest">Generator</p>
          <p className="text-xs font-mono font-bold mt-2 text-foreground truncate">
            {current?.generatorModel ?? history[0]?.generatorModel ?? "—"}
          </p>
        </div>
        <div className="card-glass rounded-lg border border-primary/10 p-4">
          <p className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest">Judge</p>
          <p className="text-xs font-mono font-bold mt-2 text-foreground truncate">
            {current?.judgeModel ?? history[0]?.judgeModel ?? "—"}
          </p>
        </div>
      </div>

      {/* Case table */}
      <section className="card-glass rounded-lg border border-primary/10 overflow-hidden">
        <div className="px-4 py-3 border-b border-border/60 bg-primary/5">
          <h2 className="text-xs font-mono font-semibold text-muted-foreground tracking-widest uppercase">
            Golden cases
          </h2>
        </div>
        <div className="divide-y divide-border/40">
          {CASES.map((c) => {
            const r = caseResults[c.id]
            const isOpen = expanded === c.id
            return (
              <div key={c.id}>
                <div className="px-4 py-3 flex items-center gap-3 flex-wrap">
                  <button
                    onClick={() => setExpanded(isOpen ? null : c.id)}
                    className="flex items-center gap-2 min-w-0 flex-1 text-left"
                  >
                    <ChevronDown className={`w-3.5 h-3.5 text-muted-foreground transition-transform ${isOpen ? "rotate-180" : ""}`} />
                    <div className="min-w-0">
                      <p className="text-xs font-mono font-bold text-foreground truncate">{c.title}</p>
                      <p className="text-[10px] font-mono text-muted-foreground">{c.id} · {c.mode}</p>
                    </div>
                  </button>

                  {r && (
                    <div className="flex items-center gap-2 flex-wrap">
                      <Pill ok={r.deterministic.rootCausePass} label="root cause" />
                      <Pill ok={r.deterministic.remediationPass} label="remediation" />
                      <Pill ok={r.deterministic.noHallucinationPass} label="no-halluc" />
                      {r.judge && <Pill ok={r.judge.hallucinationPass} label="judge-halluc" />}
                      <span className={`text-sm font-mono font-bold ${scoreColor(r.overall)} w-12 text-right`}>
                        {pct(r.overall)}
                      </span>
                    </div>
                  )}

                  <button
                    onClick={() => runOne(c.id)}
                    disabled={anyRunning}
                    className="inline-flex items-center gap-1.5 text-[10px] font-mono px-2.5 py-1 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors disabled:opacity-50"
                  >
                    {runningCase === c.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                    Run
                  </button>
                </div>

                {isOpen && r && (
                  <div className="px-4 pb-4 pt-1 flex flex-col gap-3 bg-secondary/20">
                    {r.error && (
                      <p className="text-[11px] font-mono text-[var(--neon-red)]">Error: {r.error}</p>
                    )}
                    {r.judge && (
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                        {[
                          ["Groundedness", r.judge.groundedness],
                          ["Format", r.judge.formatCompliance],
                          ["Remediation", r.judge.remediationCorrectness],
                        ].map(([label, val]) => (
                          <div key={label as string} className="rounded border border-border/50 px-2 py-1.5">
                            <p className="text-[9px] font-mono text-muted-foreground uppercase">{label}</p>
                            <p className={`text-sm font-mono font-bold ${scoreColor(val as number)}`}>{pct(val as number)}</p>
                          </div>
                        ))}
                        <div className="rounded border border-border/50 px-2 py-1.5">
                          <p className="text-[9px] font-mono text-muted-foreground uppercase">Halluc.</p>
                          <p className={`text-sm font-mono font-bold ${r.judge.hallucinationPass ? "text-[var(--neon-green)]" : "text-[var(--neon-red)]"}`}>
                            {r.judge.hallucinationPass ? "pass" : "fail"}
                          </p>
                        </div>
                      </div>
                    )}
                    {r.judge?.rationale && (
                      <p className="text-[11px] font-mono text-muted-foreground italic">Judge: {r.judge.rationale}</p>
                    )}
                    {r.deterministic.details.length > 0 && (
                      <p className="text-[11px] font-mono text-[var(--neon-orange)]">
                        Checks: {r.deterministic.details.join(" · ")}
                      </p>
                    )}
                    <details>
                      <summary className="text-[10px] font-mono text-muted-foreground cursor-pointer hover:text-foreground">
                        View model output
                      </summary>
                      <pre className="mt-2 text-[11px] font-mono text-foreground/90 whitespace-pre-wrap bg-background/60 rounded border border-border/50 p-3 max-h-80 overflow-auto">
                        {r.output}
                      </pre>
                    </details>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </section>

      {/* Incident evals — grade a real resolved incident's approved RCA */}
      <section className="card-glass rounded-lg border border-primary/10 overflow-hidden">
        <div className="px-4 py-3 border-b border-border/60 bg-primary/5">
          <h2 className="text-xs font-mono font-semibold text-muted-foreground tracking-widest uppercase">
            Incident evals
          </h2>
          <p className="text-[11px] text-muted-foreground mt-1 max-w-2xl">
            Grades the RCA a human already approved for a resolved incident — the exact document from
            the incident page — against that incident&apos;s real log snapshot. Scores groundedness,
            hallucination and format (no regeneration).
          </p>
        </div>

        <div className="px-4 py-3 flex items-center gap-2 flex-wrap border-b border-border/40">
          {incidents.length === 0 ? (
            <p className="text-[11px] font-mono text-muted-foreground">
              No resolved incidents with an approved RCA yet — resolve an incident and approve its RCA first.
            </p>
          ) : (
            <>
              <select
                value={selectedIncidentId}
                onChange={(e) => {
                  setSelectedIncidentId(e.target.value)
                  setIncidentResult(null)
                }}
                disabled={anyRunning}
                className="text-xs font-mono bg-background border border-border rounded-md px-2.5 py-1.5 text-foreground min-w-0 flex-1 max-w-md disabled:opacity-50"
              >
                {incidents.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.id} — {i.title}
                  </option>
                ))}
              </select>
              <button
                onClick={runIncident}
                disabled={anyRunning || !selectedIncidentId}
                className="inline-flex items-center gap-2 text-xs font-mono font-semibold px-4 py-2 rounded-md bg-primary/10 border border-primary/25 text-[var(--neon-cyan)] hover:bg-primary/20 transition-colors disabled:opacity-50"
              >
                {runningIncident ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                {runningIncident ? "Evaluating…" : "Eval this incident"}
              </button>
            </>
          )}
        </div>

        {incidentResult && (
          <div className="px-4 py-4 flex flex-col gap-3">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-xs font-mono font-bold text-foreground truncate flex-1 min-w-0">
                {incidentResult.title}
              </p>
              <Pill ok={incidentResult.deterministic.rootCausePass} label="root cause" />
              <Pill ok={incidentResult.deterministic.remediationPass} label="remediation" />
              <Pill ok={incidentResult.deterministic.noHallucinationPass} label="no-halluc" />
              {incidentResult.judge && <Pill ok={incidentResult.judge.hallucinationPass} label="judge-halluc" />}
              <span className={`text-sm font-mono font-bold ${scoreColor(incidentResult.overall)} w-12 text-right`}>
                {pct(incidentResult.overall)}
              </span>
            </div>

            {incidentResult.error && (
              <p className="text-[11px] font-mono text-[var(--neon-red)]">Error: {incidentResult.error}</p>
            )}

            {incidentResult.judge && (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                {[
                  ["Groundedness", incidentResult.judge.groundedness],
                  ["Format", incidentResult.judge.formatCompliance],
                  ["Remediation", incidentResult.judge.remediationCorrectness],
                ].map(([label, val]) => (
                  <div key={label as string} className="rounded border border-border/50 px-2 py-1.5">
                    <p className="text-[9px] font-mono text-muted-foreground uppercase">{label}</p>
                    <p className={`text-sm font-mono font-bold ${scoreColor(val as number)}`}>{pct(val as number)}</p>
                  </div>
                ))}
                <div className="rounded border border-border/50 px-2 py-1.5">
                  <p className="text-[9px] font-mono text-muted-foreground uppercase">Halluc.</p>
                  <p className={`text-sm font-mono font-bold ${incidentResult.judge.hallucinationPass ? "text-[var(--neon-green)]" : "text-[var(--neon-red)]"}`}>
                    {incidentResult.judge.hallucinationPass ? "pass" : "fail"}
                  </p>
                </div>
              </div>
            )}

            {incidentResult.judge?.rationale && (
              <p className="text-[11px] font-mono text-muted-foreground italic">Judge: {incidentResult.judge.rationale}</p>
            )}
            {incidentResult.deterministic.details.length > 0 && (
              <p className="text-[11px] font-mono text-[var(--neon-orange)]">
                Checks: {incidentResult.deterministic.details.join(" · ")}
              </p>
            )}

            <details>
              <summary className="text-[10px] font-mono text-muted-foreground cursor-pointer hover:text-foreground">
                View graded RCA
              </summary>
              <pre className="mt-2 text-[11px] font-mono text-foreground/90 whitespace-pre-wrap bg-background/60 rounded border border-border/50 p-3 max-h-80 overflow-auto">
                {incidentResult.output}
              </pre>
            </details>
          </div>
        )}
      </section>

      {/* Run history */}
      <section className="card-glass rounded-lg border border-primary/10 overflow-hidden">
        <div className="px-4 py-3 border-b border-border/60 bg-primary/5 flex items-center gap-2">
          <History className="w-3.5 h-3.5 text-muted-foreground" />
          <h2 className="text-xs font-mono font-semibold text-muted-foreground tracking-widest uppercase">
            Run history
          </h2>
        </div>
        {history.length === 0 ? (
          <p className="px-4 py-6 text-xs font-mono text-muted-foreground text-center">
            No runs yet — click “Run all” to record the first eval run.
          </p>
        ) : (
          <div className="divide-y divide-border/40">
            {history.map((run) => (
              <button
                key={run.id}
                onClick={() => loadRun(run)}
                className={`w-full text-left px-4 py-2.5 flex items-center gap-3 text-xs font-mono hover:bg-secondary/40 transition-colors ${
                  viewingRunId === run.id ? "bg-primary/5" : ""
                }`}
              >
                <span className={`font-bold w-12 ${scoreColor(run.aggregate)}`}>{pct(run.aggregate)}</span>
                <span className="text-muted-foreground">{new Date(run.finishedAt).toLocaleString()}</span>
                {run.kind === "incident" ? (
                  <span className="text-[9px] font-mono px-1.5 py-0.5 rounded border border-[var(--neon-cyan)]/25 bg-[var(--neon-cyan)]/10 text-[var(--neon-cyan)]">
                    incident {run.incidentId ?? ""}
                  </span>
                ) : (
                  <span className="text-[9px] font-mono px-1.5 py-0.5 rounded border border-border text-muted-foreground">
                    golden
                  </span>
                )}
                <span className="text-muted-foreground ml-auto">{run.caseCount} cases</span>
                <span className="text-foreground/70 truncate max-w-[200px]">{run.generatorModel}</span>
              </button>
            ))}
          </div>
        )}
      </section>
    </main>
  )
}
