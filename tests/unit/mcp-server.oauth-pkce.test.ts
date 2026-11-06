import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256Base64Url, verifyPkceS256 } from '../../apps/mcp-server/src/mcp-oauth.js';

describe('MCP OAuth PKCE (S256)', () => {
  it('accepts a verifier matching its challenge', () => {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = sha256Base64Url(verifier);
    expect(verifyPkceS256(verifier, challenge)).toBe(true);
  });

  it('rejects a wrong verifier, empty input, and malformed challenges', () => {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = sha256Base64Url(verifier);
    expect(verifyPkceS256(randomBytes(32).toString('base64url'), challenge)).toBe(false);
    expect(verifyPkceS256('', challenge)).toBe(false);
    expect(verifyPkceS256(verifier, 'not-a-challenge')).toBe(false);
    expect(verifyPkceS256(verifier, '')).toBe(false);
  });

  it('matches the RFC 7636 appendix B test vector', () => {
    expect(
      verifyPkceS256(
        'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
        'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      ),
    ).toBe(true);
  });
});
