-- Replace only the owned-social row in the existing typed live-channel truth
-- with Zernio-qualified evidence. Every other rail continues to come from the
-- exact pre-0087 function. The public function signature remains unchanged.
--
-- The owned-social row is intentionally derived from current, active,
-- non-revoked Zernio account/binding evidence. Cap usage is measured at the
-- same account/network grain enforced by 0085 (1/day and 3/month), while
-- receipts are accepted only when both the receipt and its job say Zernio.

SET LOCAL ROLE r72_owner;

-- Column-scoped reads only. The operational truth definer does not receive
-- usernames, display names, actor ids, provider payloads or any credential.
GRANT SELECT (
  workspace_id, id, provider_connection_id, provider_profile_id_sha256,
  provider_account_id_sha256, network, status, environment
) ON app.property_predator_zernio_accounts
  TO r72_operational_inbox_definer;
GRANT SELECT (
  workspace_id, id, provider_connection_id, zernio_account_id, environment,
  provider_id, network, provider_profile_id_sha256,
  provider_account_id_sha256, ownership_evidence_sha256, verified_at
) ON app.property_predator_zernio_publish_bindings
  TO r72_operational_inbox_definer;
GRANT SELECT (workspace_id, binding_id)
  ON app.property_predator_zernio_publish_binding_revocations
  TO r72_operational_inbox_definer;
GRANT SELECT (
  workspace_id, provider_connection_id, event_type, network,
  provider_profile_id_sha256, provider_account_id_sha256, receipt_sha256,
  occurred_at, environment
) ON app.property_predator_zernio_account_webhook_receipts
  TO r72_operational_inbox_definer;

CREATE POLICY operational_channel_truth_zernio_accounts_select
  ON app.property_predator_zernio_accounts FOR SELECT
  TO r72_operational_inbox_definer
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND current_setting('app.actor_kind', true) = 'user'
  );
CREATE POLICY operational_channel_truth_zernio_bindings_select
  ON app.property_predator_zernio_publish_bindings FOR SELECT
  TO r72_operational_inbox_definer
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND current_setting('app.actor_kind', true) = 'user'
  );
CREATE POLICY operational_channel_truth_zernio_revocations_select
  ON app.property_predator_zernio_publish_binding_revocations FOR SELECT
  TO r72_operational_inbox_definer
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND current_setting('app.actor_kind', true) = 'user'
  );
CREATE POLICY operational_channel_truth_zernio_account_receipts_select
  ON app.property_predator_zernio_account_webhook_receipts FOR SELECT
  TO r72_operational_inbox_definer
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND current_setting('app.actor_kind', true) = 'user'
  );

GRANT CREATE ON SCHEMA app_private TO r72_operational_inbox_definer;
SET LOCAL ROLE r72_operational_inbox_definer;

-- Keep the fully composed pre-0087 truth (including every non-social rail)
-- closed behind the replacement function.
ALTER FUNCTION app_private.property_predator_live_channel_truth()
  RENAME TO property_predator_live_channel_truth_pre_zernio;

