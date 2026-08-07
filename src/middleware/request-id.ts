/**
 * Request ID.
 *
 * Trust an incoming X-Request-ID if present (Nginx sets one); otherwise
 * generate. Attach to the reply as X-Request-ID so a client error can be
 * paired to the log line by an operator without exposing internals.
 */

import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";

export function registerRequestId(app: FastifyInstance): void {
  app.addHook("onRequest", async (request, reply) => {
    const incoming = request.headers["x-request-id"];
    const id = typeof incoming === "string" && incoming.length <= 128 ? incoming : nanoid(14);
    request.id = id;
    reply.header("x-request-id", id);
  });
}
