import "server-only"
import type {
  IncidentRecord,
  IncidentFilter,
  IncidentRange,
} from "../incident-types"
import type {
  PersistenceStore,
  StoreState,
  CreateIncidentInput,
  UpdateIncidentInput,
} from "./store"

// BaseIncidentStore — all the incident business logic (seed-on-first-run, in-place
// version upgrade, id generation, supersede-open-incident, duration computation,
// query filtering, write serialization) implemented ONCE. Backend adapters only
// provide two storage primitives (`readState` / `writeState`); everything above
// is shared so every backend behaves identically (guaranteed by ./contract.ts).

export interface BaseIncidentStoreOptions {
  /** Bump when the seed content changes so older stores upgrade in place. */
  storeVersion: number
  /** Produce the seed incidents for a base timestamp. Omit ⇒ start empty
   * (this is what M11 uses to remove static demo data from the core). */
  seed?: (baseMs: number) => IncidentRecord[]
}

export abstract class BaseIncidentStore implements PersistenceStore {
  protected readonly storeVersion: number
  private readonly seed: (baseMs: number) => IncidentRecord[]

  constructor(opts: BaseIncidentStoreOptions) {
    this.storeVersion = opts.storeVersion
    this.seed = opts.seed ?? (() => [])
  }

  // ── Storage primitives implemented by each backend ──────────────────────────
  /** Return the persisted state, or null when the store has never been written. */
  protected abstract readState(): Promise<StoreState | null>
  /** Persist the full state atomically. */
  protected abstract writeState(state: StoreState): Promise<void>

