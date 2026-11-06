-- Allow 40 daily sends from the primary identity of every existing mailbox.
-- The original deployment also kept per-mailbox caps here (historical data,
-- intentionally dropped); new installations set limits through the mailbox
-- registry file or the dashboard.
UPDATE mailboxes
SET daily_send_limit = 40,
    daily_send_limits_by_identity = jsonb_build_object(lower(email_address), 40),
    updated_at = now();
