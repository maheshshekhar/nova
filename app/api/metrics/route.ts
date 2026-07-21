import { NextResponse } from "next/server"

const METRICS_URL = process.env.METRICS_COLLECTOR_URL || "http://metrics-collector:3001"

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const endpoint = searchParams.get("endpoint") || "metrics"
  // Forward any remaining query params (e.g. ?service=config-service for logs).
  searchParams.delete("endpoint")
  const qs = searchParams.toString()
  const target = `${METRICS_URL}/${endpoint}${qs ? `?${qs}` : ""}`

  try {
    const response = await fetch(target, {
      next: { revalidate: 0 }
    })

    if (!response.ok) {
      throw new Error(`Metrics collector returned ${response.status}`)
    }

    const data = await response.json()
    return NextResponse.json(data)

  } catch (err: any) {
    // Return null data so dashboard falls back to simulated metrics
    // This allows the dashboard to work even without a KinD cluster
    return NextResponse.json(
      { error: err.message, fallback: true },
      { status: 503 }
    )
  }
}
