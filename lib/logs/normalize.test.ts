import { describe, expect, it } from "vitest"
import {
  classifyLevel,
  extractMessage,
  finalizeEntries,
  toIsoTimestamp,
} from "@/lib/logs/normalize"

describe("classifyLevel", () => {
  it("classifies error/fatal/exception/503/failed as ERROR", () => {
    for (const m of ["an error", "FATAL boom", "NullException", "503 bad", "it failed"]) {
      expect(classifyLevel(m)).toBe("ERROR")
    }
  })
  it("classifies warn/timeout/retry/slow as WARN", () => {
    for (const m of ["a warning", "op timeout", "will retry", "slow query"]) {
      expect(classifyLevel(m)).toBe("WARN")
    }
  })
  it("classifies debug as DEBUG and everything else as INFO", () => {
    expect(classifyLevel("debug trace")).toBe("DEBUG")
    expect(classifyLevel("checkout completed")).toBe("INFO")
  })
})

describe("extractMessage", () => {
  it("pulls `message` out of a JSON line and strips trailing newlines", () => {
    expect(extractMessage('{"message":"hello\\n\\n"}')).toBe("hello")
  })
  it("falls back to `log`, then to the raw line", () => {
    expect(extractMessage('{"log":"from log"}')).toBe("from log")
    expect(extractMessage("plain text line")).toBe("plain text line")
  })
  it("returns the raw line when the JSON is malformed", () => {
    expect(extractMessage("{not json")).toBe("{not json")
  })
})

describe("toIsoTimestamp", () => {
  it("treats large numbers as ms epoch and small numbers as seconds", () => {
    expect(toIsoTimestamp(1768382040000)).toBe(new Date(1768382040000).toISOString())
    expect(toIsoTimestamp(1768382040)).toBe(new Date(1768382040000).toISOString())
  })
  it("passes through an ISO string", () => {
    const iso = "2026-01-14T09:14:00.000Z"
    expect(toIsoTimestamp(iso)).toBe(iso)
  })
})

describe("finalizeEntries", () => {
  it("truncates messages to 400 chars and sorts ascending by timestamp", () => {
    const out = finalizeEntries([
      { timestamp: "2026-01-14T09:15:00Z", message: "b".repeat(500) },
      { timestamp: "2026-01-14T09:14:00Z", message: "earlier" },
    ])
    expect(out[0].message).toBe("earlier")
    expect(out[1].message).toHaveLength(400)
  })
})
