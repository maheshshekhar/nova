import * as k8s from "@kubernetes/client-node"
import { Writable } from "node:stream"
import * as http from "node:http"
import * as https from "node:https"
import { SentinelEngine } from "./engine"
import { HttpAlertSink } from "./sink"
import { serviceNameFromLabels } from "./signal"
import { parseLogLine } from "./logs/parse"
import { buildSentinel, loadSentinelConfig } from "./config"
import type { SentinelConfig } from "@/lib/config/schema"
import type { EventLike, PodLike } from "./extract"

// Each tailed pod holds ONE long-lived follow-stream open. Lift Node's own agent
// socket caps so outbound HTTP (and any global-agent streams) aren't queued.
// NOTE: log tailing opens one stream per pod/container and is bounded by the
// client + apiserver concurrent-stream limits, so a very busy namespace may not
// tail every pod. Scope `sentinel.namespaces` (or integrate a log backend) rather
// than tailing thousands of pods directly. k8s-object + event detection is
// unaffected and always covers the whole scope.
http.globalAgent.maxSockets = Infinity
https.globalAgent.maxSockets = Infinity

// The Sentinel runtime — the only I/O-bound piece.
//
// It watches Kubernetes Pods and Events with informers (the same mechanism
// operators use, so it scales to thousands of objects without polling), and
// tails the logs of the pods in scope. Every observed object / log line is
// forwarded to the pure `SentinelEngine`. Detection logic, correlation and
// incident mapping all live in tested, cluster-free modules; this file is
// deliberately thin.
//
// Tuning comes from the `sentinel:` block of nova.config.yaml (loaded standalone,
// no server-only). A few operational knobs may be overridden by env for the
// env-driven deployment path:
//   NOVA_URL            base URL of the Nova dashboard (default http://nova:3000)
//   SENTINEL_NAMESPACES comma-separated namespaces to watch (empty = all)
//   SENTINEL_DRY_RUN    "true" → log decisions, never open incidents
//   SENTINEL_WINDOW_MS  correlation/dedup window in ms
//   SENTINEL_SOFT_CONFIRM distinct soft signal kinds to confirm
//   SENTINEL_LOGS       "false" → disable pod-log tailing
//   NOVA_CONFIG         path to nova.config.yaml (default /app/nova.config.yaml)

/** Load the `sentinel:` config, then let a handful of env vars override the
 * operational knobs (backward-compatible with the env-only deployment). */
function readRuntime(): { novaUrl: string; cfg: SentinelConfig } {
  const file = loadSentinelConfig()
  const env = process.env
  const cfg: SentinelConfig = {
    ...file,
    dryRun: env.SENTINEL_DRY_RUN !== undefined ? env.SENTINEL_DRY_RUN === "true" : file.dryRun,
    namespaces: env.SENTINEL_NAMESPACES
      ? env.SENTINEL_NAMESPACES.split(",").map((s) => s.trim()).filter(Boolean)
      : file.namespaces,
    softConfirmKinds: env.SENTINEL_SOFT_CONFIRM ? Number(env.SENTINEL_SOFT_CONFIRM) : file.softConfirmKinds,
    dedupeWindowSec: env.SENTINEL_WINDOW_MS ? Math.round(Number(env.SENTINEL_WINDOW_MS) / 1000) : file.dedupeWindowSec,
    logs: {
      ...file.logs,
      enabled: env.SENTINEL_LOGS !== undefined ? env.SENTINEL_LOGS !== "false" : file.logs.enabled,
    },
  }
  return { novaUrl: env.NOVA_URL || "http://nova:3000", cfg }
}

const RESTART_DELAY_MS = 5000

function log(message: string): void {
  console.log(`[nova-sentinel] ${message}`)
}

