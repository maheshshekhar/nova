import "server-only"
import { AdapterRegistry } from "@/lib/config/registry"
import { getConfig } from "@/lib/config/loader"
import type { LogsConfig } from "@/lib/config/schema"
import type { LogSource } from "./source"
import { LokiLogSource } from "./loki-source"
import { ElasticsearchLogSource } from "./es-source"
import { McpLogSource } from "./mcp/source"
import { createMcpConnect } from "./mcp/transport"

// Log-source registry — resolves `config.logs.provider` to a concrete LogSource
// adapter. Elasticsearch and OpenSearch share the same wire protocol, so both map
// to the ES adapter. Add cloudwatch/datadog/file adapters here as they land.

export const logSourceRegistry = new AdapterRegistry<LogsConfig, LogSource>("log source")

logSourceRegistry
  .register("loki", (cfg) => new LokiLogSource({ url: cfg.url }))
  .register(
    "elasticsearch",
    (cfg) => new ElasticsearchLogSource({ url: cfg.url, index: readIndex(cfg) })
  )
  .register(
    "opensearch",
    (cfg) => new ElasticsearchLogSource({ url: cfg.url, index: readIndex(cfg) })
  )
  .register("mcp", (cfg) => {
    const mcp = cfg.mcp
    if (!mcp?.tool) {
      throw new Error("logs.provider=mcp requires a logs.mcp block with a `tool`")
    }
    return new McpLogSource({
      connect: createMcpConnect(mcp),
      tool: mcp.tool,
      argMap: mcp.argMap,
      resultPath: mcp.resultPath,
      scopeFormat: mcp.scopeFormat,
    })
  })

// `index` is an ES/OpenSearch-specific passthrough field on the logs config.
function readIndex(cfg: LogsConfig): string | undefined {
  const index = (cfg as Record<string, unknown>).index
  return typeof index === "string" ? index : undefined
}

let cached: LogSource | undefined

export function getLogSource(): LogSource {
  if (cached) return cached
  const logs = getConfig().logs
  cached = logSourceRegistry.create(logs.provider, logs)
  return cached
}

export function resetLogSourceCache(): void {
  cached = undefined
}
