/**
 * Migration runner.
 *
 * Design choices:
 *   - Migrations are raw SQL files in db/migrations/, timestamped.
 *   - Each file runs inside a single transaction — either the whole thing
 *     succeeds or nothing changes. Rollbacks of partial state are impossible
 *     because they never happen.
 *   - Applied migrations are recorded in schema_migrations. The runner
 *     compares filesystem against DB and applies whatever's new, in order.
 *   - Down migrations are optional. A separate `.down.sql` file, if present,
 *     runs on `migrate:down`. Otherwise we refuse to migrate down — safer
 *     than pretending we can auto-reverse.
 *   - No migration file is ever edited after being committed. Corrections
 *     ship as a new migration.
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";

const __filename = fileURLToPath(import.meta.url);
const MIGRATIONS_DIR = resolve(__filename, "../../../db/migrations");

async function withClient<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
    await pool.end();
  }
}

async function ensureMigrationsTable(client: pg.PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        text PRIMARY KEY,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `);
}

function listMigrationFiles(): string[] {
  if (!existsSync(MIGRATIONS_DIR)) return [];
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql") && !f.endsWith(".down.sql"))
    .sort();
}

async function appliedMigrations(client: pg.PoolClient): Promise<Set<string>> {
  const { rows } = await client.query<{ name: string }>("SELECT name FROM schema_migrations");
  return new Set(rows.map((r) => r.name));
}

async function up(): Promise<void> {
  await withClient(async (client) => {
    await ensureMigrationsTable(client);
    const applied = await appliedMigrations(client);
    const files = listMigrationFiles();
    const pending = files.filter((f) => !applied.has(f));
    if (pending.length === 0) {
      logger.info("no pending migrations");
      return;
    }
    for (const file of pending) {
      const path = join(MIGRATIONS_DIR, file);
      const sql = readFileSync(path, "utf8");
      logger.info({ file }, "applying migration");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        logger.info({ file }, "migration applied");
      } catch (err) {
        await client.query("ROLLBACK");
        logger.error({ file, err }, "migration failed");
        throw err;
      }
    }
    logger.info({ count: pending.length }, "all migrations applied");
  });
}

async function down(): Promise<void> {
  await withClient(async (client) => {
    await ensureMigrationsTable(client);
    const { rows } = await client.query<{ name: string }>(
      "SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1",
    );
    const last = rows[0]?.name;
    if (!last) {
      logger.info("no migrations to reverse");
      return;
    }
    const downFile = last.replace(/\.sql$/, ".down.sql");
    const path = join(MIGRATIONS_DIR, downFile);
    if (!existsSync(path)) {
      logger.error({ last, downFile }, "no down migration available");
      throw new Error(`No down migration for ${last}`);
    }
    logger.info({ file: downFile }, "reversing migration");
    await client.query("BEGIN");
    try {
      await client.query(readFileSync(path, "utf8"));
      await client.query("DELETE FROM schema_migrations WHERE name = $1", [last]);
      await client.query("COMMIT");
      logger.info({ file: downFile }, "migration reversed");
    } catch (err) {
      await client.query("ROLLBACK");
      logger.error({ file: downFile, err }, "reverse failed");
      throw err;
    }
  });
}

async function status(): Promise<void> {
  await withClient(async (client) => {
    await ensureMigrationsTable(client);
    const applied = await appliedMigrations(client);
    const files = listMigrationFiles();
    // eslint-disable-next-line no-console
    console.log("Migration status:");
    for (const f of files) {
      const mark = applied.has(f) ? "✓ applied" : "· pending";
      // eslint-disable-next-line no-console
      console.log(`  ${mark}  ${f}`);
    }
  });
}

const cmd = process.argv[2];
try {
  if (cmd === "up") await up();
  else if (cmd === "down") await down();
  else if (cmd === "status") await status();
  else {
    // eslint-disable-next-line no-console
    console.error("Usage: migrate <up|down|status>");
    process.exit(1);
  }
} catch (err) {
  logger.error({ err }, "migration command failed");
  process.exit(1);
}
