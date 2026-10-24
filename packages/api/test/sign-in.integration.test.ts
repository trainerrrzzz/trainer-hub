import { type CreateAuthOptions, createAuth, parseSignUpAllowlist } from '@fivvi/auth';
import {
  authRateLimits,
  authUsers,
  authVerifications,
  createDatabase,
  type DatabaseClient,
} from '@fivvi/database';
import { seed } from '@fivvi/database/seed';
import {
  createMemoryTransport,
  createSendEmail,
  EmailSendError,
  type EmailTransport,
  type OutgoingEmail,
} from '@fivvi/email';
import { messages } from '@fivvi/i18n';
import { type Clock, freezeSystemTime, manualClock } from '@fivvi/testing/clock';
import { cloneTemplateDatabase, type TestDatabase } from '@fivvi/testing/database';
import { eq, ne } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

const SECRET = 'test-secret-that-is-at-least-thirty-two-characters-long';
const ORIGIN = 'http://localhost:3000';
/** The fixed start of the clock tests (a Tuesday, 12:00 in Amsterdam). */
const T0 = '2026-03-31T10:00:00Z';

/** The part of the `pg` pool the interleaving test wraps. */
interface PoolLike {
  query(...args: unknown[]): Promise<unknown>;
}

describe('F001 sign in with the emailed code through the API', () => {
  let database: TestDatabase;
  let client: DatabaseClient;
  const transport = createMemoryTransport();
  /** The sign-in requests' work that runs after their answer; `requestCode` waits for it. */
  const pending: Promise<void>[] = [];
  let allowlist = parseSignUpAllowlist(undefined);
  let reportedErrors: unknown[] = [];

  /** The server as apps/web wires it, with the email transport in memory. */
  interface AuthAtOptions {
    baseURL?: string;
    clock?: Clock;
    emailTransport?: EmailTransport;
    log?: (line: string) => void;
    requireClientIp?: boolean;
    /** Any other option of `createAuth`, which wins over the defaults of this helper. */
    overrides?: Partial<CreateAuthOptions>;
  }

  function authAt({
    baseURL = ORIGIN,
    clock,
    emailTransport = transport,
    log,
    requireClientIp,
    overrides = {},
  }: AuthAtOptions = {}) {
    return createAuth({
      db: client.db,
      secret: SECRET,
      baseURL,
      ...(clock ? { clock } : {}),
      ...(log ? { log } : {}),
      ...(requireClientIp === undefined ? {} : { requireClientIp }),
      signUpAllowlist: allowlist,
      runInBackground: (task) => pending.push(task),
      reportError: (error) => reportedErrors.push(error),
      sendEmail: createSendEmail({
        transport: emailTransport,
        sender: { email: 'noreply@fivvi.app', name: 'Fivvi' },
      }),
      ...overrides,
    });
  }

  const auth = () => authAt();

  /** Waits until the work that followed the answers of the sign-in requests so far is done. */
  const settle = async () => {
    await Promise.all(pending.splice(0));
  };

  interface PostOptions {
    headers?: Record<string, string>;
    server?: ReturnType<typeof auth>;
  }

  async function post(
    path: string,
    body: unknown,
    { headers = {}, server = auth() }: PostOptions = {},
  ) {
    return await server.handler(
      new Request(`${ORIGIN}/api/auth${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers },
        body: JSON.stringify(body),
      }),
    );
  }

  /** Asks for a code and waits for the email to be sent, which happens after the answer. */
  async function requestCode(email: string, locale?: string, options: PostOptions = {}) {
    const response = await post('/sign-in/code/request', { email, locale }, options);
    await settle();
    return response;
  }
  const enterCode = (email: string, code: string, server = auth()) =>
    post('/sign-in/code/verify', { email, code }, { server });

  /** The 6-digit code and the sign-in link token in the latest email, of `count` sent so far. */
  function readEmail(count = 1) {
    expect(transport.sent).toHaveLength(count);
    const email = transport.sent.at(-1);
    if (!email) throw new Error('No email was sent.');
    const code = /\b(\d{6})\b/.exec(email.text)?.[1] ?? '';
    const link = email.links.find((href) => href.includes('/login/confirm')) ?? '';
    return { email, code, link, token: new URL(link, ORIGIN).searchParams.get('token') ?? '' };
  }

  /** A 6-digit code that is not `code`. */
  const wrongCodeFor = (code: string) => (code === '000000' ? '000001' : '000000');

  /** Status and body of a response, to compare failures: they must look the same. */
  async function outcome(response: Response) {
    return {
      status: response.status,
      body: await response.json(),
      cookies: response.headers.getSetCookie(),
    };
  }

  /** A second account, removed again when the test ends. */
  async function addTrainerAccount(preferredLocale: 'nl-NL' | 'en' | null = null) {
    await client.db.insert(authUsers).values({ email: 'trainer@example.com', preferredLocale });
    onTestFinished(async () => {
      await client.db.delete(authUsers).where(eq(authUsers.email, 'trainer@example.com'));
    });
  }

  /** Both accounts have asked for a code; their codes, in order. */
  async function ownerAndTrainerCodes() {
    await addTrainerAccount();
    await requestCode('owner@example.com', 'en');
    const owner = readEmail().code;
    await requestCode('trainer@example.com', 'en');
    const trainer = readEmail(2).code;
    return { owner, trainer };
  }

  const verifications = () => client.db.select().from(authVerifications);

  /**
   * Runs `during` right after the verification was found and before it is consumed (Better Auth
   * then tidies up expired rows), to make another request land in between. Drizzle keeps its
   * connection pool on `$client`, which the `Database` type doesn't show.
   */
  function interleave(during: () => Promise<unknown>) {
    const pool = (client.db as unknown as { $client: PoolLike }).$client;
    const query = pool.query.bind(pool);
    let landed: Promise<unknown> | undefined;
    const spy = vi.spyOn(pool, 'query').mockImplementation((async (...args: unknown[]) => {
      const first = args[0];
      const text = typeof first === 'string' ? first : (first as { text?: string }).text;
      if (!landed && text?.includes('"expires_at" <')) {
        landed = during();
        await landed;
      }
      return await query(...args);
    }) as never);
    onTestFinished(() => {
      spy.mockRestore();
    });
    return { landed: () => landed };
  }

  beforeAll(async () => {
    database = await cloneTemplateDatabase();
    client = createDatabase({ url: database.url, maxConnections: 4 });
    await seed(client.db);
  });

  afterAll(async () => {
    await client?.close();
    await database?.drop();
  });

  beforeEach(async () => {
    transport.clear();
    pending.length = 0;
    reportedErrors = [];
    allowlist = parseSignUpAllowlist(undefined);
    await client.db.delete(authVerifications);
    await client.db.delete(authRateLimits);
    // Accounts that first sign-ins created: only the seeded owner stays.
    await client.db.delete(authUsers).where(ne(authUsers.email, 'owner@example.com'));
  });

  describe.each([
    ['nl-NL', 'Je inlogcode voor Fivvi'],
    ['en', 'Your sign-in code for Fivvi'],
  ] as const)('page language %s', (locale, subject) => {
    it('AC1: sends one sign-in email with link and code in the resolved language', async () => {
      await addTrainerAccount();
      const response = await requestCode('trainer@example.com', locale);

      expect(response.status).toBe(200);
      const { email, code, link } = readEmail();
      expect(email.to.email).toBe('trainer@example.com');
      expect(email.locale).toBe(locale);
      expect(email.subject).toBe(subject);
      expect(email.text).toContain(messages[locale].email.signIn.intro);
      expect(code).toMatch(/^\d{6}$/);
      // The link opens the confirm step of the sign-in page (TW-10), not a Better Auth URL.
      expect(link).toMatch(/^http:\/\/localhost:3000\/login\/confirm\?token=[\w-]{20,}$/);
    });
  });

  it('AC1: without a page language, the browser language decides', async () => {
    await addTrainerAccount();
    await requestCode('trainer@example.com', undefined, {
      headers: { 'accept-language': 'nl-BE,nl;q=0.9' },
    });
    expect(readEmail().email.locale).toBe('nl-NL');
  });

  describe('AC1 (ADR-019): the stored language comes before the language of the page', () => {
    it('an account with stored language en gets EM-08 in English from a Dutch page', async () => {
      await addTrainerAccount('en');

      await requestCode('trainer@example.com', 'nl-NL', {
        headers: { 'accept-language': 'nl-NL' },
      });

      const { email } = readEmail();
      expect(email.locale).toBe('en');
      expect(email.subject).toBe('Your sign-in code for Fivvi');
      expect(email.text).toContain(messages.en.email.signIn.intro);
    });

    it('an account with stored language nl-NL gets EM-08 in Dutch from an English page', async () => {
      // The seeded owner's stored language is nl-NL.
      await requestCode('owner@example.com', 'en');

      expect(readEmail().email.locale).toBe('nl-NL');
    });

    it('signing in does not change the stored language', async () => {
      await addTrainerAccount('en');
      await requestCode('trainer@example.com', 'nl-NL');
      await enterCode('trainer@example.com', readEmail().code);

      const [account] = await client.db
        .select()
        .from(authUsers)
        .where(eq(authUsers.email, 'trainer@example.com'));
      expect(account?.preferredLocale).toBe('en');
    });
  });

  it('AC1: the address is matched without regard to case and spaces', async () => {
    await requestCode(' Owner@Example.com ', 'en');
    expect(readEmail().email.to.email).toBe('owner@example.com');
  });

  it('AC2: entering the code from the email signs this browser in', async () => {
    await requestCode('owner@example.com', 'en');
    const { code } = readEmail();

    const response = await enterCode('owner@example.com', code);

    expect(response.status).toBe(200);
    const cookie = response.headers.getSetCookie().find((c) => c.includes('session_token'));
    expect(cookie).toBeDefined();
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Max-Age=2592000/i);
    // Not Secure on plain-http localhost; the next test covers https.
    expect(cookie).not.toMatch(/Secure/i);

    // The cookie is a sign-in session the server accepts.
    const session = await auth().handler(
      new Request(`${ORIGIN}/api/auth/get-session`, {
        headers: { cookie: (cookie ?? '').split(';')[0] ?? '' },
      }),
    );
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({ user: { email: 'owner@example.com' } });
  });

  it('AC2: the sign-in session cookie is Secure outside local (https)', async () => {
    const https = authAt({ baseURL: 'https://fivvi.example.net' });
    await requestCode('owner@example.com', 'en', { server: https });
    const response = await enterCode('owner@example.com', readEmail().code, https);

    const cookie = response.headers.getSetCookie().find((c) => c.includes('session_token'));
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
  });

  it('AC2: a wrong code signs nobody in and says nothing about why', async () => {
    await requestCode('owner@example.com', 'en');
    const { code } = readEmail();
    const wrong = code === '000000' ? '000001' : '000000';

    const response = await enterCode('owner@example.com', wrong);

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 'INVALID_OR_EXPIRED_CODE' });
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it('AC4: a code works once', async () => {
    await requestCode('owner@example.com', 'en');
    const { code } = readEmail();

    expect((await enterCode('owner@example.com', code)).status).toBe(200);
    expect((await enterCode('owner@example.com', code)).status).toBe(401);
  });

  it('AC4: link and code are one single-use verification; a new request replaces it', async () => {
    await requestCode('owner@example.com', 'en');
    const first = readEmail();
    const [row] = await verifications();
    expect(await verifications()).toHaveLength(1);

    // A second request for the same address replaces the first verification: its link token and
    // its code are gone, and only the newest email works.
    await requestCode('owner@example.com', 'en');
    const second = readEmail(2);
    const [replacement, ...others] = await verifications();
    expect(others).toEqual([]);
    expect(replacement?.id).not.toBe(row?.id);
    expect(replacement?.value).not.toBe(row?.value);
    expect(replacement?.codeHash).not.toBe(row?.codeHash);
    expect(second.token).not.toBe(first.token);
    expect((await enterCode('owner@example.com', first.code)).status).toBe(401);

    // Using the code of the newest email uses up its link too: nothing is left to use.
    expect((await enterCode('owner@example.com', second.code)).status).toBe(200);
    expect(await verifications()).toEqual([]);
    expect((await enterCode('owner@example.com', second.code)).status).toBe(401);
  });

  it('AC4: using a code does not touch the verification of another address', async () => {
    const { owner, trainer } = await ownerAndTrainerCodes();

    expect((await enterCode('owner@example.com', owner)).status).toBe(200);

    expect(await verifications()).toHaveLength(1);
    expect((await enterCode('trainer@example.com', trainer)).status).toBe(200);
  });

  it('AC4: a new request that lands while the old code is checked cannot be used up by the old code', async () => {
    await requestCode('owner@example.com', 'en');
    const old = readEmail().code;

    // A second request replaces the verification with a new one while the old code is checked.
    const interleaving = interleave(() => requestCode('owner@example.com', 'en'));

    const response = await enterCode('owner@example.com', old);

    expect(interleaving.landed()).toBeDefined();
    expect(response.status).toBe(401);
    expect(response.headers.getSetCookie()).toEqual([]);
    // The new email still works: the old code did not void it.
    const fresh = readEmail(2).code;
    expect((await enterCode('owner@example.com', fresh)).status).toBe(200);
  });

  describe('AC5: link and code expire after 15 minutes', () => {
    // Better Auth tidies up expired rows by the system clock, which it can't take as a clock, so
    // that is frozen at the same instant as the injected one (TESTING.md §5.4).
    function startAt() {
      freezeSystemTime(T0);
      const clock = manualClock(T0);
      return { clock, server: authAt({ clock }) };
    }

    it('a code one second short of 15 minutes still signs in', async () => {
      const { clock, server } = startAt();
      await requestCode('owner@example.com', 'en', { server });
      const { code } = readEmail();

      clock.advance({ minutes: 14, seconds: 59 });

      expect((await enterCode('owner@example.com', code, server)).status).toBe(200);
    });

    it('a code at 15 minutes is rejected like a wrong code, and sets no cookie', async () => {
      const { clock, server } = startAt();
      await requestCode('owner@example.com', 'en', { server });
      const { code } = readEmail();

      clock.advance({ minutes: 15 });
      const response = await enterCode('owner@example.com', code, server);

      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ code: 'INVALID_OR_EXPIRED_CODE' });
      expect(response.headers.getSetCookie()).toEqual([]);
    });

    it('link and code share one expiry: 15 minutes after the request', async () => {
      const { server } = startAt();
      await requestCode('owner@example.com', 'en', { server });

      // One row holds the link token and the code, so one `expiresAt` ends both.
      const [row, ...others] = await verifications();
      expect(others).toEqual([]);
      expect(row?.expiresAt.toISOString()).toBe('2026-03-31T10:15:00.000Z');
    });

    it('an expired code is rejected like a wrong one, and a new request starts afresh', async () => {
      const { clock, server } = startAt();
      await requestCode('owner@example.com', 'en', { server });
      const old = readEmail().code;
      clock.advance({ minutes: 16 });
      const expired = await outcome(await enterCode('owner@example.com', old, server));
      const wrong = await outcome(await enterCode('owner@example.com', wrongCodeFor(old), server));
      expect(expired).toEqual(wrong);

      await requestCode('owner@example.com', 'en', { server });
      clock.advance({ minutes: 14 });

      expect((await enterCode('owner@example.com', readEmail(2).code, server)).status).toBe(200);
    });

    it('the validity is counted from the request, not from the server start', async () => {
      const { clock, server } = startAt();
      clock.advance({ minutes: 20 });
      await requestCode('owner@example.com', 'en', { server });
      const { code } = readEmail();

      clock.advance({ minutes: 10 });

      expect((await enterCode('owner@example.com', code, server)).status).toBe(200);
    });
  });

  describe('AC6: 5 wrong codes kill the verification', () => {
    async function wrongCodes(count: number, email: string, wrongCode: string) {
      const responses: Response[] = [];
      for (let attempt = 0; attempt < count; attempt += 1) {
        responses.push(await enterCode(email, wrongCode));
      }
      return responses;
    }

    it('5 wrong codes kill the verification, even for the right code', async () => {
      await requestCode('owner@example.com', 'en');
      const { code } = readEmail();
      const wrong = wrongCodeFor(code);

      for (const response of await wrongCodes(5, 'owner@example.com', wrong)) {
        expect(response.status).toBe(401);
      }
      const right = await enterCode('owner@example.com', code);

      expect(right.status).toBe(401);
      expect(right.headers.getSetCookie()).toEqual([]);
      // The link is dead too: no verification is left that holds its token.
      expect(await verifications()).toEqual([]);
    });

    it('a new email after that works again', async () => {
      await requestCode('owner@example.com', 'en');
      await wrongCodes(5, 'owner@example.com', wrongCodeFor(readEmail().code));

      await requestCode('owner@example.com', 'en');

      expect((await enterCode('owner@example.com', readEmail(2).code)).status).toBe(200);
    });

    it('4 wrong codes do not: the right code still signs in', async () => {
      await requestCode('owner@example.com', 'en');
      const { code } = readEmail();
      await wrongCodes(4, 'owner@example.com', wrongCodeFor(code));

      expect((await enterCode('owner@example.com', code)).status).toBe(200);
    });

    it('wrong codes are counted per email', async () => {
      const { owner, trainer } = await ownerAndTrainerCodes();

      await wrongCodes(5, 'trainer@example.com', wrongCodeFor(trainer));

      expect((await enterCode('trainer@example.com', trainer)).status).toBe(401);
      expect((await enterCode('owner@example.com', owner)).status).toBe(200);
    });

    it('a verification at the limit is dead even before it is deleted', async () => {
      await requestCode('owner@example.com', 'en');
      const { code } = readEmail();
      const wrong = await outcome(await enterCode('owner@example.com', wrongCodeFor(code)));
      await client.db.update(authVerifications).set({ failedAttempts: 5 });

      const dead = await outcome(await enterCode('owner@example.com', code));

      expect(dead.status).toBe(401);
      expect(dead).toEqual(wrong);
    });

    it('a 5th wrong code that lands while the right code is checked still kills it', async () => {
      await requestCode('owner@example.com', 'en');
      const { code } = readEmail();

      // The 5th wrong code has counted itself and not yet deleted the verification when the right
      // code, which was found below the limit, is consumed.
      const interleaving = interleave(
        async () => await client.db.update(authVerifications).set({ failedAttempts: 5 }),
      );
      const response = await enterCode('owner@example.com', code);

      expect(interleaving.landed()).toBeDefined();
      expect(response.status).toBe(401);
      expect(response.headers.getSetCookie()).toEqual([]);
    });

    it('guesses made in parallel are counted too', async () => {
      await requestCode('owner@example.com', 'en');
      const { code } = readEmail();
      const wrong = wrongCodeFor(code);

      await Promise.all(Array.from({ length: 12 }, () => enterCode('owner@example.com', wrong)));

      expect((await enterCode('owner@example.com', code)).status).toBe(401);
    });
  });

  it('AC6: every code failure returns the same response', async () => {
    await requestCode('owner@example.com', 'en');
    const replaced = readEmail().code;
    await requestCode('owner@example.com', 'en');
    const { code } = readEmail(2);
    const wrong = wrongCodeFor(code);

    // The code of a replaced email, a wrong code, a malformed one, more wrong codes up to the
    // 5th, the right code after it, the same again and a code for an address with no account.
    // The replaced and the malformed code each count as a wrong code: the 3rd failure here is
    // the 3rd count, the 5th kills the verification, and the right code after it is killed.
    const failures = [
      await enterCode('owner@example.com', replaced),
      await enterCode('owner@example.com', wrong),
      await enterCode('owner@example.com', 'not-a-code'),
      await enterCode('owner@example.com', wrong),
      await enterCode('owner@example.com', wrong),
      await enterCode('owner@example.com', code),
      await enterCode('owner@example.com', code),
      await enterCode('nobody@example.com', code),
    ];
    // A used code: a new verification that signs in once and is then entered again.
    await requestCode('owner@example.com', 'en');
    const used = readEmail(3).code;
    expect((await enterCode('owner@example.com', used)).status).toBe(200);
    failures.push(await enterCode('owner@example.com', used));

    const [first, ...rest] = await Promise.all(failures.map(outcome));
    expect(first).toMatchObject({
      status: 401,
      body: { code: 'INVALID_OR_EXPIRED_CODE' },
      cookies: [],
    });
    for (const failure of rest) expect(failure).toEqual(first);
  });

  describe('AC8: an address without an account that is not on the allowlist', () => {
    /** Everything a client can see of the answer to a sign-in request. */
    async function seen(response: Response) {
      return {
        status: response.status,
        body: await response.text(),
        contentType: response.headers.get('content-type'),
        cookies: response.headers.getSetCookie(),
      };
    }

    it('AC8: unknown address gets the same response and no email', async () => {
      const known = await requestCode('owner@example.com', 'en');
      transport.clear();
      await client.db.delete(authVerifications);
      const unknown = await requestCode('nobody@example.com', 'en');

      const answer = await seen(unknown);
      expect(answer).toEqual(await seen(known));
      expect(answer.status).toBe(200);
      expect(JSON.parse(answer.body)).toEqual({ status: true });
      expect(transport.sent).toEqual([]);
      // No account, and no verification that a code could be entered for.
      expect(await client.db.$count(authUsers, eq(authUsers.email, 'nobody@example.com'))).toBe(0);
      expect(await client.db.$count(authUsers)).toBe(1);
      expect(await verifications()).toEqual([]);
    });

    it('AC8: the same answer for an address in other case and with spaces', async () => {
      const known = await seen(await requestCode('owner@example.com', 'nl-NL'));
      const unknown = await seen(await requestCode(' Nobody@Example.com ', 'nl-NL'));

      expect(unknown).toEqual(known);
    });

    it('AC8: entering a code for it creates no account', async () => {
      await requestCode('nobody@example.com', 'en');

      const response = await enterCode('nobody@example.com', '123456');

      expect(response.status).toBe(401);
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(await client.db.$count(authUsers, eq(authUsers.email, 'nobody@example.com'))).toBe(0);
    });

    it('AC8: an address next to an allowlist entry is still unknown', async () => {
      allowlist = parseSignUpAllowlist('pilot@gym.test,@trainers.test');

      for (const address of [
        'pilot2@gym.test',
        'pilot@sub.gym.test',
        'x@sub.trainers.test',
        'x@trainers.test.evil.test',
      ]) {
        const response = await requestCode(address, 'en');
        expect(response.status).toBe(200);
      }

      expect(transport.sent).toEqual([]);
      expect(await client.db.$count(authUsers)).toBe(1);
    });

    it('AC8: with no allowlist at all, sign-up is closed even for example.com', async () => {
      await requestCode('someone@example.com', 'en');

      expect(transport.sent).toEqual([]);
      expect(await verifications()).toEqual([]);
    });

    it('AC8: the answer does not wait for the email, so its time tells nothing about the account', async () => {
      // A transport that holds every email until the test lets it go.
      const held: Array<() => void> = [];
      const slow: EmailTransport = {
        name: 'slow',
        send: async (email: OutgoingEmail) => {
          await new Promise<void>((release) => held.push(release));
          return await transport.send(email);
        },
      };
      const server = authAt({ emailTransport: slow });

      // The answer for an account comes back while its email is still being sent.
      const known = await post('/sign-in/code/request', { email: 'owner@example.com' }, { server });
      const unknown = await post(
        '/sign-in/code/request',
        { email: 'nobody@example.com' },
        { server },
      );

      expect(await seen(known)).toEqual(await seen(unknown));
      await vi.waitFor(() => expect(held).toHaveLength(1));
      expect(transport.sent).toEqual([]);
      for (const release of held) release();
      await settle();
      expect(transport.sent).toHaveLength(1);
    });

    describe('AC8: a failure after the answer', () => {
      const LOG_PREFIX = 'Sign-in request failed after its answer';
      const SECRET_ADDRESS = 'owner@example.com';

      /** The log of `console.error`, which the tests keep out of the output. */
      function spyOnLog() {
        return vi.spyOn(console, 'error').mockImplementation(() => {});
      }

      /** What a sign-in request for the account answers when nothing went wrong. */
      const normalAnswer = async () => await seen(await requestCode('nobody@example.com', 'en'));

      it('an email that fails to send still gets the same answer, and is logged and reported with a name and message that carry no address', async () => {
        const unknown = await normalAnswer();
        const log = spyOnLog();
        // The provider's own error quotes the recipient.
        const failing = authAt({
          emailTransport: {
            name: 'failing',
            send: () => Promise.reject(new Error(`Brevo rejected ${SECRET_ADDRESS}`)),
          },
        });

        const known = await post(
          '/sign-in/code/request',
          { email: SECRET_ADDRESS },
          { server: failing },
        );
        await settle();

        expect(await seen(known)).toEqual(unknown);
        // Only the name of the error and the message of the email error reach the log.
        expect(log.mock.calls).toEqual([[`${LOG_PREFIX}: failing: send failed`]]);
        expect(reportedErrors).toHaveLength(1);
        expect(reportedErrors[0]).toBeInstanceOf(EmailSendError);
        // The name and message only: the error's `cause` still quotes the address, and the
        // reporter's scrubber masks it (packages/observability).
        expect(String(reportedErrors[0])).not.toContain(SECRET_ADDRESS);
      });

      it('any other failure is logged by its name alone, because it can quote the address', async () => {
        const log = spyOnLog();
        const server = authAt({
          overrides: {
            sendEmail: () => Promise.reject(new TypeError(`duplicate key for ${SECRET_ADDRESS}`)),
          },
        });

        const response = await post('/sign-in/code/request', { email: SECRET_ADDRESS }, { server });
        await settle();

        expect(response.status).toBe(200);
        expect(log.mock.calls).toEqual([[`${LOG_PREFIX}: TypeError`]]);
      });

      it('a reporter that throws neither fails the work nor hides the log line', async () => {
        const log = spyOnLog();
        const server = authAt({
          overrides: {
            sendEmail: () => Promise.reject(new Error('Brevo is down')),
            reportError: () => {
              throw new Error(`Sentry is down for ${SECRET_ADDRESS}`);
            },
          },
        });

        const response = await post('/sign-in/code/request', { email: SECRET_ADDRESS }, { server });

        expect(response.status).toBe(200);
        await expect(settle()).resolves.toBeUndefined();
        expect(log.mock.calls).toEqual([[`${LOG_PREFIX}: Error`]]);
      });
    });
  });

  describe('AC9: an address on the sign-up allowlist creates its account at its first sign-in', () => {
    const accountOf = async (email: string) =>
      (await client.db.select().from(authUsers).where(eq(authUsers.email, email)))[0];

    describe.each([
      ['an exact address', 'pilot@gym.test', 'pilot@gym.test'],
      ['an @domain entry', '@trainers.test', 'new@trainers.test'],
    ])('on the allowlist as %s', (_, entry, address) => {
      describe.each([
        ['nl-NL', 'Je inlogcode voor Fivvi'],
        ['en', 'Your sign-in code for Fivvi'],
      ] as const)('page language %s', (locale, subject) => {
        it('AC9: allowlisted first sign-in creates the account with the page language', async () => {
          allowlist = parseSignUpAllowlist(`${entry},@unrelated.test`);
          expect(await accountOf(address)).toBeUndefined();

          // The request answers like any other, sends the email in the page's language and
          // creates no account yet: that happens at the sign-in itself.
          const requested = await requestCode(address, locale);
          expect(requested.status).toBe(200);
          expect(await requested.json()).toEqual({ status: true });
          const { email, code } = readEmail();
          expect(email.to.email).toBe(address);
          expect(email.locale).toBe(locale);
          expect(email.subject).toBe(subject);
          expect(await accountOf(address)).toBeUndefined();

          const response = await enterCode(address, code);

          expect(response.status).toBe(200);
          const account = await accountOf(address);
          expect(account).toMatchObject({
            email: address,
            emailVerified: true,
            preferredLocale: locale,
          });
          // The browser is signed in as the new account.
          const cookie = response.headers.getSetCookie().find((c) => c.includes('session_token'));
          const session = await auth().handler(
            new Request(`${ORIGIN}/api/auth/get-session`, {
              headers: { cookie: (cookie ?? '').split(';')[0] ?? '' },
            }),
          );
          expect(await session.json()).toMatchObject({ user: { id: account?.id, email: address } });
        });
      });

      it('AC9: the second sign-in signs in to the same account and keeps its stored language', async () => {
        allowlist = parseSignUpAllowlist(entry);
        await requestCode(address, 'en');
        await enterCode(address, readEmail().code);
        const created = await accountOf(address);

        // From a Dutch page this time: the stored language (en) decides, and holds.
        await requestCode(address, 'nl-NL');
        const { email, code } = readEmail(2);
        expect(email.locale).toBe('en');
        expect((await enterCode(address, code)).status).toBe(200);

        expect(await client.db.$count(authUsers, eq(authUsers.email, address))).toBe(1);
        expect(await accountOf(address)).toMatchObject({
          id: created?.id,
          preferredLocale: 'en',
        });
      });

      it('AC9: the language is the one of the page that asked, not of a later request', async () => {
        allowlist = parseSignUpAllowlist(entry);
        await requestCode(address, 'nl-NL');
        const first = readEmail().code;
        // A second request from an English page replaces the first one.
        await requestCode(address, 'en');
        const second = readEmail(2).code;

        expect((await enterCode(address, first)).status).toBe(401);
        expect((await enterCode(address, second)).status).toBe(200);

        expect((await accountOf(address))?.preferredLocale).toBe('en');
      });
    });

    it('AC9: the allowlist is checked again at the first sign-in', async () => {
      allowlist = parseSignUpAllowlist('pilot@gym.test');
      await requestCode('pilot@gym.test', 'en');
      const { code } = readEmail();

      // The operator takes the address off the list between the request and the code.
      allowlist = parseSignUpAllowlist(undefined);
      const response = await enterCode('pilot@gym.test', code);

      expect(response.status).toBe(401);
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(await accountOf('pilot@gym.test')).toBeUndefined();
    });

    it('AC9: a wrong code creates no account', async () => {
      allowlist = parseSignUpAllowlist('pilot@gym.test');
      await requestCode('pilot@gym.test', 'en');

      const response = await enterCode('pilot@gym.test', wrongCodeFor(readEmail().code));

      expect(response.status).toBe(401);
      expect(await accountOf('pilot@gym.test')).toBeUndefined();
    });

    it('AC9: an address that is already an account does not need to be on the list', async () => {
      allowlist = parseSignUpAllowlist('pilot@gym.test');
      await requestCode('owner@example.com', 'en');

      expect((await enterCode('owner@example.com', readEmail().code)).status).toBe(200);
    });
  });

  it('AC11: only hashes are stored: no usable link token or code in auth_verifications', async () => {
    await requestCode('owner@example.com', 'en');
    const { code, token } = readEmail();
    expect(token).not.toBe('');

    const rows = await client.db.select().from(authVerifications);

    expect(rows).toHaveLength(1);
    for (const row of rows) {
      for (const [column, value] of Object.entries(row)) {
        const text = String(value);
        expect(text, `${column} holds the code`).not.toContain(code);
        expect(text, `${column} holds the link token`).not.toContain(token);
      }
    }
    // What is stored is a keyed hash of each, not the token or the code itself.
    expect(rows[0]?.value).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]?.codeHash).toMatch(/^[0-9a-f]{64}$/);
  });

  describe('AC10 rate limits on sign-in requests', () => {
    /** The addresses Railway's proxy puts in `x-real-ip` (documentation range, RFC 5737). */
    const CLIENT_A = '203.0.113.7';
    const CLIENT_B = '203.0.113.8';
    const CLIENT_C = '203.0.113.9';

    /**
     * One server on a manual clock, started at `T0`. The system time is frozen at `T0` as well
     * (TESTING.md §5.4) and stays there: `clock.advance` moves only the injected clock, which is
     * what the limits read; the system time is for Better Auth's own code.
     */
    function startAt() {
      freezeSystemTime(T0);
      const clock = manualClock(T0);
      const log: string[] = [];
      return { clock, log, server: authAt({ clock, log: (line) => log.push(line) }) };
    }

    const from = (ip: string, server: ReturnType<typeof auth>) => ({
      headers: { 'x-real-ip': ip },
      server,
    });

    /**
     * The per-IP boundary through `send` (one IP address, or none): requests 1 to 19 go to
     * unknown addresses, the 20th to an account whose address limit is untouched and still
     * sends one email, the 21st to a second such account and sends none.
     */
    async function expectIpBoundary(send: (email: string) => Promise<Response>) {
      await addTrainerAccount();
      transport.clear();
      for (let i = 0; i < 19; i++) await send(`nobody${i}@example.com`);
      expect(transport.sent).toEqual([]);

      await send('owner@example.com');
      expect(transport.sent).toHaveLength(1);

      await send('trainer@example.com');
      expect(transport.sent).toHaveLength(1);
    }

    it('AC10: rate limits per address and per IP answer neutrally', async () => {
      const { clock, server } = startAt();

      // Per address: the 3rd request in 15 minutes still sends, the 4th answers like the first
      // and sends nothing, whichever IP address it comes from.
      const first = await outcome(
        await requestCode('owner@example.com', 'en', from(CLIENT_A, server)),
      );
      await requestCode('owner@example.com', 'en', from(CLIENT_A, server));
      await requestCode('owner@example.com', 'en', from(CLIENT_B, server));
      expect(transport.sent).toHaveLength(3);
      const limited = await requestCode('owner@example.com', 'en', from(CLIENT_B, server));
      expect(await outcome(limited)).toEqual(first);
      expect(transport.sent).toHaveLength(3);

      // After the 15 minutes the address may ask again.
      clock.advance({ minutes: 15 });
      await requestCode('owner@example.com', 'en', from(CLIENT_B, server));
      expect(transport.sent).toHaveLength(4);

      // Per IP address: 20 requests in an hour, whoever they are for (an unknown address counts
      // too, so the limit can't tell who has an account). A later request is answered the same way.
      await expectIpBoundary((email) => requestCode(email, 'en', from(CLIENT_C, server)));
      const ipLimited = await requestCode('owner@example.com', 'en', from(CLIENT_C, server));
      expect(await outcome(ipLimited)).toEqual(first);
      expect(transport.sent).toHaveLength(1);

      // Another IP address is not affected, and an hour later the first one may ask again.
      await requestCode('trainer@example.com', 'en', from(CLIENT_B, server));
      expect(transport.sent).toHaveLength(2);
      clock.advance({ hours: 1 });
      await requestCode('owner@example.com', 'en', from(CLIENT_C, server));
      expect(transport.sent).toHaveLength(3);
    });

    it('AC10: an unknown address is limited like an account, so the limit reveals nothing', async () => {
      const { server } = startAt();
      const outcomes = async (email: string) => {
        const results = [];
        for (let i = 0; i < 4; i++)
          results.push(await outcome(await requestCode(email, 'en', { server })));
        return results;
      };

      const known = await outcomes('owner@example.com');
      expect(transport.sent).toHaveLength(3);
      transport.clear();
      const unknown = await outcomes('nobody@example.com');

      // The 4th answer, the one that is limited, looks like the others, for both addresses.
      expect(unknown).toEqual(known);
      expect(transport.sent).toEqual([]);
      // Both addresses were counted, 4 requests each, and no IP address (no header, not required).
      const counts = (await client.db.select().from(authRateLimits)).map((row) => row.count);
      expect(counts).toEqual([4, 4]);
    });

    it('AC10: the counts of a window that has ended are cleared by the next request', async () => {
      const { clock, server } = startAt();
      await requestCode('nobody@example.com', 'en', { server });
      expect(await client.db.select().from(authRateLimits)).toHaveLength(1);

      // A request of another key, after the window: the old row is gone, not just ignored.
      clock.advance({ minutes: 15 });
      await requestCode('someone@example.com', 'en', { server });

      const rows = await client.db.select().from(authRateLimits);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.count).toBe(1);
      expect(rows[0]?.windowEndsAt.getTime()).toBe(clock.now().getTime() + 15 * 60_000);
    });

    it('AC10: addresses that differ in case or spaces share one limit', async () => {
      const { server } = startAt();
      for (const email of ['owner@example.com', ' Owner@Example.com', 'OWNER@EXAMPLE.COM']) {
        await requestCode(email, 'en', { server });
      }
      expect(transport.sent).toHaveLength(3);

      await requestCode(' owner@EXAMPLE.com ', 'en', { server });
      expect(transport.sent).toHaveLength(3);
    });

    it('AC10: requests made in parallel are all counted', async () => {
      const { server } = startAt();

      await Promise.all(
        Array.from({ length: 10 }, () => requestCode('owner@example.com', 'en', { server })),
      );

      expect(transport.sent).toHaveLength(3);
    });

    it('AC10: a limited request leaves the pending email working', async () => {
      const { server } = startAt();
      for (let i = 0; i < 3; i++) await requestCode('owner@example.com', 'en', { server });
      const { code } = readEmail(3);

      await requestCode('owner@example.com', 'en', { server });

      expect(transport.sent).toHaveLength(3);
      expect((await enterCode('owner@example.com', code, server)).status).toBe(200);
    });

    it('AC10: the limit survives a new app instance (it is stored in Postgres)', async () => {
      const { clock } = startAt();
      for (let i = 0; i < 3; i++) {
        await requestCode('owner@example.com', 'en', from(CLIENT_A, authAt({ clock })));
      }
      expect(transport.sent).toHaveLength(3);

      // A restart or a deploy: a new instance, the same database.
      const restarted = authAt({ clock });
      await requestCode('owner@example.com', 'en', from(CLIENT_A, restarted));
      expect(transport.sent).toHaveLength(3);
    });

    it('AC10: the per-IP limit survives new app instances (it is stored in Postgres)', async () => {
      const { clock } = startAt();

      // Every request through a new instance: the count lives in the database, not the instance.
      await expectIpBoundary((email) =>
        requestCode(email, 'en', from(CLIENT_B, authAt({ clock }))),
      );
    });

    it('AC10: a client cannot dodge the IP limit with a forged x-forwarded-for', async () => {
      const { server } = startAt();
      for (let i = 0; i < 20; i++) {
        await requestCode(`nobody${i}@example.com`, 'en', {
          server,
          headers: { 'x-real-ip': CLIENT_A, 'x-forwarded-for': `198.51.100.${i}` },
        });
      }

      await requestCode('owner@example.com', 'en', {
        server,
        headers: { 'x-real-ip': CLIENT_A, 'x-forwarded-for': '198.51.100.200' },
      });

      expect(transport.sent).toEqual([]);
    });

    it('AC10: addresses of the same IPv6 /64 network share one IP limit', async () => {
      const { server } = startAt();
      for (let i = 0; i < 20; i++) {
        await requestCode(`nobody${i}@example.com`, 'en', from(`2001:db8:1:2::${i + 1}`, server));
      }

      await requestCode('owner@example.com', 'en', from('2001:db8:1:2:ffff::9', server));
      expect(transport.sent).toEqual([]);

      await requestCode('owner@example.com', 'en', from('2001:db8:1:3::1', server));
      expect(transport.sent).toHaveLength(1);
    });

    it('AC10: outside production, without a client IP header only the per-address limit applies', async () => {
      const { server } = startAt();
      for (let i = 0; i < 25; i++) {
        await requestCode(`nobody${i}@example.com`, 'en', { server });
      }
      await requestCode('owner@example.com', 'en', { server });

      expect(transport.sent).toHaveLength(1);
    });

    it('AC10: when the proxy is required, a request without the client IP header counts in one shared bucket', async () => {
      freezeSystemTime(T0);
      const server = authAt({ clock: manualClock(T0), requireClientIp: true });

      // No header at all: the shared "unknown IP" bucket, 20 requests an hour for everyone.
      await expectIpBoundary((email) => requestCode(email, 'en', { server }));

      // A request that does carry an IP address has its own bucket.
      await requestCode('trainer@example.com', 'en', from(CLIENT_A, server));
      expect(transport.sent).toHaveLength(2);
    });

    it('AC10: the proxy is required by default when NODE_ENV is production, and not otherwise', async () => {
      freezeSystemTime(T0);
      const clock = manualClock(T0);

      // The default is read when the server is created; the stub is gone before the requests
      // (it would break the rendering of the email).
      vi.stubEnv('NODE_ENV', 'production');
      const behindProxy = authAt({ clock });
      vi.stubEnv('NODE_ENV', 'test');
      const local = authAt({ clock });
      vi.unstubAllEnvs();

      for (let i = 0; i < 25; i++)
        await requestCode(`nobody${i}@example.com`, 'en', { server: local });
      await requestCode('owner@example.com', 'en', { server: local });
      expect(transport.sent).toHaveLength(1);

      transport.clear();
      await expectIpBoundary((email) => requestCode(email, 'en', { server: behindProxy }));
    });

    it('AC10: an invalid client IP header is no client IP: no IP limit, or the shared bucket when required', async () => {
      freezeSystemTime(T0);
      const clock = manualClock(T0);
      const invalid = (server: ReturnType<typeof auth>) => ({
        server,
        headers: { 'x-real-ip': 'not-an-ip, 203.0.113.7' },
      });

      // Not required: like no header, so 25 requests with an invalid value are not limited.
      const open = authAt({ clock });
      for (let i = 0; i < 25; i++) await requestCode(`nobody${i}@example.com`, 'en', invalid(open));
      await requestCode('owner@example.com', 'en', invalid(open));
      expect(transport.sent).toHaveLength(1);

      // Required: the shared "unknown IP" bucket.
      transport.clear();
      const required = authAt({ clock, requireClientIp: true });
      await expectIpBoundary((email) => requestCode(email, 'en', invalid(required)));
    });

    it('AC10: the rate-limit hit is logged without the email address or the IP address', async () => {
      const { server, log } = startAt();
      for (let i = 0; i < 3; i++)
        await requestCode('owner@example.com', 'en', from(CLIENT_A, server));
      expect(log).toEqual([]);

      await requestCode('owner@example.com', 'en', from(CLIENT_A, server));

      expect(log).toEqual(['Sign-in request rate-limited: address']);
      for (let i = 0; i < 20; i++) {
        await requestCode(`nobody${i}@example.com`, 'en', from(CLIENT_B, server));
      }
      await requestCode('nobody-else@example.com', 'en', from(CLIENT_B, server));
      expect(log.at(-1)).toBe('Sign-in request rate-limited: ip');
      expect(log.join('\n')).not.toMatch(/example\.com|203\.0\.113/);
    });

    it('AC10: the default log is a console line without the address or the IP address', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      onTestFinished(() => {
        warn.mockRestore();
      });
      freezeSystemTime(T0);
      const server = authAt({ clock: manualClock(T0) });
      for (let i = 0; i < 4; i++)
        await requestCode('owner@example.com', 'en', from(CLIENT_A, server));

      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toBe('Sign-in request rate-limited: address');
    });

    it('AC10: the stored limits hold neither the email address nor the IP address', async () => {
      const { server } = startAt();
      await requestCode('owner@example.com', 'en', from(CLIENT_A, server));

      const rows = await client.db.select().from(authRateLimits);

      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.key).not.toMatch(/example\.com|203\.0\.113/);
        expect(row.key).toMatch(/^[\w-]+:[0-9a-f]{64}$/);
      }
    });

    it('AC10: the request limits do not touch entering the code', async () => {
      const { server } = startAt();
      for (let i = 0; i < 4; i++) await requestCode('owner@example.com', 'en', { server });
      const { code } = readEmail(3);

      for (let i = 0; i < 5; i++) {
        expect((await enterCode('owner@example.com', code, server)).status).toBe(
          i === 0 ? 200 : 401,
        );
      }
    });
  });
});
