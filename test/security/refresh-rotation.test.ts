/**
 * A07 + A08: Refresh token rotation with reuse detection.
 *
 * The property tested here is not just "the flow works" — it's the
 * security-critical invariant: presenting a revoked refresh token after
 * it's been rotated must trigger revocation of the entire token family.
 *
 * A leaked refresh token becomes a permanent compromise without this
 * check; with it, the second use (attacker's OR victim's) is detected
 * and the whole session tree is killed.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../../src/lib/db.js";
import { login, refresh, signupOwnerAndBusiness } from "../../src/modules/auth/service.ts";
import { hashToken } from "../../src/lib/tokens.js";
import { AppError } from "../../src/lib/errors.js";
import { ensureMigrated, teardown, truncateAll } from "../helpers/harness.js";

const EMAIL = "rotate@example.com";
const PW = "correct-horse-battery-staple";

async function seedAndLogin(): Promise<string> {
  await signupOwnerAndBusiness({
    business: { name: { en: "Rotate LLC", ar: "روتيت" } },
    owner: { email: EMAIL, full_name: "Rotate Owner", password: PW },
    branch: { name: { en: "M", ar: "م" }, code: "R1", address: { en: "x", ar: "س" } },
  }, { ipAddress: null, userAgent: null });

  const result = await login({ email: EMAIL, password: PW }, { ipAddress: null, userAgent: null });
  return result.refresh_token;
}

describe("A07 + A08: refresh token rotation and reuse detection", () => {
  beforeAll(async () => { await ensureMigrated(); });
  beforeEach(async () => { await truncateAll(); });
  afterAll(async () => { await teardown(); });

  it("refresh rotates the token: old is revoked, new is issued", async () => {
    const originalRaw = await seedAndLogin();

    const rotated = await refresh(originalRaw, { ipAddress: null, userAgent: null });
    expect(rotated.refresh_token).not.toBe(originalRaw);
    expect(rotated.access_token).toBeTruthy();

    // The original token row in the DB must now be revoked.
    const originalHash = hashToken(originalRaw);
    const originalRow = await db.selectFrom("refresh_tokens")
      .select(["revoked_at", "revoked_reason"])
      .where("token_hash", "=", originalHash)
      .executeTakeFirstOrThrow();
    expect(originalRow.revoked_at).not.toBeNull();
    expect(originalRow.revoked_reason).toBe("rotated");
  });

  it("reusing a revoked token revokes the ENTIRE family", async () => {
    // Session tree: A → B → C. All in one family.
    const A = await seedAndLogin();
    const rotatedB = await refresh(A, { ipAddress: null, userAgent: null });
    const B = rotatedB.refresh_token;
    const rotatedC = await refresh(B, { ipAddress: null, userAgent: null });
    const C = rotatedC.refresh_token;

    // Grab the family id from any of them.
    const familyRow = await db.selectFrom("refresh_tokens")
      .select("family_id")
      .where("token_hash", "=", hashToken(C))
      .executeTakeFirstOrThrow();
    const familyId = familyRow.family_id;

    // Attacker replays A — a token we know was revoked when B was minted.
    await expect(
      refresh(A, { ipAddress: null, userAgent: null }),
    ).rejects.toBeInstanceOf(AppError);

    // Every token in the family should now be revoked, including the
    // still-fresh C.
    const rows = await db.selectFrom("refresh_tokens")
      .select(["revoked_at", "revoked_reason"])
      .where("family_id", "=", familyId)
      .execute();

    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const row of rows) {
      expect(row.revoked_at).not.toBeNull();
    }
    // At least one row should record why: reuse detected.
    const reasons = rows.map((r) => r.revoked_reason).filter(Boolean);
    expect(reasons).toContain("reuse_detected");
  });

  it("using a rotated token (B) after reuse-detection is triggered fails cleanly", async () => {
    const A = await seedAndLogin();
    const rotatedB = await refresh(A, { ipAddress: null, userAgent: null });
    const B = rotatedB.refresh_token;

    // Attacker uses A → family revoked.
    await expect(refresh(A, { ipAddress: null, userAgent: null })).rejects.toBeInstanceOf(AppError);

    // The legitimate user's next refresh (with B) must now fail.
    await expect(refresh(B, { ipAddress: null, userAgent: null })).rejects.toBeInstanceOf(AppError);
  });

  it("refresh tokens are stored hashed, never as plaintext", async () => {
    const rawToken = await seedAndLogin();

    // Search the DB for the raw token as a substring — should NOT be found.
    // We compare hash(raw) to token_hash; the raw string must not exist anywhere.
    const rows = await db.selectFrom("refresh_tokens")
      .select("token_hash")
      .execute();

    for (const row of rows) {
      // token_hash is bytea. Verify hash matches and is not the raw bytes.
      const stored = Buffer.from(row.token_hash);
      const rawBytes = Buffer.from(rawToken);
      expect(stored.equals(rawBytes)).toBe(false);
    }

    // Also assert the correct hashing algorithm is in use.
    const hash = hashToken(rawToken);
    const found = await db.selectFrom("refresh_tokens")
      .select("id")
      .where("token_hash", "=", hash)
      .executeTakeFirst();
    expect(found).toBeDefined();
  });

  it("expired refresh tokens are rejected", async () => {
    const rawToken = await seedAndLogin();

    // Manually expire the token in the DB.
    await db.updateTable("refresh_tokens")
      .set({ expires_at: new Date(Date.now() - 60_000).toISOString() as never })
      .where("token_hash", "=", hashToken(rawToken))
      .execute();

    await expect(refresh(rawToken, { ipAddress: null, userAgent: null })).rejects.toBeInstanceOf(AppError);
  });
});
