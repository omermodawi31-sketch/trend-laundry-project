-- =============================================================================
-- 20260810_0009_inventory.sql
--
-- Phase 5 — Inventory.
--
-- Two tables, mirroring two patterns already proven in this codebase rather
-- than inventing new ones:
--
--   inventory_items      Business-scoped catalog, same shape as `services`
--                         (20260810_0006) — one row per distinct item
--                         ("Detergent — 5L"), shared across every branch.
--
--   inventory_movements  Append-only ledger, same shape as `payments` and
--                         `order_status_history` (20260810_0007) — reuses
--                         the `enforce_append_only()` trigger function from
--                         Phase 0/1 (20260810_0001) rather than defining new
--                         immutability logic.
--
-- DELIBERATELY NO "current stock" COLUMN ANYWHERE.
-- ---------------------------------------------------------------------------
-- The same lesson Phase 2 already applied to customer_stats: a stored
-- quantity that gets incremented/decremented on every movement can drift
-- from the ledger that's supposed to be its source of truth — this was the
-- single most-cited fragility in the original frontend prototype. Stock
-- levels are instead a computed fact of the ledger, via the
-- `inventory_stock_levels` view at the bottom of this file: a plain VIEW,
-- not materialised, matching customer_stats' "reassess to materialised only
-- if it's actually slow" reasoning. Branch A's quantity of item X is always
-- exactly SUM(quantity_delta) WHERE branch_id=A AND item_id=X — it cannot
-- disagree with its own history, because it IS its own history.
--
-- BRANCH SCOPE
-- ------------
-- Confirmed by the user (PROJECT_CONTEXT.md Decisions Log #18) before this
-- migration was written: inventory uses a SIMPLE SINGLE-BRANCH scope check,
-- not the Orders-style three-column OR predicate. A stock movement happens
-- at exactly one branch — there is no intake/processing/collection concept
-- here. `inventory_movements.branch_id` is a single NOT NULL column, and
-- application-layer authorization (inventory/branch-scope.ts) is modelled on
-- branches/branch-scope.ts's `assertCanManageBranch`, not orders'
-- `branchReadPredicate`.
--
-- The catalog itself (`inventory_items`) is business-scoped, not
-- branch-scoped — no branch-scope check applies to catalog CRUD at all,
-- exactly as the price catalogue (`services`) has no branch dimension
-- either.
--
-- WHY NO "current_stock" COLUMN, NO barcode-VS-qr DISTINCTION
-- -------------------------------------------------------------------------
-- The brief requires every item to "support barcode and QR code" and to be
-- scannable by a normal phone camera. A QR code is a visual encoding of an
-- identifier, not a second identifier — there is one `barcode` column here,
-- and the frontend is free to render it as a linear barcode, a QR code, or
-- both, from the same value. Generating and printing that visual code is a
-- frontend concern; the backend's job is to guarantee the value is unique
-- (per business, matching how `branches.code` is unique per business, not
-- globally — two different laundries can use the same supplier barcode) and
-- resolvable via a fast lookup, which the unique index and the
-- by-code lookup endpoint (routes.ts) both exist to support.
-- =============================================================================

CREATE TABLE inventory_items (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id           bigint NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,

  name                  jsonb  NOT NULL,
  category              text   NOT NULL,
  unit                  text   NOT NULL
                        CHECK (unit IN ('L','kg','piece','roll','box')),

  -- Scan identifiers. Both nullable — a brand-new item can exist in the
  -- catalog before a barcode is assigned to it (e.g. an internally-tracked
  -- consumable that never had a supplier barcode to begin with).
  sku                   text,
  barcode               text,

  is_active             boolean NOT NULL DEFAULT true,
  sort_order            int     NOT NULL DEFAULT 0,

  created_by_user_id    bigint REFERENCES users(id),
  updated_by_user_id    bigint REFERENCES users(id),

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  deleted_at            timestamptz,
  deleted_by_user_id    bigint REFERENCES users(id),

  CONSTRAINT inventory_items_name_shape CHECK (
    jsonb_typeof(name) = 'object'
    AND (coalesce(name->>'en','') <> '' OR coalesce(name->>'ar','') <> '')
  )
);

-- Both scan identifiers unique per business, not globally — mirrors
-- branches.code. Partial indexes: a NULL sku/barcode never collides with
-- another NULL, and a soft-deleted item's old code can be reused by a new
-- catalog entry, same convention as customers' phone uniqueness.
CREATE UNIQUE INDEX inventory_items_business_sku_uniq
  ON inventory_items (business_id, sku)
  WHERE sku IS NOT NULL AND deleted_at IS NULL;

CREATE UNIQUE INDEX inventory_items_business_barcode_uniq
  ON inventory_items (business_id, barcode)
  WHERE barcode IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX inventory_items_business_idx
  ON inventory_items (business_id, sort_order, id)
  WHERE deleted_at IS NULL;

CREATE INDEX inventory_items_business_deleted_idx
  ON inventory_items (business_id, deleted_at DESC)
  WHERE deleted_at IS NOT NULL;

-- Bilingual + code search, same generated-column pattern as customers
-- (20260810_0005) and branches (20260810_0008), through the same
-- normalize_arabic() function from Phase 0 so a scanned or typed code and a
-- typed name are searchable through one box exactly like every other
-- catalog in this system.
ALTER TABLE inventory_items
  ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple',
      normalize_arabic(coalesce(name->>'en','')) || ' ' ||
      normalize_arabic(coalesce(name->>'ar',''))
    ), 'A')
    ||
    setweight(to_tsvector('simple',
      coalesce(sku,'') || ' ' || coalesce(barcode,'')
    ), 'B')
  ) STORED;

