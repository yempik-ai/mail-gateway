import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { z } from 'zod';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const NONCE_BYTES = 12;

export interface EncryptedToken {
  ciphertext: string;
  nonce: string;
  authTag: string;
  keyVersion: number;
}

export interface TokenKeyring {
  currentVersion: number;
  keys: ReadonlyMap<number, Buffer>;
}

const serializedKeyringSchema = z.record(z.string(), z.string().min(1));

function decodeKey(encoded: string, version: number): Buffer {
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(`Encryption key version ${version} must decode to exactly ${KEY_BYTES} bytes`);
  }
  return key;
}

export function loadTokenKeyring(serializedKeys: string, currentVersion: number): TokenKeyring {
  const parsed: unknown = JSON.parse(serializedKeys);
  const configured = serializedKeyringSchema.parse(parsed);
  const keys = new Map<number, Buffer>();

  for (const [rawVersion, encodedKey] of Object.entries(configured)) {
    const version = Number(rawVersion);
    if (!Number.isSafeInteger(version) || version <= 0) {
      throw new Error(`Invalid encryption key version: ${rawVersion}`);
    }
    keys.set(version, decodeKey(encodedKey, version));
  }

  if (!keys.has(currentVersion)) {
    throw new Error(`Current encryption key version ${currentVersion} is not configured`);
  }

  return { currentVersion, keys };
}

export function loadTokenKeyringFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): TokenKeyring {
  const serializedKeys = environment.TOKEN_ENCRYPTION_KEYS;
  const rawCurrentVersion = environment.TOKEN_ENCRYPTION_CURRENT_VERSION;
  if (!serializedKeys || !rawCurrentVersion) {
    throw new Error('TOKEN_ENCRYPTION_KEYS and TOKEN_ENCRYPTION_CURRENT_VERSION are required');
  }
  const currentVersion = Number(rawCurrentVersion);
  if (!Number.isSafeInteger(currentVersion) || currentVersion <= 0) {
    throw new Error('TOKEN_ENCRYPTION_CURRENT_VERSION must be a positive integer');
  }
  return loadTokenKeyring(serializedKeys, currentVersion);
}

export function encryptToken(plaintext: string, keyring: TokenKeyring): EncryptedToken {
  const key = keyring.keys.get(keyring.currentVersion);
  if (!key) {
    throw new Error(`Current encryption key version ${keyring.currentVersion} is unavailable`);
  }

  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

  return {
    ciphertext: ciphertext.toString('base64'),
    nonce: nonce.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    keyVersion: keyring.currentVersion,
  };
}

export function decryptToken(encrypted: EncryptedToken, keyring: TokenKeyring): string {
  const key = keyring.keys.get(encrypted.keyVersion);
  if (!key) {
    throw new Error(`Encryption key version ${encrypted.keyVersion} is unavailable`);
  }

  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(encrypted.nonce, 'base64'));
  decipher.setAuthTag(Buffer.from(encrypted.authTag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

export function rotateToken(encrypted: EncryptedToken, keyring: TokenKeyring): EncryptedToken {
  return encryptToken(decryptToken(encrypted, keyring), keyring);
}
