/**
 * Password hashing — argon2id per the spec.
 *
 * The `argon2` package wraps the reference libargon2 in native bindings.
 * Parameters come from env so ops can tune without a code change if hardware
 * capacity changes.
 *
 * Verify is constant-time relative to the correct hash; we don't have to
 * worry about timing attacks against the hash comparison. But we DO have to
 * worry about timing attacks against user existence — so login flow always
 * runs verify against a dummy hash when the user doesn't exist, matching the
 * wall-clock time.
 */

import argon2 from "argon2";
import { env } from "../config/env.js";

const OPTS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: env.ARGON2_MEMORY_KB,
  timeCost: env.ARGON2_TIME_COST,
  parallelism: env.ARGON2_PARALLELISM,
};

/**
 * A pre-computed hash we verify against when the user doesn't exist, to keep
 * login timing constant. The value below is a hash of a random string; it's
 * cheap to keep here and never matches a real password.
 */
const DUMMY_HASH =
  "$argon2id$v=19$m=65536,t=3,p=4$MDAwMDAwMDAwMDAwMDAwMA$m2iBUnGaKAsnMbYo8sqPzTfHVN1QqWfPCcgYyR2XCzE";

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, OPTS);
}

export async function verifyPassword(hash: string | null, plain: string): Promise<boolean> {
  if (!hash) {
    // User not found — burn the same time anyway to prevent timing enumeration.
    await argon2.verify(DUMMY_HASH, plain).catch(() => false);
    return false;
  }
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}
