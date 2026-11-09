-- Exact approved company-content -> live owned-seed message bridge.
--
-- This capability is deliberately table blind. Its LOGIN role can execute
-- three bounded commands, one bounded resume snapshot and a readiness probe,
-- but cannot inspect any app table. The commands accept no recipient,
-- provider, subject or body: those
-- values are resolved from one exact, current, human-approved company-content
-- email version and the fixed Property Predator owned seed.

DO $roles$
DECLARE
  unsafe_membership text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'r72_owned_seed_message_definer') THEN
    CREATE ROLE r72_owned_seed_message_definer NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'r72_owned_seed_message_command') THEN
    CREATE ROLE r72_owned_seed_message_command LOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'r72_owned_seed_message_definer'
      AND NOT rolcanlogin AND NOT rolinherit AND NOT rolsuper
      AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'r72_owned_seed_message_command'
      AND rolcanlogin AND NOT rolinherit AND NOT rolsuper
      AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls
  ) THEN
    RAISE EXCEPTION 'Unsafe owned-seed message role attributes';
  END IF;

  REVOKE r72_owner, r72_security_definer, r72_mailgun_worker_definer,
    r72_owned_seed_message_definer FROM r72_owned_seed_message_command;
  REVOKE r72_owner, r72_security_definer, r72_mailgun_worker_definer
    FROM r72_owned_seed_message_definer;

  SELECT parent.rolname INTO unsafe_membership
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
  JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
  WHERE member.rolname = 'r72_owned_seed_message_command'
  LIMIT 1;
  IF unsafe_membership IS NOT NULL THEN
    RAISE EXCEPTION 'Unsafe owned-seed message command membership: %', unsafe_membership;
  END IF;

  GRANT r72_owned_seed_message_definer TO r72_owner;
  EXECUTE format('GRANT r72_owned_seed_message_command TO %I', current_user);
END
$roles$;

SET LOCAL ROLE r72_owner;

REVOKE ALL ON SCHEMA app, app_private
  FROM r72_owned_seed_message_definer, r72_owned_seed_message_command;
REVOKE ALL ON ALL TABLES IN SCHEMA app
  FROM r72_owned_seed_message_definer, r72_owned_seed_message_command;
REVOKE ALL ON ALL TABLES IN SCHEMA app_private
  FROM r72_owned_seed_message_definer, r72_owned_seed_message_command;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app_private
  FROM r72_owned_seed_message_definer, r72_owned_seed_message_command;
REVOKE CREATE ON SCHEMA public
  FROM r72_owned_seed_message_definer, r72_owned_seed_message_command;

CREATE TABLE app_private.property_predator_owned_seed_message_commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL,
  operation text NOT NULL CHECK (operation IN ('create_draft', 'request_approval', 'decide_approval')),
  command_key text NOT NULL CHECK (
    command_key = btrim(command_key)
    AND command_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  request_sha256 bytea NOT NULL CHECK (octet_length(request_sha256) = 32),
  company_content_version_id uuid,
  company_content_approval_decision_id uuid,
  message_id uuid NOT NULL,
  message_version_id uuid NOT NULL,
  message_approval_request_id uuid,
  message_approval_decision_id uuid,
  decision text CHECK (decision IS NULL OR decision IN ('approved', 'rejected', 'changes_requested')),
  subject_sha256 bytea NOT NULL CHECK (octet_length(subject_sha256) = 32),
  body_sha256 bytea NOT NULL CHECK (octet_length(body_sha256) = 32),
  source_content_sha256 bytea NOT NULL CHECK (octet_length(source_content_sha256) = 32),
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, actor_user_id, operation, command_key),
  UNIQUE (workspace_id, company_content_version_id),
  FOREIGN KEY (workspace_id, actor_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, company_content_version_id)
    REFERENCES app.company_content_versions (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, company_content_approval_decision_id)
    REFERENCES app.company_content_approval_decisions (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, message_id)
    REFERENCES app.messages (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, message_version_id)
    REFERENCES app.message_versions (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, message_approval_request_id)
    REFERENCES app.message_approval_requests (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, message_approval_decision_id)
    REFERENCES app.message_approval_decisions (workspace_id, id) ON DELETE RESTRICT,
  CHECK ((operation = 'create_draft') = (company_content_version_id IS NOT NULL)),
  CHECK ((operation IN ('request_approval', 'decide_approval')) = (message_approval_request_id IS NOT NULL)),
  CHECK ((operation = 'decide_approval') = (message_approval_decision_id IS NOT NULL)),
  CHECK ((operation = 'decide_approval') = (decision IS NOT NULL))
);

CREATE FUNCTION app_private.reject_property_predator_owned_seed_message_command_mutation()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $function$
BEGIN
  RAISE EXCEPTION 'Property Predator owned-seed message command evidence is append-only'
    USING ERRCODE = '55000';
END
$function$;

-- This trigger is the immutable-ledger boundary, not an application-callable
-- capability. PostgreSQL can invoke it through the trigger after PUBLIC loses
-- EXECUTE, while even r72_owner remains unable to rewrite command evidence.
REVOKE ALL ON FUNCTION
  app_private.reject_property_predator_owned_seed_message_command_mutation()
  FROM PUBLIC;

CREATE TRIGGER property_predator_owned_seed_message_commands_append_only
  BEFORE UPDATE OR DELETE
  ON app_private.property_predator_owned_seed_message_commands
  FOR EACH ROW EXECUTE FUNCTION
    app_private.reject_property_predator_owned_seed_message_command_mutation();

ALTER TABLE app_private.property_predator_owned_seed_message_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.property_predator_owned_seed_message_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY owned_seed_message_commands_owner_all
  ON app_private.property_predator_owned_seed_message_commands FOR ALL TO r72_owner
  USING (true) WITH CHECK (true);
CREATE POLICY owned_seed_message_commands_definer_all
  ON app_private.property_predator_owned_seed_message_commands FOR ALL
  TO r72_owned_seed_message_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

-- The no-login definer can see and change only the rows required by these
-- three commands. Every policy remains workspace- and active-manager-scoped.
DO $policies$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'company_content_items', 'company_content_versions',
    'company_content_source_attestations',
    'company_content_approval_requests', 'company_content_approval_decisions',
    'provider_connections', 'property_predator_email_pilot_seed_events',
    'contacts', 'contact_points', 'communication_consent_events',
    'channel_endpoints', 'inboxes', 'conversations', 'messages',
    'message_versions', 'message_approval_requests', 'message_approval_decisions',
    'property_predator_mailgun_jobs'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY %I ON app.%I FOR SELECT TO r72_owned_seed_message_definer USING (
         workspace_id = nullif(current_setting(''app.workspace_id'', true), '''')::uuid
         AND EXISTS (
           SELECT 1 FROM app.workspace_memberships AS membership
           WHERE membership.workspace_id = nullif(current_setting(''app.workspace_id'', true), '''')::uuid
             AND membership.user_id = nullif(current_setting(''app.user_id'', true), '''')::uuid
             AND membership.status = ''active'' AND membership.role IN (''owner'', ''admin'')
         )
       )', 'owned_seed_message_' || table_name || '_select', table_name
    );
  END LOOP;

  FOREACH table_name IN ARRAY ARRAY[
    'contacts', 'contact_points', 'communication_consent_events',
    'channel_endpoints', 'inboxes', 'conversations', 'messages',
    'message_versions', 'message_approval_requests', 'message_approval_decisions'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY %I ON app.%I FOR INSERT TO r72_owned_seed_message_definer WITH CHECK (
         workspace_id = nullif(current_setting(''app.workspace_id'', true), '''')::uuid
         AND EXISTS (
           SELECT 1 FROM app.workspace_memberships AS membership
           WHERE membership.workspace_id = nullif(current_setting(''app.workspace_id'', true), '''')::uuid
             AND membership.user_id = nullif(current_setting(''app.user_id'', true), '''')::uuid
             AND membership.status = ''active'' AND membership.role IN (''owner'', ''admin'')
         )
       )', 'owned_seed_message_' || table_name || '_insert', table_name
    );
  END LOOP;
END
$policies$;

CREATE POLICY owned_seed_message_workspace_memberships_select
  ON app.workspace_memberships FOR SELECT TO r72_owned_seed_message_definer
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND user_id = nullif(current_setting('app.user_id', true), '')::uuid
    AND status = 'active' AND role IN ('owner', 'admin')
  );

CREATE POLICY owned_seed_message_conversations_update
  ON app.conversations FOR UPDATE TO r72_owned_seed_message_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND channel = 'email' AND environment = 'live')
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND channel = 'email' AND environment = 'live');
CREATE POLICY owned_seed_message_messages_update
  ON app.messages FOR UPDATE TO r72_owned_seed_message_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND channel = 'email' AND environment = 'live')
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND channel = 'email' AND environment = 'live');

