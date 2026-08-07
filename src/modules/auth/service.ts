/**
 * Auth service.
 *
 * All authentication business logic. Route handlers in `routes.ts` are
 * thin — they parse the request, call one of these functions, and format
 * the response.
 *
 * Security-critical decisions embedded here:
 *
 *   - Signup creates a business + owner atomically. If any step fails, the
 *     whole transaction rolls back — no half-created tenants.
 *
 *   - Login has three failure modes and they all return the same 401 body:
 *     unknown user, wrong password, locked account. This is deliberate
 *     (user enumeration prevention).
 *
 *   - Refresh rotates the token AND checks for reuse. If a previously-
 *     revoked token is presented, we revoke the entire family. This is
 *     the OAuth2 refresh-rotation pattern with reuse detection.
 *
 *   - Password reset always returns 202, whether the email exists or not.
 *
 *   - Refresh tokens are hashed before storage. Raw tokens live in the
 *     cookie only.
 *
 *   - The dummy-hash trick in verifyPassword handles unknown-user timing.
 */

import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { db, withNoTenant } from "../../lib/db.js";
import { hashPassword, verifyPassword } from "../../lib/passwords.js";
import { signAccessToken } from "../../lib/jwt.js";
import { generateToken, hashToken, compareHashes } from "../../lib/tokens.js";
import { rateLimitFixedWindow } from "../../lib/redis.js";
import { AppError, Errors } from "../../lib/errors.js";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { SYSTEM_ROLES, type Permission } from "../../shared/permissions.js";
import type { Bilingual } from "../../shared/types.js";
import * as settingsRepo from "../settings/repository.js";

/* ---------------------------------------------------------------------- */
/*  Types                                                                 */
/* ---------------------------------------------------------------------- */

export interface SignupInput {
  business: {
    name: Bilingual;
    country_code?: string;
    currency?: string;
    default_locale?: string;
    timezone?: string;
  };
  owner: {
    email: string;
    full_name: string;
    password: string;
    preferred_locale?: string;
  };
  branch: {
    name: Bilingual;
    code: string;
    address: Bilingual;
    phone?: string;
  };
}

export interface AuthResult {
  access_token: string;
  refresh_token: string;   // raw; caller sets it as a cookie
  expires_in: number;      // seconds
  user: { id: number; email: string; full_name: string; preferred_locale: string };
  business: { id: number; name: Bilingual };
  role: string;
  permissions: string[];
  branches: number[];
}

interface IssueTokensArgs {
  userId: number;
  businessId: number;
  role: { key: string; permissions: string[] };
  branchIds: number[];
  familyId?: string;        // when refreshing
  parentTokenId?: number;   // when refreshing
  ipAddress: string | null;
  userAgent: string | null;
}

/* ---------------------------------------------------------------------- */
/*  Signup                                                                */
/* ---------------------------------------------------------------------- */

/**
 * Create a business + first branch + first owner user + membership, all in
 * one transaction. Seed roles are created too.
 *
 * This is the only "tenant creation" path in v1. There is no admin console
 * that spawns tenants; every business starts by someone signing up.
 */
