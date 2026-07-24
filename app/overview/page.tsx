"use client"

import { StatsBar } from "@/components/dashboard/stats-bar"
import { DeploymentCards } from "@/components/dashboard/deployment-cards"
import { IncidentAlerts } from "@/components/dashboard/incident-alerts"
import { ErrorRateChart, LatencyChart } from "@/components/dashboard/metrics-charts"
import { ServiceHealthTable } from "@/components/dashboard/service-health-table"
import { AiAnalysisPanel } from "@/components/dashboard/ai-analysis-panel"

export default function OverviewPage() {

  return (
    <main className="max-w-[1600px] mx-auto px-4 lg:px-6 py-6 flex flex-col gap-6">
      {/* Summary stats */}
      <StatsBar />

      {/* Incidents + Deployments */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <IncidentAlerts />
        <DeploymentCards />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ErrorRateChart />
        <LatencyChart />
      </div>

      {/* AI Root Cause Analysis */}
      <AiAnalysisPanel />

      {/* Service health */}
      <ServiceHealthTable />
    </main>
  )
}
