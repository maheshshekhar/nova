import { afterEach, describe, expect, it } from "vitest"
import {
  loadTemplate,
  renderTemplate,
  renderTemplateFile,
  resetTemplateCache,
} from "@/lib/ai/prompt-template"
import { getConfig } from "@/lib/config/loader"
import { DEFAULT_DOMAIN } from "@/lib/domain/defaults"

const VARS = DEFAULT_DOMAIN.promptVars

afterEach(() => resetTemplateCache())

describe("renderTemplate — substitution", () => {
  it("fills every {{var}} placeholder from the provided variables", () => {
    expect(renderTemplate("a {{x}} b {{y}}", { x: "1", y: "2" })).toBe("a 1 b 2")
  })

  it("tolerates internal whitespace inside the braces", () => {
    expect(renderTemplate("{{ x }}", { x: "ok" })).toBe("ok")
  })

  it("substitutes every occurrence of a repeated variable", () => {
    expect(renderTemplate("{{x}}-{{x}}", { x: "z" })).toBe("z-z")
  })

  it("throws an explicit error when a referenced variable is missing (never a silent gap)", () => {
    expect(() => renderTemplate("hello {{name}}", {})).toThrow("Missing prompt variable: {{name}}")
  })

  it("ignores extra variables the template does not reference", () => {
    expect(renderTemplate("just {{a}}", { a: "1", unused: "2" })).toBe("just 1")
  })

  it("allows an empty-string value (that is a provided value, not a gap)", () => {
    expect(renderTemplate("[{{x}}]", { x: "" })).toBe("[]")
  })
})

describe("loadTemplate — file loading", () => {
  const { prompts } = getConfig()

  it("strips a single trailing newline so files render like an inline literal", () => {
    const tpl = loadTemplate(prompts.triage)
    expect(tpl.endsWith("\n")).toBe(false)
    expect(tpl).toContain("You are a senior SRE")
  })

  it("returns the cached content on a second read", () => {
    const a = loadTemplate(prompts.rca)
    const b = loadTemplate(prompts.rca)
    expect(a).toBe(b)
  })
})

// Every shipped template must render with its full variable set and leave NO
// `{{...}}` placeholder behind — this catches a typo'd variable name in a file.
describe("shipped templates render cleanly", () => {
  const { prompts } = getConfig()
  const noBraces = (s: string) => expect(s).not.toMatch(/\{\{/)

  it("triage template renders with {context, logs}", () => {
    const out = renderTemplateFile(prompts.triage, { ...VARS, context: "CTX", logs: "L1\nL2" })
    noBraces(out)
    expect(out).toContain("INCIDENT: CTX")
    for (const s of ["ROOT CAUSE:", "BLAST RADIUS:", "REMEDIATION:", "CONFIDENCE:"]) {
      expect(out).toContain(s)
    }
  })

  it("rca template renders with {context, logs} and keeps every required section", () => {
    const out = renderTemplateFile(prompts.rca, { ...VARS, context: "CTX", logs: "L1" })
    noBraces(out)
    for (const s of [
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
      expect(out).toContain(s)
    }
  })

  it("chat template renders with {context}", () => {
    const out = renderTemplateFile(prompts.chat, { context: "CTX" })
    noBraces(out)
    expect(out).toContain("SRE assistant")
    expect(out).toContain("INCIDENT CONTEXT, HISTORY, RCAs AND LOGS:\nCTX")
  })

  it("judge template renders with its full variable set", () => {
    const out = renderTemplateFile(prompts.judge, {
      context: "CTX",
      logs: "L1",
      rootCauseMustInclude: "pool exhaustion",
      remediationMustInclude: "scale replicas",
      forbiddenClaims: "memory leak",
      output: "AI RCA TEXT",
      modeDescription: "full RCA document",
    })
    noBraces(out)
    expect(out).toContain("Root cause should reference: pool exhaustion")
    expect(out).toContain("format for a full RCA document")
    expect(out).toContain('{"groundedness"')
  })

  it("judge template throws if a required variable is omitted", () => {
    expect(() =>
      renderTemplateFile(prompts.judge, { context: "CTX", logs: "L1" })
    ).toThrow(/Missing prompt variable/)
  })
})