CREATE FUNCTION app_private.property_predator_zernio_owned_social_truth(
  p_workspace_id uuid,
  p_snapshot_at timestamptz
) RETURNS TABLE (
  connection_state text,
  inbound_state text,
  outbound_or_reply_state text,
  receipt_state text,
  daily_used bigint,
  daily_limit bigint,
  monthly_used bigint,
  monthly_limit bigint,
  blocker_codes text[],
  latest_receipt_id uuid,
  latest_receipt_outcome text,
  latest_receipt_at timestamptz,
  latest_receipt_evidence_sha256 text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
BEGIN
  IF session_user <> 'r72_web'
     OR p_workspace_id IS NULL
     OR p_snapshot_at IS NULL
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'user'
     OR coalesce(current_setting('app.user_id', true), '')
       !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'Zernio live channel truth context denied'
      USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM app.workspace_memberships AS membership
    WHERE membership.workspace_id = p_workspace_id
      AND membership.user_id = current_setting('app.user_id', true)::uuid
      AND membership.status = 'active'
  ) THEN
    RAISE EXCEPTION 'Zernio live channel truth context denied'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH active_connections AS MATERIALIZED (
    SELECT connection.id
    FROM app.provider_connections AS connection
    WHERE connection.workspace_id = p_workspace_id
      AND connection.provider_id = 'zernio'
      AND connection.provider_kind = 'social'
      AND connection.environment = 'live'
      AND connection.status = 'active'
  ),
  active_scopes AS MATERIALIZED (
    SELECT DISTINCT
      binding.id AS binding_id,
      binding.provider_connection_id,
      binding.zernio_account_id,
      binding.network
    FROM app.property_predator_zernio_publish_bindings AS binding
    JOIN active_connections AS connection
      ON connection.id = binding.provider_connection_id
    JOIN app.property_predator_zernio_accounts AS account
      ON account.workspace_id = binding.workspace_id
     AND account.id = binding.zernio_account_id
     AND account.provider_connection_id = binding.provider_connection_id
     AND account.provider_profile_id_sha256 = binding.provider_profile_id_sha256
     AND account.provider_account_id_sha256 = binding.provider_account_id_sha256
     AND account.network = binding.network
     AND account.environment = binding.environment
     AND account.status = 'active'
    WHERE binding.workspace_id = p_workspace_id
      AND binding.provider_id = 'zernio'
      AND binding.environment = 'live'
      AND binding.network IN ('instagram', 'linkedin')
      AND NOT EXISTS (
        SELECT 1
        FROM app.property_predator_zernio_publish_binding_revocations AS revocation
        WHERE revocation.workspace_id = binding.workspace_id
          AND revocation.binding_id = binding.id
      )
      AND EXISTS (
        SELECT 1
        FROM app.property_predator_zernio_account_webhook_receipts AS connected_receipt
        WHERE connected_receipt.workspace_id = binding.workspace_id
          AND connected_receipt.provider_connection_id = binding.provider_connection_id
          AND connected_receipt.environment = 'live'
          AND connected_receipt.event_type = 'account.connected'
          AND connected_receipt.network = binding.network
          AND connected_receipt.provider_profile_id_sha256
            = binding.provider_profile_id_sha256
          AND connected_receipt.provider_account_id_sha256
            = binding.provider_account_id_sha256
          AND connected_receipt.receipt_sha256 = binding.ownership_evidence_sha256
          AND connected_receipt.occurred_at <= binding.verified_at + interval '5 minutes'
          AND NOT EXISTS (
            SELECT 1
            FROM app.property_predator_zernio_account_webhook_receipts
              AS disconnected_receipt
            WHERE disconnected_receipt.workspace_id = connected_receipt.workspace_id
              AND disconnected_receipt.provider_connection_id
                = connected_receipt.provider_connection_id
              AND disconnected_receipt.environment = 'live'
              AND disconnected_receipt.event_type = 'account.disconnected'
              AND disconnected_receipt.network = connected_receipt.network
              AND disconnected_receipt.provider_profile_id_sha256
                = connected_receipt.provider_profile_id_sha256
              AND disconnected_receipt.provider_account_id_sha256
                = connected_receipt.provider_account_id_sha256
              AND disconnected_receipt.occurred_at >= connected_receipt.occurred_at
          )
      )
  ),
  scope_usage AS MATERIALIZED (
    SELECT scope.zernio_account_id, scope.network,
      count(job.id) FILTER (
        WHERE job.utc_day = (p_snapshot_at AT TIME ZONE 'UTC')::date
          AND job.state <> 'cancelled'
      )::bigint AS daily_used,
      count(job.id) FILTER (
        WHERE job.utc_month
          = date_trunc('month', p_snapshot_at AT TIME ZONE 'UTC')::date
          AND job.state <> 'cancelled'
      )::bigint AS monthly_used
    FROM active_scopes AS scope
    LEFT JOIN app.property_predator_owned_social_jobs AS job
      ON job.workspace_id = p_workspace_id
     AND job.provider_id = 'zernio'
     AND job.zernio_account_id = scope.zernio_account_id
     AND job.network = scope.network
    GROUP BY scope.zernio_account_id, scope.network
  ),
  usage_fact AS (
    SELECT
      least(coalesce(max(scope_usage.daily_used), 0), 1::bigint) AS daily_used,
      least(coalesce(max(scope_usage.monthly_used), 0), 3::bigint) AS monthly_used
    FROM scope_usage
  ),
  current_jobs AS MATERIALIZED (
    SELECT job.id, job.state
    FROM app.property_predator_owned_social_jobs AS job
    JOIN active_scopes AS scope
      ON scope.binding_id = job.zernio_publish_binding_id
     AND scope.provider_connection_id = job.provider_connection_id
     AND scope.zernio_account_id = job.zernio_account_id
     AND scope.network = job.network
    WHERE job.workspace_id = p_workspace_id
      AND job.provider_id = 'zernio'
  ),
  -- An unknown provider outcome remains quarantined even if its original
  -- binding is later revoked or replaced. Provider qualification on both the
  -- job and receipt prevents a dormant provider's history entering this row.
  ambiguous_receipt AS MATERIALIZED (
    SELECT receipt.id, receipt.event_kind, receipt.recorded_at,
      receipt.receipt_sha256
    FROM app.property_predator_owned_social_receipts AS receipt
    JOIN app.property_predator_owned_social_jobs AS job
      ON job.workspace_id = receipt.workspace_id
     AND job.id = receipt.job_id
    WHERE receipt.workspace_id = p_workspace_id
      AND job.provider_id = 'zernio'
      AND job.network IN ('instagram', 'linkedin')
      AND receipt.provider_id = 'zernio'
      AND receipt.event_kind = 'outcome_unknown'
    ORDER BY receipt.recorded_at DESC, receipt.id DESC
    LIMIT 1
  ),
  latest_zernio_receipt AS MATERIALIZED (
    SELECT receipt.id, receipt.event_kind, receipt.recorded_at,
      receipt.receipt_sha256
    FROM app.property_predator_owned_social_receipts AS receipt
    JOIN current_jobs AS job ON job.id = receipt.job_id
    WHERE receipt.workspace_id = p_workspace_id
      AND receipt.provider_id = 'zernio'
    ORDER BY receipt.recorded_at DESC, receipt.id DESC
    LIMIT 1
  ),
  selected_receipt AS (
    SELECT receipt.id, receipt.event_kind, receipt.recorded_at,
      receipt.receipt_sha256
    FROM ambiguous_receipt AS receipt
    UNION ALL
    SELECT receipt.id, receipt.event_kind, receipt.recorded_at,
      receipt.receipt_sha256
    FROM latest_zernio_receipt AS receipt
    WHERE NOT EXISTS (SELECT 1 FROM ambiguous_receipt)
  ),
  facts AS (
    SELECT
      EXISTS (SELECT 1 FROM active_connections) AS connection_ready,
      EXISTS (SELECT 1 FROM active_scopes) AS binding_ready,
      usage.daily_used,
      usage.monthly_used,
      EXISTS (SELECT 1 FROM ambiguous_receipt) AS ambiguous_outcome,
      EXISTS (
        SELECT 1
        FROM app.property_predator_live_channel_pause_events AS pause
        WHERE pause.workspace_id = p_workspace_id
          AND pause.scope IN ('all', 'owned_social')
      ) AS emergency_paused,
      EXISTS (
        SELECT 1
        FROM app.company_content_versions AS version
        JOIN app.company_content_approval_decisions AS decision
          ON decision.workspace_id = version.workspace_id
         AND decision.content_item_id = version.content_item_id
         AND decision.content_version_id = version.id
         AND decision.decision = 'approved'
        WHERE version.workspace_id = p_workspace_id
          AND version.content_kind = 'social_post'
          AND NOT EXISTS (
            SELECT 1
            FROM app.company_content_versions AS newer
            WHERE newer.workspace_id = version.workspace_id
              AND newer.content_item_id = version.content_item_id
              AND newer.version_number > version.version_number
          )
      ) AS approved_content_ready,
      receipt.id AS receipt_id,
      receipt.event_kind,
      receipt.recorded_at,
      receipt.receipt_sha256
    FROM usage_fact AS usage
    LEFT JOIN selected_receipt AS receipt ON true
  ),
  states AS (
    SELECT facts.*,
      facts.daily_used >= 1 OR facts.monthly_used >= 3 AS cap_reached,
      CASE facts.event_kind
        WHEN 'accepted' THEN 'accepted'
        WHEN 'published' THEN 'succeeded'
        WHEN 'failed' THEN 'failed'
        WHEN 'outcome_unknown' THEN 'outcome_unknown'
        ELSE NULL
      END AS receipt_outcome,
      CASE facts.event_kind
        WHEN 'accepted' THEN 'pending'
        WHEN 'published' THEN 'healthy'
        WHEN 'failed' THEN 'needs_attention'
        WHEN 'outcome_unknown' THEN 'outcome_unknown'
        ELSE 'none'
      END AS selected_receipt_state
    FROM facts
  )
  SELECT
    CASE WHEN states.binding_ready THEN 'ready'
      WHEN states.connection_ready THEN 'configured'
      ELSE 'not_configured' END,
    'not_supported'::text,
    CASE
      WHEN states.cap_reached THEN 'cap_reached'
      WHEN NOT states.binding_ready
        OR states.ambiguous_outcome
        OR states.emergency_paused THEN 'blocked'
      ELSE 'approval_required'
    END,
    states.selected_receipt_state,
    states.daily_used,
    1::bigint,
    states.monthly_used,
    3::bigint,
    pg_catalog.array_remove(ARRAY[
      CASE WHEN NOT states.connection_ready THEN 'PROVIDER_NOT_CONFIGURED' END,
      CASE WHEN states.connection_ready AND NOT states.binding_ready
        THEN 'IDENTITY_BINDING_REQUIRED' END,
      CASE WHEN states.cap_reached THEN 'CAP_REACHED' END,
      CASE WHEN NOT states.cap_reached AND states.binding_ready
        AND NOT states.ambiguous_outcome AND NOT states.emergency_paused
        THEN 'APPROVAL_REQUIRED' END,
      CASE WHEN states.selected_receipt_state = 'needs_attention'
        THEN 'RECEIPT_NEEDS_ATTENTION' END,
      CASE WHEN states.ambiguous_outcome
        THEN 'OUTCOME_UNKNOWN_QUARANTINED' END,
      CASE WHEN NOT states.approved_content_ready
        THEN 'APPROVED_CONTENT_REQUIRED' END,
      CASE WHEN states.emergency_paused THEN 'EMERGENCY_PAUSED' END
    ]::text[], NULL),
    states.receipt_id,
    states.receipt_outcome,
    states.recorded_at,
    CASE WHEN states.receipt_sha256 IS NULL THEN NULL
      ELSE pg_catalog.encode(states.receipt_sha256, 'hex') END
  FROM states;
