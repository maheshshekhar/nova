"use client"

import { useState, useEffect, useMemo, useRef } from "react"
import { useLiveState, type LivePhase } from "@/lib/live-state"
import { type RealMetricsState } from "@/hooks/use-real-metrics"
import { useLiveMetrics } from "@/lib/metrics-live"
import { useLiveDeployments } from "@/components/dashboard/deployment-cards"
import { services } from "@/lib/dashboard-data"
import { aggregateErrorRate } from "@/lib/metrics-series"
import { Activity, AlertOctagon, ArrowUpRight, CheckCircle2, Cpu, Gauge, Globe, Shield } from "lucide-react"

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))
const lerp = (a: number, b: number, p: number) => a + (b - a) * clamp(p, 0, 1)

const GREEN = { color: "text-[var(--neon-green)]", border: "border-[var(--neon-green)]/20", bg: "bg-[var(--neon-green)]/5" }
const ORANGE = { color: "text-[var(--neon-orange)]", border: "border-[var(--neon-orange)]/20", bg: "bg-[var(--neon-orange)]/5" }
const RED = { color: "text-[var(--neon-red)]", border: "border-[var(--neon-red)]/20", bg: "bg-[var(--neon-red)]/5" }

// App workloads deployed by deploy-app; everything else in the static services
// list is decorative. DECORATIVE_COUNT is derived (not hardcoded) so the Healthy
// Services tile rescales automatically if services / APP_SERVICES change.
const APP_SERVICES = ["payment-service", "config-service", "transaction-service"]
const DECORATIVE_COUNT = services.filter((s) => !APP_SERVICES.includes(s.name)).length

// Compact request-count formatter (e.g. 342.0K, 1.24M) for the ramping counter.
function formatRequests(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(Math.round(n))
}

function errorRateTheme(v: number) {
  return v < 1.5 ? GREEN : v < 1.65 ? ORANGE : RED
}

interface StatItem {
  label: string
  value: string
  sub: string
  up: boolean | null
  icon: typeof Globe
  color: string
  border: string
  bg: string
}

const baseStats: StatItem[] = [
  {
    label: "Total Requests",
    value: "1.24M",
    sub: "+8.4% vs yesterday",
    up: true,
    icon: Globe,
    color: "text-[var(--neon-cyan)]",
    border: "border-[var(--neon-cyan)]/20",
    bg: "bg-[var(--neon-cyan)]/5",
  },
  {
    label: "Avg Error Rate",
    value: "1.3%",
    sub: "↑ from 0.41% baseline",
    up: false,
    icon: AlertOctagon,
    color: "text-[var(--neon-red)]",
    border: "border-[var(--neon-red)]/20",
    bg: "bg-[var(--neon-red)]/5",
  },
  {
    label: "P95 Latency",
    value: "384ms",
    sub: "SLO: ≤ 500ms",
    up: true,
    icon: Gauge,
    color: "text-[var(--neon-orange)]",
    border: "border-[var(--neon-orange)]/20",
    bg: "bg-[var(--neon-orange)]/5",
  },
  {
    label: "Healthy Services",
    value: "7 / 10",
    sub: "3 need attention",
    up: false,
    icon: CheckCircle2,
    color: "text-[var(--neon-green)]",
    border: "border-[var(--neon-green)]/20",
    bg: "bg-[var(--neon-green)]/5",
  },
  {
    label: "Active Deployments",
    value: "1",
    sub: "3 completed today",
    up: true,
    icon: Activity,
    color: "text-[var(--neon-blue)]",
    border: "border-[var(--neon-blue)]/20",
    bg: "bg-[var(--neon-blue)]/5",
  },
  {
    label: "Open Incidents",
    value: "1",
    sub: "1 critical",
    up: false,
    icon: Shield,
    color: "text-[var(--neon-red)]",
    border: "border-[var(--neon-red)]/20",
    bg: "bg-[var(--neon-red)]/5",
  },
  {
    label: "CPU Utilization",
    value: "51%",
    sub: "Avg across all pods",
    up: null,
    icon: Cpu,
    color: "text-[var(--neon-cyan)]",
    border: "border-[var(--neon-cyan)]/20",
    bg: "bg-[var(--neon-cyan)]/5",
  },
  {
    label: "Apdex Score",
    value: "0.86",
    sub: "Good (≥0.85 threshold)",
    up: true,
    icon: ArrowUpRight,
    color: "text-[var(--neon-green)]",
    border: "border-[var(--neon-green)]/20",
    bg: "bg-[var(--neon-green)]/5",
  },
]

