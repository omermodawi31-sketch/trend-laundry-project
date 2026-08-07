/**
 * Application entry point.
 *
 * One entry per process. Which entry runs is decided by env.ROLE:
 *   - "api"    → builds and listens on PORT
 *   - "worker" → starts the BullMQ consumer (Phase 6+)
 *
 * Same image, two roles. Deploy the api and the worker as separate
 * processes/containers with different ROLE values.
 */

import { env } from "./config/env.js";
import { logger } from "./config/logger.js";
import { buildApp } from "./api.js";
import { closeDb } from "./lib/db.js";

async function runApi(): Promise<void> {
  const app = await buildApp();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "shutting down");
    try {
      await app.close();
      await closeDb();
      process.exit(0);
    } catch (err) {
      logger.error({ err }, "error during shutdown");
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  try {
    await app.listen({ port: env.PORT, host: "0.0.0.0" });
    logger.info({ port: env.PORT, env: env.NODE_ENV }, "api listening");
  } catch (err) {
    logger.error({ err }, "failed to start api");
    process.exit(1);
  }
}

async function runWorker(): Promise<void> {
  logger.info("worker role selected; no queues wired yet (Phase 6+)");
  logger.info("keeping process alive so the container health check has something to talk to");
  // Empty worker in Phase 0. Actual queue consumers land in Phase 6.
  await new Promise<void>((resolve) => {
    process.on("SIGTERM", resolve);
    process.on("SIGINT", resolve);
  });
}

if (env.ROLE === "api") {
  await runApi();
} else {
  await runWorker();
}
