"use client"

import { Activity, AlertTriangle, Bell, CheckCircle2, ChevronDown, Cpu, Moon, RefreshCw, Settings, Sun, Zap } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useState, useEffect } from "react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { useTheme } from "next-themes"

const navItems = [
  { label: "Overview", href: "/overview" },
  { label: "Deployments", href: "/overview" },
  { label: "Incidents", href: "/incidents" },
  { label: "Logs", href: "/logs" },
  { label: "Analytics", href: "/overview" },
]

type Environment = "prod" | "dev"
type TimeRange = "12h" | "6h"

const envLabels: Record<Environment, string> = { prod: "PROD", dev: "DEV" }
const timeRangeLabels: Record<TimeRange, string> = { "12h": "Last 12h", "6h": "Last 6h" }

type AlertItem = {
  id: string
  title: string
  service: string
  severity: string
  status: string
  startedAt: number
}

const alertSeverityStyle: Record<string, { dot: string; text: string }> = {
  critical: { dot: "bg-[var(--neon-red)]", text: "text-[var(--neon-red)]" },
  high: { dot: "bg-[var(--neon-orange)]", text: "text-[var(--neon-orange)]" },
  medium: { dot: "bg-[var(--neon-yellow)]", text: "text-[var(--neon-yellow)]" },
  low: { dot: "bg-[var(--neon-blue)]", text: "text-[var(--neon-blue)]" },
}

