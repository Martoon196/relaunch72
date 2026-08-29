-- Controlled Meta WhatsApp Cloud API foundation. This migration stores one
-- exact encrypted owned-number binding and one approved template/recipient job.
-- It installs no credentials, app route, worker, webhook or external effect.

DO $roles$
DECLARE unsafe_membership text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'r72_whatsapp_live_command') THEN
    CREATE ROLE r72_whatsapp_live_command LOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'r72_whatsapp_live_worker_command') THEN
    CREATE ROLE r72_whatsapp_live_worker_command LOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'r72_whatsapp_live_webhook_command') THEN
    CREATE ROLE r72_whatsapp_live_webhook_command LOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'r72_whatsapp_live_definer') THEN
    CREATE ROLE r72_whatsapp_live_definer NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'r72_whatsapp_live_command' AND rolcanlogin AND NOT rolinherit
      AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
      AND NOT rolreplication AND NOT rolbypassrls
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'r72_whatsapp_live_worker_command' AND rolcanlogin AND NOT rolinherit
      AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
      AND NOT rolreplication AND NOT rolbypassrls
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'r72_whatsapp_live_webhook_command' AND rolcanlogin AND NOT rolinherit
      AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
      AND NOT rolreplication AND NOT rolbypassrls
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'r72_whatsapp_live_definer' AND NOT rolcanlogin AND NOT rolinherit
      AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
      AND NOT rolreplication AND NOT rolbypassrls
  ) THEN
    RAISE EXCEPTION 'Unsafe WhatsApp live role attributes';
  END IF;
  REVOKE r72_owner, r72_security_definer, r72_whatsapp_live_definer FROM
    r72_whatsapp_live_command, r72_whatsapp_live_worker_command,
    r72_whatsapp_live_webhook_command;
  REVOKE r72_owner, r72_security_definer FROM r72_whatsapp_live_definer;
  SELECT parent.rolname INTO unsafe_membership
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
  JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
  WHERE member.rolname IN (
    'r72_whatsapp_live_command', 'r72_whatsapp_live_worker_command',
    'r72_whatsapp_live_webhook_command'
  ) LIMIT 1;
  IF unsafe_membership IS NOT NULL THEN
    RAISE EXCEPTION 'Unsafe WhatsApp live command membership: %', unsafe_membership;
  END IF;
  GRANT r72_whatsapp_live_definer TO r72_owner;
  EXECUTE format('GRANT r72_whatsapp_live_command TO %I', current_user);
  EXECUTE format('GRANT r72_whatsapp_live_worker_command TO %I', current_user);
  EXECUTE format('GRANT r72_whatsapp_live_webhook_command TO %I', current_user);
END
$roles$;

SET LOCAL ROLE r72_owner;

REVOKE ALL ON SCHEMA app, app_private FROM r72_whatsapp_live_command,
  r72_whatsapp_live_worker_command, r72_whatsapp_live_webhook_command,
  r72_whatsapp_live_definer;
REVOKE ALL ON ALL TABLES IN SCHEMA app FROM r72_whatsapp_live_command,
  r72_whatsapp_live_worker_command, r72_whatsapp_live_webhook_command,
  r72_whatsapp_live_definer;
REVOKE ALL ON ALL TABLES IN SCHEMA app_private FROM r72_whatsapp_live_command,
  r72_whatsapp_live_worker_command, r72_whatsapp_live_webhook_command,
  r72_whatsapp_live_definer;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app_private FROM r72_whatsapp_live_command,
  r72_whatsapp_live_worker_command, r72_whatsapp_live_webhook_command;
REVOKE CREATE ON SCHEMA public FROM r72_whatsapp_live_command,
  r72_whatsapp_live_worker_command, r72_whatsapp_live_webhook_command,
  r72_whatsapp_live_definer;
GRANT USAGE ON SCHEMA app, app_private TO r72_whatsapp_live_command,
  r72_whatsapp_live_worker_command, r72_whatsapp_live_webhook_command,
  r72_whatsapp_live_definer;

CREATE TABLE app.property_predator_whatsapp_live_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  predecessor_binding_id uuid,
  provider_connection_id uuid NOT NULL,
  environment text NOT NULL CHECK (environment = 'live'),
  provider_id text NOT NULL CHECK (provider_id = 'meta_whatsapp_cloud'),
  app_id text NOT NULL CHECK (app_id ~ '^[1-9][0-9]{4,29}$'),
  waba_id text NOT NULL CHECK (waba_id ~ '^[1-9][0-9]{4,29}$'),
  phone_number_id text NOT NULL CHECK (phone_number_id ~ '^[1-9][0-9]{4,29}$'),
  owned_phone_sha256 bytea NOT NULL CHECK (octet_length(owned_phone_sha256) = 32),
  graph_api_version text NOT NULL CHECK (graph_api_version = 'v24.0'),
  secret_algorithm text NOT NULL CHECK (secret_algorithm = 'aes-256-gcm-v1'),
  secret_key_version text NOT NULL CHECK (
    secret_key_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  ),
  secret_iv bytea NOT NULL CHECK (octet_length(secret_iv) = 12),
  -- Canonical JSON containing only a 20-byte-minimum accessToken starts at
  -- 38 bytes. Webhook app/verify secrets are deliberately excluded.
  secret_ciphertext bytea NOT NULL CHECK (octet_length(secret_ciphertext) BETWEEN 38 AND 8192),
  secret_auth_tag bytea NOT NULL CHECK (octet_length(secret_auth_tag) = 16),
  secret_aad_sha256 bytea NOT NULL CHECK (octet_length(secret_aad_sha256) = 32),
  secret_payload_sha256 bytea NOT NULL CHECK (octet_length(secret_payload_sha256) = 32),
  ownership_evidence_sha256 bytea NOT NULL CHECK (octet_length(ownership_evidence_sha256) = 32),
  ownership_observed_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status = 'active'),
  created_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, id, provider_connection_id),
  UNIQUE (workspace_id, id, provider_connection_id, environment),
  FOREIGN KEY (workspace_id, provider_connection_id, environment)
    REFERENCES app.provider_connections (workspace_id, id, environment) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, predecessor_binding_id)
    REFERENCES app.property_predator_whatsapp_live_bindings (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, created_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX property_predator_whatsapp_live_binding_one_successor_uq
  ON app.property_predator_whatsapp_live_bindings (workspace_id, predecessor_binding_id)
  WHERE predecessor_binding_id IS NOT NULL;

CREATE TABLE app.property_predator_whatsapp_live_binding_revocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  binding_id uuid NOT NULL,
  revocation_kind text NOT NULL CHECK (revocation_kind IN ('revoked', 'superseded')),
  successor_binding_id uuid,
  evidence_sha256 bytea NOT NULL CHECK (octet_length(evidence_sha256) = 32),
  recorded_by_user_id uuid NOT NULL,
  recorded_request_id text NOT NULL CHECK (
    recorded_request_id = btrim(recorded_request_id)
    AND length(recorded_request_id) BETWEEN 1 AND 128
  ),
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, binding_id),
  FOREIGN KEY (workspace_id, binding_id)
    REFERENCES app.property_predator_whatsapp_live_bindings (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, successor_binding_id)
    REFERENCES app.property_predator_whatsapp_live_bindings (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, recorded_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK (
    (revocation_kind = 'revoked' AND successor_binding_id IS NULL)
    OR (revocation_kind = 'superseded' AND successor_binding_id IS NOT NULL)
  ),
  CHECK (successor_binding_id IS NULL OR successor_binding_id <> binding_id)
);

CREATE TABLE app.property_predator_whatsapp_live_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  binding_id uuid NOT NULL,
  provider_connection_id uuid NOT NULL,
  environment text GENERATED ALWAYS AS ('live'::text) STORED,
  content_item_id uuid NOT NULL,
  content_version_id uuid NOT NULL,
  content_sha256 bytea NOT NULL CHECK (octet_length(content_sha256) = 32),
  approval_request_id uuid NOT NULL,
  approval_decision_id uuid NOT NULL,
  provider_template_name text NOT NULL CHECK (
    provider_template_name ~ '^[a-z][a-z0-9_]{0,511}$'
  ),
  provider_template_ref_sha256 bytea NOT NULL
    CHECK (octet_length(provider_template_ref_sha256) = 32),
  language_code text NOT NULL CHECK (language_code ~ '^[a-z]{2,3}(_[A-Z]{2})?$'),
  category text NOT NULL CHECK (category IN ('utility', 'marketing')),
  parameter_count smallint NOT NULL CHECK (parameter_count = 0),
  provider_status text NOT NULL CHECK (provider_status = 'approved'),
  provider_approval_evidence_sha256 bytea NOT NULL
    CHECK (octet_length(provider_approval_evidence_sha256) = 32),
  provider_approved_at timestamptz NOT NULL,
  created_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, id, binding_id, provider_connection_id),
  UNIQUE (workspace_id, binding_id, provider_template_name, language_code),
  FOREIGN KEY (workspace_id, binding_id, provider_connection_id, environment)
    REFERENCES app.property_predator_whatsapp_live_bindings
      (workspace_id, id, provider_connection_id, environment) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, content_item_id, content_version_id, content_sha256)
    REFERENCES app.company_content_versions
      (workspace_id, content_item_id, id, content_sha256) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, approval_request_id)
    REFERENCES app.company_content_approval_requests (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, approval_decision_id)
    REFERENCES app.company_content_approval_decisions (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, created_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT
);

CREATE TABLE app.property_predator_whatsapp_live_authorities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  binding_id uuid NOT NULL,
  template_id uuid NOT NULL,
  provider_connection_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  contact_point_id uuid NOT NULL,
  recipient_sha256 bytea NOT NULL CHECK (octet_length(recipient_sha256) = 32),
  purpose text NOT NULL CHECK (purpose ~ '^[a-z][a-z0-9_.-]{0,99}$'),
  consent_event_id uuid NOT NULL,
  compliance_subject_id uuid NOT NULL,
  policy_publication_event_id uuid NOT NULL,
  pecr_sender_decision_event_id uuid NOT NULL,
  pecr_instigator_decision_event_id uuid NOT NULL,
  permission_use_receipt_id uuid NOT NULL,
  pecr_decision text NOT NULL CHECK (pecr_decision = 'eligible'),
  pecr_evidence_sha256 bytea NOT NULL CHECK (octet_length(pecr_evidence_sha256) = 32),
  operator_instigator_decision text NOT NULL CHECK (operator_instigator_decision = 'eligible'),
  operator_instigator_sha256 bytea NOT NULL
    CHECK (octet_length(operator_instigator_sha256) = 32),
  action_scope_sha256 bytea NOT NULL CHECK (octet_length(action_scope_sha256) = 32),
  operator_user_id uuid NOT NULL,
  operator_request_id text NOT NULL CHECK (
    operator_request_id = btrim(operator_request_id)
    AND length(operator_request_id) BETWEEN 1 AND 128
  ),
  evaluated_at timestamptz NOT NULL,
  valid_until timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, id, binding_id, template_id, recipient_sha256),
  UNIQUE (workspace_id, permission_use_receipt_id),
  FOREIGN KEY (workspace_id, binding_id, provider_connection_id)
    REFERENCES app.property_predator_whatsapp_live_bindings
      (workspace_id, id, provider_connection_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, template_id, binding_id, provider_connection_id)
    REFERENCES app.property_predator_whatsapp_live_templates
      (workspace_id, id, binding_id, provider_connection_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, contact_point_id, contact_id)
    REFERENCES app.contact_points (workspace_id, id, contact_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, consent_event_id)
    REFERENCES app.communication_consent_events (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, compliance_subject_id)
    REFERENCES app_private.affiliate_compliance_subjects (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, policy_publication_event_id)
    REFERENCES app_private.affiliate_compliance_policy_publication_events
      (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, pecr_sender_decision_event_id)
    REFERENCES app_private.affiliate_compliance_specialist_decision_events
      (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, pecr_instigator_decision_event_id)
    REFERENCES app_private.affiliate_compliance_specialist_decision_events
      (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, permission_use_receipt_id)
    REFERENCES app_private.affiliate_compliance_permission_use_receipts
      (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, operator_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK (evaluated_at <= recorded_at + interval '30 seconds'),
  CHECK (valid_until > evaluated_at AND valid_until <= evaluated_at + interval '15 minutes')
);

