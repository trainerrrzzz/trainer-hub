// The production servers the e2e tests run against (playwright.config.ts). Both serve the same
// build; only their runtime variables differ. Each reads its own migrated database on the local
// test server (e2e/serve.ts), named after its port so worktrees never share one.

const port = Number(process.env.E2E_PORT ?? 3100);

/** The domain the e2e servers allow to sign up (`SIGN_UP_ALLOWED_EMAILS`, playwright.config.ts). */
export const ALLOWED_SIGN_UP_DOMAIN = 'allowed.e2e.test';

/** A domain the sign-up allowlist does not cover (the default of `newAddress`): its addresses need `createAccount`. */
export const UNLISTED_SIGN_UP_DOMAIN = 'fivvi.e2e.test';

/** The app as in CI and local development: no Sentry DSN and no PostHog key. */
export const appServer = server(port);

/** A synthetic PostHog project key: the page view tests (E009) never reach PostHog. */
export const TEST_POSTHOG_KEY = 'phc_e2e_synthetic_project_key';

/**
 * A synthetic PostHog host (`.test` never resolves), which the page view tests intercept: page
 * views go to whatever POSTHOG_HOST says, never to a built-in address.
 */
export const TEST_POSTHOG_HOST = 'https://posthog.e2e.test';

/**
 * The same build with a PostHog key and host, so it sends page views (E009 AC6). 1000 up, outside the
 * range of every worktree's own E2E_PORT (scripts/_lib.sh), so it never reuses another's server.
 */
export const analyticsServer = server(port + 1000);

const brevoPort = port + 2000;

/**
 * The fake Brevo server (F001): the app sends its emails to it (`BREVO_API_URL`) instead of to
 * Brevo, and the specs read the sign-in code and link from it (e2e/brevo.ts). 2000 up, outside
 * the range of every worktree's own E2E_PORT and of the analytics server.
 */
export const brevoServer = {
  port: brevoPort,
  baseURL: `http://localhost:${brevoPort}`,
  /** Where the app posts emails, like Brevo's `POST /v3/smtp/email`. */
  apiUrl: `http://localhost:${brevoPort}/v3/smtp/email`,
};

function server(serverPort: number) {
  return {
    port: serverPort,
    baseURL: `http://localhost:${serverPort}`,
    database: `fivvi_test_e2e_${serverPort}`,
  };
}
