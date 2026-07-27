// Exporter preset library (declarative, versioned data).
//
// A preset maps a recognisable Prometheus exporter shape to the RED-metric PromQL
// Nova needs. Detection is just "do these metric names exist?" (see fingerprint.ts);
// a match yields ready-to-commit `metrics.queries` for the operator to review.
//
// These are TYPED declarative data (not runtime YAML) so they're compile-checked
// and unit-testable without a parser. `$SVC` in a query is expanded to the
// preset's `serviceLabel` (which the operator can override). Latency queries are
// normalised to milliseconds to match the descriptor units (lib/metrics/descriptors.ts).
//
// Detection is ADVISORY ONLY: a match is a suggestion the operator commits to
// nova.config.yaml — it never drives a live tile on its own. This is what makes a
// broad preset library safe (a wrong guess is a reviewable suggestion, not a lie).

// The RED signal keys a preset can generate. These are the subset of
// NUMERIC_METRIC_KEYS (lib/metrics/source.ts) that a request-metrics exporter
// provides; CPU/memory/pod-health come from the k8s collector, not from presets.
export type RedSignalKey = "errorRate" | "latencyP50" | "latencyP95" | "latencyP99" | "rps"

export interface ExporterPreset {
  /** Stable id, recorded as `metrics.preset` when pinned. */
  id: string
  /** Human title shown in the Signals panel. */
  title: string
  /** Bump when a preset's queries change, so pinned configs can be re-reviewed. */
  version: string
  /** Default Prometheus label that identifies a service for this exporter. */
  serviceLabel: string
  /**
   * Fingerprint: `all` names must all be present; `any` needs at least one.
   * Detection matches a preset when both conditions hold.
   */
  fingerprint: { all?: string[]; any?: string[] }
  /** metric key → PromQL template (`$SVC` = serviceLabel). Latency in ms. */
  queries: Partial<Record<RedSignalKey, string>>
  /** Operator-facing note (caveats, label assumptions). */
  notes?: string
}

// ── Tier 1/2 presets (request-metrics exporters) ─────────────────────────────
export const PRESETS: ExporterPreset[] = [
  {
    id: "otel-http",
    title: "OpenTelemetry (HTTP server semconv)",
    version: "1",
    serviceLabel: "job",
    fingerprint: {
      any: [
        "http_server_request_duration_seconds_bucket",
        "http_server_request_duration_seconds_count",
        "http_server_duration_milliseconds_bucket",
      ],
    },
    queries: {
      errorRate:
        'sum by ($SVC)(rate(http_server_request_duration_seconds_count{http_response_status_code=~"5.."}[5m])) / clamp_min(sum by ($SVC)(rate(http_server_request_duration_seconds_count[5m])), 1) * 100',
      rps: "sum by ($SVC)(rate(http_server_request_duration_seconds_count[5m]))",
      latencyP95:
        "histogram_quantile(0.95, sum by ($SVC, le)(rate(http_server_request_duration_seconds_bucket[5m]))) * 1000",
      latencyP99:
        "histogram_quantile(0.99, sum by ($SVC, le)(rate(http_server_request_duration_seconds_bucket[5m]))) * 1000",
    },
    notes:
      "OTel semantic conventions. Verify the service label (often `job` or `service_name`) and the status-code label.",
  },
  {
    id: "red-prom-client",
    title: "Generic RED (http_requests_total)",
    version: "1",
    serviceLabel: "service",
    fingerprint: {
      all: ["http_requests_total"],
      any: ["http_request_duration_seconds_bucket", "http_requests_total"],
    },
    queries: {
      errorRate:
        'sum by ($SVC)(rate(http_requests_total{code=~"5.."}[5m])) / clamp_min(sum by ($SVC)(rate(http_requests_total[5m])), 1) * 100',
      rps: "sum by ($SVC)(rate(http_requests_total[5m]))",
      latencyP95:
        "histogram_quantile(0.95, sum by ($SVC, le)(rate(http_request_duration_seconds_bucket[5m]))) * 1000",
      latencyP99:
        "histogram_quantile(0.99, sum by ($SVC, le)(rate(http_request_duration_seconds_bucket[5m]))) * 1000",
    },
    notes:
      "Prometheus client-library convention. The status label may be `code`, `status` or `status_code` — verify before committing.",
  },
  {
    id: "istio",
    title: "Istio service mesh",
    version: "1",
    serviceLabel: "destination_service_name",
    fingerprint: {
      all: ["istio_requests_total"],
      any: ["istio_request_duration_milliseconds_bucket"],
    },
    queries: {
      errorRate:
        'sum by ($SVC)(rate(istio_requests_total{response_code=~"5.."}[5m])) / clamp_min(sum by ($SVC)(rate(istio_requests_total[5m])), 1) * 100',
      rps: "sum by ($SVC)(rate(istio_requests_total[5m]))",
      latencyP95:
        "histogram_quantile(0.95, sum by ($SVC, le)(rate(istio_request_duration_milliseconds_bucket[5m])))",
      latencyP99:
        "histogram_quantile(0.99, sum by ($SVC, le)(rate(istio_request_duration_milliseconds_bucket[5m])))",
    },
    notes: "Istio telemetry v2. Latency is already in milliseconds.",
  },
  {
    id: "nginx-ingress",
    title: "NGINX Ingress Controller",
    version: "1",
    serviceLabel: "service",
    fingerprint: {
      all: ["nginx_ingress_controller_requests"],
      any: ["nginx_ingress_controller_request_duration_seconds_bucket"],
    },
    queries: {
      errorRate:
        'sum by ($SVC)(rate(nginx_ingress_controller_requests{status=~"5.."}[5m])) / clamp_min(sum by ($SVC)(rate(nginx_ingress_controller_requests[5m])), 1) * 100',
      rps: "sum by ($SVC)(rate(nginx_ingress_controller_requests[5m]))",
      latencyP95:
        "histogram_quantile(0.95, sum by ($SVC, le)(rate(nginx_ingress_controller_request_duration_seconds_bucket[5m]))) * 1000",
    },
    notes: "NGINX ingress exposes RED metrics per `service` even for uninstrumented apps.",
  },
]
