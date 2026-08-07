/**
 * Integration-test helpers.
 *
 * These tests need a real Postgres. The harness:
 *   1. Points at a dedicated test database (env DATABASE_URL_TEST or fallback).
 *   2. Applies migrations once per test-file lifetime.
 *   3. Truncates all tables (respecting FKs) before each test.
 *
 * Note: individual test files that don't need the DB skip this harness.
 */

import { execSync } from "node:child_process";
import { sql } from "kysely";
import { db, closeDb } from "../../src/lib/db.js";
import { closeRedis } from "../../src/lib/redis.js";

let migrated = false;

export async function ensureMigrated(): Promise<void> {
  if (migrated) return;
  // Run migrations via the CLI so we're testing the same pathway prod uses.
  try {
    execSync("pnpm migrate", { stdio: "pipe" });
  } catch {
    // Fall back to npm if pnpm isn't around; migrations still run under `tsx`.
    execSync("node --import tsx src/lib/migrate.ts up", { stdio: "pipe" });
  }
  migrated = true;
}

/**
 * Truncate every application table in dependency order.
 * Cheaper than dropping and recreating; keeps sequences.
 */
export async function truncateAll(): Promise<void> {
  const tables = [
    "delivery_job_status_history",
    "delivery_jobs",
    "drivers",
    "order_photos",
    "order_status_history",
    "payments",
    "order_lines",
    "orders",
    "invoice_number_counters",
    "order_number_counters",
    "service_variants",
    "services",
    "customer_notes",
    "customers",
    "activity_logs",
    "password_resets",
    "email_verifications",
    "refresh_tokens",
    "memberships",
    "roles",
    "inventory_movements",
    "inventory_items",
    "business_settings",
    "branches",
    "users",
    "businesses",
  ];
  for (const t of tables) {
    await sql`SET session_replication_role = 'replica'`.execute(db);
    await sql.raw(`TRUNCATE TABLE "${t}" RESTART IDENTITY CASCADE`).execute(db);
    await sql`SET session_replication_role = 'origin'`.execute(db);
  }
}

export async function teardown(): Promise<void> {
  await closeDb();
  await closeRedis();
}
