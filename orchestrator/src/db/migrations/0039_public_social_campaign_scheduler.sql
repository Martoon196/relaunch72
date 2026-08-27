-- Durable TEST-only public-social campaigns, calendar slots and per-target
-- simulator operations. This migration deliberately creates no live provider
-- capability, credential store, network adapter or generic provider operation.

DO $roles$
DECLARE
  role_name text;
  expected_login boolean;
  unsafe_membership text;
BEGIN
  FOR role_name, expected_login IN
    SELECT required.role_name, required.expected_login
    FROM (VALUES
      ('r72_public_social_definer', false),
      ('r72_public_social_command', true),
      ('r72_public_social_worker_command', true)
    ) AS required(role_name, expected_login)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = role_name) THEN
      EXECUTE format(
        'CREATE ROLE %I %s NOINHERIT', role_name,
        CASE WHEN expected_login THEN 'LOGIN' ELSE 'NOLOGIN' END
      );
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles
      WHERE rolname = role_name
        AND rolcanlogin = expected_login
        AND NOT rolinherit AND NOT rolsuper AND NOT rolcreatedb
        AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls
    ) THEN
      RAISE EXCEPTION 'Unsafe public-social role attributes: %', role_name;
    END IF;
  END LOOP;

  REVOKE r72_owner, r72_security_definer, r72_onboarding_definer,
    r72_setup_delivery_definer, r72_commerce_definer,
    r72_external_event_definer, r72_provider_operation_definer,
    r72_mailgun_webhook_definer, r72_test_inbox_webhook_definer
  FROM r72_public_social_definer, r72_public_social_command,
    r72_public_social_worker_command;
  REVOKE r72_public_social_definer, r72_public_social_command,
    r72_public_social_worker_command
  FROM r72_web, r72_public, r72_worker, r72_webhook, r72_readonly,
    r72_crm_command, r72_identity_command, r72_provisioning_command,
    r72_setup_delivery_command, r72_setup_reissue_command,
    r72_external_event_command, r72_mailgun_webhook_command,
    r72_test_inbox_webhook_command;
  REVOKE r72_public_social_definer
  FROM r72_public_social_command, r72_public_social_worker_command;
  REVOKE r72_public_social_command
  FROM r72_public_social_definer, r72_public_social_worker_command, r72_owner;
  REVOKE r72_public_social_worker_command
  FROM r72_public_social_definer, r72_public_social_command, r72_owner;

  SELECT member.rolname || '->' || parent.rolname INTO unsafe_membership
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
  JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
  WHERE member.rolname IN (
    'r72_public_social_definer', 'r72_public_social_command',
    'r72_public_social_worker_command'
  )
  LIMIT 1;
  IF unsafe_membership IS NOT NULL THEN
    RAISE EXCEPTION 'Unsafe public-social role membership: %', unsafe_membership;
  END IF;

  GRANT r72_public_social_definer TO r72_owner;
  EXECUTE format('GRANT r72_public_social_command TO %I', current_user);
  EXECUTE format('GRANT r72_public_social_worker_command TO %I', current_user);
END
$roles$;

SET LOCAL ROLE r72_owner;

REVOKE ALL ON SCHEMA app, app_private
  FROM r72_public_social_definer, r72_public_social_command,
    r72_public_social_worker_command;
REVOKE ALL ON ALL TABLES IN SCHEMA app
  FROM r72_public_social_definer, r72_public_social_command,
    r72_public_social_worker_command;
REVOKE ALL ON ALL TABLES IN SCHEMA app_private
  FROM r72_public_social_definer, r72_public_social_command,
    r72_public_social_worker_command;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app_private
  FROM r72_public_social_definer, r72_public_social_command,
    r72_public_social_worker_command;
REVOKE CREATE ON SCHEMA public
  FROM r72_public_social_definer, r72_public_social_command,
    r72_public_social_worker_command;

ALTER TABLE app.provider_connections
  ADD CONSTRAINT provider_connections_public_social_dark_test_only_ck
  CHECK (
    provider_id <> 'public_social_dark_simulator'
    OR (provider_kind = 'social' AND environment = 'test')
  ) NOT VALID;
ALTER TABLE app.provider_connections
  VALIDATE CONSTRAINT provider_connections_public_social_dark_test_only_ck;

CREATE TABLE app.public_social_campaigns (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  campaign_key text NOT NULL CHECK (
    campaign_key = lower(btrim(campaign_key))
    AND campaign_key ~ '^[a-z0-9][a-z0-9._:-]{0,127}$'
  ),
  created_by_user_id uuid NOT NULL,
  created_request_id text NOT NULL CHECK (
    created_request_id = btrim(created_request_id)
    AND length(created_request_id) BETWEEN 1 AND 128
  ),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, campaign_key),
  FOREIGN KEY (workspace_id, created_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT
);

CREATE TABLE app.public_social_campaign_revisions (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL,
  revision_number integer NOT NULL CHECK (revision_number BETWEEN 1 AND 2147483647),
  previous_revision_id uuid,
  title text NOT NULL CHECK (
    title = btrim(title) AND length(title) BETWEEN 1 AND 200
    AND position(U&'\202A' in title) = 0 AND position(U&'\202B' in title) = 0
    AND position(U&'\202C' in title) = 0 AND position(U&'\202D' in title) = 0
    AND position(U&'\202E' in title) = 0 AND position(U&'\2066' in title) = 0
    AND position(U&'\2067' in title) = 0 AND position(U&'\2068' in title) = 0
    AND position(U&'\2069' in title) = 0
  ),
  objective text NOT NULL CHECK (
    objective = btrim(objective) AND length(objective) BETWEEN 1 AND 2000
    AND position(U&'\202A' in objective) = 0 AND position(U&'\202B' in objective) = 0
    AND position(U&'\202C' in objective) = 0 AND position(U&'\202D' in objective) = 0
    AND position(U&'\202E' in objective) = 0 AND position(U&'\2066' in objective) = 0
    AND position(U&'\2067' in objective) = 0 AND position(U&'\2068' in objective) = 0
    AND position(U&'\2069' in objective) = 0
  ),
  timezone text NOT NULL CHECK (
    timezone = btrim(timezone) AND length(timezone) BETWEEN 1 AND 100
  ),
  revision_sha256 bytea NOT NULL CHECK (octet_length(revision_sha256) = 32),
  created_by_user_id uuid NOT NULL,
  created_request_id text NOT NULL CHECK (
    created_request_id = btrim(created_request_id)
    AND length(created_request_id) BETWEEN 1 AND 128
  ),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, campaign_id, id),
  UNIQUE (workspace_id, campaign_id, revision_number),
  FOREIGN KEY (workspace_id, campaign_id)
    REFERENCES app.public_social_campaigns (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, campaign_id, previous_revision_id)
    REFERENCES app.public_social_campaign_revisions (workspace_id, campaign_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, created_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK ((revision_number = 1) = (previous_revision_id IS NULL))
);

CREATE TABLE app.public_social_targets (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  provider_connection_id uuid NOT NULL,
  network text NOT NULL CHECK (network IN (
    'facebook', 'instagram', 'linkedin', 'tiktok', 'x', 'youtube',
    'google_business_profile', 'threads', 'pinterest'
  )),
  environment text NOT NULL DEFAULT 'test' CHECK (environment = 'test'),
  test_account_ref text NOT NULL CHECK (
    test_account_ref = btrim(test_account_ref)
    AND length(test_account_ref) BETWEEN 1 AND 128
    AND test_account_ref ~ '^test-account:[a-z_]+:[a-z0-9_-]{1,64}$'
  ),
  account_ref_sha256 bytea GENERATED ALWAYS AS (
    public.digest(test_account_ref, 'sha256')
  ) STORED,
  display_name text NOT NULL CHECK (
    display_name = btrim(display_name) AND length(display_name) BETWEEN 1 AND 120
    AND position(U&'\202A' in display_name) = 0 AND position(U&'\202B' in display_name) = 0
    AND position(U&'\202C' in display_name) = 0 AND position(U&'\202D' in display_name) = 0
    AND position(U&'\202E' in display_name) = 0 AND position(U&'\2066' in display_name) = 0
    AND position(U&'\2067' in display_name) = 0 AND position(U&'\2068' in display_name) = 0
    AND position(U&'\2069' in display_name) = 0
  ),
  created_by_user_id uuid NOT NULL,
  created_request_id text NOT NULL CHECK (
    created_request_id = btrim(created_request_id)
    AND length(created_request_id) BETWEEN 1 AND 128
  ),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, id, provider_connection_id, network, environment),
  UNIQUE (workspace_id, provider_connection_id, network, account_ref_sha256),
  FOREIGN KEY (workspace_id, provider_connection_id, environment)
    REFERENCES app.provider_connections (workspace_id, id, environment)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, created_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK (test_account_ref LIKE 'test-account:' || network || ':%')
);

CREATE TABLE app.public_social_posts (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL,
  campaign_revision_id uuid NOT NULL,
  content_item_id uuid NOT NULL,
  content_version_id uuid NOT NULL,
  content_sha256 bytea NOT NULL CHECK (octet_length(content_sha256) = 32),
  approval_request_id uuid NOT NULL,
  approval_decision_id uuid NOT NULL,
  scheduled_source_attestation_id uuid NOT NULL,
  scheduled_for timestamptz NOT NULL,
  max_attempts smallint NOT NULL CHECK (max_attempts BETWEEN 1 AND 4),
  plan_sha256 bytea NOT NULL CHECK (octet_length(plan_sha256) = 32),
  created_by_user_id uuid NOT NULL,
  created_request_id text NOT NULL CHECK (
    created_request_id = btrim(created_request_id)
    AND length(created_request_id) BETWEEN 1 AND 128
  ),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, campaign_id, campaign_revision_id, id),
  UNIQUE (workspace_id, id, plan_sha256),
  FOREIGN KEY (workspace_id, campaign_id, campaign_revision_id)
    REFERENCES app.public_social_campaign_revisions (workspace_id, campaign_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, content_item_id, content_version_id, content_sha256)
    REFERENCES app.company_content_versions (
      workspace_id, content_item_id, id, content_sha256
    ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, approval_request_id)
    REFERENCES app.company_content_approval_requests (workspace_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, approval_decision_id)
    REFERENCES app.company_content_approval_decisions (workspace_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, scheduled_source_attestation_id)
    REFERENCES app.company_content_source_attestations (workspace_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, created_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK (scheduled_for >= created_at - interval '5 minutes'),
  CHECK (scheduled_for <= created_at + interval '366 days')
);

CREATE TABLE app.public_social_post_media (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  post_id uuid NOT NULL,
  ordinal smallint NOT NULL CHECK (ordinal BETWEEN 1 AND 10),
  content_item_id uuid NOT NULL,
  content_version_id uuid NOT NULL,
  content_sha256 bytea NOT NULL CHECK (octet_length(content_sha256) = 32),
  blob_sha256 bytea NOT NULL CHECK (octet_length(blob_sha256) = 32),
  approval_request_id uuid NOT NULL,
  approval_decision_id uuid NOT NULL,
  scheduled_source_attestation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, post_id, ordinal),
  UNIQUE (workspace_id, post_id, content_version_id),
  FOREIGN KEY (workspace_id, post_id)
    REFERENCES app.public_social_posts (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, content_item_id, content_version_id, content_sha256)
    REFERENCES app.company_content_versions (
      workspace_id, content_item_id, id, content_sha256
    ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, approval_request_id)
    REFERENCES app.company_content_approval_requests (workspace_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, approval_decision_id)
    REFERENCES app.company_content_approval_decisions (workspace_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, scheduled_source_attestation_id)
    REFERENCES app.company_content_source_attestations (workspace_id, id)
    ON DELETE RESTRICT
);

CREATE TABLE app.public_social_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  post_id uuid NOT NULL,
  target_id uuid NOT NULL,
  provider_connection_id uuid NOT NULL,
  network text NOT NULL,
  environment text NOT NULL DEFAULT 'test' CHECK (environment = 'test'),
  execution_mode text NOT NULL DEFAULT 'simulated_test_only'
    CHECK (execution_mode = 'simulated_test_only'),
  state text NOT NULL DEFAULT 'waiting_for_test_time' CHECK (state IN (
    'waiting_for_test_time', 'leased', 'calling_simulator', 'retry_wait',
    'simulated_succeeded', 'simulated_failed', 'reconciliation_required',
    'simulated_reconciled', 'simulated_cancelled', 'dead_letter'
  )),
  idempotency_key text NOT NULL CHECK (
    idempotency_key = btrim(idempotency_key)
    AND length(idempotency_key) BETWEEN 1 AND 200
  ),
  correlation_id uuid NOT NULL,
  attempt_count smallint NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 4),
  reconciliation_count smallint NOT NULL DEFAULT 0
    CHECK (reconciliation_count BETWEEN 0 AND 4),
  max_attempts smallint NOT NULL CHECK (max_attempts BETWEEN 1 AND 4),
  next_attempt_at timestamptz NOT NULL,
  lease_token_hash bytea CHECK (
    lease_token_hash IS NULL OR octet_length(lease_token_hash) = 32
  ),
  lease_version bigint NOT NULL DEFAULT 0 CHECK (lease_version >= 0),
  lease_worker_id uuid,
  lease_expires_at timestamptz,
  test_reference text CHECK (
    test_reference IS NULL OR test_reference ~ '^social_test_ref_[a-f0-9]{32}$'
  ),
  last_error_code text CHECK (
    last_error_code IS NULL OR last_error_code ~ '^[a-z][a-z0-9_.:-]{0,99}$'
  ),
  last_summary text CHECK (
    last_summary IS NULL OR (
      last_summary = btrim(last_summary) AND length(last_summary) BETWEEN 1 AND 500
    )
  ),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  completed_at timestamptz,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, id, post_id, target_id),
  UNIQUE (workspace_id, post_id, target_id),
  UNIQUE (workspace_id, idempotency_key),
  FOREIGN KEY (workspace_id, post_id)
    REFERENCES app.public_social_posts (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (
    workspace_id, target_id, provider_connection_id, network, environment
  ) REFERENCES app.public_social_targets (
    workspace_id, id, provider_connection_id, network, environment
  ) ON DELETE RESTRICT,
  CHECK (attempt_count <= max_attempts),
  CHECK (reconciliation_count <= max_attempts),
  CHECK (
    (state IN ('leased', 'calling_simulator')) =
    (lease_token_hash IS NOT NULL AND lease_worker_id IS NOT NULL
      AND lease_expires_at IS NOT NULL)
  ),
  CHECK (
    (state IN (
      'simulated_succeeded', 'simulated_failed', 'simulated_reconciled',
      'simulated_cancelled', 'dead_letter'
    )) = (completed_at IS NOT NULL)
  ),
  CHECK (completed_at IS NULL OR completed_at >= created_at),
  CHECK (updated_at >= created_at)
);

