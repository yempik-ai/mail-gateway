# Zoho Mail setup

The gateway uses OAuth 2.0 delegated authorization for Zoho Mail mailboxes (for example
`zoho-sales`).

Zoho is a multi-datacenter product, and the datacenter is part of every address. A token minted on
`accounts.zoho.eu` is valid only against `mail.zoho.eu`. `ZOHO_REGION` must match the datacenter
where your Zoho organization was created. An account created through `mail.zoho.eu` is `eu`.

## Before the app registration

1. Add your domain in the Zoho Mail admin console and complete domain verification.
2. Publish the Zoho MX records, then SPF, DKIM and DMARC, before any mail leaves the domain.
3. Create the mailbox user that the gateway will connect and note its exact address.

## Zoho API console

1. Open the Zoho API console for the same datacenter (`https://api-console.zoho.eu` for `eu`) and
   create a **Server-based Application**, for example named `Mail Gateway`.
2. Set the **Authorized Redirect URI** to the gateway callback:
   - `http://localhost:3000/oauth/zoho/callback`
   - `https://mail.example.com/oauth/zoho/callback`
3. Record the **Client ID** and **Client Secret**. Store the secret in the deployment environment,
   never in the repository.

The gateway requests these scopes:

| Scope                      | Why                                             |
| -------------------------- | ----------------------------------------------- |
| `ZohoMail.accounts.READ`   | Resolve the account id and verify the identity  |
| `ZohoMail.folders.READ`    | Resolve the Inbox, Sent and Drafts folder ids   |
| `ZohoMail.messages.READ`   | Search, read messages and read RFC 5322 headers |
| `ZohoMail.messages.CREATE` | Create and deliver managed drafts               |
| `ZohoMail.messages.DELETE` | Delete gateway drafts                           |

Zoho has no scope that separates drafting from sending. The gateway uses the
`ZohoMail.messages.CREATE` grant but exposes delivery only for a gateway-managed draft. See
[ADR 0003](ADR/0003-autonomous-draft-delivery.md) and [SECURITY.md](SECURITY.md).

## Gateway configuration

Set these in `.env` (locally) or in the deployment environment:

| Variable                 | Value                                                                |
| ------------------------ | -------------------------------------------------------------------- |
| `ZOHO_CLIENT_ID`         | Client ID from the Zoho API console                                  |
| `ZOHO_CLIENT_SECRET`     | Client secret from the Zoho API console                              |
| `ZOHO_REGION`            | `eu` or `com`. Must match the account's datacenter                   |
| `PUBLIC_BASE_URL`        | `http://localhost:3000` locally, your public HTTPS URL in production |
| `OAUTH_STATE_SECRET`     | Random string (16 or more characters) that signs the OAuth `state`   |
| `ADMIN_DASHBOARD_SECRET` | Password that protects the connect flow (HTTP Basic)                 |

The Zoho OAuth routes register only when `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`,
`OAUTH_STATE_SECRET` and `ADMIN_DASHBOARD_SECRET` are all present. The server boots without them.

The mailbox itself is a row in the registry. Register it as described in
[OPERATIONS.md](OPERATIONS.md#register-mailboxes) and [CONFIGURATION.md](CONFIGURATION.md). To
seed from a registry file, apply the migrations and run the seed. You can also add the mailbox from
`/admin` after the migrations:

```sh
pnpm db:migrate && pnpm db:seed
```

## Connecting a mailbox

1. Open `PUBLIC_BASE_URL/oauth/zoho/start?mailboxId=zoho-sales` in a browser. Use the id of a
   mailbox that exists in the registry.
2. Authenticate with any username and `ADMIN_DASHBOARD_SECRET` as the password.
3. Sign in to Zoho with the account configured for the mailbox and grant the requested scopes.
4. The gateway reads the primary address from `GET /api/accounts` and compares it with the mailbox
   registry. A different account is rejected with `MAILBOX_MISMATCH` and nothing is stored.
5. On success, the refresh token is encrypted with AES-256-GCM and stored, and the mailbox becomes
   `connected`.

Zoho refresh tokens do not expire and are not rotated on use. You need to reconnect only after a
revocation. Zoho limits how many refresh tokens a client may hold per user, so repeated
reconnections eventually invalidate the oldest.

## Verifying against a live account

The adapter is written against Zoho's published API shapes. Confirm four details on the first real
connection, because a wrong guess is silent rather than loud:

1. **Read flag.** The adapter reads `status: "1"` as read. Mark a message unread in the web client
   and confirm that `search_emails` reports `isRead: false`.
2. **Draft response fields.** `createDraft` expects `messageId` and, ideally, `folderId` in the
   response. It falls back to the resolved Drafts folder when `folderId` is absent. Confirm that the
   returned draft id resolves back to the draft.
3. **Folder naming.** Folder resolution matches `folderType` or `folderName` against `inbox`,
   `sent`, `drafts` and `archive`. Zoho has no standard Archive folder. A search with
   `folder: "archive"` falls back to an unscoped listing when none exists.
4. **Unread filter.** A folder listing with `unreadOnly` sends `status=unread` to the list endpoint.
   If Zoho expects another value, it answers HTTP 400 and the gateway raises `INVALID_QUERY`. That
   failure is loud. Run one `search_emails` call with `unreadOnly: true` to confirm.

## Troubleshooting

- **`AUTH_REQUIRED`, no refresh token returned.** Zoho issues one only when both
  `access_type=offline` and `prompt=consent` are present, and only on a fresh consent. Revoke the
  app under **Zoho Accounts > Security > OAuth Apps** and reconnect.
- **`AUTH_REQUIRED`, missing scope.** The consent screen was completed with a reduced scope set.
  Revoke and reconnect, and grant every requested scope.
- **`AUTH_REQUIRED` or `invalid_client`.** The client belongs to a different datacenter than
  `ZOHO_REGION`, or the redirect URI does not match the API console entry exactly.
- **`MAILBOX_MISMATCH`.** The wrong Zoho account was used, or its primary address differs from the
  address registered for the mailbox.
- **`TOKEN_REVOKED` or `invalid_grant`.** Consent was revoked, or Zoho's per-user token limit
  displaced the refresh token. Reconnect the mailbox.
- **`DRAFT_NOT_FOUND` on a draft that exists.** The draft reference is `folderId:messageId`. A draft
  moved out of the Drafts folder is refused by design.
- **State errors.** The link is older than 10 minutes, or another instance with a different
  `OAUTH_STATE_SECRET` built it. Restart from `/oauth/zoho/start`.
