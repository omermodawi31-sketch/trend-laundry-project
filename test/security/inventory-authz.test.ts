/**
 * A01 + A03: Inventory endpoint authorization, injection resistance, and
 * input validation.
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
  itemId: number;
}

async function setup(app: FastifyInstance): Promise<Ctx> {
  const signup = await signupOwnerAndBusiness(
    {
      business: { name: { en: "AuthZ Inventory", ar: "مخزون" } },
      owner: { email: "owner@example.com", full_name: "Owner", password: PW },
      branch: { name: { en: "Main", ar: "الرئيسية" }, code: "IZ1", address: { en: "x", ar: "س" } },
    },
    { ipAddress: null, userAgent: null },
  );
  const session = await login({ email: "owner@example.com", password: PW }, { ipAddress: null, userAgent: null });
  const item = await app.inject({
    method: "POST", url: "/inventory/items",
    headers: { authorization: `Bearer ${session.access_token}` },
    payload: { name: { en: "Detergent 5L", ar: "منظف" }, category: "chemical", unit: "L", sku: "DET-5L" },
  });
  return {
    ownerToken: session.access_token,
    businessId: signup.business.id,
    userId: signup.user.id,
    branchId: 1,
    itemId: item.json().item.id,
  };
}

function tokenWithPerms(ctx: Ctx, perms: string[], role = "driver"): string {
  return signAccessToken({
    sub: String(ctx.userId), biz: String(ctx.businessId), role,
    branches: [], perms, sess: "test-session", email: "owner@example.com",
  });
}

describe("A01: inventory requires authentication and permission", () => {
  let app: FastifyInstance;
  let ctx: Ctx;

  beforeAll(async () => { await ensureMigrated(); app = await buildApp(); });
  beforeEach(async () => { await truncateAll(); ctx = await setup(app); });
  afterAll(async () => { await app.close(); await teardown(); });

  const endpoints: Array<[string, string, unknown?]> = [
    ["GET", "/inventory/items"],
    ["POST", "/inventory/items", { name: { en: "X", ar: "" }, category: "chemical", unit: "L" }],
    ["GET", "/inventory/items/by-code/ABC"],
    ["GET", "/inventory/items/1"],
    ["PATCH", "/inventory/items/1", { sort_order: 1 }],
    ["POST", "/inventory/items/1/status", { is_active: false }],
    ["DELETE", "/inventory/items/1"],
    ["POST", "/inventory/items/1/restore"],
    ["GET", "/inventory/items/1/stock"],
    ["GET", "/inventory/items/1/movements"],
    ["GET", "/inventory/branches/1/stock"],
    ["GET", "/inventory/branches/1/movements"],
    ["POST", "/inventory/branches/1/receive", { item_id: 1, quantity: 1 }],
    ["POST", "/inventory/branches/1/waste", { item_id: 1, quantity: 1, reason: "x" }],
    ["POST", "/inventory/branches/1/adjust", { item_id: 1, counted_quantity: 1 }],
    ["POST", "/inventory/transfer", { item_id: 1, from_branch_id: 1, to_branch_id: 2, quantity: 1 }],
  ];

  it.each(endpoints)("%s %s returns 401 without a token", async (method, url, payload) => {
    const res = await app.inject({ method: method as never, url, payload: payload as never });
    expect(res.statusCode).toBe(401);
  });

  it("inventory.read alone cannot create, receive, waste, or adjust", async () => {
    const readOnly = tokenWithPerms(ctx, ["inventory.read"], "cashier");
    const cases: Array<[string, string, unknown?]> = [
      ["POST", "/inventory/items", { name: { en: "X", ar: "" }, category: "chemical", unit: "L" }],
      ["POST", `/inventory/branches/${ctx.branchId}/receive`, { item_id: ctx.itemId, quantity: 1 }],
      ["POST", `/inventory/branches/${ctx.branchId}/waste`, { item_id: ctx.itemId, quantity: 1, reason: "x" }],
      ["POST", `/inventory/branches/${ctx.branchId}/adjust`, { item_id: ctx.itemId, counted_quantity: 5 }],
    ];
    for (const [method, url, payload] of cases) {
      const res = await app.inject({
        method: method as never, url,
        headers: { authorization: `Bearer ${readOnly}` }, payload: payload as never,
      });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it("inventory.receive does not grant waste or adjust — permission granularity", async () => {
    const receiveOnly = tokenWithPerms(ctx, ["inventory.receive"], "employee");
    const waste = await app.inject({
      method: "POST", url: `/inventory/branches/${ctx.branchId}/waste`,
      headers: { authorization: `Bearer ${receiveOnly}` },
      payload: { item_id: ctx.itemId, quantity: 1, reason: "x" },
    });
    expect(waste.statusCode).toBe(403);

    const adjust = await app.inject({
      method: "POST", url: `/inventory/branches/${ctx.branchId}/adjust`,
      headers: { authorization: `Bearer ${receiveOnly}` },
      payload: { item_id: ctx.itemId, counted_quantity: 5 },
    });
    expect(adjust.statusCode).toBe(403);
  });

  it("inventory.waste_record does not grant receive", async () => {
    const wasteOnly = tokenWithPerms(ctx, ["inventory.waste_record"], "employee");
    const res = await app.inject({
      method: "POST", url: `/inventory/branches/${ctx.branchId}/receive`,
      headers: { authorization: `Bearer ${wasteOnly}` },
      payload: { item_id: ctx.itemId, quantity: 1 },
    });
    expect(res.statusCode).toBe(403);
  });

  it("client-supplied permission headers are ignored", async () => {
    const weak = tokenWithPerms(ctx, ["orders.read"]);
    const res = await app.inject({
      method: "DELETE", url: `/inventory/items/${ctx.itemId}`,
      headers: {
        authorization: `Bearer ${weak}`,
        "x-permissions": "inventory.adjust",
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

  it("rejects an item with neither English nor Arabic name", async () => {
    const res = await app.inject({
      method: "POST", url: "/inventory/items", headers: { authorization: `Bearer ${ctx.ownerToken}` },
      payload: { name: { en: "", ar: "" }, category: "chemical", unit: "L" },
    });
    expect(res.statusCode).toBe(422);
  });

  it("rejects an invalid unit", async () => {
    const res = await app.inject({
      method: "POST", url: "/inventory/items", headers: { authorization: `Bearer ${ctx.ownerToken}` },
      payload: { name: { en: "X", ar: "" }, category: "chemical", unit: "gallons" },
    });
    expect(res.statusCode).toBe(422);
  });

  it("rejects a duplicate SKU within the same business", async () => {
    const res = await app.inject({
      method: "POST", url: "/inventory/items", headers: { authorization: `Bearer ${ctx.ownerToken}` },
      payload: { name: { en: "Dupe", ar: "" }, category: "chemical", unit: "L", sku: "DET-5L" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("item-sku-exists");
    expect(res.json().details.item_id).toBe(ctx.itemId);
  });

  it("rejects a duplicate barcode within the same business", async () => {
    await app.inject({
      method: "POST", url: "/inventory/items", headers: { authorization: `Bearer ${ctx.ownerToken}` },
      payload: { name: { en: "First", ar: "" }, category: "chemical", unit: "L", barcode: "6291000000001" },
    });
    const res = await app.inject({
      method: "POST", url: "/inventory/items", headers: { authorization: `Bearer ${ctx.ownerToken}` },
      payload: { name: { en: "Second", ar: "" }, category: "chemical", unit: "L", barcode: "6291000000001" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("item-barcode-exists");
  });

  it("rejects zero or negative quantity on receive", async () => {
    for (const quantity of [0, -5]) {
      const res = await app.inject({
        method: "POST", url: `/inventory/branches/${ctx.branchId}/receive`,
        headers: { authorization: `Bearer ${ctx.ownerToken}` },
        payload: { item_id: ctx.itemId, quantity },
      });
      expect(res.statusCode, `quantity=${quantity}`).toBe(422);
    }
  });

  it("requires a reason for waste", async () => {
    const res = await app.inject({
      method: "POST", url: `/inventory/branches/${ctx.branchId}/waste`,
      headers: { authorization: `Bearer ${ctx.ownerToken}` },
      payload: { item_id: ctx.itemId, quantity: 1 },
    });
    expect(res.statusCode).toBe(422);
  });

  it("requires from_branch_id and to_branch_id to differ on transfer", async () => {
    const res = await app.inject({
      method: "POST", url: "/inventory/transfer",
      headers: { authorization: `Bearer ${ctx.ownerToken}` },
      payload: { item_id: ctx.itemId, from_branch_id: 1, to_branch_id: 1, quantity: 5 },
    });
    expect(res.statusCode).toBe(422);
  });

  it("rejects an adjust whose counted_quantity matches current stock exactly (nothing to adjust)", async () => {
    // Fresh item, zero stock; counting zero again is a no-op.
    const res = await app.inject({
      method: "POST", url: `/inventory/branches/${ctx.branchId}/adjust`,
      headers: { authorization: `Bearer ${ctx.ownerToken}` },
      payload: { item_id: ctx.itemId, counted_quantity: 0 },
    });
    expect(res.statusCode).toBe(422);
  });

  it("rejects unknown top-level fields, including an attempted business_id override", async () => {
    const res = await app.inject({
      method: "POST", url: "/inventory/items", headers: { authorization: `Bearer ${ctx.ownerToken}` },
      payload: { name: { en: "X", ar: "" }, category: "chemical", unit: "L", business_id: 999999, id: 1 },
    });
    expect(res.statusCode).toBe(422);
  });

  it("rejects an empty PATCH body", async () => {
    const res = await app.inject({
      method: "PATCH", url: `/inventory/items/${ctx.itemId}`,
      headers: { authorization: `Bearer ${ctx.ownerToken}` }, payload: {},
    });
    expect(res.statusCode).toBe(422);
  });

  it("rejects an uppercase or symbol-containing category", async () => {
    for (const category of ["Chemical", "chem-ical", "chemical!"]) {
      const res = await app.inject({
        method: "POST", url: "/inventory/items", headers: { authorization: `Bearer ${ctx.ownerToken}` },
        payload: { name: { en: "X", ar: "" }, category, unit: "L" },
      });
      expect(res.statusCode, `category=${category}`).toBe(422);
    }
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
    "'; DROP TABLE inventory_items; --",
    "1'; DELETE FROM inventory_movements WHERE 1=1; --",
    "' UNION SELECT * FROM users --",
  ];

  it.each(sqlPayloads)("catalog search term %s is treated as data", async (payload) => {
    const res = await app.inject({
      method: "GET", url: `/inventory/items?q=${encodeURIComponent(payload)}`,
      headers: { authorization: `Bearer ${ctx.ownerToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().data)).toBe(true);

    const check = await app.inject({ method: "GET", url: "/inventory/items", headers: { authorization: `Bearer ${ctx.ownerToken}` } });
    expect(check.json().data.length).toBeGreaterThanOrEqual(1);
  });

  it.each(sqlPayloads)("scan-code lookup %s is treated as data, never as SQL", async (payload) => {
    const res = await app.inject({
      method: "GET", url: `/inventory/items/by-code/${encodeURIComponent(payload)}`,
      headers: { authorization: `Bearer ${ctx.ownerToken}` },
    });
    // No such code exists — a clean 404, never a 500, and the table survives.
    expect(res.statusCode).toBe(404);

    const check = await app.inject({ method: "GET", url: "/inventory/items", headers: { authorization: `Bearer ${ctx.ownerToken}` } });
    expect(check.json().data.length).toBeGreaterThanOrEqual(1);
  });

  it.each(["1 OR 1=1", "abc", "-1", "1.5", "null"])(
    "malformed item id %s never reaches SQL as executable",
    async (badId) => {
      const res = await app.inject({
        method: "GET", url: `/inventory/items/${encodeURIComponent(badId)}`,
        headers: { authorization: `Bearer ${ctx.ownerToken}` },
      });
      expect([400, 404, 422]).toContain(res.statusCode);
      expect(res.statusCode).not.toBe(500);
    },
  );

  it("a hostile value in the bilingual name is stored and returned as inert JSON, not executed", async () => {
    const xss = "<script>alert(1)</script>";
    const res = await app.inject({
      method: "POST", url: "/inventory/items", headers: { authorization: `Bearer ${ctx.ownerToken}` },
      payload: { name: { en: xss, ar: "" }, category: "chemical", unit: "L" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.json().item.name.en).toBe(xss);
  });
});
