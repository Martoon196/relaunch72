-- Browser-safe, durable TEST-only public-social planning. Long-dated intents
-- are immutable and non-dispatchable. A separate function-only revalidator
-- must obtain fresh exact source evidence inside the JIT window before the
-- existing 0039 dark simulator operation can be materialised.

DO $roles$
DECLARE
  expected_login boolean := true;
  unsafe_membership text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'r72_public_social_revalidator_command'
  ) THEN
    CREATE ROLE r72_public_social_revalidator_command LOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'r72_public_social_revalidator_command'
      AND rolcanlogin = expected_login
      AND NOT rolinherit AND NOT rolsuper AND NOT rolcreatedb
      AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls
  ) THEN
    RAISE EXCEPTION 'Unsafe public-social revalidator role attributes';
  END IF;

  REVOKE r72_owner, r72_security_definer, r72_onboarding_definer,
    r72_setup_delivery_definer, r72_commerce_definer,
    r72_external_event_definer, r72_provider_operation_definer,
    r72_mailgun_webhook_definer, r72_test_inbox_webhook_definer,
    r72_public_social_definer, r72_public_social_command,
    r72_public_social_worker_command
  FROM r72_public_social_revalidator_command;
  REVOKE r72_public_social_revalidator_command
  FROM r72_owner, r72_web, r72_public, r72_worker, r72_webhook, r72_readonly,
    r72_crm_command, r72_identity_command, r72_provisioning_command,
    r72_setup_delivery_command, r72_setup_reissue_command,
    r72_external_event_command, r72_mailgun_webhook_command,
    r72_test_inbox_webhook_command, r72_public_social_definer,
    r72_public_social_command, r72_public_social_worker_command;

  SELECT member.rolname || '->' || parent.rolname INTO unsafe_membership
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
  JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
  WHERE member.rolname = 'r72_public_social_revalidator_command'
  LIMIT 1;
  IF unsafe_membership IS NOT NULL THEN
    RAISE EXCEPTION 'Unsafe public-social revalidator role membership: %',
      unsafe_membership;
  END IF;
  EXECUTE format(
    'GRANT r72_public_social_revalidator_command TO %I', current_user
  );
END
$roles$;

SET LOCAL ROLE r72_owner;

REVOKE ALL ON SCHEMA app, app_private
  FROM r72_public_social_revalidator_command;
REVOKE ALL ON ALL TABLES IN SCHEMA app
  FROM r72_public_social_revalidator_command;
REVOKE ALL ON ALL TABLES IN SCHEMA app_private
  FROM r72_public_social_revalidator_command;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app_private
  FROM r72_public_social_revalidator_command;
REVOKE CREATE ON SCHEMA public
  FROM r72_public_social_revalidator_command;

CREATE TABLE app.public_social_planning_intents (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL,
  campaign_revision_id uuid NOT NULL,
  content_item_id uuid NOT NULL,
  content_version_id uuid NOT NULL,
  content_sha256 bytea NOT NULL CHECK (octet_length(content_sha256) = 32),
  blob_sha256 bytea NOT NULL CHECK (octet_length(blob_sha256) = 32),
  brand_sha256 bytea NOT NULL CHECK (octet_length(brand_sha256) = 32),
  approval_request_id uuid NOT NULL,
  approval_decision_id uuid NOT NULL,
  planning_source_attestation_id uuid NOT NULL,
  desired_for timestamptz NOT NULL,
  max_attempts smallint NOT NULL CHECK (max_attempts BETWEEN 1 AND 4),
  intent_sha256 bytea NOT NULL CHECK (octet_length(intent_sha256) = 32),
  created_by_user_id uuid NOT NULL,
  created_request_id text NOT NULL CHECK (
    created_request_id = btrim(created_request_id)
    AND length(created_request_id) BETWEEN 1 AND 128
  ),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, id, intent_sha256),
  FOREIGN KEY (workspace_id, campaign_id, campaign_revision_id)
    REFERENCES app.public_social_campaign_revisions
      (workspace_id, campaign_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, content_item_id, content_version_id, content_sha256)
    REFERENCES app.company_content_versions
      (workspace_id, content_item_id, id, content_sha256) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, approval_request_id)
    REFERENCES app.company_content_approval_requests (workspace_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, approval_decision_id)
    REFERENCES app.company_content_approval_decisions (workspace_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, planning_source_attestation_id)
    REFERENCES app.company_content_source_attestations (workspace_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, created_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id)
    ON DELETE RESTRICT,
  CHECK (desired_for >= created_at - interval '5 minutes'),
  CHECK (desired_for <= created_at + interval '366 days')
);

CREATE TABLE app.public_social_planning_intent_targets (
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  intent_id uuid NOT NULL,
  ordinal smallint NOT NULL CHECK (ordinal BETWEEN 1 AND 9),
  target_id uuid NOT NULL,
  provider_connection_id uuid NOT NULL,
  network text NOT NULL CHECK (network IN (
    'facebook', 'instagram', 'linkedin', 'tiktok', 'x', 'youtube',
    'google_business_profile', 'threads', 'pinterest'
  )),
  environment text NOT NULL DEFAULT 'test' CHECK (environment = 'test'),
  account_ref_sha256 bytea NOT NULL CHECK (octet_length(account_ref_sha256) = 32),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (workspace_id, intent_id, ordinal),
  UNIQUE (workspace_id, intent_id, target_id),
  FOREIGN KEY (workspace_id, intent_id)
    REFERENCES app.public_social_planning_intents (workspace_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (
    workspace_id, target_id, provider_connection_id, network, environment
  ) REFERENCES app.public_social_targets (
    workspace_id, id, provider_connection_id, network, environment
  ) ON DELETE RESTRICT
);

CREATE TABLE app.public_social_planning_intent_media (
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  intent_id uuid NOT NULL,
  ordinal smallint NOT NULL CHECK (ordinal BETWEEN 1 AND 10),
  content_item_id uuid NOT NULL,
  content_version_id uuid NOT NULL,
  content_sha256 bytea NOT NULL CHECK (octet_length(content_sha256) = 32),
  blob_sha256 bytea NOT NULL CHECK (octet_length(blob_sha256) = 32),
  brand_sha256 bytea NOT NULL CHECK (octet_length(brand_sha256) = 32),
  approval_request_id uuid NOT NULL,
  approval_decision_id uuid NOT NULL,
  planning_source_attestation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (workspace_id, intent_id, ordinal),
  UNIQUE (workspace_id, intent_id, content_version_id),
  FOREIGN KEY (workspace_id, intent_id)
    REFERENCES app.public_social_planning_intents (workspace_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, content_item_id, content_version_id, content_sha256)
    REFERENCES app.company_content_versions
      (workspace_id, content_item_id, id, content_sha256) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, approval_request_id)
    REFERENCES app.company_content_approval_requests (workspace_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, approval_decision_id)
    REFERENCES app.company_content_approval_decisions (workspace_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, planning_source_attestation_id)
    REFERENCES app.company_content_source_attestations (workspace_id, id)
    ON DELETE RESTRICT
);

CREATE TABLE app.public_social_planning_target_cancellations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  intent_id uuid NOT NULL,
  target_id uuid NOT NULL,
  cancellation_kind text NOT NULL CHECK (
    cancellation_kind IN ('user_cancelled', 'rescheduled')
  ),
  reason_sha256 bytea NOT NULL CHECK (octet_length(reason_sha256) = 32),
  cancelled_by_user_id uuid NOT NULL,
  cancelled_request_id text NOT NULL CHECK (
    cancelled_request_id = btrim(cancelled_request_id)
    AND length(cancelled_request_id) BETWEEN 1 AND 128
  ),
  cancelled_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, intent_id, target_id),
  FOREIGN KEY (workspace_id, intent_id, target_id)
    REFERENCES app.public_social_planning_intent_targets
      (workspace_id, intent_id, target_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, cancelled_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id)
    ON DELETE RESTRICT
);

CREATE TABLE app.public_social_planning_target_supersessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  predecessor_intent_id uuid NOT NULL,
  predecessor_target_id uuid NOT NULL,
  successor_intent_id uuid NOT NULL,
  successor_target_id uuid NOT NULL,
  previous_desired_for timestamptz NOT NULL,
  new_desired_for timestamptz NOT NULL,
  reason_sha256 bytea NOT NULL CHECK (octet_length(reason_sha256) = 32),
  superseded_by_user_id uuid NOT NULL,
  superseded_request_id text NOT NULL CHECK (
    superseded_request_id = btrim(superseded_request_id)
    AND length(superseded_request_id) BETWEEN 1 AND 128
  ),
  superseded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, predecessor_intent_id, predecessor_target_id),
  UNIQUE (workspace_id, successor_intent_id, successor_target_id),
  FOREIGN KEY (workspace_id, predecessor_intent_id, predecessor_target_id)
    REFERENCES app.public_social_planning_intent_targets
      (workspace_id, intent_id, target_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, successor_intent_id, successor_target_id)
    REFERENCES app.public_social_planning_intent_targets
      (workspace_id, intent_id, target_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, superseded_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id)
    ON DELETE RESTRICT,
  CHECK (predecessor_intent_id <> successor_intent_id),
  CHECK (predecessor_target_id = successor_target_id)
);

CREATE TABLE app.public_social_revalidation_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  intent_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'waiting_for_window' CHECK (state IN (
    'waiting_for_window', 'leased', 'retry_wait', 'verified',
    'materialized', 'dead_letter', 'cancelled', 'window_expired'
  )),
  attempt_count smallint NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 4),
  max_attempts smallint NOT NULL DEFAULT 4 CHECK (max_attempts BETWEEN 1 AND 4),
  next_attempt_at timestamptz NOT NULL,
  lease_token_hash bytea CHECK (
    lease_token_hash IS NULL OR octet_length(lease_token_hash) = 32
  ),
  lease_version bigint NOT NULL DEFAULT 0 CHECK (lease_version >= 0),
  lease_worker_id uuid,
  lease_expires_at timestamptz,
  current_proof_id uuid,
  last_error_code text CHECK (
    last_error_code IS NULL OR last_error_code ~ '^[a-z][a-z0-9_.:-]{0,99}$'
  ),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  completed_at timestamptz,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, intent_id),
  FOREIGN KEY (workspace_id, intent_id)
    REFERENCES app.public_social_planning_intents (workspace_id, id)
    ON DELETE RESTRICT,
  CHECK (attempt_count <= max_attempts),
  CHECK (
    (state = 'leased') = (lease_token_hash IS NOT NULL
      AND lease_worker_id IS NOT NULL AND lease_expires_at IS NOT NULL)
  ),
  CHECK (
    (state IN (
      'materialized', 'dead_letter', 'cancelled', 'window_expired'
    )) = (completed_at IS NOT NULL)
  ),
  CHECK (updated_at >= created_at),
  CHECK (completed_at IS NULL OR completed_at >= created_at)
);

CREATE INDEX public_social_revalidation_jobs_claim_idx
  ON app.public_social_revalidation_jobs
    (state, next_attempt_at, created_at, id)
  WHERE state IN ('waiting_for_window', 'leased', 'retry_wait');

CREATE TABLE app.public_social_revalidation_proofs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  job_id uuid NOT NULL,
  intent_id uuid NOT NULL,
  intent_sha256 bytea NOT NULL CHECK (octet_length(intent_sha256) = 32),
  content_item_id uuid NOT NULL,
  content_version_id uuid NOT NULL,
  content_sha256 bytea NOT NULL CHECK (octet_length(content_sha256) = 32),
  blob_sha256 bytea NOT NULL CHECK (octet_length(blob_sha256) = 32),
  brand_sha256 bytea NOT NULL CHECK (octet_length(brand_sha256) = 32),
  source_resource_version_id uuid NOT NULL,
  source_approval_id uuid NOT NULL,
  source_approved_at timestamptz NOT NULL,
  source_catalog_sha256 bytea NOT NULL CHECK (
    octet_length(source_catalog_sha256) = 32
  ),
  checked_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  worker_id uuid NOT NULL,
  lease_version bigint NOT NULL CHECK (lease_version > 0),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, job_id),
  UNIQUE (workspace_id, intent_id),
  FOREIGN KEY (workspace_id, job_id)
    REFERENCES app.public_social_revalidation_jobs (workspace_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, intent_id, intent_sha256)
    REFERENCES app.public_social_planning_intents
      (workspace_id, id, intent_sha256) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, content_item_id, content_version_id, content_sha256)
    REFERENCES app.company_content_versions
      (workspace_id, content_item_id, id, content_sha256) ON DELETE RESTRICT,
  CHECK (source_approved_at <= checked_at),
  CHECK (checked_at <= created_at + interval '30 seconds'),
  CHECK (checked_at >= created_at - interval '15 minutes'),
  CHECK (expires_at > checked_at),
  CHECK (expires_at <= checked_at + interval '15 minutes')
);

ALTER TABLE app.public_social_revalidation_jobs
  ADD CONSTRAINT public_social_revalidation_jobs_current_proof_fk
  FOREIGN KEY (workspace_id, current_proof_id)
  REFERENCES app.public_social_revalidation_proofs (workspace_id, id)
  ON DELETE RESTRICT;

CREATE TABLE app.public_social_revalidation_proof_media (
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  proof_id uuid NOT NULL,
  intent_id uuid NOT NULL,
  ordinal smallint NOT NULL CHECK (ordinal BETWEEN 1 AND 10),
  content_item_id uuid NOT NULL,
  content_version_id uuid NOT NULL,
  content_sha256 bytea NOT NULL CHECK (octet_length(content_sha256) = 32),
  blob_sha256 bytea NOT NULL CHECK (octet_length(blob_sha256) = 32),
  brand_sha256 bytea NOT NULL CHECK (octet_length(brand_sha256) = 32),
  source_resource_version_id uuid NOT NULL,
  source_approval_id uuid NOT NULL,
  source_approved_at timestamptz NOT NULL,
  source_catalog_sha256 bytea NOT NULL CHECK (
    octet_length(source_catalog_sha256) = 32
  ),
  checked_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (workspace_id, proof_id, ordinal),
  UNIQUE (workspace_id, proof_id, content_version_id),
  FOREIGN KEY (workspace_id, proof_id)
    REFERENCES app.public_social_revalidation_proofs (workspace_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, intent_id, ordinal)
    REFERENCES app.public_social_planning_intent_media
      (workspace_id, intent_id, ordinal) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, content_item_id, content_version_id, content_sha256)
    REFERENCES app.company_content_versions
      (workspace_id, content_item_id, id, content_sha256) ON DELETE RESTRICT,
  CHECK (source_approved_at <= checked_at),
  CHECK (expires_at > checked_at),
  CHECK (expires_at <= checked_at + interval '15 minutes'),
  CHECK (checked_at >= created_at - interval '15 minutes'),
  CHECK (checked_at <= created_at + interval '30 seconds')
);

