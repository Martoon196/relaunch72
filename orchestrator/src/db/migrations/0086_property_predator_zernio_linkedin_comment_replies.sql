-- Forward-extend the immutable Zernio reply ledger from Instagram to exact
-- Instagram-or-LinkedIn targets. Migration 0079 remains untouched: its old
-- Instagram-only functions stay present as historical objects, but the login
-- role loses those ambiguous surfaces and receives only the network-qualified
-- overloads below. Existing Instagram rows and their default remain valid.

SET LOCAL ROLE r72_owner;

ALTER TABLE app.property_predator_zernio_reply_drafts
  DROP CONSTRAINT property_predator_zernio_reply_drafts_network_check;
ALTER TABLE app.property_predator_zernio_reply_drafts
  ADD CONSTRAINT property_predator_zernio_reply_drafts_network_check
  CHECK (network IN ('instagram', 'linkedin')) NOT VALID;
ALTER TABLE app.property_predator_zernio_reply_drafts
  VALIDATE CONSTRAINT property_predator_zernio_reply_drafts_network_check;

-- A process-level switch can become stale after startup. Give only the
-- security-definer role the exact durable pause read it needs so the final
-- claim-to-calling transition remains fenced inside Postgres.
GRANT SELECT ON app.property_predator_live_channel_pause_events
  TO r72_zernio_social_definer;
CREATE POLICY live_channel_pause_zernio_social_definer_select
  ON app.property_predator_live_channel_pause_events FOR SELECT
  TO r72_zernio_social_definer
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND current_setting('app.actor_kind', true) = 'user'
  );

GRANT CREATE ON SCHEMA app_private TO r72_zernio_social_definer;
SET LOCAL ROLE r72_zernio_social_definer;

