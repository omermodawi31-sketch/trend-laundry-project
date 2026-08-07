/**
 * JWT signing and verification.
 *
 * We use Node's built-in `jsonwebtoken` equivalent via @fastify/jwt at the
 * route layer; here we expose thin helpers for tests and background workers
 * that don't run inside a Fastify request. The `kid` header lets us rotate
 * the signing key without instant invalidation of live tokens.
 *
 * Access token claims match the spec §4:
 *   sub, biz, role, branches, perms, sess, iat, exp
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../config/env.js";

// Access-token payload shape.
export interface AccessTokenClaims {
  sub: string;        // user id
  biz: string;        // active business id
  role: string;       // role key
  branches: number[]; // branch scope; [] = all
  perms: string[];
  sess: string;       // opaque session id
  iat: number;
  exp: number;
}

/**
 * A very small HS256 JWT implementation — Phase 0 only.
 *
 * We do this by hand because in dev we're using HS256 and jsonwebtoken adds
 * a whole surface we don't need for a health check. When Phase 1 introduces
 * RS256 for production, this file swaps out for @fastify/jwt inside route
 * handlers plus a `jose` implementation here for workers. Documented in the
 * roadmap; do not use this in production.
 */

function b64url(input: Buffer | string): string {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(input: string): Buffer {
  const pad = 4 - (input.length % 4);
  const padded = pad < 4 ? input + "=".repeat(pad) : input;
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export function signAccessToken(claims: Omit<AccessTokenClaims, "iat" | "exp">): string {
  if (env.JWT_ALGORITHM !== "HS256") {
    throw new Error("Only HS256 supported in Phase 0. RS256 lands with Phase 1 auth.");
  }
  const now = Math.floor(Date.now() / 1000);
  const full: AccessTokenClaims = {
    ...claims,
    iat: now,
    exp: now + env.ACCESS_TOKEN_TTL_SECONDS,
  };
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT", kid: env.JWT_KID }));
  const payload = b64url(JSON.stringify(full));
  const data = `${header}.${payload}`;
  const sig = b64url(createHmac("sha256", env.JWT_SECRET!).update(data).digest());
  return `${data}.${sig}`;
}

export function verifyAccessToken(token: string): AccessTokenClaims {
  if (env.JWT_ALGORITHM !== "HS256") {
    throw new Error("Only HS256 supported in Phase 0.");
  }
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed token.");
  const [h, p, s] = parts as [string, string, string];
  const expected = b64url(createHmac("sha256", env.JWT_SECRET!).update(`${h}.${p}`).digest());
  const sigBuf = Buffer.from(s);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    throw new Error("Bad signature.");
  }
  const claims = JSON.parse(b64urlDecode(p).toString("utf8")) as AccessTokenClaims;
  const now = Math.floor(Date.now() / 1000);
  if (claims.exp <= now) throw new Error("Expired.");
  return claims;
}
