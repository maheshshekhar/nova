// Bounded, priority-aware scheduler for pod-log follow-streams.
//
// Per-pod follow-streams are limited by the client + apiserver concurrent-stream
// budget, so opening one unconditionally per pod silently drops streams past the
// limit. This scheduler caps concurrency and, when at capacity, tails PRIORITY
// pods first (those already showing trouble — their logs are the ones an incident
// is most likely to need). A freed slot immediately admits the next waiter.
//
// Pure: the caller injects how to actually open/stop a stream, so this is fully
// unit-testable without a cluster.

export interface TailHandle {
  stop(): void
}

/** Opens a stream for `key`; calls `onClosed` when it ends on its own (so the
 * scheduler can free the slot). Returns a handle to stop it proactively. */
export type OpenStream = (key: string, onClosed: () => void) => TailHandle

interface Wanted {
  priority: boolean
  seq: number
}

export interface TailSchedulerOptions {
  maxConcurrent: number
}

export class TailScheduler {
  private readonly max: number
  private readonly open: OpenStream
  private readonly wanted = new Map<string, Wanted>()
  private readonly active = new Map<string, TailHandle>()
  private seq = 0

  constructor(open: OpenStream, opts: TailSchedulerOptions) {
    this.open = open
    this.max = Math.max(1, opts.maxConcurrent)
  }

  /** Register a key to be tailed (idempotent). `priority` promotes it ahead of
   * best-effort tails and, if all slots are full of non-priority tails, evicts
   * one to make room. */
  add(key: string, priority = false): void {
    const existing = this.wanted.get(key)
    if (existing) {
      if (priority && !existing.priority) {
        existing.priority = true
        if (!this.active.has(key)) this.ensureRoomForPriority()
      }
    } else {
      this.wanted.set(key, { priority, seq: this.seq++ })
      if (priority && this.active.size >= this.max) this.ensureRoomForPriority()
    }
    this.schedule()
  }

  /** Unregister a key (pod deleted); stops its stream if active. */
  remove(key: string): void {
    this.wanted.delete(key)
    const handle = this.active.get(key)
    if (handle) {
      this.active.delete(key)
      try {
        handle.stop()
      } catch {
        // best effort
      }
    }
    this.schedule()
  }

  activeCount(): number {
    return this.active.size
  }

  isActive(key: string): boolean {
    return this.active.has(key)
  }

  private ensureRoomForPriority(): void {
    if (this.active.size < this.max) return
    // Evict the newest non-priority active tail to free a slot.
    let victim: string | undefined
    let victimSeq = -1
    for (const key of this.active.keys()) {
      const w = this.wanted.get(key)
      if (w && !w.priority && w.seq > victimSeq) {
        victim = key
        victimSeq = w.seq
      }
    }
    if (victim) {
      const handle = this.active.get(victim)!
      this.active.delete(victim)
      try {
        handle.stop()
      } catch {
        // best effort
      }
    }
  }

  private schedule(): void {
    while (this.active.size < this.max) {
      const next = this.pickWaiting()
      if (!next) return
      this.startTail(next)
    }
  }

  /** Highest-priority, then earliest-registered, key not yet active. */
  private pickWaiting(): string | undefined {
    let best: string | undefined
    let bestPriority = false
    let bestSeq = Infinity
    for (const [key, w] of this.wanted) {
      if (this.active.has(key)) continue
      const better =
        best === undefined ||
        (w.priority && !bestPriority) ||
        (w.priority === bestPriority && w.seq < bestSeq)
      if (better) {
        best = key
        bestPriority = w.priority
        bestSeq = w.seq
      }
    }
    return best
  }

  private startTail(key: string): void {
    // Reserve the slot synchronously to avoid a double-start race.
    const placeholder: TailHandle = { stop() {} }
    this.active.set(key, placeholder)
    const handle = this.open(key, () => {
      // Stream ended on its own: free the slot. The key stays wanted, but move it
      // to the back of the queue so other waiters get a fair turn before it is
      // re-tailed.
      if (this.active.get(key)) this.active.delete(key)
      const w = this.wanted.get(key)
      if (w) w.seq = this.seq++
      this.schedule()
    })
    if (this.active.get(key) === placeholder) this.active.set(key, handle)
  }
}
