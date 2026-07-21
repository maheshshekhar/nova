import { describe, expect, it } from "vitest"
import { buildPrompt, buildRcaPrompt, buildSystemPrompt } from "@/lib/ai/prompts"

// Characterization tests: lock the required STRUCTURE of each prompt (sections +
// key instructions). When M5 moves this text into editable `prompts/*.md`
// templates, these same assertions must still hold against the rendered output —
// that is how we prove externalization preserved the prompt contract.

const LOGS = [
  "2026-01-14T09:13:41Z ERROR pool.connect() timeout after 5000ms",
  "2026-01-14T09:13:42Z ERROR FATAL: too many connections",
]
const CONTEXT = "INC-2847: payment-service DB connection pool exhaustion."

describe("buildPrompt (triage)", () => {
  const p = buildPrompt(LOGS, CONTEXT)

  it("frames the model as a senior SRE and includes the incident context", () => {
    expect(p).toContain("senior SRE")
    expect(p).toContain(CONTEXT)
  })

  it("includes the provided log lines", () => {
    expect(p).toContain("pool.connect() timeout after 5000ms")
  })

  it("requests the fixed triage sections", () => {
    for (const section of ["ROOT CAUSE:", "BLAST RADIUS:", "REMEDIATION:", "CONFIDENCE:"]) {
      expect(p).toContain(section)
    }
  })
})

describe("buildRcaPrompt (full RCA)", () => {
  const p = buildRcaPrompt(LOGS, CONTEXT)

  it("asks for a blameless post-incident RCA document", () => {
    expect(p).toContain("Root Cause Analysis")
    expect(p).toContain("blameless")
  })

  it("requests every required RCA section", () => {
    for (const section of [
      "## Executive Summary",
      "## Severity & Impact",
      "## Detection",
      "## Timeline",
      "## Root Cause",
      "## Contributing Factors",
      "## Resolution",
      "## Action Items",
      "## Lessons Learned",
    ]) {
      expect(p).toContain(section)
    }
  })

  it("forbids placeholder tokens", () => {
    expect(p.toLowerCase()).toContain("placeholder")
  })
})

describe("buildSystemPrompt (chat)", () => {
  it("frames an SRE assistant grounded in the supplied context", () => {
    const s = buildSystemPrompt(CONTEXT)
    expect(s).toContain("SRE assistant")
    expect(s).toContain(CONTEXT)
  })
})
