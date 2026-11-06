import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import {
  HTML_CONTENT_SECURITY_POLICY,
  registerHttpSecurity,
} from '../../apps/mcp-server/src/http-security.js';
import {
  FORWARDED_FOR_IGNORED_LOG,
  FORWARDED_FOR_IGNORED_WARNING,
  WEAK_ADMIN_SECRET_WARNING,
} from '../../apps/mcp-server/src/admin-warnings.js';
import { ADMIN_AUTH_MAX_FAILURES } from '../../apps/mcp-server/src/admin-auth-throttle.js';
import {
  PUBLIC_BASE_URL,
  STRONG_ADMIN_SECRET as STRONG_SECRET,
  basicAuthorization as basic,
  buildGatewayHarness as buildHarness,
  closeAfterTest,
  type GatewayApp,
} from '../support/gateway-server.js';

const WEAK_SECRET = 'short-pass';

describe('CSRF protection of state-changing admin routes', () => {
  const killSwitch = (headers: Record<string, string>) => ({
    method: 'POST' as const,
    url: '/admin/kill-switch',
    headers: {
      authorization: basic(STRONG_SECRET),
      'content-type': 'application/x-www-form-urlencoded',
      ...headers,
    },
    payload: 'action=activate',
  });

  it('refuses a cross-site form post even with valid Basic credentials', async () => {
    const { app } = await buildHarness();
    for (const site of ['cross-site', 'same-site']) {
      const response = await app.inject(
        killSwitch({ 'sec-fetch-site': site, origin: 'https://evil.example' }),
      );
      expect(response.statusCode).toBe(403);
      expect(response.headers['content-type']).toContain('text/plain');
      expect(response.body).toContain('Cross-site request refused');
    }
  });

  it('accepts a same-origin post from the dashboard', async () => {
    const { app } = await buildHarness();
    const response = await app.inject(
      killSwitch({ 'sec-fetch-site': 'same-origin', origin: PUBLIC_BASE_URL }),
    );
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe('/admin');
  });

  it('accepts a user-initiated request (Sec-Fetch-Site: none)', async () => {
    const { app } = await buildHarness();
    const response = await app.inject(killSwitch({ 'sec-fetch-site': 'none' }));
    expect(response.statusCode).toBe(303);
  });

  it('falls back to Origin, then Referer, when fetch metadata is absent', async () => {
    const { app } = await buildHarness();
    expect((await app.inject(killSwitch({ origin: PUBLIC_BASE_URL }))).statusCode).toBe(303);
    expect((await app.inject(killSwitch({ origin: 'https://evil.example' }))).statusCode).toBe(403);
    expect((await app.inject(killSwitch({ origin: 'null' }))).statusCode).toBe(403);
    expect(
      (await app.inject(killSwitch({ referer: `${PUBLIC_BASE_URL}/admin?x=1` }))).statusCode,
    ).toBe(303);
    expect(
      (await app.inject(killSwitch({ referer: 'https://evil.example/admin' }))).statusCode,
    ).toBe(403);
  });

  it('refuses a post that carries no Sec-Fetch-Site, Origin or Referer', async () => {
    const { app } = await buildHarness();
    const response = await app.inject(killSwitch({}));
    expect(response.statusCode).toBe(403);
  });

  it('covers every POST under /admin, before authentication runs', async () => {
    const { app } = await buildHarness();
    for (const url of [
      '/admin/mailboxes/primary-gmail/disable',
      '/admin/migrations/apply',
      '/admin/signatures/apply-all',
      '/admin/signatures/primary-gmail/sync-gmail',
      '/admin/signatures/primary-gmail/outreach%40example.com',
    ]) {
      const response = await app.inject({
        method: 'POST',
        url,
        headers: { 'sec-fetch-site': 'cross-site' },
      });
      expect(response.statusCode, url).toBe(403);
    }
  });

  it('does not block the cross-site GET /authorize navigation, which still needs the password', async () => {
    const { app } = await buildHarness();
    const navigation = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' };
    const anonymous = await app.inject({ method: 'GET', url: '/authorize', headers: navigation });
    expect(anonymous.statusCode).toBe(401);

    const authenticated = await app.inject({
      method: 'GET',
      url: '/authorize?response_type=token',
      headers: { ...navigation, authorization: basic(STRONG_SECRET) },
    });
    // Past CSRF and authentication: the request itself is what is rejected.
    expect(authenticated.statusCode).toBe(400);
    expect(authenticated.json()).toMatchObject({ error: 'invalid_request' });
  });
});

