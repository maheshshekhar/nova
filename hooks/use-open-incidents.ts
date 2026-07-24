"use client"

import { useEffect, useState } from "react"
import type { IncidentRecord } from "@/lib/incident-types"

export interface OpenIncidentsState {
  available: boolean
  open: number
  critical: number
}

// Polls the real incident store (/api/incidents) and reports how many incidents
// are currently open (not resolved) and how many of those are critical. Purely
// source-driven — no fabricated incidents.
export function useOpenIncidents(pollInterval = 5000): OpenIncidentsState {
  const [state, setState] = useState<OpenIncidentsState>({
    available: false,
    open: 0,
    critical: 0,
  })

  useEffect(() => {
    let cancelled = false
    const load = () =>
      fetch("/api/incidents", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (cancelled || !d || !Array.isArray(d.incidents)) return
          const openIncidents = (d.incidents as IncidentRecord[]).filter(
            (i) => i.status !== "resolved"
          )
          setState({
            available: true,
            open: openIncidents.length,
            critical: openIncidents.filter((i) => i.severity === "critical").length,
          })
        })
        .catch(() => {
          if (!cancelled) setState((s) => ({ ...s, available: false }))
        })
    load()
    const t = setInterval(load, pollInterval)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [pollInterval])

  return state
}
