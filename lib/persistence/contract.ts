import { beforeEach, describe, expect, it } from "vitest"
import type { PersistenceStore } from "./store"

// Shared PersistenceStore contract. Every backend adapter (file, mongo, postgres,
// s3) runs this exact suite via `runPersistenceContract`, so "plug-and-play" is
// enforced: a new store is only correct if it reproduces this behaviour. Tests use
// a FRESH, EMPTY store per case (the `makeStore` factory must not seed demo data)
// so assertions about counts/filters are deterministic across backends.

export function runPersistenceContract(
  name: string,
  makeStore: () => Promise<PersistenceStore> | PersistenceStore
): void {
  describe(`PersistenceStore contract — ${name}`, () => {
    let store: PersistenceStore

    beforeEach(async () => {
      store = await makeStore()
    })

    it("creates a live incident and reads it back", async () => {
      const created = await store.createIncident({
        title: "checkout down",
        severity: "critical",
        service: "checkout",
        failureType: "db-pool-exhaustion",
        description: "503s under load",
      })
      expect(created.id).toMatch(/^INC-\d+$/)
      expect(created.origin).toBe("live")
      expect(created.status).toBe("investigating")

      const fetched = await store.getIncident(created.id)
      expect(fetched?.title).toBe("checkout down")
    })

    it("returns null for a missing incident", async () => {
      expect(await store.getIncident("INC-does-not-exist")).toBeNull()
    })

    it("issues monotonically increasing ids", async () => {
      const a = await store.createIncident({
        title: "a", severity: "high", service: "svc-a", failureType: "OOMKilled", description: "d",
      })
      const b = await store.createIncident({
        title: "b", severity: "high", service: "svc-b", failureType: "OOMKilled", description: "d",
      })
      expect(Number(b.id.replace("INC-", ""))).toBeGreaterThan(Number(a.id.replace("INC-", "")))
    })

    it("is idempotent for an explicit duplicate id", async () => {
      const first = await store.createIncident({
        id: "INC-4242", title: "first", severity: "low", service: "s", failureType: "network", description: "d1",
      })
      const second = await store.createIncident({
        id: "INC-4242", title: "second", severity: "low", service: "s", failureType: "network", description: "d2",
      })
      expect(second.title).toBe(first.title) // not overwritten
    })

    it("updates fields and computes durationMin when resolvedAt is set", async () => {
      const inc = await store.createIncident({
        title: "x", severity: "medium", service: "s", failureType: "latency-slo",
        description: "d", startedAt: 1_000_000,
      })
      const updated = await store.updateIncident(inc.id, {
        status: "monitoring",
        affectedUsers: 55,
        resolvedAt: 1_000_000 + 5 * 60_000, // +5 minutes
      })
      expect(updated?.status).toBe("monitoring")
      expect(updated?.affectedUsers).toBe(55)
      expect(updated?.durationMin).toBe(5)
    })

    it("clears durationMin when resolvedAt is set back to null", async () => {
      const inc = await store.createIncident({
        title: "x", severity: "low", service: "s", failureType: "network", description: "d",
      })
      await store.updateIncident(inc.id, { resolvedAt: inc.startedAt + 60_000 })
      const reopened = await store.updateIncident(inc.id, { resolvedAt: null })
      expect(reopened?.durationMin).toBeNull()
    })

    it("attaches an RCA via saveRca", async () => {
      const inc = await store.createIncident({
        title: "x", severity: "high", service: "s", failureType: "db-pool-exhaustion", description: "d",
      })
      const withRca = await store.saveRca(inc.id, {
        text: "# RCA\nroot cause…",
        provider: "test",
        generatedAt: new Date().toISOString(),
      })
      expect(withRca?.rca?.text).toContain("root cause")
    })

    it("resolves an incident idempotently", async () => {
      const inc = await store.createIncident({
        title: "x", severity: "high", service: "s", failureType: "OOMKilled", description: "d",
        startedAt: 2_000_000,
      })
      const resolved = await store.resolveIncident(inc.id, 2_000_000 + 120_000)
      expect(resolved?.status).toBe("resolved")
      expect(resolved?.durationMin).toBe(2)
    })

    it("supersedes a prior OPEN live incident for the same service", async () => {
      const first = await store.createIncident({
        title: "first outage", severity: "critical", service: "payments", failureType: "db-pool-exhaustion", description: "d",
      })
      await store.createIncident({
        title: "second outage", severity: "critical", service: "payments", failureType: "db-pool-exhaustion", description: "d",
      })
      const superseded = await store.getIncident(first.id)
      expect(superseded?.status).toBe("resolved")
      expect(superseded?.resolvedAt).not.toBeNull()
    })

    it("does NOT supersede incidents for a different service", async () => {
      const other = await store.createIncident({
        title: "auth outage", severity: "high", service: "auth", failureType: "OOMKilled", description: "d",
      })
      await store.createIncident({
        title: "payments outage", severity: "high", service: "payments", failureType: "db-pool-exhaustion", description: "d",
      })
      const stillOpen = await store.getIncident(other.id)
      expect(stillOpen?.status).toBe("investigating")
    })

    describe("listIncidents filters", () => {
      beforeEach(async () => {
        await store.createIncident({
          id: "INC-100", title: "old auth", severity: "high", service: "auth",
          failureType: "OOMKilled", description: "d", startedAt: 1_000,
        })
        await store.createIncident({
          id: "INC-101", title: "new payments", severity: "critical", service: "payments",
          failureType: "db-pool-exhaustion", description: "d", startedAt: 9_000,
        })
      })

      it("returns all incidents newest-first by default", async () => {
        const list = await store.listIncidents()
        expect(list.map((i) => i.id)).toEqual(["INC-101", "INC-100"])
      })

      it("filters by service", async () => {
        const list = await store.listIncidents({ service: "auth" })
        expect(list.map((i) => i.id)).toEqual(["INC-100"])
      })

      it("filters by severity", async () => {
        const list = await store.listIncidents({ severity: "critical" })
        expect(list.map((i) => i.id)).toEqual(["INC-101"])
      })

      it("filters by an explicit from/to window", async () => {
        const list = await store.listIncidents({ from: 5_000, to: 10_000 })
        expect(list.map((i) => i.id)).toEqual(["INC-101"])
      })
    })
  })
}
