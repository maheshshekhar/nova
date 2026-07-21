import "server-only"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import yaml from "js-yaml"
import { getDomain } from "@/lib/domain/loader"
import { selectRunbook } from "@/lib/runbooks"
import { RunbookSchema, type StoredRunbook } from "./runbook-schema"

// RunbookStore — loads authored runbooks from a directory of YAML files (a Domain
// Pack's `runbooks:` path), validating each one. A malformed runbook is skipped
// and its error captured, never crashing the store. Matching reuses the same
// pure `selectRunbook` engine as the built-in runbooks. See
// docs/domain-runbooks-settings-plan.md Part 2.

export interface RunbookLoadError {
  file: string
  error: string
}
export interface LoadRunbooksResult {
  runbooks: StoredRunbook[]
  errors: RunbookLoadError[]
}

/** Load + validate every *.yaml runbook in `dir` (relative to cwd). Missing dir
 * ⇒ empty result. Each malformed file is skipped and recorded in `errors`. */
export function loadRunbookDir(dir: string): LoadRunbooksResult {
  const abs = resolve(process.cwd(), dir)
  const result: LoadRunbooksResult = { runbooks: [], errors: [] }
  if (!existsSync(abs)) return result

  for (const file of readdirSync(abs).sort()) {
    if (!/\.ya?ml$/.test(file)) continue
    try {
      const parsed = yaml.load(readFileSync(resolve(abs, file), "utf8"))
      result.runbooks.push(RunbookSchema.parse(parsed))
    } catch (err) {
      result.errors.push({ file, error: (err as Error).message })
    }
  }
  return result
}

let cache: LoadRunbooksResult | undefined

/** Authored runbooks for the active domain (from its `runbooks:` directory). */
export function getStoredRunbooks(): LoadRunbooksResult {
  if (cache) return cache
  const dir = getDomain().runbooks
  cache = dir ? loadRunbookDir(dir) : { runbooks: [], errors: [] }
  return cache
}

export function resetRunbookCache(): void {
  cache = undefined
}

/** Best authored runbook for an incident, scoped to the active domain. */
export function matchStoredRunbook(
  failureType: string,
  service?: string
): StoredRunbook | null {
  const domain = getDomain()
  return selectRunbook(getStoredRunbooks().runbooks, failureType, service, domain.id)
}
