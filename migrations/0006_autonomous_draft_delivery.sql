-- Autonomous delivery remains draft-first: only drafts already registered by
-- the gateway may enter the sending state.
ALTER TYPE draft_status ADD VALUE IF NOT EXISTS 'sending';
ALTER TYPE draft_status ADD VALUE IF NOT EXISTS 'sent';
ALTER TYPE draft_status ADD VALUE IF NOT EXISTS 'send_unknown';

ALTER TABLE mailboxes
  ADD COLUMN daily_send_limit integer NOT NULL DEFAULT 25 CHECK (daily_send_limit >= 0),
  ADD COLUMN daily_send_limits_by_identity jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN last_successful_send_at timestamptz;

ALTER TABLE drafts
  ADD COLUMN sending_identity_email text,
  ADD COLUMN provider_sent_message_id text,
  ADD COLUMN sent_at timestamptz;

ALTER TABLE daily_mailbox_usage
  ADD COLUMN messages_sent integer NOT NULL DEFAULT 0,
  ADD COLUMN messages_sent_by_identity jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Default every existing draft to its mailbox primary identity. New drafts
-- persist the exact primary/alias address selected by the client.
UPDATE drafts AS draft
SET sending_identity_email = lower(mailbox.email_address)
FROM mailboxes AS mailbox
WHERE draft.mailbox_id = mailbox.id;

ALTER TABLE drafts
  ALTER COLUMN sending_identity_email SET NOT NULL;

-- Existing mailboxes start with 40 daily sends from their primary identity.
-- The original deployment also set per-mailbox caps here (historical data,
-- intentionally dropped); new installations set limits through the mailbox
-- registry file or the dashboard.
UPDATE mailboxes
SET daily_send_limit = 40,
    daily_send_limits_by_identity = jsonb_build_object(lower(email_address), 40);

-- Bind reply-correlation metadata to its gateway draft so provider ids can be
-- refreshed atomically when the draft becomes a sent message.
ALTER TABLE message_references
  ADD COLUMN draft_id uuid REFERENCES drafts(id) ON DELETE SET NULL;

UPDATE message_references AS reference
SET draft_id = draft.id
FROM drafts AS draft
WHERE reference.draft_id IS NULL
  AND reference.mailbox_id = draft.mailbox_id
  AND reference.provider_message_id = COALESCE(draft.provider_message_id, draft.provider_draft_id);

CREATE INDEX message_references_draft_id_idx ON message_references (draft_id);
