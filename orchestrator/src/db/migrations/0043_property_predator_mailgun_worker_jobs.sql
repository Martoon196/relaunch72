-- Production-capable Property Predator Mailgun worker queue. This migration
-- does not enable delivery: operator controls, runtime switches and the
-- emergency pause remain authoritative. The 0023 TEST queue is untouched.
--
-- The command LOGIN remains table-blind. Jobs contain identifiers and hashes
-- only; raw recipient/body data is released transiently by begin_call after
-- the existing 0025 authorization boundary has atomically rechecked approval,
-- consent, suppression, owned-seed evidence, connection state and all caps.

SET LOCAL ROLE r72_owner;

REVOKE ALL ON ALL TABLES IN SCHEMA app
  FROM r72_mailgun_worker_command;
REVOKE ALL ON ALL TABLES IN SCHEMA app_private
  FROM r72_mailgun_worker_command;

CREATE TABLE app.property_predator_mailgun_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  provider_connection_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  correlation_id uuid NOT NULL,
  idempotency_key_sha256 bytea NOT NULL CHECK (octet_length(idempotency_key_sha256) = 32),
  request_sha256 bytea NOT NULL CHECK (octet_length(request_sha256) = 32),
  run_id uuid NOT NULL,
  utc_month date NOT NULL CHECK (utc_month = date_trunc('month', utc_month)::date),
  message_version_id uuid NOT NULL,
  approval_request_id uuid NOT NULL,
  approval_decision_id uuid NOT NULL,
  approved_content_sha256 bytea NOT NULL CHECK (octet_length(approved_content_sha256) = 32),
  contact_point_id uuid NOT NULL,
  consent_event_id uuid NOT NULL,
  email_sha256 bytea NOT NULL CHECK (octet_length(email_sha256) = 32),
  estimated_spend_usd_micros bigint NOT NULL CHECK (estimated_spend_usd_micros > 0),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN (
    'queued', 'leased', 'calling', 'blocked', 'settled',
    'reconciliation_required', 'cancelled'
  )),
  reservation_id uuid,
  message_delivery_id uuid,
  expected_message_id text CHECK (
    expected_message_id IS NULL OR (
      expected_message_id = btrim(expected_message_id)
      AND expected_message_id ~ '^<pp-[0-9a-f]{64}@mg[.]propertypredator[.]com>$'
    )
  ),
  lease_version bigint NOT NULL DEFAULT 0 CHECK (lease_version >= 0),
  lease_expires_at timestamptz,
  claim_count integer NOT NULL DEFAULT 0 CHECK (claim_count BETWEEN 0 AND 8),
  block_reason text CHECK (
    block_reason IS NULL OR block_reason ~ '^[a-z][a-z0-9_.:-]{0,99}$'
  ),
  provider_status text CHECK (
    provider_status IS NULL OR provider_status IN (
      'accepted', 'pending', 'succeeded', 'failed', 'needs_attention'
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
    provider_error_code IS NULL OR
      provider_error_code ~ '^[a-z][a-z0-9_.:-]{0,99}$'
  ),
  provider_summary text CHECK (
    provider_summary IS NULL OR (
      provider_summary = btrim(provider_summary)
      AND length(provider_summary) BETWEEN 1 AND 500
    )
  ),
  available_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  leased_at timestamptz,
  calling_at timestamptz,
  settled_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, operation_id),
  UNIQUE (workspace_id, idempotency_key_sha256),
  FOREIGN KEY (workspace_id, provider_connection_id)
    REFERENCES app.provider_connections (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, message_version_id)
    REFERENCES app.message_versions (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, approval_request_id)
    REFERENCES app.message_approval_requests (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, approval_decision_id)
    REFERENCES app.message_approval_decisions (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, contact_point_id)
    REFERENCES app.contact_points (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, consent_event_id)
    REFERENCES app.communication_consent_events (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, reservation_id)
    REFERENCES app.property_predator_email_pilot_reservations (workspace_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, message_delivery_id)
    REFERENCES app.message_deliveries (workspace_id, id) ON DELETE RESTRICT,
  CHECK ((state IN ('leased', 'calling')) = (lease_expires_at IS NOT NULL)),
  CHECK ((reservation_id IS NULL) = (message_delivery_id IS NULL)),
  CHECK ((state IN ('calling', 'settled', 'reconciliation_required'))
    = (reservation_id IS NOT NULL)),
  CHECK ((state IN ('calling', 'settled', 'reconciliation_required'))
    = (expected_message_id IS NOT NULL)),
  CHECK ((provider_status IS NULL) = (provider_occurred_at IS NULL)),
  CHECK ((provider_status IS NULL) = (provider_retryable IS NULL)),
  CHECK ((provider_status IS NULL) = (provider_summary IS NULL)),
  CHECK (updated_at >= created_at)
);

-- Only a digest of the random lease capability is durable, and it is kept out
-- of the operational job row. The raw token exists only in worker memory and
-- parameterized function calls.
CREATE TABLE app.property_predator_mailgun_job_lease_hashes (
  workspace_id uuid NOT NULL,
  job_id uuid NOT NULL,
  lease_version bigint NOT NULL CHECK (lease_version > 0),
  lease_token_sha256 bytea NOT NULL CHECK (octet_length(lease_token_sha256) = 32),
  issued_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (workspace_id, job_id),
  FOREIGN KEY (workspace_id, job_id)
    REFERENCES app.property_predator_mailgun_jobs (workspace_id, id)
    ON DELETE RESTRICT
);

CREATE INDEX property_predator_mailgun_jobs_claim_idx
  ON app.property_predator_mailgun_jobs (available_at, created_at, id)
  WHERE state = 'queued';
CREATE INDEX property_predator_mailgun_jobs_recover_idx
  ON app.property_predator_mailgun_jobs (lease_expires_at, created_at, id)
  WHERE state IN ('leased', 'calling', 'reconciliation_required');

