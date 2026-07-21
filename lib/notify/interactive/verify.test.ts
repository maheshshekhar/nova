import { describe, expect, it } from "vitest"
import { createHmac } from "node:crypto"
import { verifyPagerDutySignature, verifySlackSignature } from "@/lib/notify/interactive/verify"

const SLACK_SECRET = "slack-signing-secret"

function slackSig(secret: string, ts: string, body: string): string {
  return "v0=" + createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex")
}

describe("verifySlackSignature", () => {
  const body = "payload=%7B%7D"
  const ts = "1700000000"
  const nowMs = 1700000000_000

  it("accepts a correctly signed, fresh request", () => {
    expect(
      verifySlackSignature({ signingSecret: SLACK_SECRET, timestamp: ts, rawBody: body, signature: slackSig(SLACK_SECRET, ts, body), nowMs })
    ).toBe(true)
  })

  it("rejects a tampered body", () => {
    const sig = slackSig(SLACK_SECRET, ts, body)
    expect(
      verifySlackSignature({ signingSecret: SLACK_SECRET, timestamp: ts, rawBody: body + "x", signature: sig, nowMs })
    ).toBe(false)
  })

  it("rejects a wrong signing secret", () => {
    expect(
      verifySlackSignature({ signingSecret: "wrong", timestamp: ts, rawBody: body, signature: slackSig(SLACK_SECRET, ts, body), nowMs })
    ).toBe(false)
  })

  it("rejects a stale (replayed) request outside the tolerance window", () => {
    const sig = slackSig(SLACK_SECRET, ts, body)
    // 10 minutes later, default tolerance 5 min.
    expect(
      verifySlackSignature({ signingSecret: SLACK_SECRET, timestamp: ts, rawBody: body, signature: sig, nowMs: nowMs + 600_000 })
    ).toBe(false)
  })

  it("rejects missing inputs", () => {
    expect(verifySlackSignature({ signingSecret: "", timestamp: ts, rawBody: body, signature: "v0=x", nowMs })).toBe(false)
    expect(verifySlackSignature({ signingSecret: SLACK_SECRET, timestamp: "", rawBody: body, signature: "v0=x", nowMs })).toBe(false)
    expect(verifySlackSignature({ signingSecret: SLACK_SECRET, timestamp: ts, rawBody: body, signature: "", nowMs })).toBe(false)
  })
})

const PD_SECRET = "pd-webhook-secret"
function pdSig(secret: string, body: string): string {
  return "v1=" + createHmac("sha256", secret).update(body).digest("hex")
}

describe("verifyPagerDutySignature", () => {
  const body = '{"event":{"event_type":"incident.resolved"}}'

  it("accepts a correctly signed webhook", () => {
    expect(verifyPagerDutySignature({ secret: PD_SECRET, rawBody: body, signatureHeader: pdSig(PD_SECRET, body) })).toBe(true)
  })

  it("accepts when ONE of several comma-separated signatures matches (rotation)", () => {
    const header = `v1=deadbeef,${pdSig(PD_SECRET, body)}`
    expect(verifyPagerDutySignature({ secret: PD_SECRET, rawBody: body, signatureHeader: header })).toBe(true)
  })

  it("rejects a tampered body and a wrong secret", () => {
    expect(verifyPagerDutySignature({ secret: PD_SECRET, rawBody: body + "x", signatureHeader: pdSig(PD_SECRET, body) })).toBe(false)
    expect(verifyPagerDutySignature({ secret: "wrong", rawBody: body, signatureHeader: pdSig(PD_SECRET, body) })).toBe(false)
  })

  it("rejects missing inputs", () => {
    expect(verifyPagerDutySignature({ secret: "", rawBody: body, signatureHeader: "v1=x" })).toBe(false)
    expect(verifyPagerDutySignature({ secret: PD_SECRET, rawBody: body, signatureHeader: "" })).toBe(false)
  })
})
