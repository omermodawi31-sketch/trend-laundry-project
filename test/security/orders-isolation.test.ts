/**
 * A01: Orders tenant isolation, branch-scope OR-logic, and IDOR resistance.
 *
 * Three properties under test, matching the approved Phase 3 architecture:
 *
 *   1. RLS tenant isolation — identical to the customers suite: tenant A
 *      cannot see, update or delete tenant B's orders at the database layer,
 *      even by exact primary key.
 *
 *   2. Branch-scope OR logic (application layer) — a caller whose membership
 *      is restricted to specific branches can read an order if ANY of its
 *      three branch columns (intake / processing / collection) is in their
 *      scope. A plant manager must see orders they are processing even
 *      though intake happened at a different shop.
 *
 *   3. Creation is narrower than reading — a caller may only CREATE an order
 *      whose intake branch is inside their own scope, even if they can READ
 *      orders touching other branches via processing/collection.
 *
 * Since no Branches CRUD endpoint exists yet (v1 businesses get exactly one
 * branch from signup — see PHASE-3-REPORT.md), multi-branch scenarios in
 * this suite seed a second branch directly through the database. This is a
 * documented, deliberate gap, not an oversight.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { buildApp } from "../../src/api.js";
import { login, signupOwnerAndBusiness } from "../../src/modules/auth/service.js";
import { withTenant, withNoTenant } from "../../src/lib/db.js";
import { signAccessToken } from "../../src/lib/jwt.js";
import * as repo from "../../src/modules/orders/repository.js";
import { ensureMigrated, teardown, truncateAll } from "../helpers/harness.js";

const PW = "correct-horse-battery-staple";

interface Tenant {
  businessId: number;
  userId: number;
  token: string;
  branchId: number;
  serviceVariantId: number;
  orderId: number;
}

function auth(t: { token: string }) {
  return { authorization: `Bearer ${t.token}` };
}

async function seedTenant(app: FastifyInstance, slug: string, phoneSuffix: string): Promise<Tenant> {
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
  const token = session.access_token;

  const branchRow = await withTenant({ businessId: signup.business.id, userId: signup.user.id }, (trx) =>
    trx.selectFrom("branches").select("id").where("business_id", "=", signup.business.id).executeTakeFirstOrThrow(),
  );

  const svc = await app.inject({
    method: "POST", url: "/services", headers: auth({ token }),
    payload: {
      name: { en: "Shirt", ar: "قميص" }, category: "shirt", service_type: "wash", sort_order: 0,
      variants: [{ size: null, unit_price: 10, express_multiplier: 1.5 }],
    },
  });
  expect(svc.statusCode).toBe(201);
  const catalogue = await app.inject({ method: "GET", url: "/services", headers: auth({ token }) });
  const variantId = catalogue.json().services[0].variants[0].id;

  const order = await app.inject({
    method: "POST",
    url: "/orders",
    headers: auth({ token }),
    payload: {
      intake_branch_id: branchRow.id,
      walk_in: { name: { en: `${slug} Customer`, ar: "" }, phone: `05011${phoneSuffix}` },
      lines: [{ service_variant_id: variantId, qty: 2 }],
    },
  });
  expect(order.statusCode).toBe(201);

  return {
    businessId: signup.business.id,
    userId: signup.user.id,
    token,
    branchId: branchRow.id,
    serviceVariantId: variantId,
    orderId: order.json().order.id,
  };
}

/** Insert a second branch directly — no Branches endpoint exists yet. */
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

/** A token for a real owner-tenant user, but scoped to a specific branch subset. */
function scopedToken(t: Tenant, branchIds: number[], perms: string[], role = "manager"): string {
  return signAccessToken({
    sub: String(t.userId),
    biz: String(t.businessId),
    role,
    branches: branchIds,
    perms,
    sess: "test-session",
    email: "scoped@example.com",
  });
}

/* ---------------------------------------------------------------------- */