CREATE TABLE app.public_social_intent_materializations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  intent_id uuid NOT NULL,
  proof_id uuid NOT NULL,
  post_id uuid NOT NULL,
  materialized_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, intent_id),
  UNIQUE (workspace_id, proof_id),
  UNIQUE (workspace_id, post_id),
  FOREIGN KEY (workspace_id, intent_id)
    REFERENCES app.public_social_planning_intents (workspace_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, proof_id)
    REFERENCES app.public_social_revalidation_proofs (workspace_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, post_id)
    REFERENCES app.public_social_posts (workspace_id, id)
    ON DELETE RESTRICT
);

DO $immutable_triggers$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'public_social_planning_intents',
    'public_social_planning_intent_targets',
    'public_social_planning_intent_media',
    'public_social_planning_target_cancellations',
    'public_social_planning_target_supersessions',
    'public_social_revalidation_proofs',
    'public_social_revalidation_proof_media',
    'public_social_intent_materializations'
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
    'public_social_planning_intents',
    'public_social_planning_intent_targets',
    'public_social_planning_intent_media',
    'public_social_planning_target_cancellations',
    'public_social_planning_target_supersessions',
    'public_social_revalidation_jobs',
    'public_social_revalidation_proofs',
    'public_social_revalidation_proof_media',
    'public_social_intent_materializations'
  ] LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON app.%I FOR ALL TO r72_owner
       USING (true) WITH CHECK (true)', table_name || '_owner_all', table_name
    );
    EXECUTE format(
      'CREATE POLICY %I ON app.%I FOR ALL TO r72_public_social_definer
       USING (true) WITH CHECK (true)', table_name || '_definer_all', table_name
    );
  END LOOP;
END
$rls$;

GRANT SELECT, INSERT ON app.public_social_planning_intents,
  app.public_social_planning_intent_targets,
  app.public_social_planning_intent_media,
  app.public_social_planning_target_cancellations,
  app.public_social_planning_target_supersessions,
  app.public_social_revalidation_proofs,
  app.public_social_revalidation_proof_media,
  app.public_social_intent_materializations
TO r72_public_social_definer;
GRANT SELECT, INSERT, UPDATE ON app.public_social_revalidation_jobs
TO r72_public_social_definer;

GRANT CREATE ON SCHEMA app_private TO r72_public_social_definer;
SET LOCAL ROLE r72_public_social_definer;

CREATE FUNCTION app_private.create_test_social_planning_intent(
  p_workspace_id uuid,
  p_intent_id uuid,
  p_campaign_id uuid,
  p_revision_id uuid,
  p_content_version_id uuid,
  p_desired_for timestamptz,
  p_max_attempts smallint,
  p_target_ids uuid[],
  p_media_version_ids uuid[] DEFAULT ARRAY[]::uuid[]
)
RETURNS TABLE (intent_id uuid, intent_sha256 text, disposition text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  actor_id uuid;
  request_id text;
  existing app.public_social_planning_intents%ROWTYPE;
  existing_targets uuid[];
  existing_media uuid[];
  target_count integer;
  distinct_target_count integer;
  media_count integer;
  distinct_media_count integer;
  main_content_item_id uuid;
  main_content_sha256 bytea;
  main_blob_sha256 bytea;
  main_brand_sha256 bytea;
  main_approval_request_id uuid;
  main_approval_decision_id uuid;
  main_attestation_id uuid;
  resolved_targets jsonb;
  resolved_media jsonb;
  calculated_intent_sha256 bytea;
BEGIN
  PERFORM app_private.assert_public_social_manager(p_workspace_id);
  actor_id := app_private.current_user_id();
  request_id := app_private.current_request_id();
  IF p_intent_id IS NULL OR p_campaign_id IS NULL OR p_revision_id IS NULL
     OR p_content_version_id IS NULL OR p_desired_for IS NULL
     OR p_max_attempts IS NULL OR p_max_attempts NOT BETWEEN 1 AND 4
     OR p_target_ids IS NULL OR cardinality(p_target_ids) NOT BETWEEN 1 AND 9
     OR array_position(p_target_ids, NULL) IS NOT NULL
     OR p_media_version_ids IS NULL
     OR cardinality(p_media_version_ids) > 10
     OR array_position(p_media_version_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'invalid TEST public-social planning intent'
      USING ERRCODE = '22023';
  END IF;
  SELECT count(*), count(DISTINCT value)
    INTO target_count, distinct_target_count
  FROM unnest(p_target_ids) AS value;
  SELECT count(*), count(DISTINCT value)
    INTO media_count, distinct_media_count
  FROM unnest(p_media_version_ids) AS value;
  IF target_count <> distinct_target_count OR media_count <> distinct_media_count THEN
    RAISE EXCEPTION 'planning targets and media must be unique'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public-social-planning-intent:' || p_workspace_id::text || ':'
        || p_intent_id::text,
      7200040
    )
  );
  SELECT intent.* INTO existing
  FROM app.public_social_planning_intents AS intent
  WHERE intent.workspace_id = p_workspace_id AND intent.id = p_intent_id;
  IF FOUND THEN
    SELECT array_agg(target.target_id ORDER BY target.ordinal)
      INTO existing_targets
    FROM app.public_social_planning_intent_targets AS target
    WHERE target.workspace_id = p_workspace_id AND target.intent_id = p_intent_id;
    SELECT COALESCE(array_agg(media.content_version_id ORDER BY media.ordinal), ARRAY[]::uuid[])
      INTO existing_media
    FROM app.public_social_planning_intent_media AS media
    WHERE media.workspace_id = p_workspace_id AND media.intent_id = p_intent_id;
    IF existing.campaign_id IS DISTINCT FROM p_campaign_id
       OR existing.campaign_revision_id IS DISTINCT FROM p_revision_id
       OR existing.content_version_id IS DISTINCT FROM p_content_version_id
       OR existing.desired_for IS DISTINCT FROM p_desired_for
       OR existing.max_attempts IS DISTINCT FROM p_max_attempts
       OR existing_targets IS DISTINCT FROM p_target_ids
       OR existing_media IS DISTINCT FROM p_media_version_ids THEN
      RAISE EXCEPTION 'planning intent id was reused with different inputs'
        USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT p_intent_id, encode(existing.intent_sha256, 'hex'),
      'replayed'::text;
    RETURN;
  END IF;

  IF p_desired_for < statement_timestamp() - interval '5 seconds'
     OR p_desired_for > statement_timestamp() + interval '366 days' THEN
    RAISE EXCEPTION 'planning time is outside the TEST horizon'
      USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app.public_social_campaign_revisions AS revision
    WHERE revision.workspace_id = p_workspace_id
      AND revision.campaign_id = p_campaign_id
      AND revision.id = p_revision_id
  ) THEN
    RAISE EXCEPTION 'campaign revision was not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT version.content_item_id, version.content_sha256, version.blob_sha256,
    version.brand_sha256, approved.request_id, approved.decision_id,
    fresh.attestation_id
  INTO main_content_item_id, main_content_sha256, main_blob_sha256,
    main_brand_sha256, main_approval_request_id, main_approval_decision_id,
    main_attestation_id
  FROM app.company_content_versions AS version
  JOIN LATERAL (
    SELECT request.id AS request_id, decision.id AS decision_id
    FROM app.company_content_approval_requests AS request
    JOIN app.company_content_approval_decisions AS decision
      ON decision.workspace_id = request.workspace_id
     AND decision.content_item_id = request.content_item_id
     AND decision.content_version_id = request.content_version_id
     AND decision.approval_request_id = request.id
     AND decision.content_sha256 = request.content_sha256
     AND decision.decision = 'approved'
    WHERE request.workspace_id = version.workspace_id
      AND request.content_item_id = version.content_item_id
      AND request.content_version_id = version.id
      AND request.content_sha256 = version.content_sha256
      AND NOT EXISTS (
        SELECT 1 FROM app.company_content_approval_requests AS later_request
        WHERE later_request.workspace_id = request.workspace_id
          AND later_request.content_item_id = request.content_item_id
          AND later_request.content_version_id = request.content_version_id
          AND later_request.request_number > request.request_number
      )
    ORDER BY request.request_number DESC, request.id
    LIMIT 1
  ) AS approved ON true
  JOIN LATERAL (
    SELECT attestation.id AS attestation_id
    FROM app.company_content_source_attestations AS attestation
    WHERE attestation.workspace_id = version.workspace_id
      AND attestation.content_item_id = version.content_item_id
      AND attestation.content_version_id = version.id
      AND attestation.content_sha256 = version.content_sha256
      AND attestation.blob_sha256 = version.blob_sha256
      AND attestation.brand_sha256 = version.brand_sha256
      AND attestation.checked_at <= statement_timestamp()
      AND attestation.expires_at > statement_timestamp()
    ORDER BY attestation.checked_at DESC, attestation.id
    LIMIT 1
  ) AS fresh ON true
  WHERE version.workspace_id = p_workspace_id
    AND version.id = p_content_version_id
    AND version.content_kind = 'social_post'
    AND version.source_system = 'propertypredator.company-content'
    AND version.source_item_id ~
      '^(media|asset|generated):[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
    AND version.source_version ~ '^[1-9][0-9]{0,9}$'
    AND (
      length(version.source_version) < 10
      OR version.source_version <= '2147483647'
    )
    AND version.metadata->>'sourceVersionId' ~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND pg_catalog.pg_input_is_valid(
      version.metadata->>'sourceVersionId', 'uuid'
    )
    AND version.metadata->>'sourceApprovalId' ~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND pg_catalog.pg_input_is_valid(
      version.metadata->>'sourceApprovalId', 'uuid'
    )
    AND CASE
      WHEN version.metadata->>'sourceApprovedAt' ~
          '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
       AND pg_catalog.pg_input_is_valid(
         version.metadata->>'sourceApprovedAt', 'timestamp with time zone'
       )
      THEN (version.metadata->>'sourceApprovedAt')::timestamptz
        <= statement_timestamp()
      ELSE false
    END
    AND public.digest(version.content_body, 'sha256') = version.content_sha256
    AND app_private.public_social_body_supported(version.content_body)
    AND NOT EXISTS (
      SELECT 1 FROM app.company_content_versions AS newer
      WHERE newer.workspace_id = version.workspace_id
        AND newer.content_item_id = version.content_item_id
        AND newer.version_number > version.version_number
    );
  IF NOT FOUND THEN
    RAISE EXCEPTION 'social content is not currently approved and attested'
      USING ERRCODE = '42501';
  END IF;

  WITH requested AS (
    SELECT requested_target_id, ordinal::integer
    FROM unnest(p_target_ids) WITH ORDINALITY
      AS input(requested_target_id, ordinal)
  )
  SELECT jsonb_agg(
    jsonb_build_object(
      'ordinal', requested.ordinal,
      'targetId', target.id,
      'providerConnectionId', target.provider_connection_id,
      'network', target.network,
      'accountRefSha256', encode(target.account_ref_sha256, 'hex')
    ) ORDER BY requested.ordinal
  ) INTO resolved_targets
  FROM requested
  JOIN app.public_social_targets AS target
    ON target.workspace_id = p_workspace_id
   AND target.id = requested.requested_target_id
  JOIN app.provider_connections AS connection
    ON connection.workspace_id = target.workspace_id
   AND connection.id = target.provider_connection_id
  WHERE target.environment = 'test'
    AND connection.provider_id = 'public_social_dark_simulator'
    AND connection.provider_kind = 'social'
    AND connection.environment = 'test'
    AND connection.status = 'active';
  IF jsonb_array_length(COALESCE(resolved_targets, '[]'::jsonb)) <> target_count THEN
    RAISE EXCEPTION 'one or more TEST public-social targets are unavailable'
      USING ERRCODE = '42501';
  END IF;

  WITH requested AS (
    SELECT requested_version_id, ordinal::integer
    FROM unnest(p_media_version_ids) WITH ORDINALITY
      AS input(requested_version_id, ordinal)
  ), resolved AS (
    SELECT requested.ordinal, version.content_item_id, version.id AS version_id,
      version.content_sha256, version.blob_sha256, version.brand_sha256,
      approved.request_id, approved.decision_id, fresh.attestation_id
    FROM requested
    JOIN app.company_content_versions AS version
      ON version.workspace_id = p_workspace_id
     AND version.id = requested.requested_version_id
    JOIN LATERAL (
      SELECT request.id AS request_id, decision.id AS decision_id
      FROM app.company_content_approval_requests AS request
      JOIN app.company_content_approval_decisions AS decision
        ON decision.workspace_id = request.workspace_id
       AND decision.content_item_id = request.content_item_id
       AND decision.content_version_id = request.content_version_id
       AND decision.approval_request_id = request.id
       AND decision.content_sha256 = request.content_sha256
       AND decision.decision = 'approved'
      WHERE request.workspace_id = version.workspace_id
        AND request.content_item_id = version.content_item_id
        AND request.content_version_id = version.id
        AND request.content_sha256 = version.content_sha256
        AND NOT EXISTS (
          SELECT 1 FROM app.company_content_approval_requests AS later_request
          WHERE later_request.workspace_id = request.workspace_id
            AND later_request.content_item_id = request.content_item_id
            AND later_request.content_version_id = request.content_version_id
            AND later_request.request_number > request.request_number
        )
      ORDER BY request.request_number DESC, request.id
      LIMIT 1
    ) AS approved ON true
    JOIN LATERAL (
      SELECT attestation.id AS attestation_id
      FROM app.company_content_source_attestations AS attestation
      WHERE attestation.workspace_id = version.workspace_id
        AND attestation.content_item_id = version.content_item_id
        AND attestation.content_version_id = version.id
        AND attestation.content_sha256 = version.content_sha256
        AND attestation.blob_sha256 = version.blob_sha256
        AND attestation.brand_sha256 = version.brand_sha256
        AND attestation.checked_at <= statement_timestamp()
        AND attestation.expires_at > statement_timestamp()
      ORDER BY attestation.checked_at DESC, attestation.id
      LIMIT 1
    ) AS fresh ON true
    WHERE version.content_kind IN ('image', 'video')
      AND version.source_system = 'propertypredator.company-content'
      AND version.source_item_id ~
        '^(media|asset|generated):[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
      AND version.source_version ~ '^[1-9][0-9]{0,9}$'
      AND (
        length(version.source_version) < 10
        OR version.source_version <= '2147483647'
      )
      AND version.metadata->>'sourceVersionId' ~
        '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND pg_catalog.pg_input_is_valid(
        version.metadata->>'sourceVersionId', 'uuid'
      )
      AND version.metadata->>'sourceApprovalId' ~
        '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND pg_catalog.pg_input_is_valid(
        version.metadata->>'sourceApprovalId', 'uuid'
      )
      AND CASE
        WHEN version.metadata->>'sourceApprovedAt' ~
            '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
         AND pg_catalog.pg_input_is_valid(
           version.metadata->>'sourceApprovedAt', 'timestamp with time zone'
         )
        THEN (version.metadata->>'sourceApprovedAt')::timestamptz
          <= statement_timestamp()
        ELSE false
      END
      AND app_private.public_social_media_payload_supported(
        version.blob_storage_key, version.content_mime_type
      )
      AND NOT EXISTS (
        SELECT 1 FROM app.company_content_versions AS newer
        WHERE newer.workspace_id = version.workspace_id
          AND newer.content_item_id = version.content_item_id
          AND newer.version_number > version.version_number
      )
  )
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'ordinal', resolved.ordinal,
      'contentItemId', resolved.content_item_id,
      'contentVersionId', resolved.version_id,
      'contentSha256', encode(resolved.content_sha256, 'hex'),
      'blobSha256', encode(resolved.blob_sha256, 'hex'),
      'brandSha256', encode(resolved.brand_sha256, 'hex'),
      'approvalRequestId', resolved.request_id,
      'approvalDecisionId', resolved.decision_id,
      'sourceAttestationId', resolved.attestation_id
    ) ORDER BY resolved.ordinal
  ), '[]'::jsonb) INTO resolved_media
  FROM resolved;
  IF jsonb_array_length(resolved_media) <> media_count THEN
    RAISE EXCEPTION 'one or more media assets are not currently approved and attested'
      USING ERRCODE = '42501';
  END IF;

  calculated_intent_sha256 := public.digest(
    jsonb_build_object(
      'contract', 'public-social-planning-intent/v1',
      'workspaceId', p_workspace_id,
      'intentId', p_intent_id,
      'campaignId', p_campaign_id,
      'revisionId', p_revision_id,
      'contentVersionId', p_content_version_id,
      'contentSha256', encode(main_content_sha256, 'hex'),
      'approvalRequestId', main_approval_request_id,
      'approvalDecisionId', main_approval_decision_id,
      'planningAttestationId', main_attestation_id,
      'desiredFor', to_char(p_desired_for AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'maxAttempts', p_max_attempts,
      'targets', resolved_targets,
      'media', resolved_media
    )::text,
    'sha256'
  );

  INSERT INTO app.public_social_planning_intents (
    id, workspace_id, campaign_id, campaign_revision_id,
    content_item_id, content_version_id, content_sha256, blob_sha256,
    brand_sha256, approval_request_id, approval_decision_id,
    planning_source_attestation_id, desired_for, max_attempts, intent_sha256,
    created_by_user_id, created_request_id
  ) VALUES (
    p_intent_id, p_workspace_id, p_campaign_id, p_revision_id,
    main_content_item_id, p_content_version_id, main_content_sha256,
    main_blob_sha256, main_brand_sha256, main_approval_request_id,
    main_approval_decision_id, main_attestation_id, p_desired_for,
    p_max_attempts, calculated_intent_sha256, actor_id, request_id
  );

  INSERT INTO app.public_social_planning_intent_targets (
    workspace_id, intent_id, ordinal, target_id, provider_connection_id,
    network, environment, account_ref_sha256
  )
  SELECT p_workspace_id, p_intent_id, (entry->>'ordinal')::smallint,
    (entry->>'targetId')::uuid, (entry->>'providerConnectionId')::uuid,
    entry->>'network', 'test', decode(entry->>'accountRefSha256', 'hex')
  FROM jsonb_array_elements(resolved_targets) AS entry;

  INSERT INTO app.public_social_planning_intent_media (
    workspace_id, intent_id, ordinal, content_item_id, content_version_id,
    content_sha256, blob_sha256, brand_sha256, approval_request_id,
    approval_decision_id, planning_source_attestation_id
  )
  SELECT p_workspace_id, p_intent_id, (entry->>'ordinal')::smallint,
    (entry->>'contentItemId')::uuid, (entry->>'contentVersionId')::uuid,
    decode(entry->>'contentSha256', 'hex'), decode(entry->>'blobSha256', 'hex'),
    decode(entry->>'brandSha256', 'hex'),
    (entry->>'approvalRequestId')::uuid,
    (entry->>'approvalDecisionId')::uuid,
    (entry->>'sourceAttestationId')::uuid
  FROM jsonb_array_elements(resolved_media) AS entry;

  INSERT INTO app.public_social_revalidation_jobs (
    workspace_id, intent_id, state, attempt_count, max_attempts,
    next_attempt_at
  ) VALUES (
    p_workspace_id, p_intent_id, 'waiting_for_window', 0, p_max_attempts,
    GREATEST(p_desired_for - interval '10 minutes', statement_timestamp())
  );

  RETURN QUERY SELECT p_intent_id, encode(calculated_intent_sha256, 'hex'),
    'applied'::text;
END;
$function$;

CREATE FUNCTION app_private.list_test_social_planner_targets(
  p_workspace_id uuid,
  p_limit integer
)
RETURNS TABLE (
  target_id uuid,
  network text,
  target_label text,
  has_more boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF p_workspace_id IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 120
     OR app_private.current_workspace_id() IS DISTINCT FROM p_workspace_id
     OR NOT app_private.has_active_workspace_membership(
       app_private.current_user_id(), p_workspace_id
     ) THEN
    RAISE EXCEPTION 'planner target input is invalid' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  WITH projection AS MATERIALIZED (
    SELECT target.id AS target_id, target.network,
      target.display_name AS target_label
    FROM app.public_social_targets AS target
    JOIN app.provider_connections AS connection
      ON connection.workspace_id = target.workspace_id
     AND connection.id = target.provider_connection_id
    WHERE target.workspace_id = p_workspace_id
      AND target.environment = 'test'
      AND connection.provider_id = 'public_social_dark_simulator'
      AND connection.provider_kind = 'social'
      AND connection.environment = 'test'
      AND connection.status = 'active'
  )
  SELECT projection.target_id, projection.network, projection.target_label,
    count(*) OVER () > p_limit AS has_more
  FROM projection
  ORDER BY projection.network, projection.target_label, projection.target_id
  LIMIT p_limit + 1;
END;
$function$;

CREATE FUNCTION app_private.cancel_test_social_planning_target(
  p_workspace_id uuid,
  p_intent_id uuid,
  p_target_id uuid,
  p_reason_sha256 bytea
)
RETURNS TABLE (
  intent_id uuid,
  target_id uuid,
  state text,
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
  existing app.public_social_planning_target_cancellations%ROWTYPE;
  selected_operation app.public_social_operations%ROWTYPE;
BEGIN
  PERFORM app_private.assert_public_social_manager(p_workspace_id);
  actor_id := app_private.current_user_id();
  request_id := app_private.current_request_id();
  IF p_intent_id IS NULL OR p_target_id IS NULL OR p_reason_sha256 IS NULL
     OR octet_length(p_reason_sha256) <> 32 THEN
    RAISE EXCEPTION 'invalid planning cancellation evidence'
      USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public-social-planning-target:' || p_workspace_id::text || ':'
        || p_intent_id::text || ':' || p_target_id::text,
      7200040
    )
  );
  SELECT cancellation.* INTO existing
  FROM app.public_social_planning_target_cancellations AS cancellation
  WHERE cancellation.workspace_id = p_workspace_id
    AND cancellation.intent_id = p_intent_id
    AND cancellation.target_id = p_target_id;
  IF FOUND THEN
    IF existing.cancellation_kind <> 'user_cancelled'
       OR existing.reason_sha256 IS DISTINCT FROM p_reason_sha256 THEN
      RAISE EXCEPTION 'planning target already has different lifecycle evidence'
        USING ERRCODE = '55000';
    END IF;
    RETURN QUERY SELECT p_intent_id, p_target_id, 'cancelled'::text,
      'replayed'::text;
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app.public_social_planning_intent_targets AS target
    WHERE target.workspace_id = p_workspace_id
      AND target.intent_id = p_intent_id AND target.target_id = p_target_id
  ) THEN
    RAISE EXCEPTION 'planning target was not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT operation.* INTO selected_operation
  FROM app.public_social_intent_materializations AS materialization
  JOIN app.public_social_operations AS operation
    ON operation.workspace_id = materialization.workspace_id
   AND operation.post_id = materialization.post_id
   AND operation.target_id = p_target_id
  WHERE materialization.workspace_id = p_workspace_id
    AND materialization.intent_id = p_intent_id
  FOR UPDATE OF operation;
  IF FOUND AND selected_operation.state NOT IN (
    'waiting_for_test_time', 'retry_wait', 'simulated_cancelled'
  ) THEN
    RAISE EXCEPTION 'materialized planning target can no longer be cancelled safely'
      USING ERRCODE = '55000';
  END IF;
  IF FOUND AND selected_operation.state <> 'simulated_cancelled' THEN
    UPDATE app.public_social_operations AS operation
       SET state = 'simulated_cancelled', completed_at = statement_timestamp(),
           updated_at = statement_timestamp(), row_version = operation.row_version + 1,
           lease_token_hash = NULL, lease_worker_id = NULL,
           lease_expires_at = NULL
     WHERE operation.workspace_id = p_workspace_id
       AND operation.id = selected_operation.id;
    INSERT INTO app.public_social_events (
      workspace_id, post_id, target_id, operation_id, event_kind,
      actor_kind, actor_user_id, request_id, reason_sha256
    ) VALUES (
      p_workspace_id, selected_operation.post_id, p_target_id,
      selected_operation.id, 'simulated_cancelled', 'user', actor_id,
      request_id, p_reason_sha256
    );
  END IF;

  INSERT INTO app.public_social_planning_target_cancellations (
    workspace_id, intent_id, target_id, cancellation_kind, reason_sha256,
    cancelled_by_user_id, cancelled_request_id
  ) VALUES (
    p_workspace_id, p_intent_id, p_target_id, 'user_cancelled',
    p_reason_sha256, actor_id, request_id
  );
  RETURN QUERY SELECT p_intent_id, p_target_id, 'cancelled'::text,
    'applied'::text;
