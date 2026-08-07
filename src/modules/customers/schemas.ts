/**
 * Customer request validation.
 *
 * Every request body, query string, and path parameter is parsed through one
 * of these schemas before a handler runs. Zod is used rather than raw Fastify
 * JSON schema because:
 *
 *   - We get a TypeScript type for free via z.infer, so handler code and
 *     validation cannot drift.
 *   - Refinements (e.g. "at least one language side must be non-empty",
 *     "blocked status requires a reason") are expressible; JSON Schema needs
 *     awkward oneOf/allOf gymnastics for the same rules.
 *
 * Validation is a security control, not a UX nicety. It is the boundary that
 * stops malformed or hostile input from reaching the query layer.
 * See OWASP-COMPLIANCE.md §A03.
 */

import { z } from "zod";

/* ---------------------------------------------------------------------- */
/*  Primitives                                                             */
/* ---------------------------------------------------------------------- */

/**
 * Bilingual field. At least one side must carry content — a customer with
 * neither an English nor an Arabic name is not a customer, it is a bug.
 */
export const bilingualSchema = z
  .object({
    en: z.string().trim().max(200).default(""),
    ar: z.string().trim().max(200).default(""),
  })
  .refine((v) => v.en.length > 0 || v.ar.length > 0, {
    message: "At least one of 'en' or 'ar' must be provided.",
  });

/** Optional bilingual — used for address, where empty is legitimate. */
export const bilingualOptionalSchema = z.object({
  en: z.string().trim().max(500).default(""),
  ar: z.string().trim().max(500).default(""),
});

/**
 * Phone. We accept what a UAE cashier types and normalise in the service.
 * The regex is permissive on purpose — over-strict phone validation rejects
 * legitimate numbers and pushes staff into entering junk to get past it.
 * Normalisation to E.164 happens in service.ts.
 */
export const phoneSchema = z
  .string()
  .trim()
  .min(7, "Phone number is too short.")
  .max(24, "Phone number is too long.")
  .regex(/^[+0-9][0-9\s\-()]*$/, "Phone number contains invalid characters.");

export const statusSchema = z.enum(["active", "inactive", "blocked"]);
export const pickupSchema = z.enum(["morning", "midday", "evening", "none"]);
export const localeSchema = z.enum(["en", "ar"]);

/**
 * Tags and service keys. Constrained character set so a tag cannot be used
 * to smuggle anything odd into a GIN query or a downstream template.
 */
const tokenSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[a-z0-9_]+$/, "Use lowercase letters, digits and underscores only.");

/** Positive integer path param. Rejects "1 OR 1=1", "-1", "1.5", "abc". */
export const idParamSchema = z.object({
  id: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

export const noteIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
  noteId: z.coerce.number().int().positive(),
});

/* ---------------------------------------------------------------------- */
/*  Create / update                                                        */
/* ---------------------------------------------------------------------- */

export const createCustomerSchema = z
  .object({
    name: bilingualSchema,
    phone: phoneSchema,
    whatsapp: phoneSchema.optional().nullable(),
    email: z.string().trim().email().max(200).optional().nullable(),
    address: bilingualOptionalSchema.optional().nullable(),
    maps_url: z.string().trim().url().max(500).optional().nullable(),
    emirates_id: z.string().trim().max(30).optional().nullable(),
    tax_number: z.string().trim().max(30).optional().nullable(),
    photo_url: z.string().trim().max(500).optional().nullable(),
    preferred_branch_id: z.number().int().positive().optional().nullable(),
    status: statusSchema.default("active"),
    status_reason: z.string().trim().max(500).optional().nullable(),
    vip: z.boolean().default(false),
    tags: z.array(tokenSchema).max(20).default([]),
    favourite_services: z.array(tokenSchema).max(20).default([]),
    pickup_preference: pickupSchema.default("none"),
    preferred_locale: localeSchema.optional().nullable(),
    marketing_opt_in: z.boolean().default(false),
    since: z.string().date().optional(),
    // First note, optional convenience so the counter can capture handling
    // instructions at creation without a second request.
    note: z.string().trim().max(2000).optional(),
  })
  .strict()   // reject unknown keys rather than silently dropping them
  .refine((v) => v.status !== "blocked" || (v.status_reason ?? "").trim().length > 0, {
    message: "A reason is required when blocking a customer.",
    path: ["status_reason"],
  });

