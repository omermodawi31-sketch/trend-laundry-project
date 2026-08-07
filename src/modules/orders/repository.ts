/**
 * Orders repository.
 *
 * The only place that issues SQL against orders, order_lines, payments,
 * order_status_history and order_photos.
 *
 * BRANCH SCOPE
 * ------------
 * Every list/read path takes an `AuthContext`-shaped `scope` argument and
 * applies `branchReadPredicate` to the query. There is no overload that skips
 * it. A caller who wants unscoped access must hold all-branch membership,
 * which the predicate builder recognises and turns into a no-op.
 *
 * This is the "repository helper" the approved architecture calls for: one
 * function, one place, tested.
 */

import { sql, type Transaction, type SelectQueryBuilder } from "kysely";
import type { Database } from "../../lib/db.js";
import type { Bilingual } from "../../shared/types.js";
import { branchReadPredicate } from "./branch-scope.js";

export interface BranchScope {
  branchIds: number[];
}

/* ---------------------------------------------------------------------- */
/*  Row shapes                                                             */
/* ---------------------------------------------------------------------- */

export interface OrderRow {
  id: number;
  business_id: number;
  intake_branch_id: number;
  processing_branch_id: number | null;
  collection_branch_id: number | null;
  order_number: string;
  invoice_number: string | null;
  customer_id: number | null;
  customer_name_snapshot: Bilingual;
  customer_phone_snapshot: string;
  status: string;
  pieces: number;
  subtotal: string;
  express: boolean;
  express_pct: string;
  express_amount: string;
  delivery: boolean;
  delivery_amount: string;
  discount_pct: string;
  discount_amount: string;
  discount_reason: string | null;
  vat_pct: string;
  vat_amount: string;
  total: string;
  paid_amount: string;
  notes: string | null;
  stain_notes: string | null;
  damage_notes: string | null;
  taken_by_user_id: number | null;
  due_at: string | null;
  delivered_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface OrderLineRow {
  id: number;
  order_id: number;
  service_variant_id: number | null;
  service_name_snapshot: Bilingual;
  service_type: string;
  size: string | null;
  qty: number;
  unit_price: string;
  line_total: string;
}

export interface PaymentRow {
  id: number;
  order_id: number | null;
  customer_id: number | null;
  branch_id: number | null;
  amount: string;
  method: string;
  reference: string | null;
  refunded_from_payment_id: number | null;
  refund_reason: string | null;
  received_by_user_id: number | null;
  received_at: string;
}

export interface StatusHistoryRow {
  id: number;
  from_status: string | null;
  to_status: string;
  branch_id: number | null;
  changed_by_user_id: number | null;
  changed_by_role: string | null;
  note: string | null;
  changed_at: string;
}

const ORDER_COLUMNS = [
  "id", "business_id", "intake_branch_id", "processing_branch_id",
  "collection_branch_id", "order_number", "invoice_number", "customer_id",
  "customer_name_snapshot", "customer_phone_snapshot", "status", "pieces",
  "subtotal", "express", "express_pct", "express_amount", "delivery",
  "delivery_amount", "discount_pct", "discount_amount", "discount_reason",
  "vat_pct", "vat_amount", "total", "paid_amount", "notes", "stain_notes",
  "damage_notes", "taken_by_user_id", "due_at", "delivered_at",
  "cancelled_at", "cancel_reason", "created_at", "updated_at", "deleted_at",
] as const;

/* ---------------------------------------------------------------------- */
/*  Filters                                                                */
/* ---------------------------------------------------------------------- */

export interface OrderFilters {
  search?: string;
  status?: string[];
  branchId?: number;
  customerId?: number;
  express?: boolean;
  unpaidOnly?: boolean;
  from?: string;
  to?: string;
  includeDeleted?: boolean;
}

export interface OrderListOptions {
  limit: number;
  cursor?: { createdAt: string; id: number } | undefined;
  direction: "asc" | "desc";
}

/**
 * Shared filter application.
 *
 * `scope` is not optional. Every query that reaches this function is branch
 * scoped, which is the property the security tests assert.
 */
function applyFilters<O>(
  qb: SelectQueryBuilder<Database, "orders", O>,
  businessId: number,
  scope: BranchScope,
  f: OrderFilters,
): SelectQueryBuilder<Database, "orders", O> {
  let q = qb.where("orders.business_id", "=", businessId);

  // Branch authorization. Undefined for all-branch callers.
  const predicate = branchReadPredicate(scope);
  if (predicate) q = q.where(predicate);

  if (!f.includeDeleted) q = q.where("orders.deleted_at", "is", null);

  if (f.status && f.status.length > 0) q = q.where("orders.status", "in", f.status);

  // An explicit branch filter narrows within whatever the caller may already
  // see; it never widens. The scope predicate above still applies.
  if (f.branchId !== undefined) {
    q = q.where(
      sql<boolean>`(
           orders.intake_branch_id = ${f.branchId}
        OR COALESCE(orders.processing_branch_id, orders.intake_branch_id) = ${f.branchId}
        OR COALESCE(orders.collection_branch_id, orders.intake_branch_id) = ${f.branchId}
      )`,
    );
  }

  if (f.customerId !== undefined) q = q.where("orders.customer_id", "=", f.customerId);
  if (f.express !== undefined) q = q.where("orders.express", "=", f.express);

  if (f.unpaidOnly) {
    q = q
      .where(sql<boolean>`orders.paid_amount < orders.total`)
      .where("orders.status", "not in", ["cancelled", "lost"]);
  }

  if (f.from) q = q.where("orders.created_at", ">=", sql`${f.from}::timestamptz`);
  if (f.to) q = q.where("orders.created_at", "<=", sql`${f.to}::timestamptz`);

  if (f.search && f.search.trim() !== "") {
    const term = `%${f.search.trim()}%`;
    // Order number, invoice number, and the denormalised customer snapshot.
    // ILIKE rather than full-text: these are identifiers, and a cashier
    // typing "004" expects a substring match on the order number.
    q = q.where(
      sql<boolean>`(
           orders.order_number ILIKE ${term}
        OR orders.invoice_number ILIKE ${term}
        OR orders.customer_phone_snapshot ILIKE ${term}
        OR normalize_arabic(orders.customer_name_snapshot->>'en') ILIKE normalize_arabic(${term})
        OR normalize_arabic(orders.customer_name_snapshot->>'ar') ILIKE normalize_arabic(${term})
      )`,
    );
  }

  return q;
}

/* ---------------------------------------------------------------------- */
/*  Reads                                                                  */
/* ---------------------------------------------------------------------- */

/**
 * Point read.
 *
 * Deliberately does NOT apply the branch predicate: the service fetches the
 * row, then calls `canReadOrder` so it can distinguish "no such order" from
 * "exists but out of your branch scope" in logs and tests. Both become a 404
 * to the client.
 */
export async function findById(
  trx: Transaction<Database>,
  id: number,
  opts: { includeDeleted?: boolean } = {},
): Promise<OrderRow | undefined> {
  let q = trx.selectFrom("orders").select(ORDER_COLUMNS).where("id", "=", id);
  if (!opts.includeDeleted) q = q.where("deleted_at", "is", null);
  return (await q.executeTakeFirst()) as OrderRow | undefined;
}

export async function findByNumber(
  trx: Transaction<Database>,
  businessId: number,
  orderNumber: string,
): Promise<OrderRow | undefined> {
  return (await trx
    .selectFrom("orders")
    .select(ORDER_COLUMNS)
    .where("business_id", "=", businessId)
    .where("order_number", "=", orderNumber)
    .where("deleted_at", "is", null)
    .executeTakeFirst()) as OrderRow | undefined;
}

export async function list(
  trx: Transaction<Database>,
  businessId: number,
  scope: BranchScope,
  filters: OrderFilters,
  opts: OrderListOptions,
): Promise<OrderRow[]> {
  let q = applyFilters(
    trx.selectFrom("orders").select(ORDER_COLUMNS),
    businessId,
    scope,
    filters,
  );

  if (opts.cursor) {
    const { createdAt, id } = opts.cursor;
    q = opts.direction === "desc"
      ? q.where(sql<boolean>`(orders.created_at, orders.id) < (${createdAt}::timestamptz, ${id}::bigint)`)
      : q.where(sql<boolean>`(orders.created_at, orders.id) > (${createdAt}::timestamptz, ${id}::bigint)`);
  }

  return (await q
    .orderBy("orders.created_at", opts.direction)
    .orderBy("orders.id", opts.direction)
    .limit(opts.limit)
    .execute()) as OrderRow[];
}

export async function countMatching(
  trx: Transaction<Database>,
  businessId: number,
  scope: BranchScope,
  filters: OrderFilters,
): Promise<number> {
  const row = await applyFilters(
    trx.selectFrom("orders").select(({ fn }) => fn.countAll<string>().as("n")),
    businessId,
    scope,
    filters,
  ).executeTakeFirstOrThrow();
  return Number(row.n);
}

export async function linesFor(
  trx: Transaction<Database>,
  orderId: number,
): Promise<OrderLineRow[]> {
  return (await trx
    .selectFrom("order_lines")
    .select([
      "id", "order_id", "service_variant_id", "service_name_snapshot",
      "service_type", "size", "qty", "unit_price", "line_total",
    ])
    .where("order_id", "=", orderId)
    .orderBy("id", "asc")
    .execute()) as OrderLineRow[];
}

export async function paymentsFor(
  trx: Transaction<Database>,
  orderId: number,
): Promise<PaymentRow[]> {
  return (await trx
    .selectFrom("payments")
    .select([
      "id", "order_id", "customer_id", "branch_id", "amount", "method",
      "reference", "refunded_from_payment_id", "refund_reason",
      "received_by_user_id", "received_at",
    ])
    .where("order_id", "=", orderId)
    .orderBy("received_at", "asc")
    .orderBy("id", "asc")
    .execute()) as PaymentRow[];
}

export async function historyFor(
  trx: Transaction<Database>,
  orderId: number,
): Promise<StatusHistoryRow[]> {
  return (await trx
    .selectFrom("order_status_history")
    .select([
      "id", "from_status", "to_status", "branch_id", "changed_by_user_id",
      "changed_by_role", "note", "changed_at",
    ])
    .where("order_id", "=", orderId)
    .orderBy("changed_at", "asc")
    .orderBy("id", "asc")
    .execute()) as StatusHistoryRow[];
}

/** Find a payment by id, scoped to an order. Used by the refund flow. */
export async function findPayment(
  trx: Transaction<Database>,
  paymentId: number,
): Promise<PaymentRow | undefined> {
  return (await trx
    .selectFrom("payments")
    .select([
      "id", "order_id", "customer_id", "branch_id", "amount", "method",
      "reference", "refunded_from_payment_id", "refund_reason",
      "received_by_user_id", "received_at",
    ])
    .where("id", "=", paymentId)
    .executeTakeFirst()) as PaymentRow | undefined;
}

/** Total already refunded against one payment. Used to cap refund amounts. */
export async function refundedTotalFor(
  trx: Transaction<Database>,
  paymentId: number,
): Promise<number> {
  const row = await trx
    .selectFrom("payments")
    .select(({ fn }) => fn.sum<string>("amount").as("s"))
    .where("refunded_from_payment_id", "=", paymentId)
    .executeTakeFirst();
  // Refund rows are negative; return the absolute value already refunded.
  return Math.abs(Number(row?.s ?? 0));
}

/* ---------------------------------------------------------------------- */
/*  Writes                                                                 */
/* ---------------------------------------------------------------------- */

export interface InsertOrderData {
  business_id: number;
  intake_branch_id: number;
  processing_branch_id: number | null;
  collection_branch_id: number | null;
  order_number: string;
  customer_id: number | null;
  customer_name_snapshot: Bilingual;
  customer_phone_snapshot: string;
  pieces: number;
  subtotal: number;
  express: boolean;
  express_pct: number;
  express_amount: number;
  delivery: boolean;
  delivery_amount: number;
  discount_pct: number;
  discount_amount: number;
  discount_reason: string | null;
  vat_pct: number;
  vat_amount: number;
  total: number;
  notes: string | null;
  stain_notes: string | null;
  damage_notes: string | null;
  taken_by_user_id: number | null;
  due_at: string | null;
}

export async function insertOrder(
  trx: Transaction<Database>,
  data: InsertOrderData,
): Promise<OrderRow> {
  const row = await trx
    .insertInto("orders")
    .values({ ...data, customer_name_snapshot: data.customer_name_snapshot as never })
    .returning(ORDER_COLUMNS)
    .executeTakeFirstOrThrow();
  return row as OrderRow;
}

export interface InsertLineData {
  business_id: number;
  order_id: number;
  service_variant_id: number | null;
  service_name_snapshot: Bilingual;
  service_type: string;
  size: string | null;
  qty: number;
  unit_price: number;
  line_total: number;
}

export async function insertLines(
  trx: Transaction<Database>,
  lines: InsertLineData[],
): Promise<void> {
  if (lines.length === 0) return;
  await trx
    .insertInto("order_lines")
    .values(lines.map((l) => ({ ...l, service_name_snapshot: l.service_name_snapshot as never })))
    .execute();
}

export async function deleteLines(trx: Transaction<Database>, orderId: number): Promise<void> {
  await trx.deleteFrom("order_lines").where("order_id", "=", orderId).execute();
}

/** Update the priced totals after a line edit. */
export async function updateTotals(
  trx: Transaction<Database>,
  orderId: number,
  totals: {
    pieces: number;
    subtotal: number;
    express: boolean;
    express_pct: number;
    express_amount: number;
    delivery: boolean;
    delivery_amount: number;
    discount_pct: number;
    discount_amount: number;
    discount_reason: string | null;
    vat_pct: number;
    vat_amount: number;
    total: number;
  },
): Promise<OrderRow | undefined> {
  const row = await trx
    .updateTable("orders")
    .set(totals)
    .where("id", "=", orderId)
    .where("deleted_at", "is", null)
    .returning(ORDER_COLUMNS)
    .executeTakeFirst();
  return row as OrderRow | undefined;
}

export async function updateStatus(
  trx: Transaction<Database>,
  orderId: number,
  patch: {
    status: string;
    invoice_number?: string | null;
    delivered_at?: unknown;
    cancelled_at?: unknown;
    cancel_reason?: string | null;
  },
): Promise<OrderRow | undefined> {
  const row = await trx
    .updateTable("orders")
    .set(patch as never)
    .where("id", "=", orderId)
    .where("deleted_at", "is", null)
    .returning(ORDER_COLUMNS)
    .executeTakeFirst();
  return row as OrderRow | undefined;
}

export async function updateNotes(
  trx: Transaction<Database>,
  orderId: number,
  patch: { notes?: string | null; stain_notes?: string | null; damage_notes?: string | null; due_at?: string | null },
): Promise<OrderRow | undefined> {
  const row = await trx
    .updateTable("orders")
    .set(patch as never)
    .where("id", "=", orderId)
    .where("deleted_at", "is", null)
    .returning(ORDER_COLUMNS)
    .executeTakeFirst();
  return row as OrderRow | undefined;
}

export async function softDeleteOrder(
  trx: Transaction<Database>,
  orderId: number,
): Promise<boolean> {
  const res = await trx
    .updateTable("orders")
    .set({ deleted_at: sql`now()` as never })
    .where("id", "=", orderId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  return Number(res.numUpdatedRows ?? 0) > 0;
}

export async function insertStatusHistory(
  trx: Transaction<Database>,
  data: {
    business_id: number;
    order_id: number;
    from_status: string | null;
    to_status: string;
    branch_id: number | null;
    changed_by_user_id: number | null;
    changed_by_role: string | null;
    note: string | null;
  },
): Promise<void> {
  await trx.insertInto("order_status_history").values(data).execute();
}

export async function insertPayment(
  trx: Transaction<Database>,
  data: {
    business_id: number;
    branch_id: number | null;
    order_id: number;
    customer_id: number | null;
    amount: number;
    method: string;
    reference: string | null;
    refunded_from_payment_id: number | null;
    refund_reason: string | null;
    received_by_user_id: number | null;
  },
): Promise<PaymentRow> {
  const row = await trx
    .insertInto("payments")
    .values(data)
    .returning([
      "id", "order_id", "customer_id", "branch_id", "amount", "method",
      "reference", "refunded_from_payment_id", "refund_reason",
      "received_by_user_id", "received_at",
    ])
    .executeTakeFirstOrThrow();
  return row as PaymentRow;
}

/**
 * Recalculate `orders.paid_amount` from the payments ledger.
 *
 * Called inside the same transaction as every payment insert. The ledger is
 * the source of truth; this column is a cache that exists so list queries do
 * not have to aggregate payments for every row.
 *
 * Recomputing from SUM rather than incrementing means a bug cannot make the
 * cache drift permanently — the next payment corrects it.
 */
export async function recalcPaidAmount(
  trx: Transaction<Database>,
  orderId: number,
): Promise<OrderRow | undefined> {
  const row = await trx
    .updateTable("orders")
    .set({
      paid_amount: sql`(
        SELECT COALESCE(SUM(amount), 0) FROM payments WHERE order_id = ${orderId}
      )` as never,
    })
    .where("id", "=", orderId)
    .returning(ORDER_COLUMNS)
    .executeTakeFirst();
  return row as OrderRow | undefined;
}

/* ---------------------------------------------------------------------- */
/*  Branch + business lookups                                              */
/* ---------------------------------------------------------------------- */

export async function findBranch(
  trx: Transaction<Database>,
  branchId: number,
): Promise<{ id: number; code: string; business_id: number } | undefined> {
  return await trx
    .selectFrom("branches")
    .select(["id", "code", "business_id"])
    .where("id", "=", branchId)
    .where("deleted_at", "is", null)
    .where("is_active", "=", true)
    .executeTakeFirst();
}

/**
 * Extended in Phase 6 to also read pricing rates from `business_settings`
 * (Phase 6) via a join — the exact cross-module-read-inside-one-RLS-
 * transaction pattern already used twice elsewhere (branches reading orders
 * for the historical-order guard, customers reading orders for the
 * unpaid-order guard), applied here in the other direction. INNER JOIN, not
 * LEFT: every business is guaranteed exactly one business_settings row
 * (Phase 6 migration backfill + signup hook + UNIQUE constraint), so a
 * missing row would be a real data-integrity bug, not a normal case to
 * silently default around.
 */
export async function findBusinessSettings(
  trx: Transaction<Database>,
  businessId: number,
): Promise<{
  name: Bilingual;
  timezone: string;
  currency: string;
  vatEnabled: boolean;
  vatPct: number;
  expressPct: number;
  deliveryFee: number;
} | undefined> {
  const row = await trx
    .selectFrom("businesses")
    .innerJoin("business_settings", "business_settings.business_id", "businesses.id")
    .select([
      "businesses.name as name",
      "businesses.timezone as timezone",
      "businesses.currency as currency",
      "business_settings.vat_enabled as vat_enabled",
      "business_settings.vat_pct as vat_pct",
      "business_settings.express_pct as express_pct",
      "business_settings.delivery_fee as delivery_fee",
    ])
    .where("businesses.id", "=", businessId)
    .executeTakeFirst();

  if (!row) return undefined;
  return {
    name: row.name,
    timezone: row.timezone,
    currency: row.currency,
    vatEnabled: row.vat_enabled,
    vatPct: Number(row.vat_pct),
    expressPct: Number(row.express_pct),
    deliveryFee: Number(row.delivery_fee),
  };
}

/** Resolve variants for pricing. Only active, non-deleted ones are priceable. */
export async function findVariants(
  trx: Transaction<Database>,
  variantIds: number[],
): Promise<Array<{
  id: number;
  service_id: number;
  size: string | null;
  unit_price: string;
  service_name: Bilingual;
  service_type: string;
}>> {
  if (variantIds.length === 0) return [];
  return (await trx
    .selectFrom("service_variants as v")
    .innerJoin("services as s", "s.id", "v.service_id")
    .select([
      "v.id as id", "v.service_id as service_id", "v.size as size",
      "v.unit_price as unit_price", "s.name as service_name",
      "s.service_type as service_type",
    ])
    .where("v.id", "in", variantIds)
    .where("v.deleted_at", "is", null)
    .where("v.is_active", "=", true)
    .where("s.deleted_at", "is", null)
    .where("s.is_active", "=", true)
    .execute()) as never;
}
