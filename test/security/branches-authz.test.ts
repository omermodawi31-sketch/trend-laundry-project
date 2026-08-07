/**
 * A01 + A03: Branch endpoint authorization, injection resistance, and input
 * validation.
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
  homeBranchId: number;
}

async function setup(): Promise<Ctx> {
  const signup = await signupOwnerAndBusiness(
    {
      business: { name: { en: "AuthZ Branches", ar: "فروع" } },
      owner: { email: "owner@example.com", full_name: "Owner", password: PW },
      branch: { name: { en: "Main", ar: "الرئيسية" }, code: "BZ1", address: { en: "x", ar: "س" } },
    },
    { ipAddress: null, userAgent: null },
  );
  const session = await login({ email: "owner@example.com", password: PW }, { ipAddress: null, userAgent: null });
  return {
    ownerToken: session.access_token,
    businessId: signup.business.id,
    userId: signup.user.id,
    homeBranchId: 1,
  };
}

function tokenWithPerms(ctx: Ctx, perms: string[], role = "driver"): string {
  return signAccessToken({
    sub: String(ctx.userId), biz: String(ctx.businessId), role,
    branches: [], perms, sess: "test-session", email: "owner@example.com",
  });
}

describe("A01: branches require authentication and permission", () => {
  let app: FastifyInstance;
  let ctx: Ctx;

  beforeAll(async () => { await ensureMigrated(); app = await buildApp(); });
  beforeEach(async () => { await truncateAll(); ctx = await setup(); });
  afterAll(async () => { await app.close(); await teardown(); });

  const endpoints: Array<[string, string, unknown?]> = [
    ["GET", "/branches"],
    ["POST", "/branches", { name: { en: "X", ar: "" }, code: "X1", address: { en: "x", ar: "" } }],
    ["GET", "/branches/1"],
    ["PATCH", "/branches/1", { sort_order: 1 }],
    ["POST", "/branches/1/status", { is_active: false }],
    ["DELETE", "/branches/1"],
    ["POST", "/branches/1/restore"],
  ];

  it.each(endpoints)("%s %s returns 401 without a token", async (method, url, payload) => {
    const res = await app.inject({ method: method as never, url, payload: payload as never });
    expect(res.statusCode).toBe(401);
  });

  it("a token with no settings permissions is refused everywhere", async () => {
    const none = tokenWithPerms(ctx, ["orders.read"], "cashier");
    const cases: Array<[string, string, unknown?]> = [
      ["GET", "/branches"],
      ["POST", "/branches", { name: { en: "X", ar: "" }, code: "X1", address: { en: "x", ar: "" } }],
      ["PATCH", `/branches/${ctx.homeBranchId}`, { sort_order: 1 }],
      ["POST", `/branches/${ctx.homeBranchId}/status`, { is_active: false }],
      ["DELETE", `/branches/${ctx.homeBranchId}`],
    ];
    for (const [method, url, payload] of cases) {
      const res = await app.inject({
        method: method as never, url,
        headers: { authorization: `Bearer ${none}` }, payload: payload as never,
      });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it("settings.read alone can list and get, but not mutate", async () => {
    const readOnly = tokenWithPerms(ctx, ["settings.read"], "manager");

    const list = await app.inject({ method: "GET", url: "/branches", headers: { authorization: `Bearer ${readOnly}` } });
    expect(list.statusCode).toBe(200);

    const get = await app.inject({ method: "GET", url: `/branches/${ctx.homeBranchId}`, headers: { authorization: `Bearer ${readOnly}` } });
    expect(get.statusCode).toBe(200);

    const patch = await app.inject({
      method: "PATCH", url: `/branches/${ctx.homeBranchId}`,
      headers: { authorization: `Bearer ${readOnly}` }, payload: { sort_order: 1 },
    });
    expect(patch.statusCode).toBe(403);
  });

  it("client-supplied permission headers are ignored", async () => {
    const weak = tokenWithPerms(ctx, ["orders.read"]);
    const res = await app.inject({
      method: "DELETE", url: `/branches/${ctx.homeBranchId}`,
      headers: {
        authorization: `Bearer ${weak}`,
        "x-permissions": "settings.branches.edit",
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
  beforeEach(async () => { await truncateAll(); ctx = await setup(); });
  afterAll(async () => { await app.close(); await teardown(); });

  it("rejects a branch with neither English nor Arabic name", async () => {
    const res = await app.inject({
      method: "POST", url: "/branches", headers: { authorization: `Bearer ${ctx.ownerToken}` },
      payload: { name: { en: "", ar: "" }, code: "X1", address: { en: "x", ar: "" } },
    });
    expect(res.statusCode).toBe(422);
  });

  it("rejects a lowercase or symbol-containing branch code", async () => {
    for (const code of ["ajm1", "AJM-1", "AJM 1", "AJM#1", ""]) {
      const res = await app.inject({
        method: "POST", url: "/branches", headers: { authorization: `Bearer ${ctx.ownerToken}` },
        payload: { name: { en: "X", ar: "" }, code, address: { en: "x", ar: "" } },
      });
      expect(res.statusCode, `code=${code}`).toBe(422);
    }
  });

  it("rejects a duplicate branch code within the same business", async () => {
    const first = await app.inject({
      method: "POST", url: "/branches", headers: { authorization: `Bearer ${ctx.ownerToken}` },
      payload: { name: { en: "First", ar: "" }, code: "DUP1", address: { en: "x", ar: "" } },
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: "POST", url: "/branches", headers: { authorization: `Bearer ${ctx.ownerToken}` },
      payload: { name: { en: "Second", ar: "" }, code: "DUP1", address: { en: "x", ar: "" } },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe("branch-code-exists");
    expect(second.json().details.branch_id).toBe(first.json().branch.id);
  });

  it("rejects updating a branch's code to one already used by another branch", async () => {
    await app.inject({
      method: "POST", url: "/branches", headers: { authorization: `Bearer ${ctx.ownerToken}` },
      payload: { name: { en: "Taken", ar: "" }, code: "TAKEN1", address: { en: "x", ar: "" } },
    });
    const res = await app.inject({
      method: "PATCH", url: `/branches/${ctx.homeBranchId}`,
      headers: { authorization: `Bearer ${ctx.ownerToken}` },
      payload: { code: "TAKEN1" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("branch-code-exists");
  });

  it("rejects latitude as a top-level field — coordinates must go inside `geo`", async () => {
    const res = await app.inject({
      method: "POST", url: "/branches", headers: { authorization: `Bearer ${ctx.ownerToken}` },
      payload: {
        name: { en: "X", ar: "" }, code: "GEO1", address: { en: "x", ar: "" },
        latitude: 25.4052,
      },
    });
    expect(res.statusCode).toBe(422);
  });

  it("rejects out-of-range coordinates", async () => {
    const res = await app.inject({
      method: "POST", url: "/branches", headers: { authorization: `Bearer ${ctx.ownerToken}` },
      payload: {
        name: { en: "X", ar: "" }, code: "GEO2", address: { en: "x", ar: "" },
        geo: { latitude: 999, longitude: 55.4 },
      },
    });
    expect(res.statusCode).toBe(422);
  });

  it("accepts a valid geo pair", async () => {
    const res = await app.inject({
      method: "POST", url: "/branches", headers: { authorization: `Bearer ${ctx.ownerToken}` },
      payload: {
        name: { en: "X", ar: "" }, code: "GEO3", address: { en: "x", ar: "" },
        geo: { latitude: 25.4052, longitude: 55.5136 },
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().branch.geo).toEqual({ latitude: 25.4052, longitude: 55.5136 });
  });

  it("rejects malformed working-hours times", async () => {
    const res = await app.inject({
      method: "POST", url: "/branches", headers: { authorization: `Bearer ${ctx.ownerToken}` },
      payload: {
        name: { en: "X", ar: "" }, code: "WH1", address: { en: "x", ar: "" },
        working_hours: { mon: { open: "9am", close: "22:00" } },
      },
    });
    expect(res.statusCode).toBe(422);
  });

  it("rejects a working-hours day where open is after close", async () => {
    const res = await app.inject({
      method: "POST", url: "/branches", headers: { authorization: `Bearer ${ctx.ownerToken}` },
      payload: {
        name: { en: "X", ar: "" }, code: "WH2", address: { en: "x", ar: "" },
        working_hours: { mon: { open: "22:00", close: "09:00" } },
      },
    });
    expect(res.statusCode).toBe(422);
  });

  it("rejects an unknown working-hours day key", async () => {
    const res = await app.inject({
      method: "POST", url: "/branches", headers: { authorization: `Bearer ${ctx.ownerToken}` },
      payload: {
        name: { en: "X", ar: "" }, code: "WH3", address: { en: "x", ar: "" },
        working_hours: { sund: { open: "09:00", close: "22:00" } },
      },
    });
    expect(res.statusCode).toBe(422);
  });

  it("accepts valid working hours including a closed day", async () => {
    const res = await app.inject({
      method: "POST", url: "/branches", headers: { authorization: `Bearer ${ctx.ownerToken}` },
      payload: {
        name: { en: "X", ar: "" }, code: "WH4", address: { en: "x", ar: "" },
        working_hours: {
          sun: { open: "08:00", close: "22:00" },
          fri: null,
        },
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().branch.working_hours.fri).toBeNull();
  });

  it("rejects manager_user_id that is not a member of the business", async () => {
    const res = await app.inject({
      method: "POST", url: "/branches", headers: { authorization: `Bearer ${ctx.ownerToken}` },
      payload: {
        name: { en: "X", ar: "" }, code: "MGR1", address: { en: "x", ar: "" },
        manager_user_id: 999999,
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().details.field).toBe("manager_user_id");
  });

  it("accepts the owner's own user id as manager_user_id", async () => {
    const res = await app.inject({
      method: "POST", url: "/branches", headers: { authorization: `Bearer ${ctx.ownerToken}` },
      payload: {
        name: { en: "X", ar: "" }, code: "MGR2", address: { en: "x", ar: "" },
        manager_user_id: ctx.userId,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().branch.manager_user_id).toBe(ctx.userId);
  });

  it("rejects unknown top-level fields, including an attempted business_id override", async () => {
    const res = await app.inject({
      method: "POST", url: "/branches", headers: { authorization: `Bearer ${ctx.ownerToken}` },
      payload: {
        name: { en: "X", ar: "" }, code: "OVR1", address: { en: "x", ar: "" },
        business_id: 999999,
        id: 1,
      },
    });
    expect(res.statusCode).toBe(422);
  });

  it("an empty PATCH body is rejected", async () => {
    const res = await app.inject({
      method: "PATCH", url: `/branches/${ctx.homeBranchId}`,
      headers: { authorization: `Bearer ${ctx.ownerToken}` },
      payload: {},
    });
    expect(res.statusCode).toBe(422);
  });
});

describe("A03: injection resistance", () => {
  let app: FastifyInstance;
  let ctx: Ctx;

  beforeAll(async () => { await ensureMigrated(); app = await buildApp(); });
  beforeEach(async () => { await truncateAll(); ctx = await setup(); });
  afterAll(async () => { await app.close(); await teardown(); });

  const sqlPayloads = [
    "' OR '1'='1",
    "'; DROP TABLE branches; --",
    "1'; DELETE FROM orders WHERE 1=1; --",
    "' UNION SELECT * FROM users --",
  ];

  it.each(sqlPayloads)("branch search term %s is treated as data", async (payload) => {
    const res = await app.inject({
      method: "GET", url: `/branches?q=${encodeURIComponent(payload)}`,
      headers: { authorization: `Bearer ${ctx.ownerToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().data)).toBe(true);

    const check = await app.inject({ method: "GET", url: "/branches", headers: { authorization: `Bearer ${ctx.ownerToken}` } });
    expect(check.json().data.length).toBeGreaterThanOrEqual(1);
  });

  it.each(["1 OR 1=1", "abc", "-1", "1.5", "null"])(
    "malformed branch id %s never reaches SQL as executable",
    async (badId) => {
      const res = await app.inject({
        method: "GET", url: `/branches/${encodeURIComponent(badId)}`,
        headers: { authorization: `Bearer ${ctx.ownerToken}` },
      });
      expect([400, 404, 422]).toContain(res.statusCode);
      expect(res.statusCode).not.toBe(500);
    },
  );

  it("a hostile branch code is rejected by the character-class schema before reaching SQL", async () => {
    const res = await app.inject({
      method: "POST", url: "/branches", headers: { authorization: `Bearer ${ctx.ownerToken}` },
      payload: {
        name: { en: "X", ar: "" },
        code: "'; DROP TABLE branches; --",
        address: { en: "x", ar: "" },
      },
    });
    expect(res.statusCode).toBe(422);
  });

  it("a hostile value inside the bilingual name is stored and returned as inert JSON, not executed", async () => {
    const xss = "<script>alert(1)</script>";
    const res = await app.inject({
      method: "POST", url: "/branches", headers: { authorization: `Bearer ${ctx.ownerToken}` },
      payload: { name: { en: xss, ar: "" }, code: "XSS1", address: { en: "x", ar: "" } },
    });
    expect(res.statusCode).toBe(201);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.json().branch.name.en).toBe(xss);
  });
});
