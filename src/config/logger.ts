/**
 * Structured logger.
 *
 * Redaction is *mandatory* here, not optional. Every path listed below is a
 * field that must never appear in logs, even by accident. Pino's redact
 * feature replaces matching values with '[Redacted]' before serialisation.
 * Adding a new sensitive field to a schema without adding it here is a
 * security bug — code review must catch this.
 */

import pino from "pino";
import { env } from "./env.js";

const redactPaths = [
  // Request/response bodies
  "req.body.password",
  "req.body.newPassword",
  "req.body.currentPassword",
  "req.body.token",
  "req.body.refreshToken",
  "req.body.otp",
  "req.body.mfa_code",

  // Headers
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers['x-refresh-token']",

  // Response
  "res.headers['set-cookie']",

  // Anywhere these leak
  "*.password",
  "*.password_hash",
  "*.token_hash",
  "*.mfa_secret",
  "*.access_token",
  "*.refresh_token",
];

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: { paths: redactPaths, censor: "[Redacted]" },
  base: { role: env.ROLE, env: env.NODE_ENV },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
  transport: env.isDev
    ? { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss.l" } }
    : undefined,
});

export type Logger = typeof logger;
