export const deployments = [
  {
    id: "dep-9f3a2",
    service: "api-gateway",
    version: "v3.14.2",
    environment: "production",
    status: "success",
    branch: "main",
    commit: "a4f9b2c",
    message: "feat: add rate limiting middleware",
    author: "sarah.kim",
    duration: "4m 12s",
    timestamp: "2 min ago",
  },
  {
    id: "dep-8e1b7",
    service: "auth-service",
    version: "v2.8.1",
    environment: "production",
    status: "success",
    branch: "release/2.8.1",
    commit: "d7c3e91",
    message: "fix: token refresh race condition",
    author: "marcos.dev",
    duration: "2m 11s",
    timestamp: "4 min ago",
  },
  {
    id: "dep-7c4d3",
    service: "user-profile",
    version: "v1.22.0",
    environment: "staging",
    status: "success",
    branch: "feature/avatar-upload",
    commit: "b2a5f87",
    message: "feat: S3 avatar upload pipeline",
    author: "priya.r",
    duration: "2m 58s",
    timestamp: "12 min ago",
  },
  {
    id: "dep-6b5e8",
    service: "notifications",
    version: "v4.1.3",
    environment: "production",
    status: "success",
    branch: "main",
    commit: "e9d1c44",
    message: "chore: update websocket deps",
    author: "alex.thorn",
    duration: "3m 05s",
    timestamp: "22 min ago",
  },
]

export const incidents = [
  {
    id: "INC-2847",
    title: "Elevated 5xx errors on /api/checkout",
    severity: "critical",
    service: "payment-service",
    started: "14 min ago",
    status: "investigating",
    affectedUsers: 1842,
  },
  {
    id: "INC-2846",
    title: "P95 latency spike in auth-service",
    severity: "high",
    service: "auth-service",
    started: "31 min ago",
    status: "mitigating",
    affectedUsers: 312,
  },
  {
    id: "INC-2845",
    title: "Redis cache miss rate above threshold",
    severity: "medium",
    service: "cache-layer",
    started: "1h 12m ago",
    status: "monitoring",
    affectedUsers: 0,
  },
]

// The active incident is always the payment-service cascade, re-labelled with the
// current run's incrementing id (INC-2847, INC-2848, …). Each inject run produces
// a fresh one; previous ones move to the resolved history.
export const PRIMARY_INCIDENT = {
  title: "Elevated 5xx errors on /api/checkout",
  severity: "critical",
  service: "payment-service",
  status: "investigating",
  affectedUsers: 1842,
} as const

export function makeActiveIncident(id: string, started = "just now") {
  return { id, started, ...PRIMARY_INCIDENT }
}

export const generateErrorData = () => {
  const now = Date.now()
  return Array.from({ length: 48 }, (_, i) => {
    const isSpike = i === 42 || i === 43
    const base = 0.4 + Math.random() * 0.8
    return {
      time: new Date(now - (47 - i) * 15 * 60 * 1000).toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }),
      rate: isSpike ? 4.2 + Math.random() * 1.8 : base,
      p99: isSpike ? 5.8 + Math.random() * 2 : base * 1.4,
    }
  })
}

export const generateLatencyData = () => {
  const now = Date.now()
  return Array.from({ length: 48 }, (_, i) => {
    const isSpike = i === 38 || i === 39 || i === 40
    return {
      time: new Date(now - (47 - i) * 15 * 60 * 1000).toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }),
      p50: isSpike ? 280 + Math.random() * 120 : 85 + Math.random() * 40,
      p95: isSpike ? 820 + Math.random() * 300 : 210 + Math.random() * 90,
      p99: isSpike ? 1400 + Math.random() * 400 : 380 + Math.random() * 150,
    }
  })
}