describe("A01: orders tenant isolation (database layer)", () => {
  let app: FastifyInstance;
  let alpha: Tenant;
  let beta: Tenant;

  beforeAll(async () => { await ensureMigrated(); app = await buildApp(); });
  beforeEach(async () => {
    await truncateAll();
    alpha = await seedTenant(app, "alpha", "11111");
    beta = await seedTenant(app, "beta", "22222");
  });
  afterAll(async () => { await app.close(); await teardown(); });

  it("tenant A's order list contains only A's orders", async () => {
    const rows = await withTenant({ businessId: alpha.businessId, userId: alpha.userId }, (trx) =>
      repo.list(trx, alpha.businessId, { branchIds: [] }, {}, { limit: 100, direction: "desc" }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(alpha.orderId);
  });

  it("tenant A cannot read tenant B's order by primary key", async () => {
    const row = await withTenant({ businessId: alpha.businessId, userId: alpha.userId }, (trx) =>
      repo.findById(trx, beta.orderId),
    );
    expect(row).toBeUndefined();
  });

  it("tenant A cannot see tenant B's branch when creating an order", async () => {
    // Even referencing B's branch id by number, RLS makes it invisible.
    const res = await app.inject({
      method: "POST",
      url: "/orders",
      headers: auth(alpha),
      payload: {
        intake_branch_id: beta.branchId,
        walk_in: { name: { en: "X", ar: "" }, phone: "0509999999" },
        lines: [{ service_variant_id: alpha.serviceVariantId, qty: 1 }],
      },
    });
    // Branch lookup happens inside the tenant's own transaction — B's branch
    // simply does not exist from A's point of view.
    expect(res.statusCode).toBe(404);
  });

  it("tenant A cannot record a payment against tenant B's order", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/orders/${beta.orderId}/payments`,
      headers: auth(alpha),
      payload: { amount: 5, method: "cash" },
    });
    expect(res.statusCode).toBe(404);
  });
});

/* ---------------------------------------------------------------------- */

describe("A01: branch-scope OR-logic (application layer)", () => {
  let app: FastifyInstance;
  let tenant: Tenant;
  let plantBranchId: number;
  let plantOrderId: number;

  beforeAll(async () => { await ensureMigrated(); app = await buildApp(); });
  beforeEach(async () => {
    await truncateAll();
    tenant = await seedTenant(app, "hub", "33333");
    plantBranchId = await addBranch(tenant.businessId, "PLANT");

    // Owner creates an order intaken at the shop but processed at the plant.
    const res = await app.inject({
      method: "POST",
      url: "/orders",
      headers: auth(tenant),
      payload: {
        intake_branch_id: tenant.branchId,
        processing_branch_id: plantBranchId,
        walk_in: { name: { en: "Hub Customer", ar: "" }, phone: "0501234567" },
        lines: [{ service_variant_id: tenant.serviceVariantId, qty: 1 }],
      },
    });
    expect(res.statusCode).toBe(201);
    plantOrderId = res.json().order.id;
  });
  afterAll(async () => { await app.close(); await teardown(); });

  it("a caller scoped ONLY to the plant branch can read an order whose intake was elsewhere", async () => {
    const plantManager = scopedToken(tenant, [plantBranchId], ["orders.read", "orders.status_change"]);
    const res = await app.inject({
      method: "GET",
      url: `/orders/${plantOrderId}`,
      headers: { authorization: `Bearer ${plantManager}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().order.id).toBe(plantOrderId);
  });

  it("a caller scoped ONLY to the intake branch can still read the order after it moves to the plant", async () => {
    const shopManager = scopedToken(tenant, [tenant.branchId], ["orders.read"]);
    const res = await app.inject({
      method: "GET",
      url: `/orders/${plantOrderId}`,
      headers: { authorization: `Bearer ${shopManager}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it("a caller scoped to a THIRD, unrelated branch cannot read the order", async () => {
    const unrelatedBranchId = await addBranch(tenant.businessId, "OTHER");
    const outsider = scopedToken(tenant, [unrelatedBranchId], ["orders.read"]);
    const res = await app.inject({
      method: "GET",
      url: `/orders/${plantOrderId}`,
      headers: { authorization: `Bearer ${outsider}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it("the plant manager can advance status (read scope implies mutate scope)", async () => {
    const plantManager = scopedToken(tenant, [plantBranchId], ["orders.read", "orders.status_change"]);
    const res = await app.inject({
      method: "POST",
      url: `/orders/${plantOrderId}/status`,
      headers: { authorization: `Bearer ${plantManager}` },
      payload: { to: "sorting" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("an unrelated-branch caller cannot advance status either", async () => {
    const unrelatedBranchId = await addBranch(tenant.businessId, "OTHER2");
    const outsider = scopedToken(tenant, [unrelatedBranchId], ["orders.read", "orders.status_change"]);
    const res = await app.inject({
      method: "POST",
      url: `/orders/${plantOrderId}/status`,
      headers: { authorization: `Bearer ${outsider}` },
      payload: { to: "sorting" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("listing with a branch-scoped token never returns orders entirely outside scope", async () => {
    // Create a second order confined entirely to a branch the scoped caller
    // cannot see.
    const otherBranchId = await addBranch(tenant.businessId, "ISOLATED");
    const isolatedOrder = await app.inject({
      method: "POST",
      url: "/orders",
      headers: auth(tenant),   // owner, all-branch
      payload: {
        intake_branch_id: otherBranchId,
        walk_in: { name: { en: "Isolated", ar: "" }, phone: "0507654321" },
        lines: [{ service_variant_id: tenant.serviceVariantId, qty: 1 }],
      },
    });
    expect(isolatedOrder.statusCode).toBe(201);

    const shopManager = scopedToken(tenant, [tenant.branchId], ["orders.read"]);
    const list = await app.inject({
      method: "GET", url: "/orders?limit=100",
      headers: { authorization: `Bearer ${shopManager}` },
    });
    expect(list.statusCode).toBe(200);
    const ids = list.json().data.map((o: { id: number }) => o.id);
    expect(ids).toContain(plantOrderId);         // intake at their branch
    expect(ids).not.toContain(isolatedOrder.json().order.id);
  });
});

/* ---------------------------------------------------------------------- */

describe("A01: creation is narrower than reading", () => {
  let app: FastifyInstance;
  let tenant: Tenant;
  let plantBranchId: number;

  beforeAll(async () => { await ensureMigrated(); app = await buildApp(); });
  beforeEach(async () => {
    await truncateAll();
    tenant = await seedTenant(app, "narrow", "44444");
    plantBranchId = await addBranch(tenant.businessId, "PLANT2");
  });
  afterAll(async () => { await app.close(); await teardown(); });

  it("a caller scoped to the shop CANNOT create an order intaken at the plant, even though they could read one there", async () => {
    const shopManager = scopedToken(tenant, [tenant.branchId], ["orders.read", "orders.create"]);
    const res = await app.inject({
      method: "POST",
      url: "/orders",
      headers: { authorization: `Bearer ${shopManager}` },
      payload: {
        intake_branch_id: plantBranchId,   // outside their scope
        walk_in: { name: { en: "X", ar: "" }, phone: "0501112222" },
        lines: [{ service_variant_id: tenant.serviceVariantId, qty: 1 }],
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it("a caller scoped to the shop CAN create an order intaken there even with a processing branch elsewhere", async () => {
    const shopManager = scopedToken(tenant, [tenant.branchId], ["orders.read", "orders.create"]);
    const res = await app.inject({
      method: "POST",
      url: "/orders",
      headers: { authorization: `Bearer ${shopManager}` },
      payload: {
        intake_branch_id: tenant.branchId,
        processing_branch_id: plantBranchId,
        walk_in: { name: { en: "X", ar: "" }, phone: "0501112222" },
        lines: [{ service_variant_id: tenant.serviceVariantId, qty: 1 }],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().order.branches.processing_branch_id).toBe(plantBranchId);
  });

  it("an all-branch caller (owner) can create at any branch", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/orders",
      headers: auth(tenant),
      payload: {
        intake_branch_id: plantBranchId,
        walk_in: { name: { en: "X", ar: "" }, phone: "0501112222" },
        lines: [{ service_variant_id: tenant.serviceVariantId, qty: 1 }],
      },
    });
    expect(res.statusCode).toBe(201);
  });
});
