/**
 * Customer deletion — unpaid-orders guard.
 *
 * Closes the gap tracked in PROJECT_CONTEXT.md §12: customer deletion did
 * not check for unpaid orders. Orders now exist (Phase 3), so this is no
 * longer a documented-but-open gap — it is a tested rule.
 *
 * "Unpaid" = any non-deleted order for the customer with total > paid_amount,
 * regardless of order status (a cancelled order that took a deposit still
 * represents money owed — see the repository function's header comment for
 * the full reasoning).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/api.js";
import { login, signupOwnerAndBusiness } from "../../src/modules/auth/service.js";
import { ensureMigrated, teardown, truncateAll } from "../helpers/harness.js";

const PW = "correct-horse-battery-staple";
let app: FastifyInstance;
let token: string;
let branchId: number;
let variantId: number;

async function setup(): Promise<void> {
  await signupOwnerAndBusiness(
    {
      business: { name: { en: "Unpaid Guard Co", ar: "حماية" } },
      owner: { email: "owner@example.com", full_name: "Owner", password: PW },
      branch: { name: { en: "Main", ar: "الرئيسية" }, code: "UG1", address: { en: "x", ar: "س" } },
    },
    { ipAddress: null, userAgent: null },
  );
  const s = await login({ email: "owner@example.com", password: PW }, { ipAddress: null, userAgent: null });
  token = s.access_token;
  branchId = 1;

  const svc = await app.inject({
    method: "POST", url: "/services", headers: auth(),
    payload: {
      name: { en: "Shirt", ar: "قميص" }, category: "shirt", service_type: "wash", sort_order: 0,
      variants: [{ size: null, unit_price: 10, express_multiplier: 1.5 }],
    },
  });
  expect(svc.statusCode).toBe(201);
  const catalogue = await app.inject({ method: "GET", url: "/services", headers: auth() });
  variantId = catalogue.json().services[0].variants[0].id;
}

function auth() { return { authorization: `Bearer ${token}` }; }

async function createCustomer(): Promise<number> {
  const res = await app.inject({
    method: "POST", url: "/customers", headers: auth(),
    payload: { name: { en: "Test Customer", ar: "" }, phone: "0501234567" },
  });
  expect(res.statusCode).toBe(201);
  return res.json().customer.id;
}

async function orderFor(customerId: number, overrides: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: "POST", url: "/orders", headers: auth(),
    payload: {
      intake_branch_id: branchId,
      customer_id: customerId,
      lines: [{ service_variant_id: variantId, qty: 1 }],
      ...overrides,
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json().order;
}

describe("customer deletion — unpaid orders guard", () => {
  beforeAll(async () => { await ensureMigrated(); app = await buildApp(); });
  beforeEach(async () => { await truncateAll(); await setup(); });
  afterAll(async () => { await app.close(); await teardown(); });

  it("a customer with no orders can still be deleted", async () => {
    const cid = await createCustomer();
    const res = await app.inject({ method: "DELETE", url: `/customers/${cid}`, headers: auth() });
    expect(res.statusCode).toBe(200);
  });

  it("a customer with an unpaid order cannot be deleted", async () => {
    const cid = await createCustomer();
    await orderFor(cid);   // total ~10.50, paid 0 — outstanding > 0

    const res = await app.inject({ method: "DELETE", url: `/customers/${cid}`, headers: auth() });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("customer-has-unpaid-orders");
    expect(res.json().details.unpaid_order_count).toBe(1);
    expect(res.json().details.unpaid_total).toBeGreaterThan(0);

    // The customer must still exist.
    const check = await app.inject({ method: "GET", url: `/customers/${cid}`, headers: auth() });
    expect(check.statusCode).toBe(200);
    expect(check.json().customer.deleted_at).toBeNull();
  });

  it("a customer whose only order is fully paid CAN be deleted", async () => {
    const cid = await createCustomer();
    const order = await orderFor(cid);
    await app.inject({
      method: "POST", url: `/orders/${order.id}/payments`, headers: auth(),
      payload: { amount: order.totals.total, method: "cash" },
    });

    const res = await app.inject({ method: "DELETE", url: `/customers/${cid}`, headers: auth() });
    expect(res.statusCode).toBe(200);
  });

  it("a CANCELLED order that already took a deposit still blocks deletion", async () => {
    const cid = await createCustomer();
    const order = await orderFor(cid, { initial_payment: { amount: 2, method: "cash" } });
    await app.inject({
      method: "POST", url: `/orders/${order.id}/status`, headers: auth(),
      payload: { to: "cancelled", reason: "customer changed their mind" },
    });

    const res = await app.inject({ method: "DELETE", url: `/customers/${cid}`, headers: auth() });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("customer-has-unpaid-orders");
  });

  it("a customer whose only order was itself soft-deleted CAN be deleted", async () => {
    const cid = await createCustomer();
    const order = await orderFor(cid);
    // deleteOrder only permits deletion when paid_amount is 0 — matches
    // this order's state, so this is a valid setup, not a contrived one.
    const delOrder = await app.inject({ method: "DELETE", url: `/orders/${order.id}`, headers: auth() });
    expect(delOrder.statusCode).toBe(200);

    const res = await app.inject({ method: "DELETE", url: `/customers/${cid}`, headers: auth() });
    expect(res.statusCode).toBe(200);
  });

  it("multiple unpaid orders are all counted and summed", async () => {
    const cid = await createCustomer();
    const a = await orderFor(cid);
    const b = await orderFor(cid);
    void a; void b;

    const res = await app.inject({ method: "DELETE", url: `/customers/${cid}`, headers: auth() });
    expect(res.statusCode).toBe(409);
    expect(res.json().details.unpaid_order_count).toBe(2);
  });

  it("a partially paid order still blocks deletion", async () => {
    const cid = await createCustomer();
    const order = await orderFor(cid);
    await app.inject({
      method: "POST", url: `/orders/${order.id}/payments`, headers: auth(),
      payload: { amount: 1, method: "cash" },   // less than the ~10.50 total
    });

    const res = await app.inject({ method: "DELETE", url: `/customers/${cid}`, headers: auth() });
    expect(res.statusCode).toBe(409);
  });
});
