-- Founder-operated Twilio SMS binding, revocation and activation readiness.
--
-- Two things make this migration necessary rather than optional.
--
-- First, 0056 is currently inert. Every SMS predicate requires
-- `connection.provider_kind = 'sms'`, but `app.provider_connections` has
-- constrained provider_kind to ('messaging','email','social') since 0022, so no
-- row can ever satisfy it: the enqueue's provider gate can never pass, the rail
-- truth can only ever report PROVIDER_NOT_CONFIGURED, and the webhook inbound
-- projection can never bind a connection. The existing SMS tests are text
-- contracts over the migration source and a DDL-apply proof, so none of them
-- exercise a satisfiable row. This widens the check by exactly one value.
--
-- Second, 0056 has no table or function for the Twilio account, messaging
-- service or sender number: it assumes a provider connection and channel
-- endpoint already exist. The only function that inserts a provider connection
-- is 0027's founder bootstrap, hard-coded to mailgun_eu/email, and the only
-- channel-endpoint insert is 0048's, hard-coded to email. So a founder has no
-- way to bind Twilio evidence at all.
--
-- Nothing here stores a Twilio Auth Token, API key or any other secret. The
-- account and messaging-service identifiers are stored as digests; only the
-- owned sender number is stored in clear, because `app.channel_endpoints`
-- must hold it as a routable address anyway. No provider is contacted.

SET LOCAL ROLE r72_owner;

-- Exactly one added value. Every existing row still satisfies the check, so
-- this widening cannot invalidate stored data.
DO $provider_kind_widening$
DECLARE narrow_constraint text;
BEGIN
  SELECT candidates.constraint_name INTO narrow_constraint
  FROM (
    SELECT con.conname AS constraint_name,
      pg_catalog.pg_get_constraintdef(con.oid) AS definition
    FROM pg_catalog.pg_constraint AS con
    JOIN pg_catalog.pg_class AS rel ON rel.oid = con.conrelid
    JOIN pg_catalog.pg_namespace AS ns ON ns.oid = rel.relnamespace
    WHERE ns.nspname = 'app' AND rel.relname = 'provider_connections'
      AND con.contype = 'c'
  ) AS candidates
  WHERE candidates.definition LIKE '%provider_kind%'
    AND candidates.definition LIKE '%messaging%'
    AND candidates.definition LIKE '%email%'
    AND candidates.definition LIKE '%social%'
    AND candidates.definition NOT LIKE '%sms%'
  LIMIT 1;
  IF narrow_constraint IS NULL THEN
    RAISE EXCEPTION 'Expected the narrow provider_kind check that blocks the SMS rail';
  END IF;
  EXECUTE format(
    'ALTER TABLE app.provider_connections DROP CONSTRAINT %I', narrow_constraint
  );
END
$provider_kind_widening$;

ALTER TABLE app.provider_connections
  ADD CONSTRAINT provider_connections_provider_kind_check
  CHECK (provider_kind IN ('messaging', 'email', 'social', 'sms'));

CREATE TABLE app.property_predator_sms_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  provider_connection_id uuid NOT NULL,
  channel_endpoint_id uuid NOT NULL,
  environment text NOT NULL CHECK (environment = 'live'),
  provider_id text NOT NULL CHECK (provider_id = 'twilio_messaging'),
  account_sid_sha256 bytea NOT NULL CHECK (octet_length(account_sid_sha256) = 32),
  messaging_service_sid_sha256 bytea NOT NULL
    CHECK (octet_length(messaging_service_sid_sha256) = 32),
  sender_number text NOT NULL CHECK (sender_number ~ '^\+44[0-9]{9,10}$'),
  owned_number_sha256 bytea NOT NULL CHECK (octet_length(owned_number_sha256) = 32),
  regulatory_evidence_sha256 bytea NOT NULL
    CHECK (octet_length(regulatory_evidence_sha256) = 32),
  ownership_evidence_sha256 bytea NOT NULL
    CHECK (octet_length(ownership_evidence_sha256) = 32),
  evidence_observed_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status = 'active'),
  created_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, id, provider_connection_id),
  UNIQUE (workspace_id, provider_connection_id, sender_number),
  FOREIGN KEY (workspace_id, provider_connection_id, environment)
    REFERENCES app.provider_connections (workspace_id, id, environment)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, channel_endpoint_id)
    REFERENCES app.channel_endpoints (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, created_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT
);

