-- Forward-correct only the social-DM row in the canonical live-channel truth.
-- Migration 0087 remains immutable. The replacement is derived from exact
-- active Zernio connection/account evidence plus the durable reply lifecycle
-- and emergency pause. No message text, provider identifier, actor identity,
-- provider payload or credential can cross the returned boundary.

SET LOCAL ROLE r72_owner;

-- The 0087 grants already expose only the account/receipt digest columns used
-- below. Add column-scoped reply lifecycle reads; body text, conversation
-- identity, provider response material and actor ids remain inaccessible.
GRANT SELECT (
  workspace_id, id, provider_connection_id, provider_profile_id_sha256,
  provider_account_id_sha256, network, body_sha256, created_at
) ON app.property_predator_zernio_reply_drafts
  TO r72_operational_inbox_definer;
GRANT SELECT (workspace_id, id, draft_id, body_sha256)
  ON app.property_predator_zernio_reply_approval_requests
  TO r72_operational_inbox_definer;
GRANT SELECT (
  workspace_id, id, approval_request_id, draft_id, body_sha256, decision
) ON app.property_predator_zernio_reply_approval_decisions
  TO r72_operational_inbox_definer;
GRANT SELECT (
  workspace_id, id, draft_id, approval_request_id, approval_decision_id,
  body_sha256, provider_account_id_sha256, state, started_at, settled_at
) ON app.property_predator_zernio_reply_deliveries
  TO r72_operational_inbox_definer;

CREATE POLICY operational_channel_truth_zernio_reply_drafts_select
  ON app.property_predator_zernio_reply_drafts FOR SELECT
  TO r72_operational_inbox_definer
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND current_setting('app.actor_kind', true) = 'user'
  );
CREATE POLICY operational_channel_truth_zernio_reply_requests_select
  ON app.property_predator_zernio_reply_approval_requests FOR SELECT
  TO r72_operational_inbox_definer
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND current_setting('app.actor_kind', true) = 'user'
  );
CREATE POLICY operational_channel_truth_zernio_reply_decisions_select
  ON app.property_predator_zernio_reply_approval_decisions FOR SELECT
  TO r72_operational_inbox_definer
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND current_setting('app.actor_kind', true) = 'user'
  );
CREATE POLICY operational_channel_truth_zernio_reply_deliveries_select
  ON app.property_predator_zernio_reply_deliveries FOR SELECT
  TO r72_operational_inbox_definer
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND current_setting('app.actor_kind', true) = 'user'
  );

GRANT CREATE ON SCHEMA app_private TO r72_operational_inbox_definer;
SET LOCAL ROLE r72_operational_inbox_definer;

ALTER FUNCTION app_private.property_predator_live_channel_truth()
  RENAME TO property_predator_live_channel_truth_pre_zernio_social_dm;

