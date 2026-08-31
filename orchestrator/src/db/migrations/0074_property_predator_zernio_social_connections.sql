-- Founder-only Zernio account connection evidence. This migration creates no
-- provider connection row, secret, OAuth request, publication job or worker.
-- It only adds the one-use intent, callback and signed account-event boundary.

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'r72_zernio_social_command') THEN
    CREATE ROLE r72_zernio_social_command LOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'r72_zernio_social_definer') THEN
    CREATE ROLE r72_zernio_social_definer NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'r72_zernio_social_command'
      AND rolcanlogin AND NOT rolinherit AND NOT rolsuper AND NOT rolcreatedb
      AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'r72_zernio_social_definer'
      AND NOT rolcanlogin AND NOT rolinherit AND NOT rolsuper AND NOT rolcreatedb
      AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls
  ) THEN
    RAISE EXCEPTION 'Unsafe Zernio social role attributes';
  END IF;
  REVOKE r72_owner, r72_security_definer FROM
    r72_zernio_social_command, r72_zernio_social_definer;
  EXECUTE format('GRANT r72_zernio_social_definer TO %I', current_user);
END
$roles$;

SET LOCAL ROLE r72_owner;

REVOKE ALL ON SCHEMA app, app_private FROM
  r72_zernio_social_command, r72_zernio_social_definer;
REVOKE ALL ON ALL TABLES IN SCHEMA app FROM
  r72_zernio_social_command, r72_zernio_social_definer;
REVOKE ALL ON ALL TABLES IN SCHEMA app_private FROM
  r72_zernio_social_command, r72_zernio_social_definer;
REVOKE CREATE ON SCHEMA public FROM r72_zernio_social_command, r72_zernio_social_definer;
GRANT USAGE ON SCHEMA app, app_private TO
  r72_zernio_social_command, r72_zernio_social_definer;

CREATE TABLE app.property_predator_zernio_connection_intents (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  provider_connection_id uuid NOT NULL,
  provider_profile_id_sha256 bytea NOT NULL CHECK (octet_length(provider_profile_id_sha256) = 32),
  network text NOT NULL CHECK (network IN ('facebook', 'instagram', 'linkedin')),
  portal_session_token_sha256 bytea NOT NULL CHECK (octet_length(portal_session_token_sha256) = 32),
  state text NOT NULL CHECK (state IN ('claimed', 'prepared', 'consumed')),
  provider_state_sha256 bytea CHECK (provider_state_sha256 IS NULL OR octet_length(provider_state_sha256) = 32),
  auth_url_sha256 bytea CHECK (auth_url_sha256 IS NULL OR octet_length(auth_url_sha256) = 32),
  callback_sha256 bytea CHECK (callback_sha256 IS NULL OR octet_length(callback_sha256) = 32),
  provider_account_id_sha256 bytea CHECK (
    provider_account_id_sha256 IS NULL OR octet_length(provider_account_id_sha256) = 32
  ),
  created_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz NOT NULL,
  prepared_at timestamptz,
  consumed_at timestamptz,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, provider_connection_id, environment)
    REFERENCES app.provider_connections (workspace_id, id, environment) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, created_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK (expires_at = created_at + interval '10 minutes'),
  CHECK ((state = 'claimed') = (provider_state_sha256 IS NULL AND auth_url_sha256 IS NULL
    AND prepared_at IS NULL AND callback_sha256 IS NULL
    AND provider_account_id_sha256 IS NULL AND consumed_at IS NULL)),
  CHECK ((state = 'prepared') = (provider_state_sha256 IS NOT NULL AND auth_url_sha256 IS NOT NULL
    AND prepared_at IS NOT NULL AND callback_sha256 IS NULL
    AND provider_account_id_sha256 IS NULL AND consumed_at IS NULL)),
  CHECK ((state = 'consumed') = (provider_state_sha256 IS NOT NULL AND auth_url_sha256 IS NOT NULL
    AND prepared_at IS NOT NULL AND callback_sha256 IS NOT NULL
    AND provider_account_id_sha256 IS NOT NULL AND consumed_at IS NOT NULL)),
  environment text NOT NULL DEFAULT 'live' CHECK (environment = 'live')
);

