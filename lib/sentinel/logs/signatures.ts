import type { SignalSeverity } from "../signal"

// Generic technical signature library.
//
// A curated, format-agnostic set of patterns for failures that recur across
// every stack — database, network, runtime, HTTP and resource exhaustion. These
// are DELIBERATELY conservative (precision over recall: a false incident costs
// trust). Broad/ambiguous phrasing is avoided; unambiguous fatal conditions are
// `hard` (open an incident alone), everything else is `soft` (must corroborate).
//
// The library ships in code; deployments can extend it with `extraSignatures`.

export type SignatureCategory = "database" | "network" | "runtime" | "http" | "resource"

export interface LogSignature {
  /** Stable detection kind (dedup + failure-type mapping). */
  kind: string
  category: SignatureCategory
  severity: SignalSeverity
  /** hard = strong enough to open an incident on its own. */
  hard: boolean
  pattern: RegExp
}

export const SIGNATURES: LogSignature[] = [
  // ── runtime ────────────────────────────────────────────────────────────────
  { kind: "Panic", category: "runtime", severity: "critical", hard: true, pattern: /\bpanic:/i },
  { kind: "Segfault", category: "runtime", severity: "critical", hard: true, pattern: /\b(segmentation fault|sigsegv|signal SIGSEGV)\b/i },
  { kind: "OutOfMemory", category: "runtime", severity: "critical", hard: true, pattern: /\b(out of memory|java\.lang\.OutOfMemoryError|cannot allocate memory|fatal error: runtime: out of memory)\b/i },
  { kind: "StackOverflow", category: "runtime", severity: "critical", hard: true, pattern: /\b(stack overflow|StackOverflowError)\b/i },
  { kind: "UnhandledException", category: "runtime", severity: "warning", hard: false, pattern: /\b(unhandled|uncaught)\s+(exception|promise rejection|error)\b/i },
  { kind: "Traceback", category: "runtime", severity: "warning", hard: false, pattern: /\b(traceback \(most recent call last\)|goroutine \d+ \[|at [\w.$]+\([\w.]+\.(java|kt|scala):\d+\))/i },

  // ── database ─────────────────────────────────────────────────────────────────
  { kind: "DBPoolExhausted", category: "database", severity: "critical", hard: true, pattern: /\b(connection pool (is )?(exhausted|full|timed out)|too many connections|timeout acquiring (a )?connection|QueuePool limit .* reached|remaining connection slots are reserved)\b/i },
  { kind: "DBUnavailable", category: "database", severity: "critical", hard: true, pattern: /\b(could not connect to (server|database)|database is not available|FATAL:\s+the database system is (starting up|shutting down))\b/i },
  { kind: "DBDeadlock", category: "database", severity: "warning", hard: false, pattern: /\bdeadlock (detected|found)\b/i },
  { kind: "SQLError", category: "database", severity: "warning", hard: false, pattern: /\b(SQLSTATE\[?[0-9A-Z]{5}\]?|ORA-\d{4,5}|ERROR:\s+(duplicate key|relation .* does not exist))\b/i },

  // ── network ──────────────────────────────────────────────────────────────────
  { kind: "ConnReset", category: "network", severity: "warning", hard: false, pattern: /\b(connection reset by peer|ECONNRESET|broken pipe|EPIPE)\b/i },
  { kind: "ConnRefused", category: "network", severity: "warning", hard: false, pattern: /\b(ECONNREFUSED|connection refused)\b/i },
  { kind: "NetTimeout", category: "network", severity: "warning", hard: false, pattern: /\b(ETIMEDOUT|context deadline exceeded|i\/o timeout|request timed out|read timed out|upstream timed out)\b/i },
  { kind: "DNSFailure", category: "network", severity: "warning", hard: false, pattern: /\b(EAI_AGAIN|name or service not known|no such host|getaddrinfo (ENOTFOUND|EAI_AGAIN)|dns lookup failed)\b/i },
  { kind: "TLSError", category: "network", severity: "warning", hard: false, pattern: /\b(x509:|tls: handshake failure|certificate (has expired|verify failed|is not valid)|SSL certificate problem)\b/i },

  // ── http ─────────────────────────────────────────────────────────────────────
  // Conservative: require explicit status context, not any bare 5xx number.
  { kind: "HTTP5xx", category: "http", severity: "warning", hard: false, pattern: /\b(5\d{2}\s+(internal server error|bad gateway|service unavailable|gateway timeout)|status(?:[_ ]?code)?["'=: ]+5\d{2}\b|HTTP\/\d(?:\.\d)?"?\s+5\d{2}\b)/i },

  // ── resource ─────────────────────────────────────────────────────────────────
  { kind: "DiskFull", category: "resource", severity: "critical", hard: true, pattern: /\b(no space left on device|ENOSPC|disk (is )?full)\b/i },
  { kind: "Throttled", category: "resource", severity: "warning", hard: false, pattern: /\b(429 too many requests|rate limit(ed| exceeded)?|throttl(ed|ing)|quota exceeded)\b/i },
]

/** Return the distinct signatures a message matches (built-ins + extras). */
export function matchSignatures(message: string, extra: LogSignature[] = []): LogSignature[] {
  const out: LogSignature[] = []
  const seen = new Set<string>()
  for (const sig of [...SIGNATURES, ...extra]) {
    if (seen.has(sig.kind)) continue
    if (sig.pattern.test(message)) {
      out.push(sig)
      seen.add(sig.kind)
    }
  }
  return out
}