-- Provider-qualified truth for one exact account and network. It returns no
-- provider identifiers or credentials and is callable only by the dedicated
-- Zernio command login. Draft and claim commands consume the same truth, so a
-- disconnected/substituted account cannot pass through a stale portal view.
CREATE FUNCTION app_private.zernio_reply_channel_truth(
  p_workspace_id uuid, p_provider_connection_id uuid,
  p_provider_profile_id_sha256 bytea, p_provider_account_id_sha256 bytea,
  p_network text
) RETURNS TABLE (
  provider_id text, network text, connection_state text, account_state text,
  reply_state text, reply_ready boolean, blocker_codes text[]
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $function$
  WITH facts AS (
    SELECT
      EXISTS (
        SELECT 1
        FROM app.workspace_memberships AS membership
        WHERE membership.workspace_id = p_workspace_id
          AND membership.user_id::text = current_setting('app.user_id', true)
          AND membership.status = 'active'
          AND membership.role IN ('owner', 'admin')
      ) AS membership_ready,
      EXISTS (
        SELECT 1
        FROM app.provider_connections AS connection
        WHERE connection.workspace_id = p_workspace_id
          AND connection.id = p_provider_connection_id
          AND connection.provider_id = 'zernio'
          AND connection.provider_kind = 'social'
          AND connection.environment = 'live'
          AND connection.status = 'active'
      ) AS connection_ready,
      EXISTS (
        SELECT 1
        FROM app.property_predator_zernio_accounts AS account
        WHERE account.workspace_id = p_workspace_id
          AND account.provider_connection_id = p_provider_connection_id
          AND account.provider_profile_id_sha256 = p_provider_profile_id_sha256
          AND account.provider_account_id_sha256 = p_provider_account_id_sha256
          AND account.network = p_network
          AND account.environment = 'live'
          AND account.status = 'active'
      ) AS account_ready
  )
  SELECT 'zernio'::text, p_network,
    CASE WHEN facts.connection_ready THEN 'active' ELSE 'missing' END,
    CASE WHEN facts.account_ready THEN 'active' ELSE 'missing' END,
    CASE WHEN facts.membership_ready AND facts.connection_ready
      AND facts.account_ready THEN 'ready' ELSE 'blocked' END,
    facts.membership_ready AND facts.connection_ready AND facts.account_ready,
    pg_catalog.array_remove(ARRAY[
      CASE WHEN NOT facts.membership_ready THEN 'MEMBERSHIP_REQUIRED' END,
      CASE WHEN NOT facts.connection_ready THEN 'ZERNIO_CONNECTION_REQUIRED' END,
      CASE WHEN NOT facts.account_ready THEN 'ZERNIO_ACCOUNT_REQUIRED' END
    ]::text[], NULL)
  FROM facts
  WHERE session_user = 'r72_zernio_social_command'
    AND current_setting('app.workspace_id', true) = p_workspace_id::text
    AND current_setting('app.actor_kind', true) = 'user'
    AND current_setting('app.user_id', true) ~ '^[0-9a-f-]{36}$'
    AND p_network IN ('instagram', 'linkedin')
    AND octet_length(p_provider_profile_id_sha256) = 32
    AND octet_length(p_provider_account_id_sha256) = 32
$function$;

CREATE FUNCTION app_private.create_zernio_reply_draft(
  p_workspace_id uuid, p_provider_connection_id uuid, p_draft_id uuid,
  p_network text, p_provider_profile_id_sha256 bytea,
  p_provider_account_id_sha256 bytea, p_provider_conversation_id_sha256 bytea,
  p_body text, p_body_sha256 bytea
) RETURNS TABLE(disposition text, draft_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE selected_user uuid; existing app.property_predator_zernio_reply_drafts%ROWTYPE;
BEGIN
  IF session_user <> 'r72_zernio_social_command'
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'user'
     OR current_setting('app.user_id', true) !~ '^[0-9a-f-]{36}$'
     OR p_network NOT IN ('instagram', 'linkedin')
     OR octet_length(p_provider_profile_id_sha256) <> 32
     OR octet_length(p_provider_account_id_sha256) <> 32
     OR octet_length(p_provider_conversation_id_sha256) <> 32
     OR octet_length(p_body_sha256) <> 32
     OR p_body IS NULL OR p_body <> btrim(p_body)
     OR octet_length(convert_to(p_body, 'UTF8')) NOT BETWEEN 1 AND 10000
     OR public.digest(p_body, 'sha256') <> p_body_sha256 THEN
    RAISE EXCEPTION 'Zernio reply draft denied' USING ERRCODE = '42501';
  END IF;
  selected_user := current_setting('app.user_id')::uuid;
  IF NOT EXISTS (
    SELECT 1
    FROM app_private.zernio_reply_channel_truth(
      p_workspace_id, p_provider_connection_id, p_provider_profile_id_sha256,
      p_provider_account_id_sha256, p_network
    ) AS truth
    WHERE truth.provider_id = 'zernio' AND truth.network = p_network
      AND truth.reply_ready
  ) THEN
    RAISE EXCEPTION 'Zernio reply draft denied' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO existing FROM app.property_predator_zernio_reply_drafts AS draft
  WHERE draft.workspace_id = p_workspace_id AND draft.id = p_draft_id;
  IF FOUND THEN
    IF existing.provider_connection_id <> p_provider_connection_id
       OR existing.provider_profile_id_sha256 <> p_provider_profile_id_sha256
       OR existing.provider_account_id_sha256 <> p_provider_account_id_sha256
       OR existing.provider_conversation_id_sha256 <> p_provider_conversation_id_sha256
       OR existing.network <> p_network
       OR existing.body_sha256 <> p_body_sha256 OR existing.body_text <> p_body
       OR existing.created_by_user_id <> selected_user THEN
      RAISE EXCEPTION 'Zernio reply draft conflict' USING ERRCODE = '40001';
    END IF;
    RETURN QUERY SELECT 'replayed'::text, existing.id;
    RETURN;
  END IF;
  INSERT INTO app.property_predator_zernio_reply_drafts (
    id, workspace_id, provider_connection_id, provider_profile_id_sha256,
    provider_account_id_sha256, provider_conversation_id_sha256, network,
    body_text, body_sha256, created_by_user_id
  ) VALUES (
    p_draft_id, p_workspace_id, p_provider_connection_id,
    p_provider_profile_id_sha256, p_provider_account_id_sha256,
    p_provider_conversation_id_sha256, p_network,
    p_body, p_body_sha256, selected_user
  );
  RETURN QUERY SELECT 'created'::text, p_draft_id;
END
$function$;

CREATE FUNCTION app_private.claim_zernio_reply_send(
  p_workspace_id uuid, p_provider_connection_id uuid, p_draft_id uuid,
  p_delivery_id uuid, p_network text, p_provider_profile_id_sha256 bytea,
  p_provider_account_id_sha256 bytea, p_provider_conversation_id_sha256 bytea,
  p_idempotency_key_sha256 bytea, p_lease_token_sha256 bytea
) RETURNS TABLE(disposition text, body_text text, body_sha256 bytea)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE selected_user uuid; selected_draft app.property_predator_zernio_reply_drafts%ROWTYPE;
  selected_request app.property_predator_zernio_reply_approval_requests%ROWTYPE;
  selected_decision app.property_predator_zernio_reply_approval_decisions%ROWTYPE;
  existing app.property_predator_zernio_reply_deliveries%ROWTYPE;
BEGIN
  IF session_user <> 'r72_zernio_social_command'
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'user'
     OR current_setting('app.user_id', true) !~ '^[0-9a-f-]{36}$'
     OR p_network NOT IN ('instagram', 'linkedin')
     OR octet_length(p_provider_profile_id_sha256) <> 32
     OR octet_length(p_provider_account_id_sha256) <> 32
     OR octet_length(p_provider_conversation_id_sha256) <> 32
     OR octet_length(p_idempotency_key_sha256) <> 32
     OR octet_length(p_lease_token_sha256) <> 32 THEN
    RAISE EXCEPTION 'Zernio reply send denied' USING ERRCODE = '42501';
  END IF;
  selected_user := current_setting('app.user_id')::uuid;
  IF EXISTS (
    SELECT 1
    FROM app.property_predator_live_channel_pause_events AS pause
    WHERE pause.workspace_id = p_workspace_id
      AND pause.scope IN ('all', 'social_dm')
  ) THEN
    RAISE EXCEPTION 'Zernio reply emergency pause is engaged'
      USING ERRCODE = '42501';
  END IF;
  SELECT * INTO selected_draft
  FROM app.property_predator_zernio_reply_drafts AS draft
  WHERE draft.workspace_id = p_workspace_id AND draft.id = p_draft_id FOR SHARE;
  IF NOT FOUND OR selected_draft.provider_connection_id <> p_provider_connection_id
     OR selected_draft.provider_profile_id_sha256 <> p_provider_profile_id_sha256
     OR selected_draft.provider_account_id_sha256 <> p_provider_account_id_sha256
     OR selected_draft.provider_conversation_id_sha256 <> p_provider_conversation_id_sha256
     OR selected_draft.network <> p_network THEN
    RAISE EXCEPTION 'Zernio reply send target denied' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO selected_request
  FROM app.property_predator_zernio_reply_approval_requests AS request
  WHERE request.workspace_id = p_workspace_id AND request.draft_id = p_draft_id;
  SELECT * INTO selected_decision
  FROM app.property_predator_zernio_reply_approval_decisions AS decision
  WHERE decision.workspace_id = p_workspace_id
    AND decision.approval_request_id = selected_request.id;
  IF selected_request.id IS NULL OR selected_decision.id IS NULL
     OR selected_decision.decision <> 'approved'
     OR selected_request.body_sha256 <> selected_draft.body_sha256
     OR selected_decision.body_sha256 <> selected_draft.body_sha256 THEN
    RAISE EXCEPTION 'Zernio reply send is not approved' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM app_private.zernio_reply_channel_truth(
      p_workspace_id, p_provider_connection_id, p_provider_profile_id_sha256,
      p_provider_account_id_sha256, p_network
    ) AS truth
    WHERE truth.provider_id = 'zernio' AND truth.network = p_network
      AND truth.reply_ready
  ) THEN
    RAISE EXCEPTION 'Zernio reply account is not active' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO existing
  FROM app.property_predator_zernio_reply_deliveries AS delivery
  WHERE delivery.workspace_id = p_workspace_id
    AND (delivery.id = p_delivery_id OR delivery.draft_id = p_draft_id);
  IF FOUND THEN
    IF existing.id <> p_delivery_id OR existing.draft_id <> p_draft_id
       OR existing.idempotency_key_sha256 <> p_idempotency_key_sha256
       OR existing.lease_token_sha256 <> p_lease_token_sha256
       OR existing.requested_by_user_id <> selected_user THEN
      RAISE EXCEPTION 'Zernio reply delivery conflict' USING ERRCODE = '40001';
    END IF;
    RETURN QUERY SELECT ('already_' || existing.state)::text,
      NULL::text, existing.body_sha256;
    RETURN;
  END IF;
  INSERT INTO app.property_predator_zernio_reply_deliveries (
    id, workspace_id, draft_id, approval_request_id, approval_decision_id,
    body_sha256, provider_account_id_sha256, provider_conversation_id_sha256,
    idempotency_key_sha256, lease_token_sha256, state, requested_by_user_id
  ) VALUES (
    p_delivery_id, p_workspace_id, p_draft_id, selected_request.id,
    selected_decision.id, selected_draft.body_sha256,
    p_provider_account_id_sha256, p_provider_conversation_id_sha256,
    p_idempotency_key_sha256, p_lease_token_sha256, 'calling', selected_user
  );
  RETURN QUERY SELECT 'claimed'::text, selected_draft.body_text,
    selected_draft.body_sha256;
END
$function$;

REVOKE ALL ON FUNCTION app_private.zernio_reply_channel_truth(
  uuid, uuid, bytea, bytea, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.create_zernio_reply_draft(
  uuid, uuid, uuid, text, bytea, bytea, bytea, text, bytea
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.claim_zernio_reply_send(
  uuid, uuid, uuid, uuid, text, bytea, bytea, bytea, bytea, bytea
) FROM PUBLIC;

-- Retire only the login grants for the ambiguous 0079 overloads. The
-- historical functions and immutable evidence remain intact.
REVOKE EXECUTE ON FUNCTION app_private.create_zernio_reply_draft(
  uuid, uuid, uuid, bytea, bytea, bytea, text, bytea
) FROM r72_zernio_social_command;
REVOKE EXECUTE ON FUNCTION app_private.claim_zernio_reply_send(
  uuid, uuid, uuid, uuid, bytea, bytea, bytea, bytea, bytea
) FROM r72_zernio_social_command;

GRANT EXECUTE ON FUNCTION app_private.zernio_reply_channel_truth(
  uuid, uuid, bytea, bytea, text
) TO r72_zernio_social_command;
GRANT EXECUTE ON FUNCTION app_private.create_zernio_reply_draft(
  uuid, uuid, uuid, text, bytea, bytea, bytea, text, bytea
) TO r72_zernio_social_command;
GRANT EXECUTE ON FUNCTION app_private.claim_zernio_reply_send(
  uuid, uuid, uuid, uuid, text, bytea, bytea, bytea, bytea, bytea
) TO r72_zernio_social_command;

RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_zernio_social_definer;

DO $capability_audit$
DECLARE unexpected_execute text;
BEGIN
  IF NOT has_function_privilege(
      'r72_zernio_social_command',
      'app_private.zernio_reply_channel_truth(uuid,uuid,bytea,bytea,text)',
      'EXECUTE'
    )
    OR NOT has_function_privilege(
      'r72_zernio_social_command',
      'app_private.create_zernio_reply_draft(uuid,uuid,uuid,text,bytea,bytea,bytea,text,bytea)',
      'EXECUTE'
    )
    OR NOT has_function_privilege(
      'r72_zernio_social_command',
      'app_private.claim_zernio_reply_send(uuid,uuid,uuid,uuid,text,bytea,bytea,bytea,bytea,bytea)',
      'EXECUTE'
    )
    OR has_function_privilege(
      'r72_zernio_social_command',
      'app_private.create_zernio_reply_draft(uuid,uuid,uuid,bytea,bytea,bytea,text,bytea)',
      'EXECUTE'
    )
    OR has_function_privilege(
      'r72_zernio_social_command',
      'app_private.claim_zernio_reply_send(uuid,uuid,uuid,uuid,bytea,bytea,bytea,bytea,bytea)',
      'EXECUTE'
    ) THEN
    RAISE EXCEPTION 'Zernio network-qualified reply function ACL is unsafe';
  END IF;

  SELECT procedure.oid::regprocedure::text INTO unexpected_execute
  FROM pg_catalog.pg_proc AS procedure
  CROSS JOIN LATERAL pg_catalog.aclexplode(
    coalesce(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))
  ) AS privilege
  WHERE procedure.oid IN (
      pg_catalog.to_regprocedure(
        'app_private.zernio_reply_channel_truth(uuid,uuid,bytea,bytea,text)'
      ),
      pg_catalog.to_regprocedure(
        'app_private.create_zernio_reply_draft(uuid,uuid,uuid,text,bytea,bytea,bytea,text,bytea)'
      ),
      pg_catalog.to_regprocedure(
        'app_private.claim_zernio_reply_send(uuid,uuid,uuid,uuid,text,bytea,bytea,bytea,bytea,bytea)'
      )
    )
    AND privilege.privilege_type = 'EXECUTE'
    AND privilege.grantee <> procedure.proowner
    AND privilege.grantee <> (
      SELECT role.oid FROM pg_catalog.pg_roles AS role
      WHERE role.rolname = 'r72_zernio_social_command'
    )
  LIMIT 1;
  IF unexpected_execute IS NOT NULL THEN
    RAISE EXCEPTION 'Unexpected Zernio reply function grantee: %', unexpected_execute;
  END IF;
END
$capability_audit$;

RESET ROLE;