END;
$function$;

CREATE FUNCTION app_private.reschedule_test_social_planning_target(
  p_workspace_id uuid,
  p_predecessor_intent_id uuid,
  p_target_id uuid,
  p_successor_intent_id uuid,
  p_new_desired_for timestamptz,
  p_reason_sha256 bytea
)
RETURNS TABLE (successor_intent_id uuid, disposition text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  actor_id uuid;
  request_id text;
  predecessor app.public_social_planning_intents%ROWTYPE;
  existing app.public_social_planning_target_supersessions%ROWTYPE;
  existing_cancellation app.public_social_planning_target_cancellations%ROWTYPE;
  selected_operation app.public_social_operations%ROWTYPE;
  predecessor_media_ids uuid[];
  created record;
BEGIN
  PERFORM app_private.assert_public_social_manager(p_workspace_id);
  actor_id := app_private.current_user_id();
  request_id := app_private.current_request_id();
  IF p_predecessor_intent_id IS NULL OR p_target_id IS NULL
     OR p_successor_intent_id IS NULL
     OR p_successor_intent_id = p_predecessor_intent_id
     OR p_new_desired_for IS NULL OR p_reason_sha256 IS NULL
     OR octet_length(p_reason_sha256) <> 32 THEN
    RAISE EXCEPTION 'invalid planning reschedule evidence'
      USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public-social-planning-target:' || p_workspace_id::text || ':'
        || p_predecessor_intent_id::text || ':' || p_target_id::text,
      7200040
    )
  );
  SELECT supersession.* INTO existing
  FROM app.public_social_planning_target_supersessions AS supersession
  WHERE supersession.workspace_id = p_workspace_id
    AND supersession.predecessor_intent_id = p_predecessor_intent_id
    AND supersession.predecessor_target_id = p_target_id;
  IF FOUND THEN
    IF existing.successor_intent_id IS DISTINCT FROM p_successor_intent_id
       OR existing.new_desired_for IS DISTINCT FROM p_new_desired_for
       OR existing.reason_sha256 IS DISTINCT FROM p_reason_sha256 THEN
      RAISE EXCEPTION 'planning target already has different supersession evidence'
        USING ERRCODE = '55000';
    END IF;
    RETURN QUERY SELECT p_successor_intent_id, 'replayed'::text;
    RETURN;
  END IF;

  SELECT intent.* INTO predecessor
  FROM app.public_social_planning_intents AS intent
  JOIN app.public_social_planning_intent_targets AS target
    ON target.workspace_id = intent.workspace_id AND target.intent_id = intent.id
   AND target.target_id = p_target_id
  WHERE intent.workspace_id = p_workspace_id
    AND intent.id = p_predecessor_intent_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'predecessor planning target was not found'
      USING ERRCODE = 'P0002';
  END IF;
  IF p_new_desired_for IS NOT DISTINCT FROM predecessor.desired_for THEN
    RAISE EXCEPTION 'reschedule must change the desired time'
      USING ERRCODE = '22023';
  END IF;
  SELECT cancellation.* INTO existing_cancellation
  FROM app.public_social_planning_target_cancellations AS cancellation
  WHERE cancellation.workspace_id = p_workspace_id
    AND cancellation.intent_id = p_predecessor_intent_id
    AND cancellation.target_id = p_target_id;
  IF FOUND THEN
    RAISE EXCEPTION 'cancelled planning target cannot be rescheduled'
      USING ERRCODE = '55000';
  END IF;

  SELECT operation.* INTO selected_operation
  FROM app.public_social_intent_materializations AS materialization
  JOIN app.public_social_operations AS operation
    ON operation.workspace_id = materialization.workspace_id
   AND operation.post_id = materialization.post_id
   AND operation.target_id = p_target_id
  WHERE materialization.workspace_id = p_workspace_id
    AND materialization.intent_id = p_predecessor_intent_id
  FOR UPDATE OF operation;
  IF FOUND AND selected_operation.state NOT IN (
    'waiting_for_test_time', 'retry_wait', 'simulated_cancelled'
  ) THEN
    RAISE EXCEPTION 'materialized planning target can no longer be rescheduled safely'
      USING ERRCODE = '55000';
  END IF;

  SELECT COALESCE(array_agg(media.content_version_id ORDER BY media.ordinal),
      ARRAY[]::uuid[])
    INTO predecessor_media_ids
  FROM app.public_social_planning_intent_media AS media
  WHERE media.workspace_id = p_workspace_id
    AND media.intent_id = p_predecessor_intent_id;
  SELECT * INTO created
  FROM app_private.create_test_social_planning_intent(
    p_workspace_id, p_successor_intent_id, predecessor.campaign_id,
    predecessor.campaign_revision_id, predecessor.content_version_id,
    p_new_desired_for, predecessor.max_attempts, ARRAY[p_target_id],
    predecessor_media_ids
  );

  IF selected_operation.id IS NOT NULL
     AND selected_operation.state <> 'simulated_cancelled' THEN
    UPDATE app.public_social_operations AS operation
       SET state = 'simulated_cancelled', completed_at = statement_timestamp(),
           updated_at = statement_timestamp(), row_version = operation.row_version + 1,
           lease_token_hash = NULL, lease_worker_id = NULL,
           lease_expires_at = NULL
     WHERE operation.workspace_id = p_workspace_id
       AND operation.id = selected_operation.id;
    INSERT INTO app.public_social_events (
      workspace_id, post_id, target_id, operation_id, event_kind,
      actor_kind, actor_user_id, request_id, reason_sha256
    ) VALUES (
      p_workspace_id, selected_operation.post_id, p_target_id,
      selected_operation.id, 'simulated_cancelled', 'user', actor_id,
      request_id, p_reason_sha256
    );
  END IF;

  INSERT INTO app.public_social_planning_target_cancellations (
    workspace_id, intent_id, target_id, cancellation_kind, reason_sha256,
    cancelled_by_user_id, cancelled_request_id
  ) VALUES (
    p_workspace_id, p_predecessor_intent_id, p_target_id, 'rescheduled',
    p_reason_sha256, actor_id, request_id
  );
  INSERT INTO app.public_social_planning_target_supersessions (
    workspace_id, predecessor_intent_id, predecessor_target_id,
    successor_intent_id, successor_target_id, previous_desired_for,
    new_desired_for, reason_sha256, superseded_by_user_id,
    superseded_request_id
  ) VALUES (
    p_workspace_id, p_predecessor_intent_id, p_target_id,
    p_successor_intent_id, p_target_id, predecessor.desired_for,
    p_new_desired_for, p_reason_sha256, actor_id, request_id
  );
  RETURN QUERY SELECT p_successor_intent_id, 'applied'::text;
