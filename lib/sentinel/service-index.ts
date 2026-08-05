import { serviceNameFromLabels } from "./signal"
import type { PodLike, ServiceResolver } from "./extract"

/** Readiness snapshot for a tracked pod. */
export interface PodReadiness {
  ready: boolean
  /** When the pod was first observed by the index (ms). */
  firstSeen: number
  /** When the pod most recently transitioned to Ready (ms). Undefined while not ready. */
  readySince?: number
}

/** A pod is Ready when it is Running and every container reports ready. */
function podIsReady(pod: PodLike): boolean {
  if (pod.status?.phase !== "Running") return false
  const cs = pod.status?.containerStatuses
  if (!cs || cs.length === 0) return false
  return cs.every((c) => c.ready === true)
}

// A live index of pod → service, maintained by the pod informer, used to resolve
// the service an Event refers to (Events name a Pod, not a workload) and to gate
// startup-transient incidents on per-pod readiness. Pure data structure — no k8s
// client — so it is unit-testable with plain-object fixtures.
export class PodServiceIndex {
  private readonly byPod = new Map<string, string>()
  private readonly readiness = new Map<string, PodReadiness>()
  private readonly now: () => number

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now
  }

  private key(namespace: string, name: string): string {
    return `${namespace}/${name}`
  }

  upsert(pod: PodLike): void {
    const name = pod.metadata?.name
    if (!name) return
    const namespace = pod.metadata?.namespace ?? "default"
    const k = this.key(namespace, name)
    this.byPod.set(k, serviceNameFromLabels(pod.metadata?.labels, name))
    const ready = podIsReady(pod)
    const prev = this.readiness.get(k)
    const firstSeen = prev?.firstSeen ?? this.now()
    if (ready) {
      // Preserve the original readySince across updates; only stamp it on the
      // not-ready → ready transition (or first sighting already Ready).
      this.readiness.set(k, { ready: true, firstSeen, readySince: prev?.ready ? prev.readySince : this.now() })
    } else {
      this.readiness.set(k, { ready: false, firstSeen })
    }
  }

  remove(pod: PodLike): void {
    const name = pod.metadata?.name
    if (!name) return
    const namespace = pod.metadata?.namespace ?? "default"
    const k = this.key(namespace, name)
    this.byPod.delete(k)
    this.readiness.delete(k)
  }

  /** ServiceResolver: map an Event's involvedObject (a Pod) to its service. */
  readonly resolve: ServiceResolver = (namespace, objectName, kind) => {
    if (kind && kind !== "Pod") return undefined
    return this.byPod.get(this.key(namespace, objectName))
  }

  /** Readiness of a tracked pod, or undefined when the pod is unknown. */
  readinessOf(namespace: string, name: string): PodReadiness | undefined {
    return this.readiness.get(this.key(namespace, name))
  }

  get size(): number {
    return this.byPod.size
  }
}
