import express from "express"
import cors from "cors"
import * as k8s from "@kubernetes/client-node"

const app = express()
const PORT = process.env.PORT || 3001
// The namespace running the application workloads (payment-service,
// postgres, load-generator). Pod metrics + the namespace inventory are gathered
// cluster-wide; only payment-service log tailing is scoped to this namespace.
const PAYMENT_NAMESPACE = process.env.PAYMENT_NAMESPACE || "production"
const POLL_INTERVAL = 3000

app.use(cors())
app.use(express.json())

// ── Kubernetes client setup ──────────────────────────────────────────────────

const kc = new k8s.KubeConfig()

// Load config from inside cluster (ServiceAccount token) or local kubeconfig
if (process.env.KUBERNETES_SERVICE_HOST) {
  kc.loadFromCluster()
} else {
  kc.loadFromDefault()
}

const coreApi = kc.makeApiClient(k8s.CoreV1Api)
const appsApi = kc.makeApiClient(k8s.AppsV1Api)
const metricsApi = new k8s.Metrics(kc)

// ── In-memory state ──────────────────────────────────────────────────────────

interface PodMetric {
  name: string
  cpu: number      // millicores
  cpuPercent: number
  memory: number   // Mi
  memoryPercent: number
  status: string
  restarts: number
  ready: boolean
  crashing: boolean
}

