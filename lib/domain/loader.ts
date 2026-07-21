import "server-only"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import yaml from "js-yaml"
import { getConfig } from "@/lib/config/loader"
import { DomainPackSchema, type Domain } from "./schema"
import { DEFAULT_DOMAIN } from "./defaults"

// Loads the active Domain Pack. When `nova.config.yaml` sets `domain: <path>`, the
// pack at that path is parsed + validated; otherwise the built-in DEFAULT_DOMAIN
// (today's behaviour) is used. Cached like the config so it is read once.

let cached: Domain | undefined

export interface LoadDomainOptions {
  /** Path to a Domain Pack YAML file. */
  path?: string
  /** Raw YAML/JSON string (takes precedence over `path`; used by tests). */
  raw?: string
}

export function loadDomainPack(opts: LoadDomainOptions): Domain {
  const text =
    opts.raw ?? readFileSync(resolve(process.cwd(), opts.path as string), "utf8")
  const parsed = yaml.load(text)
  return DomainPackSchema.parse(parsed).domain
}

export function getDomain(): Domain {
  if (cached) return cached
  const path = getConfig().domain
  cached = path ? loadDomainPack({ path }) : DEFAULT_DOMAIN
  return cached
}

/** Reset the cached domain (tests / hot config reloads). */
export function resetDomainCache(): void {
  cached = undefined
}
