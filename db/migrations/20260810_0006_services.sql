-- =============================================================================
-- 20260810_0006_services.sql
--
-- The price catalogue. Services and their sized variants.
--
-- Why two tables rather than one:
--   "Shirt / press" is one service; its price differs by size (S/M/L). Putting
--   price on the service would force a row per size with duplicated names,
--   and renaming "Shirt" would then be three updates instead of one.
--
-- Prices live on variants. An order line snapshots the price at the time it
-- was taken, so later catalogue edits never rewrite history.
-- =============================================================================

CREATE TABLE services (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id    bigint NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name           jsonb  NOT NULL,
  category       text   NOT NULL,
  service_type   text   NOT NULL
                 CHECK (service_type IN ('wash','press','washpress','drycl')),
  is_active      boolean NOT NULL DEFAULT true,
  sort_order     int     NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,

  CONSTRAINT services_name_shape CHECK (
    jsonb_typeof(name) = 'object'
    AND (coalesce(name->>'en','') <> '' OR coalesce(name->>'ar','') <> '')
  )
);

CREATE INDEX services_business_idx
  ON services (business_id, sort_order, id)
  WHERE deleted_at IS NULL;

CREATE TRIGGER services_updated_at
  BEFORE UPDATE ON services
  FOR EACH ROW EXECUTE FUNCTION trg_updated_at();

ALTER TABLE services ENABLE ROW LEVEL SECURITY;
ALTER TABLE services FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON services
  USING      (business_id = current_business_id())
  WITH CHECK (business_id = current_business_id());

-- ---------------------------------------------------------------------------
CREATE TABLE service_variants (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id          bigint NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  service_id           bigint NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  size                 text,
  unit_price           numeric(12,2) NOT NULL CHECK (unit_price >= 0),
  express_multiplier   numeric(4,2)  NOT NULL DEFAULT 1.50
                       CHECK (express_multiplier >= 1),
  is_active            boolean NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  deleted_at           timestamptz
);

-- One variant per (service, size). NULL size is "no sizing" — the COALESCE
-- makes NULL participate in uniqueness, which a plain unique index would not.
CREATE UNIQUE INDEX service_variants_uniq
  ON service_variants (service_id, COALESCE(size, ''))
  WHERE deleted_at IS NULL;

CREATE INDEX service_variants_service_idx
  ON service_variants (service_id)
  WHERE deleted_at IS NULL;

CREATE TRIGGER service_variants_updated_at
  BEFORE UPDATE ON service_variants
  FOR EACH ROW EXECUTE FUNCTION trg_updated_at();

ALTER TABLE service_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_variants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON service_variants
  USING      (business_id = current_business_id())
  WITH CHECK (business_id = current_business_id());
