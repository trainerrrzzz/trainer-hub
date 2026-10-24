import type { Locale } from '@fivvi/i18n';

/** The `signIn.errors.*` catalog key that words a failed request. */
export type SignInErrorKey = 'invalidEmail' | 'invalidOrExpiredCode' | 'noConnection' | 'generic';

export type SignInResult = { ok: true } | { ok: false; error: SignInErrorKey };

const BASE = '/api/auth/sign-in/code';

/**
 * Asks for the sign-in email (EM-08). The answer is the same for every address, so an `ok` says
 * nothing about whether the address has an account. `locale` is the language of the page the
 * email is written in unless the account stores another one (ADR-019).
 */
export function requestCode(
  email: string,
  locale: Locale,
  fetchFn: typeof fetch = fetch,
): Promise<SignInResult> {
  return post('/request', { email, locale }, 'invalidEmail', fetchFn);
}

/** Signs this browser in with the code from the email; the API sets the sign-in session cookie. */
export function verifyCode(
  email: string,
  code: string,
  fetchFn: typeof fetch = fetch,
): Promise<SignInResult> {
  return post('/verify', { email, code }, 'invalidOrExpiredCode', fetchFn);
}

async function post(
  path: string,
  body: unknown,
  onInvalidInput: SignInErrorKey,
  fetchFn: typeof fetch,
): Promise<SignInResult> {
  let response: Response;
  try {
    response = await fetchFn(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, error: 'noConnection' };
  }
  if (response.ok) return { ok: true };
  return { ok: false, error: await errorKey(response, onInvalidInput) };
}

/**
 * The page words every failure itself, from the error code: the API's `message` is English and
 * never shown. One key covers a wrong, expired, used and replaced code (AC7).
 */
async function errorKey(
  response: Response,
  onInvalidInput: SignInErrorKey,
): Promise<SignInErrorKey> {
  const code = await response
    .json()
    .then((body: { code?: unknown } | null) => body?.code)
    .catch(() => undefined);
  if (code === 'INVALID_OR_EXPIRED_CODE') return 'invalidOrExpiredCode';
  if (response.status === 400) return onInvalidInput;
  return 'generic';
}
