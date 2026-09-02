-- Zernio-qualified Instagram and LinkedIn calendar publishing boundary.
--
-- The historical Ayrshare profile, job and worker functions from 0052/0080
-- remain intact. This migration reuses the mature calendar job/media/lease/
-- receipt state machine, but gives Zernio a separate immutable account binding.
-- No Zernio API key, bearer token or other provider credential enters Postgres.

SET LOCAL ROLE r72_owner;

ALTER TABLE app.property_predator_zernio_accounts
  ADD CONSTRAINT property_predator_zernio_accounts_publish_identity_uq
  UNIQUE (
    workspace_id, id, provider_connection_id, environment, network,
    provider_profile_id_sha256, provider_account_id_sha256
  );

CREATE TABLE app.property_predator_zernio_publish_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  provider_connection_id uuid NOT NULL,
  zernio_account_id uuid NOT NULL,
  environment text NOT NULL CHECK (environment = 'live'),
  provider_id text NOT NULL CHECK (provider_id = 'zernio'),
  adapter_contract text NOT NULL
    DEFAULT 'propertypredator.zernio-calendar-publishing/v1'
    CHECK (adapter_contract = 'propertypredator.zernio-calendar-publishing/v1'),
  network text NOT NULL CHECK (network IN ('instagram', 'linkedin')),
  provider_profile_id_sha256 bytea NOT NULL
    CHECK (octet_length(provider_profile_id_sha256) = 32),
  provider_account_id_sha256 bytea NOT NULL
    CHECK (octet_length(provider_account_id_sha256) = 32),
  publish_capability_evidence_sha256 bytea NOT NULL
    CHECK (octet_length(publish_capability_evidence_sha256) = 32),
  ownership_evidence_sha256 bytea NOT NULL
    CHECK (octet_length(ownership_evidence_sha256) = 32),
  verified_at timestamptz NOT NULL,
  created_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, id, provider_connection_id),
  UNIQUE (
    workspace_id, id, provider_connection_id, provider_id, network,
    zernio_account_id
  ),
  FOREIGN KEY (workspace_id, provider_connection_id, environment)
    REFERENCES app.provider_connections (workspace_id, id, environment) ON DELETE RESTRICT,
  FOREIGN KEY (
    workspace_id, zernio_account_id, provider_connection_id, environment,
    network, provider_profile_id_sha256, provider_account_id_sha256
  ) REFERENCES app.property_predator_zernio_accounts (
    workspace_id, id, provider_connection_id, environment, network,
    provider_profile_id_sha256, provider_account_id_sha256
  ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, created_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK (verified_at <= created_at + interval '5 minutes')
);

CREATE TABLE app.property_predator_zernio_publish_binding_revocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  provider_connection_id uuid NOT NULL,
  binding_id uuid NOT NULL,
  revocation_evidence_sha256 bytea NOT NULL
    CHECK (octet_length(revocation_evidence_sha256) = 32),
  reason_code text NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_.:-]{0,99}$'),
  revoked_by_user_id uuid NOT NULL,
  revoked_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, binding_id),
  FOREIGN KEY (workspace_id, binding_id, provider_connection_id)
    REFERENCES app.property_predator_zernio_publish_bindings
      (workspace_id, id, provider_connection_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, revoked_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT
);

-- The shared job state machine becomes explicitly provider-qualified. Legacy
-- rows and legacy inserts retain the Ayrshare default and their original FK.
ALTER TABLE app.property_predator_owned_social_jobs
  ADD COLUMN provider_id text NOT NULL DEFAULT 'ayrshare'
    CHECK (provider_id IN ('ayrshare', 'zernio')),
  ADD COLUMN zernio_publish_binding_id uuid,
  ADD COLUMN zernio_account_id uuid,
  ALTER COLUMN profile_id DROP NOT NULL;

ALTER TABLE app.property_predator_owned_social_receipts
  ADD COLUMN provider_id text NOT NULL DEFAULT 'ayrshare'
    CHECK (provider_id IN ('ayrshare', 'zernio')),
  ADD COLUMN lease_token_sha256 bytea
    CHECK (lease_token_sha256 IS NULL OR octet_length(lease_token_sha256) = 32);

ALTER TABLE app.property_predator_owned_social_jobs
  ADD CONSTRAINT property_predator_owned_social_jobs_provider_binding_check
  CHECK (
    (provider_id = 'ayrshare' AND profile_id IS NOT NULL
      AND zernio_publish_binding_id IS NULL AND zernio_account_id IS NULL)
    OR
    (provider_id = 'zernio' AND profile_id IS NULL
      AND zernio_publish_binding_id IS NOT NULL AND zernio_account_id IS NOT NULL)
  ),
  ADD CONSTRAINT property_predator_owned_social_jobs_zernio_binding_fk
  FOREIGN KEY (
    workspace_id, zernio_publish_binding_id, provider_connection_id,
    provider_id, network, zernio_account_id
  ) REFERENCES app.property_predator_zernio_publish_bindings (
    workspace_id, id, provider_connection_id, provider_id, network,
    zernio_account_id
  ) ON DELETE RESTRICT;

CREATE INDEX property_predator_zernio_publish_bindings_account_idx
  ON app.property_predator_zernio_publish_bindings
    (workspace_id, provider_connection_id, zernio_account_id, network);
CREATE INDEX property_predator_zernio_calendar_jobs_claim_idx
  ON app.property_predator_owned_social_jobs
    (workspace_id, provider_connection_id, available_at, created_at)
  WHERE provider_id = 'zernio' AND state = 'queued';
CREATE INDEX property_predator_zernio_calendar_jobs_reconcile_idx
  ON app.property_predator_owned_social_jobs
    (workspace_id, provider_connection_id, next_reconcile_at, created_at)
  WHERE provider_id = 'zernio' AND state = 'reconciliation_pending';
CREATE INDEX property_predator_zernio_calendar_jobs_daily_cap_idx
  ON app.property_predator_owned_social_jobs
    (workspace_id, zernio_account_id, network, utc_day)
  WHERE provider_id = 'zernio' AND state <> 'cancelled';
CREATE INDEX property_predator_zernio_calendar_jobs_monthly_cap_idx
  ON app.property_predator_owned_social_jobs
    (workspace_id, zernio_account_id, network, utc_month)
  WHERE provider_id = 'zernio' AND state <> 'cancelled';
CREATE UNIQUE INDEX property_predator_zernio_calendar_jobs_external_id_uq
  ON app.property_predator_owned_social_jobs
    (workspace_id, zernio_account_id, provider_external_id)
  WHERE provider_id = 'zernio' AND provider_external_id IS NOT NULL;

CREATE TRIGGER property_predator_zernio_publish_bindings_immutable
  BEFORE UPDATE OR DELETE ON app.property_predator_zernio_publish_bindings
  FOR EACH ROW EXECUTE FUNCTION app_private.owned_social_immutable_guard();
CREATE TRIGGER property_predator_zernio_publish_binding_revocations_immutable
  BEFORE UPDATE OR DELETE ON app.property_predator_zernio_publish_binding_revocations
  FOR EACH ROW EXECUTE FUNCTION app_private.owned_social_immutable_guard();

ALTER TABLE app.property_predator_zernio_publish_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.property_predator_zernio_publish_bindings FORCE ROW LEVEL SECURITY;
ALTER TABLE app.property_predator_zernio_publish_binding_revocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.property_predator_zernio_publish_binding_revocations FORCE ROW LEVEL SECURITY;

CREATE POLICY zernio_publish_bindings_owner_all
  ON app.property_predator_zernio_publish_bindings FOR ALL TO r72_owner
  USING (true) WITH CHECK (true);
CREATE POLICY zernio_publish_binding_revocations_owner_all
  ON app.property_predator_zernio_publish_binding_revocations FOR ALL TO r72_owner
  USING (true) WITH CHECK (true);
CREATE POLICY zernio_publish_bindings_owned_social_definer_all
  ON app.property_predator_zernio_publish_bindings FOR ALL TO r72_owned_social_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY zernio_publish_binding_revocations_owned_social_definer_all
  ON app.property_predator_zernio_publish_binding_revocations FOR ALL TO r72_owned_social_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY zernio_accounts_owned_social_definer_select
  ON app.property_predator_zernio_accounts FOR SELECT TO r72_owned_social_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY zernio_account_receipts_owned_social_definer_select
  ON app.property_predator_zernio_account_webhook_receipts
  FOR SELECT TO r72_owned_social_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

GRANT SELECT, INSERT ON app.property_predator_zernio_publish_bindings,
  app.property_predator_zernio_publish_binding_revocations TO r72_owned_social_definer;
GRANT SELECT ON app.property_predator_zernio_accounts,
  app.property_predator_zernio_account_webhook_receipts TO r72_owned_social_definer;

INSERT INTO app_private.workspace_table_registry
  (schema_name, table_name, workspace_column)
VALUES
  ('app', 'property_predator_zernio_publish_bindings', 'workspace_id'),
  ('app', 'property_predator_zernio_publish_binding_revocations', 'workspace_id');

GRANT CREATE ON SCHEMA app_private TO r72_owned_social_definer;
SET LOCAL ROLE r72_owned_social_definer;

