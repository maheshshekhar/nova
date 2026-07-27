const express = require("express")
const { Pool } = require("pg")

const app = express()
app.use(express.json())
const PORT = process.env.PORT || 8080

// Downstream services in the real checkout call graph.
const CONFIG_SERVICE_URL = process.env.CONFIG_SERVICE_URL || "http://config-service"
const TRANSACTION_SERVICE_URL = process.env.TRANSACTION_SERVICE_URL || "http://transaction-service"

// fetch with an abort timeout (Node 20 has global fetch).
async function callWithTimeout(url, options, timeoutMs) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: ctrl.signal })
  } finally {
    clearTimeout(t)
  }
}

// Intentionally small pool — will exhaust under load
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
let startTime = Date.now()

// Rate-limit the "config-service degraded" WARN so a transient timeout storm
// under load doesn't drown the real incident signal (pool exhaustion) in the logs.
let lastConfigWarnAt = 0

// Rolling window of the most recent request outcomes (1 = error, 0 = success).
// /health uses THIS instead of the lifetime cumulative rate: a cumulative average
// is "sticky" and settles below the threshold after the initial burst, which lets
// pods stabilize and breaks the intended crash-loop. A recent window stays high
// under sustained load, so the liveness probe keeps failing and pods keep
// restarting for as long as the load generator runs.
const WINDOW = 20
const outcomes = []
function record(isError) {
  outcomes.push(isError ? 1 : 0)
  if (outcomes.length > WINDOW) outcomes.shift()
}
function recentErrorRate() {
  if (outcomes.length === 0) return 0
  return (outcomes.reduce((a, b) => a + b, 0) / outcomes.length) * 100
}

