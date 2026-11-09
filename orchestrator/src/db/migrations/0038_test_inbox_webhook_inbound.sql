-- Durable, replay-safe inbound TEST messages for the signed WhatsApp and
-- social-DM simulators. The LOGIN can execute one SECURITY DEFINER recorder
-- only. It cannot read inbox bodies, endpoint addresses, or any live provider.

DO $roles$
DECLARE
  role_name text;
  expected_login boolean;
  unsafe_membership text;
BEGIN
  FOR role_name, expected_login IN
    SELECT required.role_name, required.expected_login
    FROM (VALUES
      ('r72_test_inbox_webhook_definer', false),
      ('r72_test_inbox_webhook_command', true)
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
      RAISE EXCEPTION 'Unsafe test inbox webhook role attributes: %', role_name;
    END IF;
  END LOOP;

  REVOKE r72_owner, r72_security_definer, r72_onboarding_definer,
    r72_setup_delivery_definer, r72_commerce_definer,
    r72_external_event_definer, r72_provider_operation_definer,
    r72_mailgun_webhook_definer
  FROM r72_test_inbox_webhook_definer, r72_test_inbox_webhook_command;
  REVOKE r72_test_inbox_webhook_definer
  FROM r72_web, r72_public, r72_worker, r72_webhook, r72_readonly,
    r72_crm_command, r72_identity_command, r72_provisioning_command,
    r72_setup_delivery_command, r72_setup_reissue_command,
    r72_external_event_command, r72_mailgun_webhook_command,
    r72_test_inbox_webhook_command;
  REVOKE r72_test_inbox_webhook_command
  FROM r72_web, r72_public, r72_worker, r72_webhook, r72_readonly,
    r72_crm_command, r72_identity_command, r72_provisioning_command,
    r72_setup_delivery_command, r72_setup_reissue_command,
    r72_external_event_command, r72_mailgun_webhook_command,
    r72_test_inbox_webhook_definer, r72_owner;

  SELECT member.rolname || '->' || parent.rolname INTO unsafe_membership
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
  JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
  WHERE member.rolname IN (
    'r72_test_inbox_webhook_definer', 'r72_test_inbox_webhook_command'
  )
  LIMIT 1;
  IF unsafe_membership IS NOT NULL THEN
    RAISE EXCEPTION 'Unsafe test inbox webhook role membership: %', unsafe_membership;
  END IF;

  GRANT r72_test_inbox_webhook_definer TO r72_owner;
  EXECUTE format('GRANT r72_test_inbox_webhook_command TO %I', current_user);
END
$roles$;

SET LOCAL ROLE r72_owner;

REVOKE ALL ON SCHEMA app, app_private
  FROM r72_test_inbox_webhook_definer, r72_test_inbox_webhook_command;
REVOKE ALL ON ALL TABLES IN SCHEMA app
  FROM r72_test_inbox_webhook_definer, r72_test_inbox_webhook_command;
REVOKE ALL ON ALL TABLES IN SCHEMA app_private
  FROM r72_test_inbox_webhook_definer, r72_test_inbox_webhook_command;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app_private
  FROM r72_test_inbox_webhook_definer, r72_test_inbox_webhook_command;
REVOKE CREATE ON SCHEMA public
  FROM r72_test_inbox_webhook_definer, r72_test_inbox_webhook_command;

-- These simulator identifiers can never become sandbox/live connections.
ALTER TABLE app.provider_connections
  ADD CONSTRAINT provider_connections_dark_simulators_test_only_ck
  CHECK (
    provider_id NOT IN (
      'whatsapp_dark_simulator', 'social_dm_dark_simulator'
    ) OR environment = 'test'
  ) NOT VALID;
ALTER TABLE app.provider_connections
  VALIDATE CONSTRAINT provider_connections_dark_simulators_test_only_ck;

-- Composite keys make the later receipt foreign keys prove that connection,
-- inbox, conversation, channel, environment and contact are one exact chain.
ALTER TABLE app.inboxes
  ADD CONSTRAINT inboxes_test_webhook_binding_uq UNIQUE (
    workspace_id, id, provider_connection_id, channel, environment
  );
ALTER TABLE app.conversations
  ADD CONSTRAINT conversations_test_webhook_binding_uq UNIQUE (
    workspace_id, id, inbox_id, channel, environment, contact_id
  );

CREATE TABLE app.test_inbox_webhook_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  provider_connection_id uuid NOT NULL,
  provider_id text NOT NULL CHECK (
    provider_id IN ('whatsapp_dark_simulator', 'social_dm_dark_simulator')
  ),
  environment text NOT NULL DEFAULT 'test' CHECK (environment = 'test'),
  channel text NOT NULL CHECK (
    channel IN ('whatsapp', 'instagram', 'facebook')
  ),
  inbox_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  contact_point_id uuid NOT NULL,
  external_event_id text NOT NULL CHECK (
    external_event_id = btrim(external_event_id)
    AND length(external_event_id) BETWEEN 38 AND 46
    AND external_event_id ~ '^(waevt|social_dm_evt)_[a-f0-9]{32}$'
  ),
  payload_sha256 bytea NOT NULL CHECK (octet_length(payload_sha256) = 32),
  event_identity_sha256 bytea NOT NULL CHECK (
    octet_length(event_identity_sha256) = 32
  ),
  signature_sha256 bytea NOT NULL CHECK (octet_length(signature_sha256) = 32),
  source_identity_sha256 bytea NOT NULL CHECK (
    octet_length(source_identity_sha256) = 32
  ),
  destination_identity_sha256 bytea NOT NULL CHECK (
    octet_length(destination_identity_sha256) = 32
  ),
  conversation_id uuid NOT NULL,
  message_id uuid NOT NULL,
  message_version_id uuid NOT NULL,
  version_number integer NOT NULL DEFAULT 1 CHECK (version_number = 1),
  body_sha256 bytea NOT NULL CHECK (octet_length(body_sha256) = 32),
  occurred_at timestamptz NOT NULL,
  actor_kind text NOT NULL DEFAULT 'webhook' CHECK (actor_kind = 'webhook'),
  request_id text NOT NULL CHECK (
    length(request_id) BETWEEN 1 AND 128 AND request_id !~ '[^[:graph:]]'
  ),
  received_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, provider_connection_id, external_event_id),
  UNIQUE (workspace_id, provider_connection_id, signature_sha256),
  UNIQUE (workspace_id, message_id),
  FOREIGN KEY (workspace_id, provider_connection_id, environment)
    REFERENCES app.provider_connections (
      workspace_id, id, environment
    ) ON DELETE RESTRICT,
  FOREIGN KEY (
    workspace_id, inbox_id, provider_connection_id, channel, environment
  ) REFERENCES app.inboxes (
    workspace_id, id, provider_connection_id, channel, environment
  ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, contact_id)
    REFERENCES app.contacts (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, contact_point_id, contact_id)
    REFERENCES app.contact_points (workspace_id, id, contact_id) ON DELETE RESTRICT,
  FOREIGN KEY (
    workspace_id, conversation_id, inbox_id,
    channel, environment, contact_id
  ) REFERENCES app.conversations (
    workspace_id, id, inbox_id, channel, environment, contact_id
  ) ON DELETE RESTRICT,
  FOREIGN KEY (
    workspace_id, conversation_id, message_id,
    message_version_id, version_number, body_sha256
  ) REFERENCES app.message_versions (
    workspace_id, conversation_id, message_id,
    id, version_number, body_sha256
  ) ON DELETE RESTRICT,
  CHECK (
    (provider_id = 'whatsapp_dark_simulator'
      AND channel = 'whatsapp'
      AND external_event_id ~ '^waevt_[a-f0-9]{32}$')
    OR (provider_id = 'social_dm_dark_simulator'
      AND channel IN ('instagram', 'facebook')
      AND external_event_id ~ '^social_dm_evt_[a-f0-9]{32}$')
  )
);

