CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE mailbox_provider AS ENUM ('gmail', 'microsoft');
CREATE TYPE mailbox_connection_status AS ENUM (
  'connected', 'disconnected', 'expired', 'revoked', 'error', 'disabled'
);
CREATE TYPE draft_status AS ENUM ('creating', 'created', 'updated', 'deleted', 'failed');
CREATE TYPE operation_status AS ENUM ('started', 'succeeded', 'failed');

CREATE TABLE mailboxes (
  id text PRIMARY KEY,
  provider mailbox_provider NOT NULL,
  email_address text NOT NULL,
  display_name text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  connection_status mailbox_connection_status NOT NULL DEFAULT 'disconnected',
  per_run_draft_limit integer NOT NULL DEFAULT 5 CHECK (per_run_draft_limit >= 0),
  daily_draft_limit integer NOT NULL DEFAULT 25 CHECK (daily_draft_limit >= 0),
  routing_priority integer NOT NULL CHECK (routing_priority > 0),
  last_successful_read_at timestamptz,
  last_successful_draft_at timestamptz,
  last_token_refresh_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE oauth_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mailbox_id text NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  provider mailbox_provider NOT NULL,
  provider_account_id text,
  scopes text[] NOT NULL DEFAULT ARRAY[]::text[],
  status mailbox_connection_status NOT NULL DEFAULT 'disconnected',
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE oauth_token_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  oauth_connection_id uuid NOT NULL REFERENCES oauth_connections(id) ON DELETE CASCADE,
  ciphertext text NOT NULL,
  nonce text NOT NULL,
  auth_tag text NOT NULL,
  key_version integer NOT NULL CHECK (key_version > 0),
  token_kind text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz
);

CREATE TABLE campaigns (
  id text PRIMARY KEY,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE prospect_mailbox_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id text NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  prospect_id text NOT NULL,
  normalized_recipient_email text NOT NULL,
  mailbox_id text NOT NULL REFERENCES mailboxes(id),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prospect_mailbox_assignments_campaign_recipient_unique
    UNIQUE (campaign_id, normalized_recipient_email)
);

CREATE TABLE drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL,
  mailbox_id text NOT NULL REFERENCES mailboxes(id),
  provider mailbox_provider NOT NULL,
  provider_draft_id text,
  provider_message_id text,
  provider_web_url text,
  campaign_id text REFERENCES campaigns(id),
  prospect_id text,
  normalized_recipient_email text,
  sequence_step integer,
  source_message_id text,
  content_hash text,
  status draft_status NOT NULL DEFAULT 'creating',
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT drafts_idempotency_key_unique UNIQUE (idempotency_key),
  CONSTRAINT drafts_campaign_recipient_sequence_unique
    UNIQUE (campaign_id, normalized_recipient_email, sequence_step)
);

CREATE TABLE draft_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id uuid NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  operation text NOT NULL,
  status operation_status NOT NULL,
  retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  error_code text,
  correlation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE message_references (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mailbox_id text NOT NULL REFERENCES mailboxes(id),
  campaign_id text REFERENCES campaigns(id),
  prospect_id text,
  provider_message_id text NOT NULL,
  thread_id text,
  conversation_id text,
  internet_message_id text,
  in_reply_to text,
  "references" text[] NOT NULL DEFAULT ARRAY[]::text[],
  normalized_sender text,
  normalized_recipient text,
  subject text,
  snippet text,
  content_hash text,
  message_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE idempotency_keys (
  key text PRIMARY KEY,
  operation text NOT NULL,
  status operation_status NOT NULL DEFAULT 'started',
  resource_type text,
  resource_id text,
  response jsonb,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE daily_mailbox_usage (
  mailbox_id text NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  usage_date date NOT NULL,
  drafts_created integer NOT NULL DEFAULT 0 CHECK (drafts_created >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mailbox_id, usage_date)
);

CREATE TABLE mcp_clients (
  id text PRIMARY KEY,
  display_name text NOT NULL,
  secret_hash text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  allowlisted boolean NOT NULL DEFAULT true,
  global_kill_switch boolean NOT NULL DEFAULT false,
  environment text NOT NULL,
  last_authenticated_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mcp_client_id text REFERENCES mcp_clients(id) ON DELETE SET NULL,
  tool text,
  correlation_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  mailbox_id text REFERENCES mailboxes(id) ON DELETE SET NULL,
  campaign_id text,
  prospect_id text,
  resource_id text,
  operation text NOT NULL,
  result text NOT NULL,
  error_code text,
  retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  idempotency_key text,
  provider_latency_ms numeric(12,3),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX oauth_connections_mailbox_idx ON oauth_connections(mailbox_id);
CREATE INDEX oauth_token_versions_connection_idx ON oauth_token_versions(oauth_connection_id);
CREATE INDEX drafts_mailbox_idx ON drafts(mailbox_id);
CREATE INDEX drafts_campaign_idx ON drafts(campaign_id);
CREATE INDEX message_references_mailbox_message_idx ON message_references(mailbox_id, provider_message_id);
CREATE INDEX audit_events_occurred_at_idx ON audit_events(occurred_at DESC);
CREATE INDEX audit_events_client_idx ON audit_events(mcp_client_id, occurred_at DESC);
