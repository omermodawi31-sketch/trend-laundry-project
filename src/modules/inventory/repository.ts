/**
 * Inventory repository.
 *
 * The only place in the codebase that issues SQL against `inventory_items`,
 * `inventory_movements`, and the `inventory_stock_levels` view. Every
 * function takes a `Transaction<Database>` supplied by `withTenant(...)` —
 * RLS is active on every query here, exactly as in every other repository.
 *
 * Stock levels are never stored — every "current stock" read is a live
 * aggregate against `inventory_movements` (via the view, or a direct SUM
 * for a single lookup). See the migration's header comment for why.
 */

import { sql, type Transaction, type SelectQueryBuilder } from "kysely";
import type { Database } from "../../lib/db.js";
import type { Bilingual } from "../../shared/types.js";
import type { InventoryMovementType } from "../../lib/db-schema.js";

/* ---------------------------------------------------------------------- */
/*  Types                                                                  */
/* ---------------------------------------------------------------------- */

export type ItemUnit = "L" | "kg" | "piece" | "roll" | "box";
export type SortKey = "sort_order" | "name" | "created_at";
export type SortDirection = "asc" | "desc";

export interface ItemRow {
  id: number;
  business_id: number;
  name: Bilingual;
  category: string;
  unit: ItemUnit;
  sku: string | null;
  barcode: string | null;
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface MovementRow {
  id: number;
  business_id: number;
  branch_id: number;
  item_id: number;
  movement_type: InventoryMovementType;
  quantity_delta: string;
  unit_cost: string | null;
  reason: string | null;
  note: string | null;
  transfer_group_id: string | null;
  created_by_user_id: number | null;
  occurred_at: string;
}

const ITEM_COLUMNS = [
  "id", "business_id", "name", "category", "unit", "sku", "barcode",
  "is_active", "sort_order", "created_at", "updated_at", "deleted_at",
] as const;

const MOVEMENT_COLUMNS = [
  "id", "business_id", "branch_id", "item_id", "movement_type",
  "quantity_delta", "unit_cost", "reason", "note", "transfer_group_id",
  "created_by_user_id", "occurred_at",
] as const;

/* ---------------------------------------------------------------------- */
/*  Catalog — reads                                                        */
/* ---------------------------------------------------------------------- */

export async function findById(
  trx: Transaction<Database>,
  id: number,
  opts: { includeDeleted?: boolean } = {},
): Promise<ItemRow | undefined> {
  let q = trx.selectFrom("inventory_items").select(ITEM_COLUMNS).where("id", "=", id);
  if (!opts.includeDeleted) q = q.where("deleted_at", "is", null);
  return (await q.executeTakeFirst()) as ItemRow | undefined;
}

/** Scan lookup — matches either the SKU or the barcode column exactly. */
export async function findByCode(
  trx: Transaction<Database>,
  code: string,
): Promise<ItemRow | undefined> {
  return (await trx
    .selectFrom("inventory_items")
    .select(ITEM_COLUMNS)
    .where((eb) => eb.or([eb("sku", "=", code), eb("barcode", "=", code)]))
    .where("deleted_at", "is", null)
    .executeTakeFirst()) as ItemRow | undefined;
}

export async function findBySku(trx: Transaction<Database>, sku: string): Promise<ItemRow | undefined> {
  return (await trx
    .selectFrom("inventory_items")
    .select(ITEM_COLUMNS)
    .where("sku", "=", sku)
    .where("deleted_at", "is", null)
    .executeTakeFirst()) as ItemRow | undefined;
}

export async function findByBarcode(trx: Transaction<Database>, barcode: string): Promise<ItemRow | undefined> {
  return (await trx
    .selectFrom("inventory_items")
    .select(ITEM_COLUMNS)
    .where("barcode", "=", barcode)
    .where("deleted_at", "is", null)
    .executeTakeFirst()) as ItemRow | undefined;
}

export interface ListItemFilters {
  search?: string;
  isActive?: boolean;
  category?: string;
  includeDeleted?: boolean;
  onlyDeleted?: boolean;
}

export interface ListItemOptions {
  limit: number;
  cursor?: { createdAt: string; id: number } | undefined;
  sort: SortKey;
  direction: SortDirection;
}

function applyItemFilters<O>(
  qb: SelectQueryBuilder<Database, "inventory_items", O>,
  businessId: number,
  f: ListItemFilters,
): SelectQueryBuilder<Database, "inventory_items", O> {
  let q = qb.where("inventory_items.business_id", "=", businessId);

  if (f.onlyDeleted) q = q.where("inventory_items.deleted_at", "is not", null);
  else if (!f.includeDeleted) q = q.where("inventory_items.deleted_at", "is", null);

  if (f.isActive !== undefined) q = q.where("inventory_items.is_active", "=", f.isActive);
  if (f.category) q = q.where("inventory_items.category", "=", f.category);

  if (f.search && f.search.trim() !== "") {
    const term = f.search.trim();
    q = q.where(
      sql<boolean>`inventory_items.search_vector @@ websearch_to_tsquery('simple', normalize_arabic(${term}))`,
    );
  }

  return q;
}

export async function list(
  trx: Transaction<Database>,
  businessId: number,
  filters: ListItemFilters,
  opts: ListItemOptions,
): Promise<ItemRow[]> {
  let q = applyItemFilters(trx.selectFrom("inventory_items").select(ITEM_COLUMNS), businessId, filters);
  const dir = opts.direction;

  if (opts.sort === "created_at") {
    if (opts.cursor) {
      const { createdAt, id } = opts.cursor;
      q = dir === "desc"
        ? q.where(sql<boolean>`(inventory_items.created_at, inventory_items.id) < (${createdAt}::timestamptz, ${id}::bigint)`)
        : q.where(sql<boolean>`(inventory_items.created_at, inventory_items.id) > (${createdAt}::timestamptz, ${id}::bigint)`);
    }
    q = q.orderBy("inventory_items.created_at", dir).orderBy("inventory_items.id", dir);
  } else if (opts.sort === "name") {
    q = q
      .orderBy(sql`coalesce(nullif(inventory_items.name->>'en',''), inventory_items.name->>'ar')`, dir)
      .orderBy("inventory_items.id", dir);
  } else {
    q = q.orderBy("inventory_items.sort_order", dir).orderBy("inventory_items.id", dir);
  }

  return (await q.limit(opts.limit).execute()) as ItemRow[];
}

/* ---------------------------------------------------------------------- */
/*  Catalog — writes                                                       */
/* ---------------------------------------------------------------------- */

export interface CreateItemData {
  business_id: number;
  name: Bilingual;
  category: string;
  unit: ItemUnit;
  sku?: string | null;
  barcode?: string | null;
  sort_order?: number;
  is_active?: boolean;
  created_by_user_id: number | null;
}

export type UpdateItemData = Partial<Omit<CreateItemData, "business_id" | "created_by_user_id">> & {
  updated_by_user_id: number | null;
};

export async function insert(trx: Transaction<Database>, data: CreateItemData): Promise<ItemRow> {
  const row = await trx
    .insertInto("inventory_items")
    .values({
      business_id: data.business_id,
      name: data.name as never,
      category: data.category,
      unit: data.unit,
      sku: data.sku ?? null,
      barcode: data.barcode ?? null,
      sort_order: data.sort_order ?? 0,
      is_active: data.is_active ?? true,
      created_by_user_id: data.created_by_user_id,
      updated_by_user_id: data.created_by_user_id,
    })
    .returning(ITEM_COLUMNS)
    .executeTakeFirstOrThrow();
  return row as ItemRow;
}

export async function update(
  trx: Transaction<Database>,
  id: number,
  data: UpdateItemData,
): Promise<ItemRow | undefined> {
  const patch: Record<string, unknown> = { updated_by_user_id: data.updated_by_user_id };
  if (data.name !== undefined) patch.name = data.name;
  if (data.category !== undefined) patch.category = data.category;
  if (data.unit !== undefined) patch.unit = data.unit;
  if (data.sku !== undefined) patch.sku = data.sku;
  if (data.barcode !== undefined) patch.barcode = data.barcode;
  if (data.sort_order !== undefined) patch.sort_order = data.sort_order;

  const row = await trx
    .updateTable("inventory_items")
    .set(patch as never)
    .where("id", "=", id)
    .where("deleted_at", "is", null)
    .returning(ITEM_COLUMNS)
    .executeTakeFirst();
  return row as ItemRow | undefined;
}

export async function setActive(
  trx: Transaction<Database>,
  id: number,
  isActive: boolean,
  userId: number | null,
): Promise<ItemRow | undefined> {
  const row = await trx
    .updateTable("inventory_items")
    .set({ is_active: isActive, updated_by_user_id: userId })
    .where("id", "=", id)
    .where("deleted_at", "is", null)
    .returning(ITEM_COLUMNS)
    .executeTakeFirst();
  return row as ItemRow | undefined;
}

export async function softDelete(
  trx: Transaction<Database>,
  id: number,
  userId: number | null,
): Promise<ItemRow | undefined> {
  const row = await trx
    .updateTable("inventory_items")
    .set({ deleted_at: sql`now()` as never, deleted_by_user_id: userId, is_active: false })
    .where("id", "=", id)
    .where("deleted_at", "is", null)
    .returning(ITEM_COLUMNS)
    .executeTakeFirst();
  return row as ItemRow | undefined;
}

export async function restore(
  trx: Transaction<Database>,
  id: number,
  userId: number | null,
): Promise<ItemRow | undefined> {
  const row = await trx
    .updateTable("inventory_items")
    .set({ deleted_at: null, deleted_by_user_id: null, updated_by_user_id: userId, is_active: false })
    .where("id", "=", id)
    .where("deleted_at", "is not", null)
    .returning(ITEM_COLUMNS)
    .executeTakeFirst();
  return row as ItemRow | undefined;
}

/**
 * Total stock of one item, summed across every branch — the delete-guard's
 * query. Deliberately different from the Branches module's "any historical
 * order blocks deletion" rule: here, only currently-held units block
 * deletion, not the mere existence of past movements. See service.ts's
 * `deleteItem` for the full reasoning.
 */
export async function totalStockAcrossBranches(
  trx: Transaction<Database>,
  itemId: number,
): Promise<number> {
  const row = await trx
    .selectFrom("inventory_stock_levels")
    .select(({ fn }) => fn.sum<string>("quantity").as("total"))
    .where("item_id", "=", itemId)
    .executeTakeFirst();
  return row?.total ? Number(row.total) : 0;
}

/* ---------------------------------------------------------------------- */
/*  Stock levels (computed, never stored)                                  */
/* ---------------------------------------------------------------------- */

/** Current stock of one item at one branch. Missing row = zero, not an error. */
export async function stockOf(
  trx: Transaction<Database>,
  branchId: number,
  itemId: number,
): Promise<number> {
  const row = await trx
    .selectFrom("inventory_stock_levels")
    .select("quantity")
    .where("branch_id", "=", branchId)
    .where("item_id", "=", itemId)
    .executeTakeFirst();
  return row ? Number(row.quantity) : 0;
}

export interface BranchStockRow {
  item_id: number;
  name: Bilingual;
  category: string;
  unit: ItemUnit;
  sku: string | null;
  barcode: string | null;
  quantity: number;
}

/**
 * Every active catalog item, joined against this branch's computed stock.
 * A LEFT JOIN so an item that has never had a movement at this branch still
 * appears, at zero — a manager should see "we stock this, we have none
 * right now", not have the item silently vanish from the list.
 */
export async function stockForBranch(
  trx: Transaction<Database>,
  businessId: number,
  branchId: number,
): Promise<BranchStockRow[]> {
  const rows = await trx
    .selectFrom("inventory_items")
    .leftJoin("inventory_stock_levels", (join) =>
      join
        .onRef("inventory_stock_levels.item_id", "=", "inventory_items.id")
        .on("inventory_stock_levels.branch_id", "=", branchId),
    )
    .select([
      "inventory_items.id as item_id",
      "inventory_items.name as name",
      "inventory_items.category as category",
      "inventory_items.unit as unit",
      "inventory_items.sku as sku",
      "inventory_items.barcode as barcode",
      sql<string>`coalesce(inventory_stock_levels.quantity, 0)`.as("quantity"),
    ])
    .where("inventory_items.business_id", "=", businessId)
    .where("inventory_items.deleted_at", "is", null)
    .where("inventory_items.is_active", "=", true)
    .orderBy("inventory_items.sort_order", "asc")
    .orderBy("inventory_items.id", "asc")
    .execute();

  return rows.map((r) => ({ ...r, quantity: Number(r.quantity) })) as BranchStockRow[];
}

export interface ItemStockRow {
  branch_id: number;
  quantity: number;
}

/**
 * One item's stock at every branch the caller may see. `branchIds` empty
 * means all-branch access — no filter applied; otherwise restricted to the
 * caller's own branches. This FILTERS rather than denies (unlike a point
 * read of a single branch's stock), matching how Orders' list endpoint
 * narrows rather than 403s for a scoped caller.
 */
export async function stockForItem(
  trx: Transaction<Database>,
  itemId: number,
  branchIds: number[],
): Promise<ItemStockRow[]> {
  let q = trx
    .selectFrom("inventory_stock_levels")
    .select(["branch_id", "quantity"])
    .where("item_id", "=", itemId);
  if (branchIds.length > 0) q = q.where("branch_id", "in", branchIds);

  const rows = await q.orderBy("branch_id", "asc").execute();
  return rows.map((r) => ({ branch_id: r.branch_id, quantity: Number(r.quantity) }));
}

/* ---------------------------------------------------------------------- */
/*  Movements                                                              */
/* ---------------------------------------------------------------------- */

export interface InsertMovementData {
  business_id: number;
  branch_id: number;
  item_id: number;
  movement_type: InventoryMovementType;
  quantity_delta: number;
  unit_cost?: number | null;
  reason?: string | null;
  note?: string | null;
  transfer_group_id?: string | null;
  created_by_user_id: number | null;
}

export async function insertMovement(
  trx: Transaction<Database>,
  data: InsertMovementData,
): Promise<MovementRow> {
  const row = await trx
    .insertInto("inventory_movements")
    .values({
      business_id: data.business_id,
      branch_id: data.branch_id,
      item_id: data.item_id,
      movement_type: data.movement_type,
      quantity_delta: data.quantity_delta,
      unit_cost: data.unit_cost ?? null,
      reason: data.reason ?? null,
      note: data.note ?? null,
      transfer_group_id: data.transfer_group_id ?? null,
      created_by_user_id: data.created_by_user_id,
    } as never)
    .returning(MOVEMENT_COLUMNS)
    .executeTakeFirstOrThrow();
  return row as MovementRow;
}

export interface MovementFilters {
  itemId?: number;
  movementType?: InventoryMovementType;
  from?: string;
  to?: string;
}

async function baseMovementsQuery(
  trx: Transaction<Database>,
  businessId: number,
  f: MovementFilters,
) {
  let q = trx
    .selectFrom("inventory_movements")
    .select(MOVEMENT_COLUMNS)
    .where("business_id", "=", businessId);

  if (f.itemId !== undefined) q = q.where("item_id", "=", f.itemId);
  if (f.movementType !== undefined) q = q.where("movement_type", "=", f.movementType);
  if (f.from) q = q.where("occurred_at", ">=", sql`${f.from}::timestamptz`);
  if (f.to) q = q.where("occurred_at", "<=", sql`${f.to}::timestamptz`);

  return q;
}

export async function movementsForBranch(
  trx: Transaction<Database>,
  businessId: number,
  branchId: number,
  filters: MovementFilters,
  limit: number,
  beforeId?: number,
): Promise<MovementRow[]> {
  let q = (await baseMovementsQuery(trx, businessId, filters)).where("branch_id", "=", branchId);
  if (beforeId) q = q.where("id", "<", beforeId);
  return (await q.orderBy("id", "desc").limit(limit).execute()) as MovementRow[];
}

/**
 * One item's movements across every branch the caller may see — same
 * filter-not-deny convention as `stockForItem`.
 */
export async function movementsForItem(
  trx: Transaction<Database>,
  businessId: number,
  itemId: number,
  branchIds: number[],
  filters: Omit<MovementFilters, "itemId">,
  limit: number,
  beforeId?: number,
): Promise<MovementRow[]> {
  let q = await baseMovementsQuery(trx, businessId, { ...filters, itemId });
  if (branchIds.length > 0) q = q.where("branch_id", "in", branchIds);
  if (beforeId) q = q.where("id", "<", beforeId);
  return (await q.orderBy("id", "desc").limit(limit).execute()) as MovementRow[];
}

/* ---------------------------------------------------------------------- */
/*  Branch existence                                                       */
/* ---------------------------------------------------------------------- */

/** Same shape as orders/repository.ts's findBranch — mirrored, not duplicated logic. */
export async function findBranch(
  trx: Transaction<Database>,
  branchId: number,
): Promise<{ id: number; business_id: number } | undefined> {
  return await trx
    .selectFrom("branches")
    .select(["id", "business_id"])
    .where("id", "=", branchId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
}
