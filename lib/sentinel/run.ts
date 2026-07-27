import * as k8s from "@kubernetes/client-node"
import { SentinelEngine } from "./engine"
import { Correlator } from "./correlate"
import { HttpAlertSink } from "./sink"
import type { EventLike, PodLike } from "./extract"

// The Sentinel runtime — the only I/O-bound piece.
//
// It watches Kubernetes Pods and Events with informers (the same mechanism
// operators use, so it scales to thousands of objects without polling), and
// forwards every observed object to the pure `SentinelEngine`. Detection logic,
// correlation and incident mapping all live in tested, cluster-free modules;
// this file is deliberately thin.
//
// Configuration is entirely environment-driven so the companion needs no access
// to Nova's server-only config loader:
//   NOVA_URL            base URL of the Nova dashboard (default http://nova:3000)
//   SENTINEL_NAMESPACES comma-separated namespaces to watch (empty = all)
//   SENTINEL_DRY_RUN    "true" → log decisions, never open incidents
//   SENTINEL_WINDOW_MS  correlation window in ms (default 600000)
//   SENTINEL_SOFT_CONFIRM distinct soft signal kinds to confirm (default 2)

interface RuntimeConfig {
  novaUrl: string
  namespaces: string[]
  dryRun: boolean
  windowMs: number
  softConfirmKinds: number
}

function readConfig(): RuntimeConfig {
  return {
    novaUrl: process.env.NOVA_URL || "http://nova:3000",
    namespaces: (process.env.SENTINEL_NAMESPACES || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    dryRun: process.env.SENTINEL_DRY_RUN === "true",
    windowMs: Number(process.env.SENTINEL_WINDOW_MS) || 10 * 60 * 1000,
    softConfirmKinds: Number(process.env.SENTINEL_SOFT_CONFIRM) || 2,
  }
}

const RESTART_DELAY_MS = 5000

function log(message: string): void {
  console.log(`[nova-sentinel] ${message}`)
}

/**
 * Create + start an informer that survives disconnects (restarts on error/close
 * with a fixed backoff — the standard client-node pattern).
 */
function runInformer<T extends k8s.KubernetesObject>(
  kc: k8s.KubeConfig,
  path: string,
  listFn: k8s.ListPromise<T>,
  handlers: {
    add: (obj: T) => void
    update: (obj: T) => void
    delete: (obj: T) => void
  }
): void {
  const informer = k8s.makeInformer(kc, path, listFn)
  informer.on("add", handlers.add)
  informer.on("update", handlers.update)
  informer.on("delete", handlers.delete)
  informer.on("error", (err) => {
    log(`informer error on ${path}: ${(err as Error).message ?? err}; restarting in ${RESTART_DELAY_MS}ms`)
    setTimeout(() => {
      informer.start().catch((e) => log(`restart failed for ${path}: ${e}`))
    }, RESTART_DELAY_MS)
  })
  informer.start().then(
    () => log(`watching ${path}`),
    (err) => log(`failed to start informer on ${path}: ${err}`)
  )
}

export function start(): void {
  const cfg = readConfig()
  const kc = new k8s.KubeConfig()
  try {
    kc.loadFromCluster()
  } catch {
    kc.loadFromDefault()
  }
  const core = kc.makeApiClient(k8s.CoreV1Api)

  const sink = new HttpAlertSink(cfg.novaUrl)
  const engine = new SentinelEngine({
    sink,
    correlator: new Correlator({ windowMs: cfg.windowMs, softConfirmKinds: cfg.softConfirmKinds }),
    dryRun: cfg.dryRun,
    logger: log,
  })

  const scopes = cfg.namespaces.length > 0 ? cfg.namespaces : [null]
  log(
    `starting — nova=${cfg.novaUrl} scope=${cfg.namespaces.length ? cfg.namespaces.join(",") : "all namespaces"} dryRun=${cfg.dryRun}`
  )

  const onPod = (obj: k8s.V1Pod) => {
    void engine.onPod(obj as PodLike).catch((e) => log(`onPod error: ${e}`))
  }
  const onPodDeleted = (obj: k8s.V1Pod) => engine.onPodDeleted(obj as PodLike)
  const onEvent = (obj: k8s.CoreV1Event) => {
    void engine.onEvent(obj as EventLike).catch((e) => log(`onEvent error: ${e}`))
  }

  for (const ns of scopes) {
    const podPath = ns ? `/api/v1/namespaces/${ns}/pods` : "/api/v1/pods"
    const eventPath = ns ? `/api/v1/namespaces/${ns}/events` : "/api/v1/events"
    runInformer<k8s.V1Pod>(
      kc,
      podPath,
      () => (ns ? core.listNamespacedPod(ns) : core.listPodForAllNamespaces()),
      { add: onPod, update: onPod, delete: onPodDeleted }
    )
    runInformer<k8s.CoreV1Event>(
      kc,
      eventPath,
      () => (ns ? core.listNamespacedEvent(ns) : core.listEventForAllNamespaces()),
      { add: onEvent, update: onEvent, delete: () => {} }
    )
  }

  const shutdown = () => {
    log("shutting down")
    process.exit(0)
  }
  process.on("SIGTERM", shutdown)
  process.on("SIGINT", shutdown)
}

// Run when invoked directly (tsx lib/sentinel/run.ts).
if (process.argv[1] && process.argv[1].endsWith("run.ts")) {
  start()
}
