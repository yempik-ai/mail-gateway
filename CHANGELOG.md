# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-06

First public release. The gateway has run in production at Yempik before this release.

### Email through MCP

- One MCP server over Streamable HTTP for Gmail, Microsoft 365 and Zoho Mail, with 16 tools for
  reading, searching, drafting, sending and reconciling.
- Authentication with HTTP Basic client credentials, or OAuth 2.0 Authorization Code with PKCE so
  that Claude and ChatGPT connectors can connect. The operator approves each client on a consent
  page. Authorization codes and refresh tokens are single use.
- Delegated OAuth per mailbox for Google, Microsoft (multi-tenant, with per-mailbox tenant pinning)
  and Zoho, with address verification. Refresh tokens are encrypted with AES-256-GCM under a
  versioned keyring that supports rotation.
- Cross-provider search, message and thread reads, with bodies loaded only on request and never
  stored.
- Reply correlation for outreach campaigns, with an explicit confidence level per match method.

### Safe delivery

- Draft-first delivery. `send_draft` accepts only a gateway draft id. An atomic claim, persistent
  send states and a ban on automatic retry after an ambiguous result prevent duplicate sends.
- `reconcile_draft_send` resolves an unknown send from the Sent and Drafts folders.
- Idempotent draft creation, stable prospect-to-mailbox assignment, and distributed or explicit
  routing across mailboxes.
- Daily draft and send limits per mailbox and per sending identity (primary address or alias), with
  per-run draft limits and a conservative warm-up default for new mailboxes.
- A 45-second time budget for batch operations. Entries that cannot finish in time come back with
  the retryable `BATCH_TIME_BUDGET_EXCEEDED` and an `errorMessage`.
- Received mail stays read-only: no forwarding, moving, archiving or deleting of messages the
  gateway did not create.

### Real emails

- Markdown draft bodies, rendered into a plain-text part and an email-safe HTML part. `textBody`
  and `htmlBody` remain available.
- Stored signatures per sending identity, imported from Gmail or entered in the dashboard, appended
  to every draft unless `includeSignature` is `false`. The signature's display name is set in the
  From header.
- Quoted replies: reply drafts quote the original message below the signature, and updating a
  reply keeps the quote. Outlook keeps the conversation that Microsoft Graph composes.

### Configuration and operations

- Mailbox registry from a JSON file (`MAILBOXES_FILE`, template `mailboxes.example.json`) read by
  `pnpm db:seed`, or mailbox management from the admin dashboard. The seed refuses changes that
  would break a connected mailbox and writes all or nothing.
- Admin dashboard: mailbox status and capacity, connect and reconnect, signatures, pending
  migrations, kill switch and recent audit events.
- Health endpoints `/health/live` and `/health/ready`, with the wiring of each provider adapter.
- Structured logs with secret and body redaction, correlation ids, a persistent audit trail and
  optional Sentry reporting with a strict data policy (`SENTRY_DSN`).
- `pnpm verify:deployment <url>` for post-deploy checks.
- Deployment on Vercel with Neon PostgreSQL, and a Dockerfile for self-hosting (`TRUST_PROXY` for
  deployments behind a proxy).

### Security

- Same-origin check (CSRF protection) on state-changing admin requests and on `POST /authorize`.
- Security headers: a strict `Content-Security-Policy`, `X-Frame-Options: DENY`,
  `Referrer-Policy: same-origin`, `X-Content-Type-Options: nosniff` and `Cache-Control: no-store`.
- Admin login throttling per client network (IPv6 by /64), a rate limit on `/mcp` keyed by client
  network, and a warning for an admin password shorter than 16 characters.
- Client allowlist and revocation, and a global kill switch.

### Development

- Continuous integration: typecheck and lint of sources and tests, build, a boot smoke test that
  reproduces Vercel's function loader, the whole test suite against PostgreSQL 16, and a format
  check.
- Contributing guide, security policy, code of conduct, issue and pull request templates, citation
  metadata and `llms.txt`.

[Unreleased]: https://github.com/yempik-ai/mail-gateway/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/yempik-ai/mail-gateway/releases/tag/v0.1.0
