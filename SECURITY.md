# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities. Instead, report
them privately via GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository, or email the maintainers listed in the repository metadata.

We aim to acknowledge reports within 3 business days and to provide a remediation
timeline after triage.

## Handling of secrets and data

Nova is designed to reason over your logs and incidents without exfiltrating
credentials:

- **Secrets stay in environment variables.** API keys and connection URIs are read
  from env; they are never written to the config file and never shown in the
  Settings UI (only whether an env var is set).
- **Egress redaction.** Log text is scrubbed of high-confidence secrets and PII
  (API keys, tokens, JWTs, `key=value` credentials, emails) by
  `lib/security/redact.ts` before being sent to an LLM. Extend the rules there for
  your environment.
- **Remediation is gated.** Executable runbook actions require explicit approval and
  an operator/admin role, and every attempt is audit-logged
  (`lib/actions/executor.ts`).

## Supported versions

Security fixes target the `main` branch. Pin a released tag for production and
watch releases for advisories.
