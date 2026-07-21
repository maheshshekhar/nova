// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import { SettingsPanels } from "@/components/settings/settings-panels"
import type { SettingsView } from "@/lib/settings/view"

afterEach(cleanup)

const view: SettingsView = {
  editable: false,
  source: "defaults",
  tabs: [
    {
      id: "providers",
      title: "Providers",
      rows: [
        { key: "Logs provider", value: "loki" },
        { key: "AI API key", value: "OPENROUTER_API_KEY (unset)", secret: true },
      ],
    },
    {
      id: "eval",
      title: "Evaluation",
      rows: [{ key: "Pass threshold", value: "0.8" }],
    },
  ],
}

describe("SettingsPanels", () => {
  it("renders a tab per section and marks the config read-only", () => {
    render(<SettingsPanels view={view} />)
    expect(screen.getByText(/Read-only/)).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "Providers" })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "Evaluation" })).toBeInTheDocument()
  })

  it("shows the first tab's rows including a secret marked as env-managed", () => {
    render(<SettingsPanels view={view} />)
    expect(screen.getByText("loki")).toBeInTheDocument()
    expect(screen.getByText("OPENROUTER_API_KEY (unset)")).toBeInTheDocument()
    // The secret row carries an "env" badge.
    expect(screen.getByText("env")).toBeInTheDocument()
  })

  it("renders an empty-state when there are no tabs", () => {
    render(<SettingsPanels view={{ editable: false, source: "defaults", tabs: [] }} />)
    expect(screen.getByText(/No configuration to display/)).toBeInTheDocument()
  })
})
