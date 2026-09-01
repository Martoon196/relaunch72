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
    ON DELETE RESTRICT;

CREATE TABLE app.property_predator_owned_social_job_media (
  workspace_id uuid NOT NULL,
  job_id uuid NOT NULL,
  ordinal smallint NOT NULL CHECK (ordinal BETWEEN 1 AND 10),
  content_item_id uuid NOT NULL,
  content_version_id uuid NOT NULL,
  content_sha256 bytea NOT NULL CHECK (octet_length(content_sha256) = 32),
  blob_sha256 bytea NOT NULL CHECK (octet_length(blob_sha256) = 32),
  blob_storage_key text NOT NULL CHECK (
    blob_storage_key ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,499}$'
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
  IF NEW.planning_intent_id IS DISTINCT FROM OLD.planning_intent_id THEN
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

GRANT SELECT, INSERT ON app.property_predator_owned_social_job_media
  TO r72_owned_social_definer;
GRANT SELECT ON app.public_social_planning_intents,
  app.public_social_planning_intent_targets,
  app.public_social_planning_intent_media,
  app.public_social_planning_target_cancellations,
  app.public_social_planning_target_supersessions
  TO r72_owned_social_definer;

GRANT CREATE ON SCHEMA app_private TO r72_owned_social_definer;
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
  p_network text, p_planning_intent_id uuid,
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

  PERFORM profile.id
  FROM app.property_predator_owned_social_profiles AS profile
  WHERE profile.workspace_id = p_workspace_id AND profile.id = p_profile_id
    AND profile.provider_connection_id = p_provider_connection_id
    AND profile.environment = 'live' AND profile.network = p_network
    AND profile.provider_permissions = 'publish'
    AND NOT EXISTS (
      SELECT 1 FROM app.property_predator_owned_social_profile_revocations AS revocation
      WHERE revocation.workspace_id = profile.workspace_id AND revocation.profile_id = profile.id
    )
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Owned social profile binding denied' USING ERRCODE = '42501'; END IF;

  SELECT job.id, job.request_sha256 INTO existing
  FROM app.property_predator_owned_social_jobs AS job
  WHERE job.workspace_id = p_workspace_id
    AND job.idempotency_key_sha256 = p_idempotency_key_sha256;
  IF FOUND THEN
    IF existing.request_sha256 <> p_request_sha256 THEN
      RAISE EXCEPTION 'Owned social idempotency conflict' USING ERRCODE = '40001';
    END IF;
    RETURN existing.id;
  END IF;

  SELECT version.content_body, version.content_sha256 INTO selected_version
  FROM app.public_social_planning_intents AS intent
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
    AND attestation.expires_at > greatest(statement_timestamp(), p_scheduled_for) + interval '15 minutes'
    AND EXISTS (
      SELECT 1 FROM app.public_social_planning_intent_targets AS target
      WHERE target.workspace_id = intent.workspace_id AND target.intent_id = intent.id
        AND target.network = p_network
        AND NOT EXISTS (
          SELECT 1 FROM app.public_social_planning_target_cancellations AS cancellation
          WHERE cancellation.workspace_id = target.workspace_id
            AND cancellation.intent_id = target.intent_id AND cancellation.target_id = target.target_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM app.public_social_planning_target_supersessions AS supersession
          WHERE supersession.workspace_id = target.workspace_id
            AND supersession.predecessor_intent_id = target.intent_id
            AND supersession.predecessor_target_id = target.target_id
        )
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
  IF length(selected_version.content_body) > CASE p_network WHEN 'instagram' THEN 2200 ELSE 3000 END THEN
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
    AND media_attestation.expires_at > greatest(statement_timestamp(), p_scheduled_for) + interval '15 minutes'
    AND NOT EXISTS (
      SELECT 1 FROM app.company_content_versions AS newer_media
      WHERE newer_media.workspace_id = media_version.workspace_id
        AND newer_media.content_item_id = media_version.content_item_id
        AND newer_media.version_number > media_version.version_number
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
    planning_intent_id, content_item_id, content_version_id, content_sha256,
    approval_request_id, approval_decision_id, source_attestation_id,
    operation_tag, idempotency_key_sha256, request_sha256, text_body,
    scheduled_for, utc_day, utc_month, available_at, created_by_user_id
  ) VALUES (
    selected_id, p_workspace_id, p_provider_connection_id, p_profile_id, 'live', p_network,
    p_planning_intent_id, p_content_item_id, p_content_version_id,
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
  uuid, uuid, uuid, text, uuid, uuid, uuid, uuid, uuid, uuid, text,
  bytea, bytea, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.load_owned_social_job_v2(
  uuid, uuid, bigint, bytea
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.record_owned_social_profile_v2(
  uuid, uuid, uuid, text, text, bytea, bytea, text, bytea, bytea, bytea,
  bytea, bytea, bytea, timestamptz, timestamptz
) TO r72_owned_social_command;
GRANT EXECUTE ON FUNCTION app_private.enqueue_owned_social_job_v2(
  uuid, uuid, uuid, text, uuid, uuid, uuid, uuid, uuid, uuid, text,
  bytea, bytea, timestamptz
) TO r72_owned_social_command;
GRANT EXECUTE ON FUNCTION app_private.load_owned_social_job_v2(
  uuid, uuid, bigint, bytea
) TO r72_owned_social_worker_command;

RESET ROLE;
REVOKE CREATE ON SCHEMA app_private FROM r72_owned_social_definer;