-- Include the new provider/binding identity in the existing immutable job
-- identity fence while retaining every original identity field.
-- The trigger function was created by r72_owner in 0052, so its replacement
-- must remain under that owner. Switch back to the definer role immediately
-- afterwards for the new SECURITY DEFINER command functions.
SET LOCAL ROLE r72_owner;
CREATE OR REPLACE FUNCTION app_private.owned_social_job_identity_guard()
RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog AS $function$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.provider_connection_id IS DISTINCT FROM OLD.provider_connection_id
     OR NEW.provider_id IS DISTINCT FROM OLD.provider_id
     OR NEW.profile_id IS DISTINCT FROM OLD.profile_id
     OR NEW.zernio_publish_binding_id IS DISTINCT FROM OLD.zernio_publish_binding_id
     OR NEW.zernio_account_id IS DISTINCT FROM OLD.zernio_account_id
     OR NEW.environment IS DISTINCT FROM OLD.environment
     OR NEW.network IS DISTINCT FROM OLD.network
     OR NEW.content_item_id IS DISTINCT FROM OLD.content_item_id
     OR NEW.content_version_id IS DISTINCT FROM OLD.content_version_id
     OR NEW.content_sha256 IS DISTINCT FROM OLD.content_sha256
     OR NEW.approval_request_id IS DISTINCT FROM OLD.approval_request_id
     OR NEW.approval_decision_id IS DISTINCT FROM OLD.approval_decision_id
     OR NEW.source_attestation_id IS DISTINCT FROM OLD.source_attestation_id
     OR NEW.operation_tag IS DISTINCT FROM OLD.operation_tag
     OR NEW.idempotency_key_sha256 IS DISTINCT FROM OLD.idempotency_key_sha256
     OR NEW.request_sha256 IS DISTINCT FROM OLD.request_sha256
     OR NEW.text_body IS DISTINCT FROM OLD.text_body
     OR NEW.scheduled_for IS DISTINCT FROM OLD.scheduled_for
     OR NEW.utc_day IS DISTINCT FROM OLD.utc_day
     OR NEW.utc_month IS DISTINCT FROM OLD.utc_month
     OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Owned public-social job identity evidence is immutable'
      USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END
$function$;
SET LOCAL ROLE r72_owned_social_definer;

