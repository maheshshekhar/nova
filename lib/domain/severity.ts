import type { SeverityRule } from "@/lib/config/schema"

// Domain-agnostic severity mapping. Each Domain Pack declares ordered
// `severityRules` mapping metric thresholds to a severity; the FIRST matching
// rule wins. A rule's `when` is a map of metric → threshold expression, where the
// expression is an operator + number (`">5"`, `">=1"`, `"<0.5"`, `"=0"`) or a
// bare number (treated as equality). All metrics in a `when` must match (AND).
// Pure — usable anywhere.

export type Severity = SeverityRule["severity"]

const OP_RE = /^\s*(>=|<=|==|=|>|<)?\s*(-?\d+(?:\.\d+)?)\s*$/

function satisfies(actual: number, expr: string | number): boolean {
  const raw = typeof expr === "number" ? String(expr) : expr
  const m = OP_RE.exec(raw)
  if (!m) return false
  const op = m[1] ?? "="
  const threshold = Number(m[2])
  switch (op) {
    case ">":
      return actual > threshold
    case ">=":
      return actual >= threshold
    case "<":
      return actual < threshold
    case "<=":
      return actual <= threshold
    case "=":
    case "==":
      return actual === threshold
    default:
      return false
  }
}

/**
 * Return the severity of the first rule whose every `when` condition is met by
 * `metrics`, or `null` when no rule matches. A condition on a metric that is not
 * present in `metrics` never matches (the rule is skipped).
 */
export function severityFor(
  metrics: Record<string, number>,
  rules: SeverityRule[]
): Severity | null {
  for (const rule of rules) {
    const conditions = Object.entries(rule.when)
    if (conditions.length === 0) continue
    const allMatch = conditions.every(([metric, expr]) => {
      const actual = metrics[metric]
      return actual !== undefined && satisfies(actual, expr)
    })
    if (allMatch) return rule.severity
  }
  return null
}
