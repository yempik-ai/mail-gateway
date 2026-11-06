# MCP tools and HTTP surface

The gateway exposes one MCP endpoint over Streamable HTTP and a small operational HTTP surface.
Received mail is read-only. The gateway manages drafts, and it can deliver only a draft that is
already registered under an `internalDraftId`.

Examples use `https://mail.example.com` as the public base URL. Replace it with your own
`PUBLIC_BASE_URL`.

## Contents

- [Draft-first guarantee](#draft-first-guarantee)
- [HTTP endpoints](#http-endpoints)
- [Authentication](#authentication)
- [Conventions](#conventions)
- [Tool index](#tool-index)
- [Tool reference](#tool-reference)
- [Body, signature and quoting](#body-signature-and-quoting)
- [Error codes](#error-codes)

## Draft-first guarantee

`send_draft` accepts only a gateway-internal id. Recipients, subject and body cannot be introduced
during the send call. The record is claimed atomically and cannot be sent twice. An ambiguous
timeout or network error produces `SEND_STATUS_UNKNOWN` and blocks automatic retries. The gateway
cannot forward, move, archive or delete received messages.

Security tests forbid arbitrary sending (`users.messages.send`, `/me/sendMail`), direct actions on
received messages and any mutation that draft management does not need. See
[SECURITY.md](SECURITY.md).

## HTTP endpoints

| Method                  | Path                                          | Authentication                    | Purpose                                                                                                   |
| ----------------------- | --------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `GET`                   | `/health/live`                                | public                            | Process liveness.                                                                                         |
| `GET`                   | `/health/ready`                               | public                            | Database readiness and provider wiring (`adapters`). Returns 503 when degraded.                           |
| `GET`, `POST`, `DELETE` | `/mcp`                                        | MCP Basic or Bearer               | Stateless MCP Streamable HTTP transport.                                                                  |
| `GET`                   | `/admin`                                      | admin Basic                       | Dashboard: mailboxes, capacity, signatures, migrations, kill switch and recent audit events.              |
| `POST`                  | `/admin/mailboxes`                            | admin Basic                       | Add a mailbox. Fields `id`, `provider`, `emailAddress`, `aliases`, `microsoftTenantId`, `displayName`.    |
| `POST`                  | `/admin/mailboxes/:mailboxId/update`          | admin Basic                       | Edit display name, aliases, limits and, before the first connection, provider, address and tenant.        |
| `POST`                  | `/admin/mailboxes/:mailboxId/enable`          | admin Basic                       | Enable a mailbox. Redirects with 303 to `/admin`.                                                         |
| `POST`                  | `/admin/mailboxes/:mailboxId/disable`         | admin Basic                       | Disable a mailbox. Redirects with 303 to `/admin`.                                                        |
| `POST`                  | `/admin/kill-switch`                          | admin Basic                       | Form field `action=activate\|deactivate`. Redirects with 303.                                             |
| `POST`                  | `/admin/migrations/apply`                     | admin Basic                       | Apply pending SQL migrations. Writes a `migrations_apply` audit event.                                    |
| `POST`                  | `/admin/signatures/:mailboxId/:identityEmail` | admin Basic                       | Fields `displayName` and `signatureHtml`. Saves a manual signature. An empty textarea deletes it.         |
| `POST`                  | `/admin/signatures/:mailboxId/sync-gmail`     | admin Basic                       | Import signature and display name from Gmail `settings.sendAs`. Returns 400 for a non-Gmail mailbox.      |
| `POST`                  | `/admin/signatures/apply-all`                 | admin Basic                       | Fields `sourceMailboxId` and `sourceIdentityEmail`. Overwrites every other identity on enabled mailboxes. |
| `GET`                   | `/oauth/google/start`, `/callback`            | admin on start, state on callback | Gmail OAuth connection for a `mailboxId`.                                                                 |
| `GET`                   | `/oauth/microsoft/start`, `/callback`         | admin on start, state on callback | Microsoft OAuth connection for a `mailboxId`.                                                             |
| `GET`                   | `/oauth/zoho/start`, `/callback`              | admin on start, state on callback | Zoho OAuth connection for a `mailboxId`.                                                                  |

The OAuth routes of a provider register only when that provider's variables are configured. See
[OPERATIONS.md](OPERATIONS.md#environment-variables). The dashboard shows no secrets.

Every `POST` on `/admin/...` and on `/authorize` must come from the gateway's own origin
(`PUBLIC_BASE_URL`), or it gets HTTP 403. After 10 wrong admin passwords from one IP address within
15 minutes, the admin routes answer HTTP 429 with a `Retry-After` header. See
[SECURITY.md](SECURITY.md#admin-surface).

### Health response

`/health/ready` and the `get_gateway_health` tool return the same object:

```json
{
  "status": "ok",
  "database": "ok",
  "configuration": "ok",
  "adapters": { "gmail": true, "microsoft": false, "zoho": false }
}
```

`status` is `ok` or `degraded`, and `database` is `ok` or `unavailable`. Readiness depends on the
database alone. `adapters` is an object with one boolean per provider (`gmail`, `microsoft`,
`zoho`). A value is `true` when that provider's OAuth settings are complete, so a deployment wired
for a subset of providers is still `ok`. Earlier versions returned the string
`"not_configured"` for `adapters`.

### Errors from the HTTP layer

An unhandled server error returns HTTP 500 with `{"code":"INTERNAL_ERROR","correlationId":"…"}` and
no detail. An unknown route returns HTTP 404 with
`{"code":"NOT_FOUND","message":"Route not found","correlationId":"…"}`. Find the details of a 500 in
the server log by correlation id (see [OPERATIONS.md](OPERATIONS.md#logs-and-error-reports)).

Too many requests to `/mcp` return HTTP 429 with a `Retry-After` header. The limit is
`MCP_RATE_LIMIT_MAX` requests per `MCP_RATE_LIMIT_WINDOW_MS` for each client network (an IPv4
address or an IPv6 /64), whatever credentials the requests carry.

## Authentication

`/mcp` accepts:

- HTTP Basic: `Authorization: Basic base64(MCP_CLIENT_ID:MCP_CLIENT_SECRET)`.
- The equivalent legacy headers `x-mcp-client-id` and `x-mcp-client-secret`.
- OAuth Bearer: `Authorization: Bearer <access-token>`.

The client must be enabled, allowlisted, not revoked and assigned to the runtime environment. The
kill switch, whether set in the environment or in the database, overrides any credential and
returns HTTP 503.

For OAuth clients such as claude.ai and ChatGPT, the gateway implements:

| Method | Path                                      | Purpose                                                                                 |
| ------ | ----------------------------------------- | --------------------------------------------------------------------------------------- |
| `GET`  | `/.well-known/oauth-protected-resource`   | MCP resource metadata.                                                                  |
| `GET`  | `/.well-known/oauth-authorization-server` | Authorization server metadata.                                                          |
| `POST` | `/register`                               | Dynamic client registration. Redirect URIs are allowlisted. A new client has no access. |
| `GET`  | `/authorize`                              | Admin Basic. Validates the request and shows the consent page. Issues nothing.          |
| `POST` | `/authorize`                              | Admin Basic and same-origin check. The consent form: `decision=approve` or `deny`.      |
| `POST` | `/token`                                  | Code and refresh-token exchange. Both are single use.                                   |

`/authorize` requires Authorization Code with PKCE S256. The operator signs in with the admin
password and sees a consent page with the client name, the client id and the host the browser
returns to. **Approve** issues a one-time code and redirects to the client. **Deny** redirects to the
client with `error=access_denied`. Authorization codes and refresh tokens can be used once. A
refresh returns a new access token and a new refresh token.

The default allowed redirect URIs are `https://claude.ai/api/mcp/auth_callback` and
`https://chatgpt.com/connector_platform_oauth_redirect`. Per-connector ChatGPT callbacks
(`https://chatgpt.com/connector/oauth/{callback_id}`) are accepted without listing them. Add more
with `MCP_OAUTH_REDIRECT_ALLOWLIST`.

In ChatGPT, set the connector URL to `https://mail.example.com/mcp` and Authentication to OAuth.
In both Claude and ChatGPT, the browser opens the consent page: sign in with the admin password and
press **Approve**. Access tokens last 30 days, refresh tokens 90 days and authorization codes
10 minutes.

For a client that should not ask for confirmation on every message, configure the client to trust
the server and auto-approve `send_draft`. That is a client setting. The gateway cannot enforce it.
The tool is still advertised as an operation with external effects.

## Conventions

Tool output is one MCP `text` block that contains JSON. Application errors use this shape:

```json
{
  "code": "PROVIDER_TIMEOUT",
  "message": "…",
  "retryable": true,
  "retryAfterSeconds": 30,
  "correlationId": "…"
}
```

`retryAfterSeconds` appears only when it is known. Retryable codes are `PROVIDER_RATE_LIMIT`,
`PROVIDER_TIMEOUT`, `PROVIDER_UNAVAILABLE`, `DATABASE_ERROR` and `BATCH_TIME_BUDGET_EXCEEDED`. Never retry `SEND_STATUS_UNKNOWN`
automatically. Resolve it with `reconcile_draft_send`, which gathers evidence from the Sent and
Drafts folders.

Environment feature flags gate the tools. All the flags below are on by default.

| Flag                    | Tools it enables                                                           |
| ----------------------- | -------------------------------------------------------------------------- |
| `SEARCH_EMAILS`         | `search_emails`, `list_outreach_replies`                                   |
| `READ_EMAILS`           | `get_email`                                                                |
| `READ_THREADS`          | `get_email_thread`                                                         |
| `CREATE_DRAFTS`         | `create_outreach_drafts`, `list_campaign_drafts`, `get_draft_status`       |
| `CREATE_REPLY_DRAFTS`   | `create_reply_draft`                                                       |
| `UPDATE_DRAFTS`         | `update_outreach_draft`, `adopt_external_drafts`                           |
| `DELETE_GATEWAY_DRAFTS` | `delete_outreach_draft`, `delete_outreach_drafts`, `adopt_external_drafts` |
| `SEND_EMAILS`           | `send_draft`, `reconcile_draft_send`                                       |

`get_gateway_health` and `list_mailboxes` are always available.

## Tool index

| #   | Tool                     | Purpose                                                |
| --- | ------------------------ | ------------------------------------------------------ |
| 1   | `get_gateway_health`     | Technical status without secrets.                      |
| 2   | `list_mailboxes`         | Mailbox ids, status, capacity and sending identities.  |
| 3   | `search_emails`          | Cross-provider search. No bodies.                      |
| 4   | `get_email`              | Read one message.                                      |
| 5   | `get_email_thread`       | Read one conversation in one mailbox.                  |
| 6   | `create_outreach_drafts` | Create a batch of new drafts.                          |
| 7   | `create_reply_draft`     | Create a reply draft in the source thread.             |
| 8   | `send_draft`             | Send a managed draft.                                  |
| 9   | `adopt_external_drafts`  | Put existing provider drafts under gateway management. |
| 10  | `update_outreach_draft`  | Change a managed draft.                                |
| 11  | `delete_outreach_draft`  | Delete one managed draft.                              |
| 12  | `delete_outreach_drafts` | Delete up to 50 managed drafts.                        |
| 13  | `list_campaign_drafts`   | List the drafts of a campaign.                         |
| 14  | `get_draft_status`       | Gateway record plus a live provider check.             |
| 15  | `list_outreach_replies`  | Find inbound replies to known campaigns.               |
| 16  | `reconcile_draft_send`   | Resolve an ambiguous send from mailbox evidence.       |

## Tool reference

### 1. `get_gateway_health`

**Purpose.** Technical status without secrets and without reading mailboxes.

**Input.** None.

**Output.** `{status, database, configuration, adapters}`. `status` is `ok` or `degraded`.
`database` is `ok` or `unavailable`. `adapters` is an object `{gmail, microsoft, zoho}` of booleans
that say which providers have complete OAuth settings. See [Health response](#health-response).

**Errors and limits.** An unreachable database returns a degraded snapshot. The tool does not read
providers. It uses no provider quota.

### 2. `list_mailboxes`

**Purpose.** List the mailbox ids to use in other tools and the operational state of each mailbox.

**Input.** None.

**Output.** `{mailboxes: [...]}`. Each mailbox has `mailboxId`, `provider`, `emailAddress`,
`aliases[]`, status, aggregate capacity and `sendingIdentities[]`. Each identity has
`emailAddress`, `dailyLimit`, `messagesSentToday` and `remainingDailyCapacity`. A mailbox also has
optional `lastSuccessfulReadAt`, `requiresReconnection`, `canSend` and `missingScopes[]`.

**Errors and limits.** Only infrastructure errors (`DATABASE_ERROR`, `INTERNAL_ERROR`). Aggregate
capacity is `daily_draft_limit - drafts_created` and `daily_send_limit - messages_sent`. Each
sender's capacity uses its counter in `messages_sent_by_identity`. Capacity is never negative.

**Delivery readiness.** An OAuth grant is frozen at consent time. A mailbox can be `connected` and
read normally while it cannot send. `missingScopes[]` lists the delivery scopes that the recorded
grant lacks, and is empty when the grant is complete. `canSend` is true only when the mailbox is
enabled, connected and has no missing scope. `canSend: false` is resolved only by reconnecting the
mailbox from `/oauth/<provider>/start`. `send_draft` refuses earlier with `AUTH_REQUIRED`.

### 3. `search_emails`

**Purpose.** Cross-provider search. Results never include bodies.

**Input.** All optional: `mailboxIds[]`, `text`, `from`, `to`, `subject`, `after` (ISO 8601,
inclusive), `before` (ISO 8601, exclusive), `unreadOnly`, `hasAttachment`, `folder`
(`inbox|sent|drafts|archive|all`), `limit`, `cursor`. Without `mailboxIds`, the tool searches every
enabled and connected mailbox.

**Output.** `{emails, partialFailures, nextCursor?}`. Each summary includes `mailboxId`. Results are
sorted newest first and deduplicated. `partialFailures` holds `{mailboxId, errorCode}` entries and
does not cancel results from other mailboxes.

**Errors and limits.** Default 20 and maximum 50 results overall. Each provider has a 10-second
timeout. Possible codes: `INVALID_QUERY`, `MAILBOX_NOT_FOUND`, `MAILBOX_DISABLED`, `AUTH_REQUIRED`,
`PROVIDER_RATE_LIMIT`, `PROVIDER_TIMEOUT`, `PROVIDER_UNAVAILABLE`, `UNSUPPORTED_OPERATION`.

### 4. `get_email`

**Purpose.** Read one message from one mailbox.

**Input.** `mailboxId` and `messageId`. Optional `includeBody` (default `true`) and `bodyFormat`
(`text|html|both`, default `text`). The text format falls back to HTML when the message has no text
part.

**Output.** A normalized email with headers, senders and recipients, timestamps, thread id and, when
requested, `textBody` and `htmlBody`.

**Errors and limits.** Each body is truncated at 50,000 characters with an explicit marker.
Possible codes: `MAILBOX_NOT_FOUND`, `MAILBOX_DISABLED`, `AUTH_REQUIRED`, `MESSAGE_NOT_FOUND`,
`PROVIDER_RATE_LIMIT`, `PROVIDER_TIMEOUT`, `PROVIDER_UNAVAILABLE`, `UNSUPPORTED_OPERATION`.

### 5. `get_email_thread`

**Purpose.** Read one conversation inside one mailbox. The tool does not merge threads across
providers.

**Input.** `mailboxId` and `threadId`.

**Output.** A normalized thread. Messages are in chronological order and appear as summaries without
bodies. Use `get_email` for the content of a specific message.

**Errors and limits.** `MAILBOX_NOT_FOUND`, `MAILBOX_DISABLED`, `AUTH_REQUIRED`,
`THREAD_NOT_FOUND`, `PROVIDER_RATE_LIMIT`, `PROVIDER_TIMEOUT`, `PROVIDER_UNAVAILABLE`,
`UNSUPPORTED_OPERATION`.

### 6. `create_outreach_drafts`

**Purpose.** Create a batch of new drafts, one per prospect, with explicit or distributed routing.

**Input.** `campaignId`, `routingMode` (`explicit|distributed`) and `drafts[]`. `mailboxId` is
required with explicit routing. `fromAddress` selects the primary address or an alias of the
explicit mailbox. `sequenceStep` is optional (default 1). `includeSignature` (default `true`)
applies to the whole batch. Each draft has `to` (one recipient), `subject`, a body (`body` in
Markdown, recommended, or `textBody` and/or `htmlBody`) and an optional `prospectId`. The gateway
renders the body and appends the sending identity's signature. See
[Body, signature and quoting](#body-signature-and-quoting).

**Output.** `campaignId`, `sequenceStep`, `routingMode`, `results[]` in input order, and `summary`.
Each result has `status` (`created|duplicate|failed`), `duplicatePrevented`, the gateway and
provider ids, the mailbox, `providerWebUrl` and an optional `errorCode`. A failed result can also
carry `errorMessage`, a short explanation of what to do, where the code alone does not say it.

**Errors and limits.** 1 to 15 drafts per call. Each mailbox enforces `per_run_draft_limit` and
`daily_draft_limit` (defaults 5 and 25). Items beyond a limit fail individually with
`PER_RUN_LIMIT_REACHED` or `DAILY_LIMIT_REACHED`. Other codes: `INVALID_QUERY`, `INVALID_RECIPIENT`,
`MAILBOX_NOT_FOUND`, `MAILBOX_DISABLED`, `AUTH_REQUIRED`, `PROVIDER_RATE_LIMIT`,
`PROVIDER_TIMEOUT`, `PROVIDER_UNAVAILABLE`, `UNSUPPORTED_OPERATION`. An item with no body, or with
`body` together with `textBody` or `htmlBody`, fails on its own with `INVALID_QUERY`. If the
signature cannot be read, the item fails with `DATABASE_ERROR`. The gateway never creates a draft
without its signature.

**Time budget.** A call has a time budget of 45 seconds, measured from its start, because the
serverless function that runs it stops at 60 seconds. Before it starts an entry, the gateway checks
that the remaining budget covers one provider timeout (20 seconds) plus a 5-second margin for the
writes around it. An entry that does not fit fails with the retryable `BATCH_TIME_BUDGET_EXCEEDED`
and an `errorMessage`. Nothing was created for it and no quota was used. Call the tool again with
those entries. Repeating entries that already succeeded is harmless: they come back as
`duplicate`.

**Idempotency.** The key is campaign + normalized recipient + sequence step. A retry returns
`duplicate` and creates no second draft.

### 7. `create_reply_draft`

**Purpose.** Create a reply draft in the thread and mailbox of the source message.

**Input.** `mailboxId`, `sourceMessageId`, `replyMode` (`reply|replyAll`) and a body (`body` in
Markdown, recommended, or `textBody` and/or `htmlBody`). Optional: `fromAddress`,
`includeSignature` (default `true`), `campaignId`, `prospectId`. There is no input to change the
mailbox, and the sender must be an identity registered on that mailbox. The body holds only the
reply. The gateway adds the signature and the quoted original. See
[Body, signature and quoting](#body-signature-and-quoting).

**Output.** A draft result with `status`, `duplicatePrevented`, `internalDraftId`, the provider id,
`mailboxId` and `providerWebUrl` when available.

**Errors and limits.** Provider timeout of 20 seconds. Possible codes: `INVALID_QUERY`,
`MAILBOX_NOT_FOUND`, `MAILBOX_DISABLED`, `AUTH_REQUIRED`, `MESSAGE_NOT_FOUND`, `DUPLICATE_DRAFT`,
`DATABASE_ERROR`, `PROVIDER_RATE_LIMIT`, `PROVIDER_TIMEOUT`, `PROVIDER_UNAVAILABLE`,
`UNSUPPORTED_OPERATION`.

**Idempotency.** The key is mailbox + source message + mode + a hash of the body as the client sent
it, not of the signed body. Changing the signature does not turn a retry into a second draft.

### 8. `send_draft`

**Purpose.** Send an existing, gateway-managed draft, including reply drafts, without human
approval of each message.

**Input.** Only `internalDraftId`, taken from creation, a campaign listing or adoption. The tool
accepts no provider ids, recipients, subject or content.

**Output.** A summary with `status="sent"`, `alreadySent`, `acceptedAt` and
`providerSentMessageId` when the provider returns one. `alreadySent=true` means an earlier call had
already completed the send and no new provider request was made.

**Errors and limits.** The send quota is independent of the draft quota. Each send needs capacity
in the mailbox aggregate limit and in the limit of the specific primary or alias identity. The
persistent states are `created|updated → sending → sent`. A definitive rejection
(`PROVIDER_REJECTED` and the other definitive codes) restores the draft and releases both quotas.
The message carries the HTTP status and the provider's explanation. An ambiguous timeout or network
error produces `send_unknown` and `SEND_STATUS_UNKNOWN`, keeps the quota and blocks automatic retry.
Only `reconcile_draft_send` leaves that state. `sent` means accepted by the provider, not delivered
to the recipient.

**Delivery scopes.** Before it commits quota, the gateway compares the scopes of the recorded grant
with the scopes that delivery needs. If one is missing, the call ends at once with `AUTH_REQUIRED`.
The error names the mailbox, the missing scopes and the `/oauth/<provider>/start` route to
reconnect. No quota is consumed, no provider call is made and retrying does not help.

### 9. `adopt_external_drafts`

**Purpose.** Bring up to 50 legacy or hand-made drafts under gateway management without recreating
them and without needing their original `campaignId`.

**Input.** `mailboxId` and `providerMessageIds[]` from `search_emails` with `folder="drafts"`.
`campaignId` is optional and only organizes the drafts. On Gmail the gateway resolves the message
id to the stable draft id.

**Output.** Results in input order with status `adopted|alreadyManaged|failed`, a summary and
`draft.internalDraftId` for the update and delete tools. A failed result carries `errorCode`, and
can also carry `errorMessage` where the code alone does not say what to do.

**Errors and limits.** The provider verifies each item live as an unsent draft. Received, sent or
vanished messages return `DRAFT_NOT_FOUND` and do not become editable. Maximum 50 items. Partial
success. Provider timeout of 20 seconds per item. Adoption does not use draft quota.

**Time budget.** The same budget as [`create_outreach_drafts`](#6-create_outreach_drafts) applies.
An item the remaining budget cannot cover fails with the retryable `BATCH_TIME_BUDGET_EXCEEDED`
and an `errorMessage`, before the provider is read and before anything is stored for it. Call the
tool again with those items. Adopting an already managed draft again is harmless: it comes back as
`alreadyManaged`.

### 10. `update_outreach_draft`

**Purpose.** Update a draft that still exists, created by the gateway or adopted after a live check.

**Input.** `internalDraftId` and at least one new value among `subject`, `to`, `fromAddress` and the
body, given as `body` (Markdown, recommended) or as `textBody` and/or `htmlBody`.
`includeSignature` (default `true`) matters only when the body is replaced. `to` stays a single
address. `fromAddress` must be the primary address or an alias of the mailbox, and brings the
display name saved for that identity. A new body replaces the old one entirely. The gateway signs
it again for the draft's sending identity and, for a reply draft, quotes the original message
again. See [Body, signature and quoting](#body-signature-and-quoting). On Gmail, an update limited
to headers keeps the MIME body and attachments untouched.

**Output.** The updated summary with status `updated`, mailbox, provider, provider id, campaign,
prospect and `providerWebUrl` when available. `quoteRebuilt: true` appears only when, on a reply,
the provider could not keep the original quote and the gateway rebuilt it from the source message
alone, which loses earlier history. Otherwise the field is absent.

**Errors and limits.** `INVALID_QUERY`, `INVALID_RECIPIENT`, `DRAFT_NOT_FOUND`, `AUTH_REQUIRED`,
`DATABASE_ERROR`, `PROVIDER_RATE_LIMIT`, `PROVIDER_TIMEOUT`, `PROVIDER_UNAVAILABLE`,
`UNSUPPORTED_OPERATION`. An external draft must go through `adopt_external_drafts` first. Received
and delivered messages stay out of reach.

### 11. `delete_outreach_draft`

**Purpose.** Delete a draft registered by the gateway, and only such a draft.

**Input.** `internalDraftId`. Provider ids are not accepted.

**Output.** The draft summary with status `deleted`.

**Errors and limits.** `DRAFT_NOT_FOUND`, `AUTH_REQUIRED`, `PROVIDER_RATE_LIMIT`,
`PROVIDER_TIMEOUT`, `PROVIDER_UNAVAILABLE`, `UNSUPPORTED_OPERATION`. A provider 404 for an already
missing draft counts as a completed deletion. The tool has no path to received or delivered mail.

### 12. `delete_outreach_drafts`

**Purpose.** Delete up to 50 managed drafts in one call. Useful for legacy cleanup without 50 MCP
round trips.

**Input.** `internalDraftIds[]` from creation, a campaign listing or adoption.

**Output.** Results in order with status `deleted|failed`, and a summary. A failed item does not
block the others. A failed result carries `errorCode`, and can also carry `errorMessage` where the
code alone does not say what to do.

**Errors and limits.** Same guarantees as the single tool. Every id must belong to a managed draft.
Partial success. Maximum 50.

**Time budget.** The same budget as [`create_outreach_drafts`](#6-create_outreach_drafts) applies.
An id the remaining budget cannot cover fails with the retryable `BATCH_TIME_BUDGET_EXCEEDED` and
an `errorMessage`, before the provider is called. Call the tool again with those ids.

### 13. `list_campaign_drafts`

**Purpose.** List the known drafts of a campaign and recover their `internalDraftId` values.

**Input.** `campaignId`. Optional `status`
(`creating|created|updated|sending|sent|send_unknown|deleted|failed`).

**Output.** `{campaignId, drafts}`. Each summary has status, mailbox, provider, recipient, sequence
step, provider id, error code and `providerWebUrl` when present.

**Errors and limits.** Infrastructure errors `DATABASE_ERROR` and `INTERNAL_ERROR`. No provider call
and no provider quota.

### 14. `get_draft_status`

**Purpose.** Combine the gateway record with a live check that the draft still exists at the
provider.

**Input.** `internalDraftId`.

**Output.** The draft summary plus `stillExists`. `providerCheckErrorCode` appears when the check is
inconclusive. For a `sent` draft, `stillExists=false` is expected because the draft has left the
Drafts folder. `reconciliationHint` appears when the send outcome is unknown and only
`reconcile_draft_send` can close it.

**Errors and limits.** `DRAFT_NOT_FOUND` when the id does not belong to the gateway. The live check
can report `AUTH_REQUIRED`, `PROVIDER_RATE_LIMIT`, `PROVIDER_TIMEOUT`, `PROVIDER_UNAVAILABLE` or
`UNSUPPORTED_OPERATION` in `providerCheckErrorCode`. A provider 404 yields `stillExists=false`.

### 15. `list_outreach_replies`

**Purpose.** Search the mailboxes that hold outreach references for inbound messages that can be
tied to known campaigns.

**Input.** Optional `campaignId`, `mailboxIds[]`, `since` (ISO 8601, default 14 days ago),
`unreadOnly` and `limit`.

**Output.** `{replies, partialFailures}`. Each reply has `campaignId`, `prospectId?`, `mailboxId`,
`sourceMessageId`, `threadId?`, `from`, `subject`, `receivedAt`, `isUnread`, `snippet`,
`matchMethod` and `confidence`. Matches are deduplicated and sorted newest first.

**Errors and limits.** Default 20 and maximum 50 results. The tool examines at most 50 candidates
per mailbox, over a default window of 14 days, with a 10-second timeout per provider. Mailbox and
provider errors appear in `partialFailures`: `MAILBOX_NOT_FOUND`, `MAILBOX_DISABLED`,
`AUTH_REQUIRED`, `PROVIDER_RATE_LIMIT`, `PROVIDER_TIMEOUT`, `PROVIDER_UNAVAILABLE`,
`UNSUPPORTED_OPERATION`.

**Match methods and confidence.**

| `matchMethod`          | Confidence |
| ---------------------- | ---------- |
| `thread`               | 0.95       |
| `inReplyTo`            | 0.90       |
| `references`           | 0.85       |
| `messageId`            | 0.80       |
| `recipientSubjectTime` | 0.50       |

A match below 0.80 is a hint, not a certain reply. Check the thread with `get_email_thread` and
the message with `get_email` before you act on it.

### 16. `reconcile_draft_send`

**Purpose.** Close a send whose outcome is unknown, using evidence from the mailbox. This is the
only exit from `SEND_STATUS_UNKNOWN`. No other tool moves a row out of `send_unknown`.

**Input.** Only `internalDraftId`. The tool accepts rows in `send_unknown`, and rows in `sending`
that are older than two provider timeouts (40 seconds), which an interrupted process leaves behind.
A row that is already `sent` answers `outcome="sent"` idempotently without contacting the provider.
Any other state returns `INVALID_QUERY`.

**Output.** The draft summary plus `outcome`, `evidence` and, when an explanation helps, `reason`.
`evidence.draftStillPresent` is the result of the Drafts folder check. `evidence.sentMatchFound` is
the result of the Sent search. Each is `undefined` when the provider could not answer.

| Provider         | Evidence                                       | `outcome`    |
| ---------------- | ---------------------------------------------- | ------------ |
| all              | copy in Sent to the same recipient and subject | `sent`       |
| gmail, microsoft | draft still in Drafts, no copy in Sent         | `not_sent`   |
| zoho             | no copy in Sent and row older than 5 minutes   | `not_sent`   |
| all              | failed search or insufficient evidence         | `unresolved` |

`sent` records the delivery with the `providerSentMessageId` found in Sent. `not_sent` returns the
draft to `created`, gives back the send quota claimed for it, keeps `lastErrorCode` and makes the
draft sendable again with `send_draft`. `unresolved` writes nothing. The row stays as it was and the
call can be repeated later.

**Errors and limits.** Gmail and Microsoft consume the draft while sending, so a draft that is still
present proves the send did not happen. Zoho creates a separate message and the gateway deletes the
draft afterwards, so the only evidence there is the Sent folder. Matching compares the normalized
recipient and subject and a date not earlier than the claim, with one minute of tolerance. Each
provider call is bound by the 20-second timeout. Each run leaves a `draft_operations` row with
`operation="reconcile"`. The tool depends on the `SEND_EMAILS` feature flag.

## Body, signature and quoting

The gateway alone renders message bodies. Whatever form the body takes, every provider receives a
text part and an email-safe HTML part. Every tool that writes a body (`create_outreach_drafts`,
`create_reply_draft`, `update_outreach_draft`) accepts `body` on its own, or `textBody` and/or
`htmlBody`. A missing body, or `body` combined with either of the other two, returns
`INVALID_QUERY`. Empty fields count as absent.

- **`body` (Markdown, recommended).** A blank line starts a new paragraph. A single line break stays
  a line break. The renderer supports `**bold**`, `*italic*`, bullet and numbered lists and
  `[text](https://…)` links. Each paragraph becomes a `<p>` with an inline margin, so spacing
  survives in Outlook. This is the form built for LLMs, which tend to lose blank-line paragraph
  breaks in HTML.
- **`textBody`.** Plain text. Line breaks are kept, a blank line starts a paragraph and URLs become
  links in the HTML part.
- **`htmlBody`.** Email-safe HTML: links (`<a href="https://…">`), `<strong>`, `<em>`, `<u>`, `<p>`,
  `<br>`, lists and `<blockquote>`, with absolute URLs, preferably HTTPS. Scripts, forms, external
  styles and active content are removed. If the HTML has no block tags, line breaks become
  paragraphs. The text part is derived from the HTML unless `textBody` is also given. In that case
  the HTML comes from `htmlBody` and `textBody`, with line breaks normalized, becomes the text part.
  Signature and quote apply to both parts either way.

**Signature.** The gateway appends the signature saved for the sending identity. The identity is the
primary address or alias in `fromAddress`, or else the mailbox's primary address. The text part gets
a `-- ` separator and the HTML part gets a `gmail_signature` block. In the text part, each row of a
table in the signature is its own line, and its cells are separated by spaces. Manage signatures in the admin
dashboard: import from Gmail, or paste them by hand for Microsoft and Zoho. See
[Signatures](OPERATIONS.md#signatures).

The display name saved with a signature goes into the From header. When one exists, a draft with no
`fromAddress` still gets the primary address set explicitly as sender, so that it can carry the
name. `includeSignature: false` skips the signature but keeps the display name. Use it only when the
message must end exactly where the body ends. An identity with no saved signature produces a draft
with no signature and an unchanged From header. If the signature table cannot be read, the tool
fails with `DATABASE_ERROR` and does not create a draft without a signature. Do not write a
signature by hand in the body, or it appears twice.

**Quoting in replies.** `create_reply_draft` asks the adapter to quote the original message below
the signature, as mail clients do. The quote is an attribution line (`On <date> <sender> wrote:`)
followed by the original in a `gmail_quote` `blockquote`. The text part gets the same lines prefixed
with `>`. When `update_outreach_draft` replaces the body of a reply draft, the original is quoted
again, so history is not lost. The attribution date uses the `GATEWAY_TIME_ZONE` zone, an IANA name
such as `Europe/Rome` with default `UTC`, validated at startup. The body must hold only the new
reply. Do not paste the original into it.

On Outlook, the quote stays the one that Microsoft Graph composes: a From/Sent/To header and the
whole conversation. The new body is wrapped in a `yempik_reply_body` container, and
`update_outreach_draft` replaces only its content and keeps the quote byte for byte. If the
container is missing (the draft was edited by hand in Outlook, or created by an older version), the
gateway rebuilds the quote in Gmail style from the source message and the update answers with
`quoteRebuilt: true`.

Gmail creates a `multipart/alternative` message with both parts. Outlook and Zoho use the HTML part.

## Error codes

| Code                         | Operational meaning                                                        |
| ---------------------------- | -------------------------------------------------------------------------- |
| `AUTH_REQUIRED`              | Mailbox must be connected or reconnected.                                  |
| `TOKEN_EXPIRED`              | Token expired. Reconnect.                                                  |
| `TOKEN_REVOKED`              | Token or consent revoked. Reconnect.                                       |
| `MAILBOX_MISMATCH`           | The OAuth account differs from the configured address.                     |
| `MAILBOX_DISABLED`           | Mailbox switched off by an operator.                                       |
| `MAILBOX_NOT_FOUND`          | Unknown mailbox id.                                                        |
| `DAILY_LIMIT_REACHED`        | Daily draft or send quota used up.                                         |
| `PER_RUN_LIMIT_REACHED`      | Draft quota for the single call used up.                                   |
| `BATCH_TIME_BUDGET_EXCEEDED` | Retryable. The batch ran out of time before this entry. Call again.        |
| `INVALID_RECIPIENT`          | Invalid recipient.                                                         |
| `INVALID_QUERY`              | Invalid input, filter or cursor.                                           |
| `DUPLICATE_DRAFT`            | Draft already exists for the idempotency key.                              |
| `MESSAGE_NOT_FOUND`          | Source message not found.                                                  |
| `THREAD_NOT_FOUND`           | Thread not found.                                                          |
| `DRAFT_NOT_FOUND`            | Not a gateway id, draft removed, or no longer editable.                    |
| `SEND_STATUS_UNKNOWN`        | The send may have been accepted. Do not retry. Use `reconcile_draft_send`. |
| `PROVIDER_RATE_LIMIT`        | Temporary provider quota. Respect `retryAfterSeconds`.                     |
| `PROVIDER_TIMEOUT`           | Provider exceeded the timeout.                                             |
| `PROVIDER_UNAVAILABLE`       | Provider temporarily unavailable.                                          |
| `PROVIDER_REJECTED`          | Definitive provider refusal. The message cites the HTTP status.            |
| `UNSUPPORTED_OPERATION`      | Adapter or capability not configured.                                      |
| `DATABASE_ERROR`             | PostgreSQL unavailable or the operation failed.                            |
| `INTERNAL_ERROR`             | Unexpected error. Use the correlation id to find it in the logs.           |
