"use client"

import { useEffect, useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { generateMetricsYaml } from "@/lib/config/generate"
import type { DiscoveryReport, DiscoverySuggestion } from "@/lib/discovery/fingerprint"

// The Signals panel — the advisory discovery surface. It shows which metric
// signals are Live (pinned in config), Detected (a source exists but isn't in
// git yet) or Unavailable, and generates the nova.config.yaml to commit.
// Detection NEVER drives a live tile — this only proposes YAML (GitOps).

// The request-metric signals discovery can suggest. CPU / memory / pod health
// are always available from the k8s collector, so they are noted separately.
const RED_SIGNALS: { key: string; label: string }[] = [
  { key: "errorRate", label: "Error rate" },
  { key: "latencyP50", label: "Latency p50" },
  { key: "latencyP95", label: "Latency p95" },
  { key: "latencyP99", label: "Latency p99" },
  { key: "rps", label: "Requests / sec" },
]

type SignalState = "live" | "detected" | "unavailable"

export interface SignalsPanelProps {
  /** Metric keys already pinned in `metrics.queries`. */
  pinnedKeys: string[]
  /** The configured metrics provider (http | prometheus | none). */
  provider: string
}

function StateBadge({ state }: { state: SignalState }) {
  if (state === "live") return <Badge className="bg-[var(--neon-green)]/15 text-[var(--neon-green)] border-transparent">Live</Badge>
  if (state === "detected") return <Badge className="bg-[var(--neon-orange)]/15 text-[var(--neon-orange)] border-transparent">Detected</Badge>
  return <Badge variant="outline" className="text-muted-foreground">Unavailable</Badge>
}

export function SignalsPanel({ pinnedKeys, provider }: SignalsPanelProps) {
  const [report, setReport] = useState<DiscoveryReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let active = true
    fetch("/api/discovery", { cache: "no-store" })
      .then((r) => r.json())
      .then((data: DiscoveryReport) => {
        if (!active) return
        setReport(data)
        setSelectedId(data.suggestions?.[0]?.presetId ?? null)
      })
      .catch(() => active && setReport({ reachable: false, suggestions: [], reason: "Discovery request failed." }))
      .finally(() => active && setLoading(false))
    return () => {
      active = false
    }
  }, [])

  const selected: DiscoverySuggestion | undefined = useMemo(
    () => report?.suggestions.find((s) => s.presetId === selectedId),
    [report, selectedId]
  )

  const pinned = useMemo(() => new Set(pinnedKeys), [pinnedKeys])

  const stateFor = (key: string): SignalState => {
    if (pinned.has(key)) return "live"
    if (selected?.queries[key]) return "detected"
    return "unavailable"
  }

  const yamlText = useMemo(
    () => (selected ? generateMetricsYaml({ url: report?.url, serviceLabel: selected.serviceLabel, queries: selected.queries, preset: selected.presetId }) : ""),
    [selected, report?.url]
  )

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(yamlText)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable — the operator can still select the text */
    }
  }

  const download = () => {
    const blob = new Blob([yamlText], { type: "text/yaml" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = "nova.metrics.yaml"
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <p className="text-xs text-muted-foreground">
          Nova probes your configured Prometheus and suggests the queries for each signal.
          Detection is <span className="text-foreground">advisory</span> — nothing renders on the
          dashboard until you commit the generated YAML to <code>nova.config.yaml</code>.
        </p>
        <p className="text-[11px] text-muted-foreground">
          CPU, memory and pod health are always available from the Kubernetes collector.
        </p>
      </div>

      {loading && <p className="text-xs font-mono text-muted-foreground">Probing Prometheus…</p>}

      {!loading && report && !report.reachable && (
        <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          Discovery unavailable: {report.reason ?? "Prometheus not reachable."}
          {provider !== "prometheus" && (
            <span> Set <code>metrics.url</code> to your Prometheus to enable discovery.</span>
          )}
        </div>
      )}

      {!loading && report?.reachable && (
        <>
          {report.suggestions.length > 1 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] text-muted-foreground">Detected exporter:</span>
              {report.suggestions.map((s) => (
                <button
                  key={s.presetId}
                  onClick={() => setSelectedId(s.presetId)}
                  className={`rounded-md border px-2 py-1 text-[11px] font-mono ${
                    s.presetId === selectedId ? "border-[var(--neon-cyan)] text-foreground" : "border-border text-muted-foreground"
                  }`}
                >
                  {s.title} · {Math.round(s.confidence * 100)}%
                </button>
              ))}
            </div>
          )}

          <dl className="divide-y divide-border rounded-md border border-border">
            {RED_SIGNALS.map((sig) => {
              const state = stateFor(sig.key)
              const query = pinned.has(sig.key) ? undefined : selected?.queries[sig.key]
              return (
                <div key={sig.key} className="flex items-start justify-between gap-4 px-3 py-2">
                  <dt className="text-xs text-muted-foreground">
                    {sig.label}
                    {query && <div className="mt-1 font-mono text-[10px] text-muted-foreground/70 break-all max-w-md">{query}</div>}
                  </dt>
                  <dd>
                    <StateBadge state={state} />
                  </dd>
                </div>
              )
            })}
          </dl>

          {selected && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-muted-foreground">
                  YAML to commit ({selected.title})
                </span>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={copy}>
                    {copied ? "Copied" : "Copy"}
                  </Button>
                  <Button size="sm" variant="outline" onClick={download}>
                    Download
                  </Button>
                </div>
              </div>
              <pre className="max-h-72 overflow-auto rounded-md border border-border bg-muted/30 p-3 text-[11px] font-mono leading-relaxed">
                {yamlText}
              </pre>
              {selected.notes && <p className="text-[11px] text-muted-foreground">Note: {selected.notes}</p>}
            </div>
          )}

          {report.suggestions.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No known exporter fingerprint matched. Your apps may not expose request metrics yet,
              or use a label set Nova doesn&apos;t recognise — you can still write the queries manually.
            </p>
          )}
        </>
      )}
    </div>
  )
}
