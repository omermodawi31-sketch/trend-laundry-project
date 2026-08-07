-- =============================================================================
-- 20260810_0007_orders.sql
--
-- Orders, lines, payments, status history, photos, plus the two numbering
-- sequences.
--
-- BRANCH MODEL (approved architecture)
-- ------------------------------------
--   intake_branch_id      NOT NULL  — where the customer handed the garments over
--   processing_branch_id  NULL      — where the work happens; NULL = same as intake
--   collection_branch_id  NULL      — where the customer collects; NULL = same as intake
--
-- NULL-means-same keeps single-shop businesses free of any complexity: one
-- branch, two NULLs. Hub-and-spoke chains populate what they need.
--
-- Read authorization is OR across all three columns (application layer, not
-- RLS). A plant manager must see orders they are processing even though the
-- intake happened elsewhere.
--
-- NUMBERING
-- ---------
--   order_number   branch-scoped, per-branch daily sequence: AJM1-260803-004
--   invoice_number business-scoped, gapless per tax registrant: TL-INV-2026-000412
--
-- These follow different rules deliberately. UAE FTA requires a gapless
-- sequence per registrant (the business), while an order number is an
-- operational label the counter reads aloud. Conflating them is expensive to
-- discover at filing time.
-- =============================================================================

CREATE TABLE orders (
  id                       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id              bigint NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,

  -- Branch model. See header.
  intake_branch_id         bigint NOT NULL REFERENCES branches(id),
  processing_branch_id     bigint REFERENCES branches(id),
  collection_branch_id     bigint REFERENCES branches(id),

  order_number             text   NOT NULL,
  invoice_number           text,

  customer_id              bigint REFERENCES customers(id),
  -- Denormalised snapshot: an order stays readable even if the customer is
  -- deleted, and a reprint shows the name as it was at the time.
  customer_name_snapshot   jsonb  NOT NULL,
  customer_phone_snapshot  text   NOT NULL,

  status                   text   NOT NULL DEFAULT 'received'
                           CHECK (status IN (
                             'received','sorting','washing','drycleaning',
                             'ironing','packing','ready','out_for_delivery',
                             'delivered','cancelled','lost'
                           )),

  pieces                   int           NOT NULL DEFAULT 0 CHECK (pieces >= 0),
  subtotal                 numeric(12,2) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),

  express                  boolean       NOT NULL DEFAULT false,
  express_pct              numeric(5,2)  NOT NULL DEFAULT 0 CHECK (express_pct >= 0),
  express_amount           numeric(12,2) NOT NULL DEFAULT 0 CHECK (express_amount >= 0),

  delivery                 boolean       NOT NULL DEFAULT false,
  delivery_amount          numeric(12,2) NOT NULL DEFAULT 0 CHECK (delivery_amount >= 0),

  discount_pct             numeric(5,2)  NOT NULL DEFAULT 0
                           CHECK (discount_pct >= 0 AND discount_pct <= 100),
  discount_amount          numeric(12,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  discount_reason          text,

  vat_pct                  numeric(5,2)  NOT NULL DEFAULT 0 CHECK (vat_pct >= 0),
  vat_amount               numeric(12,2) NOT NULL DEFAULT 0 CHECK (vat_amount >= 0),

  total                    numeric(12,2) NOT NULL DEFAULT 0 CHECK (total >= 0),
  -- Cached sum of payments. Kept consistent inside the same transaction as
  -- every payment insert; `payments` remains the source of truth.
  paid_amount              numeric(12,2) NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),

  notes                    text,
  stain_notes              text,
  damage_notes             text,

  -- Who took the order. Nullable because employees land in Phase 9; the
  -- column exists now so historical orders accumulate the attribution.
  taken_by_employee_id     bigint,
  taken_by_user_id         bigint REFERENCES users(id),

  due_at                   timestamptz,
  delivered_at             timestamptz,
  cancelled_at             timestamptz,
  cancel_reason            text,

  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  deleted_at               timestamptz,

  CONSTRAINT orders_customer_name_shape CHECK (
    jsonb_typeof(customer_name_snapshot) = 'object'
    AND (coalesce(customer_name_snapshot->>'en','') <> ''
      OR coalesce(customer_name_snapshot->>'ar','') <> '')
  ),
  -- A cancelled order must say why. Same discipline as blocking a customer.
  CONSTRAINT orders_cancel_needs_reason CHECK (
    status NOT IN ('cancelled','lost') OR coalesce(cancel_reason,'') <> ''
  ),
  -- Overpayment is refused at the application layer; this is the backstop.
  CONSTRAINT orders_paid_not_exceeding_total CHECK (paid_amount <= total + 0.01)
);

CREATE UNIQUE INDEX orders_business_number_uniq
  ON orders (business_id, order_number);

