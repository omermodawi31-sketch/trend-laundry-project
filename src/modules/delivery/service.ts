/**
 * Delivery service.
 *
 * Invariants this file maintains:
 *   1. Drivers are business-scoped; no branch-scope check applies to driver
 *      CRUD at all, the same as the `services` catalogue.
 *   2. Every job read AND write requires the target branch in the caller's
 *      scope, UNLESS the caller is the job's assigned driver acting on
 *      their own job (self-scope, branch-scope.ts).
 *   3. Every job references a real order (final decision — no exceptions).
 *      `branch_id` is never client-supplied; it's derived from the order
 *      exactly the way `recordPayment` already derives a payment's branch:
 *      `order.collection_branch_id ?? order.intake_branch_id`.
 *   4. A delivery-type job's `fee` is read from `business_settings.delivery_fee`
 *      once, at creation, and never changes after — the same snapshot
 *      discipline `orders.vat_pct`/`express_pct`/`delivery_amount` already use.
 *   5. Completing a job with a COD amount records a real payment on the
 *      linked order by calling `orders/service.ts`'s `recordPaymentInTx`
 *      directly, inside the SAME transaction — not a second, independent
 *      one, and not a reimplemented guard.
 *   6. Every mutation writes an audit row in the same transaction as the
 *      change, exactly like every other module.
 */

import { withTenant } from "../../lib/db.js";
import { auditInTx, actorFromAuth } from "../../lib/audit.js";
import { Errors } from "../../lib/errors.js";
import type { AuthContext, Bilingual } from "../../shared/types.js";
import * as repo from "./repository.js";
import * as ordersRepo from "../orders/repository.js";
import { isActiveMemberOfTenant } from "../branches/repository.js";
import { recordPaymentInTx } from "../orders/service.js";
import { assertCanAccessBranch, assertCanActOnJob, canAccessBranch, isAssignedDriver } from "./branch-scope.js";
import { checkTransition, isEditable, type JobStatus } from "./transitions.js";
import type {
  AdvanceJobStatusInput,
  AssignDriverInput,
  CancelJobInput,
  CompleteJobInput,
  CreateDriverInput,
  CreateJobInput,
  FailJobInput,
  ListDriversQueryInput,
  ListJobsQueryInput,
  SetDriverStatusInput,
  UpdateDriverInput,
  UpdateJobInput,
} from "./schemas.js";

export interface RequestMeta {
  ipAddress: string | null;
  userAgent: string | null;
}

/* ---------------------------------------------------------------------- */
/*  Serialisation                                                          */
/* ---------------------------------------------------------------------- */

function n(v: string | null): number | null {
  return v === null ? null : Number(v);
}

function serialiseDriver(row: repo.DriverWithUserRow) {
  return {
    id: row.id,
    user_id: row.user_id,
    name: row.user_full_name,
    email: row.user_email,
    phone: row.user_phone,
    vehicle_type: row.vehicle_type,
    plate_number: row.plate_number,
    notes: row.notes,
    status: row.status,
    is_active: row.is_active,
    created_at: row.created_at,
    updated_at: row.updated_at,
    deleted_at: row.deleted_at,
  };
}

function serialiseJob(row: repo.JobRow) {
  return {
    id: row.id,
    branch_id: row.branch_id,
    order_id: row.order_id,
    driver_id: row.driver_id,
    job_type: row.job_type,
    status: row.status,
    address: row.address,
    scheduled_window_start: row.scheduled_window_start,
    scheduled_window_end: row.scheduled_window_end,
    fee: n(row.fee),
    collect_amount: n(row.collect_amount),
    collected_amount: n(row.collected_amount),
    proof: {
      photo_url: row.proof_photo_url,
      signature_url: row.proof_signature_url,
      latitude: row.proof_latitude === null ? null : Number(row.proof_latitude),
      longitude: row.proof_longitude === null ? null : Number(row.proof_longitude),
    },
    fail_reason: row.fail_reason,
    timestamps: {
      assigned_at: row.assigned_at,
      started_at: row.started_at,
      arrived_at: row.arrived_at,
      completed_at: row.completed_at,
      cancelled_at: row.cancelled_at,
    },
    created_at: row.created_at,
    updated_at: row.updated_at,
    deleted_at: row.deleted_at,
  };
}

