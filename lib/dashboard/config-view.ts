import type { DashboardConfig } from "@/lib/config/schema"

// A safe, read-only projection of the resolved `dashboard` config for the
// browser. The dashboard config carries no secrets, but tile defs use zod
// `.passthrough()`, so this projection emits ONLY the known fields — arbitrary
// passthrough keys are dropped before anything reaches the client. Pure +
// deterministic ⇒ fully testable.

export interface DashboardTileView {
  id: string
  label?: string
  /** "metric" = fleet aggregate of a metric key; "query" = server-executed PromQL. */
  kind: "metric" | "query"
  /** Present for metric tiles (a metric key — safe to expose). */
  metric?: string
  /** Display suffix (query tiles). */
  unit?: string
  thresholds?: { warn?: number; critical?: number }
}

export interface DashboardConfigView {
  infraWorkloads: string[]
  serviceTable: { columns: "auto" | string[] }
  stats: { tiles: "auto" | DashboardTileView[] }
  thresholds: Record<string, { warn?: number; critical?: number }>
}

export function buildDashboardConfigView(cfg: DashboardConfig): DashboardConfigView {
  return {
    infraWorkloads: [...cfg.infraWorkloads],
    serviceTable: {
      columns:
        cfg.serviceTable.columns === "auto" ? "auto" : [...cfg.serviceTable.columns],
    },
    stats: {
      tiles:
        cfg.stats.tiles === "auto"
          ? "auto"
          : cfg.stats.tiles.map((t) => ({
              id: t.id,
              label: t.label,
              // The raw PromQL (`query`) is deliberately NOT projected to the
              // browser — query tiles are executed server-side via /api/tiles,
              // referenced only by id.
              kind: t.query ? ("query" as const) : ("metric" as const),
              ...(t.metric ? { metric: t.metric } : {}),
              ...(t.unit ? { unit: t.unit } : {}),
              ...(t.thresholds
                ? { thresholds: { warn: t.thresholds.warn, critical: t.thresholds.critical } }
                : {}),
            })),
    },
    thresholds: Object.fromEntries(
      Object.entries(cfg.thresholds).map(([k, v]) => [
        k,
        { warn: v.warn, critical: v.critical },
      ])
    ),
  }
}