  // ── Write serialization (per instance) ──────────────────────────────────────
  private writeChain: Promise<unknown> = Promise.resolve()
  protected withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(fn, fn)
    this.writeChain = run.catch(() => {})
    return run
  }

  // ── Seed / upgrade ──────────────────────────────────────────────────────────
  // Load the store, seeding once on first ever run. Idempotent: an existing store
  // is never reseeded, which is what makes the data persist across restarts.
  private async loadOrSeed(): Promise<StoreState> {
    const existing = await this.readState()
    if (existing) {
      if ((existing.version ?? 1) < this.storeVersion) {
        // Upgrade in place: regenerate seeded incidents using the original seed
        // time (dates stay stable) and keep any live incidents recorded since.
        const base = existing.seededAt || Date.now()
        const live = existing.incidents.filter((i) => i.origin === "live")
        const upgraded: StoreState = {
          version: this.storeVersion,
          seededAt: base,
          incidents: [...live, ...this.seed(base)],
        }
        await this.withWriteLock(() => this.writeState(upgraded))
        return upgraded
      }
      return existing
    }

    const now = Date.now()
    const state: StoreState = {
      version: this.storeVersion,
      seededAt: now,
      incidents: this.seed(now),
    }
    await this.withWriteLock(() => this.writeState(state))
    return state
  }

  // ── Query helpers ───────────────────────────────────────────────────────────
  private rangeStart(range: IncidentRange, now: number): number {
    const DAY = 86_400_000
    switch (range) {
      case "day":
        return now - DAY
      case "week":
        return now - 7 * DAY
      case "month":
        return now - 30 * DAY
      case "quarter":
        return now - 90 * DAY
      case "year":
        return now - 365 * DAY
      case "all":
      default:
        return 0
    }
  }

  private matches(inc: IncidentRecord, filter: IncidentFilter, now: number): boolean {
    if (filter.range && filter.range !== "all") {
      if (inc.startedAt < this.rangeStart(filter.range, now)) return false
    }
    if (filter.from != null && inc.startedAt < filter.from) return false
    if (filter.to != null && inc.startedAt > filter.to) return false
    if (filter.service && inc.service !== filter.service) return false
    if (filter.severity && inc.severity !== filter.severity) return false
    if (filter.failureType && inc.failureType !== filter.failureType) return false
    if (filter.status && inc.status !== filter.status) return false
    return true
  }

  // ── Public API ────────────────────────────────────────────────────────────
  async listIncidents(filter: IncidentFilter = {}): Promise<IncidentRecord[]> {
    const store = await this.loadOrSeed()
    const now = Date.now()
    return store.incidents
      .filter((inc) => this.matches(inc, filter, now))
      .sort((a, b) => b.startedAt - a.startedAt)
  }

  async getIncident(id: string): Promise<IncidentRecord | null> {
    const store = await this.loadOrSeed()
    return store.incidents.find((i) => i.id === id) ?? null
  }

  // Next incident id = one above the highest existing INC-#### number. Keeps live
  // incident ids monotonic and continuing on from the seeded history.
  async nextIncidentId(): Promise<string> {
    const store = await this.loadOrSeed()
    return this.computeNextId(store)
  }

  // Pure id computation from an already-loaded state. Used INSIDE the write lock
  // (createIncident) so it never re-enters loadOrSeed/withWriteLock (which would
  // deadlock the per-instance mutex on an unseeded store).
  private computeNextId(state: StoreState): string {
    const max = state.incidents.reduce((m, i) => {
      const n = Number(i.id.replace(/^INC-/, ""))
      return Number.isFinite(n) && n > m ? n : m
    }, 2846)
    return `INC-${max + 1}`
  }

  async createIncident(input: CreateIncidentInput): Promise<IncidentRecord> {
    // Ensure the store is seeded BEFORE taking the write lock — loadOrSeed may
    // itself acquire the lock to write the seed, and the mutex is not re-entrant.
    await this.loadOrSeed()
    return this.withWriteLock(async () => {
      const store = (await this.readState()) as StoreState
      const id = input.id ?? this.computeNextId(store)
      // Guard against duplicate ids (e.g. double POST from the incident flow).
      const existing = store.incidents.find((i) => i.id === id)
      if (existing) return existing

      // A new outage supersedes any prior OPEN live incident for the same service:
      // auto-resolve them so the same real cascade never shows as two active
      // incidents (e.g. a stale record left over from a previous session).
      const now = Date.now()
      for (const inc of store.incidents) {
        if (
          inc.origin === "live" &&
          inc.status !== "resolved" &&
          inc.service === input.service &&
          inc.id !== id
        ) {
          inc.status = "resolved"
          inc.resolvedAt = now
          inc.durationMin = Math.max(1, Math.round((now - inc.startedAt) / 60000))
        }
      }

      const record: IncidentRecord = {
        id,
        title: input.title,
        severity: input.severity,
        service: input.service,
        status: input.status ?? "investigating",
        failureType: input.failureType,
        startedAt: input.startedAt ?? Date.now(),
        resolvedAt: null,
        durationMin: null,
        affectedUsers: input.affectedUsers ?? 0,
        description: input.description,
        timeline: input.timeline ?? [],
        relatedLogs: input.relatedLogs ?? [],
        rca: input.rca ?? null,
        origin: "live",
      }
      store.incidents.unshift(record)
      await this.writeState(store)
      return record
    })
  }

  async updateIncident(
    id: string,
    patch: UpdateIncidentInput
  ): Promise<IncidentRecord | null> {
    // Seed outside the (non-re-entrant) write lock, then read-modify-write.
    await this.loadOrSeed()
    return this.withWriteLock(async () => {
      const store = (await this.readState()) as StoreState
      const inc = store.incidents.find((i) => i.id === id)
      if (!inc) return null

      if (patch.status !== undefined) inc.status = patch.status
      if (patch.affectedUsers !== undefined) inc.affectedUsers = patch.affectedUsers
      if (patch.timeline !== undefined) inc.timeline = patch.timeline
      if (patch.relatedLogs !== undefined) inc.relatedLogs = patch.relatedLogs
      if (patch.rca !== undefined) inc.rca = patch.rca
      if (patch.resolvedAt !== undefined) {
        inc.resolvedAt = patch.resolvedAt
        inc.durationMin =
          patch.resolvedAt != null
            ? Math.max(1, Math.round((patch.resolvedAt - inc.startedAt) / 60000))
            : null
      }

      await this.writeState(store)
      return inc
    })
  }

  async saveRca(id: string, rca: NonNullable<UpdateIncidentInput["rca"]>): Promise<IncidentRecord | null> {
    return this.updateIncident(id, { rca })
  }

  async resolveIncident(
    id: string,
    resolvedAt = Date.now()
  ): Promise<IncidentRecord | null> {
    return this.updateIncident(id, { status: "resolved", resolvedAt })
  }
}