function serialiseHistory(row: repo.HistoryRow) {
  return {
    id: row.id,
    from_status: row.from_status,
    to_status: row.to_status,
    reason: row.reason,
    changed_by_user_id: row.changed_by_user_id,
    occurred_at: row.occurred_at,
  };
}

function normaliseBilingual(input: { en: string; ar: string }): Bilingual {
  return { en: (input.en ?? "").trim(), ar: (input.ar ?? "").trim() };
}

/* ---------------------------------------------------------------------- */
/*  Drivers — commands                                                     */
/* ---------------------------------------------------------------------- */

export async function createDriver(auth: AuthContext, input: CreateDriverInput, meta: RequestMeta) {
  return withTenant({ businessId: auth.businessId, userId: auth.userId }, async (trx) => {
    // "Every driver has a normal user account" — validated the same way
    // branches.manager_user_id is: the user must be an active member of
    // this tenant. RLS on `memberships` already makes a cross-tenant user
    // id unreachable here regardless; this check turns that into a clean
    // 422 instead of a silent orphaned reference. Reused directly from
    // branches/repository.ts rather than duplicated — same check, same
    // query, same reasoning.
    const isMember = await isActiveMemberOfTenant(trx, input.user_id);
    if (!isMember) {
      throw Errors.validation("user_id must be an active member of this business.", { field: "user_id" });
    }

    const existing = await repo.findByUserId(trx, input.user_id);
    if (existing) {
      throw Errors.conflict("driver-exists-for-user", "This user already has a driver profile.", {
        driver_id: existing.id,
      });
    }

    const row = await repo.insert(trx, {
      business_id: auth.businessId,
      user_id: input.user_id,
      vehicle_type: input.vehicle_type ?? null,
      plate_number: input.plate_number ?? null,
      notes: input.notes ?? null,
      created_by_user_id: auth.userId,
    });

    const withUser = await repo.findByIdWithUser(trx, row.id);
    if (!withUser) throw Errors.notFound("Driver");

    await auditInTx(trx, actorFromAuth(auth, meta.ipAddress, meta.userAgent), {
      action: "driver.create",
      resourceType: "driver",
      resourceId: row.id,
      after: { user_id: row.user_id, vehicle_type: row.vehicle_type, plate_number: row.plate_number },
    });

    return serialiseDriver(withUser);
  });
}

