import "server-only"
import { getConfig } from "@/lib/config/loader"
import { getDomain } from "@/lib/domain/loader"
import { matchStoredRunbook } from "@/lib/runbook-store"
import { redactSecrets } from "@/lib/security/redact"
import type { NotificationsConfig } from "@/lib/config/schema"
import type { IncidentRecord } from "@/lib/incident-types"
import type { NovaEvent, NovaEventType } from "./event"
import type { NotificationChannel, NotifyResult } from "./channel"
import { resolveChannels } from "./router"
import { buildChannels } from "./registry"

// The event bus: fan an incident lifecycle event out to the routed channels,
// fire-and-forget. The incident flow never awaits, never fails, on notification.

function redactEvent(event: NovaEvent): NovaEvent {
  return {
    ...event,
    incident: { ...event.incident, title: redactSecrets(event.incident.title) },
    summary: event.summary ? redactSecrets(event.summary) : undefined,
  }
}

// Per-process dedup store (incident+type → last-sent ms).
const moduleDedupe = new Map<string, number>()

export function resetNotifyDedupe(): void {
  moduleDedupe.clear()
}

export interface DispatchDeps {
  channels: NotificationChannel[]
  now?: () => number
  dedupe?: Map<string, number>
}

/**
 * Pure-ish core: redact → route → dedup → notify the selected channels. Returns
 * the per-channel results. Testable by passing a config + fake channels.
 */
export async function dispatchEvent(
  event: NovaEvent,
  cfg: NotificationsConfig,
  deps: DispatchDeps
): Promise<NotifyResult[]> {
  if (!cfg.enabled) return []
  const redacted = redactEvent(event)
  const ids = resolveChannels(redacted, cfg)
  if (!ids.length) return []

  if (cfg.dedupeWindowSec > 0) {
    const now = (deps.now ?? Date.now)()
    const dedupe = deps.dedupe ?? moduleDedupe
    const key = `${redacted.incident.id}:${redacted.type}`
    const prev = dedupe.get(key)
    if (prev !== undefined && now - prev < cfg.dedupeWindowSec * 1000) return []
    dedupe.set(key, now)
  }

  const byId = new Map(deps.channels.map((c) => [c.id, c]))
  return Promise.all(
    ids.map((id) => byId.get(id)?.notify(redacted) ?? Promise.resolve({ status: "skipped" as const, detail: `unknown channel ${id}` }))
  )
}

/** Fire-and-forget: never blocks or throws into the caller. */
export function emitEvent(event: NovaEvent): void {
  const cfg = getConfig().notifications
  if (!cfg.enabled) return
  const { channels } = buildChannels(cfg)
  void dispatchEvent(event, cfg, { channels }).catch(() => {})
}

/** Build + emit a NovaEvent from an incident record (owner from the domain
 * catalog, deep link from NOVA_BASE_URL). No-op when notifications are disabled,
 * so the (potentially costly) domain/runbook lookups are skipped entirely. */
export function emitIncidentEvent(type: NovaEventType, record: IncidentRecord): void {
  if (!getConfig().notifications.enabled) return
  const domain = getDomain()
  const owner = domain.services.find((s) => s.name === record.service)?.owner
  const base = process.env.NOVA_BASE_URL

  // For an active incident, surface a matched actionable runbook so interactive
  // channels can offer "Approve & Run".
  let runbook: { id: string; title: string } | undefined
  if (type !== "incident.resolved") {
    const rb = matchStoredRunbook(record.failureType, record.service)
    if (rb?.action) runbook = { id: rb.id, title: rb.title }
  }

  emitEvent({
    type,
    at: Date.now(),
    incident: {
      id: record.id,
      title: record.title,
      service: record.service,
      severity: record.severity,
      status: record.status,
      failureType: record.failureType,
      domain: domain.id,
      owner,
      url: base ? `${base.replace(/\/$/, "")}/incidents/${record.id}` : undefined,
    },
    summary: record.rca?.text ? summarize(record.rca.text) : undefined,
    runbook,
  })
}

function summarize(text: string): string {
  const firstPara = text
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .find(Boolean)
  return (firstPara ?? "").slice(0, 400)
}
