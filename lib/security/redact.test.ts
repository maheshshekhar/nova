import { describe, expect, it } from "vitest"
import { redactSecrets } from "@/lib/security/redact"

describe("redactSecrets — scrubs high-confidence secrets", () => {
  it("redacts provider API keys", () => {
    expect(redactSecrets("key sk-abcdefghijklmnopqrstuvwxyz012345")).toBe(
      "key [REDACTED_API_KEY]"
    )
    expect(redactSecrets("sk-ant-abcdefghijklmnopqrstuvwxyz01")).toBe("[REDACTED_API_KEY]")
  })

  it("redacts GitHub tokens and AWS keys", () => {
    expect(redactSecrets("token ghp_abcdefghijklmnopqrstuvwxyz0123")).toContain(
      "[REDACTED_TOKEN]"
    )
    expect(redactSecrets("AKIAIOSFODNN7EXAMPLE creds")).toBe("[REDACTED_AWS_KEY] creds")
  })

  it("redacts Bearer tokens and JWTs", () => {
    expect(redactSecrets("Authorization: Bearer abcdefghijklmnopqrstuvwx")).toBe(
      "Authorization: Bearer [REDACTED_TOKEN]"
    )
    expect(
      redactSecrets("jwt eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4")
    ).toContain("[REDACTED_JWT]")
  })

  it("redacts key=value secrets while keeping the key name", () => {
    expect(redactSecrets("db connect password=hunter2 ok")).toBe(
      "db connect password=[REDACTED] ok"
    )
    expect(redactSecrets('api_key: "abc123def456"')).toBe('api_key: [REDACTED]')
  })

  it("redacts email addresses (PII)", () => {
    expect(redactSecrets("user alice@example.com logged in")).toBe(
      "user [REDACTED_EMAIL] logged in"
    )
  })
})

describe("redactSecrets — leaves ordinary log lines untouched", () => {
  it("does not alter typical operational lines", () => {
    for (const line of [
      "POST /api/checkout 503 Service Unavailable",
      "pool.connect() timeout after 5000ms",
      "checkout completed for order 12",
      "waitQueueSize exceeded on payment-service-7c",
    ]) {
      expect(redactSecrets(line)).toBe(line)
    }
  })
})
