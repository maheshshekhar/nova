import { describe, expect, it } from "vitest"
import { extractPodSignals, type PodLike } from "@/lib/sentinel/extract"

// Build a pod fixture with one container in a given state.
function pod(over: {
  name?: string
  namespace?: string
  labels?: Record<string, string>
  phase?: string
  conditions?: { type?: string; status?: string; reason?: string; message?: string }[]
  container?: {
    name?: string
    restartCount?: number
    ready?: boolean
    waiting?: { reason?: string; message?: string }
    terminated?: { reason?: string; exitCode?: number }
    lastTerminated?: { reason?: string; exitCode?: number }
  }
}): PodLike {
  return {
    metadata: { name: over.name ?? "svc-abc123", namespace: over.namespace ?? "prod", labels: over.labels ?? { app: "checkout" } },
    status: {
      phase: over.phase,
      conditions: over.conditions,
      containerStatuses: over.container
        ? [
            {
              name: over.container.name ?? "app",
              restartCount: over.container.restartCount ?? 0,
              ready: over.container.ready ?? true,
              state: {
                waiting: over.container.waiting,
                terminated: over.container.terminated,
              },
              lastState: { terminated: over.container.lastTerminated },
            },
          ]
        : [],
    },
  }
}

describe("extractPodSignals — hard signals", () => {
  it("CrashLoopBackOff → hard critical", () => {
    const [s] = extractPodSignals(pod({ container: { waiting: { reason: "CrashLoopBackOff" } } }))
    expect(s).toMatchObject({ kind: "CrashLoopBackOff", severity: "critical", hard: true, service: "checkout", namespace: "prod" })
    expect(s.source).toEqual({ kind: "Pod", name: "svc-abc123" })
  })

  it("OOMKilled (from lastState) → hard critical", () => {
    const sigs = extractPodSignals(pod({ container: { lastTerminated: { reason: "OOMKilled", exitCode: 137 } } }))
    const oom = sigs.find((s) => s.kind === "OOMKilled")!
    expect(oom).toMatchObject({ severity: "critical", hard: true })
    expect(oom.message).toContain("137")
  })

  it("ImagePullBackOff and ErrImagePull both map to ImagePullBackOff", () => {
    expect(extractPodSignals(pod({ container: { waiting: { reason: "ImagePullBackOff" } } }))[0].kind).toBe("ImagePullBackOff")
    expect(extractPodSignals(pod({ container: { waiting: { reason: "ErrImagePull" } } }))[0].kind).toBe("ImagePullBackOff")
  })

  it("CreateContainerConfigError (missing secret/configmap) → hard critical, keeps the message", () => {
    const [s] = extractPodSignals(
      pod({ container: { waiting: { reason: "CreateContainerConfigError", message: 'secret "db-creds" not found' } } })
    )
    expect(s).toMatchObject({ kind: "CreateContainerConfigError", hard: true })
    expect(s.message).toContain('secret "db-creds" not found')
  })

  it("RunContainerError/Error → ContainerError", () => {
    expect(extractPodSignals(pod({ container: { waiting: { reason: "RunContainerError" } } }))[0].kind).toBe("ContainerError")
    expect(extractPodSignals(pod({ container: { waiting: { reason: "Error" } } }))[0].kind).toBe("ContainerError")
  })

  it("Pending + PodScheduled=False → Unschedulable hard critical", () => {
    const [s] = extractPodSignals(
      pod({ phase: "Pending", conditions: [{ type: "PodScheduled", status: "False", reason: "Unschedulable", message: "0/3 nodes available" }] })
    )
    expect(s).toMatchObject({ kind: "Unschedulable", hard: true, severity: "critical" })
    expect(s.message).toContain("0/3 nodes available")
  })
})

describe("extractPodSignals — soft signals", () => {
  it("restarts at/above the threshold → soft warning HighRestarts", () => {
    const [s] = extractPodSignals(pod({ container: { restartCount: 3 } }))
    expect(s).toMatchObject({ kind: "HighRestarts", hard: false, severity: "warning" })
    expect(s.message).toContain("3 times")
  })

  it("restarts below the threshold → no signal", () => {
    expect(extractPodSignals(pod({ container: { restartCount: 2 } }))).toEqual([])
  })
})

describe("extractPodSignals — service resolution & hygiene", () => {
  it("resolves the service from the app label, else app.kubernetes.io/name, else the pod name", () => {
    expect(extractPodSignals(pod({ labels: { app: "payments" }, container: { waiting: { reason: "CrashLoopBackOff" } } }))[0].service).toBe("payments")
    expect(
      extractPodSignals(pod({ labels: { "app.kubernetes.io/name": "orders" }, container: { waiting: { reason: "CrashLoopBackOff" } } }))[0].service
    ).toBe("orders")
    expect(
      extractPodSignals(pod({ name: "lonely-pod", labels: {}, container: { waiting: { reason: "CrashLoopBackOff" } } }))[0].service
    ).toBe("lonely-pod")
  })

  it("a healthy pod yields no signals", () => {
    expect(extractPodSignals(pod({ phase: "Running", container: { ready: true, restartCount: 0 } }))).toEqual([])
  })

  it("dedupes to one signal per kind even with multiple failing containers", () => {
    const p: PodLike = {
      metadata: { name: "multi", namespace: "prod", labels: { app: "svc" } },
      status: {
        containerStatuses: [
          { name: "a", state: { waiting: { reason: "CrashLoopBackOff" } } },
          { name: "b", state: { waiting: { reason: "CrashLoopBackOff" } } },
        ],
      },
    }
    const sigs = extractPodSignals(p)
    expect(sigs.filter((s) => s.kind === "CrashLoopBackOff")).toHaveLength(1)
  })

  it("emits multiple DISTINCT kinds from one pod (e.g. OOMKilled + HighRestarts)", () => {
    const sigs = extractPodSignals(pod({ container: { restartCount: 5, lastTerminated: { reason: "OOMKilled", exitCode: 137 } } }))
    expect(sigs.map((s) => s.kind).sort()).toEqual(["HighRestarts", "OOMKilled"])
  })
})