function getResolvedStats(hasResolved: boolean): StatItem[] {
  if (!hasResolved) return baseStats

  return baseStats.map((s) => {
    if (s.label === "Avg Error Rate") {
      return {
        ...s,
        value: "0.42%",
        sub: "↓ from 1.3% after recovery",
        up: true,
        color: "text-[var(--neon-green)]",
        border: "border-[var(--neon-green)]/20",
        bg: "bg-[var(--neon-green)]/5",
      }
    }
    if (s.label === "Open Incidents") {
      return {
        ...s,
        value: "0",
        sub: "No active incidents",
        up: true,
        color: "text-[var(--neon-green)]",
        border: "border-[var(--neon-green)]/20",
        bg: "bg-[var(--neon-green)]/5",
      }
    }
    if (s.label === "P95 Latency") {
      return {
        ...s,
        value: "214ms",
        sub: "SLO: ≤ 500ms ✓",
        up: true,
        color: "text-[var(--neon-green)]",
        border: "border-[var(--neon-green)]/20",
        bg: "bg-[var(--neon-green)]/5",
      }
    }
    return s
  })
}

// Apply a subtle live jitter so the top-line numbers feel like a real feed.
// Total Requests drifts slightly each tick; the Open Incidents count nudges its
// throughput sub-line without changing the (resolution-driven) integer count.
function applyLiveJitter(stats: StatItem[]): StatItem[] {
  return stats.map((s) => {
    if (s.label === "Total Requests" && s.value !== "0") {
      const value = (1.24 + (Math.random() * 0.1 - 0.05)).toFixed(2)
      return { ...s, value: `${value}M` }
    }
    // Only decorate the incident-phase Open Incidents card (value 1);
    // leave the healthy/degrading subs untouched.
    if (s.label === "Open Incidents" && s.value === "1") {
      const rps = (4.1 + (Math.random() * 0.4 - 0.2)).toFixed(1)
      return { ...s, sub: `1 critical · ${rps}k req/s` }
    }
    return s
  })
}

// HEALTHY / DEGRADING phase stats. INCIDENT phase uses getResolvedStats().
function getPhaseStats(phase: LivePhase, t: number): StatItem[] {
  return baseStats.map((s) => {
    if (phase === "healthy") {
      if (s.label === "Avg Error Rate") return { ...s, value: "0.12%", sub: "Nominal", up: true, ...GREEN }
      if (s.label === "P95 Latency") return { ...s, value: "118ms", sub: "SLO: ≤ 500ms ✓", up: true, ...GREEN }
      if (s.label === "Healthy Services") return { ...s, value: "10 / 10", sub: "All operational", up: true, ...GREEN }
      if (s.label === "Open Incidents") return { ...s, value: "0", sub: "No active incidents", up: true, ...GREEN }
      return s
    }

    // degrading — interpolate over 0..59s
    if (s.label === "Avg Error Rate") {
      const v = clamp(lerp(0.12, 1.8, t / 59), 0.12, 1.8)
      return { ...s, value: `${v.toFixed(2)}%`, sub: "↑ climbing", up: false, ...errorRateTheme(v) }
    }
    if (s.label === "P95 Latency") {
      const v = Math.round(clamp(lerp(118, 384, t / 59), 118, 384))
      return { ...s, value: `${v}ms`, sub: "SLO: ≤ 500ms", up: v < 300, ...(v < 250 ? GREEN : ORANGE) }
    }
    if (s.label === "Healthy Services") {
      const healthy = t >= 30 ? 9 : 10
      return {
        ...s,
        value: `${healthy} / 10`,
        sub: healthy === 10 ? "All operational" : "1 degrading",
        up: healthy === 10,
        ...(healthy === 10 ? GREEN : ORANGE),
      }
    }
    if (s.label === "Open Incidents") {
      const open = t >= 45 ? 1 : 0
      return {
        ...s,
        value: String(open),
        sub: open === 0 ? "No active incidents" : "1 detecting",
        up: open === 0,
        ...(open === 0 ? GREEN : ORANGE),
      }
    }
    return s
  })
}