CREATE TABLE app.property_predator_whatsapp_live_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  binding_id uuid NOT NULL,
  template_id uuid NOT NULL,
  authority_id uuid NOT NULL,
  provider_connection_id uuid NOT NULL,
  recipient_sha256 bytea NOT NULL CHECK (octet_length(recipient_sha256) = 32),
  operation_id uuid NOT NULL,
  idempotency_key_sha256 bytea NOT NULL CHECK (octet_length(idempotency_key_sha256) = 32),
  request_sha256 bytea NOT NULL CHECK (octet_length(request_sha256) = 32),
  utc_day date NOT NULL,
  utc_month date NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN (
    'queued', 'leased', 'calling', 'awaiting_status',
    'succeeded', 'failed', 'needs_attention', 'cancelled'
  )),
  lease_version bigint NOT NULL DEFAULT 0 CHECK (lease_version >= 0),
  lease_expires_at timestamptz,
  claim_count integer NOT NULL DEFAULT 0 CHECK (claim_count BETWEEN 0 AND 8),
  provider_message_id text CHECK (
    provider_message_id IS NULL OR provider_message_id ~ '^wamid[.][A-Za-z0-9_=-]{1,190}$'
  ),
  status_deadline timestamptz,
  available_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  created_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  calling_at timestamptz,
  settled_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, operation_id),
  UNIQUE (workspace_id, idempotency_key_sha256),
  UNIQUE (workspace_id, provider_message_id),
  FOREIGN KEY (workspace_id, authority_id, binding_id, template_id, recipient_sha256)
    REFERENCES app.property_predator_whatsapp_live_authorities
      (workspace_id, id, binding_id, template_id, recipient_sha256) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, created_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK (utc_month = date_trunc('month', utc_month)::date),
  CHECK ((state IN ('leased', 'calling')) = (lease_expires_at IS NOT NULL)),
  CHECK ((state = 'awaiting_status') = (status_deadline IS NOT NULL)),
  CHECK ((provider_message_id IS NULL) OR state IN (
    'calling', 'awaiting_status', 'succeeded', 'failed', 'needs_attention'
  ))
);

CREATE TABLE app.property_predator_whatsapp_live_job_leases (
  workspace_id uuid NOT NULL,
  job_id uuid NOT NULL,
  lease_version bigint NOT NULL CHECK (lease_version > 0),
  lease_token_sha256 bytea NOT NULL CHECK (octet_length(lease_token_sha256) = 32),
  issued_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (workspace_id, job_id),
  FOREIGN KEY (workspace_id, job_id)
    REFERENCES app.property_predator_whatsapp_live_jobs (workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE app.property_predator_whatsapp_live_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  job_id uuid,
  binding_id uuid NOT NULL,
  external_event_id text NOT NULL CHECK (
    external_event_id = btrim(external_event_id) AND length(external_event_id) BETWEEN 1 AND 500
  ),
  event_kind text NOT NULL CHECK (event_kind IN (
    'accepted', 'sent', 'delivered', 'read', 'failed',
    'deleted', 'outcome_unknown', 'inbound_received'
  )),
  provider_message_id text CHECK (
    provider_message_id IS NULL OR provider_message_id ~ '^wamid[.][A-Za-z0-9_=-]{1,190}$'
  ),
  recipient_or_sender_sha256 bytea NOT NULL
    CHECK (octet_length(recipient_or_sender_sha256) = 32),
  body_sha256 bytea CHECK (body_sha256 IS NULL OR octet_length(body_sha256) = 32),
  payload_sha256 bytea NOT NULL CHECK (octet_length(payload_sha256) = 32),
  safe_code text NOT NULL CHECK (safe_code ~ '^[a-z][a-z0-9_.:-]{0,99}$'),
  provider_occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, binding_id, external_event_id),
  FOREIGN KEY (workspace_id, job_id)
    REFERENCES app.property_predator_whatsapp_live_jobs (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, binding_id)
    REFERENCES app.property_predator_whatsapp_live_bindings (workspace_id, id) ON DELETE RESTRICT,
  CHECK ((event_kind = 'inbound_received') = (body_sha256 IS NOT NULL))
);

CREATE INDEX property_predator_whatsapp_live_jobs_claim_idx
  ON app.property_predator_whatsapp_live_jobs
    (workspace_id, provider_connection_id, available_at, created_at)
  WHERE state = 'queued';
CREATE UNIQUE INDEX property_predator_whatsapp_live_jobs_daily_cap_uq
  ON app.property_predator_whatsapp_live_jobs (workspace_id, binding_id, utc_day)
  WHERE state <> 'cancelled';
CREATE INDEX property_predator_whatsapp_live_jobs_status_idx
  ON app.property_predator_whatsapp_live_jobs
    (workspace_id, provider_connection_id, status_deadline, created_at)
  WHERE state = 'awaiting_status';

CREATE FUNCTION app_private.whatsapp_live_immutable_guard()
RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog AS $function$
BEGIN
  RAISE EXCEPTION 'Meta WhatsApp live evidence is immutable' USING ERRCODE = '40001';
  RETURN NULL;
END
$function$;
REVOKE ALL ON FUNCTION app_private.whatsapp_live_immutable_guard() FROM PUBLIC;
CREATE TRIGGER whatsapp_live_bindings_immutable BEFORE UPDATE OR DELETE
  ON app.property_predator_whatsapp_live_bindings FOR EACH ROW
  EXECUTE FUNCTION app_private.whatsapp_live_immutable_guard();
CREATE TRIGGER whatsapp_live_binding_revocations_immutable BEFORE UPDATE OR DELETE
  ON app.property_predator_whatsapp_live_binding_revocations FOR EACH ROW
  EXECUTE FUNCTION app_private.whatsapp_live_immutable_guard();
CREATE TRIGGER whatsapp_live_templates_immutable BEFORE UPDATE OR DELETE
  ON app.property_predator_whatsapp_live_templates FOR EACH ROW
  EXECUTE FUNCTION app_private.whatsapp_live_immutable_guard();
CREATE TRIGGER whatsapp_live_authorities_immutable BEFORE UPDATE OR DELETE
  ON app.property_predator_whatsapp_live_authorities FOR EACH ROW
  EXECUTE FUNCTION app_private.whatsapp_live_immutable_guard();
CREATE TRIGGER whatsapp_live_receipts_immutable BEFORE UPDATE OR DELETE
  ON app.property_predator_whatsapp_live_receipts FOR EACH ROW
  EXECUTE FUNCTION app_private.whatsapp_live_immutable_guard();

CREATE FUNCTION app_private.whatsapp_live_job_identity_guard()
RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog AS $function$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.binding_id IS DISTINCT FROM OLD.binding_id
     OR NEW.template_id IS DISTINCT FROM OLD.template_id
     OR NEW.authority_id IS DISTINCT FROM OLD.authority_id
     OR NEW.provider_connection_id IS DISTINCT FROM OLD.provider_connection_id
     OR NEW.recipient_sha256 IS DISTINCT FROM OLD.recipient_sha256
     OR NEW.operation_id IS DISTINCT FROM OLD.operation_id
     OR NEW.idempotency_key_sha256 IS DISTINCT FROM OLD.idempotency_key_sha256
     OR NEW.request_sha256 IS DISTINCT FROM OLD.request_sha256
     OR NEW.utc_day IS DISTINCT FROM OLD.utc_day OR NEW.utc_month IS DISTINCT FROM OLD.utc_month
     OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Meta WhatsApp job identity evidence is immutable' USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END
$function$;
REVOKE ALL ON FUNCTION app_private.whatsapp_live_job_identity_guard() FROM PUBLIC;
CREATE TRIGGER whatsapp_live_jobs_identity_immutable BEFORE UPDATE
  ON app.property_predator_whatsapp_live_jobs FOR EACH ROW
  EXECUTE FUNCTION app_private.whatsapp_live_job_identity_guard();

ALTER TABLE app.property_predator_whatsapp_live_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.property_predator_whatsapp_live_bindings FORCE ROW LEVEL SECURITY;
ALTER TABLE app.property_predator_whatsapp_live_binding_revocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.property_predator_whatsapp_live_binding_revocations FORCE ROW LEVEL SECURITY;
ALTER TABLE app.property_predator_whatsapp_live_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.property_predator_whatsapp_live_templates FORCE ROW LEVEL SECURITY;
ALTER TABLE app.property_predator_whatsapp_live_authorities ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.property_predator_whatsapp_live_authorities FORCE ROW LEVEL SECURITY;
ALTER TABLE app.property_predator_whatsapp_live_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.property_predator_whatsapp_live_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE app.property_predator_whatsapp_live_job_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.property_predator_whatsapp_live_job_leases FORCE ROW LEVEL SECURITY;
ALTER TABLE app.property_predator_whatsapp_live_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.property_predator_whatsapp_live_receipts FORCE ROW LEVEL SECURITY;

CREATE POLICY whatsapp_live_bindings_owner_all ON app.property_predator_whatsapp_live_bindings
  FOR ALL TO r72_owner USING (true) WITH CHECK (true);
CREATE POLICY whatsapp_live_binding_revocations_owner_all
  ON app.property_predator_whatsapp_live_binding_revocations
  FOR ALL TO r72_owner USING (true) WITH CHECK (true);
CREATE POLICY whatsapp_live_templates_owner_all ON app.property_predator_whatsapp_live_templates
  FOR ALL TO r72_owner USING (true) WITH CHECK (true);
CREATE POLICY whatsapp_live_authorities_owner_all ON app.property_predator_whatsapp_live_authorities
  FOR ALL TO r72_owner USING (true) WITH CHECK (true);
CREATE POLICY whatsapp_live_jobs_owner_all ON app.property_predator_whatsapp_live_jobs
  FOR ALL TO r72_owner USING (true) WITH CHECK (true);
CREATE POLICY whatsapp_live_leases_owner_all ON app.property_predator_whatsapp_live_job_leases
  FOR ALL TO r72_owner USING (true) WITH CHECK (true);
CREATE POLICY whatsapp_live_receipts_owner_all ON app.property_predator_whatsapp_live_receipts
  FOR ALL TO r72_owner USING (true) WITH CHECK (true);

CREATE POLICY whatsapp_live_bindings_definer_all ON app.property_predator_whatsapp_live_bindings
  FOR ALL TO r72_whatsapp_live_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY whatsapp_live_binding_revocations_definer_all
  ON app.property_predator_whatsapp_live_binding_revocations
  FOR ALL TO r72_whatsapp_live_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY whatsapp_live_templates_definer_all ON app.property_predator_whatsapp_live_templates
  FOR ALL TO r72_whatsapp_live_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY whatsapp_live_authorities_definer_all ON app.property_predator_whatsapp_live_authorities
  FOR ALL TO r72_whatsapp_live_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY whatsapp_live_jobs_definer_all ON app.property_predator_whatsapp_live_jobs
  FOR ALL TO r72_whatsapp_live_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY whatsapp_live_leases_definer_all ON app.property_predator_whatsapp_live_job_leases
  FOR ALL TO r72_whatsapp_live_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY whatsapp_live_receipts_definer_all ON app.property_predator_whatsapp_live_receipts
  FOR ALL TO r72_whatsapp_live_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

GRANT SELECT, INSERT ON app.property_predator_whatsapp_live_bindings,
  app.property_predator_whatsapp_live_binding_revocations,
  app.property_predator_whatsapp_live_templates,
  app.property_predator_whatsapp_live_authorities TO r72_whatsapp_live_definer;