describe('security headers', () => {
  it('sends the strict policy with the admin dashboard HTML', async () => {
    const { app } = await buildHarness();
    const response = await app.inject({
      method: 'GET',
      url: '/admin',
      headers: { authorization: basic(STRONG_SECRET) },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.headers['content-security-policy']).toBe(HTML_CONTENT_SECURITY_POLICY);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['referrer-policy']).toBe('same-origin');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['cache-control']).toBe('no-store');
    // The policy forbids scripts; the page must not depend on one.
    expect(response.body).not.toMatch(/<script/iu);
  });

  it('keeps the anti-framing and no-store headers on admin and authorize challenges', async () => {
    const { app } = await buildHarness();
    for (const url of ['/admin', '/authorize', '/oauth/google/start?mailboxId=x']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(401);
      expect(response.headers['cache-control'], url).toBe('no-store');
      expect(response.headers['x-frame-options'], url).toBe('DENY');
      expect(response.headers['content-security-policy'], url).toContain("frame-ancestors 'none'");
    }
  });

  it('sends the HTML policy with the OAuth result pages', async () => {
    const { app } = await buildHarness();
    const response = await app.inject({ method: 'GET', url: '/oauth/google/callback' });
    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.headers['content-security-policy']).toBe(HTML_CONTENT_SECURITY_POLICY);
    expect(response.headers['referrer-policy']).toBe('same-origin');
  });

  it('marks JSON responses nosniff and no-store without an HTML policy', async () => {
    const { app } = await buildHarness();
    for (const url of [
      '/health/live',
      '/health/ready',
      '/.well-known/oauth-authorization-server',
    ]) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(200);
      expect(response.headers['x-content-type-options'], url).toBe('nosniff');
      expect(response.headers['cache-control'], url).toBe('no-store');
      expect(response.headers['content-security-policy'], url).toBeUndefined();
    }
    const mcp = await app.inject({ method: 'POST', url: '/mcp', payload: {} });
    expect(mcp.statusCode).toBe(503);
    expect(mcp.headers['x-content-type-options']).toBe('nosniff');
    expect(mcp.headers['cache-control']).toBe('no-store');
  });

  it('adds them to the not-found response', async () => {
    const { app } = await buildHarness();
    const response = await app.inject({ method: 'GET', url: '/nope' });
    expect(response.statusCode).toBe(404);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('reaches responses written by a hijacked route, as the MCP transport does', async () => {
    const app = Fastify();
    closeAfterTest(app);
    registerHttpSecurity(app, { publicBaseUrl: PUBLIC_BASE_URL });
    app.post('/stream', (_request, reply) => {
      reply.hijack();
      reply.raw.writeHead(200, { 'content-type': 'text/event-stream' });
      reply.raw.end('data: {}\n\n');
    });
    const response = await app.inject({ method: 'POST', url: '/stream' });
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['cache-control']).toBe('no-store');
  });
});

