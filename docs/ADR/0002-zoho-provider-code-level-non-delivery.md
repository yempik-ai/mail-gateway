# ADR 0002: Zoho as a third provider, with code-level non-delivery

Status: accepted. The non-delivery decision is superseded by
[ADR 0003](0003-autonomous-draft-delivery.md). The Zoho provider, the regional endpoint and the
create-then-delete update decisions remain valid.

## Context

Gmail and Microsoft 365 mailboxes were served by two adapters. Adding Zoho Mail needed a third
adapter. Two properties of the Zoho API conflict with assumptions that the existing adapters rely
on:

1. Drafting and delivery share one endpoint (`POST /messages`) and one scope
   (`ZohoMail.messages.CREATE`). The `mode` field is the only difference. No scope grants drafting
   while withholding delivery.
2. No endpoint edits a draft in place. `updatemessage` moves, flags and marks messages. It does not
   change content.

## Decision

Add `packages/zoho-adapter`, which implements both the read and the draft contracts. Add a Zoho
OAuth service in `packages/oauth`. Extend the `mailbox_provider` enum with `zoho`.

Accept a weaker non-delivery guarantee for Zoho mailboxes and state it explicitly. The adapter never
builds a request with any mode other than `draft`. The draft test suite asserts that invariant over
every request issued in a test. This is a code-level guarantee, not a scope-level one.

Emulate `updateDraft` as create-then-delete. Write the replacement draft first, then remove the
previous one, and return the new provider draft id. `markDraftUpdated` already persists the id from
the returned snapshot, so the gateway-side draft id does not change.

Expose Zoho messages under a composite `folderId:messageId` reference, because the content, header
and delete paths are all folder-scoped.

## Alternatives considered

- **Host the domain on Google Workspace or Microsoft 365.** This needs no new code and keeps the
  scope-level non-delivery guarantee. It adds a per-mailbox licence cost. It was rejected on cost
  for a low-volume mailbox.
- **Reach Zoho over IMAP and SMTP.** Drafts would be created with an IMAP `APPEND` that carries the
  `\Draft` flag. No credential able to send would be needed if SMTP were never configured, which is
  a stronger guarantee than the API path. It was rejected because it needs UID-based message
  identity, MIME parsing and a connection pool that the codebase has nowhere else. Both existing
  providers share a different adapter shape.
- **Keep the mailbox outside the gateway.** This forfeits reply matching and draft automation, which
  is the reason to register the mailbox.

## Consequences

[SECURITY.md](../SECURITY.md) distinguishes scope-level from code-level guarantees. Any future
change to the Zoho adapter must preserve the single `mode: 'draft'` call site and its test.

`updateDraft` costs an extra round trip and changes the provider-side draft id on every update. A
crash between the create and the delete leaves one orphan draft in the Drafts folder. It is visible
and removable. The order was chosen so that the failure mode is a duplicate rather than a lost
draft.

A message moved to another folder invalidates a previously issued `folderId:messageId` reference.
Reply matching is unaffected. It correlates on thread id and RFC 5322 message ids, not on this
reference.

`searchEmails` returns the list payload only. `internetMessageId`, `inReplyTo` and `references` stay
empty, as `references` already does in the Microsoft adapter. Reply matching for Zoho candidates
therefore relies on the thread-id tier and the recipient, subject and time tier. `getEmail`
hydrates the RFC headers with an extra request.