interface ServiceMetric {
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

interface NamespaceInfo {
  name: string
  status: string
  podCount: number
  services: string[]
}

interface DeploymentInfo {
  name: string
  namespace: string
  image: string
  version: string
  replicas: number
  readyReplicas: number
  status: "success" | "running" | "failed"
  updatedAt: string
}

interface ClusterState {
  timestamp: string
  services: ServiceMetric[]
  namespaces: NamespaceInfo[]
  deployments: DeploymentInfo[]
  incidentActive: boolean
  lastUpdated: number
}

let state: ClusterState = {
  timestamp: new Date().toISOString(),
  services: [],
  namespaces: [],
  deployments: [],
  incidentActive: false,
  lastUpdated: Date.now()
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseCpu(cpuStr: string): number {
  if (!cpuStr) return 0
  if (cpuStr.endsWith("n")) return Math.round(parseInt(cpuStr) / 1_000_000)
  if (cpuStr.endsWith("m")) return parseInt(cpuStr)
  return parseInt(cpuStr) * 1000
}

function parseMemory(memStr: string): number {
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
): "healthy" | "degraded" | "critical" {
  if (crashedPods > 0 || errorRate > 3 || readyPods === 0) return "critical"
  if (errorRate > 0.5 || readyPods < totalPods) return "degraded"
  return "healthy"
}

// ── Metrics collector ────────────────────────────────────────────────────────

// ── Pod metrics collector ────────────────────────────────────────────────────

async function collectPodMetrics(): Promise<void> {
  try {
    const [podList, topMetrics, nsList] = await Promise.allSettled([
      coreApi.listPodForAllNamespaces(),
      metricsApi.getPodMetrics(),
      coreApi.listNamespace()
    ])

    if (podList.status === "rejected") {
      console.error("Failed to list pods:", podList.reason)
      return
    }

    const pods = podList.value.body.items
    // Metrics are keyed by "namespace/podName" so identically-named pods in
    // different namespaces never collide.
    const metricsMap = new Map<string, { cpu: number; memory: number }>()

    if (topMetrics.status === "fulfilled") {
      for (const item of topMetrics.value.items) {
        const cpu = item.containers.reduce(
          (sum: number, c: any) => sum + parseCpu(c.usage.cpu), 0
        )
        const memory = item.containers.reduce(
          (sum: number, c: any) => sum + parseMemory(c.usage.memory), 0
        )
        const ns = (item.metadata as any)?.namespace || "default"
        metricsMap.set(`${ns}/${item.metadata.name}`, { cpu, memory })
      }
    }

    // Group pods by service, scoped per namespace (key = "namespace/app").
    const serviceMap = new Map<string, { namespace: string; app: string; pods: PodMetric[] }>()

    for (const pod of pods) {
      const namespace = pod.metadata?.namespace || "default"
      const appLabel = pod.metadata?.labels?.["app"] || "unknown"
      const podName = pod.metadata?.name || "unknown"
      const phase = pod.status?.phase || "Unknown"
      const containerStatuses = pod.status?.containerStatuses || []
      const restarts = containerStatuses.reduce(
        (sum, cs) => sum + (cs.restartCount || 0), 0
      )
      const ready = containerStatuses.every(cs => cs.ready)
      // CURRENT crash state — a container actively waiting in a crash/backoff
      // state, or a Failed pod. Deliberately NOT based on cumulative restartCount:
      // that never resets, so a pod that has recovered would otherwise be reported
      // as crashed forever and the dashboard would never go green after recovery.
      const crashing =
        phase === "Failed" ||
        containerStatuses.some(cs => {
          const reason = cs.state?.waiting?.reason
          return (
            reason === "CrashLoopBackOff" ||
            reason === "Error" ||
            reason === "RunContainerError" ||
            reason === "CreateContainerError"
          )
        })
      const metrics = metricsMap.get(`${namespace}/${podName}`) || { cpu: 0, memory: 0 }

      // CPU as a percent of the pod's REQUESTED CPU (more meaningful than raw
      // millicores-vs-a-full-core): idle pods read a few %, a busy/stressed
      // service approaches or maxes 100%.
      const requestCpu = (pod.spec?.containers || []).reduce((sum, c) => {
        const req = c.resources?.requests?.cpu
        return sum + (req ? parseCpu(req) : 0)
      }, 0)
      const cpuPercent =
        requestCpu > 0
          ? Math.min(Math.round((metrics.cpu / requestCpu) * 100), 100)
          : Math.min(Math.round((metrics.cpu / 1000) * 100), 100)

      const podMetric: PodMetric = {
        name: podName,
        cpu: metrics.cpu,
        cpuPercent,
        memory: metrics.memory,
        memoryPercent: Math.min(Math.round((metrics.memory / 512) * 100), 100),
        status: phase,
        restarts,
        ready,
        crashing
      }

      const key = `${namespace}/${appLabel}`
      if (!serviceMap.has(key)) serviceMap.set(key, { namespace, app: appLabel, pods: [] })
      serviceMap.get(key)!.pods.push(podMetric)
    }

    // Build service metrics
    const services: ServiceMetric[] = []

    for (const { namespace, app, pods: servicePods } of serviceMap.values()) {
      const readyPods = servicePods.filter(p => p.ready).length
      const crashedPods = servicePods.filter(
        p => p.crashing
      ).length
      const avgCpu = servicePods.length > 0
        ? Math.round(servicePods.reduce((s, p) => s + p.cpuPercent, 0) / servicePods.length)
        : 0
      const avgMemory = servicePods.length > 0
        ? Math.round(servicePods.reduce((s, p) => s + p.memoryPercent, 0) / servicePods.length)
        : 0

      // Derive error rate from crash state
      const errorRate = crashedPods > 0
        ? Math.min(5 + crashedPods * 1.5, 9.99)
        : readyPods < servicePods.length
          ? 1.2
          : 0.08 + Math.random() * 0.1

      const status = determineStatus(
        errorRate, crashedPods, readyPods, servicePods.length
      )

      services.push({
        name: app,
        namespace,
        podCount: servicePods.length,
        readyPods,
        crashedPods,
        avgCpu,
        avgMemory,
        status,
        errorRate: Math.round(errorRate * 100) / 100,
        pods: servicePods
      })
    }

    // Namespace inventory — full list of namespaces with pod counts + the
    // services (app labels) running in each, so the AI assistant can answer
    // cluster-wide questions.
    if (nsList.status === "fulfilled") {
      state.namespaces = nsList.value.body.items.map(ns => {
        const nsName = ns.metadata?.name || "unknown"
        const nsServices = services.filter(s => s.namespace === nsName)
        return {
          name: nsName,
          status: ns.status?.phase || "Unknown",
          podCount: nsServices.reduce((sum, s) => sum + s.podCount, 0),
          services: nsServices.map(s => s.name).filter(n => n !== "unknown")
        }
      })
    }

    state.services = services
    state.incidentActive = services.some(
      s => s.name === "payment-service" && s.status === "critical"
    )
    state.timestamp = new Date().toISOString()
    state.lastUpdated = Date.now()

  } catch (err) {
    console.error("Error collecting pod metrics:", err)
  }
}

// ── Deployment collector ─────────────────────────────────────────────────────

const DEPLOY_NAMESPACES = ["production", "nova-monitoring", "db-postgres"]

async function collectDeployments(): Promise<void> {
  try {
    const all: DeploymentInfo[] = []
    for (const ns of DEPLOY_NAMESPACES) {
      let list
      try {
        list = await appsApi.listNamespacedDeployment(ns)
      } catch {
        continue
      }
      for (const d of list.body.items) {
        const name = d.metadata?.name || "unknown"
        const image = d.spec?.template?.spec?.containers?.[0]?.image || ""
        const version = image.includes(":") ? image.split(":").pop()! : "latest"
        const replicas = d.spec?.replicas ?? 0
        const ready = d.status?.readyReplicas ?? 0
        const updatedAt =
          d.status?.conditions?.find((c) => c.type === "Progressing")?.lastUpdateTime?.toString() ||
          d.metadata?.creationTimestamp?.toString() ||
          new Date().toISOString()
        const status: DeploymentInfo["status"] =
          ready === 0 && replicas > 0 ? "failed" : ready < replicas ? "running" : "success"
        all.push({ name, namespace: ns, image, version, replicas, readyReplicas: ready, status, updatedAt })
      }
    }
    all.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    state.deployments = all
  } catch (err) {
    console.error("Error collecting deployments:", err)
  }
}

// ── Polling loop ─────────────────────────────────────────────────────────────

async function poll(): Promise<void> {
  await Promise.allSettled([
    collectPodMetrics(),
    collectDeployments()
  ])
}

// Start polling immediately then every POLL_INTERVAL
poll()
setInterval(poll, POLL_INTERVAL)

// ── Routes ───────────────────────────────────────────────────────────────────

// Full cluster state
app.get("/metrics", (_req, res) => {
  res.json(state)
})

// Just service metrics — used by service health table
app.get("/metrics/services", (_req, res) => {
  res.json({
    services: state.services,
    timestamp: state.timestamp,
    lastUpdated: state.lastUpdated
  })
})

// Namespace inventory — used by the AI assistant for cluster-wide questions
app.get("/metrics/namespaces", (_req, res) => {
  res.json({
    namespaces: state.namespaces,
    timestamp: state.timestamp,
    lastUpdated: state.lastUpdated
  })
})

// Live deployments — used by the Recent Deployments widget + deployments page.
app.get("/metrics/deployments", (_req, res) => {
  res.json({
    deployments: state.deployments,
    timestamp: state.timestamp,
    lastUpdated: state.lastUpdated
  })
})

// Service logs are now shipped by Fluent Bit into Loki and queried by the
// dashboard directly (see lib/logs/loki-source.ts); the collector no longer
// buffers or serves pod logs.

// Health check
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    lastUpdated: state.lastUpdated,
    serviceCount: state.services.length
  })
})

// ── Start server ─────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Metrics collector running on port ${PORT}`)
  console.log(`Scope: cluster-wide (all namespaces)`)
  console.log(`Poll interval: ${POLL_INTERVAL}ms`)
})
