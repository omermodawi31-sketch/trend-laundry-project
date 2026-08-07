/**
 * Order and services-catalogue routes.
 *
 * Thin handlers: parse → service → reply. Every route carries both
 * `authenticate` and `authorize`; a route with only `authenticate` is a bug
 * (see OWASP-COMPLIANCE.md §A01).
 *
 * Branch authorization is NOT here. It lives in the service layer via
 * `branch-scope.ts`, because the decision needs the order row — the URL alone
 * does not say which branches an order touches.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { Errors } from "../../lib/errors.js";
import * as service from "./service.js";
import {
  changeOrderStatusSchema,
  createOrderSchema,
  createServiceSchema,
  idParamSchema,
  listOrdersQuerySchema,
  recordPaymentSchema,
  refundSchema,
  updateOrderLinesSchema,
  updateOrderMetaSchema,
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

export async function orderRoutes(app: FastifyInstance): Promise<void> {
  /* ---------------------------------------------------------------- */
  /*  Services catalogue                                               */
  /* ---------------------------------------------------------------- */

  app.get(
    "/services",
    { preHandler: [authenticate, authorize(["orders.read"])] },
    async (req, reply) => {
      const services = await service.listServices(req.auth!);
      return reply.code(200).send({ services });
    },
  );

  // Editing the price list is a settings-level action, not an order action.
  app.post(
    "/services",
    { preHandler: [authenticate, authorize(["settings.business.edit"])] },
    async (req, reply) => {
      const body = parse(createServiceSchema, req.body);
      const created = await service.createService(req.auth!, body, metaOf(req));
      return reply.code(201).send({ service: created });
    },
  );

  /* ---------------------------------------------------------------- */
  /*  Orders                                                           */
  /* ---------------------------------------------------------------- */

  app.get(
    "/orders",
    { preHandler: [authenticate, authorize(["orders.read"])] },
    async (req, reply) => {
      const query = parse(listOrdersQuerySchema, req.query);
      const result = await service.listOrders(req.auth!, query);
      return reply.code(200).send(result);
    },
  );

  app.post(
    "/orders",
    { preHandler: [authenticate, authorize(["orders.create"])] },
    async (req, reply) => {
      const body = parse(createOrderSchema, req.body);
      const order = await service.createOrder(req.auth!, body, metaOf(req));
      return reply.code(201).send({ order });
    },
  );

  app.get(
    "/orders/:id",
    { preHandler: [authenticate, authorize(["orders.read"])] },
    async (req, reply) => {
      const { id } = parse(idParamSchema, req.params);
      const order = await service.getOrder(req.auth!, id);
      return reply.code(200).send({ order });
    },
  );

  app.patch(
    "/orders/:id/lines",
    { preHandler: [authenticate, authorize(["orders.update"])] },
    async (req, reply) => {
      const { id } = parse(idParamSchema, req.params);
      const body = parse(updateOrderLinesSchema, req.body);
      const order = await service.updateOrderLines(req.auth!, id, body, metaOf(req));
      return reply.code(200).send({ order });
    },
  );

  app.patch(
    "/orders/:id",
    { preHandler: [authenticate, authorize(["orders.update"])] },
    async (req, reply) => {
      const { id } = parse(idParamSchema, req.params);
      const body = parse(updateOrderMetaSchema, req.body);
      const order = await service.updateOrderMeta(req.auth!, id, body, metaOf(req));
      return reply.code(200).send({ order });
    },
  );

  app.post(
    "/orders/:id/status",
    { preHandler: [authenticate, authorize(["orders.status_change"])] },
    async (req, reply) => {
      const { id } = parse(idParamSchema, req.params);
      const body = parse(changeOrderStatusSchema, req.body);
      const order = await service.changeStatus(req.auth!, id, body, metaOf(req));
      return reply.code(200).send({ order });
    },
  );

  app.post(
    "/orders/:id/payments",
    { preHandler: [authenticate, authorize(["orders.payment_record"])] },
    async (req, reply) => {
      const { id } = parse(idParamSchema, req.params);
      const body = parse(recordPaymentSchema, req.body);
      const order = await service.recordPayment(req.auth!, id, body, metaOf(req));
      return reply.code(201).send({ order });
    },
  );

  app.post(
    "/orders/:id/refund",
    { preHandler: [authenticate, authorize(["orders.refund"])] },
    async (req, reply) => {
      const { id } = parse(idParamSchema, req.params);
      const body = parse(refundSchema, req.body);
      const order = await service.refundPayment(req.auth!, id, body, metaOf(req));
      return reply.code(201).send({ order });
    },
  );

  app.delete(
    "/orders/:id",
    { preHandler: [authenticate, authorize(["orders.delete"])] },
    async (req, reply) => {
      const { id } = parse(idParamSchema, req.params);
      const result = await service.deleteOrder(req.auth!, id, metaOf(req));
      return reply.code(200).send(result);
    },
  );
}
