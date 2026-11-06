// Persistence of the email signature of every sending identity. None of the
// provider draft APIs appends the user's signature, so the gateway keeps it
// here: imported from Gmail settings.sendAs, or pasted by the operator in the
// admin dashboard for Microsoft and Zoho, which expose no signature API.
// Signature content is user data: it is never logged nor written to audit
// metadata.

import { sql } from 'drizzle-orm';
import { mailboxes, mailboxSignatures, type Database } from '@yempik/database';

export type SignatureSource = 'manual' | 'gmail';

export interface StoredSignature {
  mailboxId: string;
  identityEmail: string;
  displayName?: string;
  signatureHtml?: string;
  signatureText?: string;
  source: SignatureSource;
  /** ISO 8601; set only while the row mirrors the provider (source 'gmail'). */
  syncedAt?: string;
  updatedAt: string;
}

// Optional members accept `undefined` so parsed form fields flow in unchanged
// under exactOptionalPropertyTypes.
export interface UpsertSignatureInput {
  mailboxId: string;
  identityEmail: string;
  displayName?: string | undefined;
  signatureHtml?: string | undefined;
  /** Leave undefined when only HTML is known: the renderer derives the text part. */
  signatureText?: string | undefined;
  source: SignatureSource;
}

export interface ApplySignatureToAllInput {
  sourceMailboxId: string;
  sourceIdentityEmail: string;
  displayName?: string | undefined;
  signatureHtml?: string | undefined;
  signatureText?: string | undefined;
}

export interface SignatureStore {
  getSignature(mailboxId: string, identityEmail: string): Promise<StoredSignature | undefined>;
  listSignatures(): Promise<StoredSignature[]>;
  upsertSignature(input: UpsertSignatureInput): Promise<StoredSignature>;
  deleteSignature(mailboxId: string, identityEmail: string): Promise<void>;
  /**
   * Copies one signature onto every other identity of every enabled mailbox,
   * as manual rows. Returns how many identities were written.
   */
  applySignatureToAllIdentities(
    input: ApplySignatureToAllInput,
  ): Promise<{ updatedIdentities: number }>;
}

/**
 * Identities are compared case-insensitively everywhere in the gateway (send
 * limits, alias checks); the table stores them in this form so a lookup by the
 * draft's sending identity never misses on case or whitespace.
 */
export function normalizeIdentityEmail(identityEmail: string): string {
  const normalized = identityEmail.trim().toLowerCase();
  if (!normalized) throw new TypeError('identityEmail must not be empty');
  return normalized;
}

