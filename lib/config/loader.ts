import "server-only"
import { readFileSync, existsSync } from "node:fs"
import path from "node:path"
import yaml from "js-yaml"
import { NovaConfigSchema, type NovaConfig } from "./schema"
import { DEFAULT_CONFIG } from "./defaults"

// Config loader.
//
//  1. Read `nova.config.yaml` (or $NOVA_CONFIG). If absent → defaults (== today).
//  2. Interpolate `${ENV}` / `${ENV:-fallback}` in string values so secrets/URLs
//     stay in the environment, never in the file.
//  3. Validate + deep-fill via zod (partial configs inherit every default).

const ENV_REF = /\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/g

/** Replace `${VAR}` / `${VAR:-fallback}` in a single string. Throws when a
 * referenced variable is unset and no fallback is given. */
function interpolateString(value: string): string {
  return value.replace(ENV_REF, (_match, name: string, fallback?: string) => {
    const env = process.env[name]
    if (env !== undefined) return env
    if (fallback !== undefined) return fallback
    throw new Error(`Config references unset environment variable: \${${name}}`)
  })
}

/** Recursively interpolate env references in every string within a parsed object. */
function interpolate(node: unknown): unknown {
  if (typeof node === "string") return interpolateString(node)
  if (Array.isArray(node)) return node.map(interpolate)
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(node)) out[k] = interpolate(v)
    return out
  }
  return node
}

export interface LoadConfigOptions {
  /** Explicit path to the config file. Overrides $NOVA_CONFIG / the default path. */
  path?: string
  /** Skip reading any file and validate this object directly (used in tests). */
  raw?: unknown
}

function resolveConfigPath(explicit?: string): string {
  return explicit || process.env.NOVA_CONFIG || path.join(process.cwd(), "nova.config.yaml")
}

/** Load, interpolate and validate the Nova config. Always returns a fully
 * defaulted `NovaConfig`. Throws a descriptive error on invalid config. */
export function loadConfig(opts: LoadConfigOptions = {}): NovaConfig {
  if (opts.raw !== undefined) {
    return NovaConfigSchema.parse(interpolate(opts.raw))
  }

  const file = resolveConfigPath(opts.path)
  if (!existsSync(file)) return DEFAULT_CONFIG

  const parsed = yaml.load(readFileSync(file, "utf8")) ?? {}
  const interpolated = interpolate(parsed)
  return NovaConfigSchema.parse(interpolated)
}

// ── Cached singleton ─────────────────────────────────────────────────────────
let cached: NovaConfig | null = null

/** The process-wide config, loaded once. Use in app/route code. */
export function getConfig(): NovaConfig {
  if (cached === null) cached = loadConfig()
  return cached
}

/** Reset the cache (tests / hot config reload). */
export function resetConfigCache(): void {
  cached = null
}
