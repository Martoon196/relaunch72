-- Make the founder calendar self-reconcile its exact configured Zernio account,
-- distinguish access from readiness, and bind one optional uploaded media item.
-- This migration does not create a post or call a provider.

SET LOCAL ROLE r72_owner;

ALTER TABLE app.property_predator_zernio_direct_schedules
  ADD COLUMN media_type text CHECK (media_type IS NULL OR media_type IN ('image', 'video')),
  ADD COLUMN media_url text CHECK (
    media_url IS NULL OR (
      media_url = btrim(media_url)
      AND length(media_url) BETWEEN 10 AND 2048
      AND media_url ~ '^https://media[.]zernio[.]com/'
    )
  ),
  ADD CONSTRAINT zernio_direct_schedule_media_pair_ck
    CHECK ((media_type IS NULL) = (media_url IS NULL));

CREATE TABLE app.property_predator_zernio_calendar_account_probes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  provider_connection_id uuid NOT NULL,
  network text NOT NULL CHECK (network = 'linkedin'),
  provider_profile_id_sha256 bytea NOT NULL CHECK (octet_length(provider_profile_id_sha256) = 32),
  provider_account_id_sha256 bytea NOT NULL CHECK (octet_length(provider_account_id_sha256) = 32),
  username text CHECK (username IS NULL OR (username = btrim(username) AND length(username) BETWEEN 1 AND 160)),
  display_name text CHECK (display_name IS NULL OR (display_name = btrim(display_name) AND length(display_name) BETWEEN 1 AND 160)),
  response_sha256 bytea NOT NULL CHECK (octet_length(response_sha256) = 32),
  command_key_sha256 bytea NOT NULL CHECK (octet_length(command_key_sha256) = 32),
  request_sha256 bytea NOT NULL CHECK (octet_length(request_sha256) = 32),
  probed_by_user_id uuid NOT NULL,
  request_id text NOT NULL CHECK (request_id = btrim(request_id) AND length(request_id) BETWEEN 1 AND 128),
  probed_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  environment text NOT NULL DEFAULT 'live' CHECK (environment = 'live'),
  UNIQUE (workspace_id, command_key_sha256),
  FOREIGN KEY (workspace_id, provider_connection_id, environment)
    REFERENCES app.provider_connections (workspace_id, id, environment) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, probed_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT
);
CREATE INDEX zernio_calendar_account_probes_current_idx
  ON app.property_predator_zernio_calendar_account_probes (
    workspace_id, provider_connection_id, network,
    provider_profile_id_sha256, provider_account_id_sha256, probed_at DESC
  );

ALTER TABLE app.property_predator_zernio_calendar_account_probes ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.property_predator_zernio_calendar_account_probes FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app.property_predator_zernio_calendar_account_probes FROM PUBLIC;
GRANT SELECT, INSERT ON app.property_predator_zernio_calendar_account_probes TO r72_zernio_social_definer;
CREATE POLICY zernio_calendar_account_probes_definer_all
  ON app.property_predator_zernio_calendar_account_probes FOR ALL TO r72_zernio_social_definer
  USING (true) WITH CHECK (true);

SET LOCAL ROLE r72_zernio_social_definer;

CREATE FUNCTION app_private.record_zernio_calendar_account_probe(
  p_workspace_id uuid,
  p_provider_connection_id uuid,
  p_network text,
  p_provider_profile_id_sha256 bytea,
  p_provider_account_id_sha256 bytea,
  p_username text,
  p_display_name text,
  p_response_sha256 bytea,
  p_command_key text
) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE
  selected_user uuid;
  selected_key_sha256 bytea;
  selected_request_sha256 bytea;
  existing app.property_predator_zernio_calendar_account_probes%ROWTYPE;
