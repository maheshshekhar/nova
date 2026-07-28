import { describe, expect, it } from "vitest"
import { writeFileSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SentinelConfigSchema, type SentinelConfig } from "@/lib/config/schema"
import { buildSentinel, loadSentinelConfig } from "@/lib/sentinel/config"

const MIN = 60_000
function cfg(partial: unknown): SentinelConfig {
  return SentinelConfigSchema.parse(partial)
}

describe("buildSentinel", () => {
  it("maps dedupe/soft-confirm into the correlator and defaults logs on", () => {
    const b = buildSentinel(cfg({ dedupeWindowSec: 300, softConfirmKinds: 3 }))
    expect(b.logsEnabled).toBe(true)
    // Correlator behaviour: a single hard signal opens immediately.
    const [d] = b.correlator.ingest([
      { kind: "CrashLoopBackOff", service: "s", namespace: "n", severity: "critical", hard: true, message: "x", source: { kind: "Pod", name: "p" } },
    ])
    expect(d).toBeTruthy()
  })

  it("builds no business/absence lenses by default", () => {
    const b = buildSentinel(cfg({}))
    expect(b.analyzer.observe({ service: "s", message: "failed checkout" }).some((x) => x.kind === "BusinessImpact")).toBe(false)
    expect(b.analyzer.tick(10 * MIN)).toHaveLength(0)
  })

  it("enables business impact when configured", () => {
    const b = buildSentinel(cfg({ impact: { enabled: true, pattern: "failed checkout", minImpact: 2, label: "failed checkouts" } }))
    let sig
    for (let i = 0; i < 2; i++) sig = b.analyzer.observe({ service: "checkout", message: "failed checkout", at: i })
    expect(sig!.some((x) => x.kind === "BusinessImpact")).toBe(true)
  })

  it("enables absence detection when configured", () => {
    const b = buildSentinel(cfg({ absence: { enabled: true, successPattern: "ok", minBaseline: 10, dropFactor: 5 } }))
    for (let bk = 0; bk < 6; bk++) for (let i = 0; i < 50; i++) b.analyzer.observe({ service: "checkout", namespace: "prod", message: "ok", at: bk * MIN + i })
    expect(b.analyzer.tick(7 * MIN).some((x) => x.kind === "SuccessDrop")).toBe(true)
  })

  it("compiles extra signatures from config", () => {
    const b = buildSentinel(cfg({ logs: { extraSignatures: [{ kind: "PaymentDeclined", category: "database", severity: "warning", hard: true, pattern: "payment declined" }] } }))
    const sig = b.analyzer.observe({ service: "pay", message: "payment declined by gateway" })
    expect(sig.some((x) => x.kind === "Log:PaymentDeclined" && x.hard)).toBe(true)
  })

  it("respects logs.enabled=false", () => {
    expect(buildSentinel(cfg({ logs: { enabled: false } })).logsEnabled).toBe(false)
  })
})

describe("loadSentinelConfig", () => {
  it("returns schema defaults when the file is absent", () => {
    const c = loadSentinelConfig(join(tmpdir(), "does-not-exist-nova.yaml"))
    expect(c.enabled).toBe(false)
    expect(c.logs.enabled).toBe(true)
  })

  it("reads the sentinel block from a nova.config.yaml", () => {
    const dir = mkdtempSync(join(tmpdir(), "nova-cfg-"))
    const file = join(dir, "nova.config.yaml")
    writeFileSync(
      file,
      [
        "sentinel:",
        "  enabled: true",
        "  sensitivity: high",
        "  impact:",
        "    enabled: true",
        "    pattern: 'failed checkout'",
        "  absence:",
        "    enabled: true",
        "    successPattern: 'checkout complete'",
      ].join("\n")
    )
    const c = loadSentinelConfig(file)
    expect(c).toMatchObject({ enabled: true, sensitivity: "high" })
    expect(c.impact).toMatchObject({ enabled: true, pattern: "failed checkout" })
    expect(c.absence).toMatchObject({ enabled: true, successPattern: "checkout complete" })
  })
})
