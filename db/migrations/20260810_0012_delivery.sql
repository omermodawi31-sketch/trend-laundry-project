-- =============================================================================
-- 20260810_0012_delivery.sql
--
-- Phase 7 — Delivery & Driver Management.
--
-- Three tables. Follows the exact conventions already established rather
-- than inventing new ones:
--   - `drivers`   business-scoped, soft-delete + restore (customers/branches/
--                 inventory_items pattern), RLS.
--   - `delivery_jobs`  branch-scoped, RLS. Soft-delete + restore AND a
--                 `cancelled` status coexist — mirrors `orders`, which
--                 already has both a status enum including `cancelled` and
--                 its own `deleted_at` column, serving different purposes.
--   - `delivery_job_status_history`  append-only, reuses `enforce_append_only()`
--                 from 20260810_0001 — the fifth table to do so
--                 (activity_logs, payments, order_status_history,
--                 inventory_movements, this).
--
-- DRIVERS DO NOT DUPLICATE IDENTITY DATA
-- ---------------------------------------------------------------------------
-- "Every driver has a normal user account" (final decision). `users` already
-- has `full_name` and `phone` (20260810_0002) — `drivers` does not repeat
-- them. A driver row is the delivery-specific extension of an existing user
-- (vehicle info, live status), the same relationship `branches.manager_user_id`
-- already has to `users`, just with the FK required here instead of optional.
--
-- delivery_jobs.branch_id IS DERIVED, NOT CLIENT-SUPPLIED
-- ---------------------------------------------------------------------------
-- Every delivery job references an existing order (final decision — no
-- order-independent jobs in v1). `branch_id` is computed by the service layer
-- as `order.collection_branch_id ?? order.intake_branch_id` — the EXACT
-- expression `orders/service.ts`'s `recordPayment` already uses to attribute
-- a payment's branch. This isn't a new concept for the schema; it's the same
-- one, reused. There is no separate branch column a client can set directly.
--
-- GPS IS OPTIONAL, CAPTURED ONCE, AT THE PHYSICAL EVENT
-- ---------------------------------------------------------------------------
-- "GPS location should be supported for pickup and delivery events... optional
-- if location permission is unavailable." A job is only ever one type
-- (pickup XOR delivery), so one pair of nullable columns —
-- `proof_latitude`/`proof_longitude` — covers both: for a pickup job it's
-- where the pickup happened, for a delivery job it's where the delivery
-- happened. Captured at completion, grouped conceptually with the job's
-- other proof-of-completion fields (photo, signature). Same paired-CHECK +
-- range-CHECK shape as `branches.latitude`/`branches.longitude`
-- (20260810_0008) — not a new validation pattern.
-- =============================================================================