// When the metrics collector is live, override the health-reflecting cards (error
// rate, latency, healthy services) with REAL cluster state so they track recovery
// even while the incident phase is latched (recovery is a manual checklist action).
// Latency isn't collected directly, so p95 is derived from real CPU + error rate.
//
// The collector INFERS error rate from pod crash/ready state sampled every 3s, and
// payment-service flaps in/out of CrashLoopBackOff under load — so a single poll can
// land in a lull and read a healthy baseline while the incident is still active. To
// avoid a misleading "elevated 0.15%", we hold the recent PEAK error rate / CPU
// (over `recent`) while the incident is active; on recovery we revert to the current
// value immediately.
function applyRealHealth(
  stats: StatItem[],
  realMetrics: RealMetricsState,
  recent: { err: number; cpu: number }[],
  liveErr: number | null,
  liveP95: number | null
): StatItem[] {
  if (!realMetrics.available) return stats

  // Monitored app services — any of these going unhealthy should move the tiles.
  const MONITORED = ["payment-service", "config-service", "transaction-service"]
  const svcs = MONITORED
    .map((n) => realMetrics.services.find((s) => s.name === n))
    .filter((s): s is NonNullable<typeof s> => !!s)

  // Dynamic total = decorative services + app services actually live in the
  // cluster (7/7 infra-only, 8/8, 9/9, 10/10 as deploy-app rolls them out).
  const displayedTotal = DECORATIVE_COUNT + svcs.length

  if (svcs.length === 0) {
    // Collector live but no app services deployed (infra-only, e.g. just `cluster`
    // before `deploy-app`, or after the production namespace is removed). The
    // traffic-derived tiles read the shared live series (which decays to ~0 with no
    // app traffic); CPU + Apdex still reflect the real cluster.
    const infErr = liveErr ?? 0
    const infP95 = liveP95 ?? 0
    const cpuPods = realMetrics.services.filter((s) => s.podCount > 0)
    const avgCpu = cpuPods.length
      ? Math.round(cpuPods.reduce((a, s) => a + s.avgCpu, 0) / cpuPods.length)
      : 0
    const apdex = Math.max(0, Math.min(1, 1 - infErr / 100 - Math.max(0, infP95 - 500) / 2500))
    const latTheme = infP95 <= 500 ? GREEN : infP95 <= 1000 ? ORANGE : RED
    return stats.map((s) => {
      if (s.label === "Healthy Services") {
        return { ...s, value: `${displayedTotal} / ${displayedTotal}`, sub: "All operational", up: true, ...GREEN }
      }
      if (s.label === "Avg Error Rate") {
        const elevated = infErr >= 1.65
        return { ...s, value: `${infErr.toFixed(2)}%`, sub: elevated ? "\u2191 elevated" : "No app traffic", up: !elevated, ...errorRateTheme(infErr) }
      }
      if (s.label === "P95 Latency") {
        return { ...s, value: `${infP95}ms`, sub: infP95 <= 500 ? "SLO: \u2264 500ms \u2713" : "SLO: \u2264 500ms", up: infP95 <= 500, ...latTheme }
      }
      if (s.label === "CPU Utilization") {
        return { ...s, value: `${avgCpu}%`, sub: "Avg across pods (live)", up: null, ...(avgCpu >= 85 ? RED : avgCpu >= 70 ? ORANGE : {}) }
      }
      if (s.label === "Apdex Score") {
        const good = apdex >= 0.85
        return { ...s, value: apdex.toFixed(2), sub: good ? "Good \u2265 0.85" : apdex >= 0.7 ? "Fair (live)" : "Poor (live)", up: good, ...(good ? GREEN : apdex >= 0.7 ? ORANGE : RED) }
      }
      return s
    })
  }

  const payment = realMetrics.services.find((s) => s.name === "payment-service")
  const loadGen = realMetrics.services.find((s) => s.name === "load-generator")
  const loadActive = !!loadGen && loadGen.readyPods > 0
  // The payment cascade is the scripted story: payment unhealthy or load running
  // also drags 3 decorative services down.
  const paymentCascade = (!!payment && payment.status !== "healthy") || loadActive

  const unhealthy = svcs.filter((s) => s.status !== "healthy")
  const anyIncident = unhealthy.length > 0 || loadActive

  // Error rate: worst across monitored services. For payment, use the recent peak
  // so flapping crash cycles don't read healthy in a lull.
  const paymentErr =
    payment && paymentCascade
      ? Math.max(payment.errorRate, ...recent.map((r) => r.err))
      : payment?.errorRate ?? 0
  const rawErr = Math.max(paymentErr, ...svcs.map((s) => s.errorRate), 0)
  const paymentCpu =
    payment && paymentCascade
      ? Math.max(payment.avgCpu, ...recent.map((r) => r.cpu))
      : payment?.avgCpu ?? 0
  const cpu = Math.max(paymentCpu, ...svcs.map((s) => s.avgCpu), 0)

  // Average CPU across all live pods for the CPU Utilization tile.
  const cpuPods = realMetrics.services.filter((s) => s.podCount > 0)
  const avgCpu = cpuPods.length
    ? Math.round(cpuPods.reduce((a, s) => a + s.avgCpu, 0) / cpuPods.length)
    : 0

  const fallbackP50 = 40 + Math.max(0, cpu - 30) * 3.5
  // Aggregate error across the monitored services (scales with the number of
  // concurrent incidents). Prefer the chart's smoothed value so tiles + graphs agree.
  const aggErr = aggregateErrorRate(realMetrics.services)
  // Error-weighted so a single active incident breaches the 500ms SLO even when
  // CPU stays low (pool-wait failure). Matches the LatencyChart live series.
  const fallbackP95 = Math.round(fallbackP50 * 2.6 + aggErr * 45)
  const err = liveErr ?? aggErr
  const p95 = liveP95 ?? fallbackP95

  // Apdex proxy from the live error rate + latency vs the 500ms SLO: 1.0 is perfect,
  // it degrades as errors climb and latency exceeds the SLO.
  const apdex = Math.max(0, Math.min(1, 1 - err / 100 - Math.max(0, p95 - 500) / 2500))

  // Healthy Services. The payment cascade drags 3 decorative services down;
  // config/transaction are counted individually via `unhealthy`. Total is dynamic
  // (decorative + live app services), so it reads 7/7 infra-only up to 10/10.
  const decorativeDown = paymentCascade ? 3 : 0
  const healthy = Math.max(0, displayedTotal - unhealthy.length - decorativeDown)
  // Latency vs SLO: under the 500ms SLO reads green (✓), 500–1000ms amber, worse red.
  const latencyTheme = p95 <= 500 ? GREEN : p95 <= 1000 ? ORANGE : RED

  return stats.map((s) => {
    if (s.label === "Avg Error Rate") {
      // Reflect the actual error rate, not just whether a service is flagged down —
      // a high rate reads "elevated"/red even if the incident flag has cleared.
      const elevated = err >= 1.65
      return {
        ...s,
        value: `${err.toFixed(2)}%`,
        sub: elevated ? "\u2191 elevated" : "Nominal",
        up: !elevated,
        ...errorRateTheme(err),
      }
    }
    if (s.label === "P95 Latency") {
      return {
        ...s,
        value: `${p95}ms`,
        sub: p95 <= 500 ? "SLO: \u2264 500ms \u2713" : "SLO: \u2264 500ms",
        up: p95 <= 500,
        ...latencyTheme,
      }
    }
    if (s.label === "Healthy Services") {
      return {
        ...s,
        value: `${healthy} / ${displayedTotal}`,
        sub: healthy === displayedTotal ? "All operational" : `${displayedTotal - healthy} need attention`,
        up: healthy === displayedTotal,
        ...(healthy === displayedTotal ? GREEN : ORANGE),
      }
    }
    if (s.label === "CPU Utilization") {
      return {
        ...s,
        value: `${avgCpu}%`,
        sub: "Avg across pods (live)",
        up: null,
        ...(avgCpu >= 85 ? RED : avgCpu >= 70 ? ORANGE : {}),
      }
    }
    if (s.label === "Apdex Score") {
      const good = apdex >= 0.85
      return {
        ...s,
        value: apdex.toFixed(2),
        sub: good ? "Good \u2265 0.85" : apdex >= 0.7 ? "Fair (live)" : "Poor (live)",
        up: good,
        ...(good ? GREEN : apdex >= 0.7 ? ORANGE : RED),
      }
    }
    // Surface config/transaction outages as open incidents; when the payment
    // cascade owns the story, leave its own Open Incidents value untouched.
    if (s.label === "Open Incidents" && !paymentCascade) {
      const open = unhealthy.length
      return {
        ...s,
        value: String(open),
        sub: open === 0 ? "No active incidents" : `${open} active`,
        up: open === 0,
        ...(open === 0 ? GREEN : ORANGE),
      }
    }
    return s
  })
}

