import { describe, expect, it, vi } from "vitest"
import { SentinelEngine } from "@/lib/sentinel/engine"
import { PodServiceIndex } from "@/lib/sentinel/service-index"
import { Correlator } from "@/lib/sentinel/correlate"
import { AbsenceMonitor } from "@/lib/sentinel/business/absence"
import { LogAnalyzer } from "@/lib/sentinel/logs/analyzer"
import type { IncidentSink } from "@/lib/sentinel/sink"
import type { SentinelAlert } from "@/lib/sentinel/incident"

function crashingPod(name = "checkout-x", app = "checkout", ns = "prod"): any {
  return {
    metadata: { name, namespace: ns, labels: { app } },
    status: { phase: "Running", containerStatuses: [{ name: "app", ready: false, state: { waiting: { reason: "CrashLoopBackOff" } } }] },
  }
}

function healthyPod(name = "checkout-x", app = "checkout", ns = "prod"): any {
  return {
    metadata: { name, namespace: ns, labels: { app } },
    status: { phase: "Running", containerStatuses: [{ name: "app", ready: true, state: { running: {} } }] },
  }
}

function collectingSink(): IncidentSink & { posted: SentinelAlert[] } {
  const posted: SentinelAlert[] = []
  return { posted, async post(alerts) { posted.push(...alerts) } }
}

describe("PodServiceIndex", () => {
  it("resolves a pod's event to its app-label service, only for Pod kind", () => {
    const idx = new PodServiceIndex()
    idx.upsert({ metadata: { name: "checkout-abc", namespace: "prod", labels: { app: "checkout" } } })
    expect(idx.resolve("prod", "checkout-abc", "Pod")).toBe("checkout")
    expect(idx.resolve("prod", "checkout-abc", "ReplicaSet")).toBeUndefined()
    expect(idx.resolve("prod", "missing", "Pod")).toBeUndefined()
  })

  it("drops entries on remove", () => {
    const idx = new PodServiceIndex()
    const pod = { metadata: { name: "p", namespace: "prod", labels: { app: "svc" } } }
    idx.upsert(pod)
    expect(idx.size).toBe(1)
    idx.remove(pod)
    expect(idx.size).toBe(0)
  })
})

describe("SentinelEngine", () => {
  it("opens a critical incident when a crashing pod is observed", async () => {
    const sink = collectingSink()
    const engine = new SentinelEngine({ sink, now: () => 0 })
    await engine.onPod(crashingPod())
    expect(sink.posted).toHaveLength(1)
    expect(sink.posted[0].labels).toMatchObject({ service: "checkout", severity: "critical", failure_type: "CrashLoopBackOff" })
  })

  it("de-dupes a service (one incident) while it stays broken", async () => {
    const sink = collectingSink()
    const engine = new SentinelEngine({ sink })
    await engine.onPod(crashingPod())
    await engine.onPod(crashingPod())
    expect(sink.posted).toHaveLength(1)
  })

  it("resolves an event to its service via the pod index", async () => {
    const sink = collectingSink()
    // Two distinct soft kinds needed to confirm; feed a probe-failure event twice
    // is not enough (same kind) — pair it with a restart soft signal instead.
    const engine = new SentinelEngine({ sink, correlator: new Correlator({ softConfirmKinds: 1 }) })
    engine.index.upsert({ metadata: { name: "checkout-x", namespace: "prod", labels: { app: "checkout" } } })
    await engine.onEvent({ reason: "Unhealthy", message: "liveness probe failed", involvedObject: { kind: "Pod", name: "checkout-x", namespace: "prod" } })
    expect(sink.posted[0]?.labels).toMatchObject({ service: "checkout", failure_type: "probe-failure" })
  })

  it("dry-run logs and never posts", async () => {
    const sink = collectingSink()
    const logger = vi.fn()
    const engine = new SentinelEngine({ sink, dryRun: true, logger })
    await engine.onPod(crashingPod())
    expect(sink.posted).toHaveLength(0)
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("[dry-run]"))
  })

  it("re-arms detection after recovery (healthy pod → can flag again)", async () => {
    const sink = collectingSink()
    const engine = new SentinelEngine({ sink })
    await engine.onPod(crashingPod())
    expect(sink.posted).toHaveLength(1)
    await engine.onPod(healthyPod()) // recovery observed → resolve
    await engine.onPod(crashingPod()) // regression → flag again
    expect(sink.posted).toHaveLength(2)
  })

  it("does not flag a healthy pod", async () => {
    const sink = collectingSink()
    const engine = new SentinelEngine({ sink })
    await engine.onPod(healthyPod())
    expect(sink.posted).toHaveLength(0)
  })
})

