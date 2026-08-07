/**
 * A07: Brute-force lockout regression test.
 *
 * OWASP-COMPLIANCE.md §A07 promises: after 5 failed login attempts within
 * 15 minutes, the account is locked. Subsequent attempts return 401
 * regardless of password correctness, and `locked_until` is set.
 *
 * This test is what turns that promise from 🟡 to ✅.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../../src/lib/db.js";
import { login, signupOwnerAndBusiness } from "../../src/modules/auth/service.ts";
import { AppError } from "../../src/lib/errors.js";
import { ensureMigrated, teardown, truncateAll } from "../helpers/harness.js";

const OWNER_EMAIL = "brute@example.com";
const REAL_PASSWORD = "correct-horse-battery-staple";
const WRONG_PASSWORD = "wrong-password-attempt";

async function seed(): Promise<void> {
  await signupOwnerAndBusiness({
    business: { name: { en: "Brute Test Laundry", ar: "مصبغة" } },
    owner: { email: OWNER_EMAIL, full_name: "Brute Owner", password: REAL_PASSWORD },
    branch: { name: { en: "Main", ar: "الرئيسية" }, code: "MAIN", address: { en: "x", ar: "س" } },
  }, { ipAddress: null, userAgent: null });
}

async function attemptLogin(pw: string): Promise<{ ok: boolean; err?: string }> {
  try {
    await login({ email: OWNER_EMAIL, password: pw }, { ipAddress: null, userAgent: null });
    return { ok: true };
  } catch (e) {
    return { ok: false, err: e instanceof AppError ? e.code : "unknown" };
  }
}

describe("A07: brute-force lockout", () => {
  beforeAll(async () => { await ensureMigrated(); });
  beforeEach(async () => { await truncateAll(); await seed(); });
  afterAll(async () => { await teardown(); });

  it("locks the account after 5 consecutive failures and rejects the 6th even with correct password", async () => {
    // Attempts 1–5: wrong password.
    for (let i = 0; i < 5; i++) {
      const r = await attemptLogin(WRONG_PASSWORD);
      expect(r.ok).toBe(false);
      expect(r.err).toBe("invalid-credentials");
    }

    // Verify the DB now shows the account locked.
    const row = await db.selectFrom("users")
      .select(["failed_login_count", "locked_until"])
      .where("email", "=", OWNER_EMAIL)
      .executeTakeFirstOrThrow();

    expect(row.failed_login_count).toBeGreaterThanOrEqual(5);
    expect(row.locked_until).not.toBeNull();
    expect(new Date(row.locked_until!).getTime()).toBeGreaterThan(Date.now());

    // Attempt 6: even the CORRECT password is refused while locked.
    const correct = await attemptLogin(REAL_PASSWORD);
    expect(correct.ok).toBe(false);
    // We surface the lockout as invalid-credentials to avoid revealing lock state.
    // If the code exposes `account-locked` that's also acceptable — either is a 401.
    expect(["invalid-credentials", "account-locked"]).toContain(correct.err);
  });

  it("a successful login resets the failed counter", async () => {
    // Two failures, then a success, then the counter should be zero.
    await attemptLogin(WRONG_PASSWORD);
    await attemptLogin(WRONG_PASSWORD);

    const before = await db.selectFrom("users")
      .select(["failed_login_count"])
      .where("email", "=", OWNER_EMAIL)
      .executeTakeFirstOrThrow();
    expect(before.failed_login_count).toBe(2);

    const ok = await attemptLogin(REAL_PASSWORD);
    expect(ok.ok).toBe(true);

    const after = await db.selectFrom("users")
      .select(["failed_login_count", "locked_until"])
      .where("email", "=", OWNER_EMAIL)
      .executeTakeFirstOrThrow();
    expect(after.failed_login_count).toBe(0);
    expect(after.locked_until).toBeNull();
  });

  it("unknown user returns invalid-credentials — does NOT disclose account existence", async () => {
    const r = await attemptLogin.call(null, WRONG_PASSWORD);
    // The seeded user exists; attempt with a different unknown email to verify enumeration resistance.
    const unknown = await login(
      { email: "nobody@example.com", password: WRONG_PASSWORD },
      { ipAddress: null, userAgent: null },
    ).catch((e) => (e instanceof AppError ? e.code : "unknown"));

    expect(unknown).toBe("invalid-credentials");
    // Same code as a real user with wrong password — the two cases are indistinguishable.
    expect(r.err).toBe("invalid-credentials");
  });
});
