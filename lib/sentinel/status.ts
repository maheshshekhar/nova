// Nova Sentinel liveness/status — the companion posts a heartbeat here so the
// dashboard can show whether detection is running, in which mode (live vs
// dry-run), and over what scope. Pure view logic (staleness) is unit-tested.

export interface SentinelStatus {
  /** True when the Sentinel is in dry-run (detecting but not opening incidents). */
  dryRun: boolean
  /** Watched namespaces joined by comma, or "all". */
  scope: string
  /** Whether log tailing is enabled. */
  logs: boolean
  /** When this heartbeat was received (ms epoch). */
  updatedAt: number
}

export interface SentinelStatusView extends SentinelStatus {
  ageSec: number
  /** No heartbeat within STALE_SEC — the companion is likely down. */
  stale: boolean
  /** Received a heartbeat recently. */
  active: boolean
}

/** A heartbeat older than this is considered stale (companion posts every ~30s). */
export const STALE_SEC = 90

export function statusView(status: SentinelStatus | null, now: number): SentinelStatusView | null {
  if (!status) return null
  const ageSec = Math.max(0, Math.round((now - status.updatedAt) / 1000))
  const stale = ageSec > STALE_SEC
  return { ...status, ageSec, stale, active: !stale }
}
