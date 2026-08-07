/**
 * JSON schemas for auth routes.
 *
 * Fastify validates every body against these before the handler runs.
 * A validation failure returns 422 automatically (see error-handler).
 *
 * These are the *shape* checks. Business rules (password strength, email
 * uniqueness, etc.) live in the service where they can talk to the DB.
 */

const bilingual = {
  type: "object",
  additionalProperties: false,
  properties: {
    en: { type: "string", minLength: 1, maxLength: 200 },
    ar: { type: "string", minLength: 1, maxLength: 200 },
  },
  anyOf: [{ required: ["en"] }, { required: ["ar"] }],
} as const;

const bilingualOptional = {
  type: "object",
  additionalProperties: false,
  properties: {
    en: { type: "string", maxLength: 200 },
    ar: { type: "string", maxLength: 200 },
  },
} as const;

export const signupSchema = {
  type: "object",
  additionalProperties: false,
  required: ["business", "owner", "branch"],
  properties: {
    business: {
      type: "object",
      additionalProperties: false,
      required: ["name"],
      properties: {
        name: bilingual,
        country_code: { type: "string", pattern: "^[A-Z]{2}$" },
        currency: { type: "string", pattern: "^[A-Z]{3}$" },
        default_locale: { type: "string", enum: ["en", "ar"] },
        timezone: { type: "string", maxLength: 64 },
      },
    },
    owner: {
      type: "object",
      additionalProperties: false,
      required: ["email", "full_name", "password"],
      properties: {
        email: { type: "string", format: "email", maxLength: 255 },
        full_name: { type: "string", minLength: 1, maxLength: 200 },
        password: { type: "string", minLength: 12, maxLength: 200 },
        preferred_locale: { type: "string", enum: ["en", "ar"] },
      },
    },
    branch: {
      type: "object",
      additionalProperties: false,
      required: ["name", "code", "address"],
      properties: {
        name: bilingual,
        code: { type: "string", minLength: 1, maxLength: 16, pattern: "^[A-Z0-9-]+$" },
        address: bilingualOptional,
        phone: { type: "string", maxLength: 40 },
      },
    },
  },
} as const;

export const loginSchema = {
  type: "object",
  additionalProperties: false,
  required: ["email", "password"],
  properties: {
    email: { type: "string", format: "email", maxLength: 255 },
    password: { type: "string", minLength: 1, maxLength: 200 },
    business_id: { type: "integer", minimum: 1 },
  },
} as const;

export const passwordResetRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["email"],
  properties: {
    email: { type: "string", format: "email", maxLength: 255 },
  },
} as const;

export const passwordResetConfirmSchema = {
  type: "object",
  additionalProperties: false,
  required: ["token", "new_password"],
  properties: {
    token: { type: "string", minLength: 20, maxLength: 200 },
    new_password: { type: "string", minLength: 12, maxLength: 200 },
  },
} as const;

export const emailVerifyConfirmSchema = {
  type: "object",
  additionalProperties: false,
  required: ["token"],
  properties: {
    token: { type: "string", minLength: 20, maxLength: 200 },
  },
} as const;

export const inviteSchema = {
  type: "object",
  additionalProperties: false,
  required: ["email", "role_key"],
  properties: {
    email: { type: "string", format: "email", maxLength: 255 },
    full_name: { type: "string", minLength: 1, maxLength: 200 },
    role_key: { type: "string", enum: ["manager", "cashier", "employee", "driver"] },
    branch_ids: {
      type: "array",
      items: { type: "integer", minimum: 1 },
      maxItems: 100,
      uniqueItems: true,
    },
  },
} as const;

export const acceptInviteSchema = {
  type: "object",
  additionalProperties: false,
  required: ["token", "password", "full_name"],
  properties: {
    token: { type: "string", minLength: 20, maxLength: 200 },
    password: { type: "string", minLength: 12, maxLength: 200 },
    full_name: { type: "string", minLength: 1, maxLength: 200 },
  },
} as const;
