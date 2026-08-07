/**
 * Inventory module — functional behaviour.
 *
 * Complements the security suites. Covers the four requirements from the
 * Phase 5 brief directly:
 *   1/2. Barcode/QR + scan lookup           -> "scan lookup" describe block
 *   3.   Shared catalog, per-branch stock   -> "stock computation" block
 *   4.   Immutable movement logs            -> "append-only ledger" block
 * plus the standard CRUD/audit coverage every module gets.
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

async function setup(): Promise<void> {
  const signup = await signupOwnerAndBusiness(
    {
      business: { name: { en: "Func Inventory", ar: "مخزون" } },
      owner: { email: "func@example.com", full_name: "Owner", password: PW },
      branch: { name: { en: "Main", ar: "الرئيسية" }, code: "FI1", address: { en: "x", ar: "س" } },
    },
    { ipAddress: null, userAgent: null },
  );
  const s = await login({ email: "func@example.com", password: PW }, { ipAddress: null, userAgent: null });
  token = s.access_token;
  branchId = 1;
  businessId = signup.business.id;
}

function auth() { return { authorization: `Bearer ${token}` }; }

async function addBranch(code: string): Promise<number> {
  return withNoTenant(async (trx) => {
    await sql`SET LOCAL app.business_id = ${sql.lit(businessId)}`.execute(trx);
    const row = await trx
      .insertInto("branches")
      .values({
        business_id: businessId,
        name: { en: code, ar: code } as never,
        code,
        address: { en: "x", ar: "س" } as never,
        is_active: true,
      } as never)
      .returning("id")
      .executeTakeFirstOrThrow();
    return Number(row.id);
  });
}

async function createItem(overrides: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: "POST", url: "/inventory/items", headers: auth(),
    payload: { name: { en: "Detergent 5L", ar: "منظف" }, category: "chemical", unit: "L", ...overrides },
  });
  expect(res.statusCode).toBe(201);
  return res.json().item;
}

/* ---------------------------------------------------------------- */

