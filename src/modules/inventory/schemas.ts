/**
 * Inventory request validation.
 *
 * Same discipline as every other module: Zod at the boundary, `.strict()`
 * everywhere so an unexpected key (an attempted `business_id` override) is a
 * 422, not a silent drop. Quantities are `z.number()`, not integers — unlike
 * order line quantities (whole garments), inventory quantities are
 * frequently fractional (litres, kilograms).
 */

import { z } from "zod";

export const idParamSchema = z.object({
  id: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

export const branchIdParamSchema = z.object({
  branchId: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

/**
 * Scan code path parameter. Deliberately permissive on shape — barcodes and
 * SKUs come from many supplier formats (EAN-13 digits, alphanumeric internal
 * codes) and over-constraining this would reject legitimate codes. Length
 * capped to keep a hostile long string from doing anything expensive; the
 * lookup itself is a parameterised equality match, not a pattern search.
 */
export const codeParamSchema = z.object({
  code: z.string().trim().min(1).max(64),
});

export const bilingualSchema = z
  .object({
    en: z.string().trim().max(200).default(""),
    ar: z.string().trim().max(200).default(""),
  })
  .refine((v) => v.en.length > 0 || v.ar.length > 0, {
    message: "At least one of 'en' or 'ar' must be provided.",
  });

const unitSchema = z.enum(["L", "kg", "piece", "roll", "box"]);
const categorySchema = z.string().trim().min(1).max(40).regex(/^[a-z0-9_]+$/);

/**
 * Scan-code fields. `null` is a legitimate value (an item may not have a
 * code yet); an empty string is not — Zod normalises "" to null so the
 * partial-unique index at the database layer never sees a collision between
 * two blank strings.
 */
const skuSchema = z
  .string()
  .trim()
  .max(64)
  .nullable()
  .optional()
  .transform((v) => (v === "" || v === undefined ? null : v));

const barcodeSchema = z
  .string()
  .trim()
  .max(64)
  .nullable()
  .optional()
  .transform((v) => (v === "" || v === undefined ? null : v));

/* ---------------------------------------------------------------------- */
/*  Catalog                                                                */
/* ---------------------------------------------------------------------- */

export const createItemSchema = z
  .object({
    name: bilingualSchema,
    category: categorySchema,
    unit: unitSchema,
    sku: skuSchema,
    barcode: barcodeSchema,
    sort_order: z.number().int().min(0).max(9999).default(0),
    is_active: z.boolean().default(true),
  })
  .strict();

export const updateItemSchema = z
  .object({
    name: bilingualSchema.optional(),
    category: categorySchema.optional(),
    unit: unitSchema.optional(),
    sku: skuSchema,
    barcode: barcodeSchema,
    sort_order: z.number().int().min(0).max(9999).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "Provide at least one field to update." });

export const setActiveSchema = z
  .object({ is_active: z.boolean() })
  .strict();

export const listItemsQuerySchema = z
  .object({
    q: z.string().trim().max(200).optional(),
    is_active: z.coerce.boolean().optional(),
    category: categorySchema.optional(),
    deleted: z.enum(["exclude", "include", "only"]).default("exclude"),
    sort: z.enum(["sort_order", "name", "created_at"]).default("sort_order"),
    direction: z.enum(["asc", "desc"]).default("asc"),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().max(200).optional(),
  })
  .strict();

/* ---------------------------------------------------------------------- */
/*  Stock movements                                                        */
/* ---------------------------------------------------------------------- */

const quantitySchema = z.number().positive().max(999_999);

export const receiveSchema = z
  .object({
    item_id: z.number().int().positive(),
    quantity: quantitySchema,
    unit_cost: z.number().nonnegative().max(999_999).optional().nullable(),
    note: z.string().trim().max(500).optional().nullable(),
  })
  .strict();

export const wasteSchema = z
  .object({
    item_id: z.number().int().positive(),
    quantity: quantitySchema,
    reason: z.string().trim().min(1).max(200),
    note: z.string().trim().max(500).optional().nullable(),
  })
  .strict();

/**
 * Adjust is expressed as "what a stocktake counted", not as a signed delta.
 * The service computes `counted_quantity - current_on_hand` inside the same
 * transaction that reads current stock — asking the client to compute the
 * delta itself would mean trusting a number that can go stale between the
 * client reading stock and submitting the adjustment.
 */
export const adjustSchema = z
  .object({
    item_id: z.number().int().positive(),
    counted_quantity: z.number().nonnegative().max(999_999),
    note: z.string().trim().max(500).optional().nullable(),
  })
  .strict();

export const transferSchema = z
  .object({
    item_id: z.number().int().positive(),
    from_branch_id: z.number().int().positive(),
    to_branch_id: z.number().int().positive(),
    quantity: quantitySchema,
    note: z.string().trim().max(500).optional().nullable(),
  })
  .strict()
  .refine((v) => v.from_branch_id !== v.to_branch_id, {
    message: "from_branch_id and to_branch_id must be different.",
    path: ["to_branch_id"],
  });

export const listMovementsQuerySchema = z
  .object({
    item_id: z.coerce.number().int().positive().optional(),
    movement_type: z.enum(["receive", "waste", "adjust", "transfer_out", "transfer_in"]).optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    before: z.coerce.number().int().positive().optional(),
  })
  .strict();

export type CreateItemInput = z.infer<typeof createItemSchema>;
export type UpdateItemInput = z.infer<typeof updateItemSchema>;
export type SetActiveInput = z.infer<typeof setActiveSchema>;
export type ListItemsQueryInput = z.infer<typeof listItemsQuerySchema>;
export type ReceiveInput = z.infer<typeof receiveSchema>;
export type WasteInput = z.infer<typeof wasteSchema>;
export type AdjustInput = z.infer<typeof adjustSchema>;
export type TransferInput = z.infer<typeof transferSchema>;
export type ListMovementsQueryInput = z.infer<typeof listMovementsQuerySchema>;
