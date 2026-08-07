/**
 * A01: Business Settings tenant isolation.
 *
 * This module has no per-resource `:id` in its URLs — it's a singleton
 * scoped implicitly by `auth.businessId` from the JWT, never a client-
 * supplied value — so the classic "IDOR by guessing another tenant's id"
 * vector doesn't exist here the way it does for `/customers/:id` etc. What
 * still needs proving: (1) RLS holds at the database layer even if
 * application code ever had a bug and passed the wrong business id, and
 * (2) two tenants' settings never cross at the HTTP layer under normal
 * operation.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/api.js";
import { login, signupOwnerAndBusiness } from "../../src/modules/auth/service.js";
import { withTenant } from "../../src/lib/db.js";
import * as repo from "../../src/modules/settings/repository.js";
import { ensureMigrated, teardown, truncateAll } from "../helpers/harness.js";

const PW = "correct-horse-battery-staple";

interface Tenant {
  businessId: number;
  userId: number;
  token: string;
}

function auth(t: { token: string }) {
  return { authorization: `Bearer ${t.token}` };
}

async function seedTenant(slug: string): Promise<Tenant> {
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
  return { businessId: signup.business.id, userId: signup.user.id, token: session.access_token };
}

describe("A01: business_settings is created automatically and is tenant-isolated", () => {
  let app: FastifyInstance;
  let alpha: Tenant;
  let beta: Tenant;

  beforeAll(async () => { await ensureMigrated(); app = await buildApp(); });
  beforeEach(async () => {
    await truncateAll();
    alpha = await seedTenant("alpha");
    beta = await seedTenant("beta");
  });
  afterAll(async () => { await app.close(); await teardown(); });

  it("every business gets exactly one business_settings row from signup, with no extra work", async () => {
    const row = await withTenant({ businessId: alpha.businessId, userId: alpha.userId }, (trx) =>
      repo.getCombined(trx, alpha.businessId),
    );
    expect(row).toBeDefined();
    expect(row!.business_id).toBe(alpha.businessId);
  });

  it("tenant A cannot read tenant B's settings row, even by explicit business id, under A's own RLS session", async () => {
    const row = await withTenant({ businessId: alpha.businessId, userId: alpha.userId }, (trx) =>
      repo.getCombined(trx, beta.businessId),
    );
    expect(row).toBeUndefined();
  });

  it("tenant A cannot write tenant B's settings row under A's own RLS session", async () => {
    await withTenant({ businessId: alpha.businessId, userId: alpha.userId }, (trx) =>
      repo.updateSettings(trx, beta.businessId, { vat_pct: 99, updated_by_user_id: alpha.userId }),
    );
    // The UPDATE affected zero rows (RLS filtered it out) — verify B's
    // value is untouched from B's own session.
    const bRow = await withTenant({ businessId: beta.businessId, userId: beta.userId }, (trx) =>
      repo.getCombined(trx, beta.businessId),
    );
    expect(Number(bRow!.vat_pct)).toBe(5);
  });

  it("GET /settings/business only ever returns the caller's own business — HTTP layer", async () => {
    // Give alpha a distinctive value, confirm beta never sees it.
    await app.inject({
      method: "PATCH", url: "/settings/business", headers: auth(alpha),
      payload: { vat_pct: 12.5 },
    });

    const alphaRes = await app.inject({ method: "GET", url: "/settings/business", headers: auth(alpha) });
    const betaRes = await app.inject({ method: "GET", url: "/settings/business", headers: auth(beta) });

    expect(alphaRes.json().settings.vat_pct).toBe(12.5);
    expect(betaRes.json().settings.vat_pct).toBe(5);   // untouched default
  });

  it("delivery_fee specifically respects the same tenant boundary as every other settings field", async () => {
    // The new column added in this task — proven independently rather than
    // assumed to inherit the whole-row isolation the tests above already
    // establish for the table in general.
    await app.inject({
      method: "PATCH", url: "/settings/business", headers: auth(alpha),
      payload: { delivery_fee: 77 },
    });

    const alphaRes = await app.inject({ method: "GET", url: "/settings/business", headers: auth(alpha) });
    const betaRes = await app.inject({ method: "GET", url: "/settings/business", headers: auth(beta) });

    expect(alphaRes.json().settings.delivery_fee).toBe(77);
    expect(betaRes.json().settings.delivery_fee).toBe(15);   // untouched default, unaffected by alpha's change
  });

  it("PATCH /settings/business from tenant B never affects tenant A's row", async () => {
    await app.inject({
      method: "PATCH", url: "/settings/business", headers: auth(beta),
      payload: { vat_pct: 20 },
    });

    const alphaRes = await app.inject({ method: "GET", url: "/settings/business", headers: auth(alpha) });
    expect(alphaRes.json().settings.vat_pct).toBe(5);
  });

  it("INSERT of a second business_settings row for the same business is rejected by UNIQUE(business_id)", async () => {
    await expect(
      withTenant({ businessId: alpha.businessId, userId: alpha.userId }, (trx) =>
        repo.insertDefault(trx, alpha.businessId),
      ),
    ).rejects.toThrow();
  });
});
