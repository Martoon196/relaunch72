-- Founder-operated social calendar: reserve one exact connected account,
-- call Zernio outside the database, then append a sanitised provider receipt.
-- No provider credential or clear provider account identifier enters Postgres.

SET LOCAL ROLE r72_owner;

CREATE TABLE app.property_predator_zernio_direct_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  provider_connection_id uuid NOT NULL,
  zernio_account_id uuid NOT NULL,
  network text NOT NULL CHECK (network = 'linkedin'),
  provider_profile_id_sha256 bytea NOT NULL CHECK (octet_length(provider_profile_id_sha256) = 32),
  provider_account_id_sha256 bytea NOT NULL CHECK (octet_length(provider_account_id_sha256) = 32),
  content_body text NOT NULL CHECK (
    content_body = btrim(content_body)
    AND length(content_body) BETWEEN 1 AND 3000
    AND octet_length(content_body) <= 12000
  ),
  content_sha256 bytea GENERATED ALWAYS AS (public.digest(content_body, 'sha256')) STORED,
  scheduled_for timestamptz NOT NULL,
  idempotency_key_sha256 bytea NOT NULL CHECK (octet_length(idempotency_key_sha256) = 32),
  request_sha256 bytea NOT NULL CHECK (octet_length(request_sha256) = 32),
  state text NOT NULL DEFAULT 'reserved' CHECK (
    state IN ('reserved', 'scheduled', 'failed', 'outcome_unknown', 'cancelled')
  ),
  provider_external_id text CHECK (
    provider_external_id IS NULL OR provider_external_id ~ '^[A-Za-z0-9_-]{1,200}$'
  ),
  created_by_user_id uuid NOT NULL,
  created_request_id text NOT NULL CHECK (
    created_request_id = btrim(created_request_id)
    AND length(created_request_id) BETWEEN 1 AND 128
  ),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  settled_at timestamptz,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, idempotency_key_sha256),
  UNIQUE (workspace_id, provider_external_id),
  FOREIGN KEY (
    workspace_id, zernio_account_id, provider_connection_id, network,
    provider_profile_id_sha256, provider_account_id_sha256
  ) REFERENCES app.property_predator_zernio_accounts (
    workspace_id, id, provider_connection_id, network,
    provider_profile_id_sha256, provider_account_id_sha256
  ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, created_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK ((state = 'reserved') = (settled_at IS NULL)),
  CHECK ((state = 'scheduled') = (provider_external_id IS NOT NULL))
);

CREATE TABLE app.property_predator_zernio_direct_schedule_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  schedule_id uuid NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('scheduled', 'failed', 'outcome_unknown')),
  provider_external_id text CHECK (
    provider_external_id IS NULL OR provider_external_id ~ '^[A-Za-z0-9_-]{1,200}$'
  ),
  receipt_sha256 bytea NOT NULL CHECK (octet_length(receipt_sha256) = 32),
  safe_code text NOT NULL CHECK (safe_code ~ '^[a-z][a-z0-9_.:-]{0,99}$'),
  provider_occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, schedule_id),
  FOREIGN KEY (workspace_id, schedule_id)
    REFERENCES app.property_predator_zernio_direct_schedules (workspace_id, id)
    ON DELETE RESTRICT
);

CREATE INDEX property_predator_zernio_direct_schedules_calendar_idx
  ON app.property_predator_zernio_direct_schedules
    (workspace_id, scheduled_for, created_at, id);

CREATE TRIGGER property_predator_zernio_direct_schedule_receipts_immutable
  BEFORE UPDATE OR DELETE ON app.property_predator_zernio_direct_schedule_receipts
  FOR EACH ROW EXECUTE FUNCTION app_private.owned_social_immutable_guard();

ALTER TABLE app.property_predator_zernio_direct_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.property_predator_zernio_direct_schedules FORCE ROW LEVEL SECURITY;
ALTER TABLE app.property_predator_zernio_direct_schedule_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.property_predator_zernio_direct_schedule_receipts FORCE ROW LEVEL SECURITY;

