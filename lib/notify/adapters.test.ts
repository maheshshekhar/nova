import { describe, expect, it, vi } from "vitest"
import { makeWebhookChannel } from "@/lib/notify/adapters/webhook"
import { makeSlackChannel, formatSlackText, buildSlackApprovalBlocks, APPROVE_REMEDIATION_ACTION } from "@/lib/notify/adapters/slack"
import { makePagerDutyChannel, buildPagerDutyPayload } from "@/lib/notify/adapters/pagerduty"
import { makeMsTeamsChannel, buildTeamsCard } from "@/lib/notify/adapters/msteams"
import { makeEmailChannel, formatEmail, type EmailTransport } from "@/lib/notify/adapters/email"
import { runNotificationContract } from "@/lib/notify/contract"
import type { NovaEvent } from "@/lib/notify/event"

// Every fetch-based adapter must pass the shared contract.
runNotificationContract("webhook", (f) => makeWebhookChannel("w", "https://hooks.test/x", f))
runNotificationContract("slack", (f) => makeSlackChannel("s", "https://hooks.slack.test/x", f))
runNotificationContract("pagerduty", (f) => makePagerDutyChannel("p", "routing-key", f))
runNotificationContract("msteams", (f) => makeMsTeamsChannel("t", "https://teams.test/x", f))

const OPENED: NovaEvent = {
  type: "incident.opened",
  at: 0,
  incident: {
    id: "INC-9",
    title: "Elevated 5xx on api-gateway",
    service: "api-gateway",
    severity: "critical",
    status: "investigating",
    failureType: "OOMKilled",
    owner: "platform-team",
    url: "https://nova.example/incidents/INC-9",
  },
  summary: "Pods OOMKilled under load.",
}

function capture(status = 202) {
  const calls: Array<{ url: string; body: any }> = []
  const fn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) })
    return { ok: true, status } as Response
  })
  return { fn: fn as unknown as typeof fetch, calls }
}

describe("webhook adapter", () => {
  it("POSTs the NovaEvent as JSON", async () => {
    const { fn, calls } = capture()
    await makeWebhookChannel("w", "https://hooks.test/x", fn).notify(OPENED)
    expect(calls[0].url).toBe("https://hooks.test/x")
    expect(calls[0].body.incident.id).toBe("INC-9")
  })
})

describe("slack adapter", () => {
  it("formats a message with severity emoji, id, service, title and link", () => {
    const text = formatSlackText(OPENED)
    expect(text).toContain("INC-9")
    expect(text).toContain("critical")
    expect(text).toContain("api-gateway")
    expect(text).toContain("Elevated 5xx on api-gateway")
    expect(text).toContain("🔴")
    expect(text).toContain("<https://nova.example/incidents/INC-9|open>")
  })

  it("POSTs { text } to the webhook", async () => {
    const { fn, calls } = capture(200)
    await makeSlackChannel("s", "https://hooks.slack.test/x", fn).notify(OPENED)
    expect(typeof calls[0].body.text).toBe("string")
    expect(calls[0].body.text).toContain("INC-9")
  })

  it("builds an approval block with an Approve & Run button carrying the incident id", () => {
    const blocks: any[] = buildSlackApprovalBlocks(OPENED, "Scale pool")
    const actions = blocks.find((b) => b.type === "actions")
    const button = actions.elements[0]
    expect(button.action_id).toBe(APPROVE_REMEDIATION_ACTION)
    expect(button.value).toBe("INC-9")
    expect(button.text.text).toContain("Scale pool")
  })

  it("sends interactive blocks when the event carries a matched runbook", async () => {
    const { fn, calls } = capture(200)
    await makeSlackChannel("s", "https://hooks.slack.test/x", fn).notify({
      ...OPENED,
      runbook: { id: "DB-POOL-SCALE", title: "Scale pool" },
    })
    expect(Array.isArray(calls[0].body.blocks)).toBe(true)
    const actions = calls[0].body.blocks.find((b: any) => b.type === "actions")
    expect(actions.elements[0].value).toBe("INC-9")
  })
})

describe("pagerduty adapter", () => {
  it("builds a trigger payload with a dedup_key and mapped severity", () => {
    const p: any = buildPagerDutyPayload("rk", OPENED)
    expect(p.event_action).toBe("trigger")
    expect(p.dedup_key).toBe("INC-9")
    expect(p.payload.severity).toBe("critical")
    expect(p.payload.source).toBe("api-gateway")
  })

  it("builds a resolve payload (no body) for incident.resolved with the same dedup_key", () => {
    const p: any = buildPagerDutyPayload("rk", { ...OPENED, type: "incident.resolved" })
    expect(p.event_action).toBe("resolve")
    expect(p.dedup_key).toBe("INC-9")
    expect(p.payload).toBeUndefined()
  })

  it("maps Nova severity to PagerDuty severity", () => {
    const high: any = buildPagerDutyPayload("rk", { ...OPENED, incident: { ...OPENED.incident, severity: "high" } })
    expect(high.payload.severity).toBe("error")
    const low: any = buildPagerDutyPayload("rk", { ...OPENED, incident: { ...OPENED.incident, severity: "low" } })
    expect(low.payload.severity).toBe("info")
  })
})

describe("msteams adapter", () => {
  it("builds a MessageCard with severity theme colour, facts and a link action", () => {
    const card: any = buildTeamsCard(OPENED)
    expect(card["@type"]).toBe("MessageCard")
    expect(card.themeColor).toBe("D7263D") // critical
    expect(card.sections[0].facts).toContainEqual({ name: "Incident", value: "INC-9" })
    expect(card.potentialAction[0].targets[0].uri).toBe("https://nova.example/incidents/INC-9")
  })

  it("POSTs the card to the webhook", async () => {
    const { fn, calls } = capture(200)
    await makeMsTeamsChannel("t", "https://teams.test/x", fn).notify(OPENED)
    expect(calls[0].body["@type"]).toBe("MessageCard")
  })
})

describe("email adapter", () => {
  function fakeTransport() {
    const sent: any[] = []
    const transport: EmailTransport = { async sendMail(msg) { sent.push(msg); return { ok: true } } }
    return { transport, sent }
  }

  it("formats a subject + plain-text body from the event", () => {
    const { subject, text } = formatEmail(OPENED)
    expect(subject).toContain("INC-9")
    expect(subject).toContain("CRITICAL")
    expect(text).toContain("Service:  api-gateway")
    expect(text).toContain("Pods OOMKilled under load.")
  })

  it("sends via the injected transport and reports 'sent'", async () => {
    const { transport, sent } = fakeTransport()
    const res = await makeEmailChannel("e", transport, { from: "nova@x", to: ["a@x", "b@x"] }).notify(OPENED)
    expect(res.status).toBe("sent")
    expect(sent[0]).toMatchObject({ from: "nova@x", to: ["a@x", "b@x"] })
    expect(sent[0].subject).toContain("INC-9")
  })

  it("reports 'error' (never throws) when the transport fails", async () => {
    const transport: EmailTransport = { async sendMail() { throw new Error("smtp down") } }
    const res = await makeEmailChannel("e", transport, { from: "n@x", to: ["a@x"] }).notify(OPENED)
    expect(res.status).toBe("error")
    expect(res.detail).toContain("smtp down")
  })
})
