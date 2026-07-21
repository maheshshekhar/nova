// Realistic Loki `query_range` responses + raw log line samples used by the
// characterization tests. These encode the exact shapes queryLoki() parses today.

/** A known instant (ms epoch) → its nanosecond string as Loki returns it. */
export function msToLokiNs(ms: number): string {
  return String(ms * 1_000_000)
}

// Two events, deliberately provided newest-first (Loki `direction=backward`) so
// the test can assert queryLoki() re-sorts ascending by timestamp.
export const T_LATER_MS = 1_768_382_100_000 // 2026-01-14T...Z
export const T_EARLIER_MS = 1_768_382_040_000 // 60s earlier

// A JSON-wrapped line (Fluent Bit CRI shape) — extractMessage() must pull `message`.
export const jsonLine = JSON.stringify({
  message: "POST /api/checkout 503 Service Unavailable\n",
  stream: "stdout",
})

// A plain (non-JSON) line — extractMessage() returns it verbatim.
export const plainLine = "checkout completed for order 12"

// A very long line to prove the 400-char truncation.
export const longMessage = "x".repeat(600)

export const lokiQueryRangeResponse = {
  status: "success",
  data: {
    resultType: "streams",
    result: [
      {
        stream: { app: "payment-service", pod: "payment-service-7c", namespace: "production" },
        values: [
          // newest first
          [msToLokiNs(T_LATER_MS), jsonLine],
          [msToLokiNs(T_EARLIER_MS), plainLine],
        ] as [string, string][],
      },
    ],
  },
}

export const lokiLongLineResponse = {
  status: "success",
  data: {
    resultType: "streams",
    result: [
      {
        stream: { app: "payment-service", pod: "p1" },
        values: [[msToLokiNs(T_LATER_MS), longMessage]] as [string, string][],
      },
    ],
  },
}

export const lokiEmptyResponse = {
  status: "success",
  data: { resultType: "streams", result: [] as unknown[] },
}
