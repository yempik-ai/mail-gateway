# ADR 0001: Multi-tenant Entra app with tenant pinning

Status: accepted.

## Context

A deployment can need Microsoft 365 mailboxes that live in different Microsoft Entra tenants. For
example, one domain may be hosted in a separately purchased tenant. A single-tenant app
registration and one global tenant for every Microsoft mailbox cannot authorize such a mailbox
without changing the tenant model.

## Decision

Use one multi-tenant Entra app registration with per-mailbox tenant pinning. Store the pinned
tenant in the nullable `mailboxes.microsoft_tenant_id` column. A `NULL` value falls back to the
global `MICROSOFT_TENANT_ID`. This keeps the behavior of mailboxes that have no pin.

Build every Microsoft authorize and token endpoint with the tenant resolved for that mailbox. Never
use `/common` or `/organizations`.

## Alternatives considered

- **Consolidate the domain into the existing tenant.** This removes the cross-tenant requirement.
  It also changes the ownership boundary of the other tenant, which is often not possible.
- **Create a second single-tenant app registration with per-mailbox client credentials.** This keeps
  registrations single-tenant. It adds credential selection, secret rotation and duplicated app
  configuration for every mailbox.

## Consequences

A multi-tenant registration can be consented to from any Microsoft Entra tenant. To limit that
exposure, use the Entra tenant allow-list ("Allow only specific tenants", in preview at the time of
writing). Only the home tenant and the pinned tenants may consent. If the preview feature regresses,
the fallback is to allow all tenants. Three controls still apply in that case: the HMAC-signed OAuth
state, the `MAILBOX_MISMATCH` identity check and the admin-gated connect flow.

An administrator of each secondary tenant must grant admin consent for the app. An
unverified-publisher consent prompt is expected there. It is not, by itself, an error.