CREATE TABLE drivers (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id           bigint NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id               bigint NOT NULL REFERENCES users(id),

  vehicle_type          text CHECK (vehicle_type IS NULL OR vehicle_type IN ('bike','car','van')),
  plate_number          text,
  notes                 text,

  status                text NOT NULL DEFAULT 'offline'
                        CHECK (status IN ('available','busy','offline')),
  is_active             boolean NOT NULL DEFAULT true,

  created_by_user_id    bigint REFERENCES users(id),
  updated_by_user_id    bigint REFERENCES users(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  deleted_at            timestamptz,
  deleted_by_user_id    bigint REFERENCES users(id)
);

-- One driver profile per user per business. Partial (excludes soft-deleted)
-- so a removed driver's user_id can be re-onboarded as a driver later.
CREATE UNIQUE INDEX drivers_business_user_uniq
  ON drivers (business_id, user_id)
  WHERE deleted_at IS NULL;

CREATE INDEX drivers_business_idx
  ON drivers (business_id, status)
  WHERE deleted_at IS NULL;

CREATE TRIGGER drivers_updated_at
  BEFORE UPDATE ON drivers
  FOR EACH ROW EXECUTE FUNCTION trg_updated_at();

ALTER TABLE drivers ENABLE ROW LEVEL SECURITY;
ALTER TABLE drivers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON drivers
  USING      (business_id = current_business_id())
  WITH CHECK (business_id = current_business_id());

-- ---------------------------------------------------------------------------
-- delivery_jobs
-- ---------------------------------------------------------------------------

CREATE TABLE delivery_jobs (
  id                      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id             bigint NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  branch_id               bigint NOT NULL REFERENCES branches(id),
  order_id                bigint NOT NULL REFERENCES orders(id),
  driver_id               bigint REFERENCES drivers(id),

  job_type                text NOT NULL CHECK (job_type IN ('pickup','delivery')),
  status                  text NOT NULL DEFAULT 'scheduled'
                          CHECK (status IN ('scheduled','assigned','en_route','arrived','completed','failed','cancelled')),

  address                 jsonb NOT NULL,
  scheduled_window_start  timestamptz,
  scheduled_window_end    timestamptz,

  -- Snapshotted from business_settings.delivery_fee at creation time for
  -- job_type = 'delivery'; stays 0 for 'pickup'. Immutable thereafter — the
  -- exact same snapshot discipline orders.vat_pct/express_pct/delivery_amount
  -- already use, applied to the same underlying setting (Phase 6).
  fee                     numeric(10,2) NOT NULL DEFAULT 0 CHECK (fee >= 0),

  collect_amount          numeric(10,2) CHECK (collect_amount IS NULL OR collect_amount >= 0),
  collected_amount        numeric(10,2) CHECK (collected_amount IS NULL OR collected_amount >= 0),

  proof_photo_url         text,
  proof_signature_url     text,
  proof_latitude          numeric(9,6),
  proof_longitude         numeric(9,6),

  fail_reason             text,

  assigned_at             timestamptz,
  started_at              timestamptz,
  arrived_at              timestamptz,
  completed_at            timestamptz,
  cancelled_at            timestamptz,

  created_by_user_id      bigint REFERENCES users(id),
  updated_by_user_id      bigint REFERENCES users(id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  deleted_at              timestamptz,
  deleted_by_user_id      bigint REFERENCES users(id),

  CONSTRAINT delivery_jobs_address_shape CHECK (jsonb_typeof(address) = 'object'),
  -- Both failure AND cancellation require a reason — extends the pattern to
  -- match orders.cancel_reason, which covers cancelled AND lost with one
  -- column the same way. Column keeps its original name (fail_reason);
  -- renaming it project-wide for a same-day, pre-completion fix would have
  -- been a bigger ripple than the gap justified.
  CONSTRAINT delivery_jobs_fail_reason_chk CHECK (
    status NOT IN ('failed','cancelled') OR coalesce(fail_reason, '') <> ''
  ),
  CONSTRAINT delivery_jobs_geo_pair_chk CHECK (
    (proof_latitude IS NULL AND proof_longitude IS NULL) OR
    (proof_latitude IS NOT NULL AND proof_longitude IS NOT NULL)
  ),
  CONSTRAINT delivery_jobs_lat_range_chk CHECK (proof_latitude  IS NULL OR (proof_latitude  BETWEEN -90  AND 90)),
  CONSTRAINT delivery_jobs_lng_range_chk CHECK (proof_longitude IS NULL OR (proof_longitude BETWEEN -180 AND 180))
);

CREATE INDEX delivery_jobs_branch_status_idx
  ON delivery_jobs (business_id, branch_id, status)
  WHERE deleted_at IS NULL;

CREATE INDEX delivery_jobs_driver_status_idx
  ON delivery_jobs (business_id, driver_id, status)
  WHERE deleted_at IS NULL AND driver_id IS NOT NULL;

CREATE INDEX delivery_jobs_order_idx
  ON delivery_jobs (business_id, order_id)
  WHERE deleted_at IS NULL;

CREATE INDEX delivery_jobs_business_deleted_idx
  ON delivery_jobs (business_id, deleted_at DESC)
  WHERE deleted_at IS NOT NULL;

CREATE TRIGGER delivery_jobs_updated_at
  BEFORE UPDATE ON delivery_jobs
  FOR EACH ROW EXECUTE FUNCTION trg_updated_at();

ALTER TABLE delivery_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON delivery_jobs
  USING      (business_id = current_business_id())
  WITH CHECK (business_id = current_business_id());

-- ---------------------------------------------------------------------------
-- delivery_job_status_history — append-only, mirrors order_status_history exactly
-- ---------------------------------------------------------------------------

CREATE TABLE delivery_job_status_history (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id         bigint NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  job_id              bigint NOT NULL REFERENCES delivery_jobs(id),
  branch_id           bigint NOT NULL REFERENCES branches(id),
  from_status         text,
  to_status           text NOT NULL,
  reason              text,
  changed_by_user_id  bigint REFERENCES users(id),
  occurred_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX delivery_job_status_history_job_idx
  ON delivery_job_status_history (job_id, occurred_at DESC);

-- Append-only. Same trigger function every other ledger table in this
-- schema uses — see 20260810_0001, reused for the fifth time.
CREATE TRIGGER delivery_job_status_history_append_only_update
  BEFORE UPDATE ON delivery_job_status_history
  FOR EACH ROW EXECUTE FUNCTION enforce_append_only();

CREATE TRIGGER delivery_job_status_history_append_only_delete
  BEFORE DELETE ON delivery_job_status_history
  FOR EACH ROW EXECUTE FUNCTION enforce_append_only();

ALTER TABLE delivery_job_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_job_status_history FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON delivery_job_status_history
  USING      (business_id = current_business_id())
  WITH CHECK (business_id = current_business_id());
