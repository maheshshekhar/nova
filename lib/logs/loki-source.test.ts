import { afterEach, describe, expect, it, vi } from "vitest"
import { queryLoki } from "@/lib/logs/loki-source"
import {
  T_EARLIER_MS,
  T_LATER_MS,
  lokiEmptyResponse,
  lokiLongLineResponse,
  lokiQueryRangeResponse,
} from "@/test/fixtures/loki"

// Characterization tests: lock the CURRENT behaviour of the Loki adapter so the
// M3 refactor (LogScope → LogQL compilation) can prove it is byte-for-byte
// equivalent for the default `production` scope.

/** Install a fake `fetch` that records the URL it was called with and returns
 * the given JSON body. Returns a getter for the captured URL. */
function stubFetch(body: unknown, ok = true, statusCode = 200) {
  const calls: string[] = []
  const fn = vi.fn(async (url: string) => ({
    ok,
    status: statusCode,
    json: async () => body,
  }))
  vi.stubGlobal("fetch", fn)
  // Expose the captured URLs by wrapping.
  fn.mockImplementation(async (url: string) => {
    calls.push(String(url))
    return { ok, status: statusCode, json: async () => body } as any
  })
  return {
    url: () => calls[0],
    params: () => new URL(calls[0]).searchParams,
    query: () => new URL(calls[0]).searchParams.get("query") ?? "",
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("queryLoki — LogQL construction (buildLogQL)", () => {
  it("scopes to namespace=production and excludes load-generator when no service given", async () => {
    const cap = stubFetch(lokiEmptyResponse)
    await queryLoki({ startMs: T_EARLIER_MS, endMs: T_LATER_MS })
    expect(cap.query()).toBe(`{namespace="production", app!="load-generator"}`)
  })

  it("scopes to a single app when a service is given", async () => {
    const cap = stubFetch(lokiEmptyResponse)
    await queryLoki({ service: "payment-service", startMs: T_EARLIER_MS, endMs: T_LATER_MS })
    expect(cap.query()).toBe(`{namespace="production", app="payment-service"}`)
  })

  it("appends a case-insensitive level regex filter when levels are given", async () => {
    const cap = stubFetch(lokiEmptyResponse)
    await queryLoki({ service: "payment-service", levels: ["ERROR", "WARN"] })
    expect(cap.query()).toBe(`{namespace="production", app="payment-service"} |~ "(?i)(ERROR|WARN)"`)
  })

  it("sanitises level tokens to A–Z before building the alternation", async () => {
    const cap = stubFetch(lokiEmptyResponse)
    await queryLoki({ levels: ["error!", " warn "] })
    // punctuation/space stripped, uppercased → ERROR|WARN
    expect(cap.query()).toContain(`|~ "(?i)(ERROR|WARN)"`)
  })
})

describe("queryLoki — request parameters", () => {
  it("converts the ms window to nanoseconds (floor start, ceil end), defaults limit=5000 and direction=backward", async () => {
    const cap = stubFetch(lokiEmptyResponse)
    await queryLoki({ startMs: T_EARLIER_MS, endMs: T_LATER_MS })
    const p = cap.params()
    expect(p.get("start")).toBe(String(Math.floor(T_EARLIER_MS) * 1_000_000))
    expect(p.get("end")).toBe(String(Math.ceil(T_LATER_MS) * 1_000_000))
    expect(p.get("limit")).toBe("5000")
    expect(p.get("direction")).toBe("backward")
  })

  it("hits the default LOKI_URL query_range endpoint", async () => {
    const cap = stubFetch(lokiEmptyResponse)
    await queryLoki({ startMs: T_EARLIER_MS, endMs: T_LATER_MS })
    expect(cap.url()).toContain("/loki/api/v1/query_range?")
  })
})

describe("queryLoki — response parsing", () => {
  it("maps streams to RawLogEntry, extracts JSON `message`, classifies level, sorts ascending", async () => {
    stubFetch(lokiQueryRangeResponse)
    const out = await queryLoki({ startMs: T_EARLIER_MS, endMs: T_LATER_MS })

    expect(out).toHaveLength(2)
    // Sorted ascending by timestamp — the earlier plain line comes first even
    // though Loki returned it second (direction=backward).
    expect(out[0].timestamp).toBe(new Date(T_EARLIER_MS).toISOString())
    expect(out[1].timestamp).toBe(new Date(T_LATER_MS).toISOString())

    // JSON line: `message` extracted (trailing newline stripped), 503 ⇒ ERROR.
    expect(out[1].message).toBe("POST /api/checkout 503 Service Unavailable")
    expect(out[1].level).toBe("ERROR")
    expect(out[1].pod).toBe("payment-service-7c")
    expect(out[1].service).toBe("payment-service")

    // Plain line kept verbatim, no error/warn keywords ⇒ INFO.
    expect(out[0].message).toBe("checkout completed for order 12")
    expect(out[0].level).toBe("INFO")
  })

  it("truncates messages to 400 characters", async () => {
    stubFetch(lokiLongLineResponse)
    const out = await queryLoki({})
    expect(out[0].message).toHaveLength(400)
  })

  it("returns [] when the result set is empty", async () => {
    stubFetch(lokiEmptyResponse)
    const out = await queryLoki({})
    expect(out).toEqual([])
  })
})

describe("queryLoki — error path", () => {
  it("throws with the HTTP status when Loki responds non-OK", async () => {
    stubFetch({}, false, 503)
    await expect(queryLoki({})).rejects.toThrow("Loki query failed: 503")
  })
})
