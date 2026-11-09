-- Cut the founder calendar over to the approval-gated Zernio job worker.
--
-- The 0094-0096 direct scheduler is retained as immutable history, but every
-- command/probe surface that could create or settle a direct provider effect is
-- revoked. New calendar jobs must prove an immutable TEST-target-to-LIVE-account
-- promotion before entering the existing approval/media/lease state machine.

DO $roles$
DECLARE
  unsafe_membership text;
  effective_creator_grants integer;
  safe_creator_grants integer;
  owner_memberships integer;
  database_owner_oid oid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'r72_zernio_calendar_bootstrap_definer'
  ) THEN
    CREATE ROLE r72_zernio_calendar_bootstrap_definer NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'r72_zernio_calendar_bootstrap_definer'
      AND NOT rolcanlogin AND NOT rolinherit AND NOT rolsuper
      AND NOT rolcreatedb AND NOT rolcreaterole
      AND NOT rolreplication AND NOT rolbypassrls
  ) THEN
    RAISE EXCEPTION 'Unsafe Zernio calendar bootstrap definer attributes';
  END IF;

  REVOKE r72_zernio_calendar_bootstrap_definer
  FROM r72_web, r72_public, r72_worker, r72_webhook, r72_readonly,
    r72_zernio_social_command, r72_owned_social_worker_command,
    r72_public_social_command, r72_public_social_worker_command;
  REVOKE r72_owner, r72_owned_social_definer, r72_zernio_social_definer,
    r72_public_social_definer
  FROM r72_zernio_calendar_bootstrap_definer;
  GRANT r72_zernio_calendar_bootstrap_definer TO r72_owner;

  -- Remove only a separate effective self-grant that this migration identity
  -- could have issued. PostgreSQL 16+ managed CREATEROLE may also leave one
  -- bootstrap-superuser grant to the database owner; that grant cannot be
  -- removed by the owner, so the audit below permits it only when ADMIN is
  -- true while INHERIT and SET are both false.
  SELECT pg_catalog.count(*)::integer INTO effective_creator_grants
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
  JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
  JOIN pg_catalog.pg_roles AS grantor ON grantor.oid = membership.grantor
  WHERE parent.rolname = 'r72_zernio_calendar_bootstrap_definer'
    AND member.rolname = session_user
    AND grantor.rolname = session_user
    AND (
      membership.inherit_option
      OR coalesce(
        (pg_catalog.to_jsonb(membership)->>'set_option')::boolean,
        true
      )
    );
  IF effective_creator_grants > 1 THEN
    RAISE EXCEPTION 'Multiple effective creator grants target the Zernio calendar bootstrap role';
  END IF;
  IF effective_creator_grants = 1 THEN
    EXECUTE pg_catalog.format(
      'REVOKE r72_zernio_calendar_bootstrap_definer FROM %I GRANTED BY %I RESTRICT',
      session_user,
      session_user
    );
  END IF;

  SELECT database.datdba INTO database_owner_oid
  FROM pg_catalog.pg_database AS database
  WHERE database.datname = current_database();

  SELECT pg_catalog.count(*)::integer INTO safe_creator_grants
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
  JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
  JOIN pg_catalog.pg_roles AS grantor ON grantor.oid = membership.grantor
  WHERE parent.rolname = 'r72_zernio_calendar_bootstrap_definer'
    AND member.oid = database_owner_oid
    AND grantor.rolsuper
    AND membership.admin_option
    AND NOT membership.inherit_option
    AND coalesce(
      (pg_catalog.to_jsonb(membership)->>'set_option')::boolean,
      true
    ) IS NOT TRUE;
  SELECT pg_catalog.count(*)::integer INTO owner_memberships
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
  JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
  WHERE parent.rolname = 'r72_zernio_calendar_bootstrap_definer'
    AND member.rolname = 'r72_owner';
  IF safe_creator_grants <> 1 OR owner_memberships <> 1 THEN
    RAISE EXCEPTION 'Zernio calendar bootstrap membership baseline is incomplete';
  END IF;

  SELECT member.rolname || '->' || parent.rolname INTO unsafe_membership
    FROM pg_catalog.pg_auth_members AS membership
    JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
    JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
    JOIN pg_catalog.pg_roles AS grantor ON grantor.oid = membership.grantor
    WHERE parent.rolname = 'r72_zernio_calendar_bootstrap_definer'
      AND NOT (
        member.rolname = 'r72_owner'
        OR (
          member.oid = database_owner_oid
          AND grantor.rolsuper
          AND membership.admin_option
          AND NOT membership.inherit_option
          AND coalesce(
            (pg_catalog.to_jsonb(membership)->>'set_option')::boolean,
            true
          ) IS NOT TRUE
        )
      )
  LIMIT 1;
  IF unsafe_membership IS NOT NULL THEN
    RAISE EXCEPTION 'Unsafe Zernio calendar bootstrap membership: %', unsafe_membership;
  END IF;
END
$roles$;

SET LOCAL ROLE r72_owner;

REVOKE ALL ON SCHEMA app, app_private
  FROM r72_zernio_calendar_bootstrap_definer;
REVOKE ALL ON ALL TABLES IN SCHEMA app
  FROM r72_zernio_calendar_bootstrap_definer;
REVOKE ALL ON ALL TABLES IN SCHEMA app_private
  FROM r72_zernio_calendar_bootstrap_definer;
REVOKE CREATE ON SCHEMA public
  FROM r72_zernio_calendar_bootstrap_definer;

-- Direct schedule rows become evidence-only. Receipts were already immutable.
CREATE TRIGGER property_predator_zernio_direct_schedules_immutable
  BEFORE UPDATE OR DELETE ON app.property_predator_zernio_direct_schedules
  FOR EACH ROW EXECUTE FUNCTION app_private.owned_social_immutable_guard();

-- Give the promotion row exact composite FK anchors. Each added key contains an
-- already-unique identity column, so it cannot collapse or rewrite old rows.
ALTER TABLE app.public_social_planning_intent_targets
  ADD CONSTRAINT public_social_planning_targets_promotion_identity_uq
  UNIQUE (
    workspace_id, intent_id, target_id, provider_connection_id,
    network, environment, account_ref_sha256
  );

ALTER TABLE app.property_predator_zernio_publish_bindings
  ADD CONSTRAINT property_predator_zernio_bindings_promotion_identity_uq
  UNIQUE (
    workspace_id, id, provider_connection_id, provider_id, network,
    zernio_account_id, provider_profile_id_sha256,
    provider_account_id_sha256, publish_capability_evidence_sha256,
    ownership_evidence_sha256
  );

ALTER TABLE app.property_predator_zernio_account_webhook_receipts
  ADD CONSTRAINT property_predator_zernio_receipts_promotion_identity_uq
  UNIQUE (
    workspace_id, event_id, provider_connection_id, environment, event_type,
    network, provider_profile_id_sha256, provider_account_id_sha256,
    receipt_sha256
  );

CREATE TABLE app.property_predator_zernio_calendar_target_promotions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  planning_intent_id uuid NOT NULL,
  planning_target_id uuid NOT NULL,
  test_provider_connection_id uuid NOT NULL,
  test_environment text NOT NULL DEFAULT 'test' CHECK (test_environment = 'test'),
  network text NOT NULL CHECK (network IN ('instagram', 'linkedin')),
  test_account_ref_sha256 bytea NOT NULL
    CHECK (octet_length(test_account_ref_sha256) = 32),
  live_provider_connection_id uuid NOT NULL,
  live_environment text NOT NULL DEFAULT 'live' CHECK (live_environment = 'live'),
  provider_id text NOT NULL DEFAULT 'zernio' CHECK (provider_id = 'zernio'),
  zernio_publish_binding_id uuid NOT NULL,
  zernio_account_id uuid NOT NULL,
  provider_profile_id_sha256 bytea NOT NULL
    CHECK (octet_length(provider_profile_id_sha256) = 32),
  provider_account_id_sha256 bytea NOT NULL
    CHECK (octet_length(provider_account_id_sha256) = 32),
  connected_receipt_id uuid NOT NULL,
  connected_event_type text NOT NULL DEFAULT 'account.connected'
    CHECK (connected_event_type = 'account.connected'),
  ownership_evidence_sha256 bytea NOT NULL
    CHECK (octet_length(ownership_evidence_sha256) = 32),
  publish_capability_evidence_sha256 bytea NOT NULL
    CHECK (octet_length(publish_capability_evidence_sha256) = 32),
  promotion_sha256 bytea NOT NULL CHECK (octet_length(promotion_sha256) = 32),
  promoted_by_user_id uuid NOT NULL,
  promoted_request_id text NOT NULL CHECK (
    promoted_request_id = btrim(promoted_request_id)
    AND length(promoted_request_id) BETWEEN 1 AND 128
  ),
  promoted_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, planning_intent_id, planning_target_id),
  UNIQUE (
    workspace_id, id, live_provider_connection_id,
    zernio_publish_binding_id, zernio_account_id, network
  ),
  FOREIGN KEY (
    workspace_id, planning_intent_id, planning_target_id,
    test_provider_connection_id, network, test_environment,
    test_account_ref_sha256
  ) REFERENCES app.public_social_planning_intent_targets (
    workspace_id, intent_id, target_id, provider_connection_id,
    network, environment, account_ref_sha256
  ) ON DELETE RESTRICT,
  FOREIGN KEY (
    workspace_id, zernio_publish_binding_id, live_provider_connection_id,
    provider_id, network, zernio_account_id,
    provider_profile_id_sha256, provider_account_id_sha256,
    publish_capability_evidence_sha256, ownership_evidence_sha256
  ) REFERENCES app.property_predator_zernio_publish_bindings (
    workspace_id, id, provider_connection_id, provider_id, network,
    zernio_account_id, provider_profile_id_sha256,
    provider_account_id_sha256, publish_capability_evidence_sha256,
    ownership_evidence_sha256
  ) ON DELETE RESTRICT,
  FOREIGN KEY (
    workspace_id, connected_receipt_id, live_provider_connection_id,
    live_environment, connected_event_type, network,
    provider_profile_id_sha256, provider_account_id_sha256,
    ownership_evidence_sha256
  ) REFERENCES app.property_predator_zernio_account_webhook_receipts (
    workspace_id, event_id, provider_connection_id, environment, event_type,
    network, provider_profile_id_sha256, provider_account_id_sha256,
    receipt_sha256
  ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, promoted_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK (promoted_at <= created_at + interval '5 minutes'),
  CHECK (promoted_at >= created_at - interval '5 minutes')
);

