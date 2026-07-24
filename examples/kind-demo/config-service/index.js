const express = require("express")
const promClient = require("prom-client")

const app = express()
const PORT = process.env.PORT || 8080

// ── Prometheus metrics (real, service-labelled) — see payment-service ─────────
const SERVICE_NAME = process.env.SERVICE_NAME || "config-service"
const MEMORY_LIMIT_MB = Number(process.env.MEMORY_LIMIT_MB || 128)
const CPU_LIMIT_M = Number(process.env.CPU_LIMIT_M || 200)
const registry = new promClient.Registry()
registry.setDefaultLabels({ service: SERVICE_NAME })
promClient.collectDefaultMetrics({ register: registry })

const httpRequests = new promClient.Counter({
  name: "http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["method", "route", "status"],
  registers: [registry],
})
const httpDuration = new promClient.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status"],
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [registry],
})
const cpuPercentGauge = new promClient.Gauge({
  name: "app_cpu_percent",
  help: "Process CPU usage as a percent of the container CPU limit",
  registers: [registry],
})
const memPercentGauge = new promClient.Gauge({
  name: "app_memory_percent",
  help: "Process RSS as a percent of the container memory limit",
  registers: [registry],
})

let lastCpu = process.cpuUsage()
let lastCpuAt = Date.now()
setInterval(() => {
  const now = Date.now()
  const elapsedMs = now - lastCpuAt || 1
  const cpuNow = process.cpuUsage()
  const usedMicros = cpuNow.user - lastCpu.user + (cpuNow.system - lastCpu.system)
  lastCpu = cpuNow
  lastCpuAt = now
  const usedCores = usedMicros / 1000 / elapsedMs
  const limitCores = CPU_LIMIT_M / 1000
  cpuPercentGauge.set(Math.min(100, Math.max(0, Math.round((usedCores / limitCores) * 100))))
  const rssMb = process.memoryUsage().rss / (1024 * 1024)
  memPercentGauge.set(Math.min(100, Math.round((rssMb / MEMORY_LIMIT_MB) * 100)))
}, 5000).unref()

app.use((req, res, next) => {
  if (req.path === "/metrics" || req.path === "/health") return next()
  const end = httpDuration.startTimer()
  res.on("finish", () => {
    const labels = { method: req.method, route: req.path, status: String(res.statusCode) }
    httpRequests.inc(labels)
    end(labels)
  })
  next()
})

// Required configuration the service validates on boot. Each entry models a
// different KIND of config source, so Nova can inject (and clearly explain)
// a missing environment variable, a missing Secret, or a missing ConfigMap key.
// In a normal deploy every value is defaulted, so the service boots healthy.
const REQUIRED_CONFIG = {
  FEATURE_FLAGS_URL: {
    kind: "environment variable",
    source: "deployment env var FEATURE_FLAGS_URL",
    default: "http://config-service/flags",
  },
  CONFIG_SIGNING_KEY: {
    kind: "Secret",
    source: "Secret 'config-service-secrets' key CONFIG_SIGNING_KEY",
    default: "sk_live_rotated_signing_key",
  },
  APP_SETTINGS_JSON: {
    kind: "ConfigMap key",
    source: "ConfigMap 'config-service-config' key APP_SETTINGS_JSON",
    default: '{"theme":"dark","locale":"en-US","maxBatch":50}',
  },
}

// Failure switch: when CRASH_ON_MISSING_CONFIG=true the service treats
// REQUIRED_CONFIG_KEY (default FEATURE_FLAGS_URL) as MANDATORY with no fallback.
// If that value is absent the container fails config validation on boot and
// exits (CrashLoopBackOff). The error names WHAT is missing and WHERE it should
// come from, so the incident + runbook can call it out explicitly.
if (process.env.CRASH_ON_MISSING_CONFIG === "true") {
  const key = process.env.REQUIRED_CONFIG_KEY || "FEATURE_FLAGS_URL"
  const meta = REQUIRED_CONFIG[key] || { kind: "configuration value", source: key }
  if (!process.env[key]) {
    console.error(
      `[${new Date().toISOString()}] ERROR Missing required ${meta.kind}: ${key} (expected from ${meta.source}) - config validation failed, refusing to start`
    )
    process.exit(1)
  }
}

const FEATURE_FLAGS_URL = process.env.FEATURE_FLAGS_URL || REQUIRED_CONFIG.FEATURE_FLAGS_URL.default

// In-memory feature flags / app config served to the rest of the platform.
const flags = { checkoutV2: true, darkMode: false, betaSearch: true, transactionsV3: true }

let requestCount = 0

app.get("/config", (req, res) => {
  requestCount++
  res.json({ flags, source: FEATURE_FLAGS_URL })
})

app.get("/health", (req, res) => {
  res.json({ status: "healthy", uptime: process.uptime(), requestCount })
})

app.get("/metrics", async (req, res) => {
  res.set("Content-Type", registry.contentType)
  res.end(await registry.metrics())
})

app.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] INFO config-service started on port ${PORT}`)
  console.log(`[${new Date().toISOString()}] INFO feature flags source: ${FEATURE_FLAGS_URL}`)
})

// ── Heartbeat ─────────────────────────────────────────────────────────────
// Periodic activity log (default every 5s) so the healthy config-service is
// visible in Loki/Grafana. config-service is a leaf dependency of the checkout
// path — payment-service reads feature flags from here on every request.
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS) || 5000
setInterval(() => {
  const ts = () => new Date().toISOString()
  const active = Object.entries(flags).filter(([, v]) => v).map(([k]) => k).join(", ")
  console.log(`[${ts()}] INFO heartbeat config-service — ${requestCount} config requests served (consumed by payment-service); active flags: ${active}`)
}, HEARTBEAT_MS)

process.on("SIGTERM", () => {
  console.log(`[${new Date().toISOString()}] INFO config-service shutting down`)
  process.exit(0)
})
