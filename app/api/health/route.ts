import { NextResponse } from "next/server"
import { getConfig } from "@/lib/config/loader"

// Lightweight liveness/readiness probe for load balancers and Kubernetes. Confirms
// the server is up and the Nova config is loadable — a broken `nova.config.yaml`
// fails readiness (503) instead of silently serving. Never exposes secrets or
// config values.
export const dynamic = "force-dynamic"

export async function GET() {
  try {
    const cfg = getConfig()
    return NextResponse.json({
      status: "ok",
      logs: cfg.logs.provider,
      persistence: cfg.persistence.provider,
    })
  } catch (err: any) {
    return NextResponse.json(
      { status: "error", error: err?.message || "config load failed" },
      { status: 503 }
    )
  }
}
