/**
 * A01 + A03: Customer endpoint authorization, injection resistance, and
 * input validation.
 *
 * Covers three properties:
 *
 *   1. Every customer endpoint rejects unauthenticated callers (401) and
 *      callers lacking the required permission (403).
 *
 *   2. Hostile input in search terms, ids, tags and cursors cannot reach the
 *      SQL layer as executable fragments.
 *
 *   3. Zod validation rejects malformed bodies with a structured 422 that
 *      does not leak internals.
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
  customerId: number;
}

async function setup(app: FastifyInstance): Promise<Ctx> {
  const signup = await signupOwnerAndBusiness(
    {
      business: { name: { en: "AuthZ Laundry", ar: "مصبغة" } },
      owner: { email: "owner@example.com", full_name: "Owner", password: PW },
      branch: { name: { en: "Main", ar: "الرئيسية" }, code: "AZ1", address: { en: "x", ar: "س" } },
    },
    { ipAddress: null, userAgent: null },
  );
  const session = await login(
    { email: "owner@example.com", password: PW },
    { ipAddress: null, userAgent: null },
  );

  const res = await app.inject({
    method: "POST",
    url: "/customers",
    headers: { authorization: `Bearer ${session.access_token}` },
    payload: { name: { en: "Ahmed Al Marzooqi", ar: "أحمد المرزوقي" }, phone: "050 347 4252" },
  });

  return {
    ownerToken: session.access_token,
    businessId: signup.business.id,
    userId: signup.user.id,
    customerId: res.json().customer.id,
  };
}

/**
 * A token that authenticates as a real user but carries driver-level
 * permissions — used to prove that permission checks, not merely
 * authentication, gate these routes.
 */
function tokenWithPerms(ctx: Ctx, perms: string[], role = "driver"): string {
  return signAccessToken({
    sub: String(ctx.userId),
    biz: String(ctx.businessId),
    role,
    branches: [],
    perms,
    sess: "test-session",
    email: "owner@example.com",
  });
}

