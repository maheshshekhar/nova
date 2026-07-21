import { NextRequest, NextResponse } from "next/server"
import * as k8s from "@kubernetes/client-node"

const kc = new k8s.KubeConfig()
if (process.env.KUBERNETES_SERVICE_HOST) {
  kc.loadFromCluster()
} else {
  kc.loadFromDefault()
}
const appsApi = kc.makeApiClient(k8s.AppsV1Api)

// Application workloads live in the production namespace.
const NAMESPACE = "production"

// Services the dashboard is allowed to remediate. The payment-service / Postgres
// cascade is intentionally excluded — that is a manual live run.
const ALLOWED = new Set(["config-service", "transaction-service"])

// Source-of-truth values the dashboard restores for config-service's required
// config. Each models a different config KIND so remediation can name exactly
// what it fixed (env var / Secret / ConfigMap key). Keep in sync with the
// REQUIRED_CONFIG map in config-service/index.js.
const CONFIG_RESTORE: Record<string, { value: string; kind: string }> = {
  FEATURE_FLAGS_URL: { value: "http://config-service/flags", kind: "environment variable" },
  CONFIG_SIGNING_KEY: { value: "sk_live_rotated_signing_key", kind: "Secret" },
  APP_SETTINGS_JSON: { value: '{"theme":"dark","locale":"en-US","maxBatch":50}', kind: "ConfigMap key" },
}

type Action = "restart" | "restore-config" | "scale"

// POST /api/remediate — perform a runbook's real cluster remediation.
// Body: { service: string, action: "restart" | "restore-config" | "scale", replicas?: number }
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  const service: string = body?.service
  const action: Action = body?.action
  const replicas: number | undefined = body?.replicas

  if (!service || !ALLOWED.has(service)) {
    return NextResponse.json(
      { success: false, error: `Remediation not permitted for service "${service}"` },
      { status: 400 }
    )
  }

  try {
    const read = await appsApi.readNamespacedDeployment(service, NAMESPACE)
    const dep = read.body

    if (!dep.spec) throw new Error("deployment has no spec")
    dep.spec.template.metadata = dep.spec.template.metadata || {}
    dep.spec.template.metadata.annotations = dep.spec.template.metadata.annotations || {}

    const container = dep.spec.template.spec?.containers?.[0]
    if (!container) throw new Error("deployment has no container")

    // Always clear any injected crash flags so the rolled pods start healthy
    // (this is what makes a plain "restart" recover a crash-injected service).
    if (container.env) {
      container.env = container.env.filter((e) => e.name !== "CRASH_ON_STARTUP")
    }

    let summary = "Rolling restart triggered"

    if (action === "restore-config") {
      // Restore the SPECIFIC missing value named by REQUIRED_CONFIG_KEY (an env
      // var, a Secret, or a ConfigMap key) from its source of truth, clear the
      // crash flag + marker, then roll the pods so they boot with valid config.
      const currentEnv = container.env || []
      const missingKey =
        currentEnv.find((e) => e.name === "REQUIRED_CONFIG_KEY")?.value || "FEATURE_FLAGS_URL"
      const restore =
        CONFIG_RESTORE[missingKey] || { value: "restored", kind: "configuration value" }
      const env = currentEnv.filter(
        (e) =>
          e.name !== "CRASH_ON_MISSING_CONFIG" &&
          e.name !== "REQUIRED_CONFIG_KEY" &&
          e.name !== missingKey
      )
      env.push({ name: missingKey, value: restore.value })
      container.env = env
      summary = `Restored missing ${restore.kind} ${missingKey} from source of truth, cleared the crash flag, and rolled the deployment`
    } else if (action === "scale") {
      dep.spec.replicas = typeof replicas === "number" ? replicas : 2
      summary = `Scaled ${service} to ${dep.spec.replicas} replicas`
    }

    // Always bump the restart annotation so a fresh rollout happens.
    dep.spec.template.metadata.annotations["kubectl.kubernetes.io/restartedAt"] =
      new Date().toISOString()

    await appsApi.replaceNamespacedDeployment(service, NAMESPACE, dep)

    return NextResponse.json({ success: true, service, action, message: summary })
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err?.body?.message || err?.message || "remediation failed" },
      { status: 500 }
    )
  }
}
