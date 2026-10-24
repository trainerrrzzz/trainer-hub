import { describe, expect, it } from 'vitest';
import { hashesEqual, hashSecretValue } from './hash.ts';

const secret = 'test-secret-that-is-at-least-thirty-two-characters-long';

describe('F001 hashes of sign-in links and codes', () => {
  it('are keyed: the same value hashes differently under another secret', () => {
    const a = hashSecretValue(secret, 'code', 'owner@example.com:482915');
    const b = hashSecretValue(`${secret}-other`, 'code', 'owner@example.com:482915');

    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });

  it('are stable for the same secret, purpose and value', () => {
    expect(hashSecretValue(secret, 'code', '482915')).toBe(
      hashSecretValue(secret, 'code', '482915'),
    );
  });

  it('do not mix a code with a link token of the same text', () => {
    expect(hashSecretValue(secret, 'code', '482915')).not.toBe(
      hashSecretValue(secret, 'link-token', '482915'),
    );
  });

  it('keep the rate-limit hashes of an address and of an IP address apart', () => {
    expect(hashSecretValue(secret, 'rate-limit-address', 'a')).not.toBe(
      hashSecretValue(secret, 'rate-limit-ip', 'a'),
    );
  });

  it('are compared without a length error', () => {
    const hash = hashSecretValue(secret, 'code', '482915');
    expect(hashesEqual(hash, hash)).toBe(true);
    expect(hashesEqual(hash, hash.slice(1))).toBe(false);
    expect(hashesEqual(hash, hashSecretValue(secret, 'code', '482916'))).toBe(false);
  });
});
