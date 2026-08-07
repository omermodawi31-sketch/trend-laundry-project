/**
 * Inventory service.
 *
 * Invariants this file maintains:
 *   1. The catalog (`inventory_items`) is business-scoped — no branch-scope
 *      check applies to catalog CRUD, the same as the `services` price
 *      catalogue.
 *   2. Every branch-stock read AND write requires the target branch to be
 *      in the caller's scope (`assertCanAccessBranch`) — unlike Branches
 *      management, where reads are business-wide. Stock is exactly the
 *      per-branch data the brief calls out.
 *   3. Stock levels are never trusted from the client and never stored —
 *      every quantity comes from `repo.stockOf`/`stockForBranch`/etc,
 *      computed fresh from the movement ledger inside the same transaction
 *      that uses it.
 *   4. `adjust` computes its delta server-side from the counted quantity and
 *      the current on-hand figure read inside the same transaction — never
 *      from a client-supplied delta, which could go stale between the
 *      client reading stock and submitting the correction.
 *   5. `waste` and `transfer_out` are refused if they would drive stock
 *      below zero. `adjust` has no such guard — a stocktake correcting a
 *      known over-count down to a lower true figure is exactly what it is
 *      for, so a "no negative result" rule would defeat its purpose.
 *   6. Every mutation writes an audit row in the SAME transaction as the
 *      change, exactly like every other module.
 */

import { randomUUID } from "node:crypto";
import { withTenant } from "../../lib/db.js";
import { auditInTx, actorFromAuth } from "../../lib/audit.js";
import { Errors } from "../../lib/errors.js";
import type { AuthContext, Bilingual } from "../../shared/types.js";
import * as repo from "./repository.js";
import { assertCanAccessBranch, assertCanTransfer } from "./branch-scope.js";
import type {
  AdjustInput,
  CreateItemInput,
  ListItemsQueryInput,
  ListMovementsQueryInput,
  ReceiveInput,
  SetActiveInput,
  TransferInput,
  UpdateItemInput,
  WasteInput,
} from "./schemas.js";

export interface RequestMeta {
  ipAddress: string | null;
  userAgent: string | null;
}

/* ---------------------------------------------------------------------- */
/*  Cursor encoding — identical scheme to every other cursor in this codebase */
/* ---------------------------------------------------------------------- */

export function encodeCursor(createdAt: string, id: number): string {
  return Buffer.from(JSON.stringify({ c: createdAt, i: id }), "utf8").toString("base64url");
}

export function decodeCursor(cursor?: string): { createdAt: string; id: number } | undefined {
  if (!cursor) return undefined;
  try {
    const p = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { c?: unknown; i?: unknown };
    if (typeof p.c !== "string" || typeof p.i !== "number") return undefined;
    if (!Number.isInteger(p.i) || p.i < 0) return undefined;
    if (Number.isNaN(Date.parse(p.c))) return undefined;
    return { createdAt: p.c, id: p.i };
  } catch {
    return undefined;
  }
}

/* ---------------------------------------------------------------------- */
/*  Serialisation                                                          */
/* ---------------------------------------------------------------------- */

export function serialiseItem(row: repo.ItemRow) {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    unit: row.unit,
    sku: row.sku,
    barcode: row.barcode,
    is_active: row.is_active,
    sort_order: row.sort_order,
    created_at: row.created_at,
    updated_at: row.updated_at,
    deleted_at: row.deleted_at,
  };
}

function serialiseMovement(row: repo.MovementRow) {
  return {
    id: row.id,
    branch_id: row.branch_id,
    item_id: row.item_id,
    movement_type: row.movement_type,
    quantity_delta: Number(row.quantity_delta),
    unit_cost: row.unit_cost === null ? null : Number(row.unit_cost),
    reason: row.reason,
    note: row.note,
    transfer_group_id: row.transfer_group_id,
    created_by_user_id: row.created_by_user_id,
    occurred_at: row.occurred_at,
  };
}

