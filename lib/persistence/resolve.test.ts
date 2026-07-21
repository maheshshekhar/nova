import { describe, expect, it } from "vitest"
import { resolveSeeder } from "@/lib/persistence/resolve"
import { buildSeedIncidents } from "@/lib/incident-seed"
import { PersistenceConfigSchema } from "@/lib/config/schema"

const cfg = (o: Record<string, unknown> = {}) => PersistenceConfigSchema.parse(o)

describe("resolveSeeder — demo data is config-driven, not hardcoded", () => {
  it("defaults to the bundled demo seed (behaviour-preserving)", () => {
    expect(resolveSeeder(cfg())).toBe(buildSeedIncidents)
    expect(resolveSeeder(cfg({ seed: "demo" }))).toBe(buildSeedIncidents)
  })

  it("returns an EMPTY seeder for a real deployment (persistence.seed: none)", () => {
    const seeder = resolveSeeder(cfg({ seed: "none" }))
    expect(seeder(Date.now())).toEqual([])
  })
})