export const services = [
  { name: "api-gateway", region: "us-east-1", status: "healthy", uptime: "99.98%", rps: 12400, latencyP50: 42, latencyP95: 118, errorRate: 0.12, cpu: 34, memory: 61, instances: 8 },
  { name: "auth-service", region: "us-east-1", status: "degraded", uptime: "99.71%", rps: 5820, latencyP50: 124, latencyP95: 892, errorRate: 0.84, cpu: 78, memory: 82, instances: 4 },
  { name: "payment-service", region: "us-east-1", status: "critical", uptime: "98.42%", rps: 1240, latencyP50: 188, latencyP95: 1420, errorRate: 5.21, cpu: 91, memory: 87, instances: 3 },
  { name: "config-service", region: "us-east-1", status: "healthy", uptime: "99.99%", rps: 340, latencyP50: 12, latencyP95: 40, errorRate: 0.02, cpu: 15, memory: 30, instances: 2 },
  { name: "transaction-service", region: "us-east-1", status: "healthy", uptime: "99.97%", rps: 2100, latencyP50: 48, latencyP95: 160, errorRate: 0.06, cpu: 28, memory: 44, instances: 2 },
  { name: "user-profile", region: "eu-west-1", status: "healthy", uptime: "99.99%", rps: 3100, latencyP50: 38, latencyP95: 104, errorRate: 0.04, cpu: 22, memory: 44, instances: 4 },
  { name: "notifications", region: "us-east-1", status: "healthy", uptime: "100.00%", rps: 8900, latencyP50: 19, latencyP95: 54, errorRate: 0.01, cpu: 18, memory: 38, instances: 6 },
  { name: "search-service", region: "us-west-2", status: "healthy", uptime: "99.94%", rps: 2700, latencyP50: 62, latencyP95: 180, errorRate: 0.08, cpu: 45, memory: 59, instances: 3 },
  { name: "media-service", region: "eu-west-1", status: "degraded", uptime: "99.61%", rps: 980, latencyP50: 210, latencyP95: 640, errorRate: 1.14, cpu: 67, memory: 73, instances: 2 },
  { name: "cache-layer", region: "us-east-1", status: "warning", uptime: "99.88%", rps: 48200, latencyP50: 2, latencyP95: 8, errorRate: 0.22, cpu: 55, memory: 91, instances: 6 },
]

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

// The metrics collector INFERS a low error rate from pod crash/ready state, which
// under-represents a real-world incident. Amplify the portion ABOVE the healthy
// baseline (~0.12%) by ~12x so incidents read realistically (e.g. 1.2% → ~13%)
// while healthy values stay realistically low (0.12% → 0.12%). Used by the stat
// tiles and the error/latency charts so they stay consistent.
export const ERROR_AMPLIFY = { knee: 0.6, factor: 12, cap: 40 }
// Healthy services report a small, jittery baseline error rate (~0.1–0.2% each).
// The old amplifier (base 0.12, factor 12) blew that baseline up — a service at
// 0.15% became ~0.5%, and summed across the monitored services the "Error Rate"
// chart spiked to >1% on every page remount, with nothing actually wrong.
// Now rates AT OR BELOW the knee pass through UNAMPLIFIED (healthy stays flat and
// low), and only genuinely elevated rates (a real incident) are amplified so they
// still read dramatically.
export function amplifyErrorRate(err: number): number {
  if (err <= ERROR_AMPLIFY.knee) return Math.max(0, err)
  return Math.min(ERROR_AMPLIFY.knee + (err - ERROR_AMPLIFY.knee) * ERROR_AMPLIFY.factor, ERROR_AMPLIFY.cap)
}

// Returns the services array with slightly randomized values on each call so the
// dashboard feels live. Constraints keep the narrative intact: payment-service
// stays critical and auth-service stays degraded.
export const getLiveServiceMetrics = () => {
  return services.map((svc) => {
    const jitter = (range: number) => (Math.random() * 2 - 1) * range

    let cpu = clamp(Math.round(svc.cpu + jitter(3)), 0, 100)
    const memory = clamp(Math.round(svc.memory + jitter(2)), 0, 100)
    const rps = Math.max(0, Math.round(svc.rps + jitter(50)))
    let errorRate = Math.max(0, Number((svc.errorRate + jitter(0.05)).toFixed(2)))

    if (svc.name === "payment-service") {
      if (errorRate <= 4.8) errorRate = Number((4.8 + Math.random() * 0.5).toFixed(2))
      if (cpu <= 88) cpu = clamp(Math.round(88 + Math.random() * 4), 0, 100)
    }

    if (svc.name === "auth-service") {
      if (errorRate <= 0.7) errorRate = Number((0.7 + Math.random() * 0.2).toFixed(2))
    }

    return { ...svc, cpu, memory, rps, errorRate }
  })
}

