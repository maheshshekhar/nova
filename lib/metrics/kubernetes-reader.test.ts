import { describe, expect, it } from "vitest"
import {
  parseCpu,
  parseMemory,
  buildServices,
  buildNamespaces,
  buildDeployments,
  buildClusterState,
  KubernetesMetricsReader,
  type PodInput,
  type PodMetricsInput,
  type DeploymentInput,
} from "@/lib/metrics/kubernetes-reader"

describe("parseCpu / parseMemory", () => {
  it("parses CPU to millicores", () => {
    expect(parseCpu("500m")).toBe(500)
    expect(parseCpu("250000000n")).toBe(250)
    expect(parseCpu("1")).toBe(1000)
    expect(parseCpu(undefined)).toBe(0)
  })
  it("parses memory to Mi", () => {
    expect(parseMemory("512Mi")).toBe(512)
    expect(parseMemory("1048576Ki")).toBe(1024)
    expect(parseMemory("1Gi")).toBe(1024)
    expect(parseMemory(undefined)).toBe(0)
  })
})

function pod(over: {
  name: string
  ns?: string
  app?: string
  phase?: string
  ready?: boolean
  restarts?: number
  waiting?: string
  reqCpu?: string
}): PodInput {
  return {
    metadata: { name: over.name, namespace: over.ns ?? "prod", labels: { app: over.app ?? "checkout" } },
    spec: { containers: [{ resources: { requests: { cpu: over.reqCpu ?? "100m" } } }] },
    status: {
      phase: over.phase ?? "Running",
      containerStatuses: [
        { restartCount: over.restarts ?? 0, ready: over.ready ?? true, state: over.waiting ? { waiting: { reason: over.waiting } } : {} },
      ],
    },
  }
}

const metric = (name: string, ns: string, cpu: string, mem: string): PodMetricsInput => ({
  metadata: { name, namespace: ns },
  containers: [{ usage: { cpu, memory: mem } }],
})

describe("buildServices", () => {
  it("groups pods by namespace/app with counts, CPU% and status", () => {
    const pods = [pod({ name: "checkout-1" }), pod({ name: "checkout-2" })]
    const metrics = [metric("checkout-1", "prod", "50m", "256Mi"), metric("checkout-2", "prod", "50m", "256Mi")]
    const [s] = buildServices(pods, metrics)
    expect(s).toMatchObject({ name: "checkout", namespace: "prod", podCount: 2, readyPods: 2, crashedPods: 0, status: "healthy" })
    expect(s.avgCpu).toBe(50) // 50m of 100m requested = 50%
    expect(s.pods).toHaveLength(2)
  })

  it("marks a crashing pod critical (waiting=CrashLoopBackOff)", () => {
    const [s] = buildServices([pod({ name: "c-1", ready: false, waiting: "CrashLoopBackOff" })], [])
    expect(s).toMatchObject({ crashedPods: 1, status: "critical" })
    expect(s.errorRate).toBeGreaterThan(3)
  })

  it("recovered pods (no waiting) are not crashing even with restarts", () => {
    const [s] = buildServices([pod({ name: "c-1", restarts: 9 })], [])
    expect(s.crashedPods).toBe(0)
    expect(s.status).toBe("healthy")
  })

  it("degraded when some pods are not ready", () => {
    const [s] = buildServices([pod({ name: "a", ready: true }), pod({ name: "b", ready: false })], [])
    expect(s.status).toBe("degraded")
  })
})

describe("buildNamespaces", () => {
  it("summarizes pod counts + service names per namespace", () => {
    const services = buildServices([pod({ name: "checkout-1", ns: "prod" })], [])
    const ns = buildNamespaces([{ metadata: { name: "prod" }, status: { phase: "Active" } }], services)
    expect(ns[0]).toMatchObject({ name: "prod", status: "Active", podCount: 1 })
    expect(ns[0].services).toContain("checkout")
  })
})

describe("buildDeployments", () => {
  const dep = (over: Partial<DeploymentInput["metadata"]> & { replicas?: number; ready?: number; ns?: string; image?: string }): DeploymentInput => ({
    metadata: { name: over.name ?? "checkout", namespace: over.ns ?? "prod", creationTimestamp: "2026-07-01T00:00:00Z" },
    spec: { replicas: over.replicas ?? 3, template: { spec: { containers: [{ image: over.image ?? "checkout:v2" }] } } },
    status: { readyReplicas: over.ready ?? 3 },
  })

  it("maps deployments with version + status, skipping system namespaces", () => {
    const out = buildDeployments([
      dep({ name: "checkout", ready: 3, replicas: 3 }),
      dep({ name: "kube-dns", ns: "kube-system" }),
    ])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ name: "checkout", version: "v2", status: "success", replicas: 3, readyReplicas: 3 })
  })

  it("status failed when zero ready, running when partial", () => {
    expect(buildDeployments([dep({ ready: 0, replicas: 2 })])[0].status).toBe("failed")
    expect(buildDeployments([dep({ ready: 1, replicas: 2 })])[0].status).toBe("running")
  })
})

describe("KubernetesMetricsReader", () => {
  it("aggregates a full cluster state from the injected client", async () => {
    const client = {
      listPods: async () => [pod({ name: "checkout-1" })],
      podMetrics: async () => [metric("checkout-1", "prod", "50m", "256Mi")],
      listNamespaces: async () => [{ metadata: { name: "prod" }, status: { phase: "Active" } }],
      listDeployments: async () => [],
    }
    const state = await new KubernetesMetricsReader(client).readClusterState(1000)
    expect(state.services[0]).toMatchObject({ name: "checkout", podCount: 1 })
    expect(state.namespaces[0].name).toBe("prod")
    expect(state.lastUpdated).toBe(1000)
  })

  it("degrades a failed sub-read to empty (tolerant)", async () => {
    const client = {
      listPods: async () => { throw new Error("boom") },
      podMetrics: async () => [],
      listNamespaces: async () => [],
      listDeployments: async () => [],
    }
    const state = await new KubernetesMetricsReader(client).readClusterState()
    expect(state.services).toEqual([])
  })
})

describe("buildClusterState shape", () => {
  it("matches the collector's top-level shape", () => {
    const state = buildClusterState([], [], [], [], 5)
    expect(state).toMatchObject({ services: [], namespaces: [], deployments: [], incidentActive: false, lastUpdated: 5 })
    expect(typeof state.timestamp).toBe("string")
  })
})
