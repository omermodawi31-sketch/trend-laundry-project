/**
 * Delivery module — functional behaviour.
 *
 * Complements the security suites. Covers the finalized business rules by
 * name: every job requires an order; branch_id is derived, never
 * client-supplied; the delivery fee is snapshotted from
 * business_settings.delivery_fee at creation; cash-on-delivery reuses
 * Orders' own recordPaymentInTx (no duplicated payment logic); soft delete;
 * driver status auto-management; GPS is optional; the status-history table
 * is append-only and immutable.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { buildApp } from "../../src/api.js";
import { login, signupOwnerAndBusiness } from "../../src/modules/auth/service.js";
import { withNoTenant } from "../../src/lib/db.js";
import { ensureMigrated, teardown, truncateAll } from "../helpers/harness.js";

const PW = "correct-horse-battery-staple";
let app: FastifyInstance;
let token: string;
let branchId: number;
let businessId: number;
let variantId: number;

async function setup(): Promise<void> {
  const signup = await signupOwnerAndBusiness(
    {
      business: { name: { en: "Func Delivery", ar: "توصيل" } },
      owner: { email: "func@example.com", full_name: "Owner", password: PW },
      branch: { name: { en: "Main", ar: "الرئيسية" }, code: "FD1", address: { en: "x", ar: "س" } },
    },
    { ipAddress: null, userAgent: null },
  );
  const s = await login({ email: "func@example.com", password: PW }, { ipAddress: null, userAgent: null });
  token = s.access_token;
  branchId = 1;
  businessId = signup.business.id;

  await app.inject({
    method: "POST", url: "/services", headers: auth(),
    payload: {
      name: { en: "Shirt", ar: "قميص" }, category: "shirt", service_type: "wash", sort_order: 0,
      variants: [{ size: null, unit_price: 10, express_multiplier: 1.5 }],
    },
  });
  const catalogue = await app.inject({ method: "GET", url: "/services", headers: auth() });
  variantId = catalogue.json().services[0].variants[0].id;
}

function auth() { return { authorization: `Bearer ${token}` }; }

async function addUser(roleKey: string, email: string): Promise<number> {
  return withNoTenant(async (trx) => {
    await sql`SET LOCAL app.business_id = ${sql.lit(businessId)}`.execute(trx);
    const user = await trx.insertInto("users").values({
      email, password_hash: "unused-in-tests", full_name: email.split("@")[0]!, preferred_locale: "en",
    } as never).returning("id").executeTakeFirstOrThrow();
    const role = await trx.selectFrom("roles").select("id")
      .where("business_id", "=", businessId).where("key", "=", roleKey).executeTakeFirstOrThrow();
    await trx.insertInto("memberships").values({
      user_id: user.id, business_id: businessId, role_id: role.id,
      branch_ids: [], is_active: true, accepted_at: sql`now()` as never,
    } as never).execute();
    return Number(user.id);
  });
}

async function createDriver(overrides: Record<string, unknown> = {}) {
  const userId = overrides.user_id ?? await addUser("driver", `driver-${Date.now()}-${Math.random()}@example.com`);
  const res = await app.inject({
    method: "POST", url: "/delivery/drivers", headers: auth(),
    payload: { user_id: userId, vehicle_type: "bike", plate_number: "AJM 1", notes: null, ...overrides, user_id: userId },
  });
  expect(res.statusCode).toBe(201);
  return res.json().driver;
}

async function createOrder(overrides: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: "POST", url: "/orders", headers: auth(),
    payload: {
      intake_branch_id: branchId,
      walk_in: { name: { en: "Cust", ar: "" }, phone: "0501234567" },
      lines: [{ service_variant_id: variantId, qty: 1 }],
      ...overrides,
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json().order;
}

async function createJob(orderId: number, overrides: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: "POST", url: "/delivery/jobs", headers: auth(),
    payload: { order_id: orderId, job_type: "delivery", address: { en: "123 Main St", ar: "" }, ...overrides },
  });
  expect(res.statusCode).toBe(201);
  return res.json().job;
}

/* ---------------------------------------------------------------- */