CREATE FUNCTION app_private.property_predator_zernio_social_dm_truth(
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
    RAISE EXCEPTION 'Zernio social DM truth context denied'
      USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM app.workspace_memberships AS membership
    WHERE membership.workspace_id = p_workspace_id
      AND membership.user_id = current_setting('app.user_id', true)::uuid
      AND membership.status = 'active'
  ) THEN
    RAISE EXCEPTION 'Zernio social DM truth context denied'
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
  active_accounts AS MATERIALIZED (
    SELECT DISTINCT account.provider_connection_id,
      account.provider_profile_id_sha256,
      account.provider_account_id_sha256,
      account.network
    FROM app.property_predator_zernio_accounts AS account
    JOIN active_connections AS connection
      ON connection.id = account.provider_connection_id
    WHERE account.workspace_id = p_workspace_id
      AND account.environment = 'live'
      AND account.status = 'active'
      AND account.network IN ('instagram', 'linkedin')
      AND EXISTS (
        SELECT 1
        FROM app.property_predator_zernio_account_webhook_receipts AS connected
        WHERE connected.workspace_id = account.workspace_id
          AND connected.provider_connection_id = account.provider_connection_id
          AND connected.environment = 'live'
          AND connected.event_type = 'account.connected'
          AND connected.network = account.network
          AND connected.provider_profile_id_sha256
            = account.provider_profile_id_sha256
          AND connected.provider_account_id_sha256
            = account.provider_account_id_sha256
          AND connected.occurred_at <= p_snapshot_at
          AND NOT EXISTS (
            SELECT 1
            FROM app.property_predator_zernio_account_webhook_receipts AS disconnected
            WHERE disconnected.workspace_id = connected.workspace_id
              AND disconnected.provider_connection_id
                = connected.provider_connection_id
              AND disconnected.environment = 'live'
              AND disconnected.event_type = 'account.disconnected'
              AND disconnected.network = connected.network
              AND disconnected.provider_profile_id_sha256
                = connected.provider_profile_id_sha256
              AND disconnected.provider_account_id_sha256
                = connected.provider_account_id_sha256
              AND disconnected.occurred_at >= connected.occurred_at
              AND disconnected.occurred_at <= p_snapshot_at
          )
      )
  ),
  scoped_drafts AS MATERIALIZED (
    SELECT draft.id, draft.body_sha256, draft.created_at
    FROM app.property_predator_zernio_reply_drafts AS draft
    JOIN active_accounts AS account
      ON account.provider_connection_id = draft.provider_connection_id
     AND account.provider_profile_id_sha256 = draft.provider_profile_id_sha256
     AND account.provider_account_id_sha256 = draft.provider_account_id_sha256
     AND account.network = draft.network
    WHERE draft.workspace_id = p_workspace_id
      AND draft.created_at <= p_snapshot_at
  ),
  latest_draft AS MATERIALIZED (
    SELECT draft.id, draft.body_sha256
    FROM scoped_drafts AS draft
    ORDER BY draft.created_at DESC, draft.id DESC
    LIMIT 1
  ),
  latest_draft_state AS MATERIALIZED (
    SELECT draft.id,
      request.id AS approval_request_id,
      decision.id AS approval_decision_id,
      decision.decision,
      delivery.id AS delivery_id,
      request.body_sha256 = draft.body_sha256
        AND decision.body_sha256 = draft.body_sha256 AS approval_matches
    FROM latest_draft AS draft
    LEFT JOIN app.property_predator_zernio_reply_approval_requests AS request
      ON request.workspace_id = p_workspace_id
     AND request.draft_id = draft.id
    LEFT JOIN app.property_predator_zernio_reply_approval_decisions AS decision
      ON decision.workspace_id = p_workspace_id
     AND decision.approval_request_id = request.id
     AND decision.draft_id = draft.id
    LEFT JOIN app.property_predator_zernio_reply_deliveries AS delivery
      ON delivery.workspace_id = p_workspace_id
     AND delivery.draft_id = draft.id
     AND delivery.approval_request_id = request.id
     AND delivery.approval_decision_id = decision.id
  ),
  ambiguous_delivery AS MATERIALIZED (
    SELECT delivery.id, delivery.state, delivery.settled_at
    FROM app.property_predator_zernio_reply_deliveries AS delivery
    JOIN scoped_drafts AS draft
      ON draft.id = delivery.draft_id
     AND draft.body_sha256 = delivery.body_sha256
    WHERE delivery.workspace_id = p_workspace_id
      AND delivery.state = 'outcome_unknown'
      AND delivery.settled_at <= p_snapshot_at
    ORDER BY delivery.settled_at DESC, delivery.id DESC
    LIMIT 1
  ),
  latest_settled_delivery AS MATERIALIZED (
    SELECT delivery.id, delivery.state, delivery.settled_at
    FROM app.property_predator_zernio_reply_deliveries AS delivery
    JOIN scoped_drafts AS draft
      ON draft.id = delivery.draft_id
     AND draft.body_sha256 = delivery.body_sha256
    WHERE delivery.workspace_id = p_workspace_id
      AND delivery.state IN ('accepted', 'failed', 'outcome_unknown')
      AND delivery.settled_at <= p_snapshot_at
    ORDER BY delivery.settled_at DESC, delivery.id DESC
    LIMIT 1
  ),
  selected_delivery AS (
    SELECT delivery.id, delivery.state, delivery.settled_at
    FROM ambiguous_delivery AS delivery
    UNION ALL
    SELECT delivery.id, delivery.state, delivery.settled_at
    FROM latest_settled_delivery AS delivery
    WHERE NOT EXISTS (SELECT 1 FROM ambiguous_delivery)
  ),
  facts AS (
    SELECT
      EXISTS (SELECT 1 FROM active_connections) AS connection_ready,
      EXISTS (SELECT 1 FROM active_accounts) AS account_ready,
      EXISTS (SELECT 1 FROM ambiguous_delivery) AS ambiguous_outcome,
      EXISTS (
        SELECT 1
        FROM app.property_predator_live_channel_pause_events AS pause
        WHERE pause.workspace_id = p_workspace_id
          AND pause.scope IN ('all', 'social_dm')
      ) AS emergency_paused,
      EXISTS (SELECT 1 FROM latest_draft) AS draft_present,
      EXISTS (
        SELECT 1
        FROM latest_draft_state AS lifecycle
        WHERE lifecycle.approval_request_id IS NOT NULL
          AND lifecycle.approval_decision_id IS NOT NULL
          AND lifecycle.decision = 'approved'
          AND lifecycle.approval_matches
      ) AS approval_ready,
      EXISTS (
        SELECT 1 FROM latest_draft_state AS lifecycle
        WHERE lifecycle.delivery_id IS NOT NULL
      ) AS delivery_present,
      delivery.id AS receipt_id,
      delivery.state AS delivery_state,
      delivery.settled_at
    FROM selected_delivery AS delivery
    RIGHT JOIN (SELECT 1 AS singleton) AS singleton ON true
  ),
  states AS (
    SELECT facts.*,
      facts.draft_present AND NOT facts.approval_ready
        AND NOT facts.delivery_present AS approval_required,
      CASE facts.delivery_state
        WHEN 'accepted' THEN 'healthy'
        WHEN 'failed' THEN 'needs_attention'
        WHEN 'outcome_unknown' THEN 'outcome_unknown'
        ELSE 'none'
      END AS selected_receipt_state,
      CASE facts.delivery_state
        WHEN 'accepted' THEN 'succeeded'
        WHEN 'failed' THEN 'failed'
        WHEN 'outcome_unknown' THEN 'outcome_unknown'
        ELSE NULL
      END AS selected_receipt_outcome
    FROM facts
  )
  SELECT
    CASE WHEN states.account_ready THEN 'ready'
      WHEN states.connection_ready THEN 'configured'
      ELSE 'not_configured' END,
    CASE WHEN states.account_ready THEN 'ready' ELSE 'not_ready' END,
    CASE
      WHEN NOT states.account_ready
        OR states.ambiguous_outcome
        OR states.emergency_paused THEN 'blocked'
      WHEN states.approval_required THEN 'approval_required'
      ELSE 'ready'
    END,
    states.selected_receipt_state,
    0::bigint, 0::bigint, 0::bigint, 0::bigint,
    pg_catalog.array_remove(ARRAY[
      CASE WHEN NOT states.connection_ready THEN 'PROVIDER_NOT_CONFIGURED' END,
      CASE WHEN states.connection_ready AND NOT states.account_ready
        THEN 'IDENTITY_BINDING_REQUIRED' END,
      CASE WHEN NOT states.account_ready THEN 'INGRESS_NOT_READY' END,
      CASE WHEN states.approval_required THEN 'APPROVAL_REQUIRED' END,
      CASE WHEN states.selected_receipt_state = 'needs_attention'
        THEN 'RECEIPT_NEEDS_ATTENTION' END,
      CASE WHEN states.ambiguous_outcome
        THEN 'OUTCOME_UNKNOWN_QUARANTINED' END,
      CASE WHEN states.emergency_paused THEN 'EMERGENCY_PAUSED' END
    ]::text[], NULL),
    states.receipt_id,
    states.selected_receipt_outcome,
    states.settled_at,
    CASE WHEN states.receipt_id IS NULL THEN NULL ELSE pg_catalog.encode(
      public.digest(
        states.receipt_id::text || ':' || states.delivery_state || ':'
          || states.settled_at::text,
        'sha256'
      ),
      'hex'
    ) END
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
    CASE WHEN legacy.rail = 'social_dm'
      THEN zernio.connection_state ELSE legacy.connection_state END,
    CASE WHEN legacy.rail = 'social_dm'
      THEN zernio.inbound_state ELSE legacy.inbound_state END,
    CASE WHEN legacy.rail = 'social_dm'
      THEN zernio.outbound_or_reply_state ELSE legacy.outbound_or_reply_state END,
    CASE WHEN legacy.rail = 'social_dm'
      THEN zernio.receipt_state ELSE legacy.receipt_state END,
    CASE WHEN legacy.rail = 'social_dm'
      THEN zernio.daily_used ELSE legacy.daily_used END,
    CASE WHEN legacy.rail = 'social_dm'
      THEN zernio.daily_limit ELSE legacy.daily_limit END,
    CASE WHEN legacy.rail = 'social_dm'
      THEN zernio.monthly_used ELSE legacy.monthly_used END,
    CASE WHEN legacy.rail = 'social_dm'
      THEN zernio.monthly_limit ELSE legacy.monthly_limit END,
    CASE WHEN legacy.rail = 'social_dm'
      THEN zernio.blocker_codes ELSE legacy.blocker_codes END,
    CASE WHEN legacy.rail = 'social_dm'
      THEN zernio.latest_receipt_id ELSE legacy.latest_receipt_id END,
    CASE WHEN legacy.rail = 'social_dm'
      THEN zernio.latest_receipt_outcome ELSE legacy.latest_receipt_outcome END,
    CASE WHEN legacy.rail = 'social_dm'
      THEN zernio.latest_receipt_at ELSE legacy.latest_receipt_at END,
    CASE WHEN legacy.rail = 'social_dm'
      THEN zernio.latest_receipt_evidence_sha256
      ELSE legacy.latest_receipt_evidence_sha256 END
  FROM app_private.property_predator_live_channel_truth_pre_zernio_social_dm()
    AS legacy
  LEFT JOIN LATERAL app_private.property_predator_zernio_social_dm_truth(
    legacy.workspace_id, legacy.snapshot_at
  ) AS zernio ON legacy.rail = 'social_dm'
