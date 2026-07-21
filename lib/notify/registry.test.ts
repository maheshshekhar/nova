import { describe, expect, it } from "vitest"
import { buildChannels } from "@/lib/notify/registry"
import { NotificationsConfigSchema } from "@/lib/config/schema"

const cfg = (channels: unknown[]) => NotificationsConfigSchema.parse({ channels })

describe("buildChannels — resolves env secrets", () => {
  it("builds a channel when its env var is set", () => {
    const { channels, errors } = buildChannels(
      cfg([{ id: "slack", type: "slack", webhookUrlEnv: "SLACK_URL" }]),
      { SLACK_URL: "https://hooks.slack.test/x" }
    )
    expect(channels.map((c) => c.id)).toEqual(["slack"])
    expect(errors).toEqual([])
  })

  it("skips a channel with a captured error when its env var is unset", () => {
    const { channels, errors } = buildChannels(
      cfg([{ id: "pd", type: "pagerduty", routingKeyEnv: "PD_KEY" }]),
      {}
    )
    expect(channels).toEqual([])
    expect(errors).toHaveLength(1)
    expect(errors[0].id).toBe("pd")
    expect(errors[0].error).toContain("PD_KEY")
  })

  it("builds the healthy channels and reports errors for the misconfigured ones", () => {
    const { channels, errors } = buildChannels(
      cfg([
        { id: "wh", type: "webhook", urlEnv: "WH_URL" },
        { id: "slack", type: "slack", webhookUrlEnv: "MISSING" },
      ]),
      { WH_URL: "https://hooks.test/x" }
    )
    expect(channels.map((c) => c.id)).toEqual(["wh"])
    expect(errors.map((e) => e.id)).toEqual(["slack"])
  })

  it("builds an msteams channel from its webhook env var", () => {
    const { channels, errors } = buildChannels(
      cfg([{ id: "teams", type: "msteams", webhookUrlEnv: "TEAMS_URL" }]),
      { TEAMS_URL: "https://teams.test/x" }
    )
    expect(channels.map((c) => c.id)).toEqual(["teams"])
    expect(errors).toEqual([])
  })

  it("builds an email channel via the injected SMTP transport factory (no nodemailer)", () => {
    const seen: string[] = []
    const fakeFactory = (url: string) => {
      seen.push(url)
      return { async sendMail() {} }
    }
    const { channels, errors } = buildChannels(
      cfg([{ id: "mail", type: "email", urlEnv: "SMTP_URL", from: "nova@x", to: ["a@x"] }]),
      { SMTP_URL: "smtp://user:pass@host:587" },
      fetch,
      fakeFactory
    )
    expect(channels.map((c) => c.id)).toEqual(["mail"])
    expect(errors).toEqual([])
    expect(seen).toEqual(["smtp://user:pass@host:587"])
  })
})
