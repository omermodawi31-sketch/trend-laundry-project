/**
 * Branch management authorization.
 *
 * Same split as orders/branch-scope.ts: tenant isolation lives in RLS,
 * branch-level authorization lives here in the application layer. See that
 * file's header comment for the full "why not RLS for this too" reasoning —
 * it applies unchanged.
 *
 * This module's scope rules are simpler than orders' three-column OR-logic,
 * because a branch has exactly one identity (itself), not three roles
 * (intake/processing/collection):
 *
 *   READ  (list, get)      — every authenticated member with `settings.read`
 *                             sees every branch in the business, regardless
 *                             of their own branch_ids. Branch metadata is
 *                             organisational information, not access-
 *                             controlled data — see the longer note in
 *                             repository.ts `list()`.
 *
 *   CREATE                 — requires all-branch access (empty branch_ids).
 *                             Creating an entirely new branch is a business-
 *                             wide decision; there is no existing branch to
 *                             scope the action to, so "manage your assigned
 *                             branches" cannot apply. Only owners and
 *                             all-branch managers may do this.
 *
 *   UPDATE / ENABLE-DISABLE /
 *   DELETE / RESTORE        — requires the target branch to be in the
 *                             caller's scope (or all-branch access). This is
 *                             the literal implementation of "branch managers
 *                             can only manage their assigned branches;
 *                             business owners can manage every branch."
 */

import { Errors } from "../../lib/errors.js";
import type { AuthContext } from "../../shared/types.js";

/** Same convention as orders: empty branch_ids means "every branch". */
export function hasAllBranchAccess(auth: Pick<AuthContext, "branchIds">): boolean {
  return auth.branchIds.length === 0;
}

/**
 * Creating a branch is an all-branch-only action.
 *
 * A manager scoped to branch 3 cannot spin up branch 7 — that would let a
 * single-location manager expand the business's footprint, which is an
 * owner-level decision even when the manager role otherwise carries
 * `settings.branches.edit`.
 */
export function assertCanCreateBranch(auth: Pick<AuthContext, "branchIds">): void {
  if (!hasAllBranchAccess(auth)) throw Errors.unauthorized();
}

/**
 * Whether the caller may manage (update / enable / disable / delete /
 * restore) a specific branch.
 */
export function canManageBranch(auth: Pick<AuthContext, "branchIds">, branchId: number): boolean {
  if (hasAllBranchAccess(auth)) return true;
  return auth.branchIds.includes(branchId);
}

/** Throwing counterpart, used once the target row is known to exist. */
export function assertCanManageBranch(auth: Pick<AuthContext, "branchIds">, branchId: number): void {
  if (!canManageBranch(auth, branchId)) throw Errors.unauthorized();
}
