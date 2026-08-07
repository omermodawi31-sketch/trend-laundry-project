/**
 * Delivery routes.
 *
 * Same shape as every other module: parse → service → reply. Branch scope
 * and self-scope (branch-scope.ts) are enforced inside the service layer,
 * not here — the decision needs the target job/branch, which comes from
 * the resolved row, not the raw request.
 *
 * `driver.status` allows EITHER `delivery.execute` (the driver acting on
 * themselves) OR `delivery.dispatch` (a manager overriding) — the only
 * endpoint in this module gated by two alternative permissions rather than
 * one, because it's the only action a driver performs on their OWN record
 * rather than on a job. The self-vs-override check itself lives in the
 * service layer (setDriverStatus), matching the branch-scope split; the
 * route only needs to admit either permission through.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { Errors } from "../../lib/errors.js";
import * as service from "./service.js";
import {
  advanceJobStatusSchema,
  assignDriverSchema,
  branchIdParamSchema,
  completeJobSchema,
  createDriverSchema,
  createJobSchema,
  failJobSchema,
  idParamSchema,
  listDriversQuerySchema,
  listJobsQuerySchema,
  orderIdParamSchema,
  setDriverStatusSchema,
  updateDriverSchema,
  updateJobSchema,
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

export async function deliveryRoutes(app: FastifyInstance): Promise<void> {
  /* ------------------------------------------------------------------ */
  /*  Drivers                                                             */
  /* ------------------------------------------------------------------ */

  app.get(
    "/delivery/drivers",
    { preHandler: [authenticate, authorize(["delivery.read"])] },
    async (req, reply) => {
      const query = parse(listDriversQuerySchema, req.query);
      const result = await service.listDrivers(req.auth!, query);
      return reply.code(200).send(result);
    },
  );

  app.post(
    "/delivery/drivers",
    { preHandler: [authenticate, authorize(["delivery.dispatch"])] },
    async (req, reply) => {
      const body = parse(createDriverSchema, req.body);
      const driver = await service.createDriver(req.auth!, body, metaOf(req));
      return reply.code(201).send({ driver });
    },
  );

  app.get(
    "/delivery/drivers/:id",
    { preHandler: [authenticate, authorize(["delivery.read"])] },
    async (req, reply) => {
      const { id } = parse(idParamSchema, req.params);
      const driver = await service.getDriver(req.auth!, id);
      return reply.code(200).send({ driver });
    },
  );

  app.patch(
    "/delivery/drivers/:id",
    { preHandler: [authenticate, authorize(["delivery.dispatch"])] },
    async (req, reply) => {
      const { id } = parse(idParamSchema, req.params);
      const body = parse(updateDriverSchema, req.body);
      const driver = await service.updateDriver(req.auth!, id, body, metaOf(req));
      return reply.code(200).send({ driver });
    },
  );

  app.post(
    "/delivery/drivers/:id/status",
    // Coarse gate only — `delivery.read` is the one permission every role
    // that could legitimately reach this endpoint actually has (manager,
    // driver, owner). The real decision ("is this caller the driver in
    // question, or do they hold delivery.dispatch") is authorization logic
    // that depends on which driver, not just who's asking — exactly the
    // same layering `assertCanActOnJob` already uses for jobs elsewhere in
    // this module, applied here to drivers. `authorize()` is deliberately
    // AND-only (see its own docstring) and was never going to express
    // "execute OR dispatch" as a static permission list — the previous
    // version of this line tried to pass a `{ mode: "any" }` option that
    // `authorize()` has no parameter for; it was silently ignored at
    // runtime (JS ignores extra arguments) and would fail to type-check
    // under `tsc`. Fixed by moving the OR down to where it already
    // correctly lives: `service.setDriverStatus`'s `isSelf ||
    // auth.permissions.includes("delivery.dispatch")` check, unchanged.
    { preHandler: [authenticate, authorize(["delivery.read"])] },
    async (req, reply) => {
      const { id } = parse(idParamSchema, req.params);
      const body = parse(setDriverStatusSchema, req.body);
      const driver = await service.setDriverStatus(req.auth!, id, body, metaOf(req));
      return reply.code(200).send({ driver });
    },
  );

  app.delete(
    "/delivery/drivers/:id",
    { preHandler: [authenticate, authorize(["delivery.dispatch"])] },
    async (req, reply) => {
      const { id } = parse(idParamSchema, req.params);
      const result = await service.deleteDriver(req.auth!, id, metaOf(req));
      return reply.code(200).send(result);
    },
  );

  app.post(
    "/delivery/drivers/:id/restore",
    { preHandler: [authenticate, authorize(["delivery.dispatch"])] },
    async (req, reply) => {
      const { id } = parse(idParamSchema, req.params);
      const driver = await service.restoreDriver(req.auth!, id, metaOf(req));
      return reply.code(200).send({ driver });
    },
  );

  app.get(
    "/delivery/drivers/:id/jobs",
    { preHandler: [authenticate, authorize(["delivery.read"])] },
    async (req, reply) => {
      const { id } = parse(idParamSchema, req.params);
      const query = parse(listJobsQuerySchema, req.query);
      const result = await service.listJobsForDriver(req.auth!, id, query);
      return reply.code(200).send(result);
    },
  );

  /* ------------------------------------------------------------------ */
  /*  Jobs                                                                 */
  /* ------------------------------------------------------------------ */

  app.post(
    "/delivery/jobs",
    { preHandler: [authenticate, authorize(["delivery.dispatch"])] },
    async (req, reply) => {
      const body = parse(createJobSchema, req.body);
      const job = await service.createJob(req.auth!, body, metaOf(req));
      return reply.code(201).send({ job });
    },
  );

  app.get(
    "/delivery/branches/:branchId/jobs",
    { preHandler: [authenticate, authorize(["delivery.read"])] },
    async (req, reply) => {
      const { branchId } = parse(branchIdParamSchema, req.params);
      const query = parse(listJobsQuerySchema, req.query);
      const result = await service.listJobsForBranch(req.auth!, branchId, query);
      return reply.code(200).send(result);
    },
  );

  app.get(
    "/delivery/orders/:orderId/jobs",
    { preHandler: [authenticate, authorize(["delivery.read"])] },
    async (req, reply) => {
      const { orderId } = parse(orderIdParamSchema, req.params);
      const result = await service.listJobsForOrder(req.auth!, orderId);
      return reply.code(200).send(result);
    },
  );

  app.get(
    "/delivery/jobs/:id",
    { preHandler: [authenticate, authorize(["delivery.read"])] },
    async (req, reply) => {
      const { id } = parse(idParamSchema, req.params);
      const job = await service.getJob(req.auth!, id);
      return reply.code(200).send({ job });
    },
  );

  app.patch(
    "/delivery/jobs/:id",
    { preHandler: [authenticate, authorize(["delivery.dispatch"])] },
    async (req, reply) => {
      const { id } = parse(idParamSchema, req.params);
      const body = parse(updateJobSchema, req.body);
      const job = await service.updateJob(req.auth!, id, body, metaOf(req));
      return reply.code(200).send({ job });
    },
  );

  app.post(
    "/delivery/jobs/:id/assign",
    { preHandler: [authenticate, authorize(["delivery.assign_driver"])] },
    async (req, reply) => {
      const { id } = parse(idParamSchema, req.params);
      const body = parse(assignDriverSchema, req.body);
      const job = await service.assignDriver(req.auth!, id, body, metaOf(req));
      return reply.code(200).send({ job });
    },
  );

  app.post(
    "/delivery/jobs/:id/status",
    { preHandler: [authenticate, authorize(["delivery.execute"])] },
    async (req, reply) => {
      const { id } = parse(idParamSchema, req.params);
      const body = parse(advanceJobStatusSchema, req.body);
      const job = await service.advanceStatus(req.auth!, id, body, metaOf(req));
      return reply.code(200).send({ job });
    },
  );

  app.post(
    "/delivery/jobs/:id/complete",
    { preHandler: [authenticate, authorize(["delivery.complete"])] },
    async (req, reply) => {
      const { id } = parse(idParamSchema, req.params);
      const body = parse(completeJobSchema, req.body);
      const job = await service.completeJob(req.auth!, id, body, metaOf(req));
      return reply.code(200).send({ job });
    },
  );

  app.post(
    "/delivery/jobs/:id/fail",
    { preHandler: [authenticate, authorize(["delivery.fail"])] },
    async (req, reply) => {
      const { id } = parse(idParamSchema, req.params);
      const body = parse(failJobSchema, req.body);
      const job = await service.failJob(req.auth!, id, body, metaOf(req));
      return reply.code(200).send({ job });
    },
  );

  app.post(
    "/delivery/jobs/:id/cancel",
    { preHandler: [authenticate, authorize(["delivery.dispatch"])] },
    async (req, reply) => {
      const { id } = parse(idParamSchema, req.params);
      const body = parse(cancelJobSchema, req.body);
      const job = await service.cancelJob(req.auth!, id, body, metaOf(req));
      return reply.code(200).send({ job });
    },
  );

  app.delete(
    "/delivery/jobs/:id",
    { preHandler: [authenticate, authorize(["delivery.dispatch"])] },
    async (req, reply) => {
      const { id } = parse(idParamSchema, req.params);
      const result = await service.deleteJob(req.auth!, id, metaOf(req));
      return reply.code(200).send(result);
    },
  );

  app.post(
    "/delivery/jobs/:id/restore",
    { preHandler: [authenticate, authorize(["delivery.dispatch"])] },
    async (req, reply) => {
      const { id } = parse(idParamSchema, req.params);
      const job = await service.restoreJob(req.auth!, id, metaOf(req));
      return reply.code(200).send({ job });
    },
  );

  app.get(
    "/delivery/jobs/:id/history",
    { preHandler: [authenticate, authorize(["delivery.read"])] },
    async (req, reply) => {
      const { id } = parse(idParamSchema, req.params);
      const result = await service.getJobHistory(req.auth!, id);
      return reply.code(200).send(result);
    },
  );
}
