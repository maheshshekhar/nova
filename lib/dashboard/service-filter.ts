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
