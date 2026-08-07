/**
 * Branch scope enforcement.
 *
 * The approved architecture keeps tenant isolation in the database (RLS) and
 * branch authorization in the application layer. This file is that layer's
 * single enforcement point: every order query routes through
 * `applyBranchScope`, and every order creation routes through
 * `assertCanCreateForBranch`.
 *
 * WHY NOT RLS FOR BRANCHES TOO
 * ----------------------------
 * Branch scoping organises access inside one trusting entity; tenant
 * isolation defends against an adversary. Expressing branch scope as a
 * second RLS policy means array-containment against a session variable, a
 * special case for "empty means all", and bypasses for owners and
 * cross-branch reports. That is a lot of policy complexity guarding a
 * boundary whose failure mode is "a manager saw the other shop's numbers"
 * rather than "a competitor read our customer list".
 *
 * The honest cost of the application-layer choice is that it can be
 * forgotten. The mitigation is this file: there is exactly one way to filter
 * orders by branch, and a test asserts every list path uses it.
 *
 * READ MODEL: OR ACROSS THREE COLUMNS
 * -----------------------------------
 * An order is visible to a caller if ANY of its three branch columns is in
 * the caller's scope. A plant manager must see orders they are processing
 * even though intake happened at a different shop.
 *
 * NULL handling: processing_branch_id and collection_branch_id are NULL when
 * they equal intake. `COALESCE(processing_branch_id, intake_branch_id)`
 * therefore expresses "the branch that will process this", which is what the
 * predicate must compare against.
 */

import { sql, type Expression, type SqlBool } from "kysely";
import { Errors } from "../../lib/errors.js";
import type { AuthContext } from "../../shared/types.js";

/**
 * True when the caller has unrestricted branch access.
 *
 * An empty `branch_ids` array on a membership means "all branches" — the
 * representation owners and chain managers carry. This is checked in exactly
 * one place so the convention cannot drift.
 */
export function hasAllBranchAccess(auth: Pick<AuthContext, "branchIds">): boolean {
  return auth.branchIds.length === 0;
}

/**
 * SQL predicate restricting a query to orders the caller may read.
 *
 * Returns `undefined` for all-branch callers so the query builder can skip
 * adding a redundant WHERE clause.
 *
 * The predicate is built with bound parameters — the branch id array comes
 * from a signed JWT claim and is still passed through `sql.val` rather than
 * interpolated, because "it came from a trusted source" is exactly the
 * reasoning that precedes an injection bug.
 */
export function branchReadPredicate(
  auth: Pick<AuthContext, "branchIds">,
): Expression<SqlBool> | undefined {
  if (hasAllBranchAccess(auth)) return undefined;

  const ids = auth.branchIds;
  return sql<SqlBool>`(
       orders.intake_branch_id = ANY(${sql.val(ids)}::bigint[])
    OR COALESCE(orders.processing_branch_id, orders.intake_branch_id) = ANY(${sql.val(ids)}::bigint[])
    OR COALESCE(orders.collection_branch_id, orders.intake_branch_id) = ANY(${sql.val(ids)}::bigint[])
  )`;
}

/**
 * Whether a specific order row is readable by the caller.
 *
 * Used after a point read (`findById`) where adding the predicate to the
 * query would make "not found" and "not permitted" indistinguishable in a
 * way we do not want *internally* — the service still converts both to 404
 * for the client, but the distinction is useful in logs and tests.
 */
export function canReadOrder(
  auth: Pick<AuthContext, "branchIds">,
  order: {
    intake_branch_id: number;
    processing_branch_id: number | null;
    collection_branch_id: number | null;
  },
): boolean {
  if (hasAllBranchAccess(auth)) return true;
  const scope = new Set(auth.branchIds);
  const processing = order.processing_branch_id ?? order.intake_branch_id;
  const collection = order.collection_branch_id ?? order.intake_branch_id;
  return scope.has(order.intake_branch_id) || scope.has(processing) || scope.has(collection);
}

/**
 * Creation is narrower than reading.
 *
 * A caller may read an order that touches any branch in their scope, but may
 * only *create* one whose intake branch is in their scope. Otherwise a
 * cashier at branch A could book revenue against branch B.
 */
export function assertCanCreateForBranch(
  auth: Pick<AuthContext, "branchIds">,
  intakeBranchId: number,
): void {
  if (hasAllBranchAccess(auth)) return;
  if (!auth.branchIds.includes(intakeBranchId)) {
    throw Errors.unauthorized();
  }
}

/**
 * Mutating an existing order requires read scope on it.
 *
 * Deliberately the same rule as reading rather than intake-only: a plant
 * that is processing an order must be able to advance its status, and the
 * plant is not the intake branch.
 */
export function assertCanMutateOrder(
  auth: Pick<AuthContext, "branchIds">,
  order: {
    intake_branch_id: number;
    processing_branch_id: number | null;
    collection_branch_id: number | null;
  },
): void {
  if (!canReadOrder(auth, order)) throw Errors.unauthorized();
}

/**
 * Validate the branch triple supplied at creation.
 *
 * Rules:
 *   - intake is mandatory and must be inside the caller's scope
 *   - processing/collection are optional; NULL means "same as intake"
 *   - a value equal to intake is normalised to NULL so there is one
 *     canonical representation of "all at one branch"
 *
 * Normalising here rather than at read time means the OR predicate does not
 * have to consider two encodings of the same fact.
 */
export function normaliseBranchTriple(input: {
  intakeBranchId: number;
  processingBranchId?: number | null;
  collectionBranchId?: number | null;
}): {
  intake_branch_id: number;
  processing_branch_id: number | null;
  collection_branch_id: number | null;
} {
  const intake = input.intakeBranchId;
  const processing = input.processingBranchId ?? null;
  const collection = input.collectionBranchId ?? null;
  return {
    intake_branch_id: intake,
    processing_branch_id: processing === intake ? null : processing,
    collection_branch_id: collection === intake ? null : collection,
  };
}
