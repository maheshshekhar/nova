import { describe, expect, it } from "vitest"
import { compileScopeToMcpArgs } from "@/lib/logs/mcp/compile"
import { DEFAULT_CONFIG } from "@/lib/config/defaults"
import type { LogQueryInput } from "@/lib/logs/source"

const FIELDS = DEFAULT_CONFIG.logs.fields
const SCOPE = DEFAULT_CONFIG.logs.scope
const WINDOW = { startMs: 1000, endMs: 2000, limit: 50 }

const argMap = {
  query: "${scope}",
  start: "${startMs}",
  end: "${endMs}",
  limit: "${limit}",
}

describe("compileScopeToMcpArgs", () => {
  it("renders ${scope} as LogQL by default and passes the window tokens", () => {
    const args = compileScopeToMcpArgs(argMap, SCOPE, FIELDS, {}, WINDOW)
    expect(args.query).toBe('{namespace="production", app!="load-generator"}')
    expect(args.start).toBe(1000)
    expect(args.end).toBe(2000)
    expect(args.limit).toBe(50)
  })

  it("includes the service in the LogQL when given", () => {
    const input: LogQueryInput = { service: "payment-service" }
    const args = compileScopeToMcpArgs(argMap, SCOPE, FIELDS, input, WINDOW)
    expect(args.query).toBe('{namespace="production", app="payment-service"}')
  })

  it("renders ${scope} as JSON when scopeFormat is json", () => {
    const args = compileScopeToMcpArgs({ q: "${scope}" }, SCOPE, FIELDS, { service: "x" }, WINDOW, "json")
    const parsed = JSON.parse(String(args.q))
    expect(parsed.service).toBe("x")
    expect(parsed.scope).toEqual(SCOPE)
  })

  it("resolves ${service} and ${levels} tokens", () => {
    const args = compileScopeToMcpArgs(
      { svc: "${service}", lvls: "${levels}" },
      SCOPE,
      FIELDS,
      { service: "cart", levels: ["ERROR"] },
      WINDOW
    )
    expect(args.svc).toBe("cart")
    expect(args.lvls).toEqual(["ERROR"])
  })

  it("passes an unrecognised token through as a literal", () => {
    const args = compileScopeToMcpArgs({ env: "production" }, SCOPE, FIELDS, {}, WINDOW)
    expect(args.env).toBe("production")
  })
})
