# Architecture decision records

Each record states a decision, the context behind it, the alternatives that were rejected and the
consequences.

| ADR                                                       | Title                                             | Status                                 |
| --------------------------------------------------------- | ------------------------------------------------- | -------------------------------------- |
| [0001](0001-multitenant-entra-app-with-tenant-pinning.md) | Multi-tenant Entra app with tenant pinning        | Accepted                               |
| [0002](0002-zoho-provider-code-level-non-delivery.md)     | Zoho as a third provider                          | Accepted; non-delivery part superseded |
| [0003](0003-autonomous-draft-delivery.md)                 | Autonomous, idempotent delivery of managed drafts | Accepted                               |

ADR 0003 supersedes the non-delivery rule in ADR 0002. The gateway keeps delegated OAuth per
mailbox, provider-neutral tools, PostgreSQL with encrypted tokens, no permanent email-body storage
and stable prospect assignments.
