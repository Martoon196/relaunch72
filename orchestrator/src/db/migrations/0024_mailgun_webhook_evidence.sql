-- Durable, replay-safe Mailgun webhook evidence for the controlled email
-- pilot. The ingress LOGIN can execute one SECURITY DEFINER recorder only. It
-- cannot enumerate message bodies, addresses, credentials, or any app table.

DO $roles$
DECLARE
  role_name text;
  expected_login boolean;
  unsafe_membership text;
BEGIN
  FOR role_name, expected_login IN
    SELECT required.role_name, required.expected_login
    FROM (VALUES
      ('r72_mailgun_webhook_definer', false),
      ('r72_mailgun_webhook_command', true)
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
      RAISE EXCEPTION 'Unsafe Mailgun role attributes: %', role_name;
    END IF;
  END LOOP;

  REVOKE r72_owner, r72_security_definer, r72_onboarding_definer,
    r72_setup_delivery_definer, r72_commerce_definer,
    r72_external_event_definer, r72_provider_operation_definer
  FROM r72_mailgun_webhook_definer, r72_mailgun_webhook_command;
  REVOKE r72_mailgun_webhook_definer
  FROM r72_web, r72_public, r72_worker, r72_webhook, r72_readonly,
    r72_crm_command, r72_identity_command, r72_provisioning_command,
    r72_setup_delivery_command, r72_setup_reissue_command,
    r72_external_event_command, r72_mailgun_webhook_command;
  REVOKE r72_mailgun_webhook_command
  FROM r72_web, r72_public, r72_worker, r72_webhook, r72_readonly,
    r72_crm_command, r72_identity_command, r72_provisioning_command,
    r72_setup_delivery_command, r72_setup_reissue_command,
    r72_external_event_command, r72_mailgun_webhook_definer, r72_owner;

  SELECT member.rolname || '->' || parent.rolname INTO unsafe_membership
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
  JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
  WHERE member.rolname IN (
    'r72_mailgun_webhook_definer', 'r72_mailgun_webhook_command'
  )
  LIMIT 1;
  IF unsafe_membership IS NOT NULL THEN
    RAISE EXCEPTION 'Unsafe Mailgun role membership: %', unsafe_membership;
  END IF;

  GRANT r72_mailgun_webhook_definer TO r72_owner;
  EXECUTE format('GRANT r72_mailgun_webhook_command TO %I', current_user);
END
$roles$;

SET LOCAL ROLE r72_owner;

REVOKE ALL ON SCHEMA app, app_private
  FROM r72_mailgun_webhook_definer, r72_mailgun_webhook_command;
REVOKE ALL ON ALL TABLES IN SCHEMA app
  FROM r72_mailgun_webhook_definer, r72_mailgun_webhook_command;
REVOKE ALL ON ALL TABLES IN SCHEMA app_private
  FROM r72_mailgun_webhook_definer, r72_mailgun_webhook_command;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app_private
  FROM r72_mailgun_webhook_definer, r72_mailgun_webhook_command;
REVOKE CREATE ON SCHEMA public
  FROM r72_mailgun_webhook_definer, r72_mailgun_webhook_command;

CREATE TABLE app.mailgun_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  provider_connection_id uuid NOT NULL,
  provider_operation_id uuid NOT NULL,
  message_delivery_id uuid NOT NULL,
  external_event_id text NOT NULL CHECK (
    external_event_id = btrim(external_event_id)
    AND length(external_event_id) BETWEEN 1 AND 255
    AND external_event_id ~ '^[A-Za-z0-9._:+/=-]+$'
  ),
  event_type text NOT NULL CHECK (event_type IN (
    'accepted', 'delivered', 'opened', 'clicked', 'failed',
    'complained', 'unsubscribed'
  )),
  failure_severity text CHECK (
    failure_severity IS NULL OR failure_severity IN ('temporary', 'permanent')
  ),
  occurred_at timestamptz NOT NULL,
  payload_sha256 bytea NOT NULL CHECK (octet_length(payload_sha256) = 32),
  event_identity_sha256 bytea NOT NULL CHECK (
    octet_length(event_identity_sha256) = 32
  ),
  signature_timestamp timestamptz NOT NULL,
  signature_token_sha256 bytea NOT NULL CHECK (
    octet_length(signature_token_sha256) = 32
  ),
  recipient_identity_sha256 bytea NOT NULL CHECK (
    octet_length(recipient_identity_sha256) = 32
  ),
  suppression_recorded boolean NOT NULL,
  opt_out_recorded boolean NOT NULL,
  actor_kind text NOT NULL DEFAULT 'webhook' CHECK (actor_kind = 'webhook'),
  request_id text NOT NULL CHECK (
    length(request_id) BETWEEN 1 AND 128 AND request_id !~ '[^[:graph:]]'
  ),
  received_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, provider_connection_id, external_event_id),
  FOREIGN KEY (workspace_id, provider_connection_id)
    REFERENCES app.provider_connections (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, provider_operation_id, message_delivery_id)
    REFERENCES app.message_deliveries (
      workspace_id, provider_operation_id, id
    ) ON DELETE RESTRICT,
  CHECK ((event_type = 'failed') = (failure_severity IS NOT NULL)),
  CHECK (opt_out_recorded = (event_type = 'unsubscribed')),
  CHECK (suppression_recorded = (
    event_type IN ('complained', 'unsubscribed')
    OR (event_type = 'failed' AND failure_severity = 'permanent')
  ))
);

