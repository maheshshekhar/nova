"use client"

import { createContext, useContext, useState, useCallback, useRef, useEffect, useMemo, ReactNode } from "react"
import { useAiAnalysis, type AnalysisState } from "@/hooks/use-ai-analysis"
import { useRealLogs } from "@/hooks/use-real-metrics"
import { countCheckoutFailures } from "@/lib/log-selection"
import { PRIMARY_INCIDENT } from "@/lib/dashboard-data"

export type LivePhase = "healthy" | "degrading" | "incident"

export interface CapturedLog {
  timestamp: string
  level: string
  message: string
  pod: string
}

export interface PastIncident {
  id: string
  title: string
  service: string
  startedAt: number
  resolvedAt: number
}

interface LiveState {
  phase: LivePhase
  secondsElapsed: number
  triggerFailure: () => void
  reset: () => void
  stabilize: () => void
  // Resolved-incident tracking is held in memory (not localStorage) so it resets
  // on a full page load / fresh deploy, while persisting across in-session
  // client-side navigation (the provider stays mounted in the root layout).
  resolvedIncidents: string[]
  isResolved: (id: string) => boolean
  markResolved: (id: string) => void
  clearResolved: (id: string) => void
  // Recovery-plan UI state, held here (not in the incident page component) so it
  // survives client-side navigation — the engineer can open the plan, jump to the
  // dashboard to verify Service Health, and return with the plan still open and
  // any ticked steps intact.
  recoveryPlanOpen: boolean
  openRecoveryPlan: (stepCount: number) => void
  recoveryChecks: boolean[]
  toggleRecoveryStep: (index: number) => void
  // Snapshot of the real cluster logs captured while the incident was live, held
  // here so the incident RCA / timeline keeps showing real (current-time) data
  // across navigation instead of falling back to the fixed static timeline.
  capturedLogs: CapturedLog[]
  captureLogs: (logs: CapturedLog[]) => void
  // Epoch ms when the current incident actually began (first degrade/incident),
  // so the RCA can report a live, real duration instead of a hardcoded value.
  incidentStartedAt: number | null
  // Canonical count of failed checkout transactions (HTTP 503) for the active
  // payment incident — computed ONCE here (bounded to the incident window) and
  // frozen at resolve. Every surface (overview, AI analysis, RCA) reads THIS so
  // the number is always consistent instead of each recomputing its own.
  impactCount: number
  // Shared AI root-cause analysis — one instance so the dashboard panel and the
  // incident page always show the same result, and it persists across navigation.
  aiState: AnalysisState
  analyzeIncident: (logs: string[], context: string, opts?: { mode?: string; service?: string; sinceMs?: number; impact?: number }) => void
  resetAnalysis: () => void
  // The active incident's id. Each inject run produces a new incrementing id
  // (INC-2847, INC-2848, …); previous incidents move into pastIncidents.
  currentIncidentId: string
  pastIncidents: PastIncident[]
}

const LiveStateContext = createContext<LiveState>({
  phase: "healthy",
  secondsElapsed: 0,
  triggerFailure: () => {},
  reset: () => {},
  stabilize: () => {},
  resolvedIncidents: [],
  isResolved: () => false,
  markResolved: () => {},
  clearResolved: () => {},
  recoveryPlanOpen: false,
  openRecoveryPlan: () => {},
  recoveryChecks: [],
  toggleRecoveryStep: () => {},
  capturedLogs: [],
  captureLogs: () => {},
  incidentStartedAt: null,
  impactCount: 0,
  aiState: { status: "idle" },
  analyzeIncident: () => {},
  resetAnalysis: () => {},
  currentIncidentId: "",
  pastIncidents: []
})

// How long the "degrading" phase may last before we force the full "incident"
// view, in case the collector only ever reports "degraded" and never "critical".
const DEGRADING_FALLBACK_SECONDS = 30
// Poll cadence for the real cluster status (matches the metrics collector / hooks).
const POLL_INTERVAL_MS = 3000