CREATE FUNCTION app_private.guard_property_predator_mailgun_job_update()
RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog AS $function$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.provider_connection_id IS DISTINCT FROM OLD.provider_connection_id
     OR NEW.operation_id IS DISTINCT FROM OLD.operation_id
     OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
     OR NEW.idempotency_key_sha256 IS DISTINCT FROM OLD.idempotency_key_sha256
     OR NEW.request_sha256 IS DISTINCT FROM OLD.request_sha256
     OR NEW.run_id IS DISTINCT FROM OLD.run_id
     OR NEW.utc_month IS DISTINCT FROM OLD.utc_month
     OR NEW.message_version_id IS DISTINCT FROM OLD.message_version_id
     OR NEW.approval_request_id IS DISTINCT FROM OLD.approval_request_id
     OR NEW.approval_decision_id IS DISTINCT FROM OLD.approval_decision_id
     OR NEW.approved_content_sha256 IS DISTINCT FROM OLD.approved_content_sha256
     OR NEW.contact_point_id IS DISTINCT FROM OLD.contact_point_id
     OR NEW.consent_event_id IS DISTINCT FROM OLD.consent_event_id
     OR NEW.email_sha256 IS DISTINCT FROM OLD.email_sha256
     OR NEW.estimated_spend_usd_micros IS DISTINCT FROM OLD.estimated_spend_usd_micros
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Mailgun job identity evidence is immutable'
      USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END
$function$;
REVOKE ALL ON FUNCTION app_private.guard_property_predator_mailgun_job_update()
  FROM PUBLIC;
CREATE TRIGGER property_predator_mailgun_job_guard
  BEFORE UPDATE ON app.property_predator_mailgun_jobs
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_property_predator_mailgun_job_update();

ALTER TABLE app.property_predator_mailgun_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.property_predator_mailgun_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE app.property_predator_mailgun_job_lease_hashes ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.property_predator_mailgun_job_lease_hashes FORCE ROW LEVEL SECURITY;

CREATE POLICY property_predator_mailgun_jobs_owner_all
  ON app.property_predator_mailgun_jobs FOR ALL TO r72_owner
  USING (true) WITH CHECK (true);
CREATE POLICY property_predator_mailgun_job_leases_owner_all
  ON app.property_predator_mailgun_job_lease_hashes FOR ALL TO r72_owner
  USING (true) WITH CHECK (true);
CREATE POLICY property_predator_mailgun_jobs_definer_all
  ON app.property_predator_mailgun_jobs FOR ALL TO r72_mailgun_worker_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY property_predator_mailgun_job_leases_definer_all
  ON app.property_predator_mailgun_job_lease_hashes FOR ALL TO r72_mailgun_worker_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY provider_operation_receipts_mailgun_worker_select
  ON app.provider_operation_receipts FOR SELECT TO r72_mailgun_worker_definer
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND source_kind = 'verified_webhook'
  );

GRANT SELECT, INSERT, UPDATE ON app.property_predator_mailgun_jobs
  TO r72_mailgun_worker_definer;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON app.property_predator_mailgun_job_lease_hashes
  TO r72_mailgun_worker_definer;
GRANT SELECT ON app.provider_operation_receipts TO r72_mailgun_worker_definer;

GRANT CREATE ON SCHEMA app_private TO r72_mailgun_worker_definer;
SET LOCAL ROLE r72_mailgun_worker_definer;

