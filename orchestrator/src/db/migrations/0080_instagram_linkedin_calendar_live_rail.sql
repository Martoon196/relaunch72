-- Instagram + LinkedIn calendar-to-live rail.
--
-- Extends the deliberately narrow 0052 owned-X proof without changing or
-- deleting its evidence. New jobs are bound to one immutable 0040 calendar
-- intent, its exact approved copy/media, one owned Ayrshare profile and one
-- network. Scheduling remains a database time fence: the worker cannot claim
-- the job before available_at.

SET LOCAL ROLE r72_owner;

ALTER TABLE app.property_predator_owned_social_profiles
  DROP CONSTRAINT IF EXISTS property_predator_owned_social_profiles_network_check;
ALTER TABLE app.property_predator_owned_social_profiles
  ADD CONSTRAINT property_predator_owned_social_profiles_network_check
  CHECK (network IN ('instagram', 'linkedin', 'x'));
ALTER TABLE app.property_predator_owned_social_profiles
  ADD COLUMN provider_link_evidence_sha256 bytea,
  ADD COLUMN provider_permissions text;
ALTER TABLE app.property_predator_owned_social_profiles
  DISABLE TRIGGER property_predator_owned_social_profiles_immutable;
UPDATE app.property_predator_owned_social_profiles
SET provider_link_evidence_sha256 = x_oauth_link_evidence_sha256,
    provider_permissions = x_oauth_permissions
WHERE provider_link_evidence_sha256 IS NULL;
ALTER TABLE app.property_predator_owned_social_profiles
  ENABLE TRIGGER property_predator_owned_social_profiles_immutable;
ALTER TABLE app.property_predator_owned_social_profiles
  ALTER COLUMN provider_link_evidence_sha256 SET NOT NULL,
  ALTER COLUMN provider_permissions SET NOT NULL,
  ALTER COLUMN x_oauth_link_evidence_sha256 DROP NOT NULL,
  ALTER COLUMN x_oauth_permissions DROP NOT NULL;
ALTER TABLE app.property_predator_owned_social_profiles
  ADD CONSTRAINT property_predator_owned_social_profiles_provider_link_evidence_check
  CHECK (octet_length(provider_link_evidence_sha256) = 32),
  ADD CONSTRAINT property_predator_owned_social_profiles_provider_permissions_check
  CHECK (provider_permissions IN ('publish', 'read_write'));

ALTER TABLE app.property_predator_owned_social_jobs
  DROP CONSTRAINT IF EXISTS property_predator_owned_social_jobs_network_check;
ALTER TABLE app.property_predator_owned_social_jobs
  DROP CONSTRAINT IF EXISTS property_predator_owned_social_jobs_text_body_check;