END
$function$;

CREATE FUNCTION app_private.property_predator_live_channel_truth()
RETURNS TABLE (
  workspace_id uuid,
  snapshot_at timestamptz,
  rail text,
  connection_state text,
  inbound_state text,
  outbound_or_reply_state text,
  receipt_state text,
  daily_used bigint,
  daily_limit bigint,
  monthly_used bigint,
  monthly_limit bigint,
  blocker_codes text[],
  latest_receipt_id uuid,
  latest_receipt_outcome text,
  latest_receipt_at timestamptz,
  latest_receipt_evidence_sha256 text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
  SELECT legacy.workspace_id, legacy.snapshot_at, legacy.rail,
    CASE WHEN legacy.rail = 'owned_social'
      THEN zernio.connection_state ELSE legacy.connection_state END,
    CASE WHEN legacy.rail = 'owned_social'
      THEN zernio.inbound_state ELSE legacy.inbound_state END,
    CASE WHEN legacy.rail = 'owned_social'
      THEN zernio.outbound_or_reply_state ELSE legacy.outbound_or_reply_state END,
    CASE WHEN legacy.rail = 'owned_social'
      THEN zernio.receipt_state ELSE legacy.receipt_state END,
    CASE WHEN legacy.rail = 'owned_social'
      THEN zernio.daily_used ELSE legacy.daily_used END,
    CASE WHEN legacy.rail = 'owned_social'
      THEN zernio.daily_limit ELSE legacy.daily_limit END,
    CASE WHEN legacy.rail = 'owned_social'
      THEN zernio.monthly_used ELSE legacy.monthly_used END,
    CASE WHEN legacy.rail = 'owned_social'
      THEN zernio.monthly_limit ELSE legacy.monthly_limit END,
    CASE WHEN legacy.rail = 'owned_social'
      THEN zernio.blocker_codes ELSE legacy.blocker_codes END,
    CASE WHEN legacy.rail = 'owned_social'
      THEN zernio.latest_receipt_id ELSE legacy.latest_receipt_id END,
    CASE WHEN legacy.rail = 'owned_social'
      THEN zernio.latest_receipt_outcome ELSE legacy.latest_receipt_outcome END,
    CASE WHEN legacy.rail = 'owned_social'
      THEN zernio.latest_receipt_at ELSE legacy.latest_receipt_at END,
    CASE WHEN legacy.rail = 'owned_social'
      THEN zernio.latest_receipt_evidence_sha256
      ELSE legacy.latest_receipt_evidence_sha256 END
  FROM app_private.property_predator_live_channel_truth_pre_zernio() AS legacy
  LEFT JOIN LATERAL app_private.property_predator_zernio_owned_social_truth(
    legacy.workspace_id, legacy.snapshot_at
  ) AS zernio ON legacy.rail = 'owned_social'
$function$;

RESET ROLE;
SET LOCAL ROLE r72_owner;

REVOKE CREATE ON SCHEMA app_private FROM r72_operational_inbox_definer;
REVOKE ALL ON FUNCTION app_private.property_predator_live_channel_truth_pre_zernio()
  FROM PUBLIC, r72_web;
REVOKE ALL ON FUNCTION app_private.property_predator_zernio_owned_social_truth(
  uuid, timestamptz
) FROM PUBLIC, r72_web;
REVOKE ALL ON FUNCTION app_private.property_predator_live_channel_truth()
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.property_predator_live_channel_truth()
  TO r72_web;

-- The two provider command logins remain table-blind. The only new reads
-- belong to the NOLOGIN truth definer and the only exposed function remains
-- the pre-existing typed r72_web entry point.
DO $capability_audit$
DECLARE checked_role text; unsafe_object text; unexpected_function text;
BEGIN
  FOREACH checked_role IN ARRAY ARRAY[
    'r72_zernio_social_command', 'r72_owned_social_worker_command'
  ] LOOP
    SELECT pg_catalog.format('%I.%I', namespace.nspname, relation.relname)
      INTO unsafe_object
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname IN ('app', 'app_private')
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND (
        pg_catalog.has_table_privilege(checked_role, relation.oid, 'SELECT')
        OR pg_catalog.has_table_privilege(checked_role, relation.oid, 'INSERT')
        OR pg_catalog.has_table_privilege(checked_role, relation.oid, 'UPDATE')
        OR pg_catalog.has_table_privilege(checked_role, relation.oid, 'DELETE')
        OR pg_catalog.has_table_privilege(checked_role, relation.oid, 'TRUNCATE')
      )
    LIMIT 1;
    IF unsafe_object IS NOT NULL THEN
      RAISE EXCEPTION 'Zernio live truth login has direct table capability: % -> %',
        checked_role, unsafe_object;
    END IF;
  END LOOP;

  IF pg_catalog.has_function_privilege(
      'r72_web',
      'app_private.property_predator_live_channel_truth_pre_zernio()',
      'EXECUTE'
    )
    OR pg_catalog.has_function_privilege(
      'r72_web',
      'app_private.property_predator_zernio_owned_social_truth(uuid,timestamptz)',
      'EXECUTE'
    )
    OR NOT pg_catalog.has_function_privilege(
      'r72_web', 'app_private.property_predator_live_channel_truth()', 'EXECUTE'
    ) THEN
    RAISE EXCEPTION 'Unsafe Zernio live truth function ACL';
  END IF;

  SELECT procedure.oid::regprocedure::text INTO unexpected_function
  FROM pg_catalog.pg_proc AS procedure
  CROSS JOIN LATERAL pg_catalog.aclexplode(
    coalesce(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))
  ) AS privilege
  WHERE procedure.oid IN (
      pg_catalog.to_regprocedure(
        'app_private.property_predator_live_channel_truth_pre_zernio()'
      ),
      pg_catalog.to_regprocedure(
        'app_private.property_predator_zernio_owned_social_truth(uuid,timestamptz)'
      ),
      pg_catalog.to_regprocedure(
        'app_private.property_predator_live_channel_truth()'
      )
    )
    AND privilege.privilege_type = 'EXECUTE'
    AND (
      privilege.grantee = 0
      OR (
        procedure.proname = 'property_predator_live_channel_truth'
        AND privilege.grantee <> (
          SELECT role.oid FROM pg_catalog.pg_roles AS role
          WHERE role.rolname = 'r72_web'
        )
        AND privilege.grantee <> procedure.proowner
      )
      OR (
        procedure.proname <> 'property_predator_live_channel_truth'
        AND privilege.grantee <> procedure.proowner
      )
    )
  LIMIT 1;
  IF unexpected_function IS NOT NULL THEN
    RAISE EXCEPTION 'Unexpected Zernio live truth function grantee: %',
      unexpected_function;
  END IF;