describe("SentinelEngine.onLog", () => {
  it("opens an incident from a fatal log signature", async () => {
    const sink = collectingSink()
    const engine = new SentinelEngine({ sink })
    await engine.onLog({ service: "checkout", namespace: "prod", message: "panic: runtime error: invalid memory address", pod: "checkout-x" })
    expect(sink.posted).toHaveLength(1)
    expect(sink.posted[0].labels).toMatchObject({ service: "checkout", severity: "critical", failure_type: "bad-deploy" })
  })

  it("maps a DB-pool log signature to the db-pool-exhaustion failure type", async () => {
    const sink = collectingSink()
    const engine = new SentinelEngine({ sink })
    await engine.onLog({ service: "orders", message: "FATAL: remaining connection slots are reserved" })
    expect(sink.posted[0]?.labels.failure_type).toBe("db-pool-exhaustion")
  })

  it("ordinary log lines produce no incident", async () => {
    const sink = collectingSink()
    const engine = new SentinelEngine({ sink })
    await engine.onLog({ service: "checkout", message: "GET /health 200 OK" })
    expect(sink.posted).toHaveLength(0)
  })

  it("dry-run does not post log-derived incidents", async () => {
    const sink = collectingSink()
    const engine = new SentinelEngine({ sink, dryRun: true, logger: vi.fn() })
    await engine.onLog({ service: "checkout", message: "panic: boom" })
    expect(sink.posted).toHaveLength(0)
  })
})

describe("SentinelEngine.tick (absence detection)", () => {
  it("opens a SuccessDrop incident when a success signal collapses", async () => {
    const MIN = 60_000
    const absence = new AbsenceMonitor({ match: { pattern: "checkout complete" }, minBaselineBuckets: 5, minBaseline: 10, dropFactor: 5, label: "checkouts" })
    const sink = collectingSink()
    const engine = new SentinelEngine({ sink, analyzer: new LogAnalyzer({ absence }) })
    // 6 healthy minutes of success logs, then silence.
    for (let b = 0; b < 6; b++) {
      for (let i = 0; i < 50; i++) {
        await engine.onLog({ service: "checkout", namespace: "prod", message: "checkout complete", level: "info", at: b * MIN + i })
      }
    }
    // Advance the clock to the next bucket and tick.
    ;(engine as unknown as { now: () => number }).now = () => 7 * MIN
    await engine.tick()
    expect(sink.posted).toHaveLength(1)
    expect(sink.posted[0].labels).toMatchObject({ service: "checkout", severity: "critical", failure_type: "latency-slo" })
  })
})

describe("SentinelEngine production-safety guards", () => {
  it("mutes configured services (no incident opened)", async () => {
    const sink = collectingSink()
    const engine = new SentinelEngine({ sink, mute: ["load-generator"] })
    await engine.onPod(crashingPod("lg-x", "load-generator"))
    expect(sink.posted).toHaveLength(0)
    // A non-muted service still flags.
    await engine.onPod(crashingPod("checkout-x", "checkout"))
    expect(sink.posted).toHaveLength(1)
  })

  it("storm control caps new incidents per window", async () => {
    const sink = collectingSink()
    let t = 0
    const engine = new SentinelEngine({ sink, maxIncidentsPerWindow: 2, rateWindowMs: 60_000, now: () => t })
    for (const svc of ["a", "b", "c", "d"]) {
      await engine.onPod(crashingPod(`${svc}-x`, svc))
    }
    expect(sink.posted).toHaveLength(2) // c and d suppressed
    // After the window rolls over, the cap refills.
    t = 61_000
    await engine.onPod(crashingPod("e-x", "e"))
    expect(sink.posted).toHaveLength(3)
  })

  it("startup grace suppresses incidents during the initial window", async () => {
    const sink = collectingSink()
    let t = 1000
    const engine = new SentinelEngine({ sink, startupGraceMs: 30_000, now: () => t })
    await engine.onPod(crashingPod("checkout-x", "checkout"))
    expect(sink.posted).toHaveLength(0) // within grace
    // Past the grace window, a fresh signal opens an incident.
    t = 40_000
    await engine.onPod(crashingPod("orders-x", "orders"))
    expect(sink.posted).toHaveLength(1)
  })
})

describe("SentinelEngine leading indicators", () => {
  function podWithMemLimit(name = "svc-x", app = "svc", ns = "prod", limit = "100Mi"): any {
    return {
      metadata: { name, namespace: ns, labels: { app } },
      spec: { containers: [{ name: "app", resources: { limits: { memory: limit } } }] },
      status: { phase: "Running", containerStatuses: [{ name: "app", ready: true, state: { running: {} } }] },
    }
  }

  it("opens a MemoryPressureRising incident when usage climbs toward the limit", async () => {
    const MB = 1024 * 1024
    const sink = collectingSink()
    let t = 0
    // MemoryPressureRising is a SOFT (corroborating) signal; use a 1-kind confirm
    // correlator so this test exercises the onPod→limit→onMemory→incident wiring.
    const engine = new SentinelEngine({ sink, correlator: new Correlator({ softConfirmKinds: 1 }), now: () => t })
    await engine.onPod(podWithMemLimit()) // records the 100Mi limit
    // climbing high + rising: 86% -> 92% -> 96%
    await engine.onMemory("prod", "svc", "svc-x", "app", 86 * MB)
    t = 60_000
    await engine.onMemory("prod", "svc", "svc-x", "app", 92 * MB)
    t = 120_000
    await engine.onMemory("prod", "svc", "svc-x", "app", 96 * MB)
    expect(sink.posted).toHaveLength(1)
    expect(sink.posted[0].labels).toMatchObject({ service: "svc", failure_type: "memory-leak" })
  })

  it("ignores memory for containers without a known limit", async () => {
    const sink = collectingSink()
    const engine = new SentinelEngine({ sink })
    // no onPod → no limit recorded
    await engine.onMemory("prod", "svc", "svc-x", "app", 999 * 1024 * 1024)
    expect(sink.posted).toHaveLength(0)
  })
})

