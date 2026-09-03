-- Repair the live calendar reservation lock without widening the definer's
-- table privileges. 0095 attempted SELECT ... FOR UPDATE against connected
-- account/provider rows while its exact definer intentionally held SELECT
-- only. PostgreSQL therefore rejected an otherwise-authorised founder before
-- any provider call. A per-account transaction advisory lock serialises cap
-- checks without granting mutation rights over provider connection truth.

SET LOCAL ROLE r72_owner;
GRANT CREATE ON SCHEMA app_private TO r72_owned_social_definer;
SET LOCAL ROLE r72_owned_social_definer;

CREATE OR REPLACE FUNCTION app_private.reserve_zernio_direct_schedule_v2(
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

  -- Every new reservation for this exact workspace/account serialises here.
  -- That preserves the daily/monthly cap fence without UPDATE privilege on
  -- provider or account rows, which this definer must never receive.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'zernio-direct-calendar-account:' || p_workspace_id::text || ':'
      || encode(p_expected_provider_account_id_sha256, 'hex'),
    7200096
  ));
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
    );
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
REVOKE CREATE ON SCHEMA app_private FROM r72_owned_social_definer;

DO $audit$
BEGIN
  IF NOT pg_catalog.has_function_privilege(
      'r72_zernio_social_command',
      'app_private.reserve_zernio_direct_schedule_v2(uuid,uuid,text,bytea,text,text,text,timestamp with time zone,text)',
      'EXECUTE'
    ) THEN
    RAISE EXCEPTION 'Zernio direct calendar reservation is not executable by its command role';
  END IF;
  IF pg_catalog.has_table_privilege('r72_owned_social_definer', 'app.provider_connections', 'UPDATE')
     OR pg_catalog.has_table_privilege('r72_owned_social_definer', 'app.property_predator_zernio_accounts', 'UPDATE') THEN
    RAISE EXCEPTION 'Zernio direct calendar lock repair widened provider truth privileges';
  END IF;
END
$audit$;
