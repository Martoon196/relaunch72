-- Exact-recipient Property Predator customer email effect.
--
-- This migration installs a table-blind command boundary and a durable worker
-- queue. It stores only identifiers/hashes outside the existing protected CRM
-- tables. Provider credentials remain exclusively in the Render secret
-- manager and the Mailgun EU worker process.

DO $roles$
DECLARE unsafe_membership text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'r72_customer_email_command') THEN
    CREATE ROLE r72_customer_email_command LOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'r72_customer_email_worker_command') THEN
    CREATE ROLE r72_customer_email_worker_command LOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'r72_customer_email_webhook_command') THEN
    CREATE ROLE r72_customer_email_webhook_command LOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'r72_customer_email_definer') THEN
    CREATE ROLE r72_customer_email_definer NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'r72_customer_email_command'
      AND rolcanlogin AND NOT rolinherit AND NOT rolsuper AND NOT rolcreatedb
      AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'r72_customer_email_worker_command'
      AND rolcanlogin AND NOT rolinherit AND NOT rolsuper AND NOT rolcreatedb
      AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'r72_customer_email_webhook_command'
      AND rolcanlogin AND NOT rolinherit AND NOT rolsuper AND NOT rolcreatedb
      AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'r72_customer_email_definer'
      AND NOT rolcanlogin AND NOT rolinherit AND NOT rolsuper AND NOT rolcreatedb
      AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls
  ) THEN
    RAISE EXCEPTION 'Unsafe customer email live role attributes';
  END IF;

  REVOKE r72_owner, r72_security_definer, r72_customer_email_definer FROM
    r72_customer_email_command, r72_customer_email_worker_command,
    r72_customer_email_webhook_command;
  REVOKE r72_owner, r72_security_definer FROM r72_customer_email_definer;
  SELECT parent.rolname INTO unsafe_membership
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
  JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
  WHERE member.rolname IN (
    'r72_customer_email_command', 'r72_customer_email_worker_command',
    'r72_customer_email_webhook_command'
  ) LIMIT 1;
  IF unsafe_membership IS NOT NULL THEN
    RAISE EXCEPTION 'Unsafe customer email command membership: %', unsafe_membership;
  END IF;
  GRANT r72_customer_email_definer TO r72_owner;
  EXECUTE format('GRANT r72_customer_email_command TO %I', current_user);
  EXECUTE format('GRANT r72_customer_email_worker_command TO %I', current_user);
  EXECUTE format('GRANT r72_customer_email_webhook_command TO %I', current_user);
END
$roles$;

SET LOCAL ROLE r72_owner;

REVOKE ALL ON SCHEMA app, app_private FROM r72_customer_email_command,
  r72_customer_email_worker_command, r72_customer_email_webhook_command,
  r72_customer_email_definer;
REVOKE ALL ON ALL TABLES IN SCHEMA app FROM r72_customer_email_command,
  r72_customer_email_worker_command, r72_customer_email_webhook_command,
  r72_customer_email_definer;
REVOKE ALL ON ALL TABLES IN SCHEMA app_private FROM r72_customer_email_command,
  r72_customer_email_worker_command, r72_customer_email_webhook_command,
  r72_customer_email_definer;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app_private FROM r72_customer_email_command,
  r72_customer_email_worker_command, r72_customer_email_webhook_command;
REVOKE CREATE ON SCHEMA public FROM r72_customer_email_command,
  r72_customer_email_worker_command, r72_customer_email_webhook_command,
  r72_customer_email_definer;
GRANT USAGE ON SCHEMA app, app_private TO r72_customer_email_command,
  r72_customer_email_worker_command, r72_customer_email_webhook_command,
  r72_customer_email_definer;

CREATE UNIQUE INDEX campaign_template_steps_customer_email_binding_uq
  ON app.campaign_template_steps
    (workspace_id, template_version_id, id, content_sha256);

-- Preserve the original controlled-pilot delivery path while admitting one
-- separately owned customer-email path. The exact idempotency prefix prevents
-- this definer from becoming a generic live-delivery bypass.
CREATE OR REPLACE FUNCTION app_private.guard_property_predator_email_live_delivery()
RETURNS trigger
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog
AS $function$
DECLARE
  point_kind text;
  point_value text;
  point_normalized text;
  latest_consent uuid;
  active_suppression uuid;
BEGIN
  IF NEW.environment <> 'live'
     OR NEW.conversation_channel <> 'email'
     OR NEW.consent_channel <> 'email'
     OR NOT (
       current_user = 'r72_mailgun_worker_definer'
       OR (
         current_user = 'r72_customer_email_definer'
         AND NEW.idempotency_key ~ '^customer-email-live:[0-9a-f]{64}$'
       )
     )
     OR NOT EXISTS (
       SELECT 1 FROM app.provider_connections AS connection
       WHERE connection.workspace_id = NEW.workspace_id
         AND connection.id = NEW.provider_connection_id
         AND connection.provider_id = 'mailgun_eu'
         AND connection.provider_kind = 'email'
         AND connection.environment = 'live'
         AND connection.status = 'active'
         AND (
           current_user <> 'r72_customer_email_definer'
           OR connection.capabilities @> '["email.send"]'::jsonb
          )
      ) THEN
    RAISE EXCEPTION 'Live delivery is outside an exact Mailgun boundary'
      USING ERRCODE = '42501';
  END IF;
  IF current_user = 'r72_customer_email_definer'
     AND NOT EXISTS (
       SELECT 1 FROM app.channel_endpoints AS endpoint
       WHERE endpoint.workspace_id = NEW.workspace_id
         AND endpoint.id = NEW.channel_endpoint_id
         AND endpoint.provider_connection_id = NEW.provider_connection_id
         AND endpoint.channel = 'email'
         AND endpoint.environment = 'live'
         AND endpoint.direction IN ('outbound', 'bidirectional')
         AND endpoint.status = 'active'
         AND endpoint.address = 'mg.propertypredator.com'
         AND endpoint.normalized_address = 'mg.propertypredator.com'
     ) THEN
    RAISE EXCEPTION 'Customer email live sender endpoint is not canonical'
      USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM app.messages AS message
    JOIN app.message_approval_decisions AS decision
      ON decision.workspace_id = message.workspace_id
     AND decision.id = NEW.approval_decision_id
     AND decision.message_id = message.id
     AND decision.message_version_id = message.current_version_id
     AND decision.body_sha256 = message.current_body_sha256
     AND decision.decision = 'approved'
    JOIN app.property_predator_email_pilot_approved_content AS approved_content
      ON approved_content.workspace_id = decision.workspace_id
     AND approved_content.approval_decision_id = decision.id
     AND approved_content.message_version_id = decision.message_version_id
     AND approved_content.body_sha256 = decision.body_sha256
    JOIN app.provider_operations AS operation
      ON operation.workspace_id = message.workspace_id
     AND operation.id = NEW.provider_operation_id
     AND operation.message_delivery_id = NEW.id
     AND operation.provider_connection_id = NEW.provider_connection_id
     AND operation.environment = 'live'
     AND operation.operation_kind = 'conversation.send'
     AND operation.state = 'queued'
     AND (
       current_user <> 'r72_customer_email_definer'
       OR operation.idempotency_key = NEW.idempotency_key
     )
    WHERE message.workspace_id = NEW.workspace_id
      AND message.id = NEW.message_id
      AND message.conversation_id = NEW.conversation_id
      AND message.contact_id = NEW.contact_id
      AND message.contact_point_id = NEW.contact_point_id
      AND message.direction = 'outbound'
      AND message.lifecycle = 'approved'
      AND message.current_version_id = NEW.message_version_id
      AND message.current_version_number = NEW.version_number
      AND message.current_body_sha256 = NEW.body_sha256
  ) THEN
    RAISE EXCEPTION 'Live delivery lost its exact immutable approval'
      USING ERRCODE = '40001';
  END IF;
  SELECT point.kind, point.value, point.normalized_value
    INTO point_kind, point_value, point_normalized
  FROM app.contact_points AS point
  WHERE point.workspace_id = NEW.workspace_id
    AND point.id = NEW.contact_point_id
    AND point.contact_id = NEW.contact_id
    AND point.kind = 'email'
    AND point.deleted_at IS NULL
    AND point.is_verified
    AND point.dedupe_state = 'normal';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Live delivery endpoint is unavailable' USING ERRCODE = '23514';
  END IF;
  NEW.endpoint_identity_sha256 := public.digest(
    point_kind || pg_catalog.chr(31) || point_value || pg_catalog.chr(31)
      || point_normalized,
    'sha256'
  );
  SELECT event.id INTO latest_consent
  FROM app.communication_consent_events AS event
  WHERE event.workspace_id = NEW.workspace_id
    AND event.contact_id = NEW.contact_id
    AND event.contact_point_id = NEW.contact_point_id
    AND event.channel = 'email'
    AND event.purpose = NEW.purpose
    AND event.endpoint_identity_sha256 = NEW.endpoint_identity_sha256
    AND event.occurred_at <= statement_timestamp() + interval '5 minutes'
  ORDER BY event.occurred_at DESC, event.recorded_at DESC, event.id DESC
  LIMIT 1;
  SELECT suppression.id INTO active_suppression
  FROM (
    SELECT DISTINCT ON (coalesce(event.purpose, ''))
      event.id, event.state, event.occurred_at, event.recorded_at
    FROM app.communication_suppression_events AS event
    WHERE event.workspace_id = NEW.workspace_id
      AND event.contact_id = NEW.contact_id
      AND event.contact_point_id = NEW.contact_point_id
      AND event.channel = 'email'
      AND (event.purpose IS NULL OR event.purpose = NEW.purpose)
      AND event.endpoint_identity_sha256 = NEW.endpoint_identity_sha256
      AND event.occurred_at <= statement_timestamp() + interval '5 minutes'
    ORDER BY coalesce(event.purpose, ''), event.occurred_at DESC,
      event.recorded_at DESC, event.id DESC
  ) AS suppression
  WHERE suppression.state = 'suppressed'
  ORDER BY suppression.occurred_at DESC, suppression.recorded_at DESC,
    suppression.id DESC
  LIMIT 1;
  IF active_suppression IS NOT NULL
     OR latest_consent IS DISTINCT FROM NEW.consent_event_id
     OR NOT EXISTS (
       SELECT 1 FROM app.communication_consent_events AS consent
       WHERE consent.workspace_id = NEW.workspace_id
         AND consent.id = latest_consent AND consent.state = 'granted'
     ) THEN
    RAISE EXCEPTION 'Live delivery is not authorised by current consent'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TABLE app.property_predator_customer_email_authorities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  provider_connection_id uuid NOT NULL,
  campaign_template_version_id uuid NOT NULL,
  campaign_template_step_id uuid NOT NULL,
  campaign_step_content_sha256 bytea NOT NULL
    CHECK (octet_length(campaign_step_content_sha256) = 32),
  campaign_definition_sha256 bytea NOT NULL CHECK (octet_length(campaign_definition_sha256) = 32),
  campaign_approval_request_id uuid NOT NULL,
  campaign_approval_decision_id uuid NOT NULL,
  message_delivery_id uuid NOT NULL,
  provider_operation_id uuid NOT NULL,
  message_version_id uuid NOT NULL,
  message_approval_request_id uuid NOT NULL,
  message_approval_decision_id uuid NOT NULL,
  message_subject_sha256 bytea NOT NULL CHECK (octet_length(message_subject_sha256) = 32),
  contact_id uuid NOT NULL,
  contact_point_id uuid NOT NULL,
  channel_endpoint_id uuid NOT NULL,
  sender_endpoint_normalized_address text NOT NULL CHECK (
    sender_endpoint_normalized_address = 'mg.propertypredator.com'
  ),
  recipient_sha256 bytea NOT NULL CHECK (octet_length(recipient_sha256) = 32),
  endpoint_identity_sha256 bytea NOT NULL CHECK (octet_length(endpoint_identity_sha256) = 32),
  consent_event_id uuid NOT NULL,
  purpose text NOT NULL CHECK (purpose ~ '^[a-z][a-z0-9_.-]{0,99}$'),
  lawful_basis text NOT NULL CHECK (lawful_basis IN ('consent', 'legitimate_interests')),
  compliance_subject_id uuid NOT NULL,
  policy_publication_event_id uuid NOT NULL,
  pecr_sender_decision_event_id uuid NOT NULL,
  pecr_instigator_decision_event_id uuid NOT NULL,
  permission_use_receipt_id uuid NOT NULL,
  pecr_decision text NOT NULL CHECK (pecr_decision = 'eligible'),
  pecr_evidence_sha256 bytea NOT NULL CHECK (octet_length(pecr_evidence_sha256) = 32),
  operator_instigator_decision text NOT NULL CHECK (operator_instigator_decision = 'eligible'),
  operator_instigator_sha256 bytea NOT NULL CHECK (octet_length(operator_instigator_sha256) = 32),
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
  UNIQUE (workspace_id, id, provider_connection_id, message_delivery_id, recipient_sha256),
  FOREIGN KEY (workspace_id, provider_connection_id)
    REFERENCES app.provider_connections (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, campaign_template_version_id, campaign_definition_sha256)
    REFERENCES app.campaign_template_versions (workspace_id, id, definition_sha256)
    ON DELETE RESTRICT,
  FOREIGN KEY (
    workspace_id, campaign_template_version_id,
    campaign_template_step_id, campaign_step_content_sha256
  ) REFERENCES app.campaign_template_steps (
    workspace_id, template_version_id, id, content_sha256
  ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, campaign_approval_request_id)
    REFERENCES app.campaign_template_approval_requests (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, campaign_approval_decision_id)
    REFERENCES app.campaign_template_approval_decisions (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, message_delivery_id)
    REFERENCES app.message_deliveries (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, provider_operation_id, message_delivery_id)
    REFERENCES app.message_deliveries (workspace_id, provider_operation_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, message_version_id)
    REFERENCES app.message_versions (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, message_approval_request_id)
    REFERENCES app.message_approval_requests (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, message_approval_decision_id)
    REFERENCES app.message_approval_decisions (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, contact_point_id, contact_id)
    REFERENCES app.contact_points (workspace_id, id, contact_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, channel_endpoint_id)
    REFERENCES app.channel_endpoints (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, consent_event_id)
    REFERENCES app.communication_consent_events (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, compliance_subject_id)
    REFERENCES app_private.affiliate_compliance_subjects (workspace_id, id)
    ON DELETE RESTRICT,
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

