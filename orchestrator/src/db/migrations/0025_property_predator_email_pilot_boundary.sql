-- Atomic, fail-closed PostgreSQL authorization boundary for the controlled
-- Property Predator Mailgun pilot. The LOGIN role can execute three narrowly
-- scoped functions; it cannot inspect or mutate any application table.

DO $roles$
DECLARE
  role_name text;
  expected_login boolean;
  unsafe_membership text;
BEGIN
  FOR role_name, expected_login IN
    SELECT required.role_name, required.expected_login
    FROM (VALUES
      ('r72_mailgun_worker_definer', false),
      ('r72_mailgun_worker_command', true)
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
      RAISE EXCEPTION 'Unsafe Mailgun worker role attributes: %', role_name;
    END IF;
  END LOOP;

  REVOKE r72_owner, r72_security_definer, r72_onboarding_definer,
    r72_setup_delivery_definer, r72_commerce_definer,
    r72_external_event_definer, r72_provider_operation_definer,
    r72_mailgun_webhook_definer
  FROM r72_mailgun_worker_definer, r72_mailgun_worker_command;
  REVOKE r72_mailgun_worker_definer
  FROM r72_web, r72_public, r72_worker, r72_webhook, r72_readonly,
    r72_crm_command, r72_identity_command, r72_provisioning_command,
    r72_setup_delivery_command, r72_setup_reissue_command,
    r72_external_event_command, r72_mailgun_webhook_command,
    r72_mailgun_worker_command;
  REVOKE r72_mailgun_worker_command
  FROM r72_web, r72_public, r72_worker, r72_webhook, r72_readonly,
    r72_crm_command, r72_identity_command, r72_provisioning_command,
    r72_setup_delivery_command, r72_setup_reissue_command,
    r72_external_event_command, r72_mailgun_webhook_command,
    r72_mailgun_worker_definer, r72_owner;

  SELECT member.rolname || '->' || parent.rolname INTO unsafe_membership
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
  JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
  WHERE member.rolname IN (
    'r72_mailgun_worker_definer', 'r72_mailgun_worker_command'
  )
  LIMIT 1;
  IF unsafe_membership IS NOT NULL THEN
    RAISE EXCEPTION 'Unsafe Mailgun worker role membership: %', unsafe_membership;
  END IF;

  GRANT r72_mailgun_worker_definer TO r72_owner;
  EXECUTE format('GRANT r72_mailgun_worker_command TO %I', current_user);
END
$roles$;

SET LOCAL ROLE r72_owner;

REVOKE ALL ON SCHEMA app, app_private
  FROM r72_mailgun_worker_definer, r72_mailgun_worker_command;
REVOKE ALL ON ALL TABLES IN SCHEMA app
  FROM r72_mailgun_worker_definer, r72_mailgun_worker_command;
REVOKE ALL ON ALL TABLES IN SCHEMA app_private
  FROM r72_mailgun_worker_definer, r72_mailgun_worker_command;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app_private
  FROM r72_mailgun_worker_definer, r72_mailgun_worker_command;
REVOKE CREATE ON SCHEMA public
  FROM r72_mailgun_worker_definer, r72_mailgun_worker_command;

-- These two ledgers are append-only operator evidence. No runtime identity can
-- activate delivery or attest an owned seed; activation remains a separate,
-- privileged production operation.
CREATE TABLE app.property_predator_email_pilot_control_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  provider_connection_id uuid NOT NULL,
  provider_effects_enabled boolean NOT NULL DEFAULT false,
  email_delivery_enabled boolean NOT NULL DEFAULT false,
  emergency_paused boolean NOT NULL DEFAULT true,
  max_recipients integer NOT NULL CHECK (max_recipients BETWEEN 1 AND 10),
  estimated_recipient_cost_usd_micros integer NOT NULL CHECK (
    estimated_recipient_cost_usd_micros BETWEEN 1 AND 1000000
  ),
  run_message_cap integer NOT NULL CHECK (
    run_message_cap BETWEEN 1 AND max_recipients
  ),
  monthly_message_cap integer NOT NULL CHECK (
    monthly_message_cap BETWEEN run_message_cap AND 10000
  ),
  run_spend_cap_usd_micros bigint NOT NULL CHECK (
    run_spend_cap_usd_micros BETWEEN 1 AND 100000000
  ),
  monthly_spend_cap_usd_micros bigint NOT NULL CHECK (
    monthly_spend_cap_usd_micros BETWEEN run_spend_cap_usd_micros AND 100000000
  ),
  reason text NOT NULL CHECK (
    reason = lower(btrim(reason))
    AND reason ~ '^[a-z][a-z0-9_.:-]{0,99}$'
  ),
  recorded_by text NOT NULL CHECK (
    recorded_by = btrim(recorded_by) AND length(recorded_by) BETWEEN 1 AND 120
  ),
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, provider_connection_id)
    REFERENCES app.provider_connections (workspace_id, id) ON DELETE RESTRICT,
  CHECK (occurred_at <= recorded_at + interval '5 minutes'),
  CHECK (
    estimated_recipient_cost_usd_micros::bigint * run_message_cap
      <= run_spend_cap_usd_micros
  ),
  CHECK (
    estimated_recipient_cost_usd_micros::bigint * monthly_message_cap
      <= monthly_spend_cap_usd_micros
  )
);

CREATE INDEX property_predator_email_pilot_controls_current_idx
  ON app.property_predator_email_pilot_control_events (
    workspace_id, provider_connection_id, occurred_at DESC,
    recorded_at DESC, id DESC
  );

CREATE TABLE app.property_predator_email_pilot_seed_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  email_sha256 bytea NOT NULL CHECK (octet_length(email_sha256) = 32),
  state text NOT NULL CHECK (state IN ('owned', 'revoked')),
  attestation text NOT NULL CHECK (
    attestation = btrim(attestation)
    AND length(attestation) BETWEEN 1 AND 500
  ),
  recorded_by text NOT NULL CHECK (
    recorded_by = btrim(recorded_by) AND length(recorded_by) BETWEEN 1 AND 120
  ),
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  CHECK (occurred_at <= recorded_at + interval '5 minutes')
);

CREATE INDEX property_predator_email_pilot_seeds_current_idx
  ON app.property_predator_email_pilot_seed_events (
    workspace_id, email_sha256, occurred_at DESC, recorded_at DESC, id DESC
  );

