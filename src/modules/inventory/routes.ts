/**
 * Inventory routes.
 *
 * Same shape as every other module: parse → service → reply. Every route
 * carries `authenticate` + `authorize([...])`; branch-level scope (where it
 * applies) is enforced inside the service layer via branch-scope.ts, not
 * here — the decision needs the target branch id, which for movement
 * endpoints comes from the URL and for transfer comes from the body.
 *
 * `/items/by-code/:code` is registered BEFORE `/items/:id` so the literal
 * path wins the route match — the same lesson customers/routes.ts already
 * documented for `/customers/statistics` vs `/customers/:id`.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { Errors } from "../../lib/errors.js";
import * as service from "./service.js";
import {
  adjustSchema,
  branchIdParamSchema,
  codeParamSchema,
  createItemSchema,
  idParamSchema,
  listItemsQuerySchema,
  listMovementsQuerySchema,
  receiveSchema,
  setActiveSchema,
  transferSchema,
  updateItemSchema,
  wasteSchema,
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

export async function inventoryRoutes(app: FastifyInstance): Promise<void> {
  /* ------------------------------------------------------------------ */
  /*  Catalog                                                             */
  /* ------------------------------------------------------------------ */

  app.get(
    "/inventory/items",
    { preHandler: [authenticate, authorize(["inventory.read"])] },
    async (req, reply) => {
      const query = parse(listItemsQuerySchema, req.query);
      const result = await service.listItems(req.auth!, query);
      return reply.code(200).send(result);
    },
  );

  app.post(
    "/inventory/items",
    { preHandler: [authenticate, authorize(["inventory.adjust"])] },
    async (req, reply) => {
      const body = parse(createItemSchema, req.body);
      const item = await service.createItem(req.auth!, body, metaOf(req));
      return reply.code(201).send({ item });
    },
  );

  /** Scan-lookup — registered before `/items/:id` for the routing reason above. */
  app.get(
    "/inventory/items/by-code/:code",
    { preHandler: [authenticate, authorize(["inventory.read"])] },
    async (req, reply) => {
      const { code } = parse(codeParamSchema, req.params);
      const item = await service.getItemByCode(req.auth!, code);
      return reply.code(200).send({ item });
    },
  );

  app.get(
    "/inventory/items/:id",
    { preHandler: [authenticate, authorize(["inventory.read"])] },
    async (req, reply) => {
      const { id } = parse(idParamSchema, req.params);
      const item = await service.getItem(req.auth!, id);
      return reply.code(200).send({ item });
    },
  );

  app.patch(
    "/inventory/items/:id",
    { preHandler: [authenticate, authorize(["inventory.adjust"])] },
    async (req, reply) => {
      const { id } = parse(idParamSchema, req.params);
      const body = parse(updateItemSchema, req.body);
      const item = await service.updateItem(req.auth!, id, body, metaOf(req));
      return reply.code(200).send({ item });
    },
  );

  app.post(
    "/inventory/items/:id/status",
    { preHandler: [authenticate, authorize(["inventory.adjust"])] },
    async (req, reply) => {
      const { id } = parse(idParamSchema, req.params);
      const body = parse(setActiveSchema, req.body);
      const item = await service.setActive(req.auth!, id, body, metaOf(req));
      return reply.code(200).send({ item });
    },
  );

  app.delete(
    "/inventory/items/:id",
    { preHandler: [authenticate, authorize(["inventory.adjust"])] },
    async (req, reply) => {
      const { id } = parse(idParamSchema, req.params);
      const result = await service.deleteItem(req.auth!, id, metaOf(req));
      return reply.code(200).send(result);
    },
  );

  app.post(
    "/inventory/items/:id/restore",
    { preHandler: [authenticate, authorize(["inventory.adjust"])] },
    async (req, reply) => {
      const { id } = parse(idParamSchema, req.params);
      const item = await service.restoreItem(req.auth!, id, metaOf(req));
      return reply.code(200).send({ item });
    },
  );

  app.get(
    "/inventory/items/:id/stock",
    { preHandler: [authenticate, authorize(["inventory.read"])] },
    async (req, reply) => {
      const { id } = parse(idParamSchema, req.params);
      const result = await service.getItemStock(req.auth!, id);
      return reply.code(200).send(result);
    },
  );

  app.get(
    "/inventory/items/:id/movements",
    { preHandler: [authenticate, authorize(["inventory.read"])] },
    async (req, reply) => {
      const { id } = parse(idParamSchema, req.params);
      const query = parse(listMovementsQuerySchema, req.query);
      const result = await service.getItemMovements(req.auth!, id, query);
      return reply.code(200).send(result);
    },
  );

  /* ------------------------------------------------------------------ */
  /*  Branch stock and movements                                          */
  /* ------------------------------------------------------------------ */

  app.get(
    "/inventory/branches/:branchId/stock",
    { preHandler: [authenticate, authorize(["inventory.read"])] },
    async (req, reply) => {
      const { branchId } = parse(branchIdParamSchema, req.params);
      const result = await service.getBranchStock(req.auth!, branchId);
      return reply.code(200).send(result);
    },
  );

  app.get(
    "/inventory/branches/:branchId/movements",
    { preHandler: [authenticate, authorize(["inventory.read"])] },
    async (req, reply) => {
      const { branchId } = parse(branchIdParamSchema, req.params);
      const query = parse(listMovementsQuerySchema, req.query);
      const result = await service.getBranchMovements(req.auth!, branchId, query);
      return reply.code(200).send(result);
    },
  );

  app.post(
    "/inventory/branches/:branchId/receive",
    { preHandler: [authenticate, authorize(["inventory.receive"])] },
    async (req, reply) => {
      const { branchId } = parse(branchIdParamSchema, req.params);
      const body = parse(receiveSchema, req.body);
      const result = await service.recordReceive(req.auth!, branchId, body, metaOf(req));
      return reply.code(201).send(result);
    },
  );

  app.post(
    "/inventory/branches/:branchId/waste",
    { preHandler: [authenticate, authorize(["inventory.waste_record"])] },
    async (req, reply) => {
      const { branchId } = parse(branchIdParamSchema, req.params);
      const body = parse(wasteSchema, req.body);
      const result = await service.recordWaste(req.auth!, branchId, body, metaOf(req));
      return reply.code(201).send(result);
    },
  );

  app.post(
    "/inventory/branches/:branchId/adjust",
    { preHandler: [authenticate, authorize(["inventory.adjust"])] },
    async (req, reply) => {
      const { branchId } = parse(branchIdParamSchema, req.params);
      const body = parse(adjustSchema, req.body);
      const result = await service.recordAdjust(req.auth!, branchId, body, metaOf(req));
      return reply.code(201).send(result);
    },
  );

  /* ------------------------------------------------------------------ */
  /*  Transfers                                                           */
  /* ------------------------------------------------------------------ */

  app.post(
    "/inventory/transfer",
    { preHandler: [authenticate, authorize(["inventory.adjust"])] },
    async (req, reply) => {
      const body = parse(transferSchema, req.body);
      const result = await service.recordTransfer(req.auth!, body, metaOf(req));
      return reply.code(201).send(result);
    },
  );
}
