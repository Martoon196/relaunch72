-- First owned-profile public-social live-capable persistence boundary.
-- This migration installs no worker, provider secret or runtime composition and
-- cannot publish by itself. All external effects remain behind an explicit
-- worker runtime switch plus an engaged-by-default emergency pause.

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'r72_owned_social_command') THEN
    CREATE ROLE r72_owned_social_command LOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'r72_owned_social_worker_command') THEN
    CREATE ROLE r72_owned_social_worker_command LOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'r72_owned_social_definer') THEN
    CREATE ROLE r72_owned_social_definer NOLOGIN NOINHERIT;
  END IF;
  REVOKE r72_owner, r72_security_definer FROM
    r72_owned_social_command, r72_owned_social_worker_command, r72_owned_social_definer;
  EXECUTE format('GRANT r72_owned_social_definer TO %I', current_user);
END
$roles$;

SET LOCAL ROLE r72_owner;

REVOKE ALL ON SCHEMA app, app_private FROM
  r72_owned_social_command, r72_owned_social_worker_command, r72_owned_social_definer;
REVOKE ALL ON ALL TABLES IN SCHEMA app FROM
  r72_owned_social_command, r72_owned_social_worker_command, r72_owned_social_definer;
REVOKE ALL ON ALL TABLES IN SCHEMA app_private FROM
  r72_owned_social_command, r72_owned_social_worker_command, r72_owned_social_definer;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app_private FROM
  r72_owned_social_command, r72_owned_social_worker_command;
REVOKE CREATE ON SCHEMA public FROM
  r72_owned_social_command, r72_owned_social_worker_command, r72_owned_social_definer;
GRANT USAGE ON SCHEMA app, app_private TO
  r72_owned_social_command, r72_owned_social_worker_command, r72_owned_social_definer;

CREATE TABLE app.property_predator_owned_social_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  provider_connection_id uuid NOT NULL,
  environment text NOT NULL CHECK (environment = 'live'),
  provider_id text NOT NULL CHECK (provider_id = 'ayrshare'),
  network text NOT NULL CHECK (network = 'x'),
  display_name text NOT NULL CHECK (
    display_name = btrim(display_name) AND length(display_name) BETWEEN 1 AND 120
  ),
  provider_profile_ref_sha256 bytea NOT NULL
    CHECK (octet_length(provider_profile_ref_sha256) = 32),
  owned_account_ref_sha256 bytea NOT NULL
    CHECK (octet_length(owned_account_ref_sha256) = 32),
  secret_algorithm text NOT NULL CHECK (secret_algorithm = 'aes-256-gcm-v1'),
  secret_key_version text NOT NULL CHECK (
    secret_key_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  ),
  profile_key_iv bytea NOT NULL CHECK (octet_length(profile_key_iv) = 12),
  profile_key_ciphertext bytea NOT NULL
    CHECK (octet_length(profile_key_ciphertext) BETWEEN 8 AND 1024),
  profile_key_auth_tag bytea NOT NULL CHECK (octet_length(profile_key_auth_tag) = 16),
  profile_key_aad_sha256 bytea NOT NULL CHECK (octet_length(profile_key_aad_sha256) = 32),
  profile_key_sha256 bytea NOT NULL CHECK (octet_length(profile_key_sha256) = 32),
  x_oauth_link_evidence_sha256 bytea NOT NULL
    CHECK (octet_length(x_oauth_link_evidence_sha256) = 32),
  x_oauth_permissions text NOT NULL CHECK (x_oauth_permissions = 'read_write'),
  linked_at timestamptz NOT NULL,
  evidence_observed_at timestamptz NOT NULL,
  created_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, id, provider_connection_id),
  UNIQUE (workspace_id, id, provider_connection_id, environment, network),
  UNIQUE (workspace_id, provider_connection_id, network, provider_profile_ref_sha256),
  FOREIGN KEY (workspace_id, provider_connection_id, environment)
    REFERENCES app.provider_connections (workspace_id, id, environment) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, created_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK (linked_at <= evidence_observed_at + interval '5 minutes')
);

CREATE TABLE app.property_predator_owned_social_profile_revocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  provider_connection_id uuid NOT NULL,
  profile_id uuid NOT NULL,
  revocation_evidence_sha256 bytea NOT NULL
    CHECK (octet_length(revocation_evidence_sha256) = 32),
  reason_code text NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_.:-]{0,99}$'),
  revoked_by_user_id uuid NOT NULL,
  revoked_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, profile_id),
  FOREIGN KEY (workspace_id, profile_id, provider_connection_id)
    REFERENCES app.property_predator_owned_social_profiles
      (workspace_id, id, provider_connection_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, revoked_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT
);

