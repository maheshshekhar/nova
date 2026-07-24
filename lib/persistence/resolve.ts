import "server-only"
import { AdapterRegistry } from "../config/registry"
import { getConfig } from "../config/loader"
import type { PersistenceConfig } from "../config/schema"
import type { PersistenceStore, StoreState } from "./store"
import { FileIncidentStore } from "./file-store"

// Persistence adapter registry + resolver. The configured `persistence.provider`
// is turned into a concrete store here. M2 registers only "file"; Mongo/Postgres/
// S3 register later (each verified by the shared contract-test kit).

/**
 * Select the store seeder from config. The bundled demo incident history was
 * removed (de-static work), so every deployment now starts with an EMPTY store
 * driven purely by live incidents. Returns a seeder so `BaseIncidentStore` is
 * unchanged; a future generic seeder can plug in here.
 */
export function resolveSeeder(
  _cfg: PersistenceConfig
): (baseMs: number) => StoreState["incidents"] {
  return () => []
}

export const persistenceRegistry = new AdapterRegistry<PersistenceConfig, PersistenceStore>(
  "persistence"
)

persistenceRegistry.register(
  "file",
  (cfg) => new FileIncidentStore({ dataDir: cfg.dataDir, seed: resolveSeeder(cfg) })
)

let cached: PersistenceStore | null = null

/** The process-wide incident store, constructed lazily from config. */
export function getStore(): PersistenceStore {
  if (!cached) {
    const cfg = getConfig().persistence
    cached = persistenceRegistry.create(cfg.provider, cfg)
  }
  return cached
}

/** Reset the cached store (tests / config reload). */
export function resetStore(): void {
  cached = null
}
