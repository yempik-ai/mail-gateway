import { describe, expect, it } from 'vitest';
import {
  isAllowlistedMcpOAuthRedirect,
  loadGatewayConfig,
  mailboxSeedConfigSchema,
} from '../../packages/core/src/index.js';

const validEnvironment = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:password@localhost:5432/gateway',
  MCP_CLIENT_ID: 'test-client',
  MCP_CLIENT_SECRET: 'a-secret-longer-than-sixteen',
  MCP_CLIENT_ALLOWLIST: 'test-client, second-client',
  TOKEN_ENCRYPTION_CURRENT_VERSION: '1',
  TOKEN_ENCRYPTION_KEYS: '{"1":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}',
};

describe('configuration validation', () => {
  it('coerces typed runtime values and allowlists', () => {
    const config = loadGatewayConfig(validEnvironment);
    expect(config.NODE_ENV).toBe('test');
    expect(config.PORT).toBe(3000);
    expect(config.GLOBAL_KILL_SWITCH).toBe(false);
    expect(config.MCP_CLIENT_ALLOWLIST).toEqual(['test-client', 'second-client']);
    expect(config.MCP_OAUTH_REDIRECT_ALLOWLIST).toEqual([
      'https://claude.ai/api/mcp/auth_callback',
      'https://chatgpt.com/connector_platform_oauth_redirect',
    ]);
  });

  it('accepts official ChatGPT connector callbacks without listing the per-app id', () => {
    const allowlist = ['https://claude.ai/api/mcp/auth_callback'];
    expect(
      isAllowlistedMcpOAuthRedirect(
        'https://chatgpt.com/connector/oauth/AbC123_def-4567',
        allowlist,
      ),
    ).toBe(true);
    expect(
      isAllowlistedMcpOAuthRedirect(
        'https://chatgpt.com/connector_platform_oauth_redirect',
        allowlist,
      ),
    ).toBe(false);
    expect(
      isAllowlistedMcpOAuthRedirect('https://chatgpt.com/connector_platform_oauth_redirect', [
        'https://chatgpt.com/connector_platform_oauth_redirect',
      ]),
    ).toBe(true);
    expect(
      isAllowlistedMcpOAuthRedirect(
        'https://evil.example/connector/oauth/AbC123_def-4567',
        allowlist,
      ),
    ).toBe(false);
    expect(
      isAllowlistedMcpOAuthRedirect('https://chatgpt.com/connector/oauth/short', allowlist),
    ).toBe(false);
    expect(
      isAllowlistedMcpOAuthRedirect(
        'https://chatgpt.com/connector/oauth/AbC123_def-4567/extra',
        allowlist,
      ),
    ).toBe(false);
  });

  it('derives NODE_ENV from VERCEL_ENV when NODE_ENV is absent', () => {
    const withoutNodeEnv: Record<string, string | undefined> = { ...validEnvironment };
    delete withoutNodeEnv.NODE_ENV;
    expect(loadGatewayConfig({ ...withoutNodeEnv, VERCEL_ENV: 'production' }).NODE_ENV).toBe(
      'production',
    );
    expect(loadGatewayConfig({ ...withoutNodeEnv, VERCEL_ENV: 'preview' }).NODE_ENV).toBe(
      'development',
    );
    expect(loadGatewayConfig({ ...validEnvironment, VERCEL_ENV: 'production' }).NODE_ENV).toBe(
      'test',
    );
  });

  it('rejects non-PostgreSQL database URLs and short client secrets', () => {
    expect(() =>
      loadGatewayConfig({
        ...validEnvironment,
        DATABASE_URL: 'https://example.com/database',
        MCP_CLIENT_SECRET: 'short',
      }),
    ).toThrow();
  });

  it('accepts any non-empty operator-chosen dashboard password', () => {
    expect(
      loadGatewayConfig({ ...validEnvironment, ADMIN_DASHBOARD_SECRET: '7' })
        .ADMIN_DASHBOARD_SECRET,
    ).toBe('7');
    expect(
      loadGatewayConfig({ ...validEnvironment, ADMIN_DASHBOARD_SECRET: '' }).ADMIN_DASHBOARD_SECRET,
    ).toBeUndefined();
  });

  it('defaults the quote time zone to UTC and rejects unknown zones', () => {
    expect(loadGatewayConfig(validEnvironment).GATEWAY_TIME_ZONE).toBe('UTC');
    expect(
      loadGatewayConfig({ ...validEnvironment, GATEWAY_TIME_ZONE: '' }).GATEWAY_TIME_ZONE,
    ).toBe('UTC');
    expect(
      loadGatewayConfig({ ...validEnvironment, GATEWAY_TIME_ZONE: 'Europe/Rome' })
        .GATEWAY_TIME_ZONE,
    ).toBe('Europe/Rome');
    expect(() =>
      loadGatewayConfig({ ...validEnvironment, GATEWAY_TIME_ZONE: 'Mars/Olympus_Mons' }),
    ).toThrow(/GATEWAY_TIME_ZONE/);
  });

  it('parses TRUST_PROXY as off, on, a hop count or a list of proxy ranges', () => {
    const trustProxy = (value?: string) =>
      loadGatewayConfig(
        value === undefined ? validEnvironment : { ...validEnvironment, TRUST_PROXY: value },
      ).TRUST_PROXY;
    expect(trustProxy()).toBe(false);
    expect(trustProxy('')).toBe(false);
    expect(trustProxy('false')).toBe(false);
    expect(trustProxy('true')).toBe(true);
    expect(trustProxy(' TRUE ')).toBe(true);
    expect(trustProxy('1')).toBe(1);
    expect(trustProxy('2')).toBe(2);
    expect(trustProxy('10.0.0.0/8, 192.168.1.10,fd00::/8 ,loopback')).toEqual([
      '10.0.0.0/8',
      '192.168.1.10',
      'fd00::/8',
      'loopback',
    ]);
    for (const invalid of ['yes', '10.0.0.0/33', 'fd00::/129', '10.0.0/8', '1.2.3.4/8/1', ',']) {
      expect(() => trustProxy(invalid), invalid).toThrow(/TRUST_PROXY/);
    }
  });

  it('needs only the database URL for the seed: mailboxes come from the registry file', () => {
    expect(mailboxSeedConfigSchema.parse({ DATABASE_URL: validEnvironment.DATABASE_URL })).toEqual({
      DATABASE_URL: validEnvironment.DATABASE_URL,
    });
    expect(
      mailboxSeedConfigSchema.parse({
        DATABASE_URL: validEnvironment.DATABASE_URL,
        MAILBOXES_FILE: '',
      }).MAILBOXES_FILE,
    ).toBeUndefined();
    expect(() => mailboxSeedConfigSchema.parse({})).toThrow();
  });
});