CREATE TABLE app.property_predator_customer_email_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  authority_id uuid NOT NULL,
  provider_connection_id uuid NOT NULL,
  message_delivery_id uuid NOT NULL,
  recipient_sha256 bytea NOT NULL CHECK (octet_length(recipient_sha256) = 32),
  operation_id uuid NOT NULL,
  correlation_id uuid NOT NULL,
  idempotency_key_sha256 bytea NOT NULL CHECK (octet_length(idempotency_key_sha256) = 32),
  request_sha256 bytea NOT NULL CHECK (octet_length(request_sha256) = 32),
  expected_message_id text NOT NULL CHECK (
    expected_message_id ~ '^<pp-[0-9a-f]{64}@mg[.]propertypredator[.]com>$'
  ),
  utc_day date NOT NULL,
  utc_month date NOT NULL CHECK (utc_month = date_trunc('month', utc_month)::date),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN (
    'queued', 'leased', 'calling', 'awaiting_receipt',
    'succeeded', 'failed', 'needs_attention', 'cancelled'
  )),
  lease_version bigint NOT NULL DEFAULT 0 CHECK (lease_version >= 0),
  lease_expires_at timestamptz,
  claim_count integer NOT NULL DEFAULT 0 CHECK (claim_count BETWEEN 0 AND 8),
  provider_external_id text CHECK (
    provider_external_id IS NULL OR length(btrim(provider_external_id)) BETWEEN 1 AND 500
  ),
  receipt_deadline timestamptz,
  available_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  created_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  calling_at timestamptz,
  settled_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, operation_id),
  UNIQUE (workspace_id, idempotency_key_sha256),
  UNIQUE (workspace_id, expected_message_id),
  FOREIGN KEY (workspace_id, authority_id, provider_connection_id,
    message_delivery_id, recipient_sha256)
    REFERENCES app.property_predator_customer_email_authorities
      (workspace_id, id, provider_connection_id, message_delivery_id, recipient_sha256)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, created_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK ((state IN ('leased', 'calling')) = (lease_expires_at IS NOT NULL)),
  CHECK ((state = 'awaiting_receipt') = (receipt_deadline IS NOT NULL)),
  CHECK (updated_at >= created_at)
);

CREATE TABLE app.property_predator_customer_email_job_leases (
  workspace_id uuid NOT NULL,
  job_id uuid NOT NULL,
  lease_version bigint NOT NULL CHECK (lease_version > 0),
  lease_token_sha256 bytea NOT NULL CHECK (octet_length(lease_token_sha256) = 32),
  issued_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (workspace_id, job_id),
  FOREIGN KEY (workspace_id, job_id)
    REFERENCES app.property_predator_customer_email_jobs (workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE app.property_predator_customer_email_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  job_id uuid NOT NULL,
  provider_connection_id uuid NOT NULL,
  message_delivery_id uuid NOT NULL,
  mailgun_webhook_event_id uuid,
  external_event_id text NOT NULL CHECK (
    external_event_id = btrim(external_event_id)
    AND length(external_event_id) BETWEEN 1 AND 500
  ),
  event_kind text NOT NULL CHECK (event_kind IN (
    'dispatch_accepted', 'dispatch_failed', 'outcome_unknown', 'accepted',
    'delivered', 'opened', 'clicked', 'failed', 'complained', 'unsubscribed'
  )),
  recipient_sha256 bytea NOT NULL CHECK (octet_length(recipient_sha256) = 32),
  payload_sha256 bytea NOT NULL CHECK (octet_length(payload_sha256) = 32),
  safe_code text NOT NULL CHECK (safe_code ~ '^[a-z][a-z0-9_.:-]{0,99}$'),
  provider_occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, provider_connection_id, external_event_id),
  UNIQUE (workspace_id, mailgun_webhook_event_id),
  FOREIGN KEY (workspace_id, job_id)
    REFERENCES app.property_predator_customer_email_jobs (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, provider_connection_id)
    REFERENCES app.provider_connections (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, message_delivery_id)
    REFERENCES app.message_deliveries (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, mailgun_webhook_event_id)
    REFERENCES app.mailgun_webhook_events (workspace_id, id) ON DELETE RESTRICT,
  CHECK ((mailgun_webhook_event_id IS NULL) =
    (event_kind IN ('dispatch_accepted', 'dispatch_failed', 'outcome_unknown')))
);

CREATE INDEX property_predator_customer_email_jobs_claim_idx
  ON app.property_predator_customer_email_jobs
    (workspace_id, provider_connection_id, available_at, created_at)
  WHERE state = 'queued';
CREATE INDEX property_predator_customer_email_jobs_day_cap_idx
  ON app.property_predator_customer_email_jobs
    (workspace_id, provider_connection_id, utc_day)
  WHERE state <> 'cancelled';
CREATE INDEX property_predator_customer_email_jobs_month_cap_idx
  ON app.property_predator_customer_email_jobs
    (workspace_id, provider_connection_id, utc_month)
  WHERE state <> 'cancelled';
CREATE INDEX property_predator_customer_email_jobs_receipt_idx
  ON app.property_predator_customer_email_jobs
    (workspace_id, provider_connection_id, receipt_deadline)
  WHERE state = 'awaiting_receipt';

CREATE FUNCTION app_private.customer_email_live_immutable_guard()
RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog AS $function$
BEGIN
  RAISE EXCEPTION 'Customer email live evidence is immutable' USING ERRCODE = '40001';
  RETURN NULL;
END
$function$;

CREATE FUNCTION app_private.begin_customer_email_live_call(
  p_workspace_id uuid, p_job_id uuid, p_lease_version bigint,
  p_lease_token bytea, p_provider_effects_enabled boolean,
  p_email_delivery_enabled boolean, p_emergency_paused boolean
) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE selected app.property_predator_customer_email_jobs%ROWTYPE;
  eligible boolean := false; day_count integer; month_count integer;
