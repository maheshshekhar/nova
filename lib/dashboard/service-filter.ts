// Shared, pure helper for separating application workloads from infrastructure
// workloads on the dashboard. Domain-agnostic: which workloads count as "infra"
// is driven entirely by config (`dashboard.infraWorkloads`), never hardcoded.

export interface WorkloadLike {
  name: string
  namespace?: string
}

/**
 * True when a workload matches any configured infra pattern. A pattern matches
 * when it is a case-insensitive substring of the workload's name or namespace.
 * With no patterns configured, nothing is infra (everything is an app service).
 */
export function isInfraWorkload(svc: WorkloadLike, infraWorkloads: string[]): boolean {
  if (!infraWorkloads.length) return false
  const name = svc.name.toLowerCase()
  const ns = (svc.namespace ?? "").toLowerCase()
  return infraWorkloads.some((raw) => {
    const p = raw.trim().toLowerCase()
    return p.length > 0 && (name.includes(p) || (ns.length > 0 && ns.includes(p)))
  })
}

/** Filter a list of workloads down to application services (infra removed). */
export function appServices<T extends WorkloadLike>(services: T[], infraWorkloads: string[]): T[] {
  return services.filter((s) => !isInfraWorkload(s, infraWorkloads))
}

// Severity ordering for the service table: worst first, so a `topN` cap keeps the
// services that matter (critical/degraded) visible on very large clusters.
const SEVERITY_RANK: Record<string, number> = { critical: 0, degraded: 1, warning: 1, healthy: 2 }

/** Stable-sort services worst-severity first (ties keep input order). */
export function rankBySeverity<T extends { status: string }>(services: T[]): T[] {
  return services
    .map((s, i) => ({ s, i }))
    .sort((a, b) => (SEVERITY_RANK[a.s.status] ?? 3) - (SEVERITY_RANK[b.s.status] ?? 3) || a.i - b.i)
    .map(({ s }) => s)
}

/** Rank worst-first and cap to `topN` (undefined/0 = no cap). */
export function capServices<T extends { status: string }>(services: T[], topN?: number): T[] {
  const ranked = rankBySeverity(services)
  return topN && topN > 0 ? ranked.slice(0, topN) : ranked
}
