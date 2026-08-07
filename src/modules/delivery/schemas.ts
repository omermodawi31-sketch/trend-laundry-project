/**
 * Delivery request validation.
 *
 * Same discipline as every other module: `.strict()` throughout, rejecting
 * an attempted `business_id` override as a 422 rather than dropping it
 * silently.
 */

import { z } from "zod";

export const idParamSchema = z.object({
  id: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

export const orderIdParamSchema = z.object({
  orderId: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

export const branchIdParamSchema = z.object({
  branchId: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

export const bilingualOptionalSchema = z.object({
  en: z.string().trim().max(500).default(""),
  ar: z.string().trim().max(500).default(""),
});

const vehicleTypeSchema = z.enum(["bike", "car", "van"]);

/** Optional coordinates — "GPS is optional if location permission is unavailable" (final decision). */
const geoSchema = z
  .object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
  })
  .strict();

/* ---------------------------------------------------------------------- */
/*  Drivers                                                                 */
/* ---------------------------------------------------------------------- */

export const createDriverSchema = z
  .object({
    user_id: z.number().int().positive(),
    vehicle_type: vehicleTypeSchema.optional().nullable(),
    plate_number: z.string().trim().max(20).optional().nullable(),
    notes: z.string().trim().max(500).optional().nullable(),
  })
  .strict();

export const updateDriverSchema = z
  .object({
    vehicle_type: vehicleTypeSchema.optional().nullable(),
    plate_number: z.string().trim().max(20).optional().nullable(),
    notes: z.string().trim().max(500).optional().nullable(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "Provide at least one field to update." });

export const setDriverStatusSchema = z
  .object({
    status: z.enum(["available", "busy", "offline"]),
  })
  .strict();

export const listDriversQuerySchema = z
  .object({
    status: z.enum(["available", "busy", "offline"]).optional(),
    is_active: z.coerce.boolean().optional(),
    deleted: z.enum(["exclude", "include", "only"]).default("exclude"),
  })
  .strict();

/* ---------------------------------------------------------------------- */
/*  Jobs                                                                    */
/* ---------------------------------------------------------------------- */

export const createJobSchema = z
  .object({
    order_id: z.number().int().positive(),
    job_type: z.enum(["pickup", "delivery"]),
    address: bilingualOptionalSchema,
    scheduled_window_start: z.string().datetime().optional().nullable(),
    scheduled_window_end: z.string().datetime().optional().nullable(),
    collect_amount: z.number().nonnegative().max(999_999).optional().nullable(),
  })
  .strict()
  .refine(
    (v) => !v.scheduled_window_start || !v.scheduled_window_end || v.scheduled_window_start <= v.scheduled_window_end,
    { message: "scheduled_window_start must be before scheduled_window_end.", path: ["scheduled_window_end"] },
  );

export const updateJobSchema = z
  .object({
    address: bilingualOptionalSchema.optional(),
    scheduled_window_start: z.string().datetime().optional().nullable(),
    scheduled_window_end: z.string().datetime().optional().nullable(),
    collect_amount: z.number().nonnegative().max(999_999).optional().nullable(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "Provide at least one field to update." });

export const assignDriverSchema = z
  .object({
    driver_id: z.number().int().positive(),
  })
  .strict();

export const advanceJobStatusSchema = z
  .object({
    to: z.enum(["en_route", "arrived"]),
  })
  .strict();

export const completeJobSchema = z
  .object({
    collected_amount: z.number().nonnegative().max(999_999).optional().nullable(),
    proof_photo_url: z.string().trim().url().max(500).optional().nullable(),
    proof_signature_url: z.string().trim().url().max(500).optional().nullable(),
    geo: geoSchema.optional().nullable(),
  })
  .strict();

export const failJobSchema = z
  .object({
    reason: z.string().trim().min(1).max(500),
    geo: geoSchema.optional().nullable(),
  })
  .strict();

/** Mirrors failJobSchema — cancellation requires a reason too, matching orders' cancel_reason precedent. */
export const cancelJobSchema = z
  .object({
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

export const listJobsQuerySchema = z
  .object({
    status: z.enum(["scheduled", "assigned", "en_route", "arrived", "completed", "failed", "cancelled"]).optional(),
    job_type: z.enum(["pickup", "delivery"]).optional(),
    deleted: z.enum(["exclude", "include", "only"]).default("exclude"),
  })
  .strict();

export type CreateDriverInput = z.infer<typeof createDriverSchema>;
export type UpdateDriverInput = z.infer<typeof updateDriverSchema>;
export type SetDriverStatusInput = z.infer<typeof setDriverStatusSchema>;
export type ListDriversQueryInput = z.infer<typeof listDriversQuerySchema>;
export type CreateJobInput = z.infer<typeof createJobSchema>;
export type UpdateJobInput = z.infer<typeof updateJobSchema>;
export type AssignDriverInput = z.infer<typeof assignDriverSchema>;
export type AdvanceJobStatusInput = z.infer<typeof advanceJobStatusSchema>;
export type CompleteJobInput = z.infer<typeof completeJobSchema>;
export type FailJobInput = z.infer<typeof failJobSchema>;
export type CancelJobInput = z.infer<typeof cancelJobSchema>;
export type ListJobsQueryInput = z.infer<typeof listJobsQuerySchema>;
