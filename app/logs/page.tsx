"use client"

import { useState, useMemo, useEffect } from "react"
import { ArrowLeft, Filter, Pause, Play, Search, Terminal } from "lucide-react"
import { useRealLogs } from "@/hooks/use-real-metrics"
import { useLiveState } from "@/lib/live-state"
import { formatLocalTime, parseRawLogLine } from "@/lib/local-time"
import Link from "next/link"

const logLevelColors: Record<string, { text: string; bg: string; border: string }> = {
  ERROR: { text: "text-[var(--neon-red)]", bg: "bg-[var(--neon-red)]/10", border: "border-[var(--neon-red)]/20" },
  WARN: { text: "text-[var(--neon-orange)]", bg: "bg-[var(--neon-orange)]/10", border: "border-[var(--neon-orange)]/20" },
  INFO: { text: "text-[var(--neon-cyan)]", bg: "bg-[var(--neon-cyan)]/10", border: "border-[var(--neon-cyan)]/20" },
  DEBUG: { text: "text-muted-foreground", bg: "bg-secondary/30", border: "border-border/30" },
}

const serviceColors: Record<string, string> = {
  "api-gateway": "text-[var(--neon-cyan)]",
  "auth-service": "text-[var(--neon-blue)]",
  "payment-service": "text-[var(--neon-red)]",
  "config-service": "text-[var(--neon-purple,#a78bfa)]",
  "transaction-service": "text-[var(--neon-green)]",
  "notifications": "text-[var(--neon-green)]",
  "search-service": "text-[var(--neon-yellow)]",
  "user-profile": "text-[var(--neon-orange)]",
  "media-service": "text-[var(--neon-orange)]",
  "cache-layer": "text-[var(--neon-cyan)]",
}

const allLevels = ["ERROR", "WARN", "INFO", "DEBUG"]
// The real workloads whose logs Fluent Bit ships into Loki. Kept as a fixed list
// so the service filter chips are stable even before the first live logs arrive.
const allServices = ["payment-service", "config-service", "transaction-service"]

export default function LogsPage() {
  const [searchQuery, setSearchQuery] = useState("")
  const [selectedLevels, setSelectedLevels] = useState<Set<string>>(new Set(allLevels))
  const [selectedServices, setSelectedServices] = useState<Set<string>>(new Set(allServices))
  const [isStreaming, setIsStreaming] = useState(true)
  const { currentIncidentId } = useLiveState()

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
        const service = (log as { service?: string }).service ?? "payment-service"
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
      if (!selectedServices.has(log.service)) return false
      if (searchQuery && !log.message.toLowerCase().includes(searchQuery.toLowerCase())) return false
      return true
    })
  }, [searchQuery, selectedLevels, selectedServices, sourceLogs])

  // Service filter chips: the known real workloads plus any other service that
  // shows up in the live stream. Using the fixed base keeps the chips stable even
  // before the first logs arrive.
  const availableServices = useMemo(
    () => Array.from(new Set([...allServices, ...sourceLogs.map((l) => l.service)])).sort(),
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
    setSelectedServices((prev) => {
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
              const active = selectedServices.has(service)
              return (
                <button
                  key={service}
                  onClick={() => toggleService(service)}
                  className={`text-[10px] font-mono px-2 py-0.5 rounded border transition-colors ${
                    active
                      ? `${serviceColors[service] ?? "text-foreground"} bg-secondary/40 border-border/50`
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
                  <span className={`shrink-0 w-32 px-2 py-2 text-[10px] border-r border-border/20 truncate ${serviceColors[log.service] ?? "text-foreground"}`}>
                    {log.service}
                  </span>
                  <span className="flex-1 px-3 py-2 text-foreground/80 break-all leading-relaxed">
                    {searchQuery ? highlightMatch(log.message, searchQuery) : log.message}
                    {log.service === "payment-service" && log.level === "ERROR" && (
                      <Link
                        href={`/incidents/${currentIncidentId}`}
                        className="ml-2 inline-flex items-center text-[10px] font-mono px-1.5 py-0.5 rounded border border-[var(--neon-cyan)]/30 bg-[var(--neon-cyan)]/10 text-[var(--neon-cyan)] hover:bg-[var(--neon-cyan)]/20 transition-colors align-middle"
                      >
                        {currentIncidentId} ↗
                      </Link>
                    )}
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