// Simulate a checkout that requires a DB connection
app.post("/api/checkout", async (req, res) => {
  requestCount++
  const ts = () => new Date().toISOString()

  // 1. Feature-flag check via config-service (FAIL-OPEN: degrade, don't block).
  try {
    const cfgRes = await callWithTimeout(`${CONFIG_SERVICE_URL}/config`, {}, 2000)
    if (!cfgRes.ok) throw new Error(`status ${cfgRes.status}`)
  } catch (err) {
    // Log at most once every 10s — under load the event loop stalls and this
    // would otherwise fire on every request and bury the real signal.
    const now = Date.now()
    if (now - lastConfigWarnAt > 10000) {
      lastConfigWarnAt = now
      console.warn(`[${ts()}] WARN config-service degraded (${err.message}) — using cached feature flags`)
    }
  }

  // 2. DB connection (intentionally small pool → exhausts under load).
  const client = await pool.connect().catch(err => {
    errorCount++
    console.error(`[${ts()}] ERROR pool.waitQueueSize exceeded maximum for payment-service-prod`)
    console.error(`[${ts()}] ERROR FATAL: too many connections for role "payment_svc"`)
    return null
  })

  if (!client) {
    record(true)
    console.error(`[${ts()}] ERROR POST /api/checkout — 503 Service Unavailable (upstream timeout)`)
    return res.status(503).json({ error: "Service Unavailable", message: "Connection pool exhausted" })
  }

  try {
    // Simulate GC pause and slow query while requests are queueing for the pool.
    const underLoad = pool.waitingCount > 0
    const delay = underLoad ? 300 + Math.random() * 200 : 50 + Math.random() * 30

    if (underLoad) {
      console.warn(`[${ts()}] WARN GC pause ${Math.round(delay)}ms exceeds threshold (50ms) — pod payment-service-prod`)
    }

    await new Promise(resolve => setTimeout(resolve, delay))
    await client.query("SELECT pg_sleep(0.1), NOW() as processed_at")

    const orderId = `ord-${Math.random().toString(36).slice(2, 8)}`
    const amount = req.body?.amount ?? Math.round(Math.random() * 20000) / 100

    // 3. Record the transaction via transaction-service (real downstream call).
    let txnId = null
    try {
      const txRes = await callWithTimeout(`${TRANSACTION_SERVICE_URL}/api/transaction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId, amount }),
      }, 1500)
      if (!txRes.ok) {
        errorCount++
        record(true)
        console.error(`[${ts()}] ERROR transaction-service returned ${txRes.status} for ${orderId} — checkout aborted`)
        return res.status(503).json({ error: "Service Unavailable", message: "transaction-service failed" })
      }
      const txBody = await txRes.json().catch(() => ({}))
      txnId = txBody.txnId ?? null
    } catch (err) {
      errorCount++
      record(true)
      console.error(`[${ts()}] ERROR transaction-service unreachable for ${orderId}: ${err.message}`)
      return res.status(503).json({ error: "Service Unavailable", message: "transaction-service unreachable" })
    }

    record(false)
    res.json({
      success: true,
      orderId,
      txnId,
      processedAt: new Date().toISOString()
    })

  } catch (err) {
    errorCount++
    record(true)
    console.error(`[${ts()}] ERROR Transaction failed:`, err.message)
    res.status(500).json({ error: "Transaction failed" })
  } finally {
    client.release()
  }
})

// Health and metrics endpoints
app.get("/health", (req, res) => {
  const uptime = Date.now() - startTime
  // Use the RECENT error rate (sliding window) so health reflects current load,
  // not the sticky lifetime average.
  const errorRate = recentErrorRate()

  // Fail liveness probe when the recent error rate is critical.
  // This causes Kubernetes to restart the pod — visible CrashLoopBackOff
  const poolCritical = errorRate > 40

  if (poolCritical) {
    console.error(
      `[${new Date().toISOString()}] ERROR Health check failing — ` +
      `pool exhausted: waiting=${pool.waitingCount}, errorRate=${errorRate.toFixed(1)}%`
    )
    return res.status(503).json({
      status: "unhealthy",
      reason: "connection pool exhausted",
      pool: {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
        max: 3
      },
      metrics: {
        requestCount,
        errorCount,
        errorRate: Math.round(errorRate * 100) / 100
      }
    })
  }

  res.json({
    status: pool.waitingCount > 0 ? "degraded" : "healthy",
    uptime,
    pool: {
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
      max: 3
    },
    metrics: {
      requestCount,
      errorCount,
      errorRate: Math.round(errorRate * 100) / 100
    }
  })
})

app.get("/metrics", (req, res) => {
  const errorRate = requestCount > 0 ? (errorCount / requestCount) * 100 : 0
  res.json({
    errorRate: Math.round(errorRate * 100) / 100,
    poolWaiting: pool.waitingCount,
    poolTotal: pool.totalCount,
    requestCount,
    errorCount
  })
})

// Circuit breaker simulation
app.get("/circuit-breaker", (req, res) => {
  const isOpen = errorCount > 10
  if (isOpen) {
    console.error(`[${new Date().toISOString()}] ERROR Circuit breaker OPEN for payment-service after 10 consecutive failures`)
  }
  res.json({ state: isOpen ? "OPEN" : "CLOSED", errorCount })
})

app.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] INFO payment-service started on port ${PORT}`)
  console.log(`[${new Date().toISOString()}] INFO DB pool max: 2 connections per pod`)
})

// ── Heartbeat + synthetic payment ticker ──────────────────────────────────────
// Emit periodic activity logs (default every 5s) so a HEALTHY service still shows
// up in Loki/Grafana, surface the checkout call-graph (payment-service →
// config-service for flags, payment-service → transaction-service for the ledger),
// and stream realistic payment-authorization logs so the service looks like a live
// revenue system. During an incident the downstream pings fail and the authorized
// stream stops, so the cascade is visible in the logs too.
//
// PCI-safe: we NEVER log a CVV value or a full card number (PAN). Only a masked
// last-4, the card network, an auth code, and the CHECK RESULTS (cvv/avs pass/fail)
// are logged — exactly what a compliant processor emits.
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS) || 5000
async function reachable(url) {
  try {
    const r = await callWithTimeout(url, {}, 1500)
    return r.ok
  } catch {
    return false
  }
}
const CARDS = [
  { last4: "4242", network: "visa" },
  { last4: "5454", network: "mastercard" },
  { last4: "3782", network: "amex" },
  { last4: "6011", network: "discover" },
  { last4: "0119", network: "visa" },
]
const DECLINES = [
  { code: "51", reason: "insufficient_funds" },
  { code: "05", reason: "do_not_honor" },
  { code: "54", reason: "expired_card" },
  { code: "14", reason: "invalid_card_number" },
]
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)]
const authCode = () => `AUTH-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
const orderId = () => `ord-${Math.random().toString(36).slice(2, 8)}`

setInterval(async () => {
  const ts = () => new Date().toISOString()
  console.log(`[${ts()}] INFO heartbeat payment-service — ${requestCount} checkouts processed, errorRate=${recentErrorRate().toFixed(1)}%, pool waiting=${pool.waitingCount}`)

  if (await reachable(`${CONFIG_SERVICE_URL}/health`)) {
    console.log(`[${ts()}] INFO downstream config-service reachable — feature flags OK`)
  } else {
    console.warn(`[${ts()}] WARN downstream config-service unreachable — checkout falling back to cached feature flags`)
  }
  if (await reachable(`${TRANSACTION_SERVICE_URL}/health`)) {
    console.log(`[${ts()}] INFO downstream transaction-service reachable — ledger OK`)
  } else {
    console.error(`[${ts()}] ERROR downstream transaction-service unreachable — checkouts will abort with 503`)
  }

  // Synthetic payment authorizations for the 5s window so payments "flow" in
  // Grafana even when the load-generator isn't running.
  const total = 4 + Math.floor(Math.random() * 6)
  let approved = 0
  let declined = 0
  let volume = 0
  for (let i = 0; i < total; i++) {
    const card = pick(CARDS)
    const amount = Math.round((5 + Math.random() * 495) * 100) / 100
    const authMs = 90 + Math.floor(Math.random() * 160)
    // ~1 in 8 payments declines — realistic gateway behaviour.
    if (Math.random() < 0.12) {
      declined++
      const d = pick(DECLINES)
      console.warn(`[${ts()}] WARN payment declined ${orderId()} — card ****${card.last4} (${card.network}) · code=${d.code} ${d.reason} · cvv=pass`)
    } else {
      approved++
      volume += amount
      console.log(`[${ts()}] INFO payment authorized ${orderId()} — $${amount.toFixed(2)} USD · card ****${card.last4} (${card.network}) · ${authCode()} · cvv=pass avs=Y · gateway 200 in ${authMs}ms`)
    }
  }
  console.log(`[${ts()}] INFO payments (5s window): ${approved} approved, ${declined} declined · volume $${volume.toFixed(2)} USD`)
}, HEARTBEAT_MS)

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log(`[${new Date().toISOString()}] INFO payment-service shutting down`)
  pool.end()
  process.exit(0)
})
