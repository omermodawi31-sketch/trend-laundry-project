-- =============================================================================
-- 20260810_0001_extensions_and_functions.sql
--
-- Extensions and shared functions used by every subsequent migration.
--   - citext: case-insensitive email storage.
--   - pgcrypto: gen_random_uuid() for token families.
--   - normalize_arabic(): mirrors the frontend's normalize() so server-side
--     search matches what a user typed. Marked IMMUTABLE so it can be used
--     in GIN indexes.
--   - trg_updated_at(): standard "keep updated_at fresh on UPDATE" trigger.
--   - enforce_append_only(): raises exception on UPDATE/DELETE. Attached to
--     ledger tables (activity_logs here, movements/payments later).
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Arabic normalisation. Strips harakat, unifies alef variants, ya, ta marbuta,
-- tatweel, LTR/RTL marks. IMMUTABLE lets us index over it.
CREATE OR REPLACE FUNCTION normalize_arabic(input text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT lower(
    regexp_replace(
      translate(
        coalesce(input, ''),
        E'\u064B\u064C\u064D\u064E\u064F\u0650\u0651\u0652\u0670\u0640\u200E\u200F\u0623\u0625\u0622\u0671\u0649\u0629\u0624\u0626',
        E'                \u0627\u0627\u0627\u0627\u064A\u0647\u0648\u064A'
      ),
      '\s+', ' ', 'g'
    )
  )
$$;

-- Keep updated_at fresh.
CREATE OR REPLACE FUNCTION trg_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- Enforce append-only tables. Attached below to activity_logs; later attached
-- to inventory_movements, order_status_history, payments (except refunds).
CREATE OR REPLACE FUNCTION enforce_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Table % is append-only. Use a compensating insert.', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;
