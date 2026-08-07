/**
 * Database access layer.
 *
 * Two things matter here beyond the usual "connect to Postgres":
 *
 * 1. RLS session variables. Every request against a tenant-owned table must
 *    run inside a transaction that has SET LOCAL app.business_id = ... first.
 *    Without that, RLS policies see NULL for the current business and every
 *    query returns zero rows. Use `withTenant(...)` — never issue queries
 *    directly with `db.selectFrom(...)` from a request handler.
 *
 * 2. Pool tuning. Statement timeout is set globally on the connection so a
 *    runaway query cannot pin a connection forever. This is defense-in-depth;
 *    the API also enforces per-endpoint timeouts.
 *
 * Alternatives considered:
 *   - Prisma: fights RLS because its client hides connection lifecycle.
 *   - Raw pg + query helper: fine, but 80 endpoints × handwritten SQL is
 *     more surface for injection mistakes. Kysely gives type-safe query
 *     building with a clean escape hatch for hand-written SQL when needed.
 */

import { Kysely, PostgresDialect, sql, type Transaction } from "kysely";
import pg from "pg";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import type { Database } from "./db-schema.js";

const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: env.DATABASE_POOL_MAX,
  statement_timeout: env.DATABASE_STATEMENT_TIMEOUT_MS,
  // Application name shows up in pg_stat_activity — helpful for triage.
  application_name: `trend-${env.ROLE}`,
});

pool.on("error", (err) => {
  logger.error({ err }, "postgres pool error");
});

export const db = new Kysely<Database>({
  dialect: new PostgresDialect({ pool }),
  log: env.isDev
    ? (event) => {
        if (event.level === "error") logger.error({ event }, "db error");
      }
    : undefined,
});

/**
 * Run a callback inside a transaction with tenant + user set as PostgreSQL
 * session variables. RLS policies read these and filter automatically.
 *
 * The variables are set with SET LOCAL, so they are automatically cleared
 * when the transaction ends — even on rollback. There is no way to leak
 * a tenant context to the next request on the same connection.
 */
export async function withTenant<T>(
  args: { businessId: number; userId: number | null },
  fn: (trx: Transaction<Database>) => Promise<T>,
): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await sql`SET LOCAL app.business_id = ${sql.lit(args.businessId)}`.execute(trx);
    if (args.userId != null) {
      await sql`SET LOCAL app.user_id = ${sql.lit(args.userId)}`.execute(trx);
    }
    return fn(trx);
  });
}

/**
 * Run a callback inside a transaction WITHOUT tenant context. Only for
 * requests that legitimately span tenants: login, signup, password reset,
 * admin operations. Callers must never touch tenant-owned tables here —
 * RLS will refuse the query anyway, so a bug fails loudly rather than
 * silently leaking data.
 */
export async function withNoTenant<T>(
  fn: (trx: Transaction<Database>) => Promise<T>,
): Promise<T> {
  return db.transaction().execute(fn);
}

/**
 * Health-check ping. Returns quickly; failure is a signal to restart the pool.
 */
export async function pingDb(): Promise<boolean> {
  try {
    await sql`SELECT 1`.execute(db);
    return true;
  } catch (err) {
    logger.warn({ err }, "db ping failed");
    return false;
  }
}

export async function closeDb(): Promise<void> {
  await db.destroy();
}