BEGIN
  IF session_user <> 'r72_customer_email_worker_command'
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'worker'
     OR coalesce(current_setting('app.user_id', true), '') <> ''
     OR coalesce(current_setting('app.request_id', true), '') = ''
     OR NOT p_provider_effects_enabled OR NOT p_email_delivery_enabled
     OR p_emergency_paused OR octet_length(p_lease_token) <> 32 THEN
    RAISE EXCEPTION 'Customer email begin-call denied' USING ERRCODE = '42501';
  END IF;
  SELECT job.* INTO selected
  FROM app.property_predator_customer_email_jobs AS job
  JOIN app.property_predator_customer_email_job_leases AS lease
    ON lease.workspace_id = job.workspace_id AND lease.job_id = job.id
   AND lease.lease_version = job.lease_version
   AND lease.lease_token_sha256 = public.digest(p_lease_token, 'sha256')
  WHERE job.workspace_id = p_workspace_id AND job.id = p_job_id
    AND job.state = 'leased' AND job.lease_version = p_lease_version
    AND job.lease_expires_at > statement_timestamp()
  FOR UPDATE OF job;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    format('pp-customer-email:%s:%s', p_workspace_id, selected.provider_connection_id), 0
  ));
  SELECT count(*)::integer INTO day_count
  FROM app.property_predator_customer_email_jobs AS job
  WHERE job.workspace_id = p_workspace_id
    AND job.provider_connection_id = selected.provider_connection_id
    AND job.utc_day = (statement_timestamp() AT TIME ZONE 'UTC')::date
    AND job.state <> 'cancelled';
  SELECT count(*)::integer INTO month_count
  FROM app.property_predator_customer_email_jobs AS job
  WHERE job.workspace_id = p_workspace_id
    AND job.provider_connection_id = selected.provider_connection_id
    AND job.utc_month = date_trunc('month', statement_timestamp() AT TIME ZONE 'UTC')::date
    AND job.state <> 'cancelled';

  SELECT EXISTS (
    SELECT 1
    FROM app.property_predator_customer_email_authorities AS authority
    JOIN app.provider_connections AS connection
      ON connection.workspace_id = authority.workspace_id
     AND connection.id = authority.provider_connection_id
     AND connection.provider_id = 'mailgun_eu' AND connection.provider_kind = 'email'
     AND connection.environment = 'live' AND connection.status = 'active'
     AND connection.capabilities @> '["email.send"]'::jsonb
    JOIN app.campaign_template_versions AS campaign_version
      ON campaign_version.workspace_id = authority.workspace_id
     AND campaign_version.id = authority.campaign_template_version_id
     AND campaign_version.definition_sha256 = authority.campaign_definition_sha256
     AND campaign_version.purpose_key = authority.purpose
     AND NOT campaign_version.provider_effects
    JOIN app.campaign_template_steps AS campaign_step
      ON campaign_step.workspace_id = campaign_version.workspace_id
     AND campaign_step.template_version_id = campaign_version.id
     AND campaign_step.id = authority.campaign_template_step_id
     AND campaign_step.content_sha256 = authority.campaign_step_content_sha256
     AND campaign_step.step_kind = 'email' AND campaign_step.channel = 'email'
     AND campaign_step.requires_human_approval
     AND campaign_step.requires_current_permission
     AND NOT campaign_step.provider_effects
    JOIN app.campaign_template_approval_requests AS campaign_request
      ON campaign_request.workspace_id = campaign_version.workspace_id
     AND campaign_request.id = authority.campaign_approval_request_id
     AND campaign_request.template_version_id = campaign_version.id
     AND campaign_request.template_version_sha256 = campaign_version.definition_sha256
    JOIN app.campaign_template_approval_decisions AS campaign_decision
      ON campaign_decision.workspace_id = campaign_request.workspace_id
     AND campaign_decision.id = authority.campaign_approval_decision_id
     AND campaign_decision.approval_request_id = campaign_request.id
     AND campaign_decision.template_version_id = campaign_version.id
     AND campaign_decision.decision = 'approved'
    JOIN app.message_deliveries AS delivery
      ON delivery.workspace_id = authority.workspace_id
     AND delivery.id = authority.message_delivery_id
     AND delivery.message_version_id = authority.message_version_id
     AND delivery.approval_request_id = authority.message_approval_request_id
     AND delivery.approval_decision_id = authority.message_approval_decision_id
     AND delivery.provider_connection_id = authority.provider_connection_id
     AND delivery.contact_id = authority.contact_id
     AND delivery.contact_point_id = authority.contact_point_id
     AND delivery.channel_endpoint_id = authority.channel_endpoint_id
     AND delivery.status = 'queued' AND delivery.environment = 'live'
     AND delivery.conversation_channel = 'email' AND delivery.purpose = authority.purpose
    JOIN app.provider_operations AS provider_operation
      ON provider_operation.workspace_id = delivery.workspace_id
     AND provider_operation.id = authority.provider_operation_id
     AND provider_operation.message_delivery_id = delivery.id
     AND provider_operation.provider_connection_id = authority.provider_connection_id
     AND provider_operation.operation_kind = 'conversation.send'
     AND provider_operation.environment = 'live'
     AND provider_operation.state = 'reconciliation_required'
     AND provider_operation.provider_reference IS NULL
     AND provider_operation.last_error_code = 'customer_email_live_reserved'
    JOIN app.message_versions AS message_version
      ON message_version.workspace_id = delivery.workspace_id
     AND message_version.id = delivery.message_version_id
     AND message_version.body_sha256 = delivery.body_sha256
    JOIN app.messages AS message
      ON message.workspace_id = message_version.workspace_id
     AND message.id = message_version.message_id
     AND message.current_version_id = message_version.id
     AND message.current_body_sha256 = message_version.body_sha256
     AND message.lifecycle = 'committed' AND message.direction = 'outbound'
    JOIN app.conversations AS conversation
      ON conversation.workspace_id = message.workspace_id
     AND conversation.id = message.conversation_id
     AND conversation.channel = 'email' AND conversation.environment = 'live'
     AND conversation.subject IS NOT NULL
     AND conversation.subject = campaign_step.subject_template
     AND message_version.body_text = campaign_step.body_template
     AND public.digest(conversation.subject, 'sha256') = authority.message_subject_sha256
    JOIN app.channel_endpoints AS endpoint
      ON endpoint.workspace_id = delivery.workspace_id AND endpoint.id = delivery.channel_endpoint_id
     AND endpoint.provider_connection_id = delivery.provider_connection_id
     AND endpoint.channel = 'email' AND endpoint.environment = 'live'
     AND endpoint.status = 'active' AND endpoint.direction IN ('outbound', 'bidirectional')
     AND endpoint.address = authority.sender_endpoint_normalized_address
     AND endpoint.normalized_address = authority.sender_endpoint_normalized_address
     AND authority.sender_endpoint_normalized_address = 'mg.propertypredator.com'
    JOIN app.contact_points AS point
      ON point.workspace_id = authority.workspace_id
     AND point.id = authority.contact_point_id AND point.contact_id = authority.contact_id
     AND point.kind = 'email' AND point.deleted_at IS NULL
     AND point.is_verified AND point.dedupe_state = 'normal'
     AND public.digest(point.normalized_value, 'sha256') = authority.recipient_sha256
     AND public.digest(point.kind || pg_catalog.chr(31) || point.value
       || pg_catalog.chr(31) || point.normalized_value, 'sha256')
       = authority.endpoint_identity_sha256
    JOIN app.communication_consent_events AS consent
      ON consent.workspace_id = authority.workspace_id
     AND consent.id = authority.consent_event_id
     AND consent.contact_id = authority.contact_id
     AND consent.contact_point_id = authority.contact_point_id
     AND consent.channel = 'email' AND consent.purpose = authority.purpose
     AND consent.state = 'granted' AND consent.lawful_basis = authority.lawful_basis
     AND consent.endpoint_identity_sha256 = authority.endpoint_identity_sha256
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
     AND permission_use.permission = 'email.send'
     AND permission_use.action_scope_sha256 = authority.action_scope_sha256
     AND permission_use.eligibility_decision = 'allow'
     AND permission_use.use_state = 'consumed'
     AND permission_use.provider_effects IS FALSE
     AND permission_use.recorded_by_user_id = authority.operator_user_id
     AND permission_use.recorded_request_id = authority.operator_request_id
    JOIN app.workspace_memberships AS operator_membership
      ON operator_membership.workspace_id = authority.workspace_id
     AND operator_membership.user_id = authority.operator_user_id
     AND operator_membership.status = 'active'
     AND operator_membership.role IN ('owner', 'admin')
    WHERE authority.workspace_id = selected.workspace_id
      AND authority.id = selected.authority_id
      AND authority.provider_connection_id = selected.provider_connection_id
      AND authority.message_delivery_id = selected.message_delivery_id
      AND authority.recipient_sha256 = selected.recipient_sha256
      AND authority.valid_until > statement_timestamp()
      AND authority.action_scope_sha256 = public.digest(format(
        'email:%s:%s:%s:%s:%s:%s:%s:%s:%s:%s', authority.workspace_id,
        authority.provider_connection_id, authority.sender_endpoint_normalized_address,
        authority.campaign_template_version_id,
        authority.campaign_template_step_id,
        pg_catalog.encode(authority.campaign_step_content_sha256, 'hex'),
        authority.message_version_id,
        pg_catalog.encode(authority.endpoint_identity_sha256, 'hex'),
        authority.purpose, authority.consent_event_id
      ), 'sha256')
      AND publication.effective_at <= statement_timestamp()
      AND (publication.expires_at IS NULL OR publication.expires_at > statement_timestamp())
      AND sender_route.valid_from <= statement_timestamp()
      AND (sender_route.valid_until IS NULL OR sender_route.valid_until > statement_timestamp())
      AND instigator_route.valid_from <= statement_timestamp()
      AND (instigator_route.valid_until IS NULL OR instigator_route.valid_until > statement_timestamp())
      AND permission_use.consumed_at <= statement_timestamp()
      AND permission_use.decision_expires_at > statement_timestamp()
      AND campaign_request.id = (
        SELECT latest.id FROM app.campaign_template_approval_requests AS latest
        WHERE latest.workspace_id = campaign_version.workspace_id
          AND latest.template_version_id = campaign_version.id
        ORDER BY latest.request_no DESC, latest.requested_at DESC, latest.id DESC LIMIT 1
      )
      AND NOT EXISTS (
        SELECT 1 FROM app.campaign_template_versions AS newer
        WHERE newer.workspace_id = campaign_version.workspace_id
          AND newer.template_id = campaign_version.template_id
          AND newer.version_no > campaign_version.version_no
      )
      AND consent.id = (
        SELECT latest.id FROM app.communication_consent_events AS latest
        WHERE latest.workspace_id = authority.workspace_id
          AND latest.contact_point_id = authority.contact_point_id
          AND latest.channel = 'email' AND latest.purpose = authority.purpose
        ORDER BY latest.occurred_at DESC, latest.recorded_at DESC, latest.id DESC LIMIT 1
      )
      AND NOT EXISTS (
        SELECT 1 FROM app.communication_suppression_events AS suppression
        WHERE suppression.workspace_id = authority.workspace_id
          AND suppression.contact_point_id = authority.contact_point_id
          AND suppression.channel = 'email'
          AND (suppression.purpose IS NULL OR suppression.purpose = authority.purpose)
          AND suppression.state = 'suppressed'
          AND suppression.id = (
            SELECT latest.id FROM app.communication_suppression_events AS latest
            WHERE latest.workspace_id = suppression.workspace_id
              AND latest.contact_point_id = suppression.contact_point_id
              AND latest.channel = suppression.channel
              AND latest.purpose IS NOT DISTINCT FROM suppression.purpose
            ORDER BY latest.occurred_at DESC, latest.recorded_at DESC, latest.id DESC LIMIT 1
           )
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
          AND block.permission = 'email.send'
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
  ) INTO eligible;
  eligible := eligible AND selected.utc_day = (statement_timestamp() AT TIME ZONE 'UTC')::date
    AND selected.utc_month = date_trunc('month', statement_timestamp() AT TIME ZONE 'UTC')::date
    AND day_count BETWEEN 1 AND 10 AND month_count BETWEEN 1 AND 50;
  IF NOT eligible THEN
    UPDATE app.property_predator_customer_email_jobs SET state = 'needs_attention',
      lease_expires_at = NULL, settled_at = statement_timestamp(),
      updated_at = statement_timestamp()
    WHERE workspace_id = p_workspace_id AND id = p_job_id;
    DELETE FROM app.property_predator_customer_email_job_leases
    WHERE workspace_id = p_workspace_id AND job_id = p_job_id;
    RETURN false;
  END IF;
  UPDATE app.property_predator_customer_email_jobs SET state = 'calling',
    calling_at = statement_timestamp(), updated_at = statement_timestamp()
  WHERE workspace_id = p_workspace_id AND id = p_job_id;
  UPDATE app.provider_operations AS provider_operation SET
    provider_reference = selected.expected_message_id,
    row_version = provider_operation.row_version + 1,
    updated_at = statement_timestamp()
  FROM app.property_predator_customer_email_authorities AS authority
  WHERE authority.workspace_id = selected.workspace_id
    AND authority.id = selected.authority_id
    AND provider_operation.workspace_id = authority.workspace_id
    AND provider_operation.id = authority.provider_operation_id
    AND provider_operation.message_delivery_id = selected.message_delivery_id
    AND provider_operation.provider_connection_id = selected.provider_connection_id
    AND provider_operation.state = 'reconciliation_required'
    AND provider_operation.provider_reference IS NULL
    AND provider_operation.last_error_code = 'customer_email_live_reserved';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Customer email provider reference fence lost' USING ERRCODE = '40001';
  END IF;
  UPDATE app.message_deliveries SET status = 'sending', updated_at = statement_timestamp()
  WHERE workspace_id = p_workspace_id AND id = selected.message_delivery_id
    AND status = 'queued';
  IF NOT FOUND THEN RAISE EXCEPTION 'Customer email delivery fence lost' USING ERRCODE = '40001'; END IF;
  RETURN true;
END
$function$;

CREATE FUNCTION app_private.settle_customer_email_live_call(
  p_workspace_id uuid, p_job_id uuid, p_lease_version bigint, p_lease_token bytea,
  p_status text, p_external_id text, p_occurred_at timestamptz,
  p_retryable boolean, p_error_code text, p_summary text, p_receipt_sha256 bytea
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE selected app.property_predator_customer_email_jobs%ROWTYPE;
  next_state text; event_kind text; safe_code text;
BEGIN
  IF session_user <> 'r72_customer_email_worker_command'
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'worker'
     OR coalesce(current_setting('app.user_id', true), '') <> ''
     OR coalesce(current_setting('app.request_id', true), '') = ''
     OR p_status NOT IN ('accepted', 'pending', 'succeeded', 'failed', 'needs_attention')
     OR (p_status IN ('accepted', 'pending', 'succeeded') AND p_external_id IS NULL)
     OR (p_external_id IS NOT NULL AND (
       p_external_id <> btrim(p_external_id)
       OR length(p_external_id) NOT BETWEEN 1 AND 500
     ))
     OR p_retryable IS NULL OR octet_length(p_receipt_sha256) <> 32
     OR p_summary IS NULL OR p_summary <> btrim(p_summary)
     OR length(p_summary) NOT BETWEEN 1 AND 500
     OR (p_error_code IS NOT NULL AND p_error_code !~ '^[a-z][a-z0-9_.:-]{0,99}$') THEN
    RAISE EXCEPTION 'Customer email settlement denied' USING ERRCODE = '42501';
  END IF;
  SELECT job.* INTO selected
  FROM app.property_predator_customer_email_jobs AS job
  WHERE job.workspace_id = p_workspace_id AND job.id = p_job_id
  FOR UPDATE OF job;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Customer email settlement job lost' USING ERRCODE = '40001';
  END IF;
  IF selected.state <> 'calling' THEN
    -- A verified signed webhook may win the race immediately after the worker
    -- crosses the calling fence. Its immutable receipt is the stronger truth;
    -- the later HTTP settlement becomes a replay-safe no-op.
    IF EXISTS (
      SELECT 1 FROM app.property_predator_customer_email_receipts AS receipt
      WHERE receipt.workspace_id = p_workspace_id AND receipt.job_id = p_job_id
        AND receipt.mailgun_webhook_event_id IS NOT NULL
    ) THEN
      RETURN;
    END IF;
    RAISE EXCEPTION 'Customer email settlement lease lost' USING ERRCODE = '40001';
  END IF;
  IF selected.lease_version <> p_lease_version OR NOT EXISTS (
    SELECT 1 FROM app.property_predator_customer_email_job_leases AS lease
    WHERE lease.workspace_id = selected.workspace_id AND lease.job_id = selected.id
      AND lease.lease_version = selected.lease_version
      AND lease.lease_token_sha256 = public.digest(p_lease_token, 'sha256')
  ) THEN
    RAISE EXCEPTION 'Customer email settlement lease lost' USING ERRCODE = '40001';
  END IF;
  next_state := CASE WHEN p_status IN ('accepted', 'pending', 'succeeded')
    THEN 'awaiting_receipt' WHEN p_status = 'failed' THEN 'failed' ELSE 'needs_attention' END;
  event_kind := CASE WHEN next_state = 'awaiting_receipt' THEN 'dispatch_accepted'
    WHEN next_state = 'failed' THEN 'dispatch_failed' ELSE 'outcome_unknown' END;
  safe_code := coalesce(p_error_code, CASE event_kind
    WHEN 'dispatch_accepted' THEN 'mailgun_customer_accepted'
    WHEN 'dispatch_failed' THEN 'mailgun_customer_failed'
    ELSE 'mailgun_customer_outcome_unknown' END);
  UPDATE app.provider_operations AS operation SET
    state = CASE WHEN next_state = 'awaiting_receipt' THEN 'accepted'
      WHEN next_state = 'failed' THEN 'failed' ELSE 'reconciliation_required' END,
    provider_reference = coalesce(p_external_id, selected.expected_message_id),
    attempt_count = greatest(operation.attempt_count, 1),
    next_attempt_at = CASE WHEN next_state = 'needs_attention'
      THEN 'infinity'::timestamptz ELSE operation.next_attempt_at END,
    lease_token_hash = NULL, lease_expires_at = NULL,
    last_error_code = CASE WHEN next_state = 'awaiting_receipt' THEN NULL ELSE safe_code END,
    last_summary = p_summary,
    row_version = operation.row_version + 1,
    updated_at = statement_timestamp(),
    completed_at = CASE WHEN next_state IN ('awaiting_receipt', 'failed')
      THEN statement_timestamp() ELSE NULL END
  WHERE operation.workspace_id = selected.workspace_id
    AND operation.id = selected.operation_id
    AND operation.message_delivery_id = selected.message_delivery_id
    AND operation.provider_connection_id = selected.provider_connection_id
    AND operation.state = 'reconciliation_required'
    AND operation.provider_reference = selected.expected_message_id
    AND operation.last_error_code = 'customer_email_live_reserved'
    AND operation.idempotency_key ~ '^customer-email-live:[0-9a-f]{64}$';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Customer email settlement provider fence lost' USING ERRCODE = '40001';
  END IF;
  UPDATE app.message_deliveries SET
    status = CASE WHEN next_state = 'awaiting_receipt' THEN 'accepted'
      WHEN next_state = 'failed' THEN 'failed' ELSE 'reconciliation_required' END,
    accepted_at = CASE WHEN next_state = 'awaiting_receipt'
      THEN greatest(queued_at, p_occurred_at) ELSE NULL END,
    failed_at = CASE WHEN next_state = 'failed'
      THEN greatest(queued_at, p_occurred_at) ELSE NULL END,
    updated_at = statement_timestamp()
  WHERE workspace_id = p_workspace_id AND id = selected.message_delivery_id
    AND provider_operation_id = selected.operation_id
    AND provider_connection_id = selected.provider_connection_id
    AND status = 'sending';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Customer email settlement delivery fence lost' USING ERRCODE = '40001';
  END IF;
  INSERT INTO app.property_predator_customer_email_receipts (
    workspace_id, job_id, provider_connection_id, message_delivery_id,
    mailgun_webhook_event_id, external_event_id, event_kind, recipient_sha256,
    payload_sha256, safe_code, provider_occurred_at
  ) VALUES (
    p_workspace_id, p_job_id, selected.provider_connection_id,
    selected.message_delivery_id, NULL,
    format('dispatch:%s:%s', p_job_id, p_lease_version), event_kind,
    selected.recipient_sha256, p_receipt_sha256, safe_code, p_occurred_at
  );
  UPDATE app.property_predator_customer_email_jobs SET state = next_state,
    lease_expires_at = NULL, provider_external_id = p_external_id,
    receipt_deadline = CASE WHEN next_state = 'awaiting_receipt'
      THEN statement_timestamp() + interval '24 hours' ELSE NULL END,
    settled_at = CASE WHEN next_state IN ('failed', 'needs_attention')
      THEN statement_timestamp() ELSE NULL END,
    updated_at = statement_timestamp()
  WHERE workspace_id = p_workspace_id AND id = p_job_id;
  DELETE FROM app.property_predator_customer_email_job_leases
  WHERE workspace_id = p_workspace_id AND job_id = p_job_id;
END
$function$;

CREATE FUNCTION app_private.record_customer_email_signed_receipt(
  p_workspace_id uuid, p_provider_connection_id uuid,
  p_external_event_id text
) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE selected_event app.mailgun_webhook_events%ROWTYPE;
  selected_job app.property_predator_customer_email_jobs%ROWTYPE;
  next_state text;
BEGIN
  IF session_user <> 'r72_customer_email_webhook_command'
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'webhook'
     OR coalesce(current_setting('app.user_id', true), '') <> ''
     OR coalesce(current_setting('app.request_id', true), '') = '' THEN
    RAISE EXCEPTION 'Customer email signed receipt denied' USING ERRCODE = '42501';
  END IF;
  IF p_external_event_id IS NULL
     OR p_external_event_id <> btrim(p_external_event_id)
     OR length(p_external_event_id) NOT BETWEEN 1 AND 255
     OR p_external_event_id !~ '^[A-Za-z0-9._:+/=-]+$' THEN
    RETURN 'not_applicable';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    format('pp-customer-email-receipt:%s:%s:%s',
      p_workspace_id, p_provider_connection_id, p_external_event_id), 0
  ));
  SELECT event.* INTO selected_event
  FROM app.mailgun_webhook_events AS event
  WHERE event.workspace_id = p_workspace_id
    AND event.provider_connection_id = p_provider_connection_id
    AND event.external_event_id = p_external_event_id;
  IF NOT FOUND THEN RETURN 'not_applicable'; END IF;
  PERFORM 1
  FROM app.property_predator_customer_email_receipts AS receipt
  WHERE receipt.workspace_id = p_workspace_id
    AND receipt.mailgun_webhook_event_id = selected_event.id;
  IF FOUND THEN RETURN 'replayed'; END IF;
  SELECT job.* INTO selected_job
  FROM app.property_predator_customer_email_jobs AS job
  WHERE job.workspace_id = selected_event.workspace_id
    AND job.provider_connection_id = selected_event.provider_connection_id
    AND job.operation_id = selected_event.provider_operation_id
    AND job.message_delivery_id = selected_event.message_delivery_id
    AND job.recipient_sha256 = selected_event.recipient_identity_sha256
    AND job.state IN (
      'calling', 'awaiting_receipt', 'succeeded', 'failed', 'needs_attention'
    )
  FOR UPDATE OF job;
  IF NOT FOUND THEN RETURN 'not_applicable'; END IF;
  next_state := CASE
    WHEN selected_event.event_type IN ('failed', 'complained', 'unsubscribed')
      THEN 'failed'
    WHEN selected_event.event_type IN ('delivered', 'opened', 'clicked')
      THEN CASE WHEN selected_job.state = 'failed' THEN 'failed' ELSE 'succeeded' END
    WHEN selected_job.state IN ('succeeded', 'failed') THEN selected_job.state
    ELSE 'awaiting_receipt'
  END;
  INSERT INTO app.property_predator_customer_email_receipts (
    workspace_id, job_id, provider_connection_id, message_delivery_id,
    mailgun_webhook_event_id, external_event_id, event_kind, recipient_sha256,
    payload_sha256, safe_code, provider_occurred_at
  ) VALUES (
    p_workspace_id, selected_job.id, p_provider_connection_id,
    selected_job.message_delivery_id, selected_event.id,
    selected_event.external_event_id, selected_event.event_type,
    selected_job.recipient_sha256, selected_event.payload_sha256,
    'mailgun_signed_customer_receipt', selected_event.occurred_at
  );
  UPDATE app.property_predator_customer_email_jobs SET state = next_state,
    lease_expires_at = NULL,
    receipt_deadline = CASE WHEN next_state = 'awaiting_receipt'
      THEN coalesce(receipt_deadline, statement_timestamp() + interval '24 hours')
      ELSE NULL END,
    settled_at = CASE WHEN next_state IN ('succeeded', 'failed')
      THEN statement_timestamp() ELSE settled_at END,
    updated_at = statement_timestamp()
  WHERE workspace_id = p_workspace_id AND id = selected_job.id;
  UPDATE app.provider_operations AS operation SET
    state = CASE
      WHEN selected_event.event_type IN ('failed', 'complained', 'unsubscribed')
        THEN 'failed'
      WHEN selected_event.event_type IN ('delivered', 'opened', 'clicked')
        THEN CASE WHEN operation.state = 'failed' THEN 'failed' ELSE 'succeeded' END
      WHEN operation.state IN ('succeeded', 'failed') THEN operation.state
      ELSE 'accepted'
    END,
    last_error_code = CASE
      WHEN selected_event.event_type IN ('failed', 'complained', 'unsubscribed')
        THEN 'mailgun_' || selected_event.event_type
      ELSE NULL
    END,
    last_summary = 'Projected from exact signed Mailgun customer-email receipt',
    row_version = operation.row_version + 1,
    updated_at = statement_timestamp(),
    completed_at = coalesce(operation.completed_at, statement_timestamp())
  WHERE operation.workspace_id = p_workspace_id
    AND operation.id = selected_job.operation_id
    AND operation.message_delivery_id = selected_job.message_delivery_id
    AND operation.provider_connection_id = selected_job.provider_connection_id
    AND operation.idempotency_key ~ '^customer-email-live:[0-9a-f]{64}$';
  DELETE FROM app.property_predator_customer_email_job_leases
  WHERE workspace_id = p_workspace_id AND job_id = selected_job.id;
  RETURN 'applied';
