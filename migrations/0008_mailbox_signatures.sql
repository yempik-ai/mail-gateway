-- Email signature of every sending identity (mailbox primary address or
-- alias). None of the provider draft APIs appends the user's signature, so the
-- gateway stores it and adds it when it renders a draft. Gmail exposes it
-- through settings.sendAs (source 'gmail'); Microsoft Graph and Zoho expose no
-- signature API, so the operator pastes it in the admin dashboard ('manual').
CREATE TABLE mailbox_signatures (
  mailbox_id text NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  -- Stored normalized so a lookup by the draft's sending identity never misses
  -- on case or surrounding whitespace.
  identity_email text NOT NULL
    CHECK (identity_email <> '' AND identity_email = lower(btrim(identity_email))),
  display_name text,
  signature_html text,
  -- NULL when only HTML is provided: the renderer derives the text part.
  signature_text text,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'gmail')),
  synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mailbox_id, identity_email)
);
