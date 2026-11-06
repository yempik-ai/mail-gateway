# Security model

This document describes how Yempik Mail Gateway limits what an AI agent can do with a mailbox. To
report a vulnerability, follow the policy in the repository's [SECURITY.md](../SECURITY.md).

## Threat model

The gateway holds delegated OAuth access to real mailboxes and exposes it to autonomous software.
The main risks and the controls against them are:

| Risk                                                                    | Control                                                                                                              |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| An agent sends arbitrary mail, or mail to recipients it was not given.  | Draft-first delivery. `send_draft` takes only a gateway draft id. See the next section.                              |
| An agent reads, moves, forwards or deletes received mail.               | Those operations are not implemented. Security tests scan the source for the provider calls that would perform them. |
| A retry or timeout sends the same message twice.                        | Atomic claim, persistent send state, and a ban on automatic retry after an ambiguous outcome.                        |
| A prompt-injected or runaway agent floods recipients.                   | Per-mailbox and per-identity daily send limits, per-run draft limits, client rate limiting and a global kill switch. |
| A database leak exposes mailbox access.                                 | Refresh tokens are stored as AES-256-GCM ciphertext. Keys live outside the database.                                 |
| A log or audit leak exposes secrets or message content.                 | Recursive log redaction. Audit metadata holds identifiers and timings only. Bodies are never stored.                 |
| A stolen MCP credential is used after discovery.                        | Client allowlist, revocation, per-environment assignment and the kill switch.                                        |
| An attacker connects their own account to a mailbox slot.               | The authenticated provider address must match the configured mailbox address, or the connection is rejected.         |
| A web page forges a request to the dashboard with the operator's login. | Same-origin check on state-changing admin requests, and a consent page before any MCP client gets a code.            |
| An unknown client registers itself and connects to the gateway.         | Registration is open but inert. Only the operator, after the admin password, can approve a client on `/authorize`.   |
| Someone guesses the admin password online.                              | Per-IP login throttling, a warning for passwords under 16 characters and constant-time comparison.                   |
| A browser renders the admin pages inside a frame or leaks their URLs.   | Strict CSP, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin` and `Cache-Control: no-store`.                   |

What the gateway does not protect against:

- A compromised provider account or a compromised host that holds the encryption keys.
- A stolen admin password. The dashboard has one shared password and no second factor.
- Content risk. The gateway does not judge what an agent writes in a draft. Limits bound the
  damage; they do not review the text.
- A user who disables the safeguards. Feature flags and limits are operator settings.

## Draft-first delivery invariant

The gateway can deliver mail, but only through `send_draft`, and only from a provider draft that is
already registered under an internal gateway id. The tool accepts no recipients, subject, body or
provider id. It cannot be used to send an arbitrary message or to send a received message.

The database claims the draft with a `created|updated → sending` transition. It consumes both the
mailbox aggregate quota and the quota for the selected primary or alias identity before any
provider call. Success sets the status to `sent`. A second call returns the same record and makes
no provider call.

A timeout or network failure after the provider call may hide a successful send. In that case the
record becomes `send_unknown` and automatic retry is forbidden. An operator or agent resolves the
state with `reconcile_draft_send`, which checks the Drafts and Sent folders. See
[ARCHITECTURE.md](ARCHITECTURE.md#draft-state-machine) for the state machine.

### Provider boundaries

- **Gmail.** The adapter uses `users.drafts.send` under the `gmail.compose` scope. The direct
  `users.messages.send` call is not implemented.
- **Microsoft.** The adapter verifies `isDraft=true`, then calls the existing-draft `/send` action.
  OAuth is delegated per mailbox and needs `Mail.ReadWrite` and `Mail.Send`. `/me/sendMail` is not
  implemented.
- **Zoho Mail.** Zoho documents no send action for an existing draft, and no scope separates
  drafting from sending. The adapter reads the gateway-owned draft, submits the same content to the
  send endpoint under `ZohoMail.messages.CREATE`, then removes the stale draft best-effort. A
  failed cleanup never triggers a resend. This guarantee is enforced in code, not by scope.

Received messages stay read-only. Forwarding, moving, archiving, deleting and direct reply-send
operations are absent, and `tests/security/forbidden-operations.test.ts` fails the build if the
source contains the provider calls for them. See
[ADR 0003](ADR/0003-autonomous-draft-delivery.md).

### Delivery scopes

An OAuth grant is frozen at the moment of consent. If the gateway later asks for more scopes,
existing connections keep their old grant. Before it claims quota, `send_draft` compares the stored
scopes with the scopes that delivery needs. A mailbox with a missing scope fails fast with
`AUTH_REQUIRED`, uses no quota and makes no provider call. `list_mailboxes` reports `canSend` and
`missingScopes` so that an operator sees the gap before an agent hits it.

## Authentication and access

The MCP endpoint accepts three credential forms:

- HTTP Basic with the MCP client id and secret.
- The legacy `x-mcp-client-id` and `x-mcp-client-secret` headers.
- An OAuth 2.0 Bearer token, issued through Authorization Code with PKCE (S256), for clients such
  as claude.ai and ChatGPT.

Client secrets are stored as salted scrypt hashes in `mcp_clients`. A client must be enabled,
allowlisted in both configuration and the database, assigned to the current environment and not
revoked. Every authentication decision is audited.

The `/mcp` route is rate limited per client network (`MCP_RATE_LIMIT_MAX` requests per
`MCP_RATE_LIMIT_WINDOW_MS`), with the same key as the admin login throttle: an IPv4 address, or the
/64 block of an IPv6 address. The limit runs before authentication, so it never reads a value the
client chooses, such as the `x-mcp-client-id` header. A client that changes that header still
spends the budget of its network.

MCP OAuth redirect URIs must be on an allowlist. Access tokens last 30 days, refresh tokens last
90 days and authorization codes last 10 minutes. The gateway stores only SHA-256 hashes of codes
and tokens.

### Connecting an MCP client

Dynamic client registration (`POST /register`) is open, rate limited and inert: a registered client
has no access until the operator approves it. The flow for claude.ai, ChatGPT and similar clients
is:

1. The client sends the browser to `GET /authorize`. The operator signs in with the admin password
   (HTTP Basic).
2. The gateway shows a consent page with the client name, the client id and the host the browser
   returns to. It issues nothing at this step. The client name is chosen by the client when it
   registers, so the page shows it as a claim next to the facts.
3. The operator presses **Approve** or **Deny**. The form posts to `POST /authorize`, which passes
   the same-origin check, validates the request again from scratch and then issues the code.
   **Deny** redirects to the client with `error=access_denied`.
4. The client exchanges the code at `POST /token` with its PKCE verifier.

A `GET` never mints a code, because a browser resends cached Basic credentials on cross-site
navigations and a page the operator visits could otherwise connect a client of its choosing.
Authorization codes and refresh tokens are single use. The gateway marks a grant as consumed in a
conditional update, so two concurrent exchanges of one code or token cannot both succeed. Using a
refresh token returns a new access and refresh token pair and retires the old one. Dynamically
registered clients are public clients: they use PKCE and have no usable secret.

### Kill switch

The kill switch is active when `GLOBAL_KILL_SWITCH=true` or when any `mcp_clients.global_kill_switch`
row is true. While it is active, all MCP traffic receives HTTP 503. Health endpoints stay available
for diagnosis. The kill switch overrides valid credentials.

`SEND_EMAILS=false` is a narrower stop. It removes the send and reconcile tools and leaves reading
and drafting available.

## Admin surface

The admin dashboard and the mailbox connect flow are protected by HTTP Basic. The username is
ignored and the password is `ADMIN_DASHBOARD_SECRET`, which the operator chooses. The application
boots with any non-empty value and compares it in constant time. A password shorter than 16
characters logs a warning at boot and shows a red banner on the dashboard. It does not stop the
server, so a weak password never takes a deployment down, but treat the warning as a defect to fix.

The dashboard is server-rendered and shows no secrets. It can:

- add and edit mailboxes, and enable or disable them;
- connect or reconnect a mailbox through OAuth;
- activate or deactivate the kill switch;
- edit, import and copy signatures;
- apply pending database migrations.

OAuth connect links carry an HMAC-signed `state` value (`OAUTH_STATE_SECRET`) that expires after
10 minutes. The callback checks that the authenticated provider address matches the mailbox
address and rejects any other account with `MAILBOX_MISMATCH`.

For Microsoft, every authorize and token request goes to the tenant resolved for that mailbox. The
gateway never uses `/common` or `/organizations`. See
[ADR 0001](ADR/0001-multitenant-entra-app-with-tenant-pinning.md).

### Same-origin check (CSRF)

Browsers resend cached Basic credentials to the origin on every request, including requests that a
page on another site triggers. The password alone therefore cannot tell the operator's click from a
forged form post. The gateway adds a same-origin check to every state-changing admin request, that
is every request other than `GET`, `HEAD` and `OPTIONS` on `/admin/...` and on `/authorize`:

1. If the browser sends `Sec-Fetch-Site`, it must be `same-origin` or `none`.
2. Otherwise `Origin` must equal the origin of `PUBLIC_BASE_URL`.
3. Otherwise the origin of `Referer` must equal it.
4. A request with none of the three headers is refused.

A refused request gets HTTP 403 before the password is checked, and the gateway logs a warning.
`PUBLIC_BASE_URL` must therefore be the origin that the operator really uses in the browser. A
mismatch makes the dashboard buttons answer 403.

### Response headers

| Header                    | Value                                                                                                        | Applies to                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| `Content-Security-Policy` | `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'` | HTML responses and the admin routes         |
| `X-Frame-Options`         | `DENY`                                                                                                       | HTML responses and the admin routes         |
| `Referrer-Policy`         | `same-origin`                                                                                                | HTML responses and the admin routes         |
| `X-Content-Type-Options`  | `nosniff`                                                                                                    | Every response                              |
| `Cache-Control`           | `no-store`                                                                                                   | Every response, unless a route sets its own |

