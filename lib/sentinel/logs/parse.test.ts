import { describe, expect, it } from "vitest"
import { parseLogLine } from "@/lib/sentinel/logs/parse"

const meta = { service: "checkout", namespace: "prod", pod: "checkout-x" }

describe("parseLogLine", () => {
  it("returns null for blank lines", () => {
    expect(parseLogLine("", meta)).toBeNull()
    expect(parseLogLine("   \n", meta)).toBeNull()
  })

  it("extracts message + level from JSON structured logs", () => {
    const line = parseLogLine('{"level":"error","message":"db pool exhausted","ts":123}', meta, 5)
    expect(line).toMatchObject({ service: "checkout", namespace: "prod", pod: "checkout-x", message: "db pool exhausted", level: "error", at: 5 })
  })

  it("supports common JSON field aliases (msg/severity)", () => {
    expect(parseLogLine('{"severity":"WARN","msg":"slow query"}', meta)).toMatchObject({ message: "slow query", level: "WARN" })
  })

  it("falls back to plain text when JSON has no message field", () => {
    const line = parseLogLine('{"foo":"bar"}', meta)
    expect(line?.message).toBe('{"foo":"bar"}')
  })

  it("detects a level near the start of a plain-text line", () => {
    expect(parseLogLine("2026-07-27T10:00:00Z ERROR connection refused", meta)?.level).toBe("ERROR")
    expect(parseLogLine("[WARN] retrying", meta)?.level).toBe("WARN")
  })

  it("does not treat a level word buried deep in the message as the level", () => {
    const longPrefix = "GET /api/v1/resource/with/a/fairly/long/path returned an "
    const line = parseLogLine(`${longPrefix}error to the caller`, meta)
    expect(line?.level).toBeUndefined()
    expect(line?.message).toContain("error to the caller")
  })

  it("keeps the raw line as the message for unstructured logs", () => {
    expect(parseLogLine("plain informational line", meta)?.message).toBe("plain informational line")
  })
})