describe('admin password strength', () => {
  it('warns at boot and on the dashboard when the password is shorter than 16 characters', async () => {
    const { app, logs } = await buildHarness({ env: { ADMIN_DASHBOARD_SECRET: WEAK_SECRET } });
    const warning = logs().find(
      (line) => line.msg === 'admin password is shorter than 16 characters',
    );
    expect(warning).toMatchObject({ level: 40, setting: 'ADMIN_DASHBOARD_SECRET' });
    expect(JSON.stringify(logs())).not.toContain(WEAK_SECRET);

    const response = await app.inject({
      method: 'GET',
      url: '/admin',
      headers: { authorization: basic(WEAK_SECRET) },
    });
    expect(response.statusCode).toBe(200);
    const banner = response.body.indexOf(WEAK_ADMIN_SECRET_WARNING);
    expect(banner).toBeGreaterThan(response.body.indexOf('<body>'));
    expect(banner).toBeLessThan(response.body.indexOf('<h1>'));
  });

  it('shows no banner and logs no warning for a long password', async () => {
    const { app, logs } = await buildHarness();
    expect(logs().some((line) => String(line.msg).includes('admin password'))).toBe(false);
    const response = await app.inject({
      method: 'GET',
      url: '/admin',
      headers: { authorization: basic(STRONG_SECRET) },
    });
    expect(response.body).not.toContain(WEAK_ADMIN_SECRET_WARNING);
  });
});

describe('X-Forwarded-For while TRUST_PROXY is off', () => {
  const forwarded = { 'x-forwarded-for': '192.0.2.1' };
  const dashboard = (app: GatewayApp, headers: Record<string, string> = {}) =>
    app.inject({
      method: 'GET',
      url: '/admin',
      headers: { authorization: basic(STRONG_SECRET), ...headers },
    });
  const proxyWarnings = (logs: () => Record<string, unknown>[]) =>
    logs().filter((line) => line.msg === FORWARDED_FOR_IGNORED_LOG);

  it('logs one structured warning, on the first forwarded request', async () => {
    const { app, logs } = await buildHarness();
    await app.inject({ method: 'GET', url: '/health/live' });
    expect(proxyWarnings(logs)).toEqual([]);

    await app.inject({ method: 'GET', url: '/health/live', headers: forwarded });
    await app.inject({ method: 'GET', url: '/health/live', headers: forwarded });
    await dashboard(app, forwarded);
    expect(proxyWarnings(logs)).toEqual([
      expect.objectContaining({ level: 40, setting: 'TRUST_PROXY', header: 'x-forwarded-for' }),
    ]);
  });

  it('shows the warning on the dashboard for a forwarded request only', async () => {
    const { app } = await buildHarness();
    const direct = await dashboard(app);
    expect(direct.body).not.toContain(FORWARDED_FOR_IGNORED_WARNING);

    const proxied = await dashboard(app, forwarded);
    expect(proxied.statusCode).toBe(200);
    const banner = proxied.body.indexOf(FORWARDED_FOR_IGNORED_WARNING);
    expect(banner).toBeGreaterThan(proxied.body.indexOf('<body>'));
    expect(banner).toBeLessThan(proxied.body.indexOf('<h1>'));
  });

  it('stays quiet once a proxy is trusted', async () => {
    for (const harness of [
      await buildHarness({ env: { TRUST_PROXY: '10.0.0.0/8' } }),
      await buildHarness({ dependencies: { trustProxy: true } }),
    ]) {
      const response = await dashboard(harness.app, forwarded);
      expect(response.body).not.toContain(FORWARDED_FOR_IGNORED_WARNING);
      expect(proxyWarnings(harness.logs)).toEqual([]);
    }
  });
});

