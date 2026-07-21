# Contributing to Nova

Thanks for your interest in improving Nova! This project is a plug-and-play,
AI-augmented DevOps incident platform. The core carries **no** domain, backend, or
demo assumptions — everything is behind an interface + config.

## Getting started

```bash
npm ci
npm test          # vitest — unit, contract and component tests
npm run typecheck # tsc --noEmit
npm run build     # next build
```

The optional local Kubernetes demo lives entirely under `examples/kind-demo/`.

## Architecture at a glance

- **Ports & adapters.** Each plug point (logs, persistence, AI, metrics) is an
  interface resolved from config via an `AdapterRegistry`. Add a backend by
  implementing the interface and registering it — no core changes.
- **Config-driven.** `nova.config.yaml` (see `nova.config.example.yaml`) plus
  Domain Packs (`domains/*.yaml`) and prompt templates (`prompts/*.md`) drive
  behaviour. Secrets stay in env.
- **The core imports zero demo code.** Enforced by
  `test/architecture/no-demo-imports.test.ts`.

## Testing bar

A test must be able to fail for a real reason. We favour:

- **Contract tests** — one suite every adapter of an interface must pass
  (e.g. `lib/persistence/contract.ts`). A new adapter is not done until it is green.
- **Characterization tests** that lock existing behaviour before a refactor.
- **Fixtures over mocks** for data shapes; inject time and `fetch` (never hit the
  network or the wall clock in unit tests).

Please add a regression test with every bug fix, and keep
`typecheck → test → build` green (CI enforces this).

## Pull requests

- Keep changes focused and behaviour-preserving unless the PR is explicitly a
  behaviour change.
- Update `nova.config.example.yaml` and docs when you add configuration.
- Do not commit secrets; `k8s/secret.yaml` and `.env.local` are git-ignored.

## License

By contributing you agree that your contributions are licensed under the
project's [Apache 2.0 License](LICENSE).