GRANT USAGE ON SCHEMA app, app_private TO r72_owned_seed_message_definer;
GRANT SELECT ON app.workspace_memberships, app.company_content_items,
  app.company_content_versions, app.company_content_source_attestations,
  app.company_content_approval_requests,
  app.company_content_approval_decisions, app.provider_connections,
  app.property_predator_email_pilot_seed_events, app.contacts,
  app.contact_points, app.communication_consent_events, app.channel_endpoints,
  app.inboxes, app.conversations, app.messages, app.message_versions,
  app.message_approval_requests, app.message_approval_decisions,
  app.property_predator_mailgun_jobs
  TO r72_owned_seed_message_definer;
GRANT INSERT ON app.contacts, app.contact_points, app.communication_consent_events,
  app.channel_endpoints, app.inboxes, app.conversations, app.messages,
  app.message_versions, app.message_approval_requests,
  app.message_approval_decisions TO r72_owned_seed_message_definer;
GRANT UPDATE (state, row_version, updated_at) ON app.conversations
  TO r72_owned_seed_message_definer;
GRANT UPDATE (lifecycle, row_version, updated_at) ON app.messages
  TO r72_owned_seed_message_definer;
GRANT SELECT, INSERT ON app_private.property_predator_owned_seed_message_commands
  TO r72_owned_seed_message_definer;
GRANT EXECUTE ON FUNCTION app_private.current_workspace_id(),
  app_private.current_user_id(), app_private.current_actor_kind(),
  app_private.current_request_id() TO r72_owned_seed_message_definer;

GRANT CREATE ON SCHEMA app_private TO r72_owned_seed_message_definer;
SET LOCAL ROLE r72_owned_seed_message_definer;