-- Subject is not part of 0022's body digest. Capture the exact subject and
-- combined content digest in the same transaction as every future live email
-- approval. Existing approvals intentionally receive no backfill: the pilot
-- requires a fresh, post-migration approval rather than inventing history.
CREATE TABLE app.property_predator_email_pilot_approved_content (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  message_version_id uuid NOT NULL,
  approval_request_id uuid NOT NULL,
  approval_decision_id uuid NOT NULL,
  subject_sha256 bytea NOT NULL CHECK (octet_length(subject_sha256) = 32),
  body_sha256 bytea NOT NULL CHECK (octet_length(body_sha256) = 32),
  approved_content_sha256 bytea NOT NULL CHECK (
    octet_length(approved_content_sha256) = 32
  ),
  captured_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, approval_decision_id),
  FOREIGN KEY (workspace_id, message_version_id)
    REFERENCES app.message_versions (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, approval_request_id)
    REFERENCES app.message_approval_requests (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, approval_decision_id)
    REFERENCES app.message_approval_decisions (workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE app.property_predator_email_pilot_run_usage (
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  run_id uuid NOT NULL,
  reserved_messages integer NOT NULL CHECK (reserved_messages >= 0),
  reserved_spend_usd_micros bigint NOT NULL CHECK (reserved_spend_usd_micros >= 0),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (workspace_id, run_id)
);

CREATE TABLE app.property_predator_email_pilot_month_usage (
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  utc_month date NOT NULL CHECK (utc_month = date_trunc('month', utc_month)::date),
  reserved_messages integer NOT NULL CHECK (reserved_messages >= 0),
  reserved_spend_usd_micros bigint NOT NULL CHECK (reserved_spend_usd_micros >= 0),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (workspace_id, utc_month)
);

CREATE TABLE app.property_predator_email_pilot_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  provider_connection_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  message_delivery_id uuid NOT NULL,
  correlation_id uuid NOT NULL,
  idempotency_key_sha256 bytea NOT NULL CHECK (octet_length(idempotency_key_sha256) = 32),
  request_sha256 bytea NOT NULL CHECK (octet_length(request_sha256) = 32),
  run_id uuid NOT NULL,
  utc_month date NOT NULL CHECK (utc_month = date_trunc('month', utc_month)::date),
  stage text NOT NULL CHECK (stage = 'internal-seed'),
  recipient_scope text NOT NULL CHECK (recipient_scope = 'owned-internal-seeds-only'),
  message_version_id uuid NOT NULL,
  approval_request_id uuid NOT NULL,
  approval_decision_id uuid NOT NULL,
  approved_content_sha256 bytea NOT NULL CHECK (octet_length(approved_content_sha256) = 32),
  control_event_id uuid NOT NULL,
  recipient_evidence jsonb NOT NULL CHECK (
    jsonb_typeof(recipient_evidence) = 'array'
    AND jsonb_array_length(recipient_evidence) BETWEEN 1 AND 10
  ),
  requested_messages integer NOT NULL CHECK (requested_messages BETWEEN 1 AND 10),
  estimated_spend_usd_micros bigint NOT NULL CHECK (estimated_spend_usd_micros > 0),
  runtime_provider_effects_enabled boolean NOT NULL,
  runtime_email_delivery_enabled boolean NOT NULL,
  runtime_emergency_paused boolean NOT NULL,
  state text NOT NULL CHECK (state IN (
    'calling', 'cancelled', 'accepted', 'pending', 'succeeded', 'failed',
    'needs_attention'
  )),
  cancellation_reason text CHECK (
    cancellation_reason IS NULL OR (
      cancellation_reason = lower(btrim(cancellation_reason))
      AND cancellation_reason ~ '^[a-z][a-z0-9_.:-]{0,99}$'
    )
  ),
  provider_external_id text CHECK (
    provider_external_id IS NULL OR (
      provider_external_id = btrim(provider_external_id)
      AND length(provider_external_id) BETWEEN 1 AND 500
    )
  ),
  provider_occurred_at timestamptz,
  provider_retryable boolean,
  provider_error_code text CHECK (
    provider_error_code IS NULL OR (
      provider_error_code = lower(btrim(provider_error_code))
      AND provider_error_code ~ '^[a-z][a-z0-9_.:-]{0,99}$'
    )
  ),
  provider_summary text CHECK (
    provider_summary IS NULL OR (
      provider_summary = btrim(provider_summary)
      AND length(provider_summary) BETWEEN 1 AND 500
    )
  ),
  authorized_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  settled_at timestamptz,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, idempotency_key_sha256),
  UNIQUE (workspace_id, operation_id),
  UNIQUE (workspace_id, message_delivery_id),
  FOREIGN KEY (workspace_id, provider_connection_id)
    REFERENCES app.provider_connections (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, operation_id, message_delivery_id)
    REFERENCES app.provider_operations (workspace_id, id, message_delivery_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, message_version_id)
    REFERENCES app.message_versions (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, approval_request_id)
    REFERENCES app.message_approval_requests (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, approval_decision_id)
    REFERENCES app.message_approval_decisions (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, control_event_id)
    REFERENCES app.property_predator_email_pilot_control_events (workspace_id, id)
    ON DELETE RESTRICT,
  CHECK ((state = 'calling') = (settled_at IS NULL)),
  CHECK ((state = 'cancelled') = (cancellation_reason IS NOT NULL)),
  CHECK ((state IN ('calling', 'cancelled')) = (provider_occurred_at IS NULL)),
  CHECK ((provider_occurred_at IS NULL) = (provider_retryable IS NULL)),
  CHECK ((provider_occurred_at IS NULL) = (provider_summary IS NULL)),
  CHECK (state NOT IN ('accepted', 'succeeded') OR provider_external_id IS NOT NULL),
  CHECK (settled_at IS NULL OR settled_at >= authorized_at)
);

CREATE INDEX property_predator_email_pilot_reservations_run_idx
  ON app.property_predator_email_pilot_reservations (workspace_id, run_id, authorized_at);
CREATE INDEX property_predator_email_pilot_reservations_month_idx
  ON app.property_predator_email_pilot_reservations (workspace_id, utc_month, authorized_at);

CREATE FUNCTION app_private.reject_property_predator_email_pilot_event_mutation()
RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog AS $function$
BEGIN
  RAISE EXCEPTION 'Property Predator email pilot evidence is append-only'
    USING ERRCODE = '42501';
END
$function$;
REVOKE ALL ON FUNCTION app_private.reject_property_predator_email_pilot_event_mutation()
  FROM PUBLIC;

CREATE TRIGGER property_predator_email_pilot_controls_append_only
  BEFORE UPDATE OR DELETE ON app.property_predator_email_pilot_control_events
  FOR EACH ROW EXECUTE FUNCTION app_private.reject_property_predator_email_pilot_event_mutation();
CREATE TRIGGER property_predator_email_pilot_seeds_append_only
  BEFORE UPDATE OR DELETE ON app.property_predator_email_pilot_seed_events
  FOR EACH ROW EXECUTE FUNCTION app_private.reject_property_predator_email_pilot_event_mutation();
CREATE TRIGGER property_predator_email_pilot_approved_content_append_only
  BEFORE UPDATE OR DELETE ON app.property_predator_email_pilot_approved_content
  FOR EACH ROW EXECUTE FUNCTION app_private.reject_property_predator_email_pilot_event_mutation();

CREATE FUNCTION app_private.capture_property_predator_email_pilot_approved_content()
RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  approved_subject text;
  approved_body text;
  approved_body_sha256 bytea;
  approved_channel text;
  approved_environment text;
BEGIN
  IF NEW.decision <> 'approved' THEN RETURN NEW; END IF;
  SELECT conversation.subject, version.body_text, version.body_sha256,
         version.channel, version.environment
    INTO approved_subject, approved_body, approved_body_sha256,
         approved_channel, approved_environment
  FROM app.message_versions AS version
  JOIN app.conversations AS conversation
    ON conversation.workspace_id = version.workspace_id
   AND conversation.id = version.conversation_id
  WHERE version.workspace_id = NEW.workspace_id
    AND version.id = NEW.message_version_id
    AND version.body_sha256 = NEW.body_sha256;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Approved content capture lost its exact version'
      USING ERRCODE = '40001';
  END IF;
  IF approved_channel = 'email' AND approved_environment = 'live' THEN
    IF approved_subject IS NULL THEN
      RAISE EXCEPTION 'Live email approval requires an immutable subject'
        USING ERRCODE = '23514';
    END IF;
    INSERT INTO app.property_predator_email_pilot_approved_content (
      workspace_id, message_version_id, approval_request_id,
      approval_decision_id, subject_sha256, body_sha256,
      approved_content_sha256
    ) VALUES (
      NEW.workspace_id, NEW.message_version_id, NEW.approval_request_id,
      NEW.id, public.digest(approved_subject, 'sha256'), approved_body_sha256,
      public.digest(
        pg_catalog.convert_to(
          '{"schemaVersion":1,"subject":' || pg_catalog.to_json(approved_subject)::text
          || ',"text":' || pg_catalog.to_json(approved_body)::text || '}',
          'UTF8'
        ),
        'sha256'
      )
    );
  END IF;
  RETURN NEW;
END
$function$;
REVOKE ALL ON FUNCTION app_private.capture_property_predator_email_pilot_approved_content()
  FROM PUBLIC;

CREATE TRIGGER message_approval_decisions_capture_pilot_content
  AFTER INSERT ON app.message_approval_decisions
  FOR EACH ROW EXECUTE FUNCTION app_private.capture_property_predator_email_pilot_approved_content();

-- 0022 deliberately permitted only non-routable TEST delivery intents. Route
-- that unchanged guard only over TEST rows and add one separate, exact live
-- path callable solely from this migration's security-definer boundary.
CREATE FUNCTION app_private.guard_property_predator_email_live_delivery()
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
  IF current_user <> 'r72_mailgun_worker_definer'
     OR NEW.environment <> 'live'
     OR NEW.conversation_channel <> 'email'
     OR NEW.consent_channel <> 'email'
     OR NOT EXISTS (
       SELECT 1 FROM app.provider_connections AS connection
       WHERE connection.workspace_id = NEW.workspace_id
         AND connection.id = NEW.provider_connection_id
         AND connection.provider_id = 'mailgun_eu'
         AND connection.provider_kind = 'email'
         AND connection.environment = 'live'
         AND connection.status = 'active'
     ) THEN
    RAISE EXCEPTION 'Live delivery is outside the controlled Mailgun pilot'
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
    JOIN app.property_predator_email_pilot_approved_content AS pilot_approval
      ON pilot_approval.workspace_id = decision.workspace_id
     AND pilot_approval.approval_decision_id = decision.id
     AND pilot_approval.message_version_id = decision.message_version_id
     AND pilot_approval.body_sha256 = decision.body_sha256
    JOIN app.provider_operations AS operation
      ON operation.workspace_id = message.workspace_id
     AND operation.id = NEW.provider_operation_id
     AND operation.message_delivery_id = NEW.id
     AND operation.provider_connection_id = NEW.provider_connection_id
     AND operation.environment = 'live'
     AND operation.operation_kind = 'conversation.send'
     AND operation.state = 'queued'
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
REVOKE ALL ON FUNCTION app_private.guard_property_predator_email_live_delivery()
  FROM PUBLIC;