CREATE FUNCTION app_private.enqueue_zernio_calendar_job(
  p_workspace_id uuid, p_provider_connection_id uuid, p_binding_id uuid,
  p_zernio_account_id uuid, p_network text,
  p_expected_provider_profile_id_sha256 bytea,
  p_expected_provider_account_id_sha256 bytea,
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
  IF session_user <> 'r72_zernio_social_command'
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'user'
     OR current_setting('app.user_id', true) !~ '^[0-9a-f-]{36}$'
     OR coalesce(current_setting('app.request_id', true), '') = ''
     OR p_network NOT IN ('instagram', 'linkedin')
     OR p_expected_provider_profile_id_sha256 IS NULL
     OR octet_length(p_expected_provider_profile_id_sha256) <> 32
     OR p_expected_provider_account_id_sha256 IS NULL
     OR octet_length(p_expected_provider_account_id_sha256) <> 32
     OR p_planning_intent_id IS NULL OR p_planning_target_id IS NULL
     OR p_scheduled_for IS NULL
     OR p_operation_tag IS NULL
     OR p_operation_tag !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$'
     OR p_idempotency_key_sha256 IS NULL
     OR octet_length(p_idempotency_key_sha256) <> 32
     OR p_request_sha256 IS NULL
     OR octet_length(p_request_sha256) <> 32 THEN
    RAISE EXCEPTION 'Zernio calendar enqueue denied' USING ERRCODE = '42501';
  END IF;
  selected_user := current_setting('app.user_id')::uuid;
  IF NOT EXISTS (
    SELECT 1 FROM app.workspace_memberships AS membership
    WHERE membership.workspace_id = p_workspace_id AND membership.user_id = selected_user
      AND membership.status = 'active' AND membership.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'Zernio calendar enqueue denied' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public-social-planning-target:' || p_workspace_id::text || ':'
        || p_planning_intent_id::text || ':' || p_planning_target_id::text,
      7200040
    )
  );

  -- Revocation takes this exact lock. Take it before trusting binding state and
  -- retain it through the cap count and insert, so a concurrent revoke cannot
  -- land between the active-binding proof and the durable job identity.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'zernio-calendar-publish-binding:' || p_workspace_id::text || ':'
        || p_binding_id::text,
      7200085
    )
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'zernio-calendar-publish-account:' || p_workspace_id::text || ':'
        || p_zernio_account_id::text || ':' || p_network,
      7200085
    )
  );

  PERFORM binding.id
  FROM app.property_predator_zernio_publish_bindings AS binding
  JOIN app.property_predator_zernio_accounts AS account
    ON account.workspace_id = binding.workspace_id
   AND account.id = binding.zernio_account_id
   AND account.provider_connection_id = binding.provider_connection_id
   AND account.provider_profile_id_sha256 = binding.provider_profile_id_sha256
   AND account.provider_account_id_sha256 = binding.provider_account_id_sha256
   AND account.network = binding.network
  JOIN app.provider_connections AS connection
    ON connection.workspace_id = binding.workspace_id
   AND connection.id = binding.provider_connection_id
   AND connection.environment = binding.environment
  WHERE binding.workspace_id = p_workspace_id AND binding.id = p_binding_id
    AND binding.provider_connection_id = p_provider_connection_id
    AND binding.zernio_account_id = p_zernio_account_id
    AND binding.provider_id = 'zernio' AND binding.network = p_network
    AND binding.provider_profile_id_sha256 = p_expected_provider_profile_id_sha256
    AND binding.provider_account_id_sha256 = p_expected_provider_account_id_sha256
    AND account.status = 'active'
    AND connection.provider_id = 'zernio' AND connection.provider_kind = 'social'
    AND connection.environment = 'live' AND connection.status = 'active'
    AND NOT EXISTS (
      SELECT 1 FROM app.property_predator_zernio_publish_binding_revocations AS revocation
      WHERE revocation.workspace_id = binding.workspace_id
        AND revocation.binding_id = binding.id
    )
  ;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Zernio calendar publish binding denied' USING ERRCODE = '42501';
  END IF;

  SELECT version.content_body, version.content_sha256 INTO selected_version
  FROM app.public_social_planning_intents AS intent
  JOIN app.public_social_planning_intent_targets AS target
    ON target.workspace_id = intent.workspace_id
   AND target.intent_id = intent.id
   AND target.target_id = p_planning_target_id
   AND target.network = p_network
   AND target.account_ref_sha256 = p_expected_provider_account_id_sha256
  JOIN app.company_content_versions AS version
    ON version.workspace_id = intent.workspace_id
   AND version.content_item_id = intent.content_item_id
   AND version.id = intent.content_version_id
   AND version.content_sha256 = intent.content_sha256
  JOIN app.company_content_approval_requests AS request
    ON request.workspace_id = version.workspace_id AND request.id = p_approval_request_id
   AND request.content_item_id = version.content_item_id
   AND request.content_version_id = version.id
   AND request.content_sha256 = version.content_sha256
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
    RAISE EXCEPTION 'Zernio calendar content evidence denied' USING ERRCODE = '42501';
  END IF;
  IF length(selected_version.content_body) >
      (CASE p_network WHEN 'instagram' THEN 2200 ELSE 3000 END) THEN
    RAISE EXCEPTION 'Zernio calendar network text denied' USING ERRCODE = '22023';
  END IF;
  IF p_request_sha256 <> public.digest(pg_catalog.format(
    'propertypredator.zernio-calendar-job/v1|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s',
    p_workspace_id, p_provider_connection_id, p_binding_id, p_zernio_account_id,
    p_network, encode(p_expected_provider_profile_id_sha256, 'hex'),
    encode(p_expected_provider_account_id_sha256, 'hex'), p_planning_intent_id,
    p_planning_target_id, p_content_item_id, p_content_version_id,
    p_approval_request_id, p_approval_decision_id, p_source_attestation_id,
    p_operation_tag,
    pg_catalog.floor(pg_catalog.date_part('epoch', p_scheduled_for) * 1000000)::bigint,
    encode(selected_version.content_sha256, 'hex'),
    encode(public.digest(selected_version.content_body, 'sha256'), 'hex')
  ), 'sha256') THEN
    RAISE EXCEPTION 'Zernio calendar request digest denied' USING ERRCODE = '42501';
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
    RAISE EXCEPTION 'Zernio calendar network media denied' USING ERRCODE = '22023';
  END IF;

  SELECT job.* INTO existing
  FROM app.property_predator_owned_social_jobs AS job
  WHERE job.workspace_id = p_workspace_id
    AND job.idempotency_key_sha256 = p_idempotency_key_sha256;
  IF FOUND THEN
    IF existing.request_sha256 <> p_request_sha256
       OR existing.provider_id <> 'zernio'
       OR existing.provider_connection_id <> p_provider_connection_id
       OR existing.profile_id IS NOT NULL
       OR existing.zernio_publish_binding_id <> p_binding_id
       OR existing.zernio_account_id <> p_zernio_account_id
       OR existing.network <> p_network
       OR existing.planning_intent_id <> p_planning_intent_id
       OR existing.planning_target_id <> p_planning_target_id
       OR existing.content_item_id <> p_content_item_id
       OR existing.content_version_id <> p_content_version_id
       OR existing.approval_request_id <> p_approval_request_id
       OR existing.approval_decision_id <> p_approval_decision_id
       OR existing.source_attestation_id <> p_source_attestation_id
       OR existing.operation_tag <> p_operation_tag
       OR existing.scheduled_for <> p_scheduled_for THEN
      RAISE EXCEPTION 'Zernio calendar idempotency conflict' USING ERRCODE = '40001';
    END IF;
    RETURN existing.id;
  END IF;

  selected_effect_at := greatest(statement_timestamp(), p_scheduled_for);
  IF (SELECT count(*) FROM app.property_predator_owned_social_jobs AS job
      WHERE job.workspace_id = p_workspace_id AND job.provider_id = 'zernio'
        AND job.zernio_account_id = p_zernio_account_id
        AND job.network = p_network
        AND job.utc_day = (selected_effect_at AT TIME ZONE 'UTC')::date
        AND job.state <> 'cancelled') >= 1
     OR (SELECT count(*) FROM app.property_predator_owned_social_jobs AS job
      WHERE job.workspace_id = p_workspace_id AND job.provider_id = 'zernio'
        AND job.zernio_account_id = p_zernio_account_id
        AND job.network = p_network
        AND job.utc_month = date_trunc('month', selected_effect_at AT TIME ZONE 'UTC')::date
        AND job.state <> 'cancelled') >= 3 THEN
    RAISE EXCEPTION 'Zernio calendar hard publish cap reached' USING ERRCODE = '42501';
  END IF;

  INSERT INTO app.property_predator_owned_social_jobs (
    id, workspace_id, provider_connection_id, provider_id, profile_id,
    zernio_publish_binding_id, zernio_account_id, environment, network,
    planning_intent_id, planning_target_id, content_item_id,
    content_version_id, content_sha256, approval_request_id,
    approval_decision_id, source_attestation_id, operation_tag,
    idempotency_key_sha256, request_sha256, text_body, scheduled_for,
    utc_day, utc_month, available_at, created_by_user_id
  ) VALUES (
    selected_id, p_workspace_id, p_provider_connection_id, 'zernio', NULL,
    p_binding_id, p_zernio_account_id, 'live', p_network,
    p_planning_intent_id, p_planning_target_id, p_content_item_id,
    p_content_version_id, selected_version.content_sha256,
    p_approval_request_id, p_approval_decision_id, p_source_attestation_id,
    p_operation_tag, p_idempotency_key_sha256, p_request_sha256,
    selected_version.content_body, p_scheduled_for,
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

CREATE FUNCTION app_private.record_zernio_calendar_publish_binding(
  p_workspace_id uuid, p_provider_connection_id uuid, p_binding_id uuid,
  p_zernio_account_id uuid, p_network text,
  p_provider_profile_id_sha256 bytea, p_provider_account_id_sha256 bytea,
  p_publish_capability_evidence_sha256 bytea,
  p_ownership_evidence_sha256 bytea, p_verified_at timestamptz
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE selected_user uuid; existing app.property_predator_zernio_publish_bindings%ROWTYPE;
BEGIN
  IF session_user <> 'r72_zernio_social_command'
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'user'
     OR current_setting('app.user_id', true) !~ '^[0-9a-f-]{36}$'
     OR coalesce(current_setting('app.request_id', true), '') = ''
     OR p_network NOT IN ('instagram', 'linkedin')
     OR p_provider_profile_id_sha256 IS NULL
     OR octet_length(p_provider_profile_id_sha256) <> 32
     OR p_provider_account_id_sha256 IS NULL
     OR octet_length(p_provider_account_id_sha256) <> 32
     OR p_publish_capability_evidence_sha256 IS NULL
     OR octet_length(p_publish_capability_evidence_sha256) <> 32
     OR p_ownership_evidence_sha256 IS NULL
     OR octet_length(p_ownership_evidence_sha256) <> 32
     OR p_verified_at IS NULL
     OR p_verified_at > statement_timestamp() + interval '5 minutes' THEN
    RAISE EXCEPTION 'Zernio calendar publish binding denied' USING ERRCODE = '42501';
  END IF;
  selected_user := current_setting('app.user_id')::uuid;
  IF NOT EXISTS (
    SELECT 1 FROM app.workspace_memberships AS membership
    WHERE membership.workspace_id = p_workspace_id AND membership.user_id = selected_user
      AND membership.status = 'active' AND membership.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'Zernio calendar publish binding denied' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'zernio-calendar-binding:' || p_workspace_id::text || ':'
        || p_zernio_account_id::text || ':' || p_network,
      7200085
    )
  );

  IF NOT EXISTS (
    SELECT 1
    FROM app.property_predator_zernio_accounts AS account
    JOIN app.provider_connections AS connection
      ON connection.workspace_id = account.workspace_id
     AND connection.id = account.provider_connection_id
     AND connection.environment = account.environment
    WHERE account.workspace_id = p_workspace_id AND account.id = p_zernio_account_id
      AND account.provider_connection_id = p_provider_connection_id
      AND account.provider_profile_id_sha256 = p_provider_profile_id_sha256
      AND account.provider_account_id_sha256 = p_provider_account_id_sha256
      AND account.network = p_network AND account.status = 'active'
      AND account.linked_at <= p_verified_at + interval '5 minutes'
      AND connection.provider_id = 'zernio' AND connection.provider_kind = 'social'
      AND connection.environment = 'live' AND connection.status = 'active'
      AND EXISTS (
        SELECT 1
        FROM app.property_predator_zernio_account_webhook_receipts AS connected_receipt
        WHERE connected_receipt.workspace_id = account.workspace_id
          AND connected_receipt.provider_connection_id = account.provider_connection_id
          AND connected_receipt.event_type = 'account.connected'
          AND connected_receipt.network = account.network
          AND connected_receipt.provider_profile_id_sha256 = account.provider_profile_id_sha256
          AND connected_receipt.provider_account_id_sha256 = account.provider_account_id_sha256
          AND connected_receipt.receipt_sha256 = p_ownership_evidence_sha256
          AND connected_receipt.occurred_at <= p_verified_at + interval '5 minutes'
          AND NOT EXISTS (
            SELECT 1
            FROM app.property_predator_zernio_account_webhook_receipts AS disconnected_receipt
            WHERE disconnected_receipt.workspace_id = connected_receipt.workspace_id
              AND disconnected_receipt.provider_connection_id = connected_receipt.provider_connection_id
              AND disconnected_receipt.event_type = 'account.disconnected'
              AND disconnected_receipt.network = connected_receipt.network
              AND disconnected_receipt.provider_profile_id_sha256 = connected_receipt.provider_profile_id_sha256
              AND disconnected_receipt.provider_account_id_sha256 = connected_receipt.provider_account_id_sha256
              AND disconnected_receipt.occurred_at >= connected_receipt.occurred_at
          )
      )
  ) THEN
    RAISE EXCEPTION 'Zernio calendar account binding denied' USING ERRCODE = '42501';
  END IF;

  SELECT binding.* INTO existing
  FROM app.property_predator_zernio_publish_bindings AS binding
  WHERE binding.workspace_id = p_workspace_id AND binding.id = p_binding_id;
  IF FOUND THEN
    IF existing.provider_connection_id <> p_provider_connection_id
       OR existing.zernio_account_id <> p_zernio_account_id
       OR existing.provider_id <> 'zernio' OR existing.network <> p_network
       OR existing.provider_profile_id_sha256 <> p_provider_profile_id_sha256
       OR existing.provider_account_id_sha256 <> p_provider_account_id_sha256
       OR existing.publish_capability_evidence_sha256 <> p_publish_capability_evidence_sha256
       OR existing.ownership_evidence_sha256 <> p_ownership_evidence_sha256
       OR existing.verified_at <> p_verified_at THEN
      RAISE EXCEPTION 'Zernio calendar publish binding conflict' USING ERRCODE = '40001';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM app.property_predator_zernio_publish_binding_revocations AS revocation
      WHERE revocation.workspace_id = existing.workspace_id
        AND revocation.binding_id = existing.id
    ) THEN
      RAISE EXCEPTION 'Zernio calendar publish binding is revoked'
        USING ERRCODE = '40001';
    END IF;
    RETURN existing.id;
  END IF;

  IF EXISTS (
    SELECT 1 FROM app.property_predator_zernio_publish_bindings AS binding
    WHERE binding.workspace_id = p_workspace_id
      AND binding.provider_connection_id = p_provider_connection_id
      AND binding.zernio_account_id = p_zernio_account_id
      AND binding.network = p_network
      AND NOT EXISTS (
        SELECT 1 FROM app.property_predator_zernio_publish_binding_revocations AS revocation
        WHERE revocation.workspace_id = binding.workspace_id
          AND revocation.binding_id = binding.id
      )
  ) THEN
    RAISE EXCEPTION 'Zernio calendar account already has an active binding'
      USING ERRCODE = '40001';
  END IF;

  INSERT INTO app.property_predator_zernio_publish_bindings (
    id, workspace_id, provider_connection_id, zernio_account_id,
    environment, provider_id, network, provider_profile_id_sha256,
    provider_account_id_sha256, publish_capability_evidence_sha256,
    ownership_evidence_sha256, verified_at, created_by_user_id
  ) VALUES (
    p_binding_id, p_workspace_id, p_provider_connection_id, p_zernio_account_id,
    'live', 'zernio', p_network, p_provider_profile_id_sha256,
    p_provider_account_id_sha256, p_publish_capability_evidence_sha256,
    p_ownership_evidence_sha256, p_verified_at, selected_user
  );
  RETURN p_binding_id;
