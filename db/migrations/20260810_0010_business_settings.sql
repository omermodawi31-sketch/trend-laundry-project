-- =============================================================================
-- 20260810_0010_business_settings.sql
--
-- Phase 6 — Business Settings & Branding.
--
-- ONE NEW TABLE, `businesses` LEFT UNTOUCHED.
-- ---------------------------------------------------------------------------
-- `businesses` (Phase 0) already carries 7 of the 9 requested "Business
-- information" fields: name, trade_licence_number, tax_registration_number,
-- currency, default_locale, timezone, country_code. Nothing has ever read or
-- written most of them past signup. Rather than ALTER that table (the
-- tenancy root, referenced everywhere RLS cares about) or move those columns
-- elsewhere, this migration adds exactly what doesn't exist yet — legal
-- name, VAT/express rates, branding, contact info — as a new table, 1:1 with
-- businesses via a UNIQUE business_id. The Settings module's service layer
-- (not this migration) is what presents both tables as one unified object;
-- physically they stay separate, matching how every other new capability in
-- this schema got its own table rather than being bolted onto an existing
-- one. See PHASE-6-REPORT.md for the full reasoning.
--
-- "ONE SETTINGS RECORD PER BUSINESS" AS AN ENFORCED INVARIANT
-- ---------------------------------------------------------------------------
-- UNIQUE(business_id) makes a second row impossible. The backfill INSERT at
-- the bottom of this file guarantees every business that already exists
-- gets exactly one row, with defaults matching today's hardcoded pricing
-- literals exactly (vat_pct=5.00, express_pct=50.00) — zero behaviour
-- change for any existing business. Every future signup gets its row
-- created in the same transaction as the business itself (see the matching
-- change in auth/service.ts), so the invariant never has a window where a
-- business exists without settings.
-- =============================================================================

CREATE TABLE business_settings (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id         bigint NOT NULL UNIQUE REFERENCES businesses(id) ON DELETE CASCADE,

  -- Business information (the two fields businesses.* doesn't already cover)
  legal_name          jsonb,

  -- Tax / pricing — the whole reason this phase exists. Defaults match the
  -- literals being deleted from orders/service.ts in this same phase.
  vat_enabled         boolean       NOT NULL DEFAULT true,
  vat_pct             numeric(5,2)  NOT NULL DEFAULT 5.00  CHECK (vat_pct >= 0 AND vat_pct <= 100),
  express_pct         numeric(5,2)  NOT NULL DEFAULT 50.00 CHECK (express_pct >= 0 AND express_pct <= 1000),

  -- Branding
  logo_url            text,
  favicon_url         text,
  primary_color       text CHECK (primary_color   IS NULL OR primary_color   ~ '^#[0-9A-Fa-f]{6}$'),
  secondary_color     text CHECK (secondary_color IS NULL OR secondary_color ~ '^#[0-9A-Fa-f]{6}$'),
  theme               text NOT NULL DEFAULT 'light' CHECK (theme IN ('light','dark')),
  receipt_header      jsonb,
  receipt_footer      jsonb,

  -- Contact information
  address             jsonb,
  phone               text,
  email               citext,
  website             text,
  social_links        jsonb,

  updated_by_user_id  bigint REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT business_settings_legal_name_shape CHECK (
    legal_name IS NULL OR jsonb_typeof(legal_name) = 'object'
  ),
  CONSTRAINT business_settings_receipt_header_shape CHECK (
    receipt_header IS NULL OR jsonb_typeof(receipt_header) = 'object'
  ),
  CONSTRAINT business_settings_receipt_footer_shape CHECK (
    receipt_footer IS NULL OR jsonb_typeof(receipt_footer) = 'object'
  ),
  CONSTRAINT business_settings_address_shape CHECK (
    address IS NULL OR jsonb_typeof(address) = 'object'
  ),
  CONSTRAINT business_settings_social_links_shape CHECK (
    social_links IS NULL OR jsonb_typeof(social_links) = 'object'
  )
);

CREATE TRIGGER business_settings_updated_at
  BEFORE UPDATE ON business_settings
  FOR EACH ROW EXECUTE FUNCTION trg_updated_at();

ALTER TABLE business_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON business_settings
  USING      (business_id = current_business_id())
  WITH CHECK (business_id = current_business_id());

-- Backfill — every business that exists before this migration gets exactly
-- one settings row, at the same defaults orders/service.ts's hardcoded
-- literals used to produce. Businesses created after this migration get
-- their row from the signup transaction instead (auth/service.ts); this
-- INSERT is a no-op for them if the migration runner ever re-orders, thanks
-- to ON CONFLICT DO NOTHING against the UNIQUE(business_id) constraint.
INSERT INTO business_settings (business_id)
SELECT id FROM businesses
ON CONFLICT (business_id) DO NOTHING;