GRANT SELECT, INSERT, UPDATE ON app.property_predator_whatsapp_live_jobs
  TO r72_whatsapp_live_definer;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.property_predator_whatsapp_live_job_leases
  TO r72_whatsapp_live_definer;
GRANT SELECT, INSERT ON app.property_predator_whatsapp_live_receipts
  TO r72_whatsapp_live_definer;
GRANT SELECT ON app.provider_connections, app.workspace_memberships,
  app.contact_points, app.communication_consent_events,
  app.communication_suppression_events, app.company_content_versions,
  app.company_content_approval_requests, app.company_content_approval_decisions
  TO r72_whatsapp_live_definer;
GRANT SELECT ON app_private.affiliate_compliance_policy_review_events,
  app_private.affiliate_compliance_policy_publication_events,
  app_private.affiliate_compliance_specialist_decision_events,
  app_private.affiliate_compliance_permission_fact_events,
  app_private.affiliate_compliance_permission_use_receipts
  TO r72_whatsapp_live_definer;

-- Every forced-RLS dependency read by a WhatsApp SECURITY DEFINER function has
-- an exact, tenant-bound policy for this definer. Grants without these policies
-- would make the functions silently blind and therefore unusable.
CREATE POLICY provider_connections_whatsapp_live_definer_select
  ON app.provider_connections FOR SELECT TO r72_whatsapp_live_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY workspace_memberships_whatsapp_live_definer_select
  ON app.workspace_memberships FOR SELECT TO r72_whatsapp_live_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY contact_points_whatsapp_live_definer_select
  ON app.contact_points FOR SELECT TO r72_whatsapp_live_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY consent_events_whatsapp_live_definer_select
  ON app.communication_consent_events FOR SELECT TO r72_whatsapp_live_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY suppression_events_whatsapp_live_definer_select
  ON app.communication_suppression_events FOR SELECT TO r72_whatsapp_live_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY content_versions_whatsapp_live_definer_select
  ON app.company_content_versions FOR SELECT TO r72_whatsapp_live_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY content_approval_requests_whatsapp_live_definer_select
  ON app.company_content_approval_requests FOR SELECT TO r72_whatsapp_live_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY content_approval_decisions_whatsapp_live_definer_select
  ON app.company_content_approval_decisions FOR SELECT TO r72_whatsapp_live_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY affiliate_policy_reviews_whatsapp_live_definer_select
  ON app_private.affiliate_compliance_policy_review_events
  FOR SELECT TO r72_whatsapp_live_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY affiliate_policy_publications_whatsapp_live_definer_select
  ON app_private.affiliate_compliance_policy_publication_events
  FOR SELECT TO r72_whatsapp_live_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY affiliate_specialist_decisions_whatsapp_live_definer_select
  ON app_private.affiliate_compliance_specialist_decision_events
  FOR SELECT TO r72_whatsapp_live_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY affiliate_permission_facts_whatsapp_live_definer_select
  ON app_private.affiliate_compliance_permission_fact_events
  FOR SELECT TO r72_whatsapp_live_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY affiliate_permission_uses_whatsapp_live_definer_select
  ON app_private.affiliate_compliance_permission_use_receipts
  FOR SELECT TO r72_whatsapp_live_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
GRANT CREATE ON SCHEMA app_private TO r72_whatsapp_live_definer;
SET LOCAL ROLE r72_whatsapp_live_definer;

CREATE FUNCTION app_private.record_whatsapp_live_binding(
  p_workspace_id uuid, p_provider_connection_id uuid, p_binding_id uuid,
  p_app_id text, p_waba_id text, p_phone_number_id text, p_owned_phone_sha256 bytea,
  p_secret_key_version text, p_secret_iv bytea, p_secret_ciphertext bytea,
  p_secret_auth_tag bytea, p_secret_aad_sha256 bytea, p_secret_payload_sha256 bytea,
  p_ownership_evidence_sha256 bytea, p_ownership_observed_at timestamptz,
  p_predecessor_binding_id uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE selected_user uuid; selected_request text; expected_aad text;
  predecessor_revocation_kind text;
  predecessor app.property_predator_whatsapp_live_bindings%ROWTYPE;
BEGIN
  IF session_user <> 'r72_whatsapp_live_command'
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'user'
     OR current_setting('app.user_id', true) !~ '^[0-9a-f-]{36}$'
     OR coalesce(current_setting('app.request_id', true), '') = ''
     OR p_app_id !~ '^[1-9][0-9]{4,29}$' OR p_waba_id !~ '^[1-9][0-9]{4,29}$'
     OR p_phone_number_id !~ '^[1-9][0-9]{4,29}$'
     OR octet_length(p_owned_phone_sha256) <> 32 OR octet_length(p_secret_iv) <> 12
     OR octet_length(p_secret_ciphertext) NOT BETWEEN 38 AND 8192
     OR octet_length(p_secret_auth_tag) <> 16 OR octet_length(p_secret_aad_sha256) <> 32
     OR octet_length(p_secret_payload_sha256) <> 32
     OR octet_length(p_ownership_evidence_sha256) <> 32 THEN
    RAISE EXCEPTION 'WhatsApp live binding denied' USING ERRCODE = '42501';
  END IF;
  selected_user := current_setting('app.user_id')::uuid;
  selected_request := current_setting('app.request_id');
  expected_aad := format(
    '{"contract":"propertypredator.meta-whatsapp-live/v1","workspaceId":"%s","connectionId":"%s","appId":"%s","wabaId":"%s","phoneNumberId":"%s","graphApiVersion":"v24.0","providerId":"meta_whatsapp_cloud","channel":"whatsapp"}',
    p_workspace_id, p_provider_connection_id, p_app_id, p_waba_id, p_phone_number_id
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    format('pp-whatsapp-binding:%s:%s:%s:%s',
      p_workspace_id, p_provider_connection_id, p_waba_id, p_phone_number_id), 0
  ));
  IF p_secret_aad_sha256 <> public.digest(expected_aad, 'sha256')
     OR p_ownership_observed_at > statement_timestamp() + interval '5 minutes'
     OR NOT EXISTS (
       SELECT 1 FROM app.workspace_memberships AS membership
       WHERE membership.workspace_id = p_workspace_id AND membership.user_id = selected_user
         AND membership.status = 'active' AND membership.role IN ('owner', 'admin')
     ) OR NOT EXISTS (
       SELECT 1 FROM app.provider_connections AS connection
       WHERE connection.workspace_id = p_workspace_id AND connection.id = p_provider_connection_id
         AND connection.provider_id = 'meta_whatsapp_cloud'
         AND connection.provider_kind = 'messaging'
         AND connection.environment = 'live' AND connection.status = 'active'
     ) THEN RAISE EXCEPTION 'WhatsApp live binding evidence denied' USING ERRCODE = '42501'; END IF;
  IF p_predecessor_binding_id IS NULL THEN
    IF EXISTS (
      SELECT 1 FROM app.property_predator_whatsapp_live_bindings AS existing
      WHERE existing.workspace_id = p_workspace_id
        AND existing.provider_connection_id = p_provider_connection_id
        AND existing.waba_id = p_waba_id AND existing.phone_number_id = p_phone_number_id
    ) THEN
      RAISE EXCEPTION 'WhatsApp live binding successor is required' USING ERRCODE = '40001';
    END IF;
  ELSE
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      format('pp-whatsapp-call-fence:%s:%s', p_workspace_id, p_predecessor_binding_id), 0
    ));
    SELECT binding.* INTO predecessor
    FROM app.property_predator_whatsapp_live_bindings AS binding
    WHERE binding.workspace_id = p_workspace_id AND binding.id = p_predecessor_binding_id
      AND binding.provider_connection_id = p_provider_connection_id
      AND binding.app_id = p_app_id AND binding.waba_id = p_waba_id
      AND binding.phone_number_id = p_phone_number_id
      AND binding.owned_phone_sha256 = p_owned_phone_sha256
    FOR UPDATE OF binding;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'WhatsApp live binding rotation denied' USING ERRCODE = '42501';
    END IF;
    SELECT revocation.revocation_kind INTO predecessor_revocation_kind
    FROM app.property_predator_whatsapp_live_binding_revocations AS revocation
    WHERE revocation.workspace_id = p_workspace_id
      AND revocation.binding_id = p_predecessor_binding_id;
    IF (
      predecessor.secret_key_version = p_secret_key_version
      AND predecessor.secret_payload_sha256 = p_secret_payload_sha256
    ) OR predecessor_revocation_kind = 'superseded' THEN
      RAISE EXCEPTION 'WhatsApp live binding rotation denied' USING ERRCODE = '42501';
    END IF;
  END IF;
  INSERT INTO app.property_predator_whatsapp_live_bindings (
    id, workspace_id, predecessor_binding_id, provider_connection_id,
    environment, provider_id, app_id, waba_id,
    phone_number_id, owned_phone_sha256, graph_api_version, secret_algorithm,
    secret_key_version, secret_iv, secret_ciphertext, secret_auth_tag, secret_aad_sha256,
    secret_payload_sha256, ownership_evidence_sha256, ownership_observed_at,
    created_by_user_id
  ) VALUES (
    p_binding_id, p_workspace_id, p_predecessor_binding_id,
    p_provider_connection_id, 'live', 'meta_whatsapp_cloud',
    p_app_id, p_waba_id, p_phone_number_id, p_owned_phone_sha256, 'v24.0',
    'aes-256-gcm-v1', p_secret_key_version, p_secret_iv, p_secret_ciphertext,
    p_secret_auth_tag, p_secret_aad_sha256, p_secret_payload_sha256,
    p_ownership_evidence_sha256, p_ownership_observed_at, selected_user
  );
  IF p_predecessor_binding_id IS NOT NULL AND predecessor_revocation_kind IS NULL THEN
    INSERT INTO app.property_predator_whatsapp_live_binding_revocations (
      workspace_id, binding_id, revocation_kind, successor_binding_id,
      evidence_sha256, recorded_by_user_id, recorded_request_id
    ) VALUES (
      p_workspace_id, p_predecessor_binding_id, 'superseded', p_binding_id,
      p_ownership_evidence_sha256, selected_user, selected_request
    );
    INSERT INTO app.property_predator_whatsapp_live_receipts (
      workspace_id, job_id, binding_id, external_event_id, event_kind,
      provider_message_id, recipient_or_sender_sha256, body_sha256,
      payload_sha256, safe_code, provider_occurred_at
    ) SELECT job.workspace_id, job.id, job.binding_id,
        format('binding-superseded:%s:%s', job.id, job.lease_version),
        'outcome_unknown', job.provider_message_id, job.recipient_sha256, NULL,
        p_ownership_evidence_sha256,
        'meta_whatsapp_binding_superseded_during_call', statement_timestamp()
      FROM app.property_predator_whatsapp_live_jobs AS job
      WHERE job.workspace_id = p_workspace_id
        AND job.binding_id = p_predecessor_binding_id
        AND job.state IN ('calling', 'awaiting_status')
    ON CONFLICT (workspace_id, binding_id, external_event_id) DO NOTHING;
    UPDATE app.property_predator_whatsapp_live_jobs SET
      state = CASE WHEN state IN ('queued', 'leased') THEN 'cancelled' ELSE 'needs_attention' END,
      lease_expires_at = NULL, status_deadline = NULL, settled_at = statement_timestamp(),
      updated_at = statement_timestamp()
    WHERE workspace_id = p_workspace_id AND binding_id = p_predecessor_binding_id
      AND state IN ('queued', 'leased', 'calling', 'awaiting_status');
    DELETE FROM app.property_predator_whatsapp_live_job_leases AS lease
    USING app.property_predator_whatsapp_live_jobs AS job
    WHERE lease.workspace_id = job.workspace_id AND lease.job_id = job.id
      AND job.workspace_id = p_workspace_id
      AND job.binding_id = p_predecessor_binding_id;
  END IF;
  RETURN p_binding_id;
END
$function$;