CREATE TABLE app.property_predator_sms_binding_revocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  binding_id uuid NOT NULL,
  provider_connection_id uuid NOT NULL,
  reason_code text NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_.:-]{0,99}$'),
  revocation_evidence_sha256 bytea NOT NULL
    CHECK (octet_length(revocation_evidence_sha256) = 32),
  revoked_by_user_id uuid NOT NULL,
  revoked_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  -- One revocation per binding. Revocation is permanent; a rotation is a
  -- revoke followed by binding a successor number.
  UNIQUE (workspace_id, binding_id),
  FOREIGN KEY (workspace_id, binding_id, provider_connection_id)
    REFERENCES app.property_predator_sms_bindings
      (workspace_id, id, provider_connection_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, revoked_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT
);

CREATE TRIGGER property_predator_sms_bindings_immutable BEFORE UPDATE OR DELETE
  ON app.property_predator_sms_bindings FOR EACH ROW
  EXECUTE FUNCTION app_private.sms_live_immutable_guard();
CREATE TRIGGER property_predator_sms_binding_revocations_immutable
  BEFORE UPDATE OR DELETE
  ON app.property_predator_sms_binding_revocations FOR EACH ROW
  EXECUTE FUNCTION app_private.sms_live_immutable_guard();

ALTER TABLE app.property_predator_sms_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.property_predator_sms_bindings FORCE ROW LEVEL SECURITY;
ALTER TABLE app.property_predator_sms_binding_revocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.property_predator_sms_binding_revocations FORCE ROW LEVEL SECURITY;

CREATE POLICY sms_bindings_owner_all
  ON app.property_predator_sms_bindings FOR ALL TO r72_owner
  USING (true) WITH CHECK (true);
CREATE POLICY sms_binding_revocations_owner_all
  ON app.property_predator_sms_binding_revocations FOR ALL TO r72_owner
  USING (true) WITH CHECK (true);
CREATE POLICY sms_bindings_definer_all
  ON app.property_predator_sms_bindings FOR ALL TO r72_sms_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY sms_binding_revocations_definer_all
  ON app.property_predator_sms_binding_revocations FOR ALL TO r72_sms_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

GRANT SELECT, INSERT ON app.property_predator_sms_bindings TO r72_sms_definer;
GRANT SELECT, INSERT ON app.property_predator_sms_binding_revocations
  TO r72_sms_definer;

-- The definer may create exactly one Twilio SMS connection and its owned
-- sender endpoint, and may only ever move that connection towards disabled.
GRANT INSERT ON app.provider_connections, app.channel_endpoints TO r72_sms_definer;
GRANT UPDATE (status, row_version, updated_at)
  ON app.provider_connections TO r72_sms_definer;
GRANT SELECT ON app.property_predator_live_channel_pause_events TO r72_sms_definer;

CREATE POLICY provider_connections_sms_definer_insert
  ON app.provider_connections FOR INSERT TO r72_sms_definer
  WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND provider_id = 'twilio_messaging' AND provider_kind = 'sms'
    AND environment = 'live' AND status = 'active'
    AND capabilities @> '["sms.send"]'::jsonb
  );
CREATE POLICY provider_connections_sms_definer_update
  ON app.provider_connections FOR UPDATE TO r72_sms_definer
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND provider_id = 'twilio_messaging' AND provider_kind = 'sms'
  )
  WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND provider_id = 'twilio_messaging' AND provider_kind = 'sms'
    AND status = 'disabled'
  );
CREATE POLICY channel_endpoints_sms_definer_insert
  ON app.channel_endpoints FOR INSERT TO r72_sms_definer
  WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND channel = 'sms' AND environment = 'live' AND status = 'active'
    AND direction = 'bidirectional'
    AND address = normalized_address
    AND normalized_address ~ '^\+44[0-9]{9,10}$'
  );
CREATE POLICY live_channel_pause_sms_definer_select
  ON app.property_predator_live_channel_pause_events FOR SELECT
  TO r72_sms_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

GRANT CREATE ON SCHEMA app_private TO r72_sms_definer;
SET LOCAL ROLE r72_sms_definer;

/*
 * Bind one exact owned Twilio sender. Creates the live connection, the owned
 * sender endpoint and the binding evidence in one transaction. Stores digests
 * for the account and messaging-service identifiers and never a credential.
 */
