/**
 * Business Settings service.
 *
 * The single source of truth for business configuration, delivered as one
 * unified object even though it's physically stored across two tables
 * (`businesses`, pre-existing since Phase 0; `business_settings`, new this
 * phase). `getSettings`/`updateSettings` are the only two operations this
 * singleton resource needs — there's no create (a row always exists, from
 * signup or the migration backfill) and no delete (settings don't get
 * "deleted," only edited).
 *
 * Every mutation writes one audit row per call, diffed against the combined
 * before/after view regardless of which underlying table(s) actually
 * changed — the caller doesn't need to know or care that "currency" lives on
 * `businesses` while "vat_pct" lives on `business_settings`.
 */

import { withTenant } from "../../lib/db.js";
import { auditInTx, actorFromAuth } from "../../lib/audit.js";
import { Errors } from "../../lib/errors.js";
import type { AuthContext, Bilingual } from "../../shared/types.js";
import * as repo from "./repository.js";
import type { UpdateSettingsInput } from "./schemas.js";

export interface RequestMeta {
  ipAddress: string | null;
  userAgent: string | null;
}

/* ---------------------------------------------------------------------- */
/*  Serialisation                                                          */
/* ---------------------------------------------------------------------- */

function n(v: string): number {
  return Number(v);
}

export function serialiseSettings(row: repo.CombinedSettingsRow) {
  return {
    // Business information
    name: row.name,
    legal_name: row.legal_name,
    trade_licence_number: row.trade_licence_number,
    tax_registration_number: row.tax_registration_number,
    vat_enabled: row.vat_enabled,
    vat_pct: n(row.vat_pct),
    express_pct: n(row.express_pct),
    delivery_fee: n(row.delivery_fee),
    currency: row.currency,
    language: row.language,
    timezone: row.timezone,

    // Branding
    logo_url: row.logo_url,
    favicon_url: row.favicon_url,
    primary_color: row.primary_color,
    secondary_color: row.secondary_color,
    theme: row.theme,
    receipt_header: row.receipt_header,
    receipt_footer: row.receipt_footer,

    // Contact information
    address: row.address,
    phone: row.phone,
    email: row.email,
    website: row.website,
    social_links: row.social_links,

    updated_at: row.updated_at,
  };
}

const AUDITED_FIELDS = [
  "name", "legal_name", "trade_licence_number", "tax_registration_number",
  "vat_enabled", "vat_pct", "express_pct", "delivery_fee", "currency", "language", "timezone",
  "logo_url", "favicon_url", "primary_color", "secondary_color", "theme",
  "receipt_header", "receipt_footer", "address", "phone", "email", "website",
  "social_links",
] as const;

function auditDiff(before: ReturnType<typeof serialiseSettings>, after: ReturnType<typeof serialiseSettings>) {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const f of AUDITED_FIELDS) {
    const bv = JSON.stringify(before[f]);
    const av = JSON.stringify(after[f]);
    if (bv !== av) { b[f] = before[f]; a[f] = after[f]; }
  }
  return { before: b, after: a };
}

/* ---------------------------------------------------------------------- */
/*  Queries                                                                 */
/* ---------------------------------------------------------------------- */

export async function getSettings(auth: AuthContext) {
  return withTenant({ businessId: auth.businessId, userId: auth.userId }, async (trx) => {
    const row = await repo.getCombined(trx, auth.businessId);
    if (!row) {
      // Should be unreachable — see repository.ts's getCombined header
      // comment. Surfacing loudly rather than silently defaulting if the
      // one-row-per-business invariant is ever actually broken.
      throw new Error(`business_settings invariant broken: no row for business ${auth.businessId}`);
    }
    return serialiseSettings(row);
  });
}

/* ---------------------------------------------------------------------- */
/*  Commands                                                                */
/* ---------------------------------------------------------------------- */