BEGIN
  IF session_user <> 'r72_zernio_social_command'
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'user'
     OR current_setting('app.user_id', true) !~ '^[0-9a-f-]{36}$'
     OR coalesce(current_setting('app.request_id', true), '') = ''
     OR current_setting('transaction_isolation') IS DISTINCT FROM 'serializable'
     OR current_setting('transaction_read_only') IS DISTINCT FROM 'off' THEN
    RAISE EXCEPTION 'Zernio calendar account probe denied' USING ERRCODE = '42501';
  END IF;
  IF p_network <> 'linkedin'
     OR octet_length(p_provider_profile_id_sha256) <> 32
     OR octet_length(p_provider_account_id_sha256) <> 32
     OR octet_length(p_response_sha256) <> 32
     OR p_command_key !~ '^[!-~]{8,200}$'
     OR (p_username IS NOT NULL AND (p_username <> btrim(p_username) OR length(p_username) NOT BETWEEN 1 AND 160))
     OR (p_display_name IS NOT NULL AND (p_display_name <> btrim(p_display_name) OR length(p_display_name) NOT BETWEEN 1 AND 160)) THEN
    RAISE EXCEPTION 'Zernio calendar account probe invalid' USING ERRCODE = '22023';
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
    RAISE EXCEPTION 'Zernio calendar account probe denied' USING ERRCODE = '42501';
  END IF;

  selected_key_sha256 := public.digest(p_command_key, 'sha256');
  selected_request_sha256 := public.digest(pg_catalog.format(
    'propertypredator.zernio-calendar-account-probe/v1|%s|%s|%s|%s|%s|%s',
    p_workspace_id, p_provider_connection_id, p_network,
    encode(p_provider_profile_id_sha256, 'hex'), encode(p_provider_account_id_sha256, 'hex'),
    encode(p_response_sha256, 'hex')
  ), 'sha256');
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'zernio-calendar-account-probe:' || p_workspace_id::text || ':' || encode(selected_key_sha256, 'hex'),
    7200095
  ));
  SELECT probe.* INTO existing
  FROM app.property_predator_zernio_calendar_account_probes probe
  WHERE probe.workspace_id = p_workspace_id AND probe.command_key_sha256 = selected_key_sha256;
  IF FOUND THEN
    IF existing.request_sha256 <> selected_request_sha256 THEN
      RAISE EXCEPTION 'Zernio calendar account probe conflict' USING ERRCODE = '23505';
    END IF;
    RETURN 'replayed';
  END IF;

  INSERT INTO app.property_predator_zernio_calendar_account_probes (
    workspace_id, provider_connection_id, network,
    provider_profile_id_sha256, provider_account_id_sha256,
    username, display_name, response_sha256, command_key_sha256, request_sha256,
    probed_by_user_id, request_id
  ) VALUES (
    p_workspace_id, p_provider_connection_id, p_network,
    p_provider_profile_id_sha256, p_provider_account_id_sha256,
    p_username, p_display_name, p_response_sha256, selected_key_sha256, selected_request_sha256,
    selected_user, current_setting('app.request_id')
  );
  INSERT INTO app.property_predator_zernio_accounts (
    workspace_id, provider_connection_id, provider_profile_id_sha256,
    provider_account_id_sha256, network, username, display_name, status,
    linked_at, last_event_at, created_by_user_id
  ) VALUES (
    p_workspace_id, p_provider_connection_id, p_provider_profile_id_sha256,
    p_provider_account_id_sha256, p_network, p_username, p_display_name, 'active',
    statement_timestamp(), statement_timestamp(), selected_user
  ) ON CONFLICT (workspace_id, provider_connection_id, provider_account_id_sha256)
  DO UPDATE SET username = coalesce(EXCLUDED.username, app.property_predator_zernio_accounts.username),
    display_name = coalesce(EXCLUDED.display_name, app.property_predator_zernio_accounts.display_name),
    status = 'active', last_event_at = statement_timestamp(), updated_at = statement_timestamp()
  WHERE app.property_predator_zernio_accounts.network = EXCLUDED.network
    AND app.property_predator_zernio_accounts.provider_profile_id_sha256 = EXCLUDED.provider_profile_id_sha256;
  RETURN 'recorded';
END
$function$;