CREATE FUNCTION app_private.record_sms_live_binding(
  p_workspace_id uuid,
  p_binding_id uuid,
  p_provider_connection_id uuid,
  p_channel_endpoint_id uuid,
  p_display_name text,
  p_account_sid_sha256 bytea,
  p_messaging_service_sid_sha256 bytea,
  p_sender_number text,
  p_regulatory_evidence_sha256 bytea,
  p_ownership_evidence_sha256 bytea,
  p_evidence_observed_at timestamptz
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE selected_user uuid;
BEGIN
  IF session_user <> 'r72_sms_command'
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'user'
     OR current_setting('app.user_id', true) !~ '^[0-9a-f-]{36}$'
     OR coalesce(current_setting('app.request_id', true), '') = ''
     OR octet_length(p_account_sid_sha256) <> 32
     OR octet_length(p_messaging_service_sid_sha256) <> 32
     OR octet_length(p_regulatory_evidence_sha256) <> 32
     OR octet_length(p_ownership_evidence_sha256) <> 32
     OR p_sender_number !~ '^\+44[0-9]{9,10}$'
     OR p_display_name IS NULL OR p_display_name <> btrim(p_display_name)
     OR length(p_display_name) NOT BETWEEN 1 AND 120
     OR p_evidence_observed_at > statement_timestamp() + interval '5 minutes' THEN
    RAISE EXCEPTION 'Twilio SMS binding denied' USING ERRCODE = '42501';
  END IF;
  selected_user := current_setting('app.user_id')::uuid;
  IF NOT EXISTS (
    SELECT 1 FROM app.workspace_memberships AS membership
    WHERE membership.workspace_id = p_workspace_id
      AND membership.user_id = selected_user
      AND membership.status = 'active' AND membership.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'Twilio SMS binding operator denied' USING ERRCODE = '42501';
  END IF;
  -- Serialize binding for this workspace so two founders cannot register two
  -- live senders concurrently.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    format('pp-sms-binding:%s', p_workspace_id), 7200060
  ));
  IF EXISTS (
    SELECT 1 FROM app.property_predator_sms_bindings AS binding
    WHERE binding.workspace_id = p_workspace_id
      AND NOT EXISTS (
        SELECT 1 FROM app.property_predator_sms_binding_revocations AS revocation
        WHERE revocation.workspace_id = binding.workspace_id
          AND revocation.binding_id = binding.id
      )
  ) THEN
    RAISE EXCEPTION 'An unrevoked Twilio SMS binding already exists'
      USING ERRCODE = '23505';
  END IF;
  INSERT INTO app.provider_connections (
    id, workspace_id, provider_id, provider_kind, environment, status,
    display_name, capabilities, created_by_user_id
  ) VALUES (
    p_provider_connection_id, p_workspace_id, 'twilio_messaging', 'sms',
    'live', 'active', p_display_name, '["sms.send"]'::jsonb, selected_user
  );
  INSERT INTO app.channel_endpoints (
    id, workspace_id, provider_connection_id, channel, environment,
    direction, address, normalized_address, display_name, status
  ) VALUES (
    p_channel_endpoint_id, p_workspace_id, p_provider_connection_id, 'sms',
    'live', 'bidirectional', p_sender_number, p_sender_number,
    p_display_name, 'active'
  );
  INSERT INTO app.property_predator_sms_bindings (
    id, workspace_id, provider_connection_id, channel_endpoint_id, environment,
    provider_id, account_sid_sha256, messaging_service_sid_sha256,
    sender_number, owned_number_sha256, regulatory_evidence_sha256,
    ownership_evidence_sha256, evidence_observed_at, status, created_by_user_id
  ) VALUES (
    p_binding_id, p_workspace_id, p_provider_connection_id, p_channel_endpoint_id,
    'live', 'twilio_messaging', p_account_sid_sha256,
    p_messaging_service_sid_sha256, p_sender_number,
    public.digest(p_sender_number, 'sha256'), p_regulatory_evidence_sha256,
    p_ownership_evidence_sha256, p_evidence_observed_at, 'active', selected_user
  );
  RETURN p_binding_id;
END
$function$;

/*
 * Permanently revoke one binding and disable its connection so the rail can
 * never dispatch through it again. There is deliberately no un-revoke.
 */
