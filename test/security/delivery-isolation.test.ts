/**
 * A01: Delivery tenant isolation, branch-scope enforcement, and the
 * self-scope model — the one genuinely new authorization concept this
 * module introduces (see delivery/branch-scope.ts's header for the full
 * reasoning).
 *
 * This file also directly regression-tests the bug found during Phase 7
 * verification: `POST /delivery/drivers/:id/status` was originally gated by
 * `authorize(["delivery.execute", "delivery.dispatch"], { mode: "any" })` —
 * an option `authorize()` doesn't support (it's strictly AND-only). Since no
 * role has both permissions, only the owner could ever call it. The tests
 * below prove a manager (dispatch, no execute) and the driver themself
 * (execute, no dispatch) can BOTH call it — the exact two cases the bug
 * broke.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { buildApp } from "../../src/api.js";
import { login, signupOwnerAndBusiness } from "../../src/modules/auth/service.js";
import { withTenant, withNoTenant } from "../../src/lib/db.js";
import { signAccessToken } from "../../src/lib/jwt.js";
import { ensureMigrated, teardown, truncateAll } from "../helpers/harness.js";

const PW = "correct-horse-battery-staple";

interface Tenant {
  businessId: number;
  userId: number;
  token: string;
  homeBranchId: number;
  variantId: number;
  orderId: number;
  driverId: number;
  driverUserId: number;
}

function auth(t: { token: string }) {
  return { authorization: `Bearer ${t.token}` };
}

/** Same raw-insert technique used since Inventory/Branches for entities with no seeding endpoint. */
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

/** A second real user + membership, needed because drivers.user_id is a real FK — a signed token alone isn't enough. */
async function addUser(businessId: number, roleKey: string, email: string): Promise<number> {
  return withNoTenant(async (trx) => {
    await sql`SET LOCAL app.business_id = ${sql.lit(businessId)}`.execute(trx);
    const user = await trx
      .insertInto("users")
      .values({
        email,
        password_hash: "unused-in-tests",
        full_name: email.split("@")[0]!,
        preferred_locale: "en",
      } as never)
      .returning("id")
      .executeTakeFirstOrThrow();
    const role = await trx
      .selectFrom("roles")
      .select("id")
      .where("business_id", "=", businessId)
      .where("key", "=", roleKey)
      .executeTakeFirstOrThrow();
    await trx
      .insertInto("memberships")
      .values({
        user_id: user.id,
        business_id: businessId,
        role_id: role.id,
        branch_ids: [],
        is_active: true,
        accepted_at: sql`now()` as never,
      } as never)
      .execute();
    return Number(user.id);
  });
}

function scopedToken(t: Tenant, branchIds: number[], perms: string[], role: string, userId?: number): string {
  return signAccessToken({
    sub: String(userId ?? t.userId), biz: String(t.businessId), role,
    branches: branchIds, perms, sess: "test-session", email: "scoped@example.com",
  });
}

const MANAGER_PERMS = ["delivery.read", "delivery.dispatch", "delivery.assign_driver"];
const DRIVER_PERMS = ["delivery.read", "delivery.execute", "delivery.complete", "delivery.fail"];

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
  const token = session.access_token;

  const branchRow = await withTenant({ businessId: signup.business.id, userId: signup.user.id }, (trx) =>
    trx.selectFrom("branches").select("id").where("business_id", "=", signup.business.id).executeTakeFirstOrThrow(),
  );

  const svc = await app.inject({
    method: "POST", url: "/services", headers: { authorization: `Bearer ${token}` },
    payload: {
      name: { en: "Shirt", ar: "قميص" }, category: "shirt", service_type: "wash", sort_order: 0,
      variants: [{ size: null, unit_price: 10, express_multiplier: 1.5 }],
    },
  });
  const catalogue = await app.inject({ method: "GET", url: "/services", headers: { authorization: `Bearer ${token}` } });
  const variantId = catalogue.json().services[0].variants[0].id;
  void svc;

  const order = await app.inject({
    method: "POST", url: "/orders", headers: { authorization: `Bearer ${token}` },
    payload: {
      intake_branch_id: branchRow.id,
      walk_in: { name: { en: "Cust", ar: "" }, phone: "0501234567" },
      lines: [{ service_variant_id: variantId, qty: 1 }],
    },
  });

  const driverUserId = await addUser(signup.business.id, "driver", `${slug}-driver@example.com`);
  const driverRes = await app.inject({
    method: "POST", url: "/delivery/drivers", headers: { authorization: `Bearer ${token}` },
    payload: { user_id: driverUserId, vehicle_type: "bike", plate_number: "AJM 1", notes: null },
  });
  expect(driverRes.statusCode).toBe(201);

  return {
    businessId: signup.business.id,
    userId: signup.user.id,
    token,
    homeBranchId: branchRow.id,
    variantId,
    orderId: order.json().order.id,
    driverId: driverRes.json().driver.id,
    driverUserId,
  };
}

