import type { LogFields, LogScope } from "@/lib/config/schema"
import type { LogQueryInput } from "../source"
import { compileScopeToLogQL } from "../scope"

// Compile Nova's query into an MCP tool's argument object. The operator declares
// an `argMap` of { toolArgName: token }, where a token is one of the placeholders
// below (or a literal). `${scope}` is rendered in the configured dialect so the
// tool receives a query it understands, while the rest of the LogScope machinery
// (compilation, redaction on the result) is unchanged. Pure.

export type ScopeFormat = "logql" | "json"

export interface McpWindow {
  startMs: number
  endMs: number
  limit: number
}

function renderScope(
  scope: LogScope,
  fields: LogFields,
  input: LogQueryInput,
  format: ScopeFormat
): string {
  if (format === "json") {
    return JSON.stringify({ scope, service: input.service, levels: input.levels })
  }
  // logql (default): a complete stream selector + line filter.
  return compileScopeToLogQL(scope, fields, { service: input.service, levels: input.levels })
}

function resolveToken(
  token: string,
  scope: LogScope,
  fields: LogFields,
  input: LogQueryInput,
  window: McpWindow,
  format: ScopeFormat
): unknown {
  switch (token) {
    case "${scope}":
      return renderScope(scope, fields, input, format)
    case "${startMs}":
      return window.startMs
    case "${endMs}":
      return window.endMs
    case "${limit}":
      return window.limit
    case "${service}":
      return input.service ?? ""
    case "${levels}":
      return input.levels ?? []
    default:
      return token // literal passthrough
  }
}

export function compileScopeToMcpArgs(
  argMap: Record<string, string>,
  scope: LogScope,
  fields: LogFields,
  input: LogQueryInput,
  window: McpWindow,
  format: ScopeFormat = "logql"
): Record<string, unknown> {
  const args: Record<string, unknown> = {}
  for (const [name, token] of Object.entries(argMap)) {
    args[name] = resolveToken(token, scope, fields, input, window, format)
  }
  return args
}
