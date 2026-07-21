const express = require("express")
const { Pool } = require("pg")
const fs = require("fs")

const app = express()
app.use(express.json())
const PORT = process.env.PORT || 8080

// ── Downstream cascade (Nova demo) ────────────────────────────────────────────
// transaction-service is payment-service's ledger dependency. For the demo its
// readiness MIRRORS payment-service's live health so the blast radius is visible
// on the dashboard — and, crucially, it AUTO-RECOVERS the moment payment-service is
// restored, with NO recover script and NO pod restart needed.
//
// A lightweight background poller checks payment-service /health every couple of
// seconds and caches the result; /ready returns that cached value instantly (so the
// readiness probe never blocks on a network call). Restarting payment-service from
// the terminal is all it takes for transaction-service to go green again.
//
// A manual override is also honoured: the /tmp/degraded flag file (via kubectl exec)
// or DEGRADED_MODE=true force-degrade regardless of upstream health.
const PAYMENT_SERVICE_URL = process.env.PAYMENT_SERVICE_URL || "http://payment-service"
const UPSTREAM_POLL_MS = Number(process.env.UPSTREAM_POLL_MS) || 2000
// Consecutive failed polls before we degrade — small hysteresis so a single
// transient blip doesn't flap readiness. Recovery is immediate (first good poll).
const UPSTREAM_FAIL_THRESHOLD = 2
const DEGRADE_FLAG = "/tmp/degraded"

let upstreamHealthy = true // optimistic at boot so we start Ready (no deadlock)
let upstreamFailStreak = 0

async function pollUpstream() {
  let ok = false
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 1200)
    try {
      const r = await fetch(`${PAYMENT_SERVICE_URL}/health`, { signal: ctrl.signal })
      ok = r.ok // 200 = healthy; 503 (poolCritical) or unreachable = unhealthy
    } finally {
      clearTimeout(t)
    }
  } catch {
    ok = false // no ready endpoints during payment-service crashloop → unhealthy
  }

  const ts = () => new Date().toISOString()
  if (ok) {
    if (!upstreamHealthy) {
      console.log(`[${ts()}] INFO upstream payment-service healthy again — ledger resuming, readiness restored`)
    }
    upstreamHealthy = true
    upstreamFailStreak = 0
  } else {
    upstreamFailStreak++
    if (upstreamFailStreak >= UPSTREAM_FAIL_THRESHOLD && upstreamHealthy) {
      upstreamHealthy = false
      console.error(`[${ts()}] ERROR upstream payment-service unavailable — ledger writes paused, readiness failing`)
    }
  }
}
setInterval(pollUpstream, UPSTREAM_POLL_MS)
pollUpstream()

// Degraded when the upstream is down, OR when manually forced via the flag file /
// env var. Manual force is only for ad-hoc testing; the demo relies on the
// automatic upstream mirror above.
function isDegraded() {
  return !upstreamHealthy || process.env.DEGRADED_MODE === "true" || fs.existsSync(DEGRADE_FLAG)
}

// Injected failure hook for Nova: when CRASH_ON_STARTUP=true the service
// exits on boot → CrashLoopBackOff. Cleared by the ROLLING-RESTART runbook
// (POST /api/remediate strips this flag before rolling the deployment).
if (process.env.CRASH_ON_STARTUP === "true") {
  console.error(`[${new Date().toISOString()}] ERROR transaction-service failed to start: downstream ledger dependency unavailable`)
  process.exit(1)
}

// Small pool — participates in the shared Postgres max_connections pressure, so
// the DB-exhaustion cascade is genuinely distributed across payment + transaction.
const pool = new Pool({
  host: process.env.DB_HOST || "postgres",
  port: 5432,
  database: process.env.DB_NAME || "paymentdb",
  user: process.env.DB_USER || "payment_svc",
  password: process.env.DB_PASSWORD || "nova_password",
  max: 2,
  idleTimeoutMillis: 500,
  connectionTimeoutMillis: 1000,
})

let requestCount = 0
let errorCount = 0
const startTime = Date.now()

