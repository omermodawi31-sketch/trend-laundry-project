/**
 * Business Settings repository.
 *
 * The only place in the codebase that issues SQL against `business_settings`
 * — and, for the small set of pre-existing fields this module also exposes
 * (name, trade licence, tax registration, currency, language, timezone), the
 * only place that updates those specific columns on `businesses` outside of
 * signup. Every function takes a `Transaction<Database>` supplied by
 * `withTenant(...)` — RLS is active on every query here.
 *
 * Two tables, two update functions, because they're genuinely different
 * rows with different constraints (`businesses` has no soft-delete, no
 * `updated_by_user_id`, and is written to by the auth module at signup;
 * `business_settings` is this module's own table end to end). The service
 * layer decides which one(s) a given PATCH touches and calls accordingly,
 * inside one transaction either way.
 */

import { sql, type Transaction } from "kysely";
import type { Database } from "../../lib/db.js";
import type { Bilingual } from "../../shared/types.js";
import type { SocialLinks } from "../../lib/db-schema.js";

/* ---------------------------------------------------------------------- */
/*  Types                                                                  */
/* ---------------------------------------------------------------------- */

export interface CombinedSettingsRow {
  business_id: number;
  name: Bilingual;
  legal_name: Bilingual | null;
  trade_licence_number: string | null;
  tax_registration_number: string | null;
  currency: string;
  language: string;
  timezone: string;

  vat_enabled: boolean;
  vat_pct: string;
  express_pct: string;
  delivery_fee: string;

  logo_url: string | null;
  favicon_url: string | null;
  primary_color: string | null;
  secondary_color: string | null;
  theme: "light" | "dark";
  receipt_header: Bilingual | null;
  receipt_footer: Bilingual | null;

  address: Bilingual | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  social_links: SocialLinks | null;

  updated_at: string;
}

const SETTINGS_COLUMNS = [
  "business_settings.legal_name",
  "business_settings.vat_enabled",
  "business_settings.vat_pct",
  "business_settings.express_pct",
  "business_settings.delivery_fee",
  "business_settings.logo_url",
  "business_settings.favicon_url",
  "business_settings.primary_color",
  "business_settings.secondary_color",
  "business_settings.theme",
  "business_settings.receipt_header",
  "business_settings.receipt_footer",
  "business_settings.address",
  "business_settings.phone",
  "business_settings.email",
  "business_settings.website",
  "business_settings.social_links",
  "business_settings.updated_at",
] as const;

/* ---------------------------------------------------------------------- */
/*  Reads                                                                  */
/* ---------------------------------------------------------------------- */

/**
 * The unified read. INNER JOIN, not LEFT — every business is guaranteed
 * exactly one `business_settings` row (migration backfill + signup hook +
 * UNIQUE(business_id)), so a missing row here would indicate a real data
 * integrity bug, not a normal "not configured yet" state. Failing loudly
 * (returning undefined, which the service turns into a 500-worthy error
 * rather than silently defaulting) is the correct behaviour if that
 * invariant is ever actually broken.
 */
export async function getCombined(
  trx: Transaction<Database>,
  businessId: number,
): Promise<CombinedSettingsRow | undefined> {
  const row = await trx
    .selectFrom("businesses")
    .innerJoin("business_settings", "business_settings.business_id", "businesses.id")
    .select([
      "businesses.id as business_id",
      "businesses.name as name",
      "businesses.trade_licence_number as trade_licence_number",
      "businesses.tax_registration_number as tax_registration_number",
      "businesses.currency as currency",
      "businesses.default_locale as language",
      "businesses.timezone as timezone",
      ...SETTINGS_COLUMNS,
    ])
    .where("businesses.id", "=", businessId)
    .executeTakeFirst();
  return row as CombinedSettingsRow | undefined;
}

/**
 * The narrow read orders/service.ts actually needs for pricing — kept
 * separate from `getCombined` (which lives here, in the settings module)
 * because that read belongs to the orders module's own repository, the same
 * cross-module-read-inside-one-RLS-transaction pattern already used twice
 * (branches reading orders for the historical-order guard, customers reading
 * orders for the unpaid-order guard). See orders/repository.ts.
 */

/* ---------------------------------------------------------------------- */
/*  Writes                                                                 */
/* ---------------------------------------------------------------------- */

export interface BusinessPatch {
  name?: Bilingual;
  trade_licence_number?: string | null;
  tax_registration_number?: string | null;
  currency?: string;
  default_locale?: string;
  timezone?: string;
}

/** Updates the small set of pre-existing `businesses` columns this module exposes. */
export async function updateBusiness(
  trx: Transaction<Database>,
  businessId: number,
  patch: BusinessPatch,
): Promise<void> {
  if (Object.keys(patch).length === 0) return;
  await trx
    .updateTable("businesses")
    .set({ ...patch, updated_at: sql`now()` as never } as never)
    .where("id", "=", businessId)
    .execute();
}

export interface SettingsPatch {
  legal_name?: Bilingual | null;
  vat_enabled?: boolean;
  vat_pct?: number;
  express_pct?: number;
  delivery_fee?: number;
  logo_url?: string | null;
  favicon_url?: string | null;
  primary_color?: string | null;
  secondary_color?: string | null;
  theme?: "light" | "dark";
  receipt_header?: Bilingual | null;
  receipt_footer?: Bilingual | null;
  address?: Bilingual | null;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  social_links?: SocialLinks | null;
  updated_by_user_id: number | null;
}

/** Updates `business_settings`. Explicit patch object, same discipline as every other module's update(). */
export async function updateSettings(
  trx: Transaction<Database>,
  businessId: number,
  patch: SettingsPatch,
): Promise<void> {
  await trx
    .updateTable("business_settings")
    .set(patch as never)
    .where("business_id", "=", businessId)
    .execute();
}

/** Used only by the migration-adjacent signup hook (auth/service.ts) — creates the one row a new business must have. */
export async function insertDefault(
  trx: Transaction<Database>,
  businessId: number,
): Promise<void> {
  await trx.insertInto("business_settings").values({ business_id: businessId }).execute();
}
