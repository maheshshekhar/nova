import { describe, expect, it } from "vitest"
import { Correlator } from "@/lib/sentinel/correlate"
import type { Signal } from "@/lib/sentinel/signal"

function sig(over: Partial<Signal> & { kind: string; hard: boolean }): Signal {
  return {
    service: "checkout",
    namespace: "prod",
    severity: over.hard ? "critical" : "warning",
    message: `${over.kind} evidence`,
    source: { kind: "Pod", name: "checkout-abc" },
    ...over,
  }
}

describe("Correlator — hard signals open immediately", () => {
  it("a single hard signal opens a critical incident with high confidence + evidence", () => {
    const c = new Correlator({ now: () => 1000 })
    const [d] = c.ingest([sig({ kind: "CrashLoopBackOff", hard: true })])
    expect(d).toMatchObject({ service: "checkout", namespace: "prod", severity: "critical", confidence: 0.9 })
    expect(d.reason).toContain("CrashLoopBackOff")
    expect(d.signals).toHaveLength(1)
  })
})

describe("Correlator — soft signals need corroboration", () => {
  it("a single soft signal does NOT open an incident (candidate only)", () => {
    const c = new Correlator({ now: () => 1000 })
    expect(c.ingest([sig({ kind: "HighRestarts", hard: false })])).toEqual([])
  })

  it("two of the SAME soft kind still do not confirm (needs distinct kinds)", () => {
    const c = new Correlator({ softConfirmKinds: 2, now: () => 1000 })
    c.ingest([sig({ kind: "HighRestarts", hard: false })])
    expect(c.ingest([sig({ kind: "HighRestarts", hard: false })])).toEqual([])
  })

  it("two DISTINCT soft kinds confirm → warning incident, medium confidence", () => {
    const c = new Correlator({ softConfirmKinds: 2, now: () => 1000 })
    c.ingest([sig({ kind: "HighRestarts", hard: false })])
    const [d] = c.ingest([sig({ kind: "ProbeFailure", hard: false })])
    expect(d).toMatchObject({ severity: "warning", confidence: 0.6 })
    expect(d.reason).toContain("HighRestarts")
    expect(d.reason).toContain("ProbeFailure")
  })
})

describe("Correlator — dedup, window, resolve", () => {
  it("dedupes: a second batch while an incident is open yields no new decision", () => {
    const c = new Correlator({ now: () => 1000 })
    expect(c.ingest([sig({ kind: "OOMKilled", hard: true })])).toHaveLength(1)
    expect(c.ingest([sig({ kind: "CrashLoopBackOff", hard: true })])).toEqual([])
  })

  it("expires signals outside the rolling window (no false confirm)", () => {
    const c = new Correlator({ windowMs: 1000, softConfirmKinds: 2 })
    c.ingest([sig({ kind: "HighRestarts", hard: false })], 0)
    // second soft arrives after the window → the first is pruned → only 1 in window
    expect(c.ingest([sig({ kind: "ProbeFailure", hard: false })], 2000)).toEqual([])
  })

  it("resolve() lets a service flag again after recovery", () => {
    const c = new Correlator({ now: () => 1000 })
    expect(c.ingest([sig({ kind: "OOMKilled", hard: true })])).toHaveLength(1)
    expect(c.ingest([sig({ kind: "OOMKilled", hard: true })])).toEqual([]) // deduped
    c.resolve("prod", "checkout")
    expect(c.ingest([sig({ kind: "OOMKilled", hard: true })])).toHaveLength(1) // flags again
  })

  it("tracks services independently", () => {
    const c = new Correlator({ now: () => 1000 })
    const decisions = c.ingest([
      sig({ kind: "CrashLoopBackOff", hard: true, service: "a" }),
      sig({ kind: "CrashLoopBackOff", hard: true, service: "b" }),
    ])
    expect(decisions.map((d) => d.service).sort()).toEqual(["a", "b"])
  })
})