CREATE FUNCTION app_private.revoke_whatsapp_live_binding(
  p_workspace_id uuid, p_binding_id uuid, p_evidence_sha256 bytea
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE selected_user uuid; selected_request text; selected_connection uuid;
  selected_waba text; selected_phone text; revocation_id uuid := gen_random_uuid();
BEGIN
  IF session_user <> 'r72_whatsapp_live_command'
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'user'
     OR current_setting('app.user_id', true) !~ '^[0-9a-f-]{36}$'
     OR coalesce(current_setting('app.request_id', true), '') = ''
     OR octet_length(p_evidence_sha256) <> 32 THEN
    RAISE EXCEPTION 'WhatsApp live revocation denied' USING ERRCODE = '42501';
  END IF;
  selected_user := current_setting('app.user_id')::uuid;
  selected_request := current_setting('app.request_id');
  IF NOT EXISTS (
    SELECT 1 FROM app.workspace_memberships AS membership
    WHERE membership.workspace_id = p_workspace_id AND membership.user_id = selected_user
      AND membership.status = 'active' AND membership.role IN ('owner', 'admin')
  ) THEN RAISE EXCEPTION 'WhatsApp live revocation authority denied' USING ERRCODE = '42501'; END IF;
  SELECT binding.provider_connection_id, binding.waba_id, binding.phone_number_id
    INTO selected_connection, selected_waba, selected_phone
  FROM app.property_predator_whatsapp_live_bindings AS binding
  WHERE binding.workspace_id = p_workspace_id AND binding.id = p_binding_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'WhatsApp live binding not found' USING ERRCODE = '42501'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    format('pp-whatsapp-binding:%s:%s:%s:%s',
      p_workspace_id, selected_connection, selected_waba, selected_phone), 0
  ));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    format('pp-whatsapp-call-fence:%s:%s', p_workspace_id, p_binding_id), 0
  ));
  PERFORM 1 FROM app.property_predator_whatsapp_live_bindings AS binding
  WHERE binding.workspace_id = p_workspace_id AND binding.id = p_binding_id
  FOR UPDATE OF binding;
  INSERT INTO app.property_predator_whatsapp_live_binding_revocations (
    id, workspace_id, binding_id, revocation_kind, successor_binding_id,
    evidence_sha256, recorded_by_user_id, recorded_request_id
  ) VALUES (
    revocation_id, p_workspace_id, p_binding_id, 'revoked', NULL,
    p_evidence_sha256, selected_user, selected_request
  );
  INSERT INTO app.property_predator_whatsapp_live_receipts (
    workspace_id, job_id, binding_id, external_event_id, event_kind,
    provider_message_id, recipient_or_sender_sha256, body_sha256,
    payload_sha256, safe_code, provider_occurred_at
  ) SELECT job.workspace_id, job.id, job.binding_id,
      format('binding-revoked:%s:%s', job.id, job.lease_version),
      'outcome_unknown', job.provider_message_id, job.recipient_sha256, NULL,
      p_evidence_sha256, 'meta_whatsapp_binding_revoked_during_call', statement_timestamp()
    FROM app.property_predator_whatsapp_live_jobs AS job
    WHERE job.workspace_id = p_workspace_id AND job.binding_id = p_binding_id
      AND job.state IN ('calling', 'awaiting_status')
  ON CONFLICT (workspace_id, binding_id, external_event_id) DO NOTHING;
  UPDATE app.property_predator_whatsapp_live_jobs SET
    state = CASE WHEN state IN ('queued', 'leased') THEN 'cancelled' ELSE 'needs_attention' END,
    lease_expires_at = NULL, status_deadline = NULL, settled_at = statement_timestamp(),
    updated_at = statement_timestamp()
  WHERE workspace_id = p_workspace_id AND binding_id = p_binding_id
    AND state IN ('queued', 'leased', 'calling', 'awaiting_status');
  DELETE FROM app.property_predator_whatsapp_live_job_leases AS lease
  USING app.property_predator_whatsapp_live_jobs AS job
  WHERE lease.workspace_id = job.workspace_id AND lease.job_id = job.id
    AND job.workspace_id = p_workspace_id AND job.binding_id = p_binding_id;
  RETURN revocation_id;
END
$function$;