CREATE TABLE app.property_predator_owned_social_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  provider_connection_id uuid NOT NULL,
  profile_id uuid NOT NULL,
  environment text NOT NULL CHECK (environment = 'live'),
  network text NOT NULL CHECK (network = 'x'),
  content_item_id uuid NOT NULL,
  content_version_id uuid NOT NULL,
  content_sha256 bytea NOT NULL CHECK (octet_length(content_sha256) = 32),
  approval_request_id uuid NOT NULL,
  approval_decision_id uuid NOT NULL,
  source_attestation_id uuid NOT NULL,
  operation_tag text NOT NULL CHECK (
    operation_tag ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$'
  ),
  idempotency_key_sha256 bytea NOT NULL CHECK (octet_length(idempotency_key_sha256) = 32),
  request_sha256 bytea NOT NULL CHECK (octet_length(request_sha256) = 32),
  text_body text NOT NULL CHECK (
    octet_length(text_body) BETWEEN 1 AND 16384
    AND length(text_body) BETWEEN 1 AND 280
    AND text_body ~ '^[\r\n -~]+$'
    AND text_body !~* '(//|(^|[^A-Za-z])[A-Za-z][A-Za-z0-9+.-]*:|www[.]|[A-Za-z0-9][A-Za-z0-9-]{0,62}[.][A-Za-z]{2,63})'
  ),
  text_sha256 bytea GENERATED ALWAYS AS (public.digest(text_body, 'sha256')) STORED,
  scheduled_for timestamptz,
  utc_day date NOT NULL,
  utc_month date NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN (
    'queued', 'leased', 'calling', 'reconciliation_pending',
    'succeeded', 'failed', 'needs_attention', 'cancelled'
  )),
  lease_version bigint NOT NULL DEFAULT 0 CHECK (lease_version >= 0),
  lease_attempt_kind text CHECK (lease_attempt_kind IS NULL OR lease_attempt_kind IN ('publish', 'reconcile')),
  lease_expires_at timestamptz,
  claim_count integer NOT NULL DEFAULT 0 CHECK (claim_count BETWEEN 0 AND 12),
  reconcile_count integer NOT NULL DEFAULT 0 CHECK (reconcile_count BETWEEN 0 AND 8),
  provider_external_id text CHECK (
    provider_external_id IS NULL OR provider_external_id ~ '^[A-Za-z0-9_-]{1,200}$'
  ),
  next_reconcile_at timestamptz,
  available_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  created_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  leased_at timestamptz,
  calling_at timestamptz,
  settled_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, idempotency_key_sha256),
  FOREIGN KEY (workspace_id, profile_id, provider_connection_id, environment, network)
    REFERENCES app.property_predator_owned_social_profiles
      (workspace_id, id, provider_connection_id, environment, network) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, content_item_id, content_version_id, content_sha256)
    REFERENCES app.company_content_versions
      (workspace_id, content_item_id, id, content_sha256) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, approval_request_id)
    REFERENCES app.company_content_approval_requests (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, approval_decision_id)
    REFERENCES app.company_content_approval_decisions (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, source_attestation_id)
    REFERENCES app.company_content_source_attestations (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, created_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK (utc_month = date_trunc('month', utc_month)::date),
  CHECK ((state IN ('leased', 'calling')) = (lease_expires_at IS NOT NULL)),
  CHECK ((state IN ('leased', 'calling')) = (lease_attempt_kind IS NOT NULL)),
  CHECK ((state = 'reconciliation_pending') = (next_reconcile_at IS NOT NULL)),
  CHECK ((provider_external_id IS NULL) OR state IN (
    'calling', 'reconciliation_pending', 'succeeded', 'failed', 'needs_attention'
  ))
);

CREATE TABLE app.property_predator_owned_social_job_leases (
  workspace_id uuid NOT NULL,
  job_id uuid NOT NULL,
  lease_version bigint NOT NULL CHECK (lease_version > 0),
  lease_token_sha256 bytea NOT NULL CHECK (octet_length(lease_token_sha256) = 32),
  issued_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (workspace_id, job_id),
  FOREIGN KEY (workspace_id, job_id)
    REFERENCES app.property_predator_owned_social_jobs (workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE app.property_predator_owned_social_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  job_id uuid NOT NULL,
  lease_version bigint NOT NULL CHECK (lease_version > 0),
  attempt_kind text NOT NULL CHECK (attempt_kind IN ('publish', 'reconcile')),
  event_kind text NOT NULL CHECK (event_kind IN (
    'accepted', 'published', 'failed', 'outcome_unknown'
  )),
  provider_external_id text CHECK (
    provider_external_id IS NULL OR provider_external_id ~ '^[A-Za-z0-9_-]{1,200}$'
  ),
  receipt_sha256 bytea NOT NULL CHECK (octet_length(receipt_sha256) = 32),
  safe_code text NOT NULL CHECK (safe_code ~ '^[a-z][a-z0-9_.:-]{0,99}$'),
  provider_occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, job_id, lease_version),
  FOREIGN KEY (workspace_id, job_id)
    REFERENCES app.property_predator_owned_social_jobs (workspace_id, id) ON DELETE RESTRICT
);

CREATE INDEX property_predator_owned_social_jobs_claim_idx
  ON app.property_predator_owned_social_jobs (workspace_id, provider_connection_id, available_at, created_at)
  WHERE state = 'queued';
