import "server-only"
import type { McpConnect } from "./client"

// SDK-backed MCP connection factory. The @modelcontextprotocol/sdk (and its
// transports) are imported LAZILY so they only load when an MCP log source is
// actually configured. Not unit-tested (needs a live MCP server); the adapter
// logic in ./source is tested against a fake client.

export interface McpTransportConfig {
  transport: "stdio" | "http" | "sse"
  command?: string[]
  url?: string
}

export function createMcpConnect(cfg: McpTransportConfig): McpConnect {
  return async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js")

    let transport
    if (cfg.transport === "stdio") {
      if (!cfg.command?.length) throw new Error("mcp stdio transport requires `command`")
      const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js")
      transport = new StdioClientTransport({ command: cfg.command[0], args: cfg.command.slice(1) })
    } else if (cfg.transport === "http") {
      if (!cfg.url) throw new Error("mcp http transport requires `url`")
      const { StreamableHTTPClientTransport } = await import(
        "@modelcontextprotocol/sdk/client/streamableHttp.js"
      )
      transport = new StreamableHTTPClientTransport(new URL(cfg.url))
    } else {
      if (!cfg.url) throw new Error("mcp sse transport requires `url`")
      const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js")
      transport = new SSEClientTransport(new URL(cfg.url))
    }

    const client = new Client({ name: "nova", version: "0.1.0" })
    await client.connect(transport)

    return {
      async callTool(name: string, args: Record<string, unknown>) {
        return client.callTool({ name, arguments: args })
      },
      async close() {
        await client.close()
      },
    }
  }
}
