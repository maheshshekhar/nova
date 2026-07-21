import type { RawLogEntry } from "@/lib/log-selection"
import { DEFAULT_CONFIG } from "@/lib/config/defaults"
import { classifyLevel, finalizeEntries, toIsoTimestamp } from "../normalize"
import type { LogQueryInput, LogSource } from "../source"
import type { McpConnect } from "./client"
import { compileScopeToMcpArgs, type ScopeFormat } from "./compile"

// MCP LogSource — consume a Model Context Protocol server as a log backend. Nova
// calls the configured tool DIRECTLY (never via the LLM), so the pipeline stays
// deterministic and the result is redacted + normalised like every other adapter.
// Not server-only: the SDK transport is injected via `connect`, so the adapter is
// testable with a fake client.

export interface McpLogSourceOptions {
  connect: McpConnect
  tool: string
  argMap: Record<string, string>
  resultPath?: string
  scopeFormat?: ScopeFormat
}

// Navigate a dot-path (e.g. "data.result") into an object.
function navigate(obj: unknown, path?: string): unknown {
  if (!path) return obj
  return path.split(".").reduce<unknown>((o, k) => (o == null ? o : (o as any)[k]), obj)
}

// Extract the array of row objects from a tool result. A common MCP shape is
// `{ content: [{ type: "text", text: "<json>" }] }`, so a string at the resultPath
// is JSON-parsed before use.
export function extractRows(result: unknown, resultPath?: string): Array<Record<string, unknown>> {
  let value = navigate(result, resultPath)
  if (typeof value === "string") {
    try {
      value = JSON.parse(value)
    } catch {
      return []
    }
  }
  return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : []
}

export class McpLogSource implements LogSource {
  private clientPromise?: ReturnType<McpConnect>

  constructor(private readonly opts: McpLogSourceOptions) {}

  private client() {
    return (this.clientPromise ??= this.opts.connect())
  }

  async queryLogs(input: LogQueryInput): Promise<RawLogEntry[]> {
    const endMs = input.endMs ?? Date.now()
    const startMs = input.startMs ?? endMs - 30 * 60 * 1000
    const limit = input.limit ?? 5000
    const scope = input.scope ?? DEFAULT_CONFIG.logs.scope
    const fields = input.fields ?? DEFAULT_CONFIG.logs.fields

    const args = compileScopeToMcpArgs(
      this.opts.argMap,
      scope,
      fields,
      input,
      { startMs, endMs, limit },
      this.opts.scopeFormat
    )

    const client = await this.client()
    const result = await client.callTool(this.opts.tool, args) // throws ⇒ propagates (backend error)
    const rows = extractRows(result, this.opts.resultPath)

    const out: RawLogEntry[] = rows.map((r) => {
      const message = String(r[fields.message] ?? "")
      const rawLevel = r[fields.level]
      return {
        timestamp: toIsoTimestamp(r[fields.timestamp]),
        level: rawLevel ? String(rawLevel).toUpperCase() : classifyLevel(message),
        message,
        pod: typeof r.pod === "string" ? r.pod : undefined,
        service: (r[fields.service] as string) ?? input.service,
      }
    })
    return finalizeEntries(out)
  }
}