CREATE FUNCTION app_private.create_property_predator_owned_seed_message_draft(
  p_workspace_id uuid, p_company_content_version_id uuid, p_command_key text
) RETURNS TABLE (
  disposition text, message_id uuid, message_version_id uuid,
  company_content_version_id uuid, company_content_approval_decision_id uuid,
  subject_sha256 bytea, body_sha256 bytea, source_content_sha256 bytea
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  actor_id uuid;
  request_hash bytea;
  prior app_private.property_predator_owned_seed_message_commands%ROWTYPE;
  payload jsonb;
  selected_canonical_content text;
  selected_canonical_payload text;
  payload_keys integer;
  selected_subject text;
  selected_body text;
  selected_source_sha bytea;
  selected_content_item_id uuid;
  selected_content_decision_id uuid;
  selected_connection_id uuid;
  selected_endpoint_id uuid;
  selected_inbox_id uuid;
  selected_contact_id uuid;
  selected_contact_point_id uuid;
  selected_conversation_id uuid;
  selected_consent_id uuid;
  selected_consent_state text;
  selected_message_id uuid := gen_random_uuid();
  selected_message_version_id uuid := gen_random_uuid();
  selected_subject_sha bytea;
  selected_body_sha bytea;
BEGIN
  actor_id := nullif(current_setting('app.user_id', true), '')::uuid;
  IF session_user <> 'r72_owned_seed_message_command'
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'user'
     OR actor_id IS NULL OR coalesce(current_setting('app.request_id', true), '') = ''
     OR NOT EXISTS (
       SELECT 1 FROM app.workspace_memberships AS membership
       WHERE membership.workspace_id = p_workspace_id AND membership.user_id = actor_id
         AND membership.status = 'active' AND membership.role IN ('owner', 'admin')
     ) THEN
    RAISE EXCEPTION 'Owned-seed message command context denied' USING ERRCODE = '42501';
  END IF;
  IF p_workspace_id IS NULL OR p_company_content_version_id IS NULL
     OR p_command_key IS NULL OR p_command_key <> btrim(p_command_key)
     OR p_command_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN
    RAISE EXCEPTION 'Owned-seed message draft input is invalid' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_workspace_id::text || ':owned-seed-live-message', 0));
  request_hash := public.digest(pg_catalog.convert_to(
    'create_draft' || pg_catalog.chr(31) || p_company_content_version_id::text,
    'UTF8'), 'sha256');
  SELECT command.* INTO prior
  FROM app_private.property_predator_owned_seed_message_commands AS command
  WHERE command.workspace_id = p_workspace_id AND command.actor_user_id = actor_id
    AND command.operation = 'create_draft' AND command.command_key = p_command_key;
  IF FOUND THEN
    IF prior.request_sha256 IS DISTINCT FROM request_hash THEN
      RAISE EXCEPTION 'Owned-seed message command idempotency conflict' USING ERRCODE = '22000';
    END IF;
    RETURN QUERY SELECT 'replayed', prior.message_id, prior.message_version_id,
      prior.company_content_version_id, prior.company_content_approval_decision_id,
      prior.subject_sha256, prior.body_sha256, prior.source_content_sha256;
    RETURN;
  END IF;

  -- One immutable company-content version maps to one owned-seed message,
  -- regardless of browser tab, actor or caller-generated command key.
  SELECT command.* INTO prior
  FROM app_private.property_predator_owned_seed_message_commands AS command
  WHERE command.workspace_id = p_workspace_id
    AND command.operation = 'create_draft'
    AND command.company_content_version_id = p_company_content_version_id;
  IF FOUND THEN
    RETURN QUERY SELECT 'replayed', prior.message_id,
      prior.message_version_id, prior.company_content_version_id,
      prior.company_content_approval_decision_id, prior.subject_sha256,
      prior.body_sha256, prior.source_content_sha256;
    RETURN;
  END IF;

  SELECT version.content_item_id INTO selected_content_item_id
  FROM app.company_content_versions AS version
  WHERE version.workspace_id = p_workspace_id
    AND version.id = p_company_content_version_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Company-content email version does not exist' USING ERRCODE = '40001';
  END IF;
  -- Serialize with 0021's immutable version/approval commands. This prevents a
  -- newer source version appearing between the currentness check and message
  -- creation.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'company-content:' || p_workspace_id::text || ':' || selected_content_item_id::text,
    7200021));

  SELECT version.content_body::jsonb, version.content_body,
         version.content_sha256, decision.id
    INTO payload, selected_canonical_content,
         selected_source_sha, selected_content_decision_id
  FROM app.company_content_versions AS version
  JOIN app.company_content_source_attestations AS source_attestation
    ON source_attestation.workspace_id = version.workspace_id
   AND source_attestation.content_item_id = version.content_item_id
   AND source_attestation.content_version_id = version.id
   AND source_attestation.source_system = version.source_system
   AND source_attestation.source_item_id = version.source_item_id
   AND source_attestation.source_version = version.source_version
   AND source_attestation.content_sha256 = version.content_sha256
   AND source_attestation.blob_sha256 = version.blob_sha256
   AND source_attestation.brand_sha256 = version.brand_sha256
   AND source_attestation.id = (
     SELECT latest.id
     FROM app.company_content_source_attestations AS latest
     WHERE latest.workspace_id = version.workspace_id
       AND latest.content_item_id = version.content_item_id
       AND latest.content_version_id = version.id
     ORDER BY latest.checked_at DESC, latest.id DESC LIMIT 1
   )
   AND source_attestation.checked_at <= statement_timestamp()
   AND source_attestation.expires_at > statement_timestamp()
  JOIN app.company_content_approval_requests AS request
    ON request.workspace_id = version.workspace_id
   AND request.content_item_id = version.content_item_id
   AND request.content_version_id = version.id
   AND request.content_sha256 = version.content_sha256
   AND request.id = (
     SELECT latest.id FROM app.company_content_approval_requests AS latest
     WHERE latest.workspace_id = version.workspace_id
       AND latest.content_item_id = version.content_item_id
       AND latest.content_version_id = version.id
     ORDER BY latest.request_number DESC, latest.id DESC LIMIT 1
   )
  JOIN app.company_content_approval_decisions AS decision
    ON decision.workspace_id = request.workspace_id
   AND decision.approval_request_id = request.id
   AND decision.content_version_id = version.id
   AND decision.content_sha256 = version.content_sha256
   AND decision.decision = 'approved'
  WHERE version.workspace_id = p_workspace_id
    AND version.id = p_company_content_version_id
    AND version.content_kind = 'email'
    AND version.content_mime_type = 'application/vnd.propertypredator.email-draft+json'
    AND NOT EXISTS (
      SELECT 1 FROM app.company_content_versions AS newer
      WHERE newer.workspace_id = version.workspace_id
        AND newer.content_item_id = version.content_item_id
        AND newer.version_number > version.version_number
    );
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Company-content email approval is missing or stale' USING ERRCODE = '42501';
  END IF;
  SELECT count(*)::integer INTO payload_keys FROM pg_catalog.jsonb_object_keys(payload);
  IF pg_catalog.jsonb_typeof(payload) <> 'object' OR payload_keys <> 3
     OR payload->>'schema' IS DISTINCT FROM 'propertypredator.email-draft/v1'
     OR pg_catalog.jsonb_typeof(payload->'subject') <> 'string'
     OR pg_catalog.jsonb_typeof(payload->'bodyText') <> 'string' THEN
    RAISE EXCEPTION 'Approved company-content email payload is not canonical' USING ERRCODE = '22023';
  END IF;
  selected_subject := payload->>'subject';
  selected_body := payload->>'bodyText';
  selected_canonical_payload := '{"bodyText":'
    || pg_catalog.to_json(selected_body)::text
    || ',"schema":"propertypredator.email-draft/v1","subject":'
    || pg_catalog.to_json(selected_subject)::text || '}';
  IF selected_canonical_content IS DISTINCT FROM selected_canonical_payload
     OR selected_source_sha IS DISTINCT FROM public.digest(
       pg_catalog.convert_to(selected_canonical_content, 'UTF8'), 'sha256'
     ) THEN
    RAISE EXCEPTION 'Approved company-content email bytes are not canonical'
      USING ERRCODE = '22023';
  END IF;
  IF selected_subject <> btrim(selected_subject)
     OR length(selected_subject) NOT BETWEEN 1 AND 500
     OR selected_subject ~ '[[:cntrl:]]'
     OR octet_length(selected_body) NOT BETWEEN 1 AND 65536
     OR length(btrim(selected_body)) < 1
     OR EXISTS (
       SELECT 1 FROM pg_catalog.unnest(ARRAY[8234,8235,8236,8237,8238,8294,8295,8296,8297]) AS code
       WHERE pg_catalog.strpos(selected_body, pg_catalog.chr(code)) > 0
     ) THEN
    RAISE EXCEPTION 'Approved company-content email is unsafe for a message version' USING ERRCODE = '22023';
  END IF;
  selected_subject_sha := public.digest(selected_subject, 'sha256');
  selected_body_sha := public.digest(selected_body, 'sha256');

  IF NOT EXISTS (
    SELECT 1 FROM app.property_predator_email_pilot_seed_events AS seed
    WHERE seed.workspace_id = p_workspace_id
      AND seed.email_sha256 = public.digest('office@propertypredator.com', 'sha256')
      AND seed.state = 'owned'
      AND seed.id = (
        SELECT latest.id FROM app.property_predator_email_pilot_seed_events AS latest
        WHERE latest.workspace_id = seed.workspace_id AND latest.email_sha256 = seed.email_sha256
        ORDER BY latest.occurred_at DESC, latest.recorded_at DESC, latest.id DESC LIMIT 1
      )
  ) THEN
    RAISE EXCEPTION 'Owned office seed attestation is not current' USING ERRCODE = '42501';
  END IF;
  SELECT connection.id INTO STRICT selected_connection_id
  FROM app.provider_connections AS connection
  WHERE connection.workspace_id = p_workspace_id AND connection.provider_id = 'mailgun_eu'
    AND connection.provider_kind = 'email' AND connection.environment = 'live'
    AND connection.status = 'active';

  SELECT endpoint.id INTO selected_endpoint_id
  FROM app.channel_endpoints AS endpoint
  WHERE endpoint.workspace_id = p_workspace_id
    AND endpoint.provider_connection_id = selected_connection_id
    AND endpoint.channel = 'email' AND endpoint.environment = 'live'
    AND endpoint.normalized_address = 'mg.propertypredator.com'
    AND endpoint.status <> 'disabled';
  IF FOUND AND NOT EXISTS (
    SELECT 1 FROM app.channel_endpoints AS endpoint
    WHERE endpoint.workspace_id = p_workspace_id AND endpoint.id = selected_endpoint_id
      AND endpoint.status = 'active' AND endpoint.direction IN ('outbound', 'bidirectional')
  ) THEN
    RAISE EXCEPTION 'Existing Mailgun endpoint is not active outbound' USING ERRCODE = '42501';
  ELSIF NOT FOUND THEN
    selected_endpoint_id := gen_random_uuid();
    INSERT INTO app.channel_endpoints (
      id, workspace_id, provider_connection_id, channel, environment, direction,
      address, normalized_address, display_name, status
    ) VALUES (
      selected_endpoint_id, p_workspace_id, selected_connection_id, 'email', 'live',
      'outbound', 'mg.propertypredator.com', 'mg.propertypredator.com',
      'Property Predator Mailgun EU', 'active'
    );
  END IF;

  SELECT inbox.id INTO selected_inbox_id FROM app.inboxes AS inbox
  WHERE inbox.workspace_id = p_workspace_id AND inbox.channel_endpoint_id = selected_endpoint_id;
  IF FOUND AND NOT EXISTS (
    SELECT 1 FROM app.inboxes AS inbox WHERE inbox.workspace_id = p_workspace_id
      AND inbox.id = selected_inbox_id AND inbox.provider_connection_id = selected_connection_id
      AND inbox.channel = 'email' AND inbox.environment = 'live' AND inbox.status = 'active'
  ) THEN
    RAISE EXCEPTION 'Existing Mailgun inbox is not active live email' USING ERRCODE = '42501';
  ELSIF NOT FOUND THEN
    selected_inbox_id := gen_random_uuid();
    INSERT INTO app.inboxes (
      id, workspace_id, channel_endpoint_id, provider_connection_id,
      channel, environment, name, status
    ) VALUES (
      selected_inbox_id, p_workspace_id, selected_endpoint_id, selected_connection_id,
      'email', 'live', 'Property Predator owned seed', 'active'
    );
  END IF;

  SELECT point.contact_id, point.id INTO selected_contact_id, selected_contact_point_id
  FROM app.contact_points AS point
  JOIN app.contacts AS contact ON contact.workspace_id = point.workspace_id AND contact.id = point.contact_id
  WHERE point.workspace_id = p_workspace_id AND point.kind = 'email'
    AND lower(point.normalized_value) = 'office@propertypredator.com' AND point.deleted_at IS NULL;
  IF FOUND AND NOT EXISTS (
    SELECT 1 FROM app.contacts AS contact
    JOIN app.contact_points AS point ON point.workspace_id = contact.workspace_id AND point.contact_id = contact.id
    WHERE contact.workspace_id = p_workspace_id AND contact.id = selected_contact_id
      AND contact.source IN ('property_predator_owned_seed', 'internal_seed')
      AND contact.deleted_at IS NULL
      AND contact.lifecycle_status <> 'archived' AND point.id = selected_contact_point_id
      AND point.is_verified AND point.is_primary AND point.dedupe_state = 'normal'
      AND point.consent_status <> 'opted_out'
  ) THEN
    RAISE EXCEPTION 'Office mailbox is already bound outside the owned-seed identity' USING ERRCODE = '42501';
  ELSIF NOT FOUND THEN
    selected_contact_id := gen_random_uuid();
    selected_contact_point_id := gen_random_uuid();
    INSERT INTO app.contacts (
      id, workspace_id, display_name, lifecycle_status, owner_user_id, source, custom_fields
    ) VALUES (
      selected_contact_id, p_workspace_id, 'Property Predator office seed', 'lead', actor_id,
      'property_predator_owned_seed', '{"internalOwnedSeed":true}'::jsonb
    );
    INSERT INTO app.contact_points (
      id, workspace_id, contact_id, kind, label, value, normalized_value,
      is_primary, is_verified, dedupe_state, consent_status
    ) VALUES (
      selected_contact_point_id, p_workspace_id, selected_contact_id, 'email',
      'Owned internal seed', 'office@propertypredator.com', 'office@propertypredator.com',
      true, true, 'normal', 'opted_in'
    );
  END IF;

  SELECT consent.id, consent.state INTO selected_consent_id, selected_consent_state
  FROM app.communication_consent_events AS consent
  WHERE consent.workspace_id = p_workspace_id AND consent.contact_id = selected_contact_id
    AND consent.contact_point_id = selected_contact_point_id
    AND consent.channel = 'email' AND consent.purpose = 'marketing'
  ORDER BY consent.occurred_at DESC, consent.recorded_at DESC, consent.id DESC LIMIT 1;
  IF FOUND AND selected_consent_state <> 'granted' THEN
    RAISE EXCEPTION 'Owned seed email consent was explicitly denied or withdrawn' USING ERRCODE = '42501';
  ELSIF NOT FOUND THEN
    selected_consent_id := gen_random_uuid();
    INSERT INTO app.communication_consent_events (
      id, workspace_id, contact_id, contact_point_id, channel, purpose, state,
      lawful_basis, source, policy_version, source_event_id, actor_kind,
      actor_user_id, evidence, endpoint_identity_sha256, occurred_at
    ) VALUES (
      selected_consent_id, p_workspace_id, selected_contact_id, selected_contact_point_id,
      'email', 'marketing', 'granted', 'consent', 'propertypredator.owned_seed',
      'owned-seed-v1', 'owned-seed:' || selected_contact_point_id::text,
      'user', actor_id, '{"ownedInternalSeed":true}'::jsonb,
      decode(repeat('00', 32), 'hex'), statement_timestamp()
    );
  END IF;

  SELECT conversation.id INTO selected_conversation_id
  FROM app.conversations AS conversation
  WHERE conversation.workspace_id = p_workspace_id AND conversation.inbox_id = selected_inbox_id
    AND conversation.contact_id = selected_contact_id AND conversation.state IN ('open', 'snoozed')
  LIMIT 1;
  IF FOUND AND NOT EXISTS (
    SELECT 1 FROM app.conversations AS conversation
    WHERE conversation.workspace_id = p_workspace_id AND conversation.id = selected_conversation_id
      AND conversation.subject = selected_subject
  ) THEN
    UPDATE app.conversations SET state = 'closed', row_version = row_version + 1,
      updated_at = statement_timestamp()
    WHERE workspace_id = p_workspace_id AND id = selected_conversation_id;
    selected_conversation_id := NULL;
  END IF;
  IF selected_conversation_id IS NULL THEN
    selected_conversation_id := gen_random_uuid();
    INSERT INTO app.conversations (
      id, workspace_id, inbox_id, channel, environment, contact_id, state, subject
    ) VALUES (
      selected_conversation_id, p_workspace_id, selected_inbox_id,
      'email', 'live', selected_contact_id, 'open', selected_subject
    );
  END IF;

  INSERT INTO app.messages (
    id, workspace_id, conversation_id, contact_id, contact_point_id,
    channel, environment, direction, lifecycle, source_kind,
    current_version_id, current_version_number, current_body_sha256,
    created_by_actor_kind, created_by_user_id, occurred_at
  ) VALUES (
    selected_message_id, p_workspace_id, selected_conversation_id,
    selected_contact_id, selected_contact_point_id, 'email', 'live',
    'outbound', 'draft', 'automation', selected_message_version_id, 1,
    selected_body_sha, 'user', actor_id, statement_timestamp()
  );
  INSERT INTO app.message_versions (
    id, workspace_id, conversation_id, message_id, channel, environment,
    version_number, body_text, source_content_version_ref,
    source_content_sha256, source_content_approval_ref,
    created_by_actor_kind, created_by_user_id, created_request_id
  ) VALUES (
    selected_message_version_id, p_workspace_id, selected_conversation_id,
    selected_message_id, 'email', 'live', 1, selected_body,
    'app.company_content_versions:' || p_company_content_version_id::text,
    selected_source_sha,
    'app.company_content_approval_decisions:' || selected_content_decision_id::text,
    'user', actor_id, current_setting('app.request_id')
  );
  INSERT INTO app_private.property_predator_owned_seed_message_commands (
    workspace_id, actor_user_id, operation, command_key, request_sha256,
    company_content_version_id, company_content_approval_decision_id,
    message_id, message_version_id, subject_sha256, body_sha256, source_content_sha256
  ) VALUES (
    p_workspace_id, actor_id, 'create_draft', p_command_key, request_hash,
    p_company_content_version_id, selected_content_decision_id,
    selected_message_id, selected_message_version_id,
    selected_subject_sha, selected_body_sha, selected_source_sha
  );
  RETURN QUERY SELECT 'created', selected_message_id, selected_message_version_id,
    p_company_content_version_id, selected_content_decision_id,
    selected_subject_sha, selected_body_sha, selected_source_sha;
