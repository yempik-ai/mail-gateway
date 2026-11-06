# Operations

This guide is for the person who deploys and runs a Yempik Mail Gateway instance. It uses
`https://mail.example.com` as the public base URL and `psql` for database queries. Replace the
domain and the mailbox ids with your own.

Admin pages need HTTP Basic. The username can be any value. The password is
`ADMIN_DASHBOARD_SECRET`, which you choose and store in your environment variables. The application
boots with any non-empty value, but a password shorter than 16 characters logs a warning at start
and shows a red banner at the top of the dashboard. Use a long random value. Do not paste secrets,
tokens or message content into tickets or logs.

The dashboard and the consent page reject form posts that do not come from the gateway's own
origin. Set `PUBLIC_BASE_URL` to exactly the origin you type in the browser (see
[Same-origin check](#same-origin-check)).

## Contents

- [Deploy on Vercel and Neon](#deploy-on-vercel-and-neon)
- [Verify a deployment](#verify-a-deployment)
- [Environment variables](#environment-variables)
- [Migrations](#migrations)
- [Register mailboxes](#register-mailboxes)
- [Connect or reconnect a mailbox](#connect-or-reconnect-a-mailbox)
- [Revoke a connection](#revoke-a-connection)
- [Disable or enable a mailbox](#disable-or-enable-a-mailbox)
- [Signatures](#signatures)
- [Raise or lower send limits](#raise-or-lower-send-limits)
- [Enable autonomous sending](#enable-autonomous-sending)
- [Check a draft or a send](#check-a-draft-or-a-send)
- [Reconcile SEND_STATUS_UNKNOWN](#reconcile-send_status_unknown)
- [Delete a stuck draft](#delete-a-stuck-draft)
- [Clean up legacy drafts](#clean-up-legacy-drafts)
- [Kill switch](#kill-switch)
- [Logs and error reports](#logs-and-error-reports)
- [Admin login lockout](#admin-login-lockout)
- [Same-origin check](#same-origin-check)
- [Rotate secrets](#rotate-secrets)
- [Rollback](#rollback)
- [Recover after an incident](#recover-after-an-incident)
- [Diagnose OAuth](#diagnose-oauth)
- [Read the audit log](#read-the-audit-log)
- [Local development](#local-development)
- [Self-hosting with Docker](#self-hosting-with-docker)

## Deploy on Vercel and Neon

The reference deployment is a Vercel project backed by a Neon PostgreSQL database.

1. Create a Neon project. Create one branch for production and one for development.
2. Import the repository into Vercel. `vercel.json` already sets the install and build commands,
   sends every path to `api/index.ts` and ships the `migrations` directory with the function
   (`maxDuration` is 60 seconds).
3. Add the environment variables below, separately for Production, Preview and Development. In
   production, use the **pooled** Neon connection string for `DATABASE_URL`. The function opens one
   connection per warm worker. Mark secrets as **Sensitive**.
4. Set `PUBLIC_BASE_URL` to the final public URL, without a trailing slash. It must be the origin
   that the operator types in the browser (scheme, host and port), because the admin forms are
   checked against it.
5. Deploy and [verify the deployment](#verify-a-deployment).
6. Apply the database schema (see [Migrations](#migrations)). Do this before you rely on `ready`.
7. [Register your mailboxes](#register-mailboxes) and [connect them](#connect-or-reconnect-a-mailbox).

A running deployment does not pick up changed environment variables. After any change, create a new
deployment.

For direct database access, use a **direct** (non-pooled) connection string with TLS:

```sh
psql "$DATABASE_URL"
```

## Verify a deployment

Run the post-deploy checks from a checkout of the repository (Node.js 22 is enough, no install is
needed for this script):

```sh
pnpm verify:deployment https://mail.example.com
```

The script sends no credentials and changes nothing, so it is safe against production. It runs five
checks and exits `0` when all pass, `1` when one fails and `2` on a usage error:

| Check                                | Passes when                                                                                                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health/live`                   | Status 200, body `status: "ok"`, `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.                                                             |
| `GET /health/ready`                  | Status 200 and `database: "ok"`. It prints which providers are wired (the `adapters` object).                                                                 |
| `GET /admin` without credentials     | Status 401 with a Basic challenge, `X-Frame-Options: DENY`, a CSP with `default-src 'none'` and `frame-ancestors 'none'`, and `Referrer-Policy: same-origin`. |
| Cross-site `POST /admin/kill-switch` | Status 403. The request is refused before authentication, so the probe cannot change the kill switch.                                                         |
| An unknown route                     | Status 404 with the JSON code `NOT_FOUND`.                                                                                                                    |

If the project uses Vercel deployment protection, export the project's automation bypass secret.
The script then sends it in the `x-vercel-protection-bypass` header:

```sh
export VERCEL_AUTOMATION_BYPASS_SECRET=...
pnpm verify:deployment https://my-preview.vercel.app
```

A `503` from `/health/ready` means the database is unreachable or the schema is missing. If the
`/admin` check fails on headers, a proxy in front of the gateway is probably rewriting them.

## Environment variables

`.env.example` lists every variable with a working local value. The configuration schema is in
`packages/core/src/config.ts`.

### Core

| Variable             | Required | Default                 | Purpose                                                                                          |
| -------------------- | -------- | ----------------------- | ------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`       | yes      | none                    | PostgreSQL connection string. Use TLS. Pooled in production, direct for migrations and seed.     |
| `PUBLIC_BASE_URL`    | no       | `http://localhost:3000` | Public base URL. Builds OAuth redirect URIs. Must be the origin the operator uses.               |
| `NODE_ENV`           | no       | `development`           | On Vercel it is derived from `VERCEL_ENV`.                                                       |
| `HOST`, `PORT`       | no       | `0.0.0.0`, `3000`       | Listen address for the standalone server.                                                        |
| `LOG_LEVEL`          | no       | `info`                  | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`.                                  |
| `TRUST_PROXY`        | no       | `false`                 | Self-hosting behind a proxy: `true`, a hop count, or proxy IPs and CIDRs. Ignored on Vercel.     |
| `SENTRY_DSN`         | no       | unset                   | Optional Sentry DSN for unhandled errors. See [Logs and error reports](#logs-and-error-reports). |
| `GATEWAY_TIME_ZONE`  | no       | `UTC`                   | IANA zone of the `On <date> <sender> wrote:` line in reply quotes. Validated at start.           |
| `GLOBAL_KILL_SWITCH` | no       | `false`                 | `true` blocks all MCP traffic with HTTP 503.                                                     |

### MCP clients

| Variable                       | Required | Default         | Purpose                                                                                   |
| ------------------------------ | -------- | --------------- | ----------------------------------------------------------------------------------------- |
| `MCP_CLIENT_ID`                | yes      | none            | Id of the bootstrap MCP client.                                                           |
| `MCP_CLIENT_SECRET`            | yes      | none            | Secret of the bootstrap client. At least 16 characters.                                   |
| `MCP_CLIENT_ALLOWLIST`         | yes      | none            | Comma-separated client ids allowed to connect.                                            |
| `MCP_RATE_LIMIT_MAX`           | no       | `100`           | Requests to `/mcp` per window per client network (IPv4 address or IPv6 /64).              |
| `MCP_RATE_LIMIT_WINDOW_MS`     | no       | `60000`         | Rate-limit window in milliseconds.                                                        |
| `MCP_OAUTH_REDIRECT_ALLOWLIST` | no       | Claude, ChatGPT | Extra redirect URIs for MCP OAuth clients. The Claude and ChatGPT callbacks are built in. |

### Secrets and admin access

| Variable                           | Required               | Purpose                                                                                       |
| ---------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------- |
| `TOKEN_ENCRYPTION_CURRENT_VERSION` | yes                    | Version number of the key that encrypts new tokens.                                           |
| `TOKEN_ENCRYPTION_KEYS`            | yes                    | JSON map of version to base64 32-byte key, for example `{"1":"…"}`. Never use the sample key. |
| `ADMIN_DASHBOARD_SECRET`           | for OAuth and `/admin` | Password for the dashboard, the connect flow and `/authorize`. Use 16 or more characters.     |
| `OAUTH_STATE_SECRET`               | for OAuth              | HMAC secret for the OAuth `state`. At least 16 characters.                                    |

### Provider OAuth

A provider's OAuth routes register only when all of its variables, plus `OAUTH_STATE_SECRET` and
`ADMIN_DASHBOARD_SECRET`, are present. The server boots without them.

| Variable                                               | Provider  | Purpose                                                                     |
| ------------------------------------------------------ | --------- | --------------------------------------------------------------------------- |
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | Google    | OAuth client. See [GOOGLE_OAUTH_SETUP.md](GOOGLE_OAUTH_SETUP.md).           |
| `MICROSOFT_TENANT_ID`                                  | Microsoft | Default tenant for mailboxes without their own pin.                         |
| `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`       | Microsoft | App registration. See [MICROSOFT_ENTRA_SETUP.md](MICROSOFT_ENTRA_SETUP.md). |
| `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`                 | Zoho      | API console client. See [ZOHO_MAIL_SETUP.md](ZOHO_MAIL_SETUP.md).           |
| `ZOHO_REGION`                                          | Zoho      | `eu` (default) or `com`. Must match the account's datacenter.               |

### Feature flags

All flags are booleans. The defaults are below. Keep the last four `false`.

| Flag                                                                                            | Default |
| ----------------------------------------------------------------------------------------------- | ------- |
| `READ_EMAILS`, `SEARCH_EMAILS`, `READ_THREADS`                                                  | `true`  |
| `CREATE_DRAFTS`, `CREATE_REPLY_DRAFTS`, `UPDATE_DRAFTS`, `DELETE_GATEWAY_DRAFTS`, `SEND_EMAILS` | `true`  |
| `DELETE_RECEIVED_MESSAGES`, `MOVE_MESSAGES`, `MODIFY_RECEIVED_MESSAGES`, `DOWNLOAD_ATTACHMENTS` | `false` |

### Seed variables

`pnpm db:seed` reads the mailbox registry file named by `MAILBOXES_FILE` (default
`./mailboxes.json`) and creates the bootstrap MCP client from `MCP_CLIENT_ID` and
`MCP_CLIENT_SECRET`. The running gateway never reads the file. See
[Register mailboxes](#register-mailboxes) and [CONFIGURATION.md](CONFIGURATION.md).

## Migrations

Migrations are SQL files in `migrations/`. They are applied in file order. Each file runs in its own
transaction and is recorded in `gateway_schema_migrations`. A lock stops two runs from overlapping.

### From the dashboard

Vercel functions have no shell, so production applies migrations from the dashboard.

1. Deploy the new version.
2. Open `https://mail.example.com/admin` and find the **Migrations** panel. It shows the directory
   that was read, how many migrations are applied and the list of pending ones.
3. Press **Apply pending migrations**.

If a file fails, it is rolled back. Earlier files stay applied, and the error page names the file
and the reason. Every attempt writes a `migrations_apply` audit event that lists the applied
versions. Until migration `0008` is applied, the **Signatures** section shows a notice instead of
rows. The dashboard stays reachable.

### From a terminal

`pnpm db:migrate` with the target `DATABASE_URL` does the same thing. It is the only option when a
migration must run before the new code is deployed. Migration `0006` is such a case: the new code
reads the columns that it adds.

## Register mailboxes

The `mailboxes` table is the registry. Each row has an id (for example `gmail-sales`), a provider
(`gmail`, `microsoft` or `zoho`), the primary address, optional aliases, a display name, a routing
priority and the draft and send limits. The mailbox id is what MCP tools take as `mailboxId`.

Add mailboxes in the dashboard. Open `https://mail.example.com/admin`, go to **Mailboxes**, fill in
the **Add a mailbox** form (ID, provider, primary address, and optionally aliases, a Microsoft
tenant ID and a display name) and press **Add mailbox**. **Edit** on each row changes the limits,
the aliases and the display name.

For a repeatable setup, describe the mailboxes in a JSON file and run `pnpm db:seed`. The file is
named by `MAILBOXES_FILE` (default `./mailboxes.json`; start from `mailboxes.example.json`). The
seed also creates or updates the bootstrap MCP client when `MCP_CLIENT_ID` and `MCP_CLIENT_SECRET`
are set. The file format, the defaults, the warm-up send limits, aliases and tenant pinning are
described in [CONFIGURATION.md](CONFIGURATION.md).

A new mailbox starts as `disconnected`. Connect it as described next.

## Connect or reconnect a mailbox

Open `https://mail.example.com/admin`, find the mailbox and choose **Connect** (or **Reconnect**
when it is already connected). The direct links are:

| Provider  | Link                                                                    |
| --------- | ----------------------------------------------------------------------- |
| Gmail     | `https://mail.example.com/oauth/google/start?mailboxId=<mailbox-id>`    |
| Microsoft | `https://mail.example.com/oauth/microsoft/start?mailboxId=<mailbox-id>` |
| Zoho      | `https://mail.example.com/oauth/zoho/start?mailboxId=<mailbox-id>`      |

Sign in at the provider with the address configured for that mailbox. The gateway rejects any other
account with `MAILBOX_MISMATCH`. Each reconnection stores a new encrypted version of the refresh
token and retires the previous one. Provider setup is in [GOOGLE_OAUTH_SETUP.md](GOOGLE_OAUTH_SETUP.md),
[MICROSOFT_ENTRA_SETUP.md](MICROSOFT_ENTRA_SETUP.md) and [ZOHO_MAIL_SETUP.md](ZOHO_MAIL_SETUP.md).

For an LLM client to work without a confirmation on every message, configure the client to trust the
MCP server and to auto-approve `send_draft`. This is a client setting (ChatGPT, Claude or another).
The gateway cannot enforce it. The tool is still advertised as an operation with external effects,
and it accepts only the id of a draft that the gateway already manages.

Verify the result:

```sql
SELECT id, provider, email_address, enabled, connection_status,
       last_token_refresh_at, last_error_code
FROM mailboxes
ORDER BY routing_priority, id;
```

## Revoke a connection

First revoke the consent at the provider (Google Account connected apps, or Microsoft My Apps and
Entra). Then block the connection locally. Replace only the `mailbox_id` value. The statements run
as one transaction in `psql`:

```sql
\set mailbox_id 'gmail-sales'

BEGIN;

UPDATE oauth_token_versions AS token
SET active = false,
    retired_at = COALESCE(token.retired_at, now())
FROM oauth_connections AS connection
WHERE token.oauth_connection_id = connection.id
  AND connection.mailbox_id = :'mailbox_id'
  AND token.active = true;

UPDATE oauth_connections
SET status = 'revoked',
    revoked_at = COALESCE(revoked_at, now()),
    updated_at = now()
WHERE mailbox_id = :'mailbox_id';

UPDATE mailboxes
SET connection_status = 'revoked',
    updated_at = now()
WHERE id = :'mailbox_id';

COMMIT;
```

Check that no active token remains:

```sql
SELECT connection.mailbox_id, connection.status, token.key_version, token.active, token.retired_at
FROM oauth_connections AS connection
LEFT JOIN oauth_token_versions AS token ON token.oauth_connection_id = connection.id
WHERE connection.mailbox_id = :'mailbox_id'
ORDER BY token.created_at DESC;
```

To restore the mailbox, start a new connect flow. Never reactivate a retired token by hand.

## Disable or enable a mailbox

Use **Disable** or **Enable** in the dashboard, or SQL:

```sql
UPDATE mailboxes SET enabled = false, updated_at = now() WHERE id = 'gmail-sales';
UPDATE mailboxes SET enabled = true,  updated_at = now() WHERE id = 'gmail-sales';
```

A disabled mailbox is not used for reading, routing, new drafts or sending. Its OAuth connection is
not revoked.

## Signatures

The Gmail, Microsoft Graph and Zoho draft APIs do not add a signature to drafts. The gateway stores
the signature of each sending identity (the mailbox address or an alias) in `mailbox_signatures`
and adds it when it renders a draft. Manage signatures in the **Signatures** section of the dashboard.

1. **Gmail.** Press **Import from Gmail** on the mailbox row. The gateway reads `settings.sendAs`
   with the `gmail.readonly` scope that it already holds. It saves the HTML signature and display
   name for the identities registered as the mailbox address or an alias (source `gmail`, with a
   sync time). Import again after each signature change in Gmail.
2. **Microsoft and Zoho.** These providers expose no signature API. Paste the HTML signature into
   the identity's textarea, set the display name and press **Save signature** (source `manual`).
   Saving an empty textarea deletes the stored signature.
3. **Apply to all identities.** **Apply to every identity** copies the signature and display
   name of the chosen identity to every other identity on enabled mailboxes. It overwrites
   signatures imported from Gmail, which become manual. This is useful for reusing a Gmail signature
   on Microsoft and Zoho mailboxes.

Each change writes an audit event (`signature_update`, `signature_sync_gmail`,
`signature_apply_all`) with identifiers only. Signature content never appears in audit or logs.

## Raise or lower send limits

Limits are non-negative integers. Drafts are limited per mailbox. Sends are limited twice: by the
mailbox aggregate `daily_send_limit` and by `daily_send_limits_by_identity` for the selected
primary address or alias. Set both to zero to pause sending while keeping reading and drafting.

The aggregate should be at least the sum of the identity limits you want to use. Defaults in the
schema are 5 drafts per run, 25 drafts per day and 25 sends per day.

New domains and mailboxes need warm-up. Start low (for example 10 sends per day) and raise the
limit gradually, for example by about 10 per week, while bounce and complaint rates stay low.

```sql
UPDATE mailboxes
SET per_run_draft_limit = 5,
    daily_draft_limit = 25,
    daily_send_limit = 20,
    daily_send_limits_by_identity = jsonb_build_object(lower(email_address), 20),
    updated_at = now()
WHERE id = 'gmail-sales';
```

For a mailbox with an alias, list each identity in the JSON object and set the aggregate to their
sum:

```sql
UPDATE mailboxes
SET daily_send_limit = 35,
    daily_send_limits_by_identity =
      jsonb_build_object(lower(email_address), 20, 'alias@example.com', 15),
    updated_at = now()
WHERE id = 'outlook-sales';
```

Check today's usage and remaining capacity:

```sql
SELECT m.id, m.per_run_draft_limit, m.daily_draft_limit, m.daily_send_limit,
       m.daily_send_limits_by_identity,
       COALESCE(u.drafts_created, 0) AS drafts_created_today,
       COALESCE(u.messages_sent, 0) AS messages_sent_today,
       COALESCE(u.messages_sent_by_identity, '{}'::jsonb) AS messages_sent_by_identity,
       GREATEST(m.daily_draft_limit - COALESCE(u.drafts_created, 0), 0) AS remaining_drafts,
       GREATEST(m.daily_send_limit - COALESCE(u.messages_sent, 0), 0) AS remaining_sends
FROM mailboxes AS m
LEFT JOIN daily_mailbox_usage AS u
  ON u.mailbox_id = m.id AND u.usage_date = current_date
ORDER BY m.routing_priority, m.id;
```

## Enable autonomous sending

Use this order when you turn on `send_draft` for a deployment that was running before send support
(migration `0006`). The new code reads the columns that the migration adds, so the migration comes
first.

1. In Microsoft Entra, add the delegated `Mail.Send` permission to the app registration that already
   has `Mail.ReadWrite`, and grant the consent that your tenant requires.
2. Apply the migrations to the production database with `pnpm db:migrate`, using the correct direct
   `DATABASE_URL`.
3. Deploy the new version and check `/health/live` and `/health/ready`.
4. Reconnect every Microsoft mailbox from the dashboard so that the new refresh tokens include
   `Mail.Send`. Gmail and Zoho need no new scope. A refresh never asks for scopes beyond the stored
   grant. If the code widens the scopes, the mailbox degrades to "cannot send" instead of losing
   read access, and `list_mailboxes` reports the missing scope until you reconnect.
5. Call `list_mailboxes`. Every account must be connected and must show remaining send capacity
   above zero.
6. For each provider, create one draft to an address that you control, send it with `send_draft`,
   and check both `status=sent` and the copy in the provider's Sent folder.

Before each ramp-up, check `canSend` and `missingScopes` in `list_mailboxes`. The OAuth grant is
frozen at consent, so a connected mailbox that reads normally can still have `canSend: false`. The
only fix is to reconnect the mailbox from its provider's `/oauth/<provider>/start` route.

Do not run the first test on a real campaign. To switch off delivery only, set `SEND_EMAILS=false`
and create a new deployment. Reading and drafting stay available. To block all MCP traffic, use the
[kill switch](#kill-switch).

## Check a draft or a send

From an MCP client, call `get_draft_status` with the `internalDraftId`. Look at:

- `status`, the state in the gateway registry;
- `stillExists`, the result of a live check at the provider;
- `providerCheckErrorCode`, present when the live check is inconclusive;
- `providerWebUrl`, to open the draft at the provider while it still exists;
- `reconciliationHint`, present when the send outcome is unknown and `reconcile_draft_send` is
  needed.

`stillExists=false` means the draft is no longer in the mailbox. It may have been deleted or
delivered. With `status=sent` that is the expected result.

To list recent sends in SQL:

```sql
SELECT id, mailbox_id, normalized_recipient_email, status,
       provider_sent_message_id, sent_at, last_error_code
FROM drafts
WHERE status IN ('sending', 'sent', 'send_unknown')
ORDER BY updated_at DESC
LIMIT 100;
```

- `sent`: the provider accepted the request. A second `send_draft` is an idempotent success and does
  not contact the provider.
- `sending`: the process may have stopped after the provider request and before the commit.
- `send_unknown`: a timeout or network error left the result ambiguous. Do not set the status back
  to `created` by hand and do not retry blindly. Use `reconcile_draft_send`.

## Reconcile SEND_STATUS_UNKNOWN

Call `reconcile_draft_send` with the `internalDraftId`. It is the only way out of `send_unknown`.
No other tool moves the row, and you must never edit the status in the database. It also accepts
`sending` rows older than 40 seconds, left by an interrupted process.

The tool asks the mailbox two questions. Is the draft still in Drafts? Is there a copy in Sent to
the same recipient with the same subject, dated no earlier than the claim? The outcomes are:

- `sent`: the copy exists in Sent. The row becomes `sent` with the `providerSentMessageId` that was
  found. Do not send again.
- `not_sent`: nothing left the mailbox. The row returns to `created`, the day's send quota is given
  back and `send_draft` accepts the draft again. On Gmail and Outlook, the draft must still be in
  Drafts, because the provider consumes it when it sends. On Zoho, which creates a separate
  message, the Sent folder must be empty of a match and the row at least 5 minutes old.
- `unresolved`: the evidence is not enough (search failed, provider unreachable). The row stays
  unchanged, `reason` says what was missing and you can call the tool again later.

Each run leaves a `draft_operations` row with `operation='reconcile'`. If a draft stays
`unresolved` for a long time, check the mailbox connection first (`list_mailboxes`,
`get_gateway_health`). Only then inspect the Sent and Drafts folders by hand at the provider.

## Delete a stuck draft

1. Get the `internalDraftId` with `list_campaign_drafts`.
2. Check the draft with `get_draft_status`. If it exists, open `providerWebUrl`.
3. Call `delete_outreach_draft`. It accepts only drafts that the gateway manages.
4. If the provider answers 404 because the draft is already gone, the result is still idempotent.
   The record must end as `deleted`.
5. Call `get_draft_status` again. The expected result is `status=deleted` and `stillExists=false`.

Do not use provider APIs to delete received or delivered mail.

## Clean up legacy drafts

1. Call `search_emails` on the mailbox with `folder="drafts"` and filters that are narrow enough.
   Collect the `messageId` of the results you want to remove.
2. Pass up to 50 `messageId` values to `adopt_external_drafts`. You do not need the old
   `campaignId`. If you know it, add it as metadata.
3. Read the summary. Use only the `internalDraftId` values with outcome `adopted` or
   `alreadyManaged`.
4. Call `delete_outreach_drafts` with at most 50 ids. Check every result. The batch is
   partial-success, and one failed id does not block the others.

On Gmail, adoption resolves the message id to the stable draft id. On every provider, it checks that
the target is still an unsent draft. It does not recreate copies and does not use draft quota.

## Kill switch

In an emergency, press **Turn on kill switch** at `https://mail.example.com/admin`. The
form sets `global_kill_switch=true` for all clients, and every new MCP request is blocked at once
with HTTP 503. The same action in SQL:

```sql
UPDATE mcp_clients
SET global_kill_switch = true, updated_at = now();
```

`GLOBAL_KILL_SWITCH=true` in the environment does the same. It needs a new deployment, and it is
useful when the database is not reliable. The two switches combine with OR. To restore traffic,
both must be off. When the dashboard switch is on, the same button reads **Turn off kill switch**.

## Logs and error reports

The gateway writes structured JSON logs (pino) to standard output at `LOG_LEVEL`. On Vercel they
appear in the project's runtime logs. Request URLs are not logged, because OAuth callbacks carry
codes in the query string. Keys whose name suggests a token, secret, password, credential,
authorization, cookie, body, MIME content, attachment or signature are replaced with `[Redacted]`.

An unhandled error returns HTTP 500 with a body that holds no details:

```json
{ "code": "INTERNAL_ERROR", "correlationId": "00000000-0000-0000-0000-000000000000" }
```

An unknown route returns HTTP 404 with `{"code":"NOT_FOUND","message":"Route not found","correlationId":"…"}`.
Search the logs for the correlation id to find the error type, message and stack. The same id
labels the audit events of that request (see [Read the audit log](#read-the-audit-log)). A client
can send its own `x-correlation-id` header, and the gateway keeps it when it is a UUID.

Sentry is optional. Set `SENTRY_DSN` and unhandled server errors are also sent there. Each event
holds the correlation id, the error type, the message and the stack trace. It holds no request
bodies, headers, cookies, query strings or user data, and no breadcrumbs. If Sentry cannot start,
the gateway logs the failure and keeps running. Leave `SENTRY_DSN` empty to switch reporting off.

A self-hosted process sends events in the background, so a 500 is answered without waiting for
Sentry. The Vercel entry waits for delivery, for at most 2 seconds, before it answers the 500,
because the instance may freeze as soon as the response is sent.

## Admin login lockout

Wrong admin passwords are counted per client network. After 10 failures within 15 minutes, that
network gets HTTP 429 with a `Retry-After` header on `/admin`, the connect routes and `/authorize`,
even for the right password, until the window ends. A correct password resets the count.

A client network is an IPv4 address, or the /64 block of an IPv6 address. An IPv4-mapped address
(`::ffff:192.0.2.1`) counts as that IPv4 address. A blocked network stays blocked until its window
ends, however many other clients the throttle sees.

The throttle tracks at most 10,000 clients. If all of them are blocked, a wrong password from a new
client is refused but not counted, and the log shows
`admin authentication failed, not counted: every client the throttle tracks is blocked`. That line
means a guessing flood from many networks. Keep the dashboard reachable only from where you need
it, and check that the password is long and random.

The counters live in the memory of one running instance. On Vercel that means per warm function
instance: an attacker whose requests land on several instances gets the budget once per instance.
The throttle slows online guessing, it does not stop it, so keep the password long and random.

When you self-host behind a proxy or load balancer, set `TRUST_PROXY`. Without it, every client
shares the proxy's address and one guesser can lock the operator out. With a wrong value, clients
can choose their own address through `X-Forwarded-For` and escape the limit. Prefer the proxy's
IPs or CIDR ranges. A hop count is safe only when nothing reaches the gateway except through those
hops. Vercel needs no setting: the entry point already trusts Vercel's edge.

If requests carry `X-Forwarded-For` while `TRUST_PROXY` is off, the gateway logs this warning once
per process:

```text
requests carry X-Forwarded-For but TRUST_PROXY is off: rate limits and the admin login throttle see the proxy address; set TRUST_PROXY
```

The dashboard shows the same warning as a banner while your own request carries the header. Set
`TRUST_PROXY` to the proxy's address and redeploy. If no proxy is in front of the gateway, a client
sent the header itself, and you can ignore the warning.

The `/mcp` rate limit (`MCP_RATE_LIMIT_MAX`) uses the same client network as the login throttle.
It does not read the `x-mcp-client-id` header, which a client could change at will.

## Same-origin check

Every state-changing admin request (`POST` on `/admin/...` and on `/authorize`) is refused with
HTTP 403 unless it comes from the gateway's own origin. The gateway reads `Sec-Fetch-Site` first,
then `Origin`, then `Referer`, and compares the origin with `PUBLIC_BASE_URL`. A request with none
of these headers is refused.

If the dashboard buttons answer 403, the origin in the address bar differs from `PUBLIC_BASE_URL`
(for example a preview URL or a custom domain against a different base URL). Open the dashboard on
the configured origin, or correct `PUBLIC_BASE_URL` and create a new deployment.

## Rotate secrets

Runtime secrets live in your platform's environment variables (for Vercel, the project settings,
separate for Production, Preview and Development). Check and rotate these as needed:

- `ADMIN_DASHBOARD_SECRET` and `OAUTH_STATE_SECRET`;
- `GOOGLE_OAUTH_CLIENT_SECRET`, `MICROSOFT_CLIENT_SECRET` and `ZOHO_CLIENT_SECRET`;
- `MCP_CLIENT_SECRET` and the matching hash in `mcp_clients`;
- `TOKEN_ENCRYPTION_KEYS` and `TOKEN_ENCRYPTION_CURRENT_VERSION`;
- `DATABASE_URL`, after rotating the Neon credentials.

Update the value as **Sensitive** in the affected environment only, then create a new deployment.
A running deployment does not read changed variables. With the Vercel CLI you can use
`vercel env add NAME production --sensitive`. To work locally after a change, run
`vercel env pull .env.local --environment=production --yes`. The command overwrites the target
file.

To rotate the encryption keyring without making existing tokens unreadable:

1. Generate a new random AES-256 key, base64 encoded.
2. Add version `N+1` to the JSON in `TOKEN_ENCRYPTION_KEYS`. Keep every version that still has
   tokens in the database. The shape is `{"1":"…","2":"…"}`.
3. Set `TOKEN_ENCRYPTION_CURRENT_VERSION=N+1` in the same deployment.
4. Redeploy and reconnect the mailboxes one at a time. Tokens are re-encrypted with the current
   version at the next reconnect.
5. Remove an old key only after this query returns zero active tokens for that version:

```sql
SELECT key_version, count(*) AS active_tokens
FROM oauth_token_versions
WHERE active = true
GROUP BY key_version
ORDER BY key_version;
```

Changing only `MCP_CLIENT_SECRET` in the environment does not update the hash in PostgreSQL. Run
the controlled seed with the new credentials (`pnpm db:seed`), or use an application procedure that
regenerates `mcp_clients.secret_hash`. Never store the plaintext secret in the database.

## Rollback

If a deployment misbehaves, promote the previous production deployment in Vercel, then investigate.

1. In the Vercel dashboard, open **Deployments**, choose the last healthy production deployment and
   promote it (or run `vercel rollback`).
2. [Verify the deployment](#verify-a-deployment):

   ```sh
   pnpm verify:deployment https://mail.example.com
   ```

3. Call `get_gateway_health`, then `list_mailboxes`, from an authenticated MCP client.
4. If the bad release changed the database schema, remember that migrations are not reversed by a
   rollback. Check that the older code still works with the newer schema before you continue.
   Migrations in this repository add columns and tables, so older code normally keeps running.
5. Investigate the failed deployment with its build and runtime logs and with the
   [audit log](#read-the-audit-log). Fix forward, then deploy again.

If the problem is a bad credential or variable and not the code, rollback does not help. Correct the
variable and create a new deployment.

## Recover after an incident

1. Check Neon: the project is active, the connection string is valid, TLS works and the migrations
   are applied.
2. Check the Vercel variables of the right environment. Pay attention to `DATABASE_URL`, the
   keyring, the OAuth secrets, `PUBLIC_BASE_URL` and the MCP credentials.
3. When the emergency is over, set `GLOBAL_KILL_SWITCH=false`, create a new deployment and turn the
   switch off in the database:

   ```sql
   UPDATE mcp_clients
   SET global_kill_switch = false, updated_at = now();
   ```

4. Check `/health/live` and `/health/ready`.
5. Run `get_gateway_health`, then `list_mailboxes`, with an authenticated MCP client.
6. Reconnect only the mailboxes that show `expired`, `revoked`, `error` or `disconnected`.
7. Resolve any draft in `sending` or `send_unknown` with
   [`reconcile_draft_send`](#reconcile-send_status_unknown).
8. Check the audit log with the correlation id of a test operation.

## Diagnose OAuth

Start with the recent OAuth events. `metadata.message` holds the operational message, already
redacted. It never contains tokens.

```sql
SELECT occurred_at, mailbox_id, operation, result, error_code,
       metadata ->> 'message' AS message,
       correlation_id
FROM audit_events
WHERE operation LIKE 'oauth%'
ORDER BY occurred_at DESC
LIMIT 100;
```

```sql
SELECT m.id, m.connection_status, m.last_token_refresh_at, m.last_error_code,
       c.status AS oauth_status, c.expires_at, c.revoked_at,
       t.key_version, t.active, t.created_at AS token_created_at
FROM mailboxes AS m
LEFT JOIN oauth_connections AS c ON c.mailbox_id = m.id
LEFT JOIN oauth_token_versions AS t ON t.oauth_connection_id = c.id AND t.active = true
ORDER BY m.id, c.updated_at DESC;
```

- `MAILBOX_MISMATCH`: the wrong provider account was chosen.
- `AUTH_REQUIRED`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `invalid_grant`: reconnect. For Microsoft, also
  check `Mail.ReadWrite`, `Mail.Send`, client secret expiry and tenant consent.
- `state` error: the link expired (10 minutes), or `OAUTH_STATE_SECRET` differs between instances.
  Start again from the `/start` URL after you check the environment.
- Redirect mismatch: register exactly `https://mail.example.com/oauth/google/callback`,
  `https://mail.example.com/oauth/microsoft/callback` or
  `https://mail.example.com/oauth/zoho/callback`, as applicable.

## Read the audit log

Latest failed events:

```sql
SELECT occurred_at, correlation_id, mcp_client_id, mailbox_id, tool, operation,
       result, error_code, retry_count, provider_latency_ms
FROM audit_events
WHERE result = 'failed'
ORDER BY occurred_at DESC
LIMIT 100;
```

Full trace of one correlation id:

```sql
SELECT occurred_at, mcp_client_id, mailbox_id, campaign_id, prospect_id,
       resource_id, tool, operation, result, error_code, metadata
FROM audit_events
WHERE correlation_id = '00000000-0000-0000-0000-000000000000'
ORDER BY occurred_at;
```

One mailbox over the last 24 hours:

```sql
SELECT occurred_at, correlation_id, tool, operation, result, error_code,
       provider_latency_ms
FROM audit_events
WHERE mailbox_id = 'gmail-sales'
  AND occurred_at >= now() - interval '24 hours'
ORDER BY occurred_at DESC;
```

Audit rows hold identifiers, outcomes, timings and minimal metadata. They never hold refresh
tokens, client secrets, Authorization headers, email bodies or MIME content.

## Local development

Requirements: Node.js 22, pnpm 11 and a PostgreSQL database. A Neon development branch works well.
Docker is not required.

```sh
cp .env.example .env
pnpm install
pnpm db:migrate
pnpm db:seed
pnpm dev
```

In `.env`, set a **direct** `DATABASE_URL` with TLS and local secrets that differ from production.
To seed mailboxes, copy `mailboxes.example.json` to `mailboxes.json` and edit it (see
[CONFIGURATION.md](CONFIGURATION.md)), or add them later from `/admin`. The seed registers the
mailboxes and, when `MCP_CLIENT_ID` and `MCP_CLIENT_SECRET` are set, creates or updates the
bootstrap MCP client.

Check the service:

```sh
curl -fsS http://localhost:3000/health/live
curl -fsS http://localhost:3000/health/ready
```

The dashboard is at `http://localhost:3000/admin`. MCP is at `http://localhost:3000/mcp`. For Basic
authentication, use `MCP_CLIENT_ID:MCP_CLIENT_SECRET`.

To use a local PostgreSQL instead of Neon, `docker-compose.yml` starts PostgreSQL 16 with a named
volume. Its defaults are database `yempik_mail_gateway`, user `yempik` and password
`yempik_local_password`, overridable with `POSTGRES_DB`, `POSTGRES_USER` and `POSTGRES_PASSWORD`:

```sh
docker compose up -d postgres
# DATABASE_URL=postgresql://yempik:yempik_local_password@localhost:5432/yempik_mail_gateway
```

## Self-hosting with Docker

The `Dockerfile` builds a Node 22 multi-stage image. It installs dependencies from the lockfile,
builds every package, deploys the `@yempik/mcp-server` package with production dependencies only and
runs it as the unprivileged `node` user on port 3000. The `migrations` directory is copied into the
image so that the dashboard can apply migrations.

The CI pipeline does not build this image, and it has not been verified on every release. Test it
in your environment first.

```sh
docker build -t mail-gateway .
docker run --rm -p 3000:3000 --env-file .env mail-gateway
```

Notes for a self-hosted deployment:

- The container serves plain HTTP. Put a TLS terminating proxy in front of it and set
  `PUBLIC_BASE_URL` to the public HTTPS URL.
- Set `TRUST_PROXY` to the proxy's IP address or CIDR range so that the gateway sees the real client
  address. The admin login lockout and the rate limits key on it. See
  [Admin login lockout](#admin-login-lockout).
- Provide the same [environment variables](#environment-variables) as on Vercel. Use a managed
  PostgreSQL 16 database with TLS.
- Apply migrations with `pnpm db:migrate` from a checkout, or from the dashboard after the first
  start.
- The health endpoints `/health/live` and `/health/ready` suit container liveness and readiness
  probes. After you start the container, run [`pnpm verify:deployment`](#verify-a-deployment).
- Concurrent migration runs are serialized by a database lock, so starting several replicas is safe.