describe("A01: customer endpoints require authentication", () => {
  let app: FastifyInstance;
  let ctx: Ctx;

  beforeAll(async () => { await ensureMigrated(); app = await buildApp(); });
  beforeEach(async () => { await truncateAll(); ctx = await setup(app); });
  afterAll(async () => { await app.close(); await teardown(); });

  const endpoints: Array<[string, string, unknown?]> = [
    ["GET", "/customers"],
    ["POST", "/customers", { name: { en: "X", ar: "" }, phone: "0501234567" }],
    ["GET", "/customers/statistics"],
    ["GET", "/customers/1"],
    ["PATCH", "/customers/1", { vip: true }],
    ["POST", "/customers/1/status", { status: "inactive" }],
    ["DELETE", "/customers/1"],
    ["POST", "/customers/1/restore"],
    ["GET", "/customers/1/activity"],
    ["GET", "/customers/1/notes"],
    ["POST", "/customers/1/notes", { body: "note" }],
    ["DELETE", "/customers/1/notes/1"],
  ];

  it.each(endpoints)("%s %s returns 401 without a token", async (method, url, payload) => {
    const res = await app.inject({ method: method as never, url, payload: payload as never });
    expect(res.statusCode).toBe(401);
    // Structured error, no stack trace.
    expect(res.json().code).toBeTruthy();
    expect(JSON.stringify(res.json())).not.toMatch(/at\s+.*:\d+:\d+/);
  });

  it("all endpoints reject a token with no relevant permissions (403)", async () => {
    const weak = tokenWithPerms(ctx, ["delivery.read"]);
    const cases: Array<[string, string, unknown?]> = [
      ["GET", "/customers"],
      ["POST", "/customers", { name: { en: "X", ar: "" }, phone: "0501234567" }],
      ["GET", `/customers/${ctx.customerId}`],
      ["PATCH", `/customers/${ctx.customerId}`, { vip: true }],
      ["DELETE", `/customers/${ctx.customerId}`],
    ];
    for (const [method, url, payload] of cases) {
      const res = await app.inject({
        method: method as never,
        url,
        headers: { authorization: `Bearer ${weak}` },
        payload: payload as never,
      });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it("customers.read alone cannot create, update or delete", async () => {
    const readOnly = tokenWithPerms(ctx, ["customers.read"], "cashier");

    const list = await app.inject({
      method: "GET", url: "/customers",
      headers: { authorization: `Bearer ${readOnly}` },
    });
    expect(list.statusCode).toBe(200);

    const create = await app.inject({
      method: "POST", url: "/customers",
      headers: { authorization: `Bearer ${readOnly}` },
      payload: { name: { en: "New", ar: "" }, phone: "0509998888" },
    });
    expect(create.statusCode).toBe(403);

    const del = await app.inject({
      method: "DELETE", url: `/customers/${ctx.customerId}`,
      headers: { authorization: `Bearer ${readOnly}` },
    });
    expect(del.statusCode).toBe(403);
  });

  it("delete requires customers.delete specifically, not customers.update", async () => {
    const updater = tokenWithPerms(ctx, ["customers.read", "customers.update"], "manager");

    const patch = await app.inject({
      method: "PATCH", url: `/customers/${ctx.customerId}`,
      headers: { authorization: `Bearer ${updater}` },
      payload: { vip: true },
    });
    expect(patch.statusCode).toBe(200);

    const del = await app.inject({
      method: "DELETE", url: `/customers/${ctx.customerId}`,
      headers: { authorization: `Bearer ${updater}` },
    });
    expect(del.statusCode).toBe(403);
  });

  it("client-supplied permission headers are ignored", async () => {
    const weak = tokenWithPerms(ctx, ["delivery.read"]);
    const res = await app.inject({
      method: "DELETE",
      url: `/customers/${ctx.customerId}`,
      headers: {
        authorization: `Bearer ${weak}`,
        "x-permissions": "customers.delete",
        "x-role": "owner",
      },
    });
    expect(res.statusCode).toBe(403);
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
    "'; DROP TABLE customers; --",
    "1; DELETE FROM customers WHERE 1=1; --",
    "' UNION SELECT * FROM users --",
    "%' OR 1=1 --",
    "\\'; SELECT pg_sleep(5); --",
  ];

  it.each(sqlPayloads)("search term %s is treated as data, not SQL", async (payload) => {
    const res = await app.inject({
      method: "GET",
      url: `/customers?q=${encodeURIComponent(payload)}`,
      headers: { authorization: `Bearer ${ctx.ownerToken}` },
    });
    // The query must succeed (parameterised) and simply match nothing.
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().data)).toBe(true);

    // And the table must still exist with its row intact.
    const check = await app.inject({
      method: "GET",
      url: "/customers",
      headers: { authorization: `Bearer ${ctx.ownerToken}` },
    });
    expect(check.statusCode).toBe(200);
    expect(check.json().data.length).toBeGreaterThanOrEqual(1);
  });

  it.each(["1 OR 1=1", "1;DROP TABLE customers", "abc", "-1", "1.5", "1e10", "null", "../../etc/passwd"])(
    "malformed id %s is rejected before reaching SQL",
    async (badId) => {
      const res = await app.inject({
        method: "GET",
        url: `/customers/${encodeURIComponent(badId)}`,
        headers: { authorization: `Bearer ${ctx.ownerToken}` },
      });
      // 422 from Zod, or 404 if the router refuses the shape. Never 500.
      expect([400, 404, 422]).toContain(res.statusCode);
      expect(res.statusCode).not.toBe(500);
    },
  );

  it("hostile tag values are rejected by the token pattern", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/customers",
      headers: { authorization: `Bearer ${ctx.ownerToken}` },
      payload: {
        name: { en: "Tagged", ar: "" },
        phone: "0501112222",
        tags: ["'; DROP TABLE customers; --"],
      },
    });
    expect(res.statusCode).toBe(422);
  });

  it("a forged cursor cannot break the query or widen the result set", async () => {
    for (const cursor of ["not-base64", "eyJjIjoiJyBPUiAxPTEiLCJpIjoxfQ", "////", "e30"]) {
      const res = await app.inject({
        method: "GET",
        url: `/customers?cursor=${encodeURIComponent(cursor)}`,
        headers: { authorization: `Bearer ${ctx.ownerToken}` },
      });
      expect(res.statusCode).toBe(200);
      // Still scoped to this tenant.
      const ids = res.json().data.map((c: { id: number }) => c.id);
      for (const id of ids) expect(id).toBe(ctx.customerId);
    }
  });

  it("XSS payload in a name is stored and returned as inert data", async () => {
    const xss = "<script>alert(1)</script>";
    const create = await app.inject({
      method: "POST",
      url: "/customers",
      headers: { authorization: `Bearer ${ctx.ownerToken}` },
      payload: { name: { en: xss, ar: "" }, phone: "0505556666" },
    });
    expect(create.statusCode).toBe(201);

    const got = await app.inject({
      method: "GET",
      url: `/customers/${create.json().customer.id}`,
      headers: { authorization: `Bearer ${ctx.ownerToken}` },
    });
    // Returned as a JSON string value; content-type is JSON so a browser
    // will not execute it. React escapes on render.
    expect(got.headers["content-type"]).toMatch(/application\/json/);
    expect(got.json().customer.name.en).toBe(xss);
  });
});

