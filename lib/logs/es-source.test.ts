import { afterEach, describe, expect, it, vi } from "vitest"
import { compileScopeToEs } from "@/lib/logs/es-query"
import { ElasticsearchLogSource } from "@/lib/logs/es-source"
import { DEFAULT_CONFIG } from "@/lib/config/defaults"
import type { LogScope } from "@/lib/config/schema"

const FIELDS = DEFAULT_CONFIG.logs.fields
const WINDOW = { startMs: 1000, endMs: 2000, limit: 50 }

describe("compileScopeToEs — scope translation", () => {
  it("compiles the default scope into filter (term) + must_not + range", () => {
    expect(compileScopeToEs(DEFAULT_CONFIG.logs.scope, FIELDS, WINDOW)).toEqual({
      size: 50,
      sort: [{ timestamp: "desc" }],
      query: {
        bool: {
          filter: [
            { term: { namespace: "production" } },
            { range: { timestamp: { gte: 1000, lte: 2000, format: "epoch_millis" } } },
          ],
          must_not: [{ term: { app: "load-generator" } }],
        },
      },
    })
  })

  it("adds a service term and keeps the exclude as must_not", () => {
    const body = compileScopeToEs(DEFAULT_CONFIG.logs.scope, FIELDS, {
      ...WINDOW,
      service: "payment-service",
    })
    const filter = (body.query as any).bool.filter
    expect(filter).toContainEqual({ term: { app: "payment-service" } })
    expect((body.query as any).bool.must_not).toEqual([{ term: { app: "load-generator" } }])
  })

  it("uses a terms clause for an array value", () => {
    const scope: LogScope = { include: [{ namespace: ["payments", "checkout"] }] }
    const body = compileScopeToEs(scope, FIELDS, WINDOW)
    expect((body.query as any).bool.filter).toContainEqual({
      terms: { namespace: ["payments", "checkout"] },
    })
  })

  it("uses a regexp clause for a {regex} matcher", () => {
    const scope: LogScope = { include: [{ namespace: { regex: "team-.+" } }] }
    const body = compileScopeToEs(scope, FIELDS, WINDOW)
    expect((body.query as any).bool.filter).toContainEqual({ regexp: { namespace: "team-.+" } })
  })

  it("OR-s multiple include groups via should + minimum_should_match", () => {
    const scope: LogScope = { include: [{ namespace: "a" }, { namespace: "b" }] }
    const body = compileScopeToEs(scope, FIELDS, WINDOW)
    expect((body.query as any).bool.filter[0]).toEqual({
      bool: {
        should: [
          { bool: { filter: [{ term: { namespace: "a" } }] } },
          { bool: { filter: [{ term: { namespace: "b" } }] } },
        ],
        minimum_should_match: 1,
      },
    })
  })

  it("adds a level terms filter (uppercased)", () => {
    const body = compileScopeToEs(DEFAULT_CONFIG.logs.scope, FIELDS, {
      ...WINDOW,
      levels: ["error", "warn"],
    })
    expect((body.query as any).bool.filter).toContainEqual({ terms: { level: ["ERROR", "WARN"] } })
  })
})

function stubFetch(body: unknown, ok = true, status = 200) {
  const calls: Array<{ url: string; body: any }> = []
  const fn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) })
    return { ok, status, json: async () => body } as unknown as Response
  })
  return { fn: fn as unknown as typeof fetch, calls }
}

describe("ElasticsearchLogSource — query + parsing", () => {
  afterEach(() => vi.restoreAllMocks())

  const hits = {
    hits: {
      hits: [
        { _source: { timestamp: 1768382100000, message: "checkout ok", app: "payment-service" } },
        {
          _source: {
            timestamp: 1768382040000,
            level: "error",
            message: "POST /api/checkout 503",
            app: "payment-service",
            pod: "p1",
          },
        },
      ],
    },
  }

  it("POSTs the compiled query to the configured index and maps hits to RawLogEntry", async () => {
    const { fn, calls } = stubFetch(hits)
    const source = new ElasticsearchLogSource({ url: "http://es:9200", index: "logs-*", fetchImpl: fn })
    const out = await source.queryLogs({ startMs: 1, endMs: 2, limit: 10 })

    expect(calls[0].url).toBe("http://es:9200/logs-*/_search")
    expect(calls[0].body.size).toBe(10)

    // Sorted ascending: the earlier ERROR line comes first.
    expect(out).toHaveLength(2)
    expect(out[0].level).toBe("ERROR")
    expect(out[0].service).toBe("payment-service")
    expect(out[0].pod).toBe("p1")
    // Missing structured level ⇒ classified from the message (INFO here).
    expect(out[1].level).toBe("INFO")
  })

  it("returns [] when there are no hits", async () => {
    const { fn } = stubFetch({ hits: { hits: [] } })
    const source = new ElasticsearchLogSource({ fetchImpl: fn })
    expect(await source.queryLogs({})).toEqual([])
  })

  it("throws when Elasticsearch responds with a non-2xx status", async () => {
    const { fn } = stubFetch({}, false, 503)
    const source = new ElasticsearchLogSource({ fetchImpl: fn })
    await expect(source.queryLogs({})).rejects.toThrow("Elasticsearch query failed: 503")
  })
})