DROP TRIGGER message_deliveries_guard_insert ON app.message_deliveries;
CREATE TRIGGER message_deliveries_test_guard_insert
  BEFORE INSERT ON app.message_deliveries
  FOR EACH ROW WHEN (NEW.environment = 'test')
  EXECUTE FUNCTION app_private.guard_message_delivery_insert();
CREATE TRIGGER message_deliveries_live_pilot_guard_insert
  BEFORE INSERT ON app.message_deliveries
  FOR EACH ROW WHEN (NEW.environment <> 'test')
  EXECUTE FUNCTION app_private.guard_property_predator_email_live_delivery();

CREATE FUNCTION app_private.guard_property_predator_email_pilot_reservation_update()
RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog AS $function$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.provider_connection_id IS DISTINCT FROM OLD.provider_connection_id
     OR NEW.operation_id IS DISTINCT FROM OLD.operation_id
     OR NEW.message_delivery_id IS DISTINCT FROM OLD.message_delivery_id
     OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
     OR NEW.idempotency_key_sha256 IS DISTINCT FROM OLD.idempotency_key_sha256
     OR NEW.request_sha256 IS DISTINCT FROM OLD.request_sha256
     OR NEW.run_id IS DISTINCT FROM OLD.run_id
     OR NEW.utc_month IS DISTINCT FROM OLD.utc_month
     OR NEW.stage IS DISTINCT FROM OLD.stage
     OR NEW.recipient_scope IS DISTINCT FROM OLD.recipient_scope
     OR NEW.message_version_id IS DISTINCT FROM OLD.message_version_id
     OR NEW.approval_request_id IS DISTINCT FROM OLD.approval_request_id
     OR NEW.approval_decision_id IS DISTINCT FROM OLD.approval_decision_id
     OR NEW.approved_content_sha256 IS DISTINCT FROM OLD.approved_content_sha256
     OR NEW.control_event_id IS DISTINCT FROM OLD.control_event_id
     OR NEW.recipient_evidence IS DISTINCT FROM OLD.recipient_evidence
     OR NEW.requested_messages IS DISTINCT FROM OLD.requested_messages
     OR NEW.estimated_spend_usd_micros IS DISTINCT FROM OLD.estimated_spend_usd_micros
     OR NEW.runtime_provider_effects_enabled IS DISTINCT FROM OLD.runtime_provider_effects_enabled
     OR NEW.runtime_email_delivery_enabled IS DISTINCT FROM OLD.runtime_email_delivery_enabled
     OR NEW.runtime_emergency_paused IS DISTINCT FROM OLD.runtime_emergency_paused
     OR NEW.authorized_at IS DISTINCT FROM OLD.authorized_at
     OR OLD.state <> 'calling'
     OR NEW.state = 'calling' THEN
    RAISE EXCEPTION 'Property Predator email pilot reservation evidence is immutable'
      USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END
$function$;
REVOKE ALL ON FUNCTION app_private.guard_property_predator_email_pilot_reservation_update()
  FROM PUBLIC;

CREATE TRIGGER property_predator_email_pilot_reservation_guard
  BEFORE UPDATE ON app.property_predator_email_pilot_reservations
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_property_predator_email_pilot_reservation_update();

ALTER TABLE app.property_predator_email_pilot_control_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.property_predator_email_pilot_control_events FORCE ROW LEVEL SECURITY;
ALTER TABLE app.property_predator_email_pilot_seed_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.property_predator_email_pilot_seed_events FORCE ROW LEVEL SECURITY;
ALTER TABLE app.property_predator_email_pilot_approved_content ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.property_predator_email_pilot_approved_content FORCE ROW LEVEL SECURITY;
ALTER TABLE app.property_predator_email_pilot_run_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.property_predator_email_pilot_run_usage FORCE ROW LEVEL SECURITY;
ALTER TABLE app.property_predator_email_pilot_month_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.property_predator_email_pilot_month_usage FORCE ROW LEVEL SECURITY;
ALTER TABLE app.property_predator_email_pilot_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.property_predator_email_pilot_reservations FORCE ROW LEVEL SECURITY;

CREATE POLICY property_predator_email_pilot_controls_owner_all
  ON app.property_predator_email_pilot_control_events FOR ALL TO r72_owner
  USING (true) WITH CHECK (true);
CREATE POLICY property_predator_email_pilot_seeds_owner_all
  ON app.property_predator_email_pilot_seed_events FOR ALL TO r72_owner
  USING (true) WITH CHECK (true);
CREATE POLICY property_predator_email_pilot_approved_content_owner_all
  ON app.property_predator_email_pilot_approved_content FOR ALL TO r72_owner
  USING (true) WITH CHECK (true);
CREATE POLICY property_predator_email_pilot_run_usage_owner_all
  ON app.property_predator_email_pilot_run_usage FOR ALL TO r72_owner
  USING (true) WITH CHECK (true);
CREATE POLICY property_predator_email_pilot_month_usage_owner_all
  ON app.property_predator_email_pilot_month_usage FOR ALL TO r72_owner
  USING (true) WITH CHECK (true);
CREATE POLICY property_predator_email_pilot_reservations_owner_all
  ON app.property_predator_email_pilot_reservations FOR ALL TO r72_owner
  USING (true) WITH CHECK (true);

CREATE POLICY property_predator_email_pilot_controls_definer_select
  ON app.property_predator_email_pilot_control_events FOR SELECT
  TO r72_mailgun_worker_definer USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
  );
CREATE POLICY property_predator_email_pilot_seeds_definer_select
  ON app.property_predator_email_pilot_seed_events FOR SELECT
  TO r72_mailgun_worker_definer USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
  );
CREATE POLICY property_predator_email_pilot_approved_content_definer_select
  ON app.property_predator_email_pilot_approved_content FOR SELECT
  TO r72_mailgun_worker_definer USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
  );
CREATE POLICY property_predator_email_pilot_run_usage_definer_all
  ON app.property_predator_email_pilot_run_usage FOR ALL
  TO r72_mailgun_worker_definer USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
  ) WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
  );
CREATE POLICY property_predator_email_pilot_month_usage_definer_all
  ON app.property_predator_email_pilot_month_usage FOR ALL
  TO r72_mailgun_worker_definer USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
  ) WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
  );
CREATE POLICY property_predator_email_pilot_reservations_definer_all
  ON app.property_predator_email_pilot_reservations FOR ALL
  TO r72_mailgun_worker_definer USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
  ) WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
  );

CREATE POLICY provider_connections_mailgun_worker_select
  ON app.provider_connections FOR SELECT TO r72_mailgun_worker_definer
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND provider_id = 'mailgun_eu' AND provider_kind = 'email'
    AND environment = 'live'
  );
CREATE POLICY channel_endpoints_mailgun_worker_select
  ON app.channel_endpoints FOR SELECT TO r72_mailgun_worker_definer
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND channel = 'email' AND environment = 'live'
  );
CREATE POLICY inboxes_mailgun_worker_select
  ON app.inboxes FOR SELECT TO r72_mailgun_worker_definer
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND channel = 'email' AND environment = 'live'
  );
CREATE POLICY message_versions_mailgun_worker_select
  ON app.message_versions FOR SELECT TO r72_mailgun_worker_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY messages_mailgun_worker_select
  ON app.messages FOR SELECT TO r72_mailgun_worker_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY conversations_mailgun_worker_select
  ON app.conversations FOR SELECT TO r72_mailgun_worker_definer
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND channel = 'email' AND environment = 'live'
  );
CREATE POLICY message_approval_requests_mailgun_worker_select
  ON app.message_approval_requests FOR SELECT TO r72_mailgun_worker_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY message_approval_decisions_mailgun_worker_select
  ON app.message_approval_decisions FOR SELECT TO r72_mailgun_worker_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY contact_points_mailgun_worker_select
  ON app.contact_points FOR SELECT TO r72_mailgun_worker_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY communication_consent_events_mailgun_worker_select
  ON app.communication_consent_events FOR SELECT TO r72_mailgun_worker_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY communication_suppression_events_mailgun_worker_select
  ON app.communication_suppression_events FOR SELECT TO r72_mailgun_worker_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY provider_operations_mailgun_worker_all
  ON app.provider_operations FOR ALL TO r72_mailgun_worker_definer
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND environment = 'live'
  ) WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND environment = 'live'
  );
CREATE POLICY message_deliveries_mailgun_worker_all
  ON app.message_deliveries FOR ALL TO r72_mailgun_worker_definer
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND environment = 'live' AND conversation_channel = 'email'
  ) WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND environment = 'live' AND conversation_channel = 'email'
  );
CREATE POLICY messages_mailgun_worker_update
  ON app.messages FOR UPDATE TO r72_mailgun_worker_definer
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND environment = 'live' AND channel = 'email'
  ) WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND environment = 'live' AND channel = 'email'
  );