END
$function$;

CREATE FUNCTION app_private.revoke_zernio_calendar_publish_binding(
  p_workspace_id uuid, p_provider_connection_id uuid, p_binding_id uuid,
  p_revocation_id uuid, p_revocation_evidence_sha256 bytea, p_reason_code text
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE selected_user uuid; existing app.property_predator_zernio_publish_binding_revocations%ROWTYPE;
BEGIN
  IF session_user <> 'r72_zernio_social_command'
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'user'
     OR current_setting('app.user_id', true) !~ '^[0-9a-f-]{36}$'
     OR coalesce(current_setting('app.request_id', true), '') = ''
     OR p_revocation_evidence_sha256 IS NULL
     OR octet_length(p_revocation_evidence_sha256) <> 32
     OR p_reason_code IS NULL
     OR p_reason_code !~ '^[a-z][a-z0-9_.:-]{0,99}$' THEN
    RAISE EXCEPTION 'Zernio calendar binding revocation denied' USING ERRCODE = '42501';
  END IF;
  selected_user := current_setting('app.user_id')::uuid;
  IF NOT EXISTS (
    SELECT 1 FROM app.workspace_memberships AS membership
    WHERE membership.workspace_id = p_workspace_id AND membership.user_id = selected_user
      AND membership.status = 'active' AND membership.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'Zernio calendar binding revocation denied' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'zernio-calendar-publish-binding:' || p_workspace_id::text || ':'
        || p_binding_id::text,
      7200085
    )
  );
  IF NOT EXISTS (
    SELECT 1 FROM app.property_predator_zernio_publish_bindings AS binding
    WHERE binding.workspace_id = p_workspace_id AND binding.id = p_binding_id
      AND binding.provider_connection_id = p_provider_connection_id
      AND binding.provider_id = 'zernio'
  ) THEN
    RAISE EXCEPTION 'Zernio calendar binding revocation denied' USING ERRCODE = '42501';
  END IF;
  SELECT revocation.* INTO existing
  FROM app.property_predator_zernio_publish_binding_revocations AS revocation
  WHERE revocation.workspace_id = p_workspace_id AND revocation.binding_id = p_binding_id;
  IF FOUND THEN
    IF existing.id <> p_revocation_id
       OR existing.provider_connection_id <> p_provider_connection_id
       OR existing.revocation_evidence_sha256 <> p_revocation_evidence_sha256
       OR existing.reason_code <> p_reason_code THEN
      RAISE EXCEPTION 'Zernio calendar binding revocation conflict' USING ERRCODE = '40001';
    END IF;
    RETURN existing.id;
  END IF;
  INSERT INTO app.property_predator_zernio_publish_binding_revocations (
    id, workspace_id, provider_connection_id, binding_id,
    revocation_evidence_sha256, reason_code, revoked_by_user_id
  ) VALUES (
    p_revocation_id, p_workspace_id, p_provider_connection_id, p_binding_id,
    p_revocation_evidence_sha256, p_reason_code, selected_user
  );
  RETURN p_revocation_id;
END
$function$;

CREATE FUNCTION app_private.zernio_calendar_binding_ready(
  p_workspace_id uuid, p_job_id uuid
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM app.property_predator_owned_social_jobs AS job
    JOIN app.property_predator_zernio_publish_bindings AS binding
      ON binding.workspace_id = job.workspace_id
     AND binding.id = job.zernio_publish_binding_id
     AND binding.provider_connection_id = job.provider_connection_id
     AND binding.provider_id = job.provider_id
     AND binding.network = job.network
     AND binding.zernio_account_id = job.zernio_account_id
    JOIN app.property_predator_zernio_accounts AS account
      ON account.workspace_id = binding.workspace_id
     AND account.id = binding.zernio_account_id
     AND account.provider_connection_id = binding.provider_connection_id
     AND account.provider_profile_id_sha256 = binding.provider_profile_id_sha256
     AND account.provider_account_id_sha256 = binding.provider_account_id_sha256
     AND account.network = binding.network
    JOIN app.provider_connections AS connection
      ON connection.workspace_id = binding.workspace_id
     AND connection.id = binding.provider_connection_id
     AND connection.environment = binding.environment
    WHERE job.workspace_id = p_workspace_id AND job.id = p_job_id
      AND job.provider_id = 'zernio' AND job.profile_id IS NULL
      AND account.status = 'active'
      AND connection.provider_id = 'zernio' AND connection.provider_kind = 'social'
      AND connection.environment = 'live' AND connection.status = 'active'
      AND EXISTS (
        SELECT 1
        FROM app.property_predator_zernio_account_webhook_receipts AS connected_receipt
        WHERE connected_receipt.workspace_id = binding.workspace_id
          AND connected_receipt.provider_connection_id = binding.provider_connection_id
          AND connected_receipt.event_type = 'account.connected'
          AND connected_receipt.network = binding.network
          AND connected_receipt.provider_profile_id_sha256 = binding.provider_profile_id_sha256
          AND connected_receipt.provider_account_id_sha256 = binding.provider_account_id_sha256
          AND connected_receipt.receipt_sha256 = binding.ownership_evidence_sha256
          AND NOT EXISTS (
            SELECT 1
            FROM app.property_predator_zernio_account_webhook_receipts AS disconnected_receipt
            WHERE disconnected_receipt.workspace_id = connected_receipt.workspace_id
              AND disconnected_receipt.provider_connection_id = connected_receipt.provider_connection_id
              AND disconnected_receipt.event_type = 'account.disconnected'
              AND disconnected_receipt.network = connected_receipt.network
              AND disconnected_receipt.provider_profile_id_sha256 = connected_receipt.provider_profile_id_sha256
              AND disconnected_receipt.provider_account_id_sha256 = connected_receipt.provider_account_id_sha256
              AND disconnected_receipt.occurred_at >= connected_receipt.occurred_at
          )
      )
      AND NOT EXISTS (
        SELECT 1 FROM app.property_predator_zernio_publish_binding_revocations AS revocation
        WHERE revocation.workspace_id = binding.workspace_id
          AND revocation.binding_id = binding.id
      )
  );
$function$;