export const aiAnalysis = {
  incidentId: "INC-2847",
  signalCount: 4,
  signalLabel: "4 of 4 signals correlated",
  summary: "High-probability root cause identified in payment-service pod cluster",
  rootCause:
    "payment-service's Postgres connection pool (max: 2 per pod) is being exhausted under sustained checkout load, causing pool.connect() to time out and /api/checkout to return 503s. This correlates directly with the 5xx spike starting at 09:14 UTC, triggered by a sustained load-generator run driving concurrent checkout traffic against a Postgres instance capped at max_connections=5.",
  evidence: [
    { type: "log", label: "Connection pool exhaustion", value: "pool.connect() timeout — 2/2 connections held, requests queuing", severity: "critical" },
    { type: "metric", label: "Checkout error rate", value: "62% avg — /health reporting poolCritical=true", severity: "critical" },
    { type: "log", label: "Circuit breaker", value: "OPEN after 10 consecutive failures on payment-service", severity: "high" },
    { type: "trace", label: "DB query timeout", value: "48% of /checkout traces > 1s (connectionTimeoutMillis=1000)", severity: "high" },
    { type: "deploy", label: "No recent deploys", value: "Last deploy: 6h ago (stable)", severity: "info" },
  ],
  recommendations: [
    "Scale payment-service to 6 replicas and stop the load-generator Job — restores healthy connection headroom immediately",
    "Once stable, consider fronting Postgres with PgBouncer or raising the per-pod pool size to tolerate future load spikes without manual scaling",
    "Lower the circuit breaker's failure threshold on /api/checkout to shed load earlier, before pool exhaustion cascades",
    "Review Postgres max_connections=5 headroom against payment-service's replica count before the next load test",
  ],
  similarIncidents: [
    { id: "INC-2801", date: "Apr 18", similarity: 87 },
    { id: "INC-2754", date: "Mar 29", similarity: 72 },
  ],
}