CREATE INDEX public_social_operations_claim_idx
  ON app.public_social_operations (state, next_attempt_at, created_at, id)
  WHERE state IN (
    'waiting_for_test_time', 'leased', 'calling_simulator',
    'retry_wait', 'reconciliation_required'
  );

CREATE TABLE app.public_social_operation_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  operation_id uuid NOT NULL,
  attempt_number smallint NOT NULL CHECK (attempt_number BETWEEN 1 AND 4),
  attempt_kind text NOT NULL CHECK (attempt_kind IN ('simulation', 'reconcile')),
  worker_id uuid NOT NULL,
  lease_version bigint NOT NULL CHECK (lease_version > 0),
  state text NOT NULL CHECK (state IN (
    'leased', 'calling', 'succeeded', 'failed', 'needs_attention'
  )),
  retryable boolean,
  error_code text CHECK (
    error_code IS NULL OR error_code ~ '^[a-z][a-z0-9_.:-]{0,99}$'
  ),
  safe_summary text CHECK (
    safe_summary IS NULL OR (
      safe_summary = btrim(safe_summary) AND length(safe_summary) BETWEEN 1 AND 500
    )
  ),
  provider_occurred_at timestamptz,
  phase text GENERATED ALWAYS AS (
    CASE WHEN state IN ('leased', 'calling') THEN state ELSE 'completed' END
  ) STORED,
  started_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  completed_at timestamptz,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, operation_id, attempt_kind, attempt_number, phase),
  UNIQUE (workspace_id, operation_id, lease_version, phase),
  FOREIGN KEY (workspace_id, operation_id)
    REFERENCES app.public_social_operations (workspace_id, id) ON DELETE RESTRICT,
  CHECK (completed_at IS NULL OR completed_at >= started_at),
  CHECK ((state IN ('leased', 'calling')) = (completed_at IS NULL))
);

CREATE TABLE app.public_social_operation_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  operation_id uuid NOT NULL,
  post_id uuid NOT NULL,
  target_id uuid NOT NULL,
  source_kind text NOT NULL CHECK (
    source_kind IN ('test_provider', 'worker_reconcile')
  ),
  external_event_id text NOT NULL CHECK (
    external_event_id = btrim(external_event_id)
    AND length(external_event_id) BETWEEN 1 AND 500
  ),
  payload_sha256 bytea NOT NULL CHECK (octet_length(payload_sha256) = 32),
  outcome text NOT NULL CHECK (outcome IN (
    'simulated_succeeded', 'simulated_failed', 'simulated_reconciled'
  )),
  error_code text CHECK (
    error_code IS NULL OR error_code ~ '^[a-z][a-z0-9_.:-]{0,99}$'
  ),
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, operation_id, source_kind, external_event_id),
  FOREIGN KEY (workspace_id, operation_id, post_id, target_id)
    REFERENCES app.public_social_operations (workspace_id, id, post_id, target_id)
    ON DELETE RESTRICT,
  CHECK (occurred_at >= received_at - interval '5 minutes'),
  CHECK (occurred_at <= received_at + interval '30 seconds')
);

CREATE TABLE app.public_social_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  campaign_id uuid,
  campaign_revision_id uuid,
  post_id uuid,
  target_id uuid,
  operation_id uuid,
  event_kind text NOT NULL CHECK (event_kind IN (
    'campaign_revision_created', 'target_registered', 'post_scheduled',
    'operation_leased', 'operation_calling', 'retry_planned',
    'reconciliation_required', 'simulated_succeeded', 'simulated_failed',
    'simulated_reconciled', 'simulated_cancelled', 'dead_letter'
  )),
  actor_kind text NOT NULL CHECK (actor_kind IN ('user', 'worker', 'system')),
  actor_user_id uuid,
  request_id text CHECK (
    request_id IS NULL OR (
      request_id = btrim(request_id) AND length(request_id) BETWEEN 1 AND 128
    )
  ),
  reason_sha256 bytea CHECK (
    reason_sha256 IS NULL OR octet_length(reason_sha256) = 32
  ),
  occurred_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, campaign_id)
    REFERENCES app.public_social_campaigns (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, campaign_revision_id)
    REFERENCES app.public_social_campaign_revisions (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, post_id)
    REFERENCES app.public_social_posts (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, target_id)
    REFERENCES app.public_social_targets (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, operation_id)
    REFERENCES app.public_social_operations (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, actor_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK ((actor_kind = 'user') = (actor_user_id IS NOT NULL)),
  CHECK ((actor_kind = 'user') = (request_id IS NOT NULL))
);

CREATE UNIQUE INDEX public_social_events_one_cancellation_per_operation_uq
  ON app.public_social_events (workspace_id, operation_id)
  WHERE event_kind = 'simulated_cancelled';

CREATE FUNCTION app_private.reject_public_social_mutation()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $function$
BEGIN
  RAISE EXCEPTION 'public-social evidence is append-only' USING ERRCODE = '55000';
END;
$function$;
REVOKE ALL ON FUNCTION app_private.reject_public_social_mutation() FROM PUBLIC;

DO $immutable_triggers$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'public_social_campaigns', 'public_social_campaign_revisions',
    'public_social_targets', 'public_social_posts', 'public_social_post_media',
    'public_social_operation_attempts', 'public_social_operation_receipts',
    'public_social_events'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON app.%I
       FOR EACH ROW EXECUTE FUNCTION app_private.reject_public_social_mutation()',
      table_name || '_immutable', table_name
    );
  END LOOP;
END
$immutable_triggers$;

DO $rls$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'public_social_campaigns', 'public_social_campaign_revisions',
    'public_social_targets', 'public_social_posts', 'public_social_post_media',
    'public_social_operations', 'public_social_operation_attempts',
    'public_social_operation_receipts', 'public_social_events'
  ] LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON app.%I FOR ALL TO r72_owner USING (true) WITH CHECK (true)',
      table_name || '_owner_all', table_name
    );
    EXECUTE format(
      'CREATE POLICY %I ON app.%I FOR ALL TO r72_public_social_definer
       USING (true) WITH CHECK (true)',
      table_name || '_definer_all', table_name
    );
  END LOOP;
END
$rls$;

CREATE POLICY provider_connections_public_social_definer_select
  ON app.provider_connections FOR SELECT TO r72_public_social_definer
  USING (
    provider_id = 'public_social_dark_simulator'
    AND provider_kind = 'social' AND environment = 'test'
  );
CREATE POLICY company_content_items_public_social_definer_select
  ON app.company_content_items FOR SELECT TO r72_public_social_definer USING (true);
CREATE POLICY company_content_versions_public_social_definer_select
  ON app.company_content_versions FOR SELECT TO r72_public_social_definer USING (true);
CREATE POLICY company_content_attestations_public_social_definer_select
  ON app.company_content_source_attestations
  FOR SELECT TO r72_public_social_definer USING (true);
CREATE POLICY company_content_approval_requests_public_social_definer_select
  ON app.company_content_approval_requests
  FOR SELECT TO r72_public_social_definer USING (true);
CREATE POLICY company_content_approval_decisions_public_social_definer_select
  ON app.company_content_approval_decisions
  FOR SELECT TO r72_public_social_definer USING (true);

GRANT USAGE ON SCHEMA app, app_private TO r72_public_social_definer;
GRANT SELECT ON app.provider_connections, app.company_content_items,
  app.company_content_versions, app.company_content_source_attestations,
  app.company_content_approval_requests, app.company_content_approval_decisions
TO r72_public_social_definer;
GRANT SELECT, INSERT ON app.public_social_campaigns,
  app.public_social_campaign_revisions, app.public_social_targets,
  app.public_social_posts, app.public_social_post_media,
  app.public_social_operation_attempts, app.public_social_operation_receipts,
  app.public_social_events
TO r72_public_social_definer;
GRANT SELECT, INSERT, UPDATE ON app.public_social_operations
TO r72_public_social_definer;
GRANT EXECUTE ON FUNCTION app_private.current_workspace_id(),
  app_private.current_user_id(), app_private.current_request_id(),
  app_private.has_active_workspace_membership(uuid, uuid),
  app_private.can_write_workspace(uuid, uuid),
  app_private.can_manage_workspace(uuid, uuid)
TO r72_public_social_definer;

GRANT CREATE ON SCHEMA app_private TO r72_public_social_definer;
SET LOCAL ROLE r72_public_social_definer;

