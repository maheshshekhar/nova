import "server-only"
import { getConfig } from "@/lib/config/loader"
import { getDomain } from "@/lib/domain/loader"
import { renderTemplateFile } from "./prompt-template"

// Shared AI prompt builders.
//
// Centralised so that BOTH the production routes (app/api/analyze, app/api/chat)
// and the eval harness (lib/eval) exercise the EXACT same prompts. If these
// drift, evals become meaningless — so this is the single source of truth.
//
// The prompt TEXT lives in editable `prompts/*.md` templates (paths from config),
// rendered here with the runtime variables. Domain-specific wording is tuned in
// those files, not in code. See open-source-plan §8.

// ── RCA / triage prompts (used by app/api/analyze/route.ts) ───────────────────

export function buildPrompt(logs: string[], context: string): string {
  const { prompts } = getConfig()
  return renderTemplateFile(prompts.triage, {
    ...getDomain().promptVars,
    ...prompts.variables,
    context,
    logs: logs.slice(0, 8).join("\n"),
  })
}

export function buildRcaPrompt(logs: string[], context: string): string {
  const { prompts } = getConfig()
  return renderTemplateFile(prompts.rca, {
    ...getDomain().promptVars,
    ...prompts.variables,
    context,
    logs: logs.slice(0, 12).join("\n"),
  })
}

// ── Chat system prompt (used by app/api/chat/route.ts) ────────────────────────

export function buildSystemPrompt(context: string): string {
  const { prompts } = getConfig()
  return renderTemplateFile(prompts.chat, {
    ...getDomain().promptVars,
    ...prompts.variables,
    context,
  })
}
