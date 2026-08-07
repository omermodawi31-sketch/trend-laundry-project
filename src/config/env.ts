/**
 * Schema-validated environment loader.
 *
 * Design decision: parse .env once at boot with Zod. If any required var is
 * missing or malformed, the process refuses to start. This prevents a whole
 * class of "it worked locally but crashed in prod at 2am" bugs — every env
 * assumption is stated here in one place.
 */

import { config as loadDotenv } from "dotenv";
import { z } from "zod";

loadDotenv();

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  ROLE: z.enum(["api", "worker"]).default("api"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  CORS_ORIGINS: z.string().default(""),

  DATABASE_URL: z.string().url(),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  DATABASE_REPLICA_URL: z.string().url().optional().or(z.literal("").transform(() => undefined)),

  REDIS_URL: z.string().url(),

  JWT_ALGORITHM: z.enum(["HS256", "RS256"]).default("HS256"),
  JWT_SECRET: z.string().optional(),
  JWT_PRIVATE_KEY: z.string().optional(),
  JWT_PUBLIC_KEY: z.string().optional(),
  JWT_KID: z.string().default("v1"),

  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(2_592_000),

  COOKIE_DOMAIN: z.string().default("localhost"),
  COOKIE_SECURE: z.coerce.boolean().default(false),
  COOKIE_SAMESITE: z.enum(["lax", "strict", "none"]).default("lax"),

  ARGON2_MEMORY_KB: z.coerce.number().int().positive().default(65536),
  ARGON2_TIME_COST: z.coerce.number().int().positive().default(3),
  ARGON2_PARALLELISM: z.coerce.number().int().positive().default(4),

  ADMIN_IP_ALLOWLIST: z.string().default("127.0.0.1/32"),

  FEATURE_MFA_ENABLED: z.coerce.boolean().default(true),
  FEATURE_EMAIL_VERIFICATION: z.coerce.boolean().default(false),

  RATE_LIMIT_LOGIN_PER_IP_PER_MIN: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_LOGIN_PER_EMAIL_PER_HOUR: z.coerce.number().int().positive().default(5),
  RATE_LIMIT_DEFAULT_PER_USER_PER_MIN: z.coerce.number().int().positive().default(120),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // Fail hard, print the reasons.
  // eslint-disable-next-line no-console
  console.error("❌ Invalid environment configuration:");
  for (const issue of parsed.error.issues) {
    // eslint-disable-next-line no-console
    console.error(`  ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

const raw = parsed.data;

// Cross-field validation — Zod can only validate per-field.
// The choice of JWT algorithm dictates which key material is required.
if (raw.JWT_ALGORITHM === "HS256") {
  if (!raw.JWT_SECRET || raw.JWT_SECRET.length < 32) {
    // eslint-disable-next-line no-console
    console.error("❌ JWT_SECRET must be at least 32 characters when JWT_ALGORITHM=HS256");
    process.exit(1);
  }
  if (raw.NODE_ENV === "production") {
    // eslint-disable-next-line no-console
    console.error("❌ JWT_ALGORITHM=HS256 is not allowed in production. Use RS256.");
    process.exit(1);
  }
}
if (raw.JWT_ALGORITHM === "RS256") {
  if (!raw.JWT_PRIVATE_KEY || !raw.JWT_PUBLIC_KEY) {
    // eslint-disable-next-line no-console
    console.error("❌ JWT_PRIVATE_KEY and JWT_PUBLIC_KEY required when JWT_ALGORITHM=RS256");
    process.exit(1);
  }
}

export const env = Object.freeze({
  ...raw,
  isProd: raw.NODE_ENV === "production",
  isTest: raw.NODE_ENV === "test",
  isDev: raw.NODE_ENV === "development",
  corsOrigins: raw.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean),
});

export type Env = typeof env;
