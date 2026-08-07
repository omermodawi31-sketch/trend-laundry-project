/**
 * Authentication middleware.
 *
 * Attaches `request.auth: AuthContext | null` after extracting and verifying
 * the bearer JWT. Two decorators:
 *
 *   - `authenticate`: requires a valid access token. Returns 401 otherwise.
 *   - `authenticateOptional`: attaches auth if present, does not require it.
 *     Used only for endpoints that behave differently for anonymous users.
 *
 * Security notes:
 *   - The active business, role, permissions and branches all come from
 *     the JWT claims — never from a request header or body.
 *   - Token verification is `timingSafeEqual` inside `verifyAccessToken()`.
 *   - Bearer scheme is enforced (`Bearer <token>` prefix). Any other scheme
 *     yields 401 with a clear code — no ambiguity.
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import { verifyAccessToken, type AccessTokenClaims } from "../lib/jwt.js";
import { Errors } from "../lib/errors.js";
import type { AuthContext } from "../shared/types.js";

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

function extractBearer(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header || typeof header !== "string") return null;
  const match = header.match(/^Bearer (.+)$/);
  return match ? match[1]! : null;
}

function claimsToContext(c: AccessTokenClaims): AuthContext {
  return {
    userId: Number(c.sub),
    businessId: Number(c.biz),
    roleKey: c.role,
    permissions: c.perms,
    branchIds: c.branches,
    sessionId: c.sess,
    email: "",   // filled by /me endpoint via DB lookup when needed
  };
}

export async function authenticate(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const token = extractBearer(request);
  if (!token) throw Errors.unauthenticated();
  let claims: AccessTokenClaims;
  try {
    claims = verifyAccessToken(token);
  } catch {
    throw Errors.unauthenticated();
  }
  request.auth = claimsToContext(claims);
}

export async function authenticateOptional(request: FastifyRequest): Promise<void> {
  const token = extractBearer(request);
  if (!token) return;
  try {
    request.auth = claimsToContext(verifyAccessToken(token));
  } catch {
    // Silently ignore — treat as anonymous.
  }
}
