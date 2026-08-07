/**
 * Vitest global setup.
 *
 * Kept minimal in Phase 0. Once we start writing integration tests that hit
 * Postgres, this file will:
 *   - spin up a fresh test database
 *   - run migrations
 *   - install `beforeEach`/`afterEach` hooks that wrap tests in transactions
 *     rolled back at the end, so tests can share state without polluting.
 *
 * For now: just make sure NODE_ENV=test so config picks up test defaults.
 */

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "warn";

// Provide dev-safe defaults for anything env.ts requires so unit tests can
// import the module without a real .env. Integration tests will override.
process.env.DATABASE_URL ??= "postgres://trend:trend@localhost:5432/trend_laundry_test";
process.env.REDIS_URL    ??= "redis://localhost:6379/1";
process.env.JWT_SECRET   ??= "test-secret-at-least-32-characters-long-abcdefgh";
