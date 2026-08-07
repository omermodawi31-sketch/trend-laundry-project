/**
 * Order request validation.
 *
 * Same discipline as the customers module: Zod at the boundary, `.strict()`
 * everywhere so an unexpected key is a 422 rather than a silent drop.
 *
 * Note what is NOT accepted from the client: `total`, `subtotal`, `vat_amount`
 * and every other money field. The server prices the order. A client that can
 * name its own total can buy laundry for one fils.
 */

import { z } from "zod";
import { ORDER_STATUSES } from "./transitions.js";

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

/* ---------------------------------------------------------------------- */
/*  Services catalogue                                                     */
/* ---------------------------------------------------------------------- */

export const createServiceSchema = z
  .object({
    name: bilingualSchema,
    category: z.string().trim().min(1).max(40).regex(/^[a-z0-9_]+$/),
    service_type: z.enum(["wash", "press", "washpress", "drycl"]),
    sort_order: z.number().int().min(0).max(9999).default(0),
    variants: z
      .array(
        z.object({
          size: z.string().trim().max(10).optional().nullable(),
          unit_price: z.number().nonnegative().max(999_999),
          express_multiplier: z.number().min(1).max(10).default(1.5),
        }),
      )
      .min(1, "A service needs at least one priced variant.")
      .max(20),
  })
  .strict();

export const updateServiceSchema = z
  .object({
    name: bilingualSchema.optional(),
    category: z.string().trim().min(1).max(40).regex(/^[a-z0-9_]+$/).optional(),
    is_active: z.boolean().optional(),
    sort_order: z.number().int().min(0).max(9999).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "Provide at least one field." });

export const updateVariantSchema = z
  .object({
    unit_price: z.number().nonnegative().max(999_999).optional(),
    express_multiplier: z.number().min(1).max(10).optional(),
    is_active: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "Provide at least one field." });

/* ---------------------------------------------------------------------- */
/*  Orders                                                                 */
/* ---------------------------------------------------------------------- */

const orderLineSchema = z.object({
  service_variant_id: z.number().int().positive(),
  qty: z.number().int().min(1).max(9999),
});

export const createOrderSchema = z
  .object({
    // Branch triple. Intake is mandatory; the other two default to intake.
    intake_branch_id: z.number().int().positive(),
    processing_branch_id: z.number().int().positive().optional().nullable(),
    collection_branch_id: z.number().int().positive().optional().nullable(),

    customer_id: z.number().int().positive().optional().nullable(),
    // Walk-in orders carry no customer record; a name and phone are then
    // required so the receipt and the pickup call still work.
    walk_in: z
      .object({
        name: bilingualSchema,
        phone: z.string().trim().min(7).max(24),
      })
      .optional(),

    lines: z.array(orderLineSchema).min(1, "An order needs at least one line.").max(200),

    express: z.boolean().default(false),
    delivery: z.boolean().default(false),
    discount_pct: z.number().min(0).max(100).default(0),
    discount_reason: z.string().trim().max(200).optional().nullable(),

    notes: z.string().trim().max(2000).optional().nullable(),
    stain_notes: z.string().trim().max(2000).optional().nullable(),
    damage_notes: z.string().trim().max(2000).optional().nullable(),

    due_at: z.string().datetime().optional().nullable(),

    initial_payment: z
      .object({
        amount: z.number().positive().max(999_999),
        method: z.enum(["cash", "card", "bank_transfer", "wallet", "credit"]),
        reference: z.string().trim().max(100).optional().nullable(),
      })
      .optional(),
  })
  .strict()
  .refine((v) => v.customer_id != null || v.walk_in != null, {
    message: "Provide either customer_id or walk_in details.",
    path: ["customer_id"],
  })
  .refine((v) => v.discount_pct === 0 || (v.discount_reason ?? "").trim().length > 0, {
    message: "A reason is required when applying a discount.",
    path: ["discount_reason"],
  });

/** Line edits are only legal in early statuses; the service enforces that. */
export const updateOrderLinesSchema = z
  .object({
    lines: z.array(orderLineSchema).min(1).max(200),
    express: z.boolean().optional(),
    delivery: z.boolean().optional(),
    discount_pct: z.number().min(0).max(100).optional(),
    discount_reason: z.string().trim().max(200).optional().nullable(),
  })
  .strict();

export const updateOrderMetaSchema = z
  .object({
    notes: z.string().trim().max(2000).optional().nullable(),
    stain_notes: z.string().trim().max(2000).optional().nullable(),
    damage_notes: z.string().trim().max(2000).optional().nullable(),
    due_at: z.string().datetime().optional().nullable(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "Provide at least one field." });

export const changeOrderStatusSchema = z
  .object({
    to: z.enum(ORDER_STATUSES),
    note: z.string().trim().max(500).optional(),
    reason: z.string().trim().max(500).optional(),
  })
  .strict();

export const recordPaymentSchema = z
  .object({
    amount: z.number().positive().max(999_999),
    method: z.enum(["cash", "card", "bank_transfer", "wallet", "credit"]),
    reference: z.string().trim().max(100).optional().nullable(),
  })
  .strict();

export const refundSchema = z
  .object({
    payment_id: z.number().int().positive(),
    amount: z.number().positive().max(999_999),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

export const listOrdersQuerySchema = z
  .object({
    q: z.string().trim().max(200).optional(),
    status: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .transform((v) => {
        if (v === undefined) return undefined;
        const arr = Array.isArray(v) ? v : v.split(",");
        return arr.map((s) => s.trim()).filter(Boolean);
      })
      .pipe(z.array(z.enum(ORDER_STATUSES)).max(11).optional()),
    branch_id: z.coerce.number().int().positive().optional(),
    customer_id: z.coerce.number().int().positive().optional(),
    express: z.coerce.boolean().optional(),
    unpaid: z.coerce.boolean().optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().max(200).optional(),
    direction: z.enum(["asc", "desc"]).default("desc"),
  })
  .strict();

export type CreateServiceInput = z.infer<typeof createServiceSchema>;
export type UpdateServiceInput = z.infer<typeof updateServiceSchema>;
export type UpdateVariantInput = z.infer<typeof updateVariantSchema>;
export type CreateOrderInput = z.infer<typeof createOrderSchema>;
export type UpdateOrderLinesInput = z.infer<typeof updateOrderLinesSchema>;
export type UpdateOrderMetaInput = z.infer<typeof updateOrderMetaSchema>;
export type ChangeOrderStatusInput = z.infer<typeof changeOrderStatusSchema>;
export type RecordPaymentInput = z.infer<typeof recordPaymentSchema>;
export type RefundInput = z.infer<typeof refundSchema>;
export type ListOrdersQueryInput = z.infer<typeof listOrdersQuerySchema>;
