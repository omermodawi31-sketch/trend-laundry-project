/**
 * A01: Inventory tenant isolation, branch-scope enforcement, and IDOR
 * resistance.
 *
 * The property most worth testing explicitly here is the divergence from
 * the Branches module: Branches deliberately makes branch metadata reads
 * business-wide regardless of caller scope. Inventory STOCK is exactly the
 * opposite — the brief says "each branch owns its own inventory
 * quantities", so both reads and writes of branch stock/movements require
 * the target branch to be in the caller's scope. Getting this backwards
 * (accidentally copying Branches' read model) would be a real regression
 * that these tests catch.
 *
 * Catalog CRUD has no branch dimension at all — tested explicitly too, so a
 * future change that accidentally adds a scope check there also shows up as
 * a failing test.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/api.js";
import { login, signupOwnerAndBusiness } from "../../src/modules/auth/service.js";
import { withTenant, withNoTenant } from "../../src/lib/db.js";
import { signAccessToken } from "../../src/lib/jwt.js";
import { sql } from "kysely";
import * as repo from "../../src/modules/inventory/repository.js";
import { ensureMigrated, teardown, truncateAll } from "../helpers/harness.js";

const PW = "correct-horse-battery-staple";

interface Tenant {
  businessId: number;
  userId: number;
  token: string;
  homeBranchId: number;
  itemId: number;
}

function auth(t: { token: string }) {
  return { authorization: `Bearer ${t.token}` };
}

async function addBranch(businessId: number, code: string): Promise<number> {
  return withNoTenant(async (trx) => {
    await sql`SET LOCAL app.business_id = ${sql.lit(businessId)}`.execute(trx);
    const row = await trx
      .insertInto("branches")
      .values({
        business_id: businessId,
        name: { en: code, ar: code } as never,
        code,
        address: { en: "x", ar: "س" } as never,
        is_active: true,
      } as never)
      .returning("id")
      .executeTakeFirstOrThrow();
    return Number(row.id);
  });
}

async function seedTenant(app: FastifyInstance, slug: string): Promise<Tenant> {
  const email = `${slug}@example.com`;
  const signup = await signupOwnerAndBusiness(
    {
      business: { name: { en: `${slug} Laundry`, ar: `مصبغة ${slug}` } },
      owner: { email, full_name: `${slug} Owner`, password: PW },
      branch: { name: { en: "Main", ar: "الرئيسية" }, code: `${slug.toUpperCase()}1`, address: { en: "x", ar: "س" } },
    },
    { ipAddress: null, userAgent: null },
  );
  const session = await login({ email, password: PW }, { ipAddress: null, userAgent: null });

  const branchRow = await withTenant({ businessId: signup.business.id, userId: signup.user.id }, (trx) =>
    trx.selectFrom("branches").select("id").where("business_id", "=", signup.business.id).executeTakeFirstOrThrow(),
  );

  const item = await app.inject({
    method: "POST", url: "/inventory/items",
    headers: { authorization: `Bearer ${session.access_token}` },
    payload: { name: { en: `${slug} Detergent`, ar: "" }, category: "chemical", unit: "L" },
  });
  expect(item.statusCode).toBe(201);

  return {
    businessId: signup.business.id,
    userId: signup.user.id,
    token: session.access_token,
    homeBranchId: branchRow.id,
    itemId: item.json().item.id,
  };
}

function scopedToken(t: Tenant, branchIds: number[], perms: string[], role = "manager"): string {
  return signAccessToken({
    sub: String(t.userId), biz: String(t.businessId), role,
    branches: branchIds, perms, sess: "test-session", email: "scoped@example.com",
  });
}

/* ---------------------------------------------------------------------- */

