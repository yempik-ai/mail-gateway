import { describe, expect, it } from 'vitest';
import {
  ADMIN_AUTH_FAILURE_WINDOW_MS,
  adminThrottleKey,
  createAdminAuthThrottle,
} from '../../apps/mcp-server/src/admin-auth-throttle.js';
import {
  WEAK_ADMIN_SECRET_WARNING,
  isWeakAdminSecret,
  withAdminWarnings,
} from '../../apps/mcp-server/src/admin-warnings.js';
import { isAdminSurface } from '../../apps/mcp-server/src/http-security.js';
import { renderConsentPage } from '../../apps/mcp-server/src/oauth-pages.js';

describe('consent page escaping', () => {
  it('escapes both quote styles in attribute values', () => {
    const page = renderConsentPage({
      clientName: `Evil "quoted" 'name'`,
      clientId: 'client-1',
      redirectDestination: 'claude.ai',
      fields: { state: `"><script>x</script>'` },
    });
    expect(page).toContain(
      '<input type="hidden" name="state" value="&quot;&gt;&lt;script&gt;x&lt;/script&gt;&#39;">',
    );
    expect(page).toContain('Evil &quot;quoted&quot; &#39;name&#39;');
    expect(page).not.toContain('<script>');
  });
});

describe('admin authentication throttle', () => {
  it('blocks after the failure budget and reports the remaining wait', () => {
    const throttle = createAdminAuthThrottle({ maxFailures: 3, windowMs: 60_000 });
    const start = 1_000_000;
    for (let index = 0; index < 2; index += 1) throttle.recordFailure('ip', start);
    expect(throttle.retryAfterSeconds('ip', start)).toBeUndefined();
    throttle.recordFailure('ip', start);
    expect(throttle.retryAfterSeconds('ip', start + 15_000)).toBe(45);
    expect(throttle.retryAfterSeconds('other-ip', start)).toBeUndefined();
  });

  it('forgets failures once the window has passed', () => {
    const throttle = createAdminAuthThrottle();
    const start = 5_000_000;
    for (let index = 0; index < 10; index += 1) throttle.recordFailure('ip', start);
    expect(throttle.retryAfterSeconds('ip', start)).toBe(ADMIN_AUTH_FAILURE_WINDOW_MS / 1000);
    expect(throttle.retryAfterSeconds('ip', start + ADMIN_AUTH_FAILURE_WINDOW_MS)).toBeUndefined();
    throttle.recordFailure('ip', start + ADMIN_AUTH_FAILURE_WINDOW_MS);
    expect(throttle.retryAfterSeconds('ip', start + ADMIN_AUTH_FAILURE_WINDOW_MS)).toBeUndefined();
  });

  it('clears a client on reset', () => {
    const throttle = createAdminAuthThrottle({ maxFailures: 1 });
    throttle.recordFailure('ip');
    expect(throttle.retryAfterSeconds('ip')).toBeGreaterThan(0);
    throttle.reset('ip');
    expect(throttle.retryAfterSeconds('ip')).toBeUndefined();
  });

  it('never evicts a blocked client to make room for new ones', () => {
    const throttle = createAdminAuthThrottle({ maxFailures: 2, maxTrackedClients: 3 });
    const start = 1_000_000;
    throttle.recordFailure('attacker', start);
    throttle.recordFailure('attacker', start);
    expect(throttle.retryAfterSeconds('attacker', start)).toBeGreaterThan(0);
    // A spray of new sources pushes out the oldest clients that are not blocked.
    for (let index = 0; index < 10; index += 1) {
      expect(throttle.recordFailure(`spray-${index}`, start + index)).toBe(true);
    }
    expect(throttle.retryAfterSeconds('attacker', start + 10)).toBeGreaterThan(0);
  });

  it('stops counting new sources, without blocking them, once every tracked client is blocked', () => {
    const throttle = createAdminAuthThrottle({ maxFailures: 1, maxTrackedClients: 2 });
    const start = 1_000_000;
    expect(throttle.recordFailure('a', start)).toBe(true);
    expect(throttle.recordFailure('b', start)).toBe(true);
    expect(throttle.recordFailure('newcomer', start)).toBe(false);
    expect(throttle.retryAfterSeconds('newcomer', start)).toBeUndefined();
    expect(throttle.retryAfterSeconds('a', start)).toBeGreaterThan(0);
    expect(throttle.retryAfterSeconds('b', start)).toBeGreaterThan(0);
    // Once the blocks expire there is room again.
    expect(throttle.recordFailure('newcomer', start + ADMIN_AUTH_FAILURE_WINDOW_MS)).toBe(true);
  });
});

describe('admin throttle key', () => {
  it('keys IPv4 clients by address and IPv6 clients by their /64', () => {
    expect(adminThrottleKey('203.0.113.7')).toBe('203.0.113.7');
    expect(adminThrottleKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64');
    expect(adminThrottleKey('2001:DB8:1:2::1')).toBe('2001:db8:1:2::/64');
    expect(adminThrottleKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(adminThrottleKey('::1')).toBe('0:0:0:0::/64');
    expect(adminThrottleKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(adminThrottleKey('64:ff9b::192.0.2.1')).toBe('64:ff9b:0:0::/64');
  });

  it('treats an IPv4-mapped IPv6 address as the IPv4 client', () => {
    expect(adminThrottleKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(adminThrottleKey('::FFFF:cb00:7107')).toBe('203.0.113.7');
  });

  it('leaves anything that is not an address as it is', () => {
    expect(adminThrottleKey('unknown')).toBe('unknown');
  });
});

describe('admin password warnings', () => {
  it('treats fewer than 16 characters as weak', () => {
    expect(isWeakAdminSecret('x'.repeat(15))).toBe(true);
    expect(isWeakAdminSecret('x'.repeat(16))).toBe(false);
  });

  it('puts the banner first in the body and leaves strong passwords alone', () => {
    const page = '<!doctype html><html><head></head><body class="x"><h1>Gateway</h1></body></html>';
    const warned = withAdminWarnings(page, 'short');
    expect(warned).toContain(`<body class="x"><div role="alert"`);
    expect(warned).toContain(WEAK_ADMIN_SECRET_WARNING);
    expect(warned.indexOf(WEAK_ADMIN_SECRET_WARNING)).toBeLessThan(warned.indexOf('<h1>'));
    expect(withAdminWarnings(page, 'a-long-enough-admin-password')).toBe(page);
  });
});

describe('admin surface matching', () => {
  it('matches the dashboard, the connect flows and MCP consent only', () => {
    for (const path of ['/admin', '/admin/kill-switch', '/authorize', '/oauth/zoho/start']) {
      expect(isAdminSurface(path), path).toBe(true);
    }
    for (const path of [
      '/administrator',
      '/oauth/zoho/callback',
      '/token',
      '/mcp',
      '/health/live',
    ]) {
      expect(isAdminSurface(path), path).toBe(false);
    }
  });
});
