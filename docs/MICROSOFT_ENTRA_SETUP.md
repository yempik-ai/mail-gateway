# Microsoft Entra setup

The gateway uses OAuth 2.0 delegated authorization for Microsoft 365 mailboxes. The app
registration must be multi-tenant and dedicated to the gateway. Each mailbox can be pinned to its
own Microsoft Entra tenant. The gateway never uses `/common` or `/organizations` for authorize or
token endpoints. See [ADR 0001](ADR/0001-multitenant-entra-app-with-tenant-pinning.md).

## Microsoft Entra admin center

1. In **Microsoft Entra ID > App registrations**, create a registration, for example named
   `Mail Gateway`.
2. Set **Supported account types** to **Accounts in any organizational directory** (multi-tenant,
   `AzureADMultipleOrgs`). Under **Authentication > Supported accounts**, choose **Allow only
   specific tenants** and add every tenant that hosts a pinned mailbox. The home tenant is always
   allowed. Fall back to allowing all tenants only if the preview allow-list misbehaves.
3. Under **Authentication**, add a **Web** platform with these redirect URIs:
   - `http://localhost:3000/oauth/microsoft/callback`
   - `https://mail.example.com/oauth/microsoft/callback`
4. Under **API permissions**, add these Microsoft Graph **Delegated permissions**:
   - `Mail.ReadWrite`
   - `Mail.Send`
   - `offline_access`
   - `openid`
   - `profile`

   `Mail.ReadWrite` manages drafts. `Mail.Send` delivers an existing draft. Both are delegated to
   the signed-in mailbox. Do not configure the application-wide permission.

5. Under **Certificates & secrets**, create a client secret and record its value immediately. Store
   it in the deployment environment, never in the repository.

## Gateway configuration

Set these in `.env` (locally) or in the deployment environment:

| Variable                  | Value                                                                |
| ------------------------- | -------------------------------------------------------------------- |
| `MICROSOFT_TENANT_ID`     | Default tenant ID for Microsoft mailboxes without their own pin      |
| `MICROSOFT_CLIENT_ID`     | Application (client) ID from the app registration overview           |
| `MICROSOFT_CLIENT_SECRET` | Value of the client secret, not its secret ID                        |
| `PUBLIC_BASE_URL`         | `http://localhost:3000` locally, your public HTTPS URL in production |
| `OAUTH_STATE_SECRET`      | Random string (16 or more characters) that signs the OAuth `state`   |
| `ADMIN_DASHBOARD_SECRET`  | Password that protects the connect flow (HTTP Basic)                 |

The Microsoft OAuth routes register only when the three `MICROSOFT_*` variables plus
`OAUTH_STATE_SECRET` and `ADMIN_DASHBOARD_SECRET` are present. The server boots without them.

### Tenant pinning

A mailbox row has an optional `microsoft_tenant_id`. If it is set, the gateway sends authorize, code
exchange and refresh requests to that tenant. If it is `NULL`, the gateway uses
`MICROSOFT_TENANT_ID`. To pin a mailbox that lives in another tenant, set its tenant id when you
register it: in the dashboard's **Add a mailbox** form, or as `microsoftTenantId` in the mailbox
registry file (see [CONFIGURATION.md](CONFIGURATION.md#microsoft-tenant-pinning) and
[OPERATIONS.md](OPERATIONS.md#register-mailboxes)). The pin is locked once the mailbox is connected.

Add every pinned tenant to the app's tenant allow-list, and have an administrator of that tenant
grant consent before the first connection.

## Connecting a mailbox

1. Open the connect URL for the mailbox in a browser:
   `PUBLIC_BASE_URL/oauth/microsoft/start?mailboxId=outlook-sales`. Use the id of a mailbox that
   exists in the registry.
2. Authenticate with any username and `ADMIN_DASHBOARD_SECRET` as the password.
3. Complete the Microsoft login in the mailbox's tenant with the account configured for that
   mailbox, then grant the requested delegated permissions.
4. For the first connection in a secondary tenant, a Global Administrator of that tenant must grant
   admin consent. An unverified-publisher prompt is expected there and is not an error.
5. The gateway reads the authenticated address from Microsoft Graph and compares it with the mailbox
   registry. A different account is rejected with `MAILBOX_MISMATCH` and nothing is stored.
6. On success, the refresh token is encrypted with AES-256-GCM and stored, and the mailbox becomes
   `connected`.

Reconnecting uses the same flow. The gateway retires the previous token version automatically.
Connections created before `Mail.Send` was added must be reconnected to receive the new grant.

## Troubleshooting

- **`AADSTS50011` or redirect URI mismatch.** Add the exact callback URL above as a **Web** redirect
  URI. Make sure `PUBLIC_BASE_URL` has the matching scheme and host.
- **`AUTH_REQUIRED`, no refresh token returned.** Check that `offline_access` is configured and
  granted. Then revoke the user's existing consent and reconnect.
- **`AUTH_REQUIRED`, `Mail.ReadWrite` or `Mail.Send` missing.** Add both delegated Microsoft Graph
  permissions, grant consent if your tenant policy requires it, and restart the connection flow.
- **`MAILBOX_MISMATCH`.** The wrong Microsoft account was used, or its `mail` or user principal name
  does not match the address configured for the selected mailbox.
- **Admin consent or unverified publisher.** Use a Global Administrator of the secondary tenant for
  the first connection. The unverified-publisher warning is expected. Check the app name, client ID
  and requested permissions before you grant consent.
- **`TOKEN_REVOKED` or `invalid_grant`.** The refresh token or the app consent was revoked, the
  client secret expired, or tenant policy invalidated the session. Create a new secret if needed and
  reconnect the mailbox.
- **State errors.** The link is older than 10 minutes, or another instance with a different
  `OAUTH_STATE_SECRET` built it. Restart from `/oauth/microsoft/start`.
