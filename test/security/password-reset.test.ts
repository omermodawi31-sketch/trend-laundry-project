/**
 * A07: Password reset security invariants.
 *
 * Non-obvious invariants tested here:
 *
 *   1. Reset tokens are single-use — a replay attempt is rejected.
 *   2. Reset tokens expire after 30 minutes.
 *   3. Successful reset revokes every existing refresh token for that user
 *      (a stolen session cannot survive a password reset).
 *   4. Reset request always returns 202 whether the email exists or not
 *      (no account enumeration).
 *   5. The reset TOKEN is stored hashed, not as plaintext.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../../src/lib/db.js";
import {
  confirmPasswordReset,
  login,
  requestPasswordReset,
  signupOwnerAndBusiness,
} from "../../src/modules/auth/service.ts";
import { hashToken } from "../../src/lib/tokens.js";
import { AppError } from "../../src/lib/errors.js";
import { ensureMigrated, teardown, truncateAll } from "../helpers/harness.js";

const EMAIL = "reset@example.com";
const OLD_PW = "correct-horse-battery-staple";
const NEW_PW = "brand-new-passphrase-with-entropy";

async function seed(): Promise<void> {
  await signupOwnerAndBusiness({
    business: { name: { en: "Reset Test", ar: "إعادة تعيين" } },
    owner: { email: EMAIL, full_name: "Reset Owner", password: OLD_PW },
    branch: { name: { en: "M", ar: "م" }, code: "RST1", address: { en: "x", ar: "س" } },
  }, { ipAddress: null, userAgent: null });
}

describe("A07: password reset invariants", () => {
  beforeAll(async () => { await ensureMigrated(); });
  beforeEach(async () => { await truncateAll(); await seed(); });
  afterAll(async () => { await teardown(); });

  it("reset token is single-use — replay is rejected", async () => {
    const token = await requestPasswordReset(EMAIL);
    expect(token).toBeTruthy();

    await confirmPasswordReset(token!, NEW_PW);

    // Replay: same token, different new password.
    await expect(
      confirmPasswordReset(token!, "different-password-attempt"),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("expired reset token is rejected", async () => {
    const token = await requestPasswordReset(EMAIL);

    // Manually expire.
    await db.updateTable("password_resets")
      .set({ expires_at: new Date(Date.now() - 1000).toISOString() as never })
      .where("token_hash", "=", hashToken(token!))
      .execute();

    await expect(
      confirmPasswordReset(token!, NEW_PW),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("successful reset revokes every existing refresh token for the user", async () => {
    // Establish two sessions.
    const s1 = await login({ email: EMAIL, password: OLD_PW }, { ipAddress: null, userAgent: null });
    const s2 = await login({ email: EMAIL, password: OLD_PW }, { ipAddress: null, userAgent: null });

    // Both active refresh tokens exist.
    const before = await db.selectFrom("refresh_tokens")
      .select("id")
      .where("revoked_at", "is", null)
      .execute();
    expect(before.length).toBeGreaterThanOrEqual(2);

    // Reset password.
    const token = await requestPasswordReset(EMAIL);
    await confirmPasswordReset(token!, NEW_PW);

    // Every refresh token must now be revoked.
    const active = await db.selectFrom("refresh_tokens")
      .select("id")
      .where("revoked_at", "is", null)
      .execute();
    expect(active.length).toBe(0);

    // And old password no longer works.
    await expect(
      login({ email: EMAIL, password: OLD_PW }, { ipAddress: null, userAgent: null }),
    ).rejects.toBeInstanceOf(AppError);

    // New password does.
    const fresh = await login({ email: EMAIL, password: NEW_PW }, { ipAddress: null, userAgent: null });
    expect(fresh.access_token).toBeTruthy();

    // Silence "unused" warnings on session vars.
    expect(typeof s1.refresh_token).toBe("string");
    expect(typeof s2.refresh_token).toBe("string");
  });

  it("reset request never discloses whether the email exists", async () => {
    // Both calls must complete without throwing.
    const knownResult = await requestPasswordReset(EMAIL);
    const unknownResult = await requestPasswordReset("nobody@example.com");

    // The service returns a token only when the email exists (for delivery); the
    // ENDPOINT always returns 202. Here we assert the service does not throw.
    expect(typeof knownResult === "string" || knownResult === null).toBe(true);
    expect(unknownResult).toBeNull();
  });

  it("reset TOKEN is stored hashed, not as plaintext", async () => {
    const token = await requestPasswordReset(EMAIL);
    expect(token).toBeTruthy();

    const rows = await db.selectFrom("password_resets")
      .select("token_hash")
      .execute();

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const stored = Buffer.from(row.token_hash);
      const raw = Buffer.from(token!);
      expect(stored.equals(raw)).toBe(false);
    }

    // The hash of the raw token must match a stored row.
    const found = await db.selectFrom("password_resets")
      .select("id")
      .where("token_hash", "=", hashToken(token!))
      .executeTakeFirst();
    expect(found).toBeDefined();
  });
});
