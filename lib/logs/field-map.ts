import type { LogFields } from "@/lib/config/schema"

// Field mapping — translate Nova's logical dimensions (the keys operators write in
// `logs.scope`) into the concrete field/label a backend understands. This is the
// only place the vocabulary "namespace / service / level / message / timestamp" is
// tied to a backend field name; everything else in the core stays logical.
//
// A dimension Nova doesn't know about (a custom label the operator's logs carry,
// e.g. `team` or `cluster`) is passed through verbatim — the logical key *is* the
// backend field. That keeps scope open-ended without hardcoding a label list.

const KNOWN: ReadonlyArray<keyof LogFields> = [
  "namespace",
  "service",
  "level",
  "message",
  "timestamp",
]

/** Map a logical scope dimension to its backend field name via `fields`. */
export function backendField(dimension: string, fields: LogFields): string {
  return (KNOWN as string[]).includes(dimension)
    ? fields[dimension as keyof LogFields]
    : dimension
}
