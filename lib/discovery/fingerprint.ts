import { PRESETS, type ExporterPreset } from "./presets"

// Prometheus discovery: fingerprint an existing Prometheus by the metric names it
// exposes, match against the preset library, and produce ready-to-commit query
// suggestions. Pure matching logic (matchPresets/expandQueries/buildReport) is
// network-free and unit-tested; only fetchMetricNames does I/O.
//
// SSRF-safe by construction: the caller passes a URL that comes from
// `metrics.url` (config, allowlisted) — never from the browser.

export interface PresetMatch {
  preset: ExporterPreset
  /** Fraction (0..1) of the preset's fingerprint names present in Prometheus. */
  confidence: number
  /** The fingerprint metric names that were found. */
  matched: string[]
}

export interface DiscoverySuggestion {
  presetId: string
  title: string
  confidence: number
  serviceLabel: string
  /** Expanded PromQL, keyed by metric key — ready to drop into `metrics.queries`. */
  queries: Record<string, string>
  notes?: string
}

export interface DiscoveryReport {
  reachable: boolean
  url?: string
  metricNameCount?: number
  /** Ranked exporter suggestions (highest confidence first). */
  suggestions: DiscoverySuggestion[]
  /** Populated when discovery could not run or found nothing. */
  reason?: string
}

/** Expand a preset's `$SVC` templates against a (possibly overridden) service label. */
export function expandQueries(
  preset: ExporterPreset,
  serviceLabel: string = preset.serviceLabel
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, tmpl] of Object.entries(preset.queries)) {
    if (typeof tmpl === "string") out[key] = tmpl.split("$SVC").join(serviceLabel)
  }
  return out
}

/** Match the available metric names against the preset library, ranked by confidence. */
export function matchPresets(metricNames: string[], presets: ExporterPreset[] = PRESETS): PresetMatch[] {
  const names = new Set(metricNames)
  const matches: PresetMatch[] = []
  for (const preset of presets) {
    const all = preset.fingerprint.all ?? []
    const any = preset.fingerprint.any ?? []
    const allPresent = all.every((n) => names.has(n))
    const anyPresent = any.length === 0 || any.some((n) => names.has(n))
    if (!allPresent || !anyPresent) continue
    const fingerprintNames = [...new Set([...all, ...any])]
    const matched = fingerprintNames.filter((n) => names.has(n))
    const confidence = fingerprintNames.length
      ? Math.round((matched.length / fingerprintNames.length) * 100) / 100
      : 0
    matches.push({ preset, confidence, matched })
  }
  return matches.sort((a, b) => b.confidence - a.confidence)
}

/** Assemble a full DiscoveryReport from the metric names a Prometheus exposes. */
export function buildReport(url: string, metricNames: string[]): DiscoveryReport {
  const suggestions: DiscoverySuggestion[] = matchPresets(metricNames).map((m) => ({
    presetId: m.preset.id,
    title: m.preset.title,
    confidence: m.confidence,
    serviceLabel: m.preset.serviceLabel,
    queries: expandQueries(m.preset),
    notes: m.preset.notes,
  }))
  return {
    reachable: true,
    url,
    metricNameCount: metricNames.length,
    suggestions,
    reason: suggestions.length === 0 ? "No known exporter fingerprint matched." : undefined,
  }
}

export interface FetchMetricNamesOptions {
  authToken?: string
  fetchImpl?: typeof fetch
}

/** Query Prometheus for the full set of metric names (`__name__` label values). */
export async function fetchMetricNames(
  url: string,
  opts: FetchMetricNamesOptions = {}
): Promise<string[]> {
  const base = url.replace(/\/$/, "")
  const doFetch = opts.fetchImpl ?? fetch
  const headers: Record<string, string> = {}
  if (opts.authToken) headers.Authorization = `Bearer ${opts.authToken}`

  const res = await doFetch(`${base}/api/v1/label/__name__/values`, { headers, cache: "no-store" })
  if (!res.ok) {
    throw new Error(`Prometheus label query failed: ${res.status}`)
  }
  const data = (await res.json()) as { status?: string; data?: string[] }
  return data?.status === "success" && Array.isArray(data.data) ? data.data : []
}