CREATE FUNCTION app_private.assert_public_social_manager(p_workspace_id uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog
AS $function$
DECLARE
  context_workspace uuid := app_private.current_workspace_id();
  context_user uuid := app_private.current_user_id();
BEGIN
  IF p_workspace_id IS NULL OR context_workspace IS DISTINCT FROM p_workspace_id
     OR context_user IS NULL
     OR NOT app_private.can_manage_workspace(context_user, p_workspace_id) THEN
    RAISE EXCEPTION 'public-social manager context is invalid' USING ERRCODE = '42501';
  END IF;
END;
$function$;

CREATE FUNCTION app_private.public_social_display_text_supported(p_text text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT p_text IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM unnest(ARRAY[
        1, 2, 3, 4, 5, 6, 7, 8, 11, 12,
        14, 15, 16, 17, 18, 19, 20, 21, 22, 23,
        24, 25, 26, 27, 28, 29, 30, 31, 127,
        8234, 8235, 8236, 8237, 8238, 8294, 8295, 8296, 8297
      ]) AS forbidden(codepoint)
      WHERE pg_catalog.strpos(p_text, pg_catalog.chr(forbidden.codepoint)) > 0
    );
$function$;

CREATE FUNCTION app_private.public_social_body_supported(p_body text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT p_body IS NOT NULL
    AND pg_catalog.octet_length(p_body) BETWEEN 1 AND 16384
    AND NOT EXISTS (
      SELECT 1
      FROM unnest(ARRAY[
        1, 2, 3, 4, 5, 6, 7, 8, 11, 12,
        14, 15, 16, 17, 18, 19, 20, 21, 22, 23,
        24, 25, 26, 27, 28, 29, 30, 31, 127,
        8234, 8235, 8236, 8237, 8238, 8294, 8295, 8296, 8297
      ]) AS forbidden(codepoint)
      WHERE pg_catalog.strpos(p_body, pg_catalog.chr(forbidden.codepoint)) > 0
    );
$function$;

CREATE FUNCTION app_private.public_social_media_payload_supported(
  p_blob_storage_key text,
  p_content_mime_type text
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT p_blob_storage_key IS NOT NULL
    AND p_blob_storage_key ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,499}$'
    AND pg_catalog.strpos(p_blob_storage_key, '..') = 0
    AND pg_catalog.strpos(p_blob_storage_key, '//') = 0
    AND p_content_mime_type IS NOT NULL
    AND p_content_mime_type ~ '^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$';
$function$;

CREATE FUNCTION app_private.assert_public_social_content(
  p_workspace_id uuid,
  p_content_item_id uuid,
  p_content_version_id uuid,
  p_content_sha256 bytea,
  p_approval_request_id uuid,
  p_approval_decision_id uuid,
  p_source_attestation_id uuid,
  p_required_valid_at timestamptz,
  p_media boolean,
  p_blob_sha256 bytea DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog
AS $function$
BEGIN
  IF p_workspace_id IS NULL OR p_content_item_id IS NULL
     OR p_content_version_id IS NULL OR p_approval_request_id IS NULL
     OR p_approval_decision_id IS NULL OR p_source_attestation_id IS NULL
     OR p_required_valid_at IS NULL
     OR p_content_sha256 IS NULL OR octet_length(p_content_sha256) <> 32
     OR (p_media AND (p_blob_sha256 IS NULL OR octet_length(p_blob_sha256) <> 32))
     OR (NOT p_media AND p_blob_sha256 IS NOT NULL) THEN
    RAISE EXCEPTION 'public-social content evidence is invalid' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM app.company_content_source_attestations AS bounded_attestation
    WHERE bounded_attestation.workspace_id = p_workspace_id
      AND bounded_attestation.id = p_source_attestation_id
      AND bounded_attestation.content_item_id = p_content_item_id
      AND bounded_attestation.content_version_id = p_content_version_id
      AND bounded_attestation.content_sha256 = p_content_sha256
      AND (NOT p_media OR bounded_attestation.blob_sha256 = p_blob_sha256)
      AND bounded_attestation.expires_at <= p_required_valid_at
  ) THEN
    RAISE EXCEPTION 'exact public-social source proof does not cover the scheduled time'
      USING ERRCODE = 'P0039';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM app.company_content_versions AS version
    JOIN app.company_content_approval_requests AS request
      ON request.workspace_id = version.workspace_id
     AND request.content_item_id = version.content_item_id
     AND request.content_version_id = version.id
     AND request.content_sha256 = version.content_sha256
     AND request.id = p_approval_request_id
    JOIN app.company_content_approval_decisions AS decision
      ON decision.workspace_id = request.workspace_id
     AND decision.content_item_id = request.content_item_id
     AND decision.content_version_id = request.content_version_id
     AND decision.approval_request_id = request.id
     AND decision.content_sha256 = request.content_sha256
     AND decision.id = p_approval_decision_id
     AND decision.decision = 'approved'
    JOIN app.company_content_source_attestations AS attestation
      ON attestation.workspace_id = version.workspace_id
     AND attestation.content_item_id = version.content_item_id
     AND attestation.content_version_id = version.id
     AND attestation.content_sha256 = version.content_sha256
     AND attestation.blob_sha256 = version.blob_sha256
     AND attestation.brand_sha256 = version.brand_sha256
     AND attestation.id = p_source_attestation_id
    WHERE version.workspace_id = p_workspace_id
      AND version.content_item_id = p_content_item_id
      AND version.id = p_content_version_id
      AND version.content_sha256 = p_content_sha256
      AND public.digest(version.content_body, 'sha256') = version.content_sha256
      AND app_private.public_social_body_supported(version.content_body)
      AND ((NOT p_media AND version.content_kind = 'social_post')
        OR (p_media AND version.content_kind IN ('image', 'video')
          AND version.blob_sha256 = p_blob_sha256
          AND app_private.public_social_media_payload_supported(
            version.blob_storage_key, version.content_mime_type
          )))
      AND attestation.checked_at <= statement_timestamp()
      AND attestation.expires_at > statement_timestamp()
      AND attestation.expires_at > p_required_valid_at
      AND NOT EXISTS (
        SELECT 1 FROM app.company_content_versions AS newer
        WHERE newer.workspace_id = version.workspace_id
          AND newer.content_item_id = version.content_item_id
          AND newer.version_number > version.version_number
      )
  ) THEN
    RAISE EXCEPTION 'public-social content is stale, unapproved or unverified'
      USING ERRCODE = '42501';
  END IF;
END;
$function$;

CREATE FUNCTION app_private.public_social_dispatch_ready(
  p_workspace_id uuid,
  p_operation_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM app.public_social_operations AS operation
    JOIN app.public_social_posts AS post
      ON post.workspace_id = operation.workspace_id AND post.id = operation.post_id
    JOIN app.public_social_targets AS target
      ON target.workspace_id = operation.workspace_id AND target.id = operation.target_id
    JOIN app.provider_connections AS connection
      ON connection.workspace_id = target.workspace_id
     AND connection.id = target.provider_connection_id
    JOIN app.company_content_versions AS version
      ON version.workspace_id = post.workspace_id
     AND version.content_item_id = post.content_item_id
     AND version.id = post.content_version_id
     AND version.content_sha256 = post.content_sha256
    JOIN app.company_content_approval_requests AS request
      ON request.workspace_id = version.workspace_id
     AND request.content_item_id = version.content_item_id
     AND request.content_version_id = version.id
     AND request.content_sha256 = version.content_sha256
     AND request.id = post.approval_request_id
    JOIN app.company_content_approval_decisions AS decision
      ON decision.workspace_id = request.workspace_id
     AND decision.approval_request_id = request.id
     AND decision.id = post.approval_decision_id
     AND decision.decision = 'approved'
    WHERE operation.workspace_id = p_workspace_id
      AND operation.id = p_operation_id
      AND operation.environment = 'test'
      AND operation.execution_mode = 'simulated_test_only'
      AND target.environment = 'test'
      AND connection.provider_id = 'public_social_dark_simulator'
      AND connection.provider_kind = 'social'
      AND connection.environment = 'test'
      AND connection.status = 'active'
      AND version.content_kind = 'social_post'
      AND public.digest(version.content_body, 'sha256') = post.content_sha256
      AND app_private.public_social_body_supported(version.content_body)
      AND NOT EXISTS (
        SELECT 1 FROM app.company_content_versions AS newer
        WHERE newer.workspace_id = version.workspace_id
          AND newer.content_item_id = version.content_item_id
          AND newer.version_number > version.version_number
      )
      AND EXISTS (
        SELECT 1 FROM app.company_content_source_attestations AS fresh
        WHERE fresh.workspace_id = version.workspace_id
          AND fresh.content_item_id = version.content_item_id
          AND fresh.content_version_id = version.id
          AND fresh.id = post.scheduled_source_attestation_id
          AND fresh.content_sha256 = version.content_sha256
          AND fresh.blob_sha256 = version.blob_sha256
          AND fresh.brand_sha256 = version.brand_sha256
          AND fresh.checked_at <= statement_timestamp()
          AND fresh.expires_at > statement_timestamp()
      )
      AND NOT EXISTS (
        SELECT 1
        FROM app.public_social_post_media AS media
        JOIN app.company_content_versions AS media_version
          ON media_version.workspace_id = media.workspace_id
         AND media_version.content_item_id = media.content_item_id
         AND media_version.id = media.content_version_id
         AND media_version.content_sha256 = media.content_sha256
         AND media_version.blob_sha256 = media.blob_sha256
        LEFT JOIN app.company_content_approval_requests AS media_request
          ON media_request.workspace_id = media.workspace_id
         AND media_request.id = media.approval_request_id
         AND media_request.content_item_id = media.content_item_id
         AND media_request.content_version_id = media.content_version_id
         AND media_request.content_sha256 = media.content_sha256
        LEFT JOIN app.company_content_approval_decisions AS media_decision
          ON media_decision.workspace_id = media.workspace_id
         AND media_decision.id = media.approval_decision_id
         AND media_decision.approval_request_id = media.approval_request_id
         AND media_decision.decision = 'approved'
        WHERE media.workspace_id = post.workspace_id AND media.post_id = post.id
          AND (
            media_version.content_kind NOT IN ('image', 'video')
            OR NOT app_private.public_social_media_payload_supported(
              media_version.blob_storage_key, media_version.content_mime_type
            )
            OR media_request.id IS NULL OR media_decision.id IS NULL
            OR EXISTS (
              SELECT 1 FROM app.company_content_versions AS newer_media
              WHERE newer_media.workspace_id = media_version.workspace_id
                AND newer_media.content_item_id = media_version.content_item_id
                AND newer_media.version_number > media_version.version_number
            )
            OR NOT EXISTS (
              SELECT 1 FROM app.company_content_source_attestations AS fresh_media
              WHERE fresh_media.workspace_id = media_version.workspace_id
                AND fresh_media.content_item_id = media_version.content_item_id
                AND fresh_media.content_version_id = media_version.id
                AND fresh_media.id = media.scheduled_source_attestation_id
                AND fresh_media.content_sha256 = media_version.content_sha256
                AND fresh_media.blob_sha256 = media_version.blob_sha256
                AND fresh_media.brand_sha256 = media_version.brand_sha256
                AND fresh_media.checked_at <= statement_timestamp()
                AND fresh_media.expires_at > statement_timestamp()
            )
          )
      )
  );
$function$;

CREATE FUNCTION app_private.public_social_revision_sha256(
  p_workspace_id uuid,
  p_campaign_id uuid,
  p_revision_id uuid,
  p_revision_number integer,
  p_previous_revision_id uuid,
  p_title text,
  p_objective text,
  p_timezone text
)
RETURNS bytea
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT public.digest(
    'public-social-revision/v1' || pg_catalog.chr(10)
    || pg_catalog.octet_length(p_workspace_id::text)::text || ':' || p_workspace_id::text
    || pg_catalog.chr(10)
    || pg_catalog.octet_length(p_campaign_id::text)::text || ':' || p_campaign_id::text
    || pg_catalog.chr(10)
    || pg_catalog.octet_length(p_revision_id::text)::text || ':' || p_revision_id::text
    || pg_catalog.chr(10)
    || pg_catalog.octet_length(p_revision_number::text)::text || ':' || p_revision_number::text
    || pg_catalog.chr(10)
    || CASE WHEN p_previous_revision_id IS NULL THEN '-1:' ELSE
      pg_catalog.octet_length(p_previous_revision_id::text)::text || ':'
      || p_previous_revision_id::text END
    || pg_catalog.chr(10)
    || pg_catalog.octet_length(p_title)::text || ':' || p_title
    || pg_catalog.chr(10)
    || pg_catalog.octet_length(p_objective)::text || ':' || p_objective
    || pg_catalog.chr(10)
    || pg_catalog.octet_length(p_timezone)::text || ':' || p_timezone,
    'sha256'
  );
$function$;

CREATE FUNCTION app_private.create_test_social_campaign_revision(
  p_workspace_id uuid,
  p_campaign_id uuid,
  p_revision_id uuid,
  p_revision_number integer,
  p_previous_revision_id uuid,
  p_title text,
  p_objective text,
  p_timezone text,
  p_revision_sha256 bytea
)
RETURNS TABLE (
  campaign_id uuid,
  revision_id uuid,
  revision_number integer,
  disposition text
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  actor_id uuid;
  request_id text;
  existing app.public_social_campaign_revisions%ROWTYPE;
  latest_revision integer;
  selected_campaign_key text;
BEGIN
  PERFORM app_private.assert_public_social_manager(p_workspace_id);
  actor_id := app_private.current_user_id();
  request_id := app_private.current_request_id();
  selected_campaign_key := 'campaign-' || p_campaign_id::text;

  IF p_campaign_id IS NULL OR p_revision_id IS NULL
     OR p_revision_number IS NULL OR p_revision_number < 1
     OR p_title IS NULL OR p_title <> btrim(p_title)
     OR length(p_title) NOT BETWEEN 1 AND 200
     OR NOT app_private.public_social_display_text_supported(p_title)
     OR p_objective IS NULL OR p_objective <> btrim(p_objective)
     OR length(p_objective) NOT BETWEEN 1 AND 2000
     OR NOT app_private.public_social_display_text_supported(p_objective)
     OR p_timezone IS NULL OR p_timezone <> btrim(p_timezone)
     OR length(p_timezone) NOT BETWEEN 1 AND 100
     OR p_revision_sha256 IS NULL OR octet_length(p_revision_sha256) <> 32
     OR p_revision_sha256 IS DISTINCT FROM app_private.public_social_revision_sha256(
       p_workspace_id, p_campaign_id, p_revision_id, p_revision_number,
       p_previous_revision_id, p_title, p_objective, p_timezone
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_timezone_names AS zone
       WHERE zone.name = p_timezone
     ) THEN
    RAISE EXCEPTION 'invalid TEST public-social campaign revision' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public-social-campaign:' || p_workspace_id::text || ':' || p_campaign_id::text,
      7200039
    )
  );

  SELECT revision.* INTO existing
  FROM app.public_social_campaign_revisions AS revision
  WHERE revision.workspace_id = p_workspace_id AND revision.id = p_revision_id;
  IF FOUND THEN
    IF existing.campaign_id IS DISTINCT FROM p_campaign_id
       OR existing.revision_number IS DISTINCT FROM p_revision_number
       OR existing.previous_revision_id IS DISTINCT FROM p_previous_revision_id
       OR existing.title IS DISTINCT FROM p_title
       OR existing.objective IS DISTINCT FROM p_objective
       OR existing.timezone IS DISTINCT FROM p_timezone
       OR existing.revision_sha256 IS DISTINCT FROM p_revision_sha256 THEN
      RAISE EXCEPTION 'campaign revision id was reused with different evidence'
        USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT p_campaign_id, p_revision_id, p_revision_number, 'replayed'::text;
    RETURN;
  END IF;

  INSERT INTO app.public_social_campaigns (
    id, workspace_id, campaign_key, created_by_user_id, created_request_id
  ) VALUES (
    p_campaign_id, p_workspace_id, selected_campaign_key, actor_id, request_id
  ) ON CONFLICT (workspace_id, id) DO NOTHING;

  IF NOT EXISTS (
    SELECT 1 FROM app.public_social_campaigns AS campaign
    WHERE campaign.workspace_id = p_workspace_id
      AND campaign.id = p_campaign_id
      AND campaign.campaign_key = selected_campaign_key
  ) THEN
    RAISE EXCEPTION 'campaign id was reused with different evidence' USING ERRCODE = '23505';
  END IF;

  SELECT max(revision.revision_number) INTO latest_revision
  FROM app.public_social_campaign_revisions AS revision
  WHERE revision.workspace_id = p_workspace_id
    AND revision.campaign_id = p_campaign_id;
  IF latest_revision IS NULL THEN
    IF p_revision_number <> 1 OR p_previous_revision_id IS NOT NULL THEN
      RAISE EXCEPTION 'first campaign revision must be revision 1' USING ERRCODE = '40001';
    END IF;
  ELSIF p_revision_number <> latest_revision + 1 OR NOT EXISTS (
    SELECT 1 FROM app.public_social_campaign_revisions AS previous
    WHERE previous.workspace_id = p_workspace_id
      AND previous.campaign_id = p_campaign_id
      AND previous.id = p_previous_revision_id
      AND previous.revision_number = latest_revision
  ) THEN
    RAISE EXCEPTION 'campaign revisions must extend the exact latest revision'
      USING ERRCODE = '40001';
  END IF;

  INSERT INTO app.public_social_campaign_revisions (
    id, workspace_id, campaign_id, revision_number, previous_revision_id,
    title, objective, timezone, revision_sha256,
    created_by_user_id, created_request_id
  ) VALUES (
    p_revision_id, p_workspace_id, p_campaign_id, p_revision_number,
    p_previous_revision_id, p_title, p_objective, p_timezone,
    p_revision_sha256, actor_id, request_id
  );
  INSERT INTO app.public_social_events (
    workspace_id, campaign_id, campaign_revision_id, event_kind,
    actor_kind, actor_user_id, request_id
  ) VALUES (
    p_workspace_id, p_campaign_id, p_revision_id,
    'campaign_revision_created', 'user', actor_id, request_id
  );
  RETURN QUERY SELECT p_campaign_id, p_revision_id, p_revision_number, 'applied'::text;
