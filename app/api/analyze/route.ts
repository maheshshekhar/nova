import { NextRequest } from "next/server"
import { buildPrompt, buildRcaPrompt } from "@/lib/ai/prompts"
import { fetchCollectorLogs } from "@/lib/logs/server-log-source"
import { selectIncidentLogs, countCheckoutFailures } from "@/lib/log-selection"
import { openRouterAttribution } from "@/lib/ai/openrouter"

export async function POST(req: NextRequest) {
  const { logs, context, mode, service, sinceMs, tz, impact } = await req.json()

  const openrouterKey = process.env.OPENROUTER_API_KEY
  const anthropicKey = process.env.ANTHROPIC_API_KEY

  if (!openrouterKey && !anthropicKey) {
    return new Response(
      JSON.stringify({ error: "No AI API key configured" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    )
  }

  // "rca" produces a full post-incident writeup; default is the concise triage RCA.
  const isRca = mode === "rca"

  // Server-side real-log augmentation: when a service is given, pull the REAL logs
  // the collector retained (survives pod restarts + browser reloads) and prefer
  // them over whatever the client sent. This is what keeps the RCA grounded in
  // real evidence regardless of timing. Falls back to the client logs when the
  // collector has nothing usable.
  let effectiveLogs: string[] = Array.isArray(logs) ? logs : []
  let effectiveContext: string = context ?? ""
  if (typeof service === "string" && service) {
    const real = await fetchCollectorLogs(service, typeof sinceMs === "number" ? sinceMs : undefined)
    const selected = selectIncidentLogs(real, {
      budget: isRca ? 12 : 8,
      tz: typeof tz === "string" ? tz : undefined,
    })
    if (selected.length) {
      effectiveLogs = selected
      // Customer-impact figure. Prefer the CANONICAL count the client passed
      // (single source of truth — identical to the overview / RCA). Only fall back
      // to a server-side recompute when the client didn't provide one, and bound
      // that recompute to the incident window (sinceMs) so it can't balloon to the
      // full log-retention window.
      const canonical = typeof impact === "number" && impact > 0 ? impact : 0
      const failures = canonical || countCheckoutFailures(real, {
        windowStart: typeof sinceMs === "number" ? sinceMs : undefined,
      })
      if (failures > 0) {
        effectiveContext +=
          `\n\nAUTHORITATIVE LIVE SIGNAL (overrides any earlier estimate): approximately ${failures.toLocaleString()} checkout transactions failed (HTTP 503) in the real cluster logs during the incident window — customers were unable to complete payment. These requests were rejected before payment processing, so no partial charges or double-payments occurred. Use this exact figure for customer impact, framed as "failed checkout transactions", and do NOT use any other user/customer count mentioned above or imply any payment was captured, lost, or double-charged.`
      }
    }
  }

  const prompt = isRca ? buildRcaPrompt(effectiveLogs, effectiveContext) : buildPrompt(effectiveLogs, effectiveContext)
  // Full RCA is a 9-section document (through Resolution / Action Items / Lessons
  // Learned); 1900 tokens truncated it mid-document, so give it ample headroom.
  const maxTokens = isRca ? 4000 : 400

  if (openrouterKey) {
    return streamOpenRouter(prompt, openrouterKey, maxTokens)
  } else {
    return streamAnthropic(prompt, anthropicKey!, maxTokens)
  }
}

async function streamOpenRouter(prompt: string, apiKey: string, maxTokens = 400): Promise<Response> {
  const upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...openRouterAttribution()
    },
    body: JSON.stringify({
      model: process.env.OPENROUTER_MODEL || "anthropic/claude-sonnet-4-6",
      max_tokens: maxTokens,
      stream: true,
      messages: [{ role: "user", content: prompt }]
    })
  })

  if (!upstream.ok) {
    const error = await upstream.text()
    return new Response(
      JSON.stringify({ error: `OpenRouter error: ${error}` }),
      { status: 500 }
    )
  }

  const stream = new ReadableStream({
    async start(controller) {
      const reader = upstream.body!.getReader()
      const decoder = new TextDecoder()
      const encoder = new TextEncoder()

      // Emit a provider marker as the final tokens so the client can identify
      // the provider (streaming response headers aren't easily read client-side).
      const finish = () => {
        controller.enqueue(encoder.encode("\n\n[PROVIDER:openrouter]"))
        controller.close()
      }

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          const chunk = decoder.decode(value, { stream: true })
          const lines = chunk.split("\n").filter(line => line.startsWith("data: "))

          for (const line of lines) {
            const data = line.slice(6)
            if (data === "[DONE]") {
              finish()
              return
            }
            try {
              const parsed = JSON.parse(data)
              const token = parsed.choices?.[0]?.delta?.content
              if (token) {
                controller.enqueue(encoder.encode(token))
              }
            } catch {
              // skip malformed chunks
            }
          }
        }
        finish()
      } catch (err) {
        controller.error(err)
      }
    }
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Provider": "openrouter",
      "Transfer-Encoding": "chunked",
      "Cache-Control": "no-cache"
    }
  })
}

async function streamAnthropic(prompt: string, apiKey: string, maxTokens = 400): Promise<Response> {
  const upstream = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5-20251001",
      max_tokens: maxTokens,
      stream: true,
      messages: [{ role: "user", content: prompt }]
    })
  })

  if (!upstream.ok) {
    const error = await upstream.text()
    return new Response(
      JSON.stringify({ error: `Anthropic error: ${error}` }),
      { status: 500 }
    )
  }

  const stream = new ReadableStream({
    async start(controller) {
      const reader = upstream.body!.getReader()
      const decoder = new TextDecoder()
      const encoder = new TextEncoder()

      // Emit a provider marker as the final tokens so the client can identify
      // the provider (streaming response headers aren't easily read client-side).
      const finish = () => {
        controller.enqueue(encoder.encode("\n\n[PROVIDER:anthropic]"))
        controller.close()
      }

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          const chunk = decoder.decode(value, { stream: true })
          const lines = chunk.split("\n").filter(line => line.startsWith("data: "))

          for (const line of lines) {
            const data = line.slice(6)
            try {
              const parsed = JSON.parse(data)
              if (parsed.type === "content_block_delta") {
                const token = parsed.delta?.text
                if (token) {
                  controller.enqueue(encoder.encode(token))
                }
              }
              if (parsed.type === "message_stop") {
                finish()
                return
              }
            } catch {
              // skip malformed chunks
            }
          }
        }
        finish()
      } catch (err) {
        controller.error(err)
      }
    }
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Provider": "anthropic",
      "Transfer-Encoding": "chunked",
      "Cache-Control": "no-cache"
    }
  })
}