-- Nonces are retained only as irreversible hashes. Exact provider retries are
-- idempotent; reusing one nonce for different semantic evidence is rejected.
CREATE TABLE app.mailgun_webhook_signature_tokens (
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  provider_connection_id uuid NOT NULL,
  signature_token_sha256 bytea NOT NULL CHECK (
    octet_length(signature_token_sha256) = 32
  ),
  external_event_id text NOT NULL CHECK (
    length(external_event_id) BETWEEN 1 AND 255
    AND external_event_id ~ '^[A-Za-z0-9._:+/=-]+$'
  ),
  event_identity_sha256 bytea NOT NULL CHECK (
    octet_length(event_identity_sha256) = 32
  ),
  signature_timestamp timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (
    workspace_id, provider_connection_id, signature_token_sha256
  ),
  FOREIGN KEY (workspace_id, provider_connection_id)
    REFERENCES app.provider_connections (workspace_id, id) ON DELETE RESTRICT
);

CREATE INDEX mailgun_webhook_events_delivery_time_idx
  ON app.mailgun_webhook_events (
    workspace_id, message_delivery_id, occurred_at, id
  );

CREATE FUNCTION app_private.reject_mailgun_webhook_evidence_mutation()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $function$
BEGIN
  RAISE EXCEPTION 'Mailgun webhook evidence is append-only' USING ERRCODE = '55000';
END
$function$;
REVOKE ALL ON FUNCTION app_private.reject_mailgun_webhook_evidence_mutation()
  FROM PUBLIC;

CREATE TRIGGER mailgun_webhook_events_append_only
  BEFORE UPDATE OR DELETE ON app.mailgun_webhook_events
  FOR EACH ROW EXECUTE FUNCTION app_private.reject_mailgun_webhook_evidence_mutation();
CREATE TRIGGER mailgun_webhook_signature_tokens_append_only
  BEFORE UPDATE OR DELETE ON app.mailgun_webhook_signature_tokens
  FOR EACH ROW EXECUTE FUNCTION app_private.reject_mailgun_webhook_evidence_mutation();

ALTER TABLE app.mailgun_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.mailgun_webhook_events FORCE ROW LEVEL SECURITY;
ALTER TABLE app.mailgun_webhook_signature_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.mailgun_webhook_signature_tokens FORCE ROW LEVEL SECURITY;

CREATE POLICY mailgun_webhook_events_owner_all
  ON app.mailgun_webhook_events FOR ALL TO r72_owner
  USING (true) WITH CHECK (true);
CREATE POLICY mailgun_webhook_signature_tokens_owner_all
  ON app.mailgun_webhook_signature_tokens FOR ALL TO r72_owner
  USING (true) WITH CHECK (true);
CREATE POLICY mailgun_webhook_events_definer_all
  ON app.mailgun_webhook_events FOR ALL TO r72_mailgun_webhook_definer
  USING (
    workspace_id = app_private.current_workspace_id()
    AND app_private.current_actor_kind() = 'webhook'
  ) WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND app_private.current_actor_kind() = 'webhook'
  );