async function createJob(app: FastifyInstance, t: Tenant, overrides: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: "POST", url: "/delivery/jobs", headers: auth(t),
    payload: {
      order_id: t.orderId, job_type: "delivery",
      address: { en: "123 Main St", ar: "" },
      ...overrides,
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json().job;
}

/* ---------------------------------------------------------------------- */

describe("A01: delivery tenant isolation (database layer)", () => {
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

  it("tenant A's driver list contains only A's drivers", async () => {
    const res = await app.inject({ method: "GET", url: "/delivery/drivers", headers: auth(alpha) });
    const ids = res.json().data.map((d: { id: number }) => d.id);
    expect(ids).toContain(alpha.driverId);
    expect(ids).not.toContain(beta.driverId);
  });

  it("tenant A cannot read tenant B's driver by primary key", async () => {
    const res = await app.inject({ method: "GET", url: `/delivery/drivers/${beta.driverId}`, headers: auth(alpha) });
    expect(res.statusCode).toBe(404);
  });

  it("tenant A cannot create a delivery job against tenant B's order", async () => {
    const res = await app.inject({
      method: "POST", url: "/delivery/jobs", headers: auth(alpha),
      payload: { order_id: beta.orderId, job_type: "delivery", address: { en: "x", ar: "" } },
    });
    // B's order is invisible from A's RLS-scoped transaction.
    expect(res.statusCode).toBe(404);
  });

  it("INSERT of a driver with another tenant's business_id is rejected by RLS", async () => {
    await expect(
      withTenant({ businessId: alpha.businessId, userId: alpha.userId }, (trx) =>
        trx.insertInto("drivers").values({
          business_id: beta.businessId,
          user_id: alpha.driverUserId,
        } as never).execute(),
      ),
    ).rejects.toThrow();
  });
});

/* ---------------------------------------------------------------------- */

describe("A01: IDOR resistance (HTTP layer)", () => {
  let app: FastifyInstance;
  let alpha: Tenant;
  let beta: Tenant;
  let betaJob: { id: number };

  beforeAll(async () => { await ensureMigrated(); app = await buildApp(); });
  beforeEach(async () => {
    await truncateAll();
    alpha = await seedTenant(app, "alpha");
    beta = await seedTenant(app, "beta");
    betaJob = await createJob(app, beta);
  });
  afterAll(async () => { await app.close(); await teardown(); });

  it("GET another tenant's job returns 404, never 403", async () => {
    const res = await app.inject({ method: "GET", url: `/delivery/jobs/${betaJob.id}`, headers: auth(alpha) });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("not-found");
  });

  it("assigning a driver to another tenant's job returns 404", async () => {
    const res = await app.inject({
      method: "POST", url: `/delivery/jobs/${betaJob.id}/assign`, headers: auth(alpha),
      payload: { driver_id: alpha.driverId },
    });
    expect(res.statusCode).toBe(404);
  });

  it("listing jobs for another tenant's branch returns 404 (branch itself invisible)", async () => {
    const res = await app.inject({
      method: "GET", url: `/delivery/branches/${beta.homeBranchId}/jobs`, headers: auth(alpha),
    });
    expect(res.statusCode).toBe(404);
  });
});

/* ---------------------------------------------------------------------- */

describe("A01: branch scope — jobs require target-branch scope for reads AND writes (Inventory model)", () => {
  let app: FastifyInstance;
  let tenant: Tenant;
  let secondBranchId: number;
  let jobAtSecondBranch: { id: number };

  beforeAll(async () => { await ensureMigrated(); app = await buildApp(); });
  beforeEach(async () => {
    await truncateAll();
    tenant = await seedTenant(app, "scope");
    secondBranchId = await addBranch(tenant.businessId, "SECOND");

    // A second order whose collection branch is the second branch, so the
    // resulting job's derived branch_id is secondBranchId.
    const order2 = await app.inject({
      method: "POST", url: "/orders", headers: auth(tenant),
      payload: {
        intake_branch_id: tenant.homeBranchId,
        collection_branch_id: secondBranchId,
        walk_in: { name: { en: "Cust2", ar: "" }, phone: "0509876543" },
        lines: [{ service_variant_id: tenant.variantId, qty: 1 }],
      },
    });
    jobAtSecondBranch = await createJob(app, tenant, { order_id: order2.json().order.id });
  });
  afterAll(async () => { await app.close(); await teardown(); });

  it("a caller scoped only to the home branch cannot READ a job derived to the second branch", async () => {
    const scoped = scopedToken(tenant, [tenant.homeBranchId], MANAGER_PERMS, "manager");
    const res = await app.inject({
      method: "GET", url: `/delivery/jobs/${jobAtSecondBranch.id}`,
      headers: { authorization: `Bearer ${scoped}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it("a caller scoped only to the home branch cannot create a job that derives to the second branch", async () => {
    const order3 = await app.inject({
      method: "POST", url: "/orders", headers: auth(tenant),
      payload: {
        intake_branch_id: tenant.homeBranchId,
        collection_branch_id: secondBranchId,
        walk_in: { name: { en: "Cust3", ar: "" }, phone: "0501112223" },
        lines: [{ service_variant_id: tenant.variantId, qty: 1 }],
      },
    });
    const scoped = scopedToken(tenant, [tenant.homeBranchId], MANAGER_PERMS, "manager");
    const res = await app.inject({
      method: "POST", url: "/delivery/jobs",
      headers: { authorization: `Bearer ${scoped}` },
      payload: { order_id: order3.json().order.id, job_type: "delivery", address: { en: "x", ar: "" } },
    });
    expect(res.statusCode).toBe(403);
  });

  it("a caller scoped to the second branch CAN read the job derived there", async () => {
    const scoped = scopedToken(tenant, [secondBranchId], MANAGER_PERMS, "manager");
    const res = await app.inject({
      method: "GET", url: `/delivery/jobs/${jobAtSecondBranch.id}`,
      headers: { authorization: `Bearer ${scoped}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it("an all-branch owner can read jobs at any branch", async () => {
    const res = await app.inject({ method: "GET", url: `/delivery/jobs/${jobAtSecondBranch.id}`, headers: auth(tenant) });
    expect(res.statusCode).toBe(200);
  });

  it("drivers are business-scoped — a branch-scoped manager can still list/read every driver, no branch check applies", async () => {
    const scoped = scopedToken(tenant, [tenant.homeBranchId], MANAGER_PERMS, "manager");
    const res = await app.inject({ method: "GET", url: "/delivery/drivers", headers: { authorization: `Bearer ${scoped}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.map((d: { id: number }) => d.id)).toContain(tenant.driverId);
  });
});

/* ---------------------------------------------------------------------- */

describe("A01: self-scope — the new authorization axis this module adds", () => {
  let app: FastifyInstance;
  let tenant: Tenant;
  let job: { id: number };
  let secondBranchId: number;

  beforeAll(async () => { await ensureMigrated(); app = await buildApp(); });
  beforeEach(async () => {
    await truncateAll();
    tenant = await seedTenant(app, "self");
    secondBranchId = await addBranch(tenant.businessId, "OTHER");
    job = await createJob(app, tenant);
    await app.inject({
      method: "POST", url: `/delivery/jobs/${job.id}/assign`, headers: auth(tenant),
      payload: { driver_id: tenant.driverId },
    });
  });
  afterAll(async () => { await app.close(); await teardown(); });

  it("the assigned driver can act on their own job even with EMPTY branch_ids", async () => {
    const driverToken = scopedToken(tenant, [], DRIVER_PERMS, "driver", tenant.driverUserId);
    const res = await app.inject({
      method: "POST", url: `/delivery/jobs/${job.id}/status`,
      headers: { authorization: `Bearer ${driverToken}` },
      payload: { to: "en_route" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("a DIFFERENT driver (not assigned to this job) cannot act on it, even within the right branch", async () => {
    const otherDriverUserId = await addUser(tenant.businessId, "driver", "other-driver@example.com");
    const otherDriverToken = scopedToken(tenant, [tenant.homeBranchId], DRIVER_PERMS, "driver", otherDriverUserId);
    const res = await app.inject({
      method: "POST", url: `/delivery/jobs/${job.id}/status`,
      headers: { authorization: `Bearer ${otherDriverToken}` },
      payload: { to: "en_route" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("a dispatcher with branch scope (not the assigned driver) can still act on the job via the branch path", async () => {
    const managerToken = scopedToken(tenant, [tenant.homeBranchId], MANAGER_PERMS.concat("delivery.execute"), "manager");
    const res = await app.inject({
      method: "POST", url: `/delivery/jobs/${job.id}/status`,
      headers: { authorization: `Bearer ${managerToken}` },
      payload: { to: "en_route" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("the assigned driver scoped to an UNRELATED branch cannot act via the branch path, but self-scope still lets them through", async () => {
    const driverToken = scopedToken(tenant, [secondBranchId], DRIVER_PERMS, "driver", tenant.driverUserId);
    const res = await app.inject({
      method: "POST", url: `/delivery/jobs/${job.id}/status`,
      headers: { authorization: `Bearer ${driverToken}` },
      payload: { to: "en_route" },
    });
    // Self-scope is independent of branch scope entirely.
    expect(res.statusCode).toBe(200);
  });
});

/* ---------------------------------------------------------------------- */

describe("A01 regression: the driver-status endpoint bug (authorize() AND-only, no OR support)", () => {
  let app: FastifyInstance;
  let tenant: Tenant;

  beforeAll(async () => { await ensureMigrated(); app = await buildApp(); });
  beforeEach(async () => { await truncateAll(); tenant = await seedTenant(app, "statusbug"); });
  afterAll(async () => { await app.close(); await teardown(); });

  it("a MANAGER (has delivery.dispatch, NOT delivery.execute) can set a driver's status", async () => {
    const managerToken = scopedToken(tenant, [], MANAGER_PERMS, "manager");
    const res = await app.inject({
      method: "POST", url: `/delivery/drivers/${tenant.driverId}/status`,
      headers: { authorization: `Bearer ${managerToken}` },
      payload: { status: "offline" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("the DRIVER THEMSELF (has delivery.execute, NOT delivery.dispatch) can set their OWN status", async () => {
    const driverToken = scopedToken(tenant, [], DRIVER_PERMS, "driver", tenant.driverUserId);
    const res = await app.inject({
      method: "POST", url: `/delivery/drivers/${tenant.driverId}/status`,
      headers: { authorization: `Bearer ${driverToken}` },
      payload: { status: "offline" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("a DIFFERENT driver (has delivery.execute, but is not THIS driver, and lacks dispatch) is refused", async () => {
    const otherDriverUserId = await addUser(tenant.businessId, "driver", "third-driver@example.com");
    const otherDriverToken = scopedToken(tenant, [], DRIVER_PERMS, "driver", otherDriverUserId);
    const res = await app.inject({
      method: "POST", url: `/delivery/drivers/${tenant.driverId}/status`,
      headers: { authorization: `Bearer ${otherDriverToken}` },
      payload: { status: "offline" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("a cashier (delivery.read only, not self, not dispatch) is refused", async () => {
    const cashierToken = scopedToken(tenant, [], ["delivery.read"], "cashier");
    const res = await app.inject({
      method: "POST", url: `/delivery/drivers/${tenant.driverId}/status`,
      headers: { authorization: `Bearer ${cashierToken}` },
      payload: { status: "offline" },
    });
    expect(res.statusCode).toBe(403);
  });
});
