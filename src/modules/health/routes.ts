/**
 * Health check.
 *
 * Two endpoints:
 *   - GET /health/live  — the process is up. Always returns 200 unless
 *     Node itself is broken. Used by container orchestrators for liveness.
 *   - GET /health/ready — dependencies are reachable. Returns 503 if the
 *     database is unreachable. Used for readiness probes and load-balancer
 *     "should I send traffic here" decisions.
 *
 * The distinction matters: a slow database should not restart the API pod,
 * but it should stop new traffic from arriving. Liveness = self, readiness =
 * self + dependencies.
 */

import type { FastifyInstance } from "fastify";
import { pingDb } from "../../lib/db.js";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health/live", async () => ({ status: "ok", uptime_s: Math.round(process.uptime()) }));

  app.get("/health/ready", async (_req, reply) => {
    const dbOk = await pingDb();
    if (!dbOk) {
      return reply.code(503).send({ status: "degraded", db: false });
    }
    return { status: "ok", db: true };
  });
}
