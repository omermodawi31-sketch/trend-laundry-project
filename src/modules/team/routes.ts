/**
 * Team routes.
 *
 * Permission model:
 *   - GET /team            → any authenticated member
 *   - POST /team/invite    → settings.roles.edit
 *   - POST /team/accept    → PUBLIC (token-scoped)
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import * as service from "./service.js";
import { inviteSchema, acceptInviteSchema } from "../auth/schemas.js";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { logger } from "../../config/logger.js";

function ipOf(req: FastifyRequest): string | null { return typeof req.ip === "string" ? req.ip : null; }
function uaOf(req: FastifyRequest): string | null {
  const ua = req.headers["user-agent"];
  return typeof ua === "string" ? ua.slice(0, 500) : null;
}

export async function teamRoutes(app: FastifyInstance): Promise<void> {
  app.get("/team", { preHandler: [authenticate] }, async (req, reply) => {
    const rows = await service.listTeam(req.auth!);
    return reply.send({ team: rows });
  });

  app.post(
    "/team/invite",
    {
      schema: { body: inviteSchema },
      preHandler: [authenticate, authorize(["settings.roles.edit"])],
    },
    async (req, reply) => {
      const result = await service.inviteEmployee(
        req.auth!,
        req.body as { email: string; role_key: string; full_name?: string; branch_ids?: number[] },
        { ipAddress: ipOf(req), userAgent: uaOf(req) },
      );
      logger.info(
        { invited_user_id: result.user_id, invite_token: result.rawToken },
        "INVITE TOKEN — dev only (Phase 6 wires email)",
      );
      return reply.code(201).send({
        user_id: result.user_id,
        membership_id: result.membership_id,
      });
    },
  );

  app.post(
    "/team/accept",
    { schema: { body: acceptInviteSchema } },
    async (req, reply) => {
      const body = req.body as { token: string; password: string; full_name: string };
      await service.acceptInvite(body.token, { password: body.password, full_name: body.full_name });
      return reply.code(200).send({ status: "ok" });
    },
  );
}
