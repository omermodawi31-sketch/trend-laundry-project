/**
 * Opaque token helpers.
 *
 * Every token in the system that is NOT a signed JWT — refresh tokens,
 * password-reset tokens, email-verification tokens — is a 256-bit random
 * value from `crypto.randomBytes`. The raw token is sent to the client
 * exactly once (in a cookie or an email URL). The database only stores
 * SHA-256 hashes.
 *
 * Why SHA-256 and not argon2 for these? Argon2 is designed to be slow so
 * password guessing hurts. That's the wrong shape for these tokens:
 *   - the token is already 256 bits of entropy — brute force is impossible
 *   - we look them up on every refresh / reset click — argon2 latency would
 *     bottleneck the auth hot path
 * SHA-256 gives us "database dump can't be replayed as valid tokens" for
 * essentially free.
 */

import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

/**
 * Generate a URL-safe token and its hash.
 * The raw string is the value that goes to the client.
 * The hash is what goes into the database.
 */
export function generateToken(): { raw: string; hash: Buffer } {
  const bytes = randomBytes(32);
  const raw = bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const hash = createHash("sha256").update(bytes).digest();
  return { raw, hash };
}

/** Rehash a raw token for lookup. */
export function hashToken(raw: string): Buffer {
  // Convert base64url back to bytes.
  const padded = raw.replace(/-/g, "+").replace(/_/g, "/") + "==".slice(0, (4 - (raw.length % 4)) % 4);
  const bytes = Buffer.from(padded, "base64");
  return createHash("sha256").update(bytes).digest();
}

/**
 * Constant-time hash comparison. Used when comparing a computed hash
 * against a fetched-from-DB hash. Not strictly necessary for opaque
 * tokens (they're not user-provided secrets in the traditional sense),
 * but zero-cost and prevents any timing signal.
 */
export function compareHashes(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
