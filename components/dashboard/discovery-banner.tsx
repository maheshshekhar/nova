"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { X, Sparkles } from "lucide-react"
import { unpinnedDetectedKeys, type DiscoveryReport } from "@/lib/discovery/fingerprint"

// First-run nudge. When Nova detects request-metric signals in your Prometheus
// that are NOT yet pinned in nova.config.yaml, it shows a dismissible banner
// linking to the Signals tab. Advisory only — it changes nothing on the
// dashboard; it just points at the config you can commit. Dismissal persists.

const DISMISS_KEY = "nova-discovery-banner-dismissed"

export function DiscoveryBanner() {
  const [count, setCount] = useState(0)
  const [dismissed, setDismissed] = useState(true) // hidden until we confirm there is something to show

  useEffect(() => {
    if (typeof window !== "undefined" && window.localStorage.getItem(DISMISS_KEY) === "1") return
    let active = true
    fetch("/api/discovery", { cache: "no-store" })
      .then((r) => r.json())
      .then((report: DiscoveryReport) => {
        if (!active) return
        const n = unpinnedDetectedKeys(report).length
        if (n > 0) {
          setCount(n)
          setDismissed(false)
        }
      })
      .catch(() => {
        /* discovery unavailable — no nudge */
      })
    return () => {
      active = false
    }
  }, [])

  if (dismissed || count === 0) return null

  const dismiss = () => {
    setDismissed(true)
    try {
      window.localStorage.setItem(DISMISS_KEY, "1")
    } catch {
      /* non-fatal */
    }
  }

  return (
    <div className="flex items-center gap-3 rounded-lg border border-[var(--neon-cyan)]/30 bg-[var(--neon-cyan)]/5 px-4 py-2.5">
      <Sparkles className="h-4 w-4 shrink-0 text-[var(--neon-cyan)]" />
      <p className="flex-1 text-xs text-muted-foreground">
        Nova detected <span className="font-semibold text-foreground">{count}</span> metric{" "}
        {count === 1 ? "signal" : "signals"} in your Prometheus not yet in your config.{" "}
        <Link href="/settings" className="font-medium text-[var(--neon-cyan)] underline underline-offset-2">
          Review &amp; generate YAML
        </Link>{" "}
        to commit them.
      </p>
      <button onClick={dismiss} aria-label="Dismiss" className="shrink-0 text-muted-foreground hover:text-foreground">
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}
