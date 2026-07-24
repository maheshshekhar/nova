"use client"

import { useState, useMemo, useEffect } from "react"
import { ArrowLeft, Filter, Pause, Play, Search, Terminal } from "lucide-react"
import { useRealLogs } from "@/hooks/use-real-metrics"
import { formatLocalTime, parseRawLogLine } from "@/lib/local-time"
import Link from "next/link"

const logLevelColors: Record<string, { text: string; bg: string; border: string }> = {
  ERROR: { text: "text-[var(--neon-red)]", bg: "bg-[var(--neon-red)]/10", border: "border-[var(--neon-red)]/20" },
  WARN: { text: "text-[var(--neon-orange)]", bg: "bg-[var(--neon-orange)]/10", border: "border-[var(--neon-orange)]/20" },
  INFO: { text: "text-[var(--neon-cyan)]", bg: "bg-[var(--neon-cyan)]/10", border: "border-[var(--neon-cyan)]/20" },
  DEBUG: { text: "text-muted-foreground", bg: "bg-secondary/30", border: "border-border/30" },
}

// Domain-agnostic service colouring: deterministically pick a neon accent from a
// palette based on the service name, so any service (whatever it's called) gets a
// stable colour without hardcoding specific service names.
const SERVICE_PALETTE = [
  "text-[var(--neon-cyan)]",
  "text-[var(--neon-green)]",
  "text-[var(--neon-orange)]",
  "text-[var(--neon-purple,#a78bfa)]",
  "text-[var(--neon-yellow)]",
  "text-[var(--neon-red)]",
]
function serviceColor(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0
  return SERVICE_PALETTE[Math.abs(hash) % SERVICE_PALETTE.length]
}

const allLevels = ["ERROR", "WARN", "INFO", "DEBUG"]