CREATE INDEX test_inbox_webhook_receipts_conversation_time_idx
  ON app.test_inbox_webhook_receipts (
    workspace_id, conversation_id, occurred_at DESC, id
  );

CREATE TRIGGER test_inbox_webhook_receipts_append_only
  BEFORE UPDATE OR DELETE ON app.test_inbox_webhook_receipts
  FOR EACH ROW EXECUTE FUNCTION app_private.reject_inbox_append_only_mutation();

ALTER TABLE app.test_inbox_webhook_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.test_inbox_webhook_receipts FORCE ROW LEVEL SECURITY;

CREATE POLICY test_inbox_webhook_receipts_owner_all
  ON app.test_inbox_webhook_receipts FOR ALL TO r72_owner
  USING (true) WITH CHECK (true);
CREATE POLICY test_inbox_webhook_receipts_definer_all
  ON app.test_inbox_webhook_receipts FOR ALL
  TO r72_test_inbox_webhook_definer
  USING (
    workspace_id = app_private.current_workspace_id()
    AND app_private.current_actor_kind() = 'webhook'
  ) WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND app_private.current_actor_kind() = 'webhook'
    AND actor_kind = 'webhook'
    AND request_id = app_private.current_request_id()
  );
CREATE POLICY test_inbox_webhook_receipts_definer_member_select
  ON app.test_inbox_webhook_receipts FOR SELECT
  TO r72_test_inbox_webhook_definer
  USING (
    workspace_id = app_private.current_workspace_id()
    AND app_private.current_actor_kind() = 'user'
    AND app_private.current_user_id() IS NOT NULL
    AND app_private.has_active_workspace_membership(
      app_private.current_user_id(), workspace_id
    )
  );

