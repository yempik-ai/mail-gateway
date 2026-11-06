import {
  googleOAuthSettings,
  microsoftOAuthSettings,
  zohoOAuthSettings,
  ZOHO_REGION_HOSTS,
  type AccessTokenProvider,
  type GatewayConfig,
} from '@yempik/core';
import type { Database } from '@yempik/database';
import { loadTokenKeyring, type TokenKeyring } from '@yempik/security';
import {
  createDrizzleOAuthStore,
  createGoogleOAuthService,
  createMicrosoftOAuthService,
  createZohoOAuthService,
  type OAuthStore,
} from '@yempik/oauth';
import type { MailDraftAdapter, MailProviderAdapter } from '@yempik/core';
import { createGmailAdapter } from '@yempik/gmail-adapter';
import { createMicrosoftAdapter } from '@yempik/microsoft-adapter';
import { createZohoAdapter } from '@yempik/zoho-adapter';
import type { AdapterMailboxContext } from './mail-search.js';

interface TokenService {
  getAccessToken(
    mailboxId: string,
    correlationId: string,
  ): Promise<{ accessToken: string; expiresAt: Date }>;
}

// Adapters ask for a token on every HTTP call: cache one live access token per
// mailbox per warm process, refreshed 60 seconds before expiry.
function withTokenCache(service: TokenService): AccessTokenProvider {
  const cache = new Map<string, { accessToken: string; expiresAt: Date }>();
  return {
    async getAccessToken(mailboxId, correlationId) {
      const cached = cache.get(mailboxId);
      if (cached && cached.expiresAt.getTime() - Date.now() > 60_000) {
        return { accessToken: cached.accessToken };
      }
      const fresh = await service.getAccessToken(mailboxId, correlationId);
      cache.set(mailboxId, fresh);
      return { accessToken: fresh.accessToken };
    },
  };
}

/**
 * One factory serves both seams: the adapters implement the read and the
 * draft contracts on the same object, so the composition root hands the same
 * function to `adapterFactory` and `draftAdapterFactory`.
 */
export type FullAdapterFactory = (
  mailbox: AdapterMailboxContext,
  correlationId: string,
) => (MailProviderAdapter & MailDraftAdapter) | undefined;

/**
 * Composition root for provider adapters: one token-cached provider per
 * configured OAuth service. Providers without configuration surface
 * UNSUPPORTED_OPERATION through the missing-adapter path.
 */
export function createProviderAdapterFactory(
  config: GatewayConfig,
  database: Database,
): FullAdapterFactory {
  let keyring: TokenKeyring | undefined;
  let store: OAuthStore | undefined;
  const shared = () => {
    keyring ??= loadTokenKeyring(
      config.TOKEN_ENCRYPTION_KEYS,
      config.TOKEN_ENCRYPTION_CURRENT_VERSION,
    );
    store ??= createDrizzleOAuthStore(database);
    return { keyring, store };
  };

  const googleSettings = googleOAuthSettings(config);
  const googleTokens = googleSettings
    ? withTokenCache(
        createGoogleOAuthService({
          clientId: googleSettings.clientId,
          clientSecret: googleSettings.clientSecret,
          redirectUri: `${googleSettings.publicBaseUrl}/oauth/google/callback`,
          stateSecret: googleSettings.stateSecret,
          ...shared(),
        }),
      )
    : undefined;

  const microsoftSettings = microsoftOAuthSettings(config);
  const microsoftTokens = microsoftSettings
    ? withTokenCache(
        createMicrosoftOAuthService({
          tenantId: microsoftSettings.tenantId,
          clientId: microsoftSettings.clientId,
          clientSecret: microsoftSettings.clientSecret,
          redirectUri: `${microsoftSettings.publicBaseUrl}/oauth/microsoft/callback`,
          stateSecret: microsoftSettings.stateSecret,
          ...shared(),
        }),
      )
    : undefined;

  const zohoSettings = zohoOAuthSettings(config);
  const zohoTokens = zohoSettings
    ? withTokenCache(
        createZohoOAuthService({
          clientId: zohoSettings.clientId,
          clientSecret: zohoSettings.clientSecret,
          region: zohoSettings.region,
          redirectUri: `${zohoSettings.publicBaseUrl}/oauth/zoho/callback`,
          stateSecret: zohoSettings.stateSecret,
          ...shared(),
        }),
      )
    : undefined;

  return (mailbox, correlationId) => {
    if (mailbox.provider === 'gmail' && googleTokens) {
      return createGmailAdapter({
        mailboxId: mailbox.id,
        emailAddress: mailbox.emailAddress,
        aliases: mailbox.aliases,
        correlationId,
        tokenProvider: googleTokens,
      });
    }
    if (mailbox.provider === 'microsoft' && microsoftTokens) {
      return createMicrosoftAdapter({
        mailboxId: mailbox.id,
        emailAddress: mailbox.emailAddress,
        aliases: mailbox.aliases,
        correlationId,
        tokenProvider: microsoftTokens,
      });
    }
    if (mailbox.provider === 'zoho' && zohoTokens && zohoSettings) {
      return createZohoAdapter({
        mailboxId: mailbox.id,
        emailAddress: mailbox.emailAddress,
        aliases: mailbox.aliases,
        correlationId,
        tokenProvider: zohoTokens,
        apiBaseUrl: ZOHO_REGION_HOSTS[zohoSettings.region].mail,
      });
    }
    return undefined;
  };
}
