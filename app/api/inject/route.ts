import { NextResponse } from "next/server"
import * as k8s from "@kubernetes/client-node"

const kc = new k8s.KubeConfig()

if (process.env.KUBERNETES_SERVICE_HOST) {
  kc.loadFromCluster()
} else {
  kc.loadFromDefault()
}

const batchApi = kc.makeApiClient(k8s.BatchV1Api)
const coreApi = kc.makeApiClient(k8s.CoreV1Api)

const NAMESPACE = "production"

export async function POST() {
  try {
    // Delete existing job and wait for it to be fully gone
    try {
      await batchApi.deleteNamespacedJob(
        "load-generator",
        NAMESPACE,
        undefined,
        undefined,
        undefined,
        undefined,
        "Foreground"
      )

      // Wait for job to be fully deleted
      let deleted = false
      for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 1000))
        try {
          await batchApi.readNamespacedJob("load-generator", NAMESPACE)
          // Still exists, keep waiting
        } catch {
          // Job is gone
          deleted = true
          break
        }
      }
    } catch {
      // Job didn't exist — that's fine
    }

    // Create fresh load generator job
    const job: k8s.V1Job = {
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: {
        name: "load-generator",
        namespace: NAMESPACE,
        labels: { app: "load-generator" }
      },
      spec: {
        ttlSecondsAfterFinished: 30,
        template: {
          metadata: {
            labels: { app: "load-generator" }
          },
          spec: {
            restartPolicy: "Never",
            containers: [{
              name: "k6",
              image: "nova/load-generator:latest",
              imagePullPolicy: "Never",
              env: [{
                name: "TARGET_URL",
                value: "http://payment-service/api/checkout"
              }]
            }]
          }
        }
      }
    }

    await batchApi.createNamespacedJob(NAMESPACE, job)

    return NextResponse.json({
      success: true,
      message: "Load generator started — payment-service will degrade in 20-30 seconds"
    })

  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err.message },
      { status: 500 }
    )
  }
}

export async function DELETE() {
  try {
    await batchApi.deleteNamespacedJob(
      "load-generator",
      NAMESPACE,
      undefined,
      undefined,
      undefined,
      undefined,
      "Foreground"
    ).catch(() => {})

    return NextResponse.json({ success: true, message: "Load generator stopped" })
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err.message },
      { status: 500 }
    )
  }
}