CREATE FUNCTION app_private.zernio_calendar_job_effect_ready(
  p_workspace_id uuid, p_job_id uuid
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $function$
  SELECT app_private.owned_social_job_effect_ready_v2(p_workspace_id, p_job_id)
    AND app_private.zernio_calendar_binding_ready(p_workspace_id, p_job_id)
    AND EXISTS (
      SELECT 1
      FROM app.property_predator_owned_social_jobs AS job
      JOIN app.property_predator_zernio_publish_bindings AS binding
        ON binding.workspace_id = job.workspace_id
       AND binding.id = job.zernio_publish_binding_id
      JOIN app.public_social_planning_intent_targets AS target
        ON target.workspace_id = job.workspace_id
       AND target.intent_id = job.planning_intent_id
       AND target.target_id = job.planning_target_id
       AND target.network = job.network
       AND target.account_ref_sha256 = binding.provider_account_id_sha256
      WHERE job.workspace_id = p_workspace_id AND job.id = p_job_id
        AND job.provider_id = 'zernio'
    );
$function$;

CREATE FUNCTION app_private.claim_zernio_calendar_job(
  p_workspace_id uuid, p_provider_connection_id uuid, p_networks text[],
  p_lease_token bytea, p_lease_seconds integer
) RETURNS TABLE(
  job_id uuid, binding_id uuid, zernio_account_id uuid,
  lease_version bigint, attempt_kind text, network text
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE selected app.property_predator_owned_social_jobs%ROWTYPE; selected_kind text;
  next_version bigint; recovered app.property_predator_owned_social_jobs%ROWTYPE;
BEGIN
  IF session_user <> 'r72_owned_social_worker_command'
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'worker'
     OR coalesce(current_setting('app.user_id', true), '') <> ''
     OR coalesce(current_setting('app.request_id', true), '') = ''
     OR p_networks IS NULL OR cardinality(p_networks) NOT BETWEEN 1 AND 2
     OR NOT (p_networks <@ ARRAY['instagram', 'linkedin']::text[])
     OR (SELECT count(DISTINCT requested.network_name)
           FROM unnest(p_networks) AS requested(network_name))
          <> cardinality(p_networks)
     OR p_lease_token IS NULL OR octet_length(p_lease_token) <> 32
     OR p_lease_seconds NOT BETWEEN 30 AND 300 THEN
    RAISE EXCEPTION 'Zernio calendar claim denied' USING ERRCODE = '42501';
  END IF;

  FOR recovered IN
    SELECT job.* FROM app.property_predator_owned_social_jobs AS job
    WHERE job.workspace_id = p_workspace_id
      AND job.provider_id = 'zernio'
      AND job.provider_connection_id = p_provider_connection_id
      AND job.network = ANY(p_networks)
      AND job.state IN ('leased', 'calling')
      AND job.lease_expires_at <= statement_timestamp()
    ORDER BY job.lease_expires_at, job.id
    FOR UPDATE SKIP LOCKED
  LOOP
    IF recovered.state = 'calling' THEN
      INSERT INTO app.property_predator_owned_social_receipts (
        workspace_id, job_id, lease_version, provider_id, attempt_kind, event_kind,
        provider_external_id, receipt_sha256, safe_code, provider_occurred_at
      ) VALUES (
        recovered.workspace_id, recovered.id, recovered.lease_version,
        'zernio', recovered.lease_attempt_kind, 'outcome_unknown',
        recovered.provider_external_id,
        public.digest(
          format('zernio_worker_call_lease_expired:%s:%s',
            recovered.id, recovered.lease_version),
          'sha256'
        ),
        'zernio_worker_call_lease_expired_unknown', statement_timestamp()
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
    WHERE workspace_id = recovered.workspace_id AND id = recovered.id
      AND provider_id = 'zernio';
    DELETE FROM app.property_predator_owned_social_job_leases
    WHERE workspace_id = recovered.workspace_id AND job_id = recovered.id;
  END LOOP;

  UPDATE app.property_predator_owned_social_jobs AS job SET
    state = 'cancelled', next_reconcile_at = NULL,
    settled_at = statement_timestamp(), updated_at = statement_timestamp()
  WHERE job.workspace_id = p_workspace_id AND job.provider_id = 'zernio'
    AND job.provider_connection_id = p_provider_connection_id
    AND job.network = ANY(p_networks) AND job.state = 'queued'
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

  UPDATE app.property_predator_owned_social_jobs AS job SET
    state = 'needs_attention', next_reconcile_at = NULL,
    settled_at = statement_timestamp(), updated_at = statement_timestamp()
  WHERE job.workspace_id = p_workspace_id AND job.provider_id = 'zernio'
    AND job.provider_connection_id = p_provider_connection_id
    AND job.network = ANY(p_networks) AND job.state = 'queued'
    AND job.available_at <= statement_timestamp() - interval '5 minutes'
    AND NOT app_private.zernio_calendar_job_effect_ready(job.workspace_id, job.id);

  UPDATE app.property_predator_owned_social_jobs AS job SET
    state = 'needs_attention', next_reconcile_at = NULL,
    settled_at = statement_timestamp(), updated_at = statement_timestamp()
  WHERE job.workspace_id = p_workspace_id AND job.provider_id = 'zernio'
    AND job.provider_connection_id = p_provider_connection_id
    AND job.network = ANY(p_networks)
    AND ((job.state = 'queued' AND job.available_at <= statement_timestamp())
      OR (job.state = 'reconciliation_pending'
        AND job.next_reconcile_at <= statement_timestamp()))
    AND (
      (job.state = 'queued'
        AND job.utc_day <> (statement_timestamp() AT TIME ZONE 'UTC')::date)
      OR NOT app_private.zernio_calendar_binding_ready(job.workspace_id, job.id)
    );

  UPDATE app.property_predator_owned_social_jobs AS job SET
    state = 'needs_attention', next_reconcile_at = NULL,
    settled_at = statement_timestamp(), updated_at = statement_timestamp()
  WHERE job.workspace_id = p_workspace_id AND job.provider_id = 'zernio'
    AND job.provider_connection_id = p_provider_connection_id
    AND job.network = ANY(p_networks)
    AND ((job.state = 'queued' AND job.available_at <= statement_timestamp())
      OR (job.state = 'reconciliation_pending'
        AND job.next_reconcile_at <= statement_timestamp()))
    AND job.claim_count >= 12;

  SELECT job.* INTO selected FROM app.property_predator_owned_social_jobs AS job
  WHERE job.workspace_id = p_workspace_id AND job.provider_id = 'zernio'
    AND job.provider_connection_id = p_provider_connection_id
    AND job.network = ANY(p_networks)
    AND ((job.state = 'queued' AND job.available_at <= statement_timestamp())
      OR (job.state = 'reconciliation_pending'
        AND job.next_reconcile_at <= statement_timestamp()))
    AND job.claim_count < 12
    AND (job.state = 'reconciliation_pending'
      OR app_private.zernio_calendar_job_effect_ready(job.workspace_id, job.id))
    AND app_private.zernio_calendar_binding_ready(job.workspace_id, job.id)
  ORDER BY CASE WHEN job.state = 'reconciliation_pending' THEN 0 ELSE 1 END,
    coalesce(job.next_reconcile_at, job.available_at), job.created_at
  LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN; END IF;
  selected_kind := CASE WHEN selected.state = 'queued' THEN 'publish' ELSE 'reconcile' END;
  next_version := selected.lease_version + 1;
  UPDATE app.property_predator_owned_social_jobs SET
    state = 'leased', lease_version = next_version,
    lease_attempt_kind = selected_kind,
    lease_expires_at = statement_timestamp() + make_interval(secs => p_lease_seconds),
    claim_count = claim_count + 1, leased_at = statement_timestamp(),
    next_reconcile_at = NULL, updated_at = statement_timestamp()
  WHERE workspace_id = p_workspace_id AND id = selected.id
    AND provider_id = 'zernio';
  INSERT INTO app.property_predator_owned_social_job_leases
    (workspace_id, job_id, lease_version, lease_token_sha256)
  VALUES (
    p_workspace_id, selected.id, next_version,
    public.digest(p_lease_token, 'sha256')
  ) ON CONFLICT (workspace_id, job_id) DO UPDATE SET
    lease_version = EXCLUDED.lease_version,
    lease_token_sha256 = EXCLUDED.lease_token_sha256,
    issued_at = statement_timestamp();
  RETURN QUERY SELECT selected.id, selected.zernio_publish_binding_id,
    selected.zernio_account_id, next_version, selected_kind, selected.network;
END
$function$;

CREATE FUNCTION app_private.begin_zernio_calendar_call(
  p_workspace_id uuid, p_job_id uuid, p_lease_version bigint,
  p_lease_token bytea, p_provider_effects_enabled boolean,
  p_emergency_paused boolean
) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE changed integer; selected record; locked_content_item uuid;
BEGIN
  IF session_user <> 'r72_owned_social_worker_command'
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'worker'
     OR coalesce(current_setting('app.user_id', true), '') <> ''
     OR coalesce(current_setting('app.request_id', true), '') = ''
     OR p_lease_token IS NULL OR octet_length(p_lease_token) <> 32
     OR p_provider_effects_enabled IS DISTINCT FROM true
     OR p_emergency_paused IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'Zernio calendar begin-call denied' USING ERRCODE = '42501';
  END IF;

  SELECT job.planning_intent_id, job.planning_target_id, job.lease_attempt_kind,
    job.zernio_publish_binding_id, job.zernio_account_id, job.network
    INTO selected
  FROM app.property_predator_owned_social_jobs AS job
  JOIN app.property_predator_owned_social_job_leases AS lease
    ON lease.workspace_id = job.workspace_id AND lease.job_id = job.id
   AND lease.lease_version = job.lease_version
   AND lease.lease_token_sha256 = public.digest(p_lease_token, 'sha256')
  WHERE job.workspace_id = p_workspace_id AND job.id = p_job_id
    AND job.provider_id = 'zernio' AND job.profile_id IS NULL
    AND job.state = 'leased' AND job.lease_version = p_lease_version
    AND job.lease_expires_at > statement_timestamp();
  IF NOT FOUND THEN RETURN false; END IF;

  IF selected.lease_attempt_kind = 'publish' THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'public-social-planning-target:' || p_workspace_id::text || ':'
          || selected.planning_intent_id::text || ':'
          || selected.planning_target_id::text,
        7200040
      )
    );
  END IF;

  FOR locked_content_item IN
    SELECT content_identity.content_item_id
    FROM (
      SELECT job.content_item_id
      FROM app.property_predator_owned_social_jobs AS job
      WHERE job.workspace_id = p_workspace_id AND job.id = p_job_id
        AND job.provider_id = 'zernio'
      UNION
      SELECT media.content_item_id
      FROM app.property_predator_owned_social_job_media AS media
      JOIN app.property_predator_owned_social_jobs AS job
        ON job.workspace_id = media.workspace_id AND job.id = media.job_id
      WHERE media.workspace_id = p_workspace_id AND media.job_id = p_job_id
        AND job.provider_id = 'zernio'
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

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'zernio-calendar-publish-binding:' || p_workspace_id::text || ':'
        || selected.zernio_publish_binding_id::text,
      7200085
    )
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'zernio-calendar-publish-account:' || p_workspace_id::text || ':'
        || selected.zernio_account_id::text || ':' || selected.network,
      7200085
    )
  );

  SELECT job.planning_intent_id, job.planning_target_id,
    job.lease_attempt_kind, job.zernio_publish_binding_id,
    job.zernio_account_id, job.provider_connection_id, job.network
    INTO selected
  FROM app.property_predator_owned_social_jobs AS job
  JOIN app.property_predator_owned_social_job_leases AS lease
    ON lease.workspace_id = job.workspace_id AND lease.job_id = job.id
   AND lease.lease_version = job.lease_version
   AND lease.lease_token_sha256 = public.digest(p_lease_token, 'sha256')
  WHERE job.workspace_id = p_workspace_id AND job.id = p_job_id
    AND job.provider_id = 'zernio' AND job.profile_id IS NULL
    AND job.state = 'leased' AND job.lease_version = p_lease_version
    AND job.lease_expires_at > statement_timestamp()
  FOR UPDATE OF job;
  IF NOT FOUND THEN RETURN false; END IF;

  -- Freeze the exact provider connection, immutable binding and current active
  -- account status across the provider-call transition.
  PERFORM binding.id
  FROM app.property_predator_zernio_publish_bindings AS binding
  JOIN app.property_predator_zernio_accounts AS account
    ON account.workspace_id = binding.workspace_id
   AND account.id = binding.zernio_account_id
   AND account.provider_connection_id = binding.provider_connection_id
   AND account.provider_profile_id_sha256 = binding.provider_profile_id_sha256
   AND account.provider_account_id_sha256 = binding.provider_account_id_sha256
   AND account.network = binding.network
  JOIN app.provider_connections AS connection
    ON connection.workspace_id = binding.workspace_id
   AND connection.id = binding.provider_connection_id
   AND connection.environment = binding.environment
  WHERE binding.workspace_id = p_workspace_id
    AND binding.id = selected.zernio_publish_binding_id
    AND binding.zernio_account_id = selected.zernio_account_id
    AND binding.provider_connection_id = selected.provider_connection_id
    AND binding.provider_id = 'zernio' AND binding.network = selected.network
    AND account.status = 'active'
    AND connection.provider_id = 'zernio' AND connection.provider_kind = 'social'
    AND connection.environment = 'live' AND connection.status = 'active'
    AND NOT EXISTS (
      SELECT 1 FROM app.property_predator_zernio_publish_binding_revocations AS revocation
      WHERE revocation.workspace_id = binding.workspace_id
        AND revocation.binding_id = binding.id
    )
  ;
  IF NOT FOUND THEN RETURN false; END IF;

  UPDATE app.property_predator_owned_social_jobs AS job SET
    state = 'calling', calling_at = statement_timestamp(),
    updated_at = statement_timestamp()
  FROM app.property_predator_owned_social_job_leases AS lease
  WHERE job.workspace_id = p_workspace_id AND job.id = p_job_id
    AND job.provider_id = 'zernio' AND job.profile_id IS NULL
    AND job.state = 'leased' AND job.lease_version = p_lease_version
    AND job.lease_expires_at > statement_timestamp()
    AND lease.workspace_id = job.workspace_id AND lease.job_id = job.id
    AND lease.lease_version = job.lease_version
    AND lease.lease_token_sha256 = public.digest(p_lease_token, 'sha256')
    AND app_private.zernio_calendar_binding_ready(job.workspace_id, job.id)
    AND (job.lease_attempt_kind = 'reconcile' OR (
      app_private.zernio_calendar_job_effect_ready(job.workspace_id, job.id)
      AND job.utc_day = (statement_timestamp() AT TIME ZONE 'UTC')::date
      AND job.utc_month = date_trunc('month', statement_timestamp() AT TIME ZONE 'UTC')::date
      AND (SELECT count(*) FROM app.property_predator_owned_social_jobs AS capped_day
        WHERE capped_day.workspace_id = job.workspace_id
          AND capped_day.provider_id = 'zernio'
          AND capped_day.zernio_account_id = job.zernio_account_id
          AND capped_day.network = job.network
          AND capped_day.utc_day = job.utc_day
          AND capped_day.state <> 'cancelled') <= 1
      AND (SELECT count(*) FROM app.property_predator_owned_social_jobs AS capped_month
        WHERE capped_month.workspace_id = job.workspace_id
          AND capped_month.provider_id = 'zernio'
          AND capped_month.zernio_account_id = job.zernio_account_id
          AND capped_month.network = job.network
          AND capped_month.utc_month = job.utc_month
          AND capped_month.state <> 'cancelled') <= 3
    ));
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END
$function$;

