import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

// Characterization tests for the file-backed incident store. DATA_DIR must be set
// to a throwaway directory BEFORE the module is imported (it is read into a
// module-level constant at import time), so we set it here and import dynamically.
const DATA_DIR = path.join(os.tmpdir(), `nova-store-test-${process.pid}-${Date.now()}`)
process.env.DATA_DIR = DATA_DIR
const STORE_PATH = path.join(DATA_DIR, "incidents.json")

type StoreModule = typeof import("@/lib/incident-store")
let store: StoreModule

beforeAll(async () => {
  // The store starts EMPTY (the bundled demo history was removed) — the tests
  // below either read the empty store or write their own fixture file first.
  await fs.rm(DATA_DIR, { recursive: true, force: true })
  store = await import("@/lib/incident-store")
})

afterAll(async () => {
  await fs.rm(DATA_DIR, { recursive: true, force: true })
})

async function readStoreFile() {
  return JSON.parse(await fs.readFile(STORE_PATH, "utf8")) as {
    version: number
    seededAt: number
    incidents: Array<{ id: string; origin?: string; startedAt: number }>
  }
}

describe("empty store on first run", () => {
  it("starts with an empty history and writes a versioned store file", async () => {
    const list = await store.listIncidents()
    expect(list.length).toBe(0)

    const file = await readStoreFile()
    expect(file.version).toBeGreaterThanOrEqual(1)
    expect(file.incidents.length).toBe(0)
  })

  it("returns incidents sorted by startedAt descending", async () => {
    const list = await store.listIncidents()
    for (let i = 1; i < list.length; i++) {
      expect(list[i - 1].startedAt).toBeGreaterThanOrEqual(list[i].startedAt)
    }
  })
})

describe("idempotent first-write (no reseed)", () => {
  it("does not rewrite seededAt on subsequent reads", async () => {
    await store.listIncidents() // triggers the initial write
    const first = await readStoreFile()
    await store.listIncidents() // second read must not rewrite seededAt
    const second = await readStoreFile()
    expect(second.seededAt).toBe(first.seededAt)
  })
})

describe("version upgrade", () => {
  it("upgrades an old store in place, preserving live incidents and bumping the version", async () => {
    await fs.mkdir(DATA_DIR, { recursive: true })
    const liveIncident = {
      id: "INC-9001",
      title: "old live incident",
      severity: "critical",
      service: "payment-service",
      status: "resolved",
      failureType: "db-pool-exhaustion",
      startedAt: Date.now() - 3_600_000,
      resolvedAt: Date.now(),
      durationMin: 60,
      affectedUsers: 10,
      description: "prior run",
      timeline: [],
      relatedLogs: [],
      rca: null,
      origin: "live",
    }
    await fs.writeFile(
      STORE_PATH,
      JSON.stringify({ version: 1, seededAt: Date.now() - 86_400_000, incidents: [liveIncident] }),
      "utf8"
    )

    const found = await store.getIncident("INC-9001")
    expect(found).not.toBeNull()
    expect(found?.origin).toBe("live")

    const file = await readStoreFile()
    expect(file.version).toBeGreaterThan(1)
    // No demo seed anymore: only the preserved live incident survives the upgrade.
    expect(file.incidents.length).toBe(1)
  })
})

describe("createIncident", () => {
  it("creates a live incident and persists it", async () => {
    const created = await store.createIncident({
      title: "new outage",
      severity: "critical",
      service: "checkout-service",
      failureType: "db-pool-exhaustion",
      description: "created in test",
    })
    expect(created.id).toMatch(/^INC-\d+$/)
    expect(created.origin).toBe("live")

    const roundTrip = await store.getIncident(created.id)
    expect(roundTrip?.title).toBe("new outage")
  })

  it("is idempotent for a duplicate id (returns the existing record)", async () => {
    const a = await store.createIncident({
      id: "INC-7777",
      title: "first",
      severity: "high",
      service: "svc",
      failureType: "OOMKilled",
      description: "first write",
    })
    const b = await store.createIncident({
      id: "INC-7777",
      title: "second",
      severity: "high",
      service: "svc",
      failureType: "OOMKilled",
      description: "second write",
    })
    expect(b.title).toBe(a.title) // not overwritten
  })
})

describe("nextIncidentId", () => {
  it("returns one above the highest existing INC number", async () => {
    await store.createIncident({
      id: "INC-5000",
      title: "x",
      severity: "low",
      service: "svc",
      failureType: "network",
      description: "d",
    })
    const next = await store.nextIncidentId()
    const n = Number(next.replace("INC-", ""))
    expect(n).toBeGreaterThan(5000)
  })
})

describe("atomic writes", () => {
  it("leaves no temporary .tmp files behind after writes", async () => {
    await store.createIncident({
      title: "t",
      severity: "low",
      service: "svc",
      failureType: "network",
      description: "d",
    })
    const entries = await fs.readdir(DATA_DIR)
    expect(entries.some((f) => f.includes(".tmp"))).toBe(false)
  })
})