END;
$function$;

CREATE FUNCTION app_private.register_test_social_campaign_target(
  p_workspace_id uuid,
  p_target_id uuid,
  p_provider_connection_id uuid,
  p_network text,
  p_test_account_ref text,
  p_display_name text
)
RETURNS TABLE (target_id uuid, disposition text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  actor_id uuid;
  request_id text;
  existing app.public_social_targets%ROWTYPE;
BEGIN
  PERFORM app_private.assert_public_social_manager(p_workspace_id);
  actor_id := app_private.current_user_id();
  request_id := app_private.current_request_id();
  IF p_target_id IS NULL OR p_provider_connection_id IS NULL
     OR p_network NOT IN (
       'facebook', 'instagram', 'linkedin', 'tiktok', 'x', 'youtube',
       'google_business_profile', 'threads', 'pinterest'
     )
     OR p_test_account_ref IS NULL OR p_test_account_ref <> btrim(p_test_account_ref)
     OR length(p_test_account_ref) NOT BETWEEN 1 AND 128
     OR p_test_account_ref !~ '^test-account:[a-z_]+:[a-z0-9_-]{1,64}$'
     OR p_test_account_ref NOT LIKE 'test-account:' || p_network || ':%'
     OR p_display_name IS NULL OR p_display_name <> btrim(p_display_name)
     OR length(p_display_name) NOT BETWEEN 1 AND 120
     OR NOT app_private.public_social_display_text_supported(p_display_name) THEN
    RAISE EXCEPTION 'invalid TEST public-social target' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public-social-target:' || p_workspace_id::text || ':' || p_target_id::text,
      7200039
    )
  );
  SELECT target.* INTO existing FROM app.public_social_targets AS target
  WHERE target.workspace_id = p_workspace_id AND target.id = p_target_id;
  IF FOUND THEN
    IF existing.provider_connection_id IS DISTINCT FROM p_provider_connection_id
       OR existing.network IS DISTINCT FROM p_network
       OR existing.test_account_ref IS DISTINCT FROM p_test_account_ref
       OR existing.display_name IS DISTINCT FROM p_display_name THEN
      RAISE EXCEPTION 'target id was reused with different evidence' USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT p_target_id, 'replayed'::text;
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM app.provider_connections AS connection
    WHERE connection.workspace_id = p_workspace_id
      AND connection.id = p_provider_connection_id
      AND connection.provider_id = 'public_social_dark_simulator'
      AND connection.provider_kind = 'social'
      AND connection.environment = 'test' AND connection.status = 'active'
  ) THEN
    RAISE EXCEPTION 'TEST public-social provider connection is unavailable'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO app.public_social_targets (
    id, workspace_id, provider_connection_id, network, environment,
    test_account_ref, display_name, created_by_user_id, created_request_id
  ) VALUES (
    p_target_id, p_workspace_id, p_provider_connection_id, p_network, 'test',
    p_test_account_ref, p_display_name, actor_id, request_id
  );
  INSERT INTO app.public_social_events (
    workspace_id, target_id, event_kind, actor_kind, actor_user_id, request_id
  ) VALUES (
    p_workspace_id, p_target_id, 'target_registered', 'user', actor_id, request_id
  );
  RETURN QUERY SELECT p_target_id, 'applied'::text;
END;
$function$;

CREATE FUNCTION app_private.resolve_test_social_campaign_targets(
  p_workspace_id uuid,
  p_target_ids uuid[]
)
RETURNS TABLE (
  ordinal integer,
  target_id uuid,
  network text,
  test_account_ref text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  target_count integer;
  distinct_target_count integer;
  resolved_count integer;
BEGIN
  PERFORM app_private.assert_public_social_manager(p_workspace_id);
  IF p_target_ids IS NULL OR cardinality(p_target_ids) NOT BETWEEN 1 AND 9
     OR array_position(p_target_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'invalid TEST public-social target resolution'
      USING ERRCODE = '22023';
  END IF;
  SELECT count(*), count(DISTINCT candidate)
    INTO target_count, distinct_target_count
  FROM unnest(p_target_ids) AS candidate;
  IF target_count <> distinct_target_count THEN
    RAISE EXCEPTION 'public-social targets must be unique' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT requested.input_ordinal::integer, target.id, target.network,
    target.test_account_ref
  FROM unnest(p_target_ids) WITH ORDINALITY AS requested(requested_target_id, input_ordinal)
  JOIN app.public_social_targets AS target
    ON target.workspace_id = p_workspace_id AND target.id = requested.requested_target_id
  JOIN app.provider_connections AS connection
    ON connection.workspace_id = target.workspace_id
   AND connection.id = target.provider_connection_id
  WHERE target.environment = 'test'
    AND connection.provider_id = 'public_social_dark_simulator'
    AND connection.provider_kind = 'social'
    AND connection.environment = 'test'
    AND connection.status = 'active'
  ORDER BY requested.input_ordinal;
  GET DIAGNOSTICS resolved_count = ROW_COUNT;
  IF resolved_count <> target_count THEN
    RAISE EXCEPTION 'one or more TEST public-social targets are unavailable'
      USING ERRCODE = '42501';
  END IF;
END;
$function$;

CREATE FUNCTION app_private.schedule_test_social_campaign(
  p_workspace_id uuid,
  p_post_id uuid,
  p_campaign_id uuid,
  p_revision_id uuid,
  p_content_item_id uuid,
  p_content_version_id uuid,
  p_content_sha256 bytea,
  p_approval_request_id uuid,
  p_approval_decision_id uuid,
  p_source_attestation_id uuid,
  p_scheduled_for timestamptz,
  p_max_attempts smallint,
  p_plan_sha256 bytea,
  p_target_ids uuid[],
  p_media jsonb DEFAULT '[]'::jsonb
)
RETURNS TABLE (post_id uuid, operation_ids uuid[], disposition text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  actor_id uuid;
  request_id text;
  existing app.public_social_posts%ROWTYPE;
  existing_target_ids uuid[];
  existing_media jsonb;
  inserted_operation_ids uuid[];
  target_count integer;
  distinct_target_count integer;
  media_entry jsonb;
  media_ordinal integer;
  media_item_id uuid;
  media_version_id uuid;
  media_content_sha256 bytea;
  media_blob_sha256 bytea;
  media_request_id uuid;
  media_decision_id uuid;
  media_attestation_id uuid;
BEGIN
  PERFORM app_private.assert_public_social_manager(p_workspace_id);
  actor_id := app_private.current_user_id();
  request_id := app_private.current_request_id();
  IF p_post_id IS NULL OR p_campaign_id IS NULL OR p_revision_id IS NULL
     OR p_scheduled_for IS NULL
     OR p_max_attempts IS NULL OR p_max_attempts NOT BETWEEN 1 AND 4
     OR p_plan_sha256 IS NULL OR octet_length(p_plan_sha256) <> 32
     OR p_target_ids IS NULL OR cardinality(p_target_ids) NOT BETWEEN 1 AND 9
     OR array_position(p_target_ids, NULL) IS NOT NULL
     OR p_media IS NULL OR jsonb_typeof(p_media) <> 'array'
     OR jsonb_array_length(p_media) > 10 THEN
    RAISE EXCEPTION 'invalid TEST public-social schedule' USING ERRCODE = '22023';
  END IF;
  SELECT count(*), count(DISTINCT candidate)
    INTO target_count, distinct_target_count
  FROM unnest(p_target_ids) AS candidate;
  IF target_count <> distinct_target_count THEN
    RAISE EXCEPTION 'public-social targets must be unique' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public-social-post:' || p_workspace_id::text || ':' || p_post_id::text,
      7200039
    )
  );
  SELECT post.* INTO existing FROM app.public_social_posts AS post
  WHERE post.workspace_id = p_workspace_id AND post.id = p_post_id;
  IF FOUND THEN
    SELECT array_agg(operation.target_id ORDER BY operation.target_id)
      INTO existing_target_ids
    FROM app.public_social_operations AS operation
    WHERE operation.workspace_id = p_workspace_id AND operation.post_id = p_post_id;
    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'contentItemId', media.content_item_id::text,
          'contentVersionId', media.content_version_id::text,
          'contentSha256', encode(media.content_sha256, 'hex'),
          'blobSha256', encode(media.blob_sha256, 'hex'),
          'approvalRequestId', media.approval_request_id::text,
          'approvalDecisionId', media.approval_decision_id::text,
          'sourceAttestationId', media.scheduled_source_attestation_id::text
        ) ORDER BY media.ordinal
      ),
      '[]'::jsonb
    ) INTO existing_media
    FROM app.public_social_post_media AS media
    WHERE media.workspace_id = p_workspace_id AND media.post_id = p_post_id;
    IF existing.campaign_id IS DISTINCT FROM p_campaign_id
       OR existing.campaign_revision_id IS DISTINCT FROM p_revision_id
       OR existing.content_item_id IS DISTINCT FROM p_content_item_id
       OR existing.content_version_id IS DISTINCT FROM p_content_version_id
       OR existing.content_sha256 IS DISTINCT FROM p_content_sha256
       OR existing.approval_request_id IS DISTINCT FROM p_approval_request_id
       OR existing.approval_decision_id IS DISTINCT FROM p_approval_decision_id
       OR existing.scheduled_source_attestation_id IS DISTINCT FROM p_source_attestation_id
       OR existing.scheduled_for IS DISTINCT FROM p_scheduled_for
       OR existing.max_attempts IS DISTINCT FROM p_max_attempts
       OR existing.plan_sha256 IS DISTINCT FROM p_plan_sha256
       OR existing_media IS DISTINCT FROM p_media
       OR existing_target_ids IS DISTINCT FROM (
         SELECT array_agg(candidate ORDER BY candidate) FROM unnest(p_target_ids) AS candidate
       ) THEN
      RAISE EXCEPTION 'post id was reused with different schedule evidence'
        USING ERRCODE = '23505';
    END IF;
    SELECT array_agg(operation.id ORDER BY operation.target_id)
      INTO inserted_operation_ids
    FROM app.public_social_operations AS operation
    WHERE operation.workspace_id = p_workspace_id AND operation.post_id = p_post_id;
    RETURN QUERY SELECT p_post_id, inserted_operation_ids, 'replayed'::text;
    RETURN;
  END IF;

  IF p_scheduled_for < statement_timestamp() - interval '5 seconds'
     OR p_scheduled_for > statement_timestamp() + interval '366 days' THEN
    RAISE EXCEPTION 'invalid TEST public-social schedule' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app.public_social_campaign_revisions AS revision
    WHERE revision.workspace_id = p_workspace_id
      AND revision.campaign_id = p_campaign_id AND revision.id = p_revision_id
  ) THEN
    RAISE EXCEPTION 'public-social campaign revision was not found' USING ERRCODE = '23503';
  END IF;
  IF (
    SELECT count(*) FROM app.public_social_targets AS target
    JOIN app.provider_connections AS connection
      ON connection.workspace_id = target.workspace_id
     AND connection.id = target.provider_connection_id
    WHERE target.workspace_id = p_workspace_id
      AND target.id = ANY(p_target_ids)
      AND target.environment = 'test'
      AND connection.provider_id = 'public_social_dark_simulator'
      AND connection.provider_kind = 'social'
      AND connection.environment = 'test' AND connection.status = 'active'
  ) <> target_count THEN
    RAISE EXCEPTION 'one or more TEST public-social targets are unavailable'
      USING ERRCODE = '42501';
  END IF;

  PERFORM app_private.assert_public_social_content(
    p_workspace_id, p_content_item_id, p_content_version_id,
    p_content_sha256, p_approval_request_id, p_approval_decision_id,
    p_source_attestation_id, p_scheduled_for, false, NULL
  );

  INSERT INTO app.public_social_posts (
    id, workspace_id, campaign_id, campaign_revision_id,
    content_item_id, content_version_id, content_sha256,
    approval_request_id, approval_decision_id, scheduled_source_attestation_id,
    scheduled_for, max_attempts, plan_sha256,
    created_by_user_id, created_request_id
  ) VALUES (
    p_post_id, p_workspace_id, p_campaign_id, p_revision_id,
    p_content_item_id, p_content_version_id, p_content_sha256,
    p_approval_request_id, p_approval_decision_id, p_source_attestation_id,
    p_scheduled_for, p_max_attempts, p_plan_sha256, actor_id, request_id
  );

  FOR media_entry, media_ordinal IN
    SELECT item.value, item.ordinality::integer
    FROM jsonb_array_elements(p_media) WITH ORDINALITY AS item(value, ordinality)
  LOOP
    IF jsonb_typeof(media_entry) <> 'object'
       OR (SELECT count(*) FROM jsonb_object_keys(media_entry)) <> 7
       OR NOT media_entry ?& ARRAY[
         'contentItemId', 'contentVersionId', 'contentSha256', 'blobSha256',
         'approvalRequestId', 'approvalDecisionId', 'sourceAttestationId'
       ]
       OR media_entry->>'contentItemId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       OR media_entry->>'contentVersionId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       OR media_entry->>'approvalRequestId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       OR media_entry->>'approvalDecisionId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       OR media_entry->>'sourceAttestationId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       OR media_entry->>'contentSha256' !~ '^[a-f0-9]{64}$'
       OR media_entry->>'blobSha256' !~ '^[a-f0-9]{64}$' THEN
      RAISE EXCEPTION 'invalid public-social media evidence' USING ERRCODE = '22023';
    END IF;
    media_item_id := (media_entry->>'contentItemId')::uuid;
    media_version_id := (media_entry->>'contentVersionId')::uuid;
    media_content_sha256 := decode(media_entry->>'contentSha256', 'hex');
    media_blob_sha256 := decode(media_entry->>'blobSha256', 'hex');
    media_request_id := (media_entry->>'approvalRequestId')::uuid;
    media_decision_id := (media_entry->>'approvalDecisionId')::uuid;
    media_attestation_id := (media_entry->>'sourceAttestationId')::uuid;
    PERFORM app_private.assert_public_social_content(
      p_workspace_id, media_item_id, media_version_id, media_content_sha256,
      media_request_id, media_decision_id, media_attestation_id,
      p_scheduled_for, true, media_blob_sha256
    );
    INSERT INTO app.public_social_post_media (
      workspace_id, post_id, ordinal, content_item_id, content_version_id,
      content_sha256, blob_sha256, approval_request_id,
      approval_decision_id, scheduled_source_attestation_id
    ) VALUES (
      p_workspace_id, p_post_id, media_ordinal, media_item_id, media_version_id,
      media_content_sha256, media_blob_sha256, media_request_id,
      media_decision_id, media_attestation_id
    );
  END LOOP;

  WITH inserted AS (
    INSERT INTO app.public_social_operations (
      workspace_id, post_id, target_id, provider_connection_id, network,
      environment, execution_mode, state, idempotency_key, correlation_id,
      attempt_count, max_attempts, next_attempt_at
    )
    SELECT p_workspace_id, p_post_id, target.id, target.provider_connection_id,
      target.network, 'test', 'simulated_test_only', 'waiting_for_test_time',
      'public-social:' || p_post_id::text || ':' || target.id::text,
      gen_random_uuid(), 0, p_max_attempts, p_scheduled_for
    FROM app.public_social_targets AS target
    WHERE target.workspace_id = p_workspace_id AND target.id = ANY(p_target_ids)
    ORDER BY target.id
    RETURNING id, target_id
  )
  SELECT array_agg(inserted.id ORDER BY inserted.target_id)
    INTO inserted_operation_ids
  FROM inserted;

  INSERT INTO app.public_social_events (
    workspace_id, campaign_id, campaign_revision_id, post_id, target_id,
    operation_id, event_kind, actor_kind, actor_user_id, request_id
  )
  SELECT operation.workspace_id, p_campaign_id, p_revision_id, p_post_id,
    operation.target_id, operation.id, 'post_scheduled',
    'user', actor_id, request_id
  FROM app.public_social_operations AS operation
  WHERE operation.workspace_id = p_workspace_id AND operation.post_id = p_post_id;

  RETURN QUERY SELECT p_post_id, inserted_operation_ids, 'applied'::text;