CREATE POLICY zernio_direct_schedules_owner_all
  ON app.property_predator_zernio_direct_schedules FOR ALL TO r72_owner
  USING (true) WITH CHECK (true);
CREATE POLICY zernio_direct_schedule_receipts_owner_all
  ON app.property_predator_zernio_direct_schedule_receipts FOR ALL TO r72_owner
  USING (true) WITH CHECK (true);

GRANT CREATE ON SCHEMA app_private TO r72_owned_social_definer;
GRANT SELECT, INSERT, UPDATE ON app.property_predator_zernio_direct_schedules
  TO r72_owned_social_definer;
GRANT SELECT, INSERT ON app.property_predator_zernio_direct_schedule_receipts
  TO r72_owned_social_definer;

CREATE POLICY zernio_direct_schedules_definer_all
  ON app.property_predator_zernio_direct_schedules FOR ALL TO r72_owned_social_definer
  USING (true) WITH CHECK (true);
CREATE POLICY zernio_direct_schedule_receipts_definer_all
  ON app.property_predator_zernio_direct_schedule_receipts FOR ALL TO r72_owned_social_definer
  USING (true) WITH CHECK (true);

SET LOCAL ROLE r72_owned_social_definer;

CREATE FUNCTION app_private.reserve_zernio_direct_schedule(
  p_workspace_id uuid,
  p_provider_connection_id uuid,
  p_network text,
  p_expected_provider_account_id_sha256 bytea,
  p_content_body text,
  p_scheduled_for timestamptz,
  p_command_key text
) RETURNS TABLE(
  schedule_id uuid,
  current_state text,
  provider_external_id text,
  scheduled_for timestamptz,
  created_now boolean
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
     OR current_setting('transaction_read_only') IS DISTINCT FROM 'off'
     OR p_network <> 'linkedin'
     OR p_expected_provider_account_id_sha256 IS NULL
     OR octet_length(p_expected_provider_account_id_sha256) <> 32
     OR p_content_body IS NULL OR normalized_content <> p_content_body
     OR length(normalized_content) NOT BETWEEN 1 AND 3000
     OR octet_length(normalized_content) > 12000
     OR normalized_command_key !~ '^[!-~]{8,200}$'
     OR p_scheduled_for IS NULL
     OR p_scheduled_for < statement_timestamp() + interval '5 minutes'
     OR p_scheduled_for > statement_timestamp() + interval '365 days' THEN
    RAISE EXCEPTION 'Zernio direct calendar command denied' USING ERRCODE = '42501';
  END IF;

  selected_user := current_setting('app.user_id')::uuid;
  IF NOT EXISTS (
    SELECT 1 FROM app.workspace_memberships AS membership
    WHERE membership.workspace_id = p_workspace_id
      AND membership.user_id = selected_user
      AND membership.status = 'active'
      AND membership.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'Zernio direct calendar command denied' USING ERRCODE = '42501';
  END IF;

  selected_key_sha256 := public.digest(normalized_command_key, 'sha256');
  selected_request_sha256 := public.digest(pg_catalog.format(
    'propertypredator.zernio-direct-calendar/v1|%s|%s|%s|%s|%s|%s',
    p_workspace_id, p_provider_connection_id, p_network,
    encode(p_expected_provider_account_id_sha256, 'hex'),
    encode(public.digest(normalized_content, 'sha256'), 'hex'),
    pg_catalog.floor(pg_catalog.date_part('epoch', p_scheduled_for) * 1000000)::bigint
  ), 'sha256');

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'zernio-direct-calendar:' || p_workspace_id::text || ':'
        || encode(selected_key_sha256, 'hex'), 7200094
    )
  );

  SELECT schedule.* INTO existing
  FROM app.property_predator_zernio_direct_schedules AS schedule
  WHERE schedule.workspace_id = p_workspace_id
    AND schedule.idempotency_key_sha256 = selected_key_sha256;
  IF FOUND THEN
    IF existing.request_sha256 <> selected_request_sha256 THEN
      RAISE EXCEPTION 'Zernio direct calendar command key conflict'
        USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT existing.id, existing.state, existing.provider_external_id,
      existing.scheduled_for, false;
    RETURN;
  END IF;

  SELECT account.id, account.provider_profile_id_sha256
    INTO selected_account_id, selected_provider_profile_id_sha256
  FROM app.property_predator_zernio_accounts AS account
  JOIN app.provider_connections AS connection
    ON connection.workspace_id = account.workspace_id
   AND connection.id = account.provider_connection_id
   AND connection.environment = account.environment
  WHERE account.workspace_id = p_workspace_id
    AND account.provider_connection_id = p_provider_connection_id
    AND account.network = p_network
    AND account.provider_account_id_sha256 = p_expected_provider_account_id_sha256
    AND account.status = 'active'
    AND connection.provider_id = 'zernio'
    AND connection.provider_kind = 'social'
    AND connection.environment = 'live'
    AND connection.status = 'active'
    AND EXISTS (
      SELECT 1
      FROM app.property_predator_zernio_account_webhook_receipts AS connected
      WHERE connected.workspace_id = account.workspace_id
        AND connected.provider_connection_id = account.provider_connection_id
        AND connected.event_type = 'account.connected'
        AND connected.network = account.network
        AND connected.provider_profile_id_sha256 = account.provider_profile_id_sha256
        AND connected.provider_account_id_sha256 = account.provider_account_id_sha256
        AND NOT EXISTS (
          SELECT 1
          FROM app.property_predator_zernio_account_webhook_receipts AS disconnected
          WHERE disconnected.workspace_id = connected.workspace_id
            AND disconnected.provider_connection_id = connected.provider_connection_id
            AND disconnected.event_type = 'account.disconnected'
            AND disconnected.network = connected.network
            AND disconnected.provider_profile_id_sha256 = connected.provider_profile_id_sha256
            AND disconnected.provider_account_id_sha256 = connected.provider_account_id_sha256
            AND disconnected.occurred_at >= connected.occurred_at
        )
    )
  FOR UPDATE OF account, connection;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Zernio direct calendar account denied' USING ERRCODE = '42501';
  END IF;

  IF (SELECT count(*) FROM app.property_predator_zernio_direct_schedules AS schedule
      WHERE schedule.workspace_id = p_workspace_id
        AND schedule.zernio_account_id = selected_account_id
        AND schedule.state <> 'cancelled'
        AND schedule.scheduled_for >= date_trunc('day', p_scheduled_for AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
        AND schedule.scheduled_for < (date_trunc('day', p_scheduled_for AT TIME ZONE 'UTC') + interval '1 day') AT TIME ZONE 'UTC') >= 25
     OR (SELECT count(*) FROM app.property_predator_zernio_direct_schedules AS schedule
      WHERE schedule.workspace_id = p_workspace_id
        AND schedule.zernio_account_id = selected_account_id
        AND schedule.state <> 'cancelled'
        AND schedule.scheduled_for >= date_trunc('month', p_scheduled_for AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
        AND schedule.scheduled_for < (date_trunc('month', p_scheduled_for AT TIME ZONE 'UTC') + interval '1 month') AT TIME ZONE 'UTC') >= 250 THEN
    RAISE EXCEPTION 'Zernio direct calendar cap reached' USING ERRCODE = '23514';
  END IF;

  created_id := gen_random_uuid();
  INSERT INTO app.property_predator_zernio_direct_schedules (
    id, workspace_id, provider_connection_id, zernio_account_id, network,
    provider_profile_id_sha256, provider_account_id_sha256, content_body,
    scheduled_for, idempotency_key_sha256, request_sha256,
    created_by_user_id, created_request_id
  ) VALUES (
    created_id, p_workspace_id, p_provider_connection_id, selected_account_id, p_network,
    selected_provider_profile_id_sha256, p_expected_provider_account_id_sha256,
    normalized_content, p_scheduled_for, selected_key_sha256, selected_request_sha256,
    selected_user, current_setting('app.request_id')
  );
  RETURN QUERY SELECT created_id, 'reserved'::text, NULL::text, p_scheduled_for, true;
END
$function$;

CREATE FUNCTION app_private.settle_zernio_direct_schedule(
  p_workspace_id uuid,
  p_schedule_id uuid,
  p_outcome text,
  p_provider_external_id text,
  p_receipt_sha256 bytea,
  p_safe_code text,
  p_provider_occurred_at timestamptz
) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE selected app.property_predator_zernio_direct_schedules%ROWTYPE;
  existing app.property_predator_zernio_direct_schedule_receipts%ROWTYPE;
BEGIN
  IF session_user <> 'r72_zernio_social_command'
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'user'
     OR current_setting('app.user_id', true) !~ '^[0-9a-f-]{36}$'
     OR coalesce(current_setting('app.request_id', true), '') = ''
     OR p_outcome NOT IN ('scheduled', 'failed', 'outcome_unknown')
     OR (p_outcome = 'scheduled' AND p_provider_external_id IS NULL)
     OR (p_provider_external_id IS NOT NULL
       AND p_provider_external_id !~ '^[A-Za-z0-9_-]{1,200}$')
     OR p_receipt_sha256 IS NULL OR octet_length(p_receipt_sha256) <> 32
     OR p_safe_code !~ '^[a-z][a-z0-9_.:-]{0,99}$'
     OR p_provider_occurred_at IS NULL
     OR p_provider_occurred_at > statement_timestamp() + interval '5 minutes' THEN
    RAISE EXCEPTION 'Zernio direct calendar settlement denied' USING ERRCODE = '42501';
  END IF;

  SELECT schedule.* INTO selected
  FROM app.property_predator_zernio_direct_schedules AS schedule
  WHERE schedule.workspace_id = p_workspace_id AND schedule.id = p_schedule_id
    AND schedule.created_by_user_id = current_setting('app.user_id')::uuid
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Zernio direct calendar settlement denied' USING ERRCODE = '42501';
  END IF;

  SELECT receipt.* INTO existing
  FROM app.property_predator_zernio_direct_schedule_receipts AS receipt
  WHERE receipt.workspace_id = p_workspace_id AND receipt.schedule_id = p_schedule_id;
  IF FOUND THEN
    IF existing.outcome <> p_outcome
       OR existing.provider_external_id IS DISTINCT FROM p_provider_external_id
       OR existing.receipt_sha256 <> p_receipt_sha256
       OR existing.safe_code <> p_safe_code
       OR existing.provider_occurred_at <> p_provider_occurred_at THEN
      RAISE EXCEPTION 'Zernio direct calendar settlement conflict' USING ERRCODE = '40001';
    END IF;
    RETURN 'replayed';
  END IF;

  IF selected.state <> 'reserved' THEN
    RAISE EXCEPTION 'Zernio direct calendar settlement conflict' USING ERRCODE = '40001';
  END IF;
  INSERT INTO app.property_predator_zernio_direct_schedule_receipts (
    workspace_id, schedule_id, outcome, provider_external_id,
    receipt_sha256, safe_code, provider_occurred_at
  ) VALUES (
    p_workspace_id, p_schedule_id, p_outcome, p_provider_external_id,
    p_receipt_sha256, p_safe_code, p_provider_occurred_at
  );
  UPDATE app.property_predator_zernio_direct_schedules SET
    state = p_outcome,
    provider_external_id = p_provider_external_id,
    settled_at = statement_timestamp()
  WHERE workspace_id = p_workspace_id AND id = p_schedule_id;
  RETURN 'applied';
END
$function$;

CREATE FUNCTION app_private.list_zernio_direct_schedules(
  p_workspace_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_limit integer
) RETURNS TABLE(
  schedule_id uuid,
  network text,
  content_body text,
  scheduled_for timestamptz,
  state text,
  provider_external_id text,
  safe_code text,
  created_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $function$
  SELECT schedule.id, schedule.network, schedule.content_body,
    schedule.scheduled_for, schedule.state, schedule.provider_external_id,
    receipt.safe_code, schedule.created_at
  FROM app.property_predator_zernio_direct_schedules AS schedule
  LEFT JOIN app.property_predator_zernio_direct_schedule_receipts AS receipt
    ON receipt.workspace_id = schedule.workspace_id
   AND receipt.schedule_id = schedule.id
  WHERE session_user = 'r72_zernio_social_command'
    AND current_setting('app.workspace_id', true) = p_workspace_id::text
    AND current_setting('app.actor_kind', true) = 'user'
    AND current_setting('app.user_id', true) ~ '^[0-9a-f-]{36}$'
    AND p_from IS NOT NULL AND p_to IS NOT NULL AND p_from < p_to
    AND p_limit BETWEEN 1 AND 100
    AND schedule.workspace_id = p_workspace_id
    AND schedule.scheduled_for >= p_from AND schedule.scheduled_for < p_to
    AND EXISTS (
      SELECT 1 FROM app.workspace_memberships AS membership
      WHERE membership.workspace_id = schedule.workspace_id
        AND membership.user_id = current_setting('app.user_id')::uuid
        AND membership.status = 'active'
    )
  ORDER BY schedule.scheduled_for, schedule.created_at, schedule.id
  LIMIT p_limit;
$function$;

REVOKE ALL ON FUNCTION app_private.reserve_zernio_direct_schedule(
  uuid,uuid,text,bytea,text,timestamptz,text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.settle_zernio_direct_schedule(
  uuid,uuid,text,text,bytea,text,timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.list_zernio_direct_schedules(
  uuid,timestamptz,timestamptz,integer
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.reserve_zernio_direct_schedule(
  uuid,uuid,text,bytea,text,timestamptz,text
) TO r72_zernio_social_command;
GRANT EXECUTE ON FUNCTION app_private.settle_zernio_direct_schedule(
  uuid,uuid,text,text,bytea,text,timestamptz
) TO r72_zernio_social_command;
GRANT EXECUTE ON FUNCTION app_private.list_zernio_direct_schedules(
  uuid,timestamptz,timestamptz,integer
) TO r72_zernio_social_command;

RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_owned_social_definer;

DO $audit$
BEGIN
  IF NOT pg_catalog.has_function_privilege(
      'r72_zernio_social_command',
      'app_private.reserve_zernio_direct_schedule(uuid,uuid,text,bytea,text,timestamp with time zone,text)',
      'EXECUTE'
    ) OR NOT pg_catalog.has_function_privilege(
      'r72_zernio_social_command',
      'app_private.settle_zernio_direct_schedule(uuid,uuid,text,text,bytea,text,timestamp with time zone)',
      'EXECUTE'
    ) OR NOT pg_catalog.has_function_privilege(
      'r72_zernio_social_command',
      'app_private.list_zernio_direct_schedules(uuid,timestamp with time zone,timestamp with time zone,integer)',
      'EXECUTE'
    ) THEN
    RAISE EXCEPTION 'Zernio direct calendar functions are not executable by the command role';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname IN ('app', 'app_private')
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND (
        pg_catalog.has_table_privilege('r72_zernio_social_command', relation.oid, 'SELECT')
        OR pg_catalog.has_table_privilege('r72_zernio_social_command', relation.oid, 'INSERT')
        OR pg_catalog.has_table_privilege('r72_zernio_social_command', relation.oid, 'UPDATE')
        OR pg_catalog.has_table_privilege('r72_zernio_social_command', relation.oid, 'DELETE')
        OR pg_catalog.has_table_privilege('r72_zernio_social_command', relation.oid, 'TRUNCATE')
      )
  ) THEN
    RAISE EXCEPTION 'Zernio social command role is not table-blind';
  END IF;
END
$audit$;
