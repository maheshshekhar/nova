"use client"

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Badge } from "@/components/ui/badge"
import type { SettingsView } from "@/lib/settings/view"

// Read-only Settings panels. Renders the secret-free SettingsView as tabs; the
// data-fetching / server rendering lives in the page. Kept presentational so it
// is unit-testable with a fixture view.
export function SettingsPanels({ view }: { view: SettingsView }) {
  if (!view.tabs.length) {
    return <p className="text-sm text-muted-foreground">No configuration to display.</p>
  }
  return (
    <div className="space-y-4">
      <p className="text-xs font-mono text-muted-foreground">
        Read-only · managed by <span className="text-foreground">{view.source}</span>
      </p>
      <Tabs defaultValue={view.tabs[0].id}>
        <TabsList className="flex-wrap h-auto">
          {view.tabs.map((tab) => (
            <TabsTrigger key={tab.id} value={tab.id} className="text-xs">
              {tab.title}
            </TabsTrigger>
          ))}
        </TabsList>
        {view.tabs.map((tab) => (
          <TabsContent key={tab.id} value={tab.id}>
            <dl className="divide-y divide-border rounded-md border border-border">
              {tab.rows.map((row) => (
                <div key={row.key} className="flex items-start justify-between gap-4 px-3 py-2">
                  <dt className="text-xs text-muted-foreground flex items-center gap-2">
                    {row.key}
                    {row.secret && (
                      <Badge variant="outline" className="text-[10px] uppercase">
                        env
                      </Badge>
                    )}
                  </dt>
                  <dd className="text-xs font-mono text-right break-all max-w-[60%]">{row.value}</dd>
                </div>
              ))}
            </dl>
          </TabsContent>
        ))}
      </Tabs>
    </div>
  )
}
