import { NextResponse } from "next/server"
import { getConfig } from "@/lib/config/loader"
import { fetchMetricNames, buildReport, type DiscoveryReport } from "@/lib/discovery/fingerprint"

// GET /api/discovery — fingerprint the configured Prometheus and return ranked
// exporter suggestions (ready-to-commit `metrics.queries`). ADVISORY ONLY: this
// never changes what the dashboard renders — it only proposes YAML for the
// operator to commit (see docs/metrics-architecture-plan.md, Phase 4 UI).
//
// SSRF-safe: the target host comes solely from `metrics.url` (config-allowlisted),
// never from the request. Runs server-side; the raw PromQL is generated here.

export async function GET(): Promise<NextResponse<DiscoveryReport>> {
  const metrics = getConfig().metrics
  const url = metrics.url

  if (!url) {
    return NextResponse.json({
      reachable: false,
      suggestions: [],
      reason: "metrics.url is not configured — set it to your Prometheus to enable discovery.",
    })
  }

  try {
    const authToken = metrics.authTokenEnv ? process.env[metrics.authTokenEnv] : undefined
    const names = await fetchMetricNames(url, { authToken })
    return NextResponse.json(buildReport(url, names))
  } catch (err: any) {
    return NextResponse.json({
      reachable: false,
      url,
      suggestions: [],
      reason: err?.message ?? "Prometheus unreachable",
    })
  }
}