CREATE FUNCTION app_private.load_zernio_calendar_job(
  p_workspace_id uuid, p_job_id uuid, p_lease_version bigint,
  p_lease_token bytea
) RETURNS TABLE(
  provider_connection_id uuid, binding_id uuid, zernio_account_id uuid,
  provider_profile_id_sha256 bytea, provider_account_id_sha256 bytea,
  attempt_kind text, operation_tag text, idempotency_key text,
  text_body text, text_sha256 bytea, scheduled_for timestamptz,
  provider_external_id text, network text, media jsonb
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $function$
  SELECT job.provider_connection_id, binding.id, account.id,
    binding.provider_profile_id_sha256, binding.provider_account_id_sha256,
    job.lease_attempt_kind, job.operation_tag,
    encode(job.idempotency_key_sha256, 'hex'), job.text_body,
    job.text_sha256, job.scheduled_for, job.provider_external_id, job.network,
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'storageKey', media_row.blob_storage_key,
        'blobSha256', encode(media_row.blob_sha256, 'hex'),
        'mimeType', media_row.content_mime_type
      ) ORDER BY media_row.ordinal)
      FROM app.property_predator_owned_social_job_media AS media_row
      WHERE media_row.workspace_id = job.workspace_id
        AND media_row.job_id = job.id
    ), '[]'::jsonb)
  FROM app.property_predator_owned_social_jobs AS job
  JOIN app.property_predator_owned_social_job_leases AS lease
    ON lease.workspace_id = job.workspace_id AND lease.job_id = job.id
   AND lease.lease_version = job.lease_version
   AND lease.lease_token_sha256 = public.digest(p_lease_token, 'sha256')
  JOIN app.property_predator_zernio_publish_bindings AS binding
    ON binding.workspace_id = job.workspace_id
   AND binding.id = job.zernio_publish_binding_id
   AND binding.provider_connection_id = job.provider_connection_id
   AND binding.provider_id = job.provider_id
   AND binding.network = job.network
   AND binding.zernio_account_id = job.zernio_account_id
  JOIN app.property_predator_zernio_accounts AS account
    ON account.workspace_id = binding.workspace_id
   AND account.id = binding.zernio_account_id
   AND account.provider_connection_id = binding.provider_connection_id
   AND account.provider_profile_id_sha256 = binding.provider_profile_id_sha256
   AND account.provider_account_id_sha256 = binding.provider_account_id_sha256
   AND account.network = binding.network AND account.status = 'active'
  JOIN app.provider_connections AS connection
    ON connection.workspace_id = binding.workspace_id
   AND connection.id = binding.provider_connection_id
   AND connection.environment = binding.environment
   AND connection.provider_id = 'zernio' AND connection.provider_kind = 'social'
   AND connection.status = 'active'
  WHERE session_user = 'r72_owned_social_worker_command'
    AND current_setting('app.workspace_id', true) = p_workspace_id::text
    AND current_setting('app.actor_kind', true) = 'worker'
    AND coalesce(current_setting('app.user_id', true), '') = ''
    AND coalesce(current_setting('app.request_id', true), '') <> ''
    AND job.workspace_id = p_workspace_id AND job.id = p_job_id
    AND job.provider_id = 'zernio' AND job.profile_id IS NULL
    AND job.state = 'leased' AND job.lease_version = p_lease_version
    AND job.lease_expires_at > statement_timestamp()
    AND NOT EXISTS (
      SELECT 1 FROM app.property_predator_zernio_publish_binding_revocations AS revocation
      WHERE revocation.workspace_id = binding.workspace_id
        AND revocation.binding_id = binding.id
    );
$function$;

CREATE FUNCTION app_private.settle_zernio_calendar_call(
  p_workspace_id uuid, p_job_id uuid, p_lease_version bigint,
  p_lease_token bytea, p_result_state text, p_provider_external_id text,
  p_receipt_sha256 bytea, p_provider_occurred_at timestamptz,
  p_safe_code text
) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE selected app.property_predator_owned_social_jobs%ROWTYPE;
  existing_receipt app.property_predator_owned_social_receipts%ROWTYPE;
  next_state text; next_at timestamptz;