END;
$function$;

CREATE FUNCTION app_private.claim_due_test_social_revalidations(
  p_worker_id uuid,
  p_lease_token_hash bytea,
  p_batch_size integer,
  p_lease_seconds integer
)
RETURNS TABLE (
  job_id uuid,
  workspace_id uuid,
  intent_id uuid,
  lease_version bigint,
  desired_for timestamptz,
  content_item_id uuid,
  content_version_id uuid,
  source_system text,
  source_item_id text,
  source_version text,
  source_resource_version_id uuid,
  source_approval_id uuid,
  source_approved_at text,
  content_sha256 text,
  blob_sha256 text,
  brand_sha256 text,
  media jsonb
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF p_worker_id IS NULL OR p_lease_token_hash IS NULL
     OR octet_length(p_lease_token_hash) <> 32
     OR p_batch_size IS NULL OR p_batch_size NOT BETWEEN 1 AND 50
     OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 300 THEN
    RAISE EXCEPTION 'invalid revalidation claim' USING ERRCODE = '22023';
  END IF;

  -- Legacy rows created before the source-proof contract was enforced must
  -- fail closed without poisoning this global claim.  This statement runs
  -- before candidate selection, so a malformed job in one workspace is
  -- terminalised and a valid job in another workspace can still be leased by
  -- the same call.  CASE is deliberate: no UUID/timestamp cast is reachable
  -- until PostgreSQL has proved the input is both canonical and parseable.
  UPDATE app.public_social_revalidation_jobs AS job
     SET state = 'dead_letter', lease_token_hash = NULL,
         lease_worker_id = NULL, lease_expires_at = NULL,
         last_error_code = 'revalidation.source_metadata_invalid',
         updated_at = statement_timestamp(), row_version = job.row_version + 1,
         completed_at = statement_timestamp()
    FROM app.public_social_planning_intents AS intent
    JOIN app.company_content_versions AS version
      ON version.workspace_id = intent.workspace_id
     AND version.content_item_id = intent.content_item_id
     AND version.id = intent.content_version_id
     AND version.content_sha256 = intent.content_sha256
     AND version.blob_sha256 = intent.blob_sha256
     AND version.brand_sha256 = intent.brand_sha256
   WHERE intent.workspace_id = job.workspace_id AND intent.id = job.intent_id
     AND (
       job.state IN ('waiting_for_window', 'retry_wait')
       OR (job.state = 'leased' AND job.lease_expires_at <= statement_timestamp())
     )
     AND job.next_attempt_at <= statement_timestamp()
     AND intent.desired_for <= statement_timestamp() + interval '10 minutes'
     AND (
       (
         version.source_system = 'propertypredator.company-content'
         AND version.source_item_id ~
           '^(media|asset|generated):[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
         AND version.source_version ~ '^[1-9][0-9]{0,9}$'
         AND (
           length(version.source_version) < 10
           OR version.source_version <= '2147483647'
         )
         AND version.metadata->>'sourceVersionId' ~
           '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
         AND pg_catalog.pg_input_is_valid(
           version.metadata->>'sourceVersionId', 'uuid'
         )
         AND version.metadata->>'sourceApprovalId' ~
           '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
         AND pg_catalog.pg_input_is_valid(
           version.metadata->>'sourceApprovalId', 'uuid'
         )
         AND CASE
           WHEN version.metadata->>'sourceApprovedAt' ~
               '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
            AND pg_catalog.pg_input_is_valid(
              version.metadata->>'sourceApprovedAt', 'timestamp with time zone'
            )
           THEN (version.metadata->>'sourceApprovedAt')::timestamptz
             <= statement_timestamp()
           ELSE false
         END
       ) IS NOT TRUE
       OR EXISTS (
         SELECT 1
         FROM app.public_social_planning_intent_media AS planned_media
         JOIN app.company_content_versions AS media_version
           ON media_version.workspace_id = planned_media.workspace_id
          AND media_version.content_item_id = planned_media.content_item_id
          AND media_version.id = planned_media.content_version_id
          AND media_version.content_sha256 = planned_media.content_sha256
          AND media_version.blob_sha256 = planned_media.blob_sha256
          AND media_version.brand_sha256 = planned_media.brand_sha256
         WHERE planned_media.workspace_id = intent.workspace_id
           AND planned_media.intent_id = intent.id
           AND (
             media_version.source_system = 'propertypredator.company-content'
             AND media_version.source_item_id ~
               '^(media|asset|generated):[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
             AND media_version.source_version ~ '^[1-9][0-9]{0,9}$'
             AND (
               length(media_version.source_version) < 10
               OR media_version.source_version <= '2147483647'
             )
             AND media_version.metadata->>'sourceVersionId' ~
               '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
             AND pg_catalog.pg_input_is_valid(
               media_version.metadata->>'sourceVersionId', 'uuid'
             )
             AND media_version.metadata->>'sourceApprovalId' ~
               '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
             AND pg_catalog.pg_input_is_valid(
               media_version.metadata->>'sourceApprovalId', 'uuid'
             )
             AND CASE
               WHEN media_version.metadata->>'sourceApprovedAt' ~
                   '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
                AND pg_catalog.pg_input_is_valid(
                  media_version.metadata->>'sourceApprovedAt',
                  'timestamp with time zone'
                )
               THEN (media_version.metadata->>'sourceApprovedAt')::timestamptz
                 <= statement_timestamp()
               ELSE false
             END
           ) IS NOT TRUE
       )
     );

  -- Resolve terminal planner states before leasing new work. An expired lease
  -- is terminal here when the final target was cancelled or its JIT window is
  -- already gone; it must never churn through generic retries.
  UPDATE app.public_social_revalidation_jobs AS job
     SET state = 'cancelled', lease_token_hash = NULL,
         lease_worker_id = NULL, lease_expires_at = NULL,
         last_error_code = 'revalidation.cancelled',
         updated_at = statement_timestamp(), row_version = job.row_version + 1,
         completed_at = statement_timestamp()
    FROM app.public_social_planning_intents AS intent
   WHERE intent.workspace_id = job.workspace_id AND intent.id = job.intent_id
     AND (
       job.state IN ('waiting_for_window', 'retry_wait')
       OR (job.state = 'leased' AND job.lease_expires_at <= statement_timestamp())
     )
     AND NOT EXISTS (
       SELECT 1 FROM app.public_social_planning_intent_targets AS target
       WHERE target.workspace_id = intent.workspace_id
         AND target.intent_id = intent.id
         AND NOT EXISTS (
           SELECT 1 FROM app.public_social_planning_target_cancellations AS cancellation
           WHERE cancellation.workspace_id = target.workspace_id
             AND cancellation.intent_id = target.intent_id
             AND cancellation.target_id = target.target_id
         )
         AND NOT EXISTS (
           SELECT 1 FROM app.public_social_planning_target_supersessions AS supersession
           WHERE supersession.workspace_id = target.workspace_id
             AND supersession.predecessor_intent_id = target.intent_id
             AND supersession.predecessor_target_id = target.target_id
         )
     );
  UPDATE app.public_social_revalidation_jobs AS job
     SET state = 'window_expired', lease_token_hash = NULL,
         lease_worker_id = NULL, lease_expires_at = NULL,
         last_error_code = 'revalidation.window_expired',
         updated_at = statement_timestamp(), row_version = job.row_version + 1,
         completed_at = statement_timestamp()
    FROM app.public_social_planning_intents AS intent
   WHERE intent.workspace_id = job.workspace_id AND intent.id = job.intent_id
     AND (
       job.state IN ('waiting_for_window', 'retry_wait')
       OR (job.state = 'leased' AND job.lease_expires_at <= statement_timestamp())
     )
     AND intent.desired_for < statement_timestamp() - interval '5 minutes';

  UPDATE app.public_social_revalidation_jobs AS job
     SET state = CASE WHEN job.attempt_count >= job.max_attempts
                      THEN 'dead_letter' ELSE 'retry_wait' END,
         next_attempt_at = statement_timestamp() + interval '30 seconds',
         lease_token_hash = NULL, lease_worker_id = NULL,
         lease_expires_at = NULL,
         last_error_code = 'revalidation.lease_expired',
         updated_at = statement_timestamp(), row_version = job.row_version + 1,
         completed_at = CASE WHEN job.attempt_count >= job.max_attempts
                             THEN statement_timestamp() ELSE NULL END
   WHERE job.state = 'leased' AND job.lease_expires_at <= statement_timestamp();

  RETURN QUERY
  WITH selected AS MATERIALIZED (
    SELECT job.workspace_id, job.id
    FROM app.public_social_revalidation_jobs AS job
    JOIN app.public_social_planning_intents AS intent
      ON intent.workspace_id = job.workspace_id AND intent.id = job.intent_id
    JOIN app.company_content_versions AS version
      ON version.workspace_id = intent.workspace_id
     AND version.content_item_id = intent.content_item_id
     AND version.id = intent.content_version_id
     AND version.content_sha256 = intent.content_sha256
     AND version.blob_sha256 = intent.blob_sha256
     AND version.brand_sha256 = intent.brand_sha256
    WHERE job.state IN ('waiting_for_window', 'retry_wait')
      AND job.next_attempt_at <= statement_timestamp()
      AND intent.desired_for <= statement_timestamp() + interval '10 minutes'
      AND intent.desired_for >= statement_timestamp() - interval '5 minutes'
      AND version.source_system = 'propertypredator.company-content'
      AND version.source_item_id ~
        '^(media|asset|generated):[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
      AND version.source_version ~ '^[1-9][0-9]{0,9}$'
      AND (
        length(version.source_version) < 10
        OR version.source_version <= '2147483647'
      )
      AND version.metadata->>'sourceVersionId' ~
        '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND pg_catalog.pg_input_is_valid(
        version.metadata->>'sourceVersionId', 'uuid'
      )
      AND version.metadata->>'sourceApprovalId' ~
        '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND pg_catalog.pg_input_is_valid(
        version.metadata->>'sourceApprovalId', 'uuid'
      )
      AND CASE
        WHEN version.metadata->>'sourceApprovedAt' ~
            '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
         AND pg_catalog.pg_input_is_valid(
           version.metadata->>'sourceApprovedAt', 'timestamp with time zone'
         )
        THEN (version.metadata->>'sourceApprovedAt')::timestamptz
          <= statement_timestamp()
        ELSE false
      END
      AND NOT EXISTS (
        SELECT 1
        FROM app.public_social_planning_intent_media AS planned_media
        JOIN app.company_content_versions AS media_version
          ON media_version.workspace_id = planned_media.workspace_id
         AND media_version.content_item_id = planned_media.content_item_id
         AND media_version.id = planned_media.content_version_id
         AND media_version.content_sha256 = planned_media.content_sha256
         AND media_version.blob_sha256 = planned_media.blob_sha256
         AND media_version.brand_sha256 = planned_media.brand_sha256
        WHERE planned_media.workspace_id = intent.workspace_id
          AND planned_media.intent_id = intent.id
          AND (
            media_version.source_system = 'propertypredator.company-content'
            AND media_version.source_item_id ~
              '^(media|asset|generated):[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
            AND media_version.source_version ~ '^[1-9][0-9]{0,9}$'
            AND (
              length(media_version.source_version) < 10
              OR media_version.source_version <= '2147483647'
            )
            AND media_version.metadata->>'sourceVersionId' ~
              '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
            AND pg_catalog.pg_input_is_valid(
              media_version.metadata->>'sourceVersionId', 'uuid'
            )
            AND media_version.metadata->>'sourceApprovalId' ~
              '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
            AND pg_catalog.pg_input_is_valid(
              media_version.metadata->>'sourceApprovalId', 'uuid'
            )
            AND CASE
              WHEN media_version.metadata->>'sourceApprovedAt' ~
                  '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
               AND pg_catalog.pg_input_is_valid(
                 media_version.metadata->>'sourceApprovedAt',
                 'timestamp with time zone'
               )
              THEN (media_version.metadata->>'sourceApprovedAt')::timestamptz
                <= statement_timestamp()
              ELSE false
            END
          ) IS NOT TRUE
      )
      AND EXISTS (
        SELECT 1 FROM app.public_social_planning_intent_targets AS target
        WHERE target.workspace_id = intent.workspace_id
          AND target.intent_id = intent.id
          AND NOT EXISTS (
            SELECT 1
            FROM app.public_social_planning_target_cancellations AS cancellation
            WHERE cancellation.workspace_id = target.workspace_id
              AND cancellation.intent_id = target.intent_id
              AND cancellation.target_id = target.target_id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM app.public_social_planning_target_supersessions AS supersession
            WHERE supersession.workspace_id = target.workspace_id
              AND supersession.predecessor_intent_id = target.intent_id
              AND supersession.predecessor_target_id = target.target_id
          )
      )
    ORDER BY job.next_attempt_at, job.created_at, job.id
    FOR UPDATE OF job SKIP LOCKED
    LIMIT p_batch_size
  ), claimed AS (
    UPDATE app.public_social_revalidation_jobs AS job
       SET state = 'leased', attempt_count = job.attempt_count + 1,
           lease_token_hash = p_lease_token_hash,
           lease_worker_id = p_worker_id,
           lease_expires_at = statement_timestamp()
             + make_interval(secs => p_lease_seconds),
           lease_version = job.lease_version + 1,
           last_error_code = NULL, updated_at = statement_timestamp(),
           row_version = job.row_version + 1
      FROM selected
     WHERE job.workspace_id = selected.workspace_id AND job.id = selected.id
    RETURNING job.*
  )
  SELECT claimed.id, claimed.workspace_id, intent.id, claimed.lease_version,
    intent.desired_for, version.content_item_id, version.id,
    version.source_system, version.source_item_id, version.source_version,
    CASE
      WHEN version.metadata->>'sourceVersionId' ~
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       AND pg_catalog.pg_input_is_valid(
         version.metadata->>'sourceVersionId', 'uuid'
       )
      THEN (version.metadata->>'sourceVersionId')::uuid
      ELSE NULL
    END,
    CASE
      WHEN version.metadata->>'sourceApprovalId' ~
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       AND pg_catalog.pg_input_is_valid(
         version.metadata->>'sourceApprovalId', 'uuid'
       )
      THEN (version.metadata->>'sourceApprovalId')::uuid
      ELSE NULL
    END,
    version.metadata->>'sourceApprovedAt',
    encode(version.content_sha256, 'hex'), encode(version.blob_sha256, 'hex'),
    encode(version.brand_sha256, 'hex'),
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'ordinal', planned_media.ordinal,
        'contentItemId', media_version.content_item_id,
        'contentVersionId', media_version.id,
        'sourceSystem', media_version.source_system,
        'sourceItemId', media_version.source_item_id,
        'sourceVersion', media_version.source_version,
        'sourceResourceVersionId', media_version.metadata->>'sourceVersionId',
        'sourceApprovalId', media_version.metadata->>'sourceApprovalId',
        'sourceApprovedAt', media_version.metadata->>'sourceApprovedAt',
        'contentSha256', encode(media_version.content_sha256, 'hex'),
        'blobSha256', encode(media_version.blob_sha256, 'hex'),
        'brandSha256', encode(media_version.brand_sha256, 'hex')
      ) ORDER BY planned_media.ordinal)
      FROM app.public_social_planning_intent_media AS planned_media
      JOIN app.company_content_versions AS media_version
        ON media_version.workspace_id = planned_media.workspace_id
       AND media_version.id = planned_media.content_version_id
      WHERE planned_media.workspace_id = intent.workspace_id
        AND planned_media.intent_id = intent.id
    ), '[]'::jsonb)
  FROM claimed
  JOIN app.public_social_planning_intents AS intent
    ON intent.workspace_id = claimed.workspace_id AND intent.id = claimed.intent_id
  JOIN app.company_content_versions AS version
    ON version.workspace_id = intent.workspace_id
   AND version.id = intent.content_version_id
  ORDER BY intent.desired_for, claimed.id;