CREATE UNIQUE INDEX orders_business_invoice_uniq
  ON orders (business_id, invoice_number)
  WHERE invoice_number IS NOT NULL;

-- Primary list query: a branch's orders, newest first. Keyset pagination.
CREATE INDEX orders_intake_created_idx
  ON orders (business_id, intake_branch_id, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;

-- The OR-across-three-branches read filter needs each column indexed
-- separately; Postgres can BitmapOr them.
CREATE INDEX orders_processing_branch_idx
  ON orders (business_id, processing_branch_id)
  WHERE deleted_at IS NULL AND processing_branch_id IS NOT NULL;

CREATE INDEX orders_collection_branch_idx
  ON orders (business_id, collection_branch_id)
  WHERE deleted_at IS NULL AND collection_branch_id IS NOT NULL;

CREATE INDEX orders_business_status_idx
  ON orders (business_id, status, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX orders_customer_idx
  ON orders (customer_id, created_at DESC)
  WHERE deleted_at IS NULL;

-- Outstanding-balance queries (customer stats, debtor lists).
CREATE INDEX orders_outstanding_idx
  ON orders (business_id, customer_id)
  WHERE deleted_at IS NULL
    AND status NOT IN ('cancelled','lost')
    AND paid_amount < total;

CREATE INDEX orders_created_idx
  ON orders (business_id, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;

CREATE TRIGGER orders_updated_at
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION trg_updated_at();

ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON orders
  USING      (business_id = current_business_id())
  WITH CHECK (business_id = current_business_id());

-- ---------------------------------------------------------------------------
-- Order lines. Every descriptive field is snapshotted so a reprint months
-- later shows what was actually sold, not what the catalogue says today.
-- ---------------------------------------------------------------------------
CREATE TABLE order_lines (
  id                     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id            bigint NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  order_id               bigint NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  service_variant_id     bigint REFERENCES service_variants(id),
  service_name_snapshot  jsonb  NOT NULL,
  service_type           text   NOT NULL,
  size                   text,
  qty                    int           NOT NULL CHECK (qty > 0),
  unit_price             numeric(12,2) NOT NULL CHECK (unit_price >= 0),
  line_total             numeric(12,2) NOT NULL CHECK (line_total >= 0),
  created_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX order_lines_order_idx ON order_lines (order_id);

ALTER TABLE order_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON order_lines
  USING      (business_id = current_business_id())
  WITH CHECK (business_id = current_business_id());

-- ---------------------------------------------------------------------------
-- Payments. Append-only: a refund is a new negative row referencing the
-- original, never an edit. Enforced by trigger, not by convention.
-- ---------------------------------------------------------------------------
CREATE TABLE payments (
  id                        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id               bigint NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  branch_id                 bigint REFERENCES branches(id),
  order_id                  bigint REFERENCES orders(id) ON DELETE CASCADE,
  customer_id               bigint REFERENCES customers(id),
  -- Signed: positive = collected, negative = refunded.
  amount                    numeric(12,2) NOT NULL CHECK (amount <> 0),
  method                    text NOT NULL
                            CHECK (method IN ('cash','card','bank_transfer','wallet','credit')),
  reference                 text,
  refunded_from_payment_id  bigint REFERENCES payments(id),
  refund_reason             text,
  received_by_user_id       bigint REFERENCES users(id),
  received_at               timestamptz NOT NULL DEFAULT now(),
  created_at                timestamptz NOT NULL DEFAULT now(),

  -- A refund row must be negative and must reference its original.
  CONSTRAINT payments_refund_shape CHECK (
    (refunded_from_payment_id IS NULL AND amount > 0)
    OR (refunded_from_payment_id IS NOT NULL AND amount < 0)
  )
);

CREATE INDEX payments_order_idx    ON payments (order_id, received_at);
CREATE INDEX payments_customer_idx ON payments (customer_id, received_at DESC);
CREATE INDEX payments_business_idx ON payments (business_id, received_at DESC);

CREATE TRIGGER payments_append_only_update
  BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION enforce_append_only();

CREATE TRIGGER payments_append_only_delete
  BEFORE DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION enforce_append_only();

ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payments
  USING      (business_id = current_business_id())
  WITH CHECK (business_id = current_business_id());

-- ---------------------------------------------------------------------------
-- Status history. Append-only.
-- ---------------------------------------------------------------------------
CREATE TABLE order_status_history (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id         bigint NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  order_id            bigint NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  from_status         text,
  to_status           text NOT NULL,
  branch_id           bigint REFERENCES branches(id),
  changed_by_user_id  bigint REFERENCES users(id),
  changed_by_role     text,
  note                text,
  changed_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX order_status_history_order_idx
  ON order_status_history (order_id, changed_at);

CREATE TRIGGER order_status_history_append_only_update
  BEFORE UPDATE ON order_status_history
  FOR EACH ROW EXECUTE FUNCTION enforce_append_only();

CREATE TRIGGER order_status_history_append_only_delete
  BEFORE DELETE ON order_status_history
  FOR EACH ROW EXECUTE FUNCTION enforce_append_only();

ALTER TABLE order_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_status_history FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON order_status_history
  USING      (business_id = current_business_id())
  WITH CHECK (business_id = current_business_id());

-- ---------------------------------------------------------------------------
-- Photos.
-- ---------------------------------------------------------------------------
CREATE TABLE order_photos (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id       bigint NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  order_id          bigint NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  url               text NOT NULL,
  kind              text NOT NULL CHECK (kind IN ('intake','stain','damage','complete')),
  taken_by_user_id  bigint REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz
);

CREATE INDEX order_photos_order_idx
  ON order_photos (order_id)
  WHERE deleted_at IS NULL;

ALTER TABLE order_photos ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_photos FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON order_photos
  USING      (business_id = current_business_id())
  WITH CHECK (business_id = current_business_id());

-- =============================================================================
-- NUMBERING
--
-- Both counters live in tables rather than Postgres sequences. A sequence
-- cannot be scoped per (business, branch, day) without creating thousands of
-- sequence objects, and — critically — sequences are non-transactional: a
-- rolled-back order would still burn a number, leaving a gap. FTA does not
-- tolerate gaps in invoice numbering.
--
-- SELECT ... FOR UPDATE serialises concurrent allocation on the counter row.
-- Contention is per-branch-per-day, which for a laundry is trivial.
-- =============================================================================

CREATE TABLE order_number_counters (
  business_id  bigint NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  branch_id    bigint NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  local_date   date   NOT NULL,
  last_seq     int    NOT NULL DEFAULT 0,
  PRIMARY KEY (business_id, branch_id, local_date)
);

ALTER TABLE order_number_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_number_counters FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON order_number_counters
  USING      (business_id = current_business_id())
  WITH CHECK (business_id = current_business_id());

CREATE TABLE invoice_number_counters (
  business_id  bigint NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  year         int    NOT NULL,
  last_seq     int    NOT NULL DEFAULT 0,
  PRIMARY KEY (business_id, year)
);

ALTER TABLE invoice_number_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_number_counters FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON invoice_number_counters
  USING      (business_id = current_business_id())
  WITH CHECK (business_id = current_business_id());

-- =============================================================================
-- customer_stats — replaced with real aggregates.
--
-- Phase 2 shipped this view returning literal zeroes so the API contract could
-- be final before orders existed. This is the promised swap: same columns,
-- same names, real numbers. No endpoint changes.
--
-- Business-wide by design (approved): a customer belongs to the laundry, not
-- to a branch. A manager at any counter sees the customer's full history.
-- =============================================================================

DROP VIEW IF EXISTS customer_stats;

CREATE VIEW customer_stats AS
SELECT
  c.id          AS customer_id,
  c.business_id AS business_id,

  count(o.id) FILTER (WHERE o.status NOT IN ('cancelled','lost'))          AS orders_count,
  count(o.id) FILTER (WHERE o.status = 'delivered')                        AS completed_count,
  count(o.id) FILTER (WHERE o.status IN ('cancelled','lost'))              AS cancelled_count,

  coalesce(sum(o.pieces)      FILTER (WHERE o.status NOT IN ('cancelled','lost')), 0)::bigint        AS pieces,
  coalesce(sum(o.total)       FILTER (WHERE o.status NOT IN ('cancelled','lost')), 0)::numeric(12,2) AS lifetime_spend,
  coalesce(sum(o.paid_amount) FILTER (WHERE o.status NOT IN ('cancelled','lost')), 0)::numeric(12,2) AS lifetime_paid,
  coalesce(sum(o.total - o.paid_amount)
                              FILTER (WHERE o.status NOT IN ('cancelled','lost')), 0)::numeric(12,2) AS outstanding,

  -- Loyalty: 1 point per whole currency unit spent on non-cancelled orders.
  -- A placeholder rule until a loyalty scheme is designed; documented so
  -- nobody mistakes it for a product decision.
  coalesce(floor(sum(o.total) FILTER (WHERE o.status NOT IN ('cancelled','lost'))), 0)::bigint       AS loyalty_points,

  max(o.created_at) FILTER (WHERE o.status NOT IN ('cancelled','lost')) AS last_visit_at,
  min(o.created_at) FILTER (WHERE o.status NOT IN ('cancelled','lost')) AS first_order_at

FROM customers c
LEFT JOIN orders o
  ON o.customer_id = c.id
 AND o.deleted_at IS NULL
WHERE c.deleted_at IS NULL
GROUP BY c.id, c.business_id;
