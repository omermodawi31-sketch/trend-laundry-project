/**
 * Branches service.
 *
 * All business logic for branch management. Route handlers stay thin: parse
 * → call one of these → serialise the result.
 *
 * Invariants this file maintains, matching the brief exactly:
 *   1. Every branch belongs to exactly one business — enforced by RLS via
 *      `withTenant(...)`, same as every other tenant-owned module.
 *   2. Branch codes are unique within a business (pre-checked here, backed
 *      by the DB unique index as the race-condition-proof source of truth).
 *   3. A branch with historical orders can never be deleted — checked here
 *      before the soft-delete write, backed by the FK's NO ACTION default
 *      as a defense-in-depth layer against a hard delete bypassing this
 *      service entirely (see the migration's header comment).
 *   4. Every create / update / enable / disable / delete / restore writes
 *      an audit row in the SAME transaction as the change.
 *   5. Cross-tenant AND out-of-branch-scope reads both surface as 404,
 *      never 403 — a 403 would confirm the row exists (OWASP A01).
 */

import { withTenant } from "../../lib/db.js";
import { auditInTx, actorFromAuth } from "../../lib/audit.js";
import { Errors } from "../../lib/errors.js";
import type { AuthContext, Bilingual } from "../../shared/types.js";
import * as repo from "./repository.js";
import { assertCanCreateBranch, assertCanManageBranch } from "./branch-scope.js";
import type {
  CreateBranchInput,
  ListQueryInput,
  SetActiveInput,
  UpdateBranchInput,
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

export function serialiseBranch(row: repo.BranchRow) {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    address: row.address,
    phone: row.phone,
    email: row.email,
    maps_url: row.maps_url,
    geo: row.latitude !== null && row.longitude !== null
      ? { latitude: n(row.latitude), longitude: n(row.longitude) }
      : null,
    working_hours: row.working_hours,
    logo_url: row.logo_url,
    manager_user_id: row.manager_user_id,
    sort_order: row.sort_order,
    is_active: row.is_active,
    created_at: row.created_at,
    updated_at: row.updated_at,
    deleted_at: row.deleted_at,
  };
}

/** Fields captured in audit before/after snapshots — mirrors customers' AUDITED_FIELDS convention. */
const AUDITED_FIELDS = [
  "name", "code", "address", "phone", "email", "maps_url", "latitude",
  "longitude", "working_hours", "logo_url", "manager_user_id", "sort_order",
] as const;

function auditSnapshot(row: repo.BranchRow): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of AUDITED_FIELDS) out[f] = row[f];
  return out;
}

function auditDiff(
  before: repo.BranchRow,
  after: repo.BranchRow,
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const f of AUDITED_FIELDS) {
    const bv = JSON.stringify(before[f]);
    const av = JSON.stringify(after[f]);
    if (bv !== av) {
      b[f] = before[f];
      a[f] = after[f];
    }
  }
  return { before: b, after: a };
}

/* ---------------------------------------------------------------------- */
/*  Commands                                                               */
/* ---------------------------------------------------------------------- */

export async function createBranch(
  auth: AuthContext,
  input: CreateBranchInput,
  meta: RequestMeta,
) {
  // Creation is all-branch-only — see branch-scope.ts for why.
  assertCanCreateBranch(auth);

  return withTenant({ businessId: auth.businessId, userId: auth.userId }, async (trx) => {
    const existing = await repo.findByCode(trx, input.code);
    if (existing) {
      throw Errors.conflict(
        "branch-code-exists",
        "A branch with this code already exists.",
        { branch_id: existing.id },
      );
    }

    if (input.manager_user_id != null) {
      const isMember = await repo.isActiveMemberOfTenant(trx, input.manager_user_id);
      if (!isMember) {
        throw Errors.validation("manager_user_id must be an active member of this business.", {
          field: "manager_user_id",
        });
      }
    }

    let row: repo.BranchRow;
    try {
      row = await repo.insert(trx, {
        business_id: auth.businessId,
        name: normaliseBilingual(input.name),
        code: input.code,
        address: normaliseBilingual(input.address),
        phone: input.phone ?? null,
        email: input.email ?? null,
        maps_url: input.maps_url ?? null,
        latitude: input.geo?.latitude ?? null,
        longitude: input.geo?.longitude ?? null,
        working_hours: input.working_hours ?? null,
        logo_url: input.logo_url ?? null,
        manager_user_id: input.manager_user_id ?? null,
        sort_order: input.sort_order,
        is_active: input.is_active,
        created_by_user_id: auth.userId,
      });
    } catch (err) {
      // Race-condition backstop: two concurrent requests could both pass the
      // pre-check above. The unique index is the actual guarantee; this
      // turns its violation into the same clean error the pre-check gives.
      if (isUniqueViolation(err)) {
        throw Errors.conflict("branch-code-exists", "A branch with this code already exists.");
      }
      throw err;
    }

    await auditInTx(trx, actorFromAuth(auth, meta.ipAddress, meta.userAgent), {
      action: "branch.create",
      resourceType: "branch",
      resourceId: row.id,
      branchId: row.id,
      after: auditSnapshot(row),
    });

    return serialiseBranch(row);
  });
}

