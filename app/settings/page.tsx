import { getConfig } from "@/lib/config/loader"
import { getDomain } from "@/lib/domain/loader"
import { buildSettingsView } from "@/lib/settings/view"
import { SettingsPanels } from "@/components/settings/settings-panels"

// Config is read at request time (files + env), so render dynamically.
export const dynamic = "force-dynamic"

export default function SettingsPage() {
  const view = buildSettingsView(getConfig(), getDomain(), process.env)

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <header className="mb-6">
        <h1 className="text-lg font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground">
          The resolved Nova configuration. Secrets stay in environment variables and are
          never shown here — only whether they are set.
        </p>
      </header>
      <SettingsPanels view={view} />
    </main>
  )
}
