# Nova — MCP Adapters Plan (M15)

> Design spec. Companion to [open-source-plan.md](open-source-plan.md),
> [log-scope-agnostic-plan.md](log-scope-agnostic-plan.md) and
> [implementation-plan.md](implementation-plan.md).
> Status: **DESIGN — ready to implement**. Builds on the finished M0–M13 core.

## Scope

**In scope:** Nova as an MCP **client** — consume Model Context Protocol servers as a
*data/tool source* (logs first, metrics/actions later), behind the existing adapter
ports. One adapter unlocks the growing MCP ecosystem (Grafana/Loki, Elastic, Datadog,
Splunk MCP servers) instead of a bespoke adapter per backend.

**Deferred (explicitly, per decision):** Nova as an MCP **server** — exposing Nova's
own capabilities (query incidents, fetch RCA, match runbook, approve remediation) as
MCP tools for external agents. Revisit as the product evolves; noted here only so the
client design doesn't foreclose it.

---

## The core principle: MCP as transport, not an agentic loop

Nova's pipeline is **deterministic**: fetch logs → build context → render prompt →
(optionally) grade with the eval harness. That determinism is what makes evals
reproducible and the egress-redaction guarantee hold.

Therefore the MCP adapter **calls the MCP tool directly** (Nova is the client driving
the call), and **never** hands MCP tools to the LLM for autonomous tool-use. MCP is
just a *fetch transport* that happens to speak a standard protocol. This keeps:

- **Determinism** — the same incident window → the same tool call → the same logs.
- **Redaction** — results pass back through `finalizeEntries` (`redactSecrets` + normalize).
- **Scope control** — Nova compiles its `LogScope` into the tool's arguments.

> If we later add an agentic "investigate" mode, that is a separate, opt-in feature —
> not the default log path.

---

## Concept: `McpLogSource` implements the existing `LogSource` port

No new core abstraction — MCP is "just another adapter":

```ts
// lib/logs/mcp-source.ts
export class McpLogSource implements LogSource {
  constructor(private opts: { client: McpClient; tool: string; argMap: ArgMap }) {}
  async queryLogs(input: LogQueryInput): Promise<RawLogEntry[]> {
    const args = compileScopeToMcpArgs(input, this.opts.argMap)   // LogScope → tool args
    const res = await this.opts.client.callTool(this.opts.tool, args)
    return finalizeEntries(mapMcpResultToEntries(res, input.fields))
  }
}
```

Registered in `lib/logs/registry.ts` under `provider: mcp`, exactly like `loki`/`elasticsearch`.

### Transport & SDK

- Use the official `@modelcontextprotocol/sdk` (TypeScript) client.
- Support the standard transports: **stdio** (spawn a local MCP server process),
  **SSE**, and **streamable HTTP** (remote servers). Transport is a config choice.
- A thin `McpClient` wrapper (connect, `listTools`, `callTool`, close) so the adapter is
  testable against a fake in-process client and the SDK stays swappable.

### LogScope → tool args

MCP servers expose their own tool schemas, so we need a small, config-declared mapping
from Nova's logical query to the server's tool arguments:

```yaml
logs:
  provider: mcp
  mcp:
    transport: stdio            # stdio | sse | http
    command: ["npx", "-y", "@grafana/mcp-server"]   # for stdio
    # url: https://mcp.internal/loki                # for sse/http
    tool: query_range           # the tool to call
    argMap:                     # how our query maps to the tool's args
      query:  ${scope}          # Nova compiles LogScope → the server's query dialect
      start:  ${startMs}
      end:    ${endMs}
      limit:  ${limit}
    resultPath: data.result     # where log rows live in the tool response
    fields: { message: line, timestamp: ts, level: level, service: app }
```

`argMap` + `resultPath` keep the adapter generic across MCP servers without code per
vendor. When a server exposes a native scope/label concept, Nova passes the compiled
selector through; otherwise it falls back to a text query.

---

## Config schema

- Add `mcp` to the `logs.provider` enum and an optional `logs.mcp` block (transport,
  command/url, tool, argMap, resultPath, fields).
- Secrets (remote MCP auth tokens) via `${ENV}` only.
- Mark the whole block **experimental** in `nova.config.example.yaml`.
- (Future) a top-level `mcp:` servers section if metrics/actions also gain MCP adapters,
  so multiple MCP servers are declared once and referenced by capability.

---

## Testing

- **Contract kit reuse:** `McpLogSource` must pass the same `LogSource` behaviour a
  backend adapter does — sorted/truncated/redacted `RawLogEntry`, `[]` on empty, throws
  on transport error.
- **Fake MCP client:** an in-process `McpClient` stub returning canned tool results; assert
  the adapter compiles the right tool args from a `LogScope` + window and maps the result
  via `resultPath`/`fields`.
- **No network / no child process** in unit tests (inject the client). One optional
  integration test can spawn a reference MCP server behind a flag.
- **Redaction:** a secret in an MCP-returned log line is scrubbed (proves egress safety
  survives the new transport).

---

## Phases

1. **M15a — MCP log client.** `McpClient` wrapper (stdio + http) + `McpLogSource` +
   `compileScopeToMcpArgs` + config + registry + contract/fake-client tests.
2. **M15b — Breadth.** MCP metrics + MCP action executor (same principle: direct tool
   calls, gated by the existing approval/RBAC/audit for actions).
3. **(Deferred) M15c — Nova as an MCP server.** Expose incidents/RCA/runbooks as MCP
   tools + resources with auth. Separate track, revisit later.

---

## Backward-compat & caveats

- **Additive:** `provider: mcp` is opt-in; Loki/ES stay the deterministic defaults.
- **Optional dependency:** the MCP SDK is a lazy/optional import so it doesn't weigh on
  users who never enable it.
- **Maturity:** the MCP spec + SDKs are still evolving — pin versions, keep the
  `McpClient` wrapper thin so a breaking SDK change is contained to one file.
- **Determinism boundary:** never route MCP tools through the LLM in the default pipeline
  (see the core principle) or evals become non-reproducible.

---

## Open questions

- **Tool discovery vs. config** — auto-discover a server's query tool (`listTools`) and
  infer `argMap`, or require explicit config? (Start explicit; add discovery later.)
- **Auth** — how to standardise remote MCP auth (bearer/OAuth) across servers via env.
- **Multiple MCP servers** — one per capability, or a shared server registry Nova
  references by name?
- **Streaming** — do we need streaming tool results for very large windows, or is the
  capped `limit` fetch sufficient (as today)?
