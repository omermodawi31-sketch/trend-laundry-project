-- =============================================================================
-- 20260810_0005_customers.sql
--
-- The customers table plus its search infrastructure.
--
-- Design notes:
--
--   * Aggregates (spend, outstanding, orders_count) are NOT columns here.
--     They are derived from orders/payments once those tables exist (Phase 3).
--     Phase 2 exposes them as zeroes via a view so the API contract is stable
--     and Phase 3 only has to change the view body, not the endpoint.
--
--   * `status` replaces the frontend's separate `vip`/`active` booleans with
--     an explicit lifecycle: active | inactive | blocked. `vip` stays as a
--     separate flag because it is orthogonal — a VIP can be blocked.
--
--   * Search uses a generated tsvector column indexed with GIN. It combines
--     both language sides of `name`, both sides of `address`, the phone, and
--     tags — all passed through normalize_arabic() so "احمد" matches "أحمد".
--     Generated + stored means the index is always in sync; no trigger to
--     forget.
--
--   * Soft delete via `deleted_at`. Unique indexes are partial so a deleted
--     customer's phone can be reused by a new record.
-- =============================================================================

CREATE TABLE customers (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id           bigint NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  preferred_branch_id   bigint REFERENCES branches(id),

  -- Bilingual identity. At least one side must be non-empty.
  name                  jsonb  NOT NULL,
  address               jsonb,

  phone                 text   NOT NULL,
  whatsapp              text,
  email                 citext,

  photo_url             text,
  maps_url              text,
  emirates_id           text,
  tax_number            text,

  -- Lifecycle. Distinct from `vip`, which is orthogonal.
  status                text   NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','inactive','blocked')),
  status_reason         text,
  status_changed_at     timestamptz,

  vip                   boolean NOT NULL DEFAULT false,

  tags                  text[]  NOT NULL DEFAULT '{}'::text[],
  favourite_services    text[]  NOT NULL DEFAULT '{}'::text[],
  pickup_preference     text    NOT NULL DEFAULT 'none'
                        CHECK (pickup_preference IN ('morning','midday','evening','none')),

  preferred_locale      text    CHECK (preferred_locale IS NULL OR preferred_locale IN ('en','ar')),
  marketing_opt_in      boolean NOT NULL DEFAULT false,

  owner_employee_id     bigint,          -- FK added in Phase 9 when employees lands

  since                 date    NOT NULL DEFAULT CURRENT_DATE,

  created_by_user_id    bigint REFERENCES users(id),
  updated_by_user_id    bigint REFERENCES users(id),

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  deleted_at            timestamptz,
  deleted_by_user_id    bigint REFERENCES users(id),

  -- Bilingual shape enforcement: object with at least one non-empty side.
  CONSTRAINT customers_name_shape CHECK (
    jsonb_typeof(name) = 'object'
    AND (
      coalesce(name->>'en', '') <> ''
      OR coalesce(name->>'ar', '') <> ''
    )
  ),
  CONSTRAINT customers_address_shape CHECK (
    address IS NULL OR jsonb_typeof(address) = 'object'
  ),
  -- A blocked customer must carry a reason. Prevents silent blocking.
  CONSTRAINT customers_blocked_needs_reason CHECK (
    status <> 'blocked' OR coalesce(status_reason, '') <> ''
  )
);

-- ---------------------------------------------------------------------------
-- Search vector.
--
-- Generated column so it can never drift from the source data. Weighted:
--   A = name (both languages)      — highest relevance
--   B = phone / whatsapp           — exact-ish lookups
--   C = address (both languages)
--   D = tags
-- ---------------------------------------------------------------------------
ALTER TABLE customers
  ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple',
      normalize_arabic(coalesce(name->>'en','')) || ' ' ||
      normalize_arabic(coalesce(name->>'ar',''))
    ), 'A')
    ||
    setweight(to_tsvector('simple',
      coalesce(phone,'') || ' ' || coalesce(whatsapp,'')
    ), 'B')
    ||
    setweight(to_tsvector('simple',
      normalize_arabic(coalesce(address->>'en','')) || ' ' ||
      normalize_arabic(coalesce(address->>'ar',''))
    ), 'C')
    ||
    setweight(to_tsvector('simple',
      normalize_arabic(array_to_string(tags, ' '))
    ), 'D')
  ) STORED;

