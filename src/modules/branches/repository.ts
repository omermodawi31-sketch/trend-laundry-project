/**
 * Branches repository.
 *
 * The only place in the codebase that issues SQL against `branches`
 * (management concerns) and the query that checks for historical orders
 * before a delete is allowed.
 *
 * Every function takes a `Transaction<Database>` as its first argument,
 * supplied by `withTenant(...)` in the service layer — RLS is active for
 * every query here, exactly as in the customers and orders repositories.
 */

import { sql, type Transaction } from "kysely";
import type { Database } from "../../lib/db.js";
import type { Bilingual } from "../../shared/types.js";

/* ---------------------------------------------------------------------- */
/*  Types                                                                  */
/* ---------------------------------------------------------------------- */

export interface WorkingHoursDay {
  open: string;   // "HH:MM", 24h
  close: string;  // "HH:MM", 24h
}

export type WorkingHours = Partial<
  Record<"sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat", WorkingHoursDay | null>
>;

export interface BranchRow {
  id: number;
  business_id: number;
  name: Bilingual;
  code: string;
  address: Bilingual;
  phone: string | null;
  email: string | null;
  maps_url: string | null;
  latitude: string | null;
  longitude: string | null;
  working_hours: WorkingHours | null;
  logo_url: string | null;
  manager_user_id: number | null;
  sort_order: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface ListFilters {
  isActive?: boolean;
  includeDeleted?: boolean;
  onlyDeleted?: boolean;
  search?: string;
}

export interface CreateBranchData {
  business_id: number;
  name: Bilingual;
  code: string;
  address: Bilingual;
  phone?: string | null;
  email?: string | null;
  maps_url?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  working_hours?: WorkingHours | null;
  logo_url?: string | null;
  manager_user_id?: number | null;
  sort_order?: number;
  is_active?: boolean;
  created_by_user_id: number | null;
}

export type UpdateBranchData = Partial<Omit<CreateBranchData, "business_id" | "created_by_user_id">> & {
  updated_by_user_id: number | null;
};

const BRANCH_COLUMNS = [
  "id", "business_id", "name", "code", "address", "phone", "email",
  "maps_url", "latitude", "longitude", "working_hours", "logo_url",
  "manager_user_id", "sort_order", "is_active", "created_at", "updated_at",
  "deleted_at",
] as const;

/* ---------------------------------------------------------------------- */
/*  Reads                                                                  */
/* ---------------------------------------------------------------------- */

/**
 * Point read.
 *
 * Returns undefined for both "does not exist" and "belongs to another
 * tenant" — RLS makes those the same case, which is what keeps this an IDOR
 * dead end (see OWASP-COMPLIANCE.md §A01, and the identical pattern in
 * customers/repository.ts and orders/repository.ts).
 */
export async function findById(
  trx: Transaction<Database>,
  id: number,
  opts: { includeDeleted?: boolean } = {},
): Promise<BranchRow | undefined> {
  let q = trx.selectFrom("branches").select(BRANCH_COLUMNS).where("id", "=", id);
  if (!opts.includeDeleted) q = q.where("deleted_at", "is", null);
  return (await q.executeTakeFirst()) as BranchRow | undefined;
}

/** Duplicate-code pre-check, used for a friendly error before the DB constraint fires. */
export async function findByCode(
  trx: Transaction<Database>,
  code: string,
): Promise<BranchRow | undefined> {
  return (await trx
    .selectFrom("branches")
    .select(BRANCH_COLUMNS)
    .where("code", "=", code)
    .where("deleted_at", "is", null)
    .executeTakeFirst()) as BranchRow | undefined;
}

/**
 * List branches for the tenant.
 *
 * Deliberately NOT branch-scope-filtered — branch metadata (name, code,
 * address, hours) is organisational information any authenticated member
 * with `settings.read` may see, even a manager scoped to a single branch.
 * "Branch managers can only manage their assigned branches" governs writes
 * (see branch-scope.ts), not visibility of the branch network. Documented
 * here because it is the one place this module's read model diverges from
 * the orders module's OR-scoped reads, and that divergence is a deliberate
 * choice, not an oversight — see PHASE-4-REPORT.md.
 *
 * Small table (a business has single digits to low hundreds of branches,
 * never thousands) — plain offset-free full list with a display-order sort
 * is simpler than a cursor and there is no pagination need at this scale.
 */
export async function list(
  trx: Transaction<Database>,
  businessId: number,
  filters: ListFilters,
): Promise<BranchRow[]> {
  let q = trx.selectFrom("branches").select(BRANCH_COLUMNS).where("business_id", "=", businessId);

  if (filters.onlyDeleted) {
    q = q.where("deleted_at", "is not", null);
  } else if (!filters.includeDeleted) {
    q = q.where("deleted_at", "is", null);
  }

  if (filters.isActive !== undefined) q = q.where("is_active", "=", filters.isActive);

  if (filters.search && filters.search.trim() !== "") {
    const term = `%${filters.search.trim()}%`;
    q = q.where(
      sql<boolean>`(
           normalize_arabic(branches.name->>'en') ILIKE normalize_arabic(${term})
        OR normalize_arabic(branches.name->>'ar') ILIKE normalize_arabic(${term})
        OR branches.code ILIKE ${term}
      )`,
    );
  }

  return (await q.orderBy("sort_order", "asc").orderBy("id", "asc").execute()) as BranchRow[];
}

/**
 * Count non-deleted orders (in any status, including cancelled/lost — a
 * cancelled order is still a historical record) that reference this branch
 * through ANY of the three branch columns.
 *
 * This is the query "prevent deleting branches that contain historical
 * orders" is built on. Soft-deleted orders still count: their branch_id
 * columns are real foreign keys and the requirement is "existing orders must
 * always keep their branch references" — an order does not stop being
 * history just because it was itself later soft-deleted.
 */
export async function historicalOrderCount(
  trx: Transaction<Database>,
  branchId: number,
): Promise<number> {
  const row = await trx
    .selectFrom("orders")
    .select(({ fn }) => fn.countAll<string>().as("n"))
    .where((eb) =>
      eb.or([
        eb("intake_branch_id", "=", branchId),
        eb("processing_branch_id", "=", branchId),
        eb("collection_branch_id", "=", branchId),
      ]),
    )
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

/* ---------------------------------------------------------------------- */
/*  Writes                                                                 */
/* ---------------------------------------------------------------------- */

export async function insert(
  trx: Transaction<Database>,
  data: CreateBranchData,
): Promise<BranchRow> {
  const row = await trx
    .insertInto("branches")
    .values({
      business_id: data.business_id,
      name: data.name as never,
      code: data.code,
      address: data.address as never,
      phone: data.phone ?? null,
      email: data.email ?? null,
      maps_url: data.maps_url ?? null,
      latitude: data.latitude ?? null,
      longitude: data.longitude ?? null,
      working_hours: (data.working_hours ?? null) as never,
      logo_url: data.logo_url ?? null,
      manager_user_id: data.manager_user_id ?? null,
      sort_order: data.sort_order ?? 0,
      is_active: data.is_active ?? true,
      created_by_user_id: data.created_by_user_id,
      updated_by_user_id: data.created_by_user_id,
    })
    .returning(BRANCH_COLUMNS)
    .executeTakeFirstOrThrow();
  return row as BranchRow;
}

export async function update(
  trx: Transaction<Database>,
  id: number,
  data: UpdateBranchData,
): Promise<BranchRow | undefined> {
  // Explicit patch object, same discipline as customers/repository.ts:
  // spreading validated input into .set() would let an unexpected key reach
  // the UPDATE statement; enumerating each field closes that off.
  const patch: Record<string, unknown> = { updated_by_user_id: data.updated_by_user_id };

  if (data.name !== undefined) patch.name = data.name;
  if (data.code !== undefined) patch.code = data.code;
  if (data.address !== undefined) patch.address = data.address;
  if (data.phone !== undefined) patch.phone = data.phone;
  if (data.email !== undefined) patch.email = data.email;
  if (data.maps_url !== undefined) patch.maps_url = data.maps_url;
  if (data.latitude !== undefined) patch.latitude = data.latitude;
  if (data.longitude !== undefined) patch.longitude = data.longitude;
  if (data.working_hours !== undefined) patch.working_hours = data.working_hours;
  if (data.logo_url !== undefined) patch.logo_url = data.logo_url;
  if (data.manager_user_id !== undefined) patch.manager_user_id = data.manager_user_id;
  if (data.sort_order !== undefined) patch.sort_order = data.sort_order;
  if (data.is_active !== undefined) patch.is_active = data.is_active;

  const row = await trx
    .updateTable("branches")
    .set(patch as never)
    .where("id", "=", id)
    .where("deleted_at", "is", null)
    .returning(BRANCH_COLUMNS)
    .executeTakeFirst();
  return row as BranchRow | undefined;
}

/** Enable/disable. Kept separate from the general update() for the same
 * reason customers' status change is its own function: a distinct,
 * auditable action rather than a field edit buried in a bulk PATCH. */
export async function setActive(
  trx: Transaction<Database>,
  id: number,
  isActive: boolean,
  userId: number | null,
): Promise<BranchRow | undefined> {
  const row = await trx
    .updateTable("branches")
    .set({ is_active: isActive, updated_by_user_id: userId })
    .where("id", "=", id)
    .where("deleted_at", "is", null)
    .returning(BRANCH_COLUMNS)
    .executeTakeFirst();
  return row as BranchRow | undefined;
}

export async function softDelete(
  trx: Transaction<Database>,
  id: number,
  userId: number | null,
): Promise<BranchRow | undefined> {
  const row = await trx
    .updateTable("branches")
    .set({
      deleted_at: sql`now()` as never,
      deleted_by_user_id: userId,
      // A deleted branch cannot stay "active" — closes the gap where a
      // deleted-but-still-active row could otherwise be selected by other
      // modules' "active branches" filters if they ever forget the
      // deleted_at check.
      is_active: false,
    })
    .where("id", "=", id)
    .where("deleted_at", "is", null)
    .returning(BRANCH_COLUMNS)
    .executeTakeFirst();
  return row as BranchRow | undefined;
}

export async function restore(
  trx: Transaction<Database>,
  id: number,
  userId: number | null,
): Promise<BranchRow | undefined> {
  const row = await trx
    .updateTable("branches")
    .set({
      deleted_at: null,
      deleted_by_user_id: null,
      updated_by_user_id: userId,
      // Restored in a disabled state deliberately — re-enabling is a
      // separate, explicit decision via setActive(), same as how a restored
      // customer does not silently regain VIP status changes made mid-trash.
      is_active: false,
    })
    .where("id", "=", id)
    .where("deleted_at", "is not", null)
    .returning(BRANCH_COLUMNS)
    .executeTakeFirst();
  return row as BranchRow | undefined;
}

/* ---------------------------------------------------------------------- */
/*  Manager assignment validation                                          */
/* ---------------------------------------------------------------------- */

/**
 * True when `userId` has an active membership in this tenant (any role).
 *
 * Used to validate `manager_user_id` at write time — RLS on `memberships`
 * already means a cross-tenant user cannot be found here regardless, but the
 * explicit check produces a clean validation error instead of a silent
 * "assigned manager who isn't really on the team" state.
 */
export async function isActiveMemberOfTenant(
  trx: Transaction<Database>,
  userId: number,
): Promise<boolean> {
  const row = await trx
    .selectFrom("memberships")
    .select("id")
    .where("user_id", "=", userId)
    .where("is_active", "=", true)
    .executeTakeFirst();
  return row !== undefined;
}
