// The Sentinel signal model.
//
// A `Signal` is one normalized piece of evidence that something is (or is
// starting to go) wrong, extracted deterministically from a Kubernetes object.
// Signals are the common currency the correlation engine (B2) consumes: many
// signals per service accumulate into a candidate, and a candidate becomes an
// incident when a HARD signal fires or enough SOFT signals corroborate.
//
// Extraction is PURE (no clock, no network, no k8s client) so it is fully
// unit-testable with plain-object fixtures and shared by the informer worker.

export type SignalSeverity = "critical" | "warning" | "info"

export interface SignalSource {
  /** The Kubernetes object kind the signal came from (Pod, Event, Deployment…). */
  kind: string
  /** The object's name. */
  name: string
}

export interface Signal {
  /**
   * The detection kind — a stable identifier used for dedup and for mapping to a
   * failure type, e.g. "CrashLoopBackOff", "OOMKilled", "ImagePullBackOff",
   * "CreateContainerConfigError", "HighRestarts", "Unschedulable".
   */
  kind: string
  /** The workload this is about (app label, else the object name). */
  service: string
  namespace: string
  severity: SignalSeverity
  /**
   * hard = strong enough to open an incident on its own (crash, OOM, missing
   * secret). soft = needs corroboration (rising restarts, not-ready) before it
   * opens an incident. The correlation engine (B2) uses this.
   */
  hard: boolean
  /** Human-readable evidence — shown on the incident and fed to the AI RCA step. */
  message: string
  source: SignalSource
}

/** Restart count at/above which a soft `HighRestarts` signal is emitted. */
export const RESTART_WARN = 3

/**
 * Resolve the "service" a workload belongs to from its labels, falling back to
 * the object name. Domain-agnostic: honours the common app-name label
 * conventions and never hardcodes a service.
 */
export function serviceNameFromLabels(
  labels: Record<string, string> | undefined,
  fallback: string
): string {
  const l = labels ?? {}
  return l["app"] || l["app.kubernetes.io/name"] || l["k8s-app"] || fallback
}
