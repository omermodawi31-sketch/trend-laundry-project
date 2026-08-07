/**
 * Branch request validation.
 *
 * Same discipline as customers and orders: Zod at the boundary, `.strict()`
 * everywhere so an unexpected key (an attempted `business_id` override, a
 * client-supplied `id`) is a 422, not a silent drop.
 */

import { z } from "zod";

export const idParamSchema = z.object({
  id: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

export const bilingualSchema = z
  .object({
    en: z.string().trim().max(200).default(""),
    ar: z.string().trim().max(200).default(""),
  })
  .refine((v) => v.en.length > 0 || v.ar.length > 0, {
    message: "At least one of 'en' or 'ar' must be provided.",
  });

export const bilingualOptionalSchema = z.object({
  en: z.string().trim().max(500).default(""),
  ar: z.string().trim().max(500).default(""),
});

/**
 * Branch code. Used verbatim inside order numbers (e.g. `AJM1-260803-004`),
 * so the character set is deliberately narrow — anything that would look
 * awkward or be ambiguous printed on an 80mm receipt is rejected here rather
 * than discovered later on a physical slip.
 */
export const branchCodeSchema = z
  .string()
  .trim()
  .min(2, "Branch code must be at least 2 characters.")
  .max(10, "Branch code must be at most 10 characters.")
  .regex(/^[A-Z0-9]+$/, "Use uppercase letters and digits only, e.g. AJM1.");

const phoneSchema = z
  .string()
  .trim()
  .min(7, "Phone number is too short.")
  .max(24, "Phone number is too long.")
  .regex(/^[+0-9][0-9\s\-()]*$/, "Phone number contains invalid characters.");

const hhmmSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use 24-hour HH:MM, e.g. 09:00.");

const workingHoursDaySchema = z
  .object({ open: hhmmSchema, close: hhmmSchema })
  .refine((v) => v.open < v.close, { message: "Opening time must be before closing time." })
  .nullable();

/**
 * Working hours: one optional entry per day, three-letter keys. `.strict()`
 * on the outer object rejects a typo'd day key (e.g. "sund") outright rather
 * than silently ignoring it — the same "unknown key is a 422" rule as
 * everywhere else, applied to a nested shape.
 */
export const workingHoursSchema = z
  .object({
    sun: workingHoursDaySchema.optional(),
    mon: workingHoursDaySchema.optional(),
    tue: workingHoursDaySchema.optional(),
    wed: workingHoursDaySchema.optional(),
    thu: workingHoursDaySchema.optional(),
    fri: workingHoursDaySchema.optional(),
    sat: workingHoursDaySchema.optional(),
  })
  .strict();

/** Both coordinates required together — mirrors the DB CHECK constraint so a partial pair fails fast, before the query. */
const geoSchema = z
  .object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
  })
  .strict();

export const createBranchSchema = z
  .object({
    name: bilingualSchema,
    code: branchCodeSchema,
    address: bilingualOptionalSchema,
    phone: phoneSchema.optional().nullable(),
    email: z.string().trim().email().max(200).optional().nullable(),
    maps_url: z.string().trim().url().max(500).optional().nullable(),
    geo: geoSchema.optional().nullable(),
    working_hours: workingHoursSchema.optional().nullable(),
    logo_url: z.string().trim().max(500).optional().nullable(),
    manager_user_id: z.number().int().positive().optional().nullable(),
    sort_order: z.number().int().min(0).max(9999).default(0),
    is_active: z.boolean().default(true),
  })
  .strict();

export const updateBranchSchema = z
  .object({
    name: bilingualSchema.optional(),
    code: branchCodeSchema.optional(),
    address: bilingualOptionalSchema.optional(),
    phone: phoneSchema.optional().nullable(),
    email: z.string().trim().email().max(200).optional().nullable(),
    maps_url: z.string().trim().url().max(500).optional().nullable(),
    geo: geoSchema.optional().nullable(),
    working_hours: workingHoursSchema.optional().nullable(),
    logo_url: z.string().trim().max(500).optional().nullable(),
    manager_user_id: z.number().int().positive().optional().nullable(),
    sort_order: z.number().int().min(0).max(9999).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "Provide at least one field to update." });

export const setActiveSchema = z
  .object({
    is_active: z.boolean(),
  })
  .strict();

export const listQuerySchema = z
  .object({
    q: z.string().trim().max(200).optional(),
    is_active: z.coerce.boolean().optional(),
    deleted: z.enum(["exclude", "include", "only"]).default("exclude"),
  })
  .strict();

export type CreateBranchInput = z.infer<typeof createBranchSchema>;
export type UpdateBranchInput = z.infer<typeof updateBranchSchema>;
export type SetActiveInput = z.infer<typeof setActiveSchema>;
export type ListQueryInput = z.infer<typeof listQuerySchema>;
