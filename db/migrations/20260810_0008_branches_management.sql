-- =============================================================================
-- 20260810_0008_branches_management.sql
--
-- Phase 4 — Branches Management.
--
-- The `branches` table itself, RLS, soft-delete, and the (business_id, code)
-- uniqueness constraint were all created in Phase 0 (see
-- 20260810_0002_tenancy.sql) because orders needed a real branches table from
-- Phase 3 onward. This migration ADDS the columns a dedicated management
-- module needs on top of that foundation — it does not redefine anything.
--
-- New columns:
--   email             — branch contact email, citext like every other email
--                        column in the schema (users.email, customers.email)
--   latitude/longitude — structured geo-coordinates for map pins. `maps_url`
--                        (already existed) stays as a human-clickable link;
--                        lat/lng are what a map component actually plots.
--   manager_user_id   — who runs this branch day to day. Deliberately a
--                        DESCRIPTIVE field, not a permission grant: it does
--                        not by itself change what the referenced user can
--                        do. Branch-scoped access still comes from
--                        memberships.branch_ids (Phase 1), set independently
--                        via the team module. Conflating "labelled as
--                        manager" with "granted branch access" would silently
--                        change authorization from a display field — the two
--                        stay decoupled on purpose.
--   sort_order        — display order, same convention as services.sort_order
--                        from Phase 3.
--   created_by_user_id, updated_by_user_id, deleted_by_user_id
--                     — provenance columns, matching the pattern already
--                        established on `customers` in Phase 2.
--
-- FK integrity note: orders.intake_branch_id / processing_branch_id /
-- collection_branch_id (Phase 3) reference branches(id) with no ON DELETE
-- clause, i.e. Postgres default NO ACTION. A genuine hard DELETE against a
-- branch that any order references is already refused at the database level
-- before the application ever gets a say. The application-level check this
-- phase adds (in the service layer) exists to give a clean 409 with a count,
-- rather than a raw foreign-key-violation error reaching the client — it is
-- a defense-in-depth layer, not the only thing standing in the way.
-- =============================================================================

ALTER TABLE branches
  ADD COLUMN email               citext,
  ADD COLUMN latitude             numeric(9,6),
  ADD COLUMN longitude            numeric(9,6),
  ADD COLUMN manager_user_id      bigint REFERENCES users(id),
  ADD COLUMN sort_order           int NOT NULL DEFAULT 0,
  ADD COLUMN created_by_user_id   bigint REFERENCES users(id),
  ADD COLUMN updated_by_user_id   bigint REFERENCES users(id),
  ADD COLUMN deleted_by_user_id   bigint REFERENCES users(id);

-- Both coordinates travel together or not at all — a lone latitude with no
-- longitude cannot be plotted and is more likely a partial-save bug than
-- data worth keeping.
ALTER TABLE branches
  ADD CONSTRAINT branches_geo_pair_chk CHECK (
    (latitude IS NULL AND longitude IS NULL) OR
    (latitude IS NOT NULL AND longitude IS NOT NULL)
  ),
  ADD CONSTRAINT branches_lat_range_chk CHECK (latitude  IS NULL OR (latitude  BETWEEN -90  AND 90)),
  ADD CONSTRAINT branches_lng_range_chk CHECK (longitude IS NULL OR (longitude BETWEEN -180 AND 180));

-- working_hours shape: when present, must be a JSON object (per-day entries).
-- The exact per-day shape is validated at the application boundary with Zod
-- (schemas.ts) rather than a database CHECK, matching how bilingual field
-- *content* validation lives in Zod while only the coarse shape is a CHECK —
-- see the same split on customers.name in Phase 2.
ALTER TABLE branches
  ADD CONSTRAINT branches_working_hours_shape_chk CHECK (
    working_hours IS NULL OR jsonb_typeof(working_hours) = 'object'
  );

CREATE INDEX branches_manager_idx
  ON branches (manager_user_id)
  WHERE manager_user_id IS NOT NULL AND deleted_at IS NULL;

-- Listing branches in display order is the default read pattern for a
-- management UI (a picker, a settings page) — index it explicitly rather
-- than relying on a sequential scan plus sort.
CREATE INDEX branches_business_sort_idx
  ON branches (business_id, sort_order, id)
  WHERE deleted_at IS NULL;

-- Deleted-branches view, mirroring customers_business_deleted_idx from
-- Phase 2 — a restore workflow needs to list what's in the trash.
CREATE INDEX branches_business_deleted_idx
  ON branches (business_id, deleted_at DESC)
  WHERE deleted_at IS NOT NULL;