interface Abortable {
  abort(): void
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

/** Tails the logs of in-scope pods, forwarding each parsed line to the engine.
 * One follow-stream per container; started when a pod is Running, aborted when
 * the pod is deleted. Only new logs (sinceSeconds) are read so historical lines
 * never open incidents. */
function makeLogTailer(kc: k8s.KubeConfig, engine: SentinelEngine) {
  const logApi = new k8s.Log(kc)
  const streams = new Map<string, Abortable | null>()
  const wanted = new Set<string>() // keys that should stay tailed (for restart)

  function lineSink(service: string, namespace: string, pod: string): Writable {
    let buf = ""
    return new Writable({
      write(chunk, _enc, cb) {
        buf += chunk.toString("utf8")
        let nl: number
        while ((nl = buf.indexOf("\n")) >= 0) {
          const raw = buf.slice(0, nl)
          buf = buf.slice(nl + 1)
          const line = parseLogLine(raw, { service, namespace, pod })
          if (line) void engine.onLog(line).catch((e) => log(`onLog error: ${e}`))
        }
        cb()
      },
    })
  }

  // Open one follow-stream for a container; restart it only on a hard error
  // (not a normal end/close) so a genuinely dropped stream recovers without
  // thrashing a healthy one.
  function tail(key: string, namespace: string, name: string, container: string, service: string): void {
    logApi
      .log(namespace, name, container, lineSink(service, namespace, name), {
        follow: true,
        sinceSeconds: 2,
        timestamps: false,
      })
      .then(
        (req) => {
          streams.set(key, req as unknown as Abortable)
          const emitter = req as unknown as { on?: (e: string, cb: (arg?: unknown) => void) => void }
          emitter.on?.("error", () => {
            streams.delete(key)
            if (wanted.has(key)) setTimeout(() => tail(key, namespace, name, container, service), 5000)
          })
        },
        (err) => {
          streams.delete(key)
          log(`log tail failed for ${key}: ${err}`)
          if (wanted.has(key)) setTimeout(() => tail(key, namespace, name, container, service), 5000)
        }
      )
  }

  return {
    start(pod: k8s.V1Pod): void {
      if (pod.status?.phase !== "Running") return
      const namespace = pod.metadata?.namespace
      const name = pod.metadata?.name
      if (!namespace || !name) return
      const service = serviceNameFromLabels(pod.metadata?.labels, name)
      for (const c of pod.spec?.containers ?? []) {
        const key = `${namespace}/${name}/${c.name}`
        if (wanted.has(key)) continue // already tailing / reserved
        wanted.add(key)
        streams.set(key, null) // reserve to avoid a double-start race
        tail(key, namespace, name, c.name ?? "", service)
      }
    },
    stop(pod: k8s.V1Pod): void {
      const namespace = pod.metadata?.namespace
      const name = pod.metadata?.name
      if (!namespace || !name) return
      const prefix = `${namespace}/${name}/`
      for (const [key, req] of streams) {
        if (!key.startsWith(prefix)) continue
        wanted.delete(key)
        try {
          req?.abort()
        } catch {
          // best effort
        }
        streams.delete(key)
      }
      // Also clear any reserved-but-not-yet-open keys for this pod.
      for (const key of wanted) if (key.startsWith(prefix)) wanted.delete(key)
    },
  }
}

export function start(): void {
  const { novaUrl, cfg } = readRuntime()
  const kc = new k8s.KubeConfig()
  try {
    kc.loadFromCluster()
  } catch {
    kc.loadFromDefault()
  }
  const core = kc.makeApiClient(k8s.CoreV1Api)

  const build = buildSentinel(cfg)
  const sink = new HttpAlertSink(novaUrl)
  const engine = new SentinelEngine({
    sink,
    correlator: build.correlator,
    analyzer: build.analyzer,
    dryRun: cfg.dryRun,
    mute: cfg.mute,
    maxIncidentsPerWindow: cfg.maxIncidentsPerMin,
    rateWindowMs: 60_000,
    startupGraceMs: cfg.startupGraceSec * 1000,
    logger: log,
  })
  const tailer = build.logsEnabled ? makeLogTailer(kc, engine) : null

  const scopes = cfg.namespaces.length > 0 ? cfg.namespaces : [null]
  log(
    `starting — nova=${novaUrl} scope=${cfg.namespaces.length ? cfg.namespaces.join(",") : "all namespaces"} dryRun=${cfg.dryRun} logs=${build.logsEnabled} impact=${cfg.impact.enabled} absence=${cfg.absence.enabled} sensitivity=${cfg.sensitivity} mute=[${cfg.mute.join(",")}] maxPerMin=${cfg.maxIncidentsPerMin}`
  )

  const onPod = (obj: k8s.V1Pod) => {
    void engine.onPod(obj as PodLike).catch((e) => log(`onPod error: ${e}`))
    tailer?.start(obj)
  }
  const onPodDeleted = (obj: k8s.V1Pod) => {
    engine.onPodDeleted(obj as PodLike)
    tailer?.stop(obj)
  }
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

  // Clock-driven pass for absence/baseline detection (success-signal drops).
  const tick = setInterval(() => {
    void engine.tick().catch((e) => log(`tick error: ${e}`))
  }, 60_000)
  tick.unref?.()
}

// Run when invoked directly (tsx lib/sentinel/run.ts).
if (process.argv[1] && process.argv[1].endsWith("run.ts")) {
  start()
}