export function StatsBar() {
  const { phase, secondsElapsed, isResolved, currentIncidentId } = useLiveState()
  const { realMetrics, errorSeries, latencySeries } = useLiveMetrics()
  // Latest smoothed values from the shared series, so the tiles read the exact
  // same numbers as the charts on the same tick (no more one-poll lag).
  const liveErr = errorSeries.length ? errorSeries[errorSeries.length - 1].rate : null
  const liveP95 = latencySeries.length ? Math.round(latencySeries[latencySeries.length - 1].p95) : null
  // Real deployment workloads (same collector source as the Recent Deployments panel).
  const deployments = useLiveDeployments()
  const [jitterTick, setJitterTick] = useState(0)
  const resolved = isResolved(currentIncidentId)

  // Rolling window of recent real payment-service samples (~last 12 polls ≈ 36s),
  // used to hold the incident peak so flapping lulls don't misreport the tiles.
  const [recent, setRecent] = useState<{ err: number; cpu: number }[]>([])
  const lastTsRef = useRef<number | null>(null)
  useEffect(() => {
    if (!realMetrics.available) return
    const payment = realMetrics.services.find((s) => s.name === "payment-service")
    if (!payment) return
    const ts = realMetrics.lastUpdated ?? Date.now()
    if (ts === lastTsRef.current) return
    lastTsRef.current = ts
    setRecent((prev) => [...prev.slice(-11), { err: payment.errorRate, cpu: payment.avgCpu }])
  }, [realMetrics])

  // Cumulative Total Requests counter. Ramps up from 0 as live app services serve
  // traffic (each poll adds a jittered batch), and resets when no app is deployed —
  // so the tile climbs smoothly instead of jumping straight to a static total.
  const totalReqRef = useRef(0)
  const totalReqTsRef = useRef<number | null>(null)
  const [totalRequests, setTotalRequests] = useState(0)
  useEffect(() => {
    if (!realMetrics.available) return
    const ts = realMetrics.lastUpdated ?? Date.now()
    if (ts === totalReqTsRef.current) return
    totalReqTsRef.current = ts
    const appCount = APP_SERVICES.filter((n) =>
      realMetrics.services.some((s) => s.name === n)
    ).length
    if (appCount === 0) {
      // Infra-only: no application traffic — hold the counter at zero.
      if (totalReqRef.current !== 0) {
        totalReqRef.current = 0
        setTotalRequests(0)
      }
      return
    }
    // Cumulative counter ramps from 0 as live app traffic flows, then holds just
    // under a 1M ceiling with a little jitter — so it never climbs into
    // artificial-looking millions.
    const MAX_REQ = 1_000_000
    const perService = 8000 + Math.random() * 4000
    let next: number
    if (totalReqRef.current + appCount * perService >= MAX_REQ) {
      // At/approaching the ceiling — hold just under 1M with a little jitter.
      next = MAX_REQ - Math.round(Math.random() * 40_000)
    } else {
      next = totalReqRef.current + Math.round(appCount * perService)
    }
    totalReqRef.current = next
    setTotalRequests(next)
  }, [realMetrics])

  useEffect(() => {
    const interval = setInterval(() => setJitterTick((t) => t + 1), 5000)
    return () => clearInterval(interval)
  }, [])

  const stats = useMemo(() => {
    const base = phase === "incident" ? getResolvedStats(resolved) : getPhaseStats(phase, secondsElapsed)
    const computed = applyLiveJitter(applyRealHealth(base, realMetrics, recent, liveErr, liveP95))
    const appCount = realMetrics.available
      ? APP_SERVICES.filter((n) => realMetrics.services.some((s) => s.name === n)).length
      : 0
    // Active Deployments from the real collector deployment list (same source as
    // the Recent Deployments panel): total workloads + rollout health.
    const runningDeploys = deployments.filter((d) => d.status === "running").length
    const failedDeploys = deployments.filter((d) => d.status === "failed").length
    const totalDeploys = deployments.length
    return computed.map((s) => {
      // Total Requests: ramping cumulative counter when the collector is live (0
      // with no app traffic); offline keeps the jittered demo value.
      if (s.label === "Total Requests" && realMetrics.available) {
        return {
          ...s,
          value: appCount === 0 ? "0" : formatRequests(totalRequests),
          sub: appCount === 0 ? "No app traffic" : "cumulative · live",
          up: appCount > 0 ? true : null,
        }
      }
      // Active Deployments: real count of deployment workloads + rollout status.
      if (s.label === "Active Deployments" && totalDeploys > 0) {
        return {
          ...s,
          value: String(totalDeploys),
          sub:
            runningDeploys > 0
              ? `${runningDeploys} rolling out`
              : failedDeploys > 0
              ? `${failedDeploys} failed`
              : "all healthy",
          up: failedDeploys === 0,
        }
      }
      return s
    })
    // jitterTick is an intentional recompute trigger
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, secondsElapsed, jitterTick, resolved, realMetrics, liveErr, liveP95, totalRequests, deployments])

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-8 gap-3">
      {stats.map((s) => {
        const Icon = s.icon
        return (
          <div key={s.label} className={`card-glass rounded-lg p-3 flex flex-col gap-2 hover:border-border/60 transition-all`}>
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider leading-tight">{s.label}</span>
              <Icon className={`w-3.5 h-3.5 ${s.color} shrink-0`} />
            </div>
            <span suppressHydrationWarning className={`text-xl font-mono font-bold ${s.color}`}>{s.value}</span>
            <span
              suppressHydrationWarning
              className={`text-[9px] font-mono ${
                s.up === null
                  ? "text-muted-foreground"
                  : s.up
                  ? "text-[var(--neon-green)]/80"
                  : "text-[var(--neon-red)]/80"
              }`}
            >
              {s.sub}
            </span>
          </div>
        )
      })}
    </div>
  )
}
