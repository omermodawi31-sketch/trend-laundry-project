-- =============================================================================
-- 20260810_0004_password_resets_and_email_verifications.sql
--
-- Two small tables backing the credential recovery flows. Tokens are stored
-- hashed (SHA-256) — the raw token exists only in the email link. A DB dump
-- reveals hashes, not usable tokens.
-- =============================================================================

CREATE TABLE password_resets (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id         bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash      bytea  NOT NULL,
  expires_at      timestamptz NOT NULL,
  used_at         timestamptz,
  ip_address      inet,
  user_agent      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX password_resets_hash_uniq ON password_resets (token_hash);
CREATE INDEX password_resets_user_idx        ON password_resets (user_id) WHERE used_at IS NULL;

-- Not tenant-scoped: password reset is a per-user flow, tenant is irrelevant.

-- -----------------------------------------------------------------------------
CREATE TABLE email_verifications (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id         bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash      bytea  NOT NULL,
  expires_at      timestamptz NOT NULL,
  consumed_at     timestamptz,
  email_at_issue  citext NOT NULL,   -- the email at the moment the token was issued
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX email_verifications_hash_uniq ON email_verifications (token_hash);
CREATE INDEX email_verifications_user_idx        ON email_verifications (user_id) WHERE consumed_at IS NULL;

-- Storing email_at_issue prevents this attack: user has token, then changes
-- their email, then uses the old token — the old email should be verified,
-- not the new one. When the token is redeemed, we compare against users.email
-- (if the user has since changed it) and refuse the redemption.