CREATE POLICY provider_connections_test_inbox_webhook_select
  ON app.provider_connections FOR SELECT TO r72_test_inbox_webhook_definer
  USING (
    workspace_id = app_private.current_workspace_id()
    AND app_private.current_actor_kind() = 'webhook'
    AND provider_id IN (
      'whatsapp_dark_simulator', 'social_dm_dark_simulator'
    )
    AND environment = 'test' AND status = 'active'
  );
CREATE POLICY channel_endpoints_test_inbox_webhook_select
  ON app.channel_endpoints FOR SELECT TO r72_test_inbox_webhook_definer
  USING (
    workspace_id = app_private.current_workspace_id()
    AND app_private.current_actor_kind() = 'webhook'
    AND environment = 'test' AND status = 'active'
    AND direction IN ('inbound', 'bidirectional')
  );
CREATE POLICY inboxes_test_inbox_webhook_select
  ON app.inboxes FOR SELECT TO r72_test_inbox_webhook_definer
  USING (
    workspace_id = app_private.current_workspace_id()
    AND app_private.current_actor_kind() = 'webhook'
    AND environment = 'test' AND status = 'active'
  );
CREATE POLICY contact_points_test_inbox_webhook_select
  ON app.contact_points FOR SELECT TO r72_test_inbox_webhook_definer
  USING (
    workspace_id = app_private.current_workspace_id()
    AND app_private.current_actor_kind() = 'webhook'
    AND deleted_at IS NULL AND is_verified AND dedupe_state = 'normal'
    AND kind IN ('whatsapp', 'social')
  );
CREATE POLICY conversations_test_inbox_webhook_select
  ON app.conversations FOR SELECT TO r72_test_inbox_webhook_definer
  USING (
    workspace_id = app_private.current_workspace_id()
    AND app_private.current_actor_kind() = 'webhook'
    AND environment = 'test' AND state IN ('open', 'snoozed')
  );
CREATE POLICY conversations_test_inbox_webhook_insert
  ON app.conversations FOR INSERT TO r72_test_inbox_webhook_definer
  WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND app_private.current_actor_kind() = 'webhook'
    AND environment = 'test' AND state = 'open'
  );
CREATE POLICY conversations_test_inbox_webhook_update
  ON app.conversations FOR UPDATE TO r72_test_inbox_webhook_definer
  USING (
    workspace_id = app_private.current_workspace_id()
    AND app_private.current_actor_kind() = 'webhook'
    AND environment = 'test' AND state IN ('open', 'snoozed')
  ) WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND app_private.current_actor_kind() = 'webhook'
    AND environment = 'test' AND state IN ('open', 'snoozed')
  );
CREATE POLICY messages_test_inbox_webhook_insert
  ON app.messages FOR INSERT TO r72_test_inbox_webhook_definer
  WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND app_private.current_actor_kind() = 'webhook'
    AND environment = 'test' AND direction = 'inbound'
    AND lifecycle = 'received' AND source_kind = 'verified_webhook'
    AND created_by_actor_kind = 'webhook' AND created_by_user_id IS NULL
  );
CREATE POLICY message_versions_test_inbox_webhook_insert
  ON app.message_versions FOR INSERT TO r72_test_inbox_webhook_definer
  WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND app_private.current_actor_kind() = 'webhook'
    AND environment = 'test' AND version_number = 1
    AND created_by_actor_kind = 'webhook' AND created_by_user_id IS NULL
    AND created_request_id = app_private.current_request_id()
    AND source_content_version_ref IS NULL
    AND source_content_sha256 IS NULL
    AND source_content_approval_ref IS NULL
  );

GRANT USAGE ON SCHEMA app, app_private TO r72_test_inbox_webhook_definer;
GRANT SELECT, INSERT ON app.test_inbox_webhook_receipts
  TO r72_test_inbox_webhook_definer;
GRANT SELECT ON app.provider_connections, app.channel_endpoints, app.inboxes,
  app.contact_points TO r72_test_inbox_webhook_definer;
GRANT SELECT, INSERT ON app.conversations TO r72_test_inbox_webhook_definer;
GRANT UPDATE (unread_count, last_message_at, row_version, updated_at)
  ON app.conversations TO r72_test_inbox_webhook_definer;
GRANT INSERT ON app.messages, app.message_versions
  TO r72_test_inbox_webhook_definer;
GRANT EXECUTE ON FUNCTION app_private.current_workspace_id(),
  app_private.current_user_id(), app_private.current_actor_kind(),
  app_private.current_request_id(),
  app_private.has_active_workspace_membership(uuid, uuid)
  TO r72_test_inbox_webhook_definer;

-- The LOGIN can install transaction-local context and invoke one recorder. It
-- receives neither app schema usage nor direct table privileges.
GRANT USAGE ON SCHEMA app_private TO r72_test_inbox_webhook_command;
GRANT EXECUTE ON FUNCTION app_private.current_workspace_id(),
  app_private.current_actor_kind(), app_private.current_request_id()
  TO r72_test_inbox_webhook_command;