describe("SentinelEngine — on-demand AI judgment of ambiguous soft clusters", () => {
  // A single probe-failure event is ONE distinct soft kind — below the default
  // softConfirmKinds (2), so it never auto-opens but IS surfaced as ambiguous.
  function probeEvent(): any {
    return { reason: "Unhealthy", message: "liveness probe failed", involvedObject: { kind: "Pod", name: "checkout-x", namespace: "prod" } }
  }
  function stubJudge(verdict: { confirm: boolean; confidence: number; reason: string }) {
    return { judge: vi.fn(async () => verdict) }
  }

  it("does nothing to ambiguous clusters when no judge is configured (today's behaviour)", async () => {
    const sink = collectingSink()
    const engine = new SentinelEngine({ sink })
    engine.index.upsert({ metadata: { name: "checkout-x", namespace: "prod", labels: { app: "checkout" } } })
    await engine.onEvent(probeEvent())
    await engine.whenIdle()
    expect(sink.posted).toHaveLength(0)
  })

  it("opens a judged incident when the judge confirms with enough confidence", async () => {
    const sink = collectingSink()
    const judge = stubJudge({ confirm: true, confidence: 0.8, reason: "restarts + probe = crash" })
    const engine = new SentinelEngine({ sink, judge, now: () => 0 })
    engine.index.upsert({ metadata: { name: "checkout-x", namespace: "prod", labels: { app: "checkout" } } })
    await engine.onEvent(probeEvent())
    await engine.whenIdle()
    expect(judge.judge).toHaveBeenCalledTimes(1)
    expect(sink.posted).toHaveLength(1)
    expect(sink.posted[0].labels).toMatchObject({ service: "checkout", source: "nova-sentinel" })
    expect(sink.posted[0].annotations.nova_judged).toBe("true")
    expect(sink.posted[0].annotations.nova_confidence).toBe("0.80")
  })

  it("holds (no incident) when the judge declines", async () => {
    const sink = collectingSink()
    const judge = stubJudge({ confirm: false, confidence: 0, reason: "transient blip" })
    const engine = new SentinelEngine({ sink, judge })
    engine.index.upsert({ metadata: { name: "checkout-x", namespace: "prod", labels: { app: "checkout" } } })
    await engine.onEvent(probeEvent())
    await engine.whenIdle()
    expect(judge.judge).toHaveBeenCalledTimes(1)
    expect(sink.posted).toHaveLength(0)
  })

  it("holds when the judge confirms but below the minimum confidence", async () => {
    const sink = collectingSink()
    const judge = stubJudge({ confirm: true, confidence: 0.4, reason: "maybe" })
    const engine = new SentinelEngine({ sink, judge, minJudgeConfidence: 0.6 })
    engine.index.upsert({ metadata: { name: "checkout-x", namespace: "prod", labels: { app: "checkout" } } })
    await engine.onEvent(probeEvent())
    await engine.whenIdle()
    expect(sink.posted).toHaveLength(0)
  })

  it("never judges a hard signal (it auto-opens; the judge is not consulted)", async () => {
    const sink = collectingSink()
    const judge = stubJudge({ confirm: true, confidence: 0.9, reason: "x" })
    const engine = new SentinelEngine({ sink, judge })
    await engine.onPod(crashingPod())
    await engine.whenIdle()
    expect(judge.judge).not.toHaveBeenCalled()
    expect(sink.posted).toHaveLength(1) // the hard CrashLoop incident, un-judged
    expect(sink.posted[0].annotations.nova_judged).toBeUndefined()
  })

  it("caps judge calls per window (cost/storm guard)", async () => {
    const sink = collectingSink()
    const judge = stubJudge({ confirm: false, confidence: 0, reason: "held" })
    const engine = new SentinelEngine({ sink, judge, maxJudgementsPerWindow: 1, rateWindowMs: 60_000, now: () => 0 })
    engine.index.upsert({ metadata: { name: "a-x", namespace: "prod", labels: { app: "a" } } })
    engine.index.upsert({ metadata: { name: "b-x", namespace: "prod", labels: { app: "b" } } })
    await engine.onEvent({ reason: "Unhealthy", message: "liveness probe failed", involvedObject: { kind: "Pod", name: "a-x", namespace: "prod" } })
    await engine.onEvent({ reason: "Unhealthy", message: "liveness probe failed", involvedObject: { kind: "Pod", name: "b-x", namespace: "prod" } })
    await engine.whenIdle()
    expect(judge.judge).toHaveBeenCalledTimes(1) // second service exceeded the cap
  })
})

