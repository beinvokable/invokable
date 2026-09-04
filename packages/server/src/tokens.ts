import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Token format (spec 5.4): `<prefix>_<32 bytes base62>`.
 *
 * The plaintext is returned to the client exactly once. Only a SHA-256 digest is
 * persisted, so a database leak does not hand over working credentials.
 */

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** User codes avoid 0/O/1/I/L: they are read aloud and typed by hand. */
const USER_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function base62(bytes: Buffer): string {
  let out = '';
  for (const byte of bytes) {
    out += BASE62[byte % 62];
  }
  return out;
}

export function generateToken(prefix: string): { token: string; tokenHash: string } {
  const token = `${prefix}_${base62(randomBytes(32))}`;
  return { token, tokenHash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** `WXYZ-1234`, from an alphabet chosen to survive being read over a phone. */
export function generateUserCode(): string {
  const pick = (n: number): string => {
    const bytes = randomBytes(n);
    let s = '';
    for (const b of bytes) s += USER_CODE_ALPHABET[b % USER_CODE_ALPHABET.length];
    return s;
  };
  return `${pick(4)}-${pick(4)}`;
}

export function generateDeviceCode(): string {
  return randomBytes(32).toString('hex');
}

/** Constant-time comparison for values an attacker can supply repeatedly. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
