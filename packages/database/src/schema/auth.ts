import type { Locale } from '@fivvi/i18n';
import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { id, instant, timestamps } from './columns.ts';

// Better Auth's four models under our names (F001, ADR-007, spec #128): its "user" is an
// account (`auth_users`), its "session" a sign-in session (`auth_sessions`; *Session* is a
// scheduled training in the glossary), its "account" an identity (`auth_identities`) and its
// "verification" a sign-in verification (`auth_verifications`). An account is global and
// shared by every workspace of its person, and these tables hold no business data, so none of
// them has an `organization_id` (ADR-006 scoping does not apply; membership comes with F002).

/** An account: the login of one person. */
export const authUsers = pgTable(
  'auth_users',
  {
    id: id(),
    /** Better Auth requires a name. Sign-in by email collects none, so it stays empty. */
    name: text('name').notNull().default(''),
    /** Lower case: Better Auth normalises it before every read and write. */
    email: text('email').notNull().unique(),
    emailVerified: boolean('email_verified').notNull().default(false),
    /** The language of the screen where the person first signed in (ADR-019); F010 changes it. */
    preferredLocale: text('preferred_locale').$type<Locale>(),
    ...timestamps(),
  },
  (table) => [
    check('auth_users_email_lowercase', sql`${table.email} = lower(${table.email})`),
    check(
      'auth_users_preferred_locale_supported',
      sql`${table.preferredLocale} IS NULL OR ${table.preferredLocale} IN ('nl-NL', 'en')`,
    ),
  ],
);

/** A sign-in session: one signed-in browser (or, later, app). */
export const authSessions = pgTable(
  'auth_sessions',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    token: text('token').notNull().unique(),
    expiresAt: instant('expires_at').notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    ...timestamps(),
  },
  (table) => [index('auth_sessions_user_id_idx').on(table.userId)],
);

/** How an account signs in. Unused by sign-in with the emailed code; kept for Better Auth. */
export const authIdentities = pgTable(
  'auth_identities',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    ...timestamps(),
  },
  (table) => [index('auth_identities_user_id_idx').on(table.userId)],
);

/**
 * One sign-in request: the emailed link token and code, which are one verification. Only
 * hashes are stored (AC11): `value` holds the hash of the link token, `codeHash` the hash of
 * the code. A usable token or code is never in the database.
 */
export const authVerifications = pgTable(
  'auth_verifications',
  {
    id: id(),
    /** `sign-in:<lower-case email>`: one verification per address, a new request replaces it. */
    identifier: text('identifier').notNull(),
    /** Keyed hash of the sign-in link's token. */
    value: text('value').notNull(),
    /** Keyed hash of the 6-digit code. */
    codeHash: text('code_hash').notNull(),
    /**
     * The language of the email that carries this link and code: the account's stored language,
     * else the sign-in page's (ADR-019). The first sign-in stores it on a new account.
     */
    locale: text('locale'),
    /** Wrong codes entered for this verification; at `MAX_WRONG_CODES` it is dead, link and code (AC6). */
    failedAttempts: integer('failed_attempts').notNull().default(0),
    expiresAt: instant('expires_at').notNull(),
    ...timestamps(),
  },
  (table) => [
    index('auth_verifications_identifier_idx').on(table.identifier),
    check(
      'auth_verifications_locale_supported',
      sql`${table.locale} IS NULL OR ${table.locale} IN ('nl-NL', 'en')`,
    ),
  ],
);

/**
 * How many sign-in requests a key made in its current window (AC10), kept in Postgres so a
 * deploy or restart doesn't reset it. `key` is `<what>:<keyed hash>` of an email address or an
 * IP address: the table holds neither. A row is dead once `window_ends_at` has passed; the next
 * request of that key starts a new window and expired rows are deleted as requests come in.
 */
export const authRateLimits = pgTable(
  'auth_rate_limits',
  {
    id: id(),
    key: text('key').notNull().unique(),
    count: integer('count').notNull(),
    windowEndsAt: instant('window_ends_at').notNull(),
    ...timestamps(),
  },
  (table) => [index('auth_rate_limits_window_ends_at_idx').on(table.windowEndsAt)],
);

export type AuthUser = typeof authUsers.$inferSelect;

/** The account behind a request's sign-in session (spec #128). */
export type SignedInAccount = Pick<AuthUser, 'id' | 'email' | 'preferredLocale'>;