CREATE POLICY mailgun_webhook_signature_tokens_definer_all
  ON app.mailgun_webhook_signature_tokens FOR ALL TO r72_mailgun_webhook_definer
  USING (
    workspace_id = app_private.current_workspace_id()
    AND app_private.current_actor_kind() = 'webhook'
  ) WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND app_private.current_actor_kind() = 'webhook'
  );

-- The definer can see only the rows needed to bind one verified event to one
-- previously-created Mailgun delivery. It cannot read immutable message bodies.
CREATE POLICY provider_connections_mailgun_definer_select
  ON app.provider_connections FOR SELECT TO r72_mailgun_webhook_definer
  USING (
    workspace_id = app_private.current_workspace_id()
    AND app_private.current_actor_kind() = 'webhook'
    AND provider_id = 'mailgun_eu' AND provider_kind = 'email'
    AND environment = 'live' AND status = 'active'
  );
CREATE POLICY provider_operations_mailgun_definer_select
  ON app.provider_operations FOR SELECT TO r72_mailgun_webhook_definer
  USING (
    workspace_id = app_private.current_workspace_id()
    AND app_private.current_actor_kind() = 'webhook'
    AND environment = 'live'
  );
CREATE POLICY message_deliveries_mailgun_definer_select
  ON app.message_deliveries FOR SELECT TO r72_mailgun_webhook_definer
  USING (
    workspace_id = app_private.current_workspace_id()
    AND app_private.current_actor_kind() = 'webhook'
    AND environment = 'live'
  );
CREATE POLICY message_deliveries_mailgun_definer_update
  ON app.message_deliveries FOR UPDATE TO r72_mailgun_webhook_definer
  USING (
    workspace_id = app_private.current_workspace_id()
    AND app_private.current_actor_kind() = 'webhook'
    AND environment = 'live'
  ) WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND app_private.current_actor_kind() = 'webhook'
    AND environment = 'live'
  );
CREATE POLICY contact_points_mailgun_definer_select
  ON app.contact_points FOR SELECT TO r72_mailgun_webhook_definer
  USING (
    workspace_id = app_private.current_workspace_id()
    AND app_private.current_actor_kind() = 'webhook'
    AND kind = 'email'
  );
CREATE POLICY provider_operation_receipts_mailgun_definer_insert
  ON app.provider_operation_receipts FOR INSERT TO r72_mailgun_webhook_definer
  WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND app_private.current_actor_kind() = 'webhook'
    AND source_kind = 'verified_webhook' AND actor_kind = 'webhook'
  );
CREATE POLICY communication_consent_events_mailgun_definer_insert
  ON app.communication_consent_events FOR INSERT TO r72_mailgun_webhook_definer
  WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND app_private.current_actor_kind() = 'webhook'
    AND channel = 'email' AND source = 'mailgun.webhook'
    AND actor_kind = 'webhook' AND actor_user_id IS NULL
  );
CREATE POLICY communication_suppression_events_mailgun_definer_insert
  ON app.communication_suppression_events FOR INSERT TO r72_mailgun_webhook_definer
  WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND app_private.current_actor_kind() = 'webhook'
    AND channel = 'email' AND source = 'mailgun.webhook'
    AND actor_kind = 'webhook' AND actor_user_id IS NULL
  );

GRANT USAGE ON SCHEMA app, app_private TO r72_mailgun_webhook_definer;
GRANT SELECT, INSERT ON app.mailgun_webhook_events,
  app.mailgun_webhook_signature_tokens TO r72_mailgun_webhook_definer;
GRANT SELECT ON app.provider_connections, app.provider_operations,
  app.message_deliveries, app.contact_points TO r72_mailgun_webhook_definer;
GRANT UPDATE (status, accepted_at, delivered_at, read_at, failed_at, updated_at)
  ON app.message_deliveries TO r72_mailgun_webhook_definer;
GRANT INSERT ON app.provider_operation_receipts,
  app.communication_consent_events, app.communication_suppression_events
  TO r72_mailgun_webhook_definer;
GRANT EXECUTE ON FUNCTION app_private.current_workspace_id(),
  app_private.current_actor_kind(), app_private.current_request_id()
  TO r72_mailgun_webhook_definer;