ALTER TABLE app.property_predator_owned_social_jobs
  ADD COLUMN planning_intent_id uuid,
  ADD COLUMN planning_target_id uuid,
  ADD CONSTRAINT property_predator_owned_social_jobs_network_check
    CHECK (network IN ('instagram', 'linkedin', 'x')),
  ADD CONSTRAINT property_predator_owned_social_jobs_text_body_check CHECK (
    octet_length(text_body) BETWEEN 1 AND 16384
    AND length(text_body) BETWEEN 1 AND CASE network
      WHEN 'instagram' THEN 2200 WHEN 'linkedin' THEN 3000 ELSE 280 END
    AND text_body !~ E'[\\x01-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F]'
    AND (network <> 'x' OR text_body !~* '(//|(^|[^A-Za-z])[A-Za-z][A-Za-z0-9+.-]*:|www[.]|[A-Za-z0-9][A-Za-z0-9-]{0,62}[.][A-Za-z]{2,63})')
  ),
  ADD CONSTRAINT property_predator_owned_social_jobs_planning_intent_fk
    FOREIGN KEY (workspace_id, planning_intent_id)
    REFERENCES app.public_social_planning_intents (workspace_id, id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT property_predator_owned_social_jobs_planning_target_fk
    FOREIGN KEY (workspace_id, planning_intent_id, planning_target_id)
    REFERENCES app.public_social_planning_intent_targets
      (workspace_id, intent_id, target_id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT property_predator_owned_social_jobs_planning_identity_check
    CHECK ((planning_intent_id IS NULL) = (planning_target_id IS NULL));

CREATE TABLE app.property_predator_owned_social_job_media (
  workspace_id uuid NOT NULL,
  job_id uuid NOT NULL,
  ordinal smallint NOT NULL CHECK (ordinal BETWEEN 1 AND 10),
  content_item_id uuid NOT NULL,
  content_version_id uuid NOT NULL,
  content_sha256 bytea NOT NULL CHECK (octet_length(content_sha256) = 32),
  blob_sha256 bytea NOT NULL CHECK (octet_length(blob_sha256) = 32),
  blob_storage_key text NOT NULL CHECK (
    length(blob_storage_key) BETWEEN 1 AND 500
    AND blob_storage_key ~ '^/?[A-Za-z0-9][A-Za-z0-9._/-]{0,499}$'
    AND strpos(blob_storage_key, '..') = 0 AND strpos(blob_storage_key, '//') = 0
  ),
  content_mime_type text NOT NULL CHECK (
    content_mime_type ~ '^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$'
  ),
  approval_request_id uuid NOT NULL,
  approval_decision_id uuid NOT NULL,
  source_attestation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (workspace_id, job_id, ordinal),
  UNIQUE (workspace_id, job_id, content_version_id),
  FOREIGN KEY (workspace_id, job_id)
    REFERENCES app.property_predator_owned_social_jobs (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, content_item_id, content_version_id, content_sha256)
    REFERENCES app.company_content_versions
      (workspace_id, content_item_id, id, content_sha256) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, approval_request_id)
    REFERENCES app.company_content_approval_requests (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, approval_decision_id)
    REFERENCES app.company_content_approval_decisions (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, source_attestation_id)
    REFERENCES app.company_content_source_attestations (workspace_id, id) ON DELETE RESTRICT
);

CREATE TRIGGER property_predator_owned_social_job_media_immutable
  BEFORE UPDATE OR DELETE ON app.property_predator_owned_social_job_media
  FOR EACH ROW EXECUTE FUNCTION app_private.owned_social_immutable_guard();

CREATE FUNCTION app_private.owned_social_job_calendar_identity_guard()
RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog AS $function$
BEGIN
  IF NEW.planning_intent_id IS DISTINCT FROM OLD.planning_intent_id
     OR NEW.planning_target_id IS DISTINCT FROM OLD.planning_target_id THEN
    RAISE EXCEPTION 'Owned public-social calendar identity is immutable'
      USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END
$function$;
REVOKE ALL ON FUNCTION app_private.owned_social_job_calendar_identity_guard() FROM PUBLIC;
CREATE TRIGGER property_predator_owned_social_jobs_calendar_identity_immutable
  BEFORE UPDATE ON app.property_predator_owned_social_jobs
  FOR EACH ROW EXECUTE FUNCTION app_private.owned_social_job_calendar_identity_guard();
ALTER TABLE app.property_predator_owned_social_job_media ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.property_predator_owned_social_job_media FORCE ROW LEVEL SECURITY;
CREATE POLICY owned_social_job_media_owner_all
  ON app.property_predator_owned_social_job_media FOR ALL TO r72_owner
  USING (true) WITH CHECK (true);
CREATE POLICY owned_social_job_media_definer_all
  ON app.property_predator_owned_social_job_media FOR ALL TO r72_owned_social_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

CREATE POLICY public_social_planning_intents_owned_social_select
  ON app.public_social_planning_intents FOR SELECT TO r72_owned_social_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY public_social_planning_targets_owned_social_select
  ON app.public_social_planning_intent_targets FOR SELECT TO r72_owned_social_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY public_social_planning_media_owned_social_select
  ON app.public_social_planning_intent_media FOR SELECT TO r72_owned_social_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY public_social_planning_cancellations_owned_social_select
  ON app.public_social_planning_target_cancellations FOR SELECT TO r72_owned_social_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY public_social_planning_supersessions_owned_social_select
  ON app.public_social_planning_target_supersessions FOR SELECT TO r72_owned_social_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY public_social_revalidation_jobs_owned_social_select
  ON app.public_social_revalidation_jobs FOR SELECT TO r72_owned_social_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY public_social_revalidation_proofs_owned_social_select
  ON app.public_social_revalidation_proofs FOR SELECT TO r72_owned_social_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY public_social_revalidation_proof_media_owned_social_select
  ON app.public_social_revalidation_proof_media FOR SELECT TO r72_owned_social_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

GRANT SELECT, INSERT ON app.property_predator_owned_social_job_media
  TO r72_owned_social_definer;
GRANT SELECT ON app.public_social_planning_intents,
  app.public_social_planning_intent_targets,
  app.public_social_planning_intent_media,
  app.public_social_planning_target_cancellations,
  app.public_social_planning_target_supersessions,
  app.public_social_revalidation_jobs,
  app.public_social_revalidation_proofs,
  app.public_social_revalidation_proof_media
  TO r72_owned_social_definer;

INSERT INTO app_private.workspace_table_registry
  (schema_name, table_name, workspace_column)
VALUES ('app', 'property_predator_owned_social_job_media', 'workspace_id');

-- Keep the 0040 lifecycle command boundary table-blind. This narrow definer
-- locks every matching live job and refuses a lifecycle success after a job
-- has crossed out of its safely cancellable queued state.
GRANT CREATE ON SCHEMA app_private TO r72_owned_social_definer;
SET LOCAL ROLE r72_owned_social_definer;

-- Preserve the 0052 X-only command surface after the generic provider
-- evidence columns become mandatory. The same X evidence is written into
-- both the legacy compatibility fields and the provider-neutral fields.
CREATE OR REPLACE FUNCTION app_private.record_owned_social_profile(
  p_workspace_id uuid, p_provider_connection_id uuid, p_profile_id uuid,
  p_display_name text, p_provider_profile_ref_sha256 bytea,
  p_owned_account_ref_sha256 bytea, p_secret_key_version text,
  p_profile_key_iv bytea, p_profile_key_ciphertext bytea,
  p_profile_key_auth_tag bytea, p_profile_key_aad_sha256 bytea,
  p_profile_key_sha256 bytea, p_x_oauth_link_evidence_sha256 bytea,
  p_linked_at timestamptz, p_evidence_observed_at timestamptz
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE selected_user uuid;
BEGIN
  IF session_user <> 'r72_owned_social_command'
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'user'
     OR coalesce(current_setting('app.request_id', true), '') = ''
     OR current_setting('app.user_id', true) !~ '^[0-9a-f-]{36}$'
     OR octet_length(p_provider_profile_ref_sha256) <> 32
     OR octet_length(p_owned_account_ref_sha256) <> 32
     OR octet_length(p_profile_key_iv) <> 12
     OR octet_length(p_profile_key_ciphertext) NOT BETWEEN 8 AND 1024
     OR octet_length(p_profile_key_auth_tag) <> 16
     OR octet_length(p_profile_key_aad_sha256) <> 32
     OR octet_length(p_profile_key_sha256) <> 32
     OR octet_length(p_x_oauth_link_evidence_sha256) <> 32 THEN
    RAISE EXCEPTION 'Owned social profile command denied' USING ERRCODE = '42501';
  END IF;
  selected_user := current_setting('app.user_id')::uuid;
  IF p_profile_key_aad_sha256 <> public.digest(
       format(
         '{"contract":"propertypredator.owned-public-social-live/v1","workspaceId":"%s","connectionId":"%s","profileId":"%s","providerId":"ayrshare","network":"x"}',
         p_workspace_id, p_provider_connection_id, p_profile_id
       ), 'sha256'
     )
     OR p_evidence_observed_at > statement_timestamp() + interval '5 minutes'
     OR p_linked_at > p_evidence_observed_at + interval '5 minutes' THEN
    RAISE EXCEPTION 'Owned social encrypted binding evidence denied' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app.workspace_memberships AS membership
    WHERE membership.workspace_id = p_workspace_id AND membership.user_id = selected_user
      AND membership.status = 'active' AND membership.role IN ('owner', 'admin')
  ) OR NOT EXISTS (
    SELECT 1 FROM app.provider_connections AS connection
    WHERE connection.workspace_id = p_workspace_id AND connection.id = p_provider_connection_id
      AND connection.environment = 'live' AND connection.provider_id = 'ayrshare'
      AND connection.provider_kind = 'social' AND connection.status = 'active'
  ) THEN
    RAISE EXCEPTION 'Owned social profile binding denied' USING ERRCODE = '42501';
  END IF;
  INSERT INTO app.property_predator_owned_social_profiles (
    id, workspace_id, provider_connection_id, environment, provider_id, network,
    display_name, provider_profile_ref_sha256, owned_account_ref_sha256,
    secret_algorithm, secret_key_version, profile_key_iv, profile_key_ciphertext,
    profile_key_auth_tag, profile_key_aad_sha256, profile_key_sha256,
    provider_link_evidence_sha256, provider_permissions,
    x_oauth_link_evidence_sha256, x_oauth_permissions, linked_at,
    evidence_observed_at, created_by_user_id
  ) VALUES (
    p_profile_id, p_workspace_id, p_provider_connection_id, 'live', 'ayrshare', 'x',
    p_display_name, p_provider_profile_ref_sha256, p_owned_account_ref_sha256,
    'aes-256-gcm-v1', p_secret_key_version, p_profile_key_iv,
    p_profile_key_ciphertext, p_profile_key_auth_tag, p_profile_key_aad_sha256,
    p_profile_key_sha256, p_x_oauth_link_evidence_sha256, 'read_write',
    p_x_oauth_link_evidence_sha256, 'read_write', p_linked_at,
    p_evidence_observed_at, selected_user
  );
  RETURN p_profile_id;
END
$function$;

CREATE FUNCTION app_private.assert_owned_social_target_lifecycle_changeable(
  p_workspace_id uuid, p_intent_id uuid, p_target_id uuid
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE selected record;
BEGIN
  IF session_user <> 'r72_public_social_command'
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'user'
     OR coalesce(current_setting('app.request_id', true), '') = ''
     OR coalesce(current_setting('app.user_id', true), '') !~ '^[0-9a-f-]{36}$'
     OR p_intent_id IS NULL OR p_target_id IS NULL THEN
    RAISE EXCEPTION 'Owned social target lifecycle guard denied' USING ERRCODE = '42501';
  END IF;
  FOR selected IN
    SELECT job.id, job.state
    FROM app.property_predator_owned_social_jobs AS job
    WHERE job.workspace_id = p_workspace_id
      AND job.planning_intent_id = p_intent_id
      AND job.planning_target_id = p_target_id
    ORDER BY job.id
    FOR UPDATE
  LOOP
    IF selected.state NOT IN ('queued', 'cancelled') THEN
      RAISE EXCEPTION 'Live planning target can no longer change safely'
        USING ERRCODE = '55000';
    END IF;
  END LOOP;
END
$function$;
REVOKE ALL ON FUNCTION app_private.assert_owned_social_target_lifecycle_changeable(
  uuid, uuid, uuid
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.assert_owned_social_target_lifecycle_changeable(
  uuid, uuid, uuid
) TO r72_public_social_definer;

SET LOCAL ROLE r72_owner;
GRANT CREATE ON SCHEMA app_private TO r72_public_social_definer;
SET LOCAL ROLE r72_public_social_definer;

CREATE OR REPLACE FUNCTION app_private.public_social_media_payload_supported(
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
    AND pg_catalog.length(p_blob_storage_key) BETWEEN 1 AND 500
    AND p_blob_storage_key ~ '^/?[A-Za-z0-9][A-Za-z0-9._/-]{0,499}$'
    AND pg_catalog.strpos(p_blob_storage_key, '..') = 0
    AND pg_catalog.strpos(p_blob_storage_key, '//') = 0
    AND p_content_mime_type IS NOT NULL
    AND p_content_mime_type ~ '^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$';
$function$;

CREATE OR REPLACE FUNCTION app_private.cancel_test_social_planning_target(
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
  PERFORM app_private.assert_owned_social_target_lifecycle_changeable(
    p_workspace_id, p_intent_id, p_target_id
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

CREATE OR REPLACE FUNCTION app_private.reschedule_test_social_planning_target(
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
  PERFORM app_private.assert_owned_social_target_lifecycle_changeable(
    p_workspace_id, p_predecessor_intent_id, p_target_id
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

SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_public_social_definer;
SET LOCAL ROLE r72_owned_social_definer;

CREATE FUNCTION app_private.record_owned_social_profile_v2(
  p_workspace_id uuid, p_provider_connection_id uuid, p_profile_id uuid,
  p_network text, p_display_name text, p_provider_profile_ref_sha256 bytea,
  p_owned_account_ref_sha256 bytea, p_secret_key_version text,
  p_profile_key_iv bytea, p_profile_key_ciphertext bytea,
  p_profile_key_auth_tag bytea, p_profile_key_aad_sha256 bytea,
  p_profile_key_sha256 bytea, p_provider_link_evidence_sha256 bytea,
  p_linked_at timestamptz, p_evidence_observed_at timestamptz
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE selected_user uuid;
BEGIN
  IF session_user <> 'r72_owned_social_command'
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'user'
     OR coalesce(current_setting('app.request_id', true), '') = ''
     OR current_setting('app.user_id', true) !~ '^[0-9a-f-]{36}$'
     OR p_network NOT IN ('instagram', 'linkedin')
     OR octet_length(p_provider_profile_ref_sha256) <> 32
     OR octet_length(p_owned_account_ref_sha256) <> 32
     OR octet_length(p_profile_key_iv) <> 12
     OR octet_length(p_profile_key_ciphertext) NOT BETWEEN 8 AND 1024
     OR octet_length(p_profile_key_auth_tag) <> 16
     OR octet_length(p_profile_key_aad_sha256) <> 32
     OR octet_length(p_profile_key_sha256) <> 32
     OR octet_length(p_provider_link_evidence_sha256) <> 32 THEN
    RAISE EXCEPTION 'Owned social profile command denied' USING ERRCODE = '42501';
  END IF;
  selected_user := current_setting('app.user_id')::uuid;
  IF p_profile_key_aad_sha256 <> public.digest(
       format(
         '{"contract":"propertypredator.owned-public-social-live/v1","workspaceId":"%s","connectionId":"%s","profileId":"%s","providerId":"ayrshare","network":"%s"}',
         p_workspace_id, p_provider_connection_id, p_profile_id, p_network
       ), 'sha256'
     )
     OR p_evidence_observed_at > statement_timestamp() + interval '5 minutes'
     OR p_linked_at > p_evidence_observed_at + interval '5 minutes'
     OR NOT EXISTS (
       SELECT 1 FROM app.workspace_memberships AS membership
       WHERE membership.workspace_id = p_workspace_id AND membership.user_id = selected_user
         AND membership.status = 'active' AND membership.role IN ('owner', 'admin')
     )
     OR NOT EXISTS (
       SELECT 1 FROM app.provider_connections AS connection
       WHERE connection.workspace_id = p_workspace_id AND connection.id = p_provider_connection_id
         AND connection.environment = 'live' AND connection.provider_id = 'ayrshare'
         AND connection.provider_kind = 'social' AND connection.status = 'active'
     ) THEN
    RAISE EXCEPTION 'Owned social profile binding denied' USING ERRCODE = '42501';
  END IF;
  INSERT INTO app.property_predator_owned_social_profiles (
    id, workspace_id, provider_connection_id, environment, provider_id, network,
    display_name, provider_profile_ref_sha256, owned_account_ref_sha256,
    secret_algorithm, secret_key_version, profile_key_iv, profile_key_ciphertext,
    profile_key_auth_tag, profile_key_aad_sha256, profile_key_sha256,
    provider_link_evidence_sha256, provider_permissions, linked_at,
    evidence_observed_at, created_by_user_id
  ) VALUES (
    p_profile_id, p_workspace_id, p_provider_connection_id, 'live', 'ayrshare', p_network,
    p_display_name, p_provider_profile_ref_sha256, p_owned_account_ref_sha256,
    'aes-256-gcm-v1', p_secret_key_version, p_profile_key_iv,
    p_profile_key_ciphertext, p_profile_key_auth_tag, p_profile_key_aad_sha256,
    p_profile_key_sha256, p_provider_link_evidence_sha256, 'publish',
    p_linked_at, p_evidence_observed_at, selected_user
  );
  RETURN p_profile_id;
END
$function$;

CREATE FUNCTION app_private.enqueue_owned_social_job_v2(
  p_workspace_id uuid, p_provider_connection_id uuid, p_profile_id uuid,
  p_network text, p_expected_owned_account_sha256 bytea,
  p_planning_intent_id uuid, p_planning_target_id uuid,
  p_content_item_id uuid, p_content_version_id uuid,
  p_approval_request_id uuid, p_approval_decision_id uuid,
  p_source_attestation_id uuid, p_operation_tag text,
  p_idempotency_key_sha256 bytea, p_request_sha256 bytea,
  p_scheduled_for timestamptz
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE selected_user uuid; selected_id uuid := gen_random_uuid(); existing record;
  selected_version record; selected_effect_at timestamptz;
  selected_media_count integer; planned_media_count integer;
BEGIN
  IF session_user <> 'r72_owned_social_command'
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'user'
     OR coalesce(current_setting('app.request_id', true), '') = ''
     OR current_setting('app.user_id', true) !~ '^[0-9a-f-]{36}$'
     OR p_network NOT IN ('instagram', 'linkedin')
     OR p_expected_owned_account_sha256 IS NULL
     OR octet_length(p_expected_owned_account_sha256) <> 32
     OR p_planning_intent_id IS NULL OR p_planning_target_id IS NULL
     OR p_scheduled_for IS NULL
     OR octet_length(p_idempotency_key_sha256) <> 32
     OR octet_length(p_request_sha256) <> 32 THEN
    RAISE EXCEPTION 'Owned social calendar enqueue denied' USING ERRCODE = '42501';
  END IF;
  selected_user := current_setting('app.user_id')::uuid;
  IF NOT EXISTS (
    SELECT 1 FROM app.workspace_memberships AS membership
    WHERE membership.workspace_id = p_workspace_id AND membership.user_id = selected_user
      AND membership.status = 'active' AND membership.role IN ('owner', 'admin')
  ) THEN RAISE EXCEPTION 'Owned social calendar enqueue denied' USING ERRCODE = '42501'; END IF;

  -- Serialise enqueue with the 0040 cancellation/reschedule commands for this
  -- exact target. A concurrent lifecycle command therefore wins wholly before
  -- or wholly after this evidence check, never between check and insert.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public-social-planning-target:' || p_workspace_id::text || ':'
        || p_planning_intent_id::text || ':' || p_planning_target_id::text,
      7200040
    )
  );

  PERFORM profile.id
  FROM app.property_predator_owned_social_profiles AS profile
  WHERE profile.workspace_id = p_workspace_id AND profile.id = p_profile_id
    AND profile.provider_connection_id = p_provider_connection_id
    AND profile.environment = 'live' AND profile.network = p_network
    AND profile.provider_permissions = 'publish'
    AND profile.owned_account_ref_sha256 = p_expected_owned_account_sha256
    AND NOT EXISTS (
      SELECT 1 FROM app.property_predator_owned_social_profile_revocations AS revocation
      WHERE revocation.workspace_id = profile.workspace_id AND revocation.profile_id = profile.id
    )
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Owned social profile binding denied' USING ERRCODE = '42501'; END IF;

  SELECT version.content_body, version.content_sha256 INTO selected_version
  FROM app.public_social_planning_intents AS intent
  JOIN app.public_social_planning_intent_targets AS target
    ON target.workspace_id = intent.workspace_id
   AND target.intent_id = intent.id
   AND target.target_id = p_planning_target_id
   AND target.network = p_network
  JOIN app.company_content_versions AS version
    ON version.workspace_id = intent.workspace_id
   AND version.content_item_id = intent.content_item_id
   AND version.id = intent.content_version_id
   AND version.content_sha256 = intent.content_sha256
  JOIN app.company_content_approval_requests AS request
    ON request.workspace_id = version.workspace_id AND request.id = p_approval_request_id
   AND request.content_item_id = version.content_item_id
   AND request.content_version_id = version.id AND request.content_sha256 = version.content_sha256
  JOIN app.company_content_approval_decisions AS decision
    ON decision.workspace_id = request.workspace_id AND decision.id = p_approval_decision_id
   AND decision.approval_request_id = request.id AND decision.decision = 'approved'
  JOIN app.company_content_source_attestations AS attestation
    ON attestation.workspace_id = version.workspace_id AND attestation.id = p_source_attestation_id
   AND attestation.content_item_id = version.content_item_id
   AND attestation.content_version_id = version.id
   AND attestation.content_sha256 = version.content_sha256
   AND attestation.blob_sha256 = version.blob_sha256
   AND attestation.brand_sha256 = version.brand_sha256
  WHERE intent.workspace_id = p_workspace_id AND intent.id = p_planning_intent_id
    AND intent.content_item_id = p_content_item_id
    AND intent.content_version_id = p_content_version_id
    AND intent.approval_request_id = p_approval_request_id
    AND intent.approval_decision_id = p_approval_decision_id
    AND intent.planning_source_attestation_id = p_source_attestation_id
    AND intent.desired_for = p_scheduled_for
    AND version.content_kind = 'social_post'
    AND attestation.checked_at <= statement_timestamp()
    AND attestation.expires_at > statement_timestamp()
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
    AND NOT EXISTS (
      SELECT 1 FROM app.company_content_approval_requests AS later_request
      WHERE later_request.workspace_id = request.workspace_id
        AND later_request.content_item_id = request.content_item_id
        AND later_request.content_version_id = request.content_version_id
        AND later_request.request_number > request.request_number
    )
    AND NOT EXISTS (
      SELECT 1 FROM app.company_content_versions AS newer
      WHERE newer.workspace_id = version.workspace_id
        AND newer.content_item_id = version.content_item_id
        AND newer.version_number > version.version_number
    );
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Owned social calendar/content evidence denied' USING ERRCODE = '42501';
  END IF;
  IF length(selected_version.content_body) > (CASE p_network WHEN 'instagram' THEN 2200 ELSE 3000 END) THEN
    RAISE EXCEPTION 'Owned social network text denied' USING ERRCODE = '22023';
  END IF;

  SELECT count(*) INTO selected_media_count
  FROM app.public_social_planning_intent_media AS planned_media
  JOIN app.company_content_versions AS media_version
    ON media_version.workspace_id = planned_media.workspace_id
   AND media_version.content_item_id = planned_media.content_item_id
   AND media_version.id = planned_media.content_version_id
   AND media_version.content_sha256 = planned_media.content_sha256
   AND media_version.blob_sha256 = planned_media.blob_sha256
  JOIN app.company_content_approval_requests AS media_request
    ON media_request.workspace_id = planned_media.workspace_id
   AND media_request.id = planned_media.approval_request_id
   AND media_request.content_item_id = planned_media.content_item_id
   AND media_request.content_version_id = planned_media.content_version_id
   AND media_request.content_sha256 = planned_media.content_sha256
  JOIN app.company_content_approval_decisions AS media_decision
    ON media_decision.workspace_id = planned_media.workspace_id
   AND media_decision.id = planned_media.approval_decision_id
   AND media_decision.approval_request_id = planned_media.approval_request_id
   AND media_decision.decision = 'approved'
  JOIN app.company_content_source_attestations AS media_attestation
    ON media_attestation.workspace_id = planned_media.workspace_id
   AND media_attestation.id = planned_media.planning_source_attestation_id
   AND media_attestation.content_item_id = planned_media.content_item_id
   AND media_attestation.content_version_id = planned_media.content_version_id
   AND media_attestation.content_sha256 = planned_media.content_sha256
   AND media_attestation.blob_sha256 = planned_media.blob_sha256
   AND media_attestation.brand_sha256 = planned_media.brand_sha256
  WHERE planned_media.workspace_id = p_workspace_id
    AND planned_media.intent_id = p_planning_intent_id
    AND media_version.content_kind IN ('image', 'video')
    AND media_attestation.checked_at <= statement_timestamp()
    AND media_attestation.expires_at > statement_timestamp()
    AND NOT EXISTS (
      SELECT 1 FROM app.company_content_versions AS newer_media
      WHERE newer_media.workspace_id = media_version.workspace_id
        AND newer_media.content_item_id = media_version.content_item_id
        AND newer_media.version_number > media_version.version_number
    )
    AND NOT EXISTS (
      SELECT 1 FROM app.company_content_approval_requests AS later_media_request
      WHERE later_media_request.workspace_id = media_request.workspace_id
        AND later_media_request.content_item_id = media_request.content_item_id
        AND later_media_request.content_version_id = media_request.content_version_id
        AND later_media_request.request_number > media_request.request_number
    );
  SELECT count(*) INTO planned_media_count
  FROM app.public_social_planning_intent_media AS planned_media
  WHERE planned_media.workspace_id = p_workspace_id
    AND planned_media.intent_id = p_planning_intent_id;
  IF selected_media_count <> planned_media_count
     OR (p_network = 'instagram' AND selected_media_count NOT BETWEEN 1 AND 10)
     OR (p_network = 'linkedin' AND selected_media_count > 9) THEN
    RAISE EXCEPTION 'Owned social network media denied' USING ERRCODE = '22023';
  END IF;

  -- An idempotent retry still has to prove that the exact target and every
  -- approval/version/attestation remain current. The checks above therefore
  -- deliberately run before replaying the durable job identifier.
  SELECT job.* INTO existing
  FROM app.property_predator_owned_social_jobs AS job
  WHERE job.workspace_id = p_workspace_id
    AND job.idempotency_key_sha256 = p_idempotency_key_sha256;
  IF FOUND THEN
    IF existing.request_sha256 <> p_request_sha256
       OR existing.provider_connection_id IS DISTINCT FROM p_provider_connection_id
       OR existing.profile_id IS DISTINCT FROM p_profile_id
       OR existing.network IS DISTINCT FROM p_network
       OR existing.planning_intent_id IS DISTINCT FROM p_planning_intent_id
       OR existing.planning_target_id IS DISTINCT FROM p_planning_target_id
       OR existing.content_item_id IS DISTINCT FROM p_content_item_id
       OR existing.content_version_id IS DISTINCT FROM p_content_version_id
       OR existing.approval_request_id IS DISTINCT FROM p_approval_request_id
       OR existing.approval_decision_id IS DISTINCT FROM p_approval_decision_id
       OR existing.source_attestation_id IS DISTINCT FROM p_source_attestation_id
       OR existing.operation_tag IS DISTINCT FROM p_operation_tag
       OR existing.scheduled_for IS DISTINCT FROM p_scheduled_for THEN
      RAISE EXCEPTION 'Owned social idempotency conflict' USING ERRCODE = '40001';
    END IF;
    RETURN existing.id;
  END IF;

  selected_effect_at := greatest(statement_timestamp(), p_scheduled_for);
  IF (SELECT count(*) FROM app.property_predator_owned_social_jobs AS job
      WHERE job.workspace_id = p_workspace_id AND job.profile_id = p_profile_id
        AND job.utc_day = (selected_effect_at AT TIME ZONE 'UTC')::date
        AND job.state <> 'cancelled') >= 1
     OR (SELECT count(*) FROM app.property_predator_owned_social_jobs AS job
      WHERE job.workspace_id = p_workspace_id AND job.profile_id = p_profile_id
        AND job.utc_month = date_trunc('month', selected_effect_at AT TIME ZONE 'UTC')::date
        AND job.state <> 'cancelled') >= 3 THEN
    RAISE EXCEPTION 'Owned social hard publish cap reached' USING ERRCODE = '42501';
  END IF;

  INSERT INTO app.property_predator_owned_social_jobs (
    id, workspace_id, provider_connection_id, profile_id, environment, network,
    planning_intent_id, planning_target_id, content_item_id, content_version_id, content_sha256,
    approval_request_id, approval_decision_id, source_attestation_id,
    operation_tag, idempotency_key_sha256, request_sha256, text_body,
    scheduled_for, utc_day, utc_month, available_at, created_by_user_id
  ) VALUES (
    selected_id, p_workspace_id, p_provider_connection_id, p_profile_id, 'live', p_network,
    p_planning_intent_id, p_planning_target_id, p_content_item_id, p_content_version_id,
    selected_version.content_sha256, p_approval_request_id, p_approval_decision_id,
    p_source_attestation_id, p_operation_tag, p_idempotency_key_sha256,
    p_request_sha256, selected_version.content_body, p_scheduled_for,
    (selected_effect_at AT TIME ZONE 'UTC')::date,
    date_trunc('month', selected_effect_at AT TIME ZONE 'UTC')::date,
    selected_effect_at, selected_user
  );

  INSERT INTO app.property_predator_owned_social_job_media (
    workspace_id, job_id, ordinal, content_item_id, content_version_id,
    content_sha256, blob_sha256, blob_storage_key, content_mime_type,
    approval_request_id, approval_decision_id, source_attestation_id
  )
  SELECT planned_media.workspace_id, selected_id, planned_media.ordinal,
    planned_media.content_item_id, planned_media.content_version_id,
    planned_media.content_sha256, planned_media.blob_sha256,
    media_version.blob_storage_key, media_version.content_mime_type,
    planned_media.approval_request_id, planned_media.approval_decision_id,
    planned_media.planning_source_attestation_id
  FROM app.public_social_planning_intent_media AS planned_media
  JOIN app.company_content_versions AS media_version
    ON media_version.workspace_id = planned_media.workspace_id
   AND media_version.content_item_id = planned_media.content_item_id
   AND media_version.id = planned_media.content_version_id
  WHERE planned_media.workspace_id = p_workspace_id
    AND planned_media.intent_id = p_planning_intent_id
  ORDER BY planned_media.ordinal;
  RETURN selected_id;
END
$function$;

-- One effect-time predicate for all v2 publish boundaries. The short-lived
-- source attestation used to plan/enqueue is immutable provenance, not live
-- authority. The 0040 revalidator's current exact proof is the only freshness
-- authority at the provider boundary.
CREATE FUNCTION app_private.owned_social_job_effect_ready_v2(
  p_workspace_id uuid, p_job_id uuid
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM app.property_predator_owned_social_jobs AS job
    JOIN app.public_social_planning_intents AS intent
      ON intent.workspace_id = job.workspace_id
     AND intent.id = job.planning_intent_id
     AND intent.content_item_id = job.content_item_id
     AND intent.content_version_id = job.content_version_id
     AND intent.content_sha256 = job.content_sha256
     AND intent.approval_request_id = job.approval_request_id
     AND intent.approval_decision_id = job.approval_decision_id
     AND intent.planning_source_attestation_id = job.source_attestation_id
     AND intent.desired_for = job.scheduled_for
    JOIN app.public_social_planning_intent_targets AS target
      ON target.workspace_id = intent.workspace_id
     AND target.intent_id = intent.id
     AND target.target_id = job.planning_target_id
     AND target.network = job.network
    JOIN app.company_content_versions AS version
      ON version.workspace_id = job.workspace_id
     AND version.content_item_id = job.content_item_id
     AND version.id = job.content_version_id
     AND version.content_sha256 = job.content_sha256
     AND version.blob_sha256 = intent.blob_sha256
     AND version.brand_sha256 = intent.brand_sha256
     AND version.content_body = job.text_body
     AND public.digest(version.content_body, 'sha256') = job.text_sha256
    JOIN app.company_content_approval_requests AS request
      ON request.workspace_id = job.workspace_id
     AND request.id = job.approval_request_id
     AND request.content_item_id = job.content_item_id
     AND request.content_version_id = job.content_version_id
     AND request.content_sha256 = job.content_sha256
    JOIN app.company_content_approval_decisions AS decision
      ON decision.workspace_id = request.workspace_id
     AND decision.id = job.approval_decision_id
     AND decision.approval_request_id = request.id
     AND decision.decision = 'approved'
    JOIN app.public_social_revalidation_jobs AS revalidation
      ON revalidation.workspace_id = intent.workspace_id
     AND revalidation.intent_id = intent.id
     AND revalidation.state IN ('verified', 'materialized')
    JOIN app.public_social_revalidation_proofs AS proof
      ON proof.workspace_id = revalidation.workspace_id
     AND proof.id = revalidation.current_proof_id
     AND proof.job_id = revalidation.id
     AND proof.intent_id = intent.id
     AND proof.intent_sha256 = intent.intent_sha256
     AND proof.content_item_id = intent.content_item_id
     AND proof.content_version_id = intent.content_version_id
     AND proof.content_sha256 = intent.content_sha256
     AND proof.blob_sha256 = intent.blob_sha256
     AND proof.brand_sha256 = intent.brand_sha256
    WHERE job.workspace_id = p_workspace_id AND job.id = p_job_id
      AND job.planning_intent_id IS NOT NULL
      AND job.planning_target_id IS NOT NULL
      AND version.content_kind = 'social_post'
      AND proof.checked_at <= statement_timestamp()
      AND proof.expires_at > statement_timestamp()
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
      AND (job.network <> 'instagram' OR (
        SELECT count(*) FROM app.property_predator_owned_social_job_media AS media_count
        WHERE media_count.workspace_id = job.workspace_id AND media_count.job_id = job.id
      ) BETWEEN 1 AND 10)
      AND (job.network <> 'linkedin' OR (
        SELECT count(*) FROM app.property_predator_owned_social_job_media AS media_count
        WHERE media_count.workspace_id = job.workspace_id AND media_count.job_id = job.id
      ) <= 9)
      AND (
        SELECT count(*) FROM app.property_predator_owned_social_job_media AS media_count
        WHERE media_count.workspace_id = job.workspace_id AND media_count.job_id = job.id
      ) = (
        SELECT count(*) FROM app.public_social_planning_intent_media AS planned_count
        WHERE planned_count.workspace_id = intent.workspace_id
          AND planned_count.intent_id = intent.id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM app.public_social_planning_intent_media AS planned_media
        LEFT JOIN app.property_predator_owned_social_job_media AS media
          ON media.workspace_id = planned_media.workspace_id
         AND media.job_id = job.id
         AND media.ordinal = planned_media.ordinal
         AND media.content_item_id = planned_media.content_item_id
         AND media.content_version_id = planned_media.content_version_id
         AND media.content_sha256 = planned_media.content_sha256
         AND media.blob_sha256 = planned_media.blob_sha256
         AND media.approval_request_id = planned_media.approval_request_id
         AND media.approval_decision_id = planned_media.approval_decision_id
         AND media.source_attestation_id = planned_media.planning_source_attestation_id
        LEFT JOIN app.company_content_versions AS media_version
          ON media_version.workspace_id = planned_media.workspace_id
         AND media_version.content_item_id = planned_media.content_item_id
         AND media_version.id = planned_media.content_version_id
         AND media_version.content_sha256 = planned_media.content_sha256
         AND media_version.blob_sha256 = planned_media.blob_sha256
         AND media_version.brand_sha256 = planned_media.brand_sha256
        LEFT JOIN app.company_content_approval_requests AS media_request
          ON media_request.workspace_id = planned_media.workspace_id
         AND media_request.id = planned_media.approval_request_id
         AND media_request.content_item_id = planned_media.content_item_id
         AND media_request.content_version_id = planned_media.content_version_id
         AND media_request.content_sha256 = planned_media.content_sha256
        LEFT JOIN app.company_content_approval_decisions AS media_decision
          ON media_decision.workspace_id = planned_media.workspace_id
         AND media_decision.id = planned_media.approval_decision_id
         AND media_decision.approval_request_id = planned_media.approval_request_id
         AND media_decision.decision = 'approved'
        LEFT JOIN app.public_social_revalidation_proof_media AS proof_media
          ON proof_media.workspace_id = planned_media.workspace_id
         AND proof_media.proof_id = proof.id
         AND proof_media.intent_id = planned_media.intent_id
         AND proof_media.ordinal = planned_media.ordinal
         AND proof_media.content_item_id = planned_media.content_item_id
         AND proof_media.content_version_id = planned_media.content_version_id
         AND proof_media.content_sha256 = planned_media.content_sha256
         AND proof_media.blob_sha256 = planned_media.blob_sha256
         AND proof_media.brand_sha256 = planned_media.brand_sha256
         AND proof_media.source_catalog_sha256 = proof.source_catalog_sha256
         AND proof_media.checked_at = proof.checked_at
         AND proof_media.expires_at = proof.expires_at
        WHERE planned_media.workspace_id = intent.workspace_id
          AND planned_media.intent_id = intent.id
          AND (
            media.job_id IS NULL OR media_version.id IS NULL
            OR media_version.content_kind NOT IN ('image', 'video')
            OR media.blob_storage_key IS DISTINCT FROM media_version.blob_storage_key
            OR media.content_mime_type IS DISTINCT FROM media_version.content_mime_type
            OR media_request.id IS NULL OR media_decision.id IS NULL
            OR proof_media.proof_id IS NULL
            OR proof_media.checked_at > statement_timestamp()
            OR proof_media.expires_at <= statement_timestamp()
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
          )
      )
  );
$function$;

CREATE FUNCTION app_private.claim_owned_social_job_v2(
  p_workspace_id uuid, p_provider_connection_id uuid, p_networks text[],
  p_lease_token bytea, p_lease_seconds integer
) RETURNS TABLE(job_id uuid, profile_id uuid, lease_version bigint, attempt_kind text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE selected app.property_predator_owned_social_jobs%ROWTYPE; selected_kind text;
  next_version bigint; recovered app.property_predator_owned_social_jobs%ROWTYPE;
BEGIN
  IF session_user <> 'r72_owned_social_worker_command'
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'worker'
     OR coalesce(current_setting('app.user_id', true), '') <> ''
     OR coalesce(current_setting('app.request_id', true), '') = ''
     OR p_networks IS NULL OR cardinality(p_networks) NOT BETWEEN 1 AND 3
     OR NOT (p_networks <@ ARRAY['instagram', 'linkedin', 'x']::text[])
     OR (SELECT count(DISTINCT requested.network_name)
           FROM unnest(p_networks) AS requested(network_name))
          <> cardinality(p_networks)
     OR octet_length(p_lease_token) <> 32 OR p_lease_seconds NOT BETWEEN 30 AND 300 THEN
    RAISE EXCEPTION 'Owned social claim denied' USING ERRCODE = '42501';
  END IF;

  FOR recovered IN
    SELECT job.* FROM app.property_predator_owned_social_jobs AS job
    WHERE job.workspace_id = p_workspace_id
      AND job.provider_connection_id = p_provider_connection_id
      AND job.network = ANY(p_networks)
      AND job.state IN ('leased', 'calling')
      AND job.lease_expires_at <= statement_timestamp()
    ORDER BY job.lease_expires_at, job.id
    FOR UPDATE SKIP LOCKED
  LOOP
    IF recovered.state = 'calling' THEN
      INSERT INTO app.property_predator_owned_social_receipts (
        workspace_id, job_id, lease_version, attempt_kind, event_kind,
        provider_external_id, receipt_sha256, safe_code, provider_occurred_at
      ) VALUES (
        recovered.workspace_id, recovered.id, recovered.lease_version,
        recovered.lease_attempt_kind, 'outcome_unknown', recovered.provider_external_id,
        public.digest(format('worker_call_lease_expired:%s:%s', recovered.id, recovered.lease_version), 'sha256'),
        'worker_call_lease_expired_unknown', statement_timestamp()
      ) ON CONFLICT (workspace_id, job_id, lease_version) DO NOTHING;
    END IF;
    UPDATE app.property_predator_owned_social_jobs SET
      state = CASE
        WHEN recovered.state = 'calling' THEN 'needs_attention'
        WHEN recovered.lease_attempt_kind = 'publish' THEN 'queued'
        ELSE 'reconciliation_pending'
      END,
      available_at = CASE WHEN recovered.lease_attempt_kind = 'publish'
        THEN statement_timestamp() ELSE available_at END,
      next_reconcile_at = CASE
        WHEN recovered.state = 'leased' AND recovered.lease_attempt_kind = 'reconcile'
          THEN statement_timestamp()
        ELSE NULL
      END,
      lease_attempt_kind = NULL, lease_expires_at = NULL,
      settled_at = CASE WHEN recovered.state = 'calling'
        THEN statement_timestamp() ELSE settled_at END,
      updated_at = statement_timestamp()
    WHERE workspace_id = recovered.workspace_id AND id = recovered.id;
    DELETE FROM app.property_predator_owned_social_job_leases
    WHERE workspace_id = recovered.workspace_id AND job_id = recovered.id;
  END LOOP;

  -- A cancellation or supersession is a terminal, non-provider outcome for a
  -- job that has not crossed the call boundary.
  UPDATE app.property_predator_owned_social_jobs AS job SET
    state = 'cancelled', next_reconcile_at = NULL,
    settled_at = statement_timestamp(), updated_at = statement_timestamp()
  WHERE job.workspace_id = p_workspace_id
    AND job.provider_connection_id = p_provider_connection_id
    AND job.network = ANY(p_networks)
    AND job.state = 'queued' AND job.planning_target_id IS NOT NULL
    AND (
      EXISTS (
        SELECT 1 FROM app.public_social_planning_target_cancellations AS cancellation
        WHERE cancellation.workspace_id = job.workspace_id
          AND cancellation.intent_id = job.planning_intent_id
          AND cancellation.target_id = job.planning_target_id
      )
      OR EXISTS (
        SELECT 1 FROM app.public_social_planning_target_supersessions AS supersession
        WHERE supersession.workspace_id = job.workspace_id
          AND supersession.predecessor_intent_id = job.planning_intent_id
          AND supersession.predecessor_target_id = job.planning_target_id
      )
    );

  -- Stale approval/version/attestation evidence is fenced for review before
  -- the job can be selected, even if it was valid when originally queued.
  UPDATE app.property_predator_owned_social_jobs AS job SET
    state = 'needs_attention', next_reconcile_at = NULL,
    settled_at = statement_timestamp(), updated_at = statement_timestamp()
  WHERE job.workspace_id = p_workspace_id
    AND job.provider_connection_id = p_provider_connection_id
    AND job.network = ANY(p_networks)
    AND job.state = 'queued' AND job.planning_target_id IS NOT NULL
    AND job.available_at <= statement_timestamp() - interval '5 minutes'
    AND NOT app_private.owned_social_job_effect_ready_v2(job.workspace_id, job.id);

  UPDATE app.property_predator_owned_social_jobs AS job SET
    state = 'needs_attention', next_reconcile_at = NULL,
    settled_at = statement_timestamp(), updated_at = statement_timestamp()
  WHERE job.workspace_id = p_workspace_id
    AND job.provider_connection_id = p_provider_connection_id
    AND job.network = ANY(p_networks)
    AND ((job.state = 'queued' AND job.available_at <= statement_timestamp())
      OR (job.state = 'reconciliation_pending' AND job.next_reconcile_at <= statement_timestamp()))
    AND (
      (job.state = 'queued'
        AND job.utc_day <> (statement_timestamp() AT TIME ZONE 'UTC')::date)
      OR NOT EXISTS (
        SELECT 1 FROM app.property_predator_owned_social_profiles AS profile
        JOIN app.provider_connections AS connection
          ON connection.workspace_id = profile.workspace_id
         AND connection.id = profile.provider_connection_id
         AND connection.environment = 'live' AND connection.provider_id = 'ayrshare'
         AND connection.provider_kind = 'social' AND connection.status = 'active'
        WHERE profile.workspace_id = job.workspace_id AND profile.id = job.profile_id
          AND profile.provider_connection_id = job.provider_connection_id
          AND profile.network = job.network
          AND NOT EXISTS (
            SELECT 1 FROM app.property_predator_owned_social_profile_revocations AS revocation
            WHERE revocation.workspace_id = profile.workspace_id
              AND revocation.profile_id = profile.id
          )
      )
    );

  SELECT job.* INTO selected FROM app.property_predator_owned_social_jobs AS job
  WHERE job.workspace_id = p_workspace_id
    AND job.provider_connection_id = p_provider_connection_id
    AND job.network = ANY(p_networks)
    AND ((job.state = 'queued' AND job.available_at <= statement_timestamp())
      OR (job.state = 'reconciliation_pending' AND job.next_reconcile_at <= statement_timestamp()))
    AND job.claim_count < 12
    AND (job.state = 'reconciliation_pending' OR job.planning_target_id IS NULL
      OR app_private.owned_social_job_effect_ready_v2(job.workspace_id, job.id))
    AND EXISTS (
      SELECT 1 FROM app.property_predator_owned_social_profiles AS profile
      JOIN app.provider_connections AS connection
        ON connection.workspace_id = profile.workspace_id
       AND connection.id = profile.provider_connection_id
       AND connection.environment = 'live' AND connection.provider_id = 'ayrshare'
       AND connection.provider_kind = 'social' AND connection.status = 'active'
      WHERE profile.workspace_id = job.workspace_id AND profile.id = job.profile_id
        AND profile.provider_connection_id = job.provider_connection_id
        AND profile.network = job.network
        AND NOT EXISTS (
          SELECT 1 FROM app.property_predator_owned_social_profile_revocations AS revocation
          WHERE revocation.workspace_id = profile.workspace_id
            AND revocation.profile_id = profile.id
        )
    )
  ORDER BY CASE WHEN job.state = 'reconciliation_pending' THEN 0 ELSE 1 END,
    coalesce(job.next_reconcile_at, job.available_at), job.created_at
  LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN; END IF;
  selected_kind := CASE WHEN selected.state = 'queued' THEN 'publish' ELSE 'reconcile' END;
  next_version := selected.lease_version + 1;
  UPDATE app.property_predator_owned_social_jobs SET
    state = 'leased', lease_version = next_version, lease_attempt_kind = selected_kind,
    lease_expires_at = statement_timestamp() + make_interval(secs => p_lease_seconds),
    claim_count = claim_count + 1, leased_at = statement_timestamp(),
    next_reconcile_at = NULL, updated_at = statement_timestamp()
  WHERE workspace_id = p_workspace_id AND id = selected.id;
  INSERT INTO app.property_predator_owned_social_job_leases
    (workspace_id, job_id, lease_version, lease_token_sha256)
  VALUES (p_workspace_id, selected.id, next_version, public.digest(p_lease_token, 'sha256'))
  ON CONFLICT (workspace_id, job_id) DO UPDATE SET
    lease_version = EXCLUDED.lease_version,
    lease_token_sha256 = EXCLUDED.lease_token_sha256,
    issued_at = statement_timestamp();
  RETURN QUERY SELECT selected.id, selected.profile_id, next_version, selected_kind;
END
$function$;

CREATE FUNCTION app_private.begin_owned_social_call_v2(
  p_workspace_id uuid, p_job_id uuid, p_lease_version bigint, p_lease_token bytea,
  p_provider_effects_enabled boolean, p_emergency_paused boolean
) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE changed integer; selected record; locked_content_item uuid;
BEGIN
  IF session_user <> 'r72_owned_social_worker_command'
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'worker'
     OR coalesce(current_setting('app.user_id', true), '') <> ''
     OR coalesce(current_setting('app.request_id', true), '') = ''
     OR NOT p_provider_effects_enabled OR p_emergency_paused THEN
    RAISE EXCEPTION 'Owned social begin-call denied' USING ERRCODE = '42501';
  END IF;

  SELECT job.planning_intent_id, job.planning_target_id, job.lease_attempt_kind
    INTO selected
  FROM app.property_predator_owned_social_jobs AS job
  JOIN app.property_predator_owned_social_job_leases AS lease
    ON lease.workspace_id = job.workspace_id AND lease.job_id = job.id
   AND lease.lease_version = job.lease_version
   AND lease.lease_token_sha256 = public.digest(p_lease_token, 'sha256')
  WHERE job.workspace_id = p_workspace_id AND job.id = p_job_id
    AND job.state = 'leased' AND job.lease_version = p_lease_version
    AND job.lease_expires_at > statement_timestamp();
  IF NOT FOUND THEN RETURN false; END IF;

  IF selected.lease_attempt_kind = 'publish'
     AND selected.planning_target_id IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'public-social-planning-target:' || p_workspace_id::text || ':'
          || selected.planning_intent_id::text || ':' || selected.planning_target_id::text,
        7200040
      )
    );
  END IF;

  -- The company-content append functions use this exact per-item lock. Take
  -- main and media locks in deterministic order before the final evidence
  -- query, so a newer version/approval cannot commit between proof check and
  -- the provider-call transition.
  FOR locked_content_item IN
    SELECT content_identity.content_item_id
    FROM (
      SELECT job.content_item_id
      FROM app.property_predator_owned_social_jobs AS job
      WHERE job.workspace_id = p_workspace_id AND job.id = p_job_id
      UNION
      SELECT media.content_item_id
      FROM app.property_predator_owned_social_job_media AS media
      WHERE media.workspace_id = p_workspace_id AND media.job_id = p_job_id
    ) AS content_identity
    ORDER BY content_identity.content_item_id
  LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'company-content:' || p_workspace_id::text || ':'
          || locked_content_item::text,
        7200021
      )
    );
  END LOOP;

  -- Cancellation/reschedule and provider begin all take the exact target lock
  -- then sorted content locks before the live-job row lock. Re-read the lease
  -- after waiting: no pre-lock visibility or lease evidence is trusted across
  -- either advisory-lock boundary.
  SELECT job.planning_intent_id, job.planning_target_id, job.lease_attempt_kind
    INTO selected
  FROM app.property_predator_owned_social_jobs AS job
  JOIN app.property_predator_owned_social_job_leases AS lease
    ON lease.workspace_id = job.workspace_id AND lease.job_id = job.id
   AND lease.lease_version = job.lease_version
   AND lease.lease_token_sha256 = public.digest(p_lease_token, 'sha256')
  WHERE job.workspace_id = p_workspace_id AND job.id = p_job_id
    AND job.state = 'leased' AND job.lease_version = p_lease_version
    AND job.lease_expires_at > statement_timestamp()
  FOR UPDATE OF job;
  IF NOT FOUND THEN RETURN false; END IF;

  UPDATE app.property_predator_owned_social_jobs AS job SET
    state = 'calling', calling_at = statement_timestamp(), updated_at = statement_timestamp()
  FROM app.property_predator_owned_social_job_leases AS lease
  WHERE job.workspace_id = p_workspace_id AND job.id = p_job_id
    AND job.state = 'leased' AND job.lease_version = p_lease_version
    AND job.lease_expires_at > statement_timestamp()
    AND lease.workspace_id = job.workspace_id AND lease.job_id = job.id
    AND lease.lease_version = job.lease_version
    AND lease.lease_token_sha256 = public.digest(p_lease_token, 'sha256')
    AND (job.lease_attempt_kind = 'reconcile' OR (
      (job.planning_target_id IS NULL
        OR app_private.owned_social_job_effect_ready_v2(job.workspace_id, job.id))
      AND job.utc_day = (statement_timestamp() AT TIME ZONE 'UTC')::date
      AND job.utc_month = date_trunc('month', statement_timestamp() AT TIME ZONE 'UTC')::date
      AND (SELECT count(*) FROM app.property_predator_owned_social_jobs AS capped_day
        WHERE capped_day.workspace_id = job.workspace_id
          AND capped_day.profile_id = job.profile_id
          AND capped_day.utc_day = job.utc_day
          AND capped_day.state <> 'cancelled') <= 1
      AND (SELECT count(*) FROM app.property_predator_owned_social_jobs AS capped_month
        WHERE capped_month.workspace_id = job.workspace_id
          AND capped_month.profile_id = job.profile_id
          AND capped_month.utc_month = job.utc_month
          AND capped_month.state <> 'cancelled') <= 3
    ))
    AND EXISTS (
      SELECT 1 FROM app.property_predator_owned_social_profiles AS profile
      JOIN app.provider_connections AS connection
        ON connection.workspace_id = profile.workspace_id
       AND connection.id = profile.provider_connection_id
       AND connection.environment = 'live' AND connection.provider_id = 'ayrshare'
       AND connection.provider_kind = 'social' AND connection.status = 'active'
      WHERE profile.workspace_id = job.workspace_id AND profile.id = job.profile_id
        AND profile.provider_connection_id = job.provider_connection_id
        AND profile.network = job.network
        AND NOT EXISTS (
          SELECT 1 FROM app.property_predator_owned_social_profile_revocations AS revocation
          WHERE revocation.workspace_id = profile.workspace_id
            AND revocation.profile_id = profile.id
        )
    );
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END;
$function$;

CREATE FUNCTION app_private.load_owned_social_job_v2(
  p_workspace_id uuid, p_job_id uuid, p_lease_version bigint, p_lease_token bytea
) RETURNS TABLE(
  provider_connection_id uuid, profile_id uuid, attempt_kind text,
  secret_key_version text, profile_key_iv bytea, profile_key_ciphertext bytea,
  profile_key_auth_tag bytea, profile_key_aad_sha256 bytea, profile_key_sha256 bytea,
  operation_tag text, idempotency_key text, text_body text, text_sha256 bytea,
  scheduled_for timestamptz, provider_external_id text, network text, media jsonb
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $function$
  SELECT job.provider_connection_id, job.profile_id, job.lease_attempt_kind,
    profile.secret_key_version, profile.profile_key_iv, profile.profile_key_ciphertext,
    profile.profile_key_auth_tag, profile.profile_key_aad_sha256, profile.profile_key_sha256,
    job.operation_tag, encode(job.idempotency_key_sha256, 'hex'), job.text_body,
    job.text_sha256, job.scheduled_for, job.provider_external_id, job.network,
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'storageKey', media_row.blob_storage_key,
        'blobSha256', encode(media_row.blob_sha256, 'hex'),
        'mimeType', media_row.content_mime_type
      ) ORDER BY media_row.ordinal)
      FROM app.property_predator_owned_social_job_media AS media_row
      WHERE media_row.workspace_id = job.workspace_id AND media_row.job_id = job.id
    ), '[]'::jsonb)
  FROM app.property_predator_owned_social_jobs AS job
  JOIN app.property_predator_owned_social_job_leases AS lease
    ON lease.workspace_id = job.workspace_id AND lease.job_id = job.id
   AND lease.lease_version = job.lease_version
   AND lease.lease_token_sha256 = public.digest(p_lease_token, 'sha256')
  JOIN app.property_predator_owned_social_profiles AS profile
    ON profile.workspace_id = job.workspace_id AND profile.id = job.profile_id
   AND profile.provider_connection_id = job.provider_connection_id
   AND profile.network = job.network
  JOIN app.provider_connections AS connection
    ON connection.workspace_id = profile.workspace_id
   AND connection.id = profile.provider_connection_id
   AND connection.environment = 'live' AND connection.provider_id = 'ayrshare'
   AND connection.provider_kind = 'social' AND connection.status = 'active'
  WHERE session_user = 'r72_owned_social_worker_command'
    AND current_setting('app.workspace_id', true) = p_workspace_id::text
    AND current_setting('app.actor_kind', true) = 'worker'
    AND coalesce(current_setting('app.user_id', true), '') = ''
    AND coalesce(current_setting('app.request_id', true), '') <> ''
    AND job.workspace_id = p_workspace_id AND job.id = p_job_id
    AND job.state = 'leased' AND job.lease_version = p_lease_version
    AND job.lease_expires_at > statement_timestamp()
    AND NOT EXISTS (
      SELECT 1 FROM app.property_predator_owned_social_profile_revocations AS revocation
      WHERE revocation.workspace_id = profile.workspace_id AND revocation.profile_id = profile.id
    );
$function$;

REVOKE ALL ON FUNCTION app_private.record_owned_social_profile_v2(
  uuid, uuid, uuid, text, text, bytea, bytea, text, bytea, bytea, bytea,
  bytea, bytea, bytea, timestamptz, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.enqueue_owned_social_job_v2(
  uuid, uuid, uuid, text, bytea, uuid, uuid, uuid, uuid, uuid, uuid, uuid,
  text, bytea, bytea, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.owned_social_job_effect_ready_v2(
  uuid, uuid
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.claim_owned_social_job_v2(
  uuid, uuid, text[], bytea, integer
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.begin_owned_social_call_v2(
  uuid, uuid, bigint, bytea, boolean, boolean
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.load_owned_social_job_v2(
  uuid, uuid, bigint, bytea
) FROM PUBLIC;
-- The worker must not bypass exact target/network/proof checks by calling the
-- 0052 claim/load/begin functions. Settle remains the shared receipt boundary.
REVOKE EXECUTE ON FUNCTION app_private.claim_owned_social_job(
  uuid, uuid, bytea, integer
) FROM r72_owned_social_worker_command;
REVOKE EXECUTE ON FUNCTION app_private.load_owned_social_job(
  uuid, uuid, bigint, bytea
) FROM r72_owned_social_worker_command;
REVOKE EXECUTE ON FUNCTION app_private.begin_owned_social_call(
  uuid, uuid, bigint, bytea, boolean, boolean
) FROM r72_owned_social_worker_command;
GRANT EXECUTE ON FUNCTION app_private.record_owned_social_profile_v2(
  uuid, uuid, uuid, text, text, bytea, bytea, text, bytea, bytea, bytea,
  bytea, bytea, bytea, timestamptz, timestamptz
) TO r72_owned_social_command;
GRANT EXECUTE ON FUNCTION app_private.enqueue_owned_social_job_v2(
  uuid, uuid, uuid, text, bytea, uuid, uuid, uuid, uuid, uuid, uuid, uuid,
  text, bytea, bytea, timestamptz
) TO r72_owned_social_command;
GRANT EXECUTE ON FUNCTION app_private.claim_owned_social_job_v2(
  uuid, uuid, text[], bytea, integer
) TO r72_owned_social_worker_command;
GRANT EXECUTE ON FUNCTION app_private.begin_owned_social_call_v2(
  uuid, uuid, bigint, bytea, boolean, boolean
) TO r72_owned_social_worker_command;
GRANT EXECUTE ON FUNCTION app_private.load_owned_social_job_v2(
  uuid, uuid, bigint, bytea
) TO r72_owned_social_worker_command;

RESET ROLE;
REVOKE CREATE ON SCHEMA app_private FROM r72_owned_social_definer;