CREATE INDEX property_predator_owned_social_jobs_reconcile_idx
  ON app.property_predator_owned_social_jobs
    (workspace_id, provider_connection_id, next_reconcile_at, created_at)
  WHERE state = 'reconciliation_pending';

CREATE FUNCTION app_private.owned_social_immutable_guard()
RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog AS $function$
BEGIN
  RAISE EXCEPTION 'Owned public-social evidence is immutable' USING ERRCODE = '40001';
  RETURN NULL;
END
$function$;
REVOKE ALL ON FUNCTION app_private.owned_social_immutable_guard() FROM PUBLIC;
CREATE TRIGGER property_predator_owned_social_profiles_immutable
  BEFORE UPDATE OR DELETE ON app.property_predator_owned_social_profiles
  FOR EACH ROW EXECUTE FUNCTION app_private.owned_social_immutable_guard();
CREATE TRIGGER property_predator_owned_social_profile_revocations_immutable
  BEFORE UPDATE OR DELETE ON app.property_predator_owned_social_profile_revocations
  FOR EACH ROW EXECUTE FUNCTION app_private.owned_social_immutable_guard();
CREATE TRIGGER property_predator_owned_social_receipts_immutable
  BEFORE UPDATE OR DELETE ON app.property_predator_owned_social_receipts
  FOR EACH ROW EXECUTE FUNCTION app_private.owned_social_immutable_guard();

CREATE FUNCTION app_private.owned_social_job_identity_guard()
RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog AS $function$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.provider_connection_id IS DISTINCT FROM OLD.provider_connection_id
     OR NEW.profile_id IS DISTINCT FROM OLD.profile_id
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
REVOKE ALL ON FUNCTION app_private.owned_social_job_identity_guard() FROM PUBLIC;
CREATE TRIGGER property_predator_owned_social_jobs_identity_immutable
  BEFORE UPDATE ON app.property_predator_owned_social_jobs
  FOR EACH ROW EXECUTE FUNCTION app_private.owned_social_job_identity_guard();

ALTER TABLE app.property_predator_owned_social_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.property_predator_owned_social_profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE app.property_predator_owned_social_profile_revocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.property_predator_owned_social_profile_revocations FORCE ROW LEVEL SECURITY;
ALTER TABLE app.property_predator_owned_social_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.property_predator_owned_social_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE app.property_predator_owned_social_job_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.property_predator_owned_social_job_leases FORCE ROW LEVEL SECURITY;
ALTER TABLE app.property_predator_owned_social_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.property_predator_owned_social_receipts FORCE ROW LEVEL SECURITY;

CREATE POLICY owned_social_profiles_owner_all ON app.property_predator_owned_social_profiles
  FOR ALL TO r72_owner USING (true) WITH CHECK (true);
CREATE POLICY owned_social_profile_revocations_owner_all
  ON app.property_predator_owned_social_profile_revocations
  FOR ALL TO r72_owner USING (true) WITH CHECK (true);
CREATE POLICY owned_social_jobs_owner_all ON app.property_predator_owned_social_jobs
  FOR ALL TO r72_owner USING (true) WITH CHECK (true);
CREATE POLICY owned_social_leases_owner_all ON app.property_predator_owned_social_job_leases
  FOR ALL TO r72_owner USING (true) WITH CHECK (true);
CREATE POLICY owned_social_receipts_owner_all ON app.property_predator_owned_social_receipts
  FOR ALL TO r72_owner USING (true) WITH CHECK (true);
CREATE POLICY owned_social_profiles_definer_all ON app.property_predator_owned_social_profiles
  FOR ALL TO r72_owned_social_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY owned_social_profile_revocations_definer_all
  ON app.property_predator_owned_social_profile_revocations
  FOR ALL TO r72_owned_social_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY owned_social_jobs_definer_all ON app.property_predator_owned_social_jobs
  FOR ALL TO r72_owned_social_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY owned_social_leases_definer_all ON app.property_predator_owned_social_job_leases
  FOR ALL TO r72_owned_social_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY owned_social_receipts_definer_all ON app.property_predator_owned_social_receipts
  FOR ALL TO r72_owned_social_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

CREATE POLICY provider_connections_owned_social_definer_select
  ON app.provider_connections FOR SELECT TO r72_owned_social_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY workspace_memberships_owned_social_definer_select
  ON app.workspace_memberships FOR SELECT TO r72_owned_social_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY company_content_versions_owned_social_definer_select
  ON app.company_content_versions FOR SELECT TO r72_owned_social_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY company_content_approval_requests_owned_social_definer_select
  ON app.company_content_approval_requests FOR SELECT TO r72_owned_social_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY company_content_approval_decisions_owned_social_definer_select
  ON app.company_content_approval_decisions FOR SELECT TO r72_owned_social_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY company_content_source_attestations_owned_social_definer_select
  ON app.company_content_source_attestations FOR SELECT TO r72_owned_social_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

