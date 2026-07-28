import { describe, expect, it } from "vitest"
import { statusView, STALE_SEC, type SentinelStatus } from "@/lib/sentinel/status"

const base: SentinelStatus = { dryRun: false, scope: "otel-demo", logs: true, updatedAt: 0 }

describe("statusView", () => {
  it("returns null when there is no status", () => {
    expect(statusView(null, 1000)).toBeNull()
  })

  it("marks a recent heartbeat active", () => {
    const v = statusView({ ...base, updatedAt: 1_000_000 }, 1_000_000 + 10_000)
    expect(v).toMatchObject({ active: true, stale: false, ageSec: 10 })
  })

  it("marks an old heartbeat stale", () => {
    const v = statusView({ ...base, updatedAt: 0 }, (STALE_SEC + 5) * 1000)
    expect(v).toMatchObject({ active: false, stale: true })
    expect(v!.ageSec).toBe(STALE_SEC + 5)
  })

  it("carries mode + scope through", () => {
    const v = statusView({ dryRun: true, scope: "all", logs: false, updatedAt: 500 }, 500)
    expect(v).toMatchObject({ dryRun: true, scope: "all", logs: false, ageSec: 0 })
  })
})
