# @fivvi/auth

Sign-in for the web and, later, the native apps (ADR-007, F001): [Better Auth](https://better-auth.com) on our own Postgres tables. **The only code that imports Better Auth** (a Biome rule in `biome.json` enforces it); `apps/web` and `packages/api` use the interface in `src/auth.ts`. Server-side only.

```ts
import { createAuth } from '@fivvi/auth';

const auth = createAuth({ db, secret, baseURL, sendEmail }); // apps/web/server/auth.ts
auth.handler(request); // served under /api/auth/* by apps/web/app/api/auth/[...all]/route.ts
await auth.findAccount(request.headers); // the signed-in account of the cookie, or undefined (GET /api/v1/me)
```

## How sign-in works

A person signs in with only their email address. One request creates **one verification** that holds both the link token and the 6-digit code of the one EM-08 email (`packages/email`). Better Auth's own magic-link and email-OTP plugins each send their own email with their own token, so `src/sign-in-plugin.ts` is a small custom plugin instead:

| Endpoint (under `/api/auth`) | Body | Result |
|---|---|---|
| `POST /sign-in/code/request` | `{ email, locale? }` | Always `200 { status: true }`. An existing account, or an address on the sign-up allowlist, gets one EM-08 email: in the account's stored language, else in the language of the page that asked (`locale`, else `Accept-Language`, else English; ADR-019). Any other address gets the same answer and no email |
| `POST /sign-in/code/verify` | `{ email, code }` | The right code: `200` and the sign-in session cookie; for an allowlisted address without an account, the account is created first. Anything else: `401 INVALID_OR_EXPIRED_CODE`, never saying which case it was |

- **Hashes only (AC11).** `auth_verifications.value` holds the HMAC-SHA256 of the link token and `code_hash` that of the code, keyed with `BETTER_AUTH_SECRET` (a code has a million values, so an unkeyed hash would fall to brute force). The database never holds a usable token or code.
- **One per address.** `identifier` is `sign-in:<lower-case email>`; a new request deletes the old verification (the old link and code stop working), and using the code consumes the checked row in one atomic delete, so the link is used up with it (AC4).
- **5 wrong codes kill it (AC6).** `auth_verifications.failed_attempts` counts wrong codes in one `UPDATE ... RETURNING`, so parallel guesses are all counted. At 5 the row is deleted, link and code, and even the right code fails; a new request starts a fresh verification. Every failure (wrong, expired, used, replaced, killed, unknown address) is the same `401 INVALID_OR_EXPIRED_CODE`.
- **Expires after 15 minutes.** The link in the email points at the sign-in page's confirm step, `/login/confirm?token=…` (TW-10, built later), never at a Better Auth URL that would consume the token on a scanner's GET.
- **Cookie.** `HttpOnly`, `SameSite=Lax`, `Secure` unless the base URL is plain `http` (local); 30 days, renewed on use.
- **Closed sign-up (AC8, AC9).** `SIGN_UP_ALLOWED_EMAILS` (`src/allowlist.ts`: exact addresses and `@domain` entries, nothing when empty) is the only way to get an account. An allowed address without an account gets the email like an account does; its account is created when its code is entered, with the language of that email as `preferred_locale` (stored on the verification as `locale`), and it is checked again then. Every other unknown address gets the same status and body and no email, no account and no verification.
- **The answer does not wait for the work.** Looking up the account, writing the verification and sending the email run after the answer (`runInBackground`), for every address alike, so the answer's time never shows who has an account. A failure of that work is logged by error name only (an `EmailSendError` by its message, which names the provider, status and error code, never the address) and passed to `reportError` (Sentry in `apps/web`); the person asks again. This relies on a long-running Node process, which Railway is; a serverless runtime would need its `waitUntil` here.
- No passwords: an address that is neither an account nor allowed is answered like any other.

Not here yet (spec #128, later tickets): the confirm-link endpoint (#136; it creates the account the same way), rate limits (#134), the confirm step, the route guard and sign out (#137) and product events. The code step of the sign-in page (`/login`, `apps/web/app/login`) calls the two endpoints above with `fetch` and words a failed code from the error code, never from the English message.

## Tables

`auth_users` (an account), `auth_sessions` (a sign-in session), `auth_identities` and `auth_verifications`, in `packages/database/src/schema/auth.ts`. They have no `organization_id`: an account is global and shared by every workspace of its person. Better Auth's start-up schema check is off (`advanced.database.validateSchema`), because the tables lack columns it writes only for passwords, OAuth and images; the integration tests run against the real migrated tables.

## Configuration

`BETTER_AUTH_SECRET` (at least 32 characters, a secret per environment), `BETTER_AUTH_URL` (the public address) and `SIGN_UP_ALLOWED_EMAILS` (who may sign up): [`ENVIRONMENTS.md §7`](../../docs/engineering/ENVIRONMENTS.md#7-variables). Emails go through `createEnvironmentSendEmail()` in `packages/email`: to the server log for `@example.com` outside production, otherwise Brevo.

## Tests

The tests drive the HTTP endpoints, not Better Auth's internals: `packages/api/test/sign-in.integration.test.ts` (real Postgres, in-memory email transport; `pnpm --filter @fivvi/api test:integration`). `src/hash.test.ts` covers the hashes.