CREATE FUNCTION app_private.reserve_zernio_direct_schedule_v2(
  p_workspace_id uuid,
  p_provider_connection_id uuid,
  p_network text,
  p_expected_provider_account_id_sha256 bytea,
  p_content_body text,
  p_media_type text,
  p_media_url text,
  p_scheduled_for timestamptz,
  p_command_key text
) RETURNS TABLE(
  schedule_id uuid, current_state text, provider_external_id text,
  scheduled_for timestamptz, created_now boolean
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE
  selected_user uuid;
  selected_account_id uuid;
  selected_provider_profile_id_sha256 bytea;
  normalized_content text := pg_catalog.btrim(p_content_body);
  normalized_command_key text := pg_catalog.btrim(p_command_key);
  selected_key_sha256 bytea;
  selected_request_sha256 bytea;
  existing app.property_predator_zernio_direct_schedules%ROWTYPE;
  created_id uuid;
BEGIN
  IF session_user <> 'r72_zernio_social_command'
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'user'
     OR current_setting('app.user_id', true) !~ '^[0-9a-f-]{36}$'
     OR coalesce(current_setting('app.request_id', true), '') = ''
     OR current_setting('transaction_isolation') IS DISTINCT FROM 'serializable'
     OR current_setting('transaction_read_only') IS DISTINCT FROM 'off' THEN
    RAISE EXCEPTION 'Zernio direct calendar access denied' USING ERRCODE = '42501';
  END IF;
  IF p_network <> 'linkedin'
     OR octet_length(p_expected_provider_account_id_sha256) <> 32
     OR p_content_body IS NULL OR normalized_content <> p_content_body
     OR length(normalized_content) NOT BETWEEN 1 AND 3000
     OR octet_length(normalized_content) > 12000
     OR normalized_command_key !~ '^[!-~]{8,200}$'
     OR (p_media_type IS NULL) <> (p_media_url IS NULL)
     OR (p_media_type IS NOT NULL AND p_media_type NOT IN ('image', 'video'))
     OR (p_media_url IS NOT NULL AND (p_media_url <> btrim(p_media_url)
       OR length(p_media_url) NOT BETWEEN 10 AND 2048
       OR p_media_url !~ '^https://media[.]zernio[.]com/'))
     OR p_scheduled_for IS NULL
     OR p_scheduled_for < statement_timestamp() + interval '5 minutes'
     OR p_scheduled_for > statement_timestamp() + interval '365 days' THEN
    RAISE EXCEPTION 'Zernio direct calendar input invalid' USING ERRCODE = '22023';
  END IF;
  selected_user := current_setting('app.user_id')::uuid;
  IF NOT EXISTS (
    SELECT 1 FROM app.workspace_memberships membership
    WHERE membership.workspace_id = p_workspace_id AND membership.user_id = selected_user
      AND membership.status = 'active' AND membership.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'Zernio direct calendar access denied' USING ERRCODE = '42501';
  END IF;

  selected_key_sha256 := public.digest(normalized_command_key, 'sha256');
  selected_request_sha256 := public.digest(pg_catalog.format(
    'propertypredator.zernio-direct-calendar/v2|%s|%s|%s|%s|%s|%s|%s|%s',
    p_workspace_id, p_provider_connection_id, p_network,
    encode(p_expected_provider_account_id_sha256, 'hex'),
    encode(public.digest(normalized_content, 'sha256'), 'hex'),
    coalesce(p_media_type, ''), coalesce(p_media_url, ''),
    pg_catalog.floor(pg_catalog.date_part('epoch', p_scheduled_for) * 1000000)::bigint
  ), 'sha256');
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'zernio-direct-calendar-v2:' || p_workspace_id::text || ':' || encode(selected_key_sha256, 'hex'),
    7200095
  ));
  SELECT schedule.* INTO existing
  FROM app.property_predator_zernio_direct_schedules schedule
  WHERE schedule.workspace_id = p_workspace_id AND schedule.idempotency_key_sha256 = selected_key_sha256;
  IF FOUND THEN
    IF existing.request_sha256 <> selected_request_sha256 THEN
      RAISE EXCEPTION 'Zernio direct calendar command key conflict' USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT existing.id, existing.state, existing.provider_external_id,
      existing.scheduled_for, false;
    RETURN;
  END IF;

  SELECT account.id, account.provider_profile_id_sha256
    INTO selected_account_id, selected_provider_profile_id_sha256
  FROM app.property_predator_zernio_accounts account
  JOIN app.provider_connections connection
    ON connection.workspace_id = account.workspace_id
   AND connection.id = account.provider_connection_id
   AND connection.environment = account.environment
  WHERE account.workspace_id = p_workspace_id
    AND account.provider_connection_id = p_provider_connection_id
    AND account.network = p_network
    AND account.provider_account_id_sha256 = p_expected_provider_account_id_sha256
    AND account.environment = 'live' AND account.status = 'active'
    AND connection.provider_id = 'zernio' AND connection.provider_kind = 'social'
    AND connection.environment = 'live' AND connection.status = 'active'
    AND EXISTS (
      SELECT 1 FROM app.property_predator_zernio_calendar_account_probes probe
      WHERE probe.workspace_id = account.workspace_id
        AND probe.provider_connection_id = account.provider_connection_id
        AND probe.network = account.network
        AND probe.provider_profile_id_sha256 = account.provider_profile_id_sha256
        AND probe.provider_account_id_sha256 = account.provider_account_id_sha256
        AND probe.probed_at >= statement_timestamp() - interval '24 hours'
    )
  FOR UPDATE OF account, connection;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Zernio direct calendar account not ready' USING ERRCODE = '55000';
  END IF;

  IF (SELECT count(*) FROM app.property_predator_zernio_direct_schedules schedule
      WHERE schedule.workspace_id = p_workspace_id AND schedule.zernio_account_id = selected_account_id
        AND schedule.state <> 'cancelled'
        AND schedule.scheduled_for >= date_trunc('day', p_scheduled_for AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
        AND schedule.scheduled_for < (date_trunc('day', p_scheduled_for AT TIME ZONE 'UTC') + interval '1 day') AT TIME ZONE 'UTC') >= 25
     OR (SELECT count(*) FROM app.property_predator_zernio_direct_schedules schedule
      WHERE schedule.workspace_id = p_workspace_id AND schedule.zernio_account_id = selected_account_id
        AND schedule.state <> 'cancelled'
        AND schedule.scheduled_for >= date_trunc('month', p_scheduled_for AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
        AND schedule.scheduled_for < (date_trunc('month', p_scheduled_for AT TIME ZONE 'UTC') + interval '1 month') AT TIME ZONE 'UTC') >= 250 THEN
    RAISE EXCEPTION 'Zernio direct calendar cap reached' USING ERRCODE = '23514';
  END IF;

  created_id := gen_random_uuid();
  INSERT INTO app.property_predator_zernio_direct_schedules (
    id, workspace_id, provider_connection_id, zernio_account_id, network,
    provider_profile_id_sha256, provider_account_id_sha256, content_body,
    media_type, media_url, scheduled_for, idempotency_key_sha256, request_sha256,
    created_by_user_id, created_request_id
  ) VALUES (
    created_id, p_workspace_id, p_provider_connection_id, selected_account_id, p_network,
    selected_provider_profile_id_sha256, p_expected_provider_account_id_sha256, normalized_content,
    p_media_type, p_media_url, p_scheduled_for, selected_key_sha256, selected_request_sha256,
    selected_user, current_setting('app.request_id')
  );
  RETURN QUERY SELECT created_id, 'reserved'::text, NULL::text, p_scheduled_for, true;
END
$function$;

RESET ROLE;
SET LOCAL ROLE r72_owner;

REVOKE ALL ON FUNCTION app_private.record_zernio_calendar_account_probe(
  uuid,uuid,text,bytea,bytea,text,text,bytea,text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.reserve_zernio_direct_schedule_v2(
  uuid,uuid,text,bytea,text,text,text,timestamptz,text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.record_zernio_calendar_account_probe(
  uuid,uuid,text,bytea,bytea,text,text,bytea,text
) TO r72_zernio_social_command;
GRANT EXECUTE ON FUNCTION app_private.reserve_zernio_direct_schedule_v2(
  uuid,uuid,text,bytea,text,text,text,timestamptz,text
) TO r72_zernio_social_command;
REVOKE EXECUTE ON FUNCTION app_private.reserve_zernio_direct_schedule(
  uuid,uuid,text,bytea,text,timestamptz,text
) FROM r72_zernio_social_command;

DO $audit$
BEGIN
  IF NOT pg_catalog.has_function_privilege(
      'r72_zernio_social_command',
      'app_private.record_zernio_calendar_account_probe(uuid,uuid,text,bytea,bytea,text,text,bytea,text)',
      'EXECUTE'
    ) OR NOT pg_catalog.has_function_privilege(
      'r72_zernio_social_command',
      'app_private.reserve_zernio_direct_schedule_v2(uuid,uuid,text,bytea,text,text,text,timestamp with time zone,text)',
      'EXECUTE'
    ) OR pg_catalog.has_function_privilege(
      'r72_zernio_social_command',
      'app_private.reserve_zernio_direct_schedule(uuid,uuid,text,bytea,text,timestamp with time zone,text)',
      'EXECUTE'
    ) THEN
    RAISE EXCEPTION 'Zernio calendar v2 function ACL is not exact';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_class relation
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname IN ('app', 'app_private') AND relation.relkind IN ('r','p','v','m','f')
      AND (pg_catalog.has_table_privilege('r72_zernio_social_command', relation.oid, 'SELECT')
        OR pg_catalog.has_table_privilege('r72_zernio_social_command', relation.oid, 'INSERT')
        OR pg_catalog.has_table_privilege('r72_zernio_social_command', relation.oid, 'UPDATE')
        OR pg_catalog.has_table_privilege('r72_zernio_social_command', relation.oid, 'DELETE')
        OR pg_catalog.has_table_privilege('r72_zernio_social_command', relation.oid, 'TRUNCATE'))
  ) THEN
    RAISE EXCEPTION 'Zernio social command role gained table capability';
  END IF;
END
$audit$;