CREATE UNIQUE INDEX property_predator_zernio_intents_one_open_network_uq
  ON app.property_predator_zernio_connection_intents
    (workspace_id, provider_connection_id, created_by_user_id, network)
  WHERE state IN ('claimed', 'prepared');

CREATE TABLE app.property_predator_zernio_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  provider_connection_id uuid NOT NULL,
  provider_profile_id_sha256 bytea NOT NULL CHECK (octet_length(provider_profile_id_sha256) = 32),
  provider_account_id_sha256 bytea NOT NULL CHECK (octet_length(provider_account_id_sha256) = 32),
  network text NOT NULL CHECK (network IN ('facebook', 'instagram', 'linkedin')),
  username text CHECK (username IS NULL OR (username = btrim(username) AND length(username) BETWEEN 1 AND 160)),
  display_name text CHECK (
    display_name IS NULL OR (display_name = btrim(display_name) AND length(display_name) BETWEEN 1 AND 160)
  ),
  status text NOT NULL CHECK (status IN ('active', 'disconnected')),
  connected_by_intent_id uuid,
  linked_at timestamptz NOT NULL,
  last_event_at timestamptz NOT NULL,
  created_by_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, provider_connection_id, provider_account_id_sha256),
  FOREIGN KEY (workspace_id, provider_connection_id, environment)
    REFERENCES app.provider_connections (workspace_id, id, environment) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, connected_by_intent_id)
    REFERENCES app.property_predator_zernio_connection_intents (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, created_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK (updated_at >= created_at AND last_event_at >= linked_at - interval '5 minutes'),
  environment text NOT NULL DEFAULT 'live' CHECK (environment = 'live')
);

CREATE TABLE app.property_predator_zernio_account_webhook_receipts (
  event_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  provider_connection_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('account.connected', 'account.disconnected')),
  network text NOT NULL CHECK (network IN ('facebook', 'instagram', 'linkedin')),
  provider_profile_id_sha256 bytea NOT NULL CHECK (octet_length(provider_profile_id_sha256) = 32),
  provider_account_id_sha256 bytea NOT NULL CHECK (octet_length(provider_account_id_sha256) = 32),
  raw_body_sha256 bytea NOT NULL CHECK (octet_length(raw_body_sha256) = 32),
  receipt_sha256 bytea NOT NULL CHECK (octet_length(receipt_sha256) = 32),
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, event_id),
  FOREIGN KEY (workspace_id, provider_connection_id, environment)
    REFERENCES app.provider_connections (workspace_id, id, environment) ON DELETE RESTRICT,
  environment text NOT NULL DEFAULT 'live' CHECK (environment = 'live')
);

CREATE FUNCTION app_private.zernio_evidence_immutable_guard()
RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog AS $function$
BEGIN
  RAISE EXCEPTION 'Zernio social evidence is immutable' USING ERRCODE = '40001';
END
$function$;
REVOKE ALL ON FUNCTION app_private.zernio_evidence_immutable_guard() FROM PUBLIC;
CREATE TRIGGER property_predator_zernio_receipts_immutable
  BEFORE UPDATE OR DELETE ON app.property_predator_zernio_account_webhook_receipts
  FOR EACH ROW EXECUTE FUNCTION app_private.zernio_evidence_immutable_guard();

ALTER TABLE app.property_predator_zernio_connection_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.property_predator_zernio_connection_intents FORCE ROW LEVEL SECURITY;
ALTER TABLE app.property_predator_zernio_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.property_predator_zernio_accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE app.property_predator_zernio_account_webhook_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.property_predator_zernio_account_webhook_receipts FORCE ROW LEVEL SECURITY;

CREATE POLICY zernio_intents_owner_all ON app.property_predator_zernio_connection_intents
  FOR ALL TO r72_owner USING (true) WITH CHECK (true);
CREATE POLICY zernio_accounts_owner_all ON app.property_predator_zernio_accounts
  FOR ALL TO r72_owner USING (true) WITH CHECK (true);
CREATE POLICY zernio_receipts_owner_all ON app.property_predator_zernio_account_webhook_receipts
  FOR ALL TO r72_owner USING (true) WITH CHECK (true);