CREATE FUNCTION app_private.revoke_sms_live_binding(
  p_workspace_id uuid,
  p_binding_id uuid,
  p_reason_code text,
  p_revocation_evidence_sha256 bytea
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE selected_user uuid; selected_connection uuid; existing record;
  created_id uuid := gen_random_uuid();
BEGIN
  IF session_user <> 'r72_sms_command'
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'user'
     OR current_setting('app.user_id', true) !~ '^[0-9a-f-]{36}$'
     OR coalesce(current_setting('app.request_id', true), '') = ''
     OR octet_length(p_revocation_evidence_sha256) <> 32
     OR p_reason_code !~ '^[a-z][a-z0-9_.:-]{0,99}$' THEN
    RAISE EXCEPTION 'Twilio SMS revocation denied' USING ERRCODE = '42501';
  END IF;
  selected_user := current_setting('app.user_id')::uuid;
  IF NOT EXISTS (
    SELECT 1 FROM app.workspace_memberships AS membership
    WHERE membership.workspace_id = p_workspace_id
      AND membership.user_id = selected_user
      AND membership.status = 'active' AND membership.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'Twilio SMS revocation operator denied' USING ERRCODE = '42501';
  END IF;
  SELECT binding.provider_connection_id INTO selected_connection
  FROM app.property_predator_sms_bindings AS binding
  WHERE binding.workspace_id = p_workspace_id AND binding.id = p_binding_id
  FOR UPDATE;
  IF selected_connection IS NULL THEN
    RAISE EXCEPTION 'Twilio SMS binding not found' USING ERRCODE = '42501';
  END IF;
  SELECT revocation.id, revocation.reason_code,
      revocation.revocation_evidence_sha256
    INTO existing
  FROM app.property_predator_sms_binding_revocations AS revocation
  WHERE revocation.workspace_id = p_workspace_id
    AND revocation.binding_id = p_binding_id;
  IF FOUND THEN
    IF existing.reason_code IS DISTINCT FROM p_reason_code
       OR existing.revocation_evidence_sha256 IS DISTINCT FROM p_revocation_evidence_sha256 THEN
      RAISE EXCEPTION 'Twilio SMS revocation conflict' USING ERRCODE = '40001';
    END IF;
    RETURN existing.id;
  END IF;
  INSERT INTO app.property_predator_sms_binding_revocations (
    id, workspace_id, binding_id, provider_connection_id, reason_code,
    revocation_evidence_sha256, revoked_by_user_id
  ) VALUES (
    created_id, p_workspace_id, p_binding_id, selected_connection, p_reason_code,
    p_revocation_evidence_sha256, selected_user
  );
  UPDATE app.provider_connections AS connection
  SET status = 'disabled', row_version = connection.row_version + 1,
    updated_at = statement_timestamp()
  WHERE connection.workspace_id = p_workspace_id
    AND connection.id = selected_connection
    AND connection.provider_id = 'twilio_messaging'
    AND connection.provider_kind = 'sms';
  RETURN created_id;
END
$function$;

/*
 * Derive the exact request digest `authorize_and_enqueue_sms_live_job`
 * re-computes and compares.
 *
 * 0056 builds that digest from the sender number, approved body hash, resolved
 * contact and contact-point ids, the recipient and endpoint identity digests,
 * the derived segment count and the action scope — none of which the founder
 * command role can read, because 0056 deliberately makes it table-blind and
 * its own capability audit fails the migration if it is not. The command was
 * therefore uncallable by the only role permitted to call it: any caller-
 * invented digest raises 'Twilio SMS request digest conflict'.
 *
 * This is read-only and returns a digest, never the underlying values.
 */
CREATE FUNCTION app_private.derive_sms_live_request_digest(
  p_workspace_id uuid,
  p_provider_connection_id uuid,
  p_message_version_id uuid,
  p_message_approval_request_id uuid,
  p_message_approval_decision_id uuid,
  p_channel_endpoint_id uuid,
  p_consent_event_id uuid,
  p_compliance_subject_id uuid,
  p_policy_publication_event_id uuid,
  p_pecr_sender_decision_event_id uuid,
  p_pecr_instigator_decision_event_id uuid,
  p_permission_use_receipt_id uuid,
  p_authority_valid_until timestamptz,
  p_provider_operation_id uuid,
  p_message_delivery_id uuid,
  p_correlation_id uuid,
  p_idempotency_key_sha256 bytea
) RETURNS bytea
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE
  selected_user uuid;
  selected_request_id text;
  selected_purpose text := 'marketing';
  selected_contact_id uuid;
  selected_contact_point_id uuid;
  selected_sender_number text;
  selected_body_sha bytea;
  selected_recipient_sha bytea;
  selected_endpoint_sha bytea;
  selected_segment_count integer;
  expected_action_scope bytea;
BEGIN
  IF session_user <> 'r72_sms_command'
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'user'
     OR current_setting('app.user_id', true) !~ '^[0-9a-f-]{36}$'
     OR coalesce(current_setting('app.request_id', true), '') = ''
     OR octet_length(p_idempotency_key_sha256) <> 32 THEN
    RAISE EXCEPTION 'Twilio SMS request digest derivation denied' USING ERRCODE = '42501';
  END IF;
  selected_user := current_setting('app.user_id')::uuid;
  selected_request_id := current_setting('app.request_id');

  -- Exactly the resolution the command performs, so the digest can only match
  -- when the same evidence chain is present.
  SELECT message.contact_id, message.contact_point_id,
    endpoint.normalized_address, message_version.body_sha256,
    public.digest(point.normalized_value, 'sha256'),
    public.digest(point.kind || pg_catalog.chr(31) || point.value
      || pg_catalog.chr(31) || point.normalized_value, 'sha256'),
    CASE WHEN char_length(message_version.body_text) <= 160 THEN 1
      ELSE ceil(char_length(message_version.body_text) / 153.0)::integer END
  INTO selected_contact_id, selected_contact_point_id, selected_sender_number,
    selected_body_sha, selected_recipient_sha, selected_endpoint_sha,
    selected_segment_count
  FROM app.message_versions AS message_version
  JOIN app.messages AS message
    ON message.workspace_id = message_version.workspace_id
   AND message.id = message_version.message_id
   AND message.current_version_id = message_version.id
   AND message.channel = 'sms' AND message.environment = 'live'
   AND message.direction = 'outbound'
  JOIN app.channel_endpoints AS endpoint
    ON endpoint.workspace_id = message_version.workspace_id
   AND endpoint.id = p_channel_endpoint_id
   AND endpoint.provider_connection_id = p_provider_connection_id
   AND endpoint.channel = 'sms' AND endpoint.environment = 'live'
  JOIN app.contact_points AS point
    ON point.workspace_id = message.workspace_id
   AND point.id = message.contact_point_id AND point.contact_id = message.contact_id
   AND point.kind = 'phone'
  WHERE message_version.workspace_id = p_workspace_id
    AND message_version.id = p_message_version_id
    AND message_version.channel = 'sms' AND message_version.environment = 'live';
  IF selected_sender_number IS NULL THEN
    RAISE EXCEPTION 'Twilio SMS request digest evidence is unavailable'
      USING ERRCODE = '42501';
  END IF;

  expected_action_scope := public.digest(format(
    'sms:%s:%s:%s:%s:%s:%s:%s', p_workspace_id,
    p_provider_connection_id, selected_sender_number,
    p_message_version_id,
    pg_catalog.encode(selected_endpoint_sha, 'hex'),
    selected_purpose, p_consent_event_id
  ), 'sha256');

  RETURN public.digest(pg_catalog.concat_ws(pg_catalog.chr(31),
    'propertypredator.twilio-sms-live/v1', p_workspace_id::text,
    p_provider_connection_id::text, selected_sender_number,
    p_message_version_id::text,
    pg_catalog.encode(selected_body_sha, 'hex'),
    p_message_approval_request_id::text,
    p_message_approval_decision_id::text,
    p_channel_endpoint_id::text, p_consent_event_id::text,
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
    pg_catalog.encode(selected_endpoint_sha, 'hex'),
    selected_purpose, selected_segment_count::text,
    pg_catalog.encode(expected_action_scope, 'hex'),
    selected_user::text, selected_request_id
  ), 'sha256');
END
$function$;

/*
 * Read-only activation readiness for one exact owned recipient and approved
 * message. Writes nothing, creates no job and cannot reach Twilio. Returns one
 * row per dimension carrying a boolean and a non-sensitive blocker code; the
 * recipient is supplied as a digest and never returned.
 */
CREATE FUNCTION app_private.property_predator_sms_activation_readiness(
  p_workspace_id uuid,
  p_binding_id uuid,
  p_message_version_id uuid,
  p_message_approval_decision_id uuid,
  p_contact_id uuid,
  p_contact_point_id uuid,
  p_consent_event_id uuid,
  p_purpose text,
  p_expected_recipient_sha256 bytea
) RETURNS TABLE (dimension text, ready boolean, blocker_code text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE
  selected_user uuid;
  binding_ok boolean := false;
  binding_revoked boolean := false;
  selected_connection uuid;
  selected_endpoint uuid;
  message_ok boolean := false;
  selected_segments integer;
  selected_endpoint_sha bytea;
  selected_recipient_sha bytea;
  day_segments integer := 0;
  month_segments integer := 0;
BEGIN
  IF session_user <> 'r72_sms_command'
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'user'
     OR current_setting('app.user_id', true) !~ '^[0-9a-f-]{36}$'
     OR coalesce(current_setting('app.request_id', true), '') = ''
     OR p_purpose !~ '^[a-z][a-z0-9_.-]{0,99}$'
     OR p_expected_recipient_sha256 IS NULL
     OR octet_length(p_expected_recipient_sha256) <> 32 THEN
    RAISE EXCEPTION 'Twilio SMS activation readiness denied' USING ERRCODE = '42501';
  END IF;
  selected_user := current_setting('app.user_id')::uuid;

  dimension := 'operator_authority';
  ready := EXISTS (
    SELECT 1 FROM app.workspace_memberships AS membership
    WHERE membership.workspace_id = p_workspace_id
      AND membership.user_id = selected_user
      AND membership.status = 'active' AND membership.role IN ('owner', 'admin')
  );
  blocker_code := CASE WHEN ready THEN NULL ELSE 'OPERATOR_AUTHORITY_REQUIRED' END;
  RETURN NEXT;

  SELECT true, EXISTS (
      SELECT 1 FROM app.property_predator_sms_binding_revocations AS revocation
      WHERE revocation.workspace_id = binding.workspace_id
        AND revocation.binding_id = binding.id
    ), binding.provider_connection_id, binding.channel_endpoint_id
  INTO binding_ok, binding_revoked, selected_connection, selected_endpoint
  FROM app.property_predator_sms_bindings AS binding
  WHERE binding.workspace_id = p_workspace_id AND binding.id = p_binding_id
    AND binding.status = 'active';
  dimension := 'owned_binding';
  ready := coalesce(binding_ok, false) AND NOT coalesce(binding_revoked, false);
  blocker_code := CASE
    WHEN ready THEN NULL
    WHEN coalesce(binding_revoked, false) THEN 'IDENTITY_BINDING_REVOKED'
    ELSE 'IDENTITY_BINDING_REQUIRED' END;
  RETURN NEXT;

  dimension := 'provider_connection';
  ready := selected_connection IS NOT NULL AND EXISTS (
    SELECT 1 FROM app.provider_connections AS connection
    WHERE connection.workspace_id = p_workspace_id
      AND connection.id = selected_connection
      AND connection.provider_id = 'twilio_messaging'
      AND connection.provider_kind = 'sms'
      AND connection.environment = 'live' AND connection.status = 'active'
      AND connection.capabilities @> '["sms.send"]'::jsonb
  );
  blocker_code := CASE WHEN ready THEN NULL ELSE 'PROVIDER_NOT_CONFIGURED' END;
  RETURN NEXT;

  dimension := 'sender_endpoint';
  ready := selected_endpoint IS NOT NULL AND EXISTS (
    SELECT 1 FROM app.channel_endpoints AS endpoint
    WHERE endpoint.workspace_id = p_workspace_id
      AND endpoint.id = selected_endpoint
      AND endpoint.provider_connection_id = selected_connection
      AND endpoint.channel = 'sms' AND endpoint.environment = 'live'
      AND endpoint.status = 'active'
      AND endpoint.direction IN ('outbound', 'bidirectional')
      AND endpoint.address = endpoint.normalized_address
      AND endpoint.normalized_address ~ '^\+44[0-9]{9,10}$'
  );
  blocker_code := CASE WHEN ready THEN NULL ELSE 'SENDER_ENDPOINT_REQUIRED' END;
  RETURN NEXT;

  -- The approved message must still be the current approved version and must
  -- satisfy the same GSM subset and segment arithmetic the command enforces.
  SELECT true,
    CASE WHEN char_length(version.body_text) <= 160 THEN 1
      ELSE ceil(char_length(version.body_text) / 153.0)::integer END
  INTO message_ok, selected_segments
  FROM app.message_versions AS version
  JOIN app.messages AS message
    ON message.workspace_id = version.workspace_id
   AND message.id = version.message_id
   AND message.current_version_id = version.id
   AND message.current_body_sha256 = version.body_sha256
   AND message.direction = 'outbound' AND message.channel = 'sms'
   AND message.environment = 'live'
  JOIN app.message_approval_decisions AS decision
    ON decision.workspace_id = version.workspace_id
   AND decision.id = p_message_approval_decision_id
   AND decision.message_id = message.id
   AND decision.message_version_id = version.id
   AND decision.body_sha256 = version.body_sha256
   AND decision.decision = 'approved'
  WHERE version.workspace_id = p_workspace_id
    AND version.id = p_message_version_id
    AND version.channel = 'sms' AND version.environment = 'live'
    AND version.body_text ~ '^[\r\n\x20-\x5a\x5f\x61-\x7a]+$'
    AND char_length(version.body_text) BETWEEN 1 AND 1530;
  dimension := 'approved_message';
  ready := coalesce(message_ok, false);
  blocker_code := CASE WHEN ready THEN NULL ELSE 'APPROVED_CONTENT_REQUIRED' END;
  RETURN NEXT;

  SELECT public.digest(point.kind || pg_catalog.chr(31) || point.value
      || pg_catalog.chr(31) || point.normalized_value, 'sha256'),
    public.digest(point.normalized_value, 'sha256')
  INTO selected_endpoint_sha, selected_recipient_sha
  FROM app.contact_points AS point
  WHERE point.workspace_id = p_workspace_id AND point.id = p_contact_point_id
    AND point.contact_id = p_contact_id AND point.kind = 'phone'
    AND point.is_verified AND point.dedupe_state = 'normal'
    AND point.deleted_at IS NULL
    AND point.normalized_value ~ '^\+44[0-9]{9,10}$';
  dimension := 'recipient_endpoint';
  ready := selected_recipient_sha IS NOT NULL;
  blocker_code := CASE WHEN ready THEN NULL ELSE 'RECIPIENT_ENDPOINT_UNVERIFIED' END;
  RETURN NEXT;

  dimension := 'recipient_matches_supplied_owned_target';
  ready := selected_recipient_sha IS NOT NULL
    AND selected_recipient_sha = p_expected_recipient_sha256;
  blocker_code := CASE WHEN ready THEN NULL ELSE 'RECIPIENT_EVIDENCE_MISMATCH' END;
  RETURN NEXT;

  dimension := 'current_consent';
  ready := selected_endpoint_sha IS NOT NULL AND EXISTS (
    SELECT 1 FROM app.communication_consent_events AS consent
    WHERE consent.workspace_id = p_workspace_id AND consent.id = p_consent_event_id
      AND consent.contact_id = p_contact_id
      AND consent.contact_point_id = p_contact_point_id
      AND consent.channel = 'sms' AND consent.purpose = p_purpose
      AND consent.state = 'granted'
      AND consent.endpoint_identity_sha256 = selected_endpoint_sha
      AND consent.id = (
        SELECT latest.id FROM app.communication_consent_events AS latest
        WHERE latest.workspace_id = p_workspace_id
          AND latest.contact_point_id = p_contact_point_id
          AND latest.channel = 'sms' AND latest.purpose = p_purpose
        ORDER BY latest.occurred_at DESC, latest.recorded_at DESC, latest.id DESC
        LIMIT 1
      )
  );
  blocker_code := CASE WHEN ready THEN NULL ELSE 'CONSENT_NOT_CURRENT' END;
  RETURN NEXT;

  -- Latest-wins suppression, exactly as the command boundary evaluates it. A
  -- STOP recorded after a START still blocks.
  dimension := 'suppression_clear';
  ready := selected_endpoint_sha IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM app.communication_suppression_events AS suppression
    WHERE suppression.workspace_id = p_workspace_id
      AND suppression.contact_point_id = p_contact_point_id
      AND suppression.channel = 'sms'
      AND (suppression.purpose IS NULL OR suppression.purpose = p_purpose)
      AND suppression.state = 'suppressed'
      AND suppression.id = (
        SELECT latest.id FROM app.communication_suppression_events AS latest
        WHERE latest.workspace_id = p_workspace_id
          AND latest.contact_point_id = suppression.contact_point_id
          AND latest.channel = suppression.channel
          AND latest.purpose IS NOT DISTINCT FROM suppression.purpose
        ORDER BY latest.occurred_at DESC, latest.recorded_at DESC, latest.id DESC
        LIMIT 1
      )
  );
  blocker_code := CASE WHEN ready THEN NULL ELSE 'SUPPRESSION_ACTIVE' END;
  RETURN NEXT;

  -- Segment caps are summed, not counted, exactly as 0056 enforces them.
  IF selected_connection IS NOT NULL THEN
    SELECT coalesce(sum(job.segment_count), 0)::integer INTO day_segments
    FROM app.property_predator_sms_jobs AS job
    WHERE job.workspace_id = p_workspace_id
      AND job.provider_connection_id = selected_connection
      AND job.utc_day = (statement_timestamp() AT TIME ZONE 'UTC')::date
      AND job.state <> 'cancelled';
    SELECT coalesce(sum(job.segment_count), 0)::integer INTO month_segments
    FROM app.property_predator_sms_jobs AS job
    WHERE job.workspace_id = p_workspace_id
      AND job.provider_connection_id = selected_connection
      AND job.utc_month = date_trunc('month', statement_timestamp() AT TIME ZONE 'UTC')::date
      AND job.state <> 'cancelled';
  END IF;
  -- An unresolved message means the segment count is unknown, so headroom
  -- cannot be claimed. Reporting ready here would be a false negative on the
  -- one dimension a founder is most likely to trust.
  dimension := 'segment_cap_headroom';
  ready := selected_segments IS NOT NULL
    AND day_segments + selected_segments <= 10
    AND month_segments + selected_segments <= 50;
  blocker_code := CASE WHEN ready THEN NULL ELSE 'CAP_REACHED' END;
  RETURN NEXT;

  dimension := 'receipt_path_clear';
  ready := selected_connection IS NULL OR NOT EXISTS (
    SELECT 1 FROM app.property_predator_sms_jobs AS job
    WHERE job.workspace_id = p_workspace_id
      AND job.provider_connection_id = selected_connection
      AND job.state = 'needs_attention'
  );
  blocker_code := CASE WHEN ready THEN NULL ELSE 'OUTCOME_UNKNOWN_QUARANTINED' END;
  RETURN NEXT;

  dimension := 'emergency_pause_clear';
  ready := NOT EXISTS (
    SELECT 1 FROM app.property_predator_live_channel_pause_events AS pause
    WHERE pause.workspace_id = p_workspace_id
      AND pause.scope IN ('all', 'sms')
  );
  blocker_code := CASE WHEN ready THEN NULL ELSE 'EMERGENCY_PAUSED' END;
  RETURN NEXT;
END
$function$;

RESET ROLE;
SET LOCAL ROLE r72_owner;

REVOKE CREATE ON SCHEMA app_private FROM r72_sms_definer;
REVOKE ALL ON FUNCTION app_private.record_sms_live_binding(
  uuid, uuid, uuid, uuid, text, bytea, bytea, text, bytea, bytea, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.revoke_sms_live_binding(
  uuid, uuid, text, bytea
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.derive_sms_live_request_digest(
  uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, timestamptz, uuid, uuid, uuid, bytea
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.property_predator_sms_activation_readiness(
  uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, bytea
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.record_sms_live_binding(
  uuid, uuid, uuid, uuid, text, bytea, bytea, text, bytea, bytea, timestamptz
) TO r72_sms_command;
GRANT EXECUTE ON FUNCTION app_private.revoke_sms_live_binding(
  uuid, uuid, text, bytea
) TO r72_sms_command;
GRANT EXECUTE ON FUNCTION app_private.derive_sms_live_request_digest(
  uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, timestamptz, uuid, uuid, uuid, bytea
) TO r72_sms_command;
GRANT EXECUTE ON FUNCTION app_private.property_predator_sms_activation_readiness(
  uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, bytea
) TO r72_sms_command;

INSERT INTO app_private.workspace_table_registry (schema_name, table_name, workspace_column)
VALUES
  ('app', 'property_predator_sms_bindings', 'workspace_id'),
  ('app', 'property_predator_sms_binding_revocations', 'workspace_id');

-- The SMS command identities must remain completely table-blind.
DO $capability_audit$
DECLARE checked_role text; unsafe_object text;
BEGIN
  FOREACH checked_role IN ARRAY ARRAY[
    'r72_sms_command', 'r72_sms_worker_command', 'r72_sms_webhook_command'
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
      RAISE EXCEPTION 'Unsafe Twilio SMS founder binding capability: % -> %',
        checked_role, unsafe_object;
    END IF;
  END LOOP;
END
$capability_audit$;
