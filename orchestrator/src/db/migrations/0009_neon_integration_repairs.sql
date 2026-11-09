-- Forward-only repairs proven necessary by the first managed PostgreSQL run.
-- Keep both session timestamps on one stable statement clock so the existing
-- last_seen_at >= created_at invariant cannot fail from column evaluation order.

SET LOCAL ROLE r72_owner;

ALTER TABLE app.user_sessions
  ALTER COLUMN last_seen_at SET DEFAULT statement_timestamp(),
  ALTER COLUMN created_at SET DEFAULT statement_timestamp();

-- SELECT ... FOR UPDATE requires UPDATE privilege on at least one column.
-- Grant the security-definer owner a deliberately inert column capability,
-- rather than table-wide UPDATE, so it can lock a claim before consuming it.
GRANT UPDATE (created_at)
  ON app_private.account_setup_claims
  TO r72_security_definer;
