/**
 * A01: Branches tenant isolation, branch-scope enforcement, and IDOR
 * resistance.
 *
 * Three properties under test:
 *
 *   1. RLS tenant isolation — identical shape to every other module's suite:
 *      tenant A cannot see, update, or delete tenant B's branch, even by
 *      exact primary key.
 *
 *   2. Branch-scope rules specific to this module (see branch-scope.ts):
 *        - CREATE requires all-branch access. A manager scoped to branch 3
 *          cannot create branch 7.
 *        - UPDATE / ENABLE-DISABLE / DELETE / RESTORE require the TARGET
 *          branch to be in the caller's scope.
 *        - READ (list, get) is business-wide regardless of scope — a
 *          deliberate divergence from the orders module, tested explicitly
 *          so a future change to that decision shows up as a failing test
 *          rather than a silent behaviour change.
 *
 *   3. IDOR resistance — cross-tenant and out-of-scope both surface as 404
 *      (for get/update/delete) or 403 (for a scope failure the caller could
 *      already infer, e.g. create) — never a 403 that would confirm another
 *      tenant's row exists.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/api.js";
import { login, signupOwnerAndBusiness } from "../../src/modules/auth/service.js";
import { withTenant } from "../../src/lib/db.js";
import { signAccessToken } from "../../src/lib/jwt.js";
import * as repo from "../../src/modules/branches/repository.js";
import { ensureMigrated, teardown, truncateAll } from "../helpers/harness.js";

const PW = "correct-horse-battery-staple";

interface Tenant {
  businessId: number;
  userId: number;
  token: string;
  homeBranchId: number;   // created by signup
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

  const branchRow = await withTenant({ businessId: signup.business.id, userId: signup.user.id }, (trx) =>
    trx.selectFrom("branches").select("id").where("business_id", "=", signup.business.id).executeTakeFirstOrThrow(),
  );

  return {
    businessId: signup.business.id,
    userId: signup.user.id,
    token: session.access_token,
    homeBranchId: branchRow.id,
  };
}

function scopedToken(t: Tenant, branchIds: number[], perms: string[], role = "manager"): string {
  return signAccessToken({
    sub: String(t.userId), biz: String(t.businessId), role,
    branches: branchIds, perms, sess: "test-session", email: "scoped@example.com",
  });
}

/* ---------------------------------------------------------------------- */