END;
$function$;

CREATE FUNCTION app_private.cancel_test_social_campaign_target(
  p_workspace_id uuid,
  p_operation_id uuid,
  p_reason_sha256 bytea
)
RETURNS TABLE (operation_id uuid, state text, disposition text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  actor_id uuid;
  request_id text;
  selected app.public_social_operations%ROWTYPE;
  existing_reason_sha256 bytea;
BEGIN
  PERFORM app_private.assert_public_social_manager(p_workspace_id);
  actor_id := app_private.current_user_id();
  request_id := app_private.current_request_id();
  IF p_operation_id IS NULL OR p_reason_sha256 IS NULL
     OR octet_length(p_reason_sha256) <> 32 THEN
    RAISE EXCEPTION 'invalid public-social cancellation evidence' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public-social-operation:' || p_workspace_id::text || ':' || p_operation_id::text,
      7200039
    )
  );
  SELECT operation.* INTO selected FROM app.public_social_operations AS operation
  WHERE operation.workspace_id = p_workspace_id AND operation.id = p_operation_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'public-social operation was not found' USING ERRCODE = 'P0002';
  END IF;
  IF selected.state = 'simulated_cancelled' THEN
    SELECT event.reason_sha256 INTO existing_reason_sha256
    FROM app.public_social_events AS event
    WHERE event.workspace_id = p_workspace_id
      AND event.operation_id = p_operation_id
      AND event.event_kind = 'simulated_cancelled';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'public-social cancellation evidence is missing'
        USING ERRCODE = '55000';
    END IF;
    IF existing_reason_sha256 IS DISTINCT FROM p_reason_sha256 THEN
      RAISE EXCEPTION 'operation id was reused with different cancellation evidence'
        USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT p_operation_id, selected.state, 'replayed'::text;
    RETURN;
  END IF;
  IF selected.state NOT IN ('waiting_for_test_time', 'retry_wait') THEN
    RAISE EXCEPTION 'public-social operation can no longer be cancelled safely'
      USING ERRCODE = '55000';
  END IF;
  UPDATE app.public_social_operations AS operation
     SET state = 'simulated_cancelled', completed_at = statement_timestamp(),
         updated_at = statement_timestamp(), row_version = operation.row_version + 1,
         lease_token_hash = NULL, lease_worker_id = NULL, lease_expires_at = NULL
   WHERE operation.workspace_id = p_workspace_id AND operation.id = p_operation_id;
  INSERT INTO app.public_social_events (
    workspace_id, post_id, target_id, operation_id, event_kind,
    actor_kind, actor_user_id, request_id, reason_sha256
  ) VALUES (
    p_workspace_id, selected.post_id, selected.target_id, p_operation_id,
    'simulated_cancelled', 'user', actor_id, request_id, p_reason_sha256
  );
  RETURN QUERY SELECT p_operation_id, 'simulated_cancelled'::text, 'applied'::text;
END;
$function$;

CREATE FUNCTION app_private.claim_due_test_social_targets(
  p_worker_id uuid,
  p_lease_token_hash bytea,
  p_batch_size integer,
  p_lease_seconds integer
)
RETURNS TABLE (
  operation_id uuid,
  workspace_id uuid,
  post_id uuid,
  target_id uuid,
  provider_connection_id uuid,
  network text,
  attempt_number smallint,
  lease_version bigint,
  lease_expires_at timestamptz,
  attempt_kind text,
  test_reference text,
  idempotency_key text,
  correlation_id uuid
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  expired app.public_social_operations%ROWTYPE;
  candidate app.public_social_operations%ROWTYPE;
  selected_kind text;
  selected_expires timestamptz;
  expired_attempt_kind text;
BEGIN
  IF p_worker_id IS NULL OR p_lease_token_hash IS NULL
     OR octet_length(p_lease_token_hash) <> 32
     OR p_batch_size IS NULL OR p_batch_size NOT BETWEEN 1 AND 25
     OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 15 AND 300 THEN
    RAISE EXCEPTION 'invalid public-social claim input' USING ERRCODE = '22023';
  END IF;

  FOR expired IN
    SELECT operation.*
    FROM app.public_social_operations AS operation
    WHERE operation.state IN ('leased', 'calling_simulator')
      AND operation.lease_expires_at <= statement_timestamp()
    ORDER BY operation.lease_expires_at, operation.id
    LIMIT 100
    FOR UPDATE SKIP LOCKED
  LOOP
    INSERT INTO app.public_social_operation_attempts AS completed_attempt (
      workspace_id, operation_id, attempt_number, attempt_kind,
      worker_id, lease_version, state, retryable, error_code,
      safe_summary, completed_at
    )
    SELECT attempt.workspace_id, attempt.operation_id, attempt.attempt_number,
      attempt.attempt_kind, attempt.worker_id, attempt.lease_version,
      CASE WHEN expired.state = 'calling_simulator'
        THEN 'needs_attention' ELSE 'failed' END,
      expired.state = 'leased' AND (
        (attempt.attempt_kind = 'simulation'
          AND expired.attempt_count < expired.max_attempts)
        OR (attempt.attempt_kind = 'reconcile'
          AND expired.reconciliation_count < expired.max_attempts)
      ),
      CASE
        WHEN expired.state = 'calling_simulator' AND attempt.attempt_kind = 'reconcile'
          THEN 'reconciliation_call_lease_expired'
        WHEN expired.state = 'calling_simulator' THEN 'simulator_call_lease_expired'
        WHEN attempt.attempt_kind = 'reconcile'
          THEN 'reconciliation_lease_expired_before_call'
        ELSE 'lease_expired_before_call'
      END,
      CASE
        WHEN expired.state = 'calling_simulator' AND attempt.attempt_kind = 'reconcile'
          THEN 'Reconciliation call lease expired; outcome remains unknown'
        WHEN expired.state = 'calling_simulator'
          THEN 'Simulator call lease expired; reconciliation required'
        WHEN attempt.attempt_kind = 'reconcile'
          THEN 'Reconciliation lease expired before simulator query'
        ELSE 'Lease expired before simulator call'
      END,
      statement_timestamp()
    FROM app.public_social_operation_attempts AS attempt
    WHERE attempt.workspace_id = expired.workspace_id
      AND attempt.operation_id = expired.id
      AND attempt.lease_version = expired.lease_version
      AND attempt.state = CASE WHEN expired.state = 'calling_simulator'
        THEN 'calling' ELSE 'leased' END
    RETURNING completed_attempt.attempt_kind INTO expired_attempt_kind;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'public-social expired lease evidence is incomplete'
        USING ERRCODE = '40001';
    END IF;

    IF expired.state = 'calling_simulator' AND expired_attempt_kind = 'reconcile' THEN
      UPDATE app.public_social_operations AS operation
         SET state = 'dead_letter', completed_at = statement_timestamp(),
             lease_token_hash = NULL, lease_worker_id = NULL, lease_expires_at = NULL,
             last_error_code = 'reconciliation_call_lease_expired',
             last_summary = 'Reconciliation call lease expired; outcome remains unknown',
             updated_at = statement_timestamp(), row_version = operation.row_version + 1
       WHERE operation.workspace_id = expired.workspace_id AND operation.id = expired.id;
      INSERT INTO app.public_social_events (
        workspace_id, post_id, target_id, operation_id, event_kind, actor_kind
      ) VALUES (
        expired.workspace_id, expired.post_id, expired.target_id, expired.id,
        'dead_letter', 'system'
      );
    ELSIF expired.state = 'calling_simulator'
          AND expired.reconciliation_count < expired.max_attempts THEN
      UPDATE app.public_social_operations AS operation
         SET state = 'reconciliation_required', next_attempt_at = statement_timestamp(),
             lease_token_hash = NULL, lease_worker_id = NULL, lease_expires_at = NULL,
             last_error_code = 'simulator_call_lease_expired',
             last_summary = 'Simulator call lease expired; reconciliation required',
             updated_at = statement_timestamp(), row_version = operation.row_version + 1
       WHERE operation.workspace_id = expired.workspace_id AND operation.id = expired.id;
      INSERT INTO app.public_social_events (
        workspace_id, post_id, target_id, operation_id, event_kind, actor_kind
      ) VALUES (
        expired.workspace_id, expired.post_id, expired.target_id, expired.id,
        'reconciliation_required', 'system'
      );
    ELSIF expired.state = 'calling_simulator' THEN
      UPDATE app.public_social_operations AS operation
         SET state = 'dead_letter', completed_at = statement_timestamp(),
             lease_token_hash = NULL, lease_worker_id = NULL, lease_expires_at = NULL,
             last_error_code = 'reconciliation_attempts_exhausted',
             last_summary = 'Simulator outcome is unknown and reconciliation attempts are exhausted',
             updated_at = statement_timestamp(), row_version = operation.row_version + 1
       WHERE operation.workspace_id = expired.workspace_id AND operation.id = expired.id;
      INSERT INTO app.public_social_events (
        workspace_id, post_id, target_id, operation_id, event_kind, actor_kind
      ) VALUES (
        expired.workspace_id, expired.post_id, expired.target_id, expired.id,
        'dead_letter', 'system'
      );
    ELSIF expired_attempt_kind = 'reconcile'
          AND expired.reconciliation_count < expired.max_attempts THEN
      UPDATE app.public_social_operations AS operation
         SET state = 'reconciliation_required', next_attempt_at = statement_timestamp(),
             lease_token_hash = NULL, lease_worker_id = NULL, lease_expires_at = NULL,
             last_error_code = 'reconciliation_lease_expired_before_call',
             last_summary = 'Reconciliation lease expired before simulator query',
             updated_at = statement_timestamp(), row_version = operation.row_version + 1
       WHERE operation.workspace_id = expired.workspace_id AND operation.id = expired.id;
      INSERT INTO app.public_social_events (
        workspace_id, post_id, target_id, operation_id, event_kind, actor_kind
      ) VALUES (
        expired.workspace_id, expired.post_id, expired.target_id, expired.id,
        'reconciliation_required', 'system'
      );
    ELSIF expired_attempt_kind = 'simulation'
          AND expired.attempt_count < expired.max_attempts THEN
      UPDATE app.public_social_operations AS operation
         SET state = 'retry_wait', next_attempt_at = statement_timestamp(),
             lease_token_hash = NULL, lease_worker_id = NULL, lease_expires_at = NULL,
             last_error_code = 'lease_expired_before_call',
             last_summary = 'Lease expired before simulator call',
             updated_at = statement_timestamp(), row_version = operation.row_version + 1
       WHERE operation.workspace_id = expired.workspace_id AND operation.id = expired.id;
      INSERT INTO app.public_social_events (
        workspace_id, post_id, target_id, operation_id, event_kind, actor_kind
      ) VALUES (
        expired.workspace_id, expired.post_id, expired.target_id, expired.id,
        'retry_planned', 'system'
      );
    ELSE
      UPDATE app.public_social_operations AS operation
         SET state = 'dead_letter', completed_at = statement_timestamp(),
             lease_token_hash = NULL, lease_worker_id = NULL, lease_expires_at = NULL,
             last_error_code = CASE WHEN expired_attempt_kind = 'reconcile'
               THEN 'reconciliation_lease_attempts_exhausted'
               ELSE 'lease_attempts_exhausted' END,
             last_summary = CASE WHEN expired_attempt_kind = 'reconcile'
               THEN 'Reconciliation lease attempts exhausted before simulator query'
               ELSE 'Claim attempts exhausted before simulator call' END,
             updated_at = statement_timestamp(), row_version = operation.row_version + 1
       WHERE operation.workspace_id = expired.workspace_id AND operation.id = expired.id;
      INSERT INTO app.public_social_events (
        workspace_id, post_id, target_id, operation_id, event_kind, actor_kind
      ) VALUES (
        expired.workspace_id, expired.post_id, expired.target_id, expired.id,
        'dead_letter', 'system'
      );
    END IF;
  END LOOP;

  FOR candidate IN
    SELECT operation.*
    FROM app.public_social_operations AS operation
    WHERE operation.state IN (
      'waiting_for_test_time', 'retry_wait', 'reconciliation_required'
    )
      AND operation.next_attempt_at <= statement_timestamp()
      AND (
        (operation.state = 'reconciliation_required'
          AND operation.reconciliation_count < operation.max_attempts)
        OR (operation.state <> 'reconciliation_required'
          AND operation.attempt_count < operation.max_attempts)
      )
      AND operation.environment = 'test'
      AND operation.execution_mode = 'simulated_test_only'
    ORDER BY operation.next_attempt_at, operation.created_at, operation.id
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  LOOP
    selected_kind := CASE WHEN candidate.state = 'reconciliation_required'
      THEN 'reconcile' ELSE 'simulation' END;
    selected_expires := statement_timestamp() + make_interval(secs => p_lease_seconds);
    UPDATE app.public_social_operations AS operation
       SET state = 'leased',
           attempt_count = operation.attempt_count
             + CASE WHEN selected_kind = 'simulation' THEN 1 ELSE 0 END,
           reconciliation_count = operation.reconciliation_count
             + CASE WHEN selected_kind = 'reconcile' THEN 1 ELSE 0 END,
           lease_token_hash = p_lease_token_hash, lease_worker_id = p_worker_id,
           lease_version = operation.lease_version + 1, lease_expires_at = selected_expires,
           updated_at = statement_timestamp(), row_version = operation.row_version + 1
     WHERE operation.workspace_id = candidate.workspace_id AND operation.id = candidate.id
     RETURNING operation.attempt_count, operation.reconciliation_count,
       operation.lease_version
      INTO candidate.attempt_count, candidate.reconciliation_count,
        candidate.lease_version;
    INSERT INTO app.public_social_operation_attempts (
      workspace_id, operation_id, attempt_number, attempt_kind,
      worker_id, lease_version, state
    ) VALUES (
      candidate.workspace_id, candidate.id,
      CASE WHEN selected_kind = 'reconcile'
        THEN candidate.reconciliation_count ELSE candidate.attempt_count END,
      selected_kind, p_worker_id, candidate.lease_version, 'leased'
    );
    INSERT INTO app.public_social_events (
      workspace_id, post_id, target_id, operation_id, event_kind, actor_kind
    ) VALUES (
      candidate.workspace_id, candidate.post_id, candidate.target_id,
      candidate.id, 'operation_leased', 'worker'
    );

    operation_id := candidate.id;
    workspace_id := candidate.workspace_id;
    post_id := candidate.post_id;
    target_id := candidate.target_id;
    provider_connection_id := candidate.provider_connection_id;
    network := candidate.network;
    attempt_number := CASE WHEN selected_kind = 'reconcile'
      THEN candidate.reconciliation_count ELSE candidate.attempt_count END;
    lease_version := candidate.lease_version;
    lease_expires_at := selected_expires;
    attempt_kind := selected_kind;
    test_reference := candidate.test_reference;
    idempotency_key := candidate.idempotency_key;
    correlation_id := candidate.correlation_id;
    RETURN NEXT;
  END LOOP;
END;
$function$;

CREATE FUNCTION app_private.load_test_social_dispatch_payload(
  p_workspace_id uuid,
  p_operation_id uuid,
  p_worker_id uuid,
  p_lease_token_hash bytea,
  p_lease_version bigint
)
RETURNS TABLE (
  content_version_id uuid,
  content_sha256 bytea,
  body_text text,
  media jsonb,
  network text,
  test_account_ref text,
  scheduled_for timestamptz,
  plan_sha256 bytea,
  approval_decision_id uuid
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF p_workspace_id IS NULL OR p_operation_id IS NULL OR p_worker_id IS NULL
     OR p_lease_token_hash IS NULL OR octet_length(p_lease_token_hash) <> 32
     OR p_lease_version IS NULL OR p_lease_version < 1 THEN
    RAISE EXCEPTION 'invalid public-social payload input' USING ERRCODE = '22023';
  END IF;
  IF NOT app_private.public_social_dispatch_ready(p_workspace_id, p_operation_id) THEN
    RAISE EXCEPTION 'public-social dispatch gates are not current' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT version.id, version.content_sha256, version.content_body,
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'contentVersionId', media_version.id,
        'contentSha256', encode(media_version.content_sha256, 'hex'),
        'blobStorageKey', media_version.blob_storage_key,
        'blobSha256', encode(media_version.blob_sha256, 'hex'),
        'mimeType', media_version.content_mime_type
      ) ORDER BY post_media.ordinal)
      FROM app.public_social_post_media AS post_media
      JOIN app.company_content_versions AS media_version
        ON media_version.workspace_id = post_media.workspace_id
       AND media_version.id = post_media.content_version_id
      WHERE post_media.workspace_id = operation.workspace_id
        AND post_media.post_id = operation.post_id
    ), '[]'::jsonb), operation.network, target.test_account_ref,
    post.scheduled_for, post.plan_sha256, post.approval_decision_id
  FROM app.public_social_operations AS operation
  JOIN app.public_social_posts AS post
    ON post.workspace_id = operation.workspace_id AND post.id = operation.post_id
  JOIN app.public_social_targets AS target
    ON target.workspace_id = operation.workspace_id AND target.id = operation.target_id
  JOIN app.company_content_versions AS version
    ON version.workspace_id = post.workspace_id AND version.id = post.content_version_id
  WHERE operation.workspace_id = p_workspace_id AND operation.id = p_operation_id
    AND operation.state = 'leased'
    AND operation.lease_worker_id = p_worker_id
    AND operation.lease_token_hash = p_lease_token_hash
    AND operation.lease_version = p_lease_version
    AND operation.lease_expires_at > statement_timestamp()
    AND public.digest(version.content_body, 'sha256') = post.content_sha256
    AND app_private.public_social_body_supported(version.content_body);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'public-social lease was lost' USING ERRCODE = '40001';
  END IF;
