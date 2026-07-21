import "server-only"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

// Prompt template loader + renderer. Prompt text lives in editable `prompts/*.md`
// files (paths come from config) instead of being hardcoded in TypeScript, so an
// operator can tune the wording for their domain without a code change, and the
// eval harness renders the EXACT same templates the product does. See
// open-source-plan §8.

const cache = new Map<string, string>()

/** Read a template file (cached), stripping a single trailing newline so a file
 * with the conventional final newline renders identically to an inline literal. */
export function loadTemplate(path: string): string {
  const abs = resolve(process.cwd(), path)
  let tpl = cache.get(abs)
  if (tpl === undefined) {
    tpl = readFileSync(abs, "utf8").replace(/\n$/, "")
    cache.set(abs, tpl)
  }
  return tpl
}

/** Clear the template cache (tests / hot config reloads). */
export function resetTemplateCache(): void {
  cache.clear()
}

/**
 * Substitute `{{var}}` placeholders. A referenced variable with no value throws
 * — a prompt must never be silently shipped with a `{{gap}}` left in it. Extra
 * variables that the template does not reference are ignored.
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, name: string) => {
    const value = vars[name]
    if (value === undefined) {
      throw new Error(`Missing prompt variable: {{${name}}}`)
    }
    return value
  })
}

/** Load a template file and render it with the given variables. */
export function renderTemplateFile(path: string, vars: Record<string, string>): string {
  return renderTemplate(loadTemplate(path), vars)
}
