import type { SentinelAlert } from "./incident"

// Where the Sentinel sends the incidents it opens. The default sink POSTs the
// Alertmanager-shaped alerts to Nova's `/api/alerts` endpoint (reusing the
// existing idempotent incident-creation + notification pipeline). Injectable
// `fetch` for tests; the interface lets a test or an alternative transport swap in.

export interface IncidentSink {
  post(alerts: SentinelAlert[]): Promise<void>
}

export class HttpAlertSink implements IncidentSink {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async post(alerts: SentinelAlert[]): Promise<void> {
    if (alerts.length === 0) return
    const url = `${this.baseUrl.replace(/\/$/, "")}/api/alerts`
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ alerts }),
    })
    if (!res.ok) {
      throw new Error(`Sentinel alert post failed: ${res.status}`)
    }
  }
}
