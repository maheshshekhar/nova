import { useState, useEffect, useCallback, useContext } from "react"
import { MetricsLiveContext } from "@/lib/metrics-live-context"

export interface RealServiceMetric {
  name: string
  namespace?: string
  podCount: number
  readyPods: number
  crashedPods: number
  avgCpu: number
  avgMemory: number
  status: "healthy" | "degraded" | "critical"
  errorRate: number
  // Optional, richer signals only some sources report (e.g. Prometheus). Absent
  // when the source can't provide them — the dashboard renders only present fields.
  latencyP50?: number
  latencyP95?: number
  latencyP99?: number
  rps?: number
}

export interface NamespaceInfo {
  name: string
  status: string
  podCount: number
  services: string[]
}

export interface RealMetricsState {
  available: boolean
  services: RealServiceMetric[]
  namespaces: NamespaceInfo[]
  lastUpdated: number | null
}

export function useStandaloneRealMetrics(pollInterval = 3000, enabled = true) {
  const [state, setState] = useState<RealMetricsState>({
    available: false,
    services: [],
    namespaces: [],
    lastUpdated: null
  })

  const fetchMetrics = useCallback(async () => {
    try {
      const [servicesRes, namespacesRes] = await Promise.all([
        fetch("/api/metrics?endpoint=metrics/services", { cache: "no-store" }),
        fetch("/api/metrics?endpoint=metrics/namespaces", { cache: "no-store" })
      ])
      const data = await servicesRes.json()

      if (data.fallback || !data.services) {
        setState(prev => ({ ...prev, available: false }))
        return
      }

      let namespaces: NamespaceInfo[] = []
      try {
        const nsData = await namespacesRes.json()
        if (!nsData.fallback && Array.isArray(nsData.namespaces)) {
          namespaces = nsData.namespaces
        }
      } catch {
        namespaces = []
      }

      setState({
        available: true,
        services: data.services,
        namespaces,
        lastUpdated: data.lastUpdated
      })
    } catch {
      setState(prev => ({ ...prev, available: false }))
    }
  }, [])

  useEffect(() => {
    if (!enabled) return
    fetchMetrics()
    const interval = setInterval(fetchMetrics, pollInterval)
    return () => clearInterval(interval)
  }, [fetchMetrics, pollInterval, enabled])

  return state
}

// Context-aware entry point. When the dashboard is wrapped in <MetricsLiveProvider>
// (root layout), every caller shares that single poll — so the charts and the stat
// tiles read the same metrics on the same tick. Falls back to a standalone poll only
// when no provider is present (e.g. an isolated render / test).
export function useRealMetrics(pollInterval = 3000): RealMetricsState {
  const shared = useContext(MetricsLiveContext)
  // The standalone hook is always called (stable hook order) but only polls when
  // there is no shared provider to consume from.
  const standalone = useStandaloneRealMetrics(pollInterval, shared === null)
  return shared ? shared.realMetrics : standalone
}

export function useRealLogs(service?: string, pollInterval = 3000) {
  const [logs, setLogs] = useState<{
    timestamp: string
    level: string
    message: string
    pod: string
    service?: string
  }[]>([])
  const [available, setAvailable] = useState(false)

  const fetchLogs = useCallback(async () => {
    try {
      const qs = service ? `?service=${encodeURIComponent(service)}` : ""
      const res = await fetch(`/api/logs${qs}`, {
        cache: "no-store"
      })
      const data = await res.json()

      if (data.fallback || !data.logs) {
        setAvailable(false)
        return
      }

      // Show logs from the last 60 minutes. The collector retains ERROR/WARN for
      // ~30 min across restarts; a wider client window keeps real incident logs
      // visible for the whole incident + recovery instead of aging out mid-incident.
      const cutoff = Date.now() - 60 * 60 * 1000
      const recentLogs = data.logs.filter((log: any) => {
        const logTime = new Date(log.timestamp).getTime()
        return logTime > cutoff
      })

      setAvailable(true)
      setLogs(recentLogs)
    } catch {
      setAvailable(false)
    }
  }, [service])

  useEffect(() => {
    fetchLogs()
    const interval = setInterval(fetchLogs, pollInterval)
    return () => clearInterval(interval)
  }, [fetchLogs, pollInterval])

  return { logs, available }
}