CREATE INDEX customers_search_idx
  ON customers USING GIN (search_vector)
  WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Operational indexes
-- ---------------------------------------------------------------------------

-- The counter's most common lookup: phone within a business.
CREATE INDEX customers_business_phone_idx
  ON customers (business_id, phone)
  WHERE deleted_at IS NULL;

-- One active customer per phone per business. Deleted rows are excluded so
-- a phone can be reused after a soft delete.
CREATE UNIQUE INDEX customers_business_phone_uniq
  ON customers (business_id, phone)
  WHERE deleted_at IS NULL;

-- List/paginate by recency. Cursor pagination orders on (created_at, id).
CREATE INDEX customers_business_created_idx
  ON customers (business_id, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;

-- Filter by status.
CREATE INDEX customers_business_status_idx
  ON customers (business_id, status)
  WHERE deleted_at IS NULL;

-- VIP filter.
CREATE INDEX customers_business_vip_idx
  ON customers (business_id)
  WHERE vip AND deleted_at IS NULL;

-- Restore/list-deleted view.
CREATE INDEX customers_business_deleted_idx
  ON customers (business_id, deleted_at DESC)
  WHERE deleted_at IS NOT NULL;

-- Tag containment queries.
CREATE INDEX customers_tags_idx
  ON customers USING GIN (tags)
  WHERE deleted_at IS NULL;

CREATE TRIGGER customers_updated_at
  BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION trg_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON customers
  USING      (business_id = current_business_id())
  WITH CHECK (business_id = current_business_id());

-- ---------------------------------------------------------------------------
-- customer_notes
--
-- Notes are a child table rather than a text column because:
--   * each note has an author and a timestamp (accountability)
--   * notes are append-mostly; editing history matters
--   * a "pinned" note (handling instructions) differs from a log entry
-- ---------------------------------------------------------------------------
CREATE TABLE customer_notes (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id         bigint NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_id         bigint NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  body                text   NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  pinned              boolean NOT NULL DEFAULT false,
  created_by_user_id  bigint REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz
);

CREATE INDEX customer_notes_customer_idx
  ON customer_notes (customer_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX customer_notes_pinned_idx
  ON customer_notes (customer_id)
  WHERE pinned AND deleted_at IS NULL;

CREATE TRIGGER customer_notes_updated_at
  BEFORE UPDATE ON customer_notes
  FOR EACH ROW EXECUTE FUNCTION trg_updated_at();

ALTER TABLE customer_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_notes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON customer_notes
  USING      (business_id = current_business_id())
  WITH CHECK (business_id = current_business_id());

-- ---------------------------------------------------------------------------
-- customer_stats view
--
-- Phase 2 has no orders table, so every aggregate is zero. The view exists
-- now so the API response shape is final: Phase 3 replaces the body with
-- real joins against orders/payments and no endpoint changes.
--
-- Deliberately a plain VIEW, not MATERIALIZED. At Phase 3 we reassess:
-- if list queries get slow, it becomes materialised with a refresh job.
-- Choosing materialised now would add a refresh dependency for data that
-- is currently constant.
-- ---------------------------------------------------------------------------
CREATE VIEW customer_stats AS
SELECT
  c.id                        AS customer_id,
  c.business_id               AS business_id,
  0::bigint                   AS orders_count,
  0::bigint                   AS completed_count,
  0::bigint                   AS cancelled_count,
  0::bigint                   AS pieces,
  0::numeric(12,2)            AS lifetime_spend,
  0::numeric(12,2)            AS lifetime_paid,
  0::numeric(12,2)            AS outstanding,
  0::bigint                   AS loyalty_points,
  NULL::timestamptz           AS last_visit_at,
  NULL::timestamptz           AS first_order_at
FROM customers c
WHERE c.deleted_at IS NULL;