export default function LogsPage() {
  const [searchQuery, setSearchQuery] = useState("")
  const [selectedLevels, setSelectedLevels] = useState<Set<string>>(new Set(allLevels))
  // Services are opt-OUT: everything is shown until a chip is toggled off. This
  // stays correct as new services appear in the live stream (no hardcoded list).
  const [deselectedServices, setDeselectedServices] = useState<Set<string>>(new Set())
  const [isStreaming, setIsStreaming] = useState(true)

  // Local-time formatting depends on the viewer's timezone, so render it only
  // after mount to avoid an SSR/client hydration mismatch.
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    setMounted(true)
  }, [])

  const { logs: realLogs, available: logsAvailable } = useRealLogs()

  // The collector re-reads its log window and re-stamps every line on each 3s
  // poll, so the raw `realLogs` array changes size and identity constantly. If we
  // rendered it directly the count would flip (e.g. 32 → 826) and the list would
  // jump back to the top. Instead we accumulate lines into a stable, append-only
  // buffer, de-duplicated by each line's own embedded timestamp + level + text,
  // so existing rows keep their identity and only genuinely new lines are added.
  type RealRow = { key: string; ts: string; level: "ERROR" | "WARN" | "INFO" | "DEBUG"; message: string; service: string }
  const [stableReal, setStableReal] = useState<RealRow[]>([])

  useEffect(() => {
    if (!isStreaming) return // Pause freezes ingestion
    if (realLogs.length === 0) return
    setStableReal((prev) => {
      const seen = new Set(prev.map((r) => r.key))
      const additions: RealRow[] = []
      for (const log of realLogs) {
        const parsed = parseRawLogLine(log.message)
        const ts = parsed.ts ?? log.timestamp
        const level = log.level as RealRow["level"]
        const service = (log as { service?: string }).service ?? "unknown"
        const key = `${service}|${ts}|${level}|${parsed.message}`
        if (seen.has(key)) continue
        seen.add(key)
        additions.push({ key, ts, level, message: parsed.message, service })
      }
      if (additions.length === 0) return prev
      // Newest-last by embedded time, capped so the buffer can't grow unbounded.
      return [...prev, ...additions]
        .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime())
        .slice(-5000)
    })
  }, [realLogs, isStreaming])

  // Real service logs (newest first). Nova shows ONLY real cluster logs streamed
  // from Loki — there is no static/mock fallback, so navigating to this tab never
  // flashes stale sample lines. Before the first poll lands the list is simply empty.
  const sourceLogs = useMemo(() => {
    return [...stableReal]
      .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())
      .map((r) => ({
        timestamp: r.ts,
        level: r.level,
        service: r.service,
        message: r.message,
      }))
  }, [stableReal])

  const filteredLogs = useMemo(() => {
    return sourceLogs.filter((log) => {
      if (!selectedLevels.has(log.level)) return false
      if (deselectedServices.has(log.service)) return false
      if (searchQuery && !log.message.toLowerCase().includes(searchQuery.toLowerCase())) return false
      return true
    })
  }, [searchQuery, selectedLevels, deselectedServices, sourceLogs])

  // Service filter chips: every service that has appeared in the live stream. No
  // hardcoded base list — the chips are entirely source-driven.
  const availableServices = useMemo(
    () => Array.from(new Set(sourceLogs.map((l) => l.service))).sort(),
    [sourceLogs]
  )

  const toggleLevel = (level: string) => {
    setSelectedLevels((prev) => {
      const next = new Set(prev)
      if (next.has(level)) next.delete(level)
      else next.add(level)
      return next
    })
  }

  const toggleService = (service: string) => {
    setDeselectedServices((prev) => {
      const next = new Set(prev)
      if (next.has(service)) next.delete(service)
      else next.add(service)
      return next
    })
  }

  return (
    <main className="max-w-[1600px] mx-auto px-4 lg:px-6 py-6 flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link
            href="/overview"
            className="w-8 h-8 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <div className="flex items-center gap-2">
            <Terminal className="w-4 h-4 text-[var(--neon-cyan)]" />
            <h1 className="text-lg font-mono font-bold text-foreground tracking-wide">
              Log Viewer
            </h1>
          </div>
          <div className="flex items-center gap-1.5 text-[10px] font-mono px-2 py-1 rounded bg-primary/10 border border-primary/20 text-[var(--neon-cyan)]">
            <span className={`w-1.5 h-1.5 rounded-full ${isStreaming ? "bg-[var(--neon-green)] animate-pulse" : "bg-muted-foreground"}`} />
            {isStreaming ? "STREAMING" : "PAUSED"}
          </div>
          <div className="flex items-center gap-1.5 text-[10px] font-mono">
            <span className={`w-1.5 h-1.5 rounded-full ${logsAvailable ? "bg-[var(--neon-green)] animate-pulse" : "bg-muted-foreground"}`} />
            <span className={logsAvailable ? "text-[var(--neon-green)]" : "text-muted-foreground"}>
              {logsAvailable ? "LIVE — cluster logs" : "OFFLINE"}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setIsStreaming(!isStreaming)}
            className="flex items-center gap-1.5 text-xs font-mono bg-secondary/60 px-3 py-1.5 rounded-md border border-border text-muted-foreground hover:text-foreground transition-colors"
          >
            {isStreaming ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}
            {isStreaming ? "Pause" : "Resume"}
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="card-glass rounded-lg p-4 flex flex-col gap-3">
        {/* Search */}
        <div className="flex items-center gap-2 bg-background/50 rounded-md border border-border/50 px-3 py-2">
          <Search className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search logs..."
            className="flex-1 bg-transparent text-sm font-mono text-foreground placeholder:text-muted-foreground outline-none"
          />
          {searchQuery && (
            <button onClick={() => setSearchQuery("")} className="text-xs text-muted-foreground hover:text-foreground">
              Clear
            </button>
          )}
        </div>

        {/* Level & Service filters */}
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <Filter className="w-3 h-3 text-muted-foreground" />
            <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">Level:</span>
            {allLevels.map((level) => {
              const colors = logLevelColors[level]
              const active = selectedLevels.has(level)
              return (
                <button
                  key={level}
                  onClick={() => toggleLevel(level)}
                  className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded border transition-colors ${
                    active
                      ? `${colors.text} ${colors.bg} ${colors.border}`
                      : "text-muted-foreground/40 bg-secondary/20 border-border/20"
                  }`}
                >
                  {level}
                </button>
              )
            })}
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">Service:</span>
            {availableServices.map((service) => {
              const active = !deselectedServices.has(service)
              return (
                <button
                  key={service}
                  onClick={() => toggleService(service)}
                  className={`text-[10px] font-mono px-2 py-0.5 rounded border transition-colors ${
                    active
                      ? `${serviceColor(service)} bg-secondary/40 border-border/50`
                      : "text-muted-foreground/40 bg-secondary/20 border-border/20"
                  }`}
                >
                  {service}
                </button>
              )
            })}
          </div>
        </div>
      </div>

      {/* Log entries */}
      <div className="card-glass rounded-lg overflow-hidden">
        <div className="px-4 py-2 border-b border-border/50 flex items-center justify-between">
          <span className="text-[10px] font-mono text-muted-foreground">
            Showing {filteredLogs.length} of {sourceLogs.length} entries
          </span>
          <span className="text-[10px] font-mono text-muted-foreground">
            Last 15 minutes
          </span>
        </div>
        <div className="font-mono text-xs max-h-[600px] overflow-y-auto">
          {filteredLogs.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">
              {sourceLogs.length === 0
                ? "Waiting for live logs…"
                : "No logs match the current filters."}
            </div>
          ) : (
            filteredLogs.map((log, i) => {
              const colors = logLevelColors[log.level]
              const ts = mounted
                ? formatLocalTime(log.timestamp)
                : log.timestamp.split("T")[1]?.replace("Z", "") ?? log.timestamp
              return (
                <div
                  key={`${log.service}|${log.timestamp}|${log.message}`}
                  className={`flex gap-0 border-b border-border/20 last:border-0 hover:bg-secondary/20 transition-colors ${
                    log.level === "ERROR" ? "bg-[var(--neon-red)]/[0.03]" : ""
                  }`}
                >
                  <span className="text-[10px] text-muted-foreground shrink-0 w-28 px-3 py-2 border-r border-border/20 truncate">
                    {ts}
                  </span>
                  <span className={`shrink-0 w-14 px-2 py-2 text-[10px] font-bold text-center border-r border-border/20 ${colors.text}`}>
                    {log.level}
                  </span>
                  <span className={`shrink-0 w-32 px-2 py-2 text-[10px] border-r border-border/20 truncate ${serviceColor(log.service)}`}>
                    {log.service}
                  </span>
                  <span className="flex-1 px-3 py-2 text-foreground/80 break-all leading-relaxed">
                    {searchQuery ? highlightMatch(log.message, searchQuery) : log.message}
                  </span>
                </div>
              )
            })
          )}
        </div>
      </div>
    </main>
  )
}

function highlightMatch(text: string, query: string) {
  if (!query) return text
  const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi")
  const parts = text.split(regex)
  return parts.map((part, i) =>
    regex.test(part) ? (
      <span key={i} className="bg-[var(--neon-yellow)]/30 text-[var(--neon-yellow)] rounded px-0.5">
        {part}
      </span>
    ) : (
      part
    )
  )
}
