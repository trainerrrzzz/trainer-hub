import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cloneTemplateDatabase,
  createTestDatabase,
  type TestDatabase,
  withRollback,
} from '@fivvi/testing/database';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  authUsers,
  createDatabase,
  type DatabaseClient,
  type DatabaseExecutor,
  findSystemGreeting,
  HELLO_GREETING,
  pingDatabase,
  systemGreetings,
} from '../src/index.ts';
import { migrationsFolder, runMigrations } from '../src/migrate.ts';
import { release } from '../src/release.ts';
import { seed } from '../src/seed.ts';

/**
 * Tables that are not business data and therefore have no `organization_id`.
 * Adding a table here needs a reason in the PR (AGENTS.md, ADR-006).
 */
const NON_BUSINESS_TABLES = [
  'system_greetings',
  // Sign-in tables (F001): an account is global and shared by every workspace of its person.
  'auth_identities',
  'auth_rate_limits',
  'auth_sessions',
  'auth_users',
  'auth_verifications',
];

interface Journal {
  entries: { tag: string }[];
}

async function readJournal(folder: string): Promise<Journal> {
  return JSON.parse(await readFile(join(folder, 'meta', '_journal.json'), 'utf8')) as Journal;
}

async function rows<T>(db: DatabaseExecutor, query: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(query)).rows as T[];
}

// Migration tests start from an empty database and commit, so each gets its own.
async function withFreshDatabase(test: (client: DatabaseClient) => Promise<void>): Promise<void> {
  const database = await createTestDatabase();
  const client = createDatabase({ url: database.url, maxConnections: 2 });
  try {
    await test(client);
  } finally {
    await client.close();
    await database.drop();
  }
}

describe('E004 migrations', () => {
  it('migrate → seed → read works on an empty database', async () => {
    await withFreshDatabase(async (client) => {
      await runMigrations(client.db);
      await seed(client.db);

      expect(await findSystemGreeting(client.db, 'hello')).toEqual(HELLO_GREETING);
    });
  });

  it('inserts the hello greeting without the seed, as production needs it (E003)', async () => {
    await withFreshDatabase(async (client) => {
      await runMigrations(client.db);

      expect(await client.db.$count(systemGreetings)).toBe(1);
      expect(await findSystemGreeting(client.db, 'hello')).toEqual(HELLO_GREETING);
    });
  });

  it('records every committed migration as applied', async () => {
    await withFreshDatabase(async (client) => {
      await runMigrations(client.db);

      const journal = await readJournal(migrationsFolder);
      const applied = await rows<{ count: number }>(
        client.db,
        sql`select count(*)::int as count from drizzle.__drizzle_migrations`,
      );
      expect(journal.entries.length).toBeGreaterThan(0);
      expect(applied[0]?.count).toBe(journal.entries.length);
    });
  });

  it('applies the latest migration on top of the previous version', async () => {
    const journal = await readJournal(migrationsFolder);
    const previous = await mkdtemp(join(tmpdir(), 'fivvi-migrations-'));
    try {
      // A copy of the migrations folder as it was before the latest migration.
      await cp(migrationsFolder, previous, { recursive: true });
      const previousJournal = { ...journal, entries: journal.entries.slice(0, -1) };
      await writeFile(join(previous, 'meta', '_journal.json'), JSON.stringify(previousJournal));

      await withFreshDatabase(async (client) => {
        await migrate(client.db, { migrationsFolder: previous });
        await runMigrations(client.db);
        await seed(client.db);

        expect(await findSystemGreeting(client.db, 'hello')).toEqual(HELLO_GREETING);
      });
    } finally {
      await rm(previous, { recursive: true, force: true });
    }
  });

  it('is a no-op when run again', async () => {
    await withFreshDatabase(async (client) => {
      await runMigrations(client.db);
      await runMigrations(client.db);

      const journal = await readJournal(migrationsFolder);
      const applied = await rows<{ count: number }>(
        client.db,
        sql`select count(*)::int as count from drizzle.__drizzle_migrations`,
      );
      expect(applied[0]?.count).toBe(journal.entries.length);
    });
  });
});

describe('E003 release step', () => {
  it('migrates a new database and seeds it only when asked', async () => {
    await withFreshDatabase(async (client) => {
      const logs: string[] = [];

      await release(client.db, { seed: false }, (message) => logs.push(message));
      await release(client.db, { seed: true }, (message) => logs.push(message));

      expect(await findSystemGreeting(client.db, 'hello')).toEqual(HELLO_GREETING);
      expect(logs).toEqual(['Migrations applied.', 'Migrations applied.', 'Seed data inserted.']);
    });
  });

  it('pings a reachable database', async () => {
    await withFreshDatabase(async (client) => {
      await expect(pingDatabase(client.db)).resolves.toBeUndefined();
    });
  });

  it('fails the ping when the database is unreachable', async () => {
    const database = await createTestDatabase();
    await database.drop();
    const client = createDatabase({ url: database.url, maxConnections: 1 });
    try {
      await expect(pingDatabase(client.db)).rejects.toThrow();
    } finally {
      await client.close();
    }
  });
});

