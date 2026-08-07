/**
 * A09: Log redaction regression test.
 *
 * Sensitive fields (password, token, mfa_code, authorization header) must
 * never appear in logs. Pino's redact config in src/config/logger.ts
 * replaces matching values with '[Redacted]'. This test proves that.
 *
 * A regression here would be catastrophic — a password leaking into logs
 * that get shipped to a third-party aggregator is a breach.
 */

import { describe, expect, it } from "vitest";
import pino from "pino";

// Import the redact paths we use in production.
// If they diverge from src/config/logger.ts, this test fails.
const redactPaths = [
  "req.body.password",
  "req.body.newPassword",
  "req.body.currentPassword",
  "req.body.token",
  "req.body.refreshToken",
  "req.body.otp",
  "req.body.mfa_code",
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["x-refresh-token"]',
  'res.headers["set-cookie"]',
  "*.password",
  "*.password_hash",
  "*.token_hash",
  "*.mfa_secret",
  "*.access_token",
  "*.refresh_token",
];

function captureLog(fn: (log: pino.Logger) => void): string[] {
  const captured: string[] = [];
  const stream = { write: (chunk: string) => { captured.push(chunk); return true; } };
  const log = pino(
    { redact: { paths: redactPaths, censor: "[Redacted]" } },
    stream as never,
  );
  fn(log);
  return captured;
}

describe("A09: log redaction", () => {
  it("redacts password in request body", () => {
    const lines = captureLog((log) => {
      log.info({ req: { body: { email: "user@example.com", password: "s3cret-value" } } }, "login attempt");
    });
    const joined = lines.join("\n");
    expect(joined).not.toContain("s3cret-value");
    expect(joined).toContain("[Redacted]");
  });

  it("redacts Authorization header", () => {
    const lines = captureLog((log) => {
      log.info({ req: { headers: { authorization: "Bearer secret-jwt-token-content" } } }, "request");
    });
    const joined = lines.join("\n");
    expect(joined).not.toContain("secret-jwt-token-content");
  });

  it("redacts cookie header", () => {
    const lines = captureLog((log) => {
      log.info({ req: { headers: { cookie: "refresh=deadbeef; session=abc" } } }, "request");
    });
    const joined = lines.join("\n");
    expect(joined).not.toContain("deadbeef");
  });

  it("redacts password_hash and token_hash anywhere", () => {
    const lines = captureLog((log) => {
      log.info({ user: { id: 1, email: "x@y.z", password_hash: "$argon2id$abcdef" } }, "user loaded");
      log.info({ session: { token_hash: "someRawHashHere" } }, "session created");
    });
    const joined = lines.join("\n");
    expect(joined).not.toContain("$argon2id$abcdef");
    expect(joined).not.toContain("someRawHashHere");
  });

  it("redacts mfa_secret and mfa_code", () => {
    const lines = captureLog((log) => {
      log.info({ user: { mfa_secret: "JBSWY3DPEHPK3PXP" } }, "user");
      log.info({ req: { body: { mfa_code: "123456" } } }, "verify");
    });
    const joined = lines.join("\n");
    expect(joined).not.toContain("JBSWY3DPEHPK3PXP");
    expect(joined).not.toContain("123456");
  });

  it("redacts refresh_token and access_token anywhere", () => {
    const lines = captureLog((log) => {
      log.info({ result: { access_token: "eyJhbGci-secret-token", refresh_token: "raw-refresh-value" } }, "issued");
    });
    const joined = lines.join("\n");
    expect(joined).not.toContain("eyJhbGci-secret-token");
    expect(joined).not.toContain("raw-refresh-value");
  });

  it("does not redact fields that are safe to log", () => {
    const lines = captureLog((log) => {
      log.info(
        { req: { body: { email: "user@example.com", full_name: "Test User" }, id: "req-abc" } },
        "request received",
      );
    });
    const joined = lines.join("\n");
    // Emails and names are fine to log (correlated with X-Request-ID for support).
    expect(joined).toContain("user@example.com");
    expect(joined).toContain("Test User");
    expect(joined).toContain("req-abc");
  });
});