-- Operator-only staging. This writes no provider effect and stores no raw
-- mailbox, subject or body. Production UI exposure is intentionally deferred.
CREATE FUNCTION app_private.stage_property_predator_mailgun_job(
  p_workspace_id uuid, p_provider_connection_id uuid,
  p_operation_id uuid, p_correlation_id uuid,
  p_idempotency_key_sha256 bytea, p_request_sha256 bytea,
  p_run_id uuid, p_message_version_id uuid,
  p_approval_request_id uuid, p_approval_decision_id uuid,
  p_approved_content_sha256 bytea, p_contact_point_id uuid,
  p_consent_event_id uuid, p_email_sha256 bytea,
  p_estimated_spend_usd_micros bigint
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  selected_id uuid := gen_random_uuid();
BEGIN
  IF octet_length(p_idempotency_key_sha256) <> 32
     OR octet_length(p_request_sha256) <> 32
     OR octet_length(p_approved_content_sha256) <> 32
     OR octet_length(p_email_sha256) <> 32
     OR p_email_sha256 IS DISTINCT FROM public.digest(
       'office@propertypredator.com', 'sha256'
     )
     OR p_estimated_spend_usd_micros <= 0 THEN
    RAISE EXCEPTION 'Mailgun job staging input is invalid' USING ERRCODE = '22023';
  END IF;
  INSERT INTO app.property_predator_mailgun_jobs (
    id, workspace_id, provider_connection_id, operation_id, correlation_id,
    idempotency_key_sha256, request_sha256, run_id, utc_month,
    message_version_id, approval_request_id, approval_decision_id,
    approved_content_sha256, contact_point_id, consent_event_id,
    email_sha256, estimated_spend_usd_micros
  ) VALUES (
    selected_id, p_workspace_id, p_provider_connection_id,
    p_operation_id, p_correlation_id, p_idempotency_key_sha256,
    p_request_sha256, p_run_id,
    date_trunc('month', statement_timestamp() AT TIME ZONE 'UTC')::date,
    p_message_version_id, p_approval_request_id, p_approval_decision_id,
    p_approved_content_sha256, p_contact_point_id, p_consent_event_id,
    p_email_sha256, p_estimated_spend_usd_micros
  );
  RETURN selected_id;
END
$function$;

CREATE FUNCTION app_private.claim_property_predator_mailgun_job(
  p_workspace_id uuid, p_provider_connection_id uuid,
  p_lease_token bytea, p_lease_seconds integer
) RETURNS TABLE (job_id uuid, lease_version bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  selected app.property_predator_mailgun_jobs%ROWTYPE;
  next_version bigint;
BEGIN
  IF current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'worker'
     OR coalesce(current_setting('app.user_id', true), '') <> ''
     OR coalesce(current_setting('app.request_id', true), '') = ''
     OR octet_length(p_lease_token) <> 32
     OR p_lease_seconds NOT BETWEEN 30 AND 300 THEN
    RAISE EXCEPTION 'Mailgun claim context denied' USING ERRCODE = '42501';
  END IF;
  SELECT job.* INTO selected
  FROM app.property_predator_mailgun_jobs AS job
  WHERE job.workspace_id = p_workspace_id
    AND job.provider_connection_id = p_provider_connection_id
    AND job.state = 'queued'
    AND job.available_at <= statement_timestamp()
    AND job.claim_count < 8
  ORDER BY job.available_at, job.created_at, job.id
  LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN; END IF;

  next_version := selected.lease_version + 1;
  UPDATE app.property_predator_mailgun_jobs
  SET state = 'leased', lease_version = next_version,
      lease_expires_at = statement_timestamp()
        + make_interval(secs => p_lease_seconds),
      claim_count = claim_count + 1, leased_at = statement_timestamp(),
      updated_at = statement_timestamp()
  WHERE workspace_id = p_workspace_id AND id = selected.id;
  INSERT INTO app.property_predator_mailgun_job_lease_hashes (
    workspace_id, job_id, lease_version, lease_token_sha256
  ) VALUES (
    p_workspace_id, selected.id, next_version,
    public.digest(p_lease_token, 'sha256')
  ) ON CONFLICT (workspace_id, job_id) DO UPDATE SET
    lease_version = EXCLUDED.lease_version,
    lease_token_sha256 = EXCLUDED.lease_token_sha256,
    issued_at = statement_timestamp(), updated_at = statement_timestamp();
  RETURN QUERY SELECT selected.id, next_version;
END
$function$;

CREATE FUNCTION app_private.renew_property_predator_mailgun_job(
  p_workspace_id uuid, p_job_id uuid, p_lease_version bigint,
  p_lease_token bytea, p_lease_seconds integer
) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE changed_rows integer;
BEGIN
  IF current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'worker'
     OR coalesce(current_setting('app.user_id', true), '') <> ''
     OR coalesce(current_setting('app.request_id', true), '') = ''
     OR octet_length(p_lease_token) <> 32
     OR p_lease_seconds NOT BETWEEN 30 AND 300 THEN
    RAISE EXCEPTION 'Mailgun renew context denied' USING ERRCODE = '42501';
  END IF;
  UPDATE app.property_predator_mailgun_jobs AS job
  SET lease_expires_at = statement_timestamp()
        + make_interval(secs => p_lease_seconds),
      updated_at = statement_timestamp()
  FROM app.property_predator_mailgun_job_lease_hashes AS lease
  WHERE job.workspace_id = p_workspace_id AND job.id = p_job_id
    AND job.state = 'leased' AND job.lease_version = p_lease_version
    AND job.lease_expires_at > statement_timestamp()
    AND lease.workspace_id = job.workspace_id AND lease.job_id = job.id
    AND lease.lease_version = p_lease_version
    AND lease.lease_token_sha256 = public.digest(p_lease_token, 'sha256');
  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  RETURN changed_rows = 1;
END
$function$;

CREATE FUNCTION app_private.begin_property_predator_mailgun_job_call(
  p_workspace_id uuid, p_provider_connection_id uuid,
  p_job_id uuid, p_lease_version bigint,
  p_lease_token bytea, p_runtime_provider_effects_enabled boolean,
  p_runtime_email_delivery_enabled boolean,
  p_runtime_emergency_paused boolean,
  p_run_spend_cap_usd_micros bigint,
  p_month_spend_cap_usd_micros bigint
) RETURNS TABLE (
  disposition text, reason text, operation_id uuid, correlation_id uuid,
  provider_connection_id uuid, reservation_id uuid, request_sha256 bytea,
  expected_message_id text, recipient text, subject text, body text
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  selected app.property_predator_mailgun_jobs%ROWTYPE;
  auth_result record;
  selected_delivery_id uuid;
  selected_recipient text;
  selected_subject text;
  selected_body text;
  selected_expected_id text;
  selected_control app.property_predator_email_pilot_control_events%ROWTYPE;
BEGIN
  IF current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'worker'
     OR coalesce(current_setting('app.user_id', true), '') <> ''
     OR coalesce(current_setting('app.request_id', true), '') = ''
     OR octet_length(p_lease_token) <> 32
     OR NOT p_runtime_provider_effects_enabled
     OR NOT p_runtime_email_delivery_enabled
     OR p_runtime_emergency_paused
     OR p_run_spend_cap_usd_micros <= 0
     OR p_month_spend_cap_usd_micros < p_run_spend_cap_usd_micros THEN
    RAISE EXCEPTION 'Mailgun begin-call context denied' USING ERRCODE = '42501';
  END IF;
  SELECT job.* INTO selected
  FROM app.property_predator_mailgun_jobs AS job
  JOIN app.property_predator_mailgun_job_lease_hashes AS lease
    ON lease.workspace_id = job.workspace_id AND lease.job_id = job.id
   AND lease.lease_version = job.lease_version
   AND lease.lease_token_sha256 = public.digest(p_lease_token, 'sha256')
  WHERE job.workspace_id = p_workspace_id AND job.id = p_job_id
    AND job.provider_connection_id = p_provider_connection_id
    AND job.state = 'leased' AND job.lease_version = p_lease_version
    AND job.lease_expires_at > statement_timestamp()
  FOR UPDATE OF job;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'blocked', 'lease_lost', NULL::uuid, NULL::uuid,
      NULL::uuid, NULL::uuid, NULL::bytea, NULL::text, NULL::text,
      NULL::text, NULL::text;
    RETURN;
  END IF;

  IF selected.utc_month <> date_trunc(
       'month', statement_timestamp() AT TIME ZONE 'UTC'
     )::date THEN
    UPDATE app.property_predator_mailgun_jobs
    SET state = 'blocked', block_reason = 'stale_utc_month',
        lease_expires_at = NULL, settled_at = statement_timestamp(),
        updated_at = statement_timestamp()
    WHERE workspace_id = p_workspace_id AND id = p_job_id;
    DELETE FROM app.property_predator_mailgun_job_lease_hashes
    WHERE workspace_id = p_workspace_id AND job_id = p_job_id;
    RETURN QUERY SELECT 'blocked', 'stale_utc_month', NULL::uuid, NULL::uuid,
      NULL::uuid, NULL::uuid, selected.request_sha256, NULL::text,
      NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;

  SELECT * INTO auth_result
  FROM app_private.authorize_property_predator_email_pilot(
    selected.workspace_id, selected.provider_connection_id,
    selected.operation_id, selected.correlation_id,
    selected.idempotency_key_sha256, selected.request_sha256,
    selected.run_id, selected.utc_month,
    'internal-seed', 'owned-internal-seeds-only',
    selected.message_version_id, selected.approval_request_id,
    selected.approval_decision_id, selected.approved_content_sha256,
    jsonb_build_array(jsonb_build_object(
      'contact_point_id', selected.contact_point_id,
      'consent_event_id', selected.consent_event_id,
      'email_sha256', encode(selected.email_sha256, 'hex')
    )), 1, selected.estimated_spend_usd_micros,
    1, 3, p_run_spend_cap_usd_micros,
    p_month_spend_cap_usd_micros,
    p_runtime_provider_effects_enabled,
    p_runtime_email_delivery_enabled, p_runtime_emergency_paused
  );

  IF auth_result.disposition = 'blocked' THEN
    UPDATE app.property_predator_mailgun_jobs
    SET state = 'blocked', block_reason = auth_result.reason,
        lease_expires_at = NULL, updated_at = statement_timestamp(),
        settled_at = statement_timestamp()
    WHERE workspace_id = p_workspace_id AND id = p_job_id;
    DELETE FROM app.property_predator_mailgun_job_lease_hashes
    WHERE workspace_id = p_workspace_id AND job_id = p_job_id;
    RETURN QUERY SELECT 'blocked', auth_result.reason, NULL::uuid, NULL::uuid,
      NULL::uuid, NULL::uuid, auth_result.request_sha256, NULL::text,
      NULL::text, NULL::text, NULL::text;
    RETURN;
  ELSIF auth_result.disposition = 'replay' THEN
    UPDATE app.property_predator_mailgun_jobs
    SET state = 'blocked', block_reason = 'already_settled_replay',
        lease_expires_at = NULL,
        provider_status = auth_result.provider_result->>'status',
        provider_external_id = auth_result.provider_result->>'externalId',
        provider_occurred_at = (auth_result.provider_result->>'occurredAt')::timestamptz,
        provider_retryable = (auth_result.provider_result->>'retryable')::boolean,
        provider_error_code = auth_result.provider_result->>'errorCode',
        provider_summary = auth_result.provider_result->>'summary',
        settled_at = statement_timestamp(), updated_at = statement_timestamp()
    WHERE workspace_id = p_workspace_id AND id = p_job_id;
    RETURN QUERY SELECT 'replay', NULL::text, selected.operation_id,
      selected.correlation_id, selected.provider_connection_id,
      auth_result.reservation_id, auth_result.request_sha256,
      NULL::text, NULL::text, NULL::text, NULL::text;
    RETURN;
  ELSIF auth_result.disposition <> 'authorized'
        OR auth_result.request_sha256 IS DISTINCT FROM selected.request_sha256 THEN
    RAISE EXCEPTION 'Mailgun authorization returned invalid evidence'
      USING ERRCODE = '40001';
  END IF;

  -- The generic 0025 boundary already enforces the exact run/month/spend
  -- values supplied above. The live worker narrows the remaining operator
  -- recipient dimension to one as well. The outer SERIALIZABLE transaction
  -- makes a concurrent append-only control change conflict rather than race.
  SELECT control.* INTO selected_control
  FROM app.property_predator_email_pilot_control_events AS control
  WHERE control.workspace_id = p_workspace_id
    AND control.provider_connection_id = selected.provider_connection_id
  ORDER BY control.occurred_at DESC, control.recorded_at DESC, control.id DESC
  LIMIT 1;
  IF NOT FOUND OR selected_control.max_recipients <> 1
     OR selected_control.run_message_cap <> 1
     OR selected_control.monthly_message_cap <> 3
     OR selected_control.run_spend_cap_usd_micros <> p_run_spend_cap_usd_micros
     OR selected_control.monthly_spend_cap_usd_micros
       <> p_month_spend_cap_usd_micros THEN
    PERFORM app_private.cancel_property_predator_email_pilot_before_call(
      p_workspace_id, auth_result.reservation_id,
      selected.request_sha256, 'operator_policy_not_exact'
    );
    UPDATE app.property_predator_mailgun_jobs
    SET state = 'blocked', block_reason = 'operator_policy_not_exact',
        lease_expires_at = NULL, settled_at = statement_timestamp(),
        updated_at = statement_timestamp()
    WHERE workspace_id = p_workspace_id AND id = p_job_id;
    DELETE FROM app.property_predator_mailgun_job_lease_hashes
    WHERE workspace_id = p_workspace_id AND job_id = p_job_id;
    RETURN QUERY SELECT 'blocked', 'operator_policy_not_exact', NULL::uuid,
      NULL::uuid, NULL::uuid, NULL::uuid, selected.request_sha256,
      NULL::text, NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;

  SELECT reservation.message_delivery_id INTO selected_delivery_id
  FROM app.property_predator_email_pilot_reservations AS reservation
  WHERE reservation.workspace_id = p_workspace_id
    AND reservation.id = auth_result.reservation_id
    AND reservation.operation_id = selected.operation_id
    AND reservation.request_sha256 = selected.request_sha256;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Mailgun authorization reservation is unavailable'
      USING ERRCODE = '40001';
  END IF;

  SELECT lower(point.normalized_value), conversation.subject, version.body_text
    INTO selected_recipient, selected_subject, selected_body
  FROM app.message_deliveries AS delivery
  JOIN app.message_versions AS version
    ON version.workspace_id = delivery.workspace_id
   AND version.id = delivery.message_version_id
   AND version.body_sha256 = delivery.body_sha256
  JOIN app.conversations AS conversation
    ON conversation.workspace_id = delivery.workspace_id
   AND conversation.id = delivery.conversation_id
   AND conversation.channel = 'email' AND conversation.environment = 'live'
  JOIN app.contact_points AS point
    ON point.workspace_id = delivery.workspace_id
   AND point.id = delivery.contact_point_id AND point.kind = 'email'
   AND point.is_verified AND point.deleted_at IS NULL
  WHERE delivery.workspace_id = p_workspace_id
    AND delivery.id = selected_delivery_id
    AND lower(point.normalized_value) = 'office@propertypredator.com'
    AND public.digest(lower(point.normalized_value), 'sha256') = selected.email_sha256;
  IF NOT FOUND OR selected_subject IS NULL THEN
    PERFORM app_private.cancel_property_predator_email_pilot_before_call(
      p_workspace_id, auth_result.reservation_id,
      selected.request_sha256, 'payload_not_exact'
    );
    UPDATE app.property_predator_mailgun_jobs
    SET state = 'blocked', block_reason = 'payload_not_exact',
        lease_expires_at = NULL, settled_at = statement_timestamp(),
        updated_at = statement_timestamp()
    WHERE workspace_id = p_workspace_id AND id = p_job_id;
    DELETE FROM app.property_predator_mailgun_job_lease_hashes
    WHERE workspace_id = p_workspace_id AND job_id = p_job_id;
    RETURN QUERY SELECT 'blocked', 'payload_not_exact', NULL::uuid, NULL::uuid,
      NULL::uuid, NULL::uuid, selected.request_sha256, NULL::text,
      NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;

  selected_expected_id := '<pp-' || encode(selected.request_sha256, 'hex')
    || '@mg.propertypredator.com>';
  UPDATE app.provider_operations
  SET provider_reference = selected_expected_id,
      updated_at = statement_timestamp(), row_version = row_version + 1
  WHERE workspace_id = p_workspace_id AND id = selected.operation_id
    AND message_delivery_id = selected_delivery_id AND state = 'calling';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Mailgun expected Message-ID fence was lost'
      USING ERRCODE = '40001';
  END IF;
  UPDATE app.property_predator_mailgun_jobs
  SET state = 'calling', reservation_id = auth_result.reservation_id,
      message_delivery_id = selected_delivery_id,
      expected_message_id = selected_expected_id,
      calling_at = statement_timestamp(), updated_at = statement_timestamp()
  WHERE workspace_id = p_workspace_id AND id = p_job_id
    AND state = 'leased' AND lease_version = p_lease_version;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Mailgun calling fence was lost' USING ERRCODE = '40001';
  END IF;
  RETURN QUERY SELECT 'authorized', NULL::text, selected.operation_id,
    selected.correlation_id, selected.provider_connection_id,
      auth_result.reservation_id, selected.request_sha256,
    selected_expected_id, selected_recipient, selected_subject, selected_body;
END
$function$;

CREATE FUNCTION app_private.settle_property_predator_mailgun_job(
  p_workspace_id uuid, p_job_id uuid, p_lease_version bigint,
  p_lease_token bytea, p_status text, p_external_id text,
  p_occurred_at timestamptz, p_retryable boolean,
  p_error_code text, p_summary text
) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  selected app.property_predator_mailgun_jobs%ROWTYPE;
  normalized_state text;
  changed_rows integer;
BEGIN
  IF current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'worker'
     OR coalesce(current_setting('app.user_id', true), '') <> ''
     OR coalesce(current_setting('app.request_id', true), '') = ''
     OR octet_length(p_lease_token) <> 32
     OR p_status NOT IN ('accepted', 'pending', 'succeeded', 'failed', 'needs_attention')
     OR p_occurred_at IS NULL OR p_retryable IS NULL
     OR p_summary IS NULL OR p_summary <> btrim(p_summary)
     OR length(p_summary) NOT BETWEEN 1 AND 500
     OR (p_external_id IS NOT NULL AND (
       p_external_id <> btrim(p_external_id) OR length(p_external_id) NOT BETWEEN 1 AND 500
     ))
     OR (p_error_code IS NOT NULL AND p_error_code !~ '^[a-z][a-z0-9_.:-]{0,99}$') THEN
    RAISE EXCEPTION 'Mailgun job settlement denied' USING ERRCODE = '22023';
  END IF;
  SELECT job.* INTO selected
  FROM app.property_predator_mailgun_jobs AS job
  JOIN app.property_predator_mailgun_job_lease_hashes AS lease
    ON lease.workspace_id = job.workspace_id AND lease.job_id = job.id
   AND lease.lease_version = p_lease_version
   AND lease.lease_token_sha256 = public.digest(p_lease_token, 'sha256')
  WHERE job.workspace_id = p_workspace_id AND job.id = p_job_id
    AND job.lease_version = p_lease_version
  FOR UPDATE OF job;
  IF NOT FOUND THEN RETURN false; END IF;
  IF selected.state IN ('settled', 'reconciliation_required') THEN
    RETURN selected.provider_status = p_status
      AND selected.provider_external_id IS NOT DISTINCT FROM p_external_id
      AND selected.provider_occurred_at IS NOT DISTINCT FROM p_occurred_at
      AND selected.provider_retryable IS NOT DISTINCT FROM p_retryable
      AND selected.provider_error_code IS NOT DISTINCT FROM p_error_code
      AND selected.provider_summary IS NOT DISTINCT FROM p_summary;
  END IF;
  IF selected.state <> 'calling' THEN RETURN false; END IF;

  PERFORM app_private.settle_property_predator_email_pilot_call(
    p_workspace_id, selected.reservation_id, selected.request_sha256,
    p_status, p_external_id, p_occurred_at, p_retryable,
    p_error_code, p_summary
  );
  -- A returned Mailgun id is authoritative. Fall back to the caller-set id
  -- only when the response was ambiguous and supplied no external id.
  UPDATE app.provider_operations
  SET provider_reference = coalesce(p_external_id, selected.expected_message_id),
      last_error_code = CASE
        WHEN p_status IN ('accepted', 'succeeded') THEN NULL ELSE p_error_code
      END,
      last_summary = CASE
        WHEN p_status IN ('accepted', 'succeeded') THEN NULL ELSE p_summary
      END,
      updated_at = statement_timestamp(), row_version = row_version + 1
  WHERE workspace_id = p_workspace_id AND id = selected.operation_id
    AND message_delivery_id = selected.message_delivery_id;
  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  IF changed_rows <> 1 THEN
    RAISE EXCEPTION 'Mailgun operation reference fence was lost'
      USING ERRCODE = '40001';
  END IF;
  normalized_state := CASE
    WHEN p_status IN ('accepted', 'succeeded', 'failed') THEN 'settled'
    ELSE 'reconciliation_required'
  END;
  UPDATE app.property_predator_mailgun_jobs
  SET state = normalized_state, lease_expires_at = NULL,
      provider_status = p_status, provider_external_id = p_external_id,
      provider_occurred_at = p_occurred_at, provider_retryable = p_retryable,
      provider_error_code = p_error_code, provider_summary = p_summary,
      settled_at = statement_timestamp(), updated_at = statement_timestamp()
  WHERE workspace_id = p_workspace_id AND id = p_job_id
    AND lease_version = p_lease_version AND state = 'calling';
  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  IF changed_rows <> 1 THEN
    RAISE EXCEPTION 'Mailgun job settlement fence was lost'
      USING ERRCODE = '40001';
  END IF;
  RETURN true;
END
$function$;

CREATE FUNCTION app_private.recover_one_property_predator_mailgun_job(
  p_workspace_id uuid, p_provider_connection_id uuid
) RETURNS TABLE (job_id uuid, disposition text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  selected app.property_predator_mailgun_jobs%ROWTYPE;
  delivery_status text;
  receipt_time timestamptz;
  receipt_error_code text;
  receipt_provider_reference text;
  target_reservation_state text;
  target_operation_state text;
  target_provider_status text;
  target_summary text;
  changed_rows integer;
BEGIN
  IF current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'worker'
     OR coalesce(current_setting('app.user_id', true), '') <> ''
     OR coalesce(current_setting('app.request_id', true), '') = '' THEN
    RAISE EXCEPTION 'Mailgun recovery context denied' USING ERRCODE = '42501';
  END IF;
  SELECT job.* INTO selected
  FROM app.property_predator_mailgun_jobs AS job
  WHERE job.workspace_id = p_workspace_id
    AND job.provider_connection_id = p_provider_connection_id
    AND (
      (job.state IN ('leased', 'calling')
        AND job.lease_expires_at <= statement_timestamp())
      OR (job.state = 'reconciliation_required' AND EXISTS (
        SELECT 1
        FROM app.provider_operation_receipts AS receipt
        JOIN app.message_deliveries AS delivery
          ON delivery.workspace_id = receipt.workspace_id
         AND delivery.id = receipt.message_delivery_id
         AND delivery.provider_operation_id = receipt.provider_operation_id
        WHERE receipt.workspace_id = job.workspace_id
          AND receipt.provider_operation_id = job.operation_id
          AND receipt.message_delivery_id = job.message_delivery_id
          AND receipt.source_kind = 'verified_webhook'
          AND delivery.status = receipt.delivery_status
          AND (
            (receipt.delivery_status IN ('accepted', 'delivered', 'read')
              AND receipt.error_code IS NULL)
            OR (receipt.delivery_status = 'failed'
              AND receipt.error_code = 'mailgun.permanent')
          )
      ))
    )
  ORDER BY coalesce(job.lease_expires_at, job.created_at), job.created_at, job.id
  LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN; END IF;

  IF selected.state = 'leased' THEN
    IF selected.claim_count >= 8 THEN
      UPDATE app.property_predator_mailgun_jobs
      SET state = 'blocked', block_reason = 'lease_attempts_exhausted',
          lease_expires_at = NULL, settled_at = statement_timestamp(),
          updated_at = statement_timestamp()
      WHERE workspace_id = p_workspace_id AND id = selected.id;
      DELETE FROM app.property_predator_mailgun_job_lease_hashes
      WHERE workspace_id = p_workspace_id AND job_id = selected.id;
      RETURN QUERY SELECT selected.id, 'claim_attempts_exhausted'; RETURN;
    END IF;
    UPDATE app.property_predator_mailgun_jobs
    SET state = 'queued', lease_expires_at = NULL,
        available_at = statement_timestamp(), updated_at = statement_timestamp()
    WHERE workspace_id = p_workspace_id AND id = selected.id;
    DELETE FROM app.property_predator_mailgun_job_lease_hashes
    WHERE workspace_id = p_workspace_id AND job_id = selected.id;
    RETURN QUERY SELECT selected.id, 'requeued_before_call'; RETURN;
  END IF;

  -- A signed event can beat the worker's HTTP settlement (for example after
  -- Mailgun accepted quickly while the response path was lost). Project that
  -- stronger receipt before attempting the older sending-only settlement.
  SELECT receipt.delivery_status, receipt.occurred_at, receipt.error_code,
         coalesce(operation.provider_reference, selected.expected_message_id)
    INTO delivery_status, receipt_time, receipt_error_code,
         receipt_provider_reference
  FROM app.provider_operation_receipts AS receipt
  JOIN app.provider_operations AS operation
    ON operation.workspace_id = receipt.workspace_id
   AND operation.id = receipt.provider_operation_id
   AND operation.message_delivery_id = receipt.message_delivery_id
  JOIN app.message_deliveries AS delivery
    ON delivery.workspace_id = receipt.workspace_id
   AND delivery.id = receipt.message_delivery_id
   AND delivery.provider_operation_id = receipt.provider_operation_id
  WHERE receipt.workspace_id = p_workspace_id
    AND receipt.provider_operation_id = selected.operation_id
    AND receipt.message_delivery_id = selected.message_delivery_id
    AND receipt.source_kind = 'verified_webhook'
    AND delivery.status = receipt.delivery_status
    AND (
      (receipt.delivery_status IN ('accepted', 'delivered', 'read')
        AND receipt.error_code IS NULL)
      OR (receipt.delivery_status = 'failed'
        AND receipt.error_code = 'mailgun.permanent')
    )
  ORDER BY receipt.occurred_at DESC, receipt.received_at DESC, receipt.id DESC
  LIMIT 1;
  IF FOUND THEN
    target_reservation_state := CASE
      WHEN delivery_status = 'accepted' THEN 'accepted'
      WHEN delivery_status IN ('delivered', 'read') THEN 'succeeded'
      ELSE 'failed'
    END;
    target_operation_state := CASE
      WHEN delivery_status = 'accepted' THEN 'accepted'
      WHEN delivery_status IN ('delivered', 'read') THEN 'succeeded'
      ELSE 'failed'
    END;
    target_provider_status := CASE
      WHEN delivery_status = 'accepted' THEN 'accepted'
      WHEN delivery_status IN ('delivered', 'read') THEN 'succeeded'
      ELSE 'failed'
    END;
    target_summary := CASE
      WHEN delivery_status = 'failed'
        THEN 'Signed Mailgun webhook confirmed a permanent delivery failure'
      ELSE 'Signed Mailgun webhook reconciled the ambiguous call'
    END;

    UPDATE app.property_predator_email_pilot_reservations AS reservation
    SET state = target_reservation_state,
        provider_external_id = receipt_provider_reference,
        provider_occurred_at = receipt_time,
        provider_retryable = false,
        provider_error_code = CASE WHEN delivery_status = 'failed'
          THEN receipt_error_code ELSE NULL END,
        provider_summary = target_summary,
        settled_at = statement_timestamp()
    WHERE reservation.workspace_id = p_workspace_id
      AND reservation.id = selected.reservation_id
      AND reservation.operation_id = selected.operation_id
      AND reservation.message_delivery_id = selected.message_delivery_id
      AND reservation.request_sha256 = selected.request_sha256
      AND reservation.state IN ('calling', 'pending', 'needs_attention');
    GET DIAGNOSTICS changed_rows = ROW_COUNT;
    IF changed_rows <> 1 THEN
      RAISE EXCEPTION 'Mailgun signed receipt reservation fence was lost'
        USING ERRCODE = '40001';
    END IF;

    UPDATE app.provider_operations AS operation
    SET state = target_operation_state,
        provider_reference = receipt_provider_reference,
        lease_token_hash = NULL, lease_expires_at = NULL,
        last_error_code = CASE WHEN delivery_status = 'failed'
          THEN receipt_error_code ELSE NULL END,
        last_summary = CASE WHEN delivery_status = 'failed'
          THEN target_summary ELSE NULL END,
        completed_at = greatest(receipt_time, operation.created_at),
        updated_at = statement_timestamp(), row_version = row_version + 1
    WHERE operation.workspace_id = p_workspace_id
      AND operation.id = selected.operation_id
      AND operation.message_delivery_id = selected.message_delivery_id
      AND operation.state IN ('calling', 'reconciliation_required');
    GET DIAGNOSTICS changed_rows = ROW_COUNT;
    IF changed_rows <> 1 THEN
      RAISE EXCEPTION 'Mailgun signed receipt operation fence was lost'
        USING ERRCODE = '40001';
    END IF;

    -- The verified webhook already projected the delivery. Reassert its exact
    -- state and timestamps so a receipt without its paired projection fails
    -- the whole recovery transaction instead of partially settling ledgers.
    UPDATE app.message_deliveries AS delivery
    SET status = delivery_status,
        accepted_at = CASE
          WHEN delivery_status IN ('accepted', 'delivered', 'read')
            THEN coalesce(delivery.accepted_at,
              greatest(delivery.queued_at, receipt_time))
          ELSE NULL
        END,
        delivered_at = CASE
          WHEN delivery_status IN ('delivered', 'read')
            THEN coalesce(delivery.delivered_at,
              greatest(delivery.queued_at, receipt_time))
          ELSE NULL
        END,
        read_at = CASE
          WHEN delivery_status = 'read'
            THEN coalesce(delivery.read_at,
              greatest(delivery.queued_at, receipt_time))
          ELSE NULL
        END,
        failed_at = CASE
          WHEN delivery_status = 'failed'
            THEN coalesce(delivery.failed_at,
              greatest(delivery.queued_at, receipt_time))
          ELSE NULL
        END,
        updated_at = statement_timestamp()
    WHERE delivery.workspace_id = p_workspace_id
      AND delivery.id = selected.message_delivery_id
      AND delivery.provider_operation_id = selected.operation_id
      AND delivery.status = delivery_status;
    GET DIAGNOSTICS changed_rows = ROW_COUNT;
    IF changed_rows <> 1 THEN
      RAISE EXCEPTION 'Mailgun signed receipt delivery fence was lost'
        USING ERRCODE = '40001';
    END IF;

    UPDATE app.property_predator_mailgun_jobs
    SET state = 'settled', lease_expires_at = NULL,
        provider_status = target_provider_status,
        provider_external_id = receipt_provider_reference,
        provider_occurred_at = receipt_time, provider_retryable = false,
        provider_error_code = CASE WHEN delivery_status = 'failed'
          THEN receipt_error_code
          ELSE NULL END,
        provider_summary = target_summary,
        settled_at = statement_timestamp(), updated_at = statement_timestamp()
    WHERE workspace_id = p_workspace_id AND id = selected.id
      AND operation_id = selected.operation_id
      AND reservation_id = selected.reservation_id
      AND message_delivery_id = selected.message_delivery_id
      AND state IN ('calling', 'reconciliation_required');
    GET DIAGNOSTICS changed_rows = ROW_COUNT;
    IF changed_rows <> 1 THEN
      RAISE EXCEPTION 'Mailgun signed receipt job fence was lost'
        USING ERRCODE = '40001';
    END IF;
    -- Keep the hash-only lease proof after terminal settlement. It permits an
    -- exact retry of settle_property_predator_mailgun_job after a lost database
    -- response; deleting it would turn a successful settlement into a false
    -- negative. The raw capability is never stored and this pilot is capped.
    RETURN QUERY SELECT selected.id, 'signed_webhook_reconciled'; RETURN;
  END IF;

  IF selected.state = 'calling' THEN
    PERFORM app_private.settle_property_predator_email_pilot_call(
      p_workspace_id, selected.reservation_id, selected.request_sha256,
      'needs_attention', NULL, statement_timestamp(), false,
      'mailgun_worker_lease_expired',
      'Mailgun call outcome requires signed-webhook reconciliation'
    );
    UPDATE app.provider_operations
    SET provider_reference = selected.expected_message_id,
        updated_at = statement_timestamp(), row_version = row_version + 1
    WHERE workspace_id = p_workspace_id AND id = selected.operation_id;
    UPDATE app.property_predator_mailgun_jobs
    SET state = 'reconciliation_required', lease_expires_at = NULL,
        provider_status = 'needs_attention', provider_occurred_at = statement_timestamp(),
        provider_retryable = false,
        provider_error_code = 'mailgun_worker_lease_expired',
        provider_summary = 'Mailgun call outcome requires signed-webhook reconciliation',
        settled_at = statement_timestamp(), updated_at = statement_timestamp()
    WHERE workspace_id = p_workspace_id AND id = selected.id;
    RETURN QUERY SELECT selected.id, 'reconciliation_required'; RETURN;
  END IF;
  RETURN;
END
$function$;

CREATE OR REPLACE FUNCTION app_private.property_predator_email_pilot_boundary_ready()
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  required_oid oid;
  required_oids oid[] := ARRAY[
    to_regprocedure('app_private.authorize_property_predator_email_pilot(uuid,uuid,uuid,uuid,bytea,bytea,uuid,date,text,text,uuid,uuid,uuid,bytea,jsonb,integer,bigint,integer,integer,bigint,bigint,boolean,boolean,boolean)'),
    to_regprocedure('app_private.cancel_property_predator_email_pilot_before_call(uuid,uuid,bytea,text)'),
    to_regprocedure('app_private.settle_property_predator_email_pilot_call(uuid,uuid,bytea,text,text,timestamp with time zone,boolean,text,text)'),
    to_regprocedure('app_private.claim_property_predator_mailgun_job(uuid,uuid,bytea,integer)'),
    to_regprocedure('app_private.renew_property_predator_mailgun_job(uuid,uuid,bigint,bytea,integer)'),
    to_regprocedure('app_private.begin_property_predator_mailgun_job_call(uuid,uuid,uuid,bigint,bytea,boolean,boolean,boolean,bigint,bigint)'),
    to_regprocedure('app_private.settle_property_predator_mailgun_job(uuid,uuid,bigint,bytea,text,text,timestamp with time zone,boolean,text,text)'),
    to_regprocedure('app_private.recover_one_property_predator_mailgun_job(uuid,uuid)'),
    to_regprocedure('app_private.property_predator_email_pilot_boundary_ready()')
  ];
  ledger_oid oid := to_regprocedure('app_private.runtime_schema_migrations()');
  installation_oid oid := to_regprocedure(
    'app_private.runtime_database_installation_id()'
  );
BEGIN
  IF session_user <> 'r72_mailgun_worker_command'
     OR array_position(required_oids, NULL::oid) IS NOT NULL
     OR ledger_oid IS NULL OR installation_oid IS NULL
     OR pg_catalog.to_regclass('app.property_predator_mailgun_jobs') IS NULL
     OR pg_catalog.to_regclass('app.property_predator_mailgun_job_lease_hashes') IS NULL THEN
    RETURN false;
  END IF;
  FOREACH required_oid IN ARRAY required_oids LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc AS procedure
      JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = procedure.proowner
      WHERE procedure.oid = required_oid
        AND owner_role.rolname = 'r72_mailgun_worker_definer'
        AND procedure.prosecdef
        AND procedure.proconfig = ARRAY['search_path=pg_catalog']::text[]
        AND pg_catalog.has_function_privilege(session_user, procedure.oid, 'EXECUTE')
    ) THEN RETURN false; END IF;
  END LOOP;
  RETURN EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles AS role
      WHERE role.rolname = session_user
        AND role.rolcanlogin AND NOT role.rolinherit AND NOT role.rolsuper
        AND NOT role.rolcreatedb AND NOT role.rolcreaterole
        AND NOT role.rolreplication AND NOT role.rolbypassrls
    )
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_auth_members AS membership
      JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
      JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
      WHERE member.rolname = session_user OR parent.rolname = session_user
    )
    AND pg_catalog.has_function_privilege(session_user, ledger_oid, 'EXECUTE')
    AND pg_catalog.has_function_privilege(session_user, installation_oid, 'EXECUTE')
    AND pg_catalog.has_schema_privilege(session_user, 'app_private', 'USAGE')
    AND NOT pg_catalog.has_schema_privilege(session_user, 'app_private', 'CREATE')
    AND NOT pg_catalog.has_schema_privilege(session_user, 'app', 'USAGE')
    AND NOT pg_catalog.has_schema_privilege(session_user, 'public', 'CREATE')
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname IN ('app', 'app_private')
        AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND (
          has_table_privilege(session_user, relation.oid, 'SELECT')
          OR has_table_privilege(session_user, relation.oid, 'INSERT')
          OR has_table_privilege(session_user, relation.oid, 'UPDATE')
          OR has_table_privilege(session_user, relation.oid, 'DELETE')
          OR has_table_privilege(session_user, relation.oid, 'TRUNCATE')
        )
    )
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc AS procedure
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = procedure.pronamespace
      WHERE namespace.nspname = 'app_private'
        AND procedure.oid <> ALL(required_oids)
        AND procedure.oid NOT IN (ledger_oid, installation_oid)
        AND pg_catalog.has_function_privilege(
          session_user, procedure.oid, 'EXECUTE'
        )
    );
