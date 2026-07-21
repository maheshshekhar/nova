// Minimal MCP client surface Nova needs: call one tool and close. The concrete
// SDK-backed implementation lives in ./transport (server-only, lazily loaded);
// tests inject a fake, so the adapter logic is verified without a real MCP server.

export interface McpClient {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>
  close(): Promise<void>
}

/** A memoised connection factory — connect once, reuse across queries. */
export type McpConnect = () => Promise<McpClient>
