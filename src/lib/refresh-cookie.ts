/**
 * Refresh cookie helpers.
 *
 * Refresh tokens live in an HttpOnly, Secure (in prod), SameSite=Lax cookie.
 * Only the /auth/refresh and /auth/logout endpoints read or write this
 * cookie — every other endpoint reads the Authorization header instead.
 *
 * Cookie name is prefixed `__Host-` in production to bind it to the exact
 * host and require Secure; localhost dev falls back to a plain name so it
 * can be sent over http.
 */

import type { FastifyReply } from "fastify";
import { env } from "../config/env.js";

export const REFRESH_COOKIE = env.isProd ? "__Host-trend_rt" : "trend_rt";

export function setRefreshCookie(reply: FastifyReply, raw: string): void {
  reply.setCookie(REFRESH_COOKIE, raw, {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: env.COOKIE_SAMESITE,
    path: "/",
    // __Host- prefix forbids the Domain attribute — omit it in production.
    domain: env.isProd ? undefined : env.COOKIE_DOMAIN,
    maxAge: env.REFRESH_TOKEN_TTL_SECONDS,
  });
}

export function clearRefreshCookie(reply: FastifyReply): void {
  reply.clearCookie(REFRESH_COOKIE, {
    path: "/",
    domain: env.isProd ? undefined : env.COOKIE_DOMAIN,
  });
}
