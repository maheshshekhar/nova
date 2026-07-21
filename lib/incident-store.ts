import "server-only"
import type { IncidentRecord, IncidentFilter, IncidentRca } from "./incident-types"
import type { CreateIncidentInput, UpdateIncidentInput } from "./persistence/store"
import { getStore } from "./persistence/resolve"
import { emitIncidentEvent } from "./notify/bus"

// Façade over the configured PersistenceStore (M2). The public API is unchanged —
// every route/component keeps importing these functions and types from here — but
// the storage backend is now pluggable (file today; mongo/postgres/s3 at M9),
// selected by `persistence.provider` in nova.config.yaml.
//
// This façade is also the single funnel for incident lifecycle notifications
// (M14): create/resolve/RCA fire fire-and-forget events (no-op unless configured).

export type { CreateIncidentInput, UpdateIncidentInput }

export function listIncidents(filter: IncidentFilter = {}): Promise<IncidentRecord[]> {
  return getStore().listIncidents(filter)
}

export function getIncident(id: string): Promise<IncidentRecord | null> {
  return getStore().getIncident(id)
}

export function nextIncidentId(): Promise<string> {
  return getStore().nextIncidentId()
}

export async function createIncident(input: CreateIncidentInput): Promise<IncidentRecord> {
  const record = await getStore().createIncident(input)
  emitIncidentEvent("incident.opened", record)
  return record
}

export async function updateIncident(
  id: string,
  patch: UpdateIncidentInput
): Promise<IncidentRecord | null> {
  const record = await getStore().updateIncident(id, patch)
  if (record) emitIncidentEvent("incident.updated", record)
  return record
}

export async function saveRca(id: string, rca: IncidentRca): Promise<IncidentRecord | null> {
  const record = await getStore().saveRca(id, rca)
  if (record) emitIncidentEvent("rca.generated", record)
  return record
}

export async function resolveIncident(
  id: string,
  resolvedAt?: number
): Promise<IncidentRecord | null> {
  const record = await getStore().resolveIncident(id, resolvedAt)
  if (record) emitIncidentEvent("incident.resolved", record)
  return record
}
