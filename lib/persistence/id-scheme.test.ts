import { afterEach, describe, expect, it } from "vitest"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { FileIncidentStore } from "./file-store"

// Verifies the configurable incident-id scheme (incidents.idPrefix / startNumber)
// end-to-end through the file store. Each case uses a throwaway data dir.

const dirs: string[] = []

async function makeStore(opts: { idPrefix?: string; startNumber?: number }) {
  const dataDir = path.join(os.tmpdir(), `nova-idscheme-${process.pid}-${Math.random().toString(36).slice(2)}`)
  dirs.push(dataDir)
  return new FileIncidentStore({ dataDir, ...opts })
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
})

const base = { severity: "high", service: "svc", failureType: "network", description: "d" } as const

describe("configurable incident id scheme", () => {
  it("defaults to INC- starting at 2847", async () => {
    const store = await makeStore({})
    const a = await store.createIncident({ title: "a", ...base })
    expect(a.id).toBe("INC-2847")
  })

  it("uses a custom prefix and starting number", async () => {
    const store = await makeStore({ idPrefix: "PAY-", startNumber: 1000 })
    const a = await store.createIncident({ title: "a", ...base })
    const b = await store.createIncident({ title: "b", ...base })
    expect(a.id).toBe("PAY-1000")
    expect(b.id).toBe("PAY-1001")
  })

  it("continues one above the highest existing number for the custom prefix", async () => {
    const store = await makeStore({ idPrefix: "PAY-", startNumber: 1000 })
    await store.createIncident({ id: "PAY-1500", title: "seeded", ...base })
    const next = await store.nextIncidentId()
    expect(next).toBe("PAY-1501")
  })

  it("does not confuse a prefix that contains regex metacharacters", async () => {
    const store = await makeStore({ idPrefix: "A.B-", startNumber: 5 })
    const a = await store.createIncident({ title: "a", ...base })
    expect(a.id).toBe("A.B-5")
  })
})
