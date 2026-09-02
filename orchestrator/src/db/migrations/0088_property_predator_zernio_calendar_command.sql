-- One atomic calendar-to-Zernio command boundary.
--
-- The portal supplies immutable calendar evidence plus SHA-256 digests of the
-- configured Zernio profile/account references. Postgres selects the exact
-- active connected account, derives the publish capability and job digests,
-- creates or reuses the immutable 0085 binding, and enqueues through the 0085
-- state machine in the caller's serializable transaction. No provider secret
-- or provider call is part of this boundary.

SET LOCAL ROLE r72_owner;
GRANT CREATE ON SCHEMA app_private TO r72_owned_social_definer;
SET LOCAL ROLE r72_owned_social_definer;

CREATE FUNCTION app_private.enqueue_zernio_calendar_from_connected_account(
  p_workspace_id uuid,
  p_provider_connection_id uuid,
  p_network text,
  p_expected_provider_profile_id_sha256 bytea,
  p_expected_provider_account_id_sha256 bytea,
  p_planning_intent_id uuid,
  p_planning_target_id uuid,
  p_content_item_id uuid,
  p_content_version_id uuid,
  p_approval_request_id uuid,
  p_approval_decision_id uuid,
  p_source_attestation_id uuid,
  p_operation_tag text,
  p_scheduled_for timestamptz
) RETURNS TABLE(
  job_id uuid,
  idempotency_key_sha256 bytea,
  daily_publish_cap integer,
  monthly_publish_cap integer
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE
  selected_user uuid;
  selected_account record;
  selected_binding_id uuid;
  selected_binding_count integer;
  selected_content record;
  selected_capability_sha256 bytea;
  selected_idempotency_sha256 bytea;
  selected_request_sha256 bytea;
  selected_job_id uuid;
  selected_verified_at timestamptz := statement_timestamp();
BEGIN
  IF session_user <> 'r72_zernio_social_command'
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'user'
     OR current_setting('app.user_id', true) !~ '^[0-9a-f-]{36}$'
     OR coalesce(current_setting('app.request_id', true), '') = ''
     OR current_setting('transaction_isolation') IS DISTINCT FROM 'serializable'
     OR current_setting('transaction_read_only') IS DISTINCT FROM 'off'
     OR p_network NOT IN ('instagram', 'linkedin')
     OR p_expected_provider_profile_id_sha256 IS NULL
     OR octet_length(p_expected_provider_profile_id_sha256) <> 32
     OR p_expected_provider_account_id_sha256 IS NULL
     OR octet_length(p_expected_provider_account_id_sha256) <> 32
     OR p_planning_intent_id IS NULL OR p_planning_target_id IS NULL
     OR p_content_item_id IS NULL OR p_content_version_id IS NULL
     OR p_approval_request_id IS NULL OR p_approval_decision_id IS NULL
     OR p_source_attestation_id IS NULL
     OR p_operation_tag IS NULL
     OR p_operation_tag !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$'
     OR p_scheduled_for IS NULL THEN
    RAISE EXCEPTION 'Zernio calendar command denied' USING ERRCODE = '42501';
  END IF;

  selected_user := current_setting('app.user_id')::uuid;
  IF NOT EXISTS (
    SELECT 1
    FROM app.workspace_memberships AS membership
    WHERE membership.workspace_id = p_workspace_id
      AND membership.user_id = selected_user
      AND membership.status = 'active'
      AND membership.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'Zernio calendar command denied' USING ERRCODE = '42501';
  END IF;

  -- Serialize every command for this exact configured provider account before
  -- selecting connection evidence. The enclosing portal transaction is also
  -- SERIALIZABLE, so a concurrent disconnect/reconnect cannot be ignored.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'zernio-calendar-connected-command:' || p_workspace_id::text || ':'
        || p_provider_connection_id::text || ':' || p_network || ':'
        || encode(p_expected_provider_account_id_sha256, 'hex'),
      7200088
    )
  );

  SELECT
    account.id AS zernio_account_id,
    account.provider_profile_id_sha256,
    account.provider_account_id_sha256,
    connected_receipt.receipt_sha256 AS ownership_evidence_sha256
  INTO selected_account
  FROM app.property_predator_zernio_accounts AS account
  JOIN app.provider_connections AS connection
    ON connection.workspace_id = account.workspace_id
   AND connection.id = account.provider_connection_id
   AND connection.environment = account.environment
  JOIN LATERAL (
    SELECT receipt.receipt_sha256
    FROM app.property_predator_zernio_account_webhook_receipts AS receipt
    WHERE receipt.workspace_id = account.workspace_id
      AND receipt.provider_connection_id = account.provider_connection_id
      AND receipt.event_type = 'account.connected'
      AND receipt.network = account.network
      AND receipt.provider_profile_id_sha256 = account.provider_profile_id_sha256
      AND receipt.provider_account_id_sha256 = account.provider_account_id_sha256
      AND NOT EXISTS (
        SELECT 1
        FROM app.property_predator_zernio_account_webhook_receipts AS disconnected_receipt
        WHERE disconnected_receipt.workspace_id = receipt.workspace_id
          AND disconnected_receipt.provider_connection_id = receipt.provider_connection_id
          AND disconnected_receipt.event_type = 'account.disconnected'
          AND disconnected_receipt.network = receipt.network
          AND disconnected_receipt.provider_profile_id_sha256 = receipt.provider_profile_id_sha256
          AND disconnected_receipt.provider_account_id_sha256 = receipt.provider_account_id_sha256
          AND disconnected_receipt.occurred_at >= receipt.occurred_at
      )
    ORDER BY receipt.occurred_at DESC, receipt.received_at DESC, receipt.event_id DESC
    LIMIT 1
  ) AS connected_receipt ON true
  WHERE account.workspace_id = p_workspace_id
    AND account.provider_connection_id = p_provider_connection_id
    AND account.network = p_network
    AND account.provider_profile_id_sha256 = p_expected_provider_profile_id_sha256
    AND account.provider_account_id_sha256 = p_expected_provider_account_id_sha256
    AND account.status = 'active'
    AND connection.provider_id = 'zernio'
    AND connection.provider_kind = 'social'
    AND connection.environment = 'live'
    AND connection.status = 'active';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Zernio calendar connected account denied' USING ERRCODE = '42501';
  END IF;

  selected_capability_sha256 := public.digest(pg_catalog.format(
    'propertypredator.zernio-calendar-publish-capability/v1|%s|%s|%s|%s|%s|%s|%s',
    p_workspace_id,
    p_provider_connection_id,
    selected_account.zernio_account_id,
    p_network,
    encode(selected_account.provider_profile_id_sha256, 'hex'),
    encode(selected_account.provider_account_id_sha256, 'hex'),
    encode(selected_account.ownership_evidence_sha256, 'hex')
  ), 'sha256');

  -- Match the 0085 binding-creation lock exactly. Existing bindings are
  -- reusable only when they prove this exact latest connected receipt and the
  -- server-derived capability. A stale/manual active binding fails closed and
  -- must be explicitly revoked before a replacement can be recorded.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'zernio-calendar-binding:' || p_workspace_id::text || ':'
        || selected_account.zernio_account_id::text || ':' || p_network,
      7200085
    )
  );

  SELECT count(*)::integer
  INTO selected_binding_count
  FROM app.property_predator_zernio_publish_bindings AS binding
  WHERE binding.workspace_id = p_workspace_id
    AND binding.provider_connection_id = p_provider_connection_id
    AND binding.zernio_account_id = selected_account.zernio_account_id
    AND binding.provider_id = 'zernio'
    AND binding.network = p_network
    AND binding.provider_profile_id_sha256 = selected_account.provider_profile_id_sha256
    AND binding.provider_account_id_sha256 = selected_account.provider_account_id_sha256
    AND binding.publish_capability_evidence_sha256 = selected_capability_sha256
    AND binding.ownership_evidence_sha256 = selected_account.ownership_evidence_sha256
    AND NOT EXISTS (
      SELECT 1
      FROM app.property_predator_zernio_publish_binding_revocations AS revocation
      WHERE revocation.workspace_id = binding.workspace_id
        AND revocation.binding_id = binding.id
    );

  IF selected_binding_count > 1 THEN
    RAISE EXCEPTION 'Zernio calendar publish binding is ambiguous' USING ERRCODE = '40001';
  ELSIF selected_binding_count = 1 THEN
    SELECT binding.id
    INTO selected_binding_id
    FROM app.property_predator_zernio_publish_bindings AS binding
    WHERE binding.workspace_id = p_workspace_id
      AND binding.provider_connection_id = p_provider_connection_id
      AND binding.zernio_account_id = selected_account.zernio_account_id
      AND binding.provider_id = 'zernio'
      AND binding.network = p_network
      AND binding.provider_profile_id_sha256 = selected_account.provider_profile_id_sha256
      AND binding.provider_account_id_sha256 = selected_account.provider_account_id_sha256
      AND binding.publish_capability_evidence_sha256 = selected_capability_sha256
      AND binding.ownership_evidence_sha256 = selected_account.ownership_evidence_sha256
      AND NOT EXISTS (
        SELECT 1
        FROM app.property_predator_zernio_publish_binding_revocations AS revocation
        WHERE revocation.workspace_id = binding.workspace_id
          AND revocation.binding_id = binding.id
      );
  ELSE
    IF EXISTS (
      SELECT 1
      FROM app.property_predator_zernio_publish_bindings AS binding
      WHERE binding.workspace_id = p_workspace_id
        AND binding.provider_connection_id = p_provider_connection_id
        AND binding.zernio_account_id = selected_account.zernio_account_id
        AND binding.provider_id = 'zernio'
        AND binding.network = p_network
        AND NOT EXISTS (
          SELECT 1
          FROM app.property_predator_zernio_publish_binding_revocations AS revocation
          WHERE revocation.workspace_id = binding.workspace_id
            AND revocation.binding_id = binding.id
        )
    ) THEN
      RAISE EXCEPTION 'Zernio calendar active binding evidence is stale'
        USING ERRCODE = '40001';
    END IF;

    selected_binding_id := gen_random_uuid();
    selected_binding_id := app_private.record_zernio_calendar_publish_binding(
      p_workspace_id,
      p_provider_connection_id,
      selected_binding_id,
      selected_account.zernio_account_id,
      p_network,
      selected_account.provider_profile_id_sha256,
      selected_account.provider_account_id_sha256,
      selected_capability_sha256,
      selected_account.ownership_evidence_sha256,
      selected_verified_at
    );
  END IF;

  -- Content rows are immutable. Reading the exact selected version here lets
  -- the command derive both digests rather than accepting browser-made keys;
  -- 0085 independently re-proves the complete approval/attestation/media set.
  SELECT version.content_sha256, public.digest(version.content_body, 'sha256') AS body_sha256
  INTO selected_content
  FROM app.company_content_versions AS version
  WHERE version.workspace_id = p_workspace_id
    AND version.content_item_id = p_content_item_id
    AND version.id = p_content_version_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Zernio calendar content version denied' USING ERRCODE = '42501';
  END IF;

  selected_idempotency_sha256 := public.digest(pg_catalog.format(
    'propertypredator.zernio-calendar-command/v1|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s',
    p_workspace_id,
    p_provider_connection_id,
    p_network,
    encode(selected_account.provider_profile_id_sha256, 'hex'),
    encode(selected_account.provider_account_id_sha256, 'hex'),
    p_planning_intent_id,
    p_planning_target_id,
    p_content_item_id,
    p_content_version_id,
    p_approval_request_id,
    p_approval_decision_id,
    p_source_attestation_id,
    p_operation_tag,
    pg_catalog.floor(pg_catalog.date_part('epoch', p_scheduled_for) * 1000000)::bigint,
    encode(selected_content.content_sha256, 'hex'),
    encode(selected_content.body_sha256, 'hex'),
    'daily=1;monthly=3'
  ), 'sha256');

  selected_request_sha256 := public.digest(pg_catalog.format(
    'propertypredator.zernio-calendar-job/v1|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s',
    p_workspace_id,
    p_provider_connection_id,
    selected_binding_id,
    selected_account.zernio_account_id,
    p_network,
    encode(selected_account.provider_profile_id_sha256, 'hex'),
    encode(selected_account.provider_account_id_sha256, 'hex'),
    p_planning_intent_id,
    p_planning_target_id,
    p_content_item_id,
    p_content_version_id,
    p_approval_request_id,
    p_approval_decision_id,
    p_source_attestation_id,
    p_operation_tag,
    pg_catalog.floor(pg_catalog.date_part('epoch', p_scheduled_for) * 1000000)::bigint,
    encode(selected_content.content_sha256, 'hex'),
    encode(selected_content.body_sha256, 'hex')
  ), 'sha256');

  selected_job_id := app_private.enqueue_zernio_calendar_job(
    p_workspace_id,
    p_provider_connection_id,
    selected_binding_id,
    selected_account.zernio_account_id,
    p_network,
    selected_account.provider_profile_id_sha256,
    selected_account.provider_account_id_sha256,
    p_planning_intent_id,
    p_planning_target_id,
    p_content_item_id,
    p_content_version_id,
    p_approval_request_id,
    p_approval_decision_id,
    p_source_attestation_id,
    p_operation_tag,
    selected_idempotency_sha256,
    selected_request_sha256,
    p_scheduled_for
  );

  RETURN QUERY SELECT selected_job_id, selected_idempotency_sha256, 1, 3;
