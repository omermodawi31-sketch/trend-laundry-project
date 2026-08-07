/**
 * Inventory branch authorization.
 *
 * Confirmed by the user before this module was built (PROJECT_CONTEXT.md
 * Decisions Log #18): inventory uses a SIMPLE SINGLE-BRANCH scope check,
 * modelled on branches/branch-scope.ts's `assertCanManageBranch`, not
 * orders/branch-scope.ts's three-column OR predicate. A stock movement
 * happens at exactly one branch — there is no intake/processing/collection
 * concept here, so there is nothing for an OR across multiple columns to do.
 *
 * Unlike branches management (where reading branch metadata is deliberately
 * business-wide regardless of scope — see branches/branch-scope.ts's header),
 * inventory STOCK is exactly the kind of per-branch data the brief calls out
 * explicitly ("each branch owns its own inventory quantities"), so both
 * READS and WRITES of branch stock/movements require the target branch to
 * be in the caller's scope. Catalog CRUD (inventory_items) has no branch
 * dimension at all and needs no check from this file — it is gated purely
 * by permission, the same as the `services` price catalogue.
 */

import { Errors } from "../../lib/errors.js";
import type { AuthContext } from "../../shared/types.js";

/** Same convention as every other branch-scope helper: empty branch_ids means "every branch". */
export function hasAllBranchAccess(auth: Pick<AuthContext, "branchIds">): boolean {
  return auth.branchIds.length === 0;
}

export function canAccessBranch(auth: Pick<AuthContext, "branchIds">, branchId: number): boolean {
  if (hasAllBranchAccess(auth)) return true;
  return auth.branchIds.includes(branchId);
}

/** Throwing counterpart, used before any read or write against a specific branch's stock. */
export function assertCanAccessBranch(auth: Pick<AuthContext, "branchIds">, branchId: number): void {
  if (!canAccessBranch(auth, branchId)) throw Errors.unauthorized();
}

/**
 * Transfers touch two branches at once — both must be in scope, or the
 * caller could use a transfer to move stock into a branch's ledger they
 * cannot otherwise write to.
 */
export function assertCanTransfer(
  auth: Pick<AuthContext, "branchIds">,
  fromBranchId: number,
  toBranchId: number,
): void {
  assertCanAccessBranch(auth, fromBranchId);
  assertCanAccessBranch(auth, toBranchId);
}
