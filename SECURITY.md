# Security policy

## Supported versions

Security fixes go to the latest release and to `main`. Older versions do not receive patches.

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |
| < 0.1   | No        |

## Reporting a vulnerability

Do not open a public issue for a security problem.

Report it privately through GitHub Security Advisories:

1. Open the [Security tab](https://github.com/yempik-ai/mail-gateway/security) of the
   repository.
2. Choose **Report a vulnerability**.
3. Describe the problem, the affected version and the steps to reproduce it. Include the impact if
   you can.

Do not include real mailbox content, tokens or secrets in the report. If a report needs a
credential to reproduce, describe the setup instead.

## What to expect

| Step                                 | Target                 |
| ------------------------------------ | ---------------------- |
| Acknowledge your report              | Within 3 business days |
| First assessment and severity        | Within 7 days          |
| Fix or mitigation plan for high risk | Within 30 days         |
| Public advisory after a fix is out   | Coordinated with you   |

These are targets, not guarantees. We keep you informed if a date moves. We credit reporters in the
advisory unless you ask us not to.

## Scope

In scope:

- The code in this repository: the MCP server, the admin dashboard, the OAuth flows, the provider
  adapters and the database layer.
- Bypasses of the draft-first invariant, of send quotas, of idempotency or of the kill switch.
- Authentication and authorization flaws on `/mcp`, `/admin` and the OAuth routes.
- Leaks of tokens, secrets or message content through logs, audit events or responses.
- Weaknesses in token encryption or key handling.

Out of scope:

- Vulnerabilities in Gmail, Microsoft Graph, Zoho Mail, Vercel, Neon or other third-party services.
  Report those to the vendor.
- Findings that need a stolen administrator secret, a compromised host or a compromised mailbox
  account.
- A deployment's own configuration mistakes, such as a weak `ADMIN_DASHBOARD_SECRET`, a sample
  encryption key in production or a missing TLS terminator.
- Denial of service through volume alone, beyond the documented rate limits.
- Reports from automated scanners without a demonstrated impact.

For the design of the safeguards, see the [security model](docs/SECURITY.md).
