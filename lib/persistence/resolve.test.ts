import { describe, expect, it } from "vitest"
import { resolveSeeder } from "@/lib/persistence/resolve"
import { PersistenceConfigSchema } from "@/lib/config/schema"

const cfg = (o: Record<string, unknown> = {}) => PersistenceConfigSchema.parse(o)

describe("resolveSeeder — no bundled demo data (de-static)", () => {
  it("defaults to an EMPTY seeder (store driven purely by live incidents)", () => {
    expect(resolveSeeder(cfg())(Date.now())).toEqual([])
  })

  it("returns an EMPTY seeder for every seed value (demo content removed)", () => {
    expect(resolveSeeder(cfg({ seed: "none" }))(Date.now())).toEqual([])
    expect(resolveSeeder(cfg({ seed: "demo" }))(Date.now())).toEqual([])
  })
})
