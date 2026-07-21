import { describe, expect, it, vi } from "vitest"
import { McpLogSource, extractRows } from "@/lib/logs/mcp/source"
import type { McpClient } from "@/lib/logs/mcp/client"

const ROWS = [
  { timestamp: 1768382100000, message: "checkout ok", app: "payment-service" },
  { timestamp: 1768382040000, level: "error", message: "POST /api/checkout 503", app: "payment-service", pod: "p1" },
]

function fakeClient(result: unknown, onCall?: (name: string, args: Record<string, unknown>) => void): McpClient {
  return {
    async callTool(name, args) {
      onCall?.(name, args)
      return result
    },
    async close() {},
  }
}

describe("extractRows", () => {
  it("navigates a dot-path to the rows array", () => {
    expect(extractRows({ data: { result: ROWS } }, "data.result")).toHaveLength(2)
  })
  it("JSON-parses a string at the result path (common MCP text content)", () => {
    expect(extractRows({ text: JSON.stringify(ROWS) }, "text")).toHaveLength(2)
  })
  it("returns [] for a non-array / unparseable value", () => {
    expect(extractRows({ x: 5 }, "x")).toEqual([])
    expect(extractRows({ x: "not json" }, "x")).toEqual([])
  })
})

describe("McpLogSource", () => {
  it("calls the tool with the compiled args and maps the result to RawLogEntry", async () => {
    let seen: { name: string; args: Record<string, unknown> } | undefined
    const source = new McpLogSource({
      connect: async () => fakeClient({ data: { result: ROWS } }, (name, args) => (seen = { name, args })),
      tool: "query_range",
      argMap: { query: "${scope}", limit: "${limit}" },
      resultPath: "data.result",
    })
    const out = await source.queryLogs({ startMs: 1, endMs: 2, limit: 10 })

    expect(seen?.name).toBe("query_range")
    expect(seen?.args.limit).toBe(10)
    // Sorted ascending: the earlier ERROR line first; level from the field, else classified.
    expect(out).toHaveLength(2)
    expect(out[0].level).toBe("ERROR")
    expect(out[0].service).toBe("payment-service")
    expect(out[0].pod).toBe("p1")
    expect(out[1].level).toBe("INFO")
  })

  it("returns [] when the tool result has no rows", async () => {
    const source = new McpLogSource({
      connect: async () => fakeClient({ data: { result: [] } }),
      tool: "q",
      argMap: {},
      resultPath: "data.result",
    })
    expect(await source.queryLogs({})).toEqual([])
  })

  it("propagates a tool/transport error", async () => {
    const source = new McpLogSource({
      connect: async () => ({ async callTool() { throw new Error("mcp transport failed") }, async close() {} }),
      tool: "q",
      argMap: {},
    })
    await expect(source.queryLogs({})).rejects.toThrow("mcp transport failed")
  })

  it("redacts secrets in returned log messages", async () => {
    const source = new McpLogSource({
      connect: async () => fakeClient({ rows: [{ message: "boot key sk-abcdefghijklmnopqrstuvwxyz012345", timestamp: 1768382040000 }] }),
      tool: "q",
      argMap: {},
      resultPath: "rows",
    })
    const out = await source.queryLogs({})
    expect(out[0].message).toContain("[REDACTED_API_KEY]")
  })

  it("connects once and reuses the client across queries", async () => {
    const connect = vi.fn(async () => fakeClient({ rows: [] }))
    const source = new McpLogSource({ connect, tool: "q", argMap: {}, resultPath: "rows" })
    await source.queryLogs({})
    await source.queryLogs({})
    expect(connect).toHaveBeenCalledOnce()
  })
})
