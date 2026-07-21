import { describe, expect, it } from "vitest"
import { AdapterRegistry } from "@/lib/config/registry"

// M1 registry: the mechanism that resolves a `provider` string to a constructed
// adapter. Tested in isolation with toy adapters.

interface FakeConfig {
  provider: string
  value: number
}
interface FakeAdapter {
  name: string
  doubled: number
}

function makeRegistry() {
  return new AdapterRegistry<FakeConfig, FakeAdapter>("fake").register(
    "alpha",
    (c) => ({ name: "alpha", doubled: c.value * 2 })
  )
}

describe("AdapterRegistry", () => {
  it("constructs the adapter registered for a provider, passing the config", () => {
    const reg = makeRegistry()
    const adapter = reg.create("alpha", { provider: "alpha", value: 21 })
    expect(adapter.name).toBe("alpha")
    expect(adapter.doubled).toBe(42)
  })

  it("reports registered providers and membership", () => {
    const reg = makeRegistry()
    expect(reg.has("alpha")).toBe(true)
    expect(reg.has("beta")).toBe(false)
    expect(reg.providers()).toEqual(["alpha"])
  })

  it("throws a helpful error listing known providers on an unknown provider", () => {
    const reg = makeRegistry()
    expect(() => reg.create("beta", { provider: "beta", value: 1 })).toThrow(
      /Unknown fake provider "beta".*alpha/
    )
  })

  it("throws when the same provider is registered twice", () => {
    const reg = makeRegistry()
    expect(() => reg.register("alpha", () => ({ name: "dup", doubled: 0 }))).toThrow(
      /already registered/
    )
  })

  it("supports chained registration of multiple providers", () => {
    const reg = makeRegistry().register("gamma", (c) => ({ name: "gamma", doubled: c.value + 1 }))
    expect(reg.providers()).toContain("gamma")
    expect(reg.create("gamma", { provider: "gamma", value: 9 }).doubled).toBe(10)
  })
})