The pages use inline styles and plain forms, so no script, image, font or frame is allowed. The
consent page adds one source to `form-action`: the origin of the redirect URI that the client
requested and that passed the allowlist (the scheme alone for a custom-scheme redirect), so that
the browser can follow the redirect to the client after the form post. The referrer policy is
`same-origin` and not `no-referrer` on purpose: browsers without `Sec-Fetch-Site` send
`Origin: null` from a `no-referrer` page, which the same-origin check must refuse.

### Admin login throttling

The gateway counts wrong admin passwords per client network. After 10 failures within 15 minutes
it answers HTTP 429 with a `Retry-After` header on `/admin`, the connect routes and `/authorize`,
even for the right password, until the window ends. A correct password resets the count. A request
with no credentials, such as the browser's first request that triggers the login prompt, does not
count as a failure.

- An IPv4 client is counted by its address. An IPv6 client is counted by its /64 block, the
  smallest block a provider gives one subscriber, so changing addresses inside it gives no new
  guesses. An IPv4-mapped address (`::ffff:192.0.2.1`) counts as the IPv4 client it maps.
- The throttle tracks at most 10,000 clients. When it is full, it drops expired entries first,
  then the oldest clients that are not blocked. A blocked client is never dropped, so flooding the
  table from new addresses does not lift a block.
