import { NextRequest } from "next/server"
import { buildSystemPrompt } from "@/lib/ai/prompts"

type ChatMessage = { role: "user" | "assistant"; content: string }

// Conversational "Ask the incident" endpoint. Streams a plain-text answer grounded
// in the incident context + recent logs supplied by the client.
export async function POST(req: NextRequest) {
  const { messages, context } = (await req.json()) as {
    messages: ChatMessage[]
    context: string
  }

  const openrouterKey = process.env.OPENROUTER_API_KEY
  const anthropicKey = process.env.ANTHROPIC_API_KEY

  if (!openrouterKey && !anthropicKey) {
    return new Response(JSON.stringify({ error: "No AI API key configured" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    })
  }

  const system = buildSystemPrompt(context || "")
  // Keep the last few turns to stay within a sensible context window.
  const history = (messages || []).filter((m) => m.content?.trim()).slice(-12)

  if (openrouterKey) return streamOpenRouterChat(system, history, openrouterKey)
  return streamAnthropicChat(system, history, anthropicKey!)
}

function textStream(
  upstream: Response,
  extractToken: (parsed: any) => string | undefined,
  isDone?: (data: string) => boolean,
  extraHeaders?: Record<string, string>
): Response {
  const stream = new ReadableStream({
    async start(controller) {
      const reader = upstream.body!.getReader()
      const decoder = new TextDecoder()
      const encoder = new TextEncoder()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          const chunk = decoder.decode(value, { stream: true })
          const lines = chunk.split("\n").filter((l) => l.startsWith("data: "))
          for (const line of lines) {
            const data = line.slice(6)
            if (isDone?.(data)) {
              controller.close()
              return
            }
            try {
              const token = extractToken(JSON.parse(data))
              if (token) controller.enqueue(encoder.encode(token))
            } catch {
              // skip malformed chunks
            }
          }
        }
        controller.close()
      } catch (err) {
        controller.error(err)
      }
    },
  })
  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache",
      ...extraHeaders,
    },
  })
}

async function streamOpenRouterChat(
  system: string,
  history: ChatMessage[],
  apiKey: string
): Promise<Response> {
  const model = process.env.OPENROUTER_MODEL || "anthropic/claude-sonnet-4-6"
  const upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "http://localhost:3000",
      "X-Title": "Nova",
    },
    body: JSON.stringify({
      model,
      max_tokens: 600,
      stream: true,
      messages: [{ role: "system", content: system }, ...history],
    }),
  })

  if (!upstream.ok) {
    const error = await upstream.text()
    return new Response(JSON.stringify({ error: `OpenRouter error: ${error}` }), { status: 500 })
  }

  return textStream(
    upstream,
    (parsed) => parsed.choices?.[0]?.delta?.content,
    (data) => data === "[DONE]",
    { "X-AI-Provider": "OpenRouter", "X-AI-Model": model }
  )
}

async function streamAnthropicChat(
  system: string,
  history: ChatMessage[],
  apiKey: string
): Promise<Response> {
  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5-20251001"
  const upstream = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 600,
      stream: true,
      system,
      messages: history.map((m) => ({ role: m.role, content: m.content })),
    }),
  })

  if (!upstream.ok) {
    const error = await upstream.text()
    return new Response(JSON.stringify({ error: `Anthropic error: ${error}` }), { status: 500 })
  }

  return textStream(
    upstream,
    (parsed) => (parsed.type === "content_block_delta" ? parsed.delta?.text : undefined),
    undefined,
    { "X-AI-Provider": "Anthropic", "X-AI-Model": model }
  )
}