GRANT USAGE ON SCHEMA app, app_private TO r72_mailgun_worker_definer;
GRANT SELECT ON app.provider_connections, app.channel_endpoints, app.inboxes,
  app.conversations, app.message_versions, app.messages,
  app.message_approval_requests, app.message_approval_decisions,
  app.contact_points, app.communication_consent_events,
  app.communication_suppression_events,
  app.property_predator_email_pilot_control_events,
  app.property_predator_email_pilot_seed_events,
  app.property_predator_email_pilot_approved_content
  TO r72_mailgun_worker_definer;
GRANT SELECT, INSERT, UPDATE ON app.provider_operations, app.message_deliveries
  TO r72_mailgun_worker_definer;
GRANT UPDATE ON app.messages TO r72_mailgun_worker_definer;
GRANT SELECT, INSERT, UPDATE ON app.property_predator_email_pilot_run_usage,
  app.property_predator_email_pilot_month_usage,
  app.property_predator_email_pilot_reservations
  TO r72_mailgun_worker_definer;

GRANT USAGE ON SCHEMA app_private TO r72_mailgun_worker_command;
GRANT CREATE ON SCHEMA app_private TO r72_mailgun_worker_definer;
SET LOCAL ROLE r72_mailgun_worker_definer;

CREATE FUNCTION app_private.authorize_property_predator_email_pilot(
  p_workspace_id uuid,
  p_provider_connection_id uuid,
  p_operation_id uuid,
  p_correlation_id uuid,
  p_idempotency_key_sha256 bytea,
  p_request_sha256 bytea,
  p_run_id uuid,
  p_utc_month date,
  p_stage text,
  p_recipient_scope text,
  p_message_version_id uuid,
  p_approval_request_id uuid,
  p_approval_decision_id uuid,
  p_approved_content_sha256 bytea,
  p_recipients jsonb,
  p_requested_messages integer,
  p_estimated_spend_usd_micros bigint,
  p_max_messages_per_run integer,
  p_max_messages_per_month integer,
  p_max_spend_per_run bigint,
  p_max_spend_per_month bigint,
  p_runtime_provider_effects_enabled boolean,
  p_runtime_email_delivery_enabled boolean,
  p_runtime_emergency_paused boolean
) RETURNS TABLE (
  disposition text, reason text, reservation_id uuid,
  request_sha256 bytea, evidence jsonb, provider_result jsonb
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  existing app.property_predator_email_pilot_reservations%ROWTYPE;
  selected_control app.property_predator_email_pilot_control_events%ROWTYPE;
  selected_reservation_id uuid := gen_random_uuid();
  selected_delivery_id uuid := gen_random_uuid();
  selected_conversation_id uuid;
  selected_message_id uuid;
  selected_version_number integer;
  selected_body_sha256 bytea;
  selected_contact_id uuid;
  selected_contact_point_id uuid;
  selected_channel_endpoint_id uuid;
  selected_created_by_user_id uuid;
  selected_purpose text;
  recipients_valid integer := 0;
  selected_recipient_evidence jsonb;
  run_messages integer := 0;
  run_spend bigint := 0;
  month_messages integer := 0;
  month_spend bigint := 0;
  changed_rows integer := 0;
BEGIN
  IF current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'worker'
     OR coalesce(current_setting('app.user_id', true), '') <> ''
     OR coalesce(current_setting('app.request_id', true), '') = '' THEN
    RAISE EXCEPTION 'Mailgun worker context denied' USING ERRCODE = '42501';
  END IF;
  IF octet_length(p_idempotency_key_sha256) <> 32
     OR octet_length(p_request_sha256) <> 32
     OR octet_length(p_approved_content_sha256) <> 32
     OR p_utc_month <> date_trunc('month', p_utc_month)::date
     OR p_utc_month <> date_trunc(
       'month', statement_timestamp() AT TIME ZONE 'UTC'
     )::date
     OR p_stage <> 'internal-seed'
     OR p_recipient_scope <> 'owned-internal-seeds-only'
     OR jsonb_typeof(p_recipients) <> 'array'
     OR p_requested_messages <> jsonb_array_length(p_recipients)
     OR p_requested_messages NOT BETWEEN 1 AND 10
     OR p_estimated_spend_usd_micros <= 0
     OR p_max_messages_per_run NOT BETWEEN p_requested_messages AND 10
     OR p_max_messages_per_month NOT BETWEEN p_max_messages_per_run AND 10000
     OR p_max_spend_per_run < p_estimated_spend_usd_micros
     OR p_max_spend_per_run > 100000000
     OR p_max_spend_per_month < p_max_spend_per_run
     OR p_max_spend_per_month > 100000000 THEN
    RAISE EXCEPTION 'Mailgun pilot authorization input is invalid'
      USING ERRCODE = '22023';
  END IF;
  IF p_requested_messages <> 1 THEN
    RETURN QUERY SELECT 'blocked', 'single_recipient_required', NULL::uuid,
      NULL::bytea, NULL::jsonb, NULL::jsonb;
    RETURN;
  END IF;

  -- One workspace-wide lock makes idempotency and both aggregate caps linear.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_workspace_id::text || ':property-predator-email-pilot', 0)
  );

  SELECT reservation.* INTO existing
  FROM app.property_predator_email_pilot_reservations AS reservation
  WHERE reservation.workspace_id = p_workspace_id
    AND reservation.idempotency_key_sha256 = p_idempotency_key_sha256;
  IF FOUND THEN
    IF existing.request_sha256 IS DISTINCT FROM p_request_sha256 THEN
      RETURN QUERY SELECT 'blocked', 'idempotency_conflict', NULL::uuid,
        existing.request_sha256, NULL::jsonb, NULL::jsonb;
    ELSIF existing.state = 'calling' THEN
      RETURN QUERY SELECT 'blocked', 'ambiguous_outcome', NULL::uuid,
        existing.request_sha256, NULL::jsonb, NULL::jsonb;
    ELSIF existing.state = 'cancelled' THEN
      RETURN QUERY SELECT 'blocked', 'reservation_cancelled', NULL::uuid,
        existing.request_sha256, NULL::jsonb, NULL::jsonb;
    ELSE
      RETURN QUERY SELECT 'replay', NULL::text, existing.id,
        existing.request_sha256, NULL::jsonb,
        jsonb_build_object(
          'status', existing.state,
          'externalId', existing.provider_external_id,
          'occurredAt', to_char(existing.provider_occurred_at AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'retryable', existing.provider_retryable,
          'errorCode', existing.provider_error_code,
          'summary', existing.provider_summary
        );
    END IF;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM app.property_predator_email_pilot_reservations AS reservation
    WHERE reservation.workspace_id = p_workspace_id
      AND reservation.operation_id = p_operation_id
  ) OR EXISTS (
    SELECT 1 FROM app.provider_operations AS operation
    WHERE operation.workspace_id = p_workspace_id
      AND (
        operation.id = p_operation_id
        OR operation.idempotency_key = 'mailgun-pilot:'
          || pg_catalog.encode(p_idempotency_key_sha256, 'hex')
      )
  ) THEN
    RETURN QUERY SELECT 'blocked', 'operation_conflict', NULL::uuid,
      NULL::bytea, NULL::jsonb, NULL::jsonb;
    RETURN;
  END IF;

  IF NOT p_runtime_provider_effects_enabled
     OR NOT p_runtime_email_delivery_enabled
     OR p_runtime_emergency_paused THEN
    RETURN QUERY SELECT 'blocked', 'runtime_effects_disabled', NULL::uuid,
      NULL::bytea, NULL::jsonb, NULL::jsonb;
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app.provider_connections AS connection
    WHERE connection.workspace_id = p_workspace_id
      AND connection.id = p_provider_connection_id
      AND connection.provider_id = 'mailgun_eu'
      AND connection.provider_kind = 'email'
      AND connection.environment = 'live'
      AND connection.status = 'active'
  ) THEN
    RETURN QUERY SELECT 'blocked', 'connection_not_live', NULL::uuid,
      NULL::bytea, NULL::jsonb, NULL::jsonb;
    RETURN;
  END IF;

  SELECT control.* INTO selected_control
  FROM app.property_predator_email_pilot_control_events AS control
  WHERE control.workspace_id = p_workspace_id
    AND control.provider_connection_id = p_provider_connection_id
  ORDER BY control.occurred_at DESC, control.recorded_at DESC, control.id DESC
  LIMIT 1;
  IF NOT FOUND OR NOT selected_control.provider_effects_enabled
     OR NOT selected_control.email_delivery_enabled
     OR selected_control.emergency_paused THEN
    RETURN QUERY SELECT 'blocked', 'database_effects_disabled', NULL::uuid,
      NULL::bytea, NULL::jsonb, NULL::jsonb;
    RETURN;
  END IF;
  IF p_requested_messages > selected_control.max_recipients
     OR p_max_messages_per_run <> selected_control.run_message_cap
     OR p_max_messages_per_month <> selected_control.monthly_message_cap
     OR p_max_spend_per_run <> selected_control.run_spend_cap_usd_micros
     OR p_max_spend_per_month <> selected_control.monthly_spend_cap_usd_micros
     OR p_estimated_spend_usd_micros
       <> p_requested_messages::bigint
         * selected_control.estimated_recipient_cost_usd_micros::bigint THEN
    RETURN QUERY SELECT 'blocked', 'operator_policy_mismatch', NULL::uuid,
      NULL::bytea, NULL::jsonb, NULL::jsonb;
    RETURN;
  END IF;

  SELECT message.conversation_id, message.id, version.version_number,
         version.body_sha256, message.contact_id, message.contact_point_id,
         inbox.channel_endpoint_id, decision.decided_by_user_id
    INTO selected_conversation_id, selected_message_id, selected_version_number,
         selected_body_sha256, selected_contact_id, selected_contact_point_id,
         selected_channel_endpoint_id, selected_created_by_user_id
    FROM app.message_versions AS version
    JOIN app.messages AS message
      ON message.workspace_id = version.workspace_id
     AND message.id = version.message_id
     AND message.current_version_id = version.id
     AND message.current_body_sha256 = version.body_sha256
     AND message.lifecycle = 'approved'
     AND message.direction = 'outbound'
     AND message.contact_id IS NOT NULL
     AND message.contact_point_id IS NOT NULL
    JOIN app.conversations AS conversation
      ON conversation.workspace_id = message.workspace_id
     AND conversation.id = message.conversation_id
     AND conversation.contact_id = message.contact_id
     AND conversation.channel = 'email'
     AND conversation.environment = 'live'
    JOIN app.inboxes AS inbox
      ON inbox.workspace_id = conversation.workspace_id
     AND inbox.id = conversation.inbox_id
     AND inbox.provider_connection_id = p_provider_connection_id
     AND inbox.channel = 'email'
     AND inbox.environment = 'live'
     AND inbox.status = 'active'
    JOIN app.message_approval_requests AS request
      ON request.workspace_id = version.workspace_id
     AND request.id = p_approval_request_id
     AND request.message_id = version.message_id
     AND request.message_version_id = version.id
     AND request.body_sha256 = version.body_sha256
    JOIN app.message_approval_decisions AS decision
      ON decision.workspace_id = version.workspace_id
     AND decision.id = p_approval_decision_id
     AND decision.approval_request_id = request.id
     AND decision.message_version_id = version.id
     AND decision.body_sha256 = version.body_sha256
     AND decision.decision = 'approved'
    JOIN app.property_predator_email_pilot_approved_content AS pilot_approval
      ON pilot_approval.workspace_id = version.workspace_id
     AND pilot_approval.message_version_id = version.id
     AND pilot_approval.approval_request_id = request.id
     AND pilot_approval.approval_decision_id = decision.id
     AND pilot_approval.body_sha256 = version.body_sha256
     AND pilot_approval.subject_sha256 = public.digest(conversation.subject, 'sha256')
    WHERE version.workspace_id = p_workspace_id
      AND version.id = p_message_version_id
      AND version.channel = 'email'
      AND version.environment = 'live'
      AND pilot_approval.approved_content_sha256 = p_approved_content_sha256;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'blocked', 'approval_not_current', NULL::uuid,
      NULL::bytea, NULL::jsonb, NULL::jsonb;
    RETURN;
  END IF;

  SELECT count(*)::integer,
         jsonb_agg(jsonb_build_object(
           'contactPointId', input.contact_point_id,
           'consentEventId', input.consent_event_id,
           'emailSha256', input.email_sha256,
           'consentState', consent.state,
           'suppressed', false,
           'ownedInternalSeed', true
         ) ORDER BY input.contact_point_id)
    INTO recipients_valid, selected_recipient_evidence
  FROM jsonb_to_recordset(p_recipients) AS input(
    contact_point_id uuid, consent_event_id uuid, email_sha256 text
  )
  JOIN app.contact_points AS point
    ON point.workspace_id = p_workspace_id
   AND point.id = input.contact_point_id
   AND point.id = selected_contact_point_id
   AND point.contact_id = selected_contact_id
   AND point.kind = 'email'
   AND point.deleted_at IS NULL
   AND point.is_verified
   AND point.dedupe_state = 'normal'
   AND input.email_sha256 ~ '^[0-9a-f]{64}$'
   AND public.digest(pg_catalog.lower(point.normalized_value), 'sha256')
       = pg_catalog.decode(input.email_sha256, 'hex')
  JOIN app.communication_consent_events AS consent
    ON consent.workspace_id = point.workspace_id
   AND consent.contact_point_id = point.id
   AND consent.contact_id = point.contact_id
   AND consent.id = input.consent_event_id
   AND consent.channel = 'email'
   AND consent.state = 'granted'
   AND consent.endpoint_identity_sha256 = public.digest(
     point.kind || pg_catalog.chr(31) || point.value || pg_catalog.chr(31)
       || point.normalized_value,
     'sha256'
   )
   AND consent.id = (
     SELECT current_consent.id
     FROM app.communication_consent_events AS current_consent
     WHERE current_consent.workspace_id = consent.workspace_id
       AND current_consent.contact_point_id = consent.contact_point_id
       AND current_consent.channel = 'email'
       AND current_consent.purpose = consent.purpose
     ORDER BY current_consent.occurred_at DESC,
       current_consent.recorded_at DESC, current_consent.id DESC
     LIMIT 1
   )
  JOIN app.property_predator_email_pilot_seed_events AS seed
    ON seed.workspace_id = point.workspace_id
   AND seed.email_sha256 = pg_catalog.decode(input.email_sha256, 'hex')
   AND seed.state = 'owned'
   AND seed.id = (
     SELECT current_seed.id
     FROM app.property_predator_email_pilot_seed_events AS current_seed
     WHERE current_seed.workspace_id = seed.workspace_id
       AND current_seed.email_sha256 = seed.email_sha256
     ORDER BY current_seed.occurred_at DESC,
       current_seed.recorded_at DESC, current_seed.id DESC
     LIMIT 1
   )
  WHERE NOT EXISTS (
    SELECT 1
    FROM app.communication_suppression_events AS suppression
    WHERE suppression.workspace_id = point.workspace_id
      AND suppression.contact_point_id = point.id
      AND suppression.channel = 'email'
      AND (suppression.purpose IS NULL OR suppression.purpose = consent.purpose)
      AND suppression.state = 'suppressed'
      AND suppression.id = (
        SELECT current_suppression.id
        FROM app.communication_suppression_events AS current_suppression
        WHERE current_suppression.workspace_id = suppression.workspace_id
          AND current_suppression.contact_point_id = suppression.contact_point_id
          AND current_suppression.channel = suppression.channel
          AND current_suppression.purpose IS NOT DISTINCT FROM suppression.purpose
        ORDER BY current_suppression.occurred_at DESC,
          current_suppression.recorded_at DESC, current_suppression.id DESC
        LIMIT 1
      )
  );
  IF recipients_valid <> p_requested_messages
     OR (SELECT count(DISTINCT recipient.contact_point_id)
         FROM jsonb_to_recordset(p_recipients) AS recipient(
           contact_point_id uuid, consent_event_id uuid, email_sha256 text
         )) <> p_requested_messages
     OR (SELECT count(DISTINCT recipient.email_sha256)
         FROM jsonb_to_recordset(p_recipients) AS recipient(
           contact_point_id uuid, consent_event_id uuid, email_sha256 text
         )) <> p_requested_messages THEN
    RETURN QUERY SELECT 'blocked', 'recipient_evidence_not_current', NULL::uuid,
      NULL::bytea, NULL::jsonb, NULL::jsonb;
    RETURN;
  END IF;
  SELECT consent.purpose INTO selected_purpose
  FROM app.communication_consent_events AS consent
  WHERE consent.workspace_id = p_workspace_id
    AND consent.id = (p_recipients -> 0 ->> 'consent_event_id')::uuid
    AND consent.contact_point_id = selected_contact_point_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'blocked', 'recipient_evidence_not_current', NULL::uuid,
      NULL::bytea, NULL::jsonb, NULL::jsonb;
    RETURN;
  END IF;

  SELECT usage.reserved_messages, usage.reserved_spend_usd_micros
    INTO run_messages, run_spend
  FROM app.property_predator_email_pilot_run_usage AS usage
  WHERE usage.workspace_id = p_workspace_id AND usage.run_id = p_run_id;
  IF NOT FOUND THEN run_messages := 0; run_spend := 0; END IF;
  SELECT usage.reserved_messages, usage.reserved_spend_usd_micros
    INTO month_messages, month_spend
  FROM app.property_predator_email_pilot_month_usage AS usage
  WHERE usage.workspace_id = p_workspace_id AND usage.utc_month = p_utc_month;
  IF NOT FOUND THEN month_messages := 0; month_spend := 0; END IF;

  run_messages := run_messages + p_requested_messages;
  run_spend := run_spend + p_estimated_spend_usd_micros;
  month_messages := month_messages + p_requested_messages;
  month_spend := month_spend + p_estimated_spend_usd_micros;
  IF run_messages > selected_control.run_message_cap THEN
    RETURN QUERY SELECT 'blocked', 'run_message_cap', NULL::uuid,
      NULL::bytea, NULL::jsonb, NULL::jsonb; RETURN;
  ELSIF run_spend > selected_control.run_spend_cap_usd_micros THEN
    RETURN QUERY SELECT 'blocked', 'run_spend_cap', NULL::uuid,
      NULL::bytea, NULL::jsonb, NULL::jsonb; RETURN;
  ELSIF month_messages > selected_control.monthly_message_cap THEN
    RETURN QUERY SELECT 'blocked', 'month_message_cap', NULL::uuid,
      NULL::bytea, NULL::jsonb, NULL::jsonb; RETURN;
  ELSIF month_spend > selected_control.monthly_spend_cap_usd_micros THEN
    RETURN QUERY SELECT 'blocked', 'month_spend_cap', NULL::uuid,
      NULL::bytea, NULL::jsonb, NULL::jsonb; RETURN;
  END IF;

  -- Create one and only one canonical live delivery before crossing the
  -- provider boundary. The deferred cyclic key binds operation and delivery;
  -- the live trigger independently re-checks approval, consent and endpoint.
  INSERT INTO app.provider_operations (
    id, workspace_id, provider_connection_id, message_delivery_id,
    operation_kind, environment, state, idempotency_key, correlation_id,
    attempt_count, max_attempts, created_by_actor_kind
  ) VALUES (
    p_operation_id, p_workspace_id, p_provider_connection_id,
    selected_delivery_id, 'conversation.send', 'live', 'queued',
    'mailgun-pilot:' || pg_catalog.encode(p_idempotency_key_sha256, 'hex'),
    p_correlation_id, 0, 1, 'worker'
  );
  INSERT INTO app.message_deliveries (
    id, workspace_id, conversation_id, message_id, message_version_id,
    version_number, body_sha256, approval_request_id, approval_decision_id,
    provider_operation_id, provider_connection_id, channel_endpoint_id,
    contact_id, contact_point_id, conversation_channel, consent_channel,
    purpose, consent_event_id, endpoint_identity_sha256, environment,
    status, idempotency_key, created_by_user_id
  ) VALUES (
    selected_delivery_id, p_workspace_id, selected_conversation_id,
    selected_message_id, p_message_version_id, selected_version_number,
    selected_body_sha256, p_approval_request_id, p_approval_decision_id,
    p_operation_id, p_provider_connection_id, selected_channel_endpoint_id,
    selected_contact_id, selected_contact_point_id, 'email', 'email',
    selected_purpose, (p_recipients -> 0 ->> 'consent_event_id')::uuid,
    pg_catalog.decode((p_recipients -> 0 ->> 'email_sha256'), 'hex'),
    'live', 'queued',
    'mailgun-pilot:' || pg_catalog.encode(p_idempotency_key_sha256, 'hex'),
    selected_created_by_user_id
  );
  UPDATE app.messages AS message
  SET lifecycle = 'committed', row_version = message.row_version + 1
  WHERE message.workspace_id = p_workspace_id AND message.id = selected_message_id;
  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  IF changed_rows <> 1 THEN
    RAISE EXCEPTION 'Approved message changed before pilot commit' USING ERRCODE = '40001';
  END IF;
  UPDATE app.provider_operations AS operation
  SET state = 'calling', attempt_count = 1,
      lease_token_hash = p_request_sha256, lease_version = 1,
      lease_expires_at = statement_timestamp() + interval '5 minutes',
      row_version = operation.row_version + 1,
      updated_at = statement_timestamp()
  WHERE operation.workspace_id = p_workspace_id AND operation.id = p_operation_id;
  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  IF changed_rows <> 1 THEN
    RAISE EXCEPTION 'Pilot operation was not fenced before call' USING ERRCODE = '40001';
  END IF;
  UPDATE app.message_deliveries AS delivery
  SET status = 'sending', updated_at = statement_timestamp()
  WHERE delivery.workspace_id = p_workspace_id AND delivery.id = selected_delivery_id;
  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  IF changed_rows <> 1 THEN
    RAISE EXCEPTION 'Pilot delivery was not fenced before call' USING ERRCODE = '40001';
  END IF;

  INSERT INTO app.property_predator_email_pilot_reservations (
    id, workspace_id, provider_connection_id, operation_id,
    message_delivery_id, correlation_id,
    idempotency_key_sha256, request_sha256, run_id, utc_month, stage,
    recipient_scope, message_version_id, approval_request_id,
    approval_decision_id, approved_content_sha256, control_event_id,
    recipient_evidence, requested_messages, estimated_spend_usd_micros,
    runtime_provider_effects_enabled, runtime_email_delivery_enabled,
    runtime_emergency_paused, state
  ) VALUES (
    selected_reservation_id, p_workspace_id, p_provider_connection_id,
    p_operation_id, selected_delivery_id, p_correlation_id, p_idempotency_key_sha256,
    p_request_sha256, p_run_id, p_utc_month, p_stage, p_recipient_scope,
    p_message_version_id, p_approval_request_id, p_approval_decision_id,
    p_approved_content_sha256, selected_control.id,
    selected_recipient_evidence, p_requested_messages,
    p_estimated_spend_usd_micros, p_runtime_provider_effects_enabled,
    p_runtime_email_delivery_enabled, p_runtime_emergency_paused, 'calling'
  );
  INSERT INTO app.property_predator_email_pilot_run_usage (
    workspace_id, run_id, reserved_messages, reserved_spend_usd_micros
  ) VALUES (p_workspace_id, p_run_id, run_messages, run_spend)
  ON CONFLICT (workspace_id, run_id) DO UPDATE SET
    reserved_messages = EXCLUDED.reserved_messages,
    reserved_spend_usd_micros = EXCLUDED.reserved_spend_usd_micros,
    updated_at = statement_timestamp();
  INSERT INTO app.property_predator_email_pilot_month_usage (
    workspace_id, utc_month, reserved_messages, reserved_spend_usd_micros
  ) VALUES (p_workspace_id, p_utc_month, month_messages, month_spend)
  ON CONFLICT (workspace_id, utc_month) DO UPDATE SET
    reserved_messages = EXCLUDED.reserved_messages,
    reserved_spend_usd_micros = EXCLUDED.reserved_spend_usd_micros,
    updated_at = statement_timestamp();

  RETURN QUERY SELECT 'authorized', NULL::text, selected_reservation_id,
    p_request_sha256,
    jsonb_build_object(
      'workspaceId', p_workspace_id,
      'providerConnectionId', p_provider_connection_id,
      'stage', p_stage,
      'recipientScope', p_recipient_scope,
      'providerEffectsEnabled', true,
      'emailDeliveryEnabled', true,
      'emergencyPaused', false,
      'approval', jsonb_build_object(
        'messageVersionId', p_message_version_id,
        'approvalRequestId', p_approval_request_id,
        'approvalDecisionId', p_approval_decision_id,
        'approvedContentSha256', pg_catalog.encode(p_approved_content_sha256, 'hex'),
        'decision', 'approved', 'immutable', true
      ),
      'recipients', selected_recipient_evidence,
      'usageAfterReservation', jsonb_build_object(
        'runMessages', run_messages, 'runSpendUsdMicros', run_spend,
        'monthMessages', month_messages, 'monthSpendUsdMicros', month_spend,
        'utcMonth', pg_catalog.to_char(p_utc_month, 'YYYY-MM')
      )
    ), NULL::jsonb;
