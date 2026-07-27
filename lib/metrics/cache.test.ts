import { describe, expect, it, vi } from "vitest"
import { SingleFlightCache } from "@/lib/metrics/cache"

describe("SingleFlightCache", () => {
  it("coalesces concurrent callers onto a single producer (single-flight)", async () => {
    const cache = new SingleFlightCache(1000)
    let calls = 0
    const producer = () =>
      new Promise<number>((resolve) => {
        calls++
        setTimeout(() => resolve(42), 5)
      })

    const [a, b, c] = await Promise.all([
      cache.get("k", producer),
      cache.get("k", producer),
      cache.get("k", producer),
    ])
    expect([a, b, c]).toEqual([42, 42, 42])
    expect(calls).toBe(1) // one upstream call despite three concurrent asks
  })

  it("serves a cached value within the TTL, then refreshes after it expires", async () => {
    let clock = 1000
    const cache = new SingleFlightCache(1000, () => clock)
    let calls = 0
    const producer = async () => ++calls

    expect(await cache.get("k", producer)).toBe(1)
    clock = 1500 // within TTL
    expect(await cache.get("k", producer)).toBe(1)
    expect(calls).toBe(1)

    clock = 2100 // past TTL
    expect(await cache.get("k", producer)).toBe(2)
    expect(calls).toBe(2)
  })

  it("keys are independent", async () => {
    const cache = new SingleFlightCache(1000)
    expect(await cache.get("a", async () => "A")).toBe("A")
    expect(await cache.get("b", async () => "B")).toBe("B")
  })

  it("does not cache a failure — the next call retries", async () => {
    const cache = new SingleFlightCache(1000)
    const producer = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce("ok")

    await expect(cache.get("k", producer)).rejects.toThrow("boom")
    expect(await cache.get("k", producer)).toBe("ok")
    expect(producer).toHaveBeenCalledTimes(2)
  })
})
