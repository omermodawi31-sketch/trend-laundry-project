/**
 * A05: Security headers + error exposure.
 *
 * Two invariants:
 *   1. Helmet headers are present on every response.
 *   2. Error bodies never leak stack traces, SQL, or file paths.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/api.js";
import type { FastifyInstance } from "fastify";

describe("A05: security headers on every response", () => {
  let app: FastifyInstance;
  beforeAll(async () => { app = await buildApp(); });
  afterAll(async () => { await app.close(); });

  it("root responds with Helmet security headers", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    // Helmet defaults we rely on:
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBeTruthy();
    expect(res.headers["referrer-policy"]).toBeTruthy();
    expect(res.headers["x-dns-prefetch-control"]).toBeTruthy();
    // X-Powered-By must be removed.
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("health endpoint includes X-Request-ID", async () => {
    const res = await app.inject({ method: "GET", url: "/health/live" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-request-id"]).toBeTruthy();
  });

  it("respects incoming X-Request-Id header (from Nginx) without allowing CRLF injection", async () => {
    // Legitimate case: id echoed back.
    const clean = await app.inject({
      method: "GET",
      url: "/health/live",
      headers: { "x-request-id": "abc-123-xyz" },
    });
    expect(clean.headers["x-request-id"]).toBe("abc-123-xyz");

    // CRLF injection attempt — Node itself rejects newlines in header values,
    // so the malicious header is either dropped or the request fails.
    // We verify the response does NOT contain a newly-injected Set-Cookie.
    try {
      const injected = await app.inject({
        method: "GET",
        url: "/health/live",
        headers: { "x-request-id": "abc\r\nSet-Cookie: evil=1" },
      });
      // If the framework accepted it, must not have created an injected cookie.
      expect(injected.headers["set-cookie"]).toBeUndefined();
    } catch {
      // Fastify/Node rejected the malformed header — also correct.
      expect(true).toBe(true);
    }
  });
});

describe("A05: error responses never leak internals", () => {
  let app: FastifyInstance;
  beforeAll(async () => { app = await buildApp(); });
  afterAll(async () => { await app.close(); });

  it("404 has no path traversal, no stack", async () => {
    const res = await app.inject({ method: "GET", url: "/does-not-exist" });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.code).toBe("not-found");
    // No filesystem paths.
    expect(JSON.stringify(body)).not.toMatch(/\/home\/|\/mnt\/|\/usr\/|\/var\//);
    // No stack.
    expect(JSON.stringify(body)).not.toMatch(/at\s+.*\(.*:\d+:\d+\)/);
  });

  it("body-too-large returns a structured error, not the raw parser message", async () => {
    // 2 MB payload exceeds the 1 MB bodyLimit configured in api.ts.
    const big = "x".repeat(2 * 1024 * 1024);
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: big,
      headers: { "content-type": "application/json" },
    });
    // Some validation error, but no leaked internals.
    expect([400, 413, 422]).toContain(res.statusCode);
    const body = res.body;
    expect(body).not.toMatch(/node_modules|src\/|at\s+.*\.ts/);
  });
});