CREATE POLICY zernio_intents_definer_all ON app.property_predator_zernio_connection_intents
  FOR ALL TO r72_zernio_social_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY zernio_accounts_definer_all ON app.property_predator_zernio_accounts
  FOR ALL TO r72_zernio_social_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY zernio_receipts_definer_all ON app.property_predator_zernio_account_webhook_receipts
  FOR ALL TO r72_zernio_social_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY provider_connections_zernio_definer_select ON app.provider_connections
  FOR SELECT TO r72_zernio_social_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY workspace_memberships_zernio_definer_select ON app.workspace_memberships
  FOR SELECT TO r72_zernio_social_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON app.property_predator_zernio_connection_intents
  TO r72_zernio_social_definer;
GRANT SELECT, INSERT, UPDATE ON app.property_predator_zernio_accounts
  TO r72_zernio_social_definer;
GRANT SELECT, INSERT ON app.property_predator_zernio_account_webhook_receipts
  TO r72_zernio_social_definer;
GRANT SELECT ON app.provider_connections, app.workspace_memberships
  TO r72_zernio_social_definer;
GRANT CREATE ON SCHEMA app_private TO r72_zernio_social_definer;
SET LOCAL ROLE r72_zernio_social_definer;

CREATE FUNCTION app_private.begin_zernio_connection_intent(
  p_workspace_id uuid, p_provider_connection_id uuid, p_intent_id uuid,
  p_portal_session_token_sha256 bytea, p_provider_profile_id_sha256 bytea,
  p_network text
) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE selected_user uuid; existing app.property_predator_zernio_connection_intents%ROWTYPE;
BEGIN
  IF session_user <> 'r72_zernio_social_command'
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'user'
     OR current_setting('app.user_id', true) !~ '^[0-9a-f-]{36}$'
     OR coalesce(current_setting('app.request_id', true), '') = ''
     OR octet_length(p_portal_session_token_sha256) <> 32
     OR octet_length(p_provider_profile_id_sha256) <> 32
     OR p_network NOT IN ('facebook', 'instagram', 'linkedin') THEN
    RAISE EXCEPTION 'Zernio connection intent denied' USING ERRCODE = '42501';
  END IF;
  selected_user := current_setting('app.user_id')::uuid;
  IF NOT EXISTS (
    SELECT 1 FROM app.workspace_memberships membership
    WHERE membership.workspace_id = p_workspace_id AND membership.user_id = selected_user
      AND membership.status = 'active' AND membership.role IN ('owner', 'admin')
  ) OR NOT EXISTS (
    SELECT 1 FROM app.provider_connections connection
    WHERE connection.workspace_id = p_workspace_id AND connection.id = p_provider_connection_id
      AND connection.provider_id = 'zernio' AND connection.provider_kind = 'social'
      AND connection.environment = 'live' AND connection.status = 'active'
  ) THEN
    RAISE EXCEPTION 'Zernio connection intent denied' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO existing FROM app.property_predator_zernio_connection_intents intent
  WHERE intent.workspace_id = p_workspace_id AND intent.id = p_intent_id;
  IF FOUND THEN
    IF existing.provider_connection_id <> p_provider_connection_id
       OR existing.provider_profile_id_sha256 <> p_provider_profile_id_sha256
       OR existing.network <> p_network
       OR existing.portal_session_token_sha256 <> p_portal_session_token_sha256
       OR existing.created_by_user_id <> selected_user THEN
      RAISE EXCEPTION 'Zernio connection intent conflict' USING ERRCODE = '40001';
    END IF;
    RETURN 'replayed';
  END IF;
  IF EXISTS (
    SELECT 1 FROM app.property_predator_zernio_connection_intents intent
    WHERE intent.workspace_id = p_workspace_id
      AND intent.provider_connection_id = p_provider_connection_id
      AND intent.created_by_user_id = selected_user AND intent.network = p_network
      AND intent.state IN ('claimed', 'prepared') AND intent.expires_at > statement_timestamp()
  ) THEN
    RAISE EXCEPTION 'Zernio connection intent already open' USING ERRCODE = '40001';
  END IF;
  DELETE FROM app.property_predator_zernio_connection_intents intent
  WHERE intent.workspace_id = p_workspace_id
    AND intent.provider_connection_id = p_provider_connection_id
    AND intent.created_by_user_id = selected_user AND intent.network = p_network
    AND intent.state IN ('claimed', 'prepared') AND intent.expires_at <= statement_timestamp();
  INSERT INTO app.property_predator_zernio_connection_intents (
    id, workspace_id, provider_connection_id, provider_profile_id_sha256,
    network, portal_session_token_sha256, state, created_by_user_id,
    created_at, expires_at
  ) VALUES (
    p_intent_id, p_workspace_id, p_provider_connection_id, p_provider_profile_id_sha256,
    p_network, p_portal_session_token_sha256, 'claimed', selected_user,
    statement_timestamp(), statement_timestamp() + interval '10 minutes'
  );
  RETURN 'claimed';