// ── Store persistence (fire-and-forget) ───────────────────────────────────────
// Nova is driven entirely by client state; these calls mirror the run
// into the server-side incident store so it survives reloads / redeploys and is
// visible in the incident history and Nova AI chat.
// Create the payment incident in the store. The id is assigned by the STORE
// (nextIncidentId = max+1) rather than the client, so it can never collide with a
// config/transaction incident injected after page load. Returns the assigned id
// so the client can reconcile its currentIncidentId.
function persistCreate(startedAt: number): Promise<string | null> {
  return fetch("/api/incidents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: PRIMARY_INCIDENT.title,
      service: PRIMARY_INCIDENT.service,
      severity: PRIMARY_INCIDENT.severity,
      status: "investigating",
      failureType: "db-pool-exhaustion",
      startedAt,
      // Seed impact at 0, not the static PRIMARY_INCIDENT figure: the real count
      // is the live checkout-503 tally (liveImpact) which accumulates over the
      // incident window and is frozen at resolve. Seeding the old 1,842 made a
      // freshly-detected incident briefly show that stale number before the live
      // count ramped in.
      affectedUsers: 0,
      description:
        "Elevated 5xx errors on /api/checkout — payment-service Postgres connection pool exhausted under sustained checkout load, returning 503s until replicas were scaled and load was shed.",
    }),
  })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => d?.incident?.id ?? null)
    .catch(() => null)
}

