// Brute-force brake for the admin password. The password is operator-chosen
// and may be short, and the Basic challenge is reachable from the internet, so
// wrong guesses are counted per client network and refused once over the
// budget.
//
// The counters live in process memory. On Vercel that means per warm instance:
// a distributed guesser hitting several cold instances gets the budget once per
// instance. That still turns an unbounded online attack into a slow one, and
// it needs no shared store.

import { isIPv4, isIPv6 } from 'node:net';

export const ADMIN_AUTH_MAX_FAILURES = 10;
export const ADMIN_AUTH_FAILURE_WINDOW_MS = 15 * 60 * 1000;
export const ADMIN_AUTH_MAX_TRACKED_CLIENTS = 10_000;

export interface AdminAuthThrottle {
  /** Seconds until `key` may try again, or undefined when it is not blocked. */
  retryAfterSeconds(key: string, now?: number): number | undefined;
  /**
   * Counts a failure. False when it could not be counted because every tracked
   * client is blocked (see `createAdminAuthThrottle`).
   */
  recordFailure(key: string, now?: number): boolean;
  reset(key: string): void;
}

interface FailureWindow {
  startedAt: number;
  failures: number;
}

export interface AdminAuthThrottleOptions {
  maxFailures?: number;
  windowMs?: number;
  maxTrackedClients?: number;
}

/** The 16-bit groups of an IPv6 address, or undefined when it is not one. */
function ipv6Groups(address: string): number[] | undefined {
  // A zone index (fe80::1%eth0) names an interface, not a different host.
  let text = address.split('%')[0] ?? '';
  if (!isIPv6(text)) return undefined;
  // An embedded dotted quad (::ffff:192.0.2.1) becomes its two groups.
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (isIPv4(tail)) {
    const [a = 0, b = 0, c = 0, d = 0] = tail.split('.').map(Number);
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', rest] = text.split('::');
  const headGroups = head ? head.split(':') : [];
  const restGroups = rest === undefined ? [] : rest ? rest.split(':') : [];
  const missing = 8 - headGroups.length - restGroups.length;
  const groups = [
    ...headGroups,
    ...Array<string>(rest === undefined ? 0 : missing).fill('0'),
    ...restGroups,
  ];
  return groups.map((group) => Number.parseInt(group, 16));
}

/**
 * The throttle key of a client address. An IPv4 client is its address; an
 * IPv6 client is its /64, the smallest block a provider assigns to one
 * subscriber, so rotating addresses inside it buys no extra guesses. An
 * IPv4-mapped IPv6 address (`::ffff:a.b.c.d`, what a dual-stack socket
 * reports) is the IPv4 client it maps. Anything else is used as given.
 *
 * The MCP route rate limit uses the same key, for the same reason: it runs
 * before authentication, so only the network address is not client-chosen.
 */
export function adminThrottleKey(address: string): string {
  if (isIPv4(address)) return address;
  const groups = ipv6Groups(address);
  if (groups === undefined) return address;
  const [g0, g1, g2, g3, g4, g5, g6 = 0, g7 = 0] = groups;
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return `${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`;
  }
  return `${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(':')}::/64`;
}

/**
 * Memory is bounded at `maxTrackedClients`. When the table is full, expired
 * windows go first, then the oldest clients that are not blocked. A blocked
 * client is never evicted: evicting it would hand a fresh budget to a source
 * already caught guessing, which is exactly what an attacker flooding the
 * table with new sources wants.
 *
 * If every tracked client is blocked, a failure from a new source is not
 * counted (`recordFailure` returns false) rather than refused outright.
 * Getting there takes the full budget from that many distinct networks within
 * one window; refusing every newcomer at that point would let the same flood
 * lock the operator out of the dashboard for good, while not counting keeps
 * the dashboard reachable and still blocks every source already caught. The
 * auth hook logs each uncounted failure so the flood is visible.
 */
export function createAdminAuthThrottle(options: AdminAuthThrottleOptions = {}): AdminAuthThrottle {
  const maxFailures = options.maxFailures ?? ADMIN_AUTH_MAX_FAILURES;
  const windowMs = options.windowMs ?? ADMIN_AUTH_FAILURE_WINDOW_MS;
  const maxTrackedClients = options.maxTrackedClients ?? ADMIN_AUTH_MAX_TRACKED_CLIENTS;
  // Map iteration follows insertion order, so the first entries are the oldest.
  const windows = new Map<string, FailureWindow>();

  const active = (key: string, now: number): FailureWindow | undefined => {
    const window = windows.get(key);
    if (window && now - window.startedAt >= windowMs) {
      windows.delete(key);
      return undefined;
    }
    return window;
  };

  const evict = (now: number) => {
    for (const [key, window] of windows) {
      if (now - window.startedAt >= windowMs) windows.delete(key);
    }
    for (const [key, window] of windows) {
      if (windows.size < maxTrackedClients) break;
      if (window.failures < maxFailures) windows.delete(key);
    }
  };

  return {
    retryAfterSeconds(key, now = Date.now()) {
      const window = active(key, now);
      if (!window || window.failures < maxFailures) return undefined;
      return Math.max(1, Math.ceil((window.startedAt + windowMs - now) / 1000));
    },
    recordFailure(key, now = Date.now()) {
      const window = active(key, now);
      if (window) {
        window.failures += 1;
        return true;
      }
      if (windows.size >= maxTrackedClients) evict(now);
      if (windows.size >= maxTrackedClients) return false;
      windows.set(key, { startedAt: now, failures: 1 });
      return true;
    },
    reset(key) {
      windows.delete(key);
    },
  };
}
