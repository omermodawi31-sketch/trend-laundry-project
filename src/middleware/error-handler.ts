/**
 * Global error handler.
 *
 * Every response body from a failure looks like:
 *   { code: "kebab-case", message: "human", details?: {...} }
 *
 * Never leak stack traces, SQL, or provider errors. Those go to the logs
 * with the request id so operators can correlate.
 */

import type { FastifyInstance, FastifyError } from "fastify";
import { AppError } from "../lib/errors.js";

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | AppError, request, reply) => {
    // Structured application error — shape is safe to return as-is.
    if (err instanceof AppError) {
      request.log.info(
        { code: err.code, status: err.status, details: err.details },
        "application error",
      );
      return reply.code(err.status).send({
        code: err.code,
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
      });
    }

    // Validation errors from Fastify's JSON schema check.
    if (err.validation) {
      return reply.code(422).send({
        code: "validation-failed",
        message: "Request body failed validation.",
        details: { errors: err.validation },
      });
    }

    // Rate limit plugin fires here.
    if (err.statusCode === 429) {
      return reply.code(429).send({
        code: "rate-limited",
        message: "Too many requests.",
      });
    }

    // Anything else is unexpected — log with full context, return a bland 500.
    request.log.error({ err }, "unhandled error");
    return reply.code(500).send({
      code: "internal-error",
      message: "Something went wrong.",
    });
  });

  app.setNotFoundHandler((_req, reply) => {
    return reply.code(404).send({
      code: "not-found",
      message: "Route not found.",
    });
  });
}