END
$capability_audit$;

-- Prove that the column-scoped grants did not expose human-readable account
-- labels, actor identifiers, provider payload hashes or binding audit actors.
DO $column_capability_audit$
DECLARE forbidden text;
BEGIN
  FOREACH forbidden IN ARRAY ARRAY[
    'username', 'display_name', 'connected_by_intent_id',
    'created_by_user_id', 'created_at', 'updated_at', 'last_event_at'
  ] LOOP
    IF pg_catalog.has_column_privilege(
      'r72_operational_inbox_definer',
      'app.property_predator_zernio_accounts', forbidden, 'SELECT'
    ) THEN
      RAISE EXCEPTION 'Zernio live truth can read forbidden account column %',
        forbidden;
    END IF;
  END LOOP;

  FOREACH forbidden IN ARRAY ARRAY[
    'publish_capability_evidence_sha256', 'created_by_user_id', 'created_at'
  ] LOOP
    IF pg_catalog.has_column_privilege(
      'r72_operational_inbox_definer',
      'app.property_predator_zernio_publish_bindings', forbidden, 'SELECT'
    ) THEN
      RAISE EXCEPTION 'Zernio live truth can read forbidden binding column %',
        forbidden;
    END IF;
  END LOOP;

  FOREACH forbidden IN ARRAY ARRAY[
    'id', 'provider_connection_id', 'revocation_evidence_sha256',
    'reason_code', 'revoked_by_user_id', 'revoked_at'
  ] LOOP
    IF pg_catalog.has_column_privilege(
      'r72_operational_inbox_definer',
      'app.property_predator_zernio_publish_binding_revocations',
      forbidden, 'SELECT'
    ) THEN
      RAISE EXCEPTION 'Zernio live truth can read forbidden revocation column %',
        forbidden;
    END IF;
  END LOOP;

  FOREACH forbidden IN ARRAY ARRAY[
    'raw_body_sha256', 'received_at', 'event_id'
  ] LOOP
    IF pg_catalog.has_column_privilege(
      'r72_operational_inbox_definer',
      'app.property_predator_zernio_account_webhook_receipts',
      forbidden, 'SELECT'
    ) THEN
      RAISE EXCEPTION 'Zernio live truth can read forbidden webhook column %',
        forbidden;
    END IF;
  END LOOP;
END
$column_capability_audit$;

RESET ROLE;
