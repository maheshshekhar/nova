import type { LogScope, Selector, LogFields } from "@/lib/config/schema"
import { backendField } from "./field-map"

// LogScope — a backend-neutral description of *where Nova looks for logs*, and the
// compiler that turns it into a concrete backend query. See
// docs/log-scope-agnostic-plan.md. The core only ever deals in the logical
// `LogScope`; each LogSource adapter (Loki here) owns the translation.

export type { LogScope, Selector } from "@/lib/config/schema"

// ── Scope resolution ─────────────────────────────────────────────────────────
// Where a scope can come from, in precedence order (highest first): the incident
// it belongs to, a UI/user override, then the config default. `include` and
// `exclude` are resolved independently so an incident can narrow *where* to look
// (its own `include`) while still inheriting the global noise `exclude` (e.g. the
// load-generator) it never bothered to restate.

export interface ScopeSources {
  /** Scope recorded on the incident whose evidence we're pulling (highest). */
  incident?: LogScope
  /** A UI/user scope override (e.g. the dashboard scope picker). */
  override?: LogScope
  /** The config default — always present. */
  config: LogScope
}

export function resolveScope(sources: ScopeSources): LogScope {
  const ordered: Array<LogScope | undefined> = [
    sources.incident,
    sources.override,
    sources.config,
  ]
  // For each part, the highest-precedence source that actually specifies it wins.
  // "Specified" means the array is present (even empty ⇒ a deliberate choice);
  // `undefined`/missing defers to the next source down.
  const include = firstSpecified(ordered, (s) => s?.include)
  const exclude = firstSpecified(ordered, (s) => s?.exclude)

  const out: LogScope = {}
  if (include !== undefined) out.include = include
  if (exclude !== undefined) out.exclude = exclude
  return out
}

function firstSpecified<T>(
  sources: Array<LogScope | undefined>,
  pick: (s: LogScope | undefined) => T | undefined
): T | undefined {
  for (const s of sources) {
    const v = pick(s)
    if (v !== undefined) return v
  }
  return undefined
}

// ── LogQL compilation ────────────────────────────────────────────────────────
export interface CompileLogQLOptions {
  /** Query-time narrowing to a single service (an equality include on the
   * `service` dimension). Mirrors today's `service` param. */
  service?: string
  /** Restrict to these levels via a case-insensitive line filter. */
  levels?: string[]
}

// Per backend-field accumulated allowed/forbidden values from one or more
// selectors. Values are OR-ed (regex alternation); regexes are kept as-is.
interface FieldSpec {
  values: string[]
  regexes: string[]
}

/**
 * Compile a `LogScope` (+ query-time service/levels) into a LogQL query string.
 *
 * - `include` selectors become a stream-selector of positive matchers, merged by
 *   backend field: one value ⇒ `field="v"`, many ⇒ `field=~"a|b"`, `{regex}` ⇒
 *   `field=~"re"`.
 * - `service` adds an equality matcher on the service field.
 * - `exclude` selectors become negative matchers (`!=` / `!~`), but a field
 *   already pinned to a single value by an equality include is skipped (the
 *   exclusion is redundant — this is what keeps a service-scoped query identical
 *   to today's `{namespace="production", app="x"}`).
 * - `levels` append the same `|~ "(?i)(A|B)"` line filter as before.
 */
export function compileScopeToLogQL(
  scope: LogScope,
  fields: LogFields,
  opts: CompileLogQLOptions = {}
): string {
  const matchers: string[] = []
  const pinnedByEquality = new Set<string>()

  // 1. Includes — positive matchers, merged by backend field (ordered).
  const includes = collectByField(scope.include ?? [], fields)
  for (const [field, spec] of includes) {
    const { text, isEquality } = positiveMatcher(field, spec)
    matchers.push(text)
    if (isEquality) pinnedByEquality.add(field)
  }

  // 2. Query-time service override — an equality include on the service field.
  if (opts.service) {
    const svcField = fields.service
    if (!pinnedByEquality.has(svcField)) {
      matchers.push(`${svcField}="${opts.service}"`)
    }
    pinnedByEquality.add(svcField)
  }

  // 3. Excludes — negative matchers, skipping fields already pinned by equality.
  const excludes = collectByField(scope.exclude ?? [], fields)
  for (const [field, spec] of excludes) {
    if (pinnedByEquality.has(field)) continue
    matchers.push(negativeMatcher(field, spec))
  }

  let query = `{${matchers.join(", ")}}`

  // 4. Level line filter (unchanged from the original buildLogQL).
  if (opts.levels && opts.levels.length) {
    const alt = opts.levels
      .map((l) => l.toUpperCase().replace(/[^A-Z]/g, ""))
      .filter(Boolean)
      .join("|")
    if (alt) query += ` |~ "(?i)(${alt})"`
  }
  return query
}

// Merge a list of selectors into an ordered map of backend field → FieldSpec.
// Order = first appearance of each field across the selectors, so the compiled
// selector is deterministic (namespace before app for the demo default).
function collectByField(
  selectors: Selector[],
  fields: LogFields
): Map<string, FieldSpec> {
  const out = new Map<string, FieldSpec>()
  for (const selector of selectors) {
    for (const [dimension, matcher] of Object.entries(selector)) {
      const field = backendField(dimension, fields)
      const spec = out.get(field) ?? { values: [], regexes: [] }
      if (typeof matcher === "string") {
        spec.values.push(matcher)
      } else if (Array.isArray(matcher)) {
        spec.values.push(...matcher)
      } else if (matcher && typeof matcher === "object" && "regex" in matcher) {
        spec.regexes.push(matcher.regex)
      }
      out.set(field, spec)
    }
  }
  return out
}

function positiveMatcher(
  field: string,
  spec: FieldSpec
): { text: string; isEquality: boolean } {
  const values = dedupe(spec.values)
  // A single exact value with no regex ⇒ strict equality (`=`).
  if (spec.regexes.length === 0 && values.length === 1) {
    return { text: `${field}="${values[0]}"`, isEquality: true }
  }
  const alt = alternation(values, spec.regexes)
  return { text: `${field}=~"${alt}"`, isEquality: false }
}

function negativeMatcher(field: string, spec: FieldSpec): string {
  const values = dedupe(spec.values)
  if (spec.regexes.length === 0 && values.length === 1) {
    return `${field}!="${values[0]}"`
  }
  return `${field}!~"${alternation(values, spec.regexes)}"`
}

// Build a regex alternation from exact values (escaped) plus raw regexes.
function alternation(values: string[], regexes: string[]): string {
  return [...values.map(escapeRegex), ...regexes].join("|")
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values))
}
