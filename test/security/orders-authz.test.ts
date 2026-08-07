/**
 * A01 + A03: Order endpoint authorization, injection resistance, and the
 * property that matters most for a money-handling module — the client can
 * never dictate a price.
 *
 * Covers:
 *   1. Every endpoint requires authentication and the specific permission.
 *   2. The server prices orders; a client-supplied total/subtotal/vat_amount
 *      is rejected outright by Zod's `.strict()`, not merely ignored.
 *   3. SQL injection payloads in search and structured input are inert.
 *   4. Discount ceiling requires an elevated permission.
 *   5. A refund cannot be laundered against another order's payment.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/api.js";
import { login, signupOwnerAndBusiness } from "../../src/modules/auth/service.js";
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
}

async function setup(app: FastifyInstance): Promise<Ctx> {
  const signup = await signupOwnerAndBusiness(
    {
      business: { name: { en: "AuthZ Orders", ar: "طلبات" } },
      owner: { email: "owner@example.com", full_name: "Owner", password: PW },
      branch: { name: { en: "Main", ar: "الرئيسية" }, code: "OZ1", address: { en: "x", ar: "س" } },
    },
    { ipAddress: null, userAgent: null },
  );
  const session = await login({ email: "owner@example.com", password: PW }, { ipAddress: null, userAgent: null });
  const token = session.access_token;

  const svc = await app.inject({
    method: "POST", url: "/services", headers: auth(),
    payload: {
      name: { en: "Shirt", ar: "قميص" }, category: "shirt", service_type: "wash", sort_order: 0,
      variants: [{ size: null, unit_price: 10, express_multiplier: 1.5 }],
    },
  });
  expect(svc.statusCode).toBe(201);
  const catalogue = await app.inject({ method: "GET", url: "/services", headers: auth() });
  const variantId = catalogue.json().services[0].variants[0].id;

  const order = await app.inject({
    method: "POST", url: "/orders", headers: { authorization: `Bearer ${token}` },
    payload: {
      intake_branch_id: 1,
      walk_in: { name: { en: "Cust", ar: "" }, phone: "0501234567" },
      lines: [{ service_variant_id: variantId, qty: 2 }],
    },
  });

  return {
    ownerToken: token,
    businessId: signup.business.id,
    userId: signup.user.id,
    branchId: 1,
    variantId,
    orderId: order.json().order.id,
  };
}

function tokenWithPerms(ctx: Ctx, perms: string[], role = "driver"): string {
  return signAccessToken({
    sub: String(ctx.userId), biz: String(ctx.businessId), role,
    branches: [], perms, sess: "test-session", email: "owner@example.com",
  });
}

describe("A01: orders require authentication and permission", () => {
  let app: FastifyInstance;
  let ctx: Ctx;

  beforeAll(async () => { await ensureMigrated(); app = await buildApp(); });
  beforeEach(async () => { await truncateAll(); ctx = await setup(app); });
  afterAll(async () => { await app.close(); await teardown(); });

  const endpoints: Array<[string, string, unknown?]> = [
    ["GET", "/services"],
    ["POST", "/services", { name: { en: "X", ar: "" }, category: "x", service_type: "wash", sort_order: 0, variants: [{ unit_price: 1, express_multiplier: 1.5 }] }],
    ["GET", "/orders"],
    ["POST", "/orders", { intake_branch_id: 1, walk_in: { name: { en: "X", ar: "" }, phone: "0501234567" }, lines: [{ service_variant_id: 1, qty: 1 }] }],
    ["GET", "/orders/1"],
    ["PATCH", "/orders/1/lines", { lines: [{ service_variant_id: 1, qty: 1 }] }],
    ["PATCH", "/orders/1", { notes: "x" }],
    ["POST", "/orders/1/status", { to: "sorting" }],
    ["POST", "/orders/1/payments", { amount: 1, method: "cash" }],
    ["POST", "/orders/1/refund", { payment_id: 1, amount: 1, reason: "x" }],
    ["DELETE", "/orders/1"],
  ];

  it.each(endpoints)("%s %s returns 401 without a token", async (method, url, payload) => {
    const res = await app.inject({ method: method as never, url, payload: payload as never });
    expect(res.statusCode).toBe(401);
  });

  it("orders.read alone cannot create, update status, take payment or delete", async () => {
    const readOnly = tokenWithPerms(ctx, ["orders.read"], "cashier");
    const cases: Array<[string, string, unknown?]> = [
      ["POST", "/orders", { intake_branch_id: ctx.branchId, walk_in: { name: { en: "X", ar: "" }, phone: "0501234567" }, lines: [{ service_variant_id: ctx.variantId, qty: 1 }] }],
      ["POST", `/orders/${ctx.orderId}/status`, { to: "sorting" }],
      ["POST", `/orders/${ctx.orderId}/payments`, { amount: 5, method: "cash" }],
      ["DELETE", `/orders/${ctx.orderId}`],
    ];
    for (const [method, url, payload] of cases) {
      const res = await app.inject({
        method: method as never, url,
        headers: { authorization: `Bearer ${readOnly}` }, payload: payload as never,
      });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it("permission granularity: status_change does not imply payment_record", async () => {
    const statusOnly = tokenWithPerms(ctx, ["orders.read", "orders.status_change"], "employee");
    const res = await app.inject({
      method: "POST", url: `/orders/${ctx.orderId}/payments`,
      headers: { authorization: `Bearer ${statusOnly}` },
      payload: { amount: 5, method: "cash" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("refund requires orders.refund specifically", async () => {
    const paymentOnly = tokenWithPerms(ctx, ["orders.read", "orders.payment_record"], "cashier");
    const res = await app.inject({
      method: "POST", url: `/orders/${ctx.orderId}/refund`,
      headers: { authorization: `Bearer ${paymentOnly}` },
      payload: { payment_id: 1, amount: 1, reason: "test" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("creating a service catalogue entry requires settings.business.edit, not orders.create", async () => {
    const orderCreator = tokenWithPerms(ctx, ["orders.create", "orders.read"], "cashier");
    const res = await app.inject({
      method: "POST", url: "/services",
      headers: { authorization: `Bearer ${orderCreator}` },
      payload: { name: { en: "X", ar: "" }, category: "x", service_type: "wash", sort_order: 0, variants: [{ unit_price: 1, express_multiplier: 1.5 }] },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("A03: the server prices orders — client money fields are rejected", () => {
  let app: FastifyInstance;
  let ctx: Ctx;

  beforeAll(async () => { await ensureMigrated(); app = await buildApp(); });
  beforeEach(async () => { await truncateAll(); ctx = await setup(app); });
  afterAll(async () => { await app.close(); await teardown(); });

  it("a client-supplied total is rejected by strict schema validation, not silently dropped", async () => {
    const res = await app.inject({
      method: "POST", url: "/orders", headers: { authorization: `Bearer ${ctx.ownerToken}` },
      payload: {
        intake_branch_id: ctx.branchId,
        walk_in: { name: { en: "Cheap", ar: "" }, phone: "0509998888" },
        lines: [{ service_variant_id: ctx.variantId, qty: 100 }],
        total: 0.01,          // attempted price override
        subtotal: 0.01,
        vat_amount: 0,
      },
    });
    expect(res.statusCode).toBe(422);
  });

  it("the created order's total matches server-computed pricing, never a client hint", async () => {
    const res = await app.inject({
      method: "POST", url: "/orders", headers: { authorization: `Bearer ${ctx.ownerToken}` },
      payload: {
        intake_branch_id: ctx.branchId,
        walk_in: { name: { en: "Real Price", ar: "" }, phone: "0509998887" },
        lines: [{ service_variant_id: ctx.variantId, qty: 3 }],   // 3 × 10 = 30
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().order.totals.subtotal).toBe(30);
    expect(res.json().order.totals.total).toBeCloseTo(30 * 1.05, 5);   // 5% VAT, no express/delivery
  });

  it("discount above 50% requires orders.refund permission", async () => {
    const cashier = tokenWithPerms(ctx, ["orders.create", "orders.read"], "cashier");
    const res = await app.inject({
      method: "POST", url: "/orders",
      headers: { authorization: `Bearer ${cashier}` },
      payload: {
        intake_branch_id: ctx.branchId,
        walk_in: { name: { en: "Big Discount", ar: "" }, phone: "0509998886" },
        lines: [{ service_variant_id: ctx.variantId, qty: 1 }],
        discount_pct: 90,
        discount_reason: "friend of the owner",
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it("a manager-level token with orders.refund CAN apply a >50% discount", async () => {
    const manager = tokenWithPerms(ctx, ["orders.create", "orders.read", "orders.refund"], "manager");
    const res = await app.inject({
      method: "POST", url: "/orders",
      headers: { authorization: `Bearer ${manager}` },
      payload: {
        intake_branch_id: ctx.branchId,
        walk_in: { name: { en: "Big Discount OK", ar: "" }, phone: "0509998885" },
        lines: [{ service_variant_id: ctx.variantId, qty: 1 }],
        discount_pct: 90,
        discount_reason: "goodwill gesture",
      },
    });
    expect(res.statusCode).toBe(201);
  });

  it("initial_payment exceeding the computed total is rejected", async () => {
    const res = await app.inject({
      method: "POST", url: "/orders", headers: { authorization: `Bearer ${ctx.ownerToken}` },
      payload: {
        intake_branch_id: ctx.branchId,
        walk_in: { name: { en: "Overpay", ar: "" }, phone: "0509998884" },
        lines: [{ service_variant_id: ctx.variantId, qty: 1 }],   // total ~10.50
        initial_payment: { amount: 999, method: "cash" },
      },
    });
    expect(res.statusCode).toBe(422);
  });

  it("a payment exceeding the outstanding balance is rejected", async () => {
    const res = await app.inject({
      method: "POST", url: `/orders/${ctx.orderId}/payments`,
      headers: { authorization: `Bearer ${ctx.ownerToken}` },
      payload: { amount: 999999, method: "cash" },
    });
    expect(res.statusCode).toBe(422);
  });
});

describe("A01: a refund cannot be laundered against another order's payment", () => {
  let app: FastifyInstance;
  let ctx: Ctx;
  let secondOrderId: number;
  let secondOrderPaymentId: number;

  beforeAll(async () => { await ensureMigrated(); app = await buildApp(); });
  beforeEach(async () => {
    await truncateAll();
    ctx = await setup(app);

    const second = await app.inject({
      method: "POST", url: "/orders", headers: { authorization: `Bearer ${ctx.ownerToken}` },
      payload: {
        intake_branch_id: ctx.branchId,
        walk_in: { name: { en: "Second", ar: "" }, phone: "0501112223" },
        lines: [{ service_variant_id: ctx.variantId, qty: 1 }],
        initial_payment: { amount: 5, method: "cash" },
      },
    });
    secondOrderId = second.json().order.id;
    secondOrderPaymentId = second.json().order.payments[0].id;
  });
  afterAll(async () => { await app.close(); await teardown(); });

  it("refunding order A's endpoint with order B's payment id is rejected", async () => {
    const res = await app.inject({
      method: "POST", url: `/orders/${ctx.orderId}/refund`,     // order A
      headers: { authorization: `Bearer ${ctx.ownerToken}` },
      payload: { payment_id: secondOrderPaymentId, amount: 5, reason: "wrong order" }, // B's payment
    });
    expect(res.statusCode).toBe(404);

    // Order B's payment must be untouched.
    const check = await app.inject({
      method: "GET", url: `/orders/${secondOrderId}`,
      headers: { authorization: `Bearer ${ctx.ownerToken}` },
    });
    expect(check.json().order.totals.paid_amount).toBe(5);
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
    "'; DROP TABLE orders; --",
    "1'; DELETE FROM payments WHERE 1=1; --",
    "' UNION SELECT * FROM users --",
    "%' OR 1=1 --",
  ];

  it.each(sqlPayloads)("order search term %s is treated as data", async (payload) => {
    const res = await app.inject({
      method: "GET", url: `/orders?q=${encodeURIComponent(payload)}`,
      headers: { authorization: `Bearer ${ctx.ownerToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().data)).toBe(true);

    const check = await app.inject({
      method: "GET", url: "/orders",
      headers: { authorization: `Bearer ${ctx.ownerToken}` },
    });
    expect(check.statusCode).toBe(200);
    expect(check.json().data.length).toBeGreaterThanOrEqual(1);
  });

  it.each(["1 OR 1=1", "abc", "-1", "1.5", "null", "../../etc/passwd"])(
    "malformed order id %s never reaches SQL as executable",
    async (badId) => {
      const res = await app.inject({
        method: "GET", url: `/orders/${encodeURIComponent(badId)}`,
        headers: { authorization: `Bearer ${ctx.ownerToken}` },
      });
      expect([400, 404, 422]).toContain(res.statusCode);
      expect(res.statusCode).not.toBe(500);
    },
  );

  it("hostile status value in a transition request is rejected by the enum schema", async () => {
    const res = await app.inject({
      method: "POST", url: `/orders/${ctx.orderId}/status`,
      headers: { authorization: `Bearer ${ctx.ownerToken}` },
      payload: { to: "'; DROP TABLE orders; --" },
    });
    expect(res.statusCode).toBe(422);
  });

  it("unknown top-level fields are rejected, not dropped", async () => {
    const res = await app.inject({
      method: "POST", url: "/orders", headers: { authorization: `Bearer ${ctx.ownerToken}` },
      payload: {
        intake_branch_id: ctx.branchId,
        walk_in: { name: { en: "X", ar: "" }, phone: "0501234567" },
        lines: [{ service_variant_id: ctx.variantId, qty: 1 }],
        business_id: 99999,        // attempted tenant override
        taken_by_user_id: 1,       // attempted staff-id spoof
      },
    });
    expect(res.statusCode).toBe(422);
  });
});