$function$;

RESET ROLE;
SET LOCAL ROLE r72_owner;

REVOKE CREATE ON SCHEMA app_private FROM r72_operational_inbox_definer;
REVOKE ALL ON FUNCTION
  app_private.property_predator_live_channel_truth_pre_zernio_social_dm()
  FROM PUBLIC, r72_web;
REVOKE ALL ON FUNCTION app_private.property_predator_zernio_social_dm_truth(
  uuid, timestamptz
) FROM PUBLIC, r72_web;
REVOKE ALL ON FUNCTION app_private.property_predator_live_channel_truth()
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.property_predator_live_channel_truth()
  TO r72_web;

DO $capability_audit$
DECLARE unexpected_function text;
BEGIN
  IF pg_catalog.has_function_privilege(
      'r72_web',
      'app_private.property_predator_live_channel_truth_pre_zernio_social_dm()',
      'EXECUTE'
    )
    OR pg_catalog.has_function_privilege(
      'r72_web',
      'app_private.property_predator_zernio_social_dm_truth(uuid,timestamptz)',
      'EXECUTE'
    )
    OR NOT pg_catalog.has_function_privilege(
      'r72_web', 'app_private.property_predator_live_channel_truth()', 'EXECUTE'
    ) THEN
    RAISE EXCEPTION 'Zernio social DM truth function ACL is unsafe';
  END IF;

  IF pg_catalog.has_column_privilege(
      'r72_operational_inbox_definer',
      'app.property_predator_zernio_reply_drafts', 'body_text', 'SELECT'
    )
    OR pg_catalog.has_column_privilege(
      'r72_operational_inbox_definer',
      'app.property_predator_zernio_reply_drafts',
      'provider_conversation_id_sha256', 'SELECT'
    )
    OR pg_catalog.has_column_privilege(
      'r72_operational_inbox_definer',
      'app.property_predator_zernio_reply_deliveries',
      'provider_response_sha256', 'SELECT'
    )
    OR pg_catalog.has_column_privilege(
      'r72_operational_inbox_definer',
      'app.property_predator_zernio_reply_deliveries',
      'provider_message_id_sha256', 'SELECT'
    ) THEN
    RAISE EXCEPTION 'Zernio social DM truth can read forbidden reply material';
  END IF;

  SELECT procedure.oid::regprocedure::text INTO unexpected_function
  FROM pg_catalog.pg_proc AS procedure
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = procedure.pronamespace
  CROSS JOIN LATERAL pg_catalog.aclexplode(
    coalesce(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))
  ) AS privilege
  WHERE namespace.nspname = 'app_private'
    AND procedure.proname IN (
      'property_predator_live_channel_truth_pre_zernio_social_dm',
      'property_predator_zernio_social_dm_truth',
      'property_predator_live_channel_truth'
    )
    AND privilege.privilege_type = 'EXECUTE'
    AND privilege.grantee <> procedure.proowner
    AND NOT (
      procedure.proname = 'property_predator_live_channel_truth'
      AND privilege.grantee = (
        SELECT role.oid FROM pg_catalog.pg_roles AS role
        WHERE role.rolname = 'r72_web'
      )
    )
  LIMIT 1;
  IF unexpected_function IS NOT NULL THEN
    RAISE EXCEPTION 'Unexpected Zernio social DM truth grantee: %',
      unexpected_function;
  END IF;
END
$capability_audit$;

RESET ROLE;
