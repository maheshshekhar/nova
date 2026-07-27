import { describe, expect, it, vi } from "vitest"
import { decisionToAlert } from "@/lib/sentinel/incident"
import { collectSignals } from "@/lib/sentinel/pipeline"
import { HttpAlertSink } from "@/lib/sentinel/sink"
import { Correlator } from "@/lib/sentinel/correlate"
import type { IncidentDecision } from "@/lib/sentinel/correlate"
import type { Signal } from "@/lib/sentinel/signal"

const sig = (over: Partial<Signal> & { kind: string; hard: boolean }): Signal => ({
  service: "checkout",
  namespace: "prod",
  severity: over.hard ? "critical" : "warning",
  message: `${over.kind} evidence`,
  source: { kind: "Pod", name: "checkout-abc" },
  ...over,
})

const decision = (over: Partial<IncidentDecision> & { signals: Signal[] }): IncidentDecision => ({
  service: "checkout",
  namespace: "prod",
  severity: "critical",
  confidence: 0.9,
  reason: "test",
  ...over,
})

describe("decisionToAlert", () => {
  it("maps a hard CrashLoop decision to an /api/alerts payload with the right failure_type + severity", () => {
    const a = decisionToAlert(decision({ signals: [sig({ kind: "CrashLoopBackOff", hard: true })] }), 0)
    expect(a.labels).toMatchObject({ service: "checkout", severity: "critical", failure_type: "CrashLoopBackOff", source: "nova-sentinel" })
    expect(a.status).toBe("firing")
    expect(a.annotations.summary).toContain("CrashLoopBackOff")
    expect(a.annotations.description).toContain("confidence 90%")
    expect(a.startsAt).toBe(new Date(0).toISOString())
  })

  it("maps OOMKilled/CreateContainerConfigError/FailedMount to their failure types", () => {
    expect(decisionToAlert(decision({ signals: [sig({ kind: "OOMKilled", hard: true })] })).labels.failure_type).toBe("OOMKilled")
    expect(decisionToAlert(decision({ signals: [sig({ kind: "CreateContainerConfigError", hard: true })] })).labels.failure_type).toBe("config-missing")
    expect(decisionToAlert(decision({ signals: [sig({ kind: "FailedMount", hard: true })] })).labels.failure_type).toBe("secret-missing")
  })

  it("soft-confirmed (warning) decisions map to high severity", () => {
    const a = decisionToAlert(decision({ severity: "warning", confidence: 0.6, signals: [sig({ kind: "ProbeFailure", hard: false }), sig({ kind: "HighRestarts", hard: false })] }))
    expect(a.labels.severity).toBe("high")
    expect(a.labels.failure_type).toBe("probe-failure") // first (non-hard) signal
  })

  it("prefers a HARD signal as the primary cause when both are present", () => {
    const a = decisionToAlert(decision({ signals: [sig({ kind: "HighRestarts", hard: false }), sig({ kind: "OOMKilled", hard: true })] }))
    expect(a.labels.failure_type).toBe("OOMKilled")
  })

  it("includes every signal as evidence in the description", () => {
    const a = decisionToAlert(decision({ signals: [sig({ kind: "CrashLoopBackOff", hard: true }), sig({ kind: "HighRestarts", hard: false })] }))
    expect(a.annotations.description).toContain("- CrashLoopBackOff:")
    expect(a.annotations.description).toContain("- HighRestarts:")
  })
})

describe("collectSignals → Correlator (end-to-end, no cluster)", () => {
  it("a crashing pod flows through to a critical incident decision", () => {
    const pods: any[] = [
      { metadata: { name: "checkout-x", namespace: "prod", labels: { app: "checkout" } }, status: { containerStatuses: [{ name: "app", state: { waiting: { reason: "CrashLoopBackOff" } } }] } },
    ]
    const signals = collectSignals({ pods })
    expect(signals.map((s) => s.kind)).toContain("CrashLoopBackOff")

    const c = new Correlator({ now: () => 1000 })
    const [d] = c.ingest(signals)
    expect(d).toMatchObject({ service: "checkout", severity: "critical" })
  })

  it("resolves event service via the resolver and collects it", () => {
    const events: any[] = [
      { reason: "FailedMount", message: "secret x not found", involvedObject: { kind: "Pod", name: "checkout-x", namespace: "prod" } },
    ]
    const signals = collectSignals({ events }, () => "checkout")
    expect(signals[0]).toMatchObject({ kind: "FailedMount", service: "checkout" })
  })
})

describe("HttpAlertSink", () => {
  it("POSTs the alerts batch to /api/alerts", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({ ok: true }) as Response)
    const sink = new HttpAlertSink("http://nova:3000/", fetchImpl)
    const alert = decisionToAlert(decision({ signals: [sig({ kind: "OOMKilled", hard: true })] }))
    await sink.post([alert])
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe("http://nova:3000/api/alerts")
    expect((init as RequestInit).method).toBe("POST")
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ alerts: [alert] })
  })

  it("no-ops on an empty batch (no request)", async () => {
    const fetchImpl = vi.fn()
    await new HttpAlertSink("http://nova:3000", fetchImpl as any).post([])
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("throws on a non-OK response", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({ ok: false, status: 503 }) as Response)
    const alert = decisionToAlert(decision({ signals: [sig({ kind: "OOMKilled", hard: true })] }))
    await expect(new HttpAlertSink("http://nova:3000", fetchImpl).post([alert])).rejects.toThrow(/503/)
  })
})