/** Whitespace-only content is "no value": an empty column, not an empty signature. */
function optionalContent(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

interface SignatureRow extends Record<string, unknown> {
  mailbox_id: string;
  identity_email: string;
  display_name: string | null;
  signature_html: string | null;
  signature_text: string | null;
  source: string;
  synced_at: Date | string | null;
  updated_at: Date | string;
}

function toIsoString(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function toStoredSignature(row: SignatureRow): StoredSignature {
  return {
    mailboxId: row.mailbox_id,
    identityEmail: row.identity_email,
    ...(row.display_name === null ? {} : { displayName: row.display_name }),
    ...(row.signature_html === null ? {} : { signatureHtml: row.signature_html }),
    ...(row.signature_text === null ? {} : { signatureText: row.signature_text }),
    source: row.source === 'gmail' ? 'gmail' : 'manual',
    ...(row.synced_at === null ? {} : { syncedAt: toIsoString(row.synced_at) }),
    updatedAt: toIsoString(row.updated_at),
  };
}

const RETURNED_COLUMNS = sql`
  mailbox_id, identity_email, display_name, signature_html, signature_text,
  source, synced_at, updated_at
`;

export function createDatabaseSignatureStore(database: Database): SignatureStore {
  return {
    async getSignature(mailboxId, identityEmail) {
      const result = await database.execute<SignatureRow>(sql`
        SELECT ${RETURNED_COLUMNS}
        FROM ${mailboxSignatures}
        WHERE mailbox_id = ${mailboxId}
          AND identity_email = ${normalizeIdentityEmail(identityEmail)}
        LIMIT 1
      `);
      const row = result.rows[0];
      return row === undefined ? undefined : toStoredSignature(row);
    },

    async listSignatures() {
      const result = await database.execute<SignatureRow>(sql`
        SELECT ${RETURNED_COLUMNS}
        FROM ${mailboxSignatures}
        ORDER BY mailbox_id, identity_email
      `);
      return result.rows.map(toStoredSignature);
    },

    async upsertSignature(input) {
      // synced_at tracks "this row mirrors the provider": a manual edit of an
      // imported signature clears it, so the dashboard never shows a stale sync.
      const syncedAt = input.source === 'gmail' ? sql`now()` : sql`NULL`;
      const result = await database.execute<SignatureRow>(sql`
        INSERT INTO ${mailboxSignatures} (
          mailbox_id, identity_email, display_name, signature_html, signature_text,
          source, synced_at
        )
        VALUES (
          ${input.mailboxId},
          ${normalizeIdentityEmail(input.identityEmail)},
          ${optionalContent(input.displayName)},
          ${optionalContent(input.signatureHtml)},
          ${optionalContent(input.signatureText)},
          ${input.source},
          ${syncedAt}
        )
        ON CONFLICT (mailbox_id, identity_email) DO UPDATE SET
          display_name = excluded.display_name,
          signature_html = excluded.signature_html,
          signature_text = excluded.signature_text,
          source = excluded.source,
          synced_at = excluded.synced_at,
          updated_at = now()
        RETURNING ${RETURNED_COLUMNS}
      `);
      const row = result.rows[0];
      if (row === undefined) throw new Error('Signature upsert returned no row');
      return toStoredSignature(row);
    },

    async deleteSignature(mailboxId, identityEmail) {
      await database.execute(sql`
        DELETE FROM ${mailboxSignatures}
        WHERE mailbox_id = ${mailboxId}
          AND identity_email = ${normalizeIdentityEmail(identityEmail)}
      `);
    },

    async applySignatureToAllIdentities(input) {
      // One statement, hence one implicit transaction: a failure leaves every
      // identity as it was instead of half of them overwritten. Identities are
      // enumerated in SQL the way the dashboard does it (address plus aliases,
      // trimmed and lower-cased); DISTINCT and the blank filter keep a
      // duplicated or empty alias from hitting the same conflict key twice,
      // which Postgres rejects inside one INSERT ... ON CONFLICT DO UPDATE.
      const result = await database.execute(sql`
        INSERT INTO ${mailboxSignatures} (
          mailbox_id, identity_email, display_name, signature_html, signature_text,
          source, synced_at, created_at, updated_at
        )
        SELECT DISTINCT
          m.id,
          lower(btrim(i.email)),
          ${optionalContent(input.displayName)}::text,
          ${optionalContent(input.signatureHtml)}::text,
          ${optionalContent(input.signatureText)}::text,
          'manual',
          NULL::timestamptz,
          now(),
          now()
        FROM ${mailboxes} m
        CROSS JOIN LATERAL unnest(array_append(m.aliases, m.email_address)) AS i(email)
        WHERE m.enabled
          AND btrim(i.email) <> ''
          AND NOT (
            m.id = ${input.sourceMailboxId}
            AND lower(btrim(i.email)) = ${normalizeIdentityEmail(input.sourceIdentityEmail)}
          )
        ON CONFLICT (mailbox_id, identity_email) DO UPDATE SET
          display_name = excluded.display_name,
          signature_html = excluded.signature_html,
          signature_text = excluded.signature_text,
          source = 'manual',
          synced_at = NULL,
          updated_at = now()
      `);
      return { updatedIdentities: result.rowCount ?? 0 };
    },
  };
}
