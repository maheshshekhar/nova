import { describe, expect, it } from "vitest"
import { parsePagerDutyWebhook, parseSlackInteraction } from "@/lib/notify/interactive/parse"

describe("parseSlackInteraction", () => {
  function formBody(payload: unknown): string {
    return "payload=" + encodeURIComponent(JSON.stringify(payload))
  }

  it("extracts the action id, value, user and response_url", () => {
    const body = formBody({
      user: { id: "U123" },
      response_url: "https://hooks.slack.test/r",
      actions: [{ action_id: "approve_remediation", value: "INC-9" }],
    })
    expect(parseSlackInteraction(body)).toEqual({
      actionId: "approve_remediation",
      value: "INC-9",
      userId: "U123",
      responseUrl: "https://hooks.slack.test/r",
    })
  })

  it("returns null when there is no payload / bad JSON / no actions", () => {
    expect(parseSlackInteraction("")).toBeNull()
    expect(parseSlackInteraction("payload=not-json")).toBeNull()
    expect(parseSlackInteraction(formBody({ user: { id: "U1" }, actions: [] }))).toBeNull()
  })
})

describe("parsePagerDutyWebhook", () => {
  const wrap = (eventType: string, dedup?: string) => ({
    event: { event_type: eventType, data: dedup ? { dedup_key: dedup } : {} },
  })

  it("maps resolved and acknowledged to a status change with the incident id", () => {
    expect(parsePagerDutyWebhook(wrap("incident.resolved", "INC-1"))).toEqual({
      eventType: "incident.resolved",
      incidentId: "INC-1",
      statusChange: "resolved",
    })
    expect(parsePagerDutyWebhook(wrap("incident.acknowledged", "INC-2")).statusChange).toBe(
      "acknowledged"
    )
  })

  it("ignores unknown event types (statusChange null)", () => {
    expect(parsePagerDutyWebhook(wrap("incident.annotated", "INC-3")).statusChange).toBeNull()
  })

  it("has no incidentId when the dedup_key is absent", () => {
    expect(parsePagerDutyWebhook(wrap("incident.resolved")).incidentId).toBeUndefined()
  })
})
