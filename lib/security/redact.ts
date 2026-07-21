// Egress redaction. Before any log text is sent to an LLM (or shown in the UI),
// scrub high-confidence secrets and PII so credentials that leaked into logs are
// never forwarded to a third-party model. Conservative by design — only patterns
// with a low false-positive rate — so ordinary operational log lines are
// untouched. Pure + dependency-free.

interface Rule {
  re: RegExp
  replacement: string
}

const RULES: Rule[] = [
  // Provider API keys (OpenAI/OpenRouter/Anthropic style: sk-..., sk-ant-...).
  { re: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g, replacement: "[REDACTED_API_KEY]" },
  // GitHub tokens.
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, replacement: "[REDACTED_TOKEN]" },
  // AWS access key id.
  { re: /\bAKIA[0-9A-Z]{16}\b/g, replacement: "[REDACTED_AWS_KEY]" },
  // Bearer tokens in Authorization headers.
  { re: /\bBearer\s+[A-Za-z0-9._-]{20,}/g, replacement: "Bearer [REDACTED_TOKEN]" },
  // JWTs (three base64url segments).
  {
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    replacement: "[REDACTED_JWT]",
  },
  // key=value secrets (password / api_key / token / secret).
  {
    re: /\b(password|passwd|pwd|api[_-]?key|secret|token)\b(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi,
    replacement: "$1$2[REDACTED]",
  },
  // Email addresses (PII).
  {
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    replacement: "[REDACTED_EMAIL]",
  },
]

/** Redact secrets/PII from a single string. Returns the input unchanged when it
 * contains nothing sensitive. */
export function redactSecrets(text: string): string {
  let out = text
  for (const { re, replacement } of RULES) {
    out = out.replace(re, replacement)
  }
  return out
}