describe("A01: branches tenant isolation (database layer)", () => {
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

  it("tenant A's branch list contains only A's branches", async () => {
    const rows = await withTenant({ businessId: alpha.businessId, userId: alpha.userId }, (trx) =>
      repo.list(trx, alpha.businessId, {}),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(alpha.homeBranchId);
  });

  it("tenant A cannot read tenant B's branch by primary key", async () => {
    const row = await withTenant({ businessId: alpha.businessId, userId: alpha.userId }, (trx) =>
      repo.findById(trx, beta.homeBranchId),
    );
    expect(row).toBeUndefined();
  });

  it("tenant A cannot UPDATE tenant B's branch", async () => {
    const updated = await withTenant({ businessId: alpha.businessId, userId: alpha.userId }, (trx) =>
      repo.update(trx, beta.homeBranchId, { sort_order: 99, updated_by_user_id: alpha.userId }),
    );
    expect(updated).toBeUndefined();

    const bRow = await withTenant({ businessId: beta.businessId, userId: beta.userId }, (trx) =>
      repo.findById(trx, beta.homeBranchId),
    );
    expect(bRow!.sort_order).toBe(0);
  });

  it("tenant A cannot soft-delete tenant B's branch", async () => {
    const deleted = await withTenant({ businessId: alpha.businessId, userId: alpha.userId }, (trx) =>
      repo.softDelete(trx, beta.homeBranchId, alpha.userId),
    );
    expect(deleted).toBeUndefined();

    const bRow = await withTenant({ businessId: beta.businessId, userId: beta.userId }, (trx) =>
      repo.findById(trx, beta.homeBranchId),
    );
    expect(bRow!.deleted_at).toBeNull();
  });

  it("INSERT with another tenant's business_id is rejected by the RLS WITH CHECK clause", async () => {
    await expect(
      withTenant({ businessId: alpha.businessId, userId: alpha.userId }, (trx) =>
        repo.insert(trx, {
          business_id: beta.businessId,   // hostile value
          name: { en: "Injected", ar: "مدسوس" },
          code: "HACK1",
          address: { en: "x", ar: "س" },
          created_by_user_id: alpha.userId,
        }),
      ),
    ).rejects.toThrow();
  });
});

/* ---------------------------------------------------------------------- */

describe("A01: IDOR resistance (HTTP layer)", () => {
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

  it("GET another tenant's branch returns 404, never 403", async () => {
    const res = await app.inject({
      method: "GET", url: `/branches/${beta.homeBranchId}`,
      headers: auth(alpha),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("not-found");
  });

  it("PATCH another tenant's branch returns 404", async () => {
    const res = await app.inject({
      method: "PATCH", url: `/branches/${beta.homeBranchId}`,
      headers: auth(alpha), payload: { sort_order: 5 },
    });
    expect(res.statusCode).toBe(404);
  });

  it("DELETE another tenant's branch returns 404", async () => {
    const res = await app.inject({
      method: "DELETE", url: `/branches/${beta.homeBranchId}`,
      headers: auth(alpha),
    });
    expect(res.statusCode).toBe(404);
  });

  it("enable/disable another tenant's branch returns 404", async () => {
    const res = await app.inject({
      method: "POST", url: `/branches/${beta.homeBranchId}/status`,
      headers: auth(alpha), payload: { is_active: false },
    });
    expect(res.statusCode).toBe(404);
  });

  it("listing never includes another tenant's branches", async () => {
    const res = await app.inject({ method: "GET", url: "/branches", headers: auth(alpha) });
    expect(res.statusCode).toBe(200);
    const ids = res.json().data.map((b: { id: number }) => b.id);
    expect(ids).not.toContain(beta.homeBranchId);
  });
});

/* ---------------------------------------------------------------------- */

describe("A01: branch-scope rules — create is all-branch-only", () => {
  let app: FastifyInstance;
  let tenant: Tenant;

  beforeAll(async () => { await ensureMigrated(); app = await buildApp(); });
  beforeEach(async () => { await truncateAll(); tenant = await seedTenant("scope"); });
  afterAll(async () => { await app.close(); await teardown(); });

  it("a manager scoped to a single branch cannot create a new branch", async () => {
    const scoped = scopedToken(tenant, [tenant.homeBranchId], ["settings.branches.edit", "settings.read"]);
    const res = await app.inject({
      method: "POST", url: "/branches",
      headers: { authorization: `Bearer ${scoped}` },
      payload: { name: { en: "New Branch", ar: "" }, code: "NEW1", address: { en: "x", ar: "" } },
    });
    expect(res.statusCode).toBe(403);
  });

  it("an all-branch owner can create a new branch", async () => {
    const res = await app.inject({
      method: "POST", url: "/branches", headers: auth(tenant),
      payload: { name: { en: "New Branch", ar: "" }, code: "NEW1", address: { en: "x", ar: "" } },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().branch.code).toBe("NEW1");
  });

  it("an all-branch MANAGER (empty branch_ids) can also create — scope, not role, gates this", async () => {
    const allBranchManager = scopedToken(tenant, [], ["settings.branches.edit", "settings.read"]);
    const res = await app.inject({
      method: "POST", url: "/branches",
      headers: { authorization: `Bearer ${allBranchManager}` },
      payload: { name: { en: "New Branch 2", ar: "" }, code: "NEW2", address: { en: "x", ar: "" } },
    });
    expect(res.statusCode).toBe(201);
  });
});

/* ---------------------------------------------------------------------- */

describe("A01: branch-scope rules — manage requires the target branch in scope", () => {
  let app: FastifyInstance;
  let tenant: Tenant;
  let secondBranchId: number;

  beforeAll(async () => { await ensureMigrated(); app = await buildApp(); });
  beforeEach(async () => {
    await truncateAll();
    tenant = await seedTenant("manage");
    const created = await app.inject({
      method: "POST", url: "/branches", headers: auth(tenant),
      payload: { name: { en: "Second", ar: "" }, code: "SEC1", address: { en: "x", ar: "" } },
    });
    secondBranchId = created.json().branch.id;
  });
  afterAll(async () => { await app.close(); await teardown(); });

  it("a manager scoped to branch A cannot update branch B", async () => {
    const scoped = scopedToken(tenant, [tenant.homeBranchId], ["settings.branches.edit", "settings.read"]);
    const res = await app.inject({
      method: "PATCH", url: `/branches/${secondBranchId}`,
      headers: { authorization: `Bearer ${scoped}` },
      payload: { sort_order: 3 },
    });
    expect(res.statusCode).toBe(403);
  });

  it("a manager scoped to branch A CAN update branch A", async () => {
    const scoped = scopedToken(tenant, [tenant.homeBranchId], ["settings.branches.edit", "settings.read"]);
    const res = await app.inject({
      method: "PATCH", url: `/branches/${tenant.homeBranchId}`,
      headers: { authorization: `Bearer ${scoped}` },
      payload: { sort_order: 3 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().branch.sort_order).toBe(3);
  });

  it("a manager scoped to branch A cannot disable branch B", async () => {
    const scoped = scopedToken(tenant, [tenant.homeBranchId], ["settings.branches.edit", "settings.read"]);
    const res = await app.inject({
      method: "POST", url: `/branches/${secondBranchId}/status`,
      headers: { authorization: `Bearer ${scoped}` },
      payload: { is_active: false },
    });
    expect(res.statusCode).toBe(403);
  });

  it("a manager scoped to branch A cannot delete branch B", async () => {
    const scoped = scopedToken(tenant, [tenant.homeBranchId], ["settings.branches.edit", "settings.read"]);
    const res = await app.inject({
      method: "DELETE", url: `/branches/${secondBranchId}`,
      headers: { authorization: `Bearer ${scoped}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("a manager scoped to BOTH branches can manage either", async () => {
    const scoped = scopedToken(tenant, [tenant.homeBranchId, secondBranchId], ["settings.branches.edit", "settings.read"]);
    const a = await app.inject({
      method: "PATCH", url: `/branches/${tenant.homeBranchId}`,
      headers: { authorization: `Bearer ${scoped}` }, payload: { sort_order: 1 },
    });
    const b = await app.inject({
      method: "PATCH", url: `/branches/${secondBranchId}`,
      headers: { authorization: `Bearer ${scoped}` }, payload: { sort_order: 2 },
    });
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
  });
});

/* ---------------------------------------------------------------------- */

describe("A01: read visibility is business-wide regardless of scope (deliberate divergence)", () => {
  let app: FastifyInstance;
  let tenant: Tenant;
  let secondBranchId: number;

  beforeAll(async () => { await ensureMigrated(); app = await buildApp(); });
  beforeEach(async () => {
    await truncateAll();
    tenant = await seedTenant("readwide");
    const created = await app.inject({
      method: "POST", url: "/branches", headers: auth(tenant),
      payload: { name: { en: "Second", ar: "" }, code: "SEC1", address: { en: "x", ar: "" } },
    });
    secondBranchId = created.json().branch.id;
  });
  afterAll(async () => { await app.close(); await teardown(); });

  it("a manager scoped to only branch A can still GET branch B directly", async () => {
    const scoped = scopedToken(tenant, [tenant.homeBranchId], ["settings.read"]);
    const res = await app.inject({
      method: "GET", url: `/branches/${secondBranchId}`,
      headers: { authorization: `Bearer ${scoped}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().branch.id).toBe(secondBranchId);
  });

  it("a manager scoped to only branch A sees BOTH branches in the list", async () => {
    const scoped = scopedToken(tenant, [tenant.homeBranchId], ["settings.read"]);
    const res = await app.inject({
      method: "GET", url: "/branches",
      headers: { authorization: `Bearer ${scoped}` },
    });
    expect(res.statusCode).toBe(200);
    const ids = res.json().data.map((b: { id: number }) => b.id);
    expect(ids).toContain(tenant.homeBranchId);
    expect(ids).toContain(secondBranchId);
  });
});
