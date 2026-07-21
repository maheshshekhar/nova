import type { LogScope, Selector, LogFields } from "@/lib/config/schema"
import { backendField } from "./field-map"

// Compile a backend-neutral LogScope into an Elasticsearch/OpenSearch search
// body. Include selectors → bool.filter (multiple groups OR-ed via should),
// exclude selectors → bool.must_not, plus a level terms filter and a timestamp
// range. The same LogScope that compiles to LogQL for Loki compiles here for ES.

export interface CompileEsOptions {
  service?: string
  levels?: string[]
  startMs: number
  endMs: number
  limit: number
}

export type EsClause = Record<string, unknown>

function clausesForSelector(selector: Selector, fields: LogFields): EsClause[] {
  const clauses: EsClause[] = []
  for (const [dimension, matcher] of Object.entries(selector)) {
    const field = backendField(dimension, fields)
    if (typeof matcher === "string") {
      clauses.push({ term: { [field]: matcher } })
    } else if (Array.isArray(matcher)) {
      clauses.push({ terms: { [field]: matcher } })
    } else if (matcher && typeof matcher === "object" && "regex" in matcher) {
      clauses.push({ regexp: { [field]: matcher.regex } })
    }
  }
  return clauses
}

export function compileScopeToEs(
  scope: LogScope,
  fields: LogFields,
  opts: CompileEsOptions
): Record<string, unknown> {
  const filter: EsClause[] = []
  const include = scope.include ?? []

  if (include.length === 1) {
    filter.push(...clausesForSelector(include[0], fields))
  } else if (include.length > 1) {
    // Multiple include groups are OR-ed: any group (all its matchers) qualifies.
    filter.push({
      bool: {
        should: include.map((sel) => ({ bool: { filter: clausesForSelector(sel, fields) } })),
        minimum_should_match: 1,
      },
    })
  }

  if (opts.service) {
    filter.push({ term: { [fields.service]: opts.service } })
  }

  if (opts.levels && opts.levels.length) {
    filter.push({ terms: { [fields.level]: opts.levels.map((l) => l.toUpperCase()) } })
  }

  filter.push({
    range: { [fields.timestamp]: { gte: opts.startMs, lte: opts.endMs, format: "epoch_millis" } },
  })

  const mustNot: EsClause[] = []
  for (const selector of scope.exclude ?? []) {
    mustNot.push(...clausesForSelector(selector, fields))
  }

  return {
    size: opts.limit,
    sort: [{ [fields.timestamp]: "desc" }],
    query: { bool: { filter, must_not: mustNot } },
  }
}
