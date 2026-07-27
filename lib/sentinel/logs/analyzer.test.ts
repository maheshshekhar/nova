import { describe, expect, it } from "vitest"
import { templatize, LogTemplateMiner } from "@/lib/sentinel/logs/template"
import { matchSignatures, SIGNATURES } from "@/lib/sentinel/logs/signatures"
import { LogAnalyzer } from "@/lib/sentinel/logs/analyzer"

describe("templatize", () => {
  it("masks variable tokens so structurally-equal lines share a template", () => {
    const a = templatize('GET /orders/1837 took 42ms from 10.1.2.3:5678')
    const b = templatize('GET /orders/9902 took 7ms from 10.9.8.7:1234')
    expect(a).toBe(b)
    expect(a).toContain("<NUM>")
    expect(a).toContain("<IP>")
  })

  it("masks UUIDs, timestamps, hex and quoted strings", () => {
    const t = templatize('2026-07-27T10:00:00Z user 3f2504e0-4f89-41d3-9a0c-0305e82c3301 token 0xdeadbeef said "hello world"')
    expect(t).toContain("<TS>")
    expect(t).toContain("<UUID>")
    expect(t).toContain("<HEX>")
    expect(t).toContain("<STR>")
    expect(t).not.toMatch(/hello world/)
  })

  it("keeps distinct static text in distinct templates", () => {
    expect(templatize("cache miss for key 12")).not.toBe(templatize("cache hit for key 12"))
  })
})

describe("LogTemplateMiner", () => {
  it("learns silently during warm-up, then flags a never-seen template as novel", () => {
    const miner = new LogTemplateMiner({ warmupLines: 3, now: () => 0 })
    // warm-up: same shape 3 times → learned, never novel
    expect(miner.observe("svc", "request 1 ok").novel).toBe(false)
    expect(miner.observe("svc", "request 2 ok").novel).toBe(false)
    expect(miner.observe("svc", "request 3 ok").novel).toBe(false)
    // past warm-up, a brand-new shape is novel
    const obs = miner.observe("svc", "connection to db pool timed out after 30s")
    expect(obs.novel).toBe(true)
    // a repeat of that shape is no longer novel
    expect(miner.observe("svc", "connection to db pool timed out after 5s").novel).toBe(false)
  })

  it("tracks templates independently per service", () => {
    const miner = new LogTemplateMiner({ warmupLines: 0 })
    miner.observe("a", "hello 1")
    miner.observe("b", "hello 2")
    expect(miner.templateCount("a")).toBe(1)
    expect(miner.templateCount("b")).toBe(1)
  })

  it("evicts the least-recently-seen template past the cap", () => {
    const miner = new LogTemplateMiner({ warmupLines: 0, maxTemplatesPerService: 2 })
    miner.observe("svc", "alpha", 1)
    miner.observe("svc", "beta", 2)
    miner.observe("svc", "gamma", 3) // evicts "alpha" (oldest)
    expect(miner.templateCount("svc")).toBe(2)
  })
})

describe("matchSignatures", () => {
  it("matches hard runtime failures across formats", () => {
    expect(matchSignatures("panic: runtime error: invalid memory address").map((s) => s.kind)).toContain("Panic")
    expect(matchSignatures("java.lang.OutOfMemoryError: Java heap space").map((s) => s.kind)).toContain("OutOfMemory")
    const oom = matchSignatures("cannot allocate memory")[0]
    expect(oom).toMatchObject({ hard: true, severity: "critical", category: "runtime" })
  })

  it("matches database and network signatures", () => {
    expect(matchSignatures("FATAL: remaining connection slots are reserved").map((s) => s.kind)).toContain("DBPoolExhausted")
    expect(matchSignatures("dial tcp 10.0.0.5:5432: connect: connection refused").map((s) => s.kind)).toContain("ConnRefused")
    expect(matchSignatures("context deadline exceeded").map((s) => s.kind)).toContain("NetTimeout")
  })

  it("is conservative about HTTP 5xx (needs status context, not any 5xx number)", () => {
    expect(matchSignatures("processed 512 records in batch")).toHaveLength(0)
    expect(matchSignatures('GET /api "HTTP/1.1" 503').map((s) => s.kind)).toContain("HTTP5xx")
  })

  it("does not match ordinary healthy lines", () => {
    expect(matchSignatures("GET /health 200 OK 3ms")).toHaveLength(0)
    expect(matchSignatures("user logged in successfully")).toHaveLength(0)
  })

  it("accepts deployment-supplied extra signatures", () => {
    const extra = [{ kind: "PaymentDeclined", category: "database" as const, severity: "warning" as const, hard: false, pattern: /payment declined/i }]
    expect(matchSignatures("payment declined by gateway", extra).map((s) => s.kind)).toContain("PaymentDeclined")
  })

  it("every built-in signature has a unique kind", () => {
    expect(new Set(SIGNATURES.map((s) => s.kind)).size).toBe(SIGNATURES.length)
  })
})

describe("LogAnalyzer", () => {
  it("emits a hard signal for a fatal signature", () => {
    const a = new LogAnalyzer({ now: () => 0 })
    const [sig] = a.observe({ service: "checkout", namespace: "prod", message: "panic: nil pointer dereference", pod: "checkout-x" })
    expect(sig).toMatchObject({ kind: "Log:Panic", hard: true, severity: "critical", service: "checkout", namespace: "prod" })
    expect(sig.source).toEqual({ kind: "Log", name: "checkout-x" })
  })

  it("emits a soft novelty signal for a new pattern after warm-up", () => {
    const a = new LogAnalyzer({ miner: new LogTemplateMiner({ warmupLines: 1 }), now: () => 0 })
    a.observe({ service: "svc", message: "ordinary line 1" })
    const signals = a.observe({ service: "svc", message: "brand new never seen shape zzz" })
    const novelty = signals.find((s) => s.kind === "LogNovelty")
    expect(novelty).toMatchObject({ hard: false, severity: "warning" })
  })

  it("healthy lines produce no signals", () => {
    const a = new LogAnalyzer({ miner: new LogTemplateMiner({ warmupLines: 100 }) })
    expect(a.observe({ service: "svc", message: "GET /health 200 OK" })).toHaveLength(0)
  })

  it("a novelty + a soft signature give two distinct soft kinds (correlator-confirmable)", () => {
    const a = new LogAnalyzer({ miner: new LogTemplateMiner({ warmupLines: 1 }) })
    a.observe({ service: "svc", message: "warmup" })
    const signals = a.observe({ service: "svc", message: "upstream connection reset by peer on retry" })
    const kinds = signals.map((s) => s.kind)
    expect(kinds).toContain("LogNovelty")
    expect(kinds).toContain("Log:ConnReset")
    expect(new Set(signals.filter((s) => !s.hard).map((s) => s.kind)).size).toBeGreaterThanOrEqual(2)
  })
})