CREATE INDEX inventory_items_search_idx
  ON inventory_items USING GIN (search_vector)
  WHERE deleted_at IS NULL;

CREATE TRIGGER inventory_items_updated_at
  BEFORE UPDATE ON inventory_items
  FOR EACH ROW EXECUTE FUNCTION trg_updated_at();

ALTER TABLE inventory_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON inventory_items
  USING      (business_id = current_business_id())
  WITH CHECK (business_id = current_business_id());

-- ---------------------------------------------------------------------------
-- inventory_movements
--
-- The single source of truth for stock. Every row is one physical event:
-- goods received, goods wasted, a stocktake correction, or one leg of a
-- transfer between branches. Never updated, never deleted — a correction to
-- a correction is a new row, not an edit to the old one.
--
-- Sign convention, enforced by CHECK, not just application code:
--   receive        delta > 0   (goods arriving)
--   waste          delta < 0   (goods leaving, damaged/expired/lost)
--   adjust         either      (a stocktake found more or less than expected)
--   transfer_out   delta < 0   (leaving the source branch)
--   transfer_in    delta > 0   (arriving at the destination branch)
--
-- A transfer is two rows (one transfer_out, one transfer_in) inserted in the
-- same transaction, correlated by `transfer_group_id` — a shared value
-- rather than a self-referencing FK, because the two rows are peers (neither
-- is "the original" the other refers back to), the same shape refund rows
-- use `refunded_from_payment_id` for a parent/child relationship, which this
-- is deliberately NOT.
-- ---------------------------------------------------------------------------

CREATE TABLE inventory_movements (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id         bigint NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  branch_id           bigint NOT NULL REFERENCES branches(id),
  item_id             bigint NOT NULL REFERENCES inventory_items(id),

  movement_type       text   NOT NULL
                      CHECK (movement_type IN ('receive','waste','adjust','transfer_out','transfer_in')),

  quantity_delta      numeric(12,3) NOT NULL CHECK (quantity_delta <> 0),
  unit_cost           numeric(12,4) CHECK (unit_cost IS NULL OR unit_cost >= 0),

  -- Required for waste (mirrors customers.status_reason's "blocked requires
  -- a reason" CHECK); optional free-text everywhere else.
  reason              text,
  note                text,

  transfer_group_id   uuid,

  created_by_user_id  bigint REFERENCES users(id),
  occurred_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT inventory_movements_sign_chk CHECK (
    (movement_type = 'receive'      AND quantity_delta > 0) OR
    (movement_type = 'waste'        AND quantity_delta < 0) OR
    (movement_type = 'adjust') OR
    (movement_type = 'transfer_out' AND quantity_delta < 0) OR
    (movement_type = 'transfer_in'  AND quantity_delta > 0)
  ),
  CONSTRAINT inventory_movements_waste_reason_chk CHECK (
    movement_type <> 'waste' OR coalesce(reason, '') <> ''
  ),
  CONSTRAINT inventory_movements_transfer_group_chk CHECK (
    (movement_type IN ('transfer_out','transfer_in')) = (transfer_group_id IS NOT NULL)
  )
);

-- The stock-level aggregate query's index: every read of "what does branch X
-- have of item Y" groups by exactly this triple.
CREATE INDEX inventory_movements_branch_item_idx
  ON inventory_movements (business_id, branch_id, item_id);

-- Cross-branch history for one item (the item's own /movements endpoint).
CREATE INDEX inventory_movements_item_idx
  ON inventory_movements (business_id, item_id, occurred_at DESC);

-- One branch's full movement log, newest first (the branch's own
-- /movements endpoint).
CREATE INDEX inventory_movements_branch_idx
  ON inventory_movements (business_id, branch_id, occurred_at DESC);

CREATE INDEX inventory_movements_transfer_group_idx
  ON inventory_movements (transfer_group_id)
  WHERE transfer_group_id IS NOT NULL;

-- Append-only. Same function every other ledger table in this schema uses —
-- see payments and order_status_history in 20260810_0007.
CREATE TRIGGER inventory_movements_append_only_update
  BEFORE UPDATE ON inventory_movements
  FOR EACH ROW EXECUTE FUNCTION enforce_append_only();

CREATE TRIGGER inventory_movements_append_only_delete
  BEFORE DELETE ON inventory_movements
  FOR EACH ROW EXECUTE FUNCTION enforce_append_only();

ALTER TABLE inventory_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_movements FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON inventory_movements
  USING      (business_id = current_business_id())
  WITH CHECK (business_id = current_business_id());

-- ---------------------------------------------------------------------------
-- inventory_stock_levels
--
-- Current on-hand quantity per (branch, item), computed — never stored.
-- Only rows with at least one movement appear; the repository layer treats
-- a missing (branch_id, item_id) pair as zero, the same way a customer with
-- no orders simply has no rows to sum in customer_stats' underlying join.
-- ---------------------------------------------------------------------------
CREATE VIEW inventory_stock_levels AS
SELECT
  business_id,
  branch_id,
  item_id,
  sum(quantity_delta)::numeric(14,3) AS quantity
FROM inventory_movements
GROUP BY business_id, branch_id, item_id;
