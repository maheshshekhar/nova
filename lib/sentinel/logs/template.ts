// Drain-style log-template mining → novelty detection.
//
// The core of "detect by anomaly, not keyword": every log line is reduced to a
// stable TEMPLATE by masking its variable tokens (numbers, IDs, IPs, quoted
// strings, timestamps…). A service accumulates the set of templates it normally
// emits; once a baseline exists, a template never seen before is a NOVELTY
// signal — no `ERROR` keyword required, works for any log format.
//
// Pure and deterministic (injectable clock, in-memory state) ⇒ unit-testable.

// Ordered masks — earlier, more specific patterns run first so a UUID isn't
// shredded into <NUM>s and a date isn't split. Each collapses a variable token
// class to a placeholder.
const MASKS: Array<[RegExp, string]> = [
  // UUIDs
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<UUID>"],
  // ISO-ish timestamps
  [/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g, "<TS>"],
  // IPv4 (optionally :port)
  [/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, "<IP>"],
  // hex literals / long hashes
  [/\b0x[0-9a-f]+\b/gi, "<HEX>"],
  [/\b[0-9a-f]{12,}\b/gi, "<HEX>"],
  // quoted strings
  [/"[^"]*"/g, "<STR>"],
  [/'[^']*'/g, "<STR>"],
  // durations / sizes with a unit, then bare numbers
  [/\b\d+(?:\.\d+)?\s?(?:ns|us|µs|ms|s|m|h|d|kb|mb|gb|tb|b|%)\b/gi, "<NUM>"],
  [/\b\d+(?:\.\d+)?\b/g, "<NUM>"],
]

/** Reduce a raw log message to its structural template. */
export function templatize(message: string): string {
  let out = message
  for (const [re, rep] of MASKS) out = out.replace(re, rep)
  return out.replace(/\s+/g, " ").trim()
}

export interface TemplateObservation {
  template: string
  /** True when this template is new AND the service is past warm-up. */
  novel: boolean
  /** How many times this template has now been seen for the service. */
  count: number
}

interface TemplateStat {
  count: number
  firstSeen: number
  lastSeen: number
}

interface ServiceState {
  total: number
  templates: Map<string, TemplateStat>
}

export interface LogTemplateMinerOptions {
  /** Lines a service must emit before novelty is reported (learn silently first). */
  warmupLines?: number
  /** Max distinct templates retained per service (LRU by lastSeen). */
  maxTemplatesPerService?: number
  now?: () => number
}

export class LogTemplateMiner {
  private readonly warmupLines: number
  private readonly maxTemplates: number
  private readonly now: () => number
  private readonly services = new Map<string, ServiceState>()

  constructor(opts: LogTemplateMinerOptions = {}) {
    this.warmupLines = opts.warmupLines ?? 50
    this.maxTemplates = opts.maxTemplatesPerService ?? 500
    this.now = opts.now ?? Date.now
  }

  observe(service: string, message: string, at?: number): TemplateObservation {
    const t = at ?? this.now()
    const template = templatize(message)
    let svc = this.services.get(service)
    if (!svc) {
      svc = { total: 0, templates: new Map() }
      this.services.set(service, svc)
    }
    svc.total++

    const existing = svc.templates.get(template)
    if (existing) {
      existing.count++
      existing.lastSeen = t
      return { template, novel: false, count: existing.count }
    }

    // New template. Only novel once the service has an established baseline.
    const novel = svc.total > this.warmupLines
    svc.templates.set(template, { count: 1, firstSeen: t, lastSeen: t })
    this.evict(svc)
    return { template, novel, count: 1 }
  }

  /** Distinct templates learned for a service (for tests / introspection). */
  templateCount(service: string): number {
    return this.services.get(service)?.templates.size ?? 0
  }

  private evict(svc: ServiceState): void {
    if (svc.templates.size <= this.maxTemplates) return
    let oldestKey: string | undefined
    let oldestAt = Infinity
    for (const [k, v] of svc.templates) {
      if (v.lastSeen < oldestAt) {
        oldestAt = v.lastSeen
        oldestKey = k
      }
    }
    if (oldestKey !== undefined) svc.templates.delete(oldestKey)
  }
}