export const incidentDetails: Record<string, {
  id: string
  title: string
  severity: string
  service: string
  started: string
  status: string
  affectedUsers: number
  description: string
  timeline: { time: string; event: string; type: "info" | "warning" | "error" | "success" }[]
  relatedLogs: { timestamp: string; level: string; message: string }[]
}> = {
  "INC-2847": {
    id: "INC-2847",
    title: "Elevated 5xx errors on /api/checkout",
    severity: "critical",
    service: "payment-service",
    started: "14 min ago",
    status: "investigating",
    affectedUsers: 1842,
    description:
      "Sudden spike in 5xx errors on the /api/checkout endpoint. Error rate jumped from baseline 0.12% to 5.21%. Root cause suspected to be payment-service's Postgres connection pool (max: 2 per pod) being exhausted under sustained checkout load.",
    timeline: [
      { time: "09:00 UTC", event: "Load-generator Job started — checkout traffic surges", type: "info" },
      { time: "09:12 UTC", event: "Connection pool utilization crosses 90% threshold", type: "warning" },
      { time: "09:14 UTC", event: "First 5xx errors detected on /api/checkout", type: "error" },
      { time: "09:15 UTC", event: "Alert triggered — INC-2847 created automatically", type: "info" },
      { time: "09:16 UTC", event: "On-call engineer sarah.kim acknowledged", type: "info" },
      { time: "09:18 UTC", event: "/health reporting poolCritical=true across all 3 pods", type: "error" },
      { time: "09:22 UTC", event: "AI analysis initiated — root cause identified with 94% confidence", type: "success" },
    ],
    relatedLogs: [
      { timestamp: "09:14:22.341Z", level: "ERROR", message: "Connection pool exhausted: pool.connect() timeout after 1000ms (2/2 connections held)" },
      { timestamp: "09:14:22.892Z", level: "ERROR", message: "FATAL: too many connections for role \"payment_svc\"" },
      { timestamp: "09:14:23.102Z", level: "WARN", message: "/health reporting poolCritical=true (errorRate 54%, pod 1 of 3)" },
      { timestamp: "09:14:24.556Z", level: "ERROR", message: "POST /api/checkout — 503 Service Unavailable (Connection pool exhausted)" },
      { timestamp: "09:14:25.001Z", level: "ERROR", message: "Circuit breaker OPEN for payment-service after 10 consecutive failures" },
    ],
  },
  "INC-2846": {
    id: "INC-2846",
    title: "P95 latency spike in auth-service",
    severity: "high",
    service: "auth-service",
    started: "31 min ago",
    status: "mitigating",
    affectedUsers: 312,
    description:
      "P95 latency for auth-service has spiked to 892ms (normal: ~120ms). The issue correlates with a token refresh race condition that was patched in v2.8.1, currently being deployed.",
    timeline: [
      { time: "08:47 UTC", event: "P95 latency crosses 500ms SLO threshold", type: "warning" },
      { time: "08:49 UTC", event: "Alert triggered — INC-2846 created", type: "info" },
      { time: "08:52 UTC", event: "Token refresh endpoint identified as bottleneck", type: "info" },
      { time: "08:58 UTC", event: "Hotfix v2.8.1 merged — deployment initiated", type: "success" },
      { time: "09:05 UTC", event: "Deployment in progress — 2 of 4 pods updated", type: "info" },
    ],
    relatedLogs: [
      { timestamp: "08:47:11.223Z", level: "WARN", message: "P95 latency 524ms exceeds SLO 500ms for auth-service" },
      { timestamp: "08:48:02.441Z", level: "ERROR", message: "Token refresh deadlock detected — request held for 1.2s" },
      { timestamp: "08:48:33.109Z", level: "WARN", message: "Connection pool saturation at 87% for auth-db-replica-2" },
    ],
  },
  "INC-2845": {
    id: "INC-2845",
    title: "Redis cache miss rate above threshold",
    severity: "medium",
    service: "cache-layer",
    started: "1h 12m ago",
    status: "monitoring",
    affectedUsers: 0,
    description:
      "Redis cache miss rate has increased to 22% (threshold: 15%). No user-facing impact detected yet, but continued degradation could affect downstream latencies.",
    timeline: [
      { time: "08:06 UTC", event: "Cache miss rate crosses 15% threshold", type: "warning" },
      { time: "08:08 UTC", event: "Alert triggered — INC-2845 created", type: "info" },
      { time: "08:15 UTC", event: "Investigation started — possible key eviction issue", type: "info" },
      { time: "08:30 UTC", event: "Memory pressure identified — maxmemory-policy reviewed", type: "info" },
      { time: "08:45 UTC", event: "Monitoring — miss rate stabilized at 18%", type: "success" },
    ],
    relatedLogs: [
      { timestamp: "08:06:44.112Z", level: "WARN", message: "Cache miss rate 15.2% exceeds threshold (15%)" },
      { timestamp: "08:07:01.334Z", level: "INFO", message: "Redis eviction count: 1,247 keys in last 5min" },
      { timestamp: "08:12:22.556Z", level: "WARN", message: "Cache miss rate at 22% — downstream latency unaffected" },
    ],
  },
}

