# Google OAuth setup

The gateway uses OAuth 2.0 delegated authorization with one separate connection per Gmail mailbox
(for example `gmail-sales` and `gmail-support`). Use a dedicated Google Cloud project for the
gateway. Do not share it with other applications.

## Google Cloud console

1. Select your project and enable the **Gmail API**.
2. Configure the OAuth consent screen. The data-access scopes must be exactly:
   - `https://www.googleapis.com/auth/gmail.readonly`
   - `https://www.googleapis.com/auth/gmail.compose`

   Do not add `gmail.send`, `gmail.modify` or `https://mail.google.com/`. The `gmail.compose` scope
   is enough to create a draft and to send an existing draft. The gateway does not implement
   arbitrary `users.messages.send`. See [SECURITY.md](SECURITY.md).

3. Create an OAuth client of type **Web application**, for example named `Mail Gateway`:
   - Authorized JavaScript origins: `http://localhost:3000` and `https://mail.example.com`
   - Authorized redirect URIs: `http://localhost:3000/oauth/google/callback` and
     `https://mail.example.com/oauth/google/callback`

## Gateway configuration

Set these in `.env` (locally) or in the deployment environment:

| Variable                     | Value                                                                |
| ---------------------------- | -------------------------------------------------------------------- |
| `GOOGLE_OAUTH_CLIENT_ID`     | Client ID of the web application client                              |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Client secret of the web application client                          |
| `PUBLIC_BASE_URL`            | `http://localhost:3000` locally, your public HTTPS URL in production |
| `OAUTH_STATE_SECRET`         | Random string (16 or more characters) that signs the OAuth `state`   |
| `ADMIN_DASHBOARD_SECRET`     | Password that protects the connect flow (HTTP Basic)                 |

The OAuth routes register only when all four variables are present. The server boots without them
and logs `googleOAuth: disabled`.

## Connecting a mailbox

1. Open `PUBLIC_BASE_URL/oauth/google/start?mailboxId=gmail-sales` in a browser. Use the id of a
   mailbox that exists in the registry (see [OPERATIONS.md](OPERATIONS.md#register-mailboxes)).
2. Authenticate with any username and `ADMIN_DASHBOARD_SECRET` as the password.
3. Complete the Google login with the account configured for that mailbox. The gateway checks the
   authenticated address against the mailbox registry. A different account is rejected with
   `MAILBOX_MISMATCH` and nothing is stored.
4. On success, the refresh token is encrypted (AES-256-GCM) and stored, and the mailbox becomes
   `connected`. Repeat for each Gmail mailbox. Mailboxes are independent, so connecting only one is
   a supported state.

Reconnecting uses the same flow. The gateway retires the previous token version automatically.

## Troubleshooting

- **`AUTH_REQUIRED`, no refresh token returned.** The account still has a prior grant. Remove the
  app at <https://myaccount.google.com/permissions> and retry. The flow already forces
  `prompt=consent`.
- **`MAILBOX_MISMATCH`.** The wrong Google account was used. Retry with the address that
  `list_mailboxes` shows for that mailbox id.
- **State errors.** The link is older than 10 minutes, or another instance with a different
  `OAUTH_STATE_SECRET` built it. Restart from `/oauth/google/start`.
