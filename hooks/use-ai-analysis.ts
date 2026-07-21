import { useState, useCallback } from "react"

export type AnalysisState =
  | { status: "idle" }
  | { status: "loading"; elapsed: number }
  | { status: "streaming"; text: string; elapsed: number }
  | { status: "success"; text: string; elapsed: number; provider: string }
  | { status: "error"; message: string }

// The route appends a final "\n\n[PROVIDER:openrouter|anthropic]" marker to the
// stream. Split it off so it's never shown to the user and parse the provider.
function parseStream(raw: string): { text: string; provider: string | null } {
  const idx = raw.indexOf("\n\n[PROVIDER")
  if (idx === -1) return { text: raw, provider: null }
  const text = raw.slice(0, idx)
  const match = raw.slice(idx).match(/\[PROVIDER:(\w+)\]/)
  return { text, provider: match ? match[1] : null }
}

export function useAiAnalysis() {
  const [state, setState] = useState<AnalysisState>({ status: "idle" })

  const analyze = useCallback(async (logs: string[], context: string, opts?: { mode?: string; service?: string; sinceMs?: number; impact?: number }) => {
    const startTime = Date.now()

    setState({ status: "loading", elapsed: 0 })

    // Elapsed time counter while loading / streaming
    const timer = setInterval(() => {
      setState(prev => {
        if (prev.status === "loading") {
          return { ...prev, elapsed: Math.floor((Date.now() - startTime) / 1000) }
        }
        if (prev.status === "streaming") {
          return { ...prev, elapsed: Math.floor((Date.now() - startTime) / 1000) }
        }
        return prev
      })
    }, 1000)

    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          logs,
          context,
          mode: opts?.mode,
          service: opts?.service,
          sinceMs: opts?.sinceMs,
          // Canonical customer-impact figure (single source of truth) so the server
          // uses the SAME number as the overview / RCA instead of recomputing.
          impact: opts?.impact,
          // Viewer's timezone so the server renders collector-log timestamps in the
          // same local time as the incident bookends (avoids a UTC-vs-local gap).
          tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
        })
      })

      if (!res.ok) {
        const data = await res.json()
        clearInterval(timer)
        setState({ status: "error", message: data.error || "Analysis failed" })
        return
      }

      // Read the stream
      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let accumulated = ""

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const chunk = decoder.decode(value, { stream: true })
        accumulated += chunk

        // Strip the trailing provider marker so it never appears mid-stream.
        const { text } = parseStream(accumulated)
        setState({
          status: "streaming",
          text,
          elapsed: Math.floor((Date.now() - startTime) / 1000)
        })
      }

      clearInterval(timer)
      const { text, provider } = parseStream(accumulated)
      setState({
        status: "success",
        text,
        elapsed: Math.floor((Date.now() - startTime) / 1000),
        provider: provider ?? "openrouter"
      })

    } catch (err: any) {
      clearInterval(timer)
      setState({ status: "error", message: err.message })
    }
  }, [])

  const reset = useCallback(() => setState({ status: "idle" }), [])

  return { state, analyze, reset }
}