- If every tracked client is blocked, a wrong password from a new client is not counted. It is
  still refused, and the server logs `admin authentication failed, not counted`. Refusing every new
  client instead would let the same flood lock the operator out.

### Deployment model

The reference deployment is Vercel with a Neon PostgreSQL database. Vercel terminates TLS, sets
`X-Forwarded-For` to the real client address and keeps secrets in project environment variables
(mark them **Sensitive**). Neon connections use TLS. The Vercel entry point trusts Vercel's edge
for the client address and ignores `TRUST_PROXY`.

To self-host with the Dockerfile or `node`, put a TLS terminating reverse proxy or load balancer in
front of the gateway, keep secrets in your platform's secret store or environment, and set
`TRUST_PROXY` to the proxy's IP addresses or CIDR ranges. Without it, every client appears to have
the proxy's address. With a value that is too wide, clients can choose their own address through
`X-Forwarded-For`. Either way the per-IP controls (login throttling and rate limits) stop working
as designed. A hop count is safe only when nothing can reach the gateway except through those hops.
The gateway serves plain HTTP and never terminates TLS itself.

When a request carries `X-Forwarded-For` while `TRUST_PROXY` is off, the gateway logs one warning
(once per process) and the dashboard shows the same warning as a banner. The header is never
trusted because of this: any client can send it, so it is only a hint that a proxy may be in
front of the gateway.