describe("A01: inventory tenant isolation (database layer)", () => {
  let app: FastifyInstance;
  let alpha: Tenant;
  let beta: Tenant;

  beforeAll(async () => { await ensureMigrated(); app = await buildApp(); });
  beforeEach(async () => {
    await truncateAll();
    alpha = await seedTenant(app, "alpha");
    beta = await seedTenant(app, "beta");
  });
  afterAll(async () => { await app.close(); await teardown(); });

  it("tenant A's catalog list contains only A's items", async () => {
    const rows = await withTenant({ businessId: alpha.businessId, userId: alpha.userId }, (trx) =>
      repo.list(trx, alpha.businessId, {}, { limit: 100, sort: "sort_order", direction: "asc" }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(alpha.itemId);
  });

  it("tenant A cannot read tenant B's item by primary key", async () => {
    const row = await withTenant({ businessId: alpha.businessId, userId: alpha.userId }, (trx) =>
      repo.findById(trx, beta.itemId),
    );
    expect(row).toBeUndefined();
  });

  it("tenant A cannot see tenant B's branch when recording a movement", async () => {
    const res = await app.inject({
      method: "POST", url: `/inventory/branches/${beta.homeBranchId}/receive`,
      headers: auth(alpha),
      payload: { item_id: alpha.itemId, quantity: 10 },
    });
    // B's branch doesn't exist from A's RLS-scoped point of view.
    expect(res.statusCode).toBe(404);
  });

  it("INSERT with another tenant's business_id is rejected by the RLS WITH CHECK clause", async () => {
    await expect(
      withTenant({ businessId: alpha.businessId, userId: alpha.userId }, (trx) =>
        repo.insert(trx, {
          business_id: beta.businessId,
          name: { en: "Injected", ar: "مدسوس" },
          category: "chemical",
          unit: "L",
          created_by_user_id: alpha.userId,
        }),
      ),
    ).rejects.toThrow();
  });

  it("a movement inserted under tenant A's session cannot reference tenant B's business_id", async () => {
    await expect(
      withTenant({ businessId: alpha.businessId, userId: alpha.userId }, (trx) =>
        repo.insertMovement(trx, {
          business_id: beta.businessId,
          branch_id: alpha.homeBranchId,
          item_id: alpha.itemId,
          movement_type: "receive",
          quantity_delta: 5,
          created_by_user_id: alpha.userId,
        }),
      ),
    ).rejects.toThrow();
  });
});

/* ---------------------------------------------------------------------- */

describe("A01: IDOR resistance (HTTP layer)", () => {
  let app: FastifyInstance;
  let alpha: Tenant;
  let beta: Tenant;

  beforeAll(async () => { await ensureMigrated(); app = await buildApp(); });
  beforeEach(async () => {
    await truncateAll();
    alpha = await seedTenant(app, "alpha");
    beta = await seedTenant(app, "beta");
  });
  afterAll(async () => { await app.close(); await teardown(); });

  it("GET another tenant's item returns 404, never 403", async () => {
    const res = await app.inject({ method: "GET", url: `/inventory/items/${beta.itemId}`, headers: auth(alpha) });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("not-found");
  });

  it("PATCH another tenant's item returns 404", async () => {
    const res = await app.inject({
      method: "PATCH", url: `/inventory/items/${beta.itemId}`, headers: auth(alpha),
      payload: { sort_order: 5 },
    });
    expect(res.statusCode).toBe(404);
  });

  it("DELETE another tenant's item returns 404", async () => {
    const res = await app.inject({ method: "DELETE", url: `/inventory/items/${beta.itemId}`, headers: auth(alpha) });
    expect(res.statusCode).toBe(404);
  });

  it("another tenant's branch stock/movements both return 404", async () => {
    const stock = await app.inject({ method: "GET", url: `/inventory/branches/${beta.homeBranchId}/stock`, headers: auth(alpha) });
    expect(stock.statusCode).toBe(404);
    const moves = await app.inject({ method: "GET", url: `/inventory/branches/${beta.homeBranchId}/movements`, headers: auth(alpha) });
    expect(moves.statusCode).toBe(404);
  });

  it("listing never includes another tenant's items", async () => {
    const res = await app.inject({ method: "GET", url: "/inventory/items", headers: auth(alpha) });
    expect(res.statusCode).toBe(200);
    const ids = res.json().data.map((i: { id: number }) => i.id);
    expect(ids).not.toContain(beta.itemId);
  });
});

/* ---------------------------------------------------------------------- */

describe("A01: branch-scope — stock reads AND writes require target-branch scope", () => {
  let app: FastifyInstance;
  let tenant: Tenant;
  let secondBranchId: number;

  beforeAll(async () => { await ensureMigrated(); app = await buildApp(); });
  beforeEach(async () => {
    await truncateAll();
    tenant = await seedTenant(app, "scope");
    secondBranchId = await addBranch(tenant.businessId, "SECOND");
  });
  afterAll(async () => { await app.close(); await teardown(); });

  it("a caller scoped only to branch A cannot READ branch B's stock — unlike Branches metadata, this is scope-restricted", async () => {
    const scoped = scopedToken(tenant, [tenant.homeBranchId], ["inventory.read"]);
    const res = await app.inject({
      method: "GET", url: `/inventory/branches/${secondBranchId}/stock`,
      headers: { authorization: `Bearer ${scoped}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("a caller scoped only to branch A cannot READ branch B's movements", async () => {
    const scoped = scopedToken(tenant, [tenant.homeBranchId], ["inventory.read"]);
    const res = await app.inject({
      method: "GET", url: `/inventory/branches/${secondBranchId}/movements`,
      headers: { authorization: `Bearer ${scoped}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("a caller scoped only to branch A CAN read branch A's stock", async () => {
    const scoped = scopedToken(tenant, [tenant.homeBranchId], ["inventory.read"]);
    const res = await app.inject({
      method: "GET", url: `/inventory/branches/${tenant.homeBranchId}/stock`,
      headers: { authorization: `Bearer ${scoped}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it("a caller scoped only to branch A cannot RECEIVE stock at branch B", async () => {
    const scoped = scopedToken(tenant, [tenant.homeBranchId], ["inventory.receive"]);
    const res = await app.inject({
      method: "POST", url: `/inventory/branches/${secondBranchId}/receive`,
      headers: { authorization: `Bearer ${scoped}` },
      payload: { item_id: tenant.itemId, quantity: 10 },
    });
    expect(res.statusCode).toBe(403);
  });

  it("a caller scoped only to branch A cannot RECORD WASTE at branch B", async () => {
    const scoped = scopedToken(tenant, [tenant.homeBranchId], ["inventory.waste_record"]);
    const res = await app.inject({
      method: "POST", url: `/inventory/branches/${secondBranchId}/waste`,
      headers: { authorization: `Bearer ${scoped}` },
      payload: { item_id: tenant.itemId, quantity: 1, reason: "damaged" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("a caller scoped to BOTH branches can operate on either", async () => {
    const scoped = scopedToken(tenant, [tenant.homeBranchId, secondBranchId], ["inventory.receive"]);
    const a = await app.inject({
      method: "POST", url: `/inventory/branches/${tenant.homeBranchId}/receive`,
      headers: { authorization: `Bearer ${scoped}` }, payload: { item_id: tenant.itemId, quantity: 5 },
    });
    const b = await app.inject({
      method: "POST", url: `/inventory/branches/${secondBranchId}/receive`,
      headers: { authorization: `Bearer ${scoped}` }, payload: { item_id: tenant.itemId, quantity: 5 },
    });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
  });

  it("an all-branch owner can operate on any branch", async () => {
    const res = await app.inject({
      method: "POST", url: `/inventory/branches/${secondBranchId}/receive`,
      headers: auth(tenant), payload: { item_id: tenant.itemId, quantity: 5 },
    });
    expect(res.statusCode).toBe(201);
  });
});

/* ---------------------------------------------------------------------- */

describe("A01: transfers require BOTH branches in scope", () => {
  let app: FastifyInstance;
  let tenant: Tenant;
  let secondBranchId: number;
  let thirdBranchId: number;

  beforeAll(async () => { await ensureMigrated(); app = await buildApp(); });
  beforeEach(async () => {
    await truncateAll();
    tenant = await seedTenant(app, "transfer");
    secondBranchId = await addBranch(tenant.businessId, "SEC");
    thirdBranchId = await addBranch(tenant.businessId, "THIRD");
    // Stock up the home branch so there's something to transfer.
    await app.inject({
      method: "POST", url: `/inventory/branches/${tenant.homeBranchId}/receive`,
      headers: auth(tenant), payload: { item_id: tenant.itemId, quantity: 50 },
    });
  });
  afterAll(async () => { await app.close(); await teardown(); });

  it("a caller scoped only to the source branch cannot transfer to an out-of-scope destination", async () => {
    const scoped = scopedToken(tenant, [tenant.homeBranchId], ["inventory.adjust"]);
    const res = await app.inject({
      method: "POST", url: "/inventory/transfer",
      headers: { authorization: `Bearer ${scoped}` },
      payload: { item_id: tenant.itemId, from_branch_id: tenant.homeBranchId, to_branch_id: secondBranchId, quantity: 5 },
    });
    expect(res.statusCode).toBe(403);
  });

  it("a caller scoped only to the destination branch cannot transfer from an out-of-scope source", async () => {
    const scoped = scopedToken(tenant, [secondBranchId], ["inventory.adjust"]);
    const res = await app.inject({
      method: "POST", url: "/inventory/transfer",
      headers: { authorization: `Bearer ${scoped}` },
      payload: { item_id: tenant.itemId, from_branch_id: tenant.homeBranchId, to_branch_id: secondBranchId, quantity: 5 },
    });
    expect(res.statusCode).toBe(403);
  });

  it("a caller scoped to both branches can transfer between them", async () => {
    const scoped = scopedToken(tenant, [tenant.homeBranchId, secondBranchId], ["inventory.adjust"]);
    const res = await app.inject({
      method: "POST", url: "/inventory/transfer",
      headers: { authorization: `Bearer ${scoped}` },
      payload: { item_id: tenant.itemId, from_branch_id: tenant.homeBranchId, to_branch_id: secondBranchId, quantity: 5 },
    });
    expect(res.statusCode).toBe(201);
  });

  it("scoped to source+destination is not enough if a THIRD, unrelated branch is used", async () => {
    const scoped = scopedToken(tenant, [tenant.homeBranchId, secondBranchId], ["inventory.adjust"]);
    const res = await app.inject({
      method: "POST", url: "/inventory/transfer",
      headers: { authorization: `Bearer ${scoped}` },
      payload: { item_id: tenant.itemId, from_branch_id: tenant.homeBranchId, to_branch_id: thirdBranchId, quantity: 5 },
    });
    expect(res.statusCode).toBe(403);
  });
});

/* ---------------------------------------------------------------------- */

describe("A01: catalog CRUD has no branch dimension (deliberate divergence, tested explicitly)", () => {
  let app: FastifyInstance;
  let tenant: Tenant;

  beforeAll(async () => { await ensureMigrated(); app = await buildApp(); });
  beforeEach(async () => { await truncateAll(); tenant = await seedTenant(app, "catalog"); });
  afterAll(async () => { await app.close(); await teardown(); });

  it("a manager scoped to a single branch CAN still create a catalog item — the catalog is business-wide, not branch-owned", async () => {
    const scoped = scopedToken(tenant, [tenant.homeBranchId], ["inventory.adjust"]);
    const res = await app.inject({
      method: "POST", url: "/inventory/items",
      headers: { authorization: `Bearer ${scoped}` },
      payload: { name: { en: "Softener", ar: "" }, category: "chemical", unit: "L" },
    });
    // Unlike branches.create (which requires all-branch access), catalog
    // creation is purely permission-gated.
    expect(res.statusCode).toBe(201);
  });

  it("a manager scoped to a single branch CAN update any catalog item", async () => {
    const scoped = scopedToken(tenant, [tenant.homeBranchId], ["inventory.adjust"]);
    const res = await app.inject({
      method: "PATCH", url: `/inventory/items/${tenant.itemId}`,
      headers: { authorization: `Bearer ${scoped}` },
      payload: { sort_order: 3 },
    });
    expect(res.statusCode).toBe(200);
  });
});
