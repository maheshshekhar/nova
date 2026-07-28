import { NextRequest, NextResponse } from "next/server"
import { complete } from "@/lib/ai/complete"
import {
  JUDGE_SYSTEM,
  buildJudgePrompt,
  parseJudgeVerdict,
  DENY,
  type JudgeInput,
} from "@/lib/sentinel/judge"

// AI judgment endpoint for Nova Sentinel's AMBIGUOUS soft-signal clusters.
//
// The standalone Sentinel worker posts a cluster's signals here (it never holds
// an AI key); this route — running inside the Nova app where the keys live —
// asks the model whether those signals indicate a real incident and returns a
// strict verdict. Precision-first: a missing key, a provider error, or an
// unparseable reply all degrade to DENY (hold, no incident).
export const dynamic = "force-dynamic"

function isJudgeInput(v: unknown): v is JudgeInput {
  if (!v || typeof v !== "object") return false
  const o = v as Record<string, unknown>
  return typeof o.service === "string" && typeof o.namespace === "string" && Array.isArray(o.signals)
}

export async function POST(req: NextRequest) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json(DENY, { status: 400 })
  }
  if (!isJudgeInput(body)) {
    return NextResponse.json(DENY, { status: 400 })
  }
  // Bound the input the model sees (defence against an oversized/abusive payload).
  const input: JudgeInput = {
    service: body.service,
    namespace: body.namespace,
    signals: body.signals.slice(0, 50),
  }
  if (input.signals.length === 0) {
    return NextResponse.json(DENY)
  }

  try {
    const { text } = await complete({
      system: JUDGE_SYSTEM,
      prompt: buildJudgePrompt(input),
      maxTokens: 200,
      temperature: 0,
    })
    return NextResponse.json(parseJudgeVerdict(text))
  } catch {
    // No AI key configured, or the provider failed → hold, never open.
    return NextResponse.json(DENY)
  }
}
