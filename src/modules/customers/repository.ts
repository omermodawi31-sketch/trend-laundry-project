/**
 * Customers repository.
 *
 * The ONLY place in the codebase that issues SQL against `customers` and
 * `customer_notes`. Service code calls these functions; route handlers never
 * touch the database directly.
 *
 * Every function takes a `Transaction<Database>` as its first argument. That
 * transaction is created by `withTenant(...)` in the service layer, which has
 * already run `SET LOCAL app.business_id`. This means:
 *
 *   - RLS is active on every query here. A missing WHERE business_id clause
 *     cannot leak data; Postgres refuses.
 *   - We still filter by business_id where it helps the query planner use an
 *     index, but correctness does not depend on it.
 *
 * Pagination is cursor-based on (created_at, id). Offset pagination degrades
 * badly past a few thousand rows and produces duplicate/missing rows when the
 * underlying data changes between pages.
 */

import { sql, type Transaction, type SelectQueryBuilder } from "kysely";
import type { Database } from "../../lib/db.js";
import type { Bilingual } from "../../shared/types.js";

/* ---------------------------------------------------------------------- */
/*  Types                                                                  */
/* ---------------------------------------------------------------------- */

export type CustomerStatus = "active" | "inactive" | "blocked";
export type PickupPreference = "morning" | "midday" | "evening" | "none";
export type SortKey = "created_at" | "name" | "phone" | "last_visit";
export type SortDirection = "asc" | "desc";