describe("A03: input validation", () => {
  let app: FastifyInstance;
  let ctx: Ctx;

  beforeAll(async () => { await ensureMigrated(); app = await buildApp(); });
  beforeEach(async () => { await truncateAll(); ctx = await setup(app); });
  afterAll(async () => { await app.close(); await teardown(); });

  it("rejects a customer with neither English nor Arabic name", async () => {
    const res = await app.inject({
      method: "POST", url: "/customers",
      headers: { authorization: `Bearer ${ctx.ownerToken}` },
      payload: { name: { en: "", ar: "" }, phone: "0501234567" },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe("validation-failed");
  });

  it("rejects unknown fields rather than silently dropping them", async () => {
    const res = await app.inject({
      method: "POST", url: "/customers",
      headers: { authorization: `Bearer ${ctx.ownerToken}` },
      payload: {
        name: { en: "Test", ar: "" },
        phone: "0501234567",
        business_id: 9999,          // attempt to override tenant
        id: 1,                       // attempt to set the primary key
        deleted_at: null,
      },
    });
    expect(res.statusCode).toBe(422);
  });

  it("requires a reason when blocking a customer", async () => {
    const res = await app.inject({
      method: "POST", url: `/customers/${ctx.customerId}/status`,
      headers: { authorization: `Bearer ${ctx.ownerToken}` },
      payload: { status: "blocked" },
    });
    expect(res.statusCode).toBe(422);

    const ok = await app.inject({
      method: "POST", url: `/customers/${ctx.customerId}/status`,
      headers: { authorization: `Bearer ${ctx.ownerToken}` },
      payload: { status: "blocked", reason: "Repeated non-payment" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().customer.status).toBe("blocked");
  });

  it("caps list limit at 100", async () => {
    const res = await app.inject({
      method: "GET", url: "/customers?limit=100000",
      headers: { authorization: `Bearer ${ctx.ownerToken}` },
    });
    expect(res.statusCode).toBe(422);
  });

  it("validation errors do not leak the schema or internals", async () => {
    const res = await app.inject({
      method: "POST", url: "/customers",
      headers: { authorization: `Bearer ${ctx.ownerToken}` },
      payload: { phone: "abc" },
    });
    expect(res.statusCode).toBe(422);
    const body = JSON.stringify(res.json());
    expect(body).not.toMatch(/ZodError|node_modules|\/home\/|src\//);
  });
});
