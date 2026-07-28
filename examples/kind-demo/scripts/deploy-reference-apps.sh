#!/bin/bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# deploy-reference-apps.sh
#
# Interactive deploy menu for workloads on an already-running cluster whose Nova
# monitoring platform is already up (see `cluster`, which deploys the platform).
# Nova is data-source agnostic and observes ALL namespaces, so every app below is
# just an alternative workload behind Nova's log/metric adapters.
#
#   1) OpenTelemetry Demo (Astronomy Shop)      → ns: otel-demo
#   2) Google Online Boutique                    → ns: online-boutique
#   3) Weaveworks Sock Shop                       → ns: sock-shop
#   4) Prometheus example app                     → ns: prometheus-example
#   5) Custom Payment System (bundled demo)       → ns: production + db-postgres
#   m) (re)deploy the Nova monitoring platform    — normally done by `cluster`
#
# This script never removes existing workloads.
# ─────────────────────────────────────────────────────────────────────────────

# ── Colors ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()     { echo -e "${CYAN}[DEPLOY]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC} $1"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $1"; }
error()   { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# Run from the project root so relative k8s/... and Dockerfile paths resolve.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$PROJECT_ROOT"

CLUSTER_NAME="nova-platform"
MON_NAMESPACE="nova-monitoring"

# ── Upstream sources ──────────────────────────────────────────────────────────
OTEL_HELM_REPO="https://open-telemetry.github.io/opentelemetry-helm-charts"
OTEL_HELM_CHART="open-telemetry/opentelemetry-demo"
BOUTIQUE_MANIFEST="https://raw.githubusercontent.com/GoogleCloudPlatform/microservices-demo/main/release/kubernetes-manifests.yaml"
SOCKSHOP_MANIFEST="https://raw.githubusercontent.com/microservices-demo/microservices-demo/master/deploy/kubernetes/complete-demo.yaml"

# ── Prerequisites ─────────────────────────────────────────────────────────────
command -v kubectl >/dev/null 2>&1 || error "kubectl not found. Run: brew install kubectl"
if ! kubectl cluster-info >/dev/null 2>&1; then
  error "No reachable cluster. Run ./examples/kind-demo/scripts/cluster first."
fi
CURRENT_CTX="$(kubectl config current-context 2>/dev/null || echo 'unknown')"

# Warn (don't block) if the platform isn't up yet — the dashboard is what makes
# the deployed workloads observable.
if ! kubectl get deployment dashboard -n "$MON_NAMESPACE" >/dev/null 2>&1; then
  warn "Nova monitoring platform not found in '${MON_NAMESPACE}'."
  warn "It's normally deployed by ./examples/kind-demo/scripts/cluster."
  warn "Deploy it now with the 'm' option below, or run ./examples/kind-demo/scripts/platform."
fi

echo ""
echo -e "${CYAN}╔══════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║   Nova — Deploy Workloads                     ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════════╝${NC}"
echo ""
echo -e "Target context: ${GREEN}${CURRENT_CTX}${NC}"
echo ""
echo "Which workloads do you want to deploy?"
echo ""
echo -e "  ${GREEN}1${NC}) OpenTelemetry Demo (Astronomy Shop)  — ~15 services, built-in fault flags"
echo -e "  ${GREEN}2${NC}) Google Online Boutique               — 11 gRPC microservices"
echo -e "  ${GREEN}3${NC}) Weaveworks Sock Shop                  — classic microservices reference"
echo -e "  ${GREEN}4${NC}) Prometheus example app               — minimal /metrics endpoint"
echo -e "  ${GREEN}5${NC}) Custom Payment System                — postgres + payment/config/transaction"
echo -e "  ${GREEN}a${NC}) All workloads (1-5)"
echo -e "  ${GREEN}m${NC}) (re)deploy the Nova monitoring platform"
echo -e "  ${GREEN}q${NC}) Quit"
echo ""
read -rp "Enter choice(s), space-separated (e.g. '1 5'): " -a CHOICES

if [ "${#CHOICES[@]}" -eq 0 ]; then
  warn "No selection made — nothing to do."
  exit 0
fi

# Expand + validate. 'a'/'all' → every workload (1-5); 'm' → platform; 'q' quits.
WANT_PLATFORM=false
SELECTED=()
for c in "${CHOICES[@]}"; do
  case "$c" in
    m|M) WANT_PLATFORM=true ;;
    a|A|all) SELECTED=(1 2 3 4 5) ;;
    q|Q|quit) echo "Aborted."; exit 0 ;;
    1|2|3|4|5) SELECTED+=("$c") ;;
    *) warn "Ignoring invalid choice: '$c'" ;;
  esac