describe('failed admin authentication limit', () => {
  const attempt = (app: GatewayApp, password: string | undefined, ip = '203.0.113.7') =>
    app.inject({
      method: 'GET',
      url: '/admin',
      remoteAddress: ip,
      headers: password === undefined ? {} : { authorization: basic(password) },
    });

  it('answers 429 with Retry-After after too many wrong passwords from one IP', async () => {
    const { app } = await buildHarness();
    for (let index = 0; index < ADMIN_AUTH_MAX_FAILURES; index += 1) {
      expect((await attempt(app, `wrong-${index}`)).statusCode).toBe(401);
    }
    const blocked = await attempt(app, 'wrong-again');
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(blocked.headers['retry-after'])).toBeLessThanOrEqual(15 * 60);

    // The right password does not lift the block: guessing must stay stopped.
    expect((await attempt(app, STRONG_SECRET)).statusCode).toBe(429);
    // The budget is shared by every admin-guarded route.
    const authorize = await app.inject({
      method: 'GET',
      url: '/authorize',
      remoteAddress: '203.0.113.7',
      headers: { authorization: basic(STRONG_SECRET) },
    });
    expect(authorize.statusCode).toBe(429);
    // Other clients are unaffected.
    expect((await attempt(app, STRONG_SECRET, '198.51.100.9')).statusCode).toBe(200);
  });

  it('shares one budget across an IPv6 /64 and across the IPv4-mapped form', async () => {
    const { app } = await buildHarness();
    // Every guess from a different address of the same /64.
    for (let index = 0; index < ADMIN_AUTH_MAX_FAILURES; index += 1) {
      const address = `2001:db8:aa:bb::${(index + 1).toString(16)}`;
      expect((await attempt(app, `wrong-${index}`, address)).statusCode).toBe(401);
    }
    expect((await attempt(app, STRONG_SECRET, '2001:db8:aa:bb:ffff::42')).statusCode).toBe(429);
    // The neighbouring /64 is another subscriber.
    expect((await attempt(app, STRONG_SECRET, '2001:db8:aa:bc::1')).statusCode).toBe(200);

    for (let index = 0; index < ADMIN_AUTH_MAX_FAILURES; index += 1) {
      await attempt(app, `wrong-${index}`, '::ffff:198.51.100.20');
    }
    expect((await attempt(app, STRONG_SECRET, '198.51.100.20')).statusCode).toBe(429);
  });

  it('does not count the credential-less request that opens the browser prompt', async () => {
    const { app } = await buildHarness();
    for (let index = 0; index < ADMIN_AUTH_MAX_FAILURES + 5; index += 1) {
      expect((await attempt(app, undefined)).statusCode).toBe(401);
    }
    expect((await attempt(app, STRONG_SECRET)).statusCode).toBe(200);
  });

  it('trusts the forwarded address from TRUST_PROXY, and ignores it by default', async () => {
    const lockOut = async (app: GatewayApp, peer: string) => {
      for (let index = 0; index < ADMIN_AUTH_MAX_FAILURES; index += 1) {
        await app.inject({
          method: 'GET',
          url: '/admin',
          remoteAddress: peer,
          headers: { authorization: basic('wrong'), 'x-forwarded-for': '192.0.2.1' },
        });
      }
    };
    const operator = (app: GatewayApp, peer: string) =>
      app.inject({
        method: 'GET',
        url: '/admin',
        remoteAddress: peer,
        headers: { authorization: basic(STRONG_SECRET), 'x-forwarded-for': '192.0.2.2' },
      });

    // Behind a balancer at 10.0.0.5 trusted by CIDR: the guesser and the
    // operator are told apart by the address the balancer forwards.
    const behindProxy = await buildHarness({ env: { TRUST_PROXY: '10.0.0.0/8' } });
    await lockOut(behindProxy.app, '10.0.0.5');
    expect((await operator(behindProxy.app, '10.0.0.5')).statusCode).toBe(200);

    // A hop count trusts the nearest proxy the same way.
    const oneHop = await buildHarness({ env: { TRUST_PROXY: '1' } });
    await lockOut(oneHop.app, '10.0.0.5');
    expect((await operator(oneHop.app, '10.0.0.5')).statusCode).toBe(200);

    // Default: the header is ignored, so everyone behind the balancer shares
    // its address and budget.
    const untrusted = await buildHarness();
    await lockOut(untrusted.app, '10.0.0.5');
    expect((await operator(untrusted.app, '10.0.0.5')).statusCode).toBe(429);
  });

  it('keys the limit on the forwarded client address only behind a trusted proxy', async () => {
    const trusted = await buildHarness({ dependencies: { trustProxy: true } });
    for (let index = 0; index < ADMIN_AUTH_MAX_FAILURES; index += 1) {
      await trusted.app.inject({
        method: 'GET',
        url: '/admin',
        headers: { authorization: basic('wrong'), 'x-forwarded-for': '192.0.2.1' },
      });
    }
    const sameClient = await trusted.app.inject({
      method: 'GET',
      url: '/admin',
      headers: { authorization: basic(STRONG_SECRET), 'x-forwarded-for': '192.0.2.1' },
    });
    expect(sameClient.statusCode).toBe(429);
    const otherClient = await trusted.app.inject({
      method: 'GET',
      url: '/admin',
      headers: { authorization: basic(STRONG_SECRET), 'x-forwarded-for': '192.0.2.2' },
    });
    expect(otherClient.statusCode).toBe(200);
  });
});