END
$function$;

CREATE FUNCTION app_private.request_property_predator_owned_seed_message_approval(
  p_workspace_id uuid, p_message_id uuid, p_command_key text, p_review_note text
) RETURNS TABLE (
  disposition text, message_id uuid, message_version_id uuid,
  approval_request_id uuid, subject_sha256 bytea, body_sha256 bytea,
  source_content_sha256 bytea
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  actor_id uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  request_hash bytea;
  prior app_private.property_predator_owned_seed_message_commands%ROWTYPE;
  selected_version_id uuid;
  selected_body_sha bytea;
  selected_subject_sha bytea;
  selected_source_sha bytea;
  selected_content_item_id uuid;
  selected_request_id uuid := gen_random_uuid();
  selected_request_number integer;
BEGIN
  IF session_user <> 'r72_owned_seed_message_command'
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'user'
     OR actor_id IS NULL OR coalesce(current_setting('app.request_id', true), '') = ''
     OR NOT EXISTS (SELECT 1 FROM app.workspace_memberships AS membership
       WHERE membership.workspace_id = p_workspace_id AND membership.user_id = actor_id
         AND membership.status = 'active' AND membership.role IN ('owner', 'admin')) THEN
    RAISE EXCEPTION 'Owned-seed message command context denied' USING ERRCODE = '42501';
  END IF;
  IF p_message_id IS NULL OR p_command_key IS NULL OR p_command_key <> btrim(p_command_key)
     OR p_command_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
     OR (p_review_note IS NOT NULL AND (p_review_note <> btrim(p_review_note)
       OR length(p_review_note) NOT BETWEEN 1 AND 2000)) THEN
    RAISE EXCEPTION 'Owned-seed approval request input is invalid' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_workspace_id::text || ':owned-seed-live-message', 0));
  request_hash := public.digest(pg_catalog.convert_to(
    'request_approval' || chr(31) || p_message_id::text || chr(31)
      || coalesce(p_review_note, ''), 'UTF8'), 'sha256');
  SELECT command.* INTO prior FROM app_private.property_predator_owned_seed_message_commands AS command
  WHERE command.workspace_id = p_workspace_id AND command.actor_user_id = actor_id
    AND command.operation = 'request_approval' AND command.command_key = p_command_key;
  IF FOUND THEN
    IF prior.request_sha256 IS DISTINCT FROM request_hash THEN
      RAISE EXCEPTION 'Owned-seed message command idempotency conflict' USING ERRCODE = '22000';
    END IF;
    RETURN QUERY SELECT 'replayed', prior.message_id, prior.message_version_id,
      prior.message_approval_request_id, prior.subject_sha256,
      prior.body_sha256, prior.source_content_sha256;
    RETURN;
  END IF;

  SELECT source_version.content_item_id INTO selected_content_item_id
  FROM app.messages AS message
  JOIN app.message_versions AS version
    ON version.workspace_id = message.workspace_id
   AND version.id = message.current_version_id
   AND version.message_id = message.id
  JOIN app.company_content_versions AS source_version
    ON source_version.workspace_id = version.workspace_id
   AND version.source_content_version_ref
     = 'app.company_content_versions:' || source_version.id::text
   AND version.source_content_sha256 = source_version.content_sha256
  WHERE message.workspace_id = p_workspace_id AND message.id = p_message_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Owned-seed message source evidence is unavailable' USING ERRCODE = '40001';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'company-content:' || p_workspace_id::text || ':' || selected_content_item_id::text,
    7200021));

  SELECT message.current_version_id, message.current_body_sha256,
         public.digest(conversation.subject, 'sha256'), version.source_content_sha256
    INTO selected_version_id, selected_body_sha, selected_subject_sha, selected_source_sha
  FROM app.messages AS message
  JOIN app.message_versions AS version ON version.workspace_id = message.workspace_id
    AND version.id = message.current_version_id AND version.message_id = message.id
    AND version.body_sha256 = message.current_body_sha256
  JOIN app.company_content_versions AS source_version
    ON source_version.workspace_id = version.workspace_id
   AND version.source_content_version_ref
     = 'app.company_content_versions:' || source_version.id::text
   AND version.source_content_sha256 = source_version.content_sha256
   AND source_version.content_kind = 'email'
   AND source_version.content_mime_type
     = 'application/vnd.propertypredator.email-draft+json'
  JOIN app.company_content_source_attestations AS source_attestation
    ON source_attestation.workspace_id = source_version.workspace_id
   AND source_attestation.content_item_id = source_version.content_item_id
   AND source_attestation.content_version_id = source_version.id
   AND source_attestation.source_system = source_version.source_system
   AND source_attestation.source_item_id = source_version.source_item_id
   AND source_attestation.source_version = source_version.source_version
   AND source_attestation.content_sha256 = source_version.content_sha256
   AND source_attestation.blob_sha256 = source_version.blob_sha256
   AND source_attestation.brand_sha256 = source_version.brand_sha256
   AND source_attestation.id = (
     SELECT latest.id
     FROM app.company_content_source_attestations AS latest
     WHERE latest.workspace_id = source_version.workspace_id
       AND latest.content_item_id = source_version.content_item_id
       AND latest.content_version_id = source_version.id
     ORDER BY latest.checked_at DESC, latest.id DESC LIMIT 1
   )
   AND source_attestation.checked_at <= statement_timestamp()
   AND source_attestation.expires_at > statement_timestamp()
  JOIN app.company_content_approval_requests AS source_request
    ON source_request.workspace_id = source_version.workspace_id
   AND source_request.content_item_id = source_version.content_item_id
   AND source_request.content_version_id = source_version.id
   AND source_request.content_sha256 = source_version.content_sha256
   AND source_request.id = (
     SELECT latest.id FROM app.company_content_approval_requests AS latest
     WHERE latest.workspace_id = source_version.workspace_id
       AND latest.content_item_id = source_version.content_item_id
       AND latest.content_version_id = source_version.id
     ORDER BY latest.request_number DESC, latest.id DESC LIMIT 1
   )
  JOIN app.company_content_approval_decisions AS source_decision
    ON source_decision.workspace_id = source_request.workspace_id
   AND source_decision.approval_request_id = source_request.id
   AND source_decision.content_version_id = source_version.id
   AND source_decision.content_sha256 = source_version.content_sha256
   AND source_decision.decision = 'approved'
   AND version.source_content_approval_ref
     = 'app.company_content_approval_decisions:' || source_decision.id::text
  JOIN app.conversations AS conversation ON conversation.workspace_id = message.workspace_id
    AND conversation.id = message.conversation_id AND conversation.subject IS NOT NULL
  JOIN app.contact_points AS point ON point.workspace_id = message.workspace_id
    AND point.id = message.contact_point_id AND point.contact_id = message.contact_id
  WHERE message.workspace_id = p_workspace_id AND message.id = p_message_id
    AND message.channel = 'email' AND message.environment = 'live'
    AND message.direction = 'outbound' AND message.lifecycle = 'draft'
    AND lower(point.normalized_value) = 'office@propertypredator.com'
    AND source_version.content_sha256 = public.digest(
      pg_catalog.convert_to(source_version.content_body, 'UTF8'), 'sha256'
    )
    AND source_version.content_body = '{"bodyText":'
      || pg_catalog.to_json(version.body_text)::text
      || ',"schema":"propertypredator.email-draft/v1","subject":'
      || pg_catalog.to_json(conversation.subject)::text || '}'
    AND EXISTS (
      SELECT 1
      FROM app_private.property_predator_owned_seed_message_commands AS created
      WHERE created.workspace_id = message.workspace_id
        AND created.operation = 'create_draft'
        AND created.company_content_version_id = source_version.id
        AND created.message_id = message.id
        AND created.message_version_id = version.id
        AND created.company_content_approval_decision_id = source_decision.id
        AND created.subject_sha256
          = public.digest(conversation.subject, 'sha256')
        AND created.body_sha256 = version.body_sha256
        AND created.source_content_sha256 = source_version.content_sha256
    )
    AND NOT EXISTS (
      SELECT 1 FROM app.company_content_versions AS newer
      WHERE newer.workspace_id = source_version.workspace_id
        AND newer.content_item_id = source_version.content_item_id
        AND newer.version_number > source_version.version_number
    );
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Owned-seed message is not an exact current draft' USING ERRCODE = '40001';
  END IF;
  IF EXISTS (
    SELECT 1 FROM app.message_approval_requests AS request
    LEFT JOIN app.message_approval_decisions AS decision
      ON decision.workspace_id = request.workspace_id AND decision.approval_request_id = request.id
    WHERE request.workspace_id = p_workspace_id AND request.message_id = p_message_id
      AND request.message_version_id = selected_version_id AND decision.id IS NULL
  ) THEN
    RAISE EXCEPTION 'Owned-seed message already has a pending approval' USING ERRCODE = '23505';
  END IF;
  SELECT coalesce(max(request.request_number), 0) + 1 INTO selected_request_number
  FROM app.message_approval_requests AS request
  WHERE request.workspace_id = p_workspace_id AND request.message_id = p_message_id
    AND request.message_version_id = selected_version_id;
  INSERT INTO app.message_approval_requests (
    id, workspace_id, conversation_id, message_id, message_version_id,
    version_number, body_sha256, request_number, review_note,
    requested_by_user_id, requested_request_id
  ) SELECT selected_request_id, message.workspace_id, message.conversation_id,
    message.id, message.current_version_id, message.current_version_number,
    message.current_body_sha256, selected_request_number, p_review_note,
    actor_id, current_setting('app.request_id')
  FROM app.messages AS message WHERE message.workspace_id = p_workspace_id AND message.id = p_message_id;
  UPDATE app.messages SET lifecycle = 'approval_pending', row_version = row_version + 1,
    updated_at = statement_timestamp()
  WHERE workspace_id = p_workspace_id AND id = p_message_id;
  INSERT INTO app_private.property_predator_owned_seed_message_commands (
    workspace_id, actor_user_id, operation, command_key, request_sha256,
    message_id, message_version_id, message_approval_request_id,
    subject_sha256, body_sha256, source_content_sha256
  ) VALUES (
    p_workspace_id, actor_id, 'request_approval', p_command_key, request_hash,
    p_message_id, selected_version_id, selected_request_id,
    selected_subject_sha, selected_body_sha, selected_source_sha
  );
  RETURN QUERY SELECT 'requested', p_message_id, selected_version_id,
    selected_request_id, selected_subject_sha, selected_body_sha, selected_source_sha;