done

if [ "$WANT_PLATFORM" = false ] && [ "${#SELECTED[@]}" -eq 0 ]; then
  error "No valid choices selected."
fi

# Deduplicate the numbered selections while preserving order.
UNIQUE=()
for s in "${SELECTED[@]:-}"; do
  [ -z "$s" ] && continue
  skip=""
  for u in "${UNIQUE[@]:-}"; do [ "$u" = "$s" ] && skip="yes" && break; done
  [ -z "$skip" ] && UNIQUE+=("$s")
done

# ── Shared helpers ────────────────────────────────────────────────────────────
ensure_ns() {
  local ns="$1"
  kubectl get namespace "$ns" >/dev/null 2>&1 || kubectl create namespace "$ns"
}

# ── Nova monitoring platform (single source of truth: ./platform) ─────────────
# Normally deployed by `cluster`; re-runnable here to repair/redeploy.
deploy_platform() {
  bash "${SCRIPT_DIR}/platform"
}

# ── Custom Payment System (self-contained demo workload) ──────────────────────
# Brings its OWN observability stack (Loki, Fluent Bit, Prometheus, Grafana)
# into the payment-monitoring namespace, then points Nova at it. Nova ships
# nothing itself — it just plugs into this demo's backends (metrics come from
# Nova's in-process k8s reader / Prometheus, not an external collector).
deploy_custom_payment() {
  command -v helm >/dev/null 2>&1 || error "helm not found (required for this demo's stack). Run: brew install helm"
  local ns="payment-monitoring"
  local K8S="examples/kind-demo/k8s"
  log "Deploying Custom Payment System (self-contained stack in '${ns}')..."

  # App images are pulled from Docker Hub (built + pushed from the payment-app-demo
  # repo). Nothing to build/load here.

  # metrics-server (cluster singleton) — pod CPU/memory for Nova's native reader.
  log "Installing metrics-server..."
  kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
  kubectl patch deployment metrics-server -n kube-system --type=json \
    -p='[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]' \
    2>/dev/null || true

  ensure_ns "$ns"

  # This demo's own observability stack (Helm).
  log "Ensuring Helm repos..."
  helm repo add grafana https://grafana.github.io/helm-charts >/dev/null 2>&1 || true
  helm repo add prometheus-community https://prometheus-community.github.io/helm-charts >/dev/null 2>&1 || true
  helm repo add fluent https://fluent.github.io/helm-charts >/dev/null 2>&1 || true
  helm repo update >/dev/null 2>&1 || warn "helm repo update failed — using cached indexes"

  log "Deploying the demo's Loki..."
  helm upgrade --install loki grafana/loki --version 7.1.0 -n "$ns" \
    -f "$K8S/loki-values.yaml" --wait --timeout 5m || error "Loki Helm install failed"
  log "Deploying the demo's Fluent Bit..."
  helm upgrade --install fluent-bit fluent/fluent-bit --version 0.57.9 -n "$ns" \
    -f "$K8S/fluent-bit-values.yaml" --wait --timeout 3m || error "Fluent Bit Helm install failed"
  log "Deploying the demo's Prometheus + Grafana..."
  helm upgrade --install my-prometheus prometheus-community/kube-prometheus-stack --version 87.19.0 -n "$ns" \
    -f "$K8S/prometheus-values.yaml" --wait --timeout 8m || error "kube-prometheus-stack Helm install failed"

  # The Operator creates the Prometheus/Alertmanager StatefulSets after helm
  # returns; wait for them before wiring the Alertmanager alias.
  for sts in \
    alertmanager-my-prometheus-kube-prometh-alertmanager \
    prometheus-my-prometheus-kube-prometh-prometheus; do
    for i in $(seq 1 30); do
      kubectl get statefulset "$sts" -n "$ns" >/dev/null 2>&1 && break
      sleep 2
    done
    kubectl rollout status statefulset/"$sts" -n "$ns" --timeout=180s || warn "$sts not fully ready yet"
  done
  kubectl apply -f "$K8S/alertmanager-alias.yaml"

  # App services + loki-rules + dashboard production RBAC.
  kubectl apply -f examples/custom-payment-system.yaml

  # Nudge Loki to pick up the loki-rules ConfigMap (mounted optionally).
  kubectl -n "$ns" rollout restart statefulset/loki >/dev/null 2>&1 || true

  # Point Nova at THIS demo's logs and roll the dashboard. (Metrics come from
  # Nova's in-process k8s reader — cluster-wide, so no per-namespace wiring.)
  log "Pointing Nova at the ${ns} backends..."
  kubectl set env deployment/dashboard -n "$MON_NAMESPACE" \
    LOKI_URL="http://loki.${ns}:3100" >/dev/null
  kubectl rollout status deployment/dashboard -n "$MON_NAMESPACE" --timeout=120s || warn "dashboard restart pending"

  success "Custom Payment System deployed (healthy) with its own stack."
  echo "        Nova now reads logs + metrics from the ${ns} namespace."
  echo "        Trigger the failure cascade with: ./examples/kind-demo/scripts/inject-failure"
}

