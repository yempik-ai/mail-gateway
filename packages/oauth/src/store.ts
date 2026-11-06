import { and, eq } from 'drizzle-orm';
import { mailboxes, oauthConnections, oauthTokenVersions, type Database } from '@yempik/database';
import type { EncryptedToken } from '@yempik/security';

export type OAuthProvider = 'gmail' | 'microsoft' | 'zoho';

export interface OAuthMailbox {
  id: string;
  provider: OAuthProvider;
  emailAddress: string;
  enabled: boolean;
  // NULL means: use the globally configured Microsoft tenant.
  microsoftTenantId: string | null;
}

export interface CompleteConnectionInput {
  mailboxId: string;
  provider: OAuthProvider;
  providerAccountId: string;
  scopes: string[];
  tokenKind: string;
  encryptedRefreshToken: EncryptedToken;
}

export interface OAuthStore {
  getMailbox(mailboxId: string): Promise<OAuthMailbox | undefined>;
  completeConnection(input: CompleteConnectionInput): Promise<void>;
  markConnectionError(mailboxId: string, provider: OAuthProvider, errorCode: string): Promise<void>;
  markConnectionRevoked(mailboxId: string, provider: OAuthProvider): Promise<void>;
  getActiveRefreshToken(
    mailboxId: string,
    provider: OAuthProvider,
    tokenKind: string,
  ): Promise<EncryptedToken | undefined>;
  markTokenRefreshed(mailboxId: string): Promise<void>;
}

export function createDrizzleOAuthStore(database: Database): OAuthStore {
  async function findConnection(mailboxId: string, provider: OAuthProvider) {
    const rows = await database
      .select()
      .from(oauthConnections)
      .where(
        and(eq(oauthConnections.mailboxId, mailboxId), eq(oauthConnections.provider, provider)),
      )
      .limit(1);
    return rows[0];
  }

  return {
    async getMailbox(mailboxId) {
      const rows = await database
        .select({
          id: mailboxes.id,
          provider: mailboxes.provider,
          emailAddress: mailboxes.emailAddress,
          enabled: mailboxes.enabled,
          microsoftTenantId: mailboxes.microsoftTenantId,
        })
        .from(mailboxes)
        .where(eq(mailboxes.id, mailboxId))
        .limit(1);
      return rows[0];
    },

    async completeConnection(input) {
      const now = new Date();
      await database.transaction(async (tx) => {
        const existing = await tx
          .select({ id: oauthConnections.id })
          .from(oauthConnections)
          .where(
            and(
              eq(oauthConnections.mailboxId, input.mailboxId),
              eq(oauthConnections.provider, input.provider),
            ),
          )
          .limit(1);

        let connectionId: string;
        if (existing[0]) {
          connectionId = existing[0].id;
          await tx
            .update(oauthConnections)
            .set({
              providerAccountId: input.providerAccountId,
              scopes: input.scopes,
              status: 'connected',
              revokedAt: null,
              expiresAt: null,
              updatedAt: now,
            })
            .where(eq(oauthConnections.id, connectionId));
        } else {
          const inserted = await tx
            .insert(oauthConnections)
            .values({
              mailboxId: input.mailboxId,
              provider: input.provider,
              providerAccountId: input.providerAccountId,
              scopes: input.scopes,
              status: 'connected',
            })
            .returning({ id: oauthConnections.id });
          const row = inserted[0];
          if (!row) throw new Error('Failed to persist OAuth connection');
          connectionId = row.id;
        }

        await tx
          .update(oauthTokenVersions)
          .set({ active: false, retiredAt: now })
          .where(
            and(
              eq(oauthTokenVersions.oauthConnectionId, connectionId),
              eq(oauthTokenVersions.active, true),
            ),
          );
        await tx.insert(oauthTokenVersions).values({
          oauthConnectionId: connectionId,
          ciphertext: input.encryptedRefreshToken.ciphertext,
          nonce: input.encryptedRefreshToken.nonce,
          authTag: input.encryptedRefreshToken.authTag,
          keyVersion: input.encryptedRefreshToken.keyVersion,
          tokenKind: input.tokenKind,
          active: true,
        });
        await tx
          .update(mailboxes)
          .set({
            connectionStatus: 'connected',
            lastTokenRefreshAt: now,
            lastSuccessfulReadAt: now,
            lastErrorCode: null,
            updatedAt: now,
          })
          .where(eq(mailboxes.id, input.mailboxId));
      });
    },

    async markConnectionError(mailboxId, provider, errorCode) {
      const now = new Date();
      await database
        .update(mailboxes)
        .set({ connectionStatus: 'error', lastErrorCode: errorCode, updatedAt: now })
        .where(eq(mailboxes.id, mailboxId));
      const connection = await findConnection(mailboxId, provider);
      if (connection) {
        await database
          .update(oauthConnections)
          .set({ status: 'error', updatedAt: now })
          .where(eq(oauthConnections.id, connection.id));
      }
    },

    async markConnectionRevoked(mailboxId, provider) {
      const now = new Date();
      await database.transaction(async (tx) => {
        const connection = await tx
          .select({ id: oauthConnections.id })
          .from(oauthConnections)
          .where(
            and(eq(oauthConnections.mailboxId, mailboxId), eq(oauthConnections.provider, provider)),
          )
          .limit(1);
        if (connection[0]) {
          await tx
            .update(oauthConnections)
            .set({ status: 'revoked', revokedAt: now, updatedAt: now })
            .where(eq(oauthConnections.id, connection[0].id));
          await tx
            .update(oauthTokenVersions)
            .set({ active: false, retiredAt: now })
            .where(
              and(
                eq(oauthTokenVersions.oauthConnectionId, connection[0].id),
                eq(oauthTokenVersions.active, true),
              ),
            );
        }
        await tx
          .update(mailboxes)
          .set({ connectionStatus: 'revoked', lastErrorCode: 'TOKEN_REVOKED', updatedAt: now })
          .where(eq(mailboxes.id, mailboxId));
      });
    },

    async getActiveRefreshToken(mailboxId, provider, tokenKind) {
      const connection = await findConnection(mailboxId, provider);
      if (!connection || connection.status !== 'connected') return undefined;
      const rows = await database
        .select()
        .from(oauthTokenVersions)
        .where(
          and(
            eq(oauthTokenVersions.oauthConnectionId, connection.id),
            eq(oauthTokenVersions.active, true),
            eq(oauthTokenVersions.tokenKind, tokenKind),
          ),
        )
        .limit(1);
      const token = rows[0];
      if (!token) return undefined;
      return {
        ciphertext: token.ciphertext,
        nonce: token.nonce,
        authTag: token.authTag,
        keyVersion: token.keyVersion,
      };
    },

    async markTokenRefreshed(mailboxId) {
      await database
        .update(mailboxes)
        .set({ lastTokenRefreshAt: new Date(), updatedAt: new Date() })
        .where(eq(mailboxes.id, mailboxId));
    },
  };
}