describe('E004 database', () => {
  // One migrated clone for this file; every test runs in a transaction that is rolled
  // back, so tests see a freshly migrated database (only the system rows the data
  // migrations insert) and never each other's rows.
  let database: TestDatabase;
  let client: DatabaseClient;
  let db: DatabaseClient['db'];

  beforeAll(async () => {
    database = await cloneTemplateDatabase();
    client = createDatabase({ url: database.url, maxConnections: 2 });
    db = client.db;
  });

  afterAll(async () => {
    await client?.close();
    await database?.drop();
  });

  describe('seed', () => {
    it('is idempotent and keeps the system rows', async () => {
      await withRollback(db, async (tx) => {
        await seed(tx);
        await seed(tx);

        expect(await tx.$count(systemGreetings)).toBe(1);
        expect(await findSystemGreeting(tx, 'hello')).toEqual(HELLO_GREETING);
      });
    });
  });

  describe('F001 seed accounts', () => {
    it('creates the account owner@example.com with Dutch as its language, once', async () => {
      await withRollback(db, async (tx) => {
        await seed(tx);
        await seed(tx);

        const users = await tx.select().from(authUsers);
        expect(users).toEqual([
          expect.objectContaining({
            email: 'owner@example.com',
            preferredLocale: 'nl-NL',
            emailVerified: true,
          }),
        ]);
      });
    });

    it('creates no account in production', async () => {
      await withRollback(db, async (tx) => {
        await seed(tx, { production: true });

        expect(await tx.$count(authUsers)).toBe(0);
      });
    });

    it('seeds a deployed environment only outside production', async () => {
      await withFreshDatabase(async (client) => {
        await release(client.db, { seed: true, production: true }, () => {});
        expect(await client.db.$count(authUsers)).toBe(0);

        await release(client.db, { seed: true }, () => {});
        expect(await client.db.$count(authUsers)).toBe(1);
      });
    });
  });

  describe('system greetings', () => {
    it('stores the migrated greeting as an i18n key, not as copy', async () => {
      await withRollback(db, async (tx) => {
        const [row] = await tx.select().from(systemGreetings);
        expect(row?.i18nKey).toBe('hello.title');
      });
    });

    it('returns undefined for an unknown slug', async () => {
      await withRollback(db, async (tx) => {
        expect(await findSystemGreeting(tx, 'goodbye')).toBeUndefined();
      });
    });

    it.each(['Hallo, welkom bij Fivvi!', 'hello', 'system hello'])(
      'rejects %j as an i18n key',
      async (i18nKey) => {
        await withRollback(db, async (tx) => {
          await tx.delete(systemGreetings);
          await expect(
            tx.insert(systemGreetings).values({ slug: 'hello', i18nKey }),
          ).rejects.toMatchObject({ cause: { constraint: 'system_greetings_i18n_key_format' } });
        });
      },
    );

    it('refreshes updated_at on update and keeps created_at', async () => {
      await withRollback(db, async (tx) => {
        const longAgo = new Date('2000-01-01T00:00:00Z');
        await tx.delete(systemGreetings);
        await tx
          .insert(systemGreetings)
          .values({ ...HELLO_GREETING, createdAt: longAgo, updatedAt: longAgo });

        await tx.update(systemGreetings).set({ i18nKey: 'system.helloAgain' });

        const [row] = await tx.select().from(systemGreetings);
        expect(row?.createdAt).toEqual(longAgo);
        expect(row?.updatedAt.getTime()).toBeGreaterThan(longAgo.getTime());
      });
    });
  });

  // Runs after the tests above, which Vitest guarantees within a file.
  it('leaves nothing behind: every test above was rolled back', async () => {
    expect(await db.select().from(systemGreetings)).toEqual([
      expect.objectContaining(HELLO_GREETING),
    ]);
  });

  describe('conventions', () => {
    it('runs every session in UTC', async () => {
      const [setting] = await rows<{ TimeZone: string }>(db, sql`show timezone`);
      expect(setting?.TimeZone).toBe('UTC');
    });

    it('stores every timestamp column as timestamptz', async () => {
      const columns = await rows<{ table_name: string; column_name: string; data_type: string }>(
        db,
        sql`select table_name, column_name, data_type from information_schema.columns
            where table_schema = 'public' and data_type like 'timestamp%'`,
      );
      expect(columns.length).toBeGreaterThan(0);
      for (const column of columns) {
        expect(column, `${column.table_name}.${column.column_name}`).toMatchObject({
          data_type: 'timestamp with time zone',
        });
      }
    });

    it('gives every table a uuid primary key named id', async () => {
      const keys = await rows<{ table_name: string; columns: string[]; types: string[] }>(
        db,
        sql`select c.relname as table_name,
                   array_agg(a.attname::text) as columns,
                   array_agg(format_type(a.atttypid, a.atttypmod)) as types
            from pg_index i
            join pg_class c on c.oid = i.indrelid
            join pg_namespace n on n.oid = c.relnamespace
            join pg_attribute a on a.attrelid = c.oid and a.attnum = any(i.indkey)
            where i.indisprimary and n.nspname = 'public'
            group by c.relname`,
      );
      const tables = await publicTables(db);
      expect(keys.map((key) => key.table_name).sort()).toEqual(tables);
      for (const key of keys) {
        expect(key, key.table_name).toMatchObject({ columns: ['id'], types: ['uuid'] });
      }
    });

    it('puts organization_id on every business table', async () => {
      const tables = await publicTables(db);
      const withOrganization = await rows<{ table_name: string }>(
        db,
        sql`select table_name from information_schema.columns
            where table_schema = 'public' and column_name = 'organization_id'`,
      );
      const scoped = new Set(withOrganization.map((row) => row.table_name));

      // The allow-list must only name tables that exist.
      expect(tables).toEqual(expect.arrayContaining(NON_BUSINESS_TABLES));
      const unscoped = tables.filter(
        (table) => !scoped.has(table) && !NON_BUSINESS_TABLES.includes(table),
      );
      expect(unscoped).toEqual([]);
    });
  });
});

async function publicTables(db: DatabaseExecutor): Promise<string[]> {
  const tables = await rows<{ table_name: string }>(
    db,
    sql`select table_name from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE'
        order by table_name`,
  );
  return tables.map((row) => row.table_name);
}