-- The LOGIN can install transaction-local context and call exactly one
-- recorder. It has neither app schema usage nor any direct table privilege.
GRANT USAGE ON SCHEMA app_private TO r72_mailgun_webhook_command;
GRANT EXECUTE ON FUNCTION app_private.current_workspace_id(),
  app_private.current_actor_kind(), app_private.current_request_id()
  TO r72_mailgun_webhook_command;

GRANT CREATE ON SCHEMA app_private TO r72_mailgun_webhook_definer;
SET LOCAL ROLE r72_mailgun_webhook_definer;

CREATE FUNCTION app_private.record_mailgun_webhook_event(
  p_workspace_id uuid,
  p_provider_connection_id uuid,
  p_external_event_id text,
  p_event_type text,
  p_occurred_at timestamptz,
  p_provider_message_id text,
  p_payload_sha256 bytea,
  p_event_identity_sha256 bytea,
  p_signature_token_sha256 bytea,
  p_signature_timestamp timestamptz,
  p_recipient_identity_sha256 bytea,
  p_failure_severity text
)
RETURNS TABLE (
  replayed boolean,
  delivery_status text,
  suppression_recorded boolean,
  opt_out_recorded boolean
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  trusted_workspace_id uuid := app_private.current_workspace_id();
  trusted_actor_kind text := app_private.current_actor_kind();
  trusted_request_id text := app_private.current_request_id();
  token_inserted integer;
  event_inserted integer;
  existing_token_event_id text;
  existing_token_identity bytea;
  existing_event app.mailgun_webhook_events%ROWTYPE;
  selected_operation_id uuid;
  selected_delivery_id uuid;
  selected_contact_id uuid;
  selected_contact_point_id uuid;
  selected_purpose text;
  selected_delivery_status text;
  selected_queued_at timestamptz;
  selected_event_id uuid := gen_random_uuid();
  should_suppress boolean := (
    p_event_type IN ('complained', 'unsubscribed')
    OR (p_event_type = 'failed' AND p_failure_severity = 'permanent')
  );
  should_opt_out boolean := p_event_type = 'unsubscribed';
  normalized_failure_code text;
  projected_status text;
BEGIN
  IF trusted_actor_kind IS DISTINCT FROM 'webhook'
     OR trusted_workspace_id IS NULL
     OR p_workspace_id IS DISTINCT FROM trusted_workspace_id THEN
    RAISE EXCEPTION 'mailgun webhook context denied' USING ERRCODE = '42501';
  END IF;
  IF trusted_request_id IS NULL
     OR length(trusted_request_id) NOT BETWEEN 1 AND 128
     OR trusted_request_id ~ '[^[:graph:]]'
     OR p_provider_connection_id IS NULL
     OR p_external_event_id IS NULL
     OR p_external_event_id <> btrim(p_external_event_id)
     OR length(p_external_event_id) NOT BETWEEN 1 AND 255
     OR p_external_event_id !~ '^[A-Za-z0-9._:+/=-]+$'
     OR p_event_type NOT IN (
       'accepted', 'delivered', 'opened', 'clicked', 'failed',
       'complained', 'unsubscribed'
     )
     OR p_occurred_at IS NULL
     OR p_provider_message_id IS NULL
     OR p_provider_message_id <> btrim(p_provider_message_id)
     OR length(p_provider_message_id) NOT BETWEEN 1 AND 500
     OR p_provider_message_id ~ '[[:cntrl:]]'
     OR octet_length(p_payload_sha256) IS DISTINCT FROM 32
     OR octet_length(p_event_identity_sha256) IS DISTINCT FROM 32
     OR octet_length(p_signature_token_sha256) IS DISTINCT FROM 32
     OR p_signature_timestamp IS NULL
     OR octet_length(p_recipient_identity_sha256) IS DISTINCT FROM 32
     OR ((p_event_type = 'failed') IS DISTINCT FROM (p_failure_severity IS NOT NULL))
     OR (p_failure_severity IS NOT NULL
       AND p_failure_severity NOT IN ('temporary', 'permanent')) THEN
    RAISE EXCEPTION 'mailgun webhook evidence is invalid' USING ERRCODE = '22023';
  END IF;

  PERFORM 1 FROM app.provider_connections AS connection
  WHERE connection.workspace_id = trusted_workspace_id
    AND connection.id = p_provider_connection_id
    AND connection.provider_id = 'mailgun_eu'
    AND connection.provider_kind = 'email'
    AND connection.environment = 'live'
    AND connection.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mailgun event does not match an outbound delivery'
      USING ERRCODE = '23503';
  END IF;

  INSERT INTO app.mailgun_webhook_signature_tokens (
    workspace_id, provider_connection_id, signature_token_sha256,
    external_event_id, event_identity_sha256, signature_timestamp
  ) VALUES (
    trusted_workspace_id, p_provider_connection_id, p_signature_token_sha256,
    p_external_event_id, p_event_identity_sha256, p_signature_timestamp
  ) ON CONFLICT (
    workspace_id, provider_connection_id, signature_token_sha256
  ) DO NOTHING;
  GET DIAGNOSTICS token_inserted = ROW_COUNT;
  IF token_inserted = 0 THEN
    SELECT token.external_event_id, token.event_identity_sha256
      INTO existing_token_event_id, existing_token_identity
    FROM app.mailgun_webhook_signature_tokens AS token
    WHERE token.workspace_id = trusted_workspace_id
      AND token.provider_connection_id = p_provider_connection_id
      AND token.signature_token_sha256 = p_signature_token_sha256;
    IF existing_token_event_id IS DISTINCT FROM p_external_event_id
       OR existing_token_identity IS DISTINCT FROM p_event_identity_sha256 THEN
      RAISE EXCEPTION 'mailgun signature token replay conflict'
        USING ERRCODE = '22000';
    END IF;
  END IF;

  SELECT operation.id, delivery.id, delivery.contact_id,
         delivery.contact_point_id, delivery.purpose, delivery.status,
         delivery.queued_at
    INTO selected_operation_id, selected_delivery_id, selected_contact_id,
         selected_contact_point_id, selected_purpose,
         selected_delivery_status, selected_queued_at
  FROM app.provider_operations AS operation
  JOIN app.message_deliveries AS delivery
    ON delivery.workspace_id = operation.workspace_id
   AND delivery.provider_operation_id = operation.id
  JOIN app.contact_points AS point
    ON point.workspace_id = delivery.workspace_id
   AND point.id = delivery.contact_point_id
   AND point.contact_id = delivery.contact_id
  WHERE operation.workspace_id = trusted_workspace_id
    AND operation.provider_connection_id = p_provider_connection_id
    AND operation.environment = 'live'
    -- Mailgun's API response commonly wraps the Message-Id in angle brackets,
    -- while event payloads commonly expose the same header without them.
    -- Accept exactly those two representations; never use a fuzzy match.
    AND operation.provider_reference IN (
      p_provider_message_id, '<' || p_provider_message_id || '>'
    )
    AND delivery.provider_connection_id = p_provider_connection_id
    AND delivery.environment = operation.environment
    AND point.kind = 'email'
    AND public.digest(lower(point.normalized_value), 'sha256')
      = p_recipient_identity_sha256
  ORDER BY operation.created_at DESC, operation.id DESC
  LIMIT 1
  FOR UPDATE OF delivery;
  IF selected_delivery_id IS NULL THEN
    RAISE EXCEPTION 'mailgun event does not match an outbound delivery'
      USING ERRCODE = '23503';
  END IF;

  INSERT INTO app.mailgun_webhook_events (
    id, workspace_id, provider_connection_id, provider_operation_id,
    message_delivery_id, external_event_id, event_type, failure_severity,
    occurred_at, payload_sha256, event_identity_sha256,
    signature_timestamp, signature_token_sha256,
    recipient_identity_sha256, suppression_recorded, opt_out_recorded,
    actor_kind, request_id
  ) VALUES (
    selected_event_id, trusted_workspace_id, p_provider_connection_id,
    selected_operation_id, selected_delivery_id, p_external_event_id,
    p_event_type, p_failure_severity, p_occurred_at, p_payload_sha256,
    p_event_identity_sha256, p_signature_timestamp,
    p_signature_token_sha256, p_recipient_identity_sha256,
    should_suppress, should_opt_out, 'webhook', trusted_request_id
  ) ON CONFLICT (
    workspace_id, provider_connection_id, external_event_id
  ) DO NOTHING;
  GET DIAGNOSTICS event_inserted = ROW_COUNT;

  IF event_inserted = 0 THEN
    SELECT event.* INTO existing_event
    FROM app.mailgun_webhook_events AS event
    WHERE event.workspace_id = trusted_workspace_id
      AND event.provider_connection_id = p_provider_connection_id
      AND event.external_event_id = p_external_event_id;
    IF existing_event.event_identity_sha256 IS DISTINCT FROM p_event_identity_sha256
       OR existing_event.provider_operation_id IS DISTINCT FROM selected_operation_id
       OR existing_event.message_delivery_id IS DISTINCT FROM selected_delivery_id THEN
      RAISE EXCEPTION 'mailgun event identity conflict' USING ERRCODE = '22000';
    END IF;
    SELECT delivery.status INTO selected_delivery_status
    FROM app.message_deliveries AS delivery
    WHERE delivery.workspace_id = trusted_workspace_id
      AND delivery.id = selected_delivery_id;
    RETURN QUERY SELECT true, selected_delivery_status,
      existing_event.suppression_recorded, existing_event.opt_out_recorded;
    RETURN;
  END IF;

  normalized_failure_code := CASE
    WHEN p_event_type = 'failed'
      THEN 'mailgun.' || p_failure_severity
    ELSE NULL
  END;
  projected_status := CASE p_event_type
    WHEN 'accepted' THEN 'accepted'
    WHEN 'delivered' THEN 'delivered'
    WHEN 'opened' THEN 'read'
    WHEN 'failed' THEN 'failed'
    ELSE NULL
  END;

  IF projected_status IS NOT NULL THEN
    INSERT INTO app.provider_operation_receipts (
      workspace_id, provider_operation_id, message_delivery_id,
      source_kind, external_event_id, payload_sha256, delivery_status,
      error_code, actor_kind, occurred_at
    ) VALUES (
      trusted_workspace_id, selected_operation_id, selected_delivery_id,
      'verified_webhook', p_external_event_id, p_payload_sha256,
      projected_status, normalized_failure_code, 'webhook', p_occurred_at
    );
  END IF;

  -- Acceptance is projected only to accepted. It can never create delivered
  -- or read evidence. Stronger event types retain their own immutable receipt.
  IF p_event_type = 'accepted' THEN
    UPDATE app.message_deliveries AS delivery
    SET status = 'accepted',
        accepted_at = greatest(delivery.queued_at, p_occurred_at),
        updated_at = statement_timestamp()
    WHERE delivery.workspace_id = trusted_workspace_id
      AND delivery.id = selected_delivery_id
      AND delivery.status IN ('queued', 'sending', 'reconciliation_required');
  ELSIF p_event_type = 'delivered' THEN
    UPDATE app.message_deliveries AS delivery
    SET status = 'delivered',
        accepted_at = coalesce(
          delivery.accepted_at, greatest(delivery.queued_at, p_occurred_at)
        ),
        delivered_at = greatest(delivery.queued_at, p_occurred_at),
        updated_at = statement_timestamp()
    WHERE delivery.workspace_id = trusted_workspace_id
      AND delivery.id = selected_delivery_id
      AND delivery.status NOT IN ('read', 'failed', 'cancelled');
  ELSIF p_event_type = 'opened' THEN
    UPDATE app.message_deliveries AS delivery
    SET status = 'read',
        accepted_at = coalesce(
          delivery.accepted_at, greatest(delivery.queued_at, p_occurred_at)
        ),
        delivered_at = coalesce(
          delivery.delivered_at, greatest(delivery.queued_at, p_occurred_at)
        ),
        read_at = greatest(delivery.queued_at, p_occurred_at),
        updated_at = statement_timestamp()
    WHERE delivery.workspace_id = trusted_workspace_id
      AND delivery.id = selected_delivery_id
      AND delivery.status NOT IN ('failed', 'cancelled');
  ELSIF p_event_type = 'failed' AND p_failure_severity = 'permanent' THEN
    UPDATE app.message_deliveries AS delivery
    SET status = 'failed',
        accepted_at = NULL,
        delivered_at = NULL,
        read_at = NULL,
        failed_at = greatest(delivery.queued_at, p_occurred_at),
        updated_at = statement_timestamp()
    WHERE delivery.workspace_id = trusted_workspace_id
      AND delivery.id = selected_delivery_id
      AND delivery.status NOT IN ('delivered', 'read', 'cancelled');
  END IF;

  IF should_suppress THEN
    INSERT INTO app.communication_suppression_events (
      workspace_id, contact_id, contact_point_id, channel, purpose,
      state, reason, source, source_event_id, actor_kind, actor_user_id,
      evidence, endpoint_identity_sha256, occurred_at
    ) VALUES (
      trusted_workspace_id, selected_contact_id, selected_contact_point_id,
      'email', NULL, 'suppressed',
      CASE
        WHEN p_event_type = 'complained' THEN 'mailgun_complaint'
        WHEN p_event_type = 'unsubscribed' THEN 'mailgun_unsubscribe'
        ELSE 'mailgun_permanent_failure'
      END,
      'mailgun.webhook', p_external_event_id, 'webhook', NULL,
      jsonb_build_object(
        'mailgunEventType', p_event_type,
        'mailgunEvidenceId', selected_event_id,
        'failureSeverity', p_failure_severity
      ), decode(repeat('00', 32), 'hex'), p_occurred_at
    );
  END IF;

  IF should_opt_out THEN
    INSERT INTO app.communication_consent_events (
      workspace_id, contact_id, contact_point_id, channel, purpose,
      state, lawful_basis, source, source_event_id, actor_kind,
      actor_user_id, evidence, endpoint_identity_sha256, occurred_at
    ) VALUES (
      trusted_workspace_id, selected_contact_id, selected_contact_point_id,
      'email', selected_purpose, 'withdrawn', NULL, 'mailgun.webhook',
      p_external_event_id, 'webhook', NULL,
      jsonb_build_object(
        'mailgunEventType', p_event_type,
        'mailgunEvidenceId', selected_event_id
      ), decode(repeat('00', 32), 'hex'), p_occurred_at
    );
  END IF;

  SELECT delivery.status INTO selected_delivery_status
  FROM app.message_deliveries AS delivery
  WHERE delivery.workspace_id = trusted_workspace_id
    AND delivery.id = selected_delivery_id;
  RETURN QUERY SELECT false, selected_delivery_status,
    should_suppress, should_opt_out;
END
$function$;

-- Startup readiness proves the server-owned workspace/connection binding
-- exists and is the exact live EU email connection. The command role receives
-- only this boolean result and remains table-blind.
CREATE FUNCTION app_private.mailgun_webhook_binding_ready(
  p_workspace_id uuid,
  p_provider_connection_id uuid
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT current_setting('app.workspace_id', true) = p_workspace_id::text
    AND current_setting('app.actor_kind', true) = 'webhook'
    AND coalesce(current_setting('app.user_id', true), '') = ''
    AND EXISTS (
      SELECT 1
      FROM app.provider_connections AS connection
      WHERE connection.workspace_id = p_workspace_id
        AND connection.id = p_provider_connection_id
        AND connection.provider_id = 'mailgun_eu'
        AND connection.provider_kind = 'email'
        AND connection.environment = 'live'
        AND connection.status = 'active'
    )
$function$;

REVOKE ALL ON FUNCTION app_private.record_mailgun_webhook_event(
  uuid, uuid, text, text, timestamptz, text, bytea, bytea, bytea,
  timestamptz, bytea, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.mailgun_webhook_binding_ready(uuid, uuid)
  FROM PUBLIC;
REVOKE CREATE ON SCHEMA app_private FROM r72_mailgun_webhook_definer;

SET LOCAL ROLE r72_owner;

GRANT EXECUTE ON FUNCTION app_private.record_mailgun_webhook_event(
  uuid, uuid, text, text, timestamptz, text, bytea, bytea, bytea,
  timestamptz, bytea, text
) TO r72_mailgun_webhook_command;
GRANT EXECUTE ON FUNCTION app_private.mailgun_webhook_binding_ready(uuid, uuid)
  TO r72_mailgun_webhook_command;

INSERT INTO app_private.workspace_table_registry
  (schema_name, table_name, workspace_column)
VALUES
  ('app', 'mailgun_webhook_events', 'workspace_id'),
  ('app', 'mailgun_webhook_signature_tokens', 'workspace_id');

DO $capability_audit$
DECLARE
  recorder_oid oid := pg_catalog.to_regprocedure(
    'app_private.record_mailgun_webhook_event(uuid,uuid,text,text,timestamp with time zone,text,bytea,bytea,bytea,timestamp with time zone,bytea,text)'
  );
  binding_oid oid := pg_catalog.to_regprocedure(
    'app_private.mailgun_webhook_binding_ready(uuid,uuid)'
  );
  unsafe_object text;
BEGIN
  IF recorder_oid IS NULL OR binding_oid IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = procedure.proowner
    WHERE procedure.oid = recorder_oid
      AND owner_role.rolname = 'r72_mailgun_webhook_definer'
      AND procedure.prosecdef
      AND procedure.proconfig = ARRAY['search_path=pg_catalog']::text[]
  ) THEN
    RAISE EXCEPTION 'Mailgun recorder ownership or SECURITY DEFINER settings are unsafe';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = procedure.proowner
    WHERE procedure.oid = binding_oid
      AND owner_role.rolname = 'r72_mailgun_webhook_definer'
      AND procedure.prosecdef
      AND procedure.proconfig = ARRAY['search_path=pg_catalog']::text[]
  ) THEN
    RAISE EXCEPTION 'Mailgun binding readiness ownership or SECURITY DEFINER settings are unsafe';
  END IF;

  IF NOT pg_catalog.has_schema_privilege(
       'r72_mailgun_webhook_command', 'app_private', 'USAGE'
     )
     OR pg_catalog.has_schema_privilege(
       'r72_mailgun_webhook_command', 'app_private', 'CREATE'
     )
     OR pg_catalog.has_schema_privilege(
       'r72_mailgun_webhook_command', 'app', 'USAGE'
     ) THEN
    RAISE EXCEPTION 'Mailgun command schema privileges are unsafe';
  END IF;

  SELECT format('%I.%I', namespace.nspname, relation.relname)
    INTO unsafe_object
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname IN ('app', 'app_private')
    AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND (
      pg_catalog.has_table_privilege(
        'r72_mailgun_webhook_command', relation.oid, 'SELECT'
      ) OR pg_catalog.has_table_privilege(
        'r72_mailgun_webhook_command', relation.oid, 'INSERT'
      ) OR pg_catalog.has_table_privilege(
        'r72_mailgun_webhook_command', relation.oid, 'UPDATE'
      ) OR pg_catalog.has_table_privilege(
        'r72_mailgun_webhook_command', relation.oid, 'DELETE'
      ) OR pg_catalog.has_table_privilege(
        'r72_mailgun_webhook_command', relation.oid, 'TRUNCATE'
      )
    )
  LIMIT 1;
  IF unsafe_object IS NOT NULL THEN
    RAISE EXCEPTION 'Mailgun command unexpectedly has table privilege on %',
      unsafe_object;
  END IF;

  IF NOT pg_catalog.has_function_privilege(
       'r72_mailgun_webhook_command', recorder_oid, 'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'r72_mailgun_webhook_command', binding_oid, 'EXECUTE'
     )
     OR pg_catalog.has_table_privilege(
       'r72_mailgun_webhook_definer', 'app.message_versions', 'SELECT'
     )
     OR pg_catalog.has_table_privilege(
       'r72_mailgun_webhook_definer', 'app.messages', 'SELECT'
     )
     OR pg_catalog.has_table_privilege(
       'r72_mailgun_webhook_definer', 'app.contact_points', 'UPDATE'
     )
     OR pg_catalog.has_table_privilege(
       'r72_mailgun_webhook_definer', 'app.provider_operations', 'UPDATE'
     ) THEN
    RAISE EXCEPTION 'Mailgun webhook capability is broader than required';
  END IF;

  IF pg_catalog.has_table_privilege(
       'r72_webhook', 'app.mailgun_webhook_events', 'SELECT'
     )
     OR pg_catalog.has_table_privilege(
       'r72_web', 'app.mailgun_webhook_events', 'SELECT'
     )
     OR pg_catalog.has_table_privilege(
       'r72_worker', 'app.mailgun_webhook_signature_tokens', 'SELECT'
     ) THEN
    RAISE EXCEPTION 'Mailgun evidence is exposed to a broad runtime role';
  END IF;
END
$capability_audit$;
