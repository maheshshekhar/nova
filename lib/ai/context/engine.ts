// Context engine — the assistant/RCA context is no longer one 180-line function.
// It is a set of independent *providers*, each of which turns the current inputs
// into one labelled block, plus an engine that orders the blocks and (optionally)
// trims them to a size budget. This makes every block unit-testable in isolation
// and lets an operator enable/disable or reprioritise context sources later
// (settings UI, M10) without touching the assembly logic. See open-source-plan §5.

/** One labelled section of the context (its `lines` already include the leading
 * blank separator + header, exactly as the flat builder emitted them). */
export interface ContextBlock {
  id: string
  /** Lower = more important. Kept first, dropped last under a budget. */
  priority: number
  lines: string[]
}

/** A source of context. `build` returns null (or an empty block) to contribute
 * nothing — e.g. a disabled provider, or one with no data for this incident. */
export interface ContextProvider<I> {
  id: string
  priority: number
  build(input: I): ContextBlock | null
}

export interface RenderContextOptions {
  /** Max total characters. When set, the least-important blocks are dropped
   * (highest `priority` first) until the rendered context fits. */
  budget?: number
}

/**
 * Run every provider, drop empty blocks, order by priority, optionally trim to a
 * character budget (lowest-priority blocks first), and join into the final
 * context string. With no budget the output is the in-priority-order
 * concatenation of every non-empty block — identical to the original flat builder.
 */
export function renderContext<I>(
  providers: ReadonlyArray<ContextProvider<I>>,
  input: I,
  opts: RenderContextOptions = {}
): string {
  // Build blocks, keeping the provider (declaration) order as the stable tiebreak.
  const blocks = providers
    .map((p, order) => ({ order, block: p.build(input) }))
    .filter(
      (b): b is { order: number; block: ContextBlock } =>
        b.block != null && b.block.lines.length > 0
    )
    .sort((a, z) => a.block.priority - z.block.priority || a.order - z.order)
    .map((b) => b.block)

  const kept = opts.budget != null ? trimToBudget(blocks, opts.budget) : blocks

  return kept.flatMap((b) => b.lines).join("\n")
}

// Drop whole blocks, least-important first (highest priority value, latest
// declared), until the joined result fits the budget. A single block that is
// itself over budget is only dropped if removing more-important blocks wasn't
// enough — importance is never violated.
function trimToBudget(blocks: ContextBlock[], budget: number): ContextBlock[] {
  const kept = [...blocks]
  // Never drop the last (most-important) block: a single over-budget critical
  // block is still more useful than an empty context.
  while (kept.length > 1 && renderedLength(kept) > budget) {
    // Remove the least-important remaining block. `kept` is in priority order, so
    // that's the last element.
    kept.pop()
  }
  return kept
}

function renderedLength(blocks: ContextBlock[]): number {
  return blocks.flatMap((b) => b.lines).join("\n").length
}
