/**
 * Delivery repository.
 *
 * The only place in the codebase that issues SQL against `drivers`,
 * `delivery_jobs`, and `delivery_job_status_history`. Drivers and jobs are
 * kept in one module (like Orders keeps `services` alongside `orders`)
 * because they're as tightly coupled as that pair — a job cannot be
 * meaningfully understood without its driver, the same way an order line
 * cannot be understood without its service variant.
 *
 * Every function takes a `Transaction<Database>` supplied by `withTenant(...)`
 * — RLS is active on every query here, exactly as in every other repository.
 */

import { sql, type Transaction } from "kysely";
import type { Database } from "../../lib/db.js";
import type { Bilingual } from "../../shared/types.js";
import type {
  DeliveryJobType,
  DriverStatus,
  VehicleType,
} from "../../lib/db-schema.js";

/* ---------------------------------------------------------------------- */
/*  Row shapes                                                             */
/* ---------------------------------------------------------------------- */

export interface DriverRow {
  id: number;
  business_id: number;
  user_id: number;
  vehicle_type: VehicleType | null;
  plate_number: string | null;
  notes: string | null;
  status: DriverStatus;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** Driver row joined with the identity fields it deliberately doesn't duplicate. */
export interface DriverWithUserRow extends DriverRow {
  user_full_name: string;
  user_email: string;
  user_phone: string | null;
}

export interface JobRow {
  id: number;
  business_id: number;
  branch_id: number;
  order_id: number;
  driver_id: number | null;
  job_type: DeliveryJobType;
  status: string;
  address: Bilingual;
  scheduled_window_start: string | null;
  scheduled_window_end: string | null;
  fee: string;
  collect_amount: string | null;
  collected_amount: string | null;
  proof_photo_url: string | null;
  proof_signature_url: string | null;
  proof_latitude: string | null;
  proof_longitude: string | null;
  fail_reason: string | null;
  assigned_at: string | null;
  started_at: string | null;
  arrived_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** Job row joined with the assigned driver's user_id — the self-scope check needs this without a second query. */
export interface JobWithDriverUserRow extends JobRow {
  driver_user_id: number | null;
}

export interface HistoryRow {
  id: number;
  job_id: number;
  branch_id: number;
  from_status: string | null;
  to_status: string;
  reason: string | null;
  changed_by_user_id: number | null;
  occurred_at: string;
}

const DRIVER_COLUMNS = [
  "id", "business_id", "user_id", "vehicle_type", "plate_number", "notes",
  "status", "is_active", "created_at", "updated_at", "deleted_at",
] as const;

const JOB_COLUMNS = [
  "id", "business_id", "branch_id", "order_id", "driver_id", "job_type",
  "status", "address", "scheduled_window_start", "scheduled_window_end",
  "fee", "collect_amount", "collected_amount", "proof_photo_url",
  "proof_signature_url", "proof_latitude", "proof_longitude", "fail_reason",
  "assigned_at", "started_at", "arrived_at", "completed_at", "cancelled_at",
  "created_at", "updated_at", "deleted_at",
] as const;

/* ---------------------------------------------------------------------- */
/*  Drivers — reads                                                        */
/* ---------------------------------------------------------------------- */

export async function findById(
  trx: Transaction<Database>,
  id: number,
  opts: { includeDeleted?: boolean } = {},
): Promise<DriverRow | undefined> {
  let q = trx.selectFrom("drivers").select(DRIVER_COLUMNS).where("id", "=", id);
  if (!opts.includeDeleted) q = q.where("deleted_at", "is", null);
  return (await q.executeTakeFirst()) as DriverRow | undefined;
}

/** Joined with `users` for display — see the module header for why this isn't duplicated on `drivers` itself. */
export async function findByIdWithUser(
  trx: Transaction<Database>,
  id: number,
  opts: { includeDeleted?: boolean } = {},
): Promise<DriverWithUserRow | undefined> {
  let q = trx
    .selectFrom("drivers")
    .innerJoin("users", "users.id", "drivers.user_id")
    .select([
      ...DRIVER_COLUMNS.map((c) => `drivers.${c}` as const),
      "users.full_name as user_full_name",
      "users.email as user_email",
      "users.phone as user_phone",
    ])
    .where("drivers.id", "=", id);
  if (!opts.includeDeleted) q = q.where("drivers.deleted_at", "is", null);
  return (await q.executeTakeFirst()) as DriverWithUserRow | undefined;
}

export async function findByUserId(
  trx: Transaction<Database>,
  userId: number,
): Promise<DriverRow | undefined> {
  return (await trx
    .selectFrom("drivers")
    .select(DRIVER_COLUMNS)
    .where("user_id", "=", userId)
    .where("deleted_at", "is", null)
    .executeTakeFirst()) as DriverRow | undefined;
}

export interface ListDriverFilters {
  status?: DriverStatus;
  isActive?: boolean;
  includeDeleted?: boolean;
  onlyDeleted?: boolean;
}

export async function list(
  trx: Transaction<Database>,
  businessId: number,
  filters: ListDriverFilters,
): Promise<DriverWithUserRow[]> {
  let q = trx
    .selectFrom("drivers")
    .innerJoin("users", "users.id", "drivers.user_id")
    .select([
      ...DRIVER_COLUMNS.map((c) => `drivers.${c}` as const),
      "users.full_name as user_full_name",
      "users.email as user_email",
      "users.phone as user_phone",
    ])
    .where("drivers.business_id", "=", businessId);

  if (filters.onlyDeleted) q = q.where("drivers.deleted_at", "is not", null);
  else if (!filters.includeDeleted) q = q.where("drivers.deleted_at", "is", null);

  if (filters.status) q = q.where("drivers.status", "=", filters.status);
  if (filters.isActive !== undefined) q = q.where("drivers.is_active", "=", filters.isActive);

  return (await q.orderBy("users.full_name", "asc").execute()) as DriverWithUserRow[];
}

/**
 * Delete-guard: is this driver currently assigned to any non-terminal job?
 * Mirrors branches' historicalOrderCount / inventory's totalStockAcrossBranches
 * shape — a count-based guard checked before a soft-delete is allowed.
 */
export async function hasActiveJob(trx: Transaction<Database>, driverId: number): Promise<boolean> {
  const row = await trx
    .selectFrom("delivery_jobs")
    .select("id")
    .where("driver_id", "=", driverId)
    .where("status", "not in", ["completed", "failed", "cancelled"])
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  return row !== undefined;
}

/* ---------------------------------------------------------------------- */
/*  Drivers — writes                                                       */
/* ---------------------------------------------------------------------- */

export interface CreateDriverData {
  business_id: number;
  user_id: number;
  vehicle_type?: VehicleType | null;
  plate_number?: string | null;
  notes?: string | null;
  status?: DriverStatus;
  created_by_user_id: number | null;
}

export type UpdateDriverData = Partial<
  Omit<CreateDriverData, "business_id" | "user_id" | "created_by_user_id">
> & { updated_by_user_id: number | null };

export async function insert(trx: Transaction<Database>, data: CreateDriverData): Promise<DriverRow> {
  const row = await trx
    .insertInto("drivers")
    .values({
      business_id: data.business_id,
      user_id: data.user_id,
      vehicle_type: data.vehicle_type ?? null,
      plate_number: data.plate_number ?? null,
      notes: data.notes ?? null,
      status: data.status ?? "offline",
      created_by_user_id: data.created_by_user_id,
      updated_by_user_id: data.created_by_user_id,
    })
    .returning(DRIVER_COLUMNS)
    .executeTakeFirstOrThrow();
  return row as DriverRow;
}

export async function update(
  trx: Transaction<Database>,
  id: number,
  data: UpdateDriverData,
): Promise<DriverRow | undefined> {
  const patch: Record<string, unknown> = { updated_by_user_id: data.updated_by_user_id };
  if (data.vehicle_type !== undefined) patch.vehicle_type = data.vehicle_type;
  if (data.plate_number !== undefined) patch.plate_number = data.plate_number;
  if (data.notes !== undefined) patch.notes = data.notes;
  if (data.status !== undefined) patch.status = data.status;

  const row = await trx
    .updateTable("drivers")
    .set(patch as never)
    .where("id", "=", id)
    .where("deleted_at", "is", null)
    .returning(DRIVER_COLUMNS)
    .executeTakeFirst();
  return row as DriverRow | undefined;
}

export async function setStatus(
  trx: Transaction<Database>,
  id: number,
  status: DriverStatus,
  userId: number | null,
): Promise<DriverRow | undefined> {
  const row = await trx
    .updateTable("drivers")
    .set({ status, updated_by_user_id: userId })
    .where("id", "=", id)
    .where("deleted_at", "is", null)
    .returning(DRIVER_COLUMNS)
    .executeTakeFirst();
  return row as DriverRow | undefined;
}

export async function softDelete(
  trx: Transaction<Database>,
  id: number,
  userId: number | null,
): Promise<DriverRow | undefined> {
  const row = await trx
    .updateTable("drivers")
    .set({ deleted_at: sql`now()` as never, deleted_by_user_id: userId, is_active: false })
    .where("id", "=", id)
    .where("deleted_at", "is", null)
    .returning(DRIVER_COLUMNS)
    .executeTakeFirst();
  return row as DriverRow | undefined;
}

export async function restore(
  trx: Transaction<Database>,
  id: number,
  userId: number | null,
): Promise<DriverRow | undefined> {
  const row = await trx
    .updateTable("drivers")
    .set({ deleted_at: null, deleted_by_user_id: null, updated_by_user_id: userId, is_active: false })
    .where("id", "=", id)
    .where("deleted_at", "is not", null)
    .returning(DRIVER_COLUMNS)
    .executeTakeFirst();
  return row as DriverRow | undefined;
}

/* ---------------------------------------------------------------------- */
/*  Jobs — reads                                                           */
/* ---------------------------------------------------------------------- */

export async function findJobById(
  trx: Transaction<Database>,
  id: number,
  opts: { includeDeleted?: boolean } = {},
): Promise<JobWithDriverUserRow | undefined> {
  let q = trx
    .selectFrom("delivery_jobs")
    .leftJoin("drivers", "drivers.id", "delivery_jobs.driver_id")
    .select([
      ...JOB_COLUMNS.map((c) => `delivery_jobs.${c}` as const),
      "drivers.user_id as driver_user_id",
    ])
    .where("delivery_jobs.id", "=", id);
  if (!opts.includeDeleted) q = q.where("delivery_jobs.deleted_at", "is", null);
  return (await q.executeTakeFirst()) as JobWithDriverUserRow | undefined;
}

export interface ListJobFilters {
  status?: string;
  jobType?: DeliveryJobType;
  includeDeleted?: boolean;
  onlyDeleted?: boolean;
}

export async function listForBranch(
  trx: Transaction<Database>,
  businessId: number,
  branchId: number,
  filters: ListJobFilters,
): Promise<JobRow[]> {
  let q = trx
    .selectFrom("delivery_jobs")
    .select(JOB_COLUMNS)
    .where("business_id", "=", businessId)
    .where("branch_id", "=", branchId);

  if (filters.onlyDeleted) q = q.where("deleted_at", "is not", null);
  else if (!filters.includeDeleted) q = q.where("deleted_at", "is", null);
  if (filters.status) q = q.where("status", "=", filters.status);
  if (filters.jobType) q = q.where("job_type", "=", filters.jobType);

  return (await q.orderBy("created_at", "desc").execute()) as JobRow[];
}

export async function listForDriver(
  trx: Transaction<Database>,
  businessId: number,
  driverId: number,
  filters: ListJobFilters,
): Promise<JobRow[]> {
  let q = trx
    .selectFrom("delivery_jobs")
    .select(JOB_COLUMNS)
    .where("business_id", "=", businessId)
    .where("driver_id", "=", driverId);

  if (filters.onlyDeleted) q = q.where("deleted_at", "is not", null);
  else if (!filters.includeDeleted) q = q.where("deleted_at", "is", null);
  if (filters.status) q = q.where("status", "=", filters.status);

  return (await q.orderBy("created_at", "desc").execute()) as JobRow[];
}

export async function listForOrder(
  trx: Transaction<Database>,
  businessId: number,
  orderId: number,
): Promise<JobRow[]> {
  return (await trx
    .selectFrom("delivery_jobs")
    .select(JOB_COLUMNS)
    .where("business_id", "=", businessId)
    .where("order_id", "=", orderId)
    .where("deleted_at", "is", null)
    .orderBy("created_at", "desc")
    .execute()) as JobRow[];
}

/* ---------------------------------------------------------------------- */
/*  Jobs — writes                                                          */
/* ---------------------------------------------------------------------- */

export interface CreateJobData {
  business_id: number;
  branch_id: number;
  order_id: number;
  job_type: DeliveryJobType;
  address: Bilingual;
  scheduled_window_start?: string | null;
  scheduled_window_end?: string | null;
  fee: number;
  collect_amount?: number | null;
  created_by_user_id: number | null;
}

export async function insertJob(trx: Transaction<Database>, data: CreateJobData): Promise<JobRow> {
  const row = await trx
    .insertInto("delivery_jobs")
    .values({
      business_id: data.business_id,
      branch_id: data.branch_id,
      order_id: data.order_id,
      job_type: data.job_type,
      address: data.address as never,
      scheduled_window_start: data.scheduled_window_start ?? null,
      scheduled_window_end: data.scheduled_window_end ?? null,
      fee: data.fee,
      collect_amount: data.collect_amount ?? null,
      created_by_user_id: data.created_by_user_id,
      updated_by_user_id: data.created_by_user_id,
    } as never)
    .returning(JOB_COLUMNS)
    .executeTakeFirstOrThrow();
  return row as JobRow;
}

export interface UpdateJobData {
  address?: Bilingual;
  scheduled_window_start?: string | null;
  scheduled_window_end?: string | null;
  collect_amount?: number | null;
  updated_by_user_id: number | null;
}

export async function updateJob(
  trx: Transaction<Database>,
  id: number,
  data: UpdateJobData,
): Promise<JobRow | undefined> {
  const patch: Record<string, unknown> = { updated_by_user_id: data.updated_by_user_id };
  if (data.address !== undefined) patch.address = data.address;
  if (data.scheduled_window_start !== undefined) patch.scheduled_window_start = data.scheduled_window_start;
  if (data.scheduled_window_end !== undefined) patch.scheduled_window_end = data.scheduled_window_end;
  if (data.collect_amount !== undefined) patch.collect_amount = data.collect_amount;

  const row = await trx
    .updateTable("delivery_jobs")
    .set(patch as never)
    .where("id", "=", id)
    .where("deleted_at", "is", null)
    .returning(JOB_COLUMNS)
    .executeTakeFirst();
  return row as JobRow | undefined;
}

export async function assignDriver(
  trx: Transaction<Database>,
  id: number,
  driverId: number,
  userId: number | null,
): Promise<JobRow | undefined> {
  const row = await trx
    .updateTable("delivery_jobs")
    .set({
      driver_id: driverId,
      status: "assigned",
      assigned_at: sql`now()` as never,
      updated_by_user_id: userId,
    })
    .where("id", "=", id)
    .where("deleted_at", "is", null)
    .returning(JOB_COLUMNS)
    .executeTakeFirst();
  return row as JobRow | undefined;
}

export interface AdvanceStatusData {
  status: string;
  timestampColumn?: "started_at" | "arrived_at" | "completed_at" | "cancelled_at";
  fail_reason?: string | null;
  collected_amount?: number | null;
  proof_photo_url?: string | null;
  proof_signature_url?: string | null;
  proof_latitude?: number | null;
  proof_longitude?: number | null;
  updated_by_user_id: number | null;
}

/**
 * The one generic status-advancing writer, used by the status/complete/fail/
 * cancel service functions alike — mirrors how orders/repository.ts doesn't
 * have four separate "set status to X" functions either, just one that takes
 * the target status and whatever fields that particular transition needs.
 */
export async function advanceStatus(
  trx: Transaction<Database>,
  id: number,
  data: AdvanceStatusData,
): Promise<JobRow | undefined> {
  const patch: Record<string, unknown> = {
    status: data.status,
    updated_by_user_id: data.updated_by_user_id,
  };
  if (data.timestampColumn) patch[data.timestampColumn] = sql`now()`;
  if (data.fail_reason !== undefined) patch.fail_reason = data.fail_reason;
  if (data.collected_amount !== undefined) patch.collected_amount = data.collected_amount;
  if (data.proof_photo_url !== undefined) patch.proof_photo_url = data.proof_photo_url;
  if (data.proof_signature_url !== undefined) patch.proof_signature_url = data.proof_signature_url;
  if (data.proof_latitude !== undefined) patch.proof_latitude = data.proof_latitude;
  if (data.proof_longitude !== undefined) patch.proof_longitude = data.proof_longitude;

  const row = await trx
    .updateTable("delivery_jobs")
    .set(patch as never)
    .where("id", "=", id)
    .where("deleted_at", "is", null)
    .returning(JOB_COLUMNS)
    .executeTakeFirst();
  return row as JobRow | undefined;
}

export async function softDeleteJob(
  trx: Transaction<Database>,
  id: number,
  userId: number | null,
): Promise<JobRow | undefined> {
  const row = await trx
    .updateTable("delivery_jobs")
    .set({ deleted_at: sql`now()` as never, deleted_by_user_id: userId })
    .where("id", "=", id)
    .where("deleted_at", "is", null)
    .returning(JOB_COLUMNS)
    .executeTakeFirst();
  return row as JobRow | undefined;
}

export async function restoreJob(
  trx: Transaction<Database>,
  id: number,
  userId: number | null,
): Promise<JobRow | undefined> {
  const row = await trx
    .updateTable("delivery_jobs")
    .set({ deleted_at: null, deleted_by_user_id: null, updated_by_user_id: userId })
    .where("id", "=", id)
    .where("deleted_at", "is not", null)
    .returning(JOB_COLUMNS)
    .executeTakeFirst();
  return row as JobRow | undefined;
}

/* ---------------------------------------------------------------------- */
/*  Status history — append-only                                           */
/* ---------------------------------------------------------------------- */

export interface InsertHistoryData {
  business_id: number;
  job_id: number;
  branch_id: number;
  from_status: string | null;
  to_status: string;
  reason?: string | null;
  changed_by_user_id: number | null;
}

export async function insertStatusHistory(
  trx: Transaction<Database>,
  data: InsertHistoryData,
): Promise<HistoryRow> {
  const row = await trx
    .insertInto("delivery_job_status_history")
    .values({
      business_id: data.business_id,
      job_id: data.job_id,
      branch_id: data.branch_id,
      from_status: data.from_status,
      to_status: data.to_status,
      reason: data.reason ?? null,
      changed_by_user_id: data.changed_by_user_id,
    })
    .returning(["id", "job_id", "branch_id", "from_status", "to_status", "reason", "changed_by_user_id", "occurred_at"])
    .executeTakeFirstOrThrow();
  return row as HistoryRow;
}

export async function historyFor(trx: Transaction<Database>, jobId: number): Promise<HistoryRow[]> {
  return (await trx
    .selectFrom("delivery_job_status_history")
    .select(["id", "job_id", "branch_id", "from_status", "to_status", "reason", "changed_by_user_id", "occurred_at"])
    .where("job_id", "=", jobId)
    .orderBy("occurred_at", "asc")
    .execute()) as HistoryRow[];
}

/* ---------------------------------------------------------------------- */
/*  Cross-module lookups (order/branch), mirroring the established pattern */
/* ---------------------------------------------------------------------- */

/**
 * The exact data needed to derive a job's branch and validate the order —
 * same cross-module read-inside-one-RLS-transaction pattern already used by
 * branches (reading orders), customers (reading orders), and orders itself
 * (reading business_settings).
 */
export async function findOrderForJob(
  trx: Transaction<Database>,
  orderId: number,
): Promise<{
  id: number;
  status: string;
  intake_branch_id: number;
  collection_branch_id: number | null;
  deleted_at: string | null;
} | undefined> {
  return await trx
    .selectFrom("orders")
    .select(["id", "status", "intake_branch_id", "collection_branch_id", "deleted_at"])
    .where("id", "=", orderId)
    .executeTakeFirst();
}