END
$function$;


CREATE FUNCTION app_private.claim_customer_email_live_job(
  p_workspace_id uuid, p_provider_connection_id uuid,
  p_lease_token bytea, p_lease_seconds integer
) RETURNS TABLE (job_id uuid, lease_version bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE selected record;
  recovered app.property_predator_customer_email_jobs%ROWTYPE;
  timeout_event_id text;
  timeout_safe_code text;
BEGIN
  IF session_user <> 'r72_customer_email_worker_command'
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'worker'
     OR coalesce(current_setting('app.user_id', true), '') <> ''
     OR coalesce(current_setting('app.request_id', true), '') = ''
     OR octet_length(p_lease_token) <> 32 OR p_lease_seconds NOT BETWEEN 30 AND 300 THEN
    RAISE EXCEPTION 'Customer email claim denied' USING ERRCODE = '42501';
  END IF;
  -- A lost lease before calling is safe to requeue. Once calling began, or a
  -- signed provider receipt failed to arrive by its deadline, append immutable
  -- outcome-unknown evidence and quarantine every mutable projection.
  FOR recovered IN
    SELECT job.* FROM app.property_predator_customer_email_jobs AS job
    WHERE job.workspace_id = p_workspace_id
      AND job.provider_connection_id = p_provider_connection_id
      AND (
        (job.state IN ('leased', 'calling')
          AND job.lease_expires_at <= statement_timestamp())
        OR (job.state = 'awaiting_receipt'
          AND job.receipt_deadline <= statement_timestamp())
      )
    FOR UPDATE SKIP LOCKED
  LOOP
    IF recovered.state IN ('calling', 'awaiting_receipt') THEN
      timeout_event_id := CASE WHEN recovered.state = 'calling'
        THEN format('worker-timeout:%s:%s', recovered.id, recovered.lease_version)
        ELSE format('receipt-timeout:%s', recovered.id) END;
      timeout_safe_code := CASE WHEN recovered.state = 'calling'
        THEN 'customer_email_call_outcome_unknown'
        ELSE 'customer_email_receipt_outcome_unknown' END;
      INSERT INTO app.property_predator_customer_email_receipts (
        workspace_id, job_id, provider_connection_id, message_delivery_id,
        mailgun_webhook_event_id, external_event_id, event_kind, recipient_sha256,
        payload_sha256, safe_code, provider_occurred_at
      ) VALUES (
        recovered.workspace_id, recovered.id, recovered.provider_connection_id,
        recovered.message_delivery_id, NULL, timeout_event_id, 'outcome_unknown',
        recovered.recipient_sha256, public.digest(timeout_event_id, 'sha256'),
        timeout_safe_code, statement_timestamp()
      ) ON CONFLICT (workspace_id, provider_connection_id, external_event_id)
        DO NOTHING;
      UPDATE app.message_deliveries SET status = 'reconciliation_required',
        updated_at = statement_timestamp()
      WHERE workspace_id = recovered.workspace_id
        AND id = recovered.message_delivery_id
        AND status IN ('sending', 'accepted');
      UPDATE app.provider_operations AS operation SET
        state = 'reconciliation_required', next_attempt_at = 'infinity'::timestamptz,
        lease_token_hash = NULL, lease_expires_at = NULL,
        last_error_code = timeout_safe_code,
        last_summary = 'Customer email provider outcome is unknown; manual reconciliation required',
        row_version = operation.row_version + 1,
        updated_at = statement_timestamp(), completed_at = NULL
      WHERE operation.workspace_id = recovered.workspace_id
        AND operation.id = recovered.operation_id
        AND operation.message_delivery_id = recovered.message_delivery_id
        AND operation.provider_connection_id = recovered.provider_connection_id
        AND operation.idempotency_key ~ '^customer-email-live:[0-9a-f]{64}$';
    END IF;
    UPDATE app.property_predator_customer_email_jobs SET
      state = CASE WHEN recovered.state = 'leased' AND recovered.claim_count < 8
        THEN 'queued' ELSE 'needs_attention' END,
      available_at = CASE WHEN recovered.state = 'leased' AND recovered.claim_count < 8
        THEN statement_timestamp() ELSE recovered.available_at END,
      lease_expires_at = NULL, receipt_deadline = NULL,
      settled_at = CASE WHEN recovered.state = 'leased' AND recovered.claim_count < 8
        THEN recovered.settled_at ELSE statement_timestamp() END,
      updated_at = statement_timestamp()
    WHERE workspace_id = recovered.workspace_id AND id = recovered.id;
    DELETE FROM app.property_predator_customer_email_job_leases
    WHERE workspace_id = recovered.workspace_id AND job_id = recovered.id;
  END LOOP;

  SELECT job.id, job.lease_version INTO selected
  FROM app.property_predator_customer_email_jobs AS job
  JOIN app.property_predator_customer_email_authorities AS authority
    ON authority.workspace_id = job.workspace_id AND authority.id = job.authority_id
   AND authority.provider_connection_id = job.provider_connection_id
   AND authority.message_delivery_id = job.message_delivery_id
   AND authority.recipient_sha256 = job.recipient_sha256
  JOIN app.provider_connections AS connection
    ON connection.workspace_id = job.workspace_id
   AND connection.id = job.provider_connection_id
   AND connection.provider_id = 'mailgun_eu' AND connection.provider_kind = 'email'
   AND connection.environment = 'live' AND connection.status = 'active'
   AND connection.capabilities @> '["email.send"]'::jsonb
  JOIN app.contact_points AS point
    ON point.workspace_id = authority.workspace_id
   AND point.id = authority.contact_point_id AND point.contact_id = authority.contact_id
   AND point.kind = 'email' AND point.deleted_at IS NULL
   AND point.is_verified AND point.dedupe_state = 'normal'
   AND public.digest(point.normalized_value, 'sha256') = job.recipient_sha256
  JOIN app.communication_consent_events AS consent
    ON consent.workspace_id = authority.workspace_id AND consent.id = authority.consent_event_id
   AND consent.contact_id = authority.contact_id
   AND consent.contact_point_id = authority.contact_point_id
   AND consent.channel = 'email' AND consent.purpose = authority.purpose
   AND consent.state = 'granted' AND consent.lawful_basis = authority.lawful_basis
   AND consent.endpoint_identity_sha256 = authority.endpoint_identity_sha256
  WHERE job.workspace_id = p_workspace_id
    AND job.provider_connection_id = p_provider_connection_id
    AND job.state = 'queued' AND job.available_at <= statement_timestamp()
    AND authority.valid_until > statement_timestamp()
    AND consent.id = (
      SELECT latest.id FROM app.communication_consent_events AS latest
      WHERE latest.workspace_id = authority.workspace_id
        AND latest.contact_point_id = authority.contact_point_id
        AND latest.channel = 'email' AND latest.purpose = authority.purpose
      ORDER BY latest.occurred_at DESC, latest.recorded_at DESC, latest.id DESC LIMIT 1
    )
    AND NOT EXISTS (
      SELECT 1 FROM app.communication_suppression_events AS suppression
      WHERE suppression.workspace_id = authority.workspace_id
        AND suppression.contact_point_id = authority.contact_point_id
        AND suppression.channel = 'email'
        AND (suppression.purpose IS NULL OR suppression.purpose = authority.purpose)
        AND suppression.state = 'suppressed'
        AND suppression.id = (
          SELECT latest.id FROM app.communication_suppression_events AS latest
          WHERE latest.workspace_id = suppression.workspace_id
            AND latest.contact_point_id = suppression.contact_point_id
            AND latest.channel = suppression.channel
            AND latest.purpose IS NOT DISTINCT FROM suppression.purpose
          ORDER BY latest.occurred_at DESC, latest.recorded_at DESC, latest.id DESC LIMIT 1
        )
    )
  ORDER BY job.available_at, job.created_at, job.id
  LIMIT 1 FOR UPDATE OF job SKIP LOCKED;
  IF selected.id IS NULL THEN RETURN; END IF;
  UPDATE app.property_predator_customer_email_jobs SET state = 'leased',
    lease_version = lease_version + 1,
    lease_expires_at = statement_timestamp() + make_interval(secs => p_lease_seconds),
    claim_count = claim_count + 1, updated_at = statement_timestamp()
  WHERE workspace_id = p_workspace_id AND id = selected.id
  RETURNING property_predator_customer_email_jobs.lease_version
    INTO selected.lease_version;
  INSERT INTO app.property_predator_customer_email_job_leases (
    workspace_id, job_id, lease_version, lease_token_sha256
  ) VALUES (
    p_workspace_id, selected.id, selected.lease_version,
    public.digest(p_lease_token, 'sha256')
  ) ON CONFLICT (workspace_id, job_id) DO UPDATE SET
    lease_version = EXCLUDED.lease_version,
    lease_token_sha256 = EXCLUDED.lease_token_sha256,
    issued_at = statement_timestamp();
  RETURN QUERY SELECT selected.id, selected.lease_version;
END
$function$;

CREATE FUNCTION app_private.load_customer_email_live_job(
  p_workspace_id uuid, p_job_id uuid, p_lease_version bigint, p_lease_token bytea
) RETURNS TABLE (
  provider_connection_id uuid, sending_domain text,
  operation_id uuid, correlation_id uuid,
  request_sha256 bytea, expected_message_id text, recipient text,
  subject text, body text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $function$
  SELECT job.provider_connection_id, authority.sender_endpoint_normalized_address,
    job.operation_id, job.correlation_id,
    job.request_sha256, job.expected_message_id, point.normalized_value,
    conversation.subject, version.body_text
  FROM app.property_predator_customer_email_jobs AS job
  JOIN app.property_predator_customer_email_job_leases AS lease
    ON lease.workspace_id = job.workspace_id AND lease.job_id = job.id
   AND lease.lease_version = job.lease_version
   AND lease.lease_token_sha256 = public.digest(p_lease_token, 'sha256')
  JOIN app.property_predator_customer_email_authorities AS authority
    ON authority.workspace_id = job.workspace_id AND authority.id = job.authority_id
   AND authority.message_delivery_id = job.message_delivery_id
   AND authority.recipient_sha256 = job.recipient_sha256
  JOIN app.campaign_template_versions AS campaign_version
    ON campaign_version.workspace_id = authority.workspace_id
   AND campaign_version.id = authority.campaign_template_version_id
   AND campaign_version.definition_sha256 = authority.campaign_definition_sha256
   AND campaign_version.purpose_key = authority.purpose
   AND NOT campaign_version.provider_effects
  JOIN app.campaign_template_steps AS campaign_step
    ON campaign_step.workspace_id = campaign_version.workspace_id
   AND campaign_step.template_version_id = campaign_version.id
   AND campaign_step.id = authority.campaign_template_step_id
   AND campaign_step.content_sha256 = authority.campaign_step_content_sha256
   AND campaign_step.step_kind = 'email' AND campaign_step.channel = 'email'
   AND campaign_step.requires_human_approval
   AND campaign_step.requires_current_permission
   AND NOT campaign_step.provider_effects
  JOIN app.message_deliveries AS delivery
    ON delivery.workspace_id = authority.workspace_id
   AND delivery.id = authority.message_delivery_id
   AND delivery.message_version_id = authority.message_version_id
   AND delivery.approval_request_id = authority.message_approval_request_id
   AND delivery.approval_decision_id = authority.message_approval_decision_id
   AND delivery.provider_connection_id = authority.provider_connection_id
   AND delivery.contact_id = authority.contact_id
   AND delivery.contact_point_id = authority.contact_point_id
   AND delivery.channel_endpoint_id = authority.channel_endpoint_id
   AND delivery.status = 'queued' AND delivery.environment = 'live'
  JOIN app.channel_endpoints AS endpoint
    ON endpoint.workspace_id = delivery.workspace_id
   AND endpoint.id = delivery.channel_endpoint_id
   AND endpoint.provider_connection_id = delivery.provider_connection_id
   AND endpoint.channel = 'email' AND endpoint.environment = 'live'
   AND endpoint.direction IN ('outbound', 'bidirectional')
   AND endpoint.status = 'active'
   AND endpoint.address = authority.sender_endpoint_normalized_address
   AND endpoint.normalized_address = authority.sender_endpoint_normalized_address
   AND authority.sender_endpoint_normalized_address = 'mg.propertypredator.com'
  JOIN app.message_versions AS version
    ON version.workspace_id = delivery.workspace_id
   AND version.id = delivery.message_version_id
   AND version.body_sha256 = delivery.body_sha256
   AND version.channel = 'email' AND version.environment = 'live'
  JOIN app.messages AS message
    ON message.workspace_id = version.workspace_id AND message.id = version.message_id
   AND message.current_version_id = version.id
   AND message.lifecycle = 'committed' AND message.direction = 'outbound'
  JOIN app.conversations AS conversation
    ON conversation.workspace_id = message.workspace_id
   AND conversation.id = message.conversation_id
   AND conversation.channel = 'email' AND conversation.environment = 'live'
   AND conversation.subject IS NOT NULL
   AND conversation.subject = campaign_step.subject_template
   AND version.body_text = campaign_step.body_template
   AND public.digest(conversation.subject, 'sha256') = authority.message_subject_sha256
  JOIN app.contact_points AS point
    ON point.workspace_id = authority.workspace_id
   AND point.id = authority.contact_point_id AND point.contact_id = authority.contact_id
   AND point.kind = 'email' AND point.deleted_at IS NULL
   AND point.is_verified AND point.dedupe_state = 'normal'
   AND public.digest(point.normalized_value, 'sha256') = job.recipient_sha256
  WHERE session_user = 'r72_customer_email_worker_command'
    AND current_setting('app.workspace_id', true) = p_workspace_id::text
    AND current_setting('app.actor_kind', true) = 'worker'
    AND coalesce(current_setting('app.user_id', true), '') = ''
    AND coalesce(current_setting('app.request_id', true), '') <> ''
    AND job.workspace_id = p_workspace_id AND job.id = p_job_id
    AND job.state = 'leased' AND job.lease_version = p_lease_version
    AND job.lease_expires_at > statement_timestamp()
    AND authority.valid_until > statement_timestamp()
    AND authority.action_scope_sha256 = public.digest(format(
      'email:%s:%s:%s:%s:%s:%s:%s:%s:%s:%s', authority.workspace_id,
      authority.provider_connection_id, authority.sender_endpoint_normalized_address,
      authority.campaign_template_version_id, authority.campaign_template_step_id,
      pg_catalog.encode(authority.campaign_step_content_sha256, 'hex'),
      authority.message_version_id,
      pg_catalog.encode(authority.endpoint_identity_sha256, 'hex'),
      authority.purpose, authority.consent_event_id
    ), 'sha256');
$function$;

REVOKE ALL ON FUNCTION app_private.customer_email_live_immutable_guard() FROM PUBLIC;
CREATE TRIGGER customer_email_authorities_immutable BEFORE UPDATE OR DELETE
  ON app.property_predator_customer_email_authorities FOR EACH ROW
  EXECUTE FUNCTION app_private.customer_email_live_immutable_guard();
CREATE TRIGGER customer_email_receipts_immutable BEFORE UPDATE OR DELETE
  ON app.property_predator_customer_email_receipts FOR EACH ROW
  EXECUTE FUNCTION app_private.customer_email_live_immutable_guard();

CREATE FUNCTION app_private.customer_email_live_job_identity_guard()
RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog AS $function$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.authority_id IS DISTINCT FROM OLD.authority_id
     OR NEW.provider_connection_id IS DISTINCT FROM OLD.provider_connection_id
     OR NEW.message_delivery_id IS DISTINCT FROM OLD.message_delivery_id
     OR NEW.recipient_sha256 IS DISTINCT FROM OLD.recipient_sha256
     OR NEW.operation_id IS DISTINCT FROM OLD.operation_id
     OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
     OR NEW.idempotency_key_sha256 IS DISTINCT FROM OLD.idempotency_key_sha256
     OR NEW.request_sha256 IS DISTINCT FROM OLD.request_sha256
     OR NEW.expected_message_id IS DISTINCT FROM OLD.expected_message_id
     OR NEW.utc_day IS DISTINCT FROM OLD.utc_day OR NEW.utc_month IS DISTINCT FROM OLD.utc_month
     OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Customer email job identity evidence is immutable' USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END
$function$;
REVOKE ALL ON FUNCTION app_private.customer_email_live_job_identity_guard() FROM PUBLIC;
CREATE TRIGGER customer_email_jobs_identity_immutable BEFORE UPDATE
  ON app.property_predator_customer_email_jobs FOR EACH ROW
  EXECUTE FUNCTION app_private.customer_email_live_job_identity_guard();

ALTER TABLE app.property_predator_customer_email_authorities ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.property_predator_customer_email_authorities FORCE ROW LEVEL SECURITY;
ALTER TABLE app.property_predator_customer_email_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.property_predator_customer_email_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE app.property_predator_customer_email_job_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.property_predator_customer_email_job_leases FORCE ROW LEVEL SECURITY;
ALTER TABLE app.property_predator_customer_email_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.property_predator_customer_email_receipts FORCE ROW LEVEL SECURITY;

CREATE POLICY customer_email_authorities_owner_all
  ON app.property_predator_customer_email_authorities FOR ALL TO r72_owner
  USING (true) WITH CHECK (true);
CREATE POLICY customer_email_jobs_owner_all
  ON app.property_predator_customer_email_jobs FOR ALL TO r72_owner
  USING (true) WITH CHECK (true);
CREATE POLICY customer_email_leases_owner_all
  ON app.property_predator_customer_email_job_leases FOR ALL TO r72_owner
  USING (true) WITH CHECK (true);
CREATE POLICY customer_email_receipts_owner_all
  ON app.property_predator_customer_email_receipts FOR ALL TO r72_owner
  USING (true) WITH CHECK (true);

CREATE POLICY customer_email_authorities_definer_all
  ON app.property_predator_customer_email_authorities FOR ALL TO r72_customer_email_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY customer_email_jobs_definer_all
  ON app.property_predator_customer_email_jobs FOR ALL TO r72_customer_email_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY customer_email_leases_definer_all
  ON app.property_predator_customer_email_job_leases FOR ALL TO r72_customer_email_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY customer_email_receipts_definer_all
  ON app.property_predator_customer_email_receipts FOR ALL TO r72_customer_email_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

-- The no-login definer may see only the current workspace in the exact source
-- tables needed to re-prove eligibility immediately before a provider call.
DO $dependency_policies$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'provider_connections', 'workspace_memberships', 'channel_endpoints',
    'contact_points', 'communication_consent_events',
    'communication_suppression_events', 'campaign_template_versions',
    'campaign_template_steps',
    'campaign_template_approval_requests', 'campaign_template_approval_decisions',
    'conversations', 'messages', 'message_versions', 'message_approval_requests',
    'message_approval_decisions', 'property_predator_email_pilot_approved_content',
    'provider_operations', 'message_deliveries',
    'mailgun_webhook_events'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY %I ON app.%I FOR SELECT TO r72_customer_email_definer
       USING (workspace_id = nullif(current_setting(''app.workspace_id'', true), '''')::uuid)',
      'customer_email_' || table_name || '_select', table_name
    );
  END LOOP;
END
$dependency_policies$;

CREATE POLICY customer_email_affiliate_policy_reviews_select
  ON app_private.affiliate_compliance_policy_review_events
  FOR SELECT TO r72_customer_email_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY customer_email_affiliate_policy_publications_select
  ON app_private.affiliate_compliance_policy_publication_events
  FOR SELECT TO r72_customer_email_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY customer_email_affiliate_specialist_decisions_select
  ON app_private.affiliate_compliance_specialist_decision_events
  FOR SELECT TO r72_customer_email_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY customer_email_affiliate_permission_facts_select
  ON app_private.affiliate_compliance_permission_fact_events
  FOR SELECT TO r72_customer_email_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY customer_email_affiliate_permission_uses_select
  ON app_private.affiliate_compliance_permission_use_receipts
  FOR SELECT TO r72_customer_email_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

CREATE POLICY customer_email_message_deliveries_update
  ON app.message_deliveries FOR UPDATE TO r72_customer_email_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND conversation_channel = 'email' AND environment = 'live'
    AND idempotency_key ~ '^customer-email-live:[0-9a-f]{64}$')
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND conversation_channel = 'email' AND environment = 'live'
    AND idempotency_key ~ '^customer-email-live:[0-9a-f]{64}$');
CREATE POLICY customer_email_message_deliveries_insert
  ON app.message_deliveries FOR INSERT TO r72_customer_email_definer
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND conversation_channel = 'email' AND consent_channel = 'email'
    AND environment = 'live' AND status = 'queued'
    AND idempotency_key ~ '^customer-email-live:[0-9a-f]{64}$');
CREATE POLICY customer_email_provider_operations_update
  ON app.provider_operations FOR UPDATE TO r72_customer_email_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND environment = 'live'
    AND idempotency_key ~ '^customer-email-live:[0-9a-f]{64}$')
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND environment = 'live'
    AND idempotency_key ~ '^customer-email-live:[0-9a-f]{64}$');
CREATE POLICY customer_email_provider_operations_insert
  ON app.provider_operations FOR INSERT TO r72_customer_email_definer
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND operation_kind = 'conversation.send' AND environment = 'live'
    AND state = 'queued'
    AND idempotency_key ~ '^customer-email-live:[0-9a-f]{64}$');
CREATE POLICY customer_email_messages_update
  ON app.messages FOR UPDATE TO r72_customer_email_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND channel = 'email' AND environment = 'live' AND direction = 'outbound')
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND channel = 'email' AND environment = 'live' AND direction = 'outbound');

GRANT SELECT, INSERT ON app.property_predator_customer_email_authorities
  TO r72_customer_email_definer;
GRANT SELECT, INSERT, UPDATE ON app.property_predator_customer_email_jobs
  TO r72_customer_email_definer;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.property_predator_customer_email_job_leases
  TO r72_customer_email_definer;
GRANT SELECT, INSERT ON app.property_predator_customer_email_receipts
  TO r72_customer_email_definer;
GRANT SELECT ON app.provider_connections, app.workspace_memberships,
  app.channel_endpoints, app.contact_points,
  app.communication_consent_events, app.communication_suppression_events,
  app.campaign_template_versions, app.campaign_template_steps,
  app.campaign_template_approval_requests,
  app.campaign_template_approval_decisions, app.conversations, app.messages,
  app.message_versions, app.message_approval_requests,
  app.message_approval_decisions, app.property_predator_email_pilot_approved_content,
  app.provider_operations, app.message_deliveries,
  app.mailgun_webhook_events TO r72_customer_email_definer;
GRANT SELECT ON app_private.affiliate_compliance_policy_review_events,
  app_private.affiliate_compliance_policy_publication_events,
  app_private.affiliate_compliance_specialist_decision_events,
  app_private.affiliate_compliance_permission_fact_events,
  app_private.affiliate_compliance_permission_use_receipts
  TO r72_customer_email_definer;
GRANT UPDATE (status, accepted_at, failed_at, updated_at)
  ON app.message_deliveries TO r72_customer_email_definer;
GRANT INSERT ON app.message_deliveries TO r72_customer_email_definer;
GRANT UPDATE (lifecycle, row_version, updated_at)
  ON app.messages TO r72_customer_email_definer;
GRANT INSERT ON app.provider_operations TO r72_customer_email_definer;
GRANT UPDATE (state, next_attempt_at, lease_token_hash, lease_version,
  lease_expires_at, provider_reference, last_error_code, last_summary,
  attempt_count, row_version, updated_at, completed_at)
  ON app.provider_operations TO r72_customer_email_definer;

GRANT CREATE ON SCHEMA app_private TO r72_customer_email_definer;
SET LOCAL ROLE r72_customer_email_definer;

CREATE FUNCTION app_private.authorize_and_enqueue_customer_email_live_job(
  p_workspace_id uuid, p_provider_connection_id uuid,
  p_campaign_template_version_id uuid, p_campaign_template_step_id uuid,
  p_campaign_step_content_sha256 bytea, p_campaign_approval_request_id uuid,
  p_campaign_approval_decision_id uuid, p_message_version_id uuid,
  p_message_approval_request_id uuid, p_message_approval_decision_id uuid,
  p_channel_endpoint_id uuid, p_consent_event_id uuid,
  p_compliance_subject_id uuid, p_policy_publication_event_id uuid,
  p_pecr_sender_decision_event_id uuid, p_pecr_instigator_decision_event_id uuid,
  p_permission_use_receipt_id uuid, p_authority_valid_until timestamptz,
  p_provider_operation_id uuid, p_message_delivery_id uuid,
  p_correlation_id uuid, p_idempotency_key_sha256 bytea, p_request_sha256 bytea
) RETURNS TABLE (job_id uuid, disposition text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE
  selected_user uuid;
  selected_request_id text;
  selected_campaign_sha bytea;
  selected_campaign_step_sha bytea;
  selected_campaign_subject text;
  selected_campaign_body text;
  selected_contact_id uuid;
  selected_contact_point_id uuid;
  selected_channel_endpoint_id uuid;
  selected_sender_domain text;
  selected_conversation_id uuid;
  selected_message_id uuid;
  selected_message_version_id uuid;
  selected_message_version_number integer;
  selected_message_body_sha bytea;
  selected_message_approval_request_id uuid;
  selected_message_approval_decision_id uuid;
  selected_message_subject_sha bytea;
  selected_recipient text;
  selected_recipient_sha bytea;
  selected_endpoint_sha bytea;
  selected_purpose text;
  selected_lawful_basis text;
  selected_pecr_sha bytea;
  selected_instigator_sha bytea;
  expected_action_scope bytea;
  expected_request_sha bytea;
  authority_id uuid := gen_random_uuid();
  selected_job_id uuid := gen_random_uuid();
  existing record;
  day_count integer;
  month_count integer;
BEGIN
  IF session_user <> 'r72_customer_email_command'
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'user'
     OR current_setting('app.user_id', true) !~ '^[0-9a-f-]{36}$'
     OR coalesce(current_setting('app.request_id', true), '') = ''
     OR octet_length(p_campaign_step_content_sha256) <> 32
     OR octet_length(p_idempotency_key_sha256) <> 32
     OR octet_length(p_request_sha256) <> 32
     OR p_authority_valid_until <= statement_timestamp()
     OR p_authority_valid_until IS DISTINCT FROM
       date_trunc('milliseconds', p_authority_valid_until)
     OR p_authority_valid_until > statement_timestamp() + interval '15 minutes' THEN
    RAISE EXCEPTION 'Customer email enqueue denied' USING ERRCODE = '42501';
  END IF;
  selected_user := current_setting('app.user_id')::uuid;
  selected_request_id := current_setting('app.request_id');
  IF NOT EXISTS (
    SELECT 1 FROM app.workspace_memberships AS membership
    WHERE membership.workspace_id = p_workspace_id
      AND membership.user_id = selected_user
      AND membership.status = 'active' AND membership.role IN ('owner', 'admin')
  ) THEN RAISE EXCEPTION 'Customer email operator denied' USING ERRCODE = '42501'; END IF;

  -- Serialize idempotency and both caps per exact live Mailgun connection.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    format('pp-customer-email:%s:%s', p_workspace_id, p_provider_connection_id), 0
  ));
  SELECT job.id, job.request_sha256 INTO existing
  FROM app.property_predator_customer_email_jobs AS job
  WHERE job.workspace_id = p_workspace_id
    AND job.idempotency_key_sha256 = p_idempotency_key_sha256;
  IF FOUND THEN
    IF existing.request_sha256 IS DISTINCT FROM p_request_sha256 THEN
      RAISE EXCEPTION 'Customer email idempotency conflict' USING ERRCODE = '40001';
    END IF;
    RETURN QUERY SELECT existing.id, 'replayed'::text;
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM app.provider_connections AS connection
    WHERE connection.workspace_id = p_workspace_id
      AND connection.id = p_provider_connection_id
      AND connection.provider_id = 'mailgun_eu'
      AND connection.provider_kind = 'email'
      AND connection.environment = 'live' AND connection.status = 'active'
      AND connection.capabilities @> '["email.send"]'::jsonb
  ) THEN RAISE EXCEPTION 'Customer email provider binding denied' USING ERRCODE = '42501'; END IF;

  SELECT version.definition_sha256, version.purpose_key,
         step.content_sha256, step.subject_template, step.body_template
    INTO selected_campaign_sha, selected_purpose,
         selected_campaign_step_sha, selected_campaign_subject, selected_campaign_body
  FROM app.campaign_template_versions AS version
  JOIN app.campaign_template_steps AS step
    ON step.workspace_id = version.workspace_id
   AND step.template_version_id = version.id
   AND step.id = p_campaign_template_step_id
   AND step.content_sha256 = p_campaign_step_content_sha256
   AND step.step_kind = 'email' AND step.channel = 'email'
   AND step.requires_human_approval AND step.requires_current_permission
   AND NOT step.provider_effects
  JOIN app.campaign_template_approval_requests AS request
    ON request.workspace_id = version.workspace_id
   AND request.template_version_id = version.id
   AND request.template_version_sha256 = version.definition_sha256
   AND request.id = p_campaign_approval_request_id
  JOIN app.campaign_template_approval_decisions AS decision
    ON decision.workspace_id = request.workspace_id
   AND decision.template_version_id = request.template_version_id
   AND decision.approval_request_id = request.id
   AND decision.template_version_sha256 = request.template_version_sha256
   AND decision.id = p_campaign_approval_decision_id
   AND decision.decision = 'approved'
  WHERE version.workspace_id = p_workspace_id
    AND version.id = p_campaign_template_version_id
    AND NOT version.provider_effects
    AND request.id = (
      SELECT latest.id FROM app.campaign_template_approval_requests AS latest
      WHERE latest.workspace_id = version.workspace_id
        AND latest.template_version_id = version.id
      ORDER BY latest.request_no DESC, latest.requested_at DESC, latest.id DESC LIMIT 1
    )
    AND NOT EXISTS (
      SELECT 1 FROM app.campaign_template_versions AS newer
      WHERE newer.workspace_id = version.workspace_id
        AND newer.template_id = version.template_id
        AND newer.version_no > version.version_no
    );
  IF selected_campaign_sha IS NULL OR selected_campaign_step_sha IS NULL THEN
    RAISE EXCEPTION 'Customer email campaign approval denied' USING ERRCODE = '42501';
  END IF;

  SELECT message.contact_id, message.contact_point_id, endpoint.id,
         endpoint.normalized_address,
         conversation.id, message.id, message_version.id,
         message_version.version_number, message_version.body_sha256,
         message_request.id, message_decision.id,
         point.normalized_value, public.digest(point.normalized_value, 'sha256'),
         public.digest(point.kind || pg_catalog.chr(31) || point.value
           || pg_catalog.chr(31) || point.normalized_value, 'sha256'),
         consent.lawful_basis, public.digest(conversation.subject, 'sha256')
    INTO selected_contact_id, selected_contact_point_id, selected_channel_endpoint_id,
         selected_sender_domain,
         selected_conversation_id, selected_message_id, selected_message_version_id,
         selected_message_version_number, selected_message_body_sha,
         selected_message_approval_request_id, selected_message_approval_decision_id,
         selected_recipient, selected_recipient_sha, selected_endpoint_sha,
         selected_lawful_basis, selected_message_subject_sha
  FROM app.message_versions AS message_version
  JOIN app.messages AS message
    ON message.workspace_id = message_version.workspace_id
   AND message.id = message_version.message_id
   AND message.current_version_id = message_version.id
   AND message.current_version_number = message_version.version_number
   AND message.current_body_sha256 = message_version.body_sha256
   AND message.lifecycle = 'approved' AND message.direction = 'outbound'
   AND message.channel = 'email' AND message.environment = 'live'
  JOIN app.conversations AS conversation
    ON conversation.workspace_id = message.workspace_id
   AND conversation.id = message.conversation_id
   AND conversation.contact_id = message.contact_id
   AND conversation.channel = 'email' AND conversation.environment = 'live'
   AND conversation.subject = selected_campaign_subject
   AND octet_length(conversation.subject) BETWEEN 1 AND 500
  JOIN app.message_approval_requests AS message_request
    ON message_request.workspace_id = message_version.workspace_id
   AND message_request.id = p_message_approval_request_id
   AND message_request.message_id = message.id
   AND message_request.message_version_id = message_version.id
   AND message_request.version_number = message_version.version_number
   AND message_request.body_sha256 = message_version.body_sha256
  JOIN app.message_approval_decisions AS message_decision
    ON message_decision.workspace_id = message_request.workspace_id
   AND message_decision.id = p_message_approval_decision_id
   AND message_decision.message_id = message.id
   AND message_decision.message_version_id = message_version.id
   AND message_decision.approval_request_id = message_request.id
   AND message_decision.version_number = message_version.version_number
   AND message_decision.body_sha256 = message_version.body_sha256
   AND message_decision.decision = 'approved'
  JOIN app.property_predator_email_pilot_approved_content AS approved_content
    ON approved_content.workspace_id = message_decision.workspace_id
   AND approved_content.message_version_id = message_version.id
   AND approved_content.approval_request_id = message_request.id
   AND approved_content.approval_decision_id = message_decision.id
   AND approved_content.subject_sha256 = public.digest(conversation.subject, 'sha256')
   AND approved_content.body_sha256 = message_version.body_sha256
  JOIN app.channel_endpoints AS endpoint
    ON endpoint.workspace_id = message_version.workspace_id
   AND endpoint.id = p_channel_endpoint_id
   AND endpoint.provider_connection_id = p_provider_connection_id
   AND endpoint.channel = 'email' AND endpoint.environment = 'live'
   AND endpoint.status = 'active' AND endpoint.direction IN ('outbound', 'bidirectional')
   AND endpoint.address = 'mg.propertypredator.com'
   AND endpoint.normalized_address = 'mg.propertypredator.com'
  JOIN app.contact_points AS point
    ON point.workspace_id = message.workspace_id
   AND point.id = message.contact_point_id AND point.contact_id = message.contact_id
   AND point.kind = 'email' AND point.deleted_at IS NULL
   AND point.is_verified AND point.dedupe_state = 'normal'
   AND point.normalized_value = lower(point.normalized_value)
   AND point.normalized_value ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
  JOIN app.communication_consent_events AS consent
    ON consent.workspace_id = message.workspace_id
   AND consent.id = p_consent_event_id
   AND consent.contact_id = message.contact_id
   AND consent.contact_point_id = message.contact_point_id
   AND consent.channel = 'email' AND consent.purpose = selected_purpose
   AND consent.state = 'granted'
   AND consent.lawful_basis IN ('consent', 'legitimate_interests')
   AND consent.endpoint_identity_sha256 = public.digest(
     point.kind || pg_catalog.chr(31) || point.value
       || pg_catalog.chr(31) || point.normalized_value, 'sha256'
   )
  WHERE message_version.workspace_id = p_workspace_id
    AND message_version.id = p_message_version_id
    AND message_version.channel = 'email' AND message_version.environment = 'live'
    AND message_version.body_text = selected_campaign_body
    AND octet_length(message_version.body_text) BETWEEN 1 AND 8192
    AND message_request.id = (
      SELECT latest.id FROM app.message_approval_requests AS latest
      WHERE latest.workspace_id = message_version.workspace_id
        AND latest.message_id = message.id
        AND latest.message_version_id = message_version.id
      ORDER BY latest.request_number DESC, latest.requested_at DESC, latest.id DESC LIMIT 1
    )
    AND consent.id = (
      SELECT latest.id FROM app.communication_consent_events AS latest
      WHERE latest.workspace_id = message.workspace_id
        AND latest.contact_point_id = message.contact_point_id
        AND latest.channel = 'email' AND latest.purpose = selected_purpose
      ORDER BY latest.occurred_at DESC, latest.recorded_at DESC, latest.id DESC LIMIT 1
    )
    AND NOT EXISTS (
      SELECT 1 FROM app.communication_suppression_events AS suppression
      WHERE suppression.workspace_id = message.workspace_id
        AND suppression.contact_point_id = message.contact_point_id
        AND suppression.channel = 'email'
        AND (suppression.purpose IS NULL OR suppression.purpose = selected_purpose)
        AND suppression.state = 'suppressed'
        AND suppression.id = (
          SELECT latest.id FROM app.communication_suppression_events AS latest
          WHERE latest.workspace_id = suppression.workspace_id
            AND latest.contact_point_id = suppression.contact_point_id
            AND latest.channel = suppression.channel
            AND latest.purpose IS NOT DISTINCT FROM suppression.purpose
          ORDER BY latest.occurred_at DESC, latest.recorded_at DESC, latest.id DESC LIMIT 1
        )
    );
  IF selected_recipient IS NULL THEN
    RAISE EXCEPTION 'Customer email recipient consent or suppression denied' USING ERRCODE = '42501';
  END IF;

  expected_action_scope := public.digest(format(
    'email:%s:%s:%s:%s:%s:%s:%s:%s:%s:%s', p_workspace_id,
    p_provider_connection_id, selected_sender_domain,
    p_campaign_template_version_id,
    p_campaign_template_step_id, pg_catalog.encode(selected_campaign_step_sha, 'hex'),
    selected_message_version_id, pg_catalog.encode(selected_endpoint_sha, 'hex'),
    selected_purpose, p_consent_event_id
  ), 'sha256');

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
   AND commercial_review.review_dimension = 'commercial'
   AND commercial_review.decision = 'approved'
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
   AND permission_use.permission = 'email.send'
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
    AND permission_use.recorded_request_id = selected_request_id
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
        AND block.permission = 'email.send'
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
    RAISE EXCEPTION 'Customer email durable legal/operator evidence denied'
      USING ERRCODE = '42501';
  END IF;

  expected_request_sha := public.digest(pg_catalog.concat_ws(pg_catalog.chr(31),
    'propertypredator.customer-email-live/v1', p_workspace_id::text,
    p_provider_connection_id::text, selected_sender_domain,
    p_campaign_template_version_id::text,
    pg_catalog.encode(selected_campaign_sha, 'hex'), p_campaign_template_step_id::text,
    pg_catalog.encode(selected_campaign_step_sha, 'hex'),
    p_campaign_approval_request_id::text, p_campaign_approval_decision_id::text,
    selected_message_version_id::text,
    pg_catalog.encode(selected_message_body_sha, 'hex'),
    selected_message_approval_request_id::text,
    selected_message_approval_decision_id::text,
    selected_channel_endpoint_id::text, p_consent_event_id::text,
    p_compliance_subject_id::text, p_policy_publication_event_id::text,
    p_pecr_sender_decision_event_id::text,
    p_pecr_instigator_decision_event_id::text,
    p_permission_use_receipt_id::text,
    pg_catalog.to_char(
      p_authority_valid_until AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    p_provider_operation_id::text, p_message_delivery_id::text,
    p_correlation_id::text, pg_catalog.encode(p_idempotency_key_sha256, 'hex'),
    selected_contact_id::text, selected_contact_point_id::text,
    pg_catalog.encode(selected_recipient_sha, 'hex'),
    pg_catalog.encode(selected_message_subject_sha, 'hex'),
    pg_catalog.encode(selected_endpoint_sha, 'hex'),
    selected_purpose, pg_catalog.encode(expected_action_scope, 'hex'),
    selected_user::text, selected_request_id
  ), 'sha256');
  IF expected_request_sha IS DISTINCT FROM p_request_sha256 THEN
    RAISE EXCEPTION 'Customer email request digest conflict' USING ERRCODE = '40001';
  END IF;

  SELECT count(*)::integer INTO day_count
  FROM app.property_predator_customer_email_jobs AS job
  WHERE job.workspace_id = p_workspace_id
    AND job.provider_connection_id = p_provider_connection_id
    AND job.utc_day = (statement_timestamp() AT TIME ZONE 'UTC')::date
    AND job.state <> 'cancelled';
  SELECT count(*)::integer INTO month_count
  FROM app.property_predator_customer_email_jobs AS job
  WHERE job.workspace_id = p_workspace_id
    AND job.provider_connection_id = p_provider_connection_id
    AND job.utc_month = date_trunc('month', statement_timestamp() AT TIME ZONE 'UTC')::date
    AND job.state <> 'cancelled';
  IF day_count >= 10 OR month_count >= 50 THEN
    RAISE EXCEPTION 'Customer email hard cap reached' USING ERRCODE = '54000';
  END IF;

  INSERT INTO app.provider_operations (
    id, workspace_id, provider_connection_id, message_delivery_id,
    operation_kind, environment, state, idempotency_key, correlation_id,
    attempt_count, max_attempts, created_by_actor_kind, created_by_user_id
  ) VALUES (
    p_provider_operation_id, p_workspace_id, p_provider_connection_id,
    p_message_delivery_id, 'conversation.send', 'live', 'queued',
    'customer-email-live:' || pg_catalog.encode(p_idempotency_key_sha256, 'hex'),
    p_correlation_id, 0, 1, 'user', selected_user
  );
  INSERT INTO app.message_deliveries (
    id, workspace_id, conversation_id, message_id, message_version_id,
    version_number, body_sha256, approval_request_id, approval_decision_id,
    provider_operation_id, provider_connection_id, channel_endpoint_id,
    contact_id, contact_point_id, conversation_channel, consent_channel,
    purpose, consent_event_id, endpoint_identity_sha256, environment,
    status, idempotency_key, created_by_user_id
  ) VALUES (
    p_message_delivery_id, p_workspace_id, selected_conversation_id,
    selected_message_id, selected_message_version_id, selected_message_version_number,
    selected_message_body_sha, selected_message_approval_request_id,
    selected_message_approval_decision_id, p_provider_operation_id,
    p_provider_connection_id, selected_channel_endpoint_id,
    selected_contact_id, selected_contact_point_id, 'email', 'email',
    selected_purpose, p_consent_event_id, selected_endpoint_sha, 'live', 'queued',
    'customer-email-live:' || pg_catalog.encode(p_idempotency_key_sha256, 'hex'),
    selected_user
  );
  UPDATE app.provider_operations SET state = 'reconciliation_required',
    next_attempt_at = 'infinity'::timestamptz, lease_token_hash = NULL,
    lease_expires_at = NULL, last_error_code = 'customer_email_live_reserved',
    last_summary = 'Reserved for exact-recipient customer email live worker',
    row_version = row_version + 1, updated_at = statement_timestamp(),
    completed_at = NULL
  WHERE workspace_id = p_workspace_id AND id = p_provider_operation_id
    AND message_delivery_id = p_message_delivery_id
    AND provider_connection_id = p_provider_connection_id
    AND state = 'queued'
    AND provider_reference IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Customer email provider operation reservation lost'
      USING ERRCODE = '40001';
  END IF;
  UPDATE app.messages AS message SET lifecycle = 'committed',
    row_version = message.row_version + 1, updated_at = statement_timestamp()
  WHERE message.workspace_id = p_workspace_id AND message.id = selected_message_id
    AND message.current_version_id = selected_message_version_id
    AND message.current_body_sha256 = selected_message_body_sha
    AND message.lifecycle = 'approved';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Customer email approved message commit lost'
      USING ERRCODE = '40001';
  END IF;

  INSERT INTO app.property_predator_customer_email_authorities (
    id, workspace_id, provider_connection_id, campaign_template_version_id,
    campaign_template_step_id, campaign_step_content_sha256,
    campaign_definition_sha256, campaign_approval_request_id,
    campaign_approval_decision_id, message_delivery_id, provider_operation_id,
    message_version_id,
    message_approval_request_id, message_approval_decision_id,
    message_subject_sha256, contact_id,
    contact_point_id, channel_endpoint_id, sender_endpoint_normalized_address,
    recipient_sha256,
    endpoint_identity_sha256, consent_event_id, purpose, lawful_basis,
    compliance_subject_id, policy_publication_event_id,
    pecr_sender_decision_event_id, pecr_instigator_decision_event_id,
    permission_use_receipt_id,
    pecr_decision, pecr_evidence_sha256, operator_instigator_decision,
    operator_instigator_sha256, action_scope_sha256, operator_user_id,
    operator_request_id, evaluated_at, valid_until
  ) VALUES (
    authority_id, p_workspace_id, p_provider_connection_id,
    p_campaign_template_version_id, p_campaign_template_step_id,
    selected_campaign_step_sha, selected_campaign_sha,
    p_campaign_approval_request_id, p_campaign_approval_decision_id,
    p_message_delivery_id, p_provider_operation_id,
    selected_message_version_id,
    selected_message_approval_request_id, selected_message_approval_decision_id,
    selected_message_subject_sha, selected_contact_id, selected_contact_point_id,
    selected_channel_endpoint_id, selected_sender_domain,
    selected_recipient_sha, selected_endpoint_sha, p_consent_event_id,
    selected_purpose, selected_lawful_basis,
    p_compliance_subject_id, p_policy_publication_event_id,
    p_pecr_sender_decision_event_id, p_pecr_instigator_decision_event_id,
    p_permission_use_receipt_id,
    'eligible', selected_pecr_sha,
    'eligible', selected_instigator_sha, expected_action_scope,
    selected_user, selected_request_id, statement_timestamp(), p_authority_valid_until
  );
  INSERT INTO app.property_predator_customer_email_jobs (
    id, workspace_id, authority_id, provider_connection_id,
    message_delivery_id, recipient_sha256, operation_id, correlation_id,
    idempotency_key_sha256, request_sha256, expected_message_id,
    utc_day, utc_month, created_by_user_id
  ) VALUES (
    selected_job_id, p_workspace_id, authority_id, p_provider_connection_id,
    p_message_delivery_id, selected_recipient_sha, p_provider_operation_id, p_correlation_id,
    p_idempotency_key_sha256, p_request_sha256,
    '<pp-' || pg_catalog.encode(p_request_sha256, 'hex') || '@mg.propertypredator.com>',
    (statement_timestamp() AT TIME ZONE 'UTC')::date,
    date_trunc('month', statement_timestamp() AT TIME ZONE 'UTC')::date,
    selected_user
  );
  RETURN QUERY SELECT selected_job_id, 'queued'::text;
END
$function$;

SET LOCAL ROLE r72_owner;

-- The first functions are declared before the definer assumes CREATE solely
-- so PostgreSQL can validate trigger/function dependencies in migration order.
-- Transfer every callable boundary to the narrow no-login owner before grants.
ALTER FUNCTION app_private.claim_customer_email_live_job(uuid, uuid, bytea, integer)
  OWNER TO r72_customer_email_definer;
ALTER FUNCTION app_private.load_customer_email_live_job(uuid, uuid, bigint, bytea)
  OWNER TO r72_customer_email_definer;
ALTER FUNCTION app_private.begin_customer_email_live_call(
  uuid, uuid, bigint, bytea, boolean, boolean, boolean
) OWNER TO r72_customer_email_definer;
ALTER FUNCTION app_private.settle_customer_email_live_call(
  uuid, uuid, bigint, bytea, text, text, timestamptz,
  boolean, text, text, bytea
) OWNER TO r72_customer_email_definer;
ALTER FUNCTION app_private.record_customer_email_signed_receipt(uuid, uuid, text)
  OWNER TO r72_customer_email_definer;

REVOKE CREATE ON SCHEMA app_private FROM r72_customer_email_definer;
REVOKE ALL ON FUNCTION app_private.authorize_and_enqueue_customer_email_live_job(
  uuid, uuid, uuid, uuid, bytea, uuid, uuid, uuid,
  uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid,
  uuid, timestamptz, uuid, uuid, uuid, bytea, bytea
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.claim_customer_email_live_job(
  uuid, uuid, bytea, integer
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.load_customer_email_live_job(
  uuid, uuid, bigint, bytea
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.begin_customer_email_live_call(
  uuid, uuid, bigint, bytea, boolean, boolean, boolean
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.settle_customer_email_live_call(
  uuid, uuid, bigint, bytea, text, text, timestamptz,
  boolean, text, text, bytea
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.record_customer_email_signed_receipt(
  uuid, uuid, text
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app_private.authorize_and_enqueue_customer_email_live_job(
  uuid, uuid, uuid, uuid, bytea, uuid, uuid, uuid,
  uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid,
  uuid, timestamptz, uuid, uuid, uuid, bytea, bytea
) TO r72_customer_email_command;
GRANT EXECUTE ON FUNCTION app_private.claim_customer_email_live_job(
  uuid, uuid, bytea, integer
) TO r72_customer_email_worker_command;
GRANT EXECUTE ON FUNCTION app_private.load_customer_email_live_job(
  uuid, uuid, bigint, bytea
) TO r72_customer_email_worker_command;
GRANT EXECUTE ON FUNCTION app_private.begin_customer_email_live_call(
  uuid, uuid, bigint, bytea, boolean, boolean, boolean
) TO r72_customer_email_worker_command;
GRANT EXECUTE ON FUNCTION app_private.settle_customer_email_live_call(
  uuid, uuid, bigint, bytea, text, text, timestamptz,
  boolean, text, text, bytea
) TO r72_customer_email_worker_command;
GRANT EXECUTE ON FUNCTION app_private.record_customer_email_signed_receipt(
  uuid, uuid, text
) TO r72_customer_email_webhook_command;
GRANT EXECUTE ON FUNCTION app_private.runtime_schema_migrations(),
  app_private.runtime_database_installation_id()
  TO r72_customer_email_command, r72_customer_email_worker_command,
  r72_customer_email_webhook_command;
GRANT EXECUTE ON FUNCTION app_private.lock_active_portal_session(bytea, uuid, uuid)
  TO r72_customer_email_command;

INSERT INTO app_private.workspace_table_registry (schema_name, table_name, workspace_column)
VALUES
  ('app', 'property_predator_customer_email_authorities', 'workspace_id'),
  ('app', 'property_predator_customer_email_jobs', 'workspace_id'),
  ('app', 'property_predator_customer_email_job_leases', 'workspace_id'),
  ('app', 'property_predator_customer_email_receipts', 'workspace_id');

DO $capability_audit$
DECLARE checked_role text; unsafe_object text;
BEGIN
  FOREACH checked_role IN ARRAY ARRAY[
    'r72_customer_email_command', 'r72_customer_email_worker_command',
    'r72_customer_email_webhook_command'
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
      RAISE EXCEPTION 'Unsafe customer email table capability: % -> %',
        checked_role, unsafe_object;
    END IF;
  END LOOP;
END
$capability_audit$;