END;
$function$;

CREATE FUNCTION app_private.mark_test_social_target_calling(
  p_workspace_id uuid,
  p_operation_id uuid,
  p_worker_id uuid,
  p_lease_token_hash bytea,
  p_lease_version bigint
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  selected app.public_social_operations%ROWTYPE;
BEGIN
  IF NOT app_private.public_social_dispatch_ready(p_workspace_id, p_operation_id) THEN
    RAISE EXCEPTION 'public-social dispatch gates are not current' USING ERRCODE = '42501';
  END IF;
  UPDATE app.public_social_operations AS operation
     SET state = 'calling_simulator', updated_at = statement_timestamp(),
         row_version = operation.row_version + 1
   WHERE operation.workspace_id = p_workspace_id AND operation.id = p_operation_id
     AND operation.state = 'leased' AND operation.lease_worker_id = p_worker_id
     AND operation.lease_token_hash = p_lease_token_hash
     AND operation.lease_version = p_lease_version
     AND operation.lease_expires_at > statement_timestamp()
   RETURNING operation.* INTO selected;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'public-social lease was lost' USING ERRCODE = '40001';
  END IF;
  INSERT INTO app.public_social_operation_attempts (
    workspace_id, operation_id, attempt_number, attempt_kind,
    worker_id, lease_version, state
  )
  SELECT attempt.workspace_id, attempt.operation_id, attempt.attempt_number,
    attempt.attempt_kind, attempt.worker_id, attempt.lease_version, 'calling'
  FROM app.public_social_operation_attempts AS attempt
  WHERE attempt.workspace_id = p_workspace_id
    AND attempt.operation_id = p_operation_id
    AND attempt.lease_version = p_lease_version AND attempt.state = 'leased';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'public-social attempt was not leaseable' USING ERRCODE = '40001';
  END IF;
  INSERT INTO app.public_social_events (
    workspace_id, post_id, target_id, operation_id, event_kind, actor_kind
  ) VALUES (
    p_workspace_id, selected.post_id, selected.target_id, p_operation_id,
    'operation_calling', 'worker'
  );
  RETURN true;
END;
$function$;

CREATE FUNCTION app_private.renew_test_social_target_lease(
  p_workspace_id uuid,
  p_operation_id uuid,
  p_worker_id uuid,
  p_lease_token_hash bytea,
  p_lease_version bigint,
  p_lease_seconds integer
)
RETURNS timestamptz
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  renewed_at timestamptz;
BEGIN
  IF p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 15 AND 300
     OR p_lease_token_hash IS NULL OR octet_length(p_lease_token_hash) <> 32 THEN
    RAISE EXCEPTION 'invalid public-social lease renewal' USING ERRCODE = '22023';
  END IF;
  UPDATE app.public_social_operations AS operation
     SET lease_expires_at = statement_timestamp() + make_interval(secs => p_lease_seconds),
         updated_at = statement_timestamp(), row_version = operation.row_version + 1
   WHERE operation.workspace_id = p_workspace_id AND operation.id = p_operation_id
     AND operation.state IN ('leased', 'calling_simulator')
     AND operation.lease_worker_id = p_worker_id
     AND operation.lease_token_hash = p_lease_token_hash
     AND operation.lease_version = p_lease_version
     AND operation.lease_expires_at > statement_timestamp()
   RETURNING operation.lease_expires_at INTO renewed_at;
  IF renewed_at IS NULL THEN
    RAISE EXCEPTION 'public-social lease was lost' USING ERRCODE = '40001';
  END IF;
  RETURN renewed_at;
END;
$function$;

CREATE FUNCTION app_private.cancel_test_social_target_before_call(
  p_workspace_id uuid,
  p_operation_id uuid,
  p_worker_id uuid,
  p_lease_token_hash bytea,
  p_lease_version bigint,
  p_error_code text,
  p_safe_summary text
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  selected app.public_social_operations%ROWTYPE;
BEGIN
  IF p_error_code IS NULL OR p_error_code !~ '^[a-z][a-z0-9_.:-]{0,99}$'
     OR p_safe_summary IS NULL OR p_safe_summary <> btrim(p_safe_summary)
     OR length(p_safe_summary) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'invalid public-social pre-call cancellation' USING ERRCODE = '22023';
  END IF;
  SELECT operation.* INTO selected FROM app.public_social_operations AS operation
  WHERE operation.workspace_id = p_workspace_id AND operation.id = p_operation_id
    AND operation.state = 'leased' AND operation.lease_worker_id = p_worker_id
    AND operation.lease_token_hash = p_lease_token_hash
    AND operation.lease_version = p_lease_version
    AND operation.lease_expires_at > statement_timestamp()
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'public-social lease was lost' USING ERRCODE = '40001';
  END IF;
  INSERT INTO app.public_social_operation_attempts (
    workspace_id, operation_id, attempt_number, attempt_kind,
    worker_id, lease_version, state, retryable, error_code,
    safe_summary, completed_at
  )
  SELECT attempt.workspace_id, attempt.operation_id, attempt.attempt_number,
    attempt.attempt_kind, attempt.worker_id, attempt.lease_version,
    'failed', false, p_error_code, p_safe_summary, statement_timestamp()
  FROM app.public_social_operation_attempts AS attempt
  WHERE attempt.workspace_id = p_workspace_id
    AND attempt.operation_id = p_operation_id
    AND attempt.lease_version = p_lease_version AND attempt.state = 'leased'
    AND NOT EXISTS (
      SELECT 1 FROM app.public_social_operation_attempts AS calling
      WHERE calling.workspace_id = attempt.workspace_id
        AND calling.operation_id = attempt.operation_id
        AND calling.lease_version = attempt.lease_version
        AND calling.state = 'calling'
    );
  IF NOT FOUND THEN
    RAISE EXCEPTION 'public-social attempt was already called' USING ERRCODE = '40001';
  END IF;
  UPDATE app.public_social_operations AS operation
     SET state = 'simulated_failed', completed_at = statement_timestamp(),
         lease_token_hash = NULL, lease_worker_id = NULL, lease_expires_at = NULL,
         last_error_code = p_error_code, last_summary = p_safe_summary,
         updated_at = statement_timestamp(), row_version = operation.row_version + 1
   WHERE operation.workspace_id = p_workspace_id AND operation.id = p_operation_id;
  INSERT INTO app.public_social_events (
    workspace_id, post_id, target_id, operation_id, event_kind, actor_kind
  ) VALUES (
    p_workspace_id, selected.post_id, selected.target_id, p_operation_id,
    'simulated_failed', 'worker'
  );
  RETURN true;
END;
$function$;

CREATE FUNCTION app_private.settle_test_social_target(
  p_workspace_id uuid,
  p_operation_id uuid,
  p_worker_id uuid,
  p_lease_token_hash bytea,
  p_lease_version bigint,
  p_provider_status text,
  p_test_reference text,
  p_retryable boolean,
  p_error_code text,
  p_safe_summary text,
  p_occurred_at timestamptz
)
RETURNS TABLE (operation_state text, completed_at timestamptz)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  selected app.public_social_operations%ROWTYPE;
  target_state text;
  target_attempt_state text;
  target_completed timestamptz;
  retry_delay integer;
  event_name text;
  selected_attempt_kind text;
BEGIN
  IF p_provider_status IS NULL
     OR p_provider_status NOT IN ('accepted', 'pending', 'succeeded', 'failed', 'needs_attention')
     OR p_retryable IS NULL OR p_occurred_at IS NULL
     OR p_occurred_at < statement_timestamp() - interval '5 minutes'
     OR p_occurred_at > statement_timestamp() + interval '30 seconds'
     OR p_safe_summary IS NULL OR p_safe_summary <> btrim(p_safe_summary)
     OR length(p_safe_summary) NOT BETWEEN 1 AND 500
     OR (p_error_code IS NOT NULL AND p_error_code !~ '^[a-z][a-z0-9_.:-]{0,99}$')
     OR (p_provider_status = 'failed' AND p_error_code IS NULL)
     OR (p_provider_status = 'succeeded' AND (
       p_test_reference IS NULL
       OR p_test_reference !~ '^social_test_ref_[a-f0-9]{32}$'
     ))
     OR (p_test_reference IS NOT NULL
       AND p_test_reference !~ '^social_test_ref_[a-f0-9]{32}$') THEN
    RAISE EXCEPTION 'invalid public-social settlement' USING ERRCODE = '22023';
  END IF;
  SELECT operation.* INTO selected FROM app.public_social_operations AS operation
  WHERE operation.workspace_id = p_workspace_id AND operation.id = p_operation_id
    AND operation.state = 'calling_simulator'
    AND operation.lease_worker_id = p_worker_id
    AND operation.lease_token_hash = p_lease_token_hash
    AND operation.lease_version = p_lease_version
    AND operation.lease_expires_at > statement_timestamp()
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'public-social lease was lost' USING ERRCODE = '40001';
  END IF;
  SELECT attempt.attempt_kind INTO selected_attempt_kind
  FROM app.public_social_operation_attempts AS attempt
  WHERE attempt.workspace_id = p_workspace_id
    AND attempt.operation_id = p_operation_id
    AND attempt.lease_version = p_lease_version
    AND attempt.state = 'calling';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'public-social calling attempt was not found' USING ERRCODE = '40001';
  END IF;
  IF selected_attempt_kind = 'reconcile' AND p_provider_status = 'succeeded' THEN
    RAISE EXCEPTION 'successful reconciliation requires the exact reconciliation boundary'
      USING ERRCODE = '22023';
  END IF;

  IF p_provider_status = 'succeeded' THEN
    target_state := 'simulated_succeeded';
    target_attempt_state := 'succeeded';
    target_completed := statement_timestamp();
    event_name := 'simulated_succeeded';
  ELSIF selected_attempt_kind = 'reconcile'
        AND p_provider_status IN ('accepted', 'pending', 'needs_attention') THEN
    target_state := 'dead_letter';
    target_attempt_state := 'needs_attention';
    target_completed := statement_timestamp();
    event_name := 'dead_letter';
  ELSIF p_provider_status IN ('accepted', 'pending', 'needs_attention')
        AND selected.reconciliation_count >= selected.max_attempts THEN
    target_state := 'dead_letter';
    target_attempt_state := 'needs_attention';
    target_completed := statement_timestamp();
    event_name := 'dead_letter';
  ELSIF p_provider_status IN ('accepted', 'pending', 'needs_attention') THEN
    target_state := 'reconciliation_required';
    target_attempt_state := 'needs_attention';
    target_completed := NULL;
    event_name := 'reconciliation_required';
  ELSIF selected_attempt_kind = 'reconcile' AND p_provider_status = 'failed' THEN
    target_state := 'simulated_failed';
    target_attempt_state := 'failed';
    target_completed := statement_timestamp();
    event_name := 'simulated_failed';
  ELSIF selected_attempt_kind = 'simulation'
        AND p_provider_status = 'failed' AND p_test_reference IS NOT NULL
        AND selected.reconciliation_count >= selected.max_attempts THEN
    target_state := 'dead_letter';
    target_attempt_state := 'failed';
    target_completed := statement_timestamp();
    event_name := 'dead_letter';
  ELSIF selected_attempt_kind = 'simulation'
        AND p_provider_status = 'failed' AND p_test_reference IS NOT NULL THEN
    target_state := 'reconciliation_required';
    target_attempt_state := 'needs_attention';
    target_completed := NULL;
    event_name := 'reconciliation_required';
  ELSIF p_retryable AND selected.attempt_count < selected.max_attempts THEN
    target_state := 'retry_wait';
    target_attempt_state := 'failed';
    target_completed := NULL;
    event_name := 'retry_planned';
  ELSIF p_retryable THEN
    target_state := 'dead_letter';
    target_attempt_state := 'failed';
    target_completed := statement_timestamp();
    event_name := 'dead_letter';
  ELSE
    target_state := 'simulated_failed';
    target_attempt_state := 'failed';
    target_completed := statement_timestamp();
    event_name := 'simulated_failed';
  END IF;
  retry_delay := CASE selected.attempt_count
    WHEN 1 THEN 60 WHEN 2 THEN 300 ELSE 1800 END;

  INSERT INTO app.public_social_operation_attempts (
    workspace_id, operation_id, attempt_number, attempt_kind,
    worker_id, lease_version, state, retryable, error_code,
    safe_summary, provider_occurred_at, completed_at
  )
  SELECT attempt.workspace_id, attempt.operation_id, attempt.attempt_number,
    attempt.attempt_kind, attempt.worker_id, attempt.lease_version,
    target_attempt_state, p_retryable, p_error_code, p_safe_summary,
    p_occurred_at, statement_timestamp()
  FROM app.public_social_operation_attempts AS attempt
  WHERE attempt.workspace_id = p_workspace_id
    AND attempt.operation_id = p_operation_id
    AND attempt.lease_version = p_lease_version AND attempt.state = 'calling';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'public-social calling attempt was not found' USING ERRCODE = '40001';
  END IF;

  UPDATE app.public_social_operations AS operation
     SET state = target_state,
         next_attempt_at = CASE WHEN target_state IN ('retry_wait', 'reconciliation_required')
           THEN statement_timestamp() + make_interval(secs => retry_delay)
           ELSE operation.next_attempt_at END,
         lease_token_hash = NULL, lease_worker_id = NULL, lease_expires_at = NULL,
         test_reference = CASE
           WHEN selected_attempt_kind = 'reconcile' AND target_state = 'retry_wait'
             THEN NULL
           ELSE COALESCE(p_test_reference, operation.test_reference)
         END,
         last_error_code = p_error_code, last_summary = p_safe_summary,
         completed_at = target_completed, updated_at = statement_timestamp(),
         row_version = operation.row_version + 1
   WHERE operation.workspace_id = p_workspace_id AND operation.id = p_operation_id;

  IF p_test_reference IS NOT NULL AND p_provider_status IN ('succeeded', 'failed') THEN
    INSERT INTO app.public_social_operation_receipts (
      workspace_id, operation_id, post_id, target_id, source_kind,
      external_event_id, payload_sha256, outcome, error_code, occurred_at
    ) VALUES (
      p_workspace_id, p_operation_id, selected.post_id, selected.target_id,
      CASE WHEN selected_attempt_kind = 'reconcile'
        THEN 'worker_reconcile' ELSE 'test_provider' END,
      p_test_reference,
      public.digest(
        p_operation_id::text || E'\n' || selected_attempt_kind
          || E'\n' || p_provider_status || E'\n' || p_test_reference,
        'sha256'
      ),
      CASE WHEN p_provider_status = 'succeeded'
        THEN 'simulated_succeeded' ELSE 'simulated_failed' END,
      p_error_code, p_occurred_at
    ) ON CONFLICT (workspace_id, operation_id, source_kind, external_event_id)
      DO NOTHING;
  END IF;
  INSERT INTO app.public_social_events (
    workspace_id, post_id, target_id, operation_id, event_kind, actor_kind
  ) VALUES (
    p_workspace_id, selected.post_id, selected.target_id, p_operation_id,
    event_name, 'worker'
  );
  RETURN QUERY SELECT target_state, target_completed;
END;
$function$;

CREATE FUNCTION app_private.reconcile_test_social_target(
  p_workspace_id uuid,
  p_operation_id uuid,
  p_worker_id uuid,
  p_lease_token_hash bytea,
  p_lease_version bigint,
  p_test_reference text,
  p_occurred_at timestamptz
)
RETURNS TABLE (operation_state text, completed_at timestamptz)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  selected app.public_social_operations%ROWTYPE;
  finished_at timestamptz := statement_timestamp();
BEGIN
  IF p_test_reference IS NULL
     OR p_test_reference !~ '^social_test_ref_[a-f0-9]{32}$'
     OR p_occurred_at IS NULL
     OR p_occurred_at < statement_timestamp() - interval '5 minutes'
     OR p_occurred_at > statement_timestamp() + interval '30 seconds' THEN
    RAISE EXCEPTION 'invalid public-social reconciliation' USING ERRCODE = '22023';
  END IF;
  SELECT operation.* INTO selected FROM app.public_social_operations AS operation
  JOIN app.public_social_operation_attempts AS attempt
    ON attempt.workspace_id = operation.workspace_id
   AND attempt.operation_id = operation.id
   AND attempt.lease_version = operation.lease_version
  WHERE operation.workspace_id = p_workspace_id AND operation.id = p_operation_id
    AND operation.state = 'calling_simulator'
    AND operation.lease_worker_id = p_worker_id
    AND operation.lease_token_hash = p_lease_token_hash
    AND operation.lease_version = p_lease_version
    AND operation.lease_expires_at > statement_timestamp()
    AND attempt.attempt_kind = 'reconcile' AND attempt.state = 'calling'
  FOR UPDATE OF operation;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'public-social reconciliation lease was lost' USING ERRCODE = '40001';
  END IF;
  IF selected.test_reference IS NOT NULL
     AND selected.test_reference IS DISTINCT FROM p_test_reference THEN
    RAISE EXCEPTION 'reconciliation reference does not match the exact operation'
      USING ERRCODE = '23505';
  END IF;
  INSERT INTO app.public_social_operation_attempts (
    workspace_id, operation_id, attempt_number, attempt_kind,
    worker_id, lease_version, state, retryable, safe_summary,
    provider_occurred_at, completed_at
  )
  SELECT attempt.workspace_id, attempt.operation_id, attempt.attempt_number,
    attempt.attempt_kind, attempt.worker_id, attempt.lease_version,
    'succeeded', false, 'Exact TEST simulation reference reconciled',
    p_occurred_at, finished_at
  FROM app.public_social_operation_attempts AS attempt
  WHERE attempt.workspace_id = p_workspace_id
    AND attempt.operation_id = p_operation_id
    AND attempt.lease_version = p_lease_version AND attempt.state = 'calling';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'public-social reconciliation attempt was not found'
      USING ERRCODE = '40001';
  END IF;
  UPDATE app.public_social_operations AS operation
     SET state = 'simulated_reconciled', test_reference = p_test_reference,
         completed_at = finished_at, lease_token_hash = NULL,
         lease_worker_id = NULL, lease_expires_at = NULL,
         last_error_code = NULL,
         last_summary = 'Exact TEST simulation reference reconciled',
         updated_at = finished_at, row_version = operation.row_version + 1
   WHERE operation.workspace_id = p_workspace_id AND operation.id = p_operation_id;
  INSERT INTO app.public_social_operation_receipts (
    workspace_id, operation_id, post_id, target_id, source_kind,
    external_event_id, payload_sha256, outcome, occurred_at
  ) VALUES (
    p_workspace_id, p_operation_id, selected.post_id, selected.target_id,
    'worker_reconcile', p_test_reference,
    public.digest(p_operation_id::text || E'\nreconcile\n' || p_test_reference, 'sha256'),
    'simulated_reconciled', p_occurred_at
  ) ON CONFLICT (workspace_id, operation_id, source_kind, external_event_id)
    DO NOTHING;
  INSERT INTO app.public_social_events (
    workspace_id, post_id, target_id, operation_id, event_kind, actor_kind
  ) VALUES (
    p_workspace_id, selected.post_id, selected.target_id, p_operation_id,
    'simulated_reconciled', 'worker'
  );
  RETURN QUERY SELECT 'simulated_reconciled'::text, finished_at;
END;
$function$;

CREATE FUNCTION app_private.list_social_campaign_command(
  p_workspace_id uuid,
  p_campaign_id uuid,
  p_limit integer
)
RETURNS TABLE (
  revision_id uuid,
  revision_number integer,
  title text,
  objective text,
  timezone text,
  revision_sha256 text,
  post_id uuid,
  scheduled_for timestamptz,
  content_item_id uuid,
  content_version_id uuid,
  content_sha256 text,
  plan_sha256 text,
  operation_id uuid,
  target_id uuid,
  network text,
  target_label text,
  operation_state text,
  simulation_attempt_count smallint,
  max_simulation_attempts smallint,
  reconciliation_attempt_count smallint,
  max_reconciliation_attempts smallint,
  test_reference_sha256 text,
  has_more boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF p_workspace_id IS NULL OR p_campaign_id IS NULL
     OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 120
     OR app_private.current_workspace_id() IS DISTINCT FROM p_workspace_id
     OR NOT app_private.has_active_workspace_membership(
       app_private.current_user_id(), p_workspace_id
     ) THEN
    RAISE EXCEPTION 'public-social read context is invalid' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  WITH projection AS MATERIALIZED (
    SELECT revision.id AS revision_id,
      revision.revision_number, revision.title, revision.objective,
      revision.timezone, encode(revision.revision_sha256, 'hex') AS revision_sha256,
      post.id AS post_id, post.scheduled_for, post.content_item_id,
      post.content_version_id, encode(post.content_sha256, 'hex') AS content_sha256,
      encode(post.plan_sha256, 'hex') AS plan_sha256,
      operation.id AS operation_id, target.id AS target_id, target.network,
      target.display_name AS target_label, operation.state AS operation_state,
      operation.attempt_count AS simulation_attempt_count,
      operation.max_attempts AS max_simulation_attempts,
      operation.reconciliation_count AS reconciliation_attempt_count,
      operation.max_attempts AS max_reconciliation_attempts,
      CASE WHEN operation.test_reference IS NULL THEN NULL
        ELSE encode(public.digest(operation.test_reference, 'sha256'), 'hex') END
        AS test_reference_sha256
    FROM app.public_social_campaign_revisions AS revision
    LEFT JOIN app.public_social_posts AS post
      ON post.workspace_id = revision.workspace_id
     AND post.campaign_revision_id = revision.id
    LEFT JOIN app.public_social_operations AS operation
      ON operation.workspace_id = post.workspace_id AND operation.post_id = post.id
    LEFT JOIN app.public_social_targets AS target
      ON target.workspace_id = operation.workspace_id AND target.id = operation.target_id
    WHERE revision.workspace_id = p_workspace_id
      AND revision.campaign_id = p_campaign_id
  )
  SELECT projection.revision_id, projection.revision_number, projection.title,
    projection.objective, projection.timezone, projection.revision_sha256,
    projection.post_id, projection.scheduled_for, projection.content_item_id,
    projection.content_version_id, projection.content_sha256, projection.plan_sha256,
    projection.operation_id, projection.target_id, projection.network,
    projection.target_label, projection.operation_state,
    projection.simulation_attempt_count, projection.max_simulation_attempts,
    projection.reconciliation_attempt_count, projection.max_reconciliation_attempts,
    projection.test_reference_sha256,
    (pg_catalog.count(*) OVER () > p_limit) AS has_more
  FROM projection
  ORDER BY projection.revision_number DESC,
    projection.scheduled_for NULLS LAST, projection.post_id NULLS LAST,
    projection.network, projection.operation_id
  LIMIT p_limit + 1;
END;
$function$;

CREATE FUNCTION app_private.list_social_campaign_calendar(
  p_workspace_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_limit integer
)
RETURNS TABLE (
  post_id uuid,
  campaign_id uuid,
  revision_id uuid,
  revision_number integer,
  campaign_title text,
  scheduled_for timestamptz,
  content_item_id uuid,
  content_version_id uuid,
  content_sha256 text,
  plan_sha256 text,
  operation_id uuid,
  target_id uuid,
  network text,
  target_label text,
  operation_state text,
  simulation_attempt_count smallint,
  max_simulation_attempts smallint,
  reconciliation_attempt_count smallint,
  max_reconciliation_attempts smallint,
  updated_at timestamptz,
  has_more boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF p_workspace_id IS NULL OR p_from IS NULL OR p_to IS NULL
     OR p_to <= p_from OR p_to > p_from + interval '366 days'
     OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 120
     OR app_private.current_workspace_id() IS DISTINCT FROM p_workspace_id
     OR NOT app_private.has_active_workspace_membership(
       app_private.current_user_id(), p_workspace_id
     ) THEN
    RAISE EXCEPTION 'public-social calendar input is invalid' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  WITH projection AS MATERIALIZED (
    SELECT post.id AS post_id, post.campaign_id, revision.id AS revision_id,
      revision.revision_number, revision.title AS campaign_title,
      post.scheduled_for, post.content_item_id, post.content_version_id,
      encode(post.content_sha256, 'hex') AS content_sha256,
      encode(post.plan_sha256, 'hex') AS plan_sha256,
      operation.id AS operation_id, target.id AS target_id, target.network,
      target.display_name AS target_label, operation.state AS operation_state,
      operation.attempt_count AS simulation_attempt_count,
      operation.max_attempts AS max_simulation_attempts,
      operation.reconciliation_count AS reconciliation_attempt_count,
      operation.max_attempts AS max_reconciliation_attempts,
      operation.updated_at
    FROM app.public_social_posts AS post
    JOIN app.public_social_campaign_revisions AS revision
      ON revision.workspace_id = post.workspace_id
     AND revision.id = post.campaign_revision_id
    JOIN app.public_social_operations AS operation
      ON operation.workspace_id = post.workspace_id AND operation.post_id = post.id
    JOIN app.public_social_targets AS target
      ON target.workspace_id = operation.workspace_id AND target.id = operation.target_id
    WHERE post.workspace_id = p_workspace_id
      AND post.scheduled_for >= p_from AND post.scheduled_for < p_to
  )
  SELECT projection.post_id, projection.campaign_id, projection.revision_id,
    projection.revision_number, projection.campaign_title,
    projection.scheduled_for, projection.content_item_id,
    projection.content_version_id, projection.content_sha256,
    projection.plan_sha256, projection.operation_id, projection.target_id,
    projection.network, projection.target_label, projection.operation_state,
    projection.simulation_attempt_count, projection.max_simulation_attempts,
    projection.reconciliation_attempt_count, projection.max_reconciliation_attempts,
    projection.updated_at,
    (pg_catalog.count(*) OVER () > p_limit) AS has_more
  FROM projection
  ORDER BY projection.scheduled_for, projection.post_id,
    projection.network, projection.operation_id
  LIMIT p_limit + 1;
END;
$function$;

CREATE FUNCTION app_private.public_social_campaign_boundary_ready()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT pg_catalog.to_regprocedure(
      'app_private.runtime_database_installation_id()'
    ) IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM app.public_social_targets AS target
      JOIN app.provider_connections AS connection
        ON connection.workspace_id = target.workspace_id
       AND connection.id = target.provider_connection_id
      WHERE target.environment <> 'test'
         OR connection.provider_id <> 'public_social_dark_simulator'
         OR connection.provider_kind <> 'social'
         OR connection.environment <> 'test'
    )
    AND NOT EXISTS (
      SELECT 1 FROM app.public_social_operations AS operation
      WHERE operation.environment <> 'test'
         OR operation.execution_mode <> 'simulated_test_only'
    );
$function$;

SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_public_social_definer;

DO $revoke_functions$
DECLARE
  function_oid oid;
BEGIN
  FOR function_oid IN
    SELECT procedure.oid
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname = 'app_private'
      AND procedure.proname IN (
        'assert_public_social_manager', 'public_social_display_text_supported',
        'public_social_body_supported',
        'public_social_media_payload_supported', 'assert_public_social_content',
        'public_social_dispatch_ready', 'create_test_social_campaign_revision',
        'public_social_revision_sha256',
        'register_test_social_campaign_target', 'resolve_test_social_campaign_targets',
        'schedule_test_social_campaign',
        'cancel_test_social_campaign_target', 'claim_due_test_social_targets',
        'load_test_social_dispatch_payload', 'mark_test_social_target_calling',
        'renew_test_social_target_lease', 'cancel_test_social_target_before_call',
        'settle_test_social_target', 'reconcile_test_social_target',
        'list_social_campaign_command', 'list_social_campaign_calendar',
        'public_social_campaign_boundary_ready'
      )
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', function_oid::regprocedure);
  END LOOP;
END
$revoke_functions$;

GRANT USAGE ON SCHEMA app_private
  TO r72_public_social_command, r72_public_social_worker_command;
GRANT EXECUTE ON FUNCTION app_private.create_test_social_campaign_revision(
  uuid, uuid, uuid, integer, uuid, text, text, text, bytea
) TO r72_public_social_command;
GRANT EXECUTE ON FUNCTION app_private.register_test_social_campaign_target(
  uuid, uuid, uuid, text, text, text
) TO r72_public_social_command;
GRANT EXECUTE ON FUNCTION app_private.resolve_test_social_campaign_targets(
  uuid, uuid[]
) TO r72_public_social_command;
GRANT EXECUTE ON FUNCTION app_private.schedule_test_social_campaign(
  uuid, uuid, uuid, uuid, uuid, uuid, bytea, uuid, uuid, uuid,
  timestamptz, smallint, bytea, uuid[], jsonb
) TO r72_public_social_command;
GRANT EXECUTE ON FUNCTION app_private.cancel_test_social_campaign_target(
  uuid, uuid, bytea
) TO r72_public_social_command;
GRANT EXECUTE ON FUNCTION app_private.claim_due_test_social_targets(
  uuid, bytea, integer, integer
) TO r72_public_social_worker_command;
GRANT EXECUTE ON FUNCTION app_private.load_test_social_dispatch_payload(
  uuid, uuid, uuid, bytea, bigint
) TO r72_public_social_worker_command;
GRANT EXECUTE ON FUNCTION app_private.mark_test_social_target_calling(
  uuid, uuid, uuid, bytea, bigint
) TO r72_public_social_worker_command;
GRANT EXECUTE ON FUNCTION app_private.renew_test_social_target_lease(
  uuid, uuid, uuid, bytea, bigint, integer
) TO r72_public_social_worker_command;
GRANT EXECUTE ON FUNCTION app_private.cancel_test_social_target_before_call(
  uuid, uuid, uuid, bytea, bigint, text, text
) TO r72_public_social_worker_command;
GRANT EXECUTE ON FUNCTION app_private.settle_test_social_target(
  uuid, uuid, uuid, bytea, bigint, text, text, boolean,
  text, text, timestamptz
) TO r72_public_social_worker_command;
GRANT EXECUTE ON FUNCTION app_private.reconcile_test_social_target(
  uuid, uuid, uuid, bytea, bigint, text, timestamptz
) TO r72_public_social_worker_command;
GRANT EXECUTE ON FUNCTION app_private.list_social_campaign_command(uuid, uuid, integer),
  app_private.list_social_campaign_calendar(uuid, timestamptz, timestamptz, integer)
TO r72_web;
GRANT EXECUTE ON FUNCTION app_private.public_social_campaign_boundary_ready()
  TO r72_public_social_command, r72_public_social_worker_command;
GRANT EXECUTE ON FUNCTION app_private.runtime_database_installation_id()
  TO r72_public_social_command, r72_public_social_worker_command;

INSERT INTO app_private.workspace_table_registry
  (schema_name, table_name, workspace_column)
VALUES
  ('app', 'public_social_campaigns', 'workspace_id'),
  ('app', 'public_social_campaign_revisions', 'workspace_id'),
  ('app', 'public_social_targets', 'workspace_id'),
  ('app', 'public_social_posts', 'workspace_id'),
  ('app', 'public_social_post_media', 'workspace_id'),
  ('app', 'public_social_operations', 'workspace_id'),
  ('app', 'public_social_operation_attempts', 'workspace_id'),
  ('app', 'public_social_operation_receipts', 'workspace_id'),
  ('app', 'public_social_events', 'workspace_id');

DO $capability_audit$
DECLARE
  unsafe_object text;
  unsafe_function text;
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY[
    'r72_public_social_command', 'r72_public_social_worker_command'
  ] LOOP
    IF NOT pg_catalog.has_schema_privilege(role_name, 'app_private', 'USAGE')
       OR pg_catalog.has_schema_privilege(role_name, 'app_private', 'CREATE')
       OR pg_catalog.has_schema_privilege(role_name, 'app', 'USAGE') THEN
      RAISE EXCEPTION 'Unsafe public-social login schema capability: %', role_name;
    END IF;
    SELECT format('%I.%I', namespace.nspname, relation.relname)
      INTO unsafe_object
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname IN ('app', 'app_private')
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND (
        pg_catalog.has_table_privilege(role_name, relation.oid, 'SELECT')
        OR pg_catalog.has_table_privilege(role_name, relation.oid, 'INSERT')
        OR pg_catalog.has_table_privilege(role_name, relation.oid, 'UPDATE')
        OR pg_catalog.has_table_privilege(role_name, relation.oid, 'DELETE')
        OR pg_catalog.has_table_privilege(role_name, relation.oid, 'TRUNCATE')
      )
    LIMIT 1;
    IF unsafe_object IS NOT NULL THEN
      RAISE EXCEPTION 'Public-social login % unexpectedly has table privilege on %',
        role_name, unsafe_object;
    END IF;
  END LOOP;

  IF pg_catalog.has_table_privilege('r72_web', 'app.public_social_operations', 'SELECT')
     OR pg_catalog.has_table_privilege('r72_web', 'app.public_social_operations', 'INSERT')
     OR pg_catalog.has_table_privilege('r72_worker', 'app.public_social_operations', 'SELECT')
     OR pg_catalog.has_table_privilege('r72_public', 'app.public_social_campaigns', 'SELECT')
     OR pg_catalog.has_table_privilege(
       'r72_public_social_definer', 'app.provider_connections', 'INSERT'
     ) THEN
    RAISE EXCEPTION 'Public-social table capabilities are broader than required';
  END IF;

  SELECT procedure.oid::regprocedure::text INTO unsafe_function
  FROM pg_catalog.pg_proc AS procedure
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
  JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = procedure.proowner
  WHERE namespace.nspname = 'app_private'
    AND procedure.proname IN (
      'create_test_social_campaign_revision', 'register_test_social_campaign_target',
      'resolve_test_social_campaign_targets', 'schedule_test_social_campaign',
      'cancel_test_social_campaign_target',
      'claim_due_test_social_targets', 'load_test_social_dispatch_payload',
      'mark_test_social_target_calling', 'renew_test_social_target_lease',
      'cancel_test_social_target_before_call', 'settle_test_social_target',
      'reconcile_test_social_target', 'list_social_campaign_command',
      'list_social_campaign_calendar', 'public_social_campaign_boundary_ready'
    )
    AND (
      owner_role.rolname <> 'r72_public_social_definer'
      OR NOT procedure.prosecdef
      OR procedure.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog']::text[]
      OR procedure.proacl IS NULL
      OR EXISTS (
        SELECT 1 FROM pg_catalog.aclexplode(procedure.proacl) AS privilege
        WHERE privilege.grantee = 0 AND privilege.privilege_type = 'EXECUTE'
      )
    )
  LIMIT 1;
  IF unsafe_function IS NOT NULL THEN
    RAISE EXCEPTION 'Unsafe public-social function boundary: %', unsafe_function;
  END IF;

  IF NOT app_private.public_social_campaign_boundary_ready() THEN
    RAISE EXCEPTION 'Public-social TEST-only boundary is not ready';
  END IF;
END
$capability_audit$;
