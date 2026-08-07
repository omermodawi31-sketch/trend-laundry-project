/**
 * Business Settings routes.
 *
 * A singleton resource — no `:id` in either path, since there is exactly
 * one settings record per business (the caller's own, from `auth.businessId`
 * via RLS). Same thin-handler shape as every other module: parse → service
 * → reply.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { Errors } from "../../lib/errors.js";
import * as service from "./service.js";
import { updateSettingsSchema } from "./schemas.js";

function metaOf(req: FastifyRequest): service.RequestMeta {
  return {
    ipAddress: req.ip ?? null,
    userAgent: (req.headers["user-agent"] as string | undefined) ?? null,
  };
}

function parse<T>(schema: { parse: (v: unknown) => T }, value: unknown): T {
  try {
    return schema.parse(value);
  } catch (err) {
    if (err instanceof ZodError) {
      throw Errors.validation("Request validation failed.", {
        issues: err.issues.map((i) => ({ field: i.path.join("."), message: i.message })),
      });
    }
    throw err;
  }
}

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/settings/business",
    { preHandler: [authenticate, authorize(["settings.read"])] },
    async (req, reply) => {
      const settings = await service.getSettings(req.auth!);
      return reply.code(200).send({ settings });
    },
  );

  app.patch(
    "/settings/business",
    { preHandler: [authenticate, authorize(["settings.business.edit"])] },
    async (req, reply) => {
      const body = parse(updateSettingsSchema, req.body);
      const settings = await service.updateSettings(req.auth!, body, metaOf(req));
      return reply.code(200).send({ settings });
    },
  );
}