const AUDITED_FIELDS = ["name", "category", "unit", "sku", "barcode", "sort_order"] as const;

function auditSnapshot(row: repo.ItemRow): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of AUDITED_FIELDS) out[f] = row[f];
  return out;
}

function auditDiff(before: repo.ItemRow, after: repo.ItemRow) {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const f of AUDITED_FIELDS) {
    const bv = JSON.stringify(before[f]);
    const av = JSON.stringify(after[f]);
    if (bv !== av) { b[f] = before[f]; a[f] = after[f]; }
  }
  return { before: b, after: a };
}

/* ---------------------------------------------------------------------- */
/*  Catalog — commands                                                     */
/* ---------------------------------------------------------------------- */

export async function createItem(auth: AuthContext, input: CreateItemInput, meta: RequestMeta) {
  return withTenant({ businessId: auth.businessId, userId: auth.userId }, async (trx) => {
    if (input.sku) {
      const clash = await repo.findBySku(trx, input.sku);
      if (clash) throw Errors.conflict("item-sku-exists", "An item with this SKU already exists.", { item_id: clash.id });
    }
    if (input.barcode) {
      const clash = await repo.findByBarcode(trx, input.barcode);
      if (clash) throw Errors.conflict("item-barcode-exists", "An item with this barcode already exists.", { item_id: clash.id });
    }

    let row: repo.ItemRow;
    try {
      row = await repo.insert(trx, {
        business_id: auth.businessId,
        name: normaliseBilingual(input.name),
        category: input.category,
        unit: input.unit,
        sku: input.sku,
        barcode: input.barcode,
        sort_order: input.sort_order,
        is_active: input.is_active,
        created_by_user_id: auth.userId,
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw Errors.conflict("item-code-exists", "The SKU or barcode is already in use by another item.");
      }
      throw err;
    }

    await auditInTx(trx, actorFromAuth(auth, meta.ipAddress, meta.userAgent), {
      action: "inventory_item.create",
      resourceType: "inventory_item",
      resourceId: row.id,
      after: auditSnapshot(row),
    });

    return serialiseItem(row);
  });
}

export async function updateItem(auth: AuthContext, id: number, input: UpdateItemInput, meta: RequestMeta) {
  return withTenant({ businessId: auth.businessId, userId: auth.userId }, async (trx) => {
    const before = await repo.findById(trx, id);
    if (!before) throw Errors.notFound("Item");

    if (input.sku !== undefined && input.sku !== null && input.sku !== before.sku) {
      const clash = await repo.findBySku(trx, input.sku);
      if (clash && clash.id !== id) {
        throw Errors.conflict("item-sku-exists", "Another item already uses this SKU.", { item_id: clash.id });
      }
    }
    if (input.barcode !== undefined && input.barcode !== null && input.barcode !== before.barcode) {
      const clash = await repo.findByBarcode(trx, input.barcode);
      if (clash && clash.id !== id) {
        throw Errors.conflict("item-barcode-exists", "Another item already uses this barcode.", { item_id: clash.id });
      }
    }

    let after: repo.ItemRow | undefined;
    try {
      after = await repo.update(trx, id, {
        ...(input.name !== undefined ? { name: normaliseBilingual(input.name) } : {}),
        ...(input.category !== undefined ? { category: input.category } : {}),
        ...(input.unit !== undefined ? { unit: input.unit } : {}),
        ...(input.sku !== undefined ? { sku: input.sku } : {}),
        ...(input.barcode !== undefined ? { barcode: input.barcode } : {}),
        ...(input.sort_order !== undefined ? { sort_order: input.sort_order } : {}),
        updated_by_user_id: auth.userId,
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw Errors.conflict("item-code-exists", "The SKU or barcode is already in use by another item.");
      }
      throw err;
    }
    if (!after) throw Errors.notFound("Item");

    const diff = auditDiff(before, after);
    if (Object.keys(diff.after).length > 0) {
      await auditInTx(trx, actorFromAuth(auth, meta.ipAddress, meta.userAgent), {
        action: "inventory_item.update",
        resourceType: "inventory_item",
        resourceId: id,
        before: diff.before,
        after: diff.after,
      });
    }

    return serialiseItem(after);
  });
}

export async function setActive(auth: AuthContext, id: number, input: SetActiveInput, meta: RequestMeta) {
  return withTenant({ businessId: auth.businessId, userId: auth.userId }, async (trx) => {
    const before = await repo.findById(trx, id);
    if (!before) throw Errors.notFound("Item");

    if (before.is_active === input.is_active) return serialiseItem(before);

    const after = await repo.setActive(trx, id, input.is_active, auth.userId);
    if (!after) throw Errors.notFound("Item");

    await auditInTx(trx, actorFromAuth(auth, meta.ipAddress, meta.userAgent), {
      action: input.is_active ? "inventory_item.enable" : "inventory_item.disable",
      resourceType: "inventory_item",
      resourceId: id,
      before: { is_active: before.is_active },
      after: { is_active: after.is_active },
    });

    return serialiseItem(after);
  });
}

/**
 * Delete guard: blocks only on currently-held stock, not on movement
 * history. Deliberately different from Branches' "any historical order
 * blocks deletion" — a branch reference is a hard FK every order row needs
 * forever, but an inventory movement snapshots nothing about the live
 * catalog row that would break if the item were gone; the operational
 * hazard is deleting an item you still physically have units of, not that
 * it was ever moved at all. Blocking on ANY history would make almost every
 * real item permanently undeletable, which defeats the point of the check.
 */
export async function deleteItem(auth: AuthContext, id: number, meta: RequestMeta) {
  return withTenant({ businessId: auth.businessId, userId: auth.userId }, async (trx) => {
    const before = await repo.findById(trx, id);
    if (!before) throw Errors.notFound("Item");

    const totalStock = await repo.totalStockAcrossBranches(trx, id);
    if (totalStock > 0) {
      throw Errors.conflict(
        "item-has-stock",
        "This item still has stock on hand and cannot be deleted. Use waste or a transfer to bring it to zero first, or disable it instead.",
        { total_stock: totalStock },
      );
    }

    const row = await repo.softDelete(trx, id, auth.userId);
    if (!row) throw Errors.notFound("Item");

    await auditInTx(trx, actorFromAuth(auth, meta.ipAddress, meta.userAgent), {
      action: "inventory_item.delete",
      resourceType: "inventory_item",
      resourceId: id,
      before: auditSnapshot(before),
    });

    return { id, deleted_at: row.deleted_at };
  });
}

export async function restoreItem(auth: AuthContext, id: number, meta: RequestMeta) {
  return withTenant({ businessId: auth.businessId, userId: auth.userId }, async (trx) => {
    const before = await repo.findById(trx, id, { includeDeleted: true });
    if (!before) throw Errors.notFound("Item");
    if (!before.deleted_at) throw Errors.conflict("item-not-deleted", "This item is not deleted.");

    if (before.sku) {
      const clash = await repo.findBySku(trx, before.sku);
      if (clash && clash.id !== id) {
        throw Errors.conflict("item-sku-exists", "Another item now uses this SKU. Change it before restoring.", { item_id: clash.id });
      }
    }
    if (before.barcode) {
      const clash = await repo.findByBarcode(trx, before.barcode);
      if (clash && clash.id !== id) {
        throw Errors.conflict("item-barcode-exists", "Another item now uses this barcode. Change it before restoring.", { item_id: clash.id });
      }
    }

    const row = await repo.restore(trx, id, auth.userId);
    if (!row) throw Errors.notFound("Item");

    await auditInTx(trx, actorFromAuth(auth, meta.ipAddress, meta.userAgent), {
      action: "inventory_item.restore",
      resourceType: "inventory_item",
      resourceId: id,
      after: auditSnapshot(row),
    });

    return serialiseItem(row);
  });
}

/* ---------------------------------------------------------------------- */
/*  Catalog — queries                                                      */
/* ---------------------------------------------------------------------- */

export async function getItem(auth: AuthContext, id: number) {
  return withTenant({ businessId: auth.businessId, userId: auth.userId }, async (trx) => {
    const row = await repo.findById(trx, id, { includeDeleted: true });
    if (!row) throw Errors.notFound("Item");
    return serialiseItem(row);
  });
}

/** Scan lookup — the backend half of the barcode/QR requirement. */
export async function getItemByCode(auth: AuthContext, code: string) {
  return withTenant({ businessId: auth.businessId, userId: auth.userId }, async (trx) => {
    const row = await repo.findByCode(trx, code);
    if (!row) throw Errors.notFound("Item");
    return serialiseItem(row);
  });
}

export async function listItems(auth: AuthContext, query: ListItemsQueryInput) {
  return withTenant({ businessId: auth.businessId, userId: auth.userId }, async (trx) => {
    const rows = await repo.list(
      trx,
      auth.businessId,
      {
        search: query.q,
        isActive: query.is_active,
        category: query.category,
        includeDeleted: query.deleted === "include",
        onlyDeleted: query.deleted === "only",
      },
      {
        limit: query.limit + 1,
        cursor: decodeCursor(query.cursor),
        sort: query.sort,
        direction: query.direction,
      },
    );

    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    const last = page[page.length - 1];

    return {
      data: page.map((r) => serialiseItem(r)),
      page_info: {
        has_more: hasMore,
        next_cursor: hasMore && last ? encodeCursor(last.created_at, last.id) : null,
        limit: query.limit,
      },
    };
  });
}

/* ---------------------------------------------------------------------- */
/*  Stock                                                                  */
/* ---------------------------------------------------------------------- */

export async function getBranchStock(auth: AuthContext, branchId: number) {
  return withTenant({ businessId: auth.businessId, userId: auth.userId }, async (trx) => {
    const branch = await repo.findBranch(trx, branchId);
    if (!branch) throw Errors.notFound("Branch");
    assertCanAccessBranch(auth, branchId);

    const rows = await repo.stockForBranch(trx, auth.businessId, branchId);
    return { data: rows };
  });
}

export async function getItemStock(auth: AuthContext, itemId: number) {
  return withTenant({ businessId: auth.businessId, userId: auth.userId }, async (trx) => {
    const item = await repo.findById(trx, itemId, { includeDeleted: true });
    if (!item) throw Errors.notFound("Item");

    const rows = await repo.stockForItem(trx, itemId, auth.branchIds);
    return { data: rows };
  });
}

/* ---------------------------------------------------------------------- */
/*  Movements — commands                                                   */
/* ---------------------------------------------------------------------- */

export async function recordReceive(auth: AuthContext, branchId: number, input: ReceiveInput, meta: RequestMeta) {
  return withTenant({ businessId: auth.businessId, userId: auth.userId }, async (trx) => {
    const branch = await repo.findBranch(trx, branchId);
    if (!branch) throw Errors.notFound("Branch");
    assertCanAccessBranch(auth, branchId);

    const item = await repo.findById(trx, input.item_id);
    if (!item) throw Errors.notFound("Item");

    const movement = await repo.insertMovement(trx, {
      business_id: auth.businessId,
      branch_id: branchId,
      item_id: input.item_id,
      movement_type: "receive",
      quantity_delta: input.quantity,
      unit_cost: input.unit_cost ?? null,
      note: input.note ?? null,
      created_by_user_id: auth.userId,
    });

    await auditInTx(trx, actorFromAuth(auth, meta.ipAddress, meta.userAgent), {
      action: "inventory.receive",
      resourceType: "inventory_item",
      resourceId: input.item_id,
      branchId,
      after: { movement_id: movement.id, quantity: input.quantity, unit_cost: input.unit_cost ?? null },
    });

    const newQuantity = await repo.stockOf(trx, branchId, input.item_id);
    return { movement: serialiseMovement(movement), quantity_on_hand: newQuantity };
  });
}

export async function recordWaste(auth: AuthContext, branchId: number, input: WasteInput, meta: RequestMeta) {
  return withTenant({ businessId: auth.businessId, userId: auth.userId }, async (trx) => {
    const branch = await repo.findBranch(trx, branchId);
    if (!branch) throw Errors.notFound("Branch");
    assertCanAccessBranch(auth, branchId);

    const item = await repo.findById(trx, input.item_id);
    if (!item) throw Errors.notFound("Item");

    const current = await repo.stockOf(trx, branchId, input.item_id);
    if (input.quantity > current) {
      throw Errors.validation("Cannot waste more than is currently on hand.", {
        on_hand: current,
        attempted: input.quantity,
      });
    }

    const movement = await repo.insertMovement(trx, {
      business_id: auth.businessId,
      branch_id: branchId,
      item_id: input.item_id,
      movement_type: "waste",
      quantity_delta: -input.quantity,
      reason: input.reason,
      note: input.note ?? null,
      created_by_user_id: auth.userId,
    });

    await auditInTx(trx, actorFromAuth(auth, meta.ipAddress, meta.userAgent), {
      action: "inventory.waste",
      resourceType: "inventory_item",
      resourceId: input.item_id,
      branchId,
      after: { movement_id: movement.id, quantity: input.quantity, reason: input.reason },
    });

    const newQuantity = await repo.stockOf(trx, branchId, input.item_id);
    return { movement: serialiseMovement(movement), quantity_on_hand: newQuantity };
  });
}

export async function recordAdjust(auth: AuthContext, branchId: number, input: AdjustInput, meta: RequestMeta) {
  return withTenant({ businessId: auth.businessId, userId: auth.userId }, async (trx) => {
    const branch = await repo.findBranch(trx, branchId);
    if (!branch) throw Errors.notFound("Branch");
    assertCanAccessBranch(auth, branchId);

    const item = await repo.findById(trx, input.item_id);
    if (!item) throw Errors.notFound("Item");

    const current = await repo.stockOf(trx, branchId, input.item_id);
    const delta = round3(input.counted_quantity - current);

    if (delta === 0) {
      // A no-op correction is not an event worth an immutable ledger row —
      // same principle as a no-op PATCH not writing an audit row elsewhere
      // in this codebase, applied here at the database-constraint level too
      // (quantity_delta <> 0 is a CHECK constraint, not just an app rule).
      throw Errors.validation("The counted quantity matches the current stock — nothing to adjust.", {
        on_hand: current,
      });
    }

    const movement = await repo.insertMovement(trx, {
      business_id: auth.businessId,
      branch_id: branchId,
      item_id: input.item_id,
      movement_type: "adjust",
      quantity_delta: delta,
      note: input.note ?? null,
      created_by_user_id: auth.userId,
    });

    await auditInTx(trx, actorFromAuth(auth, meta.ipAddress, meta.userAgent), {
      action: "inventory.adjust",
      resourceType: "inventory_item",
      resourceId: input.item_id,
      branchId,
      before: { on_hand: current },
      after: { movement_id: movement.id, counted_quantity: input.counted_quantity, delta },
    });

    return { movement: serialiseMovement(movement), quantity_on_hand: input.counted_quantity };
  });
}

export async function recordTransfer(auth: AuthContext, input: TransferInput, meta: RequestMeta) {
  return withTenant({ businessId: auth.businessId, userId: auth.userId }, async (trx) => {
    const [fromBranch, toBranch] = await Promise.all([
      repo.findBranch(trx, input.from_branch_id),
      repo.findBranch(trx, input.to_branch_id),
    ]);
    if (!fromBranch) throw Errors.notFound("Source branch");
    if (!toBranch) throw Errors.notFound("Destination branch");
    assertCanTransfer(auth, input.from_branch_id, input.to_branch_id);

    const item = await repo.findById(trx, input.item_id);
    if (!item) throw Errors.notFound("Item");

    const available = await repo.stockOf(trx, input.from_branch_id, input.item_id);
    if (input.quantity > available) {
      throw Errors.validation("Cannot transfer more than is available at the source branch.", {
        available,
        attempted: input.quantity,
      });
    }

    const transferGroupId = randomUUID();

    const outMovement = await repo.insertMovement(trx, {
      business_id: auth.businessId,
      branch_id: input.from_branch_id,
      item_id: input.item_id,
      movement_type: "transfer_out",
      quantity_delta: -input.quantity,
      note: input.note ?? null,
      transfer_group_id: transferGroupId,
      created_by_user_id: auth.userId,
    });
    const inMovement = await repo.insertMovement(trx, {
      business_id: auth.businessId,
      branch_id: input.to_branch_id,
      item_id: input.item_id,
      movement_type: "transfer_in",
      quantity_delta: input.quantity,
      note: input.note ?? null,
      transfer_group_id: transferGroupId,
      created_by_user_id: auth.userId,
    });

    await auditInTx(trx, actorFromAuth(auth, meta.ipAddress, meta.userAgent), {
      action: "inventory.transfer",
      resourceType: "inventory_item",
      resourceId: input.item_id,
      branchId: input.from_branch_id,
      after: {
        transfer_group_id: transferGroupId,
        from_branch_id: input.from_branch_id,
        to_branch_id: input.to_branch_id,
        quantity: input.quantity,
      },
    });

    return {
      transfer_group_id: transferGroupId,
      out: serialiseMovement(outMovement),
      in: serialiseMovement(inMovement),
    };
  });
}

/* ---------------------------------------------------------------------- */
/*  Movements — queries                                                    */
/* ---------------------------------------------------------------------- */

export async function getBranchMovements(auth: AuthContext, branchId: number, query: ListMovementsQueryInput) {
  return withTenant({ businessId: auth.businessId, userId: auth.userId }, async (trx) => {
    const branch = await repo.findBranch(trx, branchId);
    if (!branch) throw Errors.notFound("Branch");
    assertCanAccessBranch(auth, branchId);

    const rows = await repo.movementsForBranch(
      trx, auth.businessId, branchId,
      { itemId: query.item_id, movementType: query.movement_type, from: query.from, to: query.to },
      query.limit + 1, query.before,
    );

    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    const last = page[page.length - 1];

    return {
      data: page.map((r) => serialiseMovement(r)),
      page_info: { has_more: hasMore, next_before: hasMore && last ? last.id : null },
    };
  });
}

export async function getItemMovements(auth: AuthContext, itemId: number, query: ListMovementsQueryInput) {
  return withTenant({ businessId: auth.businessId, userId: auth.userId }, async (trx) => {
    const item = await repo.findById(trx, itemId, { includeDeleted: true });
    if (!item) throw Errors.notFound("Item");

    const rows = await repo.movementsForItem(
      trx, auth.businessId, itemId, auth.branchIds,
      { movementType: query.movement_type, from: query.from, to: query.to },
      query.limit + 1, query.before,
    );

    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    const last = page[page.length - 1];

    return {
      data: page.map((r) => serialiseMovement(r)),
      page_info: { has_more: hasMore, next_before: hasMore && last ? last.id : null },
    };
  });
}

/* ---------------------------------------------------------------------- */
/*  Helpers                                                                */
/* ---------------------------------------------------------------------- */

function normaliseBilingual(input: { en: string; ar: string }): Bilingual {
  return { en: (input.en ?? "").trim(), ar: (input.ar ?? "").trim() };
}

/** Round to 3dp — matches the numeric(12,3) column precision, avoids float noise in a computed delta. */
function round3(value: number): number {
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "23505"
  );
}