GRANT CREATE ON SCHEMA app_private TO r72_test_inbox_webhook_definer;
SET LOCAL ROLE r72_test_inbox_webhook_definer;

CREATE FUNCTION app_private.record_test_inbox_webhook_inbound(
  p_workspace_id uuid,
  p_provider_connection_id uuid,
  p_provider_id text,
  p_inbox_id uuid,
  p_contact_id uuid,
  p_contact_point_id uuid,
  p_external_event_id text,
  p_payload_sha256 bytea,
  p_event_identity_sha256 bytea,
  p_signature_sha256 bytea,
  p_source_identity_sha256 bytea,
  p_destination_identity_sha256 bytea,
  p_body text,
  p_body_sha256 bytea,
  p_occurred_at timestamptz,
  p_proposed_conversation_id uuid,
  p_proposed_message_id uuid,
  p_proposed_message_version_id uuid
)
RETURNS TABLE (
  replayed boolean,
  conversation_id uuid,
  message_id uuid,
  message_version_id uuid,
  body_sha256 bytea
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
  existing_event app.test_inbox_webhook_receipts%ROWTYPE;
  existing_signature app.test_inbox_webhook_receipts%ROWTYPE;
  selected_channel text;
  selected_conversation_id uuid;
  received_at timestamptz := statement_timestamp();
BEGIN
  IF trusted_workspace_id IS NULL OR trusted_actor_kind <> 'webhook'
     OR trusted_request_id IS NULL
     OR length(trusted_request_id) NOT BETWEEN 1 AND 128
     OR trusted_request_id ~ '[^[:graph:]]'
     OR p_workspace_id IS NULL OR p_workspace_id <> trusted_workspace_id
     OR p_provider_connection_id IS NULL OR p_inbox_id IS NULL
     OR p_contact_id IS NULL OR p_contact_point_id IS NULL
     OR p_provider_id NOT IN (
       'whatsapp_dark_simulator', 'social_dm_dark_simulator'
     )
     OR p_external_event_id IS NULL OR p_external_event_id <> btrim(p_external_event_id)
     OR (p_provider_id = 'whatsapp_dark_simulator'
       AND p_external_event_id !~ '^waevt_[a-f0-9]{32}$')
     OR (p_provider_id = 'social_dm_dark_simulator'
       AND p_external_event_id !~ '^social_dm_evt_[a-f0-9]{32}$')
     OR octet_length(p_payload_sha256) IS DISTINCT FROM 32
     OR octet_length(p_event_identity_sha256) IS DISTINCT FROM 32
     OR octet_length(p_signature_sha256) IS DISTINCT FROM 32
     OR octet_length(p_source_identity_sha256) IS DISTINCT FROM 32
     OR octet_length(p_destination_identity_sha256) IS DISTINCT FROM 32
     OR p_body IS NULL OR octet_length(p_body) NOT BETWEEN 1 AND 16384
     OR octet_length(p_body_sha256) IS DISTINCT FROM 32
     OR p_body_sha256 IS DISTINCT FROM public.digest(p_body, 'sha256')
     OR p_occurred_at IS NULL
     OR p_occurred_at < received_at - interval '5 minutes'
     OR p_occurred_at > received_at + interval '5 minutes'
     OR p_proposed_conversation_id IS NULL OR p_proposed_message_id IS NULL
     OR p_proposed_message_version_id IS NULL
     OR p_proposed_conversation_id = p_proposed_message_id
     OR p_proposed_conversation_id = p_proposed_message_version_id
     OR p_proposed_message_id = p_proposed_message_version_id THEN
    RAISE EXCEPTION 'invalid test inbox webhook input' USING ERRCODE = '22023';
  END IF;

  -- Serialise signature reuse and exact-event replays before reading or
  -- creating a conversation. Signature-first ordering prevents two distinct
  -- event IDs from racing the unique signature fence.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'test-inbox-signature:' || pg_catalog.encode(p_signature_sha256, 'hex'), 0
    )
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'test-inbox-event:' || p_workspace_id::text || ':'
        || p_provider_connection_id::text || ':' || p_external_event_id,
      0
    )
  );
  -- Different signed events for the same person may arrive concurrently. A
  -- transaction-scoped key serialises conversation reuse without granting the
  -- definer UPDATE authority over the inbox merely to take a row lock.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'test-inbox-conversation:' || p_workspace_id::text || ':'
        || p_inbox_id::text || ':' || p_contact_id::text,
      0
    )
  );

  SELECT receipt.* INTO existing_signature
  FROM app.test_inbox_webhook_receipts AS receipt
  WHERE receipt.workspace_id = p_workspace_id
    AND receipt.provider_connection_id = p_provider_connection_id
    AND receipt.signature_sha256 = p_signature_sha256;
  IF FOUND AND (
    existing_signature.external_event_id IS DISTINCT FROM p_external_event_id
    OR existing_signature.payload_sha256 IS DISTINCT FROM p_payload_sha256
    OR existing_signature.event_identity_sha256 IS DISTINCT FROM p_event_identity_sha256
  ) THEN
    RAISE EXCEPTION 'test inbox webhook signature replay conflict'
      USING ERRCODE = '22000';
  END IF;

  SELECT receipt.* INTO existing_event
  FROM app.test_inbox_webhook_receipts AS receipt
  WHERE receipt.workspace_id = p_workspace_id
    AND receipt.provider_connection_id = p_provider_connection_id
    AND receipt.external_event_id = p_external_event_id;
  IF FOUND THEN
    IF existing_event.provider_id IS DISTINCT FROM p_provider_id
       OR existing_event.inbox_id IS DISTINCT FROM p_inbox_id
       OR existing_event.contact_id IS DISTINCT FROM p_contact_id
       OR existing_event.contact_point_id IS DISTINCT FROM p_contact_point_id
       OR existing_event.payload_sha256 IS DISTINCT FROM p_payload_sha256
       OR existing_event.event_identity_sha256 IS DISTINCT FROM p_event_identity_sha256
       OR existing_event.signature_sha256 IS DISTINCT FROM p_signature_sha256
       OR existing_event.source_identity_sha256 IS DISTINCT FROM p_source_identity_sha256
       OR existing_event.destination_identity_sha256 IS DISTINCT FROM p_destination_identity_sha256
       OR existing_event.body_sha256 IS DISTINCT FROM p_body_sha256
       OR existing_event.occurred_at IS DISTINCT FROM p_occurred_at THEN
      RAISE EXCEPTION 'test inbox webhook event identity conflict'
        USING ERRCODE = '22000';
    END IF;
    RETURN QUERY SELECT true, existing_event.conversation_id,
      existing_event.message_id, existing_event.message_version_id,
      existing_event.body_sha256;
    RETURN;
  END IF;

  SELECT inbox.channel INTO selected_channel
  FROM app.provider_connections AS connection
  JOIN app.inboxes AS inbox
    ON inbox.workspace_id = connection.workspace_id
   AND inbox.provider_connection_id = connection.id
   AND inbox.id = p_inbox_id
   AND inbox.environment = 'test' AND inbox.status = 'active'
  JOIN app.channel_endpoints AS endpoint
    ON endpoint.workspace_id = inbox.workspace_id
   AND endpoint.id = inbox.channel_endpoint_id
   AND endpoint.provider_connection_id = connection.id
   AND endpoint.channel = inbox.channel
   AND endpoint.environment = 'test' AND endpoint.status = 'active'
   AND endpoint.direction IN ('inbound', 'bidirectional')
  JOIN app.contact_points AS point
    ON point.workspace_id = inbox.workspace_id
   AND point.id = p_contact_point_id AND point.contact_id = p_contact_id
   AND point.deleted_at IS NULL AND point.is_verified
   AND point.dedupe_state = 'normal'
  WHERE connection.workspace_id = p_workspace_id
    AND connection.id = p_provider_connection_id
    AND connection.provider_id = p_provider_id
    AND connection.environment = 'test' AND connection.status = 'active'
    AND public.digest(point.normalized_value, 'sha256') = p_source_identity_sha256
    AND public.digest(endpoint.normalized_address, 'sha256') = p_destination_identity_sha256
    AND (
      (p_provider_id = 'whatsapp_dark_simulator'
       AND connection.provider_kind = 'messaging'
       AND inbox.channel = 'whatsapp' AND point.kind = 'whatsapp'
       AND point.normalized_value ~ '^[+]447700900[0-9]{3}$'
       AND endpoint.normalized_address ~ '^[+]447700900[0-9]{3}$')
      OR
      (p_provider_id = 'social_dm_dark_simulator'
       AND connection.provider_kind = 'social'
       AND inbox.channel IN ('instagram', 'facebook') AND point.kind = 'social'
       AND point.normalized_value ~ (
         '^test-dm:' || inbox.channel || ':[a-z0-9_.-]{1,64}$'
       )
       AND endpoint.normalized_address ~ (
         '^test-dm:' || inbox.channel || ':[a-z0-9_.-]{1,64}$'
       ))
    )
  ;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'test inbox webhook binding is unavailable'
      USING ERRCODE = '42501';
  END IF;

  SELECT conversation.id INTO selected_conversation_id
  FROM app.conversations AS conversation
  WHERE conversation.workspace_id = p_workspace_id
    AND conversation.inbox_id = p_inbox_id
    AND conversation.contact_id = p_contact_id
    AND conversation.channel = selected_channel
    AND conversation.environment = 'test'
    AND conversation.state IN ('open', 'snoozed')
  FOR UPDATE OF conversation;

  IF selected_conversation_id IS NULL THEN
    selected_conversation_id := p_proposed_conversation_id;
    INSERT INTO app.conversations (
      id, workspace_id, inbox_id, channel, environment, contact_id,
      state, unread_count, last_message_at, created_at, updated_at
    ) VALUES (
      selected_conversation_id, p_workspace_id, p_inbox_id,
      selected_channel, 'test', p_contact_id,
      'open', 0, NULL, least(p_occurred_at, received_at), received_at
    );
  END IF;

  INSERT INTO app.messages (
    id, workspace_id, conversation_id, contact_id, contact_point_id,
    channel, environment, direction, lifecycle, source_kind,
    current_version_id, current_version_number, current_body_sha256,
    created_by_actor_kind, created_by_user_id, occurred_at,
    created_at, updated_at
  ) VALUES (
    p_proposed_message_id, p_workspace_id, selected_conversation_id,
    p_contact_id, p_contact_point_id, selected_channel, 'test',
    'inbound', 'received', 'verified_webhook',
    p_proposed_message_version_id, 1, p_body_sha256,
    'webhook', NULL, p_occurred_at, received_at, received_at
  );

  INSERT INTO app.message_versions (
    id, workspace_id, conversation_id, message_id, channel, environment,
    version_number, body_format, body_text,
    source_content_version_ref, source_content_sha256,
    source_content_approval_ref, created_by_actor_kind,
    created_by_user_id, created_request_id, created_at
  ) VALUES (
    p_proposed_message_version_id, p_workspace_id,
    selected_conversation_id, p_proposed_message_id,
    selected_channel, 'test', 1, 'plain_text', p_body,
    NULL, NULL, NULL, 'webhook', NULL, trusted_request_id, received_at
  );

  UPDATE app.conversations AS conversation
  SET unread_count = least(1000000, conversation.unread_count + 1),
      last_message_at = greatest(
        conversation.created_at,
        coalesce(conversation.last_message_at, conversation.created_at),
        p_occurred_at
      ),
      row_version = conversation.row_version + 1,
      updated_at = received_at
  WHERE conversation.workspace_id = p_workspace_id
    AND conversation.id = selected_conversation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'test inbox webhook conversation update failed';
  END IF;

  INSERT INTO app.test_inbox_webhook_receipts (
    id, workspace_id, provider_connection_id, provider_id,
    environment, channel,
    inbox_id, contact_id, contact_point_id, external_event_id,
    payload_sha256, event_identity_sha256, signature_sha256,
    source_identity_sha256, destination_identity_sha256,
    conversation_id, message_id, message_version_id, version_number,
    body_sha256, occurred_at, actor_kind, request_id, received_at
  ) VALUES (
    gen_random_uuid(), p_workspace_id, p_provider_connection_id, p_provider_id,
    'test', selected_channel,
    p_inbox_id, p_contact_id, p_contact_point_id, p_external_event_id,
    p_payload_sha256, p_event_identity_sha256, p_signature_sha256,
    p_source_identity_sha256, p_destination_identity_sha256,
    selected_conversation_id, p_proposed_message_id,
    p_proposed_message_version_id, 1, p_body_sha256,
    p_occurred_at, 'webhook', trusted_request_id, received_at
  );

  RETURN QUERY SELECT false, selected_conversation_id,
    p_proposed_message_id, p_proposed_message_version_id, p_body_sha256;