export async function updateBranch(
  auth: AuthContext,
  id: number,
  input: UpdateBranchInput,
  meta: RequestMeta,
) {
  return withTenant({ businessId: auth.businessId, userId: auth.userId }, async (trx) => {
    const before = await repo.findById(trx, id);
    if (!before) throw Errors.notFound("Branch");
    assertCanManageBranch(auth, id);

    if (input.code !== undefined && input.code !== before.code) {
      const clash = await repo.findByCode(trx, input.code);
      if (clash && clash.id !== id) {
        throw Errors.conflict(
          "branch-code-exists",
          "Another branch already uses this code.",
          { branch_id: clash.id },
        );
      }
    }

    if (input.manager_user_id !== undefined && input.manager_user_id !== null) {
      const isMember = await repo.isActiveMemberOfTenant(trx, input.manager_user_id);
      if (!isMember) {
        throw Errors.validation("manager_user_id must be an active member of this business.", {
          field: "manager_user_id",
        });
      }
    }

    let after: repo.BranchRow | undefined;
    try {
      after = await repo.update(trx, id, {
        ...(input.name !== undefined ? { name: normaliseBilingual(input.name) } : {}),
        ...(input.code !== undefined ? { code: input.code } : {}),
        ...(input.address !== undefined ? { address: normaliseBilingual(input.address) } : {}),
        ...(input.phone !== undefined ? { phone: input.phone } : {}),
        ...(input.email !== undefined ? { email: input.email } : {}),
        ...(input.maps_url !== undefined ? { maps_url: input.maps_url } : {}),
        // `geo` carries three possible states: absent (don't touch either
        // column), null (clear both), or a full pair (set both) — the Zod
        // schema guarantees latitude and longitude never arrive alone.
        ...(input.geo !== undefined
          ? { latitude: input.geo?.latitude ?? null, longitude: input.geo?.longitude ?? null }
          : {}),
        ...(input.working_hours !== undefined ? { working_hours: input.working_hours } : {}),
        ...(input.logo_url !== undefined ? { logo_url: input.logo_url } : {}),
        ...(input.manager_user_id !== undefined ? { manager_user_id: input.manager_user_id } : {}),
        ...(input.sort_order !== undefined ? { sort_order: input.sort_order } : {}),
        updated_by_user_id: auth.userId,
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw Errors.conflict("branch-code-exists", "Another branch already uses this code.");
      }
      throw err;
    }
    if (!after) throw Errors.notFound("Branch");

    const diff = auditDiff(before, after);
    if (Object.keys(diff.after).length > 0) {
      await auditInTx(trx, actorFromAuth(auth, meta.ipAddress, meta.userAgent), {
        action: "branch.update",
        resourceType: "branch",
        resourceId: id,
        branchId: id,
        before: diff.before,
        after: diff.after,
      });
    }

    return serialiseBranch(after);
  });
}

export async function setActive(
  auth: AuthContext,
  id: number,
  input: SetActiveInput,
  meta: RequestMeta,
) {
  return withTenant({ businessId: auth.businessId, userId: auth.userId }, async (trx) => {
    const before = await repo.findById(trx, id);
    if (!before) throw Errors.notFound("Branch");
    assertCanManageBranch(auth, id);

    if (before.is_active === input.is_active) {
      // Idempotent — matches customers.changeStatus's no-op-is-not-an-audit-event rule.
      return serialiseBranch(before);
    }

    const after = await repo.setActive(trx, id, input.is_active, auth.userId);
    if (!after) throw Errors.notFound("Branch");

    await auditInTx(trx, actorFromAuth(auth, meta.ipAddress, meta.userAgent), {
      action: input.is_active ? "branch.enable" : "branch.disable",
      resourceType: "branch",
      resourceId: id,
      branchId: id,
      before: { is_active: before.is_active },
      after: { is_active: after.is_active },
    });

    return serialiseBranch(after);
  });
}

export async function deleteBranch(auth: AuthContext, id: number, meta: RequestMeta) {
  return withTenant({ businessId: auth.businessId, userId: auth.userId }, async (trx) => {
    const before = await repo.findById(trx, id);
    if (!before) throw Errors.notFound("Branch");
    assertCanManageBranch(auth, id);

    const historicalOrders = await repo.historicalOrderCount(trx, id);
    if (historicalOrders > 0) {
      throw Errors.conflict(
        "branch-has-orders",
        "This branch has historical orders and cannot be deleted. Disable it instead.",
        { order_count: historicalOrders },
      );
    }

    const row = await repo.softDelete(trx, id, auth.userId);
    if (!row) throw Errors.notFound("Branch");

    await auditInTx(trx, actorFromAuth(auth, meta.ipAddress, meta.userAgent), {
      action: "branch.delete",
      resourceType: "branch",
      resourceId: id,
      branchId: id,
      before: auditSnapshot(before),
    });

    return { id, deleted_at: row.deleted_at };
  });
}

export async function restoreBranch(auth: AuthContext, id: number, meta: RequestMeta) {
  return withTenant({ businessId: auth.businessId, userId: auth.userId }, async (trx) => {
    const before = await repo.findById(trx, id, { includeDeleted: true });
    if (!before) throw Errors.notFound("Branch");
    if (!before.deleted_at) {
      throw Errors.conflict("branch-not-deleted", "This branch is not deleted.");
    }
    assertCanManageBranch(auth, id);

    const clash = await repo.findByCode(trx, before.code);
    if (clash && clash.id !== id) {
      throw Errors.conflict(
        "branch-code-exists",
        "Another branch now uses this code. Change it before restoring.",
        { branch_id: clash.id },
      );
    }

    const row = await repo.restore(trx, id, auth.userId);
    if (!row) throw Errors.notFound("Branch");

    await auditInTx(trx, actorFromAuth(auth, meta.ipAddress, meta.userAgent), {
      action: "branch.restore",
      resourceType: "branch",
      resourceId: id,
      branchId: id,
      after: auditSnapshot(row),
    });

    return serialiseBranch(row);
  });
}

/* ---------------------------------------------------------------------- */
/*  Queries                                                                */
/* ---------------------------------------------------------------------- */

export async function getBranch(auth: AuthContext, id: number) {
  return withTenant({ businessId: auth.businessId, userId: auth.userId }, async (trx) => {
    const row = await repo.findById(trx, id, { includeDeleted: true });
    if (!row) throw Errors.notFound("Branch");
    // Read visibility is business-wide, not scope-restricted — see
    // repository.ts `list()` for why. No canManageBranch check here.
    return serialiseBranch(row);
  });
}

export async function listBranches(auth: AuthContext, query: ListQueryInput) {
  return withTenant({ businessId: auth.businessId, userId: auth.userId }, async (trx) => {
    const rows = await repo.list(trx, auth.businessId, {
      isActive: query.is_active,
      includeDeleted: query.deleted === "include",
      onlyDeleted: query.deleted === "only",
      search: query.q,
    });
    return { data: rows.map((r) => serialiseBranch(r)) };
  });
}

/* ---------------------------------------------------------------------- */
/*  Helpers                                                                */
/* ---------------------------------------------------------------------- */

function normaliseBilingual(input: { en: string; ar: string }): Bilingual {
  return { en: (input.en ?? "").trim(), ar: (input.ar ?? "").trim() };
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "23505"
  );
}