CREATE FUNCTION app_private.record_whatsapp_live_template(
  p_workspace_id uuid, p_binding_id uuid, p_template_id uuid,
  p_content_item_id uuid, p_content_version_id uuid,
  p_approval_request_id uuid, p_approval_decision_id uuid,
  p_template_name text, p_template_ref_sha256 bytea, p_language_code text,
  p_category text, p_provider_approval_evidence_sha256 bytea,
  p_provider_approved_at timestamptz
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE selected_user uuid; selected_connection uuid; selected_hash bytea;
BEGIN
  IF session_user <> 'r72_whatsapp_live_command'
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'user'
     OR current_setting('app.user_id', true) !~ '^[0-9a-f-]{36}$'
     OR coalesce(current_setting('app.request_id', true), '') = ''
     OR p_template_name !~ '^[a-z][a-z0-9_]{0,511}$'
     OR p_language_code !~ '^[a-z]{2,3}(_[A-Z]{2})?$'
     OR p_category NOT IN ('utility', 'marketing')
     OR octet_length(p_template_ref_sha256) <> 32
     OR octet_length(p_provider_approval_evidence_sha256) <> 32
     OR p_provider_approved_at > statement_timestamp() + interval '5 minutes' THEN
    RAISE EXCEPTION 'WhatsApp live template denied' USING ERRCODE = '42501';
  END IF;
  selected_user := current_setting('app.user_id')::uuid;
  SELECT binding.provider_connection_id INTO selected_connection
  FROM app.property_predator_whatsapp_live_bindings AS binding
  JOIN app.provider_connections AS connection
    ON connection.workspace_id = binding.workspace_id
   AND connection.id = binding.provider_connection_id
   AND connection.provider_id = 'meta_whatsapp_cloud'
   AND connection.provider_kind = 'messaging'
   AND connection.environment = 'live' AND connection.status = 'active'
  WHERE binding.workspace_id = p_workspace_id AND binding.id = p_binding_id
    AND binding.status = 'active'
    AND NOT EXISTS (
      SELECT 1 FROM app.property_predator_whatsapp_live_binding_revocations AS revocation
      WHERE revocation.workspace_id = binding.workspace_id
        AND revocation.binding_id = binding.id
    );
  SELECT version.content_sha256 INTO selected_hash
  FROM app.company_content_versions AS version
  JOIN app.company_content_approval_requests AS request
    ON request.workspace_id = version.workspace_id
   AND request.content_item_id = version.content_item_id
   AND request.content_version_id = version.id
   AND request.content_sha256 = version.content_sha256 AND request.id = p_approval_request_id
  JOIN app.company_content_approval_decisions AS decision
    ON decision.workspace_id = request.workspace_id
   AND decision.approval_request_id = request.id AND decision.id = p_approval_decision_id
   AND decision.decision = 'approved'
  WHERE version.workspace_id = p_workspace_id AND version.content_item_id = p_content_item_id
    AND version.id = p_content_version_id AND version.content_kind IN ('other', 'document')
    AND public.digest(version.content_body, 'sha256') = version.content_sha256
    AND NOT EXISTS (
      SELECT 1 FROM app.company_content_versions AS newer
      WHERE newer.workspace_id = version.workspace_id
        AND newer.content_item_id = version.content_item_id
        AND newer.version_number > version.version_number
    );
  IF selected_connection IS NULL OR selected_hash IS NULL OR NOT EXISTS (
    SELECT 1 FROM app.workspace_memberships AS membership
    WHERE membership.workspace_id = p_workspace_id AND membership.user_id = selected_user
      AND membership.status = 'active' AND membership.role IN ('owner', 'admin')
  ) THEN RAISE EXCEPTION 'WhatsApp live template evidence denied' USING ERRCODE = '42501'; END IF;
  INSERT INTO app.property_predator_whatsapp_live_templates (
    id, workspace_id, binding_id, provider_connection_id, content_item_id,
    content_version_id, content_sha256, approval_request_id, approval_decision_id,
    provider_template_name, provider_template_ref_sha256, language_code, category,
    parameter_count, provider_status, provider_approval_evidence_sha256,
    provider_approved_at, created_by_user_id
  ) VALUES (
    p_template_id, p_workspace_id, p_binding_id, selected_connection, p_content_item_id,
    p_content_version_id, selected_hash, p_approval_request_id, p_approval_decision_id,
    p_template_name, p_template_ref_sha256, p_language_code, p_category, 0, 'approved',
    p_provider_approval_evidence_sha256, p_provider_approved_at, selected_user
  );
  RETURN p_template_id;
END
$function$;

CREATE FUNCTION app_private.authorize_and_enqueue_whatsapp_live_job(
  p_workspace_id uuid, p_binding_id uuid, p_template_id uuid,
  p_contact_id uuid, p_contact_point_id uuid, p_consent_event_id uuid,
  p_compliance_subject_id uuid, p_policy_publication_event_id uuid,
  p_pecr_sender_decision_event_id uuid, p_pecr_instigator_decision_event_id uuid,
  p_permission_use_receipt_id uuid, p_purpose text,
  p_authority_valid_until timestamptz, p_operation_id uuid,
  p_idempotency_key_sha256 bytea, p_request_sha256 bytea
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE selected_user uuid; selected_request text; selected_connection uuid;
  selected_recipient text; selected_recipient_sha bytea; authority_id uuid := gen_random_uuid();
  selected_id uuid := gen_random_uuid(); existing record; expected_endpoint_sha bytea;
  expected_action_scope bytea; selected_pecr_sha bytea; selected_instigator_sha bytea;
BEGIN
  IF session_user <> 'r72_whatsapp_live_command'
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'user'
     OR current_setting('app.user_id', true) !~ '^[0-9a-f-]{36}$'
     OR coalesce(current_setting('app.request_id', true), '') = ''
     OR octet_length(p_idempotency_key_sha256) <> 32
     OR octet_length(p_request_sha256) <> 32
     OR p_purpose !~ '^[a-z][a-z0-9_.-]{0,99}$'
     OR p_authority_valid_until <= statement_timestamp()
     OR p_authority_valid_until > statement_timestamp() + interval '15 minutes' THEN
    RAISE EXCEPTION 'WhatsApp live enqueue denied' USING ERRCODE = '42501';
  END IF;
  selected_user := current_setting('app.user_id')::uuid;
  selected_request := current_setting('app.request_id');
  -- Serialize all cap/idempotency decisions for the one owned number. The
  -- partial daily unique index is a second fail-closed concurrency fence.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    format('pp-whatsapp-live:%s:%s', p_workspace_id, p_binding_id), 0
  ));
  SELECT job.id, job.request_sha256 INTO existing
  FROM app.property_predator_whatsapp_live_jobs AS job
  WHERE job.workspace_id = p_workspace_id AND job.idempotency_key_sha256 = p_idempotency_key_sha256;
  IF FOUND THEN
    IF existing.request_sha256 <> p_request_sha256 THEN
      RAISE EXCEPTION 'WhatsApp live idempotency conflict' USING ERRCODE = '40001';
    END IF;
    RETURN existing.id;
  END IF;
  SELECT template.provider_connection_id INTO selected_connection
  FROM app.property_predator_whatsapp_live_templates AS template
  JOIN app.property_predator_whatsapp_live_bindings AS binding
    ON binding.workspace_id = template.workspace_id AND binding.id = template.binding_id
   AND binding.provider_connection_id = template.provider_connection_id
   AND binding.status = 'active'
  JOIN app.provider_connections AS connection
    ON connection.workspace_id = binding.workspace_id
   AND connection.id = binding.provider_connection_id
   AND connection.provider_id = 'meta_whatsapp_cloud'
   AND connection.provider_kind = 'messaging'
   AND connection.environment = 'live' AND connection.status = 'active'
  WHERE template.workspace_id = p_workspace_id AND template.id = p_template_id
    AND template.binding_id = p_binding_id AND template.provider_status = 'approved'
    AND template.parameter_count = 0
    AND NOT EXISTS (
      SELECT 1 FROM app.property_predator_whatsapp_live_binding_revocations AS revocation
      WHERE revocation.workspace_id = binding.workspace_id
        AND revocation.binding_id = binding.id
    );
  SELECT regexp_replace(point.normalized_value, '^\\+', ''),
    public.digest(regexp_replace(point.normalized_value, '^\\+', ''), 'sha256'),
    public.digest(point.kind || pg_catalog.chr(31) || point.value
      || pg_catalog.chr(31) || point.normalized_value, 'sha256')
  INTO selected_recipient, selected_recipient_sha, expected_endpoint_sha
  FROM app.contact_points AS point
  WHERE point.workspace_id = p_workspace_id AND point.id = p_contact_point_id
    AND point.contact_id = p_contact_id AND point.kind = 'whatsapp'
    AND point.is_verified AND point.dedupe_state = 'normal' AND point.deleted_at IS NULL
    AND regexp_replace(point.normalized_value, '^\\+', '') ~ '^[1-9][0-9]{6,14}$';
  expected_action_scope := public.digest(format('whatsapp:%s:%s:%s:%s:%s:%s',
    p_workspace_id, p_binding_id, p_template_id,
    encode(selected_recipient_sha, 'hex'), p_purpose, p_consent_event_id), 'sha256');
  IF selected_connection IS NULL OR selected_recipient IS NULL OR NOT EXISTS (
    SELECT 1 FROM app.workspace_memberships AS membership
    WHERE membership.workspace_id = p_workspace_id AND membership.user_id = selected_user
      AND membership.status = 'active' AND membership.role IN ('owner', 'admin')
  ) OR NOT EXISTS (
    SELECT 1 FROM app.communication_consent_events AS consent
    WHERE consent.workspace_id = p_workspace_id AND consent.id = p_consent_event_id
      AND consent.contact_id = p_contact_id AND consent.contact_point_id = p_contact_point_id
      AND consent.channel = 'whatsapp' AND consent.purpose = p_purpose
      AND consent.state = 'granted' AND consent.endpoint_identity_sha256 = expected_endpoint_sha
      AND consent.id = (
        SELECT latest.id FROM app.communication_consent_events AS latest
        WHERE latest.workspace_id = p_workspace_id
          AND latest.contact_point_id = p_contact_point_id
          AND latest.channel = 'whatsapp' AND latest.purpose = p_purpose
        ORDER BY latest.occurred_at DESC, latest.recorded_at DESC, latest.id DESC LIMIT 1
      )
  ) OR EXISTS (
    SELECT 1 FROM app.communication_suppression_events AS suppression
    WHERE suppression.workspace_id = p_workspace_id
      AND suppression.contact_point_id = p_contact_point_id
      AND suppression.channel = 'whatsapp'
      AND (suppression.purpose IS NULL OR suppression.purpose = p_purpose)
      AND suppression.endpoint_identity_sha256 = expected_endpoint_sha
      AND suppression.state = 'suppressed'
      AND suppression.id = (
        SELECT latest.id FROM app.communication_suppression_events AS latest
        WHERE latest.workspace_id = p_workspace_id
          AND latest.contact_point_id = p_contact_point_id
          AND latest.channel = 'whatsapp'
          AND latest.purpose IS NOT DISTINCT FROM suppression.purpose
        ORDER BY latest.occurred_at DESC, latest.recorded_at DESC, latest.id DESC LIMIT 1
      )
  ) THEN RAISE EXCEPTION 'WhatsApp live consent/PECR authority denied' USING ERRCODE = '42501'; END IF;
  SELECT sender_route.decision_sha256, instigator_route.decision_sha256
    INTO selected_pecr_sha, selected_instigator_sha
  FROM app_private.affiliate_compliance_policy_publication_events AS publication
  JOIN app_private.affiliate_compliance_policy_review_events AS legal_review
    ON legal_review.workspace_id = publication.workspace_id
   AND legal_review.id = publication.legal_review_event_id
   AND legal_review.policy_pack_id = publication.policy_pack_id
   AND legal_review.bundle_sha256 = publication.bundle_sha256
   AND legal_review.review_dimension = 'legal' AND legal_review.decision = 'approved'
  JOIN app_private.affiliate_compliance_policy_review_events AS commercial_review
    ON commercial_review.workspace_id = publication.workspace_id
   AND commercial_review.id = publication.commercial_review_event_id
   AND commercial_review.policy_pack_id = publication.policy_pack_id
   AND commercial_review.bundle_sha256 = publication.bundle_sha256
   AND commercial_review.review_dimension = 'commercial' AND commercial_review.decision = 'approved'
  JOIN app_private.affiliate_compliance_specialist_decision_events AS sender_route
    ON sender_route.workspace_id = publication.workspace_id
   AND sender_route.subject_id = p_compliance_subject_id
   AND sender_route.id = p_pecr_sender_decision_event_id
   AND sender_route.decision_kind = 'pecr_sender_route'
   AND sender_route.decision_state = 'approved'
   AND sender_route.action_scope_sha256 = expected_action_scope
  JOIN app_private.affiliate_compliance_specialist_decision_events AS instigator_route
    ON instigator_route.workspace_id = publication.workspace_id
   AND instigator_route.subject_id = p_compliance_subject_id
   AND instigator_route.id = p_pecr_instigator_decision_event_id
   AND instigator_route.decision_kind = 'pecr_instigator_route'
   AND instigator_route.decision_state = 'approved'
   AND instigator_route.action_scope_sha256 = expected_action_scope
  JOIN app_private.affiliate_compliance_permission_use_receipts AS permission_use
    ON permission_use.workspace_id = publication.workspace_id
   AND permission_use.subject_id = p_compliance_subject_id
   AND permission_use.id = p_permission_use_receipt_id
   AND permission_use.permission = 'whatsapp.send'
   AND permission_use.action_scope_sha256 = expected_action_scope
   AND permission_use.eligibility_decision = 'allow'
   AND permission_use.use_state = 'consumed'
   AND permission_use.provider_effects IS FALSE
  WHERE publication.workspace_id = p_workspace_id
    AND publication.id = p_policy_publication_event_id
    AND publication.publication_state = 'published'
    AND publication.effective_at <= statement_timestamp()
    AND (publication.expires_at IS NULL OR publication.expires_at >= p_authority_valid_until)
    AND sender_route.valid_from <= statement_timestamp()
    AND (sender_route.valid_until IS NULL OR sender_route.valid_until >= p_authority_valid_until)
    AND instigator_route.valid_from <= statement_timestamp()
    AND (instigator_route.valid_until IS NULL OR instigator_route.valid_until >= p_authority_valid_until)
    AND permission_use.recorded_by_user_id = selected_user
    AND permission_use.recorded_request_id = selected_request
    AND permission_use.consumed_at <= statement_timestamp()
    AND permission_use.decision_expires_at >= p_authority_valid_until
    AND NOT EXISTS (
      SELECT 1 FROM app_private.affiliate_compliance_policy_publication_events AS successor
      WHERE successor.workspace_id = publication.workspace_id
        AND successor.policy_pack_id = publication.policy_pack_id
        AND successor.supersedes_event_id = publication.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM app_private.affiliate_compliance_policy_review_events AS successor
      WHERE successor.workspace_id = legal_review.workspace_id
        AND successor.policy_pack_id = legal_review.policy_pack_id
        AND successor.review_dimension = legal_review.review_dimension
        AND successor.supersedes_event_id = legal_review.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM app_private.affiliate_compliance_policy_review_events AS successor
      WHERE successor.workspace_id = commercial_review.workspace_id
        AND successor.policy_pack_id = commercial_review.policy_pack_id
        AND successor.review_dimension = commercial_review.review_dimension
        AND successor.supersedes_event_id = commercial_review.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM app_private.affiliate_compliance_specialist_decision_events AS successor
      WHERE successor.workspace_id = sender_route.workspace_id
        AND successor.subject_id = sender_route.subject_id
        AND successor.decision_kind = sender_route.decision_kind
        AND successor.supersedes_event_id = sender_route.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM app_private.affiliate_compliance_specialist_decision_events AS successor
      WHERE successor.workspace_id = instigator_route.workspace_id
        AND successor.subject_id = instigator_route.subject_id
        AND successor.decision_kind = instigator_route.decision_kind
        AND successor.supersedes_event_id = instigator_route.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM app_private.affiliate_compliance_permission_fact_events AS block
      WHERE block.workspace_id = permission_use.workspace_id
        AND block.subject_id = permission_use.subject_id
        AND block.permission = 'whatsapp.send'
        AND block.action_scope_sha256 = expected_action_scope
        AND block.permission_state IN ('blocked', 'revoked', 'expired')
        AND block.valid_from <= statement_timestamp()
        AND (block.valid_until IS NULL OR block.valid_until > statement_timestamp())
        AND NOT EXISTS (
          SELECT 1 FROM app_private.affiliate_compliance_permission_fact_events AS successor
          WHERE successor.workspace_id = block.workspace_id
            AND successor.subject_id = block.subject_id
            AND successor.permission = block.permission
            AND successor.action_scope_sha256 = block.action_scope_sha256
            AND successor.supersedes_event_id = block.id
        )
    );
  IF selected_pecr_sha IS NULL OR selected_instigator_sha IS NULL THEN
    RAISE EXCEPTION 'WhatsApp live durable legal/operator evidence denied' USING ERRCODE = '42501';
  END IF;
  IF (SELECT count(*) FROM app.property_predator_whatsapp_live_jobs AS job
      WHERE job.workspace_id = p_workspace_id AND job.binding_id = p_binding_id
        AND job.utc_day = (statement_timestamp() AT TIME ZONE 'UTC')::date
        AND job.state <> 'cancelled') >= 1
     OR (SELECT count(*) FROM app.property_predator_whatsapp_live_jobs AS job
      WHERE job.workspace_id = p_workspace_id AND job.binding_id = p_binding_id
        AND job.utc_month = date_trunc('month', statement_timestamp() AT TIME ZONE 'UTC')::date
        AND job.state <> 'cancelled') >= 3 THEN
    RAISE EXCEPTION 'WhatsApp live hard send cap reached' USING ERRCODE = '42501';
  END IF;
  INSERT INTO app.property_predator_whatsapp_live_authorities (
    id, workspace_id, binding_id, template_id, provider_connection_id,
    contact_id, contact_point_id, recipient_sha256, purpose, consent_event_id,
    compliance_subject_id, policy_publication_event_id,
    pecr_sender_decision_event_id, pecr_instigator_decision_event_id,
    permission_use_receipt_id,
    pecr_decision, pecr_evidence_sha256, operator_instigator_decision,
    operator_instigator_sha256, action_scope_sha256, operator_user_id,
    operator_request_id, evaluated_at, valid_until
  ) VALUES (
    authority_id, p_workspace_id, p_binding_id, p_template_id, selected_connection,
    p_contact_id, p_contact_point_id, selected_recipient_sha, p_purpose, p_consent_event_id,
    p_compliance_subject_id, p_policy_publication_event_id,
    p_pecr_sender_decision_event_id, p_pecr_instigator_decision_event_id,
    p_permission_use_receipt_id,
    'eligible', selected_pecr_sha, 'eligible', selected_instigator_sha,
    expected_action_scope,
    selected_user, selected_request, statement_timestamp(), p_authority_valid_until
  );
  INSERT INTO app.property_predator_whatsapp_live_jobs (
    id, workspace_id, binding_id, template_id, authority_id, provider_connection_id,
    recipient_sha256, operation_id, idempotency_key_sha256, request_sha256,
    utc_day, utc_month, created_by_user_id
  ) VALUES (
    selected_id, p_workspace_id, p_binding_id, p_template_id, authority_id,
    selected_connection, selected_recipient_sha, p_operation_id,
    p_idempotency_key_sha256, p_request_sha256,
    (statement_timestamp() AT TIME ZONE 'UTC')::date,
    date_trunc('month', statement_timestamp() AT TIME ZONE 'UTC')::date, selected_user
  );
  RETURN selected_id;