# ── Reference workloads ───────────────────────────────────────────────────────
deploy_otel() {
  local ns="otel-demo"
  command -v helm >/dev/null 2>&1 || error "helm not found (required for the OTel demo). Run: brew install helm"
  log "Deploying OpenTelemetry Demo → namespace '${ns}'..."
  ensure_ns "$ns"
  helm repo add open-telemetry "$OTEL_HELM_REPO" >/dev/null 2>&1 || true
  helm repo update open-telemetry >/dev/null 2>&1 || warn "helm repo update failed — using cached index"
  # The OTel demo brings its OWN stack (Prometheus, Grafana, Jaeger, OpenSearch);
  # Nova ships none, so let it run its full experience. Point Nova at the demo's
  # OpenSearch (logs) / Prometheus if you want Nova to observe it.
  #
  # k8s/otel-demo-values.yaml raises memory limits for product-catalog, checkout,
  # and the flagd-ui sidecar, which OOMKill (exit 137) under KinD with the chart's
  # tight defaults.
  helm upgrade --install otel-demo "$OTEL_HELM_CHART" -n "$ns" \
    -f "examples/kind-demo/k8s/otel-demo-values.yaml"
  success "OpenTelemetry Demo installed (with its own stack). Watch: kubectl get pods -n ${ns} -w"
}

deploy_boutique() {
  local ns="online-boutique"
  log "Deploying Google Online Boutique → namespace '${ns}'..."
  ensure_ns "$ns"
  kubectl apply -n "$ns" -f "$BOUTIQUE_MANIFEST"
  success "Online Boutique applied. Watch: kubectl get pods -n ${ns} -w"
}

deploy_sockshop() {
  local ns="sock-shop"
  log "Deploying Weaveworks Sock Shop → namespace '${ns}'..."
  ensure_ns "$ns"   # the manifest pins resources to this namespace
  kubectl apply -f "$SOCKSHOP_MANIFEST"
  success "Sock Shop applied. Watch: kubectl get pods -n ${ns} -w"
}

deploy_prometheus_example() {
  local ns="prometheus-example"
  log "Deploying Prometheus example app → namespace '${ns}'..."
  ensure_ns "$ns"
  kubectl apply -n "$ns" -f - <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: prometheus-example-app
  labels:
    app: prometheus-example-app
spec:
  replicas: 1
  selector:
    matchLabels:
      app: prometheus-example-app
  template:
    metadata:
      labels:
        app: prometheus-example-app
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "8080"
    spec:
      containers:
        - name: prometheus-example-app
          image: quay.io/brancz/prometheus-example-app:v0.5.0
          ports:
            - name: http
              containerPort: 8080
          resources:
            requests:
              cpu: 10m
              memory: 16Mi
            limits:
              cpu: 100m
              memory: 64Mi
---
apiVersion: v1
kind: Service
metadata:
  name: prometheus-example-app
  labels:
    app: prometheus-example-app
spec:
  selector:
    app: prometheus-example-app
  ports:
    - name: http
      port: 8080
      targetPort: http
EOF
  success "Prometheus example app applied. Metrics at :8080/metrics"
}

# ── Run selected deployments ──────────────────────────────────────────────────
echo ""
if [ "$WANT_PLATFORM" = true ]; then
  deploy_platform
  echo ""
fi

for choice in "${UNIQUE[@]:-}"; do
  [ -z "$choice" ] && continue
  case "$choice" in
    1) deploy_otel ;;
    2) deploy_boutique ;;
    3) deploy_sockshop ;;
    4) deploy_prometheus_example ;;
    5) deploy_custom_payment ;;
  esac
  echo ""
done

echo -e "${GREEN}╔══════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║   Done                                        ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════╝${NC}"
echo ""
echo "Tip: images pull/build on first run — give pods a few minutes."
echo "     Check status with:  kubectl get pods -A"
