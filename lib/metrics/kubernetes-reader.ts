// Native Kubernetes metrics reader — the in-process replacement for the external
// `metrics-collector` sidecar. It reads pods, pod metrics (metrics-server),
// namespaces and deployments and aggregates them into the SAME JSON shapes the
// collector served (`/metrics`, `/metrics/services`, `/metrics/namespaces`,
// `/metrics/deployments`), so `app/api/metrics` can consume it identically.
//
// The aggregation is PURE (structural inputs, no k8s client) so it is fully
// unit-testable; the thin I/O adapter that fetches from the cluster is injected.

// ── Output shapes (mirror the collector's JSON exactly) ──────────────────────

export interface PodMetric {
  name: string
  cpu: number // millicores
  cpuPercent: number
  memory: number // Mi
  memoryPercent: number
  status: string
  restarts: number
  ready: boolean
  crashing: boolean
}

export interface ServiceMetric {
  name: string
  namespace: string
  podCount: number
  readyPods: number
  crashedPods: number
  avgCpu: number
  avgMemory: number
  status: "healthy" | "degraded" | "critical"
  errorRate: number
  pods: PodMetric[]
}

export interface NamespaceInfo {
  name: string
  status: string
  podCount: number
  services: string[]
}

export interface DeploymentInfo {
  name: string
  namespace: string
  image: string
  version: string
  replicas: number
  readyReplicas: number
  status: "success" | "running" | "failed"
  updatedAt: string
}

export interface ClusterState {
  timestamp: string
  services: ServiceMetric[]
  namespaces: NamespaceInfo[]
  deployments: DeploymentInfo[]
  incidentActive: boolean
  lastUpdated: number
}

// ── Structural inputs (the subset of k8s objects we read) ────────────────────

export interface PodInput {
  metadata?: { name?: string; namespace?: string; labels?: Record<string, string> }
  spec?: { containers?: { resources?: { requests?: { cpu?: string } } }[] }
  status?: {
    phase?: string
    containerStatuses?: { restartCount?: number; ready?: boolean; state?: { waiting?: { reason?: string } } }[]
  }
}

export interface PodMetricsInput {
  metadata?: { name?: string; namespace?: string }
  containers?: { usage?: { cpu?: string; memory?: string } }[]
}

export interface NamespaceInput {
  metadata?: { name?: string }
  status?: { phase?: string }
}

export interface DeploymentInput {
  metadata?: { name?: string; namespace?: string; creationTimestamp?: string | Date }
  spec?: { replicas?: number; template?: { spec?: { containers?: { image?: string }[] } } }
  status?: { readyReplicas?: number; conditions?: { type?: string; lastUpdateTime?: string | Date }[] }
}

/** What the reader needs from the cluster; the real adapter is injected (Phase B). */
export interface KubeReaderClient {
  listPods(): Promise<PodInput[]>
  podMetrics(): Promise<PodMetricsInput[]>
  listNamespaces(): Promise<NamespaceInput[]>
  listDeployments(): Promise<DeploymentInput[]>
}

// ── Unit parsing (ported from the collector, faithful units) ─────────────────

/** CPU quantity → millicores. */
export function parseCpu(cpuStr?: string): number {
  if (!cpuStr) return 0
  if (cpuStr.endsWith("n")) return Math.round(parseInt(cpuStr) / 1_000_000)
  if (cpuStr.endsWith("m")) return parseInt(cpuStr)
  return parseInt(cpuStr) * 1000
}

/** Memory quantity → Mi. */
export function parseMemory(memStr?: string): number {
  if (!memStr) return 0
  if (memStr.endsWith("Ki")) return Math.round(parseInt(memStr) / 1024)
  if (memStr.endsWith("Mi")) return parseInt(memStr)
  if (memStr.endsWith("Gi")) return Math.round(parseInt(memStr) * 1024)
  return parseInt(memStr)
}

function determineStatus(
  errorRate: number,
  crashedPods: number,
  readyPods: number,
  totalPods: number
): ServiceMetric["status"] {
  if (crashedPods > 0 || errorRate > 3 || readyPods === 0) return "critical"
  if (errorRate > 0.5 || readyPods < totalPods) return "degraded"
  return "healthy"
}

const CRASH_WAITING = new Set(["CrashLoopBackOff", "Error", "RunContainerError", "CreateContainerError"])

const SYSTEM_NAMESPACES = new Set(["kube-system", "kube-public", "kube-node-lease", "local-path-storage"])

// ── Pure aggregation ─────────────────────────────────────────────────────────

/** Group pods by `namespace/app` into service metrics (pod counts, crash state,
 * avg CPU/mem %, a crash-derived error-rate heuristic, and per-pod detail). */
