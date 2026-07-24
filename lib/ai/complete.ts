import "server-only"

import { openRouterAttribution } from "@/lib/ai/openrouter"

// Non-streaming chat completion — used by the eval harness (both to generate the
// candidate output and to run the LLM-as-judge). Production UX paths stream; the
// harness just needs the final text, so this returns the full string.
//
// Prefers OpenRouter when OPENROUTER_API_KEY is set, otherwise Anthropic.

export interface CompleteOptions {
  prompt: string
  system?: string
  /** Explicit model override. Falls back to the provider default when omitted. */
  model?: string
  maxTokens?: number
  temperature?: number
}

export interface CompleteResult {
  text: string
  provider: "openrouter" | "anthropic"
  model: string
}

export async function complete(opts: CompleteOptions): Promise<CompleteResult> {
  const { prompt, system, maxTokens = 1200, temperature = 0 } = opts
  const openrouterKey = process.env.OPENROUTER_API_KEY
  const anthropicKey = process.env.ANTHROPIC_API_KEY

  if (openrouterKey) {
    const model = opts.model || process.env.OPENROUTER_MODEL || "anthropic/claude-sonnet-4-6"
    const messages = [
      ...(system ? [{ role: "system", content: system }] : []),
      { role: "user", content: prompt },
    ]
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openrouterKey}`,
        "Content-Type": "application/json",
        ...openRouterAttribution(),
      },
      body: JSON.stringify({ model, max_tokens: maxTokens, temperature, messages }),
    })
    if (!res.ok) throw new Error(`OpenRouter error: ${await res.text()}`)
    const data = await res.json()
    return { text: data.choices?.[0]?.message?.content ?? "", provider: "openrouter", model }
  }

  if (anthropicKey) {
    const model = opts.model || process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5-20251001"
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature,
        ...(system ? { system } : {}),
        messages: [{ role: "user", content: prompt }],
      }),
    })
    if (!res.ok) throw new Error(`Anthropic error: ${await res.text()}`)
    const data = await res.json()
    const text = Array.isArray(data.content)
      ? data.content.map((c: any) => c.text ?? "").join("")
      : ""
    return { text, provider: "anthropic", model }
  }

  throw new Error("No AI API key configured")
}
