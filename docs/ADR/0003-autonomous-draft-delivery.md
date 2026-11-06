# ADR 0003: Autonomous delivery of managed drafts

Status: accepted. Supersedes the non-delivery decision in
[ADR 0002](0002-zoho-provider-code-level-non-delivery.md).

## Context

The gateway began as a read-and-draft system with manual delivery as its approval gate. The
cross-provider draft, identity, routing, quota and audit flows then proved stable. The product
requirement changed: authenticated LLM clients must be able to deliver the messages they create
without a human click on each one.

Provider calls are not uniformly idempotent. A timeout can happen after a provider accepted a
message but before the gateway received the response. A blind retry would risk sending the same
message twice.

## Decision

Expose `send_draft`. It accepts only the gateway's `internalDraftId`. Do not expose recipients,
subject, body or raw provider ids at delivery time. The message must already exist as a live,
gateway-managed draft.

Claim delivery atomically with a persistent state transition. Apply independent daily send quotas
to the mailbox aggregate and to the exact primary or alias identity stored on the draft.

```text
created | updated → sending → sent
                           ↘ send_unknown
```

A definitive rejection restores the previous draft state and releases the reserved quota. A
timeout, network failure or persistence failure after provider contact becomes `send_unknown`.
Automatic retry is forbidden. Calling `send_draft` again for a `sent` draft returns an idempotent
success without provider I/O.

Bind each `message_references` row to its gateway draft. On successful delivery, refresh that row
with the sent-message receipt and the acceptance timestamp in the same database transaction that
marks the draft `sent`. Reply correlation must not keep relying on a provider draft id that may
have changed during delivery.

Use provider-native delivery:

- **Gmail:** `users.drafts.send`, covered by the delegated `gmail.compose` grant.
- **Microsoft Graph:** verify `isDraft=true`, then `POST /me/messages/{id}/send`. This needs the
  delegated `Mail.Send` permission, and each Microsoft mailbox must be reconnected to receive it.
- **Zoho Mail:** read the managed draft, submit the same content to `POST /messages` without draft
  mode, then delete the stale draft copy best-effort. A cleanup failure never makes delivery
  retryable.

Keep arbitrary direct-send methods, forwarding and received-message mutation outside the adapter
contract. The global kill switch and mailbox enablement continue to gate every MCP request.

## Consequences

LLMs can create and deliver outreach and reply drafts without per-message human approval. Every
accepted send has a durable record, an audit event, a provider message id when the provider returns
one, and daily quota consumption at mailbox and identity level.

Microsoft operators must grant delegated `Mail.Send` in every pinned tenant and reconnect each
Microsoft mailbox. Google and Zoho need no broader OAuth scope.

An operator must reconcile `sending` and `send_unknown` rows against the provider Sent and Drafts
folders. `reconcile_draft_send` automates this check. The system intentionally prefers a blocked
message to a possible duplicate delivery.
