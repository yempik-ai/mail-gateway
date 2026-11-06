import { isIP } from 'node:net';
import { z } from 'zod';

const envBoolean = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const commaSeparated = z
  .string()
  .min(1)
  .transform((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );

/** Names proxy-addr (Fastify's trustProxy) accepts for its built-in ranges. */
const NAMED_PROXY_RANGES = new Set(['loopback', 'linklocal', 'uniquelocal']);

function isProxyAddressOrRange(entry: string): boolean {
  if (NAMED_PROXY_RANGES.has(entry)) return true;
  const [address = '', prefix, ...rest] = entry.split('/');
  const version = isIP(address);
  if (version === 0 || rest.length > 0) return false;
  if (prefix === undefined) return true;
  if (!/^\d{1,3}$/u.test(prefix)) return false;
  return Number(prefix) <= (version === 4 ? 32 : 128);
}

/**
 * Which hops may set X-Forwarded-For, in the forms Fastify's `trustProxy`
 * takes: false (the socket peer is the client), true (trust every hop), a hop
 * count, or addresses and CIDR ranges of the proxies. Validated here so a typo
 * fails the boot instead of silently trusting nothing or everything.
 */
export const trustProxySchema = z
  .preprocess((value) => (value === '' ? undefined : value), z.string().default('false'))
  .transform((value, context): boolean | number | string[] => {
    const trimmed = value.trim();
    const lower = trimmed.toLowerCase();
    if (lower === 'false') return false;
    if (lower === 'true') return true;
    if (/^\d+$/u.test(trimmed)) return Number(trimmed);
    const entries = trimmed
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    const invalid = entries.filter((entry) => !isProxyAddressOrRange(entry));
    if (entries.length === 0 || invalid.length > 0) {
      context.addIssue({
        code: 'custom',
        message:
          'TRUST_PROXY must be true, false, a hop count, or comma-separated proxy IP addresses or CIDR ranges',
      });
      return z.NEVER;
    }
    return entries;
  });

const optionalSecret = (minLength: number) =>
  z.preprocess((value) => (value === '' ? undefined : value), z.string().min(minLength).optional());

export const gatewayConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().max(65_535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  // Self-hosted (Docker, node) deployments behind a load balancer. Off by
  // default: without a proxy that overwrites X-Forwarded-For, trusting it lets
  // clients pick their own address and escape the per-IP limits. Prefer the
  // proxies' CIDRs; a hop count is safe only when nothing reaches the gateway
  // except through those hops. The Vercel entry point ignores it and always
  // trusts Vercel's edge.
  TRUST_PROXY: trustProxySchema,
  DATABASE_URL: z
    .string()
    .url()
    .refine((value) => value.startsWith('postgres'), {
      message: 'DATABASE_URL must use PostgreSQL',
    }),
  MCP_CLIENT_ID: z.string().min(1),
  MCP_CLIENT_SECRET: z.string().min(16),
  MCP_CLIENT_ALLOWLIST: commaSeparated,
  MCP_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  MCP_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  GLOBAL_KILL_SWITCH: envBoolean,
  TOKEN_ENCRYPTION_CURRENT_VERSION: z.coerce.number().int().positive(),
  TOKEN_ENCRYPTION_KEYS: z.string().min(1),
  PUBLIC_BASE_URL: z
    .string()
    .url()
    .default('http://localhost:3000')
    .transform((value) => value.replace(/\/+$/, '')),
  MCP_OAUTH_REDIRECT_ALLOWLIST: z
    .string()
    .min(1)
    .default(
      [
        'https://claude.ai/api/mcp/auth_callback',
        'https://chatgpt.com/connector_platform_oauth_redirect',
      ].join(','),
    )
    .transform((value) =>
      value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  GOOGLE_OAUTH_CLIENT_ID: optionalSecret(1),
  GOOGLE_OAUTH_CLIENT_SECRET: optionalSecret(1),
  MICROSOFT_TENANT_ID: optionalSecret(1),
  MICROSOFT_CLIENT_ID: optionalSecret(1),
  MICROSOFT_CLIENT_SECRET: optionalSecret(1),
  ZOHO_CLIENT_ID: optionalSecret(1),
  ZOHO_CLIENT_SECRET: optionalSecret(1),
  ZOHO_REGION: z.enum(['eu', 'com']).default('eu'),
  OAUTH_STATE_SECRET: optionalSecret(16),
  // Operator-chosen dashboard password. Any non-empty value boots, so a
  // deployment never goes down over it; under 16 characters the server logs a
  // warning at boot and the dashboard shows a banner.
  ADMIN_DASHBOARD_SECRET: optionalSecret(1),
  // Optional Sentry project DSN for unhandled server errors.
  SENTRY_DSN: z.preprocess((value) => (value === '' ? undefined : value), z.url().optional()),
  // Time zone of the "On <date> <sender> wrote:" line quoted below replies.
  // Validated at boot: an unknown zone would otherwise surface only as a
  // silently dropped date in the first reply draft.
  // An empty value (the .env.example placeholder left blank) means the default.
  GATEWAY_TIME_ZONE: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z
      .string()
      .default('UTC')
      .refine(
        (timeZone) => {
          try {
            new Intl.DateTimeFormat('en-US', { timeZone });
            return true;
          } catch {
            return false;
          }
        },
        { message: 'GATEWAY_TIME_ZONE must be an IANA time zone such as Europe/Rome' },
      ),
  ),
});

export type GatewayConfig = z.infer<typeof gatewayConfigSchema>;

/**
 * ChatGPT issues a unique callback per custom connector:
 * `https://chatgpt.com/connector/oauth/{callback_id}`. Exact allowlist
 * entries cannot know that id ahead of time, so the official host+path
 * prefix is accepted with a conservative id charset.
 */
