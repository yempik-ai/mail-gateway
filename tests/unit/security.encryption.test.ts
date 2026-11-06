import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decryptToken,
  encryptToken,
  loadTokenKeyring,
  rotateToken,
} from '../../packages/security/src/index.js';

const key = () => randomBytes(32).toString('base64');

describe('token encryption', () => {
  it('round-trips with AES-256-GCM and a unique nonce', () => {
    const keyring = loadTokenKeyring(JSON.stringify({ 1: key() }), 1);
    const first = encryptToken('fake-refresh-token', keyring);
    const second = encryptToken('fake-refresh-token', keyring);

    expect(decryptToken(first, keyring)).toBe('fake-refresh-token');
    expect(first.keyVersion).toBe(1);
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.ciphertext).not.toBe('fake-refresh-token');
  });

  it('decrypts an old version and re-encrypts with the current version', () => {
    const oldKey = key();
    const oldKeyring = loadTokenKeyring(JSON.stringify({ 1: oldKey }), 1);
    const oldEncrypted = encryptToken('rotation-value', oldKeyring);
    const rotatingKeyring = loadTokenKeyring(JSON.stringify({ 1: oldKey, 2: key() }), 2);
    const rotated = rotateToken(oldEncrypted, rotatingKeyring);

    expect(rotated.keyVersion).toBe(2);
    expect(decryptToken(rotated, rotatingKeyring)).toBe('rotation-value');
  });

  it('fails authentication after ciphertext tampering', () => {
    const keyring = loadTokenKeyring(JSON.stringify({ 1: key() }), 1);
    const encrypted = encryptToken('protected', keyring);
    encrypted.ciphertext = Buffer.from('tampered').toString('base64');
    expect(() => decryptToken(encrypted, keyring)).toThrow();
  });
});
