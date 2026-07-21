// PersistenceStore — the storage plug point for incidents (and, from M8, eval
// runs + chat history). Backend-neutral: File (default), Mongo, Postgres and S3
// adapters all implement this same contract, verified by the shared contract-test
// kit in ./contract.ts.
//
// No runtime deps / no `server-only` so the types can be imported from anywhere
// (routes, façade, tests). Concrete adapters live in *-store.ts and are server-only.

import type {
  IncidentRecord,
  IncidentFilter,
  IncidentRca,
  IncidentSeverity,
  IncidentStatus,
  FailureType,
  TimelineEntry,
  RelatedLog,
} from "../incident-types"

/** The full persisted shape for a store. `version`/`seededAt` drive the seed +
 * in-place upgrade path; a relational/document backend can map these to a small
 * metadata record. */
export interface StoreState {
  version: number
  seededAt: number
  incidents: IncidentRecord[]
}

export interface CreateIncidentInput {
  id?: string
  title: string
  severity: IncidentSeverity
  service: string
  status?: IncidentStatus
  failureType: FailureType
  startedAt?: number
  affectedUsers?: number
  description: string
  timeline?: TimelineEntry[]
  relatedLogs?: RelatedLog[]
  rca?: IncidentRca | null
}

export interface UpdateIncidentInput {
  status?: IncidentStatus
  resolvedAt?: number | null
  affectedUsers?: number
  timeline?: TimelineEntry[]
  relatedLogs?: RelatedLog[]
  rca?: IncidentRca | null
}

export interface PersistenceStore {
  /** All incidents matching the filter, newest first. */
  listIncidents(filter?: IncidentFilter): Promise<IncidentRecord[]>
  /** A single incident by id, or null. */
  getIncident(id: string): Promise<IncidentRecord | null>
  /** The next monotonic `INC-####` id. */
  nextIncidentId(): Promise<string>
  /** Create a live incident (auto-resolving any prior open incident for the same
   * service). Idempotent on an explicit duplicate id. */
  createIncident(input: CreateIncidentInput): Promise<IncidentRecord>
  /** Patch an incident; computes `durationMin` when `resolvedAt` is set. */
  updateIncident(id: string, patch: UpdateIncidentInput): Promise<IncidentRecord | null>
  /** Attach/replace the RCA document. */
  saveRca(id: string, rca: IncidentRca): Promise<IncidentRecord | null>
  /** Mark resolved + stamp resolution time (idempotent). */
  resolveIncident(id: string, resolvedAt?: number): Promise<IncidentRecord | null>
}
