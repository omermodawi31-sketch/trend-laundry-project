-- =============================================================================
-- 20260810_0011_business_settings_delivery_fee.sql
--
-- Phase 6 follow-up — the one hardcoded pricing constant Phase 6 missed.
--
-- orders/service.ts still had `deliveryFee: input.delivery ? 10 : 0` at both
-- pricing call sites after Phase 6 closed — vat_pct and express_pct moved to
-- Business Settings, delivery fee didn't. Same fix, same shape, one release
-- later: a new migration extending `business_settings` (0010), not an edit
-- to that file, matching how every prior extension in this schema has
-- worked (0008 extended `branches` from 0002 the same way).
--
-- BACKWARD COMPATIBILITY
-- ---------------------------------------------------------------------------
-- `ADD COLUMN ... NOT NULL DEFAULT 15.00` is a metadata-only change on
-- Postgres 11+ — every existing `business_settings` row (one per business,
-- guaranteed by 0010's invariant) gets the default value without a table
-- rewrite and without a separate backfill UPDATE. 15.00 was chosen
-- specifically to match the frontend prototype's DEFAULT_SETTINGS.deliveryFee
-- (trend-laundry-orders.jsx / trend-laundry-delivery.jsx), not the backend's
-- old hardcoded 10 — the backend's stale literal was already out of step
-- with the frontend before this migration; this closes that gap rather than
-- perpetuating it. Every business that already exists starts charging 15 for
-- delivery from the moment this migration runs — a real behaviour change,
-- called out explicitly rather than glossed over as "no behaviour change"
-- the way 0010's vat_pct/express_pct defaults could honestly claim (those
-- matched the literals being deleted exactly; this one doesn't, by design,
-- per the explicit instruction that 15 must be the default).
-- =============================================================================

ALTER TABLE business_settings
  ADD COLUMN delivery_fee numeric(10,2) NOT NULL DEFAULT 15.00
    CHECK (delivery_fee >= 0);