export interface CustomerRow {
  id: number;
  business_id: number;
  preferred_branch_id: number | null;
  name: Bilingual;
  address: Bilingual | null;
  phone: string;
  whatsapp: string | null;
  email: string | null;
  photo_url: string | null;
  maps_url: string | null;
  emirates_id: string | null;
  tax_number: string | null;
  status: CustomerStatus;
  status_reason: string | null;
  status_changed_at: string | null;
  vip: boolean;
  tags: string[];
  favourite_services: string[];
  pickup_preference: PickupPreference;
  preferred_locale: "en" | "ar" | null;
  marketing_opt_in: boolean;
  since: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface CustomerStats {
  orders_count: number;
  completed_count: number;
  cancelled_count: number;
  pieces: number;
  lifetime_spend: string;
  lifetime_paid: string;
  outstanding: string;
  loyalty_points: number;
  last_visit_at: string | null;
  first_order_at: string | null;
}

export interface ListFilters {
  search?: string;
  status?: CustomerStatus;
  vip?: boolean;
  tags?: string[];
  hasDebt?: boolean;
  marketingOptIn?: boolean;
  includeDeleted?: boolean;
  onlyDeleted?: boolean;
}

export interface ListOptions {
  limit: number;
  cursor?: { createdAt: string; id: number } | undefined;
  sort: SortKey;
  direction: SortDirection;
}

export interface CreateCustomerData {
  business_id: number;
  name: Bilingual;
  phone: string;
  whatsapp?: string | null;
  email?: string | null;
  address?: Bilingual | null;
  maps_url?: string | null;
  emirates_id?: string | null;
  tax_number?: string | null;
  photo_url?: string | null;
  preferred_branch_id?: number | null;
  status?: CustomerStatus;
  status_reason?: string | null;
  vip?: boolean;
  tags?: string[];
  favourite_services?: string[];
  pickup_preference?: PickupPreference;
  preferred_locale?: "en" | "ar" | null;
  marketing_opt_in?: boolean;
  since?: string;
  created_by_user_id: number | null;
}

export type UpdateCustomerData = Partial<Omit<CreateCustomerData, "business_id" | "created_by_user_id">> & {
  updated_by_user_id: number | null;
};

/* ---------------------------------------------------------------------- */
/*  Column selection                                                       */
/*                                                                         */
/*  Declared once so every read returns the same shape. `search_vector` is  */
/*  deliberately excluded — it is an internal index artefact, not data the  */
/*  API should ever emit.                                                   */
/* ---------------------------------------------------------------------- */

const CUSTOMER_COLUMNS = [
  "id", "business_id", "preferred_branch_id", "name", "address", "phone",
  "whatsapp", "email", "photo_url", "maps_url", "emirates_id", "tax_number",
  "status", "status_reason", "status_changed_at", "vip", "tags",
  "favourite_services", "pickup_preference", "preferred_locale",
  "marketing_opt_in", "since", "created_at", "updated_at", "deleted_at",
] as const;

/* ---------------------------------------------------------------------- */
/*  Reads                                                                  */
/* ---------------------------------------------------------------------- */

/**
 * Fetch one customer by id.
 *
 * Returns undefined when the row does not exist OR belongs to another tenant
 * (RLS makes those two cases indistinguishable, which is exactly what we want
 * for IDOR resistance — see OWASP A01).
 */
export async function findById(
  trx: Transaction<Database>,
  id: number,
  opts: { includeDeleted?: boolean } = {},
): Promise<CustomerRow | undefined> {
  let q = trx.selectFrom("customers").select(CUSTOMER_COLUMNS).where("id", "=", id);
  if (!opts.includeDeleted) q = q.where("deleted_at", "is", null);
  return (await q.executeTakeFirst()) as CustomerRow | undefined;
}

/** Fetch by phone within the tenant. Used for duplicate detection. */
export async function findByPhone(
  trx: Transaction<Database>,
  phone: string,
): Promise<CustomerRow | undefined> {
  return (await trx
    .selectFrom("customers")
    .select(CUSTOMER_COLUMNS)
    .where("phone", "=", phone)
    .where("deleted_at", "is", null)
    .executeTakeFirst()) as CustomerRow | undefined;
}

/**
 * Apply filters shared by list() and count().
 *
 * Search uses the generated tsvector column. `websearch_to_tsquery` is used
 * rather than `plainto_tsquery` because it tolerates arbitrary user input
 * (quotes, OR, minus) without throwing — important when the search box is
 * fed whatever a cashier types.
 *
 * The search term is passed as a bound parameter, never interpolated.
 */
function applyFilters<O>(
  qb: SelectQueryBuilder<Database, "customers", O>,
  businessId: number,
  f: ListFilters,
): SelectQueryBuilder<Database, "customers", O> {
  let q = qb.where("customers.business_id", "=", businessId);

  if (f.onlyDeleted) {
    q = q.where("customers.deleted_at", "is not", null);
  } else if (!f.includeDeleted) {
    q = q.where("customers.deleted_at", "is", null);
  }

  if (f.search && f.search.trim() !== "") {
    const term = f.search.trim();
    q = q.where(
      sql<boolean>`customers.search_vector @@ websearch_to_tsquery('simple', normalize_arabic(${term}))`,
    );
  }

  if (f.status) q = q.where("customers.status", "=", f.status);
  if (f.vip !== undefined) q = q.where("customers.vip", "=", f.vip);
  if (f.marketingOptIn !== undefined) q = q.where("customers.marketing_opt_in", "=", f.marketingOptIn);

  if (f.tags && f.tags.length > 0) {
    // Array containment: the customer must carry every requested tag.
    q = q.where(sql<boolean>`customers.tags @> ${sql.val(f.tags)}::text[]`);
  }

  // hasDebt is a Phase 3 concern — outstanding is always 0 until orders exist.
  // Applying it now would silently return nothing, which is worse than
  // ignoring it, so we make the no-op explicit rather than pretending.
  // (The API documents this; see service.ts.)

  return q;
}

/**
 * Cursor-paginated list.
 *
 * The cursor is (created_at, id) which is a total order — id breaks ties when
 * two customers share a created_at to the microsecond. Both are indexed.
 *
 * For name/phone sorts we still tiebreak on id so the ordering is stable
 * across pages, but those sorts fall back to a sequential scan on large
 * tables; that is acceptable because they are not the default and are used
 * on filtered subsets.
 */
export async function list(
  trx: Transaction<Database>,
  businessId: number,
  filters: ListFilters,
  opts: ListOptions,
): Promise<CustomerRow[]> {
  let q = applyFilters(
    trx.selectFrom("customers").select(CUSTOMER_COLUMNS),
    businessId,
    filters,
  );

  const dir = opts.direction;
  const flip = dir === "asc" ? "desc" : "asc";

  if (opts.sort === "created_at") {
    if (opts.cursor) {
      const { createdAt, id } = opts.cursor;
      // Keyset pagination. Strictly after (or before) the cursor tuple.
      q = dir === "desc"
        ? q.where(sql<boolean>`(customers.created_at, customers.id) < (${createdAt}::timestamptz, ${id}::bigint)`)
        : q.where(sql<boolean>`(customers.created_at, customers.id) > (${createdAt}::timestamptz, ${id}::bigint)`);
    }
    q = q.orderBy("customers.created_at", dir).orderBy("customers.id", dir);
  } else if (opts.sort === "name") {
    // Sort by whichever language side is populated; English first for stability.
    q = q
      .orderBy(sql`coalesce(nullif(customers.name->>'en',''), customers.name->>'ar')`, dir)
      .orderBy("customers.id", dir);
    if (opts.cursor) q = q.offset(0); // name-sort uses page-number fallback; see service
  } else if (opts.sort === "phone") {
    q = q.orderBy("customers.phone", dir).orderBy("customers.id", dir);
  } else {
    // last_visit is a Phase 3 field; until then it is uniformly NULL, so we
    // fall back to created_at to keep ordering deterministic.
    q = q.orderBy("customers.created_at", dir).orderBy("customers.id", dir);
  }

  void flip;
  return (await q.limit(opts.limit).execute()) as CustomerRow[];
}

/** Total matching rows for the same filters. Used for pagination metadata. */
export async function count(
  trx: Transaction<Database>,
  businessId: number,
  filters: ListFilters,
): Promise<number> {
  const row = await applyFilters(
    trx.selectFrom("customers").select(({ fn }) => fn.countAll<string>().as("n")),
    businessId,
    filters,
  ).executeTakeFirstOrThrow();
  return Number(row.n);
}

/** Stats for one customer, from the customer_stats view. */
export async function statsFor(
  trx: Transaction<Database>,
  customerId: number,
): Promise<CustomerStats | undefined> {
  const row = await trx
    .selectFrom("customer_stats")
    .select([
      "orders_count", "completed_count", "cancelled_count", "pieces",
      "lifetime_spend", "lifetime_paid", "outstanding", "loyalty_points",
      "last_visit_at", "first_order_at",
    ])
    .where("customer_id", "=", customerId)
    .executeTakeFirst();
  return row as CustomerStats | undefined;
}

/** Aggregate statistics across the whole tenant. */
export async function businessStatistics(
  trx: Transaction<Database>,
  businessId: number,
): Promise<{
  total: number;
  active: number;
  inactive: number;
  blocked: number;
  vip: number;
  deleted: number;
  marketing_opt_in: number;
  added_last_30_days: number;
}> {
  const row = await trx
    .selectFrom("customers")
    .select(({ fn, eb }) => [
      fn.countAll<string>().filterWhere("deleted_at", "is", null).as("total"),
      fn.countAll<string>().filterWhere(eb.and([eb("deleted_at", "is", null), eb("status", "=", "active")])).as("active"),
      fn.countAll<string>().filterWhere(eb.and([eb("deleted_at", "is", null), eb("status", "=", "inactive")])).as("inactive"),
      fn.countAll<string>().filterWhere(eb.and([eb("deleted_at", "is", null), eb("status", "=", "blocked")])).as("blocked"),
      fn.countAll<string>().filterWhere(eb.and([eb("deleted_at", "is", null), eb("vip", "=", true)])).as("vip"),
      fn.countAll<string>().filterWhere("deleted_at", "is not", null).as("deleted"),
      fn.countAll<string>().filterWhere(eb.and([eb("deleted_at", "is", null), eb("marketing_opt_in", "=", true)])).as("marketing_opt_in"),
      fn.countAll<string>().filterWhere(
        eb.and([eb("deleted_at", "is", null), eb(sql`customers.created_at`, ">", sql`now() - interval '30 days'`)]),
      ).as("added_last_30_days"),
    ])
    .where("business_id", "=", businessId)
    .executeTakeFirstOrThrow();

  return {
    total: Number(row.total),
    active: Number(row.active),
    inactive: Number(row.inactive),
    blocked: Number(row.blocked),
    vip: Number(row.vip),
    deleted: Number(row.deleted),
    marketing_opt_in: Number(row.marketing_opt_in),
    added_last_30_days: Number(row.added_last_30_days),
  };
}

/**
 * Unpaid-order guard for deletion.
 *
 * Queries `orders` directly rather than through the orders repository — the
 * same cross-module read-only pattern branches/repository.ts already uses
 * for `historicalOrderCount` (both live inside the same RLS-scoped
 * transaction, so this is safe and consistent, not a new precedent).
 *
 * "Unpaid" = a non-deleted order for this customer where the outstanding
 * balance (total - paid_amount) is greater than zero, regardless of order
 * status. A cancelled or lost order that already collected a deposit still
 * represents money owed; the order's own lifecycle does not erase a real
 * debt. Soft-deleted orders are excluded — `orders.deleteOrder` already
 * refuses to soft-delete any order with `paid_amount > 0`, so an order that
 * reached deletion can only have collected nothing, and once deleted it is
 * no longer part of the customer's live picture.
 *
 * Returns both a count and the total outstanding amount so the caller gets
 * an informative error rather than a bare yes/no.
 */
export async function unpaidOrderSummary(
  trx: Transaction<Database>,
  customerId: number,
): Promise<{ count: number; totalOutstanding: number }> {
  const row = await trx
    .selectFrom("orders")
    .select(({ fn }) => [
      fn.countAll<string>().as("n"),
      // A plain column reference is all fn.sum() is typed for (see
      // orders/repository.ts's refundedTotalFor for the established
      // precedent); an aggregate over a computed expression goes through a
      // raw tagged template instead, matching how every other non-trivial
      // predicate in this codebase is built.
      sql<string | null>`sum(orders.total - orders.paid_amount)`.as("outstanding"),
    ])
    .where("customer_id", "=", customerId)
    .where("deleted_at", "is", null)
    .where(sql<boolean>`orders.total > orders.paid_amount`)
    .executeTakeFirstOrThrow();

  return {
    count: Number(row.n),
    totalOutstanding: row.outstanding ? Number(row.outstanding) : 0,
  };
}

/* ---------------------------------------------------------------------- */
/*  Writes                                                                 */
/* ---------------------------------------------------------------------- */

export async function insert(
  trx: Transaction<Database>,
  data: CreateCustomerData,
): Promise<CustomerRow> {
  const row = await trx
    .insertInto("customers")
    .values({
      business_id: data.business_id,
      name: data.name as never,
      address: (data.address ?? null) as never,
      phone: data.phone,
      whatsapp: data.whatsapp ?? null,
      email: data.email ?? null,
      photo_url: data.photo_url ?? null,
      maps_url: data.maps_url ?? null,
      emirates_id: data.emirates_id ?? null,
      tax_number: data.tax_number ?? null,
      preferred_branch_id: data.preferred_branch_id ?? null,
      status: data.status ?? "active",
      status_reason: data.status_reason ?? null,
      status_changed_at: data.status ? (sql`now()` as never) : null,
      vip: data.vip ?? false,
      tags: data.tags ?? [],
      favourite_services: data.favourite_services ?? [],
      pickup_preference: data.pickup_preference ?? "none",
      preferred_locale: data.preferred_locale ?? null,
      marketing_opt_in: data.marketing_opt_in ?? false,
      since: data.since,
      created_by_user_id: data.created_by_user_id,
      updated_by_user_id: data.created_by_user_id,
    })
    .returning(CUSTOMER_COLUMNS)
    .executeTakeFirstOrThrow();
  return row as CustomerRow;
}

export async function update(
  trx: Transaction<Database>,
  id: number,
  data: UpdateCustomerData,
): Promise<CustomerRow | undefined> {
  // Build the patch explicitly. Spreading user input into .set() would let an
  // unexpected key reach the UPDATE statement; enumerating is safer.
  const patch: Record<string, unknown> = { updated_by_user_id: data.updated_by_user_id };

  if (data.name !== undefined) patch.name = data.name;
  if (data.address !== undefined) patch.address = data.address;
  if (data.phone !== undefined) patch.phone = data.phone;
  if (data.whatsapp !== undefined) patch.whatsapp = data.whatsapp;
  if (data.email !== undefined) patch.email = data.email;
  if (data.photo_url !== undefined) patch.photo_url = data.photo_url;
  if (data.maps_url !== undefined) patch.maps_url = data.maps_url;
  if (data.emirates_id !== undefined) patch.emirates_id = data.emirates_id;
  if (data.tax_number !== undefined) patch.tax_number = data.tax_number;
  if (data.preferred_branch_id !== undefined) patch.preferred_branch_id = data.preferred_branch_id;
  if (data.vip !== undefined) patch.vip = data.vip;
  if (data.tags !== undefined) patch.tags = data.tags;
  if (data.favourite_services !== undefined) patch.favourite_services = data.favourite_services;
  if (data.pickup_preference !== undefined) patch.pickup_preference = data.pickup_preference;
  if (data.preferred_locale !== undefined) patch.preferred_locale = data.preferred_locale;
  if (data.marketing_opt_in !== undefined) patch.marketing_opt_in = data.marketing_opt_in;
  if (data.since !== undefined) patch.since = data.since;

  if (data.status !== undefined) {
    patch.status = data.status;
    patch.status_reason = data.status_reason ?? null;
    patch.status_changed_at = sql`now()`;
  }

  const row = await trx
    .updateTable("customers")
    .set(patch as never)
    .where("id", "=", id)
    .where("deleted_at", "is", null)
    .returning(CUSTOMER_COLUMNS)
    .executeTakeFirst();
  return row as CustomerRow | undefined;
}

/** Soft delete. The row remains, `deleted_at` is stamped. */
export async function softDelete(
  trx: Transaction<Database>,
  id: number,
  userId: number | null,
): Promise<CustomerRow | undefined> {
  const row = await trx
    .updateTable("customers")
    .set({
      deleted_at: sql`now()` as never,
      deleted_by_user_id: userId,
    })
    .where("id", "=", id)
    .where("deleted_at", "is", null)
    .returning(CUSTOMER_COLUMNS)
    .executeTakeFirst();
  return row as CustomerRow | undefined;
}

/** Restore a soft-deleted customer. */
export async function restore(
  trx: Transaction<Database>,
  id: number,
  userId: number | null,
): Promise<CustomerRow | undefined> {
  const row = await trx
    .updateTable("customers")
    .set({
      deleted_at: null,
      deleted_by_user_id: null,
      updated_by_user_id: userId,
    })
    .where("id", "=", id)
    .where("deleted_at", "is not", null)
    .returning(CUSTOMER_COLUMNS)
    .executeTakeFirst();
  return row as CustomerRow | undefined;
}

/* ---------------------------------------------------------------------- */
/*  Notes                                                                  */
/* ---------------------------------------------------------------------- */

export interface NoteRow {
  id: number;
  customer_id: number;
  body: string;
  pinned: boolean;
  created_by_user_id: number | null;
  created_at: string;
  updated_at: string;
}

export async function listNotes(
  trx: Transaction<Database>,
  customerId: number,
): Promise<NoteRow[]> {
  return (await trx
    .selectFrom("customer_notes")
    .select(["id", "customer_id", "body", "pinned", "created_by_user_id", "created_at", "updated_at"])
    .where("customer_id", "=", customerId)
    .where("deleted_at", "is", null)
    // Pinned notes first, then newest.
    .orderBy("pinned", "desc")
    .orderBy("created_at", "desc")
    .execute()) as NoteRow[];
}

export async function insertNote(
  trx: Transaction<Database>,
  data: { business_id: number; customer_id: number; body: string; pinned: boolean; created_by_user_id: number | null },
): Promise<NoteRow> {
  const row = await trx
    .insertInto("customer_notes")
    .values(data)
    .returning(["id", "customer_id", "body", "pinned", "created_by_user_id", "created_at", "updated_at"])
    .executeTakeFirstOrThrow();
  return row as NoteRow;
}

export async function findNote(
  trx: Transaction<Database>,
  noteId: number,
): Promise<(NoteRow & { business_id: number }) | undefined> {
  return (await trx
    .selectFrom("customer_notes")
    .select(["id", "business_id", "customer_id", "body", "pinned", "created_by_user_id", "created_at", "updated_at"])
    .where("id", "=", noteId)
    .where("deleted_at", "is", null)
    .executeTakeFirst()) as (NoteRow & { business_id: number }) | undefined;
}

export async function softDeleteNote(
  trx: Transaction<Database>,
  noteId: number,
): Promise<boolean> {
  const res = await trx
    .updateTable("customer_notes")
    .set({ deleted_at: sql`now()` as never })
    .where("id", "=", noteId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  return Number(res.numUpdatedRows ?? 0) > 0;
}

/* ---------------------------------------------------------------------- */
/*  Activity history                                                       */
/* ---------------------------------------------------------------------- */

export interface ActivityRow {
  id: number;
  action: string;
  user_id: number | null;
  role_key: string | null;
  before: unknown;
  after: unknown;
  occurred_at: string;
}

/**
 * Activity history for one customer, read from the append-only audit log.
 *
 * This is the same table that records every other resource's changes; we
 * filter to this customer. Because activity_logs is RLS-protected and
 * append-only, this history cannot be forged or edited.
 */
export async function activityFor(
  trx: Transaction<Database>,
  customerId: number,
  limit: number,
  beforeId?: number,
): Promise<ActivityRow[]> {
  let q = trx
    .selectFrom("activity_logs")
    .select(["id", "action", "user_id", "role_key", "before", "after", "occurred_at"])
    .where("resource_type", "=", "customer")
    .where("resource_id", "=", customerId);

  if (beforeId) q = q.where("id", "<", beforeId);

  return (await q.orderBy("id", "desc").limit(limit).execute()) as ActivityRow[];
}
