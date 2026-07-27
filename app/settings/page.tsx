import { getConfig } from "@/lib/config/loader"
import { getDomain } from "@/lib/domain/loader"
import { buildSettingsView } from "@/lib/settings/view"
import { SettingsPanels } from "@/components/settings/settings-panels"
import { SignalsPanel } from "@/components/settings/signals-panel"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

// Config is read at request time (files + env), so render dynamically.
export const dynamic = "force-dynamic"

export default function SettingsPage() {
  const config = getConfig()
  const view = buildSettingsView(config, getDomain(), process.env)
  const pinnedKeys = Object.keys(config.metrics.queries ?? {})

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <header className="mb-6">
        <h1 className="text-lg font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground">
          The resolved Nova configuration. Secrets stay in environment variables and are
          never shown here — only whether they are set.
        </p>
      </header>

      <Tabs defaultValue="configuration">
        <TabsList>
          <TabsTrigger value="configuration">Configuration</TabsTrigger>
          <TabsTrigger value="signals">Signals</TabsTrigger>
        </TabsList>
        <TabsContent value="configuration" className="pt-4">
          <SettingsPanels view={view} />
        </TabsContent>
        <TabsContent value="signals" className="pt-4">
          <SignalsPanel pinnedKeys={pinnedKeys} provider={config.metrics.provider} />
        </TabsContent>
      </Tabs>
    </main>
  )
}
