-- Stable same-statement chronology defaults. Volatile clock_timestamp() can
-- advance between an explicit lifecycle timestamp and a later column default,
-- making a valid insert fail its own `event_at >= created_at` constraint.

SET LOCAL ROLE r72_owner;

ALTER TABLE app.organizations
  ALTER COLUMN created_at SET DEFAULT statement_timestamp(),
  ALTER COLUMN updated_at SET DEFAULT statement_timestamp();

ALTER TABLE app.users
  ALTER COLUMN created_at SET DEFAULT statement_timestamp(),
  ALTER COLUMN updated_at SET DEFAULT statement_timestamp();

ALTER TABLE app.organization_branding
  ALTER COLUMN created_at SET DEFAULT statement_timestamp(),
  ALTER COLUMN updated_at SET DEFAULT statement_timestamp();

ALTER TABLE app.workspaces
  ALTER COLUMN created_at SET DEFAULT statement_timestamp(),
  ALTER COLUMN updated_at SET DEFAULT statement_timestamp();

ALTER TABLE app.organization_domains
  ALTER COLUMN created_at SET DEFAULT statement_timestamp(),
  ALTER COLUMN updated_at SET DEFAULT statement_timestamp();

ALTER TABLE app.organization_memberships
  ALTER COLUMN granted_at SET DEFAULT statement_timestamp(),
  ALTER COLUMN updated_at SET DEFAULT statement_timestamp();

ALTER TABLE app.workspace_memberships
  ALTER COLUMN granted_at SET DEFAULT statement_timestamp(),
  ALTER COLUMN updated_at SET DEFAULT statement_timestamp();

ALTER TABLE app.membership_invitations
  ALTER COLUMN created_at SET DEFAULT statement_timestamp(),
  ALTER COLUMN updated_at SET DEFAULT statement_timestamp();

ALTER TABLE app.identity_action_tokens
  ALTER COLUMN created_at SET DEFAULT statement_timestamp();

ALTER TABLE app.contacts
  ALTER COLUMN created_at SET DEFAULT statement_timestamp(),
  ALTER COLUMN updated_at SET DEFAULT statement_timestamp();

ALTER TABLE app.contact_points
  ALTER COLUMN created_at SET DEFAULT statement_timestamp(),
  ALTER COLUMN updated_at SET DEFAULT statement_timestamp();

ALTER TABLE app.pipelines
  ALTER COLUMN created_at SET DEFAULT statement_timestamp(),
  ALTER COLUMN updated_at SET DEFAULT statement_timestamp();

ALTER TABLE app.pipeline_stages
  ALTER COLUMN created_at SET DEFAULT statement_timestamp(),
  ALTER COLUMN updated_at SET DEFAULT statement_timestamp();

ALTER TABLE app.opportunities
  ALTER COLUMN created_at SET DEFAULT statement_timestamp(),
  ALTER COLUMN updated_at SET DEFAULT statement_timestamp();

ALTER TABLE app.tasks
  ALTER COLUMN created_at SET DEFAULT statement_timestamp(),
  ALTER COLUMN updated_at SET DEFAULT statement_timestamp();

ALTER TABLE app.command_receipts
  ALTER COLUMN created_at SET DEFAULT statement_timestamp();

ALTER TABLE app_private.account_setup_deliveries
  ALTER COLUMN created_at SET DEFAULT statement_timestamp(),
  ALTER COLUMN updated_at SET DEFAULT statement_timestamp();

ALTER TABLE app_private.account_setup_claims
  ALTER COLUMN created_at SET DEFAULT statement_timestamp();

-- Activities and outbox events intentionally keep their paired moving-clock
-- defaults: their invariant runs in the opposite direction
-- (`created_at >= occurred_at`), and callers may supply both exact timestamps.
-- User-session defaults were already repaired together in migration 0009.
