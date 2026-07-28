import "server-only"
import * as k8s from "@kubernetes/client-node"
import {
  KubernetesMetricsReader,
  type KubeReaderClient,
  type PodInput,
  type PodMetricsInput,
  type NamespaceInput,
  type DeploymentInput,
} from "./kubernetes-reader"

// Real k8s adapter for the native metrics reader — the in-process replacement for
// the external metrics-collector. Reads pods, pod metrics (metrics-server),
// namespaces and deployments via @kubernetes/client-node. server-only (routes).
//
// In-cluster it uses the pod's ServiceAccount (needs read-only RBAC on pods,
// namespaces, deployments and metrics.k8s.io); locally it falls back to the
// kubeconfig. Every read is best-effort — the reader degrades a failed section to
// empty, so a missing metrics-server or RBAC gap yields empty tiles, not a crash.

function makeClient(): KubeReaderClient {
  const kc = new k8s.KubeConfig()
  try {
    kc.loadFromCluster()
  } catch {
    kc.loadFromDefault()
  }
  const core = kc.makeApiClient(k8s.CoreV1Api)
  const apps = kc.makeApiClient(k8s.AppsV1Api)
  const metrics = new k8s.Metrics(kc)

  return {
    async listPods() {
      return (await core.listPodForAllNamespaces()).body.items as unknown as PodInput[]
    },
    async podMetrics() {
      return ((await metrics.getPodMetrics()).items ?? []) as unknown as PodMetricsInput[]
    },
    async listNamespaces() {
      return (await core.listNamespace()).body.items as unknown as NamespaceInput[]
    },
    async listDeployments() {
      return (await apps.listDeploymentForAllNamespaces()).body.items as unknown as DeploymentInput[]
    },
  }
}

let reader: KubernetesMetricsReader | null = null

/** Process-wide native reader (kube client built once). */
export function getKubernetesReader(): KubernetesMetricsReader {
  if (!reader) reader = new KubernetesMetricsReader(makeClient())
  return reader
}