END;
$function$;

-- This read capability is fenced to one currently leased job. The caller
-- supplies no workspace, content tuple or human actor; all are recovered from
-- immutable planning evidence inside the definer boundary.
CREATE FUNCTION app_private.load_leased_test_social_source_versions(
  p_job_id uuid,
  p_worker_id uuid,
  p_lease_token_hash bytea,
  p_lease_version bigint
)
RETURNS TABLE (
  resource_ordinal smallint,
  workspace_id uuid,
  content_item_id uuid,
  content_version_id uuid,
  source_system text,
  source_item_id text,
  source_version text,
  content_sha256 text,
  body_sha256 text,
  blob_sha256 text,
  brand_sha256 text,
  source_resource_version_id uuid,
  source_approval_id uuid,
  source_approved_at text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  selected app.public_social_revalidation_jobs%ROWTYPE;
BEGIN
  IF p_job_id IS NULL OR p_worker_id IS NULL
     OR p_lease_token_hash IS NULL OR octet_length(p_lease_token_hash) <> 32
     OR p_lease_version IS NULL OR p_lease_version <= 0 THEN
    RAISE EXCEPTION 'invalid leased source-proof read'
      USING ERRCODE = '22023';
  END IF;
  SELECT job.* INTO selected
  FROM app.public_social_revalidation_jobs AS job
  WHERE job.id = p_job_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'revalidation job was not found' USING ERRCODE = 'P0002';
  END IF;
  IF selected.state <> 'leased'
     OR selected.lease_worker_id IS DISTINCT FROM p_worker_id
     OR selected.lease_token_hash IS DISTINCT FROM p_lease_token_hash
     OR selected.lease_version IS DISTINCT FROM p_lease_version
     OR selected.lease_expires_at <= statement_timestamp() THEN
    RAISE EXCEPTION 'revalidation lease was lost' USING ERRCODE = '55000';
  END IF;

  RETURN QUERY
  SELECT resource.resource_ordinal, resource.workspace_id,
    resource.content_item_id, resource.content_version_id,
    resource.source_system, resource.source_item_id,
    resource.source_version, resource.content_sha256,
    resource.body_sha256, resource.blob_sha256, resource.brand_sha256,
    resource.source_resource_version_id, resource.source_approval_id,
    resource.source_approved_at
  FROM (
    SELECT 0::smallint AS resource_ordinal, intent.workspace_id,
      version.content_item_id, version.id AS content_version_id,
      version.source_system, version.source_item_id, version.source_version,
      encode(version.content_sha256, 'hex') AS content_sha256,
      encode(public.digest(version.content_body, 'sha256'), 'hex') AS body_sha256,
      encode(version.blob_sha256, 'hex') AS blob_sha256,
      encode(version.brand_sha256, 'hex') AS brand_sha256,
      CASE
        WHEN version.metadata->>'sourceVersionId' ~
            '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
         AND pg_catalog.pg_input_is_valid(
           version.metadata->>'sourceVersionId', 'uuid'
         )
        THEN (version.metadata->>'sourceVersionId')::uuid
        ELSE NULL
      END AS source_resource_version_id,
      CASE
        WHEN version.metadata->>'sourceApprovalId' ~
            '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
         AND pg_catalog.pg_input_is_valid(
           version.metadata->>'sourceApprovalId', 'uuid'
         )
        THEN (version.metadata->>'sourceApprovalId')::uuid
        ELSE NULL
      END AS source_approval_id,
      version.metadata->>'sourceApprovedAt' AS source_approved_at
    FROM app.public_social_planning_intents AS intent
    JOIN app.company_content_versions AS version
      ON version.workspace_id = intent.workspace_id
     AND version.content_item_id = intent.content_item_id
     AND version.id = intent.content_version_id
     AND version.content_sha256 = intent.content_sha256
     AND version.blob_sha256 = intent.blob_sha256
     AND version.brand_sha256 = intent.brand_sha256
    WHERE intent.workspace_id = selected.workspace_id
      AND intent.id = selected.intent_id
      AND version.source_system = 'propertypredator.company-content'
      AND version.source_item_id ~
        '^(media|asset|generated):[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
      AND version.source_version ~ '^[1-9][0-9]{0,9}$'
      AND (
        length(version.source_version) < 10
        OR version.source_version <= '2147483647'
      )
      AND version.metadata->>'sourceVersionId' ~
        '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND pg_catalog.pg_input_is_valid(
        version.metadata->>'sourceVersionId', 'uuid'
      )
      AND version.metadata->>'sourceApprovalId' ~
        '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND pg_catalog.pg_input_is_valid(
        version.metadata->>'sourceApprovalId', 'uuid'
      )
      AND CASE
        WHEN version.metadata->>'sourceApprovedAt' ~
            '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
         AND pg_catalog.pg_input_is_valid(
           version.metadata->>'sourceApprovedAt', 'timestamp with time zone'
         )
        THEN (version.metadata->>'sourceApprovedAt')::timestamptz
          <= statement_timestamp()
        ELSE false
      END
    UNION ALL
    SELECT media.ordinal, media.workspace_id,
      version.content_item_id, version.id,
      version.source_system, version.source_item_id, version.source_version,
      encode(version.content_sha256, 'hex'),
      encode(public.digest(version.content_body, 'sha256'), 'hex'),
      encode(version.blob_sha256, 'hex'), encode(version.brand_sha256, 'hex'),
      CASE
        WHEN version.metadata->>'sourceVersionId' ~
            '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
         AND pg_catalog.pg_input_is_valid(
           version.metadata->>'sourceVersionId', 'uuid'
         )
        THEN (version.metadata->>'sourceVersionId')::uuid
        ELSE NULL
      END,
      CASE
        WHEN version.metadata->>'sourceApprovalId' ~
            '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
         AND pg_catalog.pg_input_is_valid(
           version.metadata->>'sourceApprovalId', 'uuid'
         )
        THEN (version.metadata->>'sourceApprovalId')::uuid
        ELSE NULL
      END,
      version.metadata->>'sourceApprovedAt'
    FROM app.public_social_planning_intent_media AS media
    JOIN app.company_content_versions AS version
      ON version.workspace_id = media.workspace_id
     AND version.content_item_id = media.content_item_id
     AND version.id = media.content_version_id
     AND version.content_sha256 = media.content_sha256
     AND version.blob_sha256 = media.blob_sha256
     AND version.brand_sha256 = media.brand_sha256
    WHERE media.workspace_id = selected.workspace_id
      AND media.intent_id = selected.intent_id
      AND version.source_system = 'propertypredator.company-content'
      AND version.source_item_id ~
        '^(media|asset|generated):[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
      AND version.source_version ~ '^[1-9][0-9]{0,9}$'
      AND (
        length(version.source_version) < 10
        OR version.source_version <= '2147483647'
      )
      AND version.metadata->>'sourceVersionId' ~
        '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND pg_catalog.pg_input_is_valid(
        version.metadata->>'sourceVersionId', 'uuid'
      )
      AND version.metadata->>'sourceApprovalId' ~
        '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND pg_catalog.pg_input_is_valid(
        version.metadata->>'sourceApprovalId', 'uuid'
      )
      AND CASE
        WHEN version.metadata->>'sourceApprovedAt' ~
            '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
         AND pg_catalog.pg_input_is_valid(
           version.metadata->>'sourceApprovedAt', 'timestamp with time zone'
         )
        THEN (version.metadata->>'sourceApprovedAt')::timestamptz
          <= statement_timestamp()
        ELSE false
      END
  ) AS resource
  ORDER BY resource.resource_ordinal;
END;
$function$;

