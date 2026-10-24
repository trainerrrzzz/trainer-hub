import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Keyed hash (HMAC-SHA256 with the server secret) of a sign-in link token or code, or of an
 * email or IP address in the rate-limit table. A code has only a million values, so a plain
 * hash of it would fall to brute force the moment the database leaked; without the secret, a
 * keyed hash cannot be tried at all (F001 AC11). The purpose keeps the hashes apart.
 */
export function hashSecretValue(
  secret: string,
  purpose: 'link-token' | 'code' | 'rate-limit-address' | 'rate-limit-ip',
  value: string,
) {
  return createHmac('sha256', secret).update(`${purpose}:${value}`).digest('hex');
}

/** Compares two hashes without leaking, through timing, how much of them matched. */
export function hashesEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