END
$function$;

CREATE FUNCTION app_private.decide_property_predator_owned_seed_message_approval(
  p_workspace_id uuid, p_approval_request_id uuid, p_decision text,
  p_decision_note text, p_command_key text
) RETURNS TABLE (
  disposition text, message_id uuid, message_version_id uuid,
  approval_request_id uuid, approval_decision_id uuid, decision text,
  subject_sha256 bytea, body_sha256 bytea, source_content_sha256 bytea
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  actor_id uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  request_hash bytea;
  prior app_private.property_predator_owned_seed_message_commands%ROWTYPE;
  selected_message_id uuid;
  selected_version_id uuid;
  selected_body_sha bytea;
  selected_subject_sha bytea;
  selected_source_sha bytea;
  selected_content_item_id uuid;
  selected_decision_id uuid := gen_random_uuid();
BEGIN
  IF session_user <> 'r72_owned_seed_message_command'
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'user'
     OR actor_id IS NULL OR coalesce(current_setting('app.request_id', true), '') = ''
     OR NOT EXISTS (SELECT 1 FROM app.workspace_memberships AS membership
       WHERE membership.workspace_id = p_workspace_id AND membership.user_id = actor_id
         AND membership.status = 'active' AND membership.role IN ('owner', 'admin')) THEN
    RAISE EXCEPTION 'Owned-seed message command context denied' USING ERRCODE = '42501';
  END IF;
  IF p_approval_request_id IS NULL OR p_decision NOT IN ('approved', 'rejected', 'changes_requested')
     OR p_command_key IS NULL OR p_command_key <> btrim(p_command_key)
     OR p_command_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
     OR (p_decision_note IS NOT NULL AND (p_decision_note <> btrim(p_decision_note)
       OR length(p_decision_note) NOT BETWEEN 1 AND 4000))
     OR (p_decision <> 'approved' AND p_decision_note IS NULL) THEN
    RAISE EXCEPTION 'Owned-seed approval decision input is invalid' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_workspace_id::text || ':owned-seed-live-message', 0));
  request_hash := public.digest(pg_catalog.convert_to(
    'decide_approval' || chr(31) || p_approval_request_id::text || chr(31)
      || p_decision || chr(31) || coalesce(p_decision_note, ''), 'UTF8'), 'sha256');
  SELECT command.* INTO prior FROM app_private.property_predator_owned_seed_message_commands AS command
  WHERE command.workspace_id = p_workspace_id AND command.actor_user_id = actor_id
    AND command.operation = 'decide_approval' AND command.command_key = p_command_key;
  IF FOUND THEN
    IF prior.request_sha256 IS DISTINCT FROM request_hash THEN
      RAISE EXCEPTION 'Owned-seed message command idempotency conflict' USING ERRCODE = '22000';
    END IF;
    RETURN QUERY SELECT 'replayed', prior.message_id, prior.message_version_id,
      prior.message_approval_request_id, prior.message_approval_decision_id,
      prior.decision, prior.subject_sha256, prior.body_sha256, prior.source_content_sha256;
    RETURN;
  END IF;

  SELECT source_version.content_item_id INTO selected_content_item_id
  FROM app.message_approval_requests AS request
  JOIN app.message_versions AS version
    ON version.workspace_id = request.workspace_id
   AND version.id = request.message_version_id
   AND version.message_id = request.message_id
  JOIN app.company_content_versions AS source_version
    ON source_version.workspace_id = version.workspace_id
   AND version.source_content_version_ref
     = 'app.company_content_versions:' || source_version.id::text
   AND version.source_content_sha256 = source_version.content_sha256
  WHERE request.workspace_id = p_workspace_id
    AND request.id = p_approval_request_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Owned-seed approval source evidence is unavailable' USING ERRCODE = '40001';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'company-content:' || p_workspace_id::text || ':' || selected_content_item_id::text,
    7200021));

  SELECT request.message_id, request.message_version_id, request.body_sha256,
         public.digest(conversation.subject, 'sha256'), version.source_content_sha256
    INTO selected_message_id, selected_version_id, selected_body_sha,
         selected_subject_sha, selected_source_sha
  FROM app.message_approval_requests AS request
  JOIN app.messages AS message ON message.workspace_id = request.workspace_id
    AND message.id = request.message_id AND message.lifecycle = 'approval_pending'
    AND message.current_version_id = request.message_version_id
    AND message.current_body_sha256 = request.body_sha256
  JOIN app.message_versions AS version ON version.workspace_id = request.workspace_id
    AND version.id = request.message_version_id AND version.message_id = request.message_id
    AND version.body_sha256 = request.body_sha256
  JOIN app.company_content_versions AS source_version
    ON source_version.workspace_id = version.workspace_id
   AND version.source_content_version_ref
     = 'app.company_content_versions:' || source_version.id::text
   AND version.source_content_sha256 = source_version.content_sha256
   AND source_version.content_kind = 'email'
   AND source_version.content_mime_type
     = 'application/vnd.propertypredator.email-draft+json'
  JOIN app.conversations AS conversation ON conversation.workspace_id = request.workspace_id
    AND conversation.id = request.conversation_id AND conversation.subject IS NOT NULL
  JOIN app.contact_points AS point ON point.workspace_id = message.workspace_id
    AND point.id = message.contact_point_id AND point.contact_id = message.contact_id
  WHERE request.workspace_id = p_workspace_id AND request.id = p_approval_request_id
    AND message.channel = 'email' AND message.environment = 'live'
    AND message.direction = 'outbound' AND message.source_kind = 'automation'
    AND lower(point.normalized_value) = 'office@propertypredator.com'
    AND EXISTS (
      SELECT 1
      FROM app_private.property_predator_owned_seed_message_commands AS created
      WHERE created.workspace_id = message.workspace_id
        AND created.operation = 'create_draft'
        AND created.company_content_version_id = source_version.id
        AND created.message_id = message.id
        AND created.message_version_id = version.id
        AND version.source_content_approval_ref
          = 'app.company_content_approval_decisions:'
            || created.company_content_approval_decision_id::text
        AND created.subject_sha256
          = public.digest(conversation.subject, 'sha256')
        AND created.body_sha256 = version.body_sha256
        AND created.source_content_sha256 = source_version.content_sha256
    )
    AND (
      p_decision <> 'approved'
      OR (
        source_version.content_sha256 = public.digest(
          pg_catalog.convert_to(source_version.content_body, 'UTF8'), 'sha256'
        )
        AND source_version.content_body = '{"bodyText":'
          || pg_catalog.to_json(version.body_text)::text
          || ',"schema":"propertypredator.email-draft/v1","subject":'
          || pg_catalog.to_json(conversation.subject)::text || '}'
        AND EXISTS (
          SELECT 1
          FROM app.company_content_approval_requests AS source_request
          JOIN app.company_content_approval_decisions AS source_decision
            ON source_decision.workspace_id = source_request.workspace_id
           AND source_decision.approval_request_id = source_request.id
           AND source_decision.content_version_id = source_version.id
           AND source_decision.content_sha256 = source_version.content_sha256
           AND source_decision.decision = 'approved'
          WHERE source_request.workspace_id = source_version.workspace_id
            AND source_request.content_item_id = source_version.content_item_id
            AND source_request.content_version_id = source_version.id
            AND source_request.content_sha256 = source_version.content_sha256
            AND source_request.id = (
              SELECT latest.id
              FROM app.company_content_approval_requests AS latest
              WHERE latest.workspace_id = source_version.workspace_id
                AND latest.content_item_id = source_version.content_item_id
                AND latest.content_version_id = source_version.id
              ORDER BY latest.request_number DESC, latest.id DESC LIMIT 1
            )
            AND version.source_content_approval_ref
              = 'app.company_content_approval_decisions:' || source_decision.id::text
        )
        AND EXISTS (
          SELECT 1
          FROM app.company_content_source_attestations AS source_attestation
          WHERE source_attestation.workspace_id = source_version.workspace_id
            AND source_attestation.content_item_id = source_version.content_item_id
            AND source_attestation.content_version_id = source_version.id
            AND source_attestation.source_system = source_version.source_system
            AND source_attestation.source_item_id = source_version.source_item_id
            AND source_attestation.source_version = source_version.source_version
            AND source_attestation.content_sha256 = source_version.content_sha256
            AND source_attestation.blob_sha256 = source_version.blob_sha256
            AND source_attestation.brand_sha256 = source_version.brand_sha256
            AND source_attestation.id = (
              SELECT latest.id
              FROM app.company_content_source_attestations AS latest
              WHERE latest.workspace_id = source_version.workspace_id
                AND latest.content_item_id = source_version.content_item_id
                AND latest.content_version_id = source_version.id
              ORDER BY latest.checked_at DESC, latest.id DESC LIMIT 1
            )
            AND source_attestation.checked_at <= statement_timestamp()
            AND source_attestation.expires_at > statement_timestamp()
        )
        AND NOT EXISTS (
          SELECT 1 FROM app.company_content_versions AS newer
          WHERE newer.workspace_id = source_version.workspace_id
            AND newer.content_item_id = source_version.content_item_id
            AND newer.version_number > source_version.version_number
        )
      )
    )
    AND NOT EXISTS (SELECT 1 FROM app.message_approval_decisions AS existing
      WHERE existing.workspace_id = request.workspace_id
        AND existing.approval_request_id = request.id);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Owned-seed approval request is not exact and pending' USING ERRCODE = '40001';
  END IF;
  INSERT INTO app.message_approval_decisions (
    id, workspace_id, conversation_id, message_id, message_version_id,
    approval_request_id, version_number, body_sha256, decision,
    decision_note, decided_by_user_id, decided_request_id
  ) SELECT selected_decision_id, request.workspace_id, request.conversation_id,
    request.message_id, request.message_version_id, request.id,
    request.version_number, request.body_sha256, p_decision, p_decision_note,
    actor_id, current_setting('app.request_id')
  FROM app.message_approval_requests AS request
  WHERE request.workspace_id = p_workspace_id AND request.id = p_approval_request_id;
  UPDATE app.messages SET lifecycle = CASE WHEN p_decision = 'approved' THEN 'approved' ELSE 'draft' END,
    row_version = row_version + 1, updated_at = statement_timestamp()
  WHERE workspace_id = p_workspace_id AND id = selected_message_id;
  INSERT INTO app_private.property_predator_owned_seed_message_commands (
    workspace_id, actor_user_id, operation, command_key, request_sha256,
    message_id, message_version_id, message_approval_request_id,
    message_approval_decision_id, decision, subject_sha256, body_sha256,
    source_content_sha256
  ) VALUES (
    p_workspace_id, actor_id, 'decide_approval', p_command_key, request_hash,
    selected_message_id, selected_version_id, p_approval_request_id,
    selected_decision_id, p_decision, selected_subject_sha, selected_body_sha,
    selected_source_sha
  );
  RETURN QUERY SELECT 'decided', selected_message_id, selected_version_id,
    p_approval_request_id, selected_decision_id, p_decision,
    selected_subject_sha, selected_body_sha, selected_source_sha;