CREATE FUNCTION app_private.fail_test_social_revalidation(
  p_workspace_id uuid,
  p_job_id uuid,
  p_worker_id uuid,
  p_lease_token_hash bytea,
  p_lease_version bigint,
  p_error_code text,
  p_retryable boolean
)
RETURNS TABLE (job_id uuid, state text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  selected app.public_social_revalidation_jobs%ROWTYPE;
  next_state text;
BEGIN
  IF p_workspace_id IS NULL OR p_job_id IS NULL OR p_worker_id IS NULL
     OR p_lease_token_hash IS NULL OR octet_length(p_lease_token_hash) <> 32
     OR p_lease_version IS NULL OR p_lease_version <= 0
     OR p_error_code IS NULL
     OR p_error_code !~ '^[a-z][a-z0-9_.:-]{0,99}$'
     OR p_retryable IS NULL THEN
    RAISE EXCEPTION 'invalid revalidation failure evidence'
      USING ERRCODE = '22023';
  END IF;
  SELECT job.* INTO selected
  FROM app.public_social_revalidation_jobs AS job
  WHERE job.workspace_id = p_workspace_id AND job.id = p_job_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'revalidation job was not found' USING ERRCODE = 'P0002';
  END IF;
  IF selected.state <> 'leased'
     OR selected.lease_worker_id IS DISTINCT FROM p_worker_id
     OR selected.lease_token_hash IS DISTINCT FROM p_lease_token_hash
     OR selected.lease_version IS DISTINCT FROM p_lease_version
     OR selected.lease_expires_at <= statement_timestamp() THEN
    RAISE EXCEPTION 'revalidation lease was lost' USING ERRCODE = '55000';
  END IF;
  next_state := CASE
    WHEN p_retryable AND selected.attempt_count < selected.max_attempts
      THEN 'retry_wait'
    ELSE 'dead_letter'
  END;
  UPDATE app.public_social_revalidation_jobs AS job
     SET state = next_state,
         next_attempt_at = statement_timestamp() + interval '30 seconds',
         lease_token_hash = NULL, lease_worker_id = NULL,
         lease_expires_at = NULL, last_error_code = p_error_code,
         updated_at = statement_timestamp(), row_version = job.row_version + 1,
         completed_at = CASE WHEN next_state = 'dead_letter'
                             THEN statement_timestamp() ELSE NULL END
   WHERE job.workspace_id = p_workspace_id AND job.id = p_job_id;
  RETURN QUERY SELECT p_job_id, next_state;
END;
$function$;

CREATE FUNCTION app_private.complete_test_social_revalidation(
  p_workspace_id uuid,
  p_job_id uuid,
  p_worker_id uuid,
  p_lease_token_hash bytea,
  p_lease_version bigint,
  p_proof_id uuid,
  p_content_source_resource_version_id uuid,
  p_content_source_approval_id uuid,
  p_content_source_approved_at timestamptz,
  p_media_source_resource_version_ids uuid[],
  p_media_source_approval_ids uuid[],
  p_media_source_approved_ats timestamptz[],
  p_source_catalog_sha256 bytea,
  p_checked_at timestamptz,
  p_expires_at timestamptz
)
RETURNS TABLE (proof_id uuid, state text, disposition text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  selected app.public_social_revalidation_jobs%ROWTYPE;
  intent app.public_social_planning_intents%ROWTYPE;
  expected_media_count integer;
  validated_content_count integer;
  validated_media_count integer;
BEGIN
  IF p_workspace_id IS NULL OR p_job_id IS NULL OR p_worker_id IS NULL
     OR p_lease_token_hash IS NULL OR octet_length(p_lease_token_hash) <> 32
     OR p_lease_version IS NULL OR p_lease_version <= 0
     OR p_proof_id IS NULL
     OR p_content_source_resource_version_id IS NULL
     OR p_content_source_approval_id IS NULL
     OR p_content_source_approved_at IS NULL
     OR p_media_source_resource_version_ids IS NULL
     OR p_media_source_approval_ids IS NULL
     OR p_media_source_approved_ats IS NULL
     OR cardinality(p_media_source_resource_version_ids) > 10
     OR cardinality(p_media_source_resource_version_ids)
       <> cardinality(p_media_source_approval_ids)
     OR cardinality(p_media_source_resource_version_ids)
       <> cardinality(p_media_source_approved_ats)
     OR array_position(p_media_source_resource_version_ids, NULL) IS NOT NULL
     OR array_position(p_media_source_approval_ids, NULL) IS NOT NULL
     OR array_position(p_media_source_approved_ats, NULL) IS NOT NULL
     OR p_source_catalog_sha256 IS NULL
     OR octet_length(p_source_catalog_sha256) <> 32
     OR p_checked_at IS NULL OR p_expires_at IS NULL
     OR p_checked_at < statement_timestamp() - interval '30 seconds'
     OR p_checked_at > statement_timestamp() + interval '30 seconds'
     OR p_content_source_approved_at > p_checked_at
     OR p_expires_at <= p_checked_at
     OR p_expires_at > p_checked_at + interval '15 minutes' THEN
    RAISE EXCEPTION 'invalid system revalidation proof'
      USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public-social-revalidation:' || p_workspace_id::text || ':' || p_job_id::text,
      7200040
    )
  );
  SELECT job.* INTO selected
  FROM app.public_social_revalidation_jobs AS job
  WHERE job.workspace_id = p_workspace_id AND job.id = p_job_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'revalidation job was not found' USING ERRCODE = 'P0002';
  END IF;
  IF selected.state <> 'leased'
     OR selected.lease_worker_id IS DISTINCT FROM p_worker_id
     OR selected.lease_token_hash IS DISTINCT FROM p_lease_token_hash
     OR selected.lease_version IS DISTINCT FROM p_lease_version
     OR selected.lease_expires_at <= statement_timestamp() THEN
    RAISE EXCEPTION 'revalidation lease was lost' USING ERRCODE = '55000';
  END IF;
  SELECT planned.* INTO intent
  FROM app.public_social_planning_intents AS planned
  WHERE planned.workspace_id = p_workspace_id AND planned.id = selected.intent_id;
  IF NOT FOUND
     OR intent.desired_for < statement_timestamp() - interval '5 minutes'
     OR intent.desired_for > statement_timestamp() + interval '10 minutes'
     OR p_expires_at <= intent.desired_for + interval '2 minutes'
     OR NOT EXISTS (
       SELECT 1 FROM app.public_social_planning_intent_targets AS target
       WHERE target.workspace_id = intent.workspace_id
         AND target.intent_id = intent.id
         AND NOT EXISTS (
           SELECT 1 FROM app.public_social_planning_target_cancellations AS cancellation
           WHERE cancellation.workspace_id = target.workspace_id
             AND cancellation.intent_id = target.intent_id
             AND cancellation.target_id = target.target_id
         )
         AND NOT EXISTS (
           SELECT 1 FROM app.public_social_planning_target_supersessions AS supersession
           WHERE supersession.workspace_id = target.workspace_id
             AND supersession.predecessor_intent_id = target.intent_id
             AND supersession.predecessor_target_id = target.target_id
         )
     ) THEN
    RAISE EXCEPTION 'revalidation intent is outside its active TEST window'
      USING ERRCODE = '55000';
  END IF;

  SELECT count(*) INTO validated_content_count
  FROM app.company_content_versions AS version
  JOIN app.company_content_approval_requests AS request
    ON request.workspace_id = intent.workspace_id
   AND request.id = intent.approval_request_id
   AND request.content_item_id = intent.content_item_id
   AND request.content_version_id = intent.content_version_id
   AND request.content_sha256 = intent.content_sha256
  JOIN app.company_content_approval_decisions AS decision
    ON decision.workspace_id = request.workspace_id
   AND decision.id = intent.approval_decision_id
   AND decision.approval_request_id = request.id
   AND decision.decision = 'approved'
  WHERE version.workspace_id = intent.workspace_id
    AND version.content_item_id = intent.content_item_id
    AND version.id = intent.content_version_id
    AND version.content_sha256 = intent.content_sha256
    AND version.blob_sha256 = intent.blob_sha256
    AND version.brand_sha256 = intent.brand_sha256
    AND version.source_system = 'propertypredator.company-content'
    AND version.source_item_id ~
      '^(media|asset|generated):[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
    AND version.source_version ~ '^[1-9][0-9]{0,9}$'
    AND (
      length(version.source_version) < 10
      OR version.source_version <= '2147483647'
    )
    AND CASE
      WHEN version.metadata->>'sourceVersionId' ~
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       AND pg_catalog.pg_input_is_valid(
         version.metadata->>'sourceVersionId', 'uuid'
       )
      THEN (version.metadata->>'sourceVersionId')::uuid
        = p_content_source_resource_version_id
      ELSE false
    END
    AND CASE
      WHEN version.metadata->>'sourceApprovalId' ~
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       AND pg_catalog.pg_input_is_valid(
         version.metadata->>'sourceApprovalId', 'uuid'
       )
      THEN (version.metadata->>'sourceApprovalId')::uuid
        = p_content_source_approval_id
      ELSE false
    END
    AND CASE
      WHEN version.metadata->>'sourceApprovedAt' ~
          '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
       AND pg_catalog.pg_input_is_valid(
         version.metadata->>'sourceApprovedAt', 'timestamp with time zone'
       )
      THEN (version.metadata->>'sourceApprovedAt')::timestamptz
        = p_content_source_approved_at
      ELSE false
    END
    AND version.content_kind = 'social_post'
    AND app_private.public_social_body_supported(version.content_body)
    AND NOT EXISTS (
      SELECT 1 FROM app.company_content_versions AS newer
      WHERE newer.workspace_id = version.workspace_id
        AND newer.content_item_id = version.content_item_id
        AND newer.version_number > version.version_number
    )
    AND NOT EXISTS (
      SELECT 1 FROM app.company_content_approval_requests AS later_request
      WHERE later_request.workspace_id = request.workspace_id
        AND later_request.content_item_id = request.content_item_id
        AND later_request.content_version_id = request.content_version_id
        AND later_request.request_number > request.request_number
    );
  IF validated_content_count <> 1 THEN
    RAISE EXCEPTION 'fresh exact social content proof is unavailable'
      USING ERRCODE = '42501';
  END IF;

  SELECT count(*) INTO expected_media_count
  FROM app.public_social_planning_intent_media AS planned_media
  WHERE planned_media.workspace_id = p_workspace_id
    AND planned_media.intent_id = intent.id;
  IF cardinality(p_media_source_resource_version_ids) <> expected_media_count THEN
    RAISE EXCEPTION 'revalidation media proof count is invalid'
      USING ERRCODE = '22023';
  END IF;
  SELECT count(*) INTO validated_media_count
  FROM unnest(
    p_media_source_resource_version_ids,
    p_media_source_approval_ids,
    p_media_source_approved_ats
  ) WITH ORDINALITY AS supplied(
    resource_version_id, approval_id, approved_at, ordinal
  )
  JOIN app.public_social_planning_intent_media AS planned_media
    ON planned_media.workspace_id = p_workspace_id
   AND planned_media.intent_id = intent.id
   AND planned_media.ordinal = supplied.ordinal
  JOIN app.company_content_versions AS version
    ON version.workspace_id = planned_media.workspace_id
   AND version.content_item_id = planned_media.content_item_id
   AND version.id = planned_media.content_version_id
   AND version.content_sha256 = planned_media.content_sha256
   AND version.blob_sha256 = planned_media.blob_sha256
   AND version.brand_sha256 = planned_media.brand_sha256
   AND version.source_system = 'propertypredator.company-content'
   AND version.source_item_id ~
     '^(media|asset|generated):[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
   AND version.source_version ~ '^[1-9][0-9]{0,9}$'
   AND (
     length(version.source_version) < 10
     OR version.source_version <= '2147483647'
   )
   AND CASE
     WHEN version.metadata->>'sourceVersionId' ~
         '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND pg_catalog.pg_input_is_valid(
        version.metadata->>'sourceVersionId', 'uuid'
      )
     THEN (version.metadata->>'sourceVersionId')::uuid
       = supplied.resource_version_id
     ELSE false
   END
   AND CASE
     WHEN version.metadata->>'sourceApprovalId' ~
         '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND pg_catalog.pg_input_is_valid(
        version.metadata->>'sourceApprovalId', 'uuid'
      )
     THEN (version.metadata->>'sourceApprovalId')::uuid = supplied.approval_id
     ELSE false
   END
   AND CASE
     WHEN version.metadata->>'sourceApprovedAt' ~
         '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
      AND pg_catalog.pg_input_is_valid(
        version.metadata->>'sourceApprovedAt', 'timestamp with time zone'
      )
     THEN (version.metadata->>'sourceApprovedAt')::timestamptz
       = supplied.approved_at
     ELSE false
   END
   AND supplied.approved_at <= p_checked_at
   AND version.content_kind IN ('image', 'video')
  JOIN app.company_content_approval_requests AS request
    ON request.workspace_id = planned_media.workspace_id
   AND request.id = planned_media.approval_request_id
   AND request.content_item_id = planned_media.content_item_id
   AND request.content_version_id = planned_media.content_version_id
   AND request.content_sha256 = planned_media.content_sha256
  JOIN app.company_content_approval_decisions AS decision
    ON decision.workspace_id = request.workspace_id
   AND decision.id = planned_media.approval_decision_id
   AND decision.approval_request_id = request.id
   AND decision.decision = 'approved'
  WHERE app_private.public_social_media_payload_supported(
      version.blob_storage_key, version.content_mime_type
    )
    AND NOT EXISTS (
      SELECT 1 FROM app.company_content_versions AS newer
      WHERE newer.workspace_id = version.workspace_id
        AND newer.content_item_id = version.content_item_id
        AND newer.version_number > version.version_number
    )
    AND NOT EXISTS (
      SELECT 1 FROM app.company_content_approval_requests AS later_request
      WHERE later_request.workspace_id = request.workspace_id
        AND later_request.content_item_id = request.content_item_id
        AND later_request.content_version_id = request.content_version_id
        AND later_request.request_number > request.request_number
    );
  IF validated_media_count <> expected_media_count THEN
    RAISE EXCEPTION 'fresh exact media proof is unavailable'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO app.public_social_revalidation_proofs (
    id, workspace_id, job_id, intent_id, intent_sha256,
    content_item_id, content_version_id, content_sha256, blob_sha256,
    brand_sha256, source_resource_version_id, source_approval_id,
    source_approved_at, source_catalog_sha256, checked_at, expires_at,
    worker_id, lease_version
  ) VALUES (
    p_proof_id, p_workspace_id, p_job_id, intent.id, intent.intent_sha256,
    intent.content_item_id, intent.content_version_id, intent.content_sha256,
    intent.blob_sha256, intent.brand_sha256,
    p_content_source_resource_version_id, p_content_source_approval_id,
    p_content_source_approved_at, p_source_catalog_sha256, p_checked_at,
    p_expires_at, p_worker_id, p_lease_version
  );
  INSERT INTO app.public_social_revalidation_proof_media (
    workspace_id, proof_id, intent_id, ordinal, content_item_id,
    content_version_id, content_sha256, blob_sha256, brand_sha256,
    source_resource_version_id, source_approval_id, source_approved_at,
    source_catalog_sha256, checked_at, expires_at
  )
  SELECT p_workspace_id, p_proof_id, intent.id, planned_media.ordinal,
    planned_media.content_item_id, planned_media.content_version_id,
    planned_media.content_sha256, planned_media.blob_sha256,
    planned_media.brand_sha256, supplied.resource_version_id,
    supplied.approval_id, supplied.approved_at, p_source_catalog_sha256,
    p_checked_at, p_expires_at
  FROM unnest(
    p_media_source_resource_version_ids,
    p_media_source_approval_ids,
    p_media_source_approved_ats
  ) WITH ORDINALITY AS supplied(
    resource_version_id, approval_id, approved_at, ordinal
  )
  JOIN app.public_social_planning_intent_media AS planned_media
    ON planned_media.workspace_id = p_workspace_id
   AND planned_media.intent_id = intent.id
   AND planned_media.ordinal = supplied.ordinal;

  UPDATE app.public_social_revalidation_jobs AS job
     SET state = 'verified', current_proof_id = p_proof_id,
         lease_token_hash = NULL, lease_worker_id = NULL,
         lease_expires_at = NULL, last_error_code = NULL,
         updated_at = statement_timestamp(), row_version = job.row_version + 1
   WHERE job.workspace_id = p_workspace_id AND job.id = p_job_id;
  RETURN QUERY SELECT p_proof_id, 'verified'::text, 'applied'::text;