END
$function$;

CREATE FUNCTION app_private.complete_zernio_connection_preparation(
  p_workspace_id uuid, p_provider_connection_id uuid, p_intent_id uuid,
  p_portal_session_token_sha256 bytea, p_provider_state_sha256 bytea,
  p_auth_url_sha256 bytea
) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE selected_user uuid; selected_intent app.property_predator_zernio_connection_intents%ROWTYPE;
BEGIN
  IF session_user <> 'r72_zernio_social_command'
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'user'
     OR current_setting('app.user_id', true) !~ '^[0-9a-f-]{36}$'
     OR octet_length(p_portal_session_token_sha256) <> 32
     OR octet_length(p_provider_state_sha256) <> 32
     OR octet_length(p_auth_url_sha256) <> 32 THEN
    RAISE EXCEPTION 'Zernio preparation denied' USING ERRCODE = '42501';
  END IF;
  selected_user := current_setting('app.user_id')::uuid;
  SELECT * INTO selected_intent FROM app.property_predator_zernio_connection_intents intent
  WHERE intent.workspace_id = p_workspace_id AND intent.id = p_intent_id FOR UPDATE;
  IF NOT FOUND OR selected_intent.provider_connection_id <> p_provider_connection_id
     OR selected_intent.created_by_user_id <> selected_user
     OR selected_intent.portal_session_token_sha256 <> p_portal_session_token_sha256
     OR selected_intent.expires_at <= statement_timestamp() THEN
    RAISE EXCEPTION 'Zernio preparation denied' USING ERRCODE = '42501';
  END IF;
  IF selected_intent.state = 'prepared' THEN
    IF selected_intent.provider_state_sha256 <> p_provider_state_sha256
       OR selected_intent.auth_url_sha256 <> p_auth_url_sha256 THEN
      RAISE EXCEPTION 'Zernio preparation conflict' USING ERRCODE = '40001';
    END IF;
    RETURN 'replayed';
  END IF;
  IF selected_intent.state <> 'claimed' THEN
    RAISE EXCEPTION 'Zernio preparation conflict' USING ERRCODE = '40001';
  END IF;
  UPDATE app.property_predator_zernio_connection_intents SET
    state = 'prepared', provider_state_sha256 = p_provider_state_sha256,
    auth_url_sha256 = p_auth_url_sha256, prepared_at = statement_timestamp()
  WHERE workspace_id = p_workspace_id AND id = p_intent_id;
  RETURN 'prepared';
END
$function$;

