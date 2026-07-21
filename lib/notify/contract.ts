import { describe, expect, it, vi } from "vitest"
import type { NotificationChannel } from "./channel"
import type { NovaEvent } from "./event"

// Shared contract every NotificationChannel adapter must pass. A channel is
// constructed from an injected `fetch`, so success/failure/throw are simulated
// without a live endpoint. The golden rule: notify() NEVER throws — a failed send
// is reported as an "error" result so the bus can carry on.

const SAMPLE_EVENT: NovaEvent = {
  type: "incident.opened",
  at: 1_700_000_000_000,
  incident: {
    id: "INC-1",
    title: "Elevated 5xx on api-gateway",
    service: "api-gateway",
    severity: "critical",
    status: "investigating",
    failureType: "OOMKilled",
  },
}

function okFetch() {
  return vi.fn(async () => ({ ok: true, status: 202 }) as Response) as unknown as typeof fetch
}
function failFetch() {
  return vi.fn(async () => ({ ok: false, status: 500 }) as Response) as unknown as typeof fetch
}
function throwFetch() {
  return vi.fn(async () => {
    throw new Error("network down")
  }) as unknown as typeof fetch
}

export function runNotificationContract(
  name: string,
  makeChannel: (fetchImpl: typeof fetch) => NotificationChannel,
  event: NovaEvent = SAMPLE_EVENT
) {
  describe(`NotificationChannel contract — ${name}`, () => {
    it("reports 'sent' on a successful send", async () => {
      const res = await makeChannel(okFetch()).notify(event)
      expect(res.status).toBe("sent")
    })

    it("reports 'error' (never throws) on a non-2xx response", async () => {
      const res = await makeChannel(failFetch()).notify(event)
      expect(res.status).toBe("error")
    })

    it("reports 'error' (never throws) when the transport throws", async () => {
      const res = await makeChannel(throwFetch()).notify(event)
      expect(res.status).toBe("error")
    })
  })
}
