/**
 * Shared cross-module types. Anything imported by 2+ modules lives here.
 * Anything module-specific should not.
 */

export type Bilingual = { en: string; ar: string };

/** ISO 8601 datetime string in UTC. Postgres returns these from timestamptz columns. */
export type ISODateTime = string;

/** ISO date without time. */
export type ISODate = string;

/** Currency code, ISO 4217 (e.g. "AED"). */
export type Currency = string;

/** Locale code the frontend understands. Extend when new languages ship. */
export type Locale = "en" | "ar";

/** Membership context attached to every authenticated request. */
export interface AuthContext {
  userId: number;
  businessId: number;
  roleKey: string;
  permissions: string[];
  branchIds: number[]; // empty = all branches
  sessionId: string;
  email: string;
}