CREATE FUNCTION app_private.record_zernio_connection_callback(
  p_workspace_id uuid, p_provider_connection_id uuid, p_intent_id uuid,
  p_portal_session_token_sha256 bytea, p_provider_profile_id_sha256 bytea,
  p_provider_account_id_sha256 bytea, p_network text, p_username text,
  p_callback_sha256 bytea, p_linked_at timestamptz
) RETURNS TABLE(disposition text, account_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE selected_user uuid; selected_intent app.property_predator_zernio_connection_intents%ROWTYPE;
  selected_account_id uuid;
BEGIN
  IF session_user <> 'r72_zernio_social_command'
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'user'
     OR current_setting('app.user_id', true) !~ '^[0-9a-f-]{36}$'
     OR octet_length(p_portal_session_token_sha256) <> 32
     OR octet_length(p_provider_profile_id_sha256) <> 32
     OR octet_length(p_provider_account_id_sha256) <> 32
     OR octet_length(p_callback_sha256) <> 32
     OR p_network NOT IN ('facebook', 'instagram', 'linkedin')
     OR p_username <> btrim(p_username) OR length(p_username) NOT BETWEEN 1 AND 160
     OR p_linked_at > statement_timestamp() + interval '5 minutes' THEN
    RAISE EXCEPTION 'Zernio callback denied' USING ERRCODE = '42501';
  END IF;
  selected_user := current_setting('app.user_id')::uuid;
  SELECT * INTO selected_intent FROM app.property_predator_zernio_connection_intents intent
  WHERE intent.workspace_id = p_workspace_id AND intent.id = p_intent_id FOR UPDATE;
  IF NOT FOUND OR selected_intent.provider_connection_id <> p_provider_connection_id
     OR selected_intent.created_by_user_id <> selected_user
     OR selected_intent.portal_session_token_sha256 <> p_portal_session_token_sha256
     OR selected_intent.provider_profile_id_sha256 <> p_provider_profile_id_sha256
     OR selected_intent.network <> p_network THEN
    RAISE EXCEPTION 'Zernio callback denied' USING ERRCODE = '42501';
  END IF;
  IF selected_intent.state = 'consumed' THEN
    IF selected_intent.callback_sha256 <> p_callback_sha256
       OR selected_intent.provider_account_id_sha256 <> p_provider_account_id_sha256 THEN
      RAISE EXCEPTION 'Zernio callback conflict' USING ERRCODE = '40001';
    END IF;
    SELECT account.id INTO selected_account_id FROM app.property_predator_zernio_accounts account
    WHERE account.workspace_id = p_workspace_id
      AND account.provider_connection_id = p_provider_connection_id
      AND account.provider_account_id_sha256 = p_provider_account_id_sha256;
    RETURN QUERY SELECT 'replayed'::text, selected_account_id;
    RETURN;
  END IF;
  IF selected_intent.state <> 'prepared'
     OR selected_intent.expires_at <= statement_timestamp() THEN
    RAISE EXCEPTION 'Zernio callback expired or unprepared' USING ERRCODE = '42501';
  END IF;
  INSERT INTO app.property_predator_zernio_accounts (
    workspace_id, provider_connection_id, provider_profile_id_sha256,
    provider_account_id_sha256, network, username, display_name, status,
    connected_by_intent_id, linked_at, last_event_at, created_by_user_id
  ) VALUES (
    p_workspace_id, p_provider_connection_id, p_provider_profile_id_sha256,
    p_provider_account_id_sha256, p_network, p_username, p_username, 'active',
    p_intent_id, p_linked_at, p_linked_at, selected_user
  ) ON CONFLICT (workspace_id, provider_connection_id, provider_account_id_sha256)
  DO UPDATE SET
    username = coalesce(app.property_predator_zernio_accounts.username, EXCLUDED.username),
    display_name = coalesce(app.property_predator_zernio_accounts.display_name, EXCLUDED.display_name),
    status = 'active', updated_at = statement_timestamp()
  WHERE app.property_predator_zernio_accounts.provider_profile_id_sha256 = EXCLUDED.provider_profile_id_sha256
    AND app.property_predator_zernio_accounts.network = EXCLUDED.network
  RETURNING id INTO selected_account_id;
  IF selected_account_id IS NULL THEN
    RAISE EXCEPTION 'Zernio callback account conflict' USING ERRCODE = '40001';
  END IF;
  UPDATE app.property_predator_zernio_connection_intents SET
    state = 'consumed', callback_sha256 = p_callback_sha256,
    provider_account_id_sha256 = p_provider_account_id_sha256,
    consumed_at = statement_timestamp()
  WHERE workspace_id = p_workspace_id AND id = p_intent_id;
  RETURN QUERY SELECT 'recorded'::text, selected_account_id;
END
$function$;

CREATE FUNCTION app_private.record_zernio_account_webhook(
  p_workspace_id uuid, p_provider_connection_id uuid, p_event_id uuid,
  p_event_type text, p_network text, p_provider_profile_id_sha256 bytea,
  p_provider_account_id_sha256 bytea, p_raw_body_sha256 bytea,
  p_receipt_sha256 bytea, p_occurred_at timestamptz
) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE existing app.property_predator_zernio_account_webhook_receipts%ROWTYPE;
  selected_account app.property_predator_zernio_accounts%ROWTYPE;
BEGIN
  IF session_user <> 'r72_zernio_social_command'
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'webhook'
     OR coalesce(current_setting('app.request_id', true), '') = ''
     OR p_event_type NOT IN ('account.connected', 'account.disconnected')
     OR p_network NOT IN ('facebook', 'instagram', 'linkedin')
     OR octet_length(p_provider_profile_id_sha256) <> 32
     OR octet_length(p_provider_account_id_sha256) <> 32
     OR octet_length(p_raw_body_sha256) <> 32 OR octet_length(p_receipt_sha256) <> 32
     OR p_occurred_at > statement_timestamp() + interval '5 minutes' THEN
    RAISE EXCEPTION 'Zernio webhook receipt denied' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app.provider_connections connection
    WHERE connection.workspace_id = p_workspace_id AND connection.id = p_provider_connection_id
      AND connection.provider_id = 'zernio' AND connection.provider_kind = 'social'
      AND connection.environment = 'live' AND connection.status = 'active'
  ) THEN
    RAISE EXCEPTION 'Zernio webhook connection denied' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO selected_account FROM app.property_predator_zernio_accounts account
  WHERE account.workspace_id = p_workspace_id
    AND account.provider_connection_id = p_provider_connection_id
    AND account.provider_account_id_sha256 = p_provider_account_id_sha256;
  IF FOUND AND (
    selected_account.provider_profile_id_sha256 <> p_provider_profile_id_sha256
    OR selected_account.network <> p_network
  ) THEN
    RAISE EXCEPTION 'Zernio webhook account conflict' USING ERRCODE = '40001';
  END IF;
  SELECT * INTO existing FROM app.property_predator_zernio_account_webhook_receipts receipt
  WHERE receipt.event_id = p_event_id;
  IF FOUND THEN
    IF existing.workspace_id <> p_workspace_id
       OR existing.provider_connection_id <> p_provider_connection_id
       OR existing.event_type <> p_event_type OR existing.network <> p_network
       OR existing.provider_profile_id_sha256 <> p_provider_profile_id_sha256
       OR existing.provider_account_id_sha256 <> p_provider_account_id_sha256
       OR existing.raw_body_sha256 <> p_raw_body_sha256
       OR existing.receipt_sha256 <> p_receipt_sha256
       OR existing.occurred_at <> p_occurred_at THEN
      RAISE EXCEPTION 'Zernio webhook replay conflict' USING ERRCODE = '40001';
    END IF;
    RETURN 'replayed';
  END IF;
  INSERT INTO app.property_predator_zernio_account_webhook_receipts (
    event_id, workspace_id, provider_connection_id, event_type, network,
    provider_profile_id_sha256, provider_account_id_sha256,
    raw_body_sha256, receipt_sha256, occurred_at
  ) VALUES (
    p_event_id, p_workspace_id, p_provider_connection_id, p_event_type, p_network,
    p_provider_profile_id_sha256, p_provider_account_id_sha256,
    p_raw_body_sha256, p_receipt_sha256, p_occurred_at
  );
  INSERT INTO app.property_predator_zernio_accounts (
    workspace_id, provider_connection_id, provider_profile_id_sha256,
    provider_account_id_sha256, network, status, linked_at, last_event_at
  ) VALUES (
    p_workspace_id, p_provider_connection_id, p_provider_profile_id_sha256,
    p_provider_account_id_sha256, p_network,
    CASE WHEN p_event_type = 'account.connected' THEN 'active' ELSE 'disconnected' END,
    p_occurred_at, p_occurred_at
  ) ON CONFLICT (workspace_id, provider_connection_id, provider_account_id_sha256)
  DO UPDATE SET
    status = CASE WHEN p_event_type = 'account.connected' THEN 'active' ELSE 'disconnected' END,
    last_event_at = p_occurred_at, updated_at = statement_timestamp()
  WHERE app.property_predator_zernio_accounts.provider_profile_id_sha256 = EXCLUDED.provider_profile_id_sha256
    AND app.property_predator_zernio_accounts.network = EXCLUDED.network
    AND app.property_predator_zernio_accounts.last_event_at <= p_occurred_at;
  RETURN 'recorded';
