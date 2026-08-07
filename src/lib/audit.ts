/**
 * Audit log writer.
 *
 * Every state-changing operation writes exactly one row into `activity_logs`.
 * Two design commitments (from SECURITY.md §5.3):
 *
 * 1. Audit failure never blocks the primary operation. If the activity_logs
 *    INSERT fails, we log the error at fatal level and return normally. The
 *    audit-log-writer failing is itself an incident but a customer's order
 *    still gets saved.
 *
 * 2. Only changed fields go into `before`/`after`, not the whole entity.
 *    Keeps rows small and makes diffing easy for the eventual admin UI.
 */

import type { Transaction } from "kysely";
import { sql } from "kysely";
import { logger } from "../config/logger.js";
import type { Database } from "./db-schema.js";
import type { AuthContext } from "../shared/types.js";

export interface AuditEvent {
  action: string;                      // canonical: "customer.create", "order.status_change"
  resourceType: string;                // "customer", "order", "user"
  resourceId?: number | null;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  branchId?: number | null;
}

export interface AuditActor {
  businessId: number;
  userId: number | null;               // null for system actions
  roleKey?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * Write inside an existing tenant-scoped transaction. Preferred for
 * "state change and audit are atomic" flows.
 */
export async function auditInTx(
  trx: Transaction<Database>,
  actor: AuditActor,
  event: AuditEvent,
): Promise<void> {
  try {
    await trx
      .insertInto("activity_logs")
      .values({
        business_id: actor.businessId,
        branch_id: event.branchId ?? null,
        user_id: actor.userId,
        role_key: actor.roleKey ?? null,
        action: event.action,
        resource_type: event.resourceType,
        resource_id: event.resourceId ?? null,
        before: (event.before ?? null) as unknown as never,
        after: (event.after ?? null) as unknown as never,
        ip_address: actor.ipAddress ?? null,
        user_agent: actor.userAgent ?? null,
      })
      .execute();
  } catch (err) {
    // Never block the caller. Log fatal and continue.
    logger.fatal({ err, actor, event }, "audit write failed inside transaction");
  }
}

/** Convenience factory when we have an AuthContext already. */
export function actorFromAuth(auth: AuthContext, ip: string | null, ua: string | null): AuditActor {
  return {
    businessId: auth.businessId,
    userId: auth.userId,
    roleKey: auth.roleKey,
    ipAddress: ip,
    userAgent: ua,
  };
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _sqlKeepImport = sql;   // sql import currently unused; retained for future non-tx writer
