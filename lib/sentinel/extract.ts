import {
  RESTART_WARN,
  serviceNameFromLabels,
  type Signal,
  type SignalSeverity,
} from "./signal"

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

export interface PodLike {
  metadata?: { name?: string; namespace?: string; labels?: Record<string, string> }
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
