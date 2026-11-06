-- OAuth grants for MCP clients (authorization codes, access and refresh tokens).
-- Tokens are stored only as SHA-256 hashes.
CREATE TABLE mcp_oauth_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mcp_client_id text NOT NULL REFERENCES mcp_clients (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('code', 'access', 'refresh')),
  token_hash text NOT NULL UNIQUE,
  code_challenge text,
  redirect_uri text,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX mcp_oauth_grants_client_kind_idx ON mcp_oauth_grants (mcp_client_id, kind);