END
$function$;

-- Recover the exact current workflow state after a signed browser token is
-- lost or expires. This is a bounded snapshot only: it returns no copy,
-- contact/provider identifiers or capability that can stage/send a message.
-- It deliberately does not require the source attestation to still be fresh;
-- the following mutating command rechecks that evidence atomically.
CREATE FUNCTION app_private.resume_property_predator_owned_seed_message(
  p_workspace_id uuid, p_company_content_version_id uuid
) RETURNS TABLE (
  message_id uuid, message_version_id uuid,
  company_content_version_id uuid, phase text,
  approval_request_id uuid, subject_sha256 bytea,
  body_sha256 bytea, source_content_sha256 bytea
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  actor_id uuid;
BEGIN
  actor_id := nullif(current_setting('app.user_id', true), '')::uuid;
  IF session_user <> 'r72_owned_seed_message_command'
     OR current_setting('app.workspace_id', true)
       IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'user'
     OR actor_id IS NULL
     OR coalesce(current_setting('app.request_id', true), '') = ''
     OR NOT EXISTS (
       SELECT 1 FROM app.workspace_memberships AS membership
       WHERE membership.workspace_id = p_workspace_id
         AND membership.user_id = actor_id
         AND membership.status = 'active'
         AND membership.role IN ('owner', 'admin')
     ) THEN
    RAISE EXCEPTION 'Owned-seed message resume context denied'
      USING ERRCODE = '42501';
  END IF;
  IF p_workspace_id IS NULL OR p_company_content_version_id IS NULL THEN
    RAISE EXCEPTION 'Owned-seed message resume input is invalid'
      USING ERRCODE = '22023';
  END IF;

  -- Serialize against create/request/decide for this bridge. Staging uses a
  -- separate lock, but PostgreSQL's statement snapshot still returns either
  -- the complete pre-stage or complete post-stage truth, never a mixed row.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_workspace_id::text || ':owned-seed-live-message', 0));

  RETURN QUERY
  WITH candidate AS (
    SELECT ledger.id AS ledger_id, ledger.recorded_at,
      ledger.message_id, ledger.message_version_id,
      ledger.company_content_version_id,
      ledger.subject_sha256, ledger.body_sha256,
      ledger.source_content_sha256,
      message.lifecycle,
      approval_request.id AS approval_request_id,
      approval_decision.decision,
      staged_job.id AS staged_job_id
    FROM app_private.property_predator_owned_seed_message_commands AS ledger
    JOIN app.messages AS message
      ON message.workspace_id = ledger.workspace_id
     AND message.id = ledger.message_id
     AND message.current_version_id = ledger.message_version_id
     AND message.current_version_number = 1
     AND message.current_body_sha256 = ledger.body_sha256
     AND message.channel = 'email' AND message.environment = 'live'
     AND message.direction = 'outbound' AND message.source_kind = 'automation'
    JOIN app.message_versions AS version
      ON version.workspace_id = message.workspace_id
     AND version.message_id = message.id
     AND version.id = ledger.message_version_id
     AND version.version_number = 1
     AND version.body_sha256 = ledger.body_sha256
     AND version.source_content_sha256 = ledger.source_content_sha256
     AND version.source_content_version_ref
       = 'app.company_content_versions:'
         || ledger.company_content_version_id::text
     AND version.source_content_approval_ref
       = 'app.company_content_approval_decisions:'
         || ledger.company_content_approval_decision_id::text
    JOIN app.company_content_versions AS source_version
      ON source_version.workspace_id = ledger.workspace_id
     AND source_version.id = ledger.company_content_version_id
     AND source_version.content_sha256 = ledger.source_content_sha256
    JOIN app.conversations AS conversation
      ON conversation.workspace_id = message.workspace_id
     AND conversation.id = message.conversation_id
     AND conversation.channel = 'email'
     AND conversation.environment = 'live'
     AND conversation.subject IS NOT NULL
     AND public.digest(conversation.subject, 'sha256') = ledger.subject_sha256
    JOIN app.contacts AS contact
      ON contact.workspace_id = message.workspace_id
     AND contact.id = message.contact_id
     AND contact.source IN ('property_predator_owned_seed', 'internal_seed')
     AND contact.deleted_at IS NULL
    JOIN app.contact_points AS point
      ON point.workspace_id = message.workspace_id
     AND point.contact_id = contact.id
     AND point.id = message.contact_point_id
     AND point.kind = 'email'
     AND lower(point.normalized_value) = 'office@propertypredator.com'
     AND point.deleted_at IS NULL
     AND point.is_verified AND point.is_primary
     AND point.dedupe_state = 'normal'
    LEFT JOIN LATERAL (
      SELECT request.id, request.request_number
      FROM app.message_approval_requests AS request
      WHERE request.workspace_id = message.workspace_id
        AND request.conversation_id = message.conversation_id
        AND request.message_id = message.id
        AND request.message_version_id = version.id
        AND request.version_number = version.version_number
        AND request.body_sha256 = version.body_sha256
      ORDER BY request.request_number DESC, request.id DESC
      LIMIT 1
    ) AS approval_request ON true
    LEFT JOIN LATERAL (
      SELECT decision.decision
      FROM app.message_approval_decisions AS decision
      WHERE decision.workspace_id = message.workspace_id
        AND decision.approval_request_id = approval_request.id
        AND decision.message_id = message.id
        AND decision.message_version_id = version.id
        AND decision.version_number = version.version_number
        AND decision.body_sha256 = version.body_sha256
      LIMIT 1
    ) AS approval_decision ON true
    LEFT JOIN LATERAL (
      SELECT job.id
      FROM app.property_predator_mailgun_jobs AS job
      WHERE job.workspace_id = message.workspace_id
        AND job.message_version_id = version.id
        AND job.email_sha256
          = public.digest('office@propertypredator.com', 'sha256')
      ORDER BY job.created_at, job.id
      LIMIT 1
    ) AS staged_job ON true
    WHERE ledger.workspace_id = p_workspace_id
      AND ledger.operation = 'create_draft'
      AND ledger.company_content_version_id = p_company_content_version_id
  ), valid AS (
    SELECT candidate.*,
      CASE
        WHEN candidate.staged_job_id IS NOT NULL THEN 'staged'
        WHEN candidate.lifecycle = 'approved'
          AND candidate.decision = 'approved' THEN 'approved'
        WHEN candidate.lifecycle = 'approval_pending'
          AND candidate.approval_request_id IS NOT NULL
          AND candidate.decision IS NULL THEN 'approval_pending'
        WHEN candidate.lifecycle = 'draft'
          AND (candidate.approval_request_id IS NULL
            OR candidate.decision IN ('rejected', 'changes_requested'))
          THEN 'drafted'
        ELSE NULL
      END AS resolved_phase
    FROM candidate
  )
  SELECT valid.message_id, valid.message_version_id,
    valid.company_content_version_id, valid.resolved_phase,
    valid.approval_request_id, valid.subject_sha256,
    valid.body_sha256, valid.source_content_sha256
  FROM valid
  WHERE valid.resolved_phase IS NOT NULL
  ORDER BY CASE valid.resolved_phase
      WHEN 'staged' THEN 1 WHEN 'approved' THEN 2
      WHEN 'approval_pending' THEN 3 ELSE 4 END,
    valid.recorded_at DESC, valid.ledger_id DESC
  LIMIT 1;
