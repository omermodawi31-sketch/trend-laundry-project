/**
 * Delivery authorization.
 *
 * Branch scope follows the Inventory model exactly (confirmed final
 * decision: "keep the existing branch-scope model unchanged" — meaning
 * reuse one of the three proven shapes, not invent a fourth). A delivery
 * job happens at exactly one branch — no intake/processing/collection
 * concept the way Orders has — so both reads and writes of jobs require the
 * target branch to be in the caller's scope, same as Inventory's stock
 * reads/writes and unlike Branches' business-wide-readable metadata.
 * Drivers are business-scoped (no branch dimension at all), same as the
 * `services` catalogue.
 *
 * SELF SCOPE — the one genuinely new concept this module adds.
 * ---------------------------------------------------------------------------
 * Every branch-scope model built so far is about WHICH BRANCH a caller can
 * touch. This module needs a second, orthogonal axis: can this caller act
 * on this specific job because it's assigned to them, independent of branch
 * scope entirely? A driver with no branch access at all (a legitimate case —
 * a driver whose only job is completing jobs assigned to them may never
 * need `branch_ids` set) must still be able to complete their own job.
 *
 * This is deliberately NOT folded into RLS — it depends on a join (does
 * auth.userId match the assigned driver's user_id?) that RLS's simple
 * `business_id = current_business_id()` predicate isn't suited to, and
 * folding it in would blur the "RLS defends the tenant boundary,
 * application layer organizes access within one trusting business" split
 * this project has held since Phase 3.
 */

import { Errors } from "../../lib/errors.js";
import type { AuthContext } from "../../shared/types.js";

export function hasAllBranchAccess(auth: Pick<AuthContext, "branchIds">): boolean {
  return auth.branchIds.length === 0;
}

export function canAccessBranch(auth: Pick<AuthContext, "branchIds">, branchId: number): boolean {
  if (hasAllBranchAccess(auth)) return true;
  return auth.branchIds.includes(branchId);
}

export function assertCanAccessBranch(auth: Pick<AuthContext, "branchIds">, branchId: number): void {
  if (!canAccessBranch(auth, branchId)) throw Errors.unauthorized();
}

/** True if the caller IS the driver assigned to this job (by user id, not driver id). */
export function isAssignedDriver(
  auth: Pick<AuthContext, "userId">,
  jobDriverUserId: number | null,
): boolean {
  return jobDriverUserId !== null && jobDriverUserId === auth.userId;
}

/**
 * Can this caller act on this job at all — either because they're the
 * assigned driver, or because the job's branch is in their scope?
 */
export function canActOnJob(
  auth: Pick<AuthContext, "userId" | "branchIds">,
  jobBranchId: number,
  jobDriverUserId: number | null,
): boolean {
  return isAssignedDriver(auth, jobDriverUserId) || canAccessBranch(auth, jobBranchId);
}

export function assertCanActOnJob(
  auth: Pick<AuthContext, "userId" | "branchIds">,
  jobBranchId: number,
  jobDriverUserId: number | null,
): void {
  if (!canActOnJob(auth, jobBranchId, jobDriverUserId)) throw Errors.unauthorized();
}