END
$function$;

SET LOCAL ROLE r72_owner;

REVOKE ALL ON FUNCTION app_private.stage_property_predator_mailgun_job(
  uuid, uuid, uuid, uuid, bytea, bytea, uuid, uuid, uuid, uuid,
  bytea, uuid, uuid, bytea, bigint
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.claim_property_predator_mailgun_job(
  uuid, uuid, bytea, integer
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.renew_property_predator_mailgun_job(
  uuid, uuid, bigint, bytea, integer
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.begin_property_predator_mailgun_job_call(
  uuid, uuid, uuid, bigint, bytea, boolean, boolean, boolean, bigint, bigint
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.settle_property_predator_mailgun_job(
  uuid, uuid, bigint, bytea, text, text, timestamptz, boolean, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.recover_one_property_predator_mailgun_job(uuid, uuid)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.property_predator_email_pilot_boundary_ready()
  FROM PUBLIC;
REVOKE CREATE ON SCHEMA app_private FROM r72_mailgun_worker_definer;

GRANT EXECUTE ON FUNCTION app_private.stage_property_predator_mailgun_job(
  uuid, uuid, uuid, uuid, bytea, bytea, uuid, uuid, uuid, uuid,
  bytea, uuid, uuid, bytea, bigint
) TO r72_owner;
GRANT EXECUTE ON FUNCTION app_private.claim_property_predator_mailgun_job(
  uuid, uuid, bytea, integer
) TO r72_mailgun_worker_command;
GRANT EXECUTE ON FUNCTION app_private.renew_property_predator_mailgun_job(
  uuid, uuid, bigint, bytea, integer
) TO r72_mailgun_worker_command;
GRANT EXECUTE ON FUNCTION app_private.begin_property_predator_mailgun_job_call(
  uuid, uuid, uuid, bigint, bytea, boolean, boolean, boolean, bigint, bigint
) TO r72_mailgun_worker_command;
GRANT EXECUTE ON FUNCTION app_private.settle_property_predator_mailgun_job(
  uuid, uuid, bigint, bytea, text, text, timestamptz, boolean, text, text
) TO r72_mailgun_worker_command;
GRANT EXECUTE ON FUNCTION app_private.recover_one_property_predator_mailgun_job(uuid, uuid)
  TO r72_mailgun_worker_command;
GRANT EXECUTE ON FUNCTION app_private.property_predator_email_pilot_boundary_ready()
  TO r72_mailgun_worker_command;

INSERT INTO app_private.workspace_table_registry
  (schema_name, table_name, workspace_column)
VALUES
  ('app', 'property_predator_mailgun_jobs', 'workspace_id'),
  ('app', 'property_predator_mailgun_job_lease_hashes', 'workspace_id');

DO $capability_audit$
DECLARE unsafe_object text;
BEGIN
  SELECT format('%I.%I', namespace.nspname, relation.relname)
    INTO unsafe_object
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname IN ('app', 'app_private')
    AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND (
      has_table_privilege('r72_mailgun_worker_command', relation.oid, 'SELECT')
      OR has_table_privilege('r72_mailgun_worker_command', relation.oid, 'INSERT')
      OR has_table_privilege('r72_mailgun_worker_command', relation.oid, 'UPDATE')
      OR has_table_privilege('r72_mailgun_worker_command', relation.oid, 'DELETE')
      OR has_table_privilege('r72_mailgun_worker_command', relation.oid, 'TRUNCATE')
    )
  LIMIT 1;
  IF unsafe_object IS NOT NULL
     OR NOT has_function_privilege(
       'r72_mailgun_worker_command',
       'app_private.claim_property_predator_mailgun_job(uuid,uuid,bytea,integer)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'r72_mailgun_worker_command',
       'app_private.stage_property_predator_mailgun_job(uuid,uuid,uuid,uuid,bytea,bytea,uuid,uuid,uuid,uuid,bytea,uuid,uuid,bytea,bigint)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'Mailgun worker job capability is unsafe: %', unsafe_object;
  END IF;
END
$capability_audit$;

RESET ROLE;
