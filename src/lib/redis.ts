/**
 * Redis client + rate limiting.
 *
 * Redis is used for:
 *   - Login rate limits (per-IP, per-email)
 *   - Session revocation index (Phase 2 concern)
 *   - Idempotency dedupe (Phase 2)
 *   - Queue backend (Phase 6)
 *
 * All keys are prefixed by role/purpose so a bug in one area cannot corrupt
 * another. Tenant-scoped keys additionally prefix with `t:<business_id>:`.
 *
 * Rate limiter is a fixed-window counter — simple, adequate for auth flows.
 * A sliding window is nicer but requires more Redis round-trips.
 */

import Redis from "ioredis";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";

let client: Redis | null = null;

export function redis(): Redis {
  if (!client) {
    client = new Redis(env.REDIS_URL, {
      lazyConnect: false,
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
    });
    client.on("error", (err) => logger.error({ err }, "redis error"));
  }
  return client;
}

export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit();
    client = null;
  }
}

/**
 * Fixed-window rate limit.
 *
 * Returns `{ allowed, remaining, resetsInSeconds }`. Increments before
 * returning, so the caller doesn't need a second call.
 *
 * On Redis failure, we **fail open**: log a warning and allow the request.
 * The alternative — blocking every request when Redis is down — is worse
 * than the brief window where limits aren't enforced. This is a deliberate
 * choice documented in SECURITY.md §1.5.
 */
export async function rateLimitFixedWindow(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<{ allowed: boolean; remaining: number; resetsInSeconds: number }> {
  try {
    const r = redis();
    const bucket = `rl:${key}:${Math.floor(Date.now() / 1000 / windowSeconds)}`;
    const count = await r.incr(bucket);
    if (count === 1) await r.expire(bucket, windowSeconds);
    const ttl = await r.ttl(bucket);
    return {
      allowed: count <= limit,
      remaining: Math.max(0, limit - count),
      resetsInSeconds: ttl > 0 ? ttl : windowSeconds,
    };
  } catch (err) {
    logger.warn({ err, key }, "rate limit check failed — failing open");
    return { allowed: true, remaining: limit, resetsInSeconds: windowSeconds };
  }
}
