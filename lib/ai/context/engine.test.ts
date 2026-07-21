import { describe, expect, it } from "vitest"
import { renderContext, type ContextProvider } from "@/lib/ai/context/engine"

// Providers under test operate on a trivial string input so the engine's own
// behaviour (ordering, empty-omission, budget trimming) is isolated from any
// real provider logic.
type I = string

function block(id: string, priority: number, lines: string[]): ContextProvider<I> {
  return { id, priority, build: () => (lines.length ? { id, priority, lines } : null) }
}

describe("renderContext — assembly", () => {
  it("concatenates non-empty blocks in priority order, joined by newlines", () => {
    const providers = [
      block("a", 10, ["A1", "A2"]),
      block("b", 20, ["", "B1"]),
    ]
    expect(renderContext(providers, "")).toBe("A1\nA2\n\nB1")
  })

  it("omits providers that return null or an empty block", () => {
    const providers = [
      block("a", 10, ["A"]),
      { id: "empty", priority: 15, build: () => null } as ContextProvider<I>,
      block("gap", 18, []), // build returns null because no lines
      block("b", 20, ["B"]),
    ]
    expect(renderContext(providers, "")).toBe("A\nB")
  })

  it("orders by priority even when providers are declared out of order (stable)", () => {
    const providers = [
      block("late", 30, ["LATE"]),
      block("early", 10, ["EARLY"]),
      block("mid", 20, ["MID"]),
    ]
    expect(renderContext(providers, "")).toBe("EARLY\nMID\nLATE")
  })
})

describe("renderContext — budget trimming", () => {
  const providers = [
    block("hi", 10, ["important"]), // 9 chars
    block("mid", 20, ["middle"]), // 6 chars
    block("lo", 30, ["least-important-block"]), // 21 chars
  ]

  it("keeps everything when the budget is not exceeded", () => {
    expect(renderContext(providers, "", { budget: 1000 })).toBe(
      "important\nmiddle\nleast-important-block"
    )
  })

  it("drops the lowest-priority block first when over budget", () => {
    // "important\nmiddle" = 16 chars; adding the lo block would exceed 20.
    expect(renderContext(providers, "", { budget: 20 })).toBe("important\nmiddle")
  })

  it("drops multiple low-priority blocks, never the most important one", () => {
    // Budget only fits the highest-priority block.
    expect(renderContext(providers, "", { budget: 9 })).toBe("important")
  })

  it("keeps the single most-important block even if it alone exceeds the budget", () => {
    expect(renderContext(providers, "", { budget: 1 })).toBe("important")
  })
})
