-- =============================================================================
-- 20260810_0002_tenancy.sql
--
-- Core tenancy: businesses, users, roles, memberships, branches.
-- RLS is enabled at the bottom, after every table exists.
-- =============================================================================

CREATE TABLE businesses (
  id                        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name                      jsonb  NOT NULL,
  trade_licence_number      text,
  tax_registration_number   text,
  country_code              char(2) NOT NULL DEFAULT 'AE',
  currency                  char(3) NOT NULL DEFAULT 'AED',
  default_locale            text    NOT NULL DEFAULT 'en',
  timezone                  text    NOT NULL DEFAULT 'Asia/Dubai',
  plan                      text    NOT NULL DEFAULT 'trial'
                            CHECK (plan IN ('trial','starter','growth','enterprise')),
  trial_ends_at             timestamptz,
  status                    text    NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active','suspended','cancelled')),
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  deleted_at                timestamptz,
  -- Bilingual name shape enforcement
  CHECK (jsonb_typeof(name) = 'object'
         AND (name ? 'en' OR name ? 'ar'))
);

CREATE UNIQUE INDEX businesses_trade_licence_uniq
  ON businesses (trade_licence_number)
  WHERE trade_licence_number IS NOT NULL;

CREATE TRIGGER businesses_updated_at
  BEFORE UPDATE ON businesses
  FOR EACH ROW EXECUTE FUNCTION trg_updated_at();

-- -----------------------------------------------------------------------------
CREATE TABLE users (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email                 citext NOT NULL,
  phone                 text,
  password_hash         text   NOT NULL,
  email_verified_at     timestamptz,
  phone_verified_at     timestamptz,
  full_name             text   NOT NULL,
  preferred_locale      text   NOT NULL DEFAULT 'en',
  mfa_secret            text,
  mfa_enabled_at        timestamptz,
  last_login_at         timestamptz,
  failed_login_count    int    NOT NULL DEFAULT 0,
  locked_until          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  deleted_at            timestamptz
);

-- Case-insensitive uniqueness on non-deleted users.
CREATE UNIQUE INDEX users_email_uniq
  ON users (email)
  WHERE deleted_at IS NULL;

CREATE TRIGGER users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION trg_updated_at();

-- -----------------------------------------------------------------------------
CREATE TABLE roles (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id   bigint NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  key           text   NOT NULL,
  name          jsonb  NOT NULL,
  permissions   text[] NOT NULL DEFAULT '{}'::text[],
  is_system     boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX roles_business_key_uniq ON roles (business_id, key);
CREATE INDEX roles_business_idx ON roles (business_id);

CREATE TRIGGER roles_updated_at
  BEFORE UPDATE ON roles
  FOR EACH ROW EXECUTE FUNCTION trg_updated_at();

-- -----------------------------------------------------------------------------
CREATE TABLE branches (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id   bigint NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name          jsonb  NOT NULL,
  code          text   NOT NULL,
  address       jsonb  NOT NULL,
  phone         text,
  maps_url      text,
  working_hours jsonb,
  logo_url      text,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);

CREATE UNIQUE INDEX branches_business_code_uniq
  ON branches (business_id, code)
  WHERE deleted_at IS NULL;

CREATE INDEX branches_business_idx ON branches (business_id) WHERE deleted_at IS NULL;

CREATE TRIGGER branches_updated_at
  BEFORE UPDATE ON branches
  FOR EACH ROW EXECUTE FUNCTION trg_updated_at();

-- -----------------------------------------------------------------------------
CREATE TABLE memberships (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id             bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_id         bigint NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  role_id             bigint NOT NULL REFERENCES roles(id),
  branch_ids          bigint[] NOT NULL DEFAULT '{}'::bigint[],
  is_active           boolean NOT NULL DEFAULT true,
  invited_by_user_id  bigint REFERENCES users(id),
  invited_at          timestamptz,
  accepted_at         timestamptz,
  revoked_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX memberships_user_business_uniq ON memberships (user_id, business_id);
CREATE INDEX memberships_business_active_idx
  ON memberships (business_id)
  WHERE is_active;

CREATE TRIGGER memberships_updated_at
  BEFORE UPDATE ON memberships
  FOR EACH ROW EXECUTE FUNCTION trg_updated_at();

-- =============================================================================
-- Row-Level Security
--
-- Every business-owned table gets a policy that filters by the
-- app.business_id session variable. The variable is set inside a transaction
-- by our db.ts withTenant() helper. FORCE ROW LEVEL SECURITY means the
-- policy applies even to the table owner — no accidental bypass.
-- =============================================================================

-- Helper for readability inside policies.
CREATE OR REPLACE FUNCTION current_business_id() RETURNS bigint
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT NULLIF(current_setting('app.business_id', true), '')::bigint
$$;

-- businesses: rows are the tenants themselves. A user may only see their own
-- business. We also allow selecting the row currently being created (used by
-- signup, which uses withNoTenant + explicit filter).
ALTER TABLE businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE businesses FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON businesses
  USING      (id = current_business_id())
  WITH CHECK (id = current_business_id());

ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON roles
  USING      (business_id = current_business_id())
  WITH CHECK (business_id = current_business_id());

ALTER TABLE branches ENABLE ROW LEVEL SECURITY;
ALTER TABLE branches FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON branches
  USING      (business_id = current_business_id())
  WITH CHECK (business_id = current_business_id());

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON memberships
  USING      (business_id = current_business_id())
  WITH CHECK (business_id = current_business_id());

-- users: NOT tenant-scoped by RLS. A user is a global identity that can
-- belong to multiple businesses. Access control is application-layer:
-- only /me and admin flows touch users directly. Every read from a tenant
-- context goes through memberships.