END
$function$;

CREATE FUNCTION app_private.property_predator_owned_seed_message_boundary_ready()
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  create_oid oid := pg_catalog.to_regprocedure('app_private.create_property_predator_owned_seed_message_draft(uuid,uuid,text)');
  request_oid oid := pg_catalog.to_regprocedure('app_private.request_property_predator_owned_seed_message_approval(uuid,uuid,text,text)');
  decide_oid oid := pg_catalog.to_regprocedure('app_private.decide_property_predator_owned_seed_message_approval(uuid,uuid,text,text,text)');
  resume_oid oid := pg_catalog.to_regprocedure('app_private.resume_property_predator_owned_seed_message(uuid,uuid)');
  ready_oid oid := pg_catalog.to_regprocedure('app_private.property_predator_owned_seed_message_boundary_ready()');
  ledger_oid oid := pg_catalog.to_regprocedure(
    'app_private.runtime_schema_migrations()'
  );
  installation_oid oid := pg_catalog.to_regprocedure(
    'app_private.runtime_database_installation_id()'
  );
  portal_lock_oid oid := pg_catalog.to_regprocedure(
    'app_private.lock_active_portal_session(bytea,uuid,uuid)'
  );
  portal_read_oid oid := pg_catalog.to_regprocedure(
    'app_private.active_portal_session(bytea,uuid,uuid)'
  );
  session_role_oid oid := pg_catalog.to_regrole(session_user);