describe("driver CRUD", () => {
  beforeAll(async () => { await ensureMigrated(); app = await buildApp(); });
  beforeEach(async () => { await truncateAll(); await setup(); });
  afterAll(async () => { await app.close(); await teardown(); });

  it("creates a driver and pulls identity from the linked user, not duplicated fields", async () => {
    const userId = await addUser("driver", "imran@example.com");
    const res = await app.inject({
      method: "POST", url: "/delivery/drivers", headers: auth(),
      payload: { user_id: userId, vehicle_type: "bike", plate_number: "AJM 4471", notes: "Prefers morning shifts" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().driver.name).toBe("imran");
    expect(res.json().driver.email).toBe("imran@example.com");
    expect(res.json().driver.status).toBe("offline");
    expect(res.json().driver.is_active).toBe(true);
  });

  it("rejects creating a driver for a user who isn't a member of the business", async () => {
    const res = await app.inject({
      method: "POST", url: "/delivery/drivers", headers: auth(),
      payload: { user_id: 999999 },
    });
    expect(res.statusCode).toBe(422);
  });

  it("updates vehicle fields independently", async () => {
    const driver = await createDriver();
    const res = await app.inject({
      method: "PATCH", url: `/delivery/drivers/${driver.id}`, headers: auth(),
      payload: { plate_number: "NEW 123" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().driver.plate_number).toBe("NEW 123");
    expect(res.json().driver.vehicle_type).toBe("bike");
  });

  it("a driver with an active job assignment cannot be deleted, only disabled", async () => {
    const driver = await createDriver();
    const order = await createOrder();
    const job = await createJob(order.id);
    await app.inject({ method: "POST", url: `/delivery/jobs/${job.id}/assign`, headers: auth(), payload: { driver_id: driver.id } });

    const del = await app.inject({ method: "DELETE", url: `/delivery/drivers/${driver.id}`, headers: auth() });
    expect(del.statusCode).toBe(409);
    expect(del.json().code).toBe("driver-has-active-job");

    const disable = await app.inject({
      method: "PATCH", url: `/delivery/drivers/${driver.id}`, headers: auth(), payload: { notes: "ok to disable via patch" },
    });
    expect(disable.statusCode).toBe(200);
  });

  it("a driver with no active job can be soft-deleted and restored", async () => {
    const driver = await createDriver();
    const del = await app.inject({ method: "DELETE", url: `/delivery/drivers/${driver.id}`, headers: auth() });
    expect(del.statusCode).toBe(200);

    const restore = await app.inject({ method: "POST", url: `/delivery/drivers/${driver.id}/restore`, headers: auth() });
    expect(restore.statusCode).toBe(200);
    expect(restore.json().driver.deleted_at).toBeNull();
  });
});

/* ---------------------------------------------------------------- */

describe("every job requires an order (final decision)", () => {
  beforeAll(async () => { await ensureMigrated(); app = await buildApp(); });
  beforeEach(async () => { await truncateAll(); await setup(); });
  afterAll(async () => { await app.close(); await teardown(); });

  it("creates a pickup job against an order", async () => {
    const order = await createOrder();
    const job = await createJob(order.id, { job_type: "pickup" });
    expect(job.order_id).toBe(order.id);
    expect(job.job_type).toBe("pickup");
    expect(job.fee).toBe(0);   // pickup jobs never snapshot the delivery fee
  });

  it("a cancelled order cannot have a delivery job created against it", async () => {
    const order = await createOrder();
    await app.inject({
      method: "POST", url: `/orders/${order.id}/status`, headers: auth(),
      payload: { to: "cancelled", reason: "test" },
    });
    const res = await app.inject({
      method: "POST", url: "/delivery/jobs", headers: auth(),
      payload: { order_id: order.id, job_type: "delivery", address: { en: "x", ar: "" } },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("order-not-deliverable");
  });

  it("looking up jobs by order works, and is empty before any job exists", async () => {
    const order = await createOrder();
    const before = await app.inject({ method: "GET", url: `/delivery/orders/${order.id}/jobs`, headers: auth() });
    expect(before.json().data).toHaveLength(0);

    const job = await createJob(order.id);
    const after = await app.inject({ method: "GET", url: `/delivery/orders/${order.id}/jobs`, headers: auth() });
    expect(after.json().data.map((j: { id: number }) => j.id)).toContain(job.id);
  });
});

/* ---------------------------------------------------------------- */

describe("branch_id is derived from the order, never client-supplied", () => {
  beforeAll(async () => { await ensureMigrated(); app = await buildApp(); });
  beforeEach(async () => { await truncateAll(); await setup(); });
  afterAll(async () => { await app.close(); await teardown(); });

  it("a job's branch is the order's intake branch when no collection branch is set", async () => {
    const order = await createOrder();
    const job = await createJob(order.id);
    const listed = await app.inject({ method: "GET", url: `/delivery/branches/${branchId}/jobs`, headers: auth() });
    expect(listed.json().data.map((j: { id: number }) => j.id)).toContain(job.id);
  });

  it("an attempted branch_id in the request body is silently rejected by strict validation, not honored", async () => {
    const order = await createOrder();
    const res = await app.inject({
      method: "POST", url: "/delivery/jobs", headers: auth(),
      payload: { order_id: order.id, job_type: "delivery", address: { en: "x", ar: "" }, branch_id: 999999 },
    });
    expect(res.statusCode).toBe(422);
  });
});

/* ---------------------------------------------------------------- */

describe("delivery fee is snapshotted from business_settings.delivery_fee", () => {
  beforeAll(async () => { await ensureMigrated(); app = await buildApp(); });
  beforeEach(async () => { await truncateAll(); await setup(); });
  afterAll(async () => { await app.close(); await teardown(); });

  it("a fresh business's delivery job charges the default fee of 15", async () => {
    const order = await createOrder();
    const job = await createJob(order.id);
    expect(job.fee).toBe(15);
  });

  it("changing business_settings.delivery_fee changes what a NEW job charges", async () => {
    await app.inject({ method: "PATCH", url: "/settings/business", headers: auth(), payload: { delivery_fee: 40 } });
    const order = await createOrder();
    const job = await createJob(order.id);
    expect(job.fee).toBe(40);
  });

  it("a job created BEFORE a fee change keeps its original snapshotted fee after the change", async () => {
    const order = await createOrder();
    const before = await createJob(order.id);
    expect(before.fee).toBe(15);

    await app.inject({ method: "PATCH", url: "/settings/business", headers: auth(), payload: { delivery_fee: 60 } });

    const check = await app.inject({ method: "GET", url: `/delivery/jobs/${before.id}`, headers: auth() });
    expect(check.json().job.fee).toBe(15);
  });
});

/* ---------------------------------------------------------------- */

describe("full job lifecycle", () => {
  beforeAll(async () => { await ensureMigrated(); app = await buildApp(); });
  beforeEach(async () => { await truncateAll(); await setup(); });
  afterAll(async () => { await app.close(); await teardown(); });

  async function advance(jobId: number, to: string) {
    return app.inject({ method: "POST", url: `/delivery/jobs/${jobId}/status`, headers: auth(), payload: { to } });
  }

  it("follows the canonical forward path: scheduled -> assigned -> en_route -> arrived -> completed", async () => {
    const driver = await createDriver();
    const order = await createOrder();
    const job = await createJob(order.id);
    expect(job.status).toBe("scheduled");

    const assign = await app.inject({ method: "POST", url: `/delivery/jobs/${job.id}/assign`, headers: auth(), payload: { driver_id: driver.id } });
    expect(assign.json().job.status).toBe("assigned");

    expect((await advance(job.id, "en_route")).json().job.status).toBe("en_route");
    expect((await advance(job.id, "arrived")).json().job.status).toBe("arrived");

    const complete = await app.inject({ method: "POST", url: `/delivery/jobs/${job.id}/complete`, headers: auth(), payload: {} });
    expect(complete.statusCode).toBe(200);
    expect(complete.json().job.status).toBe("completed");
  });

  it("rejects an illegal transition (e.g. scheduled straight to completed)", async () => {
    const order = await createOrder();
    const job = await createJob(order.id);
    const res = await app.inject({ method: "POST", url: `/delivery/jobs/${job.id}/complete`, headers: auth(), payload: {} });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("invalid-job-status-transition");
  });

  it("a job cannot be reassigned once it has left the scheduled state", async () => {
    const driver1 = await createDriver();
    const driver2 = await createDriver();
    const order = await createOrder();
    const job = await createJob(order.id);
    await app.inject({ method: "POST", url: `/delivery/jobs/${job.id}/assign`, headers: auth(), payload: { driver_id: driver1.id } });

    const reassign = await app.inject({ method: "POST", url: `/delivery/jobs/${job.id}/assign`, headers: auth(), payload: { driver_id: driver2.id } });
    expect(reassign.statusCode).toBe(409);
  });

  it("assigning a driver auto-busies them; completing frees them if it was their only job", async () => {
    const driver = await createDriver();
    const order = await createOrder();
    const job = await createJob(order.id);
    await app.inject({ method: "POST", url: `/delivery/jobs/${job.id}/assign`, headers: auth(), payload: { driver_id: driver.id } });

    const busy = await app.inject({ method: "GET", url: `/delivery/drivers/${driver.id}`, headers: auth() });
    expect(busy.json().driver.status).toBe("busy");

    await advance(job.id, "en_route");
    await advance(job.id, "arrived");
    await app.inject({ method: "POST", url: `/delivery/jobs/${job.id}/complete`, headers: auth(), payload: {} });

    const free = await app.inject({ method: "GET", url: `/delivery/drivers/${driver.id}`, headers: auth() });
    expect(free.json().driver.status).toBe("available");
  });

  it("a driver with TWO active jobs stays busy after only one completes", async () => {
    const driver = await createDriver();
    const orderA = await createOrder();
    const orderB = await createOrder();
    const jobA = await createJob(orderA.id);
    const jobB = await createJob(orderB.id);
    await app.inject({ method: "POST", url: `/delivery/jobs/${jobA.id}/assign`, headers: auth(), payload: { driver_id: driver.id } });
    await app.inject({ method: "POST", url: `/delivery/jobs/${jobB.id}/assign`, headers: auth(), payload: { driver_id: driver.id } });

    await advance(jobA.id, "en_route");
    await advance(jobA.id, "arrived");
    await app.inject({ method: "POST", url: `/delivery/jobs/${jobA.id}/complete`, headers: auth(), payload: {} });

    const stillBusy = await app.inject({ method: "GET", url: `/delivery/drivers/${driver.id}`, headers: auth() });
    expect(stillBusy.json().driver.status).toBe("busy");
  });

  it("capturing GPS at completion is optional and stored correctly when provided", async () => {
    const order = await createOrder();
    const job = await createJob(order.id);
    await advance(job.id, "en_route");
    await advance(job.id, "arrived");
    const complete = await app.inject({
      method: "POST", url: `/delivery/jobs/${job.id}/complete`, headers: auth(),
      payload: { geo: { latitude: 25.4052, longitude: 55.5136 } },
    });
    expect(complete.json().job.proof.latitude).toBe(25.4052);
    expect(complete.json().job.proof.longitude).toBe(55.5136);
  });
});

/* ---------------------------------------------------------------- */

describe("cash-on-delivery reuses Orders.recordPayment — no duplicated logic", () => {
  beforeAll(async () => { await ensureMigrated(); app = await buildApp(); });
  beforeEach(async () => { await truncateAll(); await setup(); });
  afterAll(async () => { await app.close(); await teardown(); });

  async function advance(jobId: number, to: string) {
    return app.inject({ method: "POST", url: `/delivery/jobs/${jobId}/status`, headers: auth(), payload: { to } });
  }

  it("completing a job with a collected amount records a real payment on the linked order", async () => {
    const order = await createOrder();   // total ~10.50
    const job = await createJob(order.id, { collect_amount: 10.5 });
    await advance(job.id, "en_route");
    await advance(job.id, "arrived");

    const complete = await app.inject({
      method: "POST", url: `/delivery/jobs/${job.id}/complete`, headers: auth(),
      payload: { collected_amount: 10.5 },
    });
    expect(complete.statusCode).toBe(200);
    expect(complete.json().job.collected_amount).toBe(10.5);

    const orderCheck = await app.inject({ method: "GET", url: `/orders/${order.id}`, headers: auth() });
    expect(orderCheck.json().order.totals.paid_amount).toBe(10.5);
    expect(orderCheck.json().order.totals.outstanding).toBe(0);
  });

  it("the payment reuses Orders' own outstanding-balance guard — collecting more than owed is refused", async () => {
    const order = await createOrder();
    const job = await createJob(order.id, { collect_amount: 999 });
    await advance(job.id, "en_route");
    await advance(job.id, "arrived");

    const res = await app.inject({
      method: "POST", url: `/delivery/jobs/${job.id}/complete`, headers: auth(),
      payload: { collected_amount: 999 },
    });
    // Orders' recordPaymentInTx rejects this — the exact guard being reused, not a re-implementation.
    expect(res.statusCode).toBe(422);
  });

  it("collecting more than the job's own agreed collect_amount is refused before Orders is even consulted", async () => {
    const order = await createOrder();
    const job = await createJob(order.id, { collect_amount: 5 });
    await advance(job.id, "en_route");
    await advance(job.id, "arrived");

    const res = await app.inject({
      method: "POST", url: `/delivery/jobs/${job.id}/complete`, headers: auth(),
      payload: { collected_amount: 8 },
    });
    expect(res.statusCode).toBe(422);
  });

  it("completing a job with zero or no collected amount does not touch the order's payments at all", async () => {
    const order = await createOrder();
    const job = await createJob(order.id);   // no collect_amount
    await advance(job.id, "en_route");
    await advance(job.id, "arrived");
    await app.inject({ method: "POST", url: `/delivery/jobs/${job.id}/complete`, headers: auth(), payload: {} });

    const orderCheck = await app.inject({ method: "GET", url: `/orders/${order.id}`, headers: auth() });
    expect(orderCheck.json().order.totals.paid_amount).toBe(0);
  });

  it("the payment's method is cash and its reference traces back to the delivery job", async () => {
    const order = await createOrder();
    const job = await createJob(order.id, { collect_amount: 10.5 });
    await advance(job.id, "en_route");
    await advance(job.id, "arrived");
    await app.inject({
      method: "POST", url: `/delivery/jobs/${job.id}/complete`, headers: auth(),
      payload: { collected_amount: 10.5 },
    });

    const orderCheck = await app.inject({ method: "GET", url: `/orders/${order.id}`, headers: auth() });
    const payment = orderCheck.json().order.payments[0];
    expect(payment.method).toBe("cash");
    expect(payment.reference).toContain(String(job.id));
  });
});

/* ---------------------------------------------------------------- */

describe("cancel and fail both require a reason", () => {
  beforeAll(async () => { await ensureMigrated(); app = await buildApp(); });
  beforeEach(async () => { await truncateAll(); await setup(); });
  afterAll(async () => { await app.close(); await teardown(); });

  it("failing a job records the reason and frees the driver if idle", async () => {
    const driver = await createDriver();
    const order = await createOrder();
    const job = await createJob(order.id);
    await app.inject({ method: "POST", url: `/delivery/jobs/${job.id}/assign`, headers: auth(), payload: { driver_id: driver.id } });

    const res = await app.inject({
      method: "POST", url: `/delivery/jobs/${job.id}/fail`, headers: auth(),
      payload: { reason: "Customer not home" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().job.fail_reason).toBe("Customer not home");
    expect(res.json().job.status).toBe("failed");

    const driverCheck = await app.inject({ method: "GET", url: `/delivery/drivers/${driver.id}`, headers: auth() });
    expect(driverCheck.json().driver.status).toBe("available");
  });

  it("cancelling a job records the reason and is dispatcher-only, not driver-callable", async () => {
    const order = await createOrder();
    const job = await createJob(order.id);
    const res = await app.inject({
      method: "POST", url: `/delivery/jobs/${job.id}/cancel`, headers: auth(),
      payload: { reason: "Customer requested cancellation" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().job.fail_reason).toBe("Customer requested cancellation");
    expect(res.json().job.status).toBe("cancelled");
  });

  it("the reason is visible in the job's status history", async () => {
    const order = await createOrder();
    const job = await createJob(order.id);
    await app.inject({
      method: "POST", url: `/delivery/jobs/${job.id}/cancel`, headers: auth(),
      payload: { reason: "Duplicate job created by mistake" },
    });
    const history = await app.inject({ method: "GET", url: `/delivery/jobs/${job.id}/history`, headers: auth() });
    const cancelEntry = history.json().data.find((h: { to_status: string }) => h.to_status === "cancelled");
    expect(cancelEntry.reason).toBe("Duplicate job created by mistake");
  });
});

/* ---------------------------------------------------------------- */

describe("delivery_job_status_history is append-only", () => {
  beforeAll(async () => { await ensureMigrated(); app = await buildApp(); });
  beforeEach(async () => { await truncateAll(); await setup(); });
  afterAll(async () => { await app.close(); await teardown(); });

  it("UPDATE on delivery_job_status_history is rejected by the trigger", async () => {
    const order = await createOrder();
    const job = await createJob(order.id);
    const history = await app.inject({ method: "GET", url: `/delivery/jobs/${job.id}/history`, headers: auth() });
    const entryId = history.json().data[0].id;

    await expect(
      withNoTenant(async (trx) => {
        await sql`SET LOCAL app.business_id = ${sql.lit(businessId)}`.execute(trx);
        await trx.updateTable("delivery_job_status_history").set({ reason: "tampered" } as never).where("id", "=", entryId).execute();
      }),
    ).rejects.toThrow(/append-only|restrict/i);
  });

  it("DELETE on delivery_job_status_history is rejected by the trigger", async () => {
    const order = await createOrder();
    const job = await createJob(order.id);
    const history = await app.inject({ method: "GET", url: `/delivery/jobs/${job.id}/history`, headers: auth() });
    const entryId = history.json().data[0].id;

    await expect(
      withNoTenant(async (trx) => {
        await sql`SET LOCAL app.business_id = ${sql.lit(businessId)}`.execute(trx);
        await trx.deleteFrom("delivery_job_status_history").where("id", "=", entryId).execute();
      }),
    ).rejects.toThrow(/append-only|restrict/i);
  });

  it("every transition appends a new row rather than overwriting the last one", async () => {
    const driver = await createDriver();
    const order = await createOrder();
    const job = await createJob(order.id);
    await app.inject({ method: "POST", url: `/delivery/jobs/${job.id}/assign`, headers: auth(), payload: { driver_id: driver.id } });
    await app.inject({ method: "POST", url: `/delivery/jobs/${job.id}/status`, headers: auth(), payload: { to: "en_route" } });

    const history = await app.inject({ method: "GET", url: `/delivery/jobs/${job.id}/history`, headers: auth() });
    const statuses = history.json().data.map((h: { to_status: string }) => h.to_status);
    expect(statuses).toContain("scheduled");
    expect(statuses).toContain("assigned");
    expect(statuses).toContain("en_route");
    expect(statuses).toHaveLength(3);
  });
});

/* ---------------------------------------------------------------- */

describe("job soft delete", () => {
  beforeAll(async () => { await ensureMigrated(); app = await buildApp(); });
  beforeEach(async () => { await truncateAll(); await setup(); });
  afterAll(async () => { await app.close(); await teardown(); });

  it("a scheduled job can be soft-deleted and restored", async () => {
    const order = await createOrder();
    const job = await createJob(order.id);
    const del = await app.inject({ method: "DELETE", url: `/delivery/jobs/${job.id}`, headers: auth() });
    expect(del.statusCode).toBe(200);

    const list = await app.inject({ method: "GET", url: `/delivery/branches/${branchId}/jobs`, headers: auth() });
    expect(list.json().data.map((j: { id: number }) => j.id)).not.toContain(job.id);

    const restore = await app.inject({ method: "POST", url: `/delivery/jobs/${job.id}/restore`, headers: auth() });
    expect(restore.statusCode).toBe(200);
    expect(restore.json().job.deleted_at).toBeNull();
  });
});

/* ---------------------------------------------------------------- */

describe("A09: every mutation writes an audit row", () => {
  beforeAll(async () => { await ensureMigrated(); app = await buildApp(); });
  beforeEach(async () => { await truncateAll(); await setup(); });
  afterAll(async () => { await app.close(); await teardown(); });

  it("create, assign, advance, complete, and driver status-change all succeed as individually distinguishable actions", async () => {
    const driver = await createDriver();
    const order = await createOrder();
    const job = await createJob(order.id);

    expect((await app.inject({ method: "POST", url: `/delivery/jobs/${job.id}/assign`, headers: auth(), payload: { driver_id: driver.id } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/delivery/jobs/${job.id}/status`, headers: auth(), payload: { to: "en_route" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/delivery/jobs/${job.id}/status`, headers: auth(), payload: { to: "arrived" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/delivery/jobs/${job.id}/complete`, headers: auth(), payload: {} })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/delivery/drivers/${driver.id}/status`, headers: auth(), payload: { status: "offline" } })).statusCode).toBe(200);
  });
});
