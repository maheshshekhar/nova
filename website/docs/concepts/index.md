# Concepts

Nova is built on a few deliberate ideas. Understand these and the rest of the product follows.

<div class="grid cards" markdown>

- :material-sitemap: [__Architecture__](architecture.md) — ports & adapters, one config, one dashboard
- :material-power-plug: [__Adapters & registry__](adapters.md) — how a `provider` string becomes a backend
- :material-robot: [__AI pipeline__](ai-pipeline.md) — deterministic, grounded, testable
- :material-domain: [__Domain packs__](domain-packs.md) — ground the AI in your world
- :material-alert: [__Incident lifecycle__](incidents.md) — detect → analyze → resolve

</div>

## The principles

- **Source-driven.** Every value comes from a real source (metrics, logs, the incident store)
  or shows an honest empty/loading state. Nothing is faked or scripted.
- **Config-driven & domain-agnostic.** Behaviour is declared in `nova.config.yaml` and Domain
  Packs — Nova ships zero hardcoded service names, queries, or thresholds.
- **Deterministic by default.** The AI gets a curated context and a single call. Predictable
  cost, reproducible output, and unit-testable — with an opt-in "deep investigate" mode planned.
- **Ports & adapters.** Every external system (logs, metrics, persistence, AI, notifications) is
  a port with swappable adapters, selected by a `provider` string.
