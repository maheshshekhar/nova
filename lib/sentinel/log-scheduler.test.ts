import { describe, expect, it } from "vitest"
import { TailScheduler, type TailHandle } from "@/lib/sentinel/log-scheduler"

/** A fake stream opener that records opens/stops and lets tests end streams. */
function fakeOpener() {
  const opened: string[] = []
  const closers = new Map<string, () => void>()
  const stopped: string[] = []
  const open = (key: string, onClosed: () => void): TailHandle => {
    opened.push(key)
    closers.set(key, onClosed)
    return {
      stop() {
        stopped.push(key)
        closers.delete(key)
      },
    }
  }
  return {
    open,
    opened,
    stopped,
    /** Simulate the stream for `key` ending on its own. */
    endStream(key: string) {
      const c = closers.get(key)
      closers.delete(key)
      c?.()
    },
  }
}

describe("TailScheduler", () => {
  it("opens streams up to the concurrency cap and queues the rest", () => {
    const f = fakeOpener()
    const s = new TailScheduler(f.open, { maxConcurrent: 2 })
    s.add("a")
    s.add("b")
    s.add("c")
    expect(f.opened).toEqual(["a", "b"])
    expect(s.activeCount()).toBe(2)
    expect(s.isActive("c")).toBe(false)
  })

  it("admits the next waiter when an active stream ends", () => {
    const f = fakeOpener()
    const s = new TailScheduler(f.open, { maxConcurrent: 1 })
    s.add("a")
    s.add("b")
    expect(f.opened).toEqual(["a"])
    f.endStream("a")
    expect(f.opened).toEqual(["a", "b"]) // b admitted after a closed
  })

  it("prioritizes priority keys ahead of the best-effort queue", () => {
    const f = fakeOpener()
    const s = new TailScheduler(f.open, { maxConcurrent: 1 })
    s.add("a") // takes the only slot
    s.add("b") // queued
    s.add("p", true) // priority → evicts a non-priority active
    expect(f.stopped).toContain("a")
    expect(s.isActive("p")).toBe(true)
  })

  it("promoting an already-queued key to priority makes room for it", () => {
    const f = fakeOpener()
    const s = new TailScheduler(f.open, { maxConcurrent: 2 })
    s.add("a")
    s.add("b")
    s.add("c") // queued
    s.add("c", true) // promote c → evict a newest non-priority (b), admit c
    expect(s.isActive("c")).toBe(true)
    expect(s.activeCount()).toBe(2)
  })

  it("remove() stops an active stream and admits a waiter", () => {
    const f = fakeOpener()
    const s = new TailScheduler(f.open, { maxConcurrent: 1 })
    s.add("a")
    s.add("b")
    s.remove("a")
    expect(f.stopped).toContain("a")
    expect(s.isActive("b")).toBe(true)
  })

  it("is idempotent on repeated add of the same key", () => {
    const f = fakeOpener()
    const s = new TailScheduler(f.open, { maxConcurrent: 5 })
    s.add("a")
    s.add("a")
    s.add("a")
    expect(f.opened).toEqual(["a"])
    expect(s.activeCount()).toBe(1)
  })

  it("re-admits a self-closed key when capacity is available", () => {
    const f = fakeOpener()
    const s = new TailScheduler(f.open, { maxConcurrent: 2 })
    s.add("a")
    s.add("b")
    f.endStream("a") // a closes; still wanted → re-admitted since a slot is free
    expect(f.opened).toEqual(["a", "b", "a"])
  })
})
