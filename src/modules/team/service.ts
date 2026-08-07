/**
 * Team service — invitations and membership management.
 *
 * Design:
 *   - Invites are one-time tokens that carry business_id + role + branches.
 *     They live in password_resets... no, wait, they need their own table
 *     because the target user does not exist yet.
 *
 * The `invitations` table is deliberately not part of Phase 1 to keep the
 * blast radius small. Instead we reuse the token flow: invitees receive a
 * link that lets them set their password and accept. Storage: we use the
 * `password_resets` table with a twist — a placeholder user is created at
 * invite time with a random unusable password_hash, then the reset flow
 * activates them.
 *
 * Trade-off documented: this reuses the reset table for two purposes.
 * Phase 2 will introduce a dedicated `invitations` table if we grow it.
 */

import { sql } from "kysely";
import { db, withNoTenant, withTenant } from "../../lib/db.js";
import { hashPassword } from "../../lib/passwords.js";
import { generateToken, hashToken } from "../../lib/tokens.js";
import { AppError, Errors } from "../../lib/errors.js";
import { logger } from "../../config/logger.js";
import type { AuthContext } from "../../shared/types.js";

export async function inviteEmployee(
  actor: AuthContext,
  input: { email: string; full_name?: string; role_key: string; branch_ids?: number[] },
  meta: { ipAddress: string | null; userAgent: string | null },
): Promise<{ user_id: number; membership_id: number; rawToken: string }> {
  const emailLower = input.email.toLowerCase();
  const branchIds = input.branch_ids ?? [];

  // System roles cashier/employee/driver may only be assigned to specific
  // branches — enforce presence. Manager may be all-branches (empty).
  if (input.role_key !== "manager" && branchIds.length === 0) {
    throw Errors.validation("Non-manager roles must be scoped to at least one branch.");
  }

  return withTenant({ businessId: actor.businessId, userId: actor.userId }, async (trx) => {
    // Verify role exists in this tenant.
    const role = await trx
      .selectFrom("roles")
      .select(["id", "key"])
      .where("key", "=", input.role_key)
      .executeTakeFirst();
    if (!role) throw Errors.validation("Unknown role.");

    // Verify branches all belong to this tenant. RLS ensures we can't see
    // other tenants' branches, so this also enforces cross-tenant safety.
    if (branchIds.length > 0) {
      const found = await trx
        .selectFrom("branches")
        .select(["id"])
        .where("id", "in", branchIds)
        .execute();
      if (found.length !== branchIds.length) {
        throw Errors.validation("One or more branches do not exist.");
      }
    }

    // Look up existing user by email OUTSIDE the tenant context —
    // users are global (see BACKEND-SPEC §2 users table).
    // We need to break out to withNoTenant briefly.
    // Kysely trx can query non-RLS tables (users) directly.
    const existing = await trx
      .selectFrom("users")
      .select(["id", "email", "email_verified_at"])
      .where("email", "=", emailLower)
      .where("deleted_at", "is", null)
      .executeTakeFirst();

    let userId: number;
    if (existing) {
      // Check that this user doesn't already have a membership here.
      const already = await trx
        .selectFrom("memberships")
        .select(["id"])
        .where("user_id", "=", existing.id)
        .where("business_id", "=", actor.businessId)
        .executeTakeFirst();
      if (already) throw Errors.conflict("membership-exists", "This user is already on the team.");
      userId = existing.id;
    } else {
      // Create placeholder user with a random password they can't guess.
      // The invite flow immediately resets it to what they choose.
      const placeholderPassword = generateToken().raw;
      const placeholderHash = await hashPassword(placeholderPassword);
      const inserted = await trx
        .insertInto("users")
        .values({
          email: emailLower,
          full_name: input.full_name ?? emailLower.split("@")[0]!,
          password_hash: placeholderHash,
          preferred_locale: "en",
        } as never)
        .returning(["id"])
        .executeTakeFirstOrThrow();
      userId = Number(inserted.id);
    }

    const membership = await trx
      .insertInto("memberships")
      .values({
        user_id: userId,
        business_id: actor.businessId,
        role_id: role.id,
        branch_ids: branchIds,
        is_active: false,   // becomes active on accept
        invited_by_user_id: actor.userId,
        invited_at: sql`now()` as never,
      })
      .returning(["id"])
      .executeTakeFirstOrThrow();

    // Issue a password-reset-style token. On accept the user sets a real
    // password and their membership activates.
    const { raw, hash } = generateToken();
    await trx
      .insertInto("password_resets")
      .values({
        user_id: userId,
        token_hash: hash,
        expires_at: sql`now() + interval '7 days'` as never,
        ip_address: meta.ipAddress,
        user_agent: meta.userAgent,
      })
      .execute();

    // Audit.
    await trx.insertInto("activity_logs").values({
      business_id: actor.businessId,
      user_id: actor.userId,
      role_key: actor.roleKey,
      action: "team.invite",
      resource_type: "membership",
      resource_id: Number(membership.id),
      after: { email: emailLower, role_key: input.role_key, branch_ids: branchIds } as never,
      ip_address: meta.ipAddress,
      user_agent: meta.userAgent,
    }).execute();

    return { user_id: userId, membership_id: Number(membership.id), rawToken: raw };
  });
}

