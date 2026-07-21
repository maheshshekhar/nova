import { afterAll, describe, expect, it } from "vitest"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { FileIncidentStore } from "./file-store"
import { runPersistenceContract } from "./contract"

// M2: the File adapter must satisfy the shared PersistenceStore contract, plus a
// file-specific guarantee (atomic writes leave no temp files). Seeding + version
// upgrade for the File adapter stay covered by lib/incident-store.test.ts (which
// exercises the real seeder through the façade), so they are not duplicated here.

const dirs: string[] = []
function freshDir(): string {
  const d = path.join(os.tmpdir(), `nova-file-store-${process.pid}-${Math.random().toString(36).slice(2)}`)
  dirs.push(d)
  return d
}

afterAll(async () => {
  for (const d of dirs) await fs.rm(d, { recursive: true, force: true })
})

// Run the full contract against an EMPTY file store (seed disabled) so counts and
// filters are deterministic.
runPersistenceContract("FileIncidentStore", () => new FileIncidentStore({ dataDir: freshDir(), seed: () => [] }))

describe("FileIncidentStore — file specifics", () => {
  it("persists across separate store instances pointed at the same directory", async () => {
    const dir = freshDir()
    const a = new FileIncidentStore({ dataDir: dir, seed: () => [] })
    const created = await a.createIncident({
      title: "persisted", severity: "low", service: "s", failureType: "network", description: "d",
    })

    const b = new FileIncidentStore({ dataDir: dir, seed: () => [] })
    const read = await b.getIncident(created.id)
    expect(read?.title).toBe("persisted")
  })

  it("leaves no temporary .tmp files after a write", async () => {
    const dir = freshDir()
    const store = new FileIncidentStore({ dataDir: dir, seed: () => [] })
    await store.createIncident({
      title: "t", severity: "low", service: "s", failureType: "network", description: "d",
    })
    const entries = await fs.readdir(dir)
    expect(entries.some((f) => f.includes(".tmp"))).toBe(false)
    expect(entries).toContain("incidents.json")
  })
})
