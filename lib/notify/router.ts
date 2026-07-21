import type { NotificationsConfig, NotificationRoute } from "@/lib/config/schema"
import type { NovaEvent } from "./event"

// Pure routing: decide which channel ids receive an event. Two additive sources:
//   1. Ownership routing — the incident's service `owner` → a channel.
//   2. The FIRST matching route's channels (a route with an empty `when` is the
//      default and matches everything).
// The union is de-duplicated. Disabled config, or an event type not in `events`,
// yields no channels.

function matchesRoute(route: NotificationRoute, event: NovaEvent): boolean {
  const w = route.when
  const inc = event.incident
  if (w.event && !w.event.includes(event.type)) return false
  if (w.severity && !w.severity.includes(inc.severity)) return false
  if (w.service && !w.service.includes(inc.service)) return false
  if (w.domain && (!inc.domain || !w.domain.includes(inc.domain))) return false
  if (w.failureType && (!inc.failureType || !w.failureType.includes(inc.failureType)))
    return false
  return true
}

export function resolveChannels(event: NovaEvent, cfg: NotificationsConfig): string[] {
  if (!cfg.enabled) return []
  if (cfg.events.length && !cfg.events.includes(event.type)) return []

  const ids = new Set<string>()

  // Ownership routing (additive) — value may be a single channel id or a list.
  const owner = event.incident.owner
  if (owner && cfg.ownerRouting[owner]) {
    const mapped = cfg.ownerRouting[owner]
    for (const id of Array.isArray(mapped) ? mapped : [mapped]) ids.add(id)
  }

  // First matching route wins.
  for (const route of cfg.routes) {
    if (matchesRoute(route, event)) {
      for (const c of route.channels) ids.add(c)
      break
    }
  }

  return [...ids]
}