END
$function$;

CREATE FUNCTION app_private.cancel_property_predator_email_pilot_before_call(
  p_workspace_id uuid, p_reservation_id uuid, p_request_sha256 bytea,
  p_reason text
) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  selected app.property_predator_email_pilot_reservations%ROWTYPE;
  changed_rows integer;
BEGIN
  IF current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'worker'
     OR p_reason !~ '^[a-z][a-z0-9_.:-]{0,99}$' THEN
    RAISE EXCEPTION 'Mailgun worker cancellation denied' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_workspace_id::text || ':property-predator-email-pilot', 0)
  );
  SELECT reservation.* INTO selected
  FROM app.property_predator_email_pilot_reservations AS reservation
  WHERE reservation.workspace_id = p_workspace_id
    AND reservation.id = p_reservation_id
    AND reservation.request_sha256 = p_request_sha256;
  IF NOT FOUND THEN RAISE EXCEPTION 'Mailgun reservation lost' USING ERRCODE = '40001'; END IF;
  IF selected.state = 'cancelled' THEN RETURN true; END IF;
  IF selected.state <> 'calling' THEN
    RAISE EXCEPTION 'Mailgun reservation can no longer be cancelled' USING ERRCODE = '40001';
  END IF;
  UPDATE app.property_predator_email_pilot_reservations
  SET state = 'cancelled', cancellation_reason = p_reason,
      settled_at = statement_timestamp()
  WHERE workspace_id = p_workspace_id AND id = p_reservation_id;
  UPDATE app.provider_operations AS operation
  SET state = 'cancelled', lease_token_hash = NULL, lease_expires_at = NULL,
      completed_at = statement_timestamp(), last_error_code = p_reason,
      last_summary = 'Cancelled before the Mailgun provider call',
      row_version = operation.row_version + 1,
      updated_at = statement_timestamp()
  WHERE operation.workspace_id = p_workspace_id
    AND operation.id = selected.operation_id
    AND operation.message_delivery_id = selected.message_delivery_id
    AND operation.state = 'calling';
  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  IF changed_rows <> 1 THEN
    RAISE EXCEPTION 'Mailgun operation cancellation fence was lost' USING ERRCODE = '40001';
  END IF;
  UPDATE app.message_deliveries AS delivery
  SET status = 'cancelled', updated_at = statement_timestamp()
  WHERE delivery.workspace_id = p_workspace_id
    AND delivery.id = selected.message_delivery_id
    AND delivery.provider_operation_id = selected.operation_id
    AND delivery.status = 'sending';
  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  IF changed_rows <> 1 THEN
    RAISE EXCEPTION 'Mailgun delivery cancellation fence was lost' USING ERRCODE = '40001';
  END IF;
  UPDATE app.property_predator_email_pilot_run_usage
  SET reserved_messages = reserved_messages - selected.requested_messages,
      reserved_spend_usd_micros = reserved_spend_usd_micros
        - selected.estimated_spend_usd_micros,
      updated_at = statement_timestamp()
  WHERE workspace_id = p_workspace_id AND run_id = selected.run_id;
  UPDATE app.property_predator_email_pilot_month_usage
  SET reserved_messages = reserved_messages - selected.requested_messages,
      reserved_spend_usd_micros = reserved_spend_usd_micros
        - selected.estimated_spend_usd_micros,
      updated_at = statement_timestamp()
  WHERE workspace_id = p_workspace_id AND utc_month = selected.utc_month;
  RETURN true;