### Residual risks

- **Throttling is per instance.** The failure counters live in process memory. On Vercel they exist
  per warm function instance, and a restart clears them. An attacker whose requests reach several
  instances gets the budget once per instance. The control makes online guessing slow, it does not
  make a short password safe.
- **One shared admin password.** There are no per-user accounts, no second factor and no session
  logout. Anyone with the password can approve MCP clients, change mailbox settings and use the
  kill switch. Rotate it with [OPERATIONS.md](OPERATIONS.md#rotate-secrets).
- **A short password only warns.** The 16-character minimum is advisory by design.
- **Consent relies on the operator.** The client name on the consent page is self-declared.
  Approve only a client that you are connecting yourself at that moment.
- **Issued tokens last long.** An access token is valid for 30 days. Revoke a client in the
  database or switch on the kill switch to cut it off earlier.

## Token encryption

Refresh tokens are encrypted with AES-256-GCM. Each encryption uses a fresh 96-bit nonce. The
database stores ciphertext, authentication tag, nonce and key version.

`TOKEN_ENCRYPTION_KEYS` is a JSON map from version number to a base64 32-byte key.
`TOKEN_ENCRYPTION_CURRENT_VERSION` selects the key for new encryptions. Older versions stay
available for decryption. Keys must live in your secret store or platform environment, never in
source control or PostgreSQL. The sample key in `.env.example` is for local development only.

Key rotation is in [OPERATIONS.md](OPERATIONS.md#rotate-secrets).

## Privacy and logging

- The logger (pino, JSON on standard output, level set by `LOG_LEVEL`) censors any key whose name
  suggests a token, secret, password, credential, authorization, cookie, body, MIME, attachment or
  signature. It also applies explicit pino redaction paths to common request shapes. Per-request
  access logs are off, because URLs carry OAuth codes and mailbox ids.
- An unhandled error returns HTTP 500 with `{"code":"INTERNAL_ERROR","correlationId":"…"}` and no
  detail. An unknown route returns a JSON 404. The error type, message and stack stay in the
  server log, found by correlation id.
- Sentry is optional (`SENTRY_DSN`). An event carries the correlation id, the error type, the
  message and the stack trace. The SDK runs with its default integrations and automatic data
  collection off, and a filter removes request bodies, headers, cookies, query strings, user data
  and breadcrumbs before an event leaves the process. Message content and OAuth values are never
  attached. A self-hosted process sends events in the background, so a 500 never waits for Sentry.
  The Vercel entry waits for delivery (at most 2 seconds) before it answers, because the instance
  may freeze after the response.
- Audit metadata holds identifiers, outcomes and timings only.
- Email bodies and MIME content are never persisted. Search results never include bodies. Bodies
  are returned only by `get_email`, and are cut at 50,000 characters.
- Zoho draft content is fetched only while a send is in progress. It is not written to audit
  metadata or application logs.
- Do not paste tokens, secrets or message content into issues, tickets or logs.

## Feature flags

Capabilities are gated by environment flags. The defaults are safe for received mail.

| Flag                                                                                            | Default | Meaning                                    |
| ----------------------------------------------------------------------------------------------- | ------- | ------------------------------------------ |
| `READ_EMAILS`, `SEARCH_EMAILS`, `READ_THREADS`                                                  | `true`  | Reading and searching.                     |
| `CREATE_DRAFTS`, `CREATE_REPLY_DRAFTS`, `UPDATE_DRAFTS`, `DELETE_GATEWAY_DRAFTS`                | `true`  | Draft lifecycle.                           |
| `SEND_EMAILS`                                                                                   | `true`  | Exposes `send_draft` and reconcile.        |
| `DELETE_RECEIVED_MESSAGES`, `MOVE_MESSAGES`, `MODIFY_RECEIVED_MESSAGES`, `DOWNLOAD_ATTACHMENTS` | `false` | Must stay `false`. No code path uses them. |
