/**
 * Customer routes.
 *
 * Handlers are deliberately thin: parse → call service → reply. No business
 * logic, no SQL.
 *
 * Every route carries BOTH middlewares:
 *   preHandler: [authenticate, authorize([...])]
 *
 * `authenticate` proves who the caller is; `authorize` proves they may do
 * this. A route with only `authenticate` is authenticated-but-unrestricted,
 * which is a bug — see OWASP-COMPLIANCE.md §A01.
 *
 * Validation uses Zod (schemas.ts) rather than Fastify JSON schema so that
 * refinements like "blocked status requires a reason" are expressible. A
 * failed parse throws a ZodError, which the global error handler converts
 * into a structured 422.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { Errors } from "../../lib/errors.js";
import * as service from "./service.js";
import {
  activityQuerySchema,
  changeStatusSchema,
  createCustomerSchema,
  createNoteSchema,
  idParamSchema,
  listQuerySchema,
  noteIdParamSchema,
  updateCustomerSchema,
} from "./schemas.js";

/** Extract audit metadata from the request. */
function metaOf(req: FastifyRequest): service.RequestMeta {
  return {
    ipAddress: req.ip ?? null,
    userAgent: (req.headers["user-agent"] as string | undefined) ?? null,
  };
}

/**
 * Parse with Zod and convert failures into our structured error shape.
 *
 * Zod's own error is developer-friendly but leaks the internal schema shape,
 * so we map it to `{ field, message }` pairs and nothing more.
 */
function parse<T>(schema: { parse: (v: unknown) => T }, value: unknown): T {
  try {
    return schema.parse(value);
  } catch (err) {
    if (err instanceof ZodError) {
      throw Errors.validation("Request validation failed.", {
        issues: err.issues.map((i) => ({
          field: i.path.join("."),
          message: i.message,
        })),
      });
    }
    throw err;
  }
}

export async function customerRoutes(app: FastifyInstance): Promise<void> {
  /* ---------------------------------------------------------------- */
  /*  Collection                                                       */
  /* ---------------------------------------------------------------- */

  app.get(
    "/customers",
    { preHandler: [authenticate, authorize(["customers.read"])] },
    async (req, reply) => {
      const query = parse(listQuerySchema, req.query);
      const result = await service.listCustomers(req.auth!, query);
      return reply.code(200).send(result);
    },
  );

  app.post(
    "/customers",
    { preHandler: [authenticate, authorize(["customers.create"])] },
    async (req, reply) => {
      const body = parse(createCustomerSchema, req.body);
      const customer = await service.createCustomer(req.auth!, body, metaOf(req));
      return reply.code(201).send({ customer });
    },
  );

  /**
   * Tenant-wide statistics.
   *
   * Registered BEFORE `/customers/:id` so the literal path wins the route
   * match — otherwise "statistics" would be parsed as an id and rejected by
   * the numeric param schema.
   */
  app.get(
    "/customers/statistics",
    { preHandler: [authenticate, authorize(["customers.read"])] },
    async (req, reply) => {
      const stats = await service.getStatistics(req.auth!);
      return reply.code(200).send({ statistics: stats });
    },
  );

  /* ---------------------------------------------------------------- */
  /*  Single customer                                                  */
  /* ---------------------------------------------------------------- */

  app.get(
    "/customers/:id",
    { preHandler: [authenticate, authorize(["customers.read"])] },
    async (req, reply) => {
      const { id } = parse(idParamSchema, req.params);
      const customer = await service.getCustomer(req.auth!, id);
      return reply.code(200).send({ customer });
    },
  );

  app.patch(
    "/customers/:id",
    { preHandler: [authenticate, authorize(["customers.update"])] },
    async (req, reply) => {
      const { id } = parse(idParamSchema, req.params);
      const body = parse(updateCustomerSchema, req.body);
      const customer = await service.updateCustomer(req.auth!, id, body, metaOf(req));
      return reply.code(200).send({ customer });
    },
  );

  /**
   * Status changes are their own endpoint, not a PATCH field.
   *
   * Blocking a customer is a decision with a reason and a distinct audit
   * action. Folding it into PATCH would make both the permission check and
   * the audit trail ambiguous.
   */
  app.post(
    "/customers/:id/status",
    { preHandler: [authenticate, authorize(["customers.update"])] },
    async (req, reply) => {
      const { id } = parse(idParamSchema, req.params);
      const body = parse(changeStatusSchema, req.body);
      const customer = await service.changeStatus(req.auth!, id, body, metaOf(req));
      return reply.code(200).send({ customer });
    },
  );

  app.delete(
    "/customers/:id",
    { preHandler: [authenticate, authorize(["customers.delete"])] },
    async (req, reply) => {
      const { id } = parse(idParamSchema, req.params);
      const result = await service.deleteCustomer(req.auth!, id, metaOf(req));
      return reply.code(200).send(result);
    },
  );

  app.post(
    "/customers/:id/restore",
    { preHandler: [authenticate, authorize(["customers.delete"])] },
    async (req, reply) => {
      const { id } = parse(idParamSchema, req.params);
      const customer = await service.restoreCustomer(req.auth!, id, metaOf(req));
      return reply.code(200).send({ customer });
    },
  );

  /* ---------------------------------------------------------------- */
  /*  Activity history                                                 */
  /* ---------------------------------------------------------------- */

  app.get(
    "/customers/:id/activity",
    { preHandler: [authenticate, authorize(["customers.read", "activity_log.read"])] },
    async (req, reply) => {
      const { id } = parse(idParamSchema, req.params);
      const query = parse(activityQuerySchema, req.query);
      const result = await service.getActivity(req.auth!, id, query);
      return reply.code(200).send(result);
    },
  );

  /* ---------------------------------------------------------------- */
  /*  Notes                                                            */
  /* ---------------------------------------------------------------- */

  app.get(
    "/customers/:id/notes",
    { preHandler: [authenticate, authorize(["customers.read"])] },
    async (req, reply) => {
      const { id } = parse(idParamSchema, req.params);
      const notes = await service.listNotes(req.auth!, id);
      return reply.code(200).send({ notes });
    },
  );

  app.post(
    "/customers/:id/notes",
    { preHandler: [authenticate, authorize(["customers.update"])] },
    async (req, reply) => {
      const { id } = parse(idParamSchema, req.params);
      const body = parse(createNoteSchema, req.body);
      const note = await service.addNote(req.auth!, id, body, metaOf(req));
      return reply.code(201).send({ note });
    },
  );

  app.delete(
    "/customers/:id/notes/:noteId",
    { preHandler: [authenticate, authorize(["customers.update"])] },
    async (req, reply) => {
      const { id, noteId } = parse(noteIdParamSchema, req.params);
      const result = await service.deleteNote(req.auth!, id, noteId, metaOf(req));
      return reply.code(200).send(result);
    },
  );
}