// Ensure the ledger table exists on boot. Retries with backoff so a Postgres
// that isn't ready yet at startup doesn't permanently leave the table missing.
async function ensureSchema(attempt = 1) {
  try {
    const client = await pool.connect()
    try {
      await client.query(`CREATE TABLE IF NOT EXISTS ledger (
        id SERIAL PRIMARY KEY,
        txn_id TEXT NOT NULL,
        order_id TEXT,
        amount NUMERIC,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`)
      console.log(`[${new Date().toISOString()}] INFO transaction-service ledger schema ready`)
    } finally {
      client.release()
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] ERROR failed to ensure ledger schema (attempt ${attempt}): ${err.message}`)
    if (attempt < 10) {
      setTimeout(() => ensureSchema(attempt + 1), Math.min(attempt * 1000, 5000))
    }
  }
}

// Records a ledger transaction — a REAL Postgres write. Under load its small pool
// competes for Postgres max_connections=5 and exhausts, returning 503 which
// cascades back to payment-service /api/checkout.
app.post("/api/transaction", async (req, res) => {
  requestCount++
  const ts = () => new Date().toISOString()
  const txnId = `txn-${Math.random().toString(36).slice(2, 10)}`
  const orderId = req.body?.orderId ?? null
  const amount = req.body?.amount ?? 0

  const client = await pool.connect().catch(() => {
    errorCount++
    console.error(`[${ts()}] ERROR ledger pool.connect() timeout — too many connections for role "${process.env.DB_USER || "payment_svc"}"`)
    return null
  })

  if (!client) {
    console.error(`[${ts()}] ERROR POST /api/transaction — 503 Service Unavailable (ledger connection pool exhausted)`)
    return res.status(503).json({ error: "Service Unavailable", message: "ledger pool exhausted" })
  }

  try {
    await client.query(
      "INSERT INTO ledger (txn_id, order_id, amount) VALUES ($1, $2, $3)",
      [txnId, orderId, amount]
    )
    res.json({ success: true, txnId, amount, processedAt: new Date().toISOString() })
  } catch (err) {
    errorCount++
    console.error(`[${ts()}] ERROR ledger write failed for ${txnId}: ${err.message}`)
    res.status(500).json({ error: "ledger write failed" })
  } finally {
    client.release()
  }
})

// Liveness — the process is up and serving. Deliberately NOT affected by the
// upstream cascade, so a degraded transaction-service is never killed/restarted
// (no CrashLoopBackOff, no self-inflicted incident).
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    uptime: Date.now() - startTime,
    pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
    metrics: { requestCount, errorCount },
  })
})

// Readiness — reflects the DOWNSTREAM cascade. transaction-service is
// payment-service's ledger dependency; readiness mirrors payment-service health
// (see the upstream poller above). When payment-service is in incident we fail
// readiness so Kubernetes pulls the pod OUT of rotation → it shows as
// NotReady/degraded on the dashboard WITHOUT crash-looping and WITHOUT raising its
// own incident. It auto-recovers within a couple of seconds of payment-service
// being healthy again — no recover script needed.
app.get("/ready", (req, res) => {
  if (isDegraded()) {
    return res.status(503).json({
      status: "degraded",
      reason: "upstream payment-service unavailable — ledger writes paused",
    })
  }
  res.json({ status: "ready", uptime: Date.now() - startTime })
})

app.get("/metrics", (req, res) => {
  const errorRate = requestCount > 0 ? (errorCount / requestCount) * 100 : 0
  res.json({ requestCount, errorCount, errorRate: Math.round(errorRate * 100) / 100 })
})

ensureSchema()

app.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] INFO transaction-service started on port ${PORT}`)
  console.log(`[${new Date().toISOString()}] INFO ledger DB: ${process.env.DB_NAME || "paymentdb"} (pool max 2)`)
})

// ── Heartbeat ─────────────────────────────────────────────────────────────
// Periodic activity log (default every 5s) so the healthy transaction-service is
// visible in Loki/Grafana, and to surface its dependency chain: payment-service →
// transaction-service → Postgres ledger. The pool stats make the shared-Postgres
// connection pressure visible (waiting climbs during the exhaustion cascade).
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS) || 5000
setInterval(() => {
  const ts = () => new Date().toISOString()
  const errorRate = requestCount > 0 ? (errorCount / requestCount) * 100 : 0
  if (isDegraded()) {
    console.error(`[${ts()}] ERROR transaction-service degraded — upstream payment-service unavailable, ledger writes paused, pods NotReady`)
  }
  console.log(`[${ts()}] INFO heartbeat transaction-service — ${requestCount} ledger writes for payment-service, errorRate=${errorRate.toFixed(1)}%`)
  console.log(`[${ts()}] INFO ledger DB (postgres) pool — total=${pool.totalCount} idle=${pool.idleCount} waiting=${pool.waitingCount}`)
}, HEARTBEAT_MS)

process.on("SIGTERM", () => {
  console.log(`[${new Date().toISOString()}] INFO transaction-service shutting down`)
  pool.end()
  process.exit(0)
})