END
$function$;

CREATE FUNCTION app_private.whatsapp_live_authority_is_current(
  p_workspace_id uuid, p_authority_id uuid, p_provider_connection_id uuid
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM app.property_predator_whatsapp_live_authorities AS authority
    JOIN app.property_predator_whatsapp_live_bindings AS binding
      ON binding.workspace_id = authority.workspace_id AND binding.id = authority.binding_id
     AND binding.provider_connection_id = authority.provider_connection_id
    JOIN app.provider_connections AS connection
      ON connection.workspace_id = authority.workspace_id
     AND connection.id = authority.provider_connection_id
     AND connection.provider_id = 'meta_whatsapp_cloud'
     AND connection.provider_kind = 'messaging'
     AND connection.environment = 'live' AND connection.status = 'active'
    JOIN app.property_predator_whatsapp_live_templates AS template
      ON template.workspace_id = authority.workspace_id AND template.id = authority.template_id
     AND template.binding_id = authority.binding_id
     AND template.provider_connection_id = authority.provider_connection_id
     AND template.provider_status = 'approved' AND template.parameter_count = 0
    JOIN app_private.affiliate_compliance_policy_publication_events AS publication
      ON publication.workspace_id = authority.workspace_id
     AND publication.id = authority.policy_publication_event_id
     AND publication.publication_state = 'published'
    JOIN app_private.affiliate_compliance_policy_review_events AS legal_review
      ON legal_review.workspace_id = publication.workspace_id
     AND legal_review.id = publication.legal_review_event_id
     AND legal_review.policy_pack_id = publication.policy_pack_id
     AND legal_review.bundle_sha256 = publication.bundle_sha256
     AND legal_review.review_dimension = 'legal' AND legal_review.decision = 'approved'
    JOIN app_private.affiliate_compliance_policy_review_events AS commercial_review
      ON commercial_review.workspace_id = publication.workspace_id
     AND commercial_review.id = publication.commercial_review_event_id
     AND commercial_review.policy_pack_id = publication.policy_pack_id
     AND commercial_review.bundle_sha256 = publication.bundle_sha256
     AND commercial_review.review_dimension = 'commercial'
     AND commercial_review.decision = 'approved'
    JOIN app_private.affiliate_compliance_specialist_decision_events AS sender_route
      ON sender_route.workspace_id = authority.workspace_id
     AND sender_route.subject_id = authority.compliance_subject_id
     AND sender_route.id = authority.pecr_sender_decision_event_id
     AND sender_route.decision_kind = 'pecr_sender_route'
     AND sender_route.decision_state = 'approved'
     AND sender_route.action_scope_sha256 = authority.action_scope_sha256
     AND sender_route.decision_sha256 = authority.pecr_evidence_sha256
    JOIN app_private.affiliate_compliance_specialist_decision_events AS instigator_route
      ON instigator_route.workspace_id = authority.workspace_id
     AND instigator_route.subject_id = authority.compliance_subject_id
     AND instigator_route.id = authority.pecr_instigator_decision_event_id
     AND instigator_route.decision_kind = 'pecr_instigator_route'
     AND instigator_route.decision_state = 'approved'
     AND instigator_route.action_scope_sha256 = authority.action_scope_sha256
     AND instigator_route.decision_sha256 = authority.operator_instigator_sha256
    JOIN app_private.affiliate_compliance_permission_use_receipts AS permission_use
      ON permission_use.workspace_id = authority.workspace_id
     AND permission_use.subject_id = authority.compliance_subject_id
     AND permission_use.id = authority.permission_use_receipt_id
     AND permission_use.permission = 'whatsapp.send'
     AND permission_use.action_scope_sha256 = authority.action_scope_sha256
     AND permission_use.eligibility_decision = 'allow'
     AND permission_use.use_state = 'consumed' AND permission_use.provider_effects IS FALSE
     AND permission_use.recorded_by_user_id = authority.operator_user_id
     AND permission_use.recorded_request_id = authority.operator_request_id
    JOIN app.workspace_memberships AS operator_membership
      ON operator_membership.workspace_id = authority.workspace_id
     AND operator_membership.user_id = authority.operator_user_id
     AND operator_membership.status = 'active'
     AND operator_membership.role IN ('owner', 'admin')
    WHERE authority.workspace_id = p_workspace_id AND authority.id = p_authority_id
      AND authority.provider_connection_id = p_provider_connection_id
      AND authority.valid_until > statement_timestamp()
      AND binding.status = 'active'
      AND publication.effective_at <= statement_timestamp()
      AND (publication.expires_at IS NULL OR publication.expires_at > statement_timestamp())
      AND sender_route.valid_from <= statement_timestamp()
      AND (sender_route.valid_until IS NULL OR sender_route.valid_until > statement_timestamp())
      AND instigator_route.valid_from <= statement_timestamp()
      AND (instigator_route.valid_until IS NULL OR instigator_route.valid_until > statement_timestamp())
      AND permission_use.consumed_at <= statement_timestamp()
      AND permission_use.decision_expires_at > statement_timestamp()
      AND NOT EXISTS (
        SELECT 1 FROM app.property_predator_whatsapp_live_binding_revocations AS revocation
        WHERE revocation.workspace_id = binding.workspace_id
          AND revocation.binding_id = binding.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM app_private.affiliate_compliance_policy_publication_events AS successor
        WHERE successor.workspace_id = publication.workspace_id
          AND successor.policy_pack_id = publication.policy_pack_id
          AND successor.supersedes_event_id = publication.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM app_private.affiliate_compliance_policy_review_events AS successor
        WHERE successor.workspace_id = legal_review.workspace_id
          AND successor.policy_pack_id = legal_review.policy_pack_id
          AND successor.review_dimension = legal_review.review_dimension
          AND successor.supersedes_event_id = legal_review.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM app_private.affiliate_compliance_policy_review_events AS successor
        WHERE successor.workspace_id = commercial_review.workspace_id
          AND successor.policy_pack_id = commercial_review.policy_pack_id
          AND successor.review_dimension = commercial_review.review_dimension
          AND successor.supersedes_event_id = commercial_review.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM app_private.affiliate_compliance_specialist_decision_events AS successor
        WHERE successor.workspace_id = sender_route.workspace_id
          AND successor.subject_id = sender_route.subject_id
          AND successor.decision_kind = sender_route.decision_kind
          AND successor.supersedes_event_id = sender_route.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM app_private.affiliate_compliance_specialist_decision_events AS successor
        WHERE successor.workspace_id = instigator_route.workspace_id
          AND successor.subject_id = instigator_route.subject_id
          AND successor.decision_kind = instigator_route.decision_kind
          AND successor.supersedes_event_id = instigator_route.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM app_private.affiliate_compliance_permission_fact_events AS block
        WHERE block.workspace_id = permission_use.workspace_id
          AND block.subject_id = permission_use.subject_id
          AND block.permission = 'whatsapp.send'
          AND block.action_scope_sha256 = authority.action_scope_sha256
          AND block.permission_state IN ('blocked', 'revoked', 'expired')
          AND block.valid_from <= statement_timestamp()
          AND (block.valid_until IS NULL OR block.valid_until > statement_timestamp())
          AND NOT EXISTS (
            SELECT 1 FROM app_private.affiliate_compliance_permission_fact_events AS successor
            WHERE successor.workspace_id = block.workspace_id
              AND successor.subject_id = block.subject_id
              AND successor.permission = block.permission
              AND successor.action_scope_sha256 = block.action_scope_sha256
              AND successor.supersedes_event_id = block.id
          )
      )
  );
$function$;
REVOKE ALL ON FUNCTION app_private.whatsapp_live_authority_is_current(
  uuid, uuid, uuid
) FROM PUBLIC;