function persistResolve(id: string, impact?: number): void {
  fetch(`/api/incidents/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resolve: true, ...(impact && impact > 0 ? { affectedUsers: impact } : {}) }),
  }).catch(() => {})
}

export function LiveStateProvider({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<LivePhase>("healthy")
  const [secondsElapsed, setSecondsElapsed] = useState(0)
  const [resolvedIncidents, setResolvedIncidents] = useState<string[]>([])
  // Recovery-plan UI state (persists across navigation while the provider stays mounted).
  const [recoveryPlanOpen, setRecoveryPlanOpen] = useState(false)
  const [recoveryChecks, setRecoveryChecks] = useState<boolean[]>([])
  // Real cluster logs captured while the incident is live (persists across navigation).
  const [capturedLogs, setCapturedLogs] = useState<CapturedLog[]>([])
  // Epoch ms when the current incident actually began (persists across navigation).
  const [incidentStartedAt, setIncidentStartedAt] = useState<number | null>(null)
  // Canonical impact count (single source of truth). Read the real payment logs
  // ONCE here and count checkout 503s within the incident window; freeze the value
  // at resolve so it stops growing. Every surface consumes `impactCount` from context.
  const { logs: paymentImpactLogs } = useRealLogs("payment-service")
  const [frozenImpact, setFrozenImpact] = useState<number | null>(null)
  const liveImpact = useMemo(
    () => countCheckoutFailures(paymentImpactLogs, { windowStart: incidentStartedAt ?? undefined }),
    [paymentImpactLogs, incidentStartedAt]
  )
  const impactCount = frozenImpact ?? liveImpact
  const liveImpactRef = useRef(0)
  useEffect(() => {
    liveImpactRef.current = liveImpact
  }, [liveImpact])
  // Shared AI analysis instance (persists across navigation via the mounted provider).
  const { state: aiState, analyze: analyzeIncident, reset: resetAnalysis } = useAiAnalysis()
  // The active payment incident's id. Empty until the payment cascade actually
  // starts (beginIncident mints INC-#### and reconciles with the store). It is a
  // SENTINEL, deliberately NOT a real "INC-2847", so a config / transaction
  // incident injected before the payment incident can't collide with this placeholder
  // — a collision would hide that incident on the overview (filtered by
  // `id !== currentIncidentId`) and make its detail page render as the payment
  // cascade (`id === currentIncidentId`).
  const [currentIncidentId, setCurrentIncidentId] = useState("")
  const [pastIncidents, setPastIncidents] = useState<PastIncident[]>([])
  const incidentNumberRef = useRef(2846)
  const currentIncidentIdRef = useRef("")
  const startedAtRef = useRef<number | null>(null)
  const tickRef = useRef<NodeJS.Timeout | null>(null)
  const elapsedRef = useRef(0)
  // Latest phase, readable inside the async poll without re-subscribing it.
  const phaseRef = useRef<LivePhase>("healthy")

  const clearTick = useCallback(() => {
    if (tickRef.current) {
      clearInterval(tickRef.current)
      tickRef.current = null
    }
  }, [])

  // The seconds counter drives the ramp visuals (charts / stats / table). It runs
  // for the whole time the system is non-healthy and resets on recovery.
  const startTick = useCallback(() => {
    if (tickRef.current) return
    tickRef.current = setInterval(() => {
      elapsedRef.current += 1
      setSecondsElapsed(elapsedRef.current)
      // Fallback escalation: if we've been degrading long enough without the
      // cluster reporting "critical", promote to the full incident view anyway.
      if (phaseRef.current === "degrading" && elapsedRef.current >= DEGRADING_FALLBACK_SECONDS) {
        phaseRef.current = "incident"
        setPhase("incident")
      }
    }, 1000)
  }, [])

  // Start a fresh incident run: archive the previous incident into history,
  // mint the next incrementing id, and reset all per-run state.
  const beginIncident = useCallback(() => {
    if (startedAtRef.current != null) {
      const prevId = currentIncidentIdRef.current
      const prevStart = startedAtRef.current
      setPastIncidents((prev) =>
        [
          {
            id: prevId,
            title: PRIMARY_INCIDENT.title,
            service: PRIMARY_INCIDENT.service,
            startedAt: prevStart,
            resolvedAt: Date.now(),
          },
          ...prev.filter((p) => p.id !== prevId),
        ].slice(0, 20)
      )
      // Persist the previous run's resolution if a new one starts before it was
      // explicitly resolved.
      persistResolve(prevId, liveImpactRef.current)
    }
    const nextNum = incidentNumberRef.current + 1
    incidentNumberRef.current = nextNum
    const newId = `INC-${nextNum}`
    currentIncidentIdRef.current = newId
    setCurrentIncidentId(newId)

    const now = Date.now()
    startedAtRef.current = now
    setIncidentStartedAt(now)
    setResolvedIncidents([])
    setFrozenImpact(null)
    setRecoveryPlanOpen(false)
    setRecoveryChecks([])
    setCapturedLogs([])
    resetAnalysis()
    elapsedRef.current = 0
    setSecondsElapsed(0)

    // Persist to the store, which assigns the authoritative id (max+1). Reconcile
    // our currentIncidentId with it so a config/transaction incident injected after
    // page load can't collide with / replace the payment incident.
    persistCreate(now).then((assignedId) => {
      if (assignedId && assignedId !== currentIncidentIdRef.current) {
        currentIncidentIdRef.current = assignedId
        setCurrentIncidentId(assignedId)
        const n = Number(assignedId.replace(/^INC-/, ""))
        if (Number.isFinite(n)) incidentNumberRef.current = n
      }
    })
  }, [resetAnalysis])

  const goDegrading = useCallback(() => {
    if (phaseRef.current !== "healthy") return
    beginIncident()
    phaseRef.current = "degrading"
    setPhase("degrading")
    startTick()
  }, [beginIncident, startTick])

  const goIncident = useCallback(() => {
    if (phaseRef.current === "incident") return
    if (phaseRef.current === "healthy") {
      // Jumped straight to critical — initialise the run first.
      beginIncident()
      startTick()
    }
    phaseRef.current = "incident"
    setPhase("incident")
  }, [beginIncident, startTick])

  const goHealthy = useCallback(() => {
    clearTick()
    elapsedRef.current = 0
    setSecondsElapsed(0)
    phaseRef.current = "healthy"
    setPhase("healthy")
    // Freeze the canonical impact count at recovery so it stops growing.
    setFrozenImpact((f) => f ?? liveImpactRef.current)
    // Keep any resolved-incident record (and its RCA document) after recovery;
    // a fresh run (goDegrading) or a full page load clears it.
  }, [clearTick])

  // Kept on the context for backwards compatibility with pages that still import
  // them; the phase is now driven entirely by the real cluster poll below.
  const triggerFailure = useCallback(() => goDegrading(), [goDegrading])
  const reset = useCallback(() => goHealthy(), [goHealthy])
  const stabilize = useCallback(() => goHealthy(), [goHealthy])

  const isResolved = useCallback((id: string) => resolvedIncidents.includes(id), [resolvedIncidents])
  const markResolved = useCallback((id: string) => {
    setResolvedIncidents((prev) => (prev.includes(id) ? prev : [...prev, id]))
    // Freeze the canonical impact count so it stops growing after resolution,
    // and mirror the resolution + frozen count into the store.
    const impact = liveImpactRef.current
    setFrozenImpact((f) => f ?? impact)
    persistResolve(id, impact)
  }, [])
  const clearResolved = useCallback((id: string) => {
    setResolvedIncidents((prev) => prev.filter((x) => x !== id))
  }, [])

  // Open the recovery plan, initialising the per-step checkboxes the first time.
  const openRecoveryPlan = useCallback((stepCount: number) => {
    setRecoveryPlanOpen(true)
    setRecoveryChecks((prev) => (prev.length === stepCount ? prev : Array(stepCount).fill(false)))
  }, [])
  const toggleRecoveryStep = useCallback((index: number) => {
    setRecoveryChecks((prev) => prev.map((c, i) => (i === index ? !c : c)))
  }, [])

  // Snapshot the latest non-empty real logs so they survive navigation.
  const captureLogs = useCallback((logs: CapturedLog[]) => {
    if (logs.length > 0) setCapturedLogs(logs)
  }, [])

  // Derive the dashboard phase from the REAL cluster state reported by the metrics
  // collector. The poller only ever ESCALATES (healthy → degrading → incident) as
  // the cluster degrades; it never auto-recovers. Recovery is a deliberate operator
  // action — completing the recovery checklist on the incident page (stabilize()).
  // So running `recover` heals the cluster but leaves the dashboard showing the
  // incident until the engineer works the recovery plan.
  useEffect(() => {
    let cancelled = false

    const poll = async () => {
      let services: { name?: string; status?: string; readyPods?: number }[] | undefined
      try {
        const res = await fetch("/api/metrics?endpoint=metrics/services", { cache: "no-store" })
        const data = await res.json()
        // Collector unreachable — leave the current phase untouched.
        if (data.fallback || !Array.isArray(data.services)) return
        services = data.services
      } catch {
        return
      }
      if (cancelled || !services) return

      const payment = services.find((s) => s.name === "payment-service")
      if (!payment) return
      const loadGen = services.find((s) => s.name === "load-generator")
      // Failure is actively being injected while a load-generator pod is running.
      const loadActive = !!loadGen && (loadGen.readyPods ?? 0) > 0

      // Only escalate while traffic is actually hitting the service. In this flow a
      // real incident is always load-induced (inject-failure runs load-generator;
      // recover deletes it). Without load, a "critical"/"degraded" reading is just
      // transient churn — e.g. a fresh deploy where payment-service pods aren't Ready
      // yet (readyPods === 0 → collector reports "critical"). Ignoring those keeps the
      // dashboard green while deploying the app live, without losing real incidents.
      if (!loadActive) return

      const status = payment.status
      if (status === "critical") {
        goIncident()
      } else if (status === "degraded") {
        goDegrading()
      } else {
        // Load still hammering the service but payment reads healthy this poll —
        // keep (at least) degrading; a momentary healthy sample never recovers us.
        goDegrading()
      }
      // Recovery only ever happens via the manual recovery checklist — the poller
      // never auto-heals the dashboard back to green.
    }

    poll()
    const interval = setInterval(poll, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [goDegrading, goIncident])

  useEffect(() => () => clearTick(), [clearTick])

  // On mount, sync the incident numbering with the persisted store so a fresh
  // page load continues the INC-#### series (max + 1) instead of always restarting
  // at INC-2847. Runs once; the live inject then mints the next number.
  useEffect(() => {
    let cancelled = false
    fetch("/api/incidents?range=all")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d?.incidents) return
        const nums = d.incidents
          .map((i: { id: string }) => Number(String(i.id).replace(/^INC-/, "")))
          .filter((n: number) => Number.isFinite(n))
        const max = nums.length ? Math.max(...nums) : incidentNumberRef.current
        if (max >= incidentNumberRef.current) incidentNumberRef.current = max
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <LiveStateContext.Provider
      value={{
        phase,
        secondsElapsed,
        triggerFailure,
        reset,
        stabilize,
        resolvedIncidents,
        isResolved,
        markResolved,
        clearResolved,
        recoveryPlanOpen,
        openRecoveryPlan,
        recoveryChecks,
        toggleRecoveryStep,
        capturedLogs,
        captureLogs,
        incidentStartedAt,
        impactCount,
        aiState,
        analyzeIncident,
        resetAnalysis,
        currentIncidentId,
        pastIncidents,
      }}
    >
      {children}
    </LiveStateContext.Provider>
  )
}

export function useLiveState() {
  return useContext(LiveStateContext)
}
