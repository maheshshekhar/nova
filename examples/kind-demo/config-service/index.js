const express = require("express")

const app = express()
const PORT = process.env.PORT || 8080

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

app.get("/metrics", (req, res) => {
  res.json({ requestCount })
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
