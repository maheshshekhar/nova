import { describe, expect, it, vi } from "vitest"
import {
  buildJudgePrompt,
  coerceVerdict,
  parseJudgeVerdict,
  toJudgeInput,
  HttpSignalJudge,
  DENY,
  type JudgeInput,
} from "@/lib/sentinel/judge"
import type { AmbiguousCluster } from "@/lib/sentinel/correlate"
import type { Signal } from "@/lib/sentinel/signal"

function sig(kind: string): Signal {
  return {
    service: "checkout",
    namespace: "prod",
    severity: "warning",
    message: `${kind} evidence`,
    hard: false,
    source: { kind: "Pod", name: "checkout-abc" },
    kind,
  }
}

const cluster: AmbiguousCluster = {
  service: "checkout",
  namespace: "prod",
  signals: [sig("HighRestarts"), sig("ProbeFailure")],
}

describe("toJudgeInput", () => {
  it("maps an ambiguous cluster to a minimal, self-contained input", () => {
    const input = toJudgeInput(cluster)
    expect(input).toMatchObject({ service: "checkout", namespace: "prod" })
    expect(input.signals).toEqual([
      { kind: "HighRestarts", severity: "warning", hard: false, message: "HighRestarts evidence" },
      { kind: "ProbeFailure", severity: "warning", hard: false, message: "ProbeFailure evidence" },
    ])
  })
})

describe("buildJudgePrompt", () => {
  it("lists exactly the observed signals (nothing invented)", () => {
    const prompt = buildJudgePrompt(toJudgeInput(cluster))
    expect(prompt).toContain("Service: checkout")
    expect(prompt).toContain("Namespace: prod")
    expect(prompt).toContain("- HighRestarts [warning]: HighRestarts evidence")
    expect(prompt).toContain("- ProbeFailure [warning]: ProbeFailure evidence")
  })
})

describe("coerceVerdict", () => {
  it("accepts a well-formed verdict", () => {
    expect(coerceVerdict({ confirm: true, confidence: 0.8, reason: "smells like a crash" })).toEqual({
      confirm: true,
      confidence: 0.8,
      reason: "smells like a crash",
    })
  })

  it("clamps confidence and defaults a missing reason", () => {
    expect(coerceVerdict({ confirm: true, confidence: 9 })).toEqual({
      confirm: true,
      confidence: 1,
      reason: "no reason given",
    })
  })

  it("treats a non-true confirm as false and non-numeric confidence as 0", () => {
    expect(coerceVerdict({ confirm: "yes", confidence: "high", reason: "x" })).toEqual({
      confirm: false,
      confidence: 0,
      reason: "x",
    })
  })

  it("degrades junk to DENY", () => {
    expect(coerceVerdict(null)).toEqual(DENY)
    expect(coerceVerdict("nope")).toEqual(DENY)
  })
})

describe("parseJudgeVerdict", () => {
  it("extracts the JSON object from a chatty reply", () => {
    const text = 'Here is my call:\n{"confirm": true, "confidence": 0.7, "reason": "ok"}\nThanks!'
    expect(parseJudgeVerdict(text)).toEqual({ confirm: true, confidence: 0.7, reason: "ok" })
  })

  it("holds (DENY) on an unparseable reply", () => {
    expect(parseJudgeVerdict("I cannot answer")).toEqual(DENY)
    expect(parseJudgeVerdict("")).toEqual(DENY)
    expect(parseJudgeVerdict("{not json}")).toEqual(DENY)
  })
})

describe("HttpSignalJudge", () => {
  const input: JudgeInput = toJudgeInput(cluster)

  it("POSTs the input to /api/sentinel/judge and returns the verdict", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ confirm: true, confidence: 0.9, reason: "real" }), { status: 200 })
    ) as unknown as typeof fetch
    const judge = new HttpSignalJudge("http://nova:3000/", fetchImpl)
    const verdict = await judge.judge(input)
    expect(verdict).toEqual({ confirm: true, confidence: 0.9, reason: "real" })
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toBe("http://nova:3000/api/sentinel/judge")
    expect(JSON.parse((init as RequestInit).body as string)).toEqual(input)
  })

  it("holds (DENY) on a non-OK response", async () => {
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 500 })) as unknown as typeof fetch
    const judge = new HttpSignalJudge("http://nova:3000", fetchImpl)
    expect(await judge.judge(input)).toEqual(DENY)
  })

  it("holds (DENY) when the transport throws", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down")
    }) as unknown as typeof fetch
    const judge = new HttpSignalJudge("http://nova:3000", fetchImpl)
    expect(await judge.judge(input)).toEqual(DENY)
  })
})