GRANT SELECT, INSERT ON app.property_predator_owned_social_profiles TO r72_owned_social_definer;
GRANT SELECT, INSERT ON app.property_predator_owned_social_profile_revocations
  TO r72_owned_social_definer;
GRANT SELECT, INSERT, UPDATE ON app.property_predator_owned_social_jobs TO r72_owned_social_definer;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.property_predator_owned_social_job_leases TO r72_owned_social_definer;
GRANT SELECT, INSERT ON app.property_predator_owned_social_receipts TO r72_owned_social_definer;
GRANT SELECT ON app.provider_connections, app.workspace_memberships,
  app.company_content_versions, app.company_content_approval_requests,
  app.company_content_approval_decisions, app.company_content_source_attestations
  TO r72_owned_social_definer;
GRANT CREATE ON SCHEMA app_private TO r72_owned_social_definer;
SET LOCAL ROLE r72_owned_social_definer;

CREATE FUNCTION app_private.record_owned_social_profile(
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
    x_oauth_link_evidence_sha256, x_oauth_permissions, linked_at,
    evidence_observed_at, created_by_user_id
  ) VALUES (
    p_profile_id, p_workspace_id, p_provider_connection_id, 'live', 'ayrshare', 'x',
    p_display_name, p_provider_profile_ref_sha256, p_owned_account_ref_sha256,
    'aes-256-gcm-v1', p_secret_key_version, p_profile_key_iv,
    p_profile_key_ciphertext, p_profile_key_auth_tag, p_profile_key_aad_sha256,
    p_profile_key_sha256, p_x_oauth_link_evidence_sha256, 'read_write',
    p_linked_at, p_evidence_observed_at, selected_user
  );
  RETURN p_profile_id;
END
$function$;

