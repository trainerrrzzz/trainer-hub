import { lte, sql } from 'drizzle-orm';
import type { DatabaseExecutor } from '../client.ts';
import { authRateLimits } from '../schema/index.ts';

export interface RateLimitRule {
  /** How many requests one key may make per window. */
  max: number;
  windowMinutes: number;
}

/**
 * Counts one request of `key` in its current fixed window and says whether it is within
 * the rule. The first request starts the window, which ends `windowMinutes` later; the next
 * one after that starts a new window. Requests over the limit are counted too but never move
 * the end of the window. The count goes up in one statement, so parallel requests are all
 * counted and a restart loses nothing.
 *
 * `now` is passed in (an injected clock), never read from the server. Throws when the database
 * returns no count: a limit must never let a request through because it could not count it.
 */
export async function consumeRateLimit(
  db: DatabaseExecutor,
  key: string,
  rule: RateLimitRule,
  now: Date,
): Promise<{ allowed: boolean }> {
  const windowEndsAt = new Date(now.getTime() + rule.windowMinutes * 60_000);
  const expired = lte(authRateLimits.windowEndsAt, now);
  const [row] = await db
    .insert(authRateLimits)
    .values({ key, count: 1, windowEndsAt })
    .onConflictDoUpdate({
      target: authRateLimits.key,
      set: {
        count: sql`CASE WHEN ${expired} THEN 1 ELSE ${authRateLimits.count} + 1 END`,
        windowEndsAt: sql`CASE WHEN ${expired} THEN ${windowEndsAt} ELSE ${authRateLimits.windowEndsAt} END`,
        updatedAt: sql`now()`,
      },
    })
    .returning({ count: authRateLimits.count });
  if (!row) throw new Error('Rate limit: the database returned no row, so nothing was counted.');
  return { allowed: row.count <= rule.max };
}

/**
 * Deletes the rows whose window has ended. A key that comes back reuses its row, so this only
 * clears keys that never came back. It is one indexed range delete (`window_ends_at`), run once
 * per request rather than once per counted key.
 */
export async function deleteExpiredRateLimits(db: DatabaseExecutor, now: Date): Promise<void> {
  await db.delete(authRateLimits).where(lte(authRateLimits.windowEndsAt, now));
}
