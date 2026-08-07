/**
 * Business Settings request validation.
 *
 * Same discipline as every other module: Zod at the boundary, `.strict()`
 * everywhere so an unexpected key (an attempted `business_id` override) is a
 * 422, not a silent drop. The PATCH schema is flat, matching every other
 * module's PATCH shape in this codebase (customers/branches/inventory) —
 * the GET response groups fields into readable sections for the client, but
 * that's a presentation choice made in the service layer, not a validation
 * shape; nothing here nests.
 */

import { z } from "zod";

export const bilingualSchema = z
  .object({
    en: z.string().trim().max(200).default(""),
    ar: z.string().trim().max(200).default(""),
  })
  .refine((v) => v.en.length > 0 || v.ar.length > 0, {
    message: "At least one of 'en' or 'ar' must be provided.",
  });

export const bilingualOptionalSchema = z.object({
  en: z.string().trim().max(1000).default(""),
  ar: z.string().trim().max(1000).default(""),
});

const hexColorSchema = z
  .string()
  .trim()
  .regex(/^#[0-9A-Fa-f]{6}$/, "Use a 6-digit hex color, e.g. #1A73E8.");

const urlSchema = z.string().trim().url().max(500);

const socialLinksSchema = z
  .object({
    instagram: urlSchema.optional(),
    facebook: urlSchema.optional(),
    twitter: urlSchema.optional(),
    tiktok: urlSchema.optional(),
    whatsapp: urlSchema.optional(),
    snapchat: urlSchema.optional(),
  })
  .strict();

const phoneSchema = z
  .string()
  .trim()
  .min(7, "Phone number is too short.")
  .max(24, "Phone number is too long.")
  .regex(/^[+0-9][0-9\s\-()]*$/, "Phone number contains invalid characters.");

/**
 * Currency: ISO 4217 three-letter code. Not restricted to a fixed list —
 * `businesses.currency` already has no CHECK constraint (single-currency-
 * per-business is the v1 constraint, not single-currency-across-the-
 * product), so validation here matches what the column already allows
 * rather than introducing a narrower rule than the schema enforces.
 */
const currencySchema = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, "Use a 3-letter ISO currency code, e.g. AED.");

/** Only en/ar exist anywhere in this bilingual-only system. */
const languageSchema = z.enum(["en", "ar"]);

/**
 * IANA timezone name. Not exhaustively validated against the tzdata list
 * (that list changes and duplicating it here would go stale) — checked for
 * plausible shape only; an invalid zone would surface loudly the first time
 * anything tries to use it (e.g. order-number date rollover), not silently.
 */
const timezoneSchema = z.string().trim().min(3).max(50).regex(/^[A-Za-z_]+\/[A-Za-z_]+$|^UTC$/, "Use an IANA timezone name, e.g. Asia/Dubai.");

export const updateSettingsSchema = z
  .object({
    // Business information
    name: bilingualSchema.optional(),
    legal_name: bilingualSchema.optional().nullable(),
    trade_licence_number: z.string().trim().max(100).optional().nullable(),
    tax_registration_number: z.string().trim().max(100).optional().nullable(),
    vat_enabled: z.boolean().optional(),
    vat_pct: z.number().min(0).max(100).optional(),
    express_pct: z.number().min(0).max(1000).optional(),
    delivery_fee: z.number().min(0).max(999_999).optional(),
    currency: currencySchema.optional(),
    language: languageSchema.optional(),
    timezone: timezoneSchema.optional(),

    // Branding
    logo_url: urlSchema.optional().nullable(),
    favicon_url: urlSchema.optional().nullable(),
    primary_color: hexColorSchema.optional().nullable(),
    secondary_color: hexColorSchema.optional().nullable(),
    theme: z.enum(["light", "dark"]).optional(),
    receipt_header: bilingualOptionalSchema.optional().nullable(),
    receipt_footer: bilingualOptionalSchema.optional().nullable(),

    // Contact information
    address: bilingualOptionalSchema.optional().nullable(),
    phone: phoneSchema.optional().nullable(),
    email: z.string().trim().email().max(200).optional().nullable(),
    website: urlSchema.optional().nullable(),
    social_links: socialLinksSchema.optional().nullable(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "Provide at least one field to update." });

export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;
