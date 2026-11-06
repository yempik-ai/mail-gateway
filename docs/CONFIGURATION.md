# Mailbox configuration

The gateway keeps its mailboxes in the `mailboxes` table of its database. You can put them there in
two ways, and you can mix them:

- **Registry file + seed**: describe the mailboxes in a JSON file and run `pnpm db:seed`. Good for
  version-controlled, repeatable setups (several environments, disaster recovery).
- **Admin dashboard**: add and edit mailboxes on `/admin`. Good when you have no shell on the
  deployment (for example on Vercel) or only a few mailboxes.

Either way, a new mailbox starts **disconnected**. Click **Connect** on its row in the dashboard and
sign in to the account to authorize it. Provider app setup is described in
[Google OAuth](GOOGLE_OAUTH_SETUP.md), [Microsoft Entra](MICROSOFT_ENTRA_SETUP.md) and
[Zoho Mail](ZOHO_MAIL_SETUP.md).

## Registry file

### Location

`pnpm db:seed` reads the file named by `MAILBOXES_FILE`.

| `MAILBOXES_FILE` | Behavior                                                               |
| ---------------- | ---------------------------------------------------------------------- |
| unset or empty   | Reads `./mailboxes.json`. If it does not exist, mailboxes are skipped. |
| set              | Reads that file. If it does not exist, the seed fails.                 |

Relative paths are resolved from the repository root, wherever you run the command. `mailboxes.json`
is in `.gitignore`: it holds real addresses and tenant IDs. Start from the committed template:

```sh
cp mailboxes.example.json mailboxes.json
```

`MAILBOXES_FILE` is read by the seed only. The running gateway never reads the registry file.

### Format

The file is a JSON object with one `mailboxes` array. A complete example:

```json
{
  "mailboxes": [
    {
      "id": "outreach-gmail",
      "provider": "gmail",
      "emailAddress": "outreach@example.com",
      "displayName": "Example Outreach",
      "routingPriority": 1,
      "sendLimits": { "outreach@example.com": 10 }
    },
    {
      "id": "sales-outlook",
      "provider": "microsoft",
      "emailAddress": "hello@example.com",
      "aliases": ["sales@example.com"],
      "displayName": "Example Sales",
      "microsoftTenantId": "00000000-0000-0000-0000-000000000000",
      "routingPriority": 2,
      "perRunDraftLimit": 5,
      "dailyDraftLimit": 25,
      "sendLimits": { "hello@example.com": 10, "sales@example.com": 5 }
    },
    {
      "id": "team-zoho",
      "provider": "zoho",
      "emailAddress": "team@example.com",
      "routingPriority": 3,
      "enabled": false
    }
  ]
}
```

### Fields