BEGIN
  IF session_user <> 'r72_owned_social_worker_command'
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'worker'
     OR coalesce(current_setting('app.user_id', true), '') <> ''
     OR coalesce(current_setting('app.request_id', true), '') = ''
     OR p_lease_token IS NULL OR octet_length(p_lease_token) <> 32
     OR p_result_state IS NULL
     OR p_result_state NOT IN ('accepted', 'published', 'failed', 'outcome_unknown')
     OR (p_result_state IN ('accepted', 'published') AND p_provider_external_id IS NULL)
     OR (p_provider_external_id IS NOT NULL
       AND p_provider_external_id !~ '^[A-Za-z0-9_-]{1,200}$')
     OR p_receipt_sha256 IS NULL OR octet_length(p_receipt_sha256) <> 32
     OR p_provider_occurred_at IS NULL
     OR p_provider_occurred_at > statement_timestamp() + interval '5 minutes'
     OR p_safe_code IS NULL
     OR p_safe_code !~ '^[a-z][a-z0-9_.:-]{0,99}$' THEN
    RAISE EXCEPTION 'Zernio calendar settle denied' USING ERRCODE = '42501';
  END IF;
  SELECT receipt.* INTO existing_receipt
  FROM app.property_predator_owned_social_receipts AS receipt
  JOIN app.property_predator_owned_social_jobs AS job
    ON job.workspace_id = receipt.workspace_id AND job.id = receipt.job_id
  WHERE receipt.workspace_id = p_workspace_id AND receipt.job_id = p_job_id
    AND receipt.lease_version = p_lease_version
    AND receipt.provider_id = 'zernio' AND job.provider_id = 'zernio';
  IF FOUND THEN
    IF existing_receipt.event_kind <> p_result_state
       OR existing_receipt.provider_external_id IS DISTINCT FROM p_provider_external_id
       OR existing_receipt.receipt_sha256 <> p_receipt_sha256
       OR existing_receipt.provider_occurred_at <> p_provider_occurred_at
       OR existing_receipt.safe_code <> p_safe_code
       OR existing_receipt.lease_token_sha256 IS NULL
       OR existing_receipt.lease_token_sha256 <> public.digest(p_lease_token, 'sha256') THEN
      RAISE EXCEPTION 'Zernio calendar settlement replay conflict'
        USING ERRCODE = '40001';
    END IF;
    RETURN 'replayed';
  END IF;
  SELECT job.* INTO selected
  FROM app.property_predator_owned_social_jobs AS job
  JOIN app.property_predator_owned_social_job_leases AS lease
    ON lease.workspace_id = job.workspace_id AND lease.job_id = job.id
   AND lease.lease_version = job.lease_version
   AND lease.lease_token_sha256 = public.digest(p_lease_token, 'sha256')
  WHERE job.workspace_id = p_workspace_id AND job.id = p_job_id
    AND job.provider_id = 'zernio' AND job.profile_id IS NULL
    AND job.zernio_publish_binding_id IS NOT NULL
    AND job.zernio_account_id IS NOT NULL
    AND job.state = 'calling' AND job.lease_version = p_lease_version
  FOR UPDATE OF job;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Zernio calendar settle lease lost' USING ERRCODE = '40001';
  END IF;
  IF p_result_state = 'accepted' AND selected.lease_attempt_kind = 'reconcile'
     AND selected.reconcile_count >= 7 THEN
    next_state := 'needs_attention'; next_at := NULL;
  ELSIF p_result_state = 'accepted' THEN
    next_state := 'reconciliation_pending';
    next_at := statement_timestamp() + interval '60 seconds';
  ELSIF p_result_state = 'published' THEN
    next_state := 'succeeded'; next_at := NULL;
  ELSIF p_result_state = 'failed' THEN
    next_state := 'failed'; next_at := NULL;
  ELSE
    next_state := 'needs_attention'; next_at := NULL;
  END IF;
  INSERT INTO app.property_predator_owned_social_receipts (
    workspace_id, job_id, lease_version, provider_id, attempt_kind, event_kind,
    provider_external_id, receipt_sha256, safe_code, provider_occurred_at,
    lease_token_sha256
  ) VALUES (
    p_workspace_id, p_job_id, p_lease_version, 'zernio',
    selected.lease_attempt_kind,
    p_result_state, p_provider_external_id, p_receipt_sha256, p_safe_code,
    p_provider_occurred_at, public.digest(p_lease_token, 'sha256')
  );
  UPDATE app.property_predator_owned_social_jobs SET
    state = next_state, lease_expires_at = NULL, lease_attempt_kind = NULL,
    provider_external_id = coalesce(p_provider_external_id, provider_external_id),
    next_reconcile_at = next_at,
    reconcile_count = reconcile_count
      + CASE WHEN selected.lease_attempt_kind = 'reconcile' THEN 1 ELSE 0 END,
    settled_at = CASE WHEN next_state IN ('succeeded', 'failed', 'needs_attention')
      THEN statement_timestamp() ELSE NULL END,
    updated_at = statement_timestamp()
  WHERE workspace_id = p_workspace_id AND id = p_job_id
    AND provider_id = 'zernio';
  DELETE FROM app.property_predator_owned_social_job_leases
  WHERE workspace_id = p_workspace_id AND job_id = p_job_id;
  RETURN 'recorded';
END
$function$;

