import "server-only"
import { promises as fs } from "node:fs"
import path from "node:path"
import type { StoreState } from "./store"
import { BaseIncidentStore } from "./base-store"

// File adapter — persists the store as a single atomically-written JSON file.
// In-cluster DATA_DIR points at a host-mounted volume; locally it defaults to
// ./data. All incident logic lives in BaseIncidentStore; this only does I/O.

// Bump when the seed content changes in a way existing stores should pick up.
// (Kept at the historical value so existing on-disk stores are NOT re-upgraded.)
export const STORE_VERSION = 4

export interface FileIncidentStoreOptions {
  /** Override the data directory. Defaults to $DATA_DIR or <cwd>/data. */
  dataDir?: string
  /** Override the store version (tests). */
  storeVersion?: number
  /** Override the seeder (tests). Defaults to an empty seeder (no demo data). */
  seed?: (baseMs: number) => StoreState["incidents"]
}

export class FileIncidentStore extends BaseIncidentStore {
  private readonly dataDir: string
  private readonly storePath: string

  constructor(opts: FileIncidentStoreOptions = {}) {
    super({
      storeVersion: opts.storeVersion ?? STORE_VERSION,
      seed: opts.seed ?? (() => []),
    })
    // Resolved lazily at construction so a test that sets DATA_DIR before first
    // use is honoured (matches the previous module-level behaviour).
    this.dataDir = opts.dataDir || process.env.DATA_DIR || path.join(process.cwd(), "data")
    this.storePath = path.join(this.dataDir, "incidents.json")
  }

  protected async readState(): Promise<StoreState | null> {
    try {
      const raw = await fs.readFile(this.storePath, "utf8")
      const parsed = JSON.parse(raw) as StoreState
      if (!parsed || !Array.isArray(parsed.incidents)) return null
      return parsed
    } catch {
      return null
    }
  }

  protected async writeState(state: StoreState): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true })
    // Atomic write: temp file + rename so a crash never leaves a partial file.
    const tmp = `${this.storePath}.tmp-${process.pid}`
    await fs.writeFile(tmp, JSON.stringify(state, null, 2), "utf8")
    await fs.rename(tmp, this.storePath)
  }
}