END
$function$;

CREATE FUNCTION app_private.settle_property_predator_email_pilot_call(
  p_workspace_id uuid, p_reservation_id uuid, p_request_sha256 bytea,
  p_status text, p_external_id text, p_occurred_at timestamptz,
  p_retryable boolean, p_error_code text, p_summary text
) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  selected app.property_predator_email_pilot_reservations%ROWTYPE;
  changed_rows integer;
BEGIN
  IF current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'worker'
     OR p_status NOT IN ('accepted', 'pending', 'succeeded', 'failed', 'needs_attention')
     OR p_occurred_at IS NULL OR p_retryable IS NULL
     OR p_summary IS NULL OR p_summary <> btrim(p_summary)
     OR length(p_summary) NOT BETWEEN 1 AND 500
     OR (p_external_id IS NOT NULL AND (
       p_external_id <> btrim(p_external_id) OR length(p_external_id) NOT BETWEEN 1 AND 500
     ))
     OR (p_error_code IS NOT NULL AND p_error_code !~ '^[a-z][a-z0-9_.:-]{0,99}$')
     OR (p_status IN ('accepted', 'succeeded') AND p_external_id IS NULL) THEN
    RAISE EXCEPTION 'Mailgun settlement input denied' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_workspace_id::text || ':property-predator-email-pilot', 0)
  );
  SELECT reservation.* INTO selected
  FROM app.property_predator_email_pilot_reservations AS reservation
  WHERE reservation.workspace_id = p_workspace_id
    AND reservation.id = p_reservation_id
    AND reservation.request_sha256 = p_request_sha256;
  IF NOT FOUND THEN RAISE EXCEPTION 'Mailgun reservation lost' USING ERRCODE = '40001'; END IF;
  IF selected.state <> 'calling' THEN
    IF selected.state = p_status
       AND selected.provider_external_id IS NOT DISTINCT FROM p_external_id
       AND selected.provider_occurred_at IS NOT DISTINCT FROM p_occurred_at
       AND selected.provider_retryable IS NOT DISTINCT FROM p_retryable
       AND selected.provider_error_code IS NOT DISTINCT FROM p_error_code
       AND selected.provider_summary IS NOT DISTINCT FROM p_summary THEN
      RETURN true;
    END IF;
    RAISE EXCEPTION 'Mailgun reservation settlement conflict' USING ERRCODE = '40001';
  END IF;
  UPDATE app.property_predator_email_pilot_reservations
  SET state = p_status, provider_external_id = p_external_id,
      provider_occurred_at = p_occurred_at, provider_retryable = p_retryable,
      provider_error_code = p_error_code, provider_summary = p_summary,
      settled_at = statement_timestamp()
  WHERE workspace_id = p_workspace_id AND id = p_reservation_id;
  UPDATE app.provider_operations AS operation
  SET state = CASE p_status
        WHEN 'accepted' THEN 'accepted'
        WHEN 'succeeded' THEN 'succeeded'
        WHEN 'failed' THEN 'failed'
        ELSE 'reconciliation_required'
      END,
      provider_reference = p_external_id,
      lease_token_hash = NULL, lease_expires_at = NULL,
      last_error_code = p_error_code, last_summary = p_summary,
      completed_at = CASE
        WHEN p_status IN ('accepted', 'succeeded', 'failed') THEN p_occurred_at
        ELSE NULL
      END,
      row_version = operation.row_version + 1,
      updated_at = statement_timestamp()
  WHERE operation.workspace_id = p_workspace_id
    AND operation.id = selected.operation_id
    AND operation.message_delivery_id = selected.message_delivery_id
    AND operation.state = 'calling';
  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  IF changed_rows <> 1 THEN
    RAISE EXCEPTION 'Mailgun operation settlement fence was lost' USING ERRCODE = '40001';
  END IF;
  UPDATE app.message_deliveries AS delivery
  SET status = CASE
        WHEN p_status IN ('accepted', 'succeeded') THEN 'accepted'
        WHEN p_status = 'failed' THEN 'failed'
        ELSE 'reconciliation_required'
      END,
      accepted_at = CASE
        WHEN p_status IN ('accepted', 'succeeded') THEN p_occurred_at ELSE NULL
      END,
      failed_at = CASE WHEN p_status = 'failed' THEN p_occurred_at ELSE NULL END,
      updated_at = statement_timestamp()
  WHERE delivery.workspace_id = p_workspace_id
    AND delivery.id = selected.message_delivery_id
    AND delivery.provider_operation_id = selected.operation_id
    AND delivery.status = 'sending';
  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  IF changed_rows <> 1 THEN
    RAISE EXCEPTION 'Mailgun delivery settlement fence was lost' USING ERRCODE = '40001';
  END IF;
  -- Every attempted call remains reserved. In particular needs_attention is an
  -- ambiguous outcome and can never be silently retried or refunded.
  RETURN true;