END
$function$;

CREATE FUNCTION app_private.read_zernio_social_accounts(
  p_workspace_id uuid, p_provider_connection_id uuid, p_provider_profile_id_sha256 bytea
) RETURNS TABLE(
  account_id uuid, network text, username text, display_name text, status text,
  linked_at timestamptz, last_event_at timestamptz, webhook_receipt_count bigint
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $function$
  SELECT account.id, account.network, account.username, account.display_name,
    account.status, account.linked_at, account.last_event_at,
    (SELECT count(*) FROM app.property_predator_zernio_account_webhook_receipts receipt
     WHERE receipt.workspace_id = account.workspace_id
       AND receipt.provider_connection_id = account.provider_connection_id
       AND receipt.provider_account_id_sha256 = account.provider_account_id_sha256)
  FROM app.property_predator_zernio_accounts account
  WHERE session_user = 'r72_zernio_social_command'
    AND current_setting('app.workspace_id', true) = p_workspace_id::text
    AND current_setting('app.actor_kind', true) = 'user'
    AND account.workspace_id = p_workspace_id
    AND account.provider_connection_id = p_provider_connection_id
    AND account.provider_profile_id_sha256 = p_provider_profile_id_sha256
  ORDER BY account.network, account.created_at, account.id
$function$;

REVOKE ALL ON FUNCTION app_private.begin_zernio_connection_intent(uuid,uuid,uuid,bytea,bytea,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.complete_zernio_connection_preparation(uuid,uuid,uuid,bytea,bytea,bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.record_zernio_connection_callback(uuid,uuid,uuid,bytea,bytea,bytea,text,text,bytea,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.record_zernio_account_webhook(uuid,uuid,uuid,text,text,bytea,bytea,bytea,bytea,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.read_zernio_social_accounts(uuid,uuid,bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.begin_zernio_connection_intent(uuid,uuid,uuid,bytea,bytea,text),
  app_private.complete_zernio_connection_preparation(uuid,uuid,uuid,bytea,bytea,bytea),
  app_private.record_zernio_connection_callback(uuid,uuid,uuid,bytea,bytea,bytea,text,text,bytea,timestamptz),
  app_private.record_zernio_account_webhook(uuid,uuid,uuid,text,text,bytea,bytea,bytea,bytea,timestamptz),
  app_private.read_zernio_social_accounts(uuid,uuid,bytea)
  TO r72_zernio_social_command;

RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_zernio_social_definer;

GRANT EXECUTE ON FUNCTION
  app_private.runtime_schema_migrations(),
  app_private.runtime_database_installation_id(),
  app_private.lock_active_portal_session(bytea,uuid,uuid)
  TO r72_zernio_social_command;

INSERT INTO app_private.workspace_table_registry (schema_name, table_name, workspace_column)
VALUES
  ('app', 'property_predator_zernio_connection_intents', 'workspace_id'),
  ('app', 'property_predator_zernio_accounts', 'workspace_id'),
  ('app', 'property_predator_zernio_account_webhook_receipts', 'workspace_id');

DO $capability_audit$
DECLARE unsafe_object text; unexpected_public text;
BEGIN
  SELECT format('%I.%I', namespace.nspname, relation.relname) INTO unsafe_object
  FROM pg_catalog.pg_class relation
  JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname IN ('app', 'app_private')
    AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND (has_table_privilege('r72_zernio_social_command', relation.oid, 'SELECT')
      OR has_table_privilege('r72_zernio_social_command', relation.oid, 'INSERT')
      OR has_table_privilege('r72_zernio_social_command', relation.oid, 'UPDATE')
      OR has_table_privilege('r72_zernio_social_command', relation.oid, 'DELETE'))
  LIMIT 1;
  IF unsafe_object IS NOT NULL THEN
    RAISE EXCEPTION 'Zernio command role has direct table capability: %', unsafe_object;
  END IF;
  SELECT procedure.oid::regprocedure::text INTO unexpected_public
  FROM pg_catalog.pg_proc procedure
  JOIN pg_catalog.pg_namespace namespace ON namespace.oid = procedure.pronamespace
  CROSS JOIN LATERAL pg_catalog.aclexplode(
    coalesce(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))
  ) privilege
  WHERE namespace.nspname = 'app_private'
    AND procedure.proname LIKE '%zernio%'
    AND privilege.grantee = 0 AND privilege.privilege_type = 'EXECUTE'
  LIMIT 1;
  IF unexpected_public IS NOT NULL THEN
    RAISE EXCEPTION 'Zernio function remains executable by PUBLIC: %', unexpected_public;
  END IF;
END
$capability_audit$;

RESET ROLE;