END
$function$;

REVOKE ALL ON FUNCTION app_private.enqueue_zernio_calendar_from_connected_account(
  uuid,uuid,text,bytea,bytea,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,timestamptz
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.enqueue_zernio_calendar_from_connected_account(
  uuid,uuid,text,bytea,bytea,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,timestamptz
) TO r72_zernio_social_command;

RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_owned_social_definer;

DO $audit$
DECLARE unexpected_public_execute text;
BEGIN
  IF NOT pg_catalog.has_function_privilege(
      'r72_zernio_social_command',
      'app_private.enqueue_zernio_calendar_from_connected_account(uuid,uuid,text,bytea,bytea,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,timestamp with time zone)',
      'EXECUTE'
    )
    OR pg_catalog.has_function_privilege(
      'r72_owned_social_worker_command',
      'app_private.enqueue_zernio_calendar_from_connected_account(uuid,uuid,text,bytea,bytea,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,timestamp with time zone)',
      'EXECUTE'
    ) THEN
    RAISE EXCEPTION 'Unsafe Zernio calendar command ACL';
  END IF;

  SELECT function_identity INTO unexpected_public_execute
  FROM (
    SELECT namespace.nspname || '.' || routine.proname || '('
      || pg_catalog.pg_get_function_identity_arguments(routine.oid) || ')' AS function_identity
    FROM pg_catalog.pg_proc AS routine
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = routine.pronamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      coalesce(routine.proacl, pg_catalog.acldefault('f', routine.proowner))
    ) AS privilege
    WHERE namespace.nspname = 'app_private'
      AND routine.proname = 'enqueue_zernio_calendar_from_connected_account'
      AND privilege.grantee = 0
      AND privilege.privilege_type = 'EXECUTE'
  ) AS public_functions
  LIMIT 1;
  IF unexpected_public_execute IS NOT NULL THEN
    RAISE EXCEPTION 'Zernio calendar command remains executable by PUBLIC: %',
      unexpected_public_execute;
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
