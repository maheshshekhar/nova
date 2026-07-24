# Evaluation harness

Nova ships an **LLM-as-judge** evaluation harness so RCA quality is measurable, not vibes. It
combines deterministic checks (did the RCA name the right root cause? avoid hallucinating a
forbidden cause?) with a judge model that scores groundedness — and surfaces the results in the
product.

```yaml
eval:
  enabled: true
  judge:
    provider: anthropic         # should differ from the generator to avoid self-scoring
    apiKeyEnv: ANTHROPIC_API_KEY
  scoring:
    weights: { deterministic: 0.55, judge: 0.45 }
    passThreshold: 0.8
  gradeIncidents: true          # grade real incident RCAs, not just golden cases
```

## What it grades

- **Golden cases** — representative scenarios with known-good root causes and remediations.
- **Real incidents** — each generated RCA is graded against the exact logs it was written from,
  so the score reflects real evidence (not a fresh, mismatched re-pull).

## Why it matters

The harness is what lets Nova evolve prompts, models, and context providers **with confidence** —
a regression in RCA quality shows up as a dropping score, in-product and in CI.