export async function signupOwnerAndBusiness(
  input: SignupInput,
  meta: { ipAddress: string | null; userAgent: string | null },
): Promise<AuthResult> {
  // Basic input rules — Zod at the route layer does the shape checks.
  // The rules here are ones the DB alone cannot express.
  if (input.owner.password.length < 12) {
    throw Errors.validation("Password must be at least 12 characters.");
  }

  const passwordHash = await hashPassword(input.owner.password);

  return withNoTenant(async (trx) => {
    // 1. Create the business.
    const business = await trx
      .insertInto("businesses")
      .values({
        name: input.business.name,
        country_code: input.business.country_code ?? "AE",
        currency: input.business.currency ?? "AED",
        default_locale: input.business.default_locale ?? "en",
        timezone: input.business.timezone ?? "Asia/Dubai",
        plan: "trial",
        trial_ends_at: sql`now() + interval '30 days'` as never,
        status: "active",
      })
      .returning(["id", "name"])
      .executeTakeFirstOrThrow();

    // 1b. Create the one required business_settings row (Phase 6) — every
    //     business must have exactly one, from the moment it exists, so
    //     orders/service.ts's pricing lookup never has to handle "not
    //     configured yet" as a real case. See business_settings/repository.ts.
    await settingsRepo.insertDefault(trx, business.id);

    // 2. Seed the five system roles for this business.
    const seededRoles = await trx
      .insertInto("roles")
      .values(
        SYSTEM_ROLES.map((r) => ({
          business_id: business.id,
          key: r.key,
          name: r.name,
          permissions: [...r.permissions],
          is_system: true,
        })),
      )
      .returning(["id", "key", "permissions"])
      .execute();

    const ownerRole = seededRoles.find((r) => r.key === "owner");
    if (!ownerRole) throw new Error("Owner role missing after seed — invariant broken.");

    // 3. Create the first branch.
    const branch = await trx
      .insertInto("branches")
      .values({
        business_id: business.id,
        name: input.branch.name,
        code: input.branch.code,
        address: input.branch.address,
        phone: input.branch.phone ?? null,
        is_active: true,
      } as never)
      .returning(["id"])
      .executeTakeFirstOrThrow();

    // 4. Create the owner user. Enforce case-insensitive uniqueness via
    //    the DB unique index — if the email already exists, this throws
    //    a duplicate-key error which we translate to a 409.
    let user: { id: number; email: string; full_name: string; preferred_locale: string };
    try {
      user = await trx
        .insertInto("users")
        .values({
          email: input.owner.email.toLowerCase(),
          full_name: input.owner.full_name,
          password_hash: passwordHash,
          preferred_locale: input.owner.preferred_locale ?? "en",
        } as never)
        .returning(["id", "email", "full_name", "preferred_locale"])
        .executeTakeFirstOrThrow();
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw Errors.conflict("email-exists", "An account with this email already exists.");
      }
      throw err;
    }

    // 5. Owner membership — empty branch_ids means "all branches".
    await trx
      .insertInto("memberships")
      .values({
        user_id: user.id,
        business_id: business.id,
        role_id: ownerRole.id,
        branch_ids: [],   // all branches
        is_active: true,
        accepted_at: sql`now()` as never,
      })
      .execute();

    // 6. Audit — signup event.
    await trx
      .insertInto("activity_logs")
      .values({
        business_id: business.id,
        branch_id: branch.id,
        user_id: user.id,
        role_key: "owner",
        action: "business.signup",
        resource_type: "business",
        resource_id: business.id,
        after: { name: business.name } as never,
        ip_address: meta.ipAddress,
        user_agent: meta.userAgent,
      })
      .execute();

    // 7. Issue tokens.
    const tokens = await issueTokens(trx, {
      userId: user.id,
      businessId: business.id,
      role: { key: "owner", permissions: [...ownerRole.permissions] },
      branchIds: [],
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    return {
      access_token: tokens.access,
      refresh_token: tokens.refresh,
      expires_in: env.ACCESS_TOKEN_TTL_SECONDS,
      user: { id: user.id, email: user.email, full_name: user.full_name, preferred_locale: user.preferred_locale },
      business: { id: business.id, name: business.name as unknown as Bilingual },
      role: "owner",
      permissions: [...ownerRole.permissions],
      branches: [],
    };
  });
}

/* ---------------------------------------------------------------------- */
/*  Login                                                                 */
/* ---------------------------------------------------------------------- */

/**
 * Log in.
 *
 * A note on business selection: if the user has memberships in exactly one
 * business we pick it automatically. If more than one, the client must
 * provide business_id or call POST /me/switch-business after the fact.
 */
export async function login(
  input: { email: string; password: string; business_id?: number },
  meta: { ipAddress: string | null; userAgent: string | null },
): Promise<AuthResult | { select_business: Array<{ id: number; name: Bilingual }> }> {
  const emailLower = input.email.toLowerCase();

  // Rate limits: per-IP and per-email, before we even touch the DB.
  const ipKey = `login:ip:${meta.ipAddress ?? "unknown"}`;
  const emailKey = `login:email:${emailLower}`;
  const [byIp, byEmail] = await Promise.all([
    rateLimitFixedWindow(ipKey, env.RATE_LIMIT_LOGIN_PER_IP_PER_MIN, 60),
    rateLimitFixedWindow(emailKey, env.RATE_LIMIT_LOGIN_PER_EMAIL_PER_HOUR, 3600),
  ]);
  if (!byIp.allowed || !byEmail.allowed) {
    throw Errors.rateLimited(Math.max(byIp.resetsInSeconds, byEmail.resetsInSeconds));
  }

  return withNoTenant(async (trx) => {
    // Fetch user. If not found we still call verifyPassword to burn time.
    const user = await trx
      .selectFrom("users")
      .selectAll()
      .where("email", "=", emailLower)
      .where("deleted_at", "is", null)
      .executeTakeFirst();

    const passwordOk = await verifyPassword(user?.password_hash ?? null, input.password);

    // Even if user is not found or password wrong, do the account-locked check
    // last-not-first so unknown-email requests take the same code path as
    // wrong-password requests.
    if (!user || !passwordOk) {
      // Bump failed count if the user exists but wrong password.
      if (user) await bumpFailedLogin(trx, user.id);
      throw Errors.invalidCredentials();
    }

    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      throw Errors.invalidCredentials();
    }

    // Reset failed counter on success.
    await trx
      .updateTable("users")
      .set({ failed_login_count: 0, locked_until: null, last_login_at: sql`now()` as never })
      .where("id", "=", user.id)
      .execute();

    // Load memberships.
    const memberships = await trx
      .selectFrom("memberships")
      .innerJoin("businesses", "businesses.id", "memberships.business_id")
      .innerJoin("roles", "roles.id", "memberships.role_id")
      .select([
        "memberships.id as membership_id",
        "memberships.business_id",
        "memberships.branch_ids",
        "businesses.name as business_name",
        "roles.key as role_key",
        "roles.permissions",
      ])
      .where("memberships.user_id", "=", user.id)
      .where("memberships.is_active", "=", true)
      .where("businesses.status", "=", "active")
      .execute();

    if (memberships.length === 0) {
      // User has no active business — treat as invalid credentials.
      throw Errors.invalidCredentials();
    }

    // If more than one, and no explicit business_id, ask the client.
    let chosen = memberships[0]!;
    if (memberships.length > 1) {
      if (input.business_id == null) {
        return {
          select_business: memberships.map((m) => ({
            id: Number(m.business_id),
            name: m.business_name as unknown as Bilingual,
          })),
        };
      }
      const found = memberships.find((m) => Number(m.business_id) === input.business_id);
      if (!found) throw Errors.invalidCredentials();
      chosen = found;
    }

    const tokens = await issueTokens(trx, {
      userId: user.id,
      businessId: Number(chosen.business_id),
      role: { key: chosen.role_key, permissions: chosen.permissions },
      branchIds: (chosen.branch_ids ?? []).map(Number),
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    // Audit.
    await trx.insertInto("activity_logs").values({
      business_id: Number(chosen.business_id),
      user_id: user.id,
      role_key: chosen.role_key,
      action: "auth.login",
      resource_type: "user",
      resource_id: user.id,
      ip_address: meta.ipAddress,
      user_agent: meta.userAgent,
    }).execute();

    return {
      access_token: tokens.access,
      refresh_token: tokens.refresh,
      expires_in: env.ACCESS_TOKEN_TTL_SECONDS,
      user: { id: user.id, email: user.email, full_name: user.full_name, preferred_locale: user.preferred_locale },
      business: { id: Number(chosen.business_id), name: chosen.business_name as unknown as Bilingual },
      role: chosen.role_key,
      permissions: chosen.permissions,
      branches: (chosen.branch_ids ?? []).map(Number),
    };
  });
}

async function bumpFailedLogin(trx: Parameters<typeof issueTokens>[0], userId: number): Promise<void> {
  const row = await trx
    .updateTable("users")
    .set({ failed_login_count: sql`failed_login_count + 1` as never })
    .where("id", "=", userId)
    .returning(["failed_login_count"])
    .executeTakeFirst();
  if (row && row.failed_login_count >= 5) {
    await trx
      .updateTable("users")
      .set({ locked_until: sql`now() + interval '15 minutes'` as never })
      .where("id", "=", userId)
      .execute();
  }
}

/* ---------------------------------------------------------------------- */
/*  Refresh — with rotation and reuse detection                           */
/* ---------------------------------------------------------------------- */

export async function refresh(
  rawToken: string,
  meta: { ipAddress: string | null; userAgent: string | null },
): Promise<AuthResult> {
  const tokenHash = hashToken(rawToken);

  return withNoTenant(async (trx) => {
    const existing = await trx
      .selectFrom("refresh_tokens")
      .selectAll()
      .where("token_hash", "=", tokenHash)
      .executeTakeFirst();

    if (!existing) {
      throw Errors.unauthenticated();
    }

    // Reuse detection: token was already revoked, so someone (attacker or
    // legit user racing) is replaying it. Revoke the whole family.
    if (existing.revoked_at) {
      await trx
        .updateTable("refresh_tokens")
        .set({ revoked_at: sql`now()` as never, revoked_reason: "reuse_detected" })
        .where("family_id", "=", existing.family_id)
        .where("revoked_at", "is", null)
        .execute();

      logger.warn(
        { user_id: existing.user_id, family_id: existing.family_id, ip: meta.ipAddress },
        "refresh token reuse detected — family revoked",
      );

      // Audit if we know the business.
      if (existing.business_id) {
        await trx.insertInto("activity_logs").values({
          business_id: Number(existing.business_id),
          user_id: existing.user_id,
          action: "auth.refresh_reuse_detected",
          resource_type: "user",
          resource_id: existing.user_id,
          ip_address: meta.ipAddress,
          user_agent: meta.userAgent,
        }).execute();
      }

      throw Errors.unauthenticated();
    }

    if (new Date(existing.expires_at) < new Date()) {
      throw Errors.unauthenticated();
    }

    // Reload user + membership snapshot to get freshest role/permissions.
    if (!existing.business_id) {
      throw Errors.unauthenticated();
    }

    const membership = await trx
      .selectFrom("memberships")
      .innerJoin("businesses", "businesses.id", "memberships.business_id")
      .innerJoin("roles", "roles.id", "memberships.role_id")
      .select([
        "memberships.branch_ids",
        "businesses.name as business_name",
        "roles.key as role_key",
        "roles.permissions",
      ])
      .where("memberships.user_id", "=", existing.user_id)
      .where("memberships.business_id", "=", existing.business_id)
      .where("memberships.is_active", "=", true)
      .where("businesses.status", "=", "active")
      .executeTakeFirst();

    if (!membership) throw Errors.unauthenticated();

    const user = await trx
      .selectFrom("users")
      .select(["id", "email", "full_name", "preferred_locale"])
      .where("id", "=", existing.user_id)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!user) throw Errors.unauthenticated();

    // Rotate: revoke current, issue new one in the same family.
    await trx
      .updateTable("refresh_tokens")
      .set({ revoked_at: sql`now()` as never, revoked_reason: "rotated" })
      .where("id", "=", existing.id)
      .execute();

    const tokens = await issueTokens(trx, {
      userId: existing.user_id,
      businessId: Number(existing.business_id),
      role: { key: membership.role_key, permissions: membership.permissions },
      branchIds: (membership.branch_ids ?? []).map(Number),
      familyId: existing.family_id,
      parentTokenId: existing.id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    return {
      access_token: tokens.access,
      refresh_token: tokens.refresh,
      expires_in: env.ACCESS_TOKEN_TTL_SECONDS,
      user,
      business: { id: Number(existing.business_id), name: membership.business_name as unknown as Bilingual },
      role: membership.role_key,
      permissions: membership.permissions,
      branches: (membership.branch_ids ?? []).map(Number),
    };
  });
}

/* ---------------------------------------------------------------------- */
/*  Logout                                                                */
/* ---------------------------------------------------------------------- */

export async function logout(rawToken: string | null): Promise<void> {
  if (!rawToken) return;
  const tokenHash = hashToken(rawToken);
  await withNoTenant(async (trx) => {
    await trx
      .updateTable("refresh_tokens")
      .set({ revoked_at: sql`now()` as never, revoked_reason: "logout" })
      .where("token_hash", "=", tokenHash)
      .where("revoked_at", "is", null)
      .execute();
  });
}

export async function logoutAll(userId: number): Promise<void> {
  await withNoTenant(async (trx) => {
    await trx
      .updateTable("refresh_tokens")
      .set({ revoked_at: sql`now()` as never, revoked_reason: "logout_all" })
      .where("user_id", "=", userId)
      .where("revoked_at", "is", null)
      .execute();
  });
}

/* ---------------------------------------------------------------------- */
/*  Password reset                                                        */
/* ---------------------------------------------------------------------- */

/**
 * Request a password reset. Always returns silently — even if the email
 * does not exist. This is not a UX bug; it prevents user enumeration.
 * Returns the raw token when the user exists, so the route can email it.
 */
export async function requestPasswordReset(
  email: string,
  meta: { ipAddress: string | null; userAgent: string | null },
): Promise<{ userId: number; rawToken: string; email: string } | null> {
  const emailLower = email.toLowerCase();
  return withNoTenant(async (trx) => {
    const user = await trx
      .selectFrom("users")
      .select(["id", "email"])
      .where("email", "=", emailLower)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!user) return null;

    const { raw, hash } = generateToken();
    await trx
      .insertInto("password_resets")
      .values({
        user_id: user.id,
        token_hash: hash,
        expires_at: sql`now() + interval '30 minutes'` as never,
        ip_address: meta.ipAddress,
        user_agent: meta.userAgent,
      })
      .execute();
    return { userId: user.id, rawToken: raw, email: user.email };
  });
}

export async function confirmPasswordReset(rawToken: string, newPassword: string): Promise<void> {
  if (newPassword.length < 12) throw Errors.validation("Password must be at least 12 characters.");
  const tokenHash = hashToken(rawToken);
  await withNoTenant(async (trx) => {
    const reset = await trx
      .selectFrom("password_resets")
      .selectAll()
      .where("token_hash", "=", tokenHash)
      .executeTakeFirst();
    if (!reset) throw Errors.validation("Invalid or expired reset token.");
    if (reset.used_at) throw Errors.validation("Invalid or expired reset token.");
    if (new Date(reset.expires_at) < new Date()) throw Errors.validation("Invalid or expired reset token.");
    if (!compareHashes(reset.token_hash, tokenHash)) throw Errors.validation("Invalid or expired reset token.");

    const newHash = await hashPassword(newPassword);
    await trx.updateTable("users").set({ password_hash: newHash }).where("id", "=", reset.user_id).execute();
    await trx.updateTable("password_resets").set({ used_at: sql`now()` as never }).where("id", "=", reset.id).execute();

    // Revoke every active refresh token — force sign-out everywhere.
    await trx
      .updateTable("refresh_tokens")
      .set({ revoked_at: sql`now()` as never, revoked_reason: "password_reset" })
      .where("user_id", "=", reset.user_id)
      .where("revoked_at", "is", null)
      .execute();
  });
}

/* ---------------------------------------------------------------------- */
/*  Email verification                                                    */
/* ---------------------------------------------------------------------- */

export async function requestEmailVerification(userId: number): Promise<string> {
  return withNoTenant(async (trx) => {
    const user = await trx
      .selectFrom("users")
      .select(["email", "email_verified_at"])
      .where("id", "=", userId)
      .executeTakeFirstOrThrow();
    if (user.email_verified_at) {
      throw Errors.conflict("email-already-verified", "Email already verified.");
    }
    const { raw, hash } = generateToken();
    await trx
      .insertInto("email_verifications")
      .values({
        user_id: userId,
        token_hash: hash,
        expires_at: sql`now() + interval '24 hours'` as never,
        email_at_issue: user.email,
      })
      .execute();
    return raw;
  });
}

export async function confirmEmailVerification(rawToken: string): Promise<void> {
  const tokenHash = hashToken(rawToken);
  await withNoTenant(async (trx) => {
    const row = await trx
      .selectFrom("email_verifications")
      .innerJoin("users", "users.id", "email_verifications.user_id")
      .select([
        "email_verifications.id as ev_id",
        "email_verifications.user_id",
        "email_verifications.expires_at",
        "email_verifications.consumed_at",
        "email_verifications.email_at_issue",
        "users.email as current_email",
      ])
      .where("email_verifications.token_hash", "=", tokenHash)
      .executeTakeFirst();
    if (!row) throw Errors.validation("Invalid or expired verification token.");
    if (row.consumed_at) throw Errors.validation("Invalid or expired verification token.");
    if (new Date(row.expires_at) < new Date()) throw Errors.validation("Invalid or expired verification token.");
    if (row.email_at_issue.toLowerCase() !== row.current_email.toLowerCase()) {
      // Email changed between issuance and redemption — refuse.
      throw Errors.validation("Invalid or expired verification token.");
    }
    await trx
      .updateTable("users")
      .set({ email_verified_at: sql`now()` as never })
      .where("id", "=", row.user_id)
      .execute();
    await trx
      .updateTable("email_verifications")
      .set({ consumed_at: sql`now()` as never })
      .where("id", "=", row.ev_id)
      .execute();
  });
}

/* ---------------------------------------------------------------------- */
/*  Session listing / revocation                                          */
/* ---------------------------------------------------------------------- */

export async function listSessions(userId: number): Promise<Array<{
  id: number;
  user_agent: string | null;
  ip_address: string | null;
  created_at: string;
  is_current: boolean;
}>> {
  return withNoTenant(async (trx) => {
    const rows = await trx
      .selectFrom("refresh_tokens")
      .select(["id", "user_agent", "ip_address", "created_at"])
      .where("user_id", "=", userId)
      .where("revoked_at", "is", null)
      .orderBy("created_at", "desc")
      .execute();
    return rows.map((r) => ({
      id: Number(r.id),
      user_agent: r.user_agent,
      ip_address: r.ip_address,
      created_at: String(r.created_at),
      is_current: false,   // filled by caller who knows the current family
    }));
  });
}

export async function revokeSession(userId: number, sessionId: number): Promise<void> {
  await withNoTenant(async (trx) => {
    await trx
      .updateTable("refresh_tokens")
      .set({ revoked_at: sql`now()` as never, revoked_reason: "user_revoked" })
      .where("user_id", "=", userId)
      .where("id", "=", sessionId)
      .where("revoked_at", "is", null)
      .execute();
  });
}

/* ---------------------------------------------------------------------- */
/*  Token issuance internal                                               */
/* ---------------------------------------------------------------------- */

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
async function issueTokens(trx: Parameters<typeof db.transaction>[0] extends never ? never : any, args: IssueTokensArgs) {
  const familyId = args.familyId ?? randomUUID();
  const { raw, hash } = generateToken();

  const inserted = await trx
    .insertInto("refresh_tokens")
    .values({
      user_id: args.userId,
      token_hash: hash,
      family_id: familyId,
      parent_id: args.parentTokenId ?? null,
      business_id: args.businessId,
      expires_at: sql`now() + interval '${sql.raw(String(env.REFRESH_TOKEN_TTL_SECONDS))} seconds'` as never,
      user_agent: args.userAgent,
      ip_address: args.ipAddress,
    })
    .returning(["id"])
    .executeTakeFirstOrThrow();

  const access = signAccessToken({
    sub: String(args.userId),
    biz: String(args.businessId),
    role: args.role.key,
    branches: args.branchIds,
    perms: args.role.permissions,
    sess: String(inserted.id),
  });

  return { access, refresh: raw };
}

/* ---------------------------------------------------------------------- */
/*  Utilities                                                             */
/* ---------------------------------------------------------------------- */

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "23505"
  );
}

// Keep permission type import alive for downstream consumers.
export type { Permission };
