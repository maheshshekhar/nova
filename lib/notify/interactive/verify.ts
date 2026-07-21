import { createHmac, timingSafeEqual } from "node:crypto"

// Inbound request verification for interactive integrations. Any endpoint that
// acts on an external request (a Slack button click, a PagerDuty webhook) MUST
// verify the request's signature first — otherwise anyone could forge an
// "approve remediation" or a status change. Pure (node:crypto), so it is
// exhaustively unit-testable without a live Slack/PagerDuty.

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

export interface SlackVerifyInput {
  signingSecret: string
  /** X-Slack-Request-Timestamp header (unix seconds, as a string). */
  timestamp: string
  /** The raw, unparsed request body. */
  rawBody: string
  /** X-Slack-Signature header (e.g. "v0=abc..."). */
  signature: string
  /** Injectable clock (ms) for tests. */
  nowMs?: number
  /** Max allowed clock skew in seconds (replay protection). Default 300. */
  toleranceSec?: number
}

/**
 * Verify a Slack request signature (v0 scheme): sign `v0:{ts}:{body}` with the
 * signing secret and compare, and reject requests older than the tolerance
 * window (replay protection). Constant-time comparison.
 */
export function verifySlackSignature(input: SlackVerifyInput): boolean {
  const { signingSecret, timestamp, rawBody, signature } = input
  if (!signingSecret || !timestamp || !signature) return false

  const ts = Number(timestamp)
  if (!Number.isFinite(ts)) return false
  const now = Math.floor((input.nowMs ?? Date.now()) / 1000)
  const tolerance = input.toleranceSec ?? 300
  if (Math.abs(now - ts) > tolerance) return false

  const base = `v0:${timestamp}:${rawBody}`
  const expected = "v0=" + createHmac("sha256", signingSecret).update(base).digest("hex")
  return safeEqual(expected, signature)
}

export interface PagerDutyVerifyInput {
  secret: string
  rawBody: string
  /** X-PagerDuty-Signature header (may hold multiple comma-separated "v1=" sigs). */
  signatureHeader: string
}

/**
 * Verify a PagerDuty v3 webhook signature: HMAC-SHA256 of the raw body with the
 * webhook secret, compared against any of the `v1=` signatures in the header
 * (PagerDuty may send several during secret rotation).
 */
export function verifyPagerDutySignature(input: PagerDutyVerifyInput): boolean {
  const { secret, rawBody, signatureHeader } = input
  if (!secret || !signatureHeader) return false

  const expected = "v1=" + createHmac("sha256", secret).update(rawBody).digest("hex")
  const provided = signatureHeader.split(",").map((s) => s.trim())
  return provided.some((sig) => safeEqual(expected, sig))
}
