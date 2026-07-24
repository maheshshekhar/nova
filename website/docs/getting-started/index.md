# Getting started

Nova is a stateless Next.js server. It needs three things:

1. A **config** (`nova.config.yaml`) pointing at your log/metrics backends.
2. **Secrets** in the environment (an AI key + any backend credentials).
3. **Persistence** — a volume for the file store (or a database adapter).

<div class="grid cards" markdown>

- :material-kubernetes: [__Quickstart (KinD demo)__](quickstart.md) — the fastest way to see the whole loop, locally.
- :material-cog: [__Configuration__](configuration.md) — the `nova.config.yaml` surface.

</div>

## Run it directly

```bash
# 1. install
npm ci

# 2. point Nova at your backends (copy + edit)
cp nova.config.example.yaml nova.config.yaml

# 3. secrets stay in the environment (never in the file)
export OPENROUTER_API_KEY=sk-or-...

# 4. dev server
npm run dev        # http://localhost:3000
```

Every config section has a sensible default, so a partial `nova.config.yaml` is deep-filled —
you only set what differs from the defaults.

## Deploy with Helm

```bash
helm install nova deploy/helm/nova \
  --set image.tag=latest \
  --set-file novaConfig=./nova.config.yaml
```

The `prompts/` and `domains/` folders are baked into the image, so your prompt templates and
Domain Packs ship automatically.

!!! tip "No AI key?"
    The dashboard still runs — it just can't generate an RCA. Set `OPENROUTER_API_KEY`
    (or `ANTHROPIC_API_KEY`, Azure, Ollama, …) to enable AI triage / RCA / chat.
