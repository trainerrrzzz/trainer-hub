import { spawn } from 'node:child_process';
import { createDatabase } from '@fivvi/database';
import { runMigrations } from '@fivvi/database/migrate';
import { databaseUrl, identifier, onServer } from '@fivvi/testing/database/server';

// Playwright's web server command (playwright.config.ts): the standalone server, as in production
// (Dockerfile), on a database of its own. Each run starts from an empty database with every
// migration applied, so the hello row is the migrated one (#94). The database is on the local test
// server (TEST_DATABASE_URL, else DATABASE_URL; localhost only) and stays until the next run.

const name = process.env.E2E_DATABASE;
if (!name) throw new Error('Set E2E_DATABASE to the name of the e2e database.');

await onServer(
  `DROP DATABASE IF EXISTS ${identifier(name)} WITH (FORCE)`,
  `CREATE DATABASE ${identifier(name)}`,
);
const url = databaseUrl(name);
const client = createDatabase({ url, maxConnections: 1 });
try {
  await runMigrations(client.db);
} finally {
  await client.close();
}

// Sign-in (F001): a synthetic secret, and this server's own address for the links in emails.
// SIGN_UP_ALLOWED_EMAILS comes from playwright.config.ts.
const server = spawn(process.execPath, ['.next/standalone/apps/web/server.js'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    DATABASE_URL: url,
    BETTER_AUTH_SECRET: 'e2e-secret-that-is-at-least-thirty-two-characters-long',
    BETTER_AUTH_URL: `http://localhost:${process.env.PORT}`,
  },
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.kill(signal));
}
server.on('exit', (code) => process.exit(code ?? 1));
