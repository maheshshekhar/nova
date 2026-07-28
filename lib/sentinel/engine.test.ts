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

