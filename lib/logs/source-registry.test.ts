import { afterEach, describe, expect, it } from "vitest"
import { getLogSource, logSourceRegistry, resetLogSourceCache } from "@/lib/logs/registry"
import { LokiLogSource } from "@/lib/logs/loki-source"
import { ElasticsearchLogSource } from "@/lib/logs/es-source"
import { McpLogSource } from "@/lib/logs/mcp/source"
import { LogsConfigSchema } from "@/lib/config/schema"

const cfg = LogsConfigSchema.parse({})

afterEach(() => resetLogSourceCache())

describe("logSourceRegistry", () => {
  it("resolves loki to the Loki adapter", () => {
    expect(logSourceRegistry.create("loki", cfg)).toBeInstanceOf(LokiLogSource)
  })

  it("resolves elasticsearch and opensearch to the ES adapter (shared protocol)", () => {
    expect(logSourceRegistry.create("elasticsearch", cfg)).toBeInstanceOf(ElasticsearchLogSource)
    expect(logSourceRegistry.create("opensearch", cfg)).toBeInstanceOf(ElasticsearchLogSource)
  })

  it("throws a helpful error for an unregistered provider", () => {
    expect(() => logSourceRegistry.create("datadog", cfg)).toThrow(/Unknown log source provider/)
  })

  it("resolves mcp to the MCP adapter when a tool is configured", () => {
    const c = LogsConfigSchema.parse({ provider: "mcp", mcp: { tool: "query_range" } })
    expect(logSourceRegistry.create("mcp", c)).toBeInstanceOf(McpLogSource)
  })

  it("throws when provider=mcp but no logs.mcp block is given", () => {
    const c = LogsConfigSchema.parse({ provider: "mcp" })
    expect(() => logSourceRegistry.create("mcp", c)).toThrow(/requires a logs.mcp block/)
  })
})

describe("getLogSource — default", () => {
  it("returns the Loki adapter for the default config (provider=loki)", () => {
    expect(getLogSource()).toBeInstanceOf(LokiLogSource)
  })
})
