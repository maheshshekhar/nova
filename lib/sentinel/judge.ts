import type { AmbiguousCluster } from "./correlate"

// On-demand AI judgment for AMBIGUOUS soft-signal clusters.
//
// When a service accumulates SOME soft corroboration but not enough distinct
// kinds to auto-confirm (the Correlator's `ambiguous` output), an optional judge
// reasons over the signals THAT EXIST and decides whether they collectively
// indicate a real incident right now. It is precision-first and strictly bounded:
//   • it never invents signals — it may only reason over the evidence it is given,
//   • any missing key / provider error / unparseable reply ⇒ DENY (hold, no
//     incident), so a broken judge can never manufacture false incidents.
// The interface is pure + injectable; the concrete transport (HttpSignalJudge)
// keeps the AI keys inside the Nova app (the companion posts to a Nova endpoint,
// mirroring HttpAlertSink), so the standalone worker never needs an AI key.

export interface JudgeSignal {
  kind: string
  severity: string
  hard: boolean
  message: string
}

export interface JudgeInput {
  service: string
  namespace: string
  signals: JudgeSignal[]
}

export interface JudgeVerdict {
  /** Whether the signals collectively indicate a real, actionable incident now. */
  confirm: boolean
  /** 0..1 — the judge's confidence in `confirm`. */
  confidence: number
  /** One-line rationale, grounded only in the supplied signals. */
  reason: string
}

export interface SignalJudge {
  judge(input: JudgeInput): Promise<JudgeVerdict>
}

/** Precision-first default: when anything goes wrong, we hold (never open). */
export const DENY: JudgeVerdict = { confirm: false, confidence: 0, reason: "judge unavailable" }

/** Map an ambiguous cluster into the minimal, self-contained judge input. */
export function toJudgeInput(cluster: AmbiguousCluster): JudgeInput {
  return {
    service: cluster.service,
    namespace: cluster.namespace,
    signals: cluster.signals.map((s) => ({
      kind: s.kind,
      severity: s.severity,
      hard: s.hard,
      message: s.message,
    })),
  }
}

export const JUDGE_SYSTEM = [
  "You are a precision-first incident judge for a Kubernetes observability system.",
  "You are given the ONLY signals observed for a single service in a short window.",
  "These signals corroborate weakly — not enough to auto-open an incident — so a human-grade",
  "judgment is needed. Decide whether, taken together, they indicate a REAL, actionable",
  "incident happening RIGHT NOW.",
  "",
  "Hard rules:",
  "- Reason ONLY over the signals provided. Never assume or invent any signal not listed.",
  "- Bias toward NOT confirming. A false incident costs money and trust; when in doubt, hold.",
  "- Transient or isolated noise (a single restart, one probe blip) is NOT an incident.",
  "- Confirm only when the signals genuinely reinforce one plausible failure story.",
  "",
  'Respond with STRICT JSON only, no prose: {"confirm": boolean, "confidence": number 0..1, "reason": "one line"}.',
].join("\n")

export function buildJudgePrompt(input: JudgeInput): string {
  const lines = input.signals.map(
    (s) => `- ${s.kind} [${s.severity}${s.hard ? ", hard" : ""}]: ${s.message}`
  )
  return [
    `Service: ${input.service}`,
    `Namespace: ${input.namespace}`,
    `Observed signals (${input.signals.length}):`,
    ...lines,
    "",
    "Do these signals indicate a real incident right now?",
  ].join("\n")
}

/** Coerce an arbitrary object (parsed JSON or an HTTP body) into a safe verdict.
 * Unknown/invalid shapes degrade to DENY. */
export function coerceVerdict(obj: unknown): JudgeVerdict {
  if (!obj || typeof obj !== "object") return DENY
  const o = obj as Record<string, unknown>
  const confirm = o.confirm === true
  const rawConf = typeof o.confidence === "number" && Number.isFinite(o.confidence) ? o.confidence : 0
  const confidence = Math.max(0, Math.min(1, rawConf))
  const reason = typeof o.reason === "string" && o.reason.trim() ? o.reason.trim() : "no reason given"
  return { confirm, confidence, reason }
}

/** Parse a model's text reply into a verdict. Extracts the first JSON object and
 * coerces it; any failure ⇒ DENY (hold). */
export function parseJudgeVerdict(text: string): JudgeVerdict {
  if (!text) return DENY
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start === -1 || end === -1 || end <= start) return DENY
  try {
    return coerceVerdict(JSON.parse(text.slice(start, end + 1)))
  } catch {
    return DENY
  }
}

/** Posts the ambiguous cluster to Nova's `/api/sentinel/judge` (which owns the AI
 * key) and returns the verdict. Any transport/HTTP failure ⇒ DENY. */
export class HttpSignalJudge implements SignalJudge {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async judge(input: JudgeInput): Promise<JudgeVerdict> {
    const url = `${this.baseUrl.replace(/\/$/, "")}/api/sentinel/judge`
    try {
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      })
      if (!res.ok) return DENY
      return coerceVerdict(await res.json())
    } catch {
      return DENY
    }
  }
}
