/**
 * A01 + A03: Delivery endpoint authorization, injection resistance, and
 * input validation.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { buildApp } from "../../src/api.js";
import { login, signupOwnerAndBusiness } from "../../src/modules/auth/service.js";
import { withNoTenant } from "../../src/lib/db.js";
import { signAccessToken } from "../../src/lib/jwt.js";
import { ensureMigrated, teardown, truncateAll } from "../helpers/harness.js";

const PW = "correct-horse-battery-staple";

interface Ctx {
  ownerToken: string;
  businessId: number;
  userId: number;
  branchId: number;
  variantId: number;
  orderId: number;
  driverId: number;
  driverUserId: number;
}

async function addUser(businessId: number, roleKey: string, email: string): Promise<number> {
  return withNoTenant(async (trx) => {
    await sql`SET LOCAL app.business_id = ${sql.lit(businessId)}`.execute(trx);
    const user = await trx
      .insertInto("users")
      .values({
        email, password_hash: "unused-in-tests", full_name: email.split("@")[0]!, preferred_locale: "en",
      } as never)
      .returning("id")
      .executeTakeFirstOrThrow();
    const role = await trx
      .selectFrom("roles").select("id")
      .where("business_id", "=", businessId).where("key", "=", roleKey)
      .executeTakeFirstOrThrow();
    await trx.insertInto("memberships").values({
      user_id: user.id, business_id: businessId, role_id: role.id,
      branch_ids: [], is_active: true, accepted_at: sql`now()` as never,
    } as never).execute();
    return Number(user.id);
  });
}

async function setup(app: FastifyInstance): Promise<Ctx> {
  const signup = await signupOwnerAndBusiness(
    {
      business: { name: { en: "AuthZ Delivery", ar: "توصيل" } },
      owner: { email: "owner@example.com", full_name: "Owner", password: PW },
      branch: { name: { en: "Main", ar: "الرئيسية" }, code: "DZ1", address: { en: "x", ar: "س" } },
    },
    { ipAddress: null, userAgent: null },
  );
  const session = await login({ email: "owner@example.com", password: PW }, { ipAddress: null, userAgent: null });
  const token = session.access_token;

  await app.inject({
    method: "POST", url: "/services", headers: { authorization: `Bearer ${token}` },
    payload: {
      name: { en: "Shirt", ar: "قميص" }, category: "shirt", service_type: "wash", sort_order: 0,
      variants: [{ size: null, unit_price: 10, express_multiplier: 1.5 }],
    },
  });
  const catalogue = await app.inject({ method: "GET", url: "/services", headers: { authorization: `Bearer ${token}` } });
  const variantId = catalogue.json().services[0].variants[0].id;

  const order = await app.inject({
    method: "POST", url: "/orders", headers: { authorization: `Bearer ${token}` },
    payload: {
      intake_branch_id: 1,
      walk_in: { name: { en: "Cust", ar: "" }, phone: "0501234567" },
      lines: [{ service_variant_id: variantId, qty: 1 }],
    },
  });

  const driverUserId = await addUser(signup.business.id, "driver", "driver@example.com");
  const driverRes = await app.inject({
    method: "POST", url: "/delivery/drivers", headers: { authorization: `Bearer ${token}` },
    payload: { user_id: driverUserId, vehicle_type: "van", plate_number: "AJM 99", notes: null },
  });

  return {
    ownerToken: token,
    businessId: signup.business.id,
    userId: signup.user.id,
    branchId: 1,
    variantId,
    orderId: order.json().order.id,
    driverId: driverRes.json().driver.id,
    driverUserId,
  };
}

function tokenWithPerms(ctx: Ctx, perms: string[], role = "cashier"): string {
  return signAccessToken({
    sub: String(ctx.userId), biz: String(ctx.businessId), role,
    branches: [], perms, sess: "test-session", email: "owner@example.com",
  });
}

describe("A01: delivery requires authentication and permission", () => {
  let app: FastifyInstance;
  let ctx: Ctx;

  beforeAll(async () => { await ensureMigrated(); app = await buildApp(); });
  beforeEach(async () => { await truncateAll(); ctx = await setup(app); });
  afterAll(async () => { await app.close(); await teardown(); });

  const endpoints: Array<[string, string, unknown?]> = [
    ["GET", "/delivery/drivers"],
    ["POST", "/delivery/drivers", { user_id: 1 }],
    ["GET", "/delivery/drivers/1"],
    ["PATCH", "/delivery/drivers/1", { notes: "x" }],
    ["POST", "/delivery/drivers/1/status", { status: "offline" }],
    ["DELETE", "/delivery/drivers/1"],
    ["POST", "/delivery/drivers/1/restore"],
    ["GET", "/delivery/drivers/1/jobs"],
    ["POST", "/delivery/jobs", { order_id: 1, job_type: "delivery", address: { en: "x", ar: "" } }],
    ["GET", "/delivery/branches/1/jobs"],
    ["GET", "/delivery/orders/1/jobs"],
    ["GET", "/delivery/jobs/1"],
    ["PATCH", "/delivery/jobs/1", { address: { en: "x", ar: "" } }],
    ["POST", "/delivery/jobs/1/assign", { driver_id: 1 }],
    ["POST", "/delivery/jobs/1/status", { to: "en_route" }],
    ["POST", "/delivery/jobs/1/complete", {}],
    ["POST", "/delivery/jobs/1/fail", { reason: "x" }],
    ["POST", "/delivery/jobs/1/cancel", { reason: "x" }],
    ["DELETE", "/delivery/jobs/1"],
    ["POST", "/delivery/jobs/1/restore"],
    ["GET", "/delivery/jobs/1/history"],
  ];

  it.each(endpoints)("%s %s returns 401 without a token", async (method, url, payload) => {
    const res = await app.inject({ method: method as never, url, payload: payload as never });
    expect(res.statusCode).toBe(401);
  });

  it("delivery.read alone cannot create a driver, create a job, or mutate anything", async () => {
    const readOnly = tokenWithPerms(ctx, ["delivery.read"]);
    const cases: Array<[string, string, unknown?]> = [
      ["POST", "/delivery/drivers", { user_id: ctx.driverUserId }],
      ["POST", "/delivery/jobs", { order_id: ctx.orderId, job_type: "delivery", address: { en: "x", ar: "" } }],
      ["POST", `/delivery/jobs/1/assign`, { driver_id: ctx.driverId }],
      ["DELETE", `/delivery/drivers/${ctx.driverId}`],
    ];
    for (const [method, url, payload] of cases) {
      const res = await app.inject({
        method: method as never, url,
        headers: { authorization: `Bearer ${readOnly}` }, payload: payload as never,
      });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it("permission granularity: delivery.dispatch alone cannot assign a driver (needs delivery.assign_driver specifically)", async () => {
    const dispatchOnly = tokenWithPerms(ctx, ["delivery.read", "delivery.dispatch"], "manager");
    const job = await app.inject({
      method: "POST", url: "/delivery/jobs", headers: { authorization: `Bearer ${dispatchOnly}` },
      payload: { order_id: ctx.orderId, job_type: "delivery", address: { en: "x", ar: "" } },
    });
    const res = await app.inject({
      method: "POST", url: `/delivery/jobs/${job.json().job.id}/assign`,
      headers: { authorization: `Bearer ${dispatchOnly}` },
      payload: { driver_id: ctx.driverId },
    });
    expect(res.statusCode).toBe(403);
  });

  it("permission granularity: delivery.execute alone cannot complete or fail a job (needs delivery.complete / delivery.fail specifically)", async () => {
    const executeOnly = tokenWithPerms(ctx, ["delivery.read", "delivery.execute"], "employee");
    const complete = await app.inject({
      method: "POST", url: `/delivery/jobs/1/complete`,
      headers: { authorization: `Bearer ${executeOnly}` }, payload: {},
    });
    expect(complete.statusCode).toBe(403);
    const fail = await app.inject({
      method: "POST", url: `/delivery/jobs/1/fail`,
      headers: { authorization: `Bearer ${executeOnly}` }, payload: { reason: "x" },
    });
    expect(fail.statusCode).toBe(403);
  });

  it("client-supplied permission headers are ignored", async () => {
    const weak = tokenWithPerms(ctx, ["orders.read"]);
    const res = await app.inject({
      method: "DELETE", url: `/delivery/drivers/${ctx.driverId}`,
      headers: {
        authorization: `Bearer ${weak}`,
        "x-permissions": "delivery.dispatch",
        "x-role": "owner",
      },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("A03: input validation", () => {
  let app: FastifyInstance;
  let ctx: Ctx;

  beforeAll(async () => { await ensureMigrated(); app = await buildApp(); });
  beforeEach(async () => { await truncateAll(); ctx = await setup(app); });
  afterAll(async () => { await app.close(); await teardown(); });

  it("rejects an invalid vehicle_type", async () => {
    const newDriverUserId = await addUser(ctx.businessId, "driver", "d2@example.com");
    const res = await app.inject({
      method: "POST", url: "/delivery/drivers", headers: { authorization: `Bearer ${ctx.ownerToken}` },
      payload: { user_id: newDriverUserId, vehicle_type: "spaceship" },
    });
    expect(res.statusCode).toBe(422);
  });

  it("rejects a second driver profile for the same user in the same business", async () => {
    const res = await app.inject({
      method: "POST", url: "/delivery/drivers", headers: { authorization: `Bearer ${ctx.ownerToken}` },
      payload: { user_id: ctx.driverUserId },
    });
    expect(res.statusCode).toBe(409);
  });

  it("rejects a job with no order_id", async () => {
    const res = await app.inject({
      method: "POST", url: "/delivery/jobs", headers: { authorization: `Bearer ${ctx.ownerToken}` },
      payload: { job_type: "delivery", address: { en: "x", ar: "" } },
    });
    expect(res.statusCode).toBe(422);
  });

  it("rejects an invalid job_type", async () => {
    const res = await app.inject({
      method: "POST", url: "/delivery/jobs", headers: { authorization: `Bearer ${ctx.ownerToken}` },
      payload: { order_id: ctx.orderId, job_type: "teleport", address: { en: "x", ar: "" } },
    });
    expect(res.statusCode).toBe(422);
  });

  it("rejects scheduled_window_start after scheduled_window_end", async () => {
    const res = await app.inject({
      method: "POST", url: "/delivery/jobs", headers: { authorization: `Bearer ${ctx.ownerToken}` },
      payload: {
        order_id: ctx.orderId, job_type: "delivery", address: { en: "x", ar: "" },
        scheduled_window_start: "2026-01-02T10:00:00Z",
        scheduled_window_end: "2026-01-01T10:00:00Z",
      },
    });
    expect(res.statusCode).toBe(422);
  });

  it("requires a reason to fail a job", async () => {
    const job = await app.inject({
      method: "POST", url: "/delivery/jobs", headers: { authorization: `Bearer ${ctx.ownerToken}` },
      payload: { order_id: ctx.orderId, job_type: "delivery", address: { en: "x", ar: "" } },
    });
    const res = await app.inject({
      method: "POST", url: `/delivery/jobs/${job.json().job.id}/fail`,
      headers: { authorization: `Bearer ${ctx.ownerToken}` }, payload: {},
    });
    expect(res.statusCode).toBe(422);
  });

  it("requires a reason to cancel a job", async () => {
    const job = await app.inject({
      method: "POST", url: "/delivery/jobs", headers: { authorization: `Bearer ${ctx.ownerToken}` },
      payload: { order_id: ctx.orderId, job_type: "delivery", address: { en: "x", ar: "" } },
    });
    const res = await app.inject({
      method: "POST", url: `/delivery/jobs/${job.json().job.id}/cancel`,
      headers: { authorization: `Bearer ${ctx.ownerToken}` }, payload: {},
    });
    expect(res.statusCode).toBe(422);
  });

  it("rejects out-of-range GPS coordinates on completion", async () => {
    const job = await app.inject({
      method: "POST", url: "/delivery/jobs", headers: { authorization: `Bearer ${ctx.ownerToken}` },
      payload: { order_id: ctx.orderId, job_type: "delivery", address: { en: "x", ar: "" } },
    });
    const res = await app.inject({
      method: "POST", url: `/delivery/jobs/${job.json().job.id}/complete`,
      headers: { authorization: `Bearer ${ctx.ownerToken}` },
      payload: { geo: { latitude: 999, longitude: 55 } },
    });
    expect(res.statusCode).toBe(422);
  });

  it("accepts a completion with no GPS at all — optional, per the final decision", async () => {
    const job = await app.inject({
      method: "POST", url: "/delivery/jobs", headers: { authorization: `Bearer ${ctx.ownerToken}` },
      payload: { order_id: ctx.orderId, job_type: "delivery", address: { en: "x", ar: "" } },
    });
    await app.inject({
      method: "POST", url: `/delivery/jobs/${job.json().job.id}/assign`,
      headers: { authorization: `Bearer ${ctx.ownerToken}` }, payload: { driver_id: ctx.driverId },
    });
    await app.inject({
      method: "POST", url: `/delivery/jobs/${job.json().job.id}/status`,
      headers: { authorization: `Bearer ${ctx.ownerToken}` }, payload: { to: "en_route" },
    });
    await app.inject({
      method: "POST", url: `/delivery/jobs/${job.json().job.id}/status`,
      headers: { authorization: `Bearer ${ctx.ownerToken}` }, payload: { to: "arrived" },
    });
    const res = await app.inject({
      method: "POST", url: `/delivery/jobs/${job.json().job.id}/complete`,
      headers: { authorization: `Bearer ${ctx.ownerToken}` }, payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().job.proof.latitude).toBeNull();
  });

  it("rejects unknown top-level fields, including an attempted business_id override", async () => {
    const res = await app.inject({
      method: "POST", url: "/delivery/jobs", headers: { authorization: `Bearer ${ctx.ownerToken}` },
      payload: {
        order_id: ctx.orderId, job_type: "delivery", address: { en: "x", ar: "" },
        business_id: 999999, branch_id: 999999,
      },
    });
    expect(res.statusCode).toBe(422);
  });

  it("rejects an empty PATCH body on a driver", async () => {
    const res = await app.inject({
      method: "PATCH", url: `/delivery/drivers/${ctx.driverId}`,
      headers: { authorization: `Bearer ${ctx.ownerToken}` }, payload: {},
    });
    expect(res.statusCode).toBe(422);
  });
});

describe("A03: injection resistance", () => {
  let app: FastifyInstance;
  let ctx: Ctx;

  beforeAll(async () => { await ensureMigrated(); app = await buildApp(); });
  beforeEach(async () => { await truncateAll(); ctx = await setup(app); });
  afterAll(async () => { await app.close(); await teardown(); });

  const sqlPayloads = [
    "' OR '1'='1",
    "'; DROP TABLE delivery_jobs; --",
    "1'; DELETE FROM drivers WHERE 1=1; --",
  ];

  it.each(sqlPayloads)("a hostile fail-reason value %s is treated as inert data", async (payload) => {
    const job = await app.inject({
      method: "POST", url: "/delivery/jobs", headers: { authorization: `Bearer ${ctx.ownerToken}` },
      payload: { order_id: ctx.orderId, job_type: "delivery", address: { en: "x", ar: "" } },
    });
    const res = await app.inject({
      method: "POST", url: `/delivery/jobs/${job.json().job.id}/fail`,
      headers: { authorization: `Bearer ${ctx.ownerToken}` }, payload: { reason: payload },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().job.fail_reason).toBe(payload);

    const check = await app.inject({ method: "GET", url: "/delivery/drivers", headers: { authorization: `Bearer ${ctx.ownerToken}` } });
    expect(check.statusCode).toBe(200);
  });

  it.each(["1 OR 1=1", "abc", "-1", "1.5"])("malformed job id %s never reaches SQL as executable", async (badId) => {
    const res = await app.inject({
      method: "GET", url: `/delivery/jobs/${encodeURIComponent(badId)}`,
      headers: { authorization: `Bearer ${ctx.ownerToken}` },
    });
    expect([400, 404, 422]).toContain(res.statusCode);
    expect(res.statusCode).not.toBe(500);
  });

  it("a hostile value in a bilingual address is stored and returned as inert JSON, not executed", async () => {
    const xss = "<script>alert(1)</script>";
    const res = await app.inject({
      method: "POST", url: "/delivery/jobs", headers: { authorization: `Bearer ${ctx.ownerToken}` },
      payload: { order_id: ctx.orderId, job_type: "delivery", address: { en: xss, ar: "" } },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().job.address.en).toBe(xss);
  });
});