/**
 * Accept an invite. The token is a password-reset token pointing at a user
 * that has at least one inactive membership. We consume the token, set the
 * password, activate ALL of the user's pending memberships (usually one),
 * mark email as verified (they clicked the emailed link — that's proof).
 */
export async function acceptInvite(
  rawToken: string,
  input: { password: string; full_name: string },
): Promise<void> {
  if (input.password.length < 12) throw Errors.validation("Password must be at least 12 characters.");
  const tokenHash = hashToken(rawToken);
  await withNoTenant(async (trx) => {
    const reset = await trx
      .selectFrom("password_resets")
      .selectAll()
      .where("token_hash", "=", tokenHash)
      .executeTakeFirst();
    if (!reset) throw Errors.validation("Invalid or expired invitation.");
    if (reset.used_at) throw Errors.validation("Invalid or expired invitation.");
    if (new Date(reset.expires_at) < new Date()) throw Errors.validation("Invalid or expired invitation.");

    const newHash = await hashPassword(input.password);
    await trx
      .updateTable("users")
      .set({
        password_hash: newHash,
        full_name: input.full_name,
        email_verified_at: sql`now()` as never,
      })
      .where("id", "=", reset.user_id)
      .execute();
    await trx.updateTable("password_resets").set({ used_at: sql`now()` as never }).where("id", "=", reset.id).execute();
    await trx
      .updateTable("memberships")
      .set({ is_active: true, accepted_at: sql`now()` as never })
      .where("user_id", "=", reset.user_id)
      .where("is_active", "=", false)
      .execute();
  });
}

export async function listTeam(actor: AuthContext): Promise<Array<{
  membership_id: number;
  user_id: number;
  email: string;
  full_name: string;
  role_key: string;
  branch_ids: number[];
  is_active: boolean;
  invited_at: string | null;
  accepted_at: string | null;
}>> {
  return withTenant({ businessId: actor.businessId, userId: actor.userId }, async (trx) => {
    const rows = await trx
      .selectFrom("memberships")
      .innerJoin("users", "users.id", "memberships.user_id")
      .innerJoin("roles", "roles.id", "memberships.role_id")
      .select([
        "memberships.id as membership_id",
        "users.id as user_id",
        "users.email",
        "users.full_name",
        "roles.key as role_key",
        "memberships.branch_ids",
        "memberships.is_active",
        "memberships.invited_at",
        "memberships.accepted_at",
      ])
      .where("memberships.revoked_at", "is", null)
      .orderBy("memberships.created_at", "desc")
      .execute();
    return rows.map((r) => ({
      membership_id: Number(r.membership_id),
      user_id: Number(r.user_id),
      email: r.email,
      full_name: r.full_name,
      role_key: r.role_key,
      branch_ids: (r.branch_ids ?? []).map(Number),
      is_active: Boolean(r.is_active),
      invited_at: r.invited_at as string | null,
      accepted_at: r.accepted_at as string | null,
    }));
  });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _dbKeepImport = db;   // Kysely db import currently unused directly; used indirectly via withTenant
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _appErrorKeepImport = AppError;
