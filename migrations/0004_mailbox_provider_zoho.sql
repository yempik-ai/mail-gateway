-- Adds the third mailbox provider. PostgreSQL 12+ allows ALTER TYPE ... ADD VALUE
-- inside a transaction as long as the new label is not used in the same
-- transaction; the seed inserts the Zoho mailbox on a later connection.
ALTER TYPE mailbox_provider ADD VALUE IF NOT EXISTS 'zoho';
