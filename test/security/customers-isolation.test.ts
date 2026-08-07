/**
 * A01: Customer tenant isolation and IDOR resistance.
 *
 * This is the test the OWASP document promised would be extended whenever a
 * new business-owned table lands. `customers` and `customer_notes` are that
 * table for Phase 2.
 *
 * Two properties under test:
 *
 *   1. RLS isolation — tenant A's queries cannot return tenant B's rows,
 *      even when A supplies B's exact primary key.
 *
 *   2. IDOR resistance at the HTTP layer — fetching another tenant's
 *      customer by id returns 404, not 403. A 403 would confirm the row
 *      exists, which is an enumeration oracle.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/api.js";
import { login, signupOwnerAndBusiness } from "../../src/modules/auth/service.js";
import { withTenant } from "../../src/lib/db.js";
import * as repo from "../../src/modules/customers/repository.js";
import { ensureMigrated, teardown, truncateAll } from "../helpers/harness.js";

interface Tenant {
  businessId: number;
  userId: number;
  token: string;
  customerId: number;
}

async function makeTenant(app: FastifyInstance, slug: string): Promise<Tenant> {
  const email = `${slug}@example.com`;
  const password = "correct-horse-battery-staple";

  const signup = await signupOwnerAndBusiness(
    {
      business: { name: { en: `${slug} Laundry`, ar: `مصبغة ${slug}` } },
      owner: { email, full_name: `${slug} Owner`, password },
      branch: { name: { en: "Main", ar: "الرئيسية" }, code: `${slug.toUpperCase()}1`, address: { en: "x", ar: "س" } },
    },
    { ipAddress: null, userAgent: null },
  );

  const session = await login({ email, password }, { ipAddress: null, userAgent: null });

  // Create a customer through the API so the whole stack is exercised.
  const res = await app.inject({
    method: "POST",
    url: "/customers",
    headers: { authorization: `Bearer ${session.access_token}` },
    payload: {
      name: { en: `${slug} Customer`, ar: `عميل ${slug}` },
      phone: slug === "alpha" ? "050 111 1111" : "050 222 2222",
    },
  });
  expect(res.statusCode).toBe(201);

  return {
    businessId: signup.business.id,
    userId: signup.user.id,
    token: session.access_token,
    customerId: res.json().customer.id,
  };
}

describe("A01: customers tenant isolation (database layer)", () => {
  let app: FastifyInstance;
  let alpha: Tenant;
  let beta: Tenant;

  beforeAll(async () => {
    await ensureMigrated();
    app = await buildApp();
  });
  beforeEach(async () => {
    await truncateAll();
    alpha = await makeTenant(app, "alpha");
    beta = await makeTenant(app, "beta");
  });
  afterAll(async () => {
    await app.close();
    await teardown();
  });

  it("tenant A listing customers sees only its own", async () => {
    const rows = await withTenant({ businessId: alpha.businessId, userId: alpha.userId }, (trx) =>
      repo.list(trx, alpha.businessId, {}, { limit: 100, sort: "created_at", direction: "desc" }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(alpha.customerId);
  });

  it("tenant A cannot read tenant B's customer by primary key", async () => {
    const row = await withTenant({ businessId: alpha.businessId, userId: alpha.userId }, (trx) =>
      repo.findById(trx, beta.customerId),
    );
    // RLS filters it out entirely — indistinguishable from "does not exist".
    expect(row).toBeUndefined();
  });

  it("tenant A cannot UPDATE tenant B's customer", async () => {
    const updated = await withTenant({ businessId: alpha.businessId, userId: alpha.userId }, (trx) =>
      repo.update(trx, beta.customerId, { vip: true, updated_by_user_id: alpha.userId }),
    );
    expect(updated).toBeUndefined();

    // Verify B's row is untouched.
    const bRow = await withTenant({ businessId: beta.businessId, userId: beta.userId }, (trx) =>
      repo.findById(trx, beta.customerId),
    );
    expect(bRow!.vip).toBe(false);
  });

  it("tenant A cannot soft-delete tenant B's customer", async () => {
    const deleted = await withTenant({ businessId: alpha.businessId, userId: alpha.userId }, (trx) =>
      repo.softDelete(trx, beta.customerId, alpha.userId),
    );
    expect(deleted).toBeUndefined();

    const bRow = await withTenant({ businessId: beta.businessId, userId: beta.userId }, (trx) =>
      repo.findById(trx, beta.customerId),
    );
    expect(bRow).toBeDefined();
    expect(bRow!.deleted_at).toBeNull();
  });

  it("INSERT with another tenant's business_id is rejected by the RLS WITH CHECK clause", async () => {
    await expect(
      withTenant({ businessId: alpha.businessId, userId: alpha.userId }, (trx) =>
        repo.insert(trx, {
          business_id: beta.businessId,          // hostile value
          name: { en: "Injected", ar: "مدسوس" },
          phone: "+971509999999",
          since: "2026-01-01",
          created_by_user_id: alpha.userId,
        }),
      ),
    ).rejects.toThrow();
  });

  it("tenant-wide statistics count only the caller's customers", async () => {
    const statsA = await withTenant({ businessId: alpha.businessId, userId: alpha.userId }, (trx) =>
      repo.businessStatistics(trx, alpha.businessId),
    );
    expect(statsA.total).toBe(1);
  });
});

describe("A01: IDOR resistance (HTTP layer)", () => {
  let app: FastifyInstance;
  let alpha: Tenant;
  let beta: Tenant;

  beforeAll(async () => {
    await ensureMigrated();
    app = await buildApp();
  });
  beforeEach(async () => {
    await truncateAll();
    alpha = await makeTenant(app, "alpha");
    beta = await makeTenant(app, "beta");
  });
  afterAll(async () => {
    await app.close();
    await teardown();
  });

  it("GET another tenant's customer returns 404, never 403", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/customers/${beta.customerId}`,
      headers: { authorization: `Bearer ${alpha.token}` },
    });
    // 404 not 403: a 403 would confirm the row exists.
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("not-found");
  });

  it("PATCH another tenant's customer returns 404", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/customers/${beta.customerId}`,
      headers: { authorization: `Bearer ${alpha.token}` },
      payload: { vip: true },
    });
    expect(res.statusCode).toBe(404);
  });

  it("DELETE another tenant's customer returns 404", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/customers/${beta.customerId}`,
      headers: { authorization: `Bearer ${alpha.token}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it("activity history for another tenant's customer returns 404", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/customers/${beta.customerId}/activity`,
      headers: { authorization: `Bearer ${alpha.token}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it("notes of another tenant's customer return 404", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/customers/${beta.customerId}/notes`,
      headers: { authorization: `Bearer ${alpha.token}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it("a note cannot be deleted by pairing it with a customer id the caller can see", async () => {
    // Beta adds a note to its own customer.
    const noteRes = await app.inject({
      method: "POST",
      url: `/customers/${beta.customerId}/notes`,
      headers: { authorization: `Bearer ${beta.token}` },
      payload: { body: "Beta private note" },
    });
    expect(noteRes.statusCode).toBe(201);
    const betaNoteId = noteRes.json().note.id;

    // Alpha tries to delete it via its OWN customer id — the note id belongs
    // to another tenant, so the pairing check must reject.
    const res = await app.inject({
      method: "DELETE",
      url: `/customers/${alpha.customerId}/notes/${betaNoteId}`,
      headers: { authorization: `Bearer ${alpha.token}` },
    });
    expect(res.statusCode).toBe(404);

    // Note survives.
    const check = await app.inject({
      method: "GET",
      url: `/customers/${beta.customerId}/notes`,
      headers: { authorization: `Bearer ${beta.token}` },
    });
    expect(check.json().notes).toHaveLength(1);
  });

  it("listing never includes another tenant's rows regardless of filters", async () => {
    for (const url of [
      "/customers",
      "/customers?q=Customer",
      "/customers?deleted=include",
      "/customers?limit=100",
      "/customers?sort=name&direction=asc",
    ]) {
      const res = await app.inject({
        method: "GET",
        url,
        headers: { authorization: `Bearer ${alpha.token}` },
      });
      expect(res.statusCode).toBe(200);
      const ids = res.json().data.map((c: { id: number }) => c.id);
      expect(ids).not.toContain(beta.customerId);
    }
  });
});
