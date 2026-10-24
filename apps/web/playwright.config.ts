import { existsSync } from 'node:fs';
import { defaultTimeZone, formattingLocales, locales } from '@fivvi/i18n';
import { defineConfig, devices } from '@playwright/test';
import type { E2EOptions } from './e2e/fixtures';
import {
  ALLOWED_SIGN_UP_DOMAIN,
  analyticsServer,
  appServer,
  brevoServer,
  TEST_POSTHOG_HOST,
  TEST_POSTHOG_KEY,
} from './e2e/servers';

// Web e2e tests (TESTING.md §2). Every spec runs once per catalog locale: one project
// per locale, with the browser language set to it. `pnpm test:e2e` from the repo root
// builds the app first (turbo); this config only starts the production server.

const ci = Boolean(process.env.CI);

// Local convenience: the servers' databases go on the Postgres in packages/database/.env
// (`pnpm db:up`), unless TEST_DATABASE_URL says otherwise. CI sets TEST_DATABASE_URL.
if (existsSync('../../packages/database/.env')) {
  process.loadEnvFile('../../packages/database/.env');
}

export default defineConfig<E2EOptions>({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: ci,
  // One retry in CI; a test that only passes on retry is reported as flaky (TESTING.md §8).
  retries: ci ? 1 : 0,
  reporter: ci ? [['github'], ['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: appServer.baseURL,
    timezoneId: defaultTimeZone,
    trace: 'retain-on-first-failure',
  },
  projects: locales.map((locale) => ({
    name: locale,
    use: {
      ...devices['Desktop Chrome'],
      appLocale: locale,
      // Sets navigator.language and Accept-Language, like a real browser in this language.
      locale: formattingLocales[locale],
    },
  })),
  // The standalone server, as in production (Dockerfile), not `next start`, each on its own
  // migrated database (e2e/serve.ts). A second one runs the same build with a PostHog key and
  // host, which it reads at runtime, for the page view tests (E009). Both send their emails to the
  // fake Brevo server (F001), which the third web server runs.
  webServer: [
    {
      command: 'node e2e/fake-brevo.ts',
      env: { PORT: String(brevoServer.port) },
      url: brevoServer.baseURL,
      reuseExistingServer: !ci,
      timeout: 60_000,
    },
    standaloneServer(appServer),
    standaloneServer(analyticsServer, {
      NEXT_PUBLIC_POSTHOG_KEY: TEST_POSTHOG_KEY,
      POSTHOG_HOST: TEST_POSTHOG_HOST,
    }),
  ],
});

function standaloneServer(
  { port, baseURL, database }: { port: number; baseURL: string; database: string },
  env: Record<string, string> = {},
) {
  return {
    command: 'node e2e/serve.ts',
    env: {
      ...env,
      E2E_DATABASE: database,
      PORT: String(port),
      HOSTNAME: 'localhost',
      // Synthetic: the fake Brevo server accepts any key, and `.test` never resolves.
      BREVO_API_URL: brevoServer.apiUrl,
      BREVO_API_KEY: 'e2e-synthetic-brevo-key',
      EMAIL_FROM_ADDRESS: 'noreply@fivvi.e2e.test',
      EMAIL_FROM_NAME: 'Fivvi',
      // Closed sign-up (F001): only this domain gets an account at its first sign-in.
      SIGN_UP_ALLOWED_EMAILS: `@${ALLOWED_SIGN_UP_DOMAIN}`,
    },
    url: baseURL,
    reuseExistingServer: !ci,
    timeout: 60_000,
  };
}