END
$function$;

CREATE FUNCTION app_private.property_predator_email_pilot_boundary_ready()
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  authorize_oid oid := pg_catalog.to_regprocedure(
    'app_private.authorize_property_predator_email_pilot(uuid,uuid,uuid,uuid,bytea,bytea,uuid,date,text,text,uuid,uuid,uuid,bytea,jsonb,integer,bigint,integer,integer,bigint,bigint,boolean,boolean,boolean)'
  );
  cancel_oid oid := pg_catalog.to_regprocedure(
    'app_private.cancel_property_predator_email_pilot_before_call(uuid,uuid,bytea,text)'
  );
  settle_oid oid := pg_catalog.to_regprocedure(
    'app_private.settle_property_predator_email_pilot_call(uuid,uuid,bytea,text,text,timestamp with time zone,boolean,text,text)'
  );
  ready_oid oid := pg_catalog.to_regprocedure(
    'app_private.property_predator_email_pilot_boundary_ready()'
  );
  ledger_oid oid := pg_catalog.to_regprocedure(
    'app_private.runtime_schema_migrations()'
  );
  installation_oid oid := pg_catalog.to_regprocedure(
    'app_private.runtime_database_installation_id()'
  );
BEGIN
  -- SECURITY DEFINER changes current_user, while session_user remains the
  -- authenticated least-privilege LOGIN verified by the application pool.
  IF session_user <> 'r72_mailgun_worker_command' THEN
    RAISE EXCEPTION 'Mailgun worker readiness denied' USING ERRCODE = '42501';
  END IF;
  RETURN authorize_oid IS NOT NULL AND cancel_oid IS NOT NULL
    AND settle_oid IS NOT NULL AND ready_oid IS NOT NULL AND ledger_oid IS NOT NULL
    AND pg_catalog.to_regclass('app.property_predator_email_pilot_reservations') IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles AS role
      WHERE role.rolname = session_user
        AND role.rolcanlogin AND NOT role.rolinherit AND NOT role.rolsuper
        AND NOT role.rolcreatedb AND NOT role.rolcreaterole
        AND NOT role.rolreplication AND NOT role.rolbypassrls
    )
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_auth_members AS membership
      JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
      WHERE member.rolname = session_user
    )
    AND (
      SELECT count(*) = 4
      FROM pg_catalog.pg_proc AS procedure
      JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = procedure.proowner
      WHERE procedure.oid IN (authorize_oid, cancel_oid, settle_oid, ready_oid)
        AND owner_role.rolname = 'r72_mailgun_worker_definer'
        AND procedure.prosecdef
        AND procedure.proconfig = ARRAY['search_path=pg_catalog']::text[]
    )
    AND pg_catalog.has_schema_privilege(session_user, 'app_private', 'USAGE')
    AND NOT pg_catalog.has_schema_privilege(session_user, 'app_private', 'CREATE')
    AND NOT pg_catalog.has_schema_privilege(session_user, 'app', 'USAGE')
    AND NOT pg_catalog.has_schema_privilege(session_user, 'public', 'CREATE')
    AND pg_catalog.has_function_privilege(session_user, authorize_oid, 'EXECUTE')
    AND pg_catalog.has_function_privilege(session_user, cancel_oid, 'EXECUTE')
    AND pg_catalog.has_function_privilege(session_user, settle_oid, 'EXECUTE')
    AND pg_catalog.has_function_privilege(session_user, ready_oid, 'EXECUTE')
    AND pg_catalog.has_function_privilege(session_user, ledger_oid, 'EXECUTE')
    AND (
      installation_oid IS NULL OR EXISTS (
        SELECT 1
        FROM pg_catalog.pg_proc AS procedure
        JOIN pg_catalog.pg_roles AS owner_role
          ON owner_role.oid = procedure.proowner
        WHERE procedure.oid = installation_oid
          AND owner_role.rolname = 'r72_security_definer'
          AND procedure.prosecdef
          AND procedure.provolatile = 's'
          AND procedure.prorettype = 'uuid'::pg_catalog.regtype
          AND procedure.proconfig = ARRAY['search_path=pg_catalog']::text[]
          AND pg_catalog.has_function_privilege(
            session_user, installation_oid, 'EXECUTE'
          )
      )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname IN ('app', 'app_private')
        AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND (
          pg_catalog.has_table_privilege(session_user, relation.oid, 'SELECT')
          OR pg_catalog.has_table_privilege(session_user, relation.oid, 'INSERT')
          OR pg_catalog.has_table_privilege(session_user, relation.oid, 'UPDATE')
          OR pg_catalog.has_table_privilege(session_user, relation.oid, 'DELETE')
          OR pg_catalog.has_table_privilege(session_user, relation.oid, 'TRUNCATE')
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS procedure
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
      WHERE namespace.nspname = 'app_private'
        AND procedure.oid NOT IN (
          authorize_oid, cancel_oid, settle_oid, ready_oid, ledger_oid
        )
        AND (installation_oid IS NULL OR procedure.oid <> installation_oid)
        AND pg_catalog.has_function_privilege(session_user, procedure.oid, 'EXECUTE')
    );
END
$function$;

REVOKE ALL ON FUNCTION app_private.authorize_property_predator_email_pilot(
  uuid, uuid, uuid, uuid, bytea, bytea, uuid, date, text, text, uuid, uuid,
  uuid, bytea, jsonb, integer, bigint, integer, integer, bigint, bigint,
  boolean, boolean, boolean
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.cancel_property_predator_email_pilot_before_call(
  uuid, uuid, bytea, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.settle_property_predator_email_pilot_call(
  uuid, uuid, bytea, text, text, timestamptz, boolean, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.property_predator_email_pilot_boundary_ready()
  FROM PUBLIC;
REVOKE CREATE ON SCHEMA app_private FROM r72_mailgun_worker_definer;

SET LOCAL ROLE r72_owner;

GRANT EXECUTE ON FUNCTION app_private.authorize_property_predator_email_pilot(
  uuid, uuid, uuid, uuid, bytea, bytea, uuid, date, text, text, uuid, uuid,
  uuid, bytea, jsonb, integer, bigint, integer, integer, bigint, bigint,
  boolean, boolean, boolean
) TO r72_mailgun_worker_command;
GRANT EXECUTE ON FUNCTION app_private.cancel_property_predator_email_pilot_before_call(
  uuid, uuid, bytea, text
) TO r72_mailgun_worker_command;
GRANT EXECUTE ON FUNCTION app_private.settle_property_predator_email_pilot_call(
  uuid, uuid, bytea, text, text, timestamptz, boolean, text, text
) TO r72_mailgun_worker_command;
GRANT EXECUTE ON FUNCTION app_private.property_predator_email_pilot_boundary_ready()
  TO r72_mailgun_worker_command;
GRANT EXECUTE ON FUNCTION app_private.runtime_schema_migrations()
  TO r72_mailgun_worker_command;

INSERT INTO app_private.workspace_table_registry
  (schema_name, table_name, workspace_column)
VALUES
  ('app', 'property_predator_email_pilot_control_events', 'workspace_id'),
  ('app', 'property_predator_email_pilot_seed_events', 'workspace_id'),
  ('app', 'property_predator_email_pilot_approved_content', 'workspace_id'),
  ('app', 'property_predator_email_pilot_run_usage', 'workspace_id'),
  ('app', 'property_predator_email_pilot_month_usage', 'workspace_id'),
  ('app', 'property_predator_email_pilot_reservations', 'workspace_id');

DO $capability_audit$
DECLARE
  authorize_oid oid := pg_catalog.to_regprocedure(
    'app_private.authorize_property_predator_email_pilot(uuid,uuid,uuid,uuid,bytea,bytea,uuid,date,text,text,uuid,uuid,uuid,bytea,jsonb,integer,bigint,integer,integer,bigint,bigint,boolean,boolean,boolean)'
  );
  cancel_oid oid := pg_catalog.to_regprocedure(
    'app_private.cancel_property_predator_email_pilot_before_call(uuid,uuid,bytea,text)'
  );
  settle_oid oid := pg_catalog.to_regprocedure(
    'app_private.settle_property_predator_email_pilot_call(uuid,uuid,bytea,text,text,timestamp with time zone,boolean,text,text)'
  );
  ready_oid oid := pg_catalog.to_regprocedure(
    'app_private.property_predator_email_pilot_boundary_ready()'
  );
  unsafe_object text;
BEGIN
  IF authorize_oid IS NULL OR cancel_oid IS NULL OR settle_oid IS NULL
     OR ready_oid IS NULL
     OR NOT pg_catalog.has_function_privilege(
       'r72_mailgun_worker_command', authorize_oid, 'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'r72_mailgun_worker_command', cancel_oid, 'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'r72_mailgun_worker_command', settle_oid, 'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'r72_mailgun_worker_command', ready_oid, 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'Mailgun worker function capability is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = procedure.proowner
    WHERE procedure.oid IN (authorize_oid, cancel_oid, settle_oid, ready_oid)
      AND owner_role.rolname = 'r72_mailgun_worker_definer'
      AND procedure.prosecdef
      AND procedure.proconfig = ARRAY['search_path=pg_catalog']::text[]
    GROUP BY owner_role.rolname HAVING count(*) = 4
  ) THEN
    RAISE EXCEPTION 'Mailgun worker function ownership is unsafe';
  END IF;
  IF NOT pg_catalog.has_schema_privilege(
       'r72_mailgun_worker_command', 'app_private', 'USAGE'
     ) OR pg_catalog.has_schema_privilege(
       'r72_mailgun_worker_command', 'app_private', 'CREATE'
     ) OR pg_catalog.has_schema_privilege(
       'r72_mailgun_worker_command', 'app', 'USAGE'
     ) THEN
    RAISE EXCEPTION 'Mailgun worker command schema privileges are unsafe';
  END IF;
  SELECT format('%I.%I', namespace.nspname, relation.relname)
    INTO unsafe_object
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname IN ('app', 'app_private')
    AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND (
      pg_catalog.has_table_privilege('r72_mailgun_worker_command', relation.oid, 'SELECT')
      OR pg_catalog.has_table_privilege('r72_mailgun_worker_command', relation.oid, 'INSERT')
      OR pg_catalog.has_table_privilege('r72_mailgun_worker_command', relation.oid, 'UPDATE')
      OR pg_catalog.has_table_privilege('r72_mailgun_worker_command', relation.oid, 'DELETE')
      OR pg_catalog.has_table_privilege('r72_mailgun_worker_command', relation.oid, 'TRUNCATE')
    )
  LIMIT 1;
  IF unsafe_object IS NOT NULL THEN
    RAISE EXCEPTION 'Mailgun worker command unexpectedly has table privilege on %', unsafe_object;
  END IF;
END
$capability_audit$;

RESET ROLE;
