/**
 * Authorization middleware.
 *
 * Use this factory on every protected route:
 *
 *   fastify.post("/customers", {
 *     preHandler: [authenticate, authorize(["customers.create"])],
 *   }, handler);
 *
 * Semantics:
 *   - The permission list is an AND. `authorize(["a", "b"])` means the
 *     caller must have BOTH permissions. To express OR, model it as a
 *     single higher-level permission — mixing AND/OR in code has been
 *     a source of RBAC bugs elsewhere and is deliberately not supported.
 *   - Permission check is done against the JWT `perms` claim. Under no
 *     circumstances is a request body, header, or URL parameter used
 *     to influence this decision.
 *   - Denial responses never disclose which permission is missing beyond
 *     what the caller could infer from context — we return the required
 *     set so a legitimate user can request access. Attackers already
 *     know what they're missing.
 */

import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { Errors } from "../lib/errors.js";

export function authorize(required: string[]): preHandlerHookHandler {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const auth = request.auth;
    if (!auth) throw Errors.unauthenticated();
    const has = new Set(auth.permissions);
    const missing = required.filter((p) => !has.has(p));
    if (missing.length > 0) throw Errors.unauthorized(required);
  };
}

/**
 * Branch-scope enforcement helper.
 *
 * Empty `branch_ids` in the auth context means "all branches". Otherwise,
 * every branch-scoped list query must add `AND branch_id = ANY($branchIds)`
 * and every branch-scoped create must specify a branch inside that set.
 *
 * This is a helper for handlers, not middleware — the check happens at
 * query time where the branch_id is known.
 */
export function assertBranchAccess(auth: { branchIds: number[] }, branchId: number): void {
  if (auth.branchIds.length === 0) return;   // all-branches access
  if (!auth.branchIds.includes(branchId)) throw Errors.unauthorized();
}
