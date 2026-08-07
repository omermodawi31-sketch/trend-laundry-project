/**
 * A01 + A03: Business Settings endpoint authorization, input validation,
 * and injection resistance.
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
}

async function setup(): Promise<Ctx> {
  const signup = await signupOwnerAndBusiness(
    {
      business: { name: { en: "AuthZ Settings", ar: "إعدادات" } },
      owner: { email: "owner@example.com", full_name: "Owner", password: PW },
      branch: { name: { en: "Main", ar: "الرئيسية" }, code: "SZ1", address: { en: "x", ar: "س" } },
    },
    { ipAddress: null, userAgent: null },
  );
  const session = await login({ email: "owner@example.com", password: PW }, { ipAddress: null, userAgent: null });
  return { ownerToken: session.access_token, businessId: signup.business.id, userId: signup.user.id };
}

function tokenWithPerms(ctx: Ctx, perms: string[], role = "driver"): string {
  return signAccessToken({
    sub: String(ctx.userId), biz: String(ctx.businessId), role,
    branches: [], perms, sess: "test-session", email: "owner@example.com",
  });
}

describe("A01: settings requires authentication and permission", () => {
  let app: FastifyInstance;
  let ctx: Ctx;

  beforeAll(async () => { await ensureMigrated(); app = await buildApp(); });
  beforeEach(async () => { await truncateAll(); ctx = await setup(); });
  afterAll(async () => { await app.close(); await teardown(); });

  it("GET returns 401 without a token", async () => {
    const res = await app.inject({ method: "GET", url: "/settings/business" });
    expect(res.statusCode).toBe(401);
  });

  it("PATCH returns 401 without a token", async () => {
    const res = await app.inject({ method: "PATCH", url: "/settings/business", payload: { vat_pct: 10 } });
    expect(res.statusCode).toBe(401);
  });

  it("settings.read alone can GET but not PATCH", async () => {
    const readOnly = tokenWithPerms(ctx, ["settings.read"], "manager");
    const get = await app.inject({ method: "GET", url: "/settings/business", headers: { authorization: `Bearer ${readOnly}` } });
    expect(get.statusCode).toBe(200);

    const patch = await app.inject({
      method: "PATCH", url: "/settings/business",
      headers: { authorization: `Bearer ${readOnly}` }, payload: { vat_pct: 10 },
    });
    expect(patch.statusCode).toBe(403);
  });

  it("a token with no settings permissions gets 403 on both endpoints", async () => {
    const none = tokenWithPerms(ctx, ["orders.read"], "cashier");
    const get = await app.inject({ method: "GET", url: "/settings/business", headers: { authorization: `Bearer ${none}` } });
    expect(get.statusCode).toBe(403);
    const patch = await app.inject({
      method: "PATCH", url: "/settings/business",
      headers: { authorization: `Bearer ${none}` }, payload: { vat_pct: 10 },
    });
    expect(patch.statusCode).toBe(403);
  });

  it("client-supplied permission headers are ignored", async () => {
    const weak = tokenWithPerms(ctx, ["orders.read"]);
    const res = await app.inject({
      method: "PATCH", url: "/settings/business",
      headers: {
        authorization: `Bearer ${weak}`,
        "x-permissions": "settings.business.edit",
        "x-role": "owner",
      },
      payload: { vat_pct: 10 },
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

  function patch(payload: unknown) {
    return app.inject({
      method: "PATCH", url: "/settings/business",
      headers: { authorization: `Bearer ${ctx.ownerToken}` }, payload,
    });
  }

  it("rejects VAT percentage out of range", async () => {
    expect((await patch({ vat_pct: -1 })).statusCode).toBe(422);
    expect((await patch({ vat_pct: 101 })).statusCode).toBe(422);
  });

  it("accepts a valid VAT percentage at the boundary", async () => {
    expect((await patch({ vat_pct: 0 })).statusCode).toBe(200);
    expect((await patch({ vat_pct: 100 })).statusCode).toBe(200);
  });

  it("rejects a negative express surcharge", async () => {
    expect((await patch({ express_pct: -5 })).statusCode).toBe(422);
  });

  it("rejects a negative delivery fee", async () => {
    expect((await patch({ delivery_fee: -1 })).statusCode).toBe(422);
  });

  it("accepts a valid delivery fee at zero (free delivery is a legitimate business choice)", async () => {
    expect((await patch({ delivery_fee: 0 })).statusCode).toBe(200);
  });

  it("rejects a malformed hex color", async () => {
    for (const bad of ["blue", "#12345", "#GGGGGG", "123456"]) {
      const res = await patch({ primary_color: bad });
      expect(res.statusCode, `color=${bad}`).toBe(422);
    }
  });

  it("accepts a valid hex color", async () => {
    const res = await patch({ primary_color: "#1A73E8" });
    expect(res.statusCode).toBe(200);
    expect(res.json().settings.primary_color).toBe("#1A73E8");
  });

  it("rejects an invalid theme value", async () => {
    const res = await patch({ theme: "purple" });
    expect(res.statusCode).toBe(422);
  });

  it("rejects a malformed email", async () => {
    const res = await patch({ email: "not-an-email" });
    expect(res.statusCode).toBe(422);
  });

  it("rejects a malformed website URL", async () => {
    const res = await patch({ website: "not a url" });
    expect(res.statusCode).toBe(422);
  });

  it("rejects a 2-letter currency code", async () => {
    const res = await patch({ currency: "AE" });
    expect(res.statusCode).toBe(422);
  });

  it("accepts a lowercase currency code and normalises it to uppercase", async () => {
    const res = await patch({ currency: "aed" });
    expect(res.statusCode).toBe(200);
    expect(res.json().settings.currency).toBe("AED");
  });

  it("rejects a language other than en/ar", async () => {
    const res = await patch({ language: "fr" });
    expect(res.statusCode).toBe(422);
  });

  it("rejects a malformed timezone", async () => {
    const res = await patch({ timezone: "not a timezone" });
    expect(res.statusCode).toBe(422);
  });

  it("rejects an unknown social platform key", async () => {
    const res = await patch({ social_links: { myspace: "https://myspace.com/x" } });
    expect(res.statusCode).toBe(422);
  });

  it("accepts known social platform keys", async () => {
    const res = await patch({ social_links: { instagram: "https://instagram.com/trendlaundry", whatsapp: "https://wa.me/971501234567" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().settings.social_links.instagram).toBe("https://instagram.com/trendlaundry");
  });

  it("rejects unknown top-level fields, including an attempted business_id override", async () => {
    const res = await patch({ vat_pct: 10, business_id: 999999, id: 1 });
    expect(res.statusCode).toBe(422);
  });

  it("rejects an empty PATCH body", async () => {
    const res = await patch({});
    expect(res.statusCode).toBe(422);
  });

  it("clearing an optional field with null works", async () => {
    await patch({ logo_url: "https://cdn.example.com/logo.png" });
    const res = await patch({ logo_url: null });
    expect(res.statusCode).toBe(200);
    expect(res.json().settings.logo_url).toBeNull();
  });
});

describe("A03: injection resistance", () => {
  let app: FastifyInstance;
  let ctx: Ctx;

  beforeAll(async () => { await ensureMigrated(); app = await buildApp(); });
  beforeEach(async () => { await truncateAll(); ctx = await setup(); });
  afterAll(async () => { await app.close(); await teardown(); });

  it("a hostile value in legal_name is stored and returned as inert JSON, not executed", async () => {
    const xss = "<script>alert(1)</script>";
    const res = await app.inject({
      method: "PATCH", url: "/settings/business",
      headers: { authorization: `Bearer ${ctx.ownerToken}` },
      payload: { legal_name: { en: xss, ar: "" } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.json().settings.legal_name.en).toBe(xss);
  });

  it("a SQL-payload-shaped legal_name is stored and returned as inert data, never executed", async () => {
    const payload = "'; DROP TABLE business_settings; --";
    const res = await app.inject({
      method: "PATCH", url: "/settings/business",
      headers: { authorization: `Bearer ${ctx.ownerToken}` },
      payload: { legal_name: { en: payload, ar: "" } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().settings.legal_name.en).toBe(payload);

    // The table must still be alive and queryable.
    const check = await app.inject({ method: "GET", url: "/settings/business", headers: { authorization: `Bearer ${ctx.ownerToken}` } });
    expect(check.statusCode).toBe(200);
  });

  it("a SQL-payload-shaped receipt_header is stored and returned as inert data", async () => {
    const payload = "1'; DELETE FROM businesses WHERE 1=1; --";
    const res = await app.inject({
      method: "PATCH", url: "/settings/business",
      headers: { authorization: `Bearer ${ctx.ownerToken}` },
      payload: { receipt_header: { en: payload, ar: "" } },
    });
    expect(res.statusCode).toBe(200);

    const check = await app.inject({ method: "GET", url: "/settings/business", headers: { authorization: `Bearer ${ctx.ownerToken}` } });
    expect(check.statusCode).toBe(200);
    expect(check.json().settings.receipt_header.en).toBe(payload);
  });
});
