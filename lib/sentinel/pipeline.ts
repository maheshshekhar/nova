import { extractPodSignals, extractEventSignal, type PodLike, type EventLike, type ServiceResolver } from "./extract"
import type { Signal } from "./signal"

// Turn a batch of live Kubernetes objects into normalized signals. Pure glue over
// the extractors — the informer worker calls this each tick, then feeds the
// result into the Correlator. Testable end-to-end with plain-object fixtures.

export interface SignalBatchInput {
  pods?: PodLike[]
  events?: EventLike[]
}

export function collectSignals(
  input: SignalBatchInput,
  resolveService?: ServiceResolver
): Signal[] {
  const out: Signal[] = []
  for (const pod of input.pods ?? []) {
    out.push(...extractPodSignals(pod))
  }
  for (const event of input.events ?? []) {
    const s = extractEventSignal(event, resolveService)
    if (s) out.push(s)
  }
  return out
}
