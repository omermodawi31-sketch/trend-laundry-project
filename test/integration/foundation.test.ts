/**
 * Phase 0 smoke tests.
 *
 * Two flavours:
 *   - "unit": pure logic, no external services. Runs anywhere.
 *   - "http": through Fastify inject, no listening socket. Skipped if the
 *     database isn't reachable (health/ready needs it).
 *
 * Once Phase 1 tests land these get moved into per-module files.
 */

import { describe, expect, it } from "vitest";
import { signAccessToken, verifyAccessToken } from "../../src/lib/jwt.js";
import { hashPassword, verifyPassword } from "../../src/lib/passwords.js";
import { ALL_PERMISSIONS, SYSTEM_ROLES, isPermission } from "../../src/shared/permissions.js";

describe("permission catalogue", () => {
  it("has no duplicates", () => {
    expect(new Set(ALL_PERMISSIONS).size).toBe(ALL_PERMISSIONS.length);
  });

  it("every system role references only permissions in the catalogue", () => {
    for (const role of SYSTEM_ROLES) {
      for (const p of role.permissions) {
        expect(isPermission(p), `role=${role.key} perm=${p}`).toBe(true);
      }
    }
  });

  it("owner role has every permission", () => {
    const owner = SYSTEM_ROLES.find((r) => r.key === "owner")!;
    expect(new Set(owner.permissions).size).toBe(ALL_PERMISSIONS.length);
  });

  it("driver role cannot read customers (data-boundary check)", () => {
    const driver = SYSTEM_ROLES.find((r) => r.key === "driver")!;
    expect(driver.permissions).not.toContain("customers.read");
  });
});

describe("password hashing", () => {
  it("verifies a correct password", async () => {
    const hash = await hashPassword("hunter2-with-more-entropy");
    expect(await verifyPassword(hash, "hunter2-with-more-entropy")).toBe(true);
  });

  it("rejects the wrong password", async () => {
    const hash = await hashPassword("hunter2-with-more-entropy");
    expect(await verifyPassword(hash, "wrong")).toBe(false);
  });

  it("returns false for a null hash without throwing (user not found path)", async () => {
    expect(await verifyPassword(null, "anything")).toBe(false);
  });
});

describe("access-token signing", () => {
  it("round-trips a set of claims", () => {
    const token = signAccessToken({
      sub: "42",
      biz: "17",
      role: "manager",
      branches: [1, 2],
      perms: ["orders.read", "orders.create"],
      sess: "sess-xyz",
    });
    const claims = verifyAccessToken(token);
    expect(claims.sub).toBe("42");
    expect(claims.biz).toBe("17");
    expect(claims.role).toBe("manager");
    expect(claims.branches).toEqual([1, 2]);
    expect(claims.perms).toContain("orders.create");
  });

  it("rejects a tampered token", () => {
    const token = signAccessToken({
      sub: "42", biz: "17", role: "cashier", branches: [], perms: [], sess: "s",
    });
    // Flip a character in the payload.
    const parts = token.split(".");
    parts[1] = parts[1]!.slice(0, -2) + "AA";
    expect(() => verifyAccessToken(parts.join("."))).toThrow(/signature/i);
  });
});
