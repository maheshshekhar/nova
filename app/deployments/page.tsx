"use client"

import Link from "next/link"
import { ArrowLeft, Layers } from "lucide-react"
import { useLiveDeployments, DeploymentCard } from "@/components/dashboard/deployment-cards"

export default function DeploymentsPage() {
  const deployments = useLiveDeployments()

  return (
    <main className="max-w-[1600px] mx-auto px-4 lg:px-6 py-6 flex flex-col gap-6">
      <div className="flex items-center gap-3">
        <Link
          href="/overview"
          className="w-8 h-8 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
        </Link>
        <div className="flex items-center gap-2">
          <Layers className="w-4 h-4 text-[var(--neon-cyan)]" />
          <div>
            <h1 className="text-lg font-mono font-bold text-foreground tracking-wide">Deployments</h1>
            <p className="text-xs text-muted-foreground font-mono">
              {deployments.length} live deployment{deployments.length === 1 ? "" : "s"} across the cluster
            </p>
          </div>
        </div>
      </div>

      {deployments.length === 0 ? (
        <div className="card-glass rounded-lg px-5 py-10 text-center text-sm font-mono text-muted-foreground">
          No deployments reported by the metrics collector yet.
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {deployments.map((dep) => (
            <DeploymentCard key={`${dep.namespace}/${dep.name}`} dep={dep} />
          ))}
        </div>
      )}
    </main>
  )
}