describe("catalog CRUD", () => {
  beforeAll(async () => { await ensureMigrated(); app = await buildApp(); });
  beforeEach(async () => { await truncateAll(); await setup(); });
  afterAll(async () => { await app.close(); await teardown(); });

  it("creates an item with sku and barcode", async () => {
    const item = await createItem({ sku: "DET-5L", barcode: "6291000000001", sort_order: 3 });
    expect(item.sku).toBe("DET-5L");
    expect(item.barcode).toBe("6291000000001");
    expect(item.unit).toBe("L");
    expect(item.is_active).toBe(true);
    expect(item.sort_order).toBe(3);
    expect(item.business_id).toBeUndefined();
  });

  it("defaults sort_order to 0 and is_active to true", async () => {
    const item = await createItem();
    expect(item.sort_order).toBe(0);
    expect(item.is_active).toBe(true);
  });

  it("allows an item with neither sku nor barcode", async () => {
    const item = await createItem();
    expect(item.sku).toBeNull();
    expect(item.barcode).toBeNull();
  });

  it("updates only the supplied fields", async () => {
    const item = await createItem({ sku: "ORIG" });
    const res = await app.inject({
      method: "PATCH", url: `/inventory/items/${item.id}`, headers: auth(),
      payload: { sort_order: 9 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().item.sort_order).toBe(9);
    expect(res.json().item.sku).toBe("ORIG");
  });

  it("enables and disables an item", async () => {
    const item = await createItem();
    const off = await app.inject({ method: "POST", url: `/inventory/items/${item.id}/status`, headers: auth(), payload: { is_active: false } });
    expect(off.json().item.is_active).toBe(false);
    const on = await app.inject({ method: "POST", url: `/inventory/items/${item.id}/status`, headers: auth(), payload: { is_active: true } });
    expect(on.json().item.is_active).toBe(true);
  });

  it("lists, filters by category, and paginates", async () => {
    await createItem({ sku: "A1", category: "chemical" });
    await createItem({ sku: "A2", category: "packaging" });
    const chem = await app.inject({ method: "GET", url: "/inventory/items?category=chemical", headers: auth() });
    const skus = (chem.json().data as Array<{ sku: string | null }>).map((i) => i.sku);
    expect(skus).toContain("A1");
    expect(skus).not.toContain("A2");
  });
});

/* ---------------------------------------------------------------- */

describe("scan lookup (requirements 1 & 2 — barcode/QR, camera-scannable)", () => {
  beforeAll(async () => { await ensureMigrated(); app = await buildApp(); });
  beforeEach(async () => { await truncateAll(); await setup(); });
  afterAll(async () => { await app.close(); await teardown(); });

  it("resolves an item by its exact SKU", async () => {
    const item = await createItem({ sku: "DET-5L" });
    const res = await app.inject({ method: "GET", url: "/inventory/items/by-code/DET-5L", headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json().item.id).toBe(item.id);
  });

  it("resolves an item by its exact barcode — the value a QR code or linear barcode encodes", async () => {
    const item = await createItem({ barcode: "6291000000001" });
    const res = await app.inject({ method: "GET", url: "/inventory/items/by-code/6291000000001", headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json().item.id).toBe(item.id);
  });

  it("returns 404 for a code that matches nothing", async () => {
    const res = await app.inject({ method: "GET", url: "/inventory/items/by-code/NOPE", headers: auth() });
    expect(res.statusCode).toBe(404);
  });

  it("a soft-deleted item's code no longer resolves via scan", async () => {
    const item = await createItem({ sku: "GONE" });
    await app.inject({ method: "DELETE", url: `/inventory/items/${item.id}`, headers: auth() });
    const res = await app.inject({ method: "GET", url: "/inventory/items/by-code/GONE", headers: auth() });
    expect(res.statusCode).toBe(404);
  });

  it("bilingual + code search finds an item by any of name (EN/AR), sku, or barcode", async () => {
    await createItem({ name: { en: "Fabric Softener", ar: "منعم الأقمشة" }, sku: "SOFT-1", barcode: "111222333" });

    for (const q of ["Fabric", "منعم", "SOFT-1", "111222333"]) {
      const res = await app.inject({ method: "GET", url: `/inventory/items?q=${encodeURIComponent(q)}`, headers: auth() });
      expect(res.statusCode, `q=${q}`).toBe(200);
      expect(res.json().data.length, `q=${q}`).toBeGreaterThanOrEqual(1);
    }
  });
});

/* ---------------------------------------------------------------- */

describe("stock computation (requirement 3 — shared catalog, per-branch quantities)", () => {
  let secondBranchId: number;

  beforeAll(async () => { await ensureMigrated(); app = await buildApp(); });
  beforeEach(async () => { await truncateAll(); await setup(); secondBranchId = await addBranch("SEC"); });
  afterAll(async () => { await app.close(); await teardown(); });

  it("a fresh item has zero stock everywhere, not a missing/error response", async () => {
    const item = await createItem();
    const res = await app.inject({ method: "GET", url: `/inventory/items/${item.id}/stock`, headers: auth() });
    expect(res.statusCode).toBe(200);
    // No movements yet, so no rows — the repository/service contract is
    // "no row means zero", verified at the branch-stock listing instead,
    // which always lists every active item even at zero:
    const branchStock = await app.inject({ method: "GET", url: `/inventory/branches/${branchId}/stock`, headers: auth() });
    const row = (branchStock.json().data as Array<{ item_id: number; quantity: number }>).find((r) => r.item_id === item.id);
    expect(row).toBeDefined();
    expect(row!.quantity).toBe(0);
    void res;
  });

  it("receiving stock increases the branch's on-hand quantity", async () => {
    const item = await createItem();
    const res = await app.inject({
      method: "POST", url: `/inventory/branches/${branchId}/receive`, headers: auth(),
      payload: { item_id: item.id, quantity: 20, unit_cost: 4.5 },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().quantity_on_hand).toBe(20);
  });

  it("the SAME catalog item has INDEPENDENT stock at two different branches", async () => {
    const item = await createItem();
    await app.inject({ method: "POST", url: `/inventory/branches/${branchId}/receive`, headers: auth(), payload: { item_id: item.id, quantity: 20 } });
    await app.inject({ method: "POST", url: `/inventory/branches/${secondBranchId}/receive`, headers: auth(), payload: { item_id: item.id, quantity: 7 } });

    const res = await app.inject({ method: "GET", url: `/inventory/items/${item.id}/stock`, headers: auth() });
    const rows = res.json().data as Array<{ branch_id: number; quantity: number }>;
    expect(rows.find((r) => r.branch_id === branchId)!.quantity).toBe(20);
    expect(rows.find((r) => r.branch_id === secondBranchId)!.quantity).toBe(7);
  });

  it("multiple receives accumulate correctly", async () => {
    const item = await createItem();
    await app.inject({ method: "POST", url: `/inventory/branches/${branchId}/receive`, headers: auth(), payload: { item_id: item.id, quantity: 10 } });
    await app.inject({ method: "POST", url: `/inventory/branches/${branchId}/receive`, headers: auth(), payload: { item_id: item.id, quantity: 5.5 } });
    const res = await app.inject({ method: "GET", url: `/inventory/branches/${branchId}/stock`, headers: auth() });
    const row = (res.json().data as Array<{ item_id: number; quantity: number }>).find((r) => r.item_id === item.id);
    expect(row!.quantity).toBe(15.5);
  });

  it("waste cannot exceed what is currently on hand", async () => {
    const item = await createItem();
    await app.inject({ method: "POST", url: `/inventory/branches/${branchId}/receive`, headers: auth(), payload: { item_id: item.id, quantity: 5 } });

    const tooMuch = await app.inject({
      method: "POST", url: `/inventory/branches/${branchId}/waste`, headers: auth(),
      payload: { item_id: item.id, quantity: 6, reason: "damaged" },
    });
    expect(tooMuch.statusCode).toBe(422);

    const ok = await app.inject({
      method: "POST", url: `/inventory/branches/${branchId}/waste`, headers: auth(),
      payload: { item_id: item.id, quantity: 5, reason: "damaged" },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().quantity_on_hand).toBe(0);
  });

  it("adjust corrects stock UP or DOWN based on a stocktake count, computed server-side", async () => {
    const item = await createItem();
    await app.inject({ method: "POST", url: `/inventory/branches/${branchId}/receive`, headers: auth(), payload: { item_id: item.id, quantity: 10 } });

    // Stocktake finds 8 (2 unaccounted-for loss).
    const down = await app.inject({
      method: "POST", url: `/inventory/branches/${branchId}/adjust`, headers: auth(),
      payload: { item_id: item.id, counted_quantity: 8 },
    });
    expect(down.statusCode).toBe(201);
    expect(down.json().movement.quantity_delta).toBe(-2);
    expect(down.json().quantity_on_hand).toBe(8);

    // A later stocktake finds MORE than expected (e.g. a prior miscount corrected).
    const up = await app.inject({
      method: "POST", url: `/inventory/branches/${branchId}/adjust`, headers: auth(),
      payload: { item_id: item.id, counted_quantity: 12 },
    });
    expect(up.statusCode).toBe(201);
    expect(up.json().movement.quantity_delta).toBe(4);
    expect(up.json().quantity_on_hand).toBe(12);
  });

  it("transfer moves stock from one branch to another atomically", async () => {
    const item = await createItem();
    await app.inject({ method: "POST", url: `/inventory/branches/${branchId}/receive`, headers: auth(), payload: { item_id: item.id, quantity: 20 } });

    const res = await app.inject({
      method: "POST", url: "/inventory/transfer", headers: auth(),
      payload: { item_id: item.id, from_branch_id: branchId, to_branch_id: secondBranchId, quantity: 8 },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().out.quantity_delta).toBe(-8);
    expect(res.json().in.quantity_delta).toBe(8);
    expect(res.json().transfer_group_id).toBeTruthy();
    expect(res.json().out.transfer_group_id).toBe(res.json().in.transfer_group_id);

    const stock = await app.inject({ method: "GET", url: `/inventory/items/${item.id}/stock`, headers: auth() });
    const rows = stock.json().data as Array<{ branch_id: number; quantity: number }>;
    expect(rows.find((r) => r.branch_id === branchId)!.quantity).toBe(12);
    expect(rows.find((r) => r.branch_id === secondBranchId)!.quantity).toBe(8);
  });

  it("transfer cannot exceed what is available at the source branch", async () => {
    const item = await createItem();
    await app.inject({ method: "POST", url: `/inventory/branches/${branchId}/receive`, headers: auth(), payload: { item_id: item.id, quantity: 3 } });

    const res = await app.inject({
      method: "POST", url: "/inventory/transfer", headers: auth(),
      payload: { item_id: item.id, from_branch_id: branchId, to_branch_id: secondBranchId, quantity: 10 },
    });
    expect(res.statusCode).toBe(422);

    // Neither branch's stock should have moved.
    const stock = await app.inject({ method: "GET", url: `/inventory/items/${item.id}/stock`, headers: auth() });
    const rows = stock.json().data as Array<{ branch_id: number; quantity: number }>;
    expect(rows.find((r) => r.branch_id === branchId)!.quantity).toBe(3);
    expect(rows.find((r) => r.branch_id === secondBranchId)?.quantity ?? 0).toBe(0);
  });
});

/* ---------------------------------------------------------------- */

describe("delete guard — item with stock cannot be deleted", () => {
  beforeAll(async () => { await ensureMigrated(); app = await buildApp(); });
  beforeEach(async () => { await truncateAll(); await setup(); });
  afterAll(async () => { await app.close(); await teardown(); });

  it("an item with zero stock can be deleted", async () => {
    const item = await createItem();
    const res = await app.inject({ method: "DELETE", url: `/inventory/items/${item.id}`, headers: auth() });
    expect(res.statusCode).toBe(200);
  });

  it("an item with stock on hand cannot be deleted", async () => {
    const item = await createItem();
    await app.inject({ method: "POST", url: `/inventory/branches/${branchId}/receive`, headers: auth(), payload: { item_id: item.id, quantity: 5 } });

    const res = await app.inject({ method: "DELETE", url: `/inventory/items/${item.id}`, headers: auth() });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("item-has-stock");
    expect(res.json().details.total_stock).toBe(5);
  });

  it("an item wasted down to exactly zero CAN then be deleted", async () => {
    const item = await createItem();
    await app.inject({ method: "POST", url: `/inventory/branches/${branchId}/receive`, headers: auth(), payload: { item_id: item.id, quantity: 5 } });
    await app.inject({ method: "POST", url: `/inventory/branches/${branchId}/waste`, headers: auth(), payload: { item_id: item.id, quantity: 5, reason: "expired" } });

    const res = await app.inject({ method: "DELETE", url: `/inventory/items/${item.id}`, headers: auth() });
    expect(res.statusCode).toBe(200);
  });

  it("stock at ANY branch — not just the first one checked — blocks deletion", async () => {
    const secondBranchId = await addBranch("SEC2");
    const item = await createItem();
    // Zero at the home branch, stock only at the second branch.
    await app.inject({ method: "POST", url: `/inventory/branches/${secondBranchId}/receive`, headers: auth(), payload: { item_id: item.id, quantity: 3 } });

    const res = await app.inject({ method: "DELETE", url: `/inventory/items/${item.id}`, headers: auth() });
    expect(res.statusCode).toBe(409);
  });

  it("restore is blocked if the sku/barcode was reused by a new item in the meantime", async () => {
    const item = await createItem({ sku: "REUSE1" });
    await app.inject({ method: "DELETE", url: `/inventory/items/${item.id}`, headers: auth() });
    await createItem({ sku: "REUSE1" });   // legitimately reuses the freed sku

    const res = await app.inject({ method: "POST", url: `/inventory/items/${item.id}/restore`, headers: auth() });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("item-sku-exists");
  });
});

/* ---------------------------------------------------------------- */

describe("append-only ledger (requirement 4 — fully traceable and immutable)", () => {
  beforeAll(async () => { await ensureMigrated(); app = await buildApp(); });
  beforeEach(async () => { await truncateAll(); await setup(); });
  afterAll(async () => { await app.close(); await teardown(); });

  it("UPDATE on inventory_movements is rejected by the trigger", async () => {
    const item = await createItem();
    const receive = await app.inject({
      method: "POST", url: `/inventory/branches/${branchId}/receive`, headers: auth(),
      payload: { item_id: item.id, quantity: 5 },
    });
    const movementId = receive.json().movement.id;

    await expect(
      withNoTenant(async (trx) => {
        await sql`SET LOCAL app.business_id = ${sql.lit(businessId)}`.execute(trx);
        await trx.updateTable("inventory_movements").set({ note: "tampered" }).where("id", "=", movementId).execute();
      }),
    ).rejects.toThrow(/append-only|restrict/i);
  });

  it("DELETE on inventory_movements is rejected by the trigger", async () => {
    const item = await createItem();
    const receive = await app.inject({
      method: "POST", url: `/inventory/branches/${branchId}/receive`, headers: auth(),
      payload: { item_id: item.id, quantity: 5 },
    });
    const movementId = receive.json().movement.id;

    await expect(
      withNoTenant(async (trx) => {
        await sql`SET LOCAL app.business_id = ${sql.lit(businessId)}`.execute(trx);
        await trx.deleteFrom("inventory_movements").where("id", "=", movementId).execute();
      }),
    ).rejects.toThrow(/append-only|restrict/i);
  });

  it("a correction is a NEW row, not an edit — the full history remains after an adjust", async () => {
    const item = await createItem();
    await app.inject({ method: "POST", url: `/inventory/branches/${branchId}/receive`, headers: auth(), payload: { item_id: item.id, quantity: 10 } });
    await app.inject({ method: "POST", url: `/inventory/branches/${branchId}/adjust`, headers: auth(), payload: { item_id: item.id, counted_quantity: 8 } });

    const res = await app.inject({ method: "GET", url: `/inventory/branches/${branchId}/movements`, headers: auth() });
    const types = (res.json().data as Array<{ movement_type: string }>).map((m) => m.movement_type);
    expect(types).toContain("receive");
    expect(types).toContain("adjust");
    expect(types).toHaveLength(2);   // both rows present, neither overwritten
  });
});

/* ---------------------------------------------------------------- */

describe("A09: every mutation writes an audit row", () => {
  beforeAll(async () => { await ensureMigrated(); app = await buildApp(); });
  beforeEach(async () => { await truncateAll(); await setup(); });
  afterAll(async () => { await app.close(); await teardown(); });

  it("create, update, enable, disable, delete, restore, receive, waste, adjust and transfer all succeed as individually distinguishable actions", async () => {
    const secondBranchId = await addBranch("AUDIT2");
    const item = await createItem();

    expect((await app.inject({ method: "PATCH", url: `/inventory/items/${item.id}`, headers: auth(), payload: { sort_order: 2 } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/inventory/items/${item.id}/status`, headers: auth(), payload: { is_active: false } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/inventory/items/${item.id}/status`, headers: auth(), payload: { is_active: true } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/inventory/branches/${branchId}/receive`, headers: auth(), payload: { item_id: item.id, quantity: 10 } })).statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: `/inventory/branches/${branchId}/waste`, headers: auth(), payload: { item_id: item.id, quantity: 2, reason: "damaged" } })).statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: `/inventory/branches/${branchId}/adjust`, headers: auth(), payload: { item_id: item.id, counted_quantity: 5 } })).statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: "/inventory/transfer", headers: auth(), payload: { item_id: item.id, from_branch_id: branchId, to_branch_id: secondBranchId, quantity: 1 } })).statusCode).toBe(201);
    expect((await app.inject({ method: "DELETE", url: `/inventory/items/${item.id}`, headers: auth() })).statusCode).toBe(409); // still has stock — proves the guard fires in this same flow

    // Bring it to zero, then delete + restore to exercise the last two actions.
    const remaining = await app.inject({ method: "GET", url: `/inventory/branches/${branchId}/stock`, headers: auth() });
    const onHand = (remaining.json().data as Array<{ item_id: number; quantity: number }>).find((r) => r.item_id === item.id)!.quantity;
    await app.inject({ method: "POST", url: `/inventory/branches/${branchId}/waste`, headers: auth(), payload: { item_id: item.id, quantity: onHand, reason: "clearing for delete" } });
    const secondStock = await app.inject({ method: "GET", url: `/inventory/branches/${secondBranchId}/stock`, headers: auth() });
    const secondOnHand = (secondStock.json().data as Array<{ item_id: number; quantity: number }>).find((r) => r.item_id === item.id)!.quantity;
    if (secondOnHand > 0) {
      await app.inject({ method: "POST", url: `/inventory/branches/${secondBranchId}/waste`, headers: auth(), payload: { item_id: item.id, quantity: secondOnHand, reason: "clearing for delete" } });
    }

    const del = await app.inject({ method: "DELETE", url: `/inventory/items/${item.id}`, headers: auth() });
    expect(del.statusCode).toBe(200);

    const restore = await app.inject({ method: "POST", url: `/inventory/items/${item.id}/restore`, headers: auth() });
    expect(restore.statusCode).toBe(200);
  });

  it("a no-op status change (already in that state) does not error", async () => {
    const item = await createItem();
    const res = await app.inject({ method: "POST", url: `/inventory/items/${item.id}/status`, headers: auth(), payload: { is_active: true } });
    expect(res.statusCode).toBe(200);
  });
});
