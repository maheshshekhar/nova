import { describe, expect, it } from "vitest"
import { dispatchEvent } from "@/lib/notify/bus"
import { NotificationsConfigSchema } from "@/lib/config/schema"
import type { NotificationChannel, NotifyResult } from "@/lib/notify/channel"
import type { NovaEvent } from "@/lib/notify/event"

const cfg = (o: Record<string, unknown>) => NotificationsConfigSchema.parse(o)

function recorder(id: string) {
  const received: NovaEvent[] = []
  const channel: NotificationChannel = {
    id,
    async notify(e): Promise<NotifyResult> {
      received.push(e)
      return { status: "sent", detail: "ok" }
    },
  }
  return { channel, received }
}

const event = (over: Partial<NovaEvent["incident"]> = {}): NovaEvent => ({
  type: "incident.opened",
  at: 0,
  incident: {
    id: "INC-1",
    title: "Elevated 5xx",
    service: "api-gateway",
    severity: "critical",
    status: "investigating",
    ...over,
  },
})

describe("dispatchEvent", () => {
  it("does nothing when disabled", async () => {
    const { channel, received } = recorder("c1")
    const res = await dispatchEvent(event(), cfg({ enabled: false, routes: [{ when: {}, channels: ["c1"] }] }), {
      channels: [channel],
      dedupe: new Map(),
    })
    expect(res).toEqual([])
    expect(received).toHaveLength(0)
  })

  it("delivers to the routed channel", async () => {
    const { channel, received } = recorder("c1")
    const res = await dispatchEvent(event(), cfg({ enabled: true, routes: [{ when: {}, channels: ["c1"] }] }), {
      channels: [channel],
      dedupe: new Map(),
    })
    expect(res.map((r) => r.status)).toEqual(["sent"])
    expect(received).toHaveLength(1)
    expect(received[0].incident.id).toBe("INC-1")
  })

  it("redacts secrets from the event before delivery", async () => {
    const { channel, received } = recorder("c1")
    await dispatchEvent(
      event({ title: "boot with key sk-abcdefghijklmnopqrstuvwxyz012345" }),
      cfg({ enabled: true, routes: [{ when: {}, channels: ["c1"] }] }),
      { channels: [channel], dedupe: new Map() }
    )
    expect(received[0].incident.title).toContain("[REDACTED_API_KEY]")
    expect(received[0].incident.title).not.toContain("sk-abcdefghij")
  })

  it("suppresses a duplicate incident+type within the dedup window", async () => {
    const { channel, received } = recorder("c1")
    const c = cfg({ enabled: true, dedupeWindowSec: 300, routes: [{ when: {}, channels: ["c1"] }] })
    const dedupe = new Map<string, number>()
    const now = () => 1000
    const first = await dispatchEvent(event(), c, { channels: [channel], dedupe, now })
    const second = await dispatchEvent(event(), c, { channels: [channel], dedupe, now })
    expect(first).toHaveLength(1)
    expect(second).toEqual([]) // deduped
    expect(received).toHaveLength(1)
  })
})
