import { serviceNameFromLabels } from "./signal"
import type { PodLike, ServiceResolver } from "./extract"

// A live index of pod → service, maintained by the pod informer, used to resolve
// the service an Event refers to (Events name a Pod, not a workload). Pure data
// structure — no k8s client — so it is unit-testable with plain-object fixtures.
export class PodServiceIndex {
  private readonly byPod = new Map<string, string>()

  private key(namespace: string, name: string): string {
    return `${namespace}/${name}`
  }

  upsert(pod: PodLike): void {
    const name = pod.metadata?.name
    if (!name) return
    const namespace = pod.metadata?.namespace ?? "default"
    this.byPod.set(this.key(namespace, name), serviceNameFromLabels(pod.metadata?.labels, name))
  }

  remove(pod: PodLike): void {
    const name = pod.metadata?.name
    if (!name) return
    const namespace = pod.metadata?.namespace ?? "default"
    this.byPod.delete(this.key(namespace, name))
  }

  /** ServiceResolver: map an Event's involvedObject (a Pod) to its service. */
  readonly resolve: ServiceResolver = (namespace, objectName, kind) => {
    if (kind && kind !== "Pod") return undefined
    return this.byPod.get(this.key(namespace, objectName))
  }

  get size(): number {
    return this.byPod.size
  }
}