| Field               | Required | Type                             | Default on a new mailbox     | Meaning                                                                                               |
| ------------------- | -------- | -------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------- |
| `id`                | yes      | string                           | none                         | Stable mailbox ID. 1-64 lowercase letters, digits or hyphens; starts and ends with a letter or digit. |
| `provider`          | yes      | `gmail` `microsoft` `zoho`       | none                         | Mail provider. `gmail` covers Gmail and Google Workspace.                                             |
| `emailAddress`      | yes      | email                            | none                         | Primary address: the account you sign in with when you connect.                                       |
| `aliases`           | no       | email[]                          | `[]`                         | Extra sending identities of the same account. See [Aliases](#aliases-and-sending-identities).         |
| `displayName`       | no       | string (1-120)                   | the primary address          | Internal label. The From name of drafts comes from the signature settings, not from here.             |
| `microsoftTenantId` | no       | tenant GUID or domain, or `null` | `null` (default tenant)      | Microsoft only. See [Microsoft tenant pinning](#microsoft-tenant-pinning).                            |
| `routingPriority`   | no       | integer ≥ 0                      | 1-based position in the file | Order for distributed draft routing. Lower goes first; ties are broken by `id`.                       |
| `perRunDraftLimit`  | no       | integer 0-1000                   | `5`                          | Most drafts one `create_outreach_drafts` call may put in this mailbox.                                |
| `dailyDraftLimit`   | no       | integer 0-1000                   | `25`                         | Most drafts per day in this mailbox.                                                                  |
| `sendLimits`        | no       | object: identity → 0-1000        | `10` per identity            | Daily send limit of each identity. See [Send limits](#send-limits-and-warm-up).                       |
| `enabled`           | no       | boolean                          | `true`                       | A disabled mailbox is skipped by routing and refused by the read and draft tools.                     |

Addresses are trimmed and lowercased. Unknown fields are rejected, so a typo fails loudly instead of
being ignored. An optional top-level `"$schema"` string is allowed for editor tooling.

The seed validates the whole file before it connects to the database and reports every problem with
its path, for example:

```text
mailboxes.json is not a valid mailbox registry:
mailboxes.1.microsoftTenantId: microsoftTenantId is only valid for microsoft mailboxes
mailboxes.2.sendLimits.other@example.com: other@example.com is neither the primary address nor an alias of this mailbox
```

The file is also rejected when two mailboxes share an `id`, or when one address (primary or alias)
appears on two mailboxes: each sending identity must belong to exactly one mailbox.

### How the seed writes

For each mailbox in the file, `pnpm db:seed` inserts the row, or updates the row with the same `id`.

- **Fields you set** in the file overwrite the stored values.
- **Fields you omit** keep their stored values on an existing row, and take the default above on a
  new row. So re-running the seed never resets limits that you raised later in the dashboard, unless
  the file sets them.
- **Mailboxes missing from the file** are left as they are. The seed never deletes or disables.
- `microsoftTenantId: null` removes a tenant pin; omitting it keeps the stored pin. A mailbox whose
  provider is not `microsoft` never keeps a pin: switching a mailbox away from Microsoft clears it.
- The seed does not touch connection state or tokens. A new row is `disconnected`.

Before it writes anything, the seed checks the file against every mailbox in the database. It
refuses the **whole file**, writes nothing and lists every problem, when an entry would:

- change the provider, primary address or Microsoft tenant of a mailbox that has an OAuth
  connection (the same lock as the dashboard, see below);
- claim an address (primary or alias) that belongs to a mailbox **not listed in the file**.

The writes then run in one transaction: either every mailbox in the file is written, or none is.
If an OAuth connection is stored for a mailbox while the seed runs, and the file changes that
mailbox's account, the seed rolls back and reports it.

Mailboxes listed in the file get the addresses the file gives them in the same seed. So you can
move an alias from one mailbox of the file to another in a single seed: remove it from the first
and add it to the second.

The seed also creates or updates the bootstrap MCP client when `MCP_CLIENT_ID` and
`MCP_CLIENT_SECRET` are set. That part does not depend on the registry file.

## Managing mailboxes in the dashboard

The **Mailboxes** section of `/admin` uses the same validation and the same defaults as the
registry file.

**Add a mailbox** takes an ID, a provider, a primary address, aliases (comma-separated), an
optional Microsoft tenant ID and an optional display name. The new mailbox is placed last in the
routing order and every identity starts at the warm-up send limit. Then click **Connect** on its row.

**Edit** on each row changes:

- display name and aliases;
- drafts per run and drafts per day;
- the daily send limit of each identity (an alias added in the same save starts at the warm-up
  limit; save, then raise it);
- provider, primary address and Microsoft tenant, **only while the mailbox has never been
  connected**.

Once a mailbox has an OAuth connection, its provider, primary address and tenant are locked. The
stored token belongs to that account, so changing them would leave the mailbox pointing at an
address its token cannot access. To move to another account, add a new mailbox with a new ID.
`pnpm db:seed` enforces the same lock (see [How the seed writes](#how-the-seed-writes)).

Switching an unconnected mailbox from Microsoft to another provider clears its tenant pin. The
tenant field is ignored for providers other than Microsoft, so a pin left in it does not block
the save.

**Enable** and **Disable** turn a mailbox on or off without deleting anything.

Every change is written to the audit log as `mailbox_create` or `mailbox_update`, with the mailbox
ID and the names of the changed fields. Addresses are not written to the audit log.

## Send limits and warm-up

Every sending identity (the primary address and each alias) has its own daily send limit, stored in
`daily_send_limits_by_identity`. The mailbox also has an aggregate `daily_send_limit`, which the
gateway sets to the **sum** of the identity limits. A send needs room under both.

- Draft limits (`perRunDraftLimit`, `dailyDraftLimit`) and send limits are counted separately.
- Counters are per UTC calendar day.
- `0` blocks sending from that identity. Reading and drafting still work.

**Warm-up.** New domains and mailboxes that send at full volume on day one look like spam to the
receiving providers. Every identity without an explicit limit therefore starts at **10 sends per
day**. A reasonable plan:

1. Start at 10 per day per identity.
2. Raise by about 10 per week while bounces and spam complaints stay low.
3. Stop around 40-50 per day per identity for cold outreach, and keep reply traffic in mind.

Raise limits in the dashboard (**Edit** → **Sends per day, per identity**) or in the registry file
followed by `pnpm db:seed`. If you use both, update the file too, otherwise the next seed puts the
file's value back.

## Aliases and sending identities

An alias is another address of the **same account**: it shares the login, the token and the Drafts
folder of its mailbox. Register it as an alias, never as a separate mailbox.

- The alias must already be a sending address on the provider side: a verified **Send mail as**
  address in Gmail, a proxy address of the same mailbox in Microsoft 365 (with sending from aliases
  allowed in Exchange Online), or an email alias of the account in Zoho Mail.
- A draft chooses its identity with `fromAddress`. It must be the primary address or one of the
  aliases of that mailbox; any other address is refused. Without `fromAddress`, the primary address
  is used.
- Each identity has its own send limit and its own signature. Signatures are managed in the
  **Signatures** section of `/admin`; Gmail signatures can be imported, the others are pasted.

## Provider-specific settings

### Gmail and Google Workspace

No per-mailbox settings. The Google OAuth client is configured with `GOOGLE_OAUTH_CLIENT_ID` and
`GOOGLE_OAUTH_CLIENT_SECRET`. When you connect, the account you sign in with must be the mailbox's
primary address; otherwise the connection fails with `MAILBOX_MISMATCH`.

### Microsoft tenant pinning

The gateway uses one multi-tenant Entra application. Every authorization and token request is sent
to one specific tenant, never to `common` or `organizations`:

- `microsoftTenantId` set on the mailbox: that tenant.
- `microsoftTenantId` empty or `null`: the deployment default, `MICROSOFT_TENANT_ID`.

Set `microsoftTenantId` only for a mailbox whose domain lives in a **different** Microsoft 365
tenant than the default one. The value is the tenant ID (a GUID) or one of its verified domains,
for example `contoso.onmicrosoft.com`. That tenant must grant admin consent to the application the
first time you connect. See [ADR 0001](ADR/0001-multitenant-entra-app-with-tenant-pinning.md).

The pin is locked once the mailbox is connected: the token was issued by that tenant. On an
unconnected mailbox, switching the provider away from Microsoft clears the pin, in the dashboard and
in the seed.

### Zoho Mail region

Zoho is split into datacenters, and a token issued by one only works against the same one. The
datacenter is a deployment setting, not a mailbox setting:

| `ZOHO_REGION`  | Accounts host               | Mail API host           |
| -------------- | --------------------------- | ----------------------- |
| `eu` (default) | `https://accounts.zoho.eu`  | `https://mail.zoho.eu`  |
| `com`          | `https://accounts.zoho.com` | `https://mail.zoho.com` |

All Zoho mailboxes of one deployment must be in the region set by `ZOHO_REGION`.
