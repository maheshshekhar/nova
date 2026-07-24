import { describe, it, expect } from "vitest"
import { NovaConfigSchema } from "@/lib/config/schema"
import { buildDashboardConfigView } from "./config-view"

describe("buildDashboardConfigView", () => {
  it("projects the auto defaults from an empty config", () => {
    const view = buildDashboardConfigView(NovaConfigSchema.parse({}).dashboard)
    expect(view).toEqual({
      infraWorkloads: [],
      serviceTable: { columns: "auto" },
      stats: { tiles: "auto" },
      thresholds: {},
    })
  })

  it("projects a curated config", () => {
    const cfg = NovaConfigSchema.parse({
      dashboard: {
        infraWorkloads: ["ingress-nginx"],
        serviceTable: { columns: ["status", "avgCpu"] },
        stats: { tiles: [{ id: "cpu", label: "CPU", metric: "avgCpu" }] },
        thresholds: { errorRate: { warn: 2, critical: 8 } },
      },
    }).dashboard
    const view = buildDashboardConfigView(cfg)
    expect(view.infraWorkloads).toEqual(["ingress-nginx"])
    expect(view.serviceTable.columns).toEqual(["status", "avgCpu"])
    expect(view.stats.tiles).toEqual([{ id: "cpu", label: "CPU", kind: "metric", metric: "avgCpu" }])
    expect(view.thresholds.errorRate).toEqual({ warn: 2, critical: 8 })
  })

  it("projects a query tile WITHOUT leaking the raw PromQL to the browser", () => {
    const cfg = NovaConfigSchema.parse({
      dashboard: {
        stats: {
          tiles: [
            { id: "saturation", label: "DB pool", query: "max(db_pool_in_use)", unit: "%", thresholds: { warn: 70, critical: 90 } },
          ],
        },
      },
    }).dashboard
    const view = buildDashboardConfigView(cfg)
    const tiles = view.stats.tiles
    expect(Array.isArray(tiles)).toBe(true)
    if (Array.isArray(tiles)) {
      expect(tiles[0]).toEqual({
        id: "saturation",
        label: "DB pool",
        kind: "query",
        unit: "%",
        thresholds: { warn: 70, critical: 90 },
      })
      // The PromQL must never reach the client.
      expect(JSON.stringify(view)).not.toContain("db_pool_in_use")
    }
  })

  it("drops arbitrary passthrough keys on tiles (no leakage to the client)", () => {
    const cfg = NovaConfigSchema.parse({
      dashboard: {
        stats: {
          tiles: [
            { id: "cpu", metric: "avgCpu", secretUrl: "http://internal:9000", extra: "x" },
          ],
        },
      },
    }).dashboard
    const view = buildDashboardConfigView(cfg)
    const tiles = view.stats.tiles
    expect(Array.isArray(tiles)).toBe(true)
    if (Array.isArray(tiles)) {
      expect(tiles[0]).toEqual({ id: "cpu", label: undefined, kind: "metric", metric: "avgCpu" })
      expect(JSON.stringify(view)).not.toContain("internal:9000")
      expect(JSON.stringify(view)).not.toContain("secretUrl")
    }
  })
})
