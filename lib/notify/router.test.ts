import { describe, expect, it } from "vitest"
import { resolveChannels } from "@/lib/notify/router"
import { NotificationsConfigSchema } from "@/lib/config/schema"
import type { NovaEvent } from "@/lib/notify/event"

const cfg = (o: Record<string, unknown>) => NotificationsConfigSchema.parse(o)

const event = (over: Partial<NovaEvent["incident"]> = {}, type: NovaEvent["type"] = "incident.opened"): NovaEvent => ({
  type,
  at: 0,
  incident: {
    id: "INC-1",
    title: "t",
    service: "payment-service",
    severity: "critical",
    status: "investigating",
    failureType: "db-pool-exhaustion",
    domain: "payments",
    ...over,
  },
})

describe("resolveChannels", () => {
  it("returns nothing when notifications are disabled", () => {
    expect(resolveChannels(event(), cfg({ enabled: false, routes: [{ when: {}, channels: ["c"] }] }))).toEqual([])
  })

  it("returns nothing when the event type is not subscribed", () => {
    const c = cfg({ enabled: true, events: ["incident.resolved"], routes: [{ when: {}, channels: ["c"] }] })
    expect(resolveChannels(event(), c)).toEqual([])
  })

  it("routes to the default (empty-when) route's channels", () => {
    const c = cfg({ enabled: true, routes: [{ when: {}, channels: ["slack"] }] })
    expect(resolveChannels(event(), c)).toEqual(["slack"])
  })

  it("filters by severity", () => {
    const c = cfg({
      enabled: true,
      routes: [
        { when: { severity: ["critical"] }, channels: ["pd"] },
        { when: {}, channels: ["slack"] },
      ],
    })
    expect(resolveChannels(event({ severity: "critical" }), c)).toEqual(["pd"])
    expect(resolveChannels(event({ severity: "low" }), c)).toEqual(["slack"])
  })

  it("filters by service, domain and failureType (all must match)", () => {
    const c = cfg({
      enabled: true,
      routes: [{ when: { service: ["payment-service"], domain: ["payments"] }, channels: ["pay"] }],
    })
    expect(resolveChannels(event(), c)).toEqual(["pay"])
    expect(resolveChannels(event({ service: "cart" }), c)).toEqual([])
  })

  it("uses the FIRST matching route only", () => {
    const c = cfg({
      enabled: true,
      routes: [
        { when: { severity: ["critical"] }, channels: ["first"] },
        { when: {}, channels: ["second"] },
      ],
    })
    expect(resolveChannels(event(), c)).toEqual(["first"])
  })

  it("adds an owner-routed channel on top of route channels (deduped)", () => {
    const c = cfg({
      enabled: true,
      ownerRouting: { "payments-team": "pd-payments" },
      routes: [{ when: {}, channels: ["slack"] }],
    })
    const out = resolveChannels(event({ owner: "payments-team" }), c)
    expect(out).toContain("pd-payments")
    expect(out).toContain("slack")
  })

  it("supports multiple channels for one owner", () => {
    const c = cfg({
      enabled: true,
      ownerRouting: { "payments-team": ["pd-payments", "email-oncall"] },
      routes: [],
    })
    const out = resolveChannels(event({ owner: "payments-team" }), c)
    expect(out).toEqual(expect.arrayContaining(["pd-payments", "email-oncall"]))
  })
})