export async function updateSettings(auth: AuthContext, input: UpdateSettingsInput, meta: RequestMeta) {
  return withTenant({ businessId: auth.businessId, userId: auth.userId }, async (trx) => {
    const beforeRow = await repo.getCombined(trx, auth.businessId);
    if (!beforeRow) {
      throw new Error(`business_settings invariant broken: no row for business ${auth.businessId}`);
    }
    const before = serialiseSettings(beforeRow);

    // Route each field to the table it actually lives on. Both patches are
    // built from the same flat input; only the fields present in the
    // request populate either patch, so an omitted field never triggers a
    // write to either table.
    const businessPatch: repo.BusinessPatch = {};
    if (input.name !== undefined) businessPatch.name = normaliseBilingual(input.name);
    if (input.trade_licence_number !== undefined) businessPatch.trade_licence_number = input.trade_licence_number;
    if (input.tax_registration_number !== undefined) businessPatch.tax_registration_number = input.tax_registration_number;
    if (input.currency !== undefined) businessPatch.currency = input.currency;
    if (input.language !== undefined) businessPatch.default_locale = input.language;
    if (input.timezone !== undefined) businessPatch.timezone = input.timezone;

    const settingsPatch: repo.SettingsPatch = { updated_by_user_id: auth.userId };
    if (input.legal_name !== undefined) settingsPatch.legal_name = input.legal_name ? normaliseBilingual(input.legal_name) : null;
    if (input.vat_enabled !== undefined) settingsPatch.vat_enabled = input.vat_enabled;
    if (input.vat_pct !== undefined) settingsPatch.vat_pct = input.vat_pct;
    if (input.express_pct !== undefined) settingsPatch.express_pct = input.express_pct;
    if (input.delivery_fee !== undefined) settingsPatch.delivery_fee = input.delivery_fee;
    if (input.logo_url !== undefined) settingsPatch.logo_url = input.logo_url;
    if (input.favicon_url !== undefined) settingsPatch.favicon_url = input.favicon_url;
    if (input.primary_color !== undefined) settingsPatch.primary_color = input.primary_color;
    if (input.secondary_color !== undefined) settingsPatch.secondary_color = input.secondary_color;
    if (input.theme !== undefined) settingsPatch.theme = input.theme;
    if (input.receipt_header !== undefined) settingsPatch.receipt_header = input.receipt_header ? normaliseBilingual(input.receipt_header) : null;
    if (input.receipt_footer !== undefined) settingsPatch.receipt_footer = input.receipt_footer ? normaliseBilingual(input.receipt_footer) : null;
    if (input.address !== undefined) settingsPatch.address = input.address ? normaliseBilingual(input.address) : null;
    if (input.phone !== undefined) settingsPatch.phone = input.phone;
    if (input.email !== undefined) settingsPatch.email = input.email;
    if (input.website !== undefined) settingsPatch.website = input.website;
    if (input.social_links !== undefined) settingsPatch.social_links = input.social_links;

    if (Object.keys(businessPatch).length > 0) {
      await repo.updateBusiness(trx, auth.businessId, businessPatch);
    }
    // settingsPatch always has at least updated_by_user_id; only issue the
    // write if a real field changed, mirroring the no-op-write discipline
    // used everywhere else (a PATCH that only touched businesses fields
    // shouldn't also bump business_settings.updated_at for no reason).
    if (Object.keys(settingsPatch).length > 1) {
      await repo.updateSettings(trx, auth.businessId, settingsPatch);
    }

    const afterRow = await repo.getCombined(trx, auth.businessId);
    if (!afterRow) throw new Error(`business_settings invariant broken: no row for business ${auth.businessId}`);
    const after = serialiseSettings(afterRow);

    const diff = auditDiff(before, after);
    if (Object.keys(diff.after).length > 0) {
      await auditInTx(trx, actorFromAuth(auth, meta.ipAddress, meta.userAgent), {
        action: "business_settings.update",
        resourceType: "business_settings",
        resourceId: auth.businessId,
        before: diff.before,
        after: diff.after,
      });
    }

    return after;
  });
}

function normaliseBilingual(input: { en: string; ar: string }): Bilingual {
  return { en: (input.en ?? "").trim(), ar: (input.ar ?? "").trim() };
}
