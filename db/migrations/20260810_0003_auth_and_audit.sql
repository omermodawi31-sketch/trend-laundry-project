-- =============================================================================
-- 20260810_0003_auth_and_audit.sql
--
-- refresh_tokens: DB-backed opaque tokens with family-based rotation.
-- activity_logs: append-only audit trail. Enforced by trigger, not convention.
-- =============================================================================

CREATE TABLE refresh_tokens (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id         bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash      bytea  NOT NULL,
  family_id       uuid   NOT NULL,
  parent_id       bigint REFERENCES refresh_tokens(id),
  business_id     bigint REFERENCES businesses(id),
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  revoked_reason  text,
  user_agent      text,
  ip_address      inet,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX refresh_tokens_hash_uniq ON refresh_tokens (token_hash);
CREATE INDEX refresh_tokens_user_idx     ON refresh_tokens (user_id);
CREATE INDEX refresh_tokens_family_idx   ON refresh_tokens (family_id);
CREATE INDEX refresh_tokens_active_idx
  ON refresh_tokens (user_id)
  WHERE revoked_at IS NULL;

-- Refresh tokens are not tenant-scoped: a user's session belongs to the user,
-- not to a specific business. The active business is a token claim, not a
-- token property. No RLS on this table.

-- -----------------------------------------------------------------------------
CREATE TABLE activity_logs (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id    bigint NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  branch_id      bigint REFERENCES branches(id),
  user_id        bigint REFERENCES users(id),
  role_key       text,
  action         text NOT NULL,
  resource_type  text NOT NULL,
  resource_id    bigint,
  before         jsonb,
  after          jsonb,
  ip_address     inet,
  user_agent     text,
  occurred_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX activity_logs_business_time_idx
  ON activity_logs (business_id, occurred_at DESC);

CREATE INDEX activity_logs_resource_idx
  ON activity_logs (resource_type, resource_id);

-- Append-only. Any UPDATE or DELETE raises an exception.
CREATE TRIGGER activity_logs_append_only_update
  BEFORE UPDATE ON activity_logs
  FOR EACH ROW EXECUTE FUNCTION enforce_append_only();

CREATE TRIGGER activity_logs_append_only_delete
  BEFORE DELETE ON activity_logs
  FOR EACH ROW EXECUTE FUNCTION enforce_append_only();

ALTER TABLE activity_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON activity_logs
  USING      (business_id = current_business_id())
  WITH CHECK (business_id = current_business_id());
