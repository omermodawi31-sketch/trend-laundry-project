/**
 * A01 — Broken Access Control: cross-tenant isolation.
 *
 * This test seeds two businesses and verifies that a query executed inside
 * business A's tenant context cannot see business B's rows. If RLS is
 * misconfigured — a table has RLS off, or a policy is wrong — this test
 * fails immediately.
 *
 * The test also verifies the null-tenant case: a query with no
 * `app.business_id` set returns zero rows from every RLS-protected table.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { db, withTenant, withNoTenant } from "../../src/lib/db.js";
import { ensureMigrated, truncateAll, teardown } from "../helpers/harness.js";

const skip = process.env.SKIP_DB_TESTS === "1";
const _describe = skip ? describe.skip : describe;

_describe("A01 — tenant isolation via RLS", () => {
  let bizA: number;
  let bizB: number;

  beforeAll(async () => {
    await ensureMigrated();
  });

  afterAll(async () => {
    await teardown();
  });

  beforeEach(async () => {
    await truncateAll();
    // Seed two businesses directly with SQL (bypasses withNoTenant for setup).
    await withNoTenant(async (trx) => {
      const a = await trx.insertInto("businesses")
        .values({ name: { en: "Alpha", ar: "ألفا" } } as never)
        .returning(["id"]).executeTakeFirstOrThrow();
      const b = await trx.insertInto("businesses")
        .values({ name: { en: "Beta", ar: "بيتا" } } as never)
        .returning(["id"]).executeTakeFirstOrThrow();
      bizA = Number(a.id); bizB = Number(b.id);

      // Add a distinguishing role to each so we can test isolation on roles too.
      await trx.insertInto("roles").values({
        business_id: bizA, key: "alpha_only", name: { en: "AlphaOnly", ar: "" }, permissions: [],
      }).execute();
      await trx.insertInto("roles").values({
        business_id: bizB, key: "beta_only", name: { en: "BetaOnly", ar: "" }, permissions: [],
      }).execute();
    });
  });

  it("query in tenant A returns only A's rows", async () => {
    await withTenant({ businessId: bizA, userId: null }, async (trx) => {
      const rows = await trx.selectFrom("roles").select(["key"]).execute();
      const keys = rows.map((r) => r.key);
      expect(keys).toContain("alpha_only");
      expect(keys).not.toContain("beta_only");
    });
  });

  it("query in tenant B returns only B's rows", async () => {
    await withTenant({ businessId: bizB, userId: null }, async (trx) => {
      const rows = await trx.selectFrom("roles").select(["key"]).execute();
      const keys = rows.map((r) => r.key);
      expect(keys).toContain("beta_only");
      expect(keys).not.toContain("alpha_only");
    });
  });

  it("tenant A cannot even see business B's businesses row", async () => {
    await withTenant({ businessId: bizA, userId: null }, async (trx) => {
      const rows = await trx.selectFrom("businesses").selectAll().execute();
      const ids = rows.map((r) => Number(r.id));
      expect(ids).toContain(bizA);
      expect(ids).not.toContain(bizB);
    });
  });

  it("no tenant context set: RLS returns zero rows from a policied table", async () => {
    // Use a raw session (no SET LOCAL app.business_id) to hit the null case.
    // We do this by executing inside a transaction that never sets the var.
    await db.transaction().execute(async (trx) => {
      const rows = await trx.selectFrom("roles").selectAll().execute();
      expect(rows).toHaveLength(0);
    });
  });

  it("INSERT with mismatched business_id is rejected by RLS", async () => {
    // While in tenant A's context, try to insert a row claiming to belong to B.
    await expect(async () => {
      await withTenant({ businessId: bizA, userId: null }, async (trx) => {
        await trx.insertInto("roles")
          .values({ business_id: bizB, key: "sneaky", name: { en: "X", ar: "" }, permissions: [] })
          .execute();
      });
    }).rejects.toThrow();
  });
});
