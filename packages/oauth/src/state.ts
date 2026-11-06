import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export interface OAuthStatePayload {
  mailboxId: string;
  nonce: string;
  issuedAt: number;
}

export const DEFAULT_STATE_TTL_MS = 10 * 60 * 1000;

function signPayload(encodedPayload: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(encodedPayload).digest();
}

export function createOAuthState(mailboxId: string, secret: string, now = Date.now()): string {
  const payload: OAuthStatePayload = {
    mailboxId,
    nonce: randomBytes(16).toString('hex'),
    issuedAt: now,
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${encoded}.${signPayload(encoded, secret).toString('base64url')}`;
}

export function verifyOAuthState(
  state: string,
  secret: string,
  maxAgeMs = DEFAULT_STATE_TTL_MS,
  now = Date.now(),
): OAuthStatePayload | undefined {
  const separator = state.lastIndexOf('.');
  if (separator < 1) return undefined;

  const encoded = state.slice(0, separator);
  const signature = Buffer.from(state.slice(separator + 1), 'base64url');
  const expected = signPayload(encoded, secret);
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object') return undefined;

  const candidate = parsed as Partial<OAuthStatePayload>;
  if (
    typeof candidate.mailboxId !== 'string' ||
    candidate.mailboxId.length === 0 ||
    typeof candidate.nonce !== 'string' ||
    typeof candidate.issuedAt !== 'number'
  ) {
    return undefined;
  }
  if (candidate.issuedAt > now || now - candidate.issuedAt > maxAgeMs) return undefined;

  return { mailboxId: candidate.mailboxId, nonce: candidate.nonce, issuedAt: candidate.issuedAt };
}