function agoLabel(ms: number): string {
  const diff = Date.now() - ms
  const min = Math.round(diff / 60000)
  if (min < 1) return "just now"
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h ago`
  return `${Math.round(hr / 24)}d ago`
}

export function Topbar() {
  const pathname = usePathname()
  const router = useRouter()
  const [time, setTime] = useState("")
  const [refreshing, setRefreshing] = useState(false)
  const [env, setEnv] = useState<Environment>("prod")
  const [timeRange, setTimeRange] = useState<TimeRange>("12h")
  const [alerts, setAlerts] = useState<AlertItem[]>([])
  const { resolvedTheme, setTheme } = useTheme()
  const [themeMounted, setThemeMounted] = useState(false)
  useEffect(() => setThemeMounted(true), [])
  const isDark = resolvedTheme !== "light"

  useEffect(() => {
    const update = () =>
      setTime(
        new Date().toLocaleTimeString("en-US", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        })
      )
    update()
    const id = setInterval(update, 1000)
    return () => clearInterval(id)
  }, [])

  // Real alerts feed — polled from the incident store so the bell reflects the
  // actual open incidents (payment cascade, config/transaction outages, etc.).
  useEffect(() => {
    let cancelled = false
    const load = () =>
      fetch("/api/incidents?range=all")
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (cancelled) return
          type RawIncident = {
            id: string
            title: string
            service: string
            severity: string
            status: string
            startedAt: number
          }
          const raw: RawIncident[] = (d?.incidents ?? []).filter(
            (i: RawIncident) => i.status !== "resolved"
          )
          // Dedupe by service — re-running an inject creates multiple records for
          // the same outage; keep the earliest (canonical) one per service.
          const bySvc = new Map<string, RawIncident>()
          for (const i of raw) {
            const existing = bySvc.get(i.service)
            if (!existing || i.startedAt < existing.startedAt) bySvc.set(i.service, i)
          }
          const severityRank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 }
          const rows: AlertItem[] = Array.from(bySvc.values())
            .map((i) => ({
              id: i.id,
              title: i.title,
              service: i.service,
              severity: i.severity,
              status: i.status,
              startedAt: i.startedAt,
            }))
            .sort(
              (a, b) =>
                (severityRank[a.severity] ?? 9) - (severityRank[b.severity] ?? 9) ||
                b.startedAt - a.startedAt
            )
          setAlerts(rows)
        })
        .catch(() => {})
    load()
    const t = setInterval(load, 5000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [])

  const handleRefresh = () => {
    setRefreshing(true)
    setTimeout(() => setRefreshing(false), 1200)
  }

  const alertCount = alerts.length

  return (
    <header className="h-14 flex items-center px-4 lg:px-6 border-b border-border bg-card/60 backdrop-blur-sm sticky top-0 z-50 gap-4">
      {/* Logo */}
      <div className="flex items-center gap-2 shrink-0">
        <div className="relative w-7 h-7 rounded-md bg-primary/10 border border-primary/30 flex items-center justify-center neon-glow-cyan">
          <Zap className="w-4 h-4 text-[var(--neon-cyan)]" />
        </div>
        <span className="font-mono font-bold text-sm text-foreground tracking-wider">
          NOVA<span className="text-[var(--neon-cyan)]">DEPLOY</span>
        </span>
      </div>

      {/* Nav */}
      <nav className="hidden md:flex items-center gap-1 ml-4">
        {navItems.map((item) => {
          const isActive = pathname === item.href || (item.href !== "/overview" && pathname.startsWith(item.href))
          return (
            <Link
              key={item.label}
              href={item.href}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                isActive
                  ? "bg-primary/10 text-[var(--neon-cyan)] border border-primary/20"
                  : "text-muted-foreground hover:text-foreground hover:bg-secondary"
              }`}
            >
              {item.label}
            </Link>
          )
        })}
      </nav>

      <div className="ml-auto flex items-center gap-3">
        {/* Live clock */}
        <div className="hidden sm:flex items-center gap-1.5 text-xs font-mono text-muted-foreground bg-secondary/60 px-2.5 py-1 rounded-md border border-border">
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--neon-green)] animate-pulse" />
          <span>LIVE</span>
          <span className="text-foreground">{time}</span>
        </div>

        {/* Env selector */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="hidden md:flex items-center gap-1.5 text-xs font-mono bg-secondary/60 px-2.5 py-1 rounded-md border border-border text-muted-foreground hover:text-foreground transition-colors outline-none">
              <Cpu className="w-3 h-3" />
              <span className={env === "prod" ? "text-[var(--neon-green)]" : "text-[var(--neon-blue)]"}>
                {envLabels[env]}
              </span>
              <ChevronDown className="w-3 h-3" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[9rem]">
            <DropdownMenuLabel className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
              Environment
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup value={env} onValueChange={(v) => setEnv(v as Environment)}>
              <DropdownMenuRadioItem value="prod" className="text-xs font-mono">
                <span className="text-[var(--neon-green)]">PROD</span>
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dev" className="text-xs font-mono">
                <span className="text-[var(--neon-blue)]">DEV</span>
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Time range */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="hidden md:flex items-center gap-1.5 text-xs bg-secondary/60 px-2.5 py-1 rounded-md border border-border text-muted-foreground hover:text-foreground transition-colors outline-none">
              <Activity className="w-3 h-3" />
              <span>{timeRangeLabels[timeRange]}</span>
              <ChevronDown className="w-3 h-3" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[9rem]">
            <DropdownMenuLabel className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
              Time Range
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup value={timeRange} onValueChange={(v) => setTimeRange(v as TimeRange)}>
              <DropdownMenuRadioItem value="12h" className="text-xs">
                Last 12h
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="6h" className="text-xs">
                Last 6h
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Refresh */}
        <Button
          variant="ghost"
          size="icon"
          className="w-8 h-8 text-muted-foreground hover:text-foreground"
          onClick={handleRefresh}
        >
          <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`} />
        </Button>

        {/* Theme toggle (light / dark) */}
        <button
          onClick={() => setTheme(isDark ? "light" : "dark")}
          aria-label="Toggle light / dark theme"
          title={isDark ? "Switch to light mode" : "Switch to dark mode"}
          className="w-8 h-8 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors outline-none"
        >
          {themeMounted && isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
        </button>

        {/* Alerts bell */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="relative w-8 h-8 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors outline-none">
              <Bell className="w-4 h-4" />
              {alertCount > 0 && (
                <Badge className="absolute -top-0.5 -right-0.5 w-4 h-4 p-0 text-[9px] flex items-center justify-center bg-[var(--neon-red)] text-white border-0 animate-pulse">
                  {alertCount}
                </Badge>
              )}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-80 p-0">
            <div className="flex items-center justify-between px-3 py-2.5 border-b border-border">
              <span className="text-xs font-mono font-semibold uppercase tracking-wider text-foreground">
                Alerts
              </span>
              <span
                className={`text-[10px] font-mono font-bold px-1.5 py-0.5 rounded border ${
                  alertCount > 0
                    ? "bg-[var(--neon-red)]/15 border-[var(--neon-red)]/30 text-[var(--neon-red)]"
                    : "bg-[var(--neon-green)]/15 border-[var(--neon-green)]/30 text-[var(--neon-green)]"
                }`}
              >
                {alertCount} active
              </span>
            </div>

            {alertCount === 0 ? (
              <div className="flex items-center justify-center gap-2 px-3 py-6">
                <CheckCircle2 className="w-4 h-4 text-[var(--neon-green)]" />
                <span className="text-xs font-mono text-[var(--neon-green)]">All systems operational</span>
              </div>
            ) : (
              <div className="max-h-80 overflow-y-auto">
                {alerts.map((a) => {
                  const style = alertSeverityStyle[a.severity] ?? alertSeverityStyle.medium
                  return (
                    <button
                      key={a.id}
                      onClick={() => router.push(`/incidents/${a.id}`)}
                      className="w-full flex items-start gap-2.5 px-3 py-2.5 text-left border-b border-border/60 last:border-b-0 hover:bg-secondary/60 transition-colors"
                    >
                      <AlertTriangle className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${style.text}`} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className={`text-[9px] font-mono font-bold uppercase ${style.text}`}>
                            {a.severity}
                          </span>
                          <span className="text-[9px] font-mono text-muted-foreground">
                            {agoLabel(a.startedAt)}
                          </span>
                        </div>
                        <p className="text-xs font-medium text-foreground truncate mt-0.5">{a.title}</p>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          <span className={`w-1.5 h-1.5 rounded-full ${style.dot} animate-pulse`} />
                          <span className="text-[10px] font-mono text-muted-foreground">{a.service}</span>
                        </div>
                      </div>
                    </button>
                  )
                })}
              </div>
            )}

            <Link
              href="/incidents"
              className="block text-center text-xs text-primary hover:text-[var(--neon-cyan)] py-2.5 border-t border-border transition-colors"
            >
              View all incidents
            </Link>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Avatar */}
        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-primary/40 to-primary/10 border border-primary/30 flex items-center justify-center text-xs font-bold text-[var(--neon-cyan)] cursor-pointer hover:border-primary/60 transition-colors">
          MS
        </div>

        {/* Settings */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="w-8 h-8 text-muted-foreground">
              <Settings className="w-3.5 h-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[10rem]">
            <DropdownMenuLabel className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
              Settings
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild className="text-xs">
              <Link href="/settings">
                <Settings className="w-3.5 h-3.5" />
                Configuration
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild className="text-xs">
              <Link href="/eval">
                <Activity className="w-3.5 h-3.5" />
                Evals
              </Link>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}