BEGIN
  IF session_user <> 'r72_owned_seed_message_command' OR session_role_oid IS NULL
     OR create_oid IS NULL OR request_oid IS NULL OR decide_oid IS NULL
     OR resume_oid IS NULL OR ready_oid IS NULL OR ledger_oid IS NULL
     OR installation_oid IS NULL OR portal_lock_oid IS NULL
     OR portal_read_oid IS NULL THEN
    RETURN false;
  END IF;
  RETURN EXISTS (SELECT 1 FROM pg_catalog.pg_roles AS role WHERE role.oid = session_role_oid
      AND role.rolcanlogin AND NOT role.rolinherit AND NOT role.rolsuper
      AND NOT role.rolcreatedb AND NOT role.rolcreaterole
      AND NOT role.rolreplication AND NOT role.rolbypassrls)
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members AS membership
      WHERE membership.member = session_role_oid)
    AND pg_catalog.has_schema_privilege(session_user, 'app_private', 'USAGE')
    AND NOT pg_catalog.has_schema_privilege(session_user, 'app_private', 'CREATE')
    AND NOT pg_catalog.has_schema_privilege(session_user, 'app', 'USAGE')
    AND NOT pg_catalog.has_schema_privilege(session_user, 'public', 'CREATE')
    AND pg_catalog.has_function_privilege(session_user, create_oid, 'EXECUTE')
    AND pg_catalog.has_function_privilege(session_user, request_oid, 'EXECUTE')
    AND pg_catalog.has_function_privilege(session_user, decide_oid, 'EXECUTE')
    AND pg_catalog.has_function_privilege(session_user, resume_oid, 'EXECUTE')
    AND pg_catalog.has_function_privilege(session_user, ready_oid, 'EXECUTE')
    AND pg_catalog.has_function_privilege(session_user, ledger_oid, 'EXECUTE')
    AND pg_catalog.has_function_privilege(
      session_user, installation_oid, 'EXECUTE'
    )
    AND pg_catalog.has_function_privilege(session_user, portal_lock_oid, 'EXECUTE')
    AND pg_catalog.has_function_privilege(session_user, portal_read_oid, 'EXECUTE')
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc AS procedure
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = procedure.pronamespace
      WHERE namespace.nspname = 'app_private'
        AND procedure.oid NOT IN (
          create_oid, request_oid, decide_oid, resume_oid, ready_oid,
          ledger_oid, installation_oid, portal_lock_oid, portal_read_oid
        )
        AND pg_catalog.has_function_privilege(
          session_user, procedure.oid, 'EXECUTE'
        )
    )
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname IN ('app', 'app_private')
        AND relation.relkind IN ('r', 'p', 'v', 'm', 'f') AND (
          pg_catalog.has_table_privilege(session_user, relation.oid, 'SELECT')
          OR pg_catalog.has_table_privilege(session_user, relation.oid, 'INSERT')
          OR pg_catalog.has_table_privilege(session_user, relation.oid, 'UPDATE')
          OR pg_catalog.has_table_privilege(session_user, relation.oid, 'DELETE')
          OR pg_catalog.has_table_privilege(session_user, relation.oid, 'TRUNCATE'))
    )
    AND EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc AS procedure
      JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = procedure.proowner
      WHERE procedure.oid IN (
        create_oid, request_oid, decide_oid, resume_oid, ready_oid
      )
      GROUP BY owner_role.rolname
      HAVING owner_role.rolname = 'r72_owned_seed_message_definer'
        AND pg_catalog.bool_and(procedure.prosecdef)
        AND pg_catalog.bool_and(procedure.proconfig = ARRAY['search_path=pg_catalog']::text[])
        AND pg_catalog.count(*) = 5
    )
    AND EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc AS procedure
      JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = procedure.proowner
      WHERE procedure.oid IN (portal_lock_oid, portal_read_oid)
        AND owner_role.rolname = 'r72_security_definer'
        AND procedure.prosecdef
        AND procedure.proconfig = ARRAY['search_path=pg_catalog']::text[]
      GROUP BY owner_role.rolname
      HAVING pg_catalog.count(*) = 2
    );
END
$function$;

SET LOCAL ROLE r72_owner;
REVOKE ALL ON FUNCTION app_private.create_property_predator_owned_seed_message_draft(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.request_property_predator_owned_seed_message_approval(uuid, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.decide_property_predator_owned_seed_message_approval(uuid, uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.resume_property_predator_owned_seed_message(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.property_predator_owned_seed_message_boundary_ready() FROM PUBLIC;
GRANT USAGE ON SCHEMA app_private TO r72_owned_seed_message_command;
GRANT EXECUTE ON FUNCTION app_private.create_property_predator_owned_seed_message_draft(uuid, uuid, text)
  TO r72_owned_seed_message_command;
GRANT EXECUTE ON FUNCTION app_private.request_property_predator_owned_seed_message_approval(uuid, uuid, text, text)
  TO r72_owned_seed_message_command;
GRANT EXECUTE ON FUNCTION app_private.decide_property_predator_owned_seed_message_approval(uuid, uuid, text, text, text)
  TO r72_owned_seed_message_command;
GRANT EXECUTE ON FUNCTION app_private.resume_property_predator_owned_seed_message(uuid, uuid)
  TO r72_owned_seed_message_command;
GRANT EXECUTE ON FUNCTION app_private.property_predator_owned_seed_message_boundary_ready()
  TO r72_owned_seed_message_command;
GRANT EXECUTE ON FUNCTION app_private.runtime_schema_migrations()
  TO r72_owned_seed_message_command;
GRANT EXECUTE ON FUNCTION app_private.runtime_database_installation_id()
  TO r72_owned_seed_message_command;
GRANT EXECUTE ON FUNCTION app_private.lock_active_portal_session(bytea, uuid, uuid)
  TO r72_owned_seed_message_command;
GRANT EXECUTE ON FUNCTION app_private.active_portal_session(bytea, uuid, uuid)
  TO r72_owned_seed_message_command;
REVOKE CREATE ON SCHEMA app_private FROM r72_owned_seed_message_definer;

DO $capability_audit$
DECLARE unsafe_object text;
BEGIN
  SELECT pg_catalog.format('%I.%I', namespace.nspname, relation.relname)
    INTO unsafe_object
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname IN ('app', 'app_private')
    AND relation.relkind IN ('r', 'p', 'v', 'm', 'f') AND (
      pg_catalog.has_table_privilege('r72_owned_seed_message_command', relation.oid, 'SELECT')
      OR pg_catalog.has_table_privilege('r72_owned_seed_message_command', relation.oid, 'INSERT')
      OR pg_catalog.has_table_privilege('r72_owned_seed_message_command', relation.oid, 'UPDATE')
      OR pg_catalog.has_table_privilege('r72_owned_seed_message_command', relation.oid, 'DELETE')
      OR pg_catalog.has_table_privilege('r72_owned_seed_message_command', relation.oid, 'TRUNCATE'))
  LIMIT 1;
  IF unsafe_object IS NOT NULL THEN
    RAISE EXCEPTION 'Owned-seed message command has unsafe table access: %', unsafe_object;
  END IF;
END
$capability_audit$;