export function buildServices(pods: PodInput[], metrics: PodMetricsInput[]): ServiceMetric[] {
  const metricsMap = new Map<string, { cpu: number; memory: number }>()
  for (const item of metrics) {
    const cpu = (item.containers ?? []).reduce((sum, c) => sum + parseCpu(c.usage?.cpu), 0)
    const memory = (item.containers ?? []).reduce((sum, c) => sum + parseMemory(c.usage?.memory), 0)
    const ns = item.metadata?.namespace || "default"
    metricsMap.set(`${ns}/${item.metadata?.name}`, { cpu, memory })
  }

  const serviceMap = new Map<string, { namespace: string; app: string; pods: PodMetric[] }>()
  for (const pod of pods) {
    const namespace = pod.metadata?.namespace || "default"
    const app = pod.metadata?.labels?.["app"] || "unknown"
    const podName = pod.metadata?.name || "unknown"
    const phase = pod.status?.phase || "Unknown"
    const cs = pod.status?.containerStatuses ?? []
    const restarts = cs.reduce((sum, c) => sum + (c.restartCount || 0), 0)
    const ready = cs.length > 0 && cs.every((c) => c.ready)
    // Current crash state (NOT cumulative restartCount, so recovered pods go green).
    const crashing = phase === "Failed" || cs.some((c) => CRASH_WAITING.has(c.state?.waiting?.reason ?? ""))
    const m = metricsMap.get(`${namespace}/${podName}`) || { cpu: 0, memory: 0 }
    const requestCpu = (pod.spec?.containers ?? []).reduce((sum, c) => sum + parseCpu(c.resources?.requests?.cpu), 0)
    const cpuPercent =
      requestCpu > 0
        ? Math.min(Math.round((m.cpu / requestCpu) * 100), 100)
        : Math.min(Math.round((m.cpu / 1000) * 100), 100)

    const podMetric: PodMetric = {
      name: podName,
      cpu: m.cpu,
      cpuPercent,
      memory: m.memory,
      memoryPercent: Math.min(Math.round((m.memory / 512) * 100), 100),
      status: phase,
      restarts,
      ready,
      crashing,
    }
    const key = `${namespace}/${app}`
    if (!serviceMap.has(key)) serviceMap.set(key, { namespace, app, pods: [] })
    serviceMap.get(key)!.pods.push(podMetric)
  }

  const services: ServiceMetric[] = []
  for (const { namespace, app, pods: sp } of serviceMap.values()) {
    const readyPods = sp.filter((p) => p.ready).length
    const crashedPods = sp.filter((p) => p.crashing).length
    const avgCpu = sp.length ? Math.round(sp.reduce((s, p) => s + p.cpuPercent, 0) / sp.length) : 0
    const avgMemory = sp.length ? Math.round(sp.reduce((s, p) => s + p.memoryPercent, 0) / sp.length) : 0
    // Crash-derived error-rate heuristic (deterministic; real RED metrics come
    // from Prometheus when configured).
    const errorRate = crashedPods > 0 ? Math.min(5 + crashedPods * 1.5, 9.99) : readyPods < sp.length ? 1.2 : 0.1
    services.push({
      name: app,
      namespace,
      podCount: sp.length,
      readyPods,
      crashedPods,
      avgCpu,
      avgMemory,
      status: determineStatus(errorRate, crashedPods, readyPods, sp.length),
      errorRate: Math.round(errorRate * 100) / 100,
      pods: sp,
    })
  }
  return services
}

export function buildNamespaces(namespaces: NamespaceInput[], services: ServiceMetric[]): NamespaceInfo[] {
  return namespaces.map((ns) => {
    const name = ns.metadata?.name || "unknown"
    const nsServices = services.filter((s) => s.namespace === name)
    return {
      name,
      status: ns.status?.phase || "Unknown",
      podCount: nsServices.reduce((sum, s) => sum + s.podCount, 0),
      services: nsServices.map((s) => s.name).filter((n) => n !== "unknown"),
    }
  })
}

export function buildDeployments(deployments: DeploymentInput[]): DeploymentInfo[] {
  const out: DeploymentInfo[] = []
  for (const d of deployments) {
    const namespace = d.metadata?.namespace || "default"
    if (SYSTEM_NAMESPACES.has(namespace)) continue
    const name = d.metadata?.name || "unknown"
    const image = d.spec?.template?.spec?.containers?.[0]?.image || ""
    const version = image.includes(":") ? image.split(":").pop()! : "latest"
    const replicas = d.spec?.replicas ?? 0
    const readyReplicas = d.status?.readyReplicas ?? 0
    const updatedAt =
      d.status?.conditions?.find((c) => c.type === "Progressing")?.lastUpdateTime?.toString() ||
      d.metadata?.creationTimestamp?.toString() ||
      new Date().toISOString()
    const status: DeploymentInfo["status"] =
      readyReplicas === 0 && replicas > 0 ? "failed" : readyReplicas < replicas ? "running" : "success"
    out.push({ name, namespace, image, version, replicas, readyReplicas, status, updatedAt })
  }
  out.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
  return out
}

export function buildClusterState(
  pods: PodInput[],
  metrics: PodMetricsInput[],
  namespaces: NamespaceInput[],
  deployments: DeploymentInput[],
  now: number = Date.now()
): ClusterState {
  const services = buildServices(pods, metrics)
  return {
    timestamp: new Date(now).toISOString(),
    services,
    namespaces: buildNamespaces(namespaces, services),
    deployments: buildDeployments(deployments),
    // Kept for shape-compatibility with the collector; the dashboard derives its
    // own incident state from the store, not this flag.
    incidentActive: false,
    lastUpdated: now,
  }
}

/** Reads the cluster via an injected client and aggregates it. Tolerant: a
 * failed sub-read degrades to empty for that section (matching the collector). */
export class KubernetesMetricsReader {
  constructor(private readonly client: KubeReaderClient) {}

  async readClusterState(now: number = Date.now()): Promise<ClusterState> {
    const [pods, metrics, namespaces, deployments] = await Promise.all([
      this.client.listPods().catch(() => [] as PodInput[]),
      this.client.podMetrics().catch(() => [] as PodMetricsInput[]),
      this.client.listNamespaces().catch(() => [] as NamespaceInput[]),
      this.client.listDeployments().catch(() => [] as DeploymentInput[]),
    ])
    return buildClusterState(pods, metrics, namespaces, deployments, now)
  }
}
