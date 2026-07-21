import "server-only"
import type { IncidentRecord } from "../incident-types"
import type { EvalCase, EvalExpectations } from "./cases"
import {
  runDeterministicChecks,
  runJudge,
  combineScore,
  type CaseResult,
} from "./judge"

// Incident-grounded eval.
//
// Unlike the golden cases (which GENERATE fresh output from fixed inputs), this
// grades the RCA a human already APPROVED for a real resolved incident — the exact
// document the audience saw. It scores that persisted RCA against the incident's
// real log snapshot: primarily groundedness / hallucination / format (which need
// no hand-labels), plus deterministic must-include checks derived from the
// incident's failure type where we have a known-correct signature.

const RCA_SECTIONS = ["Executive Summary", "Root Cause", "Timeline", "Action Items"]

// Per-failure-type grading hints. `root` / `remediation` are terms a correct RCA
// for this failure MUST reference; `forbidden` are signatures of *other* failure
// modes whose presence would signal the model drifted off the real evidence.
const HINTS: Record<string, { root: string[]; remediation: string[]; forbidden: string[] }> = {
  "db-pool-exhaustion": { root: ["connection pool", "exhaust"], remediation: ["scale"], forbidden: ["memory leak", "OOMKilled", "DNS"] },
  OOMKilled: { root: ["memory", "limit"], remediation: ["memory"], forbidden: ["connection pool", "DNS", "TLS certificate"] },
  CrashLoopBackOff: { root: ["startup"], remediation: ["config"], forbidden: ["memory leak", "connection pool"] },
  "config-missing": { root: ["config"], remediation: ["config"], forbidden: ["OOMKilled", "connection pool"] },
  "secret-missing": { root: ["secret"], remediation: ["secret"], forbidden: ["OOMKilled", "connection pool"] },
  "probe-failure": { root: ["probe"], remediation: ["probe"], forbidden: ["OOMKilled", "connection pool exhausted"] },
  "tls-cert-expiry": { root: ["certificate"], remediation: ["certificate"], forbidden: ["OOMKilled", "connection pool"] },
  "image-pull": { root: ["image"], remediation: ["image"], forbidden: ["memory leak", "connection pool"] },
}

// Derive gradeable expectations from what the incident record already tells us.
// For failure types without a known signature we fall back to empty must-include
// lists (those deterministic checks then auto-pass), and rely on the LLM judge's
// evidence-grounded dimensions instead.
function deriveExpectations(inc: IncidentRecord): EvalExpectations {
  const h = HINTS[inc.failureType]
  return {
    rootCauseMustInclude: h?.root ?? [],
    remediationMustInclude: h?.remediation ?? [],
    // Placeholder tokens are always a hallucination/format failure regardless of type.
    forbiddenClaims: [...(h?.forbidden ?? []), "[date]", "[time]"],
    requiredSections: RCA_SECTIONS,
  }
}

// Turn a resolved incident into an EvalCase whose `logs` are the incident's REAL
// evidence and whose expectations are derived from its failure type.
export function buildIncidentEvalCase(inc: IncidentRecord): EvalCase {
  const snap = inc.rca?.logsSnapshot
  const logs =
    snap && snap.length
      ? snap.map((l) => `${l.timestamp} ${l.level} [${l.pod}] ${l.message}`)
      : inc.relatedLogs.map((l) => `${l.timestamp} ${l.level} ${l.message}`)

  const context = inc.rca?.context?.trim()
    ? inc.rca.context
    : [
        `${inc.id}: ${inc.title}.`,
        `Service: ${inc.service}. Severity: ${inc.severity}. Users affected: ${inc.affectedUsers.toLocaleString()}.`,
        inc.durationMin != null ? `Total incident duration: ${inc.durationMin} minute(s).` : "",
        `Description: ${inc.description}`,
        `Customer impact is measured as failed checkout transactions (HTTP 503) during the incident window; a failed-transaction count consistent with the affected figure above is expected and grounded.`,
        inc.failureType === "db-pool-exhaustion"
          ? `Known remediation for this failure: the sustained checkout load is driven by a load-generator (k6) Job in the production namespace; resolution is to stop that Job and scale ${inc.service} from 3 to 6 replicas, restoring Postgres connection-pool headroom.`
          : "",
      ]
        .filter(Boolean)
        .join("\n")

  return {
    id: `incident:${inc.id}`,
    title: `${inc.id} — ${inc.title}`,
    failureType: inc.failureType,
    mode: "rca",
    logs,
    context,
    expectations: deriveExpectations(inc),
  }
}

// Grade the incident's ALREADY-APPROVED RCA (does NOT regenerate). Deterministic
// checks + LLM-as-judge, same scoring path as the golden cases so results are
// directly comparable in the eval history.
export async function runIncidentEval(inc: IncidentRecord): Promise<CaseResult> {
  const c = buildIncidentEvalCase(inc)
  const output = inc.rca?.text ?? ""

  const deterministic = runDeterministicChecks(c, output)
  let judge = null
  try {
    judge = await runJudge(c, output)
  } catch {
    // Judge failure shouldn't void the eval — fall back to deterministic-only.
    judge = null
  }
  const overall = combineScore(deterministic, judge)

  return { caseId: c.id, title: c.title, mode: c.mode, output, deterministic, judge, overall }
}