END;
$function$;
CREATE FUNCTION app_private.materialize_test_social_planning_intent(
  p_workspace_id uuid,
  p_job_id uuid,
  p_proof_id uuid,
  p_post_id uuid
)
RETURNS TABLE (post_id uuid, operation_ids uuid[], disposition text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  selected_job app.public_social_revalidation_jobs%ROWTYPE;
  intent app.public_social_planning_intents%ROWTYPE;
  proof app.public_social_revalidation_proofs%ROWTYPE;
  existing app.public_social_intent_materializations%ROWTYPE;
  inserted_operation_ids uuid[];
  expected_target_count integer;
  inserted_target_count integer;
  calculated_plan_sha256 bytea;
  locked_target record;
BEGIN
  IF p_workspace_id IS NULL OR p_job_id IS NULL OR p_proof_id IS NULL
     OR p_post_id IS NULL THEN
    RAISE EXCEPTION 'invalid planning materialization' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public-social-materialization:' || p_workspace_id::text || ':' || p_job_id::text,
      7200040
    )
  );
  SELECT materialization.* INTO existing
  FROM app.public_social_intent_materializations AS materialization
  JOIN app.public_social_revalidation_jobs AS job
    ON job.workspace_id = materialization.workspace_id
   AND job.intent_id = materialization.intent_id
  WHERE materialization.workspace_id = p_workspace_id AND job.id = p_job_id;
  IF FOUND THEN
    IF existing.proof_id IS DISTINCT FROM p_proof_id
       OR existing.post_id IS DISTINCT FROM p_post_id THEN
      RAISE EXCEPTION 'revalidation job already has different materialization'
        USING ERRCODE = '23505';
    END IF;
    SELECT array_agg(operation.id ORDER BY operation.target_id)
      INTO inserted_operation_ids
    FROM app.public_social_operations AS operation
    WHERE operation.workspace_id = p_workspace_id
      AND operation.post_id = existing.post_id;
    RETURN QUERY SELECT existing.post_id, inserted_operation_ids,
      'replayed'::text;
    RETURN;
  END IF;

  SELECT job.* INTO selected_job
  FROM app.public_social_revalidation_jobs AS job
  WHERE job.workspace_id = p_workspace_id AND job.id = p_job_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'revalidation job was not found' USING ERRCODE = 'P0002';
  END IF;
  IF selected_job.state <> 'verified'
     OR selected_job.current_proof_id IS DISTINCT FROM p_proof_id THEN
    RAISE EXCEPTION 'revalidation job is not verified for materialization'
      USING ERRCODE = '55000';
  END IF;
  SELECT planned.* INTO intent
  FROM app.public_social_planning_intents AS planned
  WHERE planned.workspace_id = p_workspace_id AND planned.id = selected_job.intent_id;
  SELECT verified.* INTO proof
  FROM app.public_social_revalidation_proofs AS verified
  WHERE verified.workspace_id = p_workspace_id AND verified.id = p_proof_id
    AND verified.job_id = p_job_id AND verified.intent_id = intent.id
    AND verified.intent_sha256 = intent.intent_sha256;
  IF NOT FOUND OR proof.expires_at <= statement_timestamp()
     OR proof.expires_at <= intent.desired_for + interval '2 minutes'
     OR intent.desired_for < statement_timestamp() - interval '5 seconds' THEN
    RAISE EXCEPTION 'verified proof no longer covers materialization'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM app.public_social_planning_intent_media AS planned_media
    LEFT JOIN app.public_social_revalidation_proof_media AS proof_media
      ON proof_media.workspace_id = planned_media.workspace_id
     AND proof_media.proof_id = p_proof_id
     AND proof_media.intent_id = planned_media.intent_id
     AND proof_media.ordinal = planned_media.ordinal
     AND proof_media.content_item_id = planned_media.content_item_id
     AND proof_media.content_version_id = planned_media.content_version_id
     AND proof_media.content_sha256 = planned_media.content_sha256
     AND proof_media.blob_sha256 = planned_media.blob_sha256
     AND proof_media.brand_sha256 = planned_media.brand_sha256
     AND proof_media.expires_at > statement_timestamp()
     AND proof_media.expires_at > intent.desired_for + interval '2 minutes'
    WHERE planned_media.workspace_id = p_workspace_id
      AND planned_media.intent_id = intent.id
      AND proof_media.proof_id IS NULL
  ) THEN
    RAISE EXCEPTION 'verified media proof no longer covers materialization'
      USING ERRCODE = '55000';
  END IF;

  -- Cancel/reschedule uses this exact per-target lock namespace. Acquire every
  -- target that appears active in deterministic order, then re-read lifecycle
  -- evidence below. If a lifecycle transaction is in flight, this waits for
  -- it; if materialization wins, the lifecycle command waits and safely
  -- cancels the committed simulator operation instead.
  FOR locked_target IN
    SELECT target.target_id
    FROM app.public_social_planning_intent_targets AS target
    WHERE target.workspace_id = p_workspace_id AND target.intent_id = intent.id
      AND NOT EXISTS (
        SELECT 1
        FROM app.public_social_planning_target_cancellations AS cancellation
        WHERE cancellation.workspace_id = target.workspace_id
          AND cancellation.intent_id = target.intent_id
          AND cancellation.target_id = target.target_id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM app.public_social_planning_target_supersessions AS supersession
        WHERE supersession.workspace_id = target.workspace_id
          AND supersession.predecessor_intent_id = target.intent_id
          AND supersession.predecessor_target_id = target.target_id
      )
    ORDER BY target.ordinal, target.target_id
  LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'public-social-planning-target:' || p_workspace_id::text || ':'
          || intent.id::text || ':' || locked_target.target_id::text,
        7200040
      )
    );
  END LOOP;

  -- This is intentionally a fresh statement after all target locks. Never
  -- reuse the pre-lock visibility snapshot for lifecycle decisions.
  SELECT count(*) INTO expected_target_count
  FROM app.public_social_planning_intent_targets AS target
  WHERE target.workspace_id = p_workspace_id AND target.intent_id = intent.id
    AND NOT EXISTS (
      SELECT 1 FROM app.public_social_planning_target_cancellations AS cancellation
      WHERE cancellation.workspace_id = target.workspace_id
        AND cancellation.intent_id = target.intent_id
        AND cancellation.target_id = target.target_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM app.public_social_planning_target_supersessions AS supersession
      WHERE supersession.workspace_id = target.workspace_id
        AND supersession.predecessor_intent_id = target.intent_id
        AND supersession.predecessor_target_id = target.target_id
    );
  IF expected_target_count < 1 THEN
    RAISE EXCEPTION 'planning intent has no active targets'
      USING ERRCODE = '55000';
  END IF;

  calculated_plan_sha256 := public.digest(
    jsonb_build_object(
      'contract', 'public-social-materialized-plan/v1',
      'workspaceId', p_workspace_id,
      'intentId', intent.id,
      'intentSha256', encode(intent.intent_sha256, 'hex'),
      'proofId', p_proof_id,
      'postId', p_post_id,
      'desiredFor', to_char(intent.desired_for AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    )::text,
    'sha256'
  );
  INSERT INTO app.public_social_posts (
    id, workspace_id, campaign_id, campaign_revision_id,
    content_item_id, content_version_id, content_sha256,
    approval_request_id, approval_decision_id,
    scheduled_source_attestation_id, scheduled_for, max_attempts,
    plan_sha256, created_by_user_id, created_request_id
  ) VALUES (
    p_post_id, p_workspace_id, intent.campaign_id,
    intent.campaign_revision_id, intent.content_item_id,
    intent.content_version_id, intent.content_sha256,
    intent.approval_request_id, intent.approval_decision_id,
    intent.planning_source_attestation_id, intent.desired_for,
    intent.max_attempts, calculated_plan_sha256,
    intent.created_by_user_id, intent.created_request_id
  );
  INSERT INTO app.public_social_post_media (
    workspace_id, post_id, ordinal, content_item_id, content_version_id,
    content_sha256, blob_sha256, approval_request_id, approval_decision_id,
    scheduled_source_attestation_id
  )
  SELECT p_workspace_id, p_post_id, media.ordinal, media.content_item_id,
    media.content_version_id, media.content_sha256, media.blob_sha256,
    media.approval_request_id, media.approval_decision_id,
    media.planning_source_attestation_id
  FROM app.public_social_planning_intent_media AS media
  WHERE media.workspace_id = p_workspace_id AND media.intent_id = intent.id
  ORDER BY media.ordinal;
  INSERT INTO app.public_social_intent_materializations (
    workspace_id, intent_id, proof_id, post_id
  ) VALUES (p_workspace_id, intent.id, p_proof_id, p_post_id);

  WITH inserted AS (
    INSERT INTO app.public_social_operations (
      workspace_id, post_id, target_id, provider_connection_id, network,
      environment, execution_mode, state, idempotency_key, correlation_id,
      attempt_count, max_attempts, next_attempt_at
    )
    SELECT p_workspace_id, p_post_id, target.target_id,
      target.provider_connection_id, target.network, 'test',
      'simulated_test_only', 'waiting_for_test_time',
      'public-social:' || p_post_id::text || ':' || target.target_id::text,
      gen_random_uuid(), 0, intent.max_attempts, intent.desired_for
    FROM app.public_social_planning_intent_targets AS target
    JOIN app.public_social_targets AS current_target
      ON current_target.workspace_id = target.workspace_id
     AND current_target.id = target.target_id
     AND current_target.provider_connection_id = target.provider_connection_id
     AND current_target.network = target.network
     AND current_target.environment = 'test'
     AND current_target.account_ref_sha256 = target.account_ref_sha256
    JOIN app.provider_connections AS connection
      ON connection.workspace_id = target.workspace_id
     AND connection.id = target.provider_connection_id
     AND connection.provider_id = 'public_social_dark_simulator'
     AND connection.provider_kind = 'social'
     AND connection.environment = 'test'
     AND connection.status = 'active'
    WHERE target.workspace_id = p_workspace_id AND target.intent_id = intent.id
      AND NOT EXISTS (
        SELECT 1 FROM app.public_social_planning_target_cancellations AS cancellation
        WHERE cancellation.workspace_id = target.workspace_id
          AND cancellation.intent_id = target.intent_id
          AND cancellation.target_id = target.target_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM app.public_social_planning_target_supersessions AS supersession
        WHERE supersession.workspace_id = target.workspace_id
          AND supersession.predecessor_intent_id = target.intent_id
          AND supersession.predecessor_target_id = target.target_id
      )
    ORDER BY target.ordinal
    RETURNING id, target_id
  )
  SELECT array_agg(inserted.id ORDER BY inserted.target_id), count(*)
    INTO inserted_operation_ids, inserted_target_count
  FROM inserted;
  IF inserted_target_count <> expected_target_count THEN
    RAISE EXCEPTION 'one or more planned TEST targets are no longer available'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO app.public_social_events (
    workspace_id, campaign_id, campaign_revision_id, post_id, target_id,
    operation_id, event_kind, actor_kind
  )
  SELECT operation.workspace_id, intent.campaign_id,
    intent.campaign_revision_id, p_post_id, operation.target_id,
    operation.id, 'post_scheduled', 'system'
  FROM app.public_social_operations AS operation
  WHERE operation.workspace_id = p_workspace_id AND operation.post_id = p_post_id;

  UPDATE app.public_social_revalidation_jobs AS job
     SET state = 'materialized', completed_at = statement_timestamp(),
         updated_at = statement_timestamp(), row_version = job.row_version + 1
   WHERE job.workspace_id = p_workspace_id AND job.id = p_job_id;
  RETURN QUERY SELECT p_post_id, inserted_operation_ids, 'applied'::text;
END;
$function$;

-- The worker receives only this completion capability. Proof persistence and
-- simulator materialization happen in one database statement/transaction;
-- failure in either half rolls the lease-fenced proof write back.
CREATE FUNCTION app_private.complete_and_materialize_test_social_revalidation(
  p_workspace_id uuid,
  p_job_id uuid,
  p_worker_id uuid,
  p_lease_token_hash bytea,
  p_lease_version bigint,
  p_proof_id uuid,
  p_post_id uuid,
  p_content_source_resource_version_id uuid,
  p_content_source_approval_id uuid,
  p_content_source_approved_at timestamptz,
  p_media_source_resource_version_ids uuid[],
  p_media_source_approval_ids uuid[],
  p_media_source_approved_ats timestamptz[],
  p_source_catalog_sha256 bytea,
  p_checked_at timestamptz,
  p_expires_at timestamptz
)
RETURNS TABLE (
  proof_id uuid,
  post_id uuid,
  operation_ids uuid[],
  disposition text
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  completed record;
  materialized record;
BEGIN
  SELECT result.* INTO STRICT completed
  FROM app_private.complete_test_social_revalidation(
    p_workspace_id, p_job_id, p_worker_id, p_lease_token_hash,
    p_lease_version, p_proof_id,
    p_content_source_resource_version_id, p_content_source_approval_id,
    p_content_source_approved_at, p_media_source_resource_version_ids,
    p_media_source_approval_ids, p_media_source_approved_ats,
    p_source_catalog_sha256, p_checked_at, p_expires_at
  ) AS result;
  IF completed.proof_id IS DISTINCT FROM p_proof_id
     OR completed.state <> 'verified' OR completed.disposition <> 'applied' THEN
    RAISE EXCEPTION 'system revalidation proof completion was invalid'
      USING ERRCODE = '55000';
  END IF;
  SELECT result.* INTO STRICT materialized
  FROM app_private.materialize_test_social_planning_intent(
    p_workspace_id, p_job_id, p_proof_id, p_post_id
  ) AS result;
  IF materialized.post_id IS DISTINCT FROM p_post_id
     OR materialized.disposition NOT IN ('applied', 'replayed') THEN
    RAISE EXCEPTION 'system revalidation materialization was invalid'
      USING ERRCODE = '55000';
  END IF;
  RETURN QUERY SELECT p_proof_id, p_post_id,
    materialized.operation_ids::uuid[], materialized.disposition::text;
END;
$function$;

CREATE OR REPLACE FUNCTION app_private.public_social_dispatch_ready(
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
      AND NOT EXISTS (
        SELECT 1 FROM app.company_content_approval_requests AS later_request
        WHERE later_request.workspace_id = request.workspace_id
          AND later_request.content_item_id = request.content_item_id
          AND later_request.content_version_id = request.content_version_id
          AND later_request.request_number > request.request_number
      )
      AND NOT EXISTS (
        SELECT 1
        FROM app.public_social_intent_materializations AS lifecycle_materialization
        WHERE lifecycle_materialization.workspace_id = operation.workspace_id
          AND lifecycle_materialization.post_id = operation.post_id
          AND NOT EXISTS (
            SELECT 1
            FROM app.public_social_planning_intent_targets AS lifecycle_target
            WHERE lifecycle_target.workspace_id = lifecycle_materialization.workspace_id
              AND lifecycle_target.intent_id = lifecycle_materialization.intent_id
              AND lifecycle_target.target_id = operation.target_id
              AND NOT EXISTS (
                SELECT 1
                FROM app.public_social_planning_target_cancellations AS cancellation
                WHERE cancellation.workspace_id = lifecycle_target.workspace_id
                  AND cancellation.intent_id = lifecycle_target.intent_id
                  AND cancellation.target_id = lifecycle_target.target_id
              )
              AND NOT EXISTS (
                SELECT 1
                FROM app.public_social_planning_target_supersessions AS supersession
                WHERE supersession.workspace_id = lifecycle_target.workspace_id
                  AND supersession.predecessor_intent_id = lifecycle_target.intent_id
                  AND supersession.predecessor_target_id = lifecycle_target.target_id
              )
          )
      )
      AND (
        (
          NOT EXISTS (
            SELECT 1 FROM app.public_social_intent_materializations AS materialization
            WHERE materialization.workspace_id = post.workspace_id
              AND materialization.post_id = post.id
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
        )
        OR EXISTS (
          SELECT 1
          FROM app.public_social_intent_materializations AS materialization
          JOIN app.public_social_planning_intents AS intent
            ON intent.workspace_id = materialization.workspace_id
           AND intent.id = materialization.intent_id
          JOIN app.public_social_revalidation_proofs AS proof
            ON proof.workspace_id = materialization.workspace_id
           AND proof.id = materialization.proof_id
           AND proof.intent_id = intent.id
           AND proof.intent_sha256 = intent.intent_sha256
           AND proof.content_item_id = post.content_item_id
           AND proof.content_version_id = post.content_version_id
           AND proof.content_sha256 = post.content_sha256
           AND proof.blob_sha256 = version.blob_sha256
           AND proof.brand_sha256 = version.brand_sha256
          JOIN app.public_social_revalidation_jobs AS job
            ON job.workspace_id = materialization.workspace_id
           AND job.intent_id = materialization.intent_id
           AND job.current_proof_id = proof.id
           AND job.state = 'materialized'
          WHERE materialization.workspace_id = post.workspace_id
            AND materialization.post_id = post.id
            AND intent.campaign_id = post.campaign_id
            AND intent.campaign_revision_id = post.campaign_revision_id
            AND intent.content_item_id = post.content_item_id
            AND intent.content_version_id = post.content_version_id
            AND intent.content_sha256 = post.content_sha256
            AND intent.desired_for = post.scheduled_for
            AND intent.max_attempts = post.max_attempts
            AND proof.checked_at <= statement_timestamp()
            AND proof.expires_at > statement_timestamp()
            AND proof.expires_at > post.scheduled_for + interval '2 minutes'
        )
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
            OR EXISTS (
              SELECT 1 FROM app.company_content_approval_requests AS later_media_request
              WHERE later_media_request.workspace_id = media_request.workspace_id
                AND later_media_request.content_item_id = media_request.content_item_id
                AND later_media_request.content_version_id = media_request.content_version_id
                AND later_media_request.request_number > media_request.request_number
            )
            OR (
              NOT EXISTS (
                SELECT 1
                FROM app.public_social_intent_materializations AS materialization
                WHERE materialization.workspace_id = post.workspace_id
                  AND materialization.post_id = post.id
              )
              AND NOT EXISTS (
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
            OR (
              EXISTS (
                SELECT 1
                FROM app.public_social_intent_materializations AS materialization
                WHERE materialization.workspace_id = post.workspace_id
                  AND materialization.post_id = post.id
              )
              AND NOT EXISTS (
                SELECT 1
                FROM app.public_social_intent_materializations AS materialization
                JOIN app.public_social_revalidation_proof_media AS proof_media
                  ON proof_media.workspace_id = materialization.workspace_id
                 AND proof_media.proof_id = materialization.proof_id
                 AND proof_media.intent_id = materialization.intent_id
                 AND proof_media.ordinal = media.ordinal
                 AND proof_media.content_item_id = media.content_item_id
                 AND proof_media.content_version_id = media.content_version_id
                 AND proof_media.content_sha256 = media.content_sha256
                 AND proof_media.blob_sha256 = media.blob_sha256
                 AND proof_media.brand_sha256 = media_version.brand_sha256
                WHERE materialization.workspace_id = post.workspace_id
                  AND materialization.post_id = post.id
                  AND proof_media.checked_at <= statement_timestamp()
                  AND proof_media.expires_at > statement_timestamp()
                  AND proof_media.expires_at > post.scheduled_for + interval '2 minutes'
              )
            )
          )
      )
  );
$function$;

CREATE FUNCTION app_private.list_test_social_planning_calendar(
  p_workspace_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_limit integer
)
RETURNS TABLE (
  intent_id uuid,
  campaign_id uuid,
  revision_id uuid,
  revision_number integer,
  campaign_title text,
  desired_for timestamptz,
  content_item_id uuid,
  content_version_id uuid,
  content_sha256 text,
  intent_sha256 text,
  target_id uuid,
  network text,
  target_label text,
  planning_state text,
  materialized_post_id uuid,
  materialized_operation_id uuid,
  operation_state text,
  revalidation_state text,
  next_revalidation_at timestamptz,
  last_error_code text,
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
    RAISE EXCEPTION 'planning calendar input is invalid' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  WITH projection AS MATERIALIZED (
    SELECT intent.id AS intent_id, intent.campaign_id,
      revision.id AS revision_id, revision.revision_number,
      revision.title AS campaign_title, intent.desired_for,
      intent.content_item_id, intent.content_version_id,
      encode(intent.content_sha256, 'hex') AS content_sha256,
      encode(intent.intent_sha256, 'hex') AS intent_sha256,
      planned_target.target_id, planned_target.network,
      target.display_name AS target_label,
      CASE
        WHEN supersession.id IS NOT NULL THEN 'superseded'
        WHEN cancellation.id IS NOT NULL THEN 'cancelled'
        WHEN materialization.id IS NOT NULL THEN 'materialized'
        WHEN job.state = 'verified' THEN 'proof_ready'
        WHEN job.state = 'leased' THEN 'revalidation_leased'
        WHEN job.state = 'dead_letter' THEN 'revalidation_attention'
        ELSE 'awaiting_revalidation'
      END AS planning_state,
      materialization.post_id AS materialized_post_id,
      operation.id AS materialized_operation_id,
      operation.state AS operation_state,
      job.state AS revalidation_state,
      job.next_attempt_at AS next_revalidation_at,
      job.last_error_code,
      GREATEST(
        intent.created_at, job.updated_at,
        COALESCE(cancellation.cancelled_at, '-infinity'::timestamptz),
        COALESCE(supersession.superseded_at, '-infinity'::timestamptz),
        COALESCE(materialization.materialized_at, '-infinity'::timestamptz),
        COALESCE(operation.updated_at, '-infinity'::timestamptz)
      ) AS updated_at
    FROM app.public_social_planning_intents AS intent
    JOIN app.public_social_campaign_revisions AS revision
      ON revision.workspace_id = intent.workspace_id
     AND revision.id = intent.campaign_revision_id
    JOIN app.public_social_planning_intent_targets AS planned_target
      ON planned_target.workspace_id = intent.workspace_id
     AND planned_target.intent_id = intent.id
    JOIN app.public_social_targets AS target
      ON target.workspace_id = planned_target.workspace_id
     AND target.id = planned_target.target_id
    JOIN app.public_social_revalidation_jobs AS job
      ON job.workspace_id = intent.workspace_id AND job.intent_id = intent.id
    LEFT JOIN app.public_social_planning_target_cancellations AS cancellation
      ON cancellation.workspace_id = planned_target.workspace_id
     AND cancellation.intent_id = planned_target.intent_id
     AND cancellation.target_id = planned_target.target_id
    LEFT JOIN app.public_social_planning_target_supersessions AS supersession
      ON supersession.workspace_id = planned_target.workspace_id
     AND supersession.predecessor_intent_id = planned_target.intent_id
     AND supersession.predecessor_target_id = planned_target.target_id
    LEFT JOIN app.public_social_intent_materializations AS materialization
      ON materialization.workspace_id = intent.workspace_id
     AND materialization.intent_id = intent.id
    LEFT JOIN app.public_social_operations AS operation
      ON operation.workspace_id = materialization.workspace_id
     AND operation.post_id = materialization.post_id
     AND operation.target_id = planned_target.target_id
    WHERE intent.workspace_id = p_workspace_id
      AND intent.desired_for >= p_from AND intent.desired_for < p_to
  )
  SELECT projection.intent_id, projection.campaign_id,
    projection.revision_id, projection.revision_number,
    projection.campaign_title, projection.desired_for,
    projection.content_item_id, projection.content_version_id,
    projection.content_sha256, projection.intent_sha256,
    projection.target_id, projection.network, projection.target_label,
    projection.planning_state, projection.materialized_post_id,
    projection.materialized_operation_id, projection.operation_state,
    projection.revalidation_state, projection.next_revalidation_at,
    projection.last_error_code, projection.updated_at,
    count(*) OVER () > p_limit AS has_more
  FROM projection
  ORDER BY projection.desired_for, projection.intent_id,
    projection.network, projection.target_id
  LIMIT p_limit + 1;
END;
$function$;

CREATE FUNCTION app_private.public_social_operational_planner_boundary_ready()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT NOT EXISTS (
    SELECT 1
    FROM app.public_social_planning_intent_targets AS planned_target
    JOIN app.public_social_targets AS target
      ON target.workspace_id = planned_target.workspace_id
     AND target.id = planned_target.target_id
    JOIN app.provider_connections AS connection
      ON connection.workspace_id = target.workspace_id
     AND connection.id = target.provider_connection_id
    WHERE planned_target.environment <> 'test'
       OR target.environment <> 'test'
       OR connection.provider_id <> 'public_social_dark_simulator'
       OR connection.provider_kind <> 'social'
       OR connection.environment <> 'test'
  )
  AND NOT EXISTS (
    SELECT 1 FROM app.public_social_operations AS operation
    JOIN app.public_social_intent_materializations AS materialization
      ON materialization.workspace_id = operation.workspace_id
     AND materialization.post_id = operation.post_id
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
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname = 'app_private'
      AND procedure.proname IN (
        'create_test_social_planning_intent',
        'list_test_social_planner_targets',
        'cancel_test_social_planning_target',
        'reschedule_test_social_planning_target',
        'claim_due_test_social_revalidations',
        'load_leased_test_social_source_versions',
        'fail_test_social_revalidation',
        'complete_test_social_revalidation',
        'complete_and_materialize_test_social_revalidation',
        'materialize_test_social_planning_intent',
        'list_test_social_planning_calendar',
        'public_social_operational_planner_boundary_ready'
      )
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',
      function_oid::regprocedure);
  END LOOP;
END
$revoke_functions$;

GRANT USAGE ON SCHEMA app_private
  TO r72_public_social_revalidator_command;
GRANT EXECUTE ON FUNCTION app_private.create_test_social_planning_intent(
  uuid, uuid, uuid, uuid, uuid, timestamptz, smallint, uuid[], uuid[]
) TO r72_public_social_command;
GRANT EXECUTE ON FUNCTION app_private.cancel_test_social_planning_target(
  uuid, uuid, uuid, bytea
) TO r72_public_social_command;
GRANT EXECUTE ON FUNCTION app_private.reschedule_test_social_planning_target(
  uuid, uuid, uuid, uuid, timestamptz, bytea
) TO r72_public_social_command;
GRANT EXECUTE ON FUNCTION app_private.list_test_social_planner_targets(
  uuid, integer
), app_private.list_test_social_planning_calendar(
  uuid, timestamptz, timestamptz, integer
) TO r72_web;
GRANT EXECUTE ON FUNCTION app_private.claim_due_test_social_revalidations(
  uuid, bytea, integer, integer
), app_private.load_leased_test_social_source_versions(
  uuid, uuid, bytea, bigint
), app_private.fail_test_social_revalidation(
  uuid, uuid, uuid, bytea, bigint, text, boolean
), app_private.complete_and_materialize_test_social_revalidation(
  uuid, uuid, uuid, bytea, bigint, uuid, uuid, uuid, uuid,
  timestamptz, uuid[], uuid[], timestamptz[], bytea, timestamptz, timestamptz
) TO r72_public_social_revalidator_command;
GRANT EXECUTE ON FUNCTION app_private.public_social_operational_planner_boundary_ready()
  TO r72_public_social_command, r72_public_social_revalidator_command;
GRANT EXECUTE ON FUNCTION app_private.runtime_schema_migrations(),
  app_private.runtime_database_installation_id()
  TO r72_public_social_revalidator_command;

INSERT INTO app_private.workspace_table_registry
  (schema_name, table_name, workspace_column)
VALUES
  ('app', 'public_social_planning_intents', 'workspace_id'),
  ('app', 'public_social_planning_intent_targets', 'workspace_id'),
  ('app', 'public_social_planning_intent_media', 'workspace_id'),
  ('app', 'public_social_planning_target_cancellations', 'workspace_id'),
  ('app', 'public_social_planning_target_supersessions', 'workspace_id'),
  ('app', 'public_social_revalidation_jobs', 'workspace_id'),
  ('app', 'public_social_revalidation_proofs', 'workspace_id'),
  ('app', 'public_social_revalidation_proof_media', 'workspace_id'),
  ('app', 'public_social_intent_materializations', 'workspace_id');

DO $capability_audit$
DECLARE
  unsafe_object text;
  unsafe_function text;
  unexpected_effective_function text;
BEGIN
  IF NOT pg_catalog.has_schema_privilege(
       'r72_public_social_revalidator_command', 'app_private', 'USAGE'
     )
     OR pg_catalog.has_schema_privilege(
       'r72_public_social_revalidator_command', 'app_private', 'CREATE'
     )
     OR pg_catalog.has_schema_privilege(
       'r72_public_social_revalidator_command', 'app', 'USAGE'
     ) THEN
    RAISE EXCEPTION 'Unsafe public-social revalidator schema capability';
  END IF;
  SELECT format('%I.%I', namespace.nspname, relation.relname)
    INTO unsafe_object
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname IN ('app', 'app_private')
    AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND (
      pg_catalog.has_table_privilege(
        'r72_public_social_revalidator_command', relation.oid, 'SELECT'
      )
      OR pg_catalog.has_table_privilege(
        'r72_public_social_revalidator_command', relation.oid, 'INSERT'
      )
      OR pg_catalog.has_table_privilege(
        'r72_public_social_revalidator_command', relation.oid, 'UPDATE'
      )
      OR pg_catalog.has_table_privilege(
        'r72_public_social_revalidator_command', relation.oid, 'DELETE'
      )
      OR pg_catalog.has_table_privilege(
        'r72_public_social_revalidator_command', relation.oid, 'TRUNCATE'
      )
    )
  LIMIT 1;
  IF unsafe_object IS NOT NULL THEN
    RAISE EXCEPTION 'Public-social revalidator unexpectedly has table privilege on %',
      unsafe_object;
  END IF;

  SELECT procedure.oid::regprocedure::text INTO unsafe_function
  FROM pg_catalog.pg_proc AS procedure
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
  JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = procedure.proowner
  WHERE namespace.nspname = 'app_private'
    AND procedure.proname IN (
      'create_test_social_planning_intent',
      'list_test_social_planner_targets',
      'cancel_test_social_planning_target',
      'reschedule_test_social_planning_target',
      'claim_due_test_social_revalidations',
      'load_leased_test_social_source_versions',
      'fail_test_social_revalidation',
      'complete_test_social_revalidation',
      'complete_and_materialize_test_social_revalidation',
      'materialize_test_social_planning_intent',
      'list_test_social_planning_calendar',
      'public_social_operational_planner_boundary_ready'
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
    RAISE EXCEPTION 'Unsafe operational planner function boundary: %',
      unsafe_function;
  END IF;

  SELECT procedure.oid::regprocedure::text
    INTO unexpected_effective_function
  FROM pg_catalog.pg_proc AS procedure
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
  WHERE namespace.nspname = 'app_private'
    AND pg_catalog.has_function_privilege(
      'r72_public_social_revalidator_command', procedure.oid, 'EXECUTE'
    )
    AND procedure.oid <> ALL (ARRAY[
      pg_catalog.to_regprocedure(
        'app_private.claim_due_test_social_revalidations(uuid,bytea,integer,integer)'
      )::oid,
      pg_catalog.to_regprocedure(
        'app_private.load_leased_test_social_source_versions(uuid,uuid,bytea,bigint)'
      )::oid,
      pg_catalog.to_regprocedure(
        'app_private.fail_test_social_revalidation(uuid,uuid,uuid,bytea,bigint,text,boolean)'
      )::oid,
      pg_catalog.to_regprocedure(
        'app_private.complete_and_materialize_test_social_revalidation(uuid,uuid,uuid,bytea,bigint,uuid,uuid,uuid,uuid,timestamptz,uuid[],uuid[],timestamptz[],bytea,timestamptz,timestamptz)'
      )::oid,
      pg_catalog.to_regprocedure(
        'app_private.public_social_operational_planner_boundary_ready()'
      )::oid,
      pg_catalog.to_regprocedure('app_private.runtime_schema_migrations()')::oid,
      pg_catalog.to_regprocedure(
        'app_private.runtime_database_installation_id()'
      )::oid
    ])
  LIMIT 1;
  IF unexpected_effective_function IS NOT NULL THEN
    RAISE EXCEPTION 'Unexpected effective public-social revalidator function: %',
      unexpected_effective_function;
  END IF;

  IF pg_catalog.has_function_privilege(
       'r72_public_social_command',
       'app_private.claim_due_test_social_revalidations(uuid,bytea,integer,integer)',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'r72_public_social_revalidator_command',
       'app_private.create_test_social_planning_intent(uuid,uuid,uuid,uuid,uuid,timestamptz,smallint,uuid[],uuid[])',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'Operational planner command capabilities are crossed';
  END IF;
  IF NOT app_private.public_social_operational_planner_boundary_ready() THEN
    RAISE EXCEPTION 'Public-social operational planner TEST boundary is not ready';
  END IF;
END
$capability_audit$;