CREATE FUNCTION app_private.revoke_owned_social_profile(
  p_workspace_id uuid, p_provider_connection_id uuid, p_profile_id uuid,
  p_revocation_evidence_sha256 bytea, p_reason_code text
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE selected_user uuid; selected_id uuid := gen_random_uuid(); existing record;
BEGIN
  IF session_user <> 'r72_owned_social_command'
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'user'
     OR coalesce(current_setting('app.request_id', true), '') = ''
     OR current_setting('app.user_id', true) !~ '^[0-9a-f-]{36}$'
     OR octet_length(p_revocation_evidence_sha256) <> 32
     OR p_reason_code !~ '^[a-z][a-z0-9_.:-]{0,99}$' THEN
    RAISE EXCEPTION 'Owned social profile revocation denied' USING ERRCODE = '42501';
  END IF;
  selected_user := current_setting('app.user_id')::uuid;
  IF NOT EXISTS (
    SELECT 1 FROM app.workspace_memberships AS membership
    WHERE membership.workspace_id = p_workspace_id AND membership.user_id = selected_user
      AND membership.status = 'active' AND membership.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'Owned social profile revocation denied' USING ERRCODE = '42501';
  END IF;
  PERFORM profile.id FROM app.property_predator_owned_social_profiles AS profile
  WHERE profile.workspace_id = p_workspace_id AND profile.id = p_profile_id
    AND profile.provider_connection_id = p_provider_connection_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Owned social profile revocation denied' USING ERRCODE = '42501';
  END IF;
  SELECT revocation.id, revocation.revocation_evidence_sha256, revocation.reason_code,
    revocation.revoked_by_user_id INTO existing
  FROM app.property_predator_owned_social_profile_revocations AS revocation
  WHERE revocation.workspace_id = p_workspace_id AND revocation.profile_id = p_profile_id;
  IF FOUND THEN
    IF existing.revocation_evidence_sha256 <> p_revocation_evidence_sha256
       OR existing.reason_code <> p_reason_code
       OR existing.revoked_by_user_id <> selected_user THEN
      RAISE EXCEPTION 'Owned social profile revocation conflict' USING ERRCODE = '40001';
    END IF;
    RETURN existing.id;
  END IF;
  INSERT INTO app.property_predator_owned_social_profile_revocations (
    id, workspace_id, provider_connection_id, profile_id,
    revocation_evidence_sha256, reason_code, revoked_by_user_id
  ) VALUES (
    selected_id, p_workspace_id, p_provider_connection_id, p_profile_id,
    p_revocation_evidence_sha256, p_reason_code, selected_user
  );
  RETURN selected_id;
END
$function$;

CREATE FUNCTION app_private.enqueue_owned_social_job(
  p_workspace_id uuid, p_provider_connection_id uuid, p_profile_id uuid,
  p_content_item_id uuid, p_content_version_id uuid,
  p_approval_request_id uuid, p_approval_decision_id uuid,
  p_source_attestation_id uuid, p_operation_tag text,
  p_idempotency_key_sha256 bytea, p_request_sha256 bytea,
  p_scheduled_for timestamptz DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE selected_user uuid; selected_id uuid := gen_random_uuid(); existing record;
  selected_version record; selected_effect_at timestamptz;
BEGIN
  IF session_user <> 'r72_owned_social_command'
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'user'
     OR coalesce(current_setting('app.request_id', true), '') = ''
     OR current_setting('app.user_id', true) !~ '^[0-9a-f-]{36}$'
     OR octet_length(p_idempotency_key_sha256) <> 32
     OR octet_length(p_request_sha256) <> 32 THEN
    RAISE EXCEPTION 'Owned social enqueue denied' USING ERRCODE = '42501';
  END IF;
  selected_user := current_setting('app.user_id')::uuid;
  IF NOT EXISTS (
    SELECT 1 FROM app.workspace_memberships AS membership
    WHERE membership.workspace_id = p_workspace_id AND membership.user_id = selected_user
      AND membership.status = 'active' AND membership.role IN ('owner', 'admin')
  ) THEN RAISE EXCEPTION 'Owned social enqueue denied' USING ERRCODE = '42501'; END IF;

  -- Serialize every enqueue for one owned profile before either the idempotency
  -- replay check or the daily/monthly count. Without this row lock concurrent
  -- requests could both observe zero jobs and step around the launch caps.
  PERFORM profile.id
  FROM app.property_predator_owned_social_profiles AS profile
  WHERE profile.workspace_id = p_workspace_id
    AND profile.id = p_profile_id
    AND profile.provider_connection_id = p_provider_connection_id
    AND profile.environment = 'live'
    AND profile.network = 'x'
    AND NOT EXISTS (
      SELECT 1 FROM app.property_predator_owned_social_profile_revocations AS revocation
      WHERE revocation.workspace_id = profile.workspace_id
        AND revocation.profile_id = profile.id
    )
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Owned social profile binding denied' USING ERRCODE = '42501';
  END IF;

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
  FROM app.company_content_versions AS version
  JOIN app.company_content_approval_requests AS request
    ON request.workspace_id = version.workspace_id
   AND request.content_item_id = version.content_item_id
   AND request.content_version_id = version.id
   AND request.content_sha256 = version.content_sha256
   AND request.id = p_approval_request_id
  JOIN app.company_content_approval_decisions AS decision
    ON decision.workspace_id = request.workspace_id
   AND decision.approval_request_id = request.id
   AND decision.id = p_approval_decision_id AND decision.decision = 'approved'
  JOIN app.company_content_source_attestations AS attestation
    ON attestation.workspace_id = version.workspace_id
   AND attestation.content_item_id = version.content_item_id
   AND attestation.content_version_id = version.id
   AND attestation.content_sha256 = version.content_sha256
   AND attestation.blob_sha256 = version.blob_sha256
   AND attestation.brand_sha256 = version.brand_sha256
   AND attestation.id = p_source_attestation_id
  JOIN app.property_predator_owned_social_profiles AS profile
    ON profile.workspace_id = version.workspace_id AND profile.id = p_profile_id
   AND profile.provider_connection_id = p_provider_connection_id
   AND profile.environment = 'live' AND profile.network = 'x'
  JOIN app.provider_connections AS connection
    ON connection.workspace_id = profile.workspace_id
   AND connection.id = profile.provider_connection_id
   AND connection.environment = 'live' AND connection.provider_id = 'ayrshare'
   AND connection.provider_kind = 'social' AND connection.status = 'active'
  WHERE version.workspace_id = p_workspace_id AND version.content_item_id = p_content_item_id
    AND version.id = p_content_version_id AND version.content_kind = 'social_post'
    AND public.digest(version.content_body, 'sha256') = version.content_sha256
    AND attestation.checked_at <= statement_timestamp()
    AND attestation.expires_at > greatest(
      statement_timestamp(), coalesce(p_scheduled_for, statement_timestamp())
    ) + interval '15 minutes'
    AND NOT EXISTS (
      SELECT 1 FROM app.company_content_versions AS newer
      WHERE newer.workspace_id = version.workspace_id
        AND newer.content_item_id = version.content_item_id
        AND newer.version_number > version.version_number
    )
    AND NOT EXISTS (
      SELECT 1 FROM app.property_predator_owned_social_profile_revocations AS revocation
      WHERE revocation.workspace_id = profile.workspace_id
        AND revocation.profile_id = profile.id
    );
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Owned social content/profile evidence denied' USING ERRCODE = '42501';
  END IF;
  IF length(selected_version.content_body) > 280 OR selected_version.content_body !~ '^[\r\n -~]+$'
     OR selected_version.content_body ~* '(//|(^|[^A-Za-z])[A-Za-z][A-Za-z0-9+.-]*:|www[.]|[A-Za-z0-9][A-Za-z0-9-]{0,62}[.][A-Za-z]{2,63})' THEN
    RAISE EXCEPTION 'Owned social X v1 text denied' USING ERRCODE = '22023';
  END IF;
  selected_effect_at := greatest(
    statement_timestamp(), coalesce(p_scheduled_for, statement_timestamp())
  );
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
    content_item_id, content_version_id, content_sha256, approval_request_id,
    approval_decision_id, source_attestation_id, operation_tag,
    idempotency_key_sha256, request_sha256, text_body, scheduled_for,
    utc_day, utc_month, available_at, created_by_user_id
  ) VALUES (
    selected_id, p_workspace_id, p_provider_connection_id, p_profile_id, 'live', 'x',
    p_content_item_id, p_content_version_id, selected_version.content_sha256,
    p_approval_request_id, p_approval_decision_id, p_source_attestation_id,
    p_operation_tag, p_idempotency_key_sha256, p_request_sha256,
    selected_version.content_body, p_scheduled_for,
    (selected_effect_at AT TIME ZONE 'UTC')::date,
    date_trunc('month', selected_effect_at AT TIME ZONE 'UTC')::date,
    selected_effect_at, selected_user
  );
  RETURN selected_id;
END
$function$;

CREATE FUNCTION app_private.claim_owned_social_job(
  p_workspace_id uuid, p_provider_connection_id uuid,
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
     OR octet_length(p_lease_token) <> 32 OR p_lease_seconds NOT BETWEEN 30 AND 300 THEN
    RAISE EXCEPTION 'Owned social claim denied' USING ERRCODE = '42501';
  END IF;
  -- A pre-call lease is safe to return to its exact queue. Once calling was
  -- entered, process death is ambiguous and is fenced for human review; it is
  -- never automatically published again.
  FOR recovered IN
    SELECT job.* FROM app.property_predator_owned_social_jobs AS job
    WHERE job.workspace_id = p_workspace_id
      AND job.provider_connection_id = p_provider_connection_id
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
  -- A revoked profile, disabled connection or missed scheduled publish day is
  -- never handed to a provider. Fence it visibly for an operator instead of
  -- leaving a poison job to be reclaimed forever.
  UPDATE app.property_predator_owned_social_jobs AS job SET
    state = 'needs_attention', next_reconcile_at = NULL,
    settled_at = statement_timestamp(), updated_at = statement_timestamp()
  WHERE job.workspace_id = p_workspace_id
    AND job.provider_connection_id = p_provider_connection_id
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
         AND connection.environment = 'live'
         AND connection.provider_id = 'ayrshare'
         AND connection.provider_kind = 'social'
         AND connection.status = 'active'
        WHERE profile.workspace_id = job.workspace_id
          AND profile.id = job.profile_id
          AND profile.provider_connection_id = job.provider_connection_id
          AND NOT EXISTS (
            SELECT 1 FROM app.property_predator_owned_social_profile_revocations AS revocation
            WHERE revocation.workspace_id = profile.workspace_id
              AND revocation.profile_id = profile.id
          )
      )
    );
  SELECT job.* INTO selected FROM app.property_predator_owned_social_jobs AS job
  WHERE job.workspace_id = p_workspace_id AND job.provider_connection_id = p_provider_connection_id
    AND ((job.state = 'queued' AND job.available_at <= statement_timestamp())
      OR (job.state = 'reconciliation_pending' AND job.next_reconcile_at <= statement_timestamp()))
    AND job.claim_count < 12
    AND EXISTS (
      SELECT 1 FROM app.property_predator_owned_social_profiles AS profile
      JOIN app.provider_connections AS connection
        ON connection.workspace_id = profile.workspace_id
       AND connection.id = profile.provider_connection_id
       AND connection.environment = 'live' AND connection.provider_id = 'ayrshare'
       AND connection.provider_kind = 'social' AND connection.status = 'active'
      WHERE profile.workspace_id = job.workspace_id AND profile.id = job.profile_id
        AND profile.provider_connection_id = job.provider_connection_id
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

CREATE FUNCTION app_private.load_owned_social_job(
  p_workspace_id uuid, p_job_id uuid, p_lease_version bigint, p_lease_token bytea
) RETURNS TABLE(
  provider_connection_id uuid, profile_id uuid, attempt_kind text,
  secret_key_version text, profile_key_iv bytea, profile_key_ciphertext bytea,
  profile_key_auth_tag bytea, profile_key_aad_sha256 bytea, profile_key_sha256 bytea,
  operation_tag text, idempotency_key text, text_body text, text_sha256 bytea,
  scheduled_for timestamptz, provider_external_id text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $function$
  SELECT job.provider_connection_id, job.profile_id, job.lease_attempt_kind,
    profile.secret_key_version, profile.profile_key_iv, profile.profile_key_ciphertext,
    profile.profile_key_auth_tag, profile.profile_key_aad_sha256, profile.profile_key_sha256,
    job.operation_tag, encode(job.idempotency_key_sha256, 'hex'), job.text_body,
    job.text_sha256, job.scheduled_for, job.provider_external_id
  FROM app.property_predator_owned_social_jobs AS job
  JOIN app.property_predator_owned_social_job_leases AS lease
    ON lease.workspace_id = job.workspace_id AND lease.job_id = job.id
   AND lease.lease_version = job.lease_version
   AND lease.lease_token_sha256 = public.digest(p_lease_token, 'sha256')
  JOIN app.property_predator_owned_social_profiles AS profile
    ON profile.workspace_id = job.workspace_id AND profile.id = job.profile_id
   AND profile.provider_connection_id = job.provider_connection_id
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
      WHERE revocation.workspace_id = profile.workspace_id
        AND revocation.profile_id = profile.id
    );
$function$;

CREATE FUNCTION app_private.begin_owned_social_call(
  p_workspace_id uuid, p_job_id uuid, p_lease_version bigint, p_lease_token bytea,
  p_provider_effects_enabled boolean, p_emergency_paused boolean
) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE changed integer;
BEGIN
  IF session_user <> 'r72_owned_social_worker_command'
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'worker'
     OR coalesce(current_setting('app.user_id', true), '') <> ''
     OR coalesce(current_setting('app.request_id', true), '') = ''
     OR NOT p_provider_effects_enabled OR p_emergency_paused THEN
    RAISE EXCEPTION 'Owned social begin-call denied' USING ERRCODE = '42501';
  END IF;
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
      job.utc_day = (statement_timestamp() AT TIME ZONE 'UTC')::date
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
        AND NOT EXISTS (
          SELECT 1 FROM app.property_predator_owned_social_profile_revocations AS revocation
          WHERE revocation.workspace_id = profile.workspace_id
            AND revocation.profile_id = profile.id
        )
    );
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END
$function$;

CREATE FUNCTION app_private.settle_owned_social_call(
  p_workspace_id uuid, p_job_id uuid, p_lease_version bigint, p_lease_token bytea,
  p_result_state text, p_provider_external_id text, p_receipt_sha256 bytea,
  p_provider_occurred_at timestamptz, p_safe_code text
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE selected app.property_predator_owned_social_jobs%ROWTYPE; next_state text; next_at timestamptz;
BEGIN
  IF session_user <> 'r72_owned_social_worker_command'
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'worker'
     OR coalesce(current_setting('app.user_id', true), '') <> ''
     OR coalesce(current_setting('app.request_id', true), '') = ''
     OR p_result_state NOT IN ('accepted', 'published', 'failed', 'outcome_unknown')
     OR (p_result_state IN ('accepted', 'published') AND p_provider_external_id IS NULL)
     OR octet_length(p_receipt_sha256) <> 32
     OR p_safe_code !~ '^[a-z][a-z0-9_.:-]{0,99}$' THEN
    RAISE EXCEPTION 'Owned social settle denied' USING ERRCODE = '42501';
  END IF;
  SELECT job.* INTO selected FROM app.property_predator_owned_social_jobs AS job
  JOIN app.property_predator_owned_social_job_leases AS lease
    ON lease.workspace_id = job.workspace_id AND lease.job_id = job.id
   AND lease.lease_version = job.lease_version
   AND lease.lease_token_sha256 = public.digest(p_lease_token, 'sha256')
  WHERE job.workspace_id = p_workspace_id AND job.id = p_job_id
    AND job.state = 'calling' AND job.lease_version = p_lease_version
  FOR UPDATE OF job;
  IF NOT FOUND THEN RAISE EXCEPTION 'Owned social settle lease lost' USING ERRCODE = '40001'; END IF;
  IF p_result_state = 'accepted' AND selected.lease_attempt_kind = 'reconcile'
     AND selected.reconcile_count >= 7 THEN
    next_state := 'needs_attention'; next_at := NULL;
  ELSIF p_result_state = 'accepted' THEN
    next_state := 'reconciliation_pending'; next_at := statement_timestamp() + interval '60 seconds';
  ELSIF p_result_state = 'published' THEN next_state := 'succeeded'; next_at := NULL;
  ELSIF p_result_state = 'failed' THEN next_state := 'failed'; next_at := NULL;
  ELSE next_state := 'needs_attention'; next_at := NULL;
  END IF;
  INSERT INTO app.property_predator_owned_social_receipts (
    workspace_id, job_id, lease_version, attempt_kind, event_kind,
    provider_external_id, receipt_sha256, safe_code, provider_occurred_at
  ) VALUES (
    p_workspace_id, p_job_id, p_lease_version, selected.lease_attempt_kind,
    p_result_state, p_provider_external_id, p_receipt_sha256, p_safe_code,
    p_provider_occurred_at
  );
  UPDATE app.property_predator_owned_social_jobs SET
    state = next_state, lease_expires_at = NULL, lease_attempt_kind = NULL,
    provider_external_id = coalesce(p_provider_external_id, provider_external_id),
    next_reconcile_at = next_at,
    reconcile_count = reconcile_count + CASE WHEN selected.lease_attempt_kind = 'reconcile' THEN 1 ELSE 0 END,
    settled_at = CASE WHEN next_state IN ('succeeded', 'failed', 'needs_attention')
      THEN statement_timestamp() ELSE NULL END,
    updated_at = statement_timestamp()
  WHERE workspace_id = p_workspace_id AND id = p_job_id;
  DELETE FROM app.property_predator_owned_social_job_leases
  WHERE workspace_id = p_workspace_id AND job_id = p_job_id;
END
$function$;

SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_owned_social_definer;

REVOKE ALL ON FUNCTION app_private.record_owned_social_profile(
  uuid, uuid, uuid, text, bytea, bytea, text, bytea, bytea, bytea,
  bytea, bytea, bytea, timestamptz, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.revoke_owned_social_profile(
  uuid, uuid, uuid, bytea, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.enqueue_owned_social_job(
  uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, bytea, bytea, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.claim_owned_social_job(uuid, uuid, bytea, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.load_owned_social_job(uuid, uuid, bigint, bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.begin_owned_social_call(
  uuid, uuid, bigint, bytea, boolean, boolean
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.settle_owned_social_call(
  uuid, uuid, bigint, bytea, text, text, bytea, timestamptz, text
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app_private.record_owned_social_profile(
  uuid, uuid, uuid, text, bytea, bytea, text, bytea, bytea, bytea,
  bytea, bytea, bytea, timestamptz, timestamptz
) TO r72_owned_social_command;
GRANT EXECUTE ON FUNCTION app_private.revoke_owned_social_profile(
  uuid, uuid, uuid, bytea, text
) TO r72_owned_social_command;
GRANT EXECUTE ON FUNCTION app_private.enqueue_owned_social_job(
  uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, bytea, bytea, timestamptz
) TO r72_owned_social_command;
GRANT EXECUTE ON FUNCTION app_private.claim_owned_social_job(uuid, uuid, bytea, integer)
  TO r72_owned_social_worker_command;
GRANT EXECUTE ON FUNCTION app_private.load_owned_social_job(uuid, uuid, bigint, bytea)
  TO r72_owned_social_worker_command;
GRANT EXECUTE ON FUNCTION app_private.begin_owned_social_call(
  uuid, uuid, bigint, bytea, boolean, boolean
) TO r72_owned_social_worker_command;
GRANT EXECUTE ON FUNCTION app_private.settle_owned_social_call(
  uuid, uuid, bigint, bytea, text, text, bytea, timestamptz, text
) TO r72_owned_social_worker_command;

-- Both isolated processes prove the release schema and installation before
-- composing. The founder command additionally crosses the same active portal
-- session fence as every other irreversible founder mutation.
GRANT EXECUTE ON FUNCTION app_private.runtime_schema_migrations(),
  app_private.runtime_database_installation_id()
  TO r72_owned_social_command, r72_owned_social_worker_command;
GRANT EXECUTE ON FUNCTION app_private.lock_active_portal_session(bytea, uuid, uuid)
  TO r72_owned_social_command;

DO $runtime_readiness_capability_audit$
BEGIN
  IF NOT has_function_privilege(
    'r72_owned_social_worker_command',
    'app_private.runtime_schema_migrations()',
    'EXECUTE'
  ) OR NOT has_function_privilege(
    'r72_owned_social_worker_command',
    'app_private.runtime_database_installation_id()',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'Owned-social worker runtime readiness capability is incomplete';
  END IF;
  IF NOT has_function_privilege(
    'r72_owned_social_command',
    'app_private.runtime_schema_migrations()',
    'EXECUTE'
  ) OR NOT has_function_privilege(
    'r72_owned_social_command',
    'app_private.runtime_database_installation_id()',
    'EXECUTE'
  ) OR NOT has_function_privilege(
    'r72_owned_social_command',
    'app_private.lock_active_portal_session(bytea,uuid,uuid)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'Owned-social founder command runtime capability is incomplete';
  END IF;
END
$runtime_readiness_capability_audit$;

INSERT INTO app_private.workspace_table_registry (schema_name, table_name, workspace_column)
VALUES
  ('app', 'property_predator_owned_social_profiles', 'workspace_id'),
  ('app', 'property_predator_owned_social_profile_revocations', 'workspace_id'),
  ('app', 'property_predator_owned_social_jobs', 'workspace_id'),
  ('app', 'property_predator_owned_social_job_leases', 'workspace_id'),
  ('app', 'property_predator_owned_social_receipts', 'workspace_id');

DO $capability_audit$
DECLARE checked_role text; unsafe_object text;
BEGIN
  FOREACH checked_role IN ARRAY ARRAY['r72_owned_social_command', 'r72_owned_social_worker_command']
  LOOP
    SELECT format('%I.%I', namespace.nspname, relation.relname) INTO unsafe_object
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname IN ('app', 'app_private')
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND (has_table_privilege(checked_role, relation.oid, 'SELECT')
        OR has_table_privilege(checked_role, relation.oid, 'INSERT')
        OR has_table_privilege(checked_role, relation.oid, 'UPDATE')
        OR has_table_privilege(checked_role, relation.oid, 'DELETE')
        OR has_table_privilege(checked_role, relation.oid, 'TRUNCATE'))
    LIMIT 1;
    IF unsafe_object IS NOT NULL THEN
      RAISE EXCEPTION 'Unsafe owned-social table capability: % -> %', checked_role, unsafe_object;
    END IF;
  END LOOP;
END
$capability_audit$;
