/**
 * Auth routes.
 *
 * Handlers are thin: parse the request, call the service, format the reply.
 * Business logic lives in service.ts so it can be tested without HTTP.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import * as service from "./service.js";
import {
  signupSchema,
  loginSchema,
  passwordResetRequestSchema,
  passwordResetConfirmSchema,
  emailVerifyConfirmSchema,
} from "./schemas.js";
import { REFRESH_COOKIE, setRefreshCookie, clearRefreshCookie } from "../../lib/refresh-cookie.js";
import { authenticate } from "../../middleware/authenticate.js";
import { Errors } from "../../lib/errors.js";
import { logger } from "../../config/logger.js";

function ipOf(req: FastifyRequest): string | null {
  return typeof req.ip === "string" ? req.ip : null;
}
function uaOf(req: FastifyRequest): string | null {
  const ua = req.headers["user-agent"];
  return typeof ua === "string" ? ua.slice(0, 500) : null;
}

/**
 * CSRF guard for the refresh endpoint.
 * The refresh cookie is SameSite=Lax, but as belt-and-braces we also require
 * a custom header — cross-origin form submissions cannot set custom headers.
 */
function requireCustomHeader(req: FastifyRequest): void {
  if (req.headers["x-refresh-request"] !== "1") throw Errors.unauthenticated();
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  /* ------------------------------- signup -------------------------------- */
  app.post("/auth/signup", { schema: { body: signupSchema } }, async (req, reply) => {
    const result = await service.signupOwnerAndBusiness(req.body as service.SignupInput, {
      ipAddress: ipOf(req),
      userAgent: uaOf(req),
    });
    setRefreshCookie(reply, result.refresh_token);
    const { refresh_token: _, ...safe } = result;
    return reply.code(201).send(safe);
  });

  /* -------------------------------- login -------------------------------- */
  app.post("/auth/login", { schema: { body: loginSchema } }, async (req, reply) => {
    const result = await service.login(req.body as never, {
      ipAddress: ipOf(req),
      userAgent: uaOf(req),
    });
    if ("select_business" in result) {
      return reply.code(202).send(result);
    }
    setRefreshCookie(reply, result.refresh_token);
    const { refresh_token: _, ...safe } = result;
    return reply.code(200).send(safe);
  });

  /* ------------------------------- refresh ------------------------------- */
  app.post("/auth/refresh", async (req, reply) => {
    requireCustomHeader(req);
    const raw = req.cookies[REFRESH_COOKIE];
    if (!raw) throw Errors.unauthenticated();
    const result = await service.refresh(raw, { ipAddress: ipOf(req), userAgent: uaOf(req) });
    setRefreshCookie(reply, result.refresh_token);
    const { refresh_token: _, ...safe } = result;
    return reply.code(200).send(safe);
  });

  /* ------------------------------- logout -------------------------------- */
  app.post("/auth/logout", async (req, reply) => {
    const raw = req.cookies[REFRESH_COOKIE] ?? null;
    await service.logout(raw);
    clearRefreshCookie(reply);
    return reply.code(204).send();
  });

  app.post("/auth/logout-all", { preHandler: [authenticate] }, async (req, reply) => {
    await service.logoutAll(req.auth!.userId);
    clearRefreshCookie(reply);
    return reply.code(204).send();
  });

  /* --------------------------- password reset ---------------------------- */
  app.post("/auth/password/reset-request", { schema: { body: passwordResetRequestSchema } }, async (req, reply) => {
    const { email } = req.body as { email: string };
    const result = await service.requestPasswordReset(email, { ipAddress: ipOf(req), userAgent: uaOf(req) });
    if (result) {
      // Phase 1: no email provider wired. Log the raw token at info level in
      // dev only. Phase 6 replaces this with a real send.
      logger.info(
        { user_id: result.userId, email: result.email, reset_token: result.rawToken },
        "PASSWORD RESET TOKEN — dev only (Phase 6 wires real email)",
      );
    }
    // Always 202, even if the email doesn't exist.
    return reply.code(202).send({ status: "queued" });
  });

  app.post("/auth/password/reset-confirm", { schema: { body: passwordResetConfirmSchema } }, async (req, reply) => {
    const { token, new_password } = req.body as { token: string; new_password: string };
    await service.confirmPasswordReset(token, new_password);
    return reply.code(200).send({ status: "ok" });
  });

  /* --------------------------- email verify ------------------------------ */
  app.post("/auth/email/resend", { preHandler: [authenticate] }, async (req, reply) => {
    const token = await service.requestEmailVerification(req.auth!.userId);
    logger.info(
      { user_id: req.auth!.userId, verify_token: token },
      "EMAIL VERIFICATION TOKEN — dev only",
    );
    return reply.code(202).send({ status: "queued" });
  });

  app.post("/auth/email/verify", { schema: { body: emailVerifyConfirmSchema } }, async (req, reply) => {
    const { token } = req.body as { token: string };
    await service.confirmEmailVerification(token);
    return reply.code(200).send({ status: "ok" });
  });

  /* --------------------------- me / sessions ----------------------------- */
  app.get("/me", { preHandler: [authenticate] }, async (req, reply) => {
    return reply.send({
      user_id: req.auth!.userId,
      business_id: req.auth!.businessId,
      role: req.auth!.roleKey,
      permissions: req.auth!.permissions,
      branch_ids: req.auth!.branchIds,
    });
  });

  app.get("/me/sessions", { preHandler: [authenticate] }, async (req, reply) => {
    const list = await service.listSessions(req.auth!.userId);
    return reply.send({ sessions: list });
  });

  app.delete<{ Params: { id: string } }>(
    "/me/sessions/:id",
    { preHandler: [authenticate] },
    async (req, reply) => {
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) throw Errors.validation("Invalid session id.");
      await service.revokeSession(req.auth!.userId, id);
      return reply.code(204).send();
    },
  );
}
