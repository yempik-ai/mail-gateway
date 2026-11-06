import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const KEY_LENGTH = 64;

export async function hashClientSecret(secret: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scrypt(secret, salt, KEY_LENGTH)) as Buffer;
  return `scrypt$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export async function verifyClientSecret(secret: string, encodedHash: string): Promise<boolean> {
  const [algorithm, encodedSalt, encodedExpected] = encodedHash.split('$');
  if (algorithm !== 'scrypt' || !encodedSalt || !encodedExpected) {
    return false;
  }

  const salt = Buffer.from(encodedSalt, 'base64');
  const expected = Buffer.from(encodedExpected, 'base64');
  const actual = (await scrypt(secret, salt, expected.length)) as Buffer;
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
