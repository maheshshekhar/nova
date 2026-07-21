import "server-only"
import type { NotificationsConfig } from "@/lib/config/schema"
import type { NotificationChannel } from "./channel"
import { makeWebhookChannel } from "./adapters/webhook"
import { makeSlackChannel } from "./adapters/slack"
import { makePagerDutyChannel } from "./adapters/pagerduty"
import { makeMsTeamsChannel } from "./adapters/msteams"
import { makeEmailChannel, type EmailTransport } from "./adapters/email"

// Build the configured channels, resolving each channel's secret from its ENV VAR
// (the config stores only the var NAME). A channel whose env var is unset is
// skipped with a captured error — one misconfigured channel never breaks the rest.

export interface ChannelBuildError {
  id: string
  error: string
}
export interface BuildChannelsResult {
  channels: NotificationChannel[]
  errors: ChannelBuildError[]
}

// Build an SMTP transport from a connection URL. Injectable so tests never need a
// real mail server or nodemailer; the default lazily loads nodemailer so it is
// only required when an email channel is actually configured.
export type EmailTransportFactory = (smtpUrl: string) => EmailTransport

const nodemailerTransportFactory: EmailTransportFactory = (smtpUrl) => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const nodemailer = require("nodemailer") as typeof import("nodemailer")
  const transport = nodemailer.createTransport(smtpUrl)
  return { sendMail: (msg) => transport.sendMail(msg) }
}

export function buildChannels(
  cfg: NotificationsConfig,
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
  emailTransportFactory: EmailTransportFactory = nodemailerTransportFactory
): BuildChannelsResult {
  const channels: NotificationChannel[] = []
  const errors: ChannelBuildError[] = []

  for (const ch of cfg.channels) {
    try {
      switch (ch.type) {
        case "webhook": {
          const url = env[ch.urlEnv]
          if (!url) throw new Error(`env var ${ch.urlEnv} is not set`)
          channels.push(makeWebhookChannel(ch.id, url, fetchImpl))
          break
        }
        case "slack": {
          const url = env[ch.webhookUrlEnv]
          if (!url) throw new Error(`env var ${ch.webhookUrlEnv} is not set`)
          channels.push(makeSlackChannel(ch.id, url, fetchImpl))
          break
        }
        case "pagerduty": {
          const key = env[ch.routingKeyEnv]
          if (!key) throw new Error(`env var ${ch.routingKeyEnv} is not set`)
          channels.push(makePagerDutyChannel(ch.id, key, fetchImpl))
          break
        }
        case "msteams": {
          const url = env[ch.webhookUrlEnv]
          if (!url) throw new Error(`env var ${ch.webhookUrlEnv} is not set`)
          channels.push(makeMsTeamsChannel(ch.id, url, fetchImpl))
          break
        }
        case "email": {
          const smtpUrl = env[ch.urlEnv]
          if (!smtpUrl) throw new Error(`env var ${ch.urlEnv} is not set`)
          const transport = emailTransportFactory(smtpUrl)
          channels.push(makeEmailChannel(ch.id, transport, { from: ch.from, to: ch.to }))
          break
        }
      }
    } catch (err) {
      errors.push({ id: ch.id, error: (err as Error).message })
    }
  }

  return { channels, errors }
}
