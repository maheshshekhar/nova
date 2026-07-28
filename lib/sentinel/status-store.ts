import "server-only"
import type { SentinelStatus } from "./status"

// Process-local holder for the latest Sentinel heartbeat. Status is ephemeral
// liveness (not durable history), so an in-memory singleton is the right store —
// it resets on dashboard restart and is repopulated on the next heartbeat.
let latest: SentinelStatus | null = null

export function setSentinelStatus(status: SentinelStatus): void {
  latest = status
}

export function getSentinelStatus(): SentinelStatus | null {
  return latest
}