CREATE FUNCTION app_private.claim_whatsapp_live_job(
  p_workspace_id uuid, p_provider_connection_id uuid,
  p_lease_token bytea, p_lease_seconds integer
) RETURNS TABLE(job_id uuid, binding_id uuid, lease_version bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE selected app.property_predator_whatsapp_live_jobs%ROWTYPE;
  recovered app.property_predator_whatsapp_live_jobs%ROWTYPE; next_version bigint;
BEGIN
  IF session_user <> 'r72_whatsapp_live_worker_command'
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'worker'
     OR coalesce(current_setting('app.user_id', true), '') <> ''
     OR coalesce(current_setting('app.request_id', true), '') = ''
     OR octet_length(p_lease_token) <> 32 OR p_lease_seconds NOT BETWEEN 30 AND 300 THEN
    RAISE EXCEPTION 'WhatsApp live claim denied' USING ERRCODE = '42501';
  END IF;
  FOR recovered IN SELECT job.* FROM app.property_predator_whatsapp_live_jobs AS job
    WHERE job.workspace_id = p_workspace_id AND job.provider_connection_id = p_provider_connection_id
      AND ((job.state IN ('leased', 'calling') AND job.lease_expires_at <= statement_timestamp())
        OR (job.state = 'awaiting_status' AND job.status_deadline <= statement_timestamp()))
    FOR UPDATE SKIP LOCKED
  LOOP
    IF recovered.state IN ('calling', 'awaiting_status') THEN
      INSERT INTO app.property_predator_whatsapp_live_receipts (
        workspace_id, job_id, binding_id, external_event_id, event_kind,
        provider_message_id, recipient_or_sender_sha256, body_sha256,
        payload_sha256, safe_code, provider_occurred_at
      ) VALUES (
        recovered.workspace_id, recovered.id, recovered.binding_id,
        format('worker-timeout:%s:%s', recovered.id, recovered.lease_version),
        'outcome_unknown', recovered.provider_message_id, recovered.recipient_sha256, NULL,
        public.digest(format('worker-timeout:%s:%s', recovered.id, recovered.lease_version), 'sha256'),
        'worker_whatsapp_outcome_unknown', statement_timestamp()
      ) ON CONFLICT (workspace_id, binding_id, external_event_id) DO NOTHING;
    END IF;
    UPDATE app.property_predator_whatsapp_live_jobs SET
      state = CASE WHEN recovered.state = 'leased' THEN 'queued' ELSE 'needs_attention' END,
      lease_expires_at = NULL, status_deadline = NULL,
      available_at = CASE WHEN recovered.state = 'leased' THEN statement_timestamp() ELSE available_at END,
      settled_at = CASE WHEN recovered.state = 'leased' THEN settled_at ELSE statement_timestamp() END,
      updated_at = statement_timestamp()
    WHERE workspace_id = recovered.workspace_id AND id = recovered.id;
    DELETE FROM app.property_predator_whatsapp_live_job_leases
    WHERE workspace_id = recovered.workspace_id AND job_id = recovered.id;
  END LOOP;
  SELECT job.* INTO selected FROM app.property_predator_whatsapp_live_jobs AS job
  WHERE job.workspace_id = p_workspace_id AND job.provider_connection_id = p_provider_connection_id
    AND job.state = 'queued' AND job.available_at <= statement_timestamp()
    AND job.claim_count < 8
    AND app_private.whatsapp_live_authority_is_current(
      job.workspace_id, job.authority_id, job.provider_connection_id
    )
  ORDER BY job.available_at, job.created_at, job.id
  LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN; END IF;
  next_version := selected.lease_version + 1;
  UPDATE app.property_predator_whatsapp_live_jobs SET state = 'leased',
    lease_version = next_version,
    lease_expires_at = statement_timestamp() + make_interval(secs => p_lease_seconds),
    claim_count = claim_count + 1, updated_at = statement_timestamp()
  WHERE workspace_id = p_workspace_id AND id = selected.id;
  INSERT INTO app.property_predator_whatsapp_live_job_leases
    (workspace_id, job_id, lease_version, lease_token_sha256)
  VALUES (p_workspace_id, selected.id, next_version, public.digest(p_lease_token, 'sha256'))
  ON CONFLICT (workspace_id, job_id) DO UPDATE SET
    lease_version = EXCLUDED.lease_version,
    lease_token_sha256 = EXCLUDED.lease_token_sha256,
    issued_at = statement_timestamp();
  RETURN QUERY SELECT selected.id, selected.binding_id, next_version;
END
$function$;

CREATE FUNCTION app_private.load_whatsapp_live_job(
  p_workspace_id uuid, p_job_id uuid, p_lease_version bigint, p_lease_token bytea
) RETURNS TABLE(
  provider_connection_id uuid, binding_id uuid, app_id text, waba_id text,
  phone_number_id text, graph_api_version text, secret_key_version text,
  secret_iv bytea, secret_ciphertext bytea, secret_auth_tag bytea,
  secret_aad_sha256 bytea, secret_payload_sha256 bytea, recipient text,
  template_name text, language_code text, operation_id uuid, request_sha256 bytea
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $function$
  SELECT job.provider_connection_id, job.binding_id, binding.app_id, binding.waba_id,
    binding.phone_number_id, binding.graph_api_version, binding.secret_key_version,
    binding.secret_iv, binding.secret_ciphertext, binding.secret_auth_tag,
    binding.secret_aad_sha256, binding.secret_payload_sha256,
    regexp_replace(point.normalized_value, '^\\+', ''), template.provider_template_name,
    template.language_code, job.operation_id, job.request_sha256
  FROM app.property_predator_whatsapp_live_jobs AS job
  JOIN app.property_predator_whatsapp_live_job_leases AS lease
    ON lease.workspace_id = job.workspace_id AND lease.job_id = job.id
   AND lease.lease_version = job.lease_version
   AND lease.lease_token_sha256 = public.digest(p_lease_token, 'sha256')
  JOIN app.property_predator_whatsapp_live_bindings AS binding
    ON binding.workspace_id = job.workspace_id AND binding.id = job.binding_id
   AND binding.provider_connection_id = job.provider_connection_id AND binding.status = 'active'
  JOIN app.property_predator_whatsapp_live_templates AS template
    ON template.workspace_id = job.workspace_id AND template.id = job.template_id
   AND template.binding_id = job.binding_id AND template.provider_status = 'approved'
  JOIN app.property_predator_whatsapp_live_authorities AS authority
    ON authority.workspace_id = job.workspace_id AND authority.id = job.authority_id
   AND authority.binding_id = job.binding_id AND authority.template_id = job.template_id
   AND authority.recipient_sha256 = job.recipient_sha256
   AND authority.valid_until > statement_timestamp()
  JOIN app.contact_points AS point
    ON point.workspace_id = authority.workspace_id AND point.id = authority.contact_point_id
   AND point.contact_id = authority.contact_id AND point.kind = 'whatsapp'
   AND point.is_verified AND point.deleted_at IS NULL
   AND public.digest(regexp_replace(point.normalized_value, '^\\+', ''), 'sha256') = job.recipient_sha256
  JOIN app.communication_consent_events AS consent
    ON consent.workspace_id = authority.workspace_id
   AND consent.id = authority.consent_event_id
   AND consent.contact_id = authority.contact_id
   AND consent.contact_point_id = authority.contact_point_id
   AND consent.channel = 'whatsapp' AND consent.purpose = authority.purpose
   AND consent.state = 'granted'
   AND consent.endpoint_identity_sha256 = public.digest(
     point.kind || pg_catalog.chr(31) || point.value || pg_catalog.chr(31)
       || point.normalized_value,
     'sha256'
   )
  WHERE session_user = 'r72_whatsapp_live_worker_command'
    AND current_setting('app.workspace_id', true) = p_workspace_id::text
    AND current_setting('app.actor_kind', true) = 'worker'
    AND coalesce(current_setting('app.user_id', true), '') = ''
    AND coalesce(current_setting('app.request_id', true), '') <> ''
    AND job.workspace_id = p_workspace_id AND job.id = p_job_id
    AND job.state = 'leased' AND job.lease_version = p_lease_version
    AND job.lease_expires_at > statement_timestamp()
    AND app_private.whatsapp_live_authority_is_current(
      job.workspace_id, job.authority_id, job.provider_connection_id
    )
    AND consent.id = (
      SELECT latest.id FROM app.communication_consent_events AS latest
      WHERE latest.workspace_id = authority.workspace_id
        AND latest.contact_point_id = authority.contact_point_id
        AND latest.channel = 'whatsapp' AND latest.purpose = authority.purpose
      ORDER BY latest.occurred_at DESC, latest.recorded_at DESC, latest.id DESC LIMIT 1
    )
    AND NOT EXISTS (
      SELECT 1 FROM app.communication_suppression_events AS suppression
      WHERE suppression.workspace_id = authority.workspace_id
        AND suppression.contact_point_id = authority.contact_point_id
        AND suppression.channel = 'whatsapp'
        AND (suppression.purpose IS NULL OR suppression.purpose = authority.purpose)
        AND suppression.state = 'suppressed'
        AND suppression.id = (
          SELECT latest.id FROM app.communication_suppression_events AS latest
          WHERE latest.workspace_id = authority.workspace_id
            AND latest.contact_point_id = authority.contact_point_id
            AND latest.channel = 'whatsapp'
            AND latest.purpose IS NOT DISTINCT FROM suppression.purpose
          ORDER BY latest.occurred_at DESC, latest.recorded_at DESC, latest.id DESC LIMIT 1
        )
    );
$function$;

CREATE FUNCTION app_private.begin_whatsapp_live_call(
  p_workspace_id uuid, p_job_id uuid, p_lease_version bigint, p_lease_token bytea,
  p_provider_effects_enabled boolean, p_emergency_paused boolean
) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE changed integer; selected_binding uuid;
BEGIN
  IF session_user <> 'r72_whatsapp_live_worker_command'
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'worker'
     OR coalesce(current_setting('app.user_id', true), '') <> ''
     OR coalesce(current_setting('app.request_id', true), '') = ''
     OR NOT p_provider_effects_enabled OR p_emergency_paused THEN
    RAISE EXCEPTION 'WhatsApp live begin-call denied' USING ERRCODE = '42501';
  END IF;
  SELECT job.binding_id INTO selected_binding
  FROM app.property_predator_whatsapp_live_jobs AS job
  WHERE job.workspace_id = p_workspace_id AND job.id = p_job_id
    AND job.state = 'leased' AND job.lease_version = p_lease_version;
  IF selected_binding IS NULL THEN RETURN false; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    format('pp-whatsapp-call-fence:%s:%s', p_workspace_id, selected_binding), 0
  ));
  UPDATE app.property_predator_whatsapp_live_jobs AS job SET
    state = 'calling', calling_at = statement_timestamp(), updated_at = statement_timestamp()
  FROM app.property_predator_whatsapp_live_job_leases AS lease,
    app.property_predator_whatsapp_live_authorities AS authority,
    app.contact_points AS point,
    app.communication_consent_events AS consent
  WHERE job.workspace_id = p_workspace_id AND job.id = p_job_id
    AND job.state = 'leased' AND job.lease_version = p_lease_version
    AND job.lease_expires_at > statement_timestamp()
    AND app_private.whatsapp_live_authority_is_current(
      job.workspace_id, job.authority_id, job.provider_connection_id
    )
    AND lease.workspace_id = job.workspace_id AND lease.job_id = job.id
    AND lease.lease_version = job.lease_version
    AND lease.lease_token_sha256 = public.digest(p_lease_token, 'sha256')
    AND authority.workspace_id = job.workspace_id AND authority.id = job.authority_id
    AND authority.binding_id = job.binding_id AND authority.template_id = job.template_id
    AND authority.recipient_sha256 = job.recipient_sha256
    AND authority.valid_until > statement_timestamp()
    AND point.workspace_id = authority.workspace_id AND point.id = authority.contact_point_id
    AND point.contact_id = authority.contact_id AND point.kind = 'whatsapp'
    AND point.is_verified AND point.deleted_at IS NULL
    AND public.digest(regexp_replace(point.normalized_value, '^\\+', ''), 'sha256') = job.recipient_sha256
    AND consent.workspace_id = authority.workspace_id
    AND consent.id = authority.consent_event_id
    AND consent.contact_id = authority.contact_id
    AND consent.contact_point_id = authority.contact_point_id
    AND consent.channel = 'whatsapp' AND consent.purpose = authority.purpose
    AND consent.state = 'granted'
    AND consent.endpoint_identity_sha256 = public.digest(
      point.kind || pg_catalog.chr(31) || point.value || pg_catalog.chr(31)
        || point.normalized_value,
      'sha256'
    )
    AND consent.id = (
      SELECT latest.id FROM app.communication_consent_events AS latest
      WHERE latest.workspace_id = authority.workspace_id
        AND latest.contact_point_id = authority.contact_point_id
        AND latest.channel = 'whatsapp' AND latest.purpose = authority.purpose
      ORDER BY latest.occurred_at DESC, latest.recorded_at DESC, latest.id DESC LIMIT 1
    )
    AND NOT EXISTS (
      SELECT 1 FROM app.communication_suppression_events AS suppression
      WHERE suppression.workspace_id = authority.workspace_id
        AND suppression.contact_point_id = authority.contact_point_id
        AND suppression.channel = 'whatsapp'
        AND (suppression.purpose IS NULL OR suppression.purpose = authority.purpose)
        AND suppression.state = 'suppressed'
        AND suppression.id = (
          SELECT latest.id FROM app.communication_suppression_events AS latest
          WHERE latest.workspace_id = authority.workspace_id
            AND latest.contact_point_id = authority.contact_point_id
            AND latest.channel = 'whatsapp'
            AND latest.purpose IS NOT DISTINCT FROM suppression.purpose
          ORDER BY latest.occurred_at DESC, latest.recorded_at DESC, latest.id DESC LIMIT 1
        )
    );
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END
$function$;

