/**
 * Fastify application factory.
 *
 * `buildApp()` returns a configured Fastify instance without listening. Tests
 * use `app.inject(...)` against the returned instance; production uses
 * `app.listen(...)` from main.ts. Same code path both ways.
 */

import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import cookie from "@fastify/cookie";
import sensible from "@fastify/sensible";
import { env } from "./config/env.js";
import { logger } from "./config/logger.js";
import { registerRequestId } from "./middleware/request-id.js";
import { registerErrorHandler } from "./middleware/error-handler.js";
import { healthRoutes } from "./modules/health/routes.js";
import { authRoutes } from "./modules/auth/routes.js";
import { teamRoutes } from "./modules/team/routes.js";
import { customerRoutes } from "./modules/customers/routes.js";
import { orderRoutes } from "./modules/orders/routes.js";
import { branchRoutes } from "./modules/branches/routes.js";
import { inventoryRoutes } from "./modules/inventory/routes.js";
import { settingsRoutes } from "./modules/settings/routes.js";
import { deliveryRoutes } from "./modules/delivery/routes.js";

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    // Use our pino instance so redaction rules apply everywhere.
    loggerInstance: logger,
    // We generate the request id ourselves so we can honour X-Request-ID from Nginx.
    genReqId: () => "",
    // Trust the first proxy hop in prod; needed for correct client IPs.
    trustProxy: env.isProd,
    // JSON parser limits — 1 MB is plenty for our shapes.
    bodyLimit: 1_048_576,
    disableRequestLogging: false,
  });

  // ---- Security & platform plugins ------------------------------------------
  await app.register(helmet, {
    // Adjust once we know the exact CDN/asset origins in prod.
    contentSecurityPolicy: false,
  });

  await app.register(cors, {
    origin: env.corsOrigins.length ? env.corsOrigins : false,
    credentials: true,
  });

  await app.register(cookie, {
    hook: "onRequest",
  });

  await app.register(sensible);

  // ---- Cross-cutting middleware ---------------------------------------------
  registerRequestId(app);
  registerErrorHandler(app);

  // ---- Routes ---------------------------------------------------------------
  // Phase 1: auth, team, health.
  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(teamRoutes);
  await app.register(customerRoutes);
  await app.register(orderRoutes);
  await app.register(branchRoutes);
  await app.register(inventoryRoutes);
  await app.register(settingsRoutes);
  await app.register(deliveryRoutes);

  // Root probe — a curl against `/` should always work.
  app.get("/", async () => ({
    name: "trend-laundry-backend",
    version: "0.2.0",
    phase: "1-auth-and-identity",
  }));

  return app;
}