export const updateCustomerSchema = z
  .object({
    name: bilingualSchema.optional(),
    phone: phoneSchema.optional(),
    whatsapp: phoneSchema.optional().nullable(),
    email: z.string().trim().email().max(200).optional().nullable(),
    address: bilingualOptionalSchema.optional().nullable(),
    maps_url: z.string().trim().url().max(500).optional().nullable(),
    emirates_id: z.string().trim().max(30).optional().nullable(),
    tax_number: z.string().trim().max(30).optional().nullable(),
    photo_url: z.string().trim().max(500).optional().nullable(),
    preferred_branch_id: z.number().int().positive().optional().nullable(),
    vip: z.boolean().optional(),
    tags: z.array(tokenSchema).max(20).optional(),
    favourite_services: z.array(tokenSchema).max(20).optional(),
    pickup_preference: pickupSchema.optional(),
    preferred_locale: localeSchema.optional().nullable(),
    marketing_opt_in: z.boolean().optional(),
    since: z.string().date().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, {
    message: "Provide at least one field to update.",
  });

/**
 * Status changes go through their own endpoint rather than PATCH.
 *
 * Rationale: blocking a customer is a business decision with a reason and an
 * audit trail, not a field edit. Separating it makes the permission check and
 * the audit action unambiguous.
 */
export const changeStatusSchema = z
  .object({
    status: statusSchema,
    reason: z.string().trim().max(500).optional(),
  })
  .strict()
  .refine((v) => v.status !== "blocked" || (v.reason ?? "").trim().length > 0, {
    message: "A reason is required when blocking a customer.",
    path: ["reason"],
  });

/* ---------------------------------------------------------------------- */
/*  Listing                                                                */
/* ---------------------------------------------------------------------- */

/**
 * List query.
 *
 * `limit` is capped at 100. Without a cap, a client can request the entire
 * customer table in one call — a denial-of-service vector and a data-exposure
 * risk if a token leaks.
 */
export const listQuerySchema = z
  .object({
    q: z.string().trim().max(200).optional(),
    status: statusSchema.optional(),
    vip: z.coerce.boolean().optional(),
    tags: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .transform((v) => {
        if (v === undefined) return undefined;
        const arr = Array.isArray(v) ? v : v.split(",");
        return arr.map((s) => s.trim()).filter(Boolean);
      })
      .pipe(z.array(tokenSchema).max(10).optional()),
    marketing_opt_in: z.coerce.boolean().optional(),
    deleted: z.enum(["exclude", "include", "only"]).default("exclude"),
    sort: z.enum(["created_at", "name", "phone", "last_visit"]).default("created_at"),
    direction: z.enum(["asc", "desc"]).default("desc"),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().max(200).optional(),
  })
  .strict();

export const activityQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    before: z.coerce.number().int().positive().optional(),
  })
  .strict();

/* ---------------------------------------------------------------------- */
/*  Notes                                                                  */
/* ---------------------------------------------------------------------- */

export const createNoteSchema = z
  .object({
    body: z.string().trim().min(1).max(2000),
    pinned: z.boolean().default(false),
  })
  .strict();

/* ---------------------------------------------------------------------- */
/*  Inferred types                                                         */
/* ---------------------------------------------------------------------- */

export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;
export type ChangeStatusInput = z.infer<typeof changeStatusSchema>;
export type ListQueryInput = z.infer<typeof listQuerySchema>;
export type ActivityQueryInput = z.infer<typeof activityQuerySchema>;
export type CreateNoteInput = z.infer<typeof createNoteSchema>;