export async function updateDriver(auth: AuthContext, id: number, input: UpdateDriverInput, meta: RequestMeta) {
  return withTenant({ businessId: auth.businessId, userId: auth.userId }, async (trx) => {
    const before = await repo.findById(trx, id);
    if (!before) throw Errors.notFound("Driver");

    const after = await repo.update(trx, id, {
      ...(input.vehicle_type !== undefined ? { vehicle_type: input.vehicle_type } : {}),
      ...(input.plate_number !== undefined ? { plate_number: input.plate_number } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      updated_by_user_id: auth.userId,
    });
    if (!after) throw Errors.notFound("Driver");

    await auditInTx(trx, actorFromAuth(auth, meta.ipAddress, meta.userAgent), {
      action: "driver.update",
      resourceType: "driver",
      resourceId: id,
      before: { vehicle_type: before.vehicle_type, plate_number: before.plate_number, notes: before.notes },
      after: { vehicle_type: after.vehicle_type, plate_number: after.plate_number, notes: after.notes },
    });

    const withUser = await repo.findByIdWithUser(trx, id);
    if (!withUser) throw Errors.notFound("Driver");
    return serialiseDriver(withUser);
  });
}

/**
 * Toggle a driver's own live status. Self-or-override: the driver
 * themselves (matched by user id, not permission) may always set their own
 * status; anyone else needs `delivery.dispatch` (checked at the route
 * level via a second permission, OR here — see routes.ts for how the two
 * compose).
 */
export async function setDriverStatus(auth: AuthContext, id: number, input: SetDriverStatusInput, meta: RequestMeta) {
  return withTenant({ businessId: auth.businessId, userId: auth.userId }, async (trx) => {
    const before = await repo.findById(trx, id);
    if (!before) throw Errors.notFound("Driver");

    const isSelf = before.user_id === auth.userId;
    if (!isSelf && !auth.permissions.includes("delivery.dispatch")) {
      throw Errors.unauthorized();
    }

    if (before.status === input.status) {
      const withUser = await repo.findByIdWithUser(trx, id);
      return serialiseDriver(withUser!);
    }

    const after = await repo.setStatus(trx, id, input.status, auth.userId);
    if (!after) throw Errors.notFound("Driver");

    await auditInTx(trx, actorFromAuth(auth, meta.ipAddress, meta.userAgent), {
      action: "driver.status_change",
      resourceType: "driver",
      resourceId: id,
      before: { status: before.status },
      after: { status: after.status },
    });

    const withUser = await repo.findByIdWithUser(trx, id);
    return serialiseDriver(withUser!);
  });
}

export async function deleteDriver(auth: AuthContext, id: number, meta: RequestMeta) {
  return withTenant({ businessId: auth.businessId, userId: auth.userId }, async (trx) => {
    const before = await repo.findById(trx, id);
    if (!before) throw Errors.notFound("Driver");

    const active = await repo.hasActiveJob(trx, id);
    if (active) {
      throw Errors.conflict(
        "driver-has-active-job",
        "This driver has an active job assigned and cannot be deleted. Reassign or complete it first, or disable the driver instead.",
      );
    }

    const row = await repo.softDelete(trx, id, auth.userId);
    if (!row) throw Errors.notFound("Driver");

    await auditInTx(trx, actorFromAuth(auth, meta.ipAddress, meta.userAgent), {
      action: "driver.delete",
      resourceType: "driver",
      resourceId: id,
    });

    return { id, deleted_at: row.deleted_at };
  });
}

export async function restoreDriver(auth: AuthContext, id: number, meta: RequestMeta) {
  return withTenant({ businessId: auth.businessId, userId: auth.userId }, async (trx) => {
    const before = await repo.findById(trx, id, { includeDeleted: true });
    if (!before) throw Errors.notFound("Driver");
    if (!before.deleted_at) throw Errors.conflict("driver-not-deleted", "This driver is not deleted.");

    const row = await repo.restore(trx, id, auth.userId);
    if (!row) throw Errors.notFound("Driver");

    await auditInTx(trx, actorFromAuth(auth, meta.ipAddress, meta.userAgent), {
      action: "driver.restore",
      resourceType: "driver",
      resourceId: id,
    });

    const withUser = await repo.findByIdWithUser(trx, id);
    return serialiseDriver(withUser!);
  });
}

/* ---------------------------------------------------------------------- */
/*  Drivers — queries                                                      */
/* ---------------------------------------------------------------------- */

export async function getDriver(auth: AuthContext, id: number) {
  return withTenant({ businessId: auth.businessId, userId: auth.userId }, async (trx) => {
    const row = await repo.findByIdWithUser(trx, id, { includeDeleted: true });
    if (!row) throw Errors.notFound("Driver");
    return serialiseDriver(row);
  });
}

export async function listDrivers(auth: AuthContext, query: ListDriversQueryInput) {
  return withTenant({ businessId: auth.businessId, userId: auth.userId }, async (trx) => {
    const rows = await repo.list(trx, auth.businessId, {
      status: query.status,
      isActive: query.is_active,
      includeDeleted: query.deleted === "include",
      onlyDeleted: query.deleted === "only",
    });
    return { data: rows.map((r) => serialiseDriver(r)) };
  });
}

/* ---------------------------------------------------------------------- */
/*  Jobs — commands                                                        */
/* ---------------------------------------------------------------------- */

export async function createJob(auth: AuthContext, input: CreateJobInput, meta: RequestMeta) {
  return withTenant({ businessId: auth.businessId, userId: auth.userId }, async (trx) => {
    const order = await repo.findOrderForJob(trx, input.order_id);
    if (!order || order.deleted_at) throw Errors.notFound("Order");
    if (order.status === "cancelled" || order.status === "lost") {
      throw Errors.conflict("order-not-deliverable", "A cancelled or lost order cannot have a delivery job.");
    }

    // Derived, not client-supplied — the exact expression recordPayment
    // already uses to attribute a payment's branch.
    const branchId = order.collection_branch_id ?? order.intake_branch_id;
    assertCanAccessBranch(auth, branchId);

    let fee = 0;
    if (input.job_type === "delivery") {
      const business = await ordersRepo.findBusinessSettings(trx, auth.businessId);
      if (!business) throw new Error(`business_settings invariant broken: no row for business ${auth.businessId}`);
      fee = business.deliveryFee;
    }

    const row = await repo.insertJob(trx, {
      business_id: auth.businessId,
      branch_id: branchId,
      order_id: input.order_id,
      job_type: input.job_type,
      address: normaliseBilingual(input.address),
      scheduled_window_start: input.scheduled_window_start ?? null,
      scheduled_window_end: input.scheduled_window_end ?? null,
      fee,
      collect_amount: input.collect_amount ?? null,
      created_by_user_id: auth.userId,
    });

    await repo.insertStatusHistory(trx, {
      business_id: auth.businessId,
      job_id: row.id,
      branch_id: branchId,
      from_status: null,
      to_status: "scheduled",
      changed_by_user_id: auth.userId,
    });

    await auditInTx(trx, actorFromAuth(auth, meta.ipAddress, meta.userAgent), {
      action: "delivery_job.create",
      resourceType: "delivery_job",
      resourceId: row.id,
      branchId,
      after: { order_id: row.order_id, job_type: row.job_type, fee },
    });

    return serialiseJob(row);
  });
}

export async function updateJob(auth: AuthContext, id: number, input: UpdateJobInput, meta: RequestMeta) {
  return withTenant({ businessId: auth.businessId, userId: auth.userId }, async (trx) => {
    const before = await repo.findJobById(trx, id);
    if (!before) throw Errors.notFound("Delivery job");
    assertCanAccessBranch(auth, before.branch_id);

    if (!isEditable(before.status as JobStatus)) {
      throw Errors.conflict("job-not-editable", "This job can no longer be edited — it has already been assigned or progressed.");
    }

    const after = await repo.updateJob(trx, id, {
      ...(input.address !== undefined ? { address: normaliseBilingual(input.address) } : {}),
      ...(input.scheduled_window_start !== undefined ? { scheduled_window_start: input.scheduled_window_start } : {}),
      ...(input.scheduled_window_end !== undefined ? { scheduled_window_end: input.scheduled_window_end } : {}),
      ...(input.collect_amount !== undefined ? { collect_amount: input.collect_amount } : {}),
      updated_by_user_id: auth.userId,
    });
    if (!after) throw Errors.notFound("Delivery job");

    await auditInTx(trx, actorFromAuth(auth, meta.ipAddress, meta.userAgent), {
      action: "delivery_job.update",
      resourceType: "delivery_job",
      resourceId: id,
      branchId: before.branch_id,
    });

    return serialiseJob(after);
  });
}

export async function assignDriver(auth: AuthContext, id: number, input: AssignDriverInput, meta: RequestMeta) {
  return withTenant({ businessId: auth.businessId, userId: auth.userId }, async (trx) => {
    const job = await repo.findJobById(trx, id);
    if (!job) throw Errors.notFound("Delivery job");
    assertCanAccessBranch(auth, job.branch_id);

    // Assignment is only legal from `scheduled` — checkTransition's forward
    // graph agrees (scheduled -> assigned is the only edge out of
    // scheduled), so this reuses it rather than re-deriving the rule.
    const check = checkTransition(job.status as JobStatus, "assigned");
    if (!check.allowed) {
      throw Errors.conflict("invalid-job-status-transition", check.reason ?? "A driver can only be assigned to a scheduled job.");
    }

    const driver = await repo.findById(trx, input.driver_id);
    if (!driver) throw Errors.notFound("Driver");
    if (!driver.is_active) {
      throw Errors.conflict("driver-inactive", "This driver is disabled and cannot be assigned new jobs.");
    }

    const after = await repo.assignDriver(trx, id, input.driver_id, auth.userId);
    if (!after) throw Errors.notFound("Delivery job");

    await repo.insertStatusHistory(trx, {
      business_id: auth.businessId,
      job_id: id,
      branch_id: job.branch_id,
      from_status: job.status,
      to_status: "assigned",
      changed_by_user_id: auth.userId,
    });

    // Auto-manage driver status — Business Rule 3: assignment busies a
    // driver automatically; they may still manually override afterward.
    if (driver.status === "available") {
      await repo.setStatus(trx, driver.id, "busy", auth.userId);
    }

    await auditInTx(trx, actorFromAuth(auth, meta.ipAddress, meta.userAgent), {
      action: "delivery_job.assign",
      resourceType: "delivery_job",
      resourceId: id,
      branchId: job.branch_id,
      after: { driver_id: input.driver_id },
    });

    return serialiseJob(after);
  });
}

export async function advanceStatus(auth: AuthContext, id: number, input: AdvanceJobStatusInput, meta: RequestMeta) {
  return withTenant({ businessId: auth.businessId, userId: auth.userId }, async (trx) => {
    const job = await repo.findJobById(trx, id);
    if (!job) throw Errors.notFound("Delivery job");
    assertCanActOnJob(auth, job.branch_id, job.driver_user_id);

    const check = checkTransition(job.status as JobStatus, input.to as JobStatus);
    if (!check.allowed) {
      throw Errors.conflict("invalid-job-status-transition", check.reason ?? "Invalid transition.");
    }

    const timestampColumn = input.to === "en_route" ? "started_at" : "arrived_at";
    const after = await repo.advanceStatus(trx, id, {
      status: input.to,
      timestampColumn,
      updated_by_user_id: auth.userId,
    });
    if (!after) throw Errors.notFound("Delivery job");

    await repo.insertStatusHistory(trx, {
      business_id: auth.businessId,
      job_id: id,
      branch_id: job.branch_id,
      from_status: job.status,
      to_status: input.to,
      changed_by_user_id: auth.userId,
    });

    await auditInTx(trx, actorFromAuth(auth, meta.ipAddress, meta.userAgent), {
      action: "delivery_job.status_change",
      resourceType: "delivery_job",
      resourceId: id,
      branchId: job.branch_id,
      before: { status: job.status },
      after: { status: input.to },
    });

    return serialiseJob(after);
  });
}

/**
 * Completion — the one function with real cross-module responsibility.
 * If the job carries a COD amount, this calls Orders' own recordPaymentInTx
 * INSIDE THIS SAME TRANSACTION — not a second one — reusing its exact
 * outstanding-balance guard rather than reimplementing it. See this file's
 * header and PHASE-7-REPORT.md for why a naive call to the public
 * `recordPayment` (which opens its own transaction) would have been wrong.
 */
export async function completeJob(auth: AuthContext, id: number, input: CompleteJobInput, meta: RequestMeta) {
  return withTenant({ businessId: auth.businessId, userId: auth.userId }, async (trx) => {
    const job = await repo.findJobById(trx, id);
    if (!job) throw Errors.notFound("Delivery job");
    assertCanActOnJob(auth, job.branch_id, job.driver_user_id);

    const check = checkTransition(job.status as JobStatus, "completed" as JobStatus);
    if (!check.allowed) {
      throw Errors.conflict("invalid-job-status-transition", check.reason ?? "Invalid transition.");
    }

    const collectedAmount = input.collected_amount ?? null;
    if (collectedAmount !== null && job.collect_amount !== null && collectedAmount > Number(job.collect_amount) + 0.01) {
      throw Errors.validation("Collected amount exceeds the amount owed for this job.", {
        owed: Number(job.collect_amount),
        attempted: collectedAmount,
      });
    }

    const after = await repo.advanceStatus(trx, id, {
      status: "completed",
      timestampColumn: "completed_at",
      collected_amount: collectedAmount,
      proof_photo_url: input.proof_photo_url ?? null,
      proof_signature_url: input.proof_signature_url ?? null,
      proof_latitude: input.geo?.latitude ?? null,
      proof_longitude: input.geo?.longitude ?? null,
      updated_by_user_id: auth.userId,
    });
    if (!after) throw Errors.notFound("Delivery job");

    await repo.insertStatusHistory(trx, {
      business_id: auth.businessId,
      job_id: id,
      branch_id: job.branch_id,
      from_status: job.status,
      to_status: "completed",
      changed_by_user_id: auth.userId,
    });

    // Cash-on-delivery: record a real payment on the linked order, inside
    // this same transaction, reusing Orders' own guard.
    if (collectedAmount !== null && collectedAmount > 0) {
      await recordPaymentInTx(
        trx,
        auth,
        job.order_id,
        { amount: collectedAmount, method: "cash", reference: `delivery-job-${id}` },
        meta,
      );
    }

    await auditInTx(trx, actorFromAuth(auth, meta.ipAddress, meta.userAgent), {
      action: "delivery_job.complete",
      resourceType: "delivery_job",
      resourceId: id,
      branchId: job.branch_id,
      after: { collected_amount: collectedAmount },
    });

    // Free the driver if this was their only active job.
    if (job.driver_id) await releaseDriverIfIdle(trx, job.driver_id, auth.userId);

    return serialiseJob(after);
  });
}

export async function failJob(auth: AuthContext, id: number, input: FailJobInput, meta: RequestMeta) {
  return withTenant({ businessId: auth.businessId, userId: auth.userId }, async (trx) => {
    const job = await repo.findJobById(trx, id);
    if (!job) throw Errors.notFound("Delivery job");
    assertCanActOnJob(auth, job.branch_id, job.driver_user_id);

    const check = checkTransition(job.status as JobStatus, "failed" as JobStatus);
    if (!check.allowed) {
      throw Errors.conflict("invalid-job-status-transition", check.reason ?? "Invalid transition.");
    }

    const after = await repo.advanceStatus(trx, id, {
      status: "failed",
      fail_reason: input.reason,
      proof_latitude: input.geo?.latitude ?? null,
      proof_longitude: input.geo?.longitude ?? null,
      updated_by_user_id: auth.userId,
    });
    if (!after) throw Errors.notFound("Delivery job");

    await repo.insertStatusHistory(trx, {
      business_id: auth.businessId,
      job_id: id,
      branch_id: job.branch_id,
      from_status: job.status,
      to_status: "failed",
      reason: input.reason,
      changed_by_user_id: auth.userId,
    });

    await auditInTx(trx, actorFromAuth(auth, meta.ipAddress, meta.userAgent), {
      action: "delivery_job.fail",
      resourceType: "delivery_job",
      resourceId: id,
      branchId: job.branch_id,
      after: { reason: input.reason },
    });

    if (job.driver_id) await releaseDriverIfIdle(trx, job.driver_id, auth.userId);

    return serialiseJob(after);
  });
}

/** Cancellation is dispatcher-only (Business Rule 7) — no self-scope path. */
export async function cancelJob(auth: AuthContext, id: number, input: CancelJobInput, meta: RequestMeta) {
  return withTenant({ businessId: auth.businessId, userId: auth.userId }, async (trx) => {
    const job = await repo.findJobById(trx, id);
    if (!job) throw Errors.notFound("Delivery job");
    assertCanAccessBranch(auth, job.branch_id);

    const check = checkTransition(job.status as JobStatus, "cancelled" as JobStatus);
    if (!check.allowed) {
      throw Errors.conflict("invalid-job-status-transition", check.reason ?? "Invalid transition.");
    }

    const after = await repo.advanceStatus(trx, id, {
      status: "cancelled",
      timestampColumn: "cancelled_at",
      fail_reason: input.reason,
      updated_by_user_id: auth.userId,
    });
    if (!after) throw Errors.notFound("Delivery job");

    await repo.insertStatusHistory(trx, {
      business_id: auth.businessId,
      job_id: id,
      branch_id: job.branch_id,
      from_status: job.status,
      to_status: "cancelled",
      reason: input.reason,
      changed_by_user_id: auth.userId,
    });

    await auditInTx(trx, actorFromAuth(auth, meta.ipAddress, meta.userAgent), {
      action: "delivery_job.cancel",
      resourceType: "delivery_job",
      resourceId: id,
      branchId: job.branch_id,
      after: { reason: input.reason },
    });

    if (job.driver_id) await releaseDriverIfIdle(trx, job.driver_id, auth.userId);

    return serialiseJob(after);
  });
}

export async function deleteJob(auth: AuthContext, id: number, meta: RequestMeta) {
  return withTenant({ businessId: auth.businessId, userId: auth.userId }, async (trx) => {
    const job = await repo.findJobById(trx, id);
    if (!job) throw Errors.notFound("Delivery job");
    assertCanAccessBranch(auth, job.branch_id);

    const row = await repo.softDeleteJob(trx, id, auth.userId);
    if (!row) throw Errors.notFound("Delivery job");

    await auditInTx(trx, actorFromAuth(auth, meta.ipAddress, meta.userAgent), {
      action: "delivery_job.delete",
      resourceType: "delivery_job",
      resourceId: id,
      branchId: job.branch_id,
    });

    return { id, deleted_at: row.deleted_at };
  });
}

export async function restoreJob(auth: AuthContext, id: number, meta: RequestMeta) {
  return withTenant({ businessId: auth.businessId, userId: auth.userId }, async (trx) => {
    const job = await repo.findJobById(trx, id, { includeDeleted: true });
    if (!job) throw Errors.notFound("Delivery job");
    if (!job.deleted_at) throw Errors.conflict("job-not-deleted", "This job is not deleted.");
    assertCanAccessBranch(auth, job.branch_id);

    const row = await repo.restoreJob(trx, id, auth.userId);
    if (!row) throw Errors.notFound("Delivery job");

    await auditInTx(trx, actorFromAuth(auth, meta.ipAddress, meta.userAgent), {
      action: "delivery_job.restore",
      resourceType: "delivery_job",
      resourceId: id,
      branchId: job.branch_id,
    });

    return serialiseJob(row);
  });
}

/* ---------------------------------------------------------------------- */
/*  Jobs — queries                                                         */
/* ---------------------------------------------------------------------- */

export async function getJob(auth: AuthContext, id: number) {
  return withTenant({ businessId: auth.businessId, userId: auth.userId }, async (trx) => {
    const job = await repo.findJobById(trx, id, { includeDeleted: true });
    if (!job) throw Errors.notFound("Delivery job");
    if (!canActOnJobRead(auth, job)) throw Errors.notFound("Delivery job");
    return serialiseJob(job);
  });
}

function canActOnJobRead(auth: AuthContext, job: repo.JobWithDriverUserRow): boolean {
  return isAssignedDriver(auth, job.driver_user_id) || canAccessBranch(auth, job.branch_id);
}

export async function listJobsForBranch(auth: AuthContext, branchId: number, query: ListJobsQueryInput) {
  return withTenant({ businessId: auth.businessId, userId: auth.userId }, async (trx) => {
    assertCanAccessBranch(auth, branchId);
    const rows = await repo.listForBranch(trx, auth.businessId, branchId, {
      status: query.status,
      jobType: query.job_type,
      includeDeleted: query.deleted === "include",
      onlyDeleted: query.deleted === "only",
    });
    return { data: rows.map((r) => serialiseJob(r)) };
  });
}

export async function listJobsForOrder(auth: AuthContext, orderId: number) {
  return withTenant({ businessId: auth.businessId, userId: auth.userId }, async (trx) => {
    const order = await repo.findOrderForJob(trx, orderId);
    if (!order) throw Errors.notFound("Order");
    const branchId = order.collection_branch_id ?? order.intake_branch_id;
    assertCanAccessBranch(auth, branchId);

    const rows = await repo.listForOrder(trx, auth.businessId, orderId);
    return { data: rows.map((r) => serialiseJob(r)) };
  });
}

export async function listJobsForDriver(auth: AuthContext, driverId: number, query: ListJobsQueryInput) {
  return withTenant({ businessId: auth.businessId, userId: auth.userId }, async (trx) => {
    const driver = await repo.findById(trx, driverId, { includeDeleted: true });
    if (!driver) throw Errors.notFound("Driver");

    const isSelf = driver.user_id === auth.userId;

    const rows = await repo.listForDriver(trx, auth.businessId, driverId, {
      status: query.status,
      includeDeleted: query.deleted === "include",
      onlyDeleted: query.deleted === "only",
    });
    // Filter to jobs the caller may see (all of them, if they're the driver
    // viewing their own list; otherwise branch-scoped) rather than deny the
    // whole request outright — matches how Orders' list endpoint narrows
    // for a scoped caller instead of 403ing.
    const visible = isSelf ? rows : rows.filter((r) => canAccessBranch(auth, r.branch_id));
    return { data: visible.map((r) => serialiseJob(r)) };
  });
}

export async function getJobHistory(auth: AuthContext, id: number) {
  return withTenant({ businessId: auth.businessId, userId: auth.userId }, async (trx) => {
    const job = await repo.findJobById(trx, id, { includeDeleted: true });
    if (!job) throw Errors.notFound("Delivery job");
    if (!canActOnJobRead(auth, job)) throw Errors.notFound("Delivery job");

    const rows = await repo.historyFor(trx, id);
    return { data: rows.map((r) => serialiseHistory(r)) };
  });
}

/* ---------------------------------------------------------------------- */
/*  Helpers                                                                 */
/* ---------------------------------------------------------------------- */

/**
 * After a job reaches a terminal state, free the driver back to `available`
 * — but only if they have no OTHER active job. Business Rule 3's "hybrid"
 * behaviour: the system manages this automatically, but a driver (or
 * dispatcher) can still manually override afterward.
 */
async function releaseDriverIfIdle(
  trx: Parameters<typeof repo.hasActiveJob>[0],
  driverId: number,
  userId: number | null,
): Promise<void> {
  const stillActive = await repo.hasActiveJob(trx, driverId);
  if (!stillActive) {
    const driver = await repo.findById(trx, driverId);
    if (driver && driver.status === "busy") {
      await repo.setStatus(trx, driverId, "available", userId);
    }
  }
}