export const mockLogs = [
  { timestamp: "2025-05-14T09:22:01.334Z", level: "INFO", service: "api-gateway", message: "Request processed: GET /api/v2/users — 200 OK (42ms)" },
  { timestamp: "2025-05-14T09:22:01.112Z", level: "INFO", service: "api-gateway", message: "Request processed: POST /api/v2/orders — 201 Created (128ms)" },
  { timestamp: "2025-05-14T09:22:00.891Z", level: "WARN", service: "auth-service", message: "Token refresh latency 524ms exceeds SLO (500ms)" },
  { timestamp: "2025-05-14T09:21:59.667Z", level: "ERROR", service: "payment-service", message: "POST /api/checkout — 503 Service Unavailable (upstream timeout after 3000ms)" },
  { timestamp: "2025-05-14T09:21:59.445Z", level: "ERROR", service: "payment-service", message: "Connection pool exhausted: pool.connect() timeout after 1000ms (2/2 connections held)" },
  { timestamp: "2025-05-14T09:21:58.223Z", level: "INFO", service: "notifications", message: "WebSocket broadcast: 847 clients notified for event order.completed" },
  { timestamp: "2025-05-14T09:21:57.001Z", level: "DEBUG", service: "search-service", message: "Elasticsearch query completed: index=products, hits=234, took=18ms" },
  { timestamp: "2025-05-14T09:21:56.778Z", level: "WARN", service: "cache-layer", message: "Redis eviction: 89 keys evicted in last 60s (allkeys-lru policy)" },
  { timestamp: "2025-05-14T09:21:55.556Z", level: "INFO", service: "user-profile", message: "Avatar upload processed: user_id=u-38291, size=2.4MB, bucket=s3://nova-avatars" },
  { timestamp: "2025-05-14T09:21:54.334Z", level: "ERROR", service: "payment-service", message: "FATAL: too many connections for role \"payment_svc\"" },
  { timestamp: "2025-05-14T09:21:53.112Z", level: "INFO", service: "api-gateway", message: "Rate limit applied: client_id=c-9281, 429 Too Many Requests (limit: 1000/min)" },
  { timestamp: "2025-05-14T09:21:52.891Z", level: "WARN", service: "media-service", message: "Image processing queue depth: 47 (threshold: 30), latency increasing" },
  { timestamp: "2025-05-14T09:21:51.667Z", level: "INFO", service: "api-gateway", message: "Health check: all upstream services responsive (8/8)" },
  { timestamp: "2025-05-14T09:21:50.445Z", level: "ERROR", service: "payment-service", message: "/health reporting poolCritical=true (errorRate 58%) — pod payment-service (1 of 3)" },
  { timestamp: "2025-05-14T09:21:49.223Z", level: "DEBUG", service: "auth-service", message: "JWT token validated: sub=u-18274, exp=1715684521, iss=nova-auth" },
  { timestamp: "2025-05-14T09:21:48.001Z", level: "INFO", service: "notifications", message: "Email queued: template=order_confirmation, to=user@example.com, queue_depth=12" },
  { timestamp: "2025-05-14T09:21:46.778Z", level: "WARN", service: "auth-service", message: "Token refresh deadlock detected — request held for 1.2s, releasing lock" },
  { timestamp: "2025-05-14T09:21:45.556Z", level: "INFO", service: "search-service", message: "Index refresh completed: products (234,891 docs, 1.2GB)" },
  { timestamp: "2025-05-14T09:21:44.334Z", level: "ERROR", service: "media-service", message: "Failed to process image: OOM killed — pod media-service-prod-2 restarting" },
  { timestamp: "2025-05-14T09:21:43.112Z", level: "INFO", service: "api-gateway", message: "TLS certificate renewal: *.novadeploy.io — expires in 47 days" },
  { timestamp: "2025-05-14T09:21:42.891Z", level: "DEBUG", service: "cache-layer", message: "Redis memory usage: 4.7GB / 6GB (78%), connected_clients: 284" },
  { timestamp: "2025-05-14T09:21:41.667Z", level: "INFO", service: "user-profile", message: "User session created: user_id=u-92847, region=eu-west-1, ttl=3600s" },
  { timestamp: "2025-05-14T09:21:40.445Z", level: "WARN", service: "payment-service", message: "Transaction retry #2 for order ord-8291: Serialization failure on checkout_lock" },
  { timestamp: "2025-05-14T09:21:39.223Z", level: "INFO", service: "api-gateway", message: "Deployment rollout: auth-service v2.8.1 — pod 2/4 updated, 50% traffic shifted" },
  { timestamp: "2025-05-14T09:21:38.001Z", level: "ERROR", service: "payment-service", message: "Circuit breaker OPEN for payment-service after 10 consecutive failures" },
]

// Resolve an incident's detail record. Dynamic run ids (INC-2848+) reuse the
// payment-service template with the id swapped in, so every incident \u2014 current
// or archived \u2014 has a full detail page.
export function getIncidentDetails(id: string) {
  return incidentDetails[id] ?? { ...incidentDetails["INC-2847"], id }
}