describe('MCP route rate limit', () => {
  const MAX = 3;
  // Unauthenticated on purpose: the limit runs before authentication, so a
  // refused request spends the budget too.
  const call = (app: GatewayApp, remoteAddress: string, clientId?: string) =>
    app.inject({
      method: 'POST',
      url: '/mcp',
      remoteAddress,
      headers: clientId === undefined ? {} : { 'x-mcp-client-id': clientId },
      payload: {},
    });

  it('does not reset the budget when the client rotates x-mcp-client-id', async () => {
    const { app } = await buildHarness({ env: { MCP_RATE_LIMIT_MAX: String(MAX) } });
    for (let index = 0; index < MAX; index += 1) {
      expect((await call(app, '203.0.113.7', `client-${index}`)).statusCode).not.toBe(429);
    }
    expect((await call(app, '203.0.113.7', 'client-fresh')).statusCode).toBe(429);
    expect((await call(app, '203.0.113.7')).statusCode).toBe(429);
    // Another network keeps its own budget.
    expect((await call(app, '198.51.100.9', 'client-0')).statusCode).not.toBe(429);
  });

  it('shares one budget across an IPv6 /64 and across the IPv4-mapped form', async () => {
    const { app } = await buildHarness({ env: { MCP_RATE_LIMIT_MAX: String(MAX) } });
    for (let index = 0; index < MAX; index += 1) {
      const address = `2001:db8:aa:bb::${(index + 1).toString(16)}`;
      expect((await call(app, address)).statusCode).not.toBe(429);
    }
    expect((await call(app, '2001:db8:aa:bb:ffff::42')).statusCode).toBe(429);
    // The neighbouring /64 is another subscriber.
    expect((await call(app, '2001:db8:aa:bc::1')).statusCode).not.toBe(429);

    for (let index = 0; index < MAX; index += 1) {
      await call(app, '::ffff:198.51.100.20');
    }
    expect((await call(app, '198.51.100.20')).statusCode).toBe(429);
  });

  it('keys on the forwarded client address only behind a trusted proxy', async () => {
    const forwarded = (app: GatewayApp, client: string) =>
      app.inject({
        method: 'POST',
        url: '/mcp',
        remoteAddress: '10.0.0.5',
        headers: { 'x-forwarded-for': client },
        payload: {},
      });

    const behindProxy = await buildHarness({
      env: { MCP_RATE_LIMIT_MAX: String(MAX), TRUST_PROXY: '10.0.0.0/8' },
    });
    for (let index = 0; index < MAX; index += 1) await forwarded(behindProxy.app, '192.0.2.1');
    expect((await forwarded(behindProxy.app, '192.0.2.1')).statusCode).toBe(429);
    expect((await forwarded(behindProxy.app, '192.0.2.2')).statusCode).not.toBe(429);

    // Default: the header is ignored, so every client shares the balancer's budget.
    const untrusted = await buildHarness({ env: { MCP_RATE_LIMIT_MAX: String(MAX) } });
    for (let index = 0; index < MAX; index += 1) await forwarded(untrusted.app, '192.0.2.1');
    expect((await forwarded(untrusted.app, '192.0.2.2')).statusCode).toBe(429);
  });
});
