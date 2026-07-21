import { afterEach, describe, expect, it } from "vitest"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { loadConfig, getConfig, resetConfigCache } from "@/lib/config/loader"
import { DEFAULT_CONFIG } from "@/lib/config/defaults"

// M1 loader: env interpolation + partial merge + validation. File I/O uses a real
// temp file so we exercise the actual YAML read path.

const tmpFiles: string[] = []

async function writeTempConfig(yaml: string): Promise<string> {
  const p = path.join(os.tmpdir(), `nova-config-${process.pid}-${Math.random().toString(36).slice(2)}.yaml`)
  await fs.writeFile(p, yaml, "utf8")
  tmpFiles.push(p)
  return p
}

afterEach(async () => {
  resetConfigCache()
  delete process.env.NOVA_CONFIG
  for (const f of tmpFiles.splice(0)) await fs.rm(f, { force: true })
})

describe("loadConfig — no file", () => {
  it("returns the full defaults when the config file is absent", () => {
    const cfg = loadConfig({ path: "/nonexistent/nova.config.yaml" })
    expect(cfg).toEqual(DEFAULT_CONFIG)
  })
})

describe("loadConfig — file merge", () => {
  it("merges a partial YAML file over the defaults", async () => {
    const file = await writeTempConfig("logs:\n  provider: elasticsearch\n  url: http://es:9200\n")
    const cfg = loadConfig({ path: file })
    expect(cfg.logs.provider).toBe("elasticsearch")
    expect(cfg.logs.url).toBe("http://es:9200")
    // untouched sections keep their defaults
    expect(cfg.persistence.provider).toBe("file")
    expect(cfg.logs.fields.service).toBe("app")
  })
})

describe("loadConfig — env interpolation", () => {
  it("substitutes ${VAR} from the environment", async () => {
    process.env.TEST_LOKI = "http://loki.internal:3100"
    const file = await writeTempConfig("logs:\n  url: ${TEST_LOKI}\n")
    expect(loadConfig({ path: file }).logs.url).toBe("http://loki.internal:3100")
    delete process.env.TEST_LOKI
  })

  it("uses ${VAR:-fallback} when the variable is unset", async () => {
    delete process.env.TEST_UNSET_URL
    const file = await writeTempConfig("logs:\n  url: ${TEST_UNSET_URL:-http://fallback:3100}\n")
    expect(loadConfig({ path: file }).logs.url).toBe("http://fallback:3100")
  })

  it("throws a descriptive error when a referenced var is unset and has no fallback", async () => {
    delete process.env.DEFINITELY_UNSET
    const file = await writeTempConfig("logs:\n  url: ${DEFINITELY_UNSET}\n")
    expect(() => loadConfig({ path: file })).toThrow(/DEFINITELY_UNSET/)
  })
})

describe("loadConfig — validation", () => {
  it("throws on an invalid provider value in the file", async () => {
    const file = await writeTempConfig("persistence:\n  provider: sqlite\n")
    expect(() => loadConfig({ path: file })).toThrow()
  })

  it("validates a raw object directly (raw option)", () => {
    const cfg = loadConfig({ raw: { ai: { provider: "ollama" } } })
    expect(cfg.ai.provider).toBe("ollama")
  })

  it("interpolates env refs inside a raw object", () => {
    process.env.RAW_KEY_ENV = "MY_KEY"
    const cfg = loadConfig({ raw: { ai: { apiKeyEnv: "${RAW_KEY_ENV}" } } })
    expect(cfg.ai.apiKeyEnv).toBe("MY_KEY")
    delete process.env.RAW_KEY_ENV
  })
})

describe("getConfig — caching", () => {
  it("caches the config and resetConfigCache forces a reload", async () => {
    const file = await writeTempConfig("server:\n  port: 4100\n")
    process.env.NOVA_CONFIG = file
    expect(getConfig().server.port).toBe(4100)

    // Change the file; cached value is unchanged until reset.
    await fs.writeFile(file, "server:\n  port: 4200\n", "utf8")
    expect(getConfig().server.port).toBe(4100)

    resetConfigCache()
    expect(getConfig().server.port).toBe(4200)
  })
})
