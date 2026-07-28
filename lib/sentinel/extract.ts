import {
  RESTART_WARN,
  serviceNameFromLabels,
  type Signal,
  type SignalSeverity,
} from "./signal"
import { parseQuantity } from "./quantity"

// Pure Kubernetes → Signal extraction. Given a Pod's structural shape (the subset
// of fields we read), emit the normalized detection signals it warrants. No
// network, no clock — deterministic and unit-testable. The informer worker (next
// increment) feeds real pods through this; the correlation engine consumes the
// output.
//
// We depend only on minimal structural interfaces (not the k8s client types) so
// this module stays decoupled and testable with plain objects.

export interface ContainerStatusLike {
  name?: string
  restartCount?: number
  ready?: boolean
  state?: {
    waiting?: { reason?: string; message?: string }
    terminated?: { reason?: string; exitCode?: number }
  }
  lastState?: {
    terminated?: { reason?: string; exitCode?: number }
  }
}

export interface PodConditionLike {
  type?: string
  status?: string
  reason?: string
  message?: string
}

export interface ContainerSpecLike {
  name?: string
  resources?: { limits?: Record<string, string>; requests?: Record<string, string> }
}

export interface PodLike {
  metadata?: { name?: string; namespace?: string; labels?: Record<string, string> }
  spec?: { containers?: ContainerSpecLike[] }
  status?: {
    phase?: string
    conditions?: PodConditionLike[]
    containerStatuses?: ContainerStatusLike[]
  }
}

// Hard, critical container waiting reasons → the detection kind they map to.
const WAITING_HARD: Record<string, string> = {
  CrashLoopBackOff: "CrashLoopBackOff",
  ImagePullBackOff: "ImagePullBackOff",
  ErrImagePull: "ImagePullBackOff",
  CreateContainerConfigError: "CreateContainerConfigError",
  RunContainerError: "ContainerError",
  CreateContainerError: "ContainerError",
  Error: "ContainerError",
}

export function extractPodSignals(pod: PodLike): Signal[] {
  const namespace = pod.metadata?.namespace ?? "default"
  const podName = pod.metadata?.name ?? "unknown"
  const service = serviceNameFromLabels(pod.metadata?.labels, podName)
  const source = { kind: "Pod", name: podName }

  const mk = (
    kind: string,
    severity: SignalSeverity,
    hard: boolean,
    message: string
  ): Signal => ({ kind, service, namespace, severity, hard, message, source })

  const out: Signal[] = []

  for (const c of pod.status?.containerStatuses ?? []) {
    const cname = c.name ?? "container"
    const waiting = c.state?.waiting?.reason
    const waitingMsg = c.state?.waiting?.message

    if (waiting && WAITING_HARD[waiting]) {
      const detail = waitingMsg ? `: ${waitingMsg}` : ""
      out.push(mk(WAITING_HARD[waiting], "critical", true, `Container ${cname} — ${waiting}${detail}`))
    }

    // OOMKilled — the container's current or previous termination.
    const term = c.state?.terminated ?? c.lastState?.terminated
    if (term?.reason === "OOMKilled") {
      out.push(
        mk("OOMKilled", "critical", true, `Container ${cname} was OOMKilled (exit ${term.exitCode ?? 137})`)
      )
    }

    // Rising restarts — a soft, leading indicator ("something is starting").
    if ((c.restartCount ?? 0) >= RESTART_WARN) {
      out.push(
        mk("HighRestarts", "warning", false, `Container ${cname} has restarted ${c.restartCount} times`)
      )
    }
  }

  // Unschedulable / Pending with a scheduling failure.
  if (pod.status?.phase === "Pending") {
    const scheduled = pod.status.conditions?.find((c) => c.type === "PodScheduled")
    if (scheduled && scheduled.status === "False") {
      const detail = scheduled.message ? `: ${scheduled.message}` : ""
      out.push(mk("Unschedulable", "critical", true, `Pod cannot be scheduled${detail}`))
    }
  }

  return dedupeByKind(out)
}

/** One signal per detection kind per pod (first message wins) — keeps noise down. */
function dedupeByKind(signals: Signal[]): Signal[] {
  const seen = new Set<string>()
  const out: Signal[] = []
  for (const s of signals) {
    if (seen.has(s.kind)) continue
    seen.add(s.kind)
    out.push(s)
  }
  return out
}

/** Per-container memory limit (bytes) from the pod spec, for the memory-trend
 * monitor. Containers without a memory limit are omitted. */
export function podMemoryLimits(pod: PodLike): Map<string, number> {
  const out = new Map<string, number>()
  for (const c of pod.spec?.containers ?? []) {
    if (!c.name) continue
    const limit = parseQuantity(c.resources?.limits?.memory)
    if (limit != null && limit > 0) out.set(c.name, limit)
  }
  return out
}

// ── Event → Signal ────────────────────────────────────────────────────────────
// Kubernetes Events catch things pod status alone doesn't surface well: failed
// volume/secret mounts, probe failures, scheduling failures, sandbox/network
// errors. An Event references an object (usually a Pod) but not its labels, so
// the caller passes a `ServiceResolver` (backed by the informer's pod cache) to
// map object → service; without one we fall back to the object name.
export interface EventLike {
  reason?: string
  message?: string
  type?: string // "Normal" | "Warning"
  involvedObject?: { kind?: string; name?: string; namespace?: string }
}

export type ServiceResolver = (
  namespace: string,
  objectName: string,
  objectKind?: string
) => string | undefined

const EVENT_MAP: Record<string, { kind: string; severity: SignalSeverity; hard: boolean }> = {
  FailedMount: { kind: "FailedMount", severity: "critical", hard: true },
  Unhealthy: { kind: "ProbeFailure", severity: "warning", hard: false },
  FailedScheduling: { kind: "FailedScheduling", severity: "warning", hard: false },
  FailedCreatePodSandBox: { kind: "SandboxError", severity: "critical", hard: true },
  BackOff: { kind: "BackOff", severity: "warning", hard: false },
}

export function extractEventSignal(
  event: EventLike,
  resolveService?: ServiceResolver
): Signal | null {
  const reason = event.reason
  if (!reason) return null
  const mapped = EVENT_MAP[reason]
  if (!mapped) return null

  const io = event.involvedObject
  const namespace = io?.namespace ?? "default"
  const objectName = io?.name ?? "unknown"
  const service = resolveService?.(namespace, objectName, io?.kind) ?? objectName
  const detail = event.message ? `: ${event.message}` : ""

  return {
    kind: mapped.kind,
    service,
    namespace,
    severity: mapped.severity,
    hard: mapped.hard,
    message: `${reason}${detail}`,
    source: { kind: io?.kind ?? "Event", name: objectName },
  }
}