const CHATGPT_CONNECTOR_OAUTH_REDIRECT =
  /^https:\/\/chatgpt\.com\/connector\/oauth\/[A-Za-z0-9_-]{8,128}$/;

export function isAllowlistedMcpOAuthRedirect(
  redirectUri: string,
  allowlist: readonly string[],
): boolean {
  return allowlist.includes(redirectUri) || CHATGPT_CONNECTOR_OAUTH_REDIRECT.test(redirectUri);
}

export function loadGatewayConfig(environment: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const resolved: NodeJS.ProcessEnv = { ...environment };
  // Vercel does not forward NODE_ENV to the function runtime; derive it from
  // VERCEL_ENV so environment-scoped MCP credentials match the deployment.
  if (!resolved.NODE_ENV && resolved.VERCEL_ENV) {
    resolved.NODE_ENV = resolved.VERCEL_ENV === 'production' ? 'production' : 'development';
  }
  return gatewayConfigSchema.parse(resolved);
}

export interface GoogleOAuthSettings {
  clientId: string;
  clientSecret: string;
  stateSecret: string;
  adminSecret: string;
  publicBaseUrl: string;
}

/**
 * Google OAuth routes are optional at boot: they activate only when every
 * related variable is present, so foundation deployments keep working.
 */
export function googleOAuthSettings(config: GatewayConfig): GoogleOAuthSettings | undefined {
  if (
    !config.GOOGLE_OAUTH_CLIENT_ID ||
    !config.GOOGLE_OAUTH_CLIENT_SECRET ||
    !config.OAUTH_STATE_SECRET ||
    !config.ADMIN_DASHBOARD_SECRET
  ) {
    return undefined;
  }
  return {
    clientId: config.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: config.GOOGLE_OAUTH_CLIENT_SECRET,
    stateSecret: config.OAUTH_STATE_SECRET,
    adminSecret: config.ADMIN_DASHBOARD_SECRET,
    publicBaseUrl: config.PUBLIC_BASE_URL,
  };
}

export interface MicrosoftOAuthSettings {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  stateSecret: string;
  adminSecret: string;
  publicBaseUrl: string;
}

/**
 * Microsoft OAuth routes are optional at boot: they activate only when every
 * related variable is present, so foundation deployments keep working.
 */
export function microsoftOAuthSettings(config: GatewayConfig): MicrosoftOAuthSettings | undefined {
  if (
    !config.MICROSOFT_TENANT_ID ||
    !config.MICROSOFT_CLIENT_ID ||
    !config.MICROSOFT_CLIENT_SECRET ||
    !config.OAUTH_STATE_SECRET ||
    !config.ADMIN_DASHBOARD_SECRET
  ) {
    return undefined;
  }
  return {
    tenantId: config.MICROSOFT_TENANT_ID,
    clientId: config.MICROSOFT_CLIENT_ID,
    clientSecret: config.MICROSOFT_CLIENT_SECRET,
    stateSecret: config.OAUTH_STATE_SECRET,
    adminSecret: config.ADMIN_DASHBOARD_SECRET,
    publicBaseUrl: config.PUBLIC_BASE_URL,
  };
}

export type ZohoRegion = 'eu' | 'com';

/**
 * Zoho is a multi-datacenter product and the datacenter is part of the address:
 * a token minted on `accounts.zoho.eu` is only valid against `mail.zoho.eu`.
 */
export const ZOHO_REGION_HOSTS: Record<ZohoRegion, { accounts: string; mail: string }> = {
  eu: { accounts: 'https://accounts.zoho.eu', mail: 'https://mail.zoho.eu' },
  com: { accounts: 'https://accounts.zoho.com', mail: 'https://mail.zoho.com' },
};

export interface ZohoOAuthSettings {
  clientId: string;
  clientSecret: string;
  region: ZohoRegion;
  stateSecret: string;
  adminSecret: string;
  publicBaseUrl: string;
}

/**
 * Zoho OAuth routes are optional at boot: they activate only when every related
 * variable is present, so deployments without a Zoho mailbox keep working.
 */
export function zohoOAuthSettings(config: GatewayConfig): ZohoOAuthSettings | undefined {
  if (
    !config.ZOHO_CLIENT_ID ||
    !config.ZOHO_CLIENT_SECRET ||
    !config.OAUTH_STATE_SECRET ||
    !config.ADMIN_DASHBOARD_SECRET
  ) {
    return undefined;
  }
  return {
    clientId: config.ZOHO_CLIENT_ID,
    clientSecret: config.ZOHO_CLIENT_SECRET,
    region: config.ZOHO_REGION,
    stateSecret: config.OAUTH_STATE_SECRET,
    adminSecret: config.ADMIN_DASHBOARD_SECRET,
    publicBaseUrl: config.PUBLIC_BASE_URL,
  };
}

/**
 * Variables read by `pnpm db:seed` only, never by the running gateway. The
 * mailboxes themselves come from the registry file (see docs/CONFIGURATION.md).
 */
export const mailboxSeedConfigSchema = z.object({
  DATABASE_URL: z.string().url(),
  // Unset means the default `./mailboxes.json`, which may be absent: the
  // dashboard can add mailboxes instead. A path set explicitly must exist.
  MAILBOXES_FILE: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().min(1).optional(),
  ),
  MCP_CLIENT_ID: z.string().min(1).optional(),
  MCP_CLIENT_SECRET: z.string().min(16).optional(),
});

export type MailboxSeedConfig = z.infer<typeof mailboxSeedConfigSchema>;