REVOKE ALL ON FUNCTION app_private.record_zernio_calendar_publish_binding(
  uuid, uuid, uuid, uuid, text, bytea, bytea, bytea, bytea, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.revoke_zernio_calendar_publish_binding(
  uuid, uuid, uuid, uuid, bytea, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.enqueue_zernio_calendar_job(
  uuid, uuid, uuid, uuid, text, bytea, bytea, uuid, uuid, uuid, uuid,
  uuid, uuid, uuid, text, bytea, bytea, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.zernio_calendar_binding_ready(uuid, uuid)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.zernio_calendar_job_effect_ready(uuid, uuid)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.claim_zernio_calendar_job(
  uuid, uuid, text[], bytea, integer
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.begin_zernio_calendar_call(
  uuid, uuid, bigint, bytea, boolean, boolean
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.load_zernio_calendar_job(
  uuid, uuid, bigint, bytea
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.settle_zernio_calendar_call(
  uuid, uuid, bigint, bytea, text, text, bytea, timestamptz, text
) FROM PUBLIC;

-- Ayrshare is deliberately deferred. Its immutable profiles, jobs and
-- receipts remain untouched, but the old shared-login command surfaces must
-- not be callable alongside the Zernio-qualified surface: those historical
-- functions predate provider_id and could otherwise mutate or settle a Zernio
-- row while recording an Ayrshare-defaulted receipt. A future provider-
-- isolation migration may re-enable Ayrshare after adding exact provider
-- fences (or a dedicated worker login) to every historical mutable function.
REVOKE EXECUTE ON FUNCTION app_private.record_owned_social_profile(
  uuid, uuid, uuid, text, bytea, bytea, text, bytea, bytea, bytea,
  bytea, bytea, bytea, timestamptz, timestamptz
) FROM r72_owned_social_command;
REVOKE EXECUTE ON FUNCTION app_private.revoke_owned_social_profile(
  uuid, uuid, uuid, bytea, text
) FROM r72_owned_social_command;
REVOKE EXECUTE ON FUNCTION app_private.enqueue_owned_social_job(
  uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, bytea, bytea,
  timestamptz
) FROM r72_owned_social_command;
REVOKE EXECUTE ON FUNCTION app_private.record_owned_social_profile_v2(
  uuid, uuid, uuid, text, text, bytea, bytea, text, bytea, bytea, bytea,
  bytea, bytea, bytea, timestamptz, timestamptz
) FROM r72_owned_social_command;
REVOKE EXECUTE ON FUNCTION app_private.enqueue_owned_social_job_v2(
  uuid, uuid, uuid, text, bytea, uuid, uuid, uuid, uuid, uuid, uuid, uuid,
  text, bytea, bytea, timestamptz
) FROM r72_owned_social_command;
REVOKE EXECUTE ON FUNCTION app_private.claim_owned_social_job(
  uuid, uuid, bytea, integer
) FROM r72_owned_social_worker_command;
REVOKE EXECUTE ON FUNCTION app_private.begin_owned_social_call(
  uuid, uuid, bigint, bytea, boolean, boolean
) FROM r72_owned_social_worker_command;
REVOKE EXECUTE ON FUNCTION app_private.load_owned_social_job(
  uuid, uuid, bigint, bytea
) FROM r72_owned_social_worker_command;
REVOKE EXECUTE ON FUNCTION app_private.claim_owned_social_job_v2(
  uuid, uuid, text[], bytea, integer
) FROM r72_owned_social_worker_command;
REVOKE EXECUTE ON FUNCTION app_private.begin_owned_social_call_v2(
  uuid, uuid, bigint, bytea, boolean, boolean
) FROM r72_owned_social_worker_command;
REVOKE EXECUTE ON FUNCTION app_private.load_owned_social_job_v2(
  uuid, uuid, bigint, bytea
) FROM r72_owned_social_worker_command;
REVOKE EXECUTE ON FUNCTION app_private.settle_owned_social_call(
  uuid, uuid, bigint, bytea, text, text, bytea, timestamptz, text
) FROM r72_owned_social_worker_command;

GRANT EXECUTE ON FUNCTION app_private.record_zernio_calendar_publish_binding(
  uuid, uuid, uuid, uuid, text, bytea, bytea, bytea, bytea, timestamptz
) TO r72_zernio_social_command;
GRANT EXECUTE ON FUNCTION app_private.revoke_zernio_calendar_publish_binding(
  uuid, uuid, uuid, uuid, bytea, text
) TO r72_zernio_social_command;
GRANT EXECUTE ON FUNCTION app_private.enqueue_zernio_calendar_job(
  uuid, uuid, uuid, uuid, text, bytea, bytea, uuid, uuid, uuid, uuid,
  uuid, uuid, uuid, text, bytea, bytea, timestamptz
) TO r72_zernio_social_command;
GRANT EXECUTE ON FUNCTION app_private.claim_zernio_calendar_job(
  uuid, uuid, text[], bytea, integer
) TO r72_owned_social_worker_command;
GRANT EXECUTE ON FUNCTION app_private.begin_zernio_calendar_call(
  uuid, uuid, bigint, bytea, boolean, boolean
) TO r72_owned_social_worker_command;
GRANT EXECUTE ON FUNCTION app_private.load_zernio_calendar_job(
  uuid, uuid, bigint, bytea
) TO r72_owned_social_worker_command;
GRANT EXECUTE ON FUNCTION app_private.settle_zernio_calendar_call(
  uuid, uuid, bigint, bytea, text, text, bytea, timestamptz, text
) TO r72_owned_social_worker_command;

RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_owned_social_definer;

DO $capability_audit$
DECLARE unsafe_object text; unexpected_function text;
BEGIN
  SELECT pg_catalog.format('%I.%I', namespace.nspname, relation.relname)
    INTO unsafe_object
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname IN ('app', 'app_private')
    AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND (
      pg_catalog.has_table_privilege(
        'r72_zernio_social_command', relation.oid, 'SELECT'
      )
      OR pg_catalog.has_table_privilege(
        'r72_zernio_social_command', relation.oid, 'INSERT'
      )
      OR pg_catalog.has_table_privilege(
        'r72_zernio_social_command', relation.oid, 'UPDATE'
      )
      OR pg_catalog.has_table_privilege(
        'r72_zernio_social_command', relation.oid, 'DELETE'
      )
      OR pg_catalog.has_table_privilege(
        'r72_zernio_social_command', relation.oid, 'TRUNCATE'
      )
      OR pg_catalog.has_table_privilege(
        'r72_owned_social_worker_command', relation.oid, 'SELECT'
      )
      OR pg_catalog.has_table_privilege(
        'r72_owned_social_worker_command', relation.oid, 'INSERT'
      )
      OR pg_catalog.has_table_privilege(
        'r72_owned_social_worker_command', relation.oid, 'UPDATE'
      )
      OR pg_catalog.has_table_privilege(
        'r72_owned_social_worker_command', relation.oid, 'DELETE'
      )
      OR pg_catalog.has_table_privilege(
        'r72_owned_social_worker_command', relation.oid, 'TRUNCATE'
      )
    )
  LIMIT 1;
  IF unsafe_object IS NOT NULL THEN
    RAISE EXCEPTION 'Zernio calendar login role has direct table capability: %',
      unsafe_object;
  END IF;

  SELECT procedure.oid::regprocedure::text INTO unexpected_function
  FROM pg_catalog.pg_proc AS procedure
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = procedure.pronamespace
  CROSS JOIN LATERAL pg_catalog.aclexplode(
    coalesce(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))
  ) AS privilege
  WHERE namespace.nspname = 'app_private'
    AND procedure.proname IN (
      'record_zernio_calendar_publish_binding',
      'revoke_zernio_calendar_publish_binding',
      'enqueue_zernio_calendar_job',
      'zernio_calendar_binding_ready',
      'zernio_calendar_job_effect_ready',
      'claim_zernio_calendar_job',
      'begin_zernio_calendar_call',
      'load_zernio_calendar_job',
      'settle_zernio_calendar_call'
    )
    AND privilege.grantee = 0
    AND privilege.privilege_type = 'EXECUTE'
  LIMIT 1;
  IF unexpected_function IS NOT NULL THEN
    RAISE EXCEPTION 'Zernio calendar function remains executable by PUBLIC: %',
      unexpected_function;
  END IF;

  IF NOT pg_catalog.has_function_privilege(
      'r72_zernio_social_command',
      'app_private.record_zernio_calendar_publish_binding(uuid,uuid,uuid,uuid,text,bytea,bytea,bytea,bytea,timestamptz)',
      'EXECUTE'
    )
    OR NOT pg_catalog.has_function_privilege(
      'r72_zernio_social_command',
      'app_private.revoke_zernio_calendar_publish_binding(uuid,uuid,uuid,uuid,bytea,text)',
      'EXECUTE'
    )
    OR NOT pg_catalog.has_function_privilege(
      'r72_zernio_social_command',
      'app_private.enqueue_zernio_calendar_job(uuid,uuid,uuid,uuid,text,bytea,bytea,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,bytea,bytea,timestamptz)',
      'EXECUTE'
    )
    OR pg_catalog.has_function_privilege(
      'r72_zernio_social_command',
      'app_private.claim_zernio_calendar_job(uuid,uuid,text[],bytea,integer)',
      'EXECUTE'
    )
    OR pg_catalog.has_function_privilege(
      'r72_zernio_social_command',
      'app_private.begin_zernio_calendar_call(uuid,uuid,bigint,bytea,boolean,boolean)',
      'EXECUTE'
    )
    OR pg_catalog.has_function_privilege(
      'r72_zernio_social_command',
      'app_private.load_zernio_calendar_job(uuid,uuid,bigint,bytea)',
      'EXECUTE'
    )
    OR pg_catalog.has_function_privilege(
      'r72_zernio_social_command',
      'app_private.settle_zernio_calendar_call(uuid,uuid,bigint,bytea,text,text,bytea,timestamptz,text)',
      'EXECUTE'
    )
    OR pg_catalog.has_function_privilege(
      'r72_zernio_social_command',
      'app_private.zernio_calendar_binding_ready(uuid,uuid)',
      'EXECUTE'
    )
    OR pg_catalog.has_function_privilege(
      'r72_zernio_social_command',
      'app_private.zernio_calendar_job_effect_ready(uuid,uuid)',
      'EXECUTE'
    ) THEN
    RAISE EXCEPTION 'Unsafe Zernio calendar user-command function ACL';
  END IF;

  IF NOT pg_catalog.has_function_privilege(
      'r72_owned_social_worker_command',
      'app_private.claim_zernio_calendar_job(uuid,uuid,text[],bytea,integer)',
      'EXECUTE'
    )
    OR NOT pg_catalog.has_function_privilege(
      'r72_owned_social_worker_command',
      'app_private.begin_zernio_calendar_call(uuid,uuid,bigint,bytea,boolean,boolean)',
      'EXECUTE'
    )
    OR NOT pg_catalog.has_function_privilege(
      'r72_owned_social_worker_command',
      'app_private.load_zernio_calendar_job(uuid,uuid,bigint,bytea)',
      'EXECUTE'
    )
    OR NOT pg_catalog.has_function_privilege(
      'r72_owned_social_worker_command',
      'app_private.settle_zernio_calendar_call(uuid,uuid,bigint,bytea,text,text,bytea,timestamptz,text)',
      'EXECUTE'
    )
    OR pg_catalog.has_function_privilege(
      'r72_owned_social_worker_command',
      'app_private.enqueue_zernio_calendar_job(uuid,uuid,uuid,uuid,text,bytea,bytea,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,bytea,bytea,timestamptz)',
      'EXECUTE'
    )
    OR pg_catalog.has_function_privilege(
      'r72_owned_social_worker_command',
      'app_private.record_zernio_calendar_publish_binding(uuid,uuid,uuid,uuid,text,bytea,bytea,bytea,bytea,timestamptz)',
      'EXECUTE'
    )
    OR pg_catalog.has_function_privilege(
      'r72_owned_social_worker_command',
      'app_private.revoke_zernio_calendar_publish_binding(uuid,uuid,uuid,uuid,bytea,text)',
      'EXECUTE'
    )
    OR pg_catalog.has_function_privilege(
      'r72_owned_social_worker_command',
      'app_private.zernio_calendar_binding_ready(uuid,uuid)',
      'EXECUTE'
    )
    OR pg_catalog.has_function_privilege(
      'r72_owned_social_worker_command',
      'app_private.zernio_calendar_job_effect_ready(uuid,uuid)',
      'EXECUTE'
    )
    OR pg_catalog.has_function_privilege(
      'r72_owned_social_worker_command',
      'app_private.claim_owned_social_job_v2(uuid,uuid,text[],bytea,integer)',
      'EXECUTE'
    )
    OR pg_catalog.has_function_privilege(
      'r72_owned_social_worker_command',
      'app_private.begin_owned_social_call_v2(uuid,uuid,bigint,bytea,boolean,boolean)',
      'EXECUTE'
    )
    OR pg_catalog.has_function_privilege(
      'r72_owned_social_worker_command',
      'app_private.load_owned_social_job_v2(uuid,uuid,bigint,bytea)',
      'EXECUTE'
    )
    OR pg_catalog.has_function_privilege(
      'r72_owned_social_worker_command',
      'app_private.settle_owned_social_call(uuid,uuid,bigint,bytea,text,text,bytea,timestamptz,text)',
      'EXECUTE'
    ) THEN
    RAISE EXCEPTION 'Unsafe Zernio calendar worker function ACL';
  END IF;
END
$capability_audit$;

RESET ROLE;
