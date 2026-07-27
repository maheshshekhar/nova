// Single-flight TTL cache for server-side upstream calls.
//
// At scale the /api/metrics route is polled by every open dashboard; without
// coalescing, N clients = N calls to Prometheus / the collector every tick. This
// cache gives two guarantees, keyed by an arbitrary string:
//   • single-flight — concurrent callers for the same key share ONE in-flight
//     producer (so a burst of polls triggers a single upstream request), and
//   • TTL — a resolved value is reused for `ttlMs` (so back-to-back polls within
//     the window don't re-hit the upstream).
//
// A failed producer is NOT cached: the in-flight marker is cleared so the next
// call retries. Pure + injectable clock ⇒ fully unit-testable.

type Producer<T> = () => Promise<T>

interface Entry {
  at: number
  value: unknown
  inflight?: Promise<unknown>
}

export class SingleFlightCache {
  private readonly store = new Map<string, Entry>()

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now
  ) {}

  async get<T>(key: string, producer: Producer<T>): Promise<T> {
    const existing = this.store.get(key)
    const t = this.now()

    // Coalesce concurrent callers onto the same in-flight producer.
    if (existing?.inflight) return existing.inflight as Promise<T>
    // Serve a fresh cached value.
    if (existing && !existing.inflight && t - existing.at < this.ttlMs) {
      return existing.value as T
    }

    const inflight = (async () => {
      try {
        const value = await producer()
        this.store.set(key, { at: this.now(), value })
        return value
      } catch (err) {
        // Don't cache failures — drop the marker so the next call retries.
        this.store.delete(key)
        throw err
      }
    })()

    this.store.set(key, { at: existing?.at ?? 0, value: existing?.value, inflight })
    return inflight as Promise<T>
  }

  /** Test/utility: clear all entries. */
  clear(): void {
    this.store.clear()
  }
}