CREATE FUNCTION app_private.settle_whatsapp_live_call(
  p_workspace_id uuid, p_job_id uuid, p_lease_version bigint, p_lease_token bytea,
  p_state text, p_provider_message_id text, p_receipt_sha256 bytea,
  p_safe_code text, p_occurred_at timestamptz
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE selected app.property_predator_whatsapp_live_jobs%ROWTYPE; next_state text;
BEGIN
  IF session_user <> 'r72_whatsapp_live_worker_command'
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'worker'
     OR coalesce(current_setting('app.user_id', true), '') <> ''
     OR coalesce(current_setting('app.request_id', true), '') = ''
     OR p_state NOT IN ('accepted', 'failed', 'outcome_unknown')
     OR (p_state = 'accepted' AND p_provider_message_id IS NULL)
     OR octet_length(p_receipt_sha256) <> 32
     OR p_safe_code !~ '^[a-z][a-z0-9_.:-]{0,99}$' THEN
    RAISE EXCEPTION 'WhatsApp live settle denied' USING ERRCODE = '42501';
  END IF;
  SELECT job.* INTO selected FROM app.property_predator_whatsapp_live_jobs AS job
  JOIN app.property_predator_whatsapp_live_job_leases AS lease
    ON lease.workspace_id = job.workspace_id AND lease.job_id = job.id
   AND lease.lease_version = job.lease_version
   AND lease.lease_token_sha256 = public.digest(p_lease_token, 'sha256')
  WHERE job.workspace_id = p_workspace_id AND job.id = p_job_id
    AND job.state = 'calling' AND job.lease_version = p_lease_version FOR UPDATE OF job;
  IF NOT FOUND THEN RAISE EXCEPTION 'WhatsApp live settle lease lost' USING ERRCODE = '40001'; END IF;
  next_state := CASE WHEN p_state = 'accepted' THEN 'awaiting_status'
    WHEN p_state = 'failed' THEN 'failed' ELSE 'needs_attention' END;
  INSERT INTO app.property_predator_whatsapp_live_receipts (
    workspace_id, job_id, binding_id, external_event_id, event_kind,
    provider_message_id, recipient_or_sender_sha256, body_sha256,
    payload_sha256, safe_code, provider_occurred_at
  ) VALUES (
    p_workspace_id, p_job_id, selected.binding_id,
    format('dispatch:%s:%s', p_job_id, p_lease_version),
    p_state, p_provider_message_id, selected.recipient_sha256, NULL,
    p_receipt_sha256, p_safe_code, p_occurred_at
  );
  UPDATE app.property_predator_whatsapp_live_jobs SET state = next_state,
    lease_expires_at = NULL, provider_message_id = p_provider_message_id,
    status_deadline = CASE WHEN next_state = 'awaiting_status'
      THEN statement_timestamp() + interval '30 minutes' ELSE NULL END,
    settled_at = CASE WHEN next_state IN ('failed', 'needs_attention')
      THEN statement_timestamp() ELSE NULL END,
    updated_at = statement_timestamp()
  WHERE workspace_id = p_workspace_id AND id = p_job_id;
  DELETE FROM app.property_predator_whatsapp_live_job_leases
  WHERE workspace_id = p_workspace_id AND job_id = p_job_id;
END
$function$;

CREATE FUNCTION app_private.record_whatsapp_live_status(
  p_workspace_id uuid, p_binding_id uuid, p_external_event_id text,
  p_provider_message_id text, p_recipient_sha256 bytea, p_status text,
  p_payload_sha256 bytea, p_occurred_at timestamptz
) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE selected app.property_predator_whatsapp_live_jobs%ROWTYPE; existing record;
BEGIN
  IF session_user <> 'r72_whatsapp_live_webhook_command'
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'webhook'
     OR coalesce(current_setting('app.user_id', true), '') <> ''
     OR coalesce(current_setting('app.request_id', true), '') = ''
     OR p_external_event_id IS NULL OR p_external_event_id <> btrim(p_external_event_id)
     OR length(p_external_event_id) NOT BETWEEN 1 AND 500
     OR p_provider_message_id !~ '^wamid[.][A-Za-z0-9_=-]{1,190}$'
     OR p_status NOT IN ('sent', 'delivered', 'read', 'failed', 'deleted')
     OR octet_length(p_recipient_sha256) <> 32 OR octet_length(p_payload_sha256) <> 32 THEN
    RAISE EXCEPTION 'WhatsApp live status denied' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    format('pp-whatsapp-webhook:%s:%s:%s',
      p_workspace_id, p_binding_id, p_external_event_id), 0
  ));
  SELECT receipt.payload_sha256 INTO existing
  FROM app.property_predator_whatsapp_live_receipts AS receipt
  WHERE receipt.workspace_id = p_workspace_id AND receipt.binding_id = p_binding_id
    AND receipt.external_event_id = p_external_event_id;
  IF FOUND THEN
    IF existing.payload_sha256 <> p_payload_sha256 THEN RETURN 'conflict'; END IF;
    RETURN 'replayed';
  END IF;
  SELECT job.* INTO selected FROM app.property_predator_whatsapp_live_jobs AS job
  WHERE job.workspace_id = p_workspace_id AND job.binding_id = p_binding_id
    AND job.provider_message_id = p_provider_message_id
    AND job.recipient_sha256 = p_recipient_sha256 FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'WhatsApp status has no exact outbound job' USING ERRCODE = '42501'; END IF;
  INSERT INTO app.property_predator_whatsapp_live_receipts (
    workspace_id, job_id, binding_id, external_event_id, event_kind,
    provider_message_id, recipient_or_sender_sha256, body_sha256,
    payload_sha256, safe_code, provider_occurred_at
  ) VALUES (
    p_workspace_id, selected.id, p_binding_id, p_external_event_id, p_status,
    p_provider_message_id, p_recipient_sha256, NULL, p_payload_sha256,
    'meta_whatsapp_signed_status', p_occurred_at
  );
  UPDATE app.property_predator_whatsapp_live_jobs SET
    state = CASE WHEN p_status = 'failed' THEN 'failed'
      WHEN p_status = 'deleted' THEN 'needs_attention'
      WHEN p_status IN ('delivered', 'read') THEN 'succeeded' ELSE state END,
    status_deadline = CASE WHEN p_status IN ('delivered', 'read', 'failed', 'deleted') THEN NULL ELSE status_deadline END,
    settled_at = CASE WHEN p_status IN ('delivered', 'read', 'failed', 'deleted')
      THEN statement_timestamp() ELSE settled_at END,
    updated_at = statement_timestamp()
  WHERE workspace_id = p_workspace_id AND id = selected.id;
  RETURN 'applied';
END
$function$;

CREATE FUNCTION app_private.record_whatsapp_live_inbound_receipt(
  p_workspace_id uuid, p_binding_id uuid, p_external_event_id text,
  p_provider_message_id text, p_sender_sha256 bytea, p_body_sha256 bytea,
  p_payload_sha256 bytea, p_occurred_at timestamptz
) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE existing record;
BEGIN
  IF session_user <> 'r72_whatsapp_live_webhook_command'
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'webhook'
     OR coalesce(current_setting('app.user_id', true), '') <> ''
     OR coalesce(current_setting('app.request_id', true), '') = ''
     OR p_external_event_id IS NULL OR p_external_event_id <> btrim(p_external_event_id)
     OR length(p_external_event_id) NOT BETWEEN 1 AND 500
     OR p_provider_message_id !~ '^wamid[.][A-Za-z0-9_=-]{1,190}$'
     OR octet_length(p_sender_sha256) <> 32 OR octet_length(p_body_sha256) <> 32
     OR octet_length(p_payload_sha256) <> 32 THEN
    RAISE EXCEPTION 'WhatsApp live inbound receipt denied' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    format('pp-whatsapp-webhook:%s:%s:%s',
      p_workspace_id, p_binding_id, p_external_event_id), 0
  ));
  SELECT receipt.payload_sha256, receipt.body_sha256 INTO existing
  FROM app.property_predator_whatsapp_live_receipts AS receipt
  WHERE receipt.workspace_id = p_workspace_id AND receipt.binding_id = p_binding_id
    AND receipt.external_event_id = p_external_event_id;
  IF FOUND THEN
    IF existing.payload_sha256 <> p_payload_sha256 OR existing.body_sha256 <> p_body_sha256
      THEN RETURN 'conflict'; END IF;
    RETURN 'replayed';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app.property_predator_whatsapp_live_bindings AS binding
    WHERE binding.workspace_id = p_workspace_id AND binding.id = p_binding_id
      AND binding.status = 'active'
  ) THEN RAISE EXCEPTION 'WhatsApp live inbound binding denied' USING ERRCODE = '42501'; END IF;
  INSERT INTO app.property_predator_whatsapp_live_receipts (
    workspace_id, job_id, binding_id, external_event_id, event_kind,
    provider_message_id, recipient_or_sender_sha256, body_sha256,
    payload_sha256, safe_code, provider_occurred_at
  ) VALUES (
    p_workspace_id, NULL, p_binding_id, p_external_event_id, 'inbound_received',
    p_provider_message_id, p_sender_sha256, p_body_sha256, p_payload_sha256,
    'meta_whatsapp_signed_inbound', p_occurred_at
  );
  RETURN 'applied';
END
$function$;

SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_whatsapp_live_definer;

REVOKE ALL ON FUNCTION app_private.record_whatsapp_live_binding(
  uuid, uuid, uuid, text, text, text, bytea, text, bytea, bytea, bytea,
  bytea, bytea, bytea, timestamptz, uuid
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.revoke_whatsapp_live_binding(
  uuid, uuid, bytea
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.record_whatsapp_live_template(
  uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, bytea, text, text, bytea, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.authorize_and_enqueue_whatsapp_live_job(
  uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid,
  text, timestamptz, uuid, bytea, bytea
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.claim_whatsapp_live_job(uuid, uuid, bytea, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.load_whatsapp_live_job(uuid, uuid, bigint, bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.begin_whatsapp_live_call(
  uuid, uuid, bigint, bytea, boolean, boolean
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.settle_whatsapp_live_call(
  uuid, uuid, bigint, bytea, text, text, bytea, text, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.record_whatsapp_live_status(
  uuid, uuid, text, text, bytea, text, bytea, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.record_whatsapp_live_inbound_receipt(
  uuid, uuid, text, text, bytea, bytea, bytea, timestamptz
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app_private.record_whatsapp_live_binding(
  uuid, uuid, uuid, text, text, text, bytea, text, bytea, bytea, bytea,
  bytea, bytea, bytea, timestamptz, uuid
) TO r72_whatsapp_live_command;
GRANT EXECUTE ON FUNCTION app_private.revoke_whatsapp_live_binding(
  uuid, uuid, bytea
) TO r72_whatsapp_live_command;
GRANT EXECUTE ON FUNCTION app_private.record_whatsapp_live_template(
  uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, bytea, text, text, bytea, timestamptz
) TO r72_whatsapp_live_command;
GRANT EXECUTE ON FUNCTION app_private.authorize_and_enqueue_whatsapp_live_job(
  uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid,
  text, timestamptz, uuid, bytea, bytea
) TO r72_whatsapp_live_command;
GRANT EXECUTE ON FUNCTION app_private.claim_whatsapp_live_job(uuid, uuid, bytea, integer)
  TO r72_whatsapp_live_worker_command;
GRANT EXECUTE ON FUNCTION app_private.load_whatsapp_live_job(uuid, uuid, bigint, bytea)
  TO r72_whatsapp_live_worker_command;
GRANT EXECUTE ON FUNCTION app_private.begin_whatsapp_live_call(
  uuid, uuid, bigint, bytea, boolean, boolean
) TO r72_whatsapp_live_worker_command;
GRANT EXECUTE ON FUNCTION app_private.settle_whatsapp_live_call(
  uuid, uuid, bigint, bytea, text, text, bytea, text, timestamptz
) TO r72_whatsapp_live_worker_command;
GRANT EXECUTE ON FUNCTION app_private.record_whatsapp_live_status(
  uuid, uuid, text, text, bytea, text, bytea, timestamptz
) TO r72_whatsapp_live_webhook_command;
GRANT EXECUTE ON FUNCTION app_private.record_whatsapp_live_inbound_receipt(
  uuid, uuid, text, text, bytea, bytea, bytea, timestamptz
) TO r72_whatsapp_live_webhook_command;
GRANT EXECUTE ON FUNCTION app_private.runtime_schema_migrations(),
  app_private.runtime_database_installation_id()
  TO r72_whatsapp_live_command, r72_whatsapp_live_worker_command,
  r72_whatsapp_live_webhook_command;
GRANT EXECUTE ON FUNCTION app_private.lock_active_portal_session(bytea, uuid, uuid)
  TO r72_whatsapp_live_command;

INSERT INTO app_private.workspace_table_registry (schema_name, table_name, workspace_column)
VALUES
  ('app', 'property_predator_whatsapp_live_bindings', 'workspace_id'),
  ('app', 'property_predator_whatsapp_live_binding_revocations', 'workspace_id'),
  ('app', 'property_predator_whatsapp_live_templates', 'workspace_id'),
  ('app', 'property_predator_whatsapp_live_authorities', 'workspace_id'),
  ('app', 'property_predator_whatsapp_live_jobs', 'workspace_id'),
  ('app', 'property_predator_whatsapp_live_job_leases', 'workspace_id'),
  ('app', 'property_predator_whatsapp_live_receipts', 'workspace_id');

DO $capability_audit$
DECLARE checked_role text; unsafe_object text;
BEGIN
  FOREACH checked_role IN ARRAY ARRAY[
    'r72_whatsapp_live_command', 'r72_whatsapp_live_worker_command',
    'r72_whatsapp_live_webhook_command'
  ] LOOP
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
      RAISE EXCEPTION 'Unsafe WhatsApp live table capability: % -> %', checked_role, unsafe_object;
    END IF;
  END LOOP;
END
$capability_audit$;