END
$function$;

-- Startup can prove the server-owned binding without learning an endpoint or
-- contact address. The command identity receives only this boolean and remains
-- unable to select from any app table.
CREATE FUNCTION app_private.test_inbox_webhook_binding_ready(
  p_workspace_id uuid,
  p_provider_connection_id uuid,
  p_provider_id text,
  p_inbox_id uuid,
  p_contact_id uuid,
  p_contact_point_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT current_setting('app.workspace_id', true) = p_workspace_id::text
    AND current_setting('app.actor_kind', true) = 'webhook'
    AND coalesce(current_setting('app.user_id', true), '') = ''
    AND p_provider_id IN (
      'whatsapp_dark_simulator', 'social_dm_dark_simulator'
    )
    AND EXISTS (
      SELECT 1
      FROM app.provider_connections AS connection
      JOIN app.inboxes AS inbox
        ON inbox.workspace_id = connection.workspace_id
       AND inbox.id = p_inbox_id
       AND inbox.provider_connection_id = connection.id
       AND inbox.environment = 'test' AND inbox.status = 'active'
      JOIN app.channel_endpoints AS endpoint
        ON endpoint.workspace_id = inbox.workspace_id
       AND endpoint.id = inbox.channel_endpoint_id
       AND endpoint.provider_connection_id = connection.id
       AND endpoint.channel = inbox.channel
       AND endpoint.environment = 'test' AND endpoint.status = 'active'
       AND endpoint.direction IN ('inbound', 'bidirectional')
      JOIN app.contact_points AS point
        ON point.workspace_id = inbox.workspace_id
       AND point.id = p_contact_point_id
       AND point.contact_id = p_contact_id
       AND point.deleted_at IS NULL AND point.is_verified
       AND point.dedupe_state = 'normal'
      WHERE connection.workspace_id = p_workspace_id
        AND connection.id = p_provider_connection_id
        AND connection.provider_id = p_provider_id
        AND connection.environment = 'test' AND connection.status = 'active'
        AND (
          (p_provider_id = 'whatsapp_dark_simulator'
           AND connection.provider_kind = 'messaging'
           AND inbox.channel = 'whatsapp' AND point.kind = 'whatsapp'
           AND point.normalized_value ~ '^[+]447700900[0-9]{3}$'
           AND endpoint.normalized_address ~ '^[+]447700900[0-9]{3}$')
          OR
          (p_provider_id = 'social_dm_dark_simulator'
           AND connection.provider_kind = 'social'
           AND inbox.channel IN ('instagram', 'facebook')
           AND point.kind = 'social'
           AND point.normalized_value ~ (
             '^test-dm:' || inbox.channel || ':[a-z0-9_.-]{1,64}$'
           )
           AND endpoint.normalized_address ~ (
             '^test-dm:' || inbox.channel || ':[a-z0-9_.-]{1,64}$'
           ))
        )
    )
$function$;

-- Member-facing provenance is intentionally narrower than the evidence row:
-- one receipt UUID, a provider family, the inbox network and server receipt
-- time. No external/provider/contact IDs, event IDs, hashes, addresses or body
-- can cross this read boundary.
-- The receipt's unique workspace/message key and composite foreign key to the
-- append-only immutable message version prove that this is the exact message,
-- conversation, channel and version recorded by the signed TEST ingress.
CREATE FUNCTION app_private.test_inbox_webhook_message_provenance(
  p_workspace_id uuid,
  p_conversation_id uuid,
  p_message_id uuid
)
RETURNS TABLE (
  receipt_id uuid,
  provider_family text,
  network text,
  received_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT receipt.id,
         CASE receipt.provider_id
           WHEN 'whatsapp_dark_simulator' THEN 'whatsapp'
           WHEN 'social_dm_dark_simulator' THEN 'social_dm'
         END,
         receipt.channel,
         receipt.received_at
  FROM app.test_inbox_webhook_receipts AS receipt
  WHERE p_workspace_id IS NOT NULL
    AND p_workspace_id = app_private.current_workspace_id()
    AND app_private.current_actor_kind() = 'user'
    AND app_private.current_user_id() IS NOT NULL
    AND app_private.has_active_workspace_membership(
      app_private.current_user_id(), p_workspace_id
    )
    AND receipt.workspace_id = p_workspace_id
    AND receipt.conversation_id = p_conversation_id
    AND receipt.message_id = p_message_id
    AND receipt.environment = 'test'
    AND (
      (receipt.provider_id = 'whatsapp_dark_simulator'
       AND receipt.channel = 'whatsapp')
      OR (receipt.provider_id = 'social_dm_dark_simulator'
       AND receipt.channel IN ('instagram', 'facebook'))
    )
$function$;

REVOKE ALL ON FUNCTION app_private.record_test_inbox_webhook_inbound(
  uuid, uuid, text, uuid, uuid, uuid, text,
  bytea, bytea, bytea, bytea, bytea, text, bytea,
  timestamptz, uuid, uuid, uuid
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.test_inbox_webhook_binding_ready(
  uuid, uuid, text, uuid, uuid, uuid
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.test_inbox_webhook_message_provenance(
  uuid, uuid, uuid
) FROM PUBLIC;
REVOKE CREATE ON SCHEMA app_private FROM r72_test_inbox_webhook_definer;

SET LOCAL ROLE r72_owner;

GRANT EXECUTE ON FUNCTION app_private.record_test_inbox_webhook_inbound(
  uuid, uuid, text, uuid, uuid, uuid, text,
  bytea, bytea, bytea, bytea, bytea, text, bytea,
  timestamptz, uuid, uuid, uuid
) TO r72_test_inbox_webhook_command;
GRANT EXECUTE ON FUNCTION app_private.test_inbox_webhook_binding_ready(
  uuid, uuid, text, uuid, uuid, uuid
) TO r72_test_inbox_webhook_command;
GRANT EXECUTE ON FUNCTION app_private.runtime_database_installation_id()
  TO r72_test_inbox_webhook_command;
GRANT EXECUTE ON FUNCTION app_private.test_inbox_webhook_message_provenance(
  uuid, uuid, uuid
) TO r72_web;

INSERT INTO app_private.workspace_table_registry
  (schema_name, table_name, workspace_column)
VALUES ('app', 'test_inbox_webhook_receipts', 'workspace_id');

DO $capability_audit$
DECLARE
  recorder_oid oid := pg_catalog.to_regprocedure(
    'app_private.record_test_inbox_webhook_inbound(uuid,uuid,text,uuid,uuid,uuid,text,bytea,bytea,bytea,bytea,bytea,text,bytea,timestamp with time zone,uuid,uuid,uuid)'
  );
  binding_oid oid := pg_catalog.to_regprocedure(
    'app_private.test_inbox_webhook_binding_ready(uuid,uuid,text,uuid,uuid,uuid)'
  );
  installation_oid oid := pg_catalog.to_regprocedure(
    'app_private.runtime_database_installation_id()'
  );
  provenance_oid oid := pg_catalog.to_regprocedure(
    'app_private.test_inbox_webhook_message_provenance(uuid,uuid,uuid)'
  );
  unsafe_object text;
BEGIN
  IF recorder_oid IS NULL OR binding_oid IS NULL
     OR installation_oid IS NULL OR provenance_oid IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = procedure.proowner
    WHERE procedure.oid = recorder_oid
      AND owner_role.rolname = 'r72_test_inbox_webhook_definer'
      AND procedure.prosecdef
      AND procedure.proconfig = ARRAY['search_path=pg_catalog']::text[]
  ) THEN
    RAISE EXCEPTION 'Test inbox recorder ownership or SECURITY DEFINER settings are unsafe';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = procedure.proowner
    WHERE procedure.oid = binding_oid
      AND owner_role.rolname = 'r72_test_inbox_webhook_definer'
      AND procedure.prosecdef
      AND procedure.proconfig = ARRAY['search_path=pg_catalog']::text[]
  ) OR NOT pg_catalog.has_function_privilege(
    'r72_test_inbox_webhook_command', binding_oid, 'EXECUTE'
  ) OR NOT pg_catalog.has_function_privilege(
    'r72_test_inbox_webhook_command', installation_oid, 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'Test inbox webhook readiness capability is unsafe';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = procedure.proowner
    WHERE procedure.oid = provenance_oid
      AND owner_role.rolname = 'r72_test_inbox_webhook_definer'
      AND procedure.prosecdef
      AND procedure.proconfig = ARRAY['search_path=pg_catalog']::text[]
  ) OR NOT pg_catalog.has_function_privilege(
    'r72_web', provenance_oid, 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'Test inbox provenance read capability is unsafe';
  END IF;

  IF NOT pg_catalog.has_schema_privilege(
       'r72_test_inbox_webhook_command', 'app_private', 'USAGE'
     )
     OR pg_catalog.has_schema_privilege(
       'r72_test_inbox_webhook_command', 'app_private', 'CREATE'
     )
     OR pg_catalog.has_schema_privilege(
       'r72_test_inbox_webhook_command', 'app', 'USAGE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'r72_test_inbox_webhook_command', recorder_oid, 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'Test inbox webhook command capability is unsafe';
  END IF;

  SELECT format('%I.%I', namespace.nspname, relation.relname)
    INTO unsafe_object
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname IN ('app', 'app_private')
    AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND (
      pg_catalog.has_table_privilege(
        'r72_test_inbox_webhook_command', relation.oid, 'SELECT'
      ) OR pg_catalog.has_table_privilege(
        'r72_test_inbox_webhook_command', relation.oid, 'INSERT'
      ) OR pg_catalog.has_table_privilege(
        'r72_test_inbox_webhook_command', relation.oid, 'UPDATE'
      ) OR pg_catalog.has_table_privilege(
        'r72_test_inbox_webhook_command', relation.oid, 'DELETE'
      ) OR pg_catalog.has_table_privilege(
        'r72_test_inbox_webhook_command', relation.oid, 'TRUNCATE'
      )
    )
  LIMIT 1;
  IF unsafe_object IS NOT NULL THEN
    RAISE EXCEPTION 'Test inbox webhook command unexpectedly has table privilege on %',
      unsafe_object;
  END IF;

  IF pg_catalog.has_table_privilege(
       'r72_test_inbox_webhook_definer', 'app.messages', 'SELECT'
     )
     OR pg_catalog.has_table_privilege(
       'r72_test_inbox_webhook_definer', 'app.message_versions', 'SELECT'
     )
     OR pg_catalog.has_table_privilege(
       'r72_test_inbox_webhook_definer', 'app.messages', 'UPDATE'
     )
     OR pg_catalog.has_table_privilege(
       'r72_test_inbox_webhook_definer', 'app.provider_connections', 'INSERT'
     )
     OR pg_catalog.has_table_privilege(
       'r72_web', 'app.test_inbox_webhook_receipts', 'SELECT'
     )
     OR pg_catalog.has_table_privilege(
       'r72_worker', 'app.test_inbox_webhook_receipts', 'SELECT'
     )
     OR pg_catalog.has_function_privilege(
       'r72_web', recorder_oid, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'r72_web', binding_oid, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'r72_test_inbox_webhook_command', provenance_oid, 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'Test inbox webhook capability is broader than required';
  END IF;
END
$capability_audit$;
