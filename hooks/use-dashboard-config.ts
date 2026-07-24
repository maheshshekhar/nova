"use client"

import { useEffect, useState } from "react"
import type { DashboardConfigView } from "@/lib/dashboard/config-view"

// Sensible auto defaults used before the config loads (or if the fetch fails):
// everything "auto" so the dashboard falls back to capability-driven behaviour.
const DEFAULT_VIEW: DashboardConfigView = {
  infraWorkloads: [],
  serviceTable: { columns: "auto" },
  stats: { tiles: "auto" },
  thresholds: {},
}

// Module-level cache: the dashboard config is file-authoritative and effectively
// static for the life of the page, so we fetch it once and share it.
let cached: DashboardConfigView | null = null
let inflight: Promise<DashboardConfigView> | null = null

async function loadDashboardConfig(): Promise<DashboardConfigView> {
  if (cached) return cached
  if (!inflight) {
    inflight = fetch("/api/dashboard-config", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<DashboardConfigView>) : DEFAULT_VIEW))
      .then((v) => {
        cached = v
        return v
      })
      .catch(() => DEFAULT_VIEW)
      .finally(() => {
        inflight = null
      })
  }
  return inflight
}

export interface UseDashboardConfig {
  config: DashboardConfigView
  loaded: boolean
}

/** Fetch (once, cached) the secret-free dashboard presentation config. */
export function useDashboardConfig(): UseDashboardConfig {
  const [config, setConfig] = useState<DashboardConfigView>(cached ?? DEFAULT_VIEW)
  const [loaded, setLoaded] = useState<boolean>(cached !== null)

  useEffect(() => {
    if (cached) {
      setConfig(cached)
      setLoaded(true)
      return
    }
    let active = true
    loadDashboardConfig().then((v) => {
      if (!active) return
      setConfig(v)
      setLoaded(true)
    })
    return () => {
      active = false
    }
  }, [])

  return { config, loaded }
}
