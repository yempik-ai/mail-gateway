import { describe, expect, it } from 'vitest';
import {
  createOAuthState,
  DEFAULT_STATE_TTL_MS,
  verifyOAuthState,
} from '../../packages/oauth/src/index.js';

const SECRET = 'a-state-secret-longer-than-sixteen';

describe('OAuth state parameter', () => {
  it('round-trips a signed payload', () => {
    const state = createOAuthState('primary-gmail', SECRET);
    const payload = verifyOAuthState(state, SECRET);
    expect(payload?.mailboxId).toBe('primary-gmail');
    expect(payload?.nonce).toMatch(/^[0-9a-f]{32}$/);
  });

  it('produces unique nonces per state', () => {
    const first = createOAuthState('primary-gmail', SECRET);
    const second = createOAuthState('primary-gmail', SECRET);
    expect(first).not.toBe(second);
  });

  it('rejects a tampered payload', () => {
    const state = createOAuthState('primary-gmail', SECRET);
    const [encoded, signature] = state.split('.') as [string, string];
    const decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    const forged = Buffer.from(
      JSON.stringify({ ...decoded, mailboxId: 'other-gmail' }),
      'utf8',
    ).toString('base64url');
    expect(verifyOAuthState(`${forged}.${signature}`, SECRET)).toBeUndefined();
  });

  it('rejects a wrong secret, garbage input, and truncated states', () => {
    const state = createOAuthState('primary-gmail', SECRET);
    expect(verifyOAuthState(state, 'another-secret-longer-than-16')).toBeUndefined();
    expect(verifyOAuthState('not-a-state', SECRET)).toBeUndefined();
    expect(verifyOAuthState('', SECRET)).toBeUndefined();
    expect(verifyOAuthState(state.split('.')[0] ?? '', SECRET)).toBeUndefined();
  });

  it('rejects expired and future-dated states', () => {
    const now = Date.now();
    const state = createOAuthState('primary-gmail', SECRET, now);
    expect(
      verifyOAuthState(state, SECRET, DEFAULT_STATE_TTL_MS, now + DEFAULT_STATE_TTL_MS + 1),
    ).toBeUndefined();
    expect(verifyOAuthState(state, SECRET, DEFAULT_STATE_TTL_MS, now - 1)).toBeUndefined();
    expect(verifyOAuthState(state, SECRET, DEFAULT_STATE_TTL_MS, now + 1000)).toBeDefined();
  });
});
