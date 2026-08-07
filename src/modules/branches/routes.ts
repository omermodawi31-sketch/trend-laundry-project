/**
 * Branch routes.
 *
 * Same shape as customers/routes.ts and orders/routes.ts: parse → service →
 * reply, every route carries `authenticate` + `authorize([...])`, Zod
 * failures become a structured 422 via the shared `parse()` helper.
 *
 * Branch-level scope (as opposed to permission) is enforced inside the
 * service layer via branch-scope.ts, not here — the same split orders/
 * routes.ts uses, because the decision needs the row (or, for create, needs
 * nothing but the caller's own scope).
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { Errors } from "../../lib/errors.js";
import * as service from "./service.js";
import {
  createBranchSchema,
  idParamSchema,
  listQuerySchema,
  setActiveSchema,
  updateBranchSchema,
} from "./schemas.js";

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

export async function branchRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/branches",
    { preHandler: [authenticate, authorize(["settings.read"])] },
    async (req, reply) => {
      const query = parse(listQuerySchema, req.query);
      const result = await service.listBranches(req.auth!, query);
      return reply.code(200).send(result);
    },
  );

  app.post(
    "/branches",
    { preHandler: [authenticate, authorize(["settings.branches.edit"])] },
    async (req, reply) => {
      const body = parse(createBranchSchema, req.body);
      const branch = await service.createBranch(req.auth!, body, metaOf(req));
      return reply.code(201).send({ branch });
    },
  );

  app.get(
    "/branches/:id",
    { preHandler: [authenticate, authorize(["settings.read"])] },
    async (req, reply) => {
      const { id } = parse(idParamSchema, req.params);
      const branch = await service.getBranch(req.auth!, id);
      return reply.code(200).send({ branch });
    },
  );

  app.patch(
    "/branches/:id",
    { preHandler: [authenticate, authorize(["settings.branches.edit"])] },
    async (req, reply) => {
      const { id } = parse(idParamSchema, req.params);
      const body = parse(updateBranchSchema, req.body);
      const branch = await service.updateBranch(req.auth!, id, body, metaOf(req));
      return reply.code(200).send({ branch });
    },
  );

  /**
   * Enable/disable is its own endpoint, not a PATCH field — same reasoning
   * as customers' /status and orders' /status: a distinct, auditable action
   * (`branch.enable` / `branch.disable`) rather than a boolean buried in a
   * bulk field edit.
   */
  app.post(
    "/branches/:id/status",
    { preHandler: [authenticate, authorize(["settings.branches.edit"])] },
    async (req, reply) => {
      const { id } = parse(idParamSchema, req.params);
      const body = parse(setActiveSchema, req.body);
      const branch = await service.setActive(req.auth!, id, body, metaOf(req));
      return reply.code(200).send({ branch });
    },
  );

  app.delete(
    "/branches/:id",
    { preHandler: [authenticate, authorize(["settings.branches.edit"])] },
    async (req, reply) => {
      const { id } = parse(idParamSchema, req.params);
      const result = await service.deleteBranch(req.auth!, id, metaOf(req));
      return reply.code(200).send(result);
    },
  );

  app.post(
    "/branches/:id/restore",
    { preHandler: [authenticate, authorize(["settings.branches.edit"])] },
    async (req, reply) => {
      const { id } = parse(idParamSchema, req.params);
      const branch = await service.restoreBranch(req.auth!, id, metaOf(req));
      return reply.code(200).send({ branch });
    },
  );
}
