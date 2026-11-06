-- Additional sending identities of a mailbox (provider aliases / proxy
-- addresses). An alias shares the account, the token and the Drafts folder of
-- its mailbox, so it is a column on the mailbox and never a mailbox of its own.
ALTER TABLE mailboxes
  ADD COLUMN aliases text[] NOT NULL DEFAULT ARRAY[]::text[];

-- A historical data fix for the original deployment (one alias on one of its
-- mailboxes) stood here. It is intentionally a no-op on new installations:
-- aliases come from the mailbox registry file or the dashboard.

-- A provider draft may be adopted from its Drafts folder, but it must still
-- have exactly one gateway owner even under concurrent agent calls.
CREATE UNIQUE INDEX drafts_mailbox_provider_draft_unique
  ON drafts (mailbox_id, provider_draft_id)
  WHERE provider_draft_id IS NOT NULL;
