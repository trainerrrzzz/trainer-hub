import { describe, expect, it, vi } from 'vitest';
import { requestCode, verifyCode } from './sign-in-client';

const reply = (status: number, body: unknown = {}) =>
  vi.fn<typeof fetch>(() => Promise.resolve(Response.json(body, { status })));

describe('F001 sign-in client of TW-10', () => {
  it('posts the address and the page language to request an email', async () => {
    const fetchFn = reply(200, { status: true });

    expect(await requestCode('owner@example.com', 'nl-NL', fetchFn)).toEqual({ ok: true });

    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe('/api/auth/sign-in/code/request');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({
      email: 'owner@example.com',
      locale: 'nl-NL',
    });
  });

  it('posts the address and the code to sign in', async () => {
    const fetchFn = reply(200, { status: true });

    expect(await verifyCode('owner@example.com', '123456', fetchFn)).toEqual({ ok: true });

    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe('/api/auth/sign-in/code/verify');
    expect(JSON.parse(String(init?.body))).toEqual({ email: 'owner@example.com', code: '123456' });
  });

  it('maps the API error code to a catalog key, never showing its English message', async () => {
    const fetchFn = reply(401, {
      code: 'INVALID_OR_EXPIRED_CODE',
      message: 'The code is incorrect or has expired.',
    });

    expect(await verifyCode('owner@example.com', '000000', fetchFn)).toEqual({
      ok: false,
      error: 'invalidOrExpiredCode',
    });
  });

  it('says the address is wrong when the API rejects it as invalid', async () => {
    const fetchFn = reply(400, { code: 'VALIDATION_ERROR', message: 'Invalid email' });

    expect(await requestCode('nope', 'en', fetchFn)).toEqual({ ok: false, error: 'invalidEmail' });
  });

  it('treats a malformed code like a wrong code', async () => {
    const fetchFn = reply(400, { code: 'VALIDATION_ERROR', message: 'Too big' });

    expect(await verifyCode('owner@example.com', 'x'.repeat(40), fetchFn)).toEqual({
      ok: false,
      error: 'invalidOrExpiredCode',
    });
  });

  it('answers with the generic error for any other failure', async () => {
    expect(await requestCode('owner@example.com', 'en', reply(500, 'oops'))).toEqual({
      ok: false,
      error: 'generic',
    });
    expect(await verifyCode('owner@example.com', '123456', reply(429, {}))).toEqual({
      ok: false,
      error: 'generic',
    });
  });

  it('reports no connection when the request cannot reach the server', async () => {
    const fetchFn = vi.fn<typeof fetch>(() => Promise.reject(new TypeError('Failed to fetch')));

    expect(await requestCode('owner@example.com', 'en', fetchFn)).toEqual({
      ok: false,
      error: 'noConnection',
    });
  });
});
