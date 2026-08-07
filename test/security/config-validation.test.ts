/**
 * A05: Config validation regression.
 *
 * The env loader in src/config/env.ts must:
 *   1. Refuse a JWT_SECRET shorter than 32 chars in HS256 mode.
 *   2. Refuse HS256 in production.
 *   3. Require JWT_PRIVATE_KEY and JWT_PUBLIC_KEY when RS256 is chosen.
 *   4. Refuse missing DATABASE_URL or REDIS_URL.
 *
 * We test by running node in a subprocess with bad env; expect non-zero exit.
 * We use `tsx` so we exercise the same code path production does.
 */

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const ENV_MODULE = resolve(__filename, "../../../src/config/env.ts");

function runEnvLoader(overrides: Record<string, string | undefined>): {
  status: number | null;
  stderr: string;
} {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "test",
    ROLE: "api",
    PORT: "3000",
    DATABASE_URL: "postgres://x:y@localhost:5432/z",
    REDIS_URL: "redis://localhost:6379/0",
    JWT_ALGORITHM: "HS256",
    JWT_SECRET: "at-least-thirty-two-characters-long-secret",
    ...overrides,
  };
  // Empty-string overrides should be treated as "unset" for the target var.
  for (const [k, v] of Object.entries(overrides)) {
    if (v === "" || v === undefined) delete env[k];
  }

  const result = spawnSync(
    "node",
    ["--import", "tsx", ENV_MODULE],
    { env, encoding: "utf8", timeout: 10_000 },
  );
  return { status: result.status, stderr: result.stderr };
}

describe("A05: env config fails fast on bad values", () => {
  it("valid config loads cleanly (baseline)", () => {
    const { status } = runEnvLoader({});
    expect(status).toBe(0);
  });

  it("refuses JWT_SECRET shorter than 32 characters in HS256", () => {
    const { status, stderr } = runEnvLoader({ JWT_SECRET: "too-short" });
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/JWT_SECRET|32 characters/i);
  });

  it("refuses HS256 in NODE_ENV=production", () => {
    const { status, stderr } = runEnvLoader({
      NODE_ENV: "production",
      JWT_ALGORITHM: "HS256",
    });
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/HS256.*production|RS256/i);
  });

  it("refuses missing DATABASE_URL", () => {
    const { status, stderr } = runEnvLoader({ DATABASE_URL: undefined });
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/DATABASE_URL/i);
  });

  it("refuses missing REDIS_URL", () => {
    const { status, stderr } = runEnvLoader({ REDIS_URL: undefined });
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/REDIS_URL/i);
  });

  it("refuses RS256 without keypair", () => {
    const { status, stderr } = runEnvLoader({
      JWT_ALGORITHM: "RS256",
      // JWT_PRIVATE_KEY and JWT_PUBLIC_KEY intentionally missing
    });
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/JWT_PRIVATE_KEY|JWT_PUBLIC_KEY|RS256/i);
  });
});