CREATE INDEX property_predator_zernio_calendar_target_promotions_live_idx
  ON app.property_predator_zernio_calendar_target_promotions (
    workspace_id, live_provider_connection_id, zernio_account_id, network,
    promoted_at DESC
  );

CREATE TRIGGER property_predator_zernio_calendar_target_promotions_immutable
  BEFORE UPDATE OR DELETE ON app.property_predator_zernio_calendar_target_promotions
  FOR EACH ROW EXECUTE FUNCTION app_private.owned_social_immutable_guard();

ALTER TABLE app.property_predator_zernio_calendar_target_promotions
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.property_predator_zernio_calendar_target_promotions
  FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app.property_predator_zernio_calendar_target_promotions FROM PUBLIC;

CREATE POLICY zernio_calendar_target_promotions_owner_all
  ON app.property_predator_zernio_calendar_target_promotions
  FOR ALL TO r72_owner USING (true) WITH CHECK (true);
CREATE POLICY zernio_calendar_target_promotions_owned_social_definer_all
  ON app.property_predator_zernio_calendar_target_promotions
  FOR ALL TO r72_owned_social_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

GRANT SELECT, INSERT ON app.property_predator_zernio_calendar_target_promotions
  TO r72_owned_social_definer;

CREATE POLICY public_social_targets_owned_social_calendar_select
  ON app.public_social_targets FOR SELECT TO r72_owned_social_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
GRANT SELECT ON app.public_social_targets TO r72_owned_social_definer;

INSERT INTO app_private.workspace_table_registry
  (schema_name, table_name, workspace_column)
VALUES ('app', 'property_predator_zernio_calendar_target_promotions', 'workspace_id');

-- A dedicated NOLOGIN definer may create only the TEST simulator connection.
-- Target/event insertion remains behind the mature 0039 registration function.
CREATE POLICY provider_connections_zernio_calendar_bootstrap_select
  ON app.provider_connections FOR SELECT
  TO r72_zernio_calendar_bootstrap_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY provider_connections_zernio_calendar_bootstrap_insert
  ON app.provider_connections FOR INSERT
  TO r72_zernio_calendar_bootstrap_definer
  WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND provider_id = 'public_social_dark_simulator'
    AND provider_kind = 'social'
    AND environment = 'test'
    AND status = 'active'
    AND capabilities = '["social.publish"]'::jsonb
    AND created_by_user_id = nullif(current_setting('app.user_id', true), '')::uuid
  );
CREATE POLICY workspace_memberships_zernio_calendar_bootstrap_select
  ON app.workspace_memberships FOR SELECT
  TO r72_zernio_calendar_bootstrap_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY zernio_accounts_calendar_bootstrap_select
  ON app.property_predator_zernio_accounts FOR SELECT
  TO r72_zernio_calendar_bootstrap_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY zernio_receipts_calendar_bootstrap_select
  ON app.property_predator_zernio_account_webhook_receipts FOR SELECT
  TO r72_zernio_calendar_bootstrap_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

GRANT USAGE ON SCHEMA app, app_private TO r72_zernio_calendar_bootstrap_definer;
GRANT SELECT, INSERT ON app.provider_connections
  TO r72_zernio_calendar_bootstrap_definer;
GRANT SELECT ON app.workspace_memberships,
  app.property_predator_zernio_accounts,
  app.property_predator_zernio_account_webhook_receipts
  TO r72_zernio_calendar_bootstrap_definer;

SET LOCAL ROLE r72_public_social_definer;
GRANT EXECUTE ON FUNCTION app_private.register_test_social_campaign_target(
  uuid, uuid, uuid, text, text, text
) TO r72_zernio_calendar_bootstrap_definer;
RESET ROLE;
SET LOCAL ROLE r72_owner;

GRANT CREATE ON SCHEMA app_private TO r72_zernio_calendar_bootstrap_definer;
SET LOCAL ROLE r72_zernio_calendar_bootstrap_definer;

CREATE FUNCTION app_private.bootstrap_zernio_calendar_planner_target(
  p_workspace_id uuid,
  p_live_provider_connection_id uuid,
  p_network text,
  p_expected_provider_profile_id_sha256 bytea,
  p_expected_provider_account_id_sha256 bytea
) RETURNS TABLE(
  test_provider_connection_id uuid,
  test_target_id uuid,
  test_account_ref_sha256 bytea,
  disposition text
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE
  selected_user uuid;
  selected_test_connection_id uuid;
  selected_test_target_id uuid;
  selected_test_account_ref text;
  selected_connection_seed text;
  selected_target_seed text;
  selected_registration record;
  connection_created boolean := false;
BEGIN
  IF session_user <> 'r72_zernio_social_command'
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'user'
     OR coalesce(current_setting('app.user_id', true), '') !~ '^[0-9a-f-]{36}$'
     OR coalesce(current_setting('app.request_id', true), '') = ''
     OR current_setting('transaction_isolation') IS DISTINCT FROM 'serializable'
     OR current_setting('transaction_read_only') IS DISTINCT FROM 'off'
     OR p_network NOT IN ('instagram', 'linkedin')
     OR p_expected_provider_profile_id_sha256 IS NULL
     OR octet_length(p_expected_provider_profile_id_sha256) <> 32
     OR p_expected_provider_account_id_sha256 IS NULL
     OR octet_length(p_expected_provider_account_id_sha256) <> 32 THEN
    RAISE EXCEPTION 'Zernio calendar planner bootstrap denied' USING ERRCODE = '42501';
  END IF;
  selected_user := current_setting('app.user_id')::uuid;
  IF NOT EXISTS (
    SELECT 1 FROM app.workspace_memberships AS membership
    WHERE membership.workspace_id = p_workspace_id
      AND membership.user_id = selected_user
      AND membership.status = 'active'
      AND membership.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'Zernio calendar planner bootstrap denied' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'zernio-calendar-planner-bootstrap:' || p_workspace_id::text,
    7200097
  ));

  IF NOT EXISTS (
    SELECT 1
    FROM app.property_predator_zernio_accounts AS account
    JOIN app.provider_connections AS connection
      ON connection.workspace_id = account.workspace_id
     AND connection.id = account.provider_connection_id
     AND connection.environment = account.environment
    JOIN LATERAL (
      SELECT connected.event_id
      FROM app.property_predator_zernio_account_webhook_receipts AS connected
      WHERE connected.workspace_id = account.workspace_id
        AND connected.provider_connection_id = account.provider_connection_id
        AND connected.environment = account.environment
        AND connected.event_type = 'account.connected'
        AND connected.network = account.network
        AND connected.provider_profile_id_sha256 = account.provider_profile_id_sha256
        AND connected.provider_account_id_sha256 = account.provider_account_id_sha256
        AND NOT EXISTS (
          SELECT 1
          FROM app.property_predator_zernio_account_webhook_receipts AS disconnected
          WHERE disconnected.workspace_id = connected.workspace_id
            AND disconnected.provider_connection_id = connected.provider_connection_id
            AND disconnected.environment = connected.environment
            AND disconnected.event_type = 'account.disconnected'
            AND disconnected.network = connected.network
            AND disconnected.provider_profile_id_sha256 = connected.provider_profile_id_sha256
            AND disconnected.provider_account_id_sha256 = connected.provider_account_id_sha256
            AND disconnected.occurred_at >= connected.occurred_at
        )
      ORDER BY connected.occurred_at DESC, connected.received_at DESC,
        connected.event_id DESC
      LIMIT 1
    ) AS current_connection ON true
    WHERE account.workspace_id = p_workspace_id
      AND account.provider_connection_id = p_live_provider_connection_id
      AND account.network = p_network
      AND account.provider_profile_id_sha256 = p_expected_provider_profile_id_sha256
      AND account.provider_account_id_sha256 = p_expected_provider_account_id_sha256
      AND account.status = 'active'
      AND connection.provider_id = 'zernio'
      AND connection.provider_kind = 'social'
      AND connection.environment = 'live'
      AND connection.status = 'active'
  ) THEN
    RAISE EXCEPTION 'Zernio calendar planner live account denied' USING ERRCODE = '42501';
  END IF;

  selected_connection_seed := encode(public.digest(pg_catalog.concat_ws('|',
    'propertypredator.zernio-calendar-test-connection/v1', p_workspace_id
  ), 'sha256'), 'hex');
  selected_test_connection_id := pg_catalog.format(
    '%s-%s-%s-%s-%s',
    substr(selected_connection_seed, 1, 8), substr(selected_connection_seed, 9, 4),
    '5' || substr(selected_connection_seed, 14, 3),
    '8' || substr(selected_connection_seed, 18, 3),
    substr(selected_connection_seed, 21, 12)
  )::uuid;

  SELECT connection.id INTO selected_test_connection_id
  FROM app.provider_connections AS connection
  WHERE connection.workspace_id = p_workspace_id
    AND connection.provider_id = 'public_social_dark_simulator'
    AND connection.provider_kind = 'social'
    AND connection.environment = 'test'
    AND connection.status <> 'disabled';
  IF FOUND THEN
    IF NOT EXISTS (
      SELECT 1 FROM app.provider_connections AS connection
      WHERE connection.workspace_id = p_workspace_id
        AND connection.id = selected_test_connection_id
        AND connection.provider_id = 'public_social_dark_simulator'
        AND connection.provider_kind = 'social'
        AND connection.environment = 'test'
        AND connection.status = 'active'
        AND connection.capabilities @> '["social.publish"]'::jsonb
    ) THEN
      RAISE EXCEPTION 'Zernio calendar TEST planner connection denied'
        USING ERRCODE = '42501';
    END IF;
  ELSE
    selected_connection_seed := encode(public.digest(pg_catalog.concat_ws('|',
      'propertypredator.zernio-calendar-test-connection/v1', p_workspace_id
    ), 'sha256'), 'hex');
    selected_test_connection_id := pg_catalog.format(
      '%s-%s-%s-%s-%s',
      substr(selected_connection_seed, 1, 8), substr(selected_connection_seed, 9, 4),
      '5' || substr(selected_connection_seed, 14, 3),
      '8' || substr(selected_connection_seed, 18, 3),
      substr(selected_connection_seed, 21, 12)
    )::uuid;
    INSERT INTO app.provider_connections (
      id, workspace_id, provider_id, provider_kind, environment, status,
      display_name, capabilities, created_by_user_id
    ) VALUES (
      selected_test_connection_id, p_workspace_id,
      'public_social_dark_simulator', 'social', 'test', 'active',
      'Property Predator social planner (TEST)', '["social.publish"]'::jsonb,
      selected_user
    );
    connection_created := true;
  END IF;

  selected_test_account_ref := 'test-account:' || p_network || ':'
    || encode(p_expected_provider_account_id_sha256, 'hex');
  selected_target_seed := encode(public.digest(pg_catalog.concat_ws('|',
    'propertypredator.zernio-calendar-test-target/v1', p_workspace_id,
    selected_test_connection_id, p_network, selected_test_account_ref
  ), 'sha256'), 'hex');
  selected_test_target_id := pg_catalog.format(
    '%s-%s-%s-%s-%s',
    substr(selected_target_seed, 1, 8), substr(selected_target_seed, 9, 4),
    '5' || substr(selected_target_seed, 14, 3),
    '8' || substr(selected_target_seed, 18, 3),
    substr(selected_target_seed, 21, 12)
  )::uuid;

  SELECT registered.* INTO selected_registration
  FROM app_private.register_test_social_campaign_target(
    p_workspace_id,
    selected_test_target_id,
    selected_test_connection_id,
    p_network,
    selected_test_account_ref,
    'Property Predator ' || initcap(p_network) || ' planner (TEST)'
  ) AS registered;

  RETURN QUERY SELECT
    selected_test_connection_id,
    selected_test_target_id,
    public.digest(selected_test_account_ref, 'sha256'),
    CASE
      WHEN connection_created OR selected_registration.disposition = 'applied'
        THEN 'applied'
      ELSE 'replayed'
    END::text;
END
$function$;


REVOKE ALL ON FUNCTION app_private.bootstrap_zernio_calendar_planner_target(
  uuid, uuid, text, bytea, bytea
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.bootstrap_zernio_calendar_planner_target(
  uuid, uuid, text, bytea, bytea
) TO r72_zernio_social_command;

RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_zernio_calendar_bootstrap_definer;
GRANT CREATE ON SCHEMA app_private TO r72_owned_social_definer;
SET LOCAL ROLE r72_owned_social_definer;

-- Same outer signature keeps the reviewed portal adapter stable. This function
-- now creates/reuses the explicit TEST-to-LIVE promotion in the same transaction
-- and derives V2 digests containing both account hashes and the promotion id.
CREATE OR REPLACE FUNCTION app_private.enqueue_zernio_calendar_from_connected_account(
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
  selected_target record;
  selected_account record;
  selected_binding_id uuid;
  selected_binding_count integer;
  selected_promotion app.property_predator_zernio_calendar_target_promotions%ROWTYPE;
  selected_promotion_id uuid;
  selected_promotion_sha256 bytea;
  selected_content record;
  selected_capability_sha256 bytea;
  selected_idempotency_sha256 bytea;
  selected_request_sha256 bytea;
  selected_job_id uuid;
  selected_verified_at timestamptz := statement_timestamp();
  selected_promoted_at timestamptz := statement_timestamp();
BEGIN
  IF session_user <> 'r72_zernio_social_command'
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'user'
     OR coalesce(current_setting('app.user_id', true), '') !~ '^[0-9a-f-]{36}$'
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

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public-social-planning-target:' || p_workspace_id::text || ':'
        || p_planning_intent_id::text || ':' || p_planning_target_id::text,
      7200040
    )
  );
  SELECT
    target.provider_connection_id AS test_provider_connection_id,
    target.network,
    target.environment,
    target.account_ref_sha256 AS test_account_ref_sha256
  INTO selected_target
  FROM app.public_social_planning_intents AS intent
  JOIN app.public_social_planning_intent_targets AS target
    ON target.workspace_id = intent.workspace_id
   AND target.intent_id = intent.id
  WHERE intent.workspace_id = p_workspace_id
    AND intent.id = p_planning_intent_id
    AND target.target_id = p_planning_target_id
    AND target.network = p_network
    AND target.environment = 'test';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Zernio calendar TEST planning target denied' USING ERRCODE = '42501';
  END IF;

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
    connected_receipt.event_id AS connected_receipt_id,
    connected_receipt.receipt_sha256 AS ownership_evidence_sha256
  INTO selected_account
  FROM app.property_predator_zernio_accounts AS account
  JOIN app.provider_connections AS connection
    ON connection.workspace_id = account.workspace_id
   AND connection.id = account.provider_connection_id
   AND connection.environment = account.environment
  JOIN LATERAL (
    SELECT receipt.event_id, receipt.receipt_sha256
    FROM app.property_predator_zernio_account_webhook_receipts AS receipt
    WHERE receipt.workspace_id = account.workspace_id
      AND receipt.provider_connection_id = account.provider_connection_id
      AND receipt.environment = account.environment
      AND receipt.event_type = 'account.connected'
      AND receipt.network = account.network
      AND receipt.provider_profile_id_sha256 = account.provider_profile_id_sha256
      AND receipt.provider_account_id_sha256 = account.provider_account_id_sha256
      AND NOT EXISTS (
        SELECT 1
        FROM app.property_predator_zernio_account_webhook_receipts AS disconnected_receipt
        WHERE disconnected_receipt.workspace_id = receipt.workspace_id
          AND disconnected_receipt.provider_connection_id = receipt.provider_connection_id
          AND disconnected_receipt.environment = receipt.environment
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

  PERFORM registry.id
  FROM app.public_social_targets AS registry
  JOIN app.provider_connections AS test_connection
    ON test_connection.workspace_id = registry.workspace_id
   AND test_connection.id = registry.provider_connection_id
   AND test_connection.environment = registry.environment
  WHERE registry.workspace_id = p_workspace_id
    AND registry.id = p_planning_target_id
    AND registry.provider_connection_id = selected_target.test_provider_connection_id
    AND registry.network = p_network
    AND registry.environment = 'test'
    AND registry.account_ref_sha256 = selected_target.test_account_ref_sha256
    AND registry.test_account_ref = 'test-account:' || p_network || ':'
      || encode(selected_account.provider_account_id_sha256, 'hex')
    AND test_connection.provider_id = 'public_social_dark_simulator'
    AND test_connection.provider_kind = 'social'
    AND test_connection.environment = 'test'
    AND test_connection.status = 'active'
    AND test_connection.capabilities @> '["social.publish"]'::jsonb;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Zernio calendar TEST-to-LIVE target identity denied'
      USING ERRCODE = '42501';
  END IF;

  selected_capability_sha256 := public.digest(pg_catalog.concat_ws('|',
    'propertypredator.zernio-calendar-publish-capability/v1',
    p_workspace_id, p_provider_connection_id, selected_account.zernio_account_id,
    p_network, encode(selected_account.provider_profile_id_sha256, 'hex'),
    encode(selected_account.provider_account_id_sha256, 'hex'),
    encode(selected_account.ownership_evidence_sha256, 'hex')
  ), 'sha256');

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

  SELECT promotion.* INTO selected_promotion
  FROM app.property_predator_zernio_calendar_target_promotions AS promotion
  WHERE promotion.workspace_id = p_workspace_id
    AND promotion.planning_intent_id = p_planning_intent_id
    AND promotion.planning_target_id = p_planning_target_id;
  IF FOUND THEN
    IF selected_promotion.test_provider_connection_id <> selected_target.test_provider_connection_id
       OR selected_promotion.test_environment <> 'test'
       OR selected_promotion.network <> p_network
       OR selected_promotion.test_account_ref_sha256 <> selected_target.test_account_ref_sha256
       OR selected_promotion.live_provider_connection_id <> p_provider_connection_id
       OR selected_promotion.live_environment <> 'live'
       OR selected_promotion.provider_id <> 'zernio'
       OR selected_promotion.zernio_publish_binding_id <> selected_binding_id
       OR selected_promotion.zernio_account_id <> selected_account.zernio_account_id
       OR selected_promotion.provider_profile_id_sha256 <> selected_account.provider_profile_id_sha256
       OR selected_promotion.provider_account_id_sha256 <> selected_account.provider_account_id_sha256
       OR selected_promotion.connected_receipt_id <> selected_account.connected_receipt_id
       OR selected_promotion.connected_event_type <> 'account.connected'
       OR selected_promotion.ownership_evidence_sha256 <> selected_account.ownership_evidence_sha256
       OR selected_promotion.publish_capability_evidence_sha256 <> selected_capability_sha256 THEN
      RAISE EXCEPTION 'Zernio calendar target promotion conflict' USING ERRCODE = '40001';
    END IF;
    selected_promotion_id := selected_promotion.id;
  ELSE
    selected_promotion_id := gen_random_uuid();
    selected_promotion_sha256 := public.digest(pg_catalog.concat_ws('|',
      'propertypredator.zernio-calendar-target-promotion/v1',
      p_workspace_id, selected_promotion_id, p_planning_intent_id,
      p_planning_target_id, selected_target.test_provider_connection_id,
      p_network, encode(selected_target.test_account_ref_sha256, 'hex'),
      p_provider_connection_id, selected_binding_id,
      selected_account.zernio_account_id,
      encode(selected_account.provider_profile_id_sha256, 'hex'),
      encode(selected_account.provider_account_id_sha256, 'hex'),
      selected_account.connected_receipt_id,
      encode(selected_account.ownership_evidence_sha256, 'hex'),
      encode(selected_capability_sha256, 'hex'), selected_user,
      current_setting('app.request_id'),
      pg_catalog.floor(pg_catalog.date_part('epoch', selected_promoted_at) * 1000000)::bigint
    ), 'sha256');
    INSERT INTO app.property_predator_zernio_calendar_target_promotions (
      id, workspace_id, planning_intent_id, planning_target_id,
      test_provider_connection_id, test_environment, network,
      test_account_ref_sha256, live_provider_connection_id, live_environment,
      provider_id, zernio_publish_binding_id, zernio_account_id,
      provider_profile_id_sha256, provider_account_id_sha256,
      connected_receipt_id, connected_event_type, ownership_evidence_sha256,
      publish_capability_evidence_sha256, promotion_sha256,
      promoted_by_user_id, promoted_request_id, promoted_at
    ) VALUES (
      selected_promotion_id, p_workspace_id, p_planning_intent_id,
      p_planning_target_id, selected_target.test_provider_connection_id,
      'test', p_network, selected_target.test_account_ref_sha256,
      p_provider_connection_id, 'live', 'zernio', selected_binding_id,
      selected_account.zernio_account_id,
      selected_account.provider_profile_id_sha256,
      selected_account.provider_account_id_sha256,
      selected_account.connected_receipt_id, 'account.connected',
      selected_account.ownership_evidence_sha256, selected_capability_sha256,
      selected_promotion_sha256, selected_user,
      current_setting('app.request_id'), selected_promoted_at
    );
  END IF;

  SELECT version.content_sha256,
    public.digest(version.content_body, 'sha256') AS body_sha256
  INTO selected_content
  FROM app.company_content_versions AS version
  WHERE version.workspace_id = p_workspace_id
    AND version.content_item_id = p_content_item_id
    AND version.id = p_content_version_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Zernio calendar content version denied' USING ERRCODE = '42501';
  END IF;

  selected_idempotency_sha256 := public.digest(pg_catalog.concat_ws('|',
    'propertypredator.zernio-calendar-command/v2', p_workspace_id,
    selected_target.test_provider_connection_id, p_provider_connection_id,
    selected_promotion_id, p_network,
    encode(selected_target.test_account_ref_sha256, 'hex'),
    encode(selected_account.provider_profile_id_sha256, 'hex'),
    encode(selected_account.provider_account_id_sha256, 'hex'),
    p_planning_intent_id, p_planning_target_id, p_content_item_id,
    p_content_version_id, p_approval_request_id, p_approval_decision_id,
    p_source_attestation_id, p_operation_tag,
    pg_catalog.floor(pg_catalog.date_part('epoch', p_scheduled_for) * 1000000)::bigint,
    encode(selected_content.content_sha256, 'hex'),
    encode(selected_content.body_sha256, 'hex'), 'daily=1;monthly=3'
  ), 'sha256');
  selected_request_sha256 := public.digest(pg_catalog.concat_ws('|',
    'propertypredator.zernio-calendar-job/v2', p_workspace_id,
    selected_promotion_id, selected_target.test_provider_connection_id,
    p_provider_connection_id, selected_binding_id, selected_account.zernio_account_id,
    p_network, encode(selected_target.test_account_ref_sha256, 'hex'),
    encode(selected_account.provider_profile_id_sha256, 'hex'),
    encode(selected_account.provider_account_id_sha256, 'hex'),
    p_planning_intent_id, p_planning_target_id, p_content_item_id,
    p_content_version_id, p_approval_request_id, p_approval_decision_id,
    p_source_attestation_id, p_operation_tag,
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

CREATE FUNCTION app_private.list_zernio_calendar_jobs(
  p_workspace_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_limit integer
) RETURNS TABLE(
  job_id uuid,
  network text,
  content_body text,
  scheduled_for timestamptz,
  state text,
  provider_external_id text,
  safe_code text,
  created_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $function$
  SELECT job.id, job.network, job.text_body, job.scheduled_for, job.state,
    job.provider_external_id, latest_receipt.safe_code, job.created_at
  FROM app.property_predator_owned_social_jobs AS job
  LEFT JOIN LATERAL (
    SELECT receipt.safe_code
    FROM app.property_predator_owned_social_receipts AS receipt
    WHERE receipt.workspace_id = job.workspace_id
      AND receipt.job_id = job.id
      AND receipt.provider_id = 'zernio'
    ORDER BY receipt.recorded_at DESC, receipt.lease_version DESC, receipt.id DESC
    LIMIT 1
  ) AS latest_receipt ON true
  WHERE session_user = 'r72_zernio_social_command'
    AND current_setting('app.workspace_id', true) = p_workspace_id::text
    AND current_setting('app.actor_kind', true) = 'user'
    AND current_setting('app.user_id', true) ~ '^[0-9a-f-]{36}$'
    AND coalesce(current_setting('app.request_id', true), '') <> ''
    AND p_from IS NOT NULL AND p_to IS NOT NULL AND p_from < p_to
    AND p_to <= p_from + interval '366 days'
    AND p_limit BETWEEN 1 AND 100
    AND job.workspace_id = p_workspace_id
    AND job.provider_id = 'zernio'
    AND job.scheduled_for >= p_from AND job.scheduled_for < p_to
    AND EXISTS (
      SELECT 1 FROM app.workspace_memberships AS membership
      WHERE membership.workspace_id = job.workspace_id
        AND membership.user_id = current_setting('app.user_id')::uuid
        AND membership.status = 'active'
    )
  ORDER BY job.scheduled_for, job.created_at, job.id
  LIMIT p_limit;
$function$;

-- Same signature, V2 semantics. The inner command is no longer executable by
-- the login role; only the outer SECURITY DEFINER command can reach it.
CREATE OR REPLACE FUNCTION app_private.enqueue_zernio_calendar_job(
  p_workspace_id uuid, p_provider_connection_id uuid, p_binding_id uuid,
  p_zernio_account_id uuid, p_network text,
  p_expected_provider_profile_id_sha256 bytea,
  p_expected_provider_account_id_sha256 bytea,
  p_planning_intent_id uuid, p_planning_target_id uuid,
  p_content_item_id uuid, p_content_version_id uuid,
  p_approval_request_id uuid, p_approval_decision_id uuid,
  p_source_attestation_id uuid, p_operation_tag text,
  p_idempotency_key_sha256 bytea, p_request_sha256 bytea,
  p_scheduled_for timestamptz
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE
  selected_user uuid;
  selected_id uuid := gen_random_uuid();
  existing record;
  selected_version record;
  selected_promotion record;
  selected_effect_at timestamptz;
  selected_media_count integer;
  planned_media_count integer;
  expected_idempotency_sha256 bytea;
  expected_request_sha256 bytea;
BEGIN
  IF session_user <> 'r72_zernio_social_command'
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'user'
     OR coalesce(current_setting('app.user_id', true), '') !~ '^[0-9a-f-]{36}$'
     OR coalesce(current_setting('app.request_id', true), '') = ''
     OR p_network NOT IN ('instagram', 'linkedin')
     OR p_expected_provider_profile_id_sha256 IS NULL
     OR octet_length(p_expected_provider_profile_id_sha256) <> 32
     OR p_expected_provider_account_id_sha256 IS NULL
     OR octet_length(p_expected_provider_account_id_sha256) <> 32
     OR p_planning_intent_id IS NULL OR p_planning_target_id IS NULL
     OR p_scheduled_for IS NULL
     OR p_operation_tag IS NULL
     OR p_operation_tag !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$'
     OR p_idempotency_key_sha256 IS NULL
     OR octet_length(p_idempotency_key_sha256) <> 32
     OR p_request_sha256 IS NULL
     OR octet_length(p_request_sha256) <> 32 THEN
    RAISE EXCEPTION 'Zernio calendar enqueue denied' USING ERRCODE = '42501';
  END IF;
  selected_user := current_setting('app.user_id')::uuid;
  IF NOT EXISTS (
    SELECT 1 FROM app.workspace_memberships AS membership
    WHERE membership.workspace_id = p_workspace_id AND membership.user_id = selected_user
      AND membership.status = 'active' AND membership.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'Zernio calendar enqueue denied' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public-social-planning-target:' || p_workspace_id::text || ':'
        || p_planning_intent_id::text || ':' || p_planning_target_id::text,
      7200040
    )
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'zernio-calendar-publish-binding:' || p_workspace_id::text || ':'
        || p_binding_id::text,
      7200085
    )
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'zernio-calendar-publish-account:' || p_workspace_id::text || ':'
        || p_zernio_account_id::text || ':' || p_network,
      7200085
    )
  );

  PERFORM binding.id
  FROM app.property_predator_zernio_publish_bindings AS binding
  JOIN app.property_predator_zernio_accounts AS account
    ON account.workspace_id = binding.workspace_id
   AND account.id = binding.zernio_account_id
   AND account.provider_connection_id = binding.provider_connection_id
   AND account.provider_profile_id_sha256 = binding.provider_profile_id_sha256
   AND account.provider_account_id_sha256 = binding.provider_account_id_sha256
   AND account.network = binding.network
  JOIN app.provider_connections AS connection
    ON connection.workspace_id = binding.workspace_id
   AND connection.id = binding.provider_connection_id
   AND connection.environment = binding.environment
  WHERE binding.workspace_id = p_workspace_id AND binding.id = p_binding_id
    AND binding.provider_connection_id = p_provider_connection_id
    AND binding.zernio_account_id = p_zernio_account_id
    AND binding.provider_id = 'zernio' AND binding.network = p_network
    AND binding.provider_profile_id_sha256 = p_expected_provider_profile_id_sha256
    AND binding.provider_account_id_sha256 = p_expected_provider_account_id_sha256
    AND account.status = 'active'
    AND connection.provider_id = 'zernio' AND connection.provider_kind = 'social'
    AND connection.environment = 'live' AND connection.status = 'active'
    AND NOT EXISTS (
      SELECT 1 FROM app.property_predator_zernio_publish_binding_revocations AS revocation
      WHERE revocation.workspace_id = binding.workspace_id
        AND revocation.binding_id = binding.id
    );
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Zernio calendar publish binding denied' USING ERRCODE = '42501';
  END IF;

  SELECT
    promotion.id,
    promotion.test_provider_connection_id,
    promotion.test_account_ref_sha256,
    promotion.promotion_sha256
  INTO selected_promotion
  FROM app.property_predator_zernio_calendar_target_promotions AS promotion
  JOIN app.public_social_planning_intent_targets AS target
    ON target.workspace_id = promotion.workspace_id
   AND target.intent_id = promotion.planning_intent_id
   AND target.target_id = promotion.planning_target_id
   AND target.provider_connection_id = promotion.test_provider_connection_id
   AND target.network = promotion.network
   AND target.environment = promotion.test_environment
   AND target.account_ref_sha256 = promotion.test_account_ref_sha256
  JOIN app.public_social_targets AS registry
    ON registry.workspace_id = target.workspace_id
   AND registry.id = target.target_id
   AND registry.provider_connection_id = target.provider_connection_id
   AND registry.network = target.network
   AND registry.environment = target.environment
   AND registry.account_ref_sha256 = target.account_ref_sha256
  JOIN app.provider_connections AS test_connection
    ON test_connection.workspace_id = registry.workspace_id
   AND test_connection.id = registry.provider_connection_id
   AND test_connection.environment = registry.environment
  JOIN app.property_predator_zernio_account_webhook_receipts AS connected_receipt
    ON connected_receipt.workspace_id = promotion.workspace_id
   AND connected_receipt.event_id = promotion.connected_receipt_id
   AND connected_receipt.provider_connection_id = promotion.live_provider_connection_id
   AND connected_receipt.environment = promotion.live_environment
   AND connected_receipt.event_type = promotion.connected_event_type
   AND connected_receipt.network = promotion.network
   AND connected_receipt.provider_profile_id_sha256 = promotion.provider_profile_id_sha256
   AND connected_receipt.provider_account_id_sha256 = promotion.provider_account_id_sha256
   AND connected_receipt.receipt_sha256 = promotion.ownership_evidence_sha256
  WHERE promotion.workspace_id = p_workspace_id
    AND promotion.planning_intent_id = p_planning_intent_id
    AND promotion.planning_target_id = p_planning_target_id
    AND promotion.live_provider_connection_id = p_provider_connection_id
    AND promotion.provider_id = 'zernio'
    AND promotion.zernio_publish_binding_id = p_binding_id
    AND promotion.zernio_account_id = p_zernio_account_id
    AND promotion.network = p_network
    AND promotion.provider_profile_id_sha256 = p_expected_provider_profile_id_sha256
    AND promotion.provider_account_id_sha256 = p_expected_provider_account_id_sha256
    AND promotion.connected_event_type = 'account.connected'
    AND registry.test_account_ref = 'test-account:' || p_network || ':'
      || encode(p_expected_provider_account_id_sha256, 'hex')
    AND test_connection.provider_id = 'public_social_dark_simulator'
    AND test_connection.provider_kind = 'social'
    AND test_connection.environment = 'test'
    AND test_connection.status = 'active'
    AND test_connection.capabilities @> '["social.publish"]'::jsonb
    AND promotion.promotion_sha256 = public.digest(pg_catalog.concat_ws('|',
      'propertypredator.zernio-calendar-target-promotion/v1',
      promotion.workspace_id, promotion.id, promotion.planning_intent_id,
      promotion.planning_target_id, promotion.test_provider_connection_id,
      promotion.network, encode(promotion.test_account_ref_sha256, 'hex'),
      promotion.live_provider_connection_id, promotion.zernio_publish_binding_id,
      promotion.zernio_account_id,
      encode(promotion.provider_profile_id_sha256, 'hex'),
      encode(promotion.provider_account_id_sha256, 'hex'),
      promotion.connected_receipt_id,
      encode(promotion.ownership_evidence_sha256, 'hex'),
      encode(promotion.publish_capability_evidence_sha256, 'hex'),
      promotion.promoted_by_user_id, promotion.promoted_request_id,
      pg_catalog.floor(pg_catalog.date_part('epoch', promotion.promoted_at) * 1000000)::bigint
    ), 'sha256')
    AND NOT EXISTS (
      SELECT 1
      FROM app.property_predator_zernio_account_webhook_receipts AS disconnected_receipt
      WHERE disconnected_receipt.workspace_id = connected_receipt.workspace_id
        AND disconnected_receipt.provider_connection_id = connected_receipt.provider_connection_id
        AND disconnected_receipt.event_type = 'account.disconnected'
        AND disconnected_receipt.network = connected_receipt.network
        AND disconnected_receipt.provider_profile_id_sha256 = connected_receipt.provider_profile_id_sha256
        AND disconnected_receipt.provider_account_id_sha256 = connected_receipt.provider_account_id_sha256
        AND disconnected_receipt.occurred_at >= connected_receipt.occurred_at
    );
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Zernio calendar target promotion denied' USING ERRCODE = '42501';
  END IF;

  SELECT version.content_body, version.content_sha256 INTO selected_version
  FROM app.public_social_planning_intents AS intent
  JOIN app.public_social_planning_intent_targets AS target
    ON target.workspace_id = intent.workspace_id
   AND target.intent_id = intent.id
   AND target.target_id = p_planning_target_id
   AND target.network = p_network
   AND target.provider_connection_id = selected_promotion.test_provider_connection_id
   AND target.environment = 'test'
   AND target.account_ref_sha256 = selected_promotion.test_account_ref_sha256
  JOIN app.company_content_versions AS version
    ON version.workspace_id = intent.workspace_id
   AND version.content_item_id = intent.content_item_id
   AND version.id = intent.content_version_id
   AND version.content_sha256 = intent.content_sha256
  JOIN app.company_content_approval_requests AS request
    ON request.workspace_id = version.workspace_id AND request.id = p_approval_request_id
   AND request.content_item_id = version.content_item_id
   AND request.content_version_id = version.id
   AND request.content_sha256 = version.content_sha256
  JOIN app.company_content_approval_decisions AS decision
    ON decision.workspace_id = request.workspace_id AND decision.id = p_approval_decision_id
   AND decision.approval_request_id = request.id AND decision.decision = 'approved'
  JOIN app.company_content_source_attestations AS attestation
    ON attestation.workspace_id = version.workspace_id AND attestation.id = p_source_attestation_id
   AND attestation.content_item_id = version.content_item_id
   AND attestation.content_version_id = version.id
   AND attestation.content_sha256 = version.content_sha256
   AND attestation.blob_sha256 = version.blob_sha256
   AND attestation.brand_sha256 = version.brand_sha256
  WHERE intent.workspace_id = p_workspace_id AND intent.id = p_planning_intent_id
    AND intent.content_item_id = p_content_item_id
    AND intent.content_version_id = p_content_version_id
    AND intent.approval_request_id = p_approval_request_id
    AND intent.approval_decision_id = p_approval_decision_id
    AND intent.planning_source_attestation_id = p_source_attestation_id
    AND intent.desired_for = p_scheduled_for
    AND version.content_kind = 'social_post'
    AND attestation.checked_at <= statement_timestamp()
    AND attestation.expires_at > statement_timestamp()
    AND NOT EXISTS (
      SELECT 1 FROM app.public_social_planning_target_cancellations AS cancellation
      WHERE cancellation.workspace_id = target.workspace_id
        AND cancellation.intent_id = target.intent_id
        AND cancellation.target_id = target.target_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM app.public_social_planning_target_supersessions AS supersession
      WHERE supersession.workspace_id = target.workspace_id
        AND supersession.predecessor_intent_id = target.intent_id
        AND supersession.predecessor_target_id = target.target_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM app.company_content_approval_requests AS later_request
      WHERE later_request.workspace_id = request.workspace_id
        AND later_request.content_item_id = request.content_item_id
        AND later_request.content_version_id = request.content_version_id
        AND later_request.request_number > request.request_number
    )
    AND NOT EXISTS (
      SELECT 1 FROM app.company_content_versions AS newer
      WHERE newer.workspace_id = version.workspace_id
        AND newer.content_item_id = version.content_item_id
        AND newer.version_number > version.version_number
    );
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Zernio calendar content evidence denied' USING ERRCODE = '42501';
  END IF;
  IF length(selected_version.content_body) >
      (CASE p_network WHEN 'instagram' THEN 2200 ELSE 3000 END) THEN
    RAISE EXCEPTION 'Zernio calendar network text denied' USING ERRCODE = '22023';
  END IF;

  expected_idempotency_sha256 := public.digest(pg_catalog.concat_ws('|',
    'propertypredator.zernio-calendar-command/v2', p_workspace_id,
    selected_promotion.test_provider_connection_id, p_provider_connection_id,
    selected_promotion.id, p_network,
    encode(selected_promotion.test_account_ref_sha256, 'hex'),
    encode(p_expected_provider_profile_id_sha256, 'hex'),
    encode(p_expected_provider_account_id_sha256, 'hex'),
    p_planning_intent_id, p_planning_target_id, p_content_item_id,
    p_content_version_id, p_approval_request_id, p_approval_decision_id,
    p_source_attestation_id, p_operation_tag,
    pg_catalog.floor(pg_catalog.date_part('epoch', p_scheduled_for) * 1000000)::bigint,
    encode(selected_version.content_sha256, 'hex'),
    encode(public.digest(selected_version.content_body, 'sha256'), 'hex'),
    'daily=1;monthly=3'
  ), 'sha256');
  expected_request_sha256 := public.digest(pg_catalog.concat_ws('|',
    'propertypredator.zernio-calendar-job/v2', p_workspace_id,
    selected_promotion.id, selected_promotion.test_provider_connection_id,
    p_provider_connection_id, p_binding_id, p_zernio_account_id, p_network,
    encode(selected_promotion.test_account_ref_sha256, 'hex'),
    encode(p_expected_provider_profile_id_sha256, 'hex'),
    encode(p_expected_provider_account_id_sha256, 'hex'),
    p_planning_intent_id, p_planning_target_id, p_content_item_id,
    p_content_version_id, p_approval_request_id, p_approval_decision_id,
    p_source_attestation_id, p_operation_tag,
    pg_catalog.floor(pg_catalog.date_part('epoch', p_scheduled_for) * 1000000)::bigint,
    encode(selected_version.content_sha256, 'hex'),
    encode(public.digest(selected_version.content_body, 'sha256'), 'hex')
  ), 'sha256');
  IF p_idempotency_key_sha256 <> expected_idempotency_sha256
     OR p_request_sha256 <> expected_request_sha256 THEN
    RAISE EXCEPTION 'Zernio calendar command digest denied' USING ERRCODE = '42501';
  END IF;

  SELECT count(*) INTO selected_media_count
  FROM app.public_social_planning_intent_media AS planned_media
  JOIN app.company_content_versions AS media_version
    ON media_version.workspace_id = planned_media.workspace_id
   AND media_version.content_item_id = planned_media.content_item_id
   AND media_version.id = planned_media.content_version_id
   AND media_version.content_sha256 = planned_media.content_sha256
   AND media_version.blob_sha256 = planned_media.blob_sha256
  JOIN app.company_content_approval_requests AS media_request
    ON media_request.workspace_id = planned_media.workspace_id
   AND media_request.id = planned_media.approval_request_id
   AND media_request.content_item_id = planned_media.content_item_id
   AND media_request.content_version_id = planned_media.content_version_id
   AND media_request.content_sha256 = planned_media.content_sha256
  JOIN app.company_content_approval_decisions AS media_decision
    ON media_decision.workspace_id = planned_media.workspace_id
   AND media_decision.id = planned_media.approval_decision_id
   AND media_decision.approval_request_id = planned_media.approval_request_id
   AND media_decision.decision = 'approved'
  JOIN app.company_content_source_attestations AS media_attestation
    ON media_attestation.workspace_id = planned_media.workspace_id
   AND media_attestation.id = planned_media.planning_source_attestation_id
   AND media_attestation.content_item_id = planned_media.content_item_id
   AND media_attestation.content_version_id = planned_media.content_version_id
   AND media_attestation.content_sha256 = planned_media.content_sha256
   AND media_attestation.blob_sha256 = planned_media.blob_sha256
   AND media_attestation.brand_sha256 = planned_media.brand_sha256
  WHERE planned_media.workspace_id = p_workspace_id
    AND planned_media.intent_id = p_planning_intent_id
    AND media_version.content_kind IN ('image', 'video')
    AND media_attestation.checked_at <= statement_timestamp()
    AND media_attestation.expires_at > statement_timestamp()
    AND NOT EXISTS (
      SELECT 1 FROM app.company_content_versions AS newer_media
      WHERE newer_media.workspace_id = media_version.workspace_id
        AND newer_media.content_item_id = media_version.content_item_id
        AND newer_media.version_number > media_version.version_number
    )
    AND NOT EXISTS (
      SELECT 1 FROM app.company_content_approval_requests AS later_media_request
      WHERE later_media_request.workspace_id = media_request.workspace_id
        AND later_media_request.content_item_id = media_request.content_item_id
        AND later_media_request.content_version_id = media_request.content_version_id
        AND later_media_request.request_number > media_request.request_number
    );
  SELECT count(*) INTO planned_media_count
  FROM app.public_social_planning_intent_media AS planned_media
  WHERE planned_media.workspace_id = p_workspace_id
    AND planned_media.intent_id = p_planning_intent_id;
  IF selected_media_count <> planned_media_count
     OR (p_network = 'instagram' AND selected_media_count NOT BETWEEN 1 AND 10)
     OR (p_network = 'linkedin' AND selected_media_count > 9) THEN
    RAISE EXCEPTION 'Zernio calendar network media denied' USING ERRCODE = '22023';
  END IF;

  SELECT job.* INTO existing
  FROM app.property_predator_owned_social_jobs AS job
  WHERE job.workspace_id = p_workspace_id
    AND job.idempotency_key_sha256 = p_idempotency_key_sha256;
  IF FOUND THEN
    IF existing.request_sha256 <> p_request_sha256
       OR existing.provider_id <> 'zernio'
       OR existing.provider_connection_id <> p_provider_connection_id
       OR existing.profile_id IS NOT NULL
       OR existing.zernio_publish_binding_id <> p_binding_id
       OR existing.zernio_account_id <> p_zernio_account_id
       OR existing.network <> p_network
       OR existing.planning_intent_id <> p_planning_intent_id
       OR existing.planning_target_id <> p_planning_target_id
       OR existing.content_item_id <> p_content_item_id
       OR existing.content_version_id <> p_content_version_id
       OR existing.approval_request_id <> p_approval_request_id
       OR existing.approval_decision_id <> p_approval_decision_id
       OR existing.source_attestation_id <> p_source_attestation_id
       OR existing.operation_tag <> p_operation_tag
       OR existing.scheduled_for <> p_scheduled_for THEN
      RAISE EXCEPTION 'Zernio calendar idempotency conflict' USING ERRCODE = '40001';
    END IF;
    RETURN existing.id;
  END IF;

  selected_effect_at := greatest(statement_timestamp(), p_scheduled_for);
  IF (SELECT count(*) FROM app.property_predator_owned_social_jobs AS job
      WHERE job.workspace_id = p_workspace_id AND job.provider_id = 'zernio'
        AND job.zernio_account_id = p_zernio_account_id
        AND job.network = p_network
        AND job.utc_day = (selected_effect_at AT TIME ZONE 'UTC')::date
        AND job.state <> 'cancelled') >= 1
     OR (SELECT count(*) FROM app.property_predator_owned_social_jobs AS job
      WHERE job.workspace_id = p_workspace_id AND job.provider_id = 'zernio'
        AND job.zernio_account_id = p_zernio_account_id
        AND job.network = p_network
        AND job.utc_month = date_trunc('month', selected_effect_at AT TIME ZONE 'UTC')::date
        AND job.state <> 'cancelled') >= 3 THEN
    RAISE EXCEPTION 'Zernio calendar hard publish cap reached' USING ERRCODE = '42501';
  END IF;

  INSERT INTO app.property_predator_owned_social_jobs (
    id, workspace_id, provider_connection_id, provider_id, profile_id,
    zernio_publish_binding_id, zernio_account_id, environment, network,
    planning_intent_id, planning_target_id, content_item_id,
    content_version_id, content_sha256, approval_request_id,
    approval_decision_id, source_attestation_id, operation_tag,
    idempotency_key_sha256, request_sha256, text_body, scheduled_for,
    utc_day, utc_month, available_at, created_by_user_id
  ) VALUES (
    selected_id, p_workspace_id, p_provider_connection_id, 'zernio', NULL,
    p_binding_id, p_zernio_account_id, 'live', p_network,
    p_planning_intent_id, p_planning_target_id, p_content_item_id,
    p_content_version_id, selected_version.content_sha256,
    p_approval_request_id, p_approval_decision_id, p_source_attestation_id,
    p_operation_tag, p_idempotency_key_sha256, p_request_sha256,
    selected_version.content_body, p_scheduled_for,
    (selected_effect_at AT TIME ZONE 'UTC')::date,
    date_trunc('month', selected_effect_at AT TIME ZONE 'UTC')::date,
    selected_effect_at, selected_user
  );

  INSERT INTO app.property_predator_owned_social_job_media (
    workspace_id, job_id, ordinal, content_item_id, content_version_id,
    content_sha256, blob_sha256, blob_storage_key, content_mime_type,
    approval_request_id, approval_decision_id, source_attestation_id
  )
  SELECT planned_media.workspace_id, selected_id, planned_media.ordinal,
    planned_media.content_item_id, planned_media.content_version_id,
    planned_media.content_sha256, planned_media.blob_sha256,
    media_version.blob_storage_key, media_version.content_mime_type,
    planned_media.approval_request_id, planned_media.approval_decision_id,
    planned_media.planning_source_attestation_id
  FROM app.public_social_planning_intent_media AS planned_media
  JOIN app.company_content_versions AS media_version
    ON media_version.workspace_id = planned_media.workspace_id
   AND media_version.content_item_id = planned_media.content_item_id
   AND media_version.id = planned_media.content_version_id
  WHERE planned_media.workspace_id = p_workspace_id
    AND planned_media.intent_id = p_planning_intent_id
  ORDER BY planned_media.ordinal;
  RETURN selected_id;
END
$function$;

-- Effect-time authorization follows the explicit immutable promotion rather
-- than comparing the TEST planner-account hash with the LIVE provider-account
-- hash. The worker still has to satisfy every 0080 content/media proof and the
-- 0085 live binding check; this predicate adds the exact TEST-to-LIVE bridge.
CREATE OR REPLACE FUNCTION app_private.zernio_calendar_job_effect_ready(
  p_workspace_id uuid, p_job_id uuid
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $function$
  SELECT app_private.owned_social_job_effect_ready_v2(p_workspace_id, p_job_id)
    AND app_private.zernio_calendar_binding_ready(p_workspace_id, p_job_id)
    AND EXISTS (
      SELECT 1
      FROM app.property_predator_owned_social_jobs AS job
      JOIN app.property_predator_zernio_calendar_target_promotions AS promotion
        ON promotion.workspace_id = job.workspace_id
       AND promotion.planning_intent_id = job.planning_intent_id
       AND promotion.planning_target_id = job.planning_target_id
       AND promotion.live_provider_connection_id = job.provider_connection_id
       AND promotion.provider_id = job.provider_id
       AND promotion.zernio_publish_binding_id = job.zernio_publish_binding_id
       AND promotion.zernio_account_id = job.zernio_account_id
       AND promotion.network = job.network
      JOIN app.public_social_planning_intent_targets AS planned_target
        ON planned_target.workspace_id = promotion.workspace_id
       AND planned_target.intent_id = promotion.planning_intent_id
       AND planned_target.target_id = promotion.planning_target_id
       AND planned_target.provider_connection_id = promotion.test_provider_connection_id
       AND planned_target.network = promotion.network
       AND planned_target.environment = promotion.test_environment
       AND planned_target.account_ref_sha256 = promotion.test_account_ref_sha256
      JOIN app.public_social_targets AS registry
        ON registry.workspace_id = planned_target.workspace_id
       AND registry.id = planned_target.target_id
       AND registry.provider_connection_id = planned_target.provider_connection_id
       AND registry.network = planned_target.network
       AND registry.environment = planned_target.environment
       AND registry.account_ref_sha256 = planned_target.account_ref_sha256
      JOIN app.provider_connections AS test_connection
        ON test_connection.workspace_id = registry.workspace_id
       AND test_connection.id = registry.provider_connection_id
       AND test_connection.environment = registry.environment
      JOIN app.property_predator_zernio_publish_bindings AS binding
        ON binding.workspace_id = promotion.workspace_id
       AND binding.id = promotion.zernio_publish_binding_id
       AND binding.provider_connection_id = promotion.live_provider_connection_id
       AND binding.provider_id = promotion.provider_id
       AND binding.network = promotion.network
       AND binding.zernio_account_id = promotion.zernio_account_id
       AND binding.provider_profile_id_sha256 = promotion.provider_profile_id_sha256
       AND binding.provider_account_id_sha256 = promotion.provider_account_id_sha256
       AND binding.publish_capability_evidence_sha256 =
         promotion.publish_capability_evidence_sha256
       AND binding.ownership_evidence_sha256 = promotion.ownership_evidence_sha256
      JOIN app.property_predator_zernio_accounts AS account
        ON account.workspace_id = binding.workspace_id
       AND account.id = binding.zernio_account_id
       AND account.provider_connection_id = binding.provider_connection_id
       AND account.environment = binding.environment
       AND account.network = binding.network
       AND account.provider_profile_id_sha256 = binding.provider_profile_id_sha256
       AND account.provider_account_id_sha256 = binding.provider_account_id_sha256
      JOIN app.provider_connections AS live_connection
        ON live_connection.workspace_id = binding.workspace_id
       AND live_connection.id = binding.provider_connection_id
       AND live_connection.environment = binding.environment
      JOIN app.property_predator_zernio_account_webhook_receipts AS connected_receipt
        ON connected_receipt.workspace_id = promotion.workspace_id
       AND connected_receipt.event_id = promotion.connected_receipt_id
       AND connected_receipt.provider_connection_id = promotion.live_provider_connection_id
       AND connected_receipt.environment = promotion.live_environment
       AND connected_receipt.event_type = promotion.connected_event_type
       AND connected_receipt.network = promotion.network
       AND connected_receipt.provider_profile_id_sha256 =
         promotion.provider_profile_id_sha256
       AND connected_receipt.provider_account_id_sha256 =
         promotion.provider_account_id_sha256
       AND connected_receipt.receipt_sha256 = promotion.ownership_evidence_sha256
      WHERE job.workspace_id = p_workspace_id AND job.id = p_job_id
        AND job.provider_id = 'zernio' AND job.profile_id IS NULL
        AND promotion.test_environment = 'test'
        AND promotion.live_environment = 'live'
        AND promotion.connected_event_type = 'account.connected'
        AND registry.test_account_ref = 'test-account:' || job.network || ':'
          || encode(promotion.provider_account_id_sha256, 'hex')
        AND test_connection.provider_id = 'public_social_dark_simulator'
        AND test_connection.provider_kind = 'social'
        AND test_connection.environment = 'test'
        AND test_connection.status = 'active'
        AND test_connection.capabilities @> '["social.publish"]'::jsonb
        AND account.status = 'active'
        AND live_connection.provider_id = 'zernio'
        AND live_connection.provider_kind = 'social'
        AND live_connection.environment = 'live'
        AND live_connection.status = 'active'
        AND promotion.promotion_sha256 = public.digest(pg_catalog.concat_ws('|',
          'propertypredator.zernio-calendar-target-promotion/v1',
          promotion.workspace_id, promotion.id, promotion.planning_intent_id,
          promotion.planning_target_id, promotion.test_provider_connection_id,
          promotion.network, encode(promotion.test_account_ref_sha256, 'hex'),
          promotion.live_provider_connection_id,
          promotion.zernio_publish_binding_id, promotion.zernio_account_id,
          encode(promotion.provider_profile_id_sha256, 'hex'),
          encode(promotion.provider_account_id_sha256, 'hex'),
          promotion.connected_receipt_id,
          encode(promotion.ownership_evidence_sha256, 'hex'),
          encode(promotion.publish_capability_evidence_sha256, 'hex'),
          promotion.promoted_by_user_id, promotion.promoted_request_id,
          pg_catalog.floor(
            pg_catalog.date_part('epoch', promotion.promoted_at) * 1000000
          )::bigint
        ), 'sha256')
        AND job.idempotency_key_sha256 = public.digest(pg_catalog.concat_ws('|',
          'propertypredator.zernio-calendar-command/v2', job.workspace_id,
          promotion.test_provider_connection_id, job.provider_connection_id,
          promotion.id, job.network,
          encode(promotion.test_account_ref_sha256, 'hex'),
          encode(promotion.provider_profile_id_sha256, 'hex'),
          encode(promotion.provider_account_id_sha256, 'hex'),
          job.planning_intent_id, job.planning_target_id, job.content_item_id,
          job.content_version_id, job.approval_request_id,
          job.approval_decision_id, job.source_attestation_id,
          job.operation_tag,
          pg_catalog.floor(
            pg_catalog.date_part('epoch', job.scheduled_for) * 1000000
          )::bigint,
          encode(job.content_sha256, 'hex'), encode(job.text_sha256, 'hex'),
          'daily=1;monthly=3'
        ), 'sha256')
        AND job.request_sha256 = public.digest(pg_catalog.concat_ws('|',
          'propertypredator.zernio-calendar-job/v2', job.workspace_id,
          promotion.id, promotion.test_provider_connection_id,
          job.provider_connection_id, job.zernio_publish_binding_id,
          job.zernio_account_id, job.network,
          encode(promotion.test_account_ref_sha256, 'hex'),
          encode(promotion.provider_profile_id_sha256, 'hex'),
          encode(promotion.provider_account_id_sha256, 'hex'),
          job.planning_intent_id, job.planning_target_id, job.content_item_id,
          job.content_version_id, job.approval_request_id,
          job.approval_decision_id, job.source_attestation_id,
          job.operation_tag,
          pg_catalog.floor(
            pg_catalog.date_part('epoch', job.scheduled_for) * 1000000
          )::bigint,
          encode(job.content_sha256, 'hex'), encode(job.text_sha256, 'hex')
        ), 'sha256')
        AND NOT EXISTS (
          SELECT 1
          FROM app.property_predator_zernio_account_webhook_receipts AS disconnected
          WHERE disconnected.workspace_id = connected_receipt.workspace_id
            AND disconnected.provider_connection_id =
              connected_receipt.provider_connection_id
            AND disconnected.event_type = 'account.disconnected'
            AND disconnected.network = connected_receipt.network
            AND disconnected.provider_profile_id_sha256 =
              connected_receipt.provider_profile_id_sha256
            AND disconnected.provider_account_id_sha256 =
              connected_receipt.provider_account_id_sha256
            AND disconnected.occurred_at >= connected_receipt.occurred_at
        )
        AND NOT EXISTS (
          SELECT 1
          FROM app.property_predator_zernio_publish_binding_revocations AS revocation
          WHERE revocation.workspace_id = binding.workspace_id
            AND revocation.binding_id = binding.id
        )
    );
$function$;

RESET ROLE;
SET LOCAL ROLE r72_owned_social_definer;

REVOKE ALL ON FUNCTION app_private.enqueue_zernio_calendar_job(
  uuid, uuid, uuid, uuid, text, bytea, bytea, uuid, uuid, uuid, uuid,
  uuid, uuid, uuid, text, bytea, bytea, timestamptz
) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app_private.enqueue_zernio_calendar_job(
  uuid, uuid, uuid, uuid, text, bytea, bytea, uuid, uuid, uuid, uuid,
  uuid, uuid, uuid, text, bytea, bytea, timestamptz
) FROM r72_zernio_social_command;
REVOKE ALL ON FUNCTION app_private.zernio_calendar_job_effect_ready(
  uuid, uuid
) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app_private.zernio_calendar_job_effect_ready(
  uuid, uuid
) FROM r72_zernio_social_command, r72_owned_social_worker_command;
REVOKE ALL ON FUNCTION app_private.enqueue_zernio_calendar_from_connected_account(
  uuid, uuid, text, bytea, bytea, uuid, uuid, uuid, uuid, uuid, uuid, uuid,
  text, timestamptz
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.enqueue_zernio_calendar_from_connected_account(
  uuid, uuid, text, bytea, bytea, uuid, uuid, uuid, uuid, uuid, uuid, uuid,
  text, timestamptz
) TO r72_zernio_social_command;
REVOKE ALL ON FUNCTION app_private.list_zernio_calendar_jobs(
  uuid, timestamptz, timestamptz, integer
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.list_zernio_calendar_jobs(
  uuid, timestamptz, timestamptz, integer
) TO r72_zernio_social_command;

-- Old direct rows remain readable but can never be created or settled again.
REVOKE EXECUTE ON FUNCTION app_private.reserve_zernio_direct_schedule(
  uuid, uuid, text, bytea, text, timestamptz, text
) FROM r72_zernio_social_command;
REVOKE EXECUTE ON FUNCTION app_private.reserve_zernio_direct_schedule_v2(
  uuid, uuid, text, bytea, text, text, text, timestamptz, text
) FROM r72_zernio_social_command;
REVOKE EXECUTE ON FUNCTION app_private.settle_zernio_direct_schedule(
  uuid, uuid, text, text, bytea, text, timestamptz
) FROM r72_zernio_social_command;

RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_owned_social_definer;
SET LOCAL ROLE r72_zernio_social_definer;
REVOKE EXECUTE ON FUNCTION app_private.record_zernio_calendar_account_probe(
  uuid, uuid, text, bytea, bytea, text, text, bytea, text
) FROM r72_zernio_social_command;

RESET ROLE;
SET LOCAL ROLE r72_owner;

DO $cutover_audit$
DECLARE
  unexpected_public_execute text;
  unsafe_table text;
  unsafe_bootstrap_write text;
  unsafe_bootstrap_function text;
  unsafe_bootstrap_membership text;
  safe_creator_grants integer;
  owner_memberships integer;
  database_owner_oid oid;
BEGIN
  SELECT database.datdba INTO database_owner_oid
  FROM pg_catalog.pg_database AS database
  WHERE database.datname = current_database();

  SELECT pg_catalog.count(*)::integer INTO safe_creator_grants
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
  JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
  JOIN pg_catalog.pg_roles AS grantor ON grantor.oid = membership.grantor
  WHERE parent.rolname = 'r72_zernio_calendar_bootstrap_definer'
    AND member.oid = database_owner_oid
    AND grantor.rolsuper
    AND membership.admin_option
    AND NOT membership.inherit_option
    AND coalesce(
      (pg_catalog.to_jsonb(membership)->>'set_option')::boolean,
      true
    ) IS NOT TRUE;

  SELECT pg_catalog.count(*)::integer INTO owner_memberships
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
  JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
  WHERE parent.rolname = 'r72_zernio_calendar_bootstrap_definer'
    AND member.rolname = 'r72_owner';

  SELECT member.rolname || '->' || parent.rolname
  INTO unsafe_bootstrap_membership
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
  JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
  JOIN pg_catalog.pg_roles AS grantor ON grantor.oid = membership.grantor
  WHERE parent.rolname = 'r72_zernio_calendar_bootstrap_definer'
    AND NOT (
      member.rolname = 'r72_owner'
      OR (
        member.oid = database_owner_oid
        AND grantor.rolsuper
        AND membership.admin_option
        AND NOT membership.inherit_option
        AND coalesce(
          (pg_catalog.to_jsonb(membership)->>'set_option')::boolean,
          true
        ) IS NOT TRUE
      )
    )
  LIMIT 1;
  IF safe_creator_grants <> 1 OR owner_memberships <> 1
     OR unsafe_bootstrap_membership IS NOT NULL THEN
    RAISE EXCEPTION 'Unsafe Zernio calendar bootstrap membership at cutover: %',
      unsafe_bootstrap_membership;
  END IF;

  IF pg_catalog.has_function_privilege(
      'r72_zernio_social_command',
      'app_private.reserve_zernio_direct_schedule(uuid,uuid,text,bytea,text,timestamp with time zone,text)',
      'EXECUTE'
    )
    OR pg_catalog.has_function_privilege(
      'r72_zernio_social_command',
      'app_private.reserve_zernio_direct_schedule_v2(uuid,uuid,text,bytea,text,text,text,timestamp with time zone,text)',
      'EXECUTE'
    )
    OR pg_catalog.has_function_privilege(
      'r72_zernio_social_command',
      'app_private.settle_zernio_direct_schedule(uuid,uuid,text,text,bytea,text,timestamp with time zone)',
      'EXECUTE'
    )
    OR pg_catalog.has_function_privilege(
      'r72_zernio_social_command',
      'app_private.record_zernio_calendar_account_probe(uuid,uuid,text,bytea,bytea,text,text,bytea,text)',
      'EXECUTE'
    )
    OR pg_catalog.has_function_privilege(
      'r72_zernio_social_command',
      'app_private.enqueue_zernio_calendar_job(uuid,uuid,uuid,uuid,text,bytea,bytea,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,bytea,bytea,timestamp with time zone)',
      'EXECUTE'
    )
    OR pg_catalog.has_function_privilege(
      'r72_zernio_social_command',
      'app_private.zernio_calendar_job_effect_ready(uuid,uuid)',
      'EXECUTE'
    )
    OR pg_catalog.has_function_privilege(
      'r72_owned_social_worker_command',
      'app_private.zernio_calendar_job_effect_ready(uuid,uuid)',
      'EXECUTE'
    ) THEN
    RAISE EXCEPTION 'Unsafe direct Zernio calendar mutation capability remains';
  END IF;

  IF NOT pg_catalog.has_function_privilege(
      'r72_zernio_social_command',
      'app_private.enqueue_zernio_calendar_from_connected_account(uuid,uuid,text,bytea,bytea,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,timestamp with time zone)',
      'EXECUTE'
    )
    OR NOT pg_catalog.has_function_privilege(
      'r72_zernio_social_command',
      'app_private.bootstrap_zernio_calendar_planner_target(uuid,uuid,text,bytea,bytea)',
      'EXECUTE'
    )
    OR NOT pg_catalog.has_function_privilege(
      'r72_zernio_social_command',
      'app_private.list_zernio_calendar_jobs(uuid,timestamp with time zone,timestamp with time zone,integer)',
      'EXECUTE'
    )
    OR NOT pg_catalog.has_function_privilege(
      'r72_zernio_social_command',
      'app_private.list_zernio_direct_schedules(uuid,timestamp with time zone,timestamp with time zone,integer)',
      'EXECUTE'
    ) THEN
    RAISE EXCEPTION 'Safe Zernio calendar cutover functions are not executable';
  END IF;

  SELECT procedure.oid::regprocedure::text INTO unexpected_public_execute
  FROM pg_catalog.pg_proc AS procedure
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
  CROSS JOIN LATERAL pg_catalog.aclexplode(
    coalesce(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))
  ) AS privilege
  WHERE namespace.nspname = 'app_private'
    AND procedure.proname IN (
      'bootstrap_zernio_calendar_planner_target',
      'enqueue_zernio_calendar_from_connected_account',
      'enqueue_zernio_calendar_job', 'list_zernio_calendar_jobs',
      'zernio_calendar_job_effect_ready'
    )
    AND privilege.grantee = 0
    AND privilege.privilege_type = 'EXECUTE'
  LIMIT 1;
  IF unexpected_public_execute IS NOT NULL THEN
    RAISE EXCEPTION 'Zernio calendar cutover function remains PUBLIC: %',
      unexpected_public_execute;
  END IF;

  -- The bootstrap role is new, so there is no safe reason to walk every
  -- definer-owned function with a blanket REVOKE. Prove its effective function
  -- surface is exactly its own wrapper plus the one mature TEST registrar.
  SELECT procedure.oid::regprocedure::text INTO unsafe_bootstrap_function
  FROM pg_catalog.pg_proc AS procedure
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
  WHERE namespace.nspname = 'app_private'
    AND procedure.oid NOT IN (
      'app_private.bootstrap_zernio_calendar_planner_target(uuid,uuid,text,bytea,bytea)'::regprocedure::oid,
      'app_private.register_test_social_campaign_target(uuid,uuid,uuid,text,text,text)'::regprocedure::oid
    )
    AND pg_catalog.has_function_privilege(
      'r72_zernio_calendar_bootstrap_definer', procedure.oid, 'EXECUTE'
    )
  LIMIT 1;
  IF unsafe_bootstrap_function IS NOT NULL
     OR NOT pg_catalog.has_function_privilege(
       'r72_zernio_calendar_bootstrap_definer',
       'app_private.register_test_social_campaign_target(uuid,uuid,uuid,text,text,text)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'Zernio calendar bootstrap function ACL is unsafe: %',
      unsafe_bootstrap_function;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (VALUES
      (
        'app_private.bootstrap_zernio_calendar_planner_target(uuid,uuid,text,bytea,bytea)'::regprocedure::oid,
        'r72_zernio_calendar_bootstrap_definer'::text
      ),
      (
        'app_private.enqueue_zernio_calendar_from_connected_account(uuid,uuid,text,bytea,bytea,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,timestamp with time zone)'::regprocedure::oid,
        'r72_owned_social_definer'::text
      ),
      (
        'app_private.enqueue_zernio_calendar_job(uuid,uuid,uuid,uuid,text,bytea,bytea,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,bytea,bytea,timestamp with time zone)'::regprocedure::oid,
        'r72_owned_social_definer'::text
      ),
      (
        'app_private.list_zernio_calendar_jobs(uuid,timestamp with time zone,timestamp with time zone,integer)'::regprocedure::oid,
        'r72_owned_social_definer'::text
      ),
      (
        'app_private.zernio_calendar_job_effect_ready(uuid,uuid)'::regprocedure::oid,
        'r72_owned_social_definer'::text
      ),
      (
        'app_private.reserve_zernio_direct_schedule(uuid,uuid,text,bytea,text,timestamp with time zone,text)'::regprocedure::oid,
        'r72_owned_social_definer'::text
      ),
      (
        'app_private.reserve_zernio_direct_schedule_v2(uuid,uuid,text,bytea,text,text,text,timestamp with time zone,text)'::regprocedure::oid,
        'r72_owned_social_definer'::text
      ),
      (
        'app_private.settle_zernio_direct_schedule(uuid,uuid,text,text,bytea,text,timestamp with time zone)'::regprocedure::oid,
        'r72_owned_social_definer'::text
      ),
      (
        'app_private.record_zernio_calendar_account_probe(uuid,uuid,text,bytea,bytea,text,text,bytea,text)'::regprocedure::oid,
        'r72_zernio_social_definer'::text
      )
    ) AS expected(function_oid, owner_name)
    JOIN pg_catalog.pg_proc AS procedure
      ON procedure.oid = expected.function_oid
    JOIN pg_catalog.pg_roles AS owner_role
      ON owner_role.oid = procedure.proowner
    WHERE owner_role.rolname <> expected.owner_name
  ) THEN
    RAISE EXCEPTION 'Zernio calendar cutover function owner mismatch';
  END IF;

  SELECT pg_catalog.format('%I.%I', namespace.nspname, relation.relname)
  INTO unsafe_table
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
  LIMIT 1;
  IF unsafe_table IS NOT NULL THEN
    RAISE EXCEPTION 'Zernio calendar command login is not table-blind: %', unsafe_table;
  END IF;

  SELECT pg_catalog.format('%I.%I', namespace.nspname, relation.relname)
  INTO unsafe_bootstrap_write
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname IN ('app', 'app_private')
    AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND relation.oid <> 'app.provider_connections'::regclass
    AND (
      pg_catalog.has_table_privilege(
        'r72_zernio_calendar_bootstrap_definer', relation.oid, 'INSERT'
      )
      OR pg_catalog.has_table_privilege(
        'r72_zernio_calendar_bootstrap_definer', relation.oid, 'UPDATE'
      )
      OR pg_catalog.has_table_privilege(
        'r72_zernio_calendar_bootstrap_definer', relation.oid, 'DELETE'
      )
      OR pg_catalog.has_table_privilege(
        'r72_zernio_calendar_bootstrap_definer', relation.oid, 'TRUNCATE'
      )
    )
  LIMIT 1;
  IF unsafe_bootstrap_write IS NOT NULL
     OR NOT pg_catalog.has_table_privilege(
       'r72_zernio_calendar_bootstrap_definer', 'app.provider_connections', 'INSERT'
     )
     OR pg_catalog.has_table_privilege(
       'r72_zernio_calendar_bootstrap_definer', 'app.provider_connections', 'UPDATE'
     )
     OR pg_catalog.has_table_privilege(
       'r72_zernio_calendar_bootstrap_definer', 'app.provider_connections', 'DELETE'
     ) THEN
    RAISE EXCEPTION 'Zernio calendar bootstrap definer has unsafe table writes: %',
      unsafe_bootstrap_write;
  END IF;

  IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'app'
        AND relation.relname = 'property_predator_zernio_calendar_target_promotions'
        AND relation.relrowsecurity AND relation.relforcerowsecurity
    )
    OR NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_trigger AS trigger
      WHERE trigger.tgrelid =
        'app.property_predator_zernio_calendar_target_promotions'::regclass
        AND trigger.tgname =
          'property_predator_zernio_calendar_target_promotions_immutable'
        AND NOT trigger.tgisinternal
    )
    OR NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_trigger AS trigger
      WHERE trigger.tgrelid =
        'app.property_predator_zernio_direct_schedules'::regclass
        AND trigger.tgname = 'property_predator_zernio_direct_schedules_immutable'
        AND NOT trigger.tgisinternal
    ) THEN
    RAISE EXCEPTION 'Zernio calendar append-only/RLS guard is incomplete';
  END IF;

END
$cutover_audit$;
