-- One-shot, offline founder bootstrap for the empty Property Predator Growth HQ
-- production database. This migration creates no network/provider effect. The
-- only live-provider row is pinned to Mailgun EU and its first durable control
-- event is fail-closed: effects OFF, email delivery OFF, emergency pause ON.

SET LOCAL ROLE r72_owner;

CREATE TABLE app_private.property_predator_founder_bootstrap_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  change_reference text NOT NULL UNIQUE CHECK (
    change_reference = lower(btrim(change_reference))
    AND change_reference ~ '^[a-z][a-z0-9._:-]{7,79}$'
  ),
  request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
  installation_id uuid NOT NULL,
  migration_ledger_sha256 bytea NOT NULL CHECK (
    octet_length(migration_ledger_sha256) = 32
  ),
  owner_email_sha256 bytea NOT NULL CHECK (octet_length(owner_email_sha256) = 32),
  organization_id uuid NOT NULL UNIQUE
    REFERENCES app.organizations(id) ON DELETE RESTRICT,
  workspace_id uuid NOT NULL UNIQUE
    REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  owner_user_id uuid NOT NULL UNIQUE
    REFERENCES app.users(id) ON DELETE RESTRICT,
  setup_action_token_id uuid NOT NULL UNIQUE,
  setup_expires_at timestamptz NOT NULL,
  provider_connection_id uuid NOT NULL UNIQUE,
  control_event_id uuid NOT NULL UNIQUE,
  seed_event_id uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  FOREIGN KEY (workspace_id, provider_connection_id)
    REFERENCES app.provider_connections (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, control_event_id)
    REFERENCES app.property_predator_email_pilot_control_events (workspace_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, seed_event_id)
    REFERENCES app.property_predator_email_pilot_seed_events (workspace_id, id)
    ON DELETE RESTRICT,
  CHECK (setup_expires_at > created_at)
);

REVOKE ALL ON app_private.property_predator_founder_bootstrap_receipts
  FROM PUBLIC, r72_web, r72_identity_command, r72_crm_command,
    r72_content_command, r72_mailgun_webhook_command,
    r72_mailgun_worker_command, r72_provisioning_command,
    r72_setup_delivery_command, r72_setup_reissue_command;

CREATE FUNCTION app_private.reject_property_predator_founder_bootstrap_receipt_mutation()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $function$
BEGIN
  RAISE EXCEPTION 'Property Predator founder bootstrap receipt is append-only'
    USING ERRCODE = '42501';
END
$function$;

REVOKE ALL ON FUNCTION app_private.reject_property_predator_founder_bootstrap_receipt_mutation()
  FROM PUBLIC;

CREATE TRIGGER property_predator_founder_bootstrap_receipt_append_only
  BEFORE UPDATE OR DELETE
  ON app_private.property_predator_founder_bootstrap_receipts
  FOR EACH ROW
  EXECUTE FUNCTION app_private.reject_property_predator_founder_bootstrap_receipt_mutation();

-- The established NOLOGIN onboarding definer already owns the primitive that
-- atomically creates the organization, pending founder, workspace, membership,
-- setup credential and default Sales pipeline. Extend it only for the exact
-- bootstrap evidence inserted by the wrapper below.
GRANT SELECT, INSERT
  ON app_private.property_predator_founder_bootstrap_receipts
  TO r72_onboarding_definer;
GRANT SELECT, INSERT ON app.provider_connections,
  app.property_predator_email_pilot_control_events,
  app.property_predator_email_pilot_seed_events
  TO r72_onboarding_definer;
GRANT EXECUTE ON FUNCTION app_private.runtime_schema_migrations()
  TO r72_onboarding_definer;
GRANT EXECUTE ON FUNCTION app_private.runtime_database_installation_id()
  TO r72_onboarding_definer;
GRANT EXECUTE ON FUNCTION app_private.provision_customer_workspace(
  text, text, text, text, text, text, text, bytea, text, text, text
) TO r72_onboarding_definer;

CREATE POLICY provider_connections_founder_bootstrap_insert
  ON app.provider_connections FOR INSERT TO r72_onboarding_definer
  WITH CHECK (
    provider_id = 'mailgun_eu'
    AND provider_kind = 'email'
    AND environment = 'live'
    AND status = 'active'
    AND display_name = 'Property Predator Mailgun EU'
    AND capabilities = '["email.events", "email.send"]'::jsonb
  );

CREATE POLICY provider_connections_founder_bootstrap_select
  ON app.provider_connections FOR SELECT TO r72_onboarding_definer
  USING (
    provider_id = 'mailgun_eu'
    AND provider_kind = 'email'
    AND environment = 'live'
    AND status = 'active'
    AND display_name = 'Property Predator Mailgun EU'
    AND capabilities = '["email.events", "email.send"]'::jsonb
  );

CREATE POLICY property_predator_email_pilot_controls_founder_bootstrap_insert
  ON app.property_predator_email_pilot_control_events
  FOR INSERT TO r72_onboarding_definer
  WITH CHECK (
    provider_effects_enabled = false
    AND email_delivery_enabled = false
    AND emergency_paused = true
    AND max_recipients = 10
    AND estimated_recipient_cost_usd_micros = 10000
    AND run_message_cap = 10
    AND monthly_message_cap = 100
    AND run_spend_cap_usd_micros = 100000
    AND monthly_spend_cap_usd_micros = 1000000
    AND reason = 'founder_bootstrap.dark'
  );

CREATE POLICY property_predator_email_pilot_controls_founder_bootstrap_select
  ON app.property_predator_email_pilot_control_events
  FOR SELECT TO r72_onboarding_definer
  USING (
    provider_effects_enabled = false
    AND email_delivery_enabled = false
    AND emergency_paused = true
    AND max_recipients = 10
    AND estimated_recipient_cost_usd_micros = 10000
    AND run_message_cap = 10
    AND monthly_message_cap = 100
    AND run_spend_cap_usd_micros = 100000
    AND monthly_spend_cap_usd_micros = 1000000
    AND reason = 'founder_bootstrap.dark'
  );

CREATE POLICY property_predator_email_pilot_seeds_founder_bootstrap_insert
  ON app.property_predator_email_pilot_seed_events
  FOR INSERT TO r72_onboarding_definer
  WITH CHECK (
    email_sha256 = public.digest(
      pg_catalog.convert_to('office@propertypredator.com', 'UTF8'),
      'sha256'
    )
    AND state = 'owned'
    AND attestation = 'Owned Property Predator internal founder and seed mailbox'
  );

CREATE POLICY property_predator_email_pilot_seeds_founder_bootstrap_select
  ON app.property_predator_email_pilot_seed_events
  FOR SELECT TO r72_onboarding_definer
  USING (
    email_sha256 = public.digest(
      pg_catalog.convert_to('office@propertypredator.com', 'UTF8'),
      'sha256'
    )
    AND state = 'owned'
    AND attestation = 'Owned Property Predator internal founder and seed mailbox'
  );

GRANT CREATE ON SCHEMA app_private TO r72_onboarding_definer;
SET LOCAL ROLE r72_onboarding_definer;

CREATE FUNCTION app_private.bootstrap_property_predator_founder(
  p_change_reference text,
  p_expected_installation_id uuid,
  p_expected_migration_ledger jsonb,
  p_setup_token_hash bytea
)
RETURNS TABLE (
  organization_id uuid,
  workspace_id uuid,
  owner_user_id uuid,
  setup_action_token_id uuid,
  setup_expires_at timestamptz,
  provider_connection_id uuid,
  control_event_id uuid,
  seed_event_id uuid,
  created_now boolean
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  normalized_change_reference text := pg_catalog.lower(
    pg_catalog.btrim(p_change_reference)
  );
  required_migration_filenames text[] := ARRAY[
    '0001_extensions_roles.sql',
    '0002_identity_workspaces.sql',
    '0003_crm_first_loop.sql',
    '0004_portal_sessions.sql',
    '0005_canonical_portal_identity.sql',
    '0006_customer_provisioning.sql',
    '0007_public_schema_hardening.sql',
    '0008_setup_delivery_recovery.sql',
    '0009_neon_integration_repairs.sql',
    '0010_delivery_lease_portability.sql',
    '0011_stable_chronology_defaults.sql',
    '0012_paid_checkout_provenance.sql',
    '0013_setup_delivery_provider_settlement.sql',
    '0014_conversion_journeys.sql',
    '0015_external_event_shadow_bridge.sql',
    '0016_property_predator_growth_evidence.sql',
    '0017_property_predator_growth_projector.sql',
    '0018_property_predator_journey_runtime.sql',
    '0019_legacy_lead_import_foundation.sql',
    '0020_legacy_lead_journey_board_materialization.sql',
    '0021_company_content_versions_and_approvals.sql',
    '0022_provider_operations_and_inbox_core.sql',
    '0023_provider_operation_dispatch.sql',
    '0024_mailgun_webhook_evidence.sql',
    '0025_property_predator_email_pilot_boundary.sql',
    '0026_database_installation_identity.sql',
    '0027_property_predator_founder_bootstrap.sql'
  ];
  expected_migration_filenames text[];
  actual_migration_ledger jsonb;
  actual_installation_id uuid;
  stable_request_hash bytea;
  migration_ledger_sha256 bytea;
  selected_receipt app_private.property_predator_founder_bootstrap_receipts%ROWTYPE;
  found_receipt boolean := false;
  provisioned record;
  created_provider_connection_id uuid := public.gen_random_uuid();
  created_control_event_id uuid := public.gen_random_uuid();
  created_seed_event_id uuid := public.gen_random_uuid();
BEGIN
  IF p_change_reference IS NULL
     OR normalized_change_reference <> p_change_reference
     OR normalized_change_reference !~ '^[a-z][a-z0-9._:-]{7,79}$'
     OR p_expected_installation_id IS NULL
     OR p_setup_token_hash IS NULL
     OR pg_catalog.octet_length(p_setup_token_hash) <> 32
     OR p_expected_migration_ledger IS NULL
     OR pg_catalog.jsonb_typeof(p_expected_migration_ledger) <> 'array'
     OR pg_catalog.jsonb_array_length(p_expected_migration_ledger) <> 27 THEN
    RAISE EXCEPTION 'invalid Property Predator founder bootstrap input'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_expected_migration_ledger) AS item(value)
    WHERE pg_catalog.jsonb_typeof(item.value) <> 'object'
       OR (
         SELECT pg_catalog.array_agg(key ORDER BY key)
         FROM pg_catalog.jsonb_object_keys(item.value) AS object_key(key)
       ) <> ARRAY['checksum', 'filename']::text[]
       OR coalesce(item.value->>'filename', '') !~ '^[0-9]{4}_[a-z0-9]+(?:_[a-z0-9]+)*[.]sql$'
       OR coalesce(item.value->>'checksum', '') !~ '^[0-9a-f]{64}$'
  ) THEN
    RAISE EXCEPTION 'invalid Property Predator founder bootstrap migration ledger'
      USING ERRCODE = '22023';
  END IF;

  SELECT pg_catalog.array_agg(item.value->>'filename' ORDER BY item.ordinality)
    INTO expected_migration_filenames
  FROM pg_catalog.jsonb_array_elements(p_expected_migration_ledger)
    WITH ORDINALITY AS item(value, ordinality);

  IF expected_migration_filenames <> required_migration_filenames THEN
    RAISE EXCEPTION 'Property Predator founder bootstrap requires its exact release ledger'
      USING ERRCODE = '55000';
  END IF;

  migration_ledger_sha256 := public.digest(
    pg_catalog.convert_to(p_expected_migration_ledger::text, 'UTF8'),
    'sha256'
  );
  stable_request_hash := public.digest(
    pg_catalog.convert_to(
      pg_catalog.jsonb_build_object(
        'schemaVersion', 1,
        'changeReference', normalized_change_reference,
        'installationId', p_expected_installation_id,
        'migrationLedgerSha256', pg_catalog.encode(migration_ledger_sha256, 'hex'),
        'organizationName', 'Property Predator',
        'organizationSlug', 'property-predator',
        'workspaceName', 'Growth HQ',
        'workspaceSlug', 'growth-hq',
        'ownerEmail', 'office@propertypredator.com',
        'ownerDisplayName', 'Property Predator Owner',
        'timezone', 'Europe/London',
        'locale', 'en-GB',
        'currency', 'GBP',
        'providerId', 'mailgun_eu',
        'providerKind', 'email',
        'environment', 'live',
        'providerEffectsEnabled', false,
        'emailDeliveryEnabled', false,
        'emergencyPaused', true,
        'maxRecipients', 10,
        'estimatedRecipientCostUsdMicros', 10000,
        'runMessageCap', 10,
        'monthlyMessageCap', 100,
        'runSpendCapUsdMicros', 100000,
        'monthlySpendCapUsdMicros', 1000000
      )::text,
      'UTF8'
    ),
    'sha256'
  );

  -- One global lock serializes different change references as well as retries.
  PERFORM pg_catalog.pg_advisory_xact_lock(1382302770, 7200027);

  SELECT receipt.*
    INTO selected_receipt
  FROM app_private.property_predator_founder_bootstrap_receipts AS receipt
  WHERE receipt.change_reference = normalized_change_reference;
  found_receipt := FOUND;

  IF found_receipt THEN
    IF selected_receipt.request_hash <> stable_request_hash
       OR selected_receipt.installation_id <> p_expected_installation_id
       OR selected_receipt.migration_ledger_sha256 <> migration_ledger_sha256 THEN
      RAISE EXCEPTION 'Property Predator founder bootstrap change reference conflict'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  -- Even an idempotent replay must prove that it is running the exact release
  -- against the exact database installation. The receipt check comes first so
  -- reusing its change reference with different authority is a conflict rather
  -- than a second interpretation of the same operator change.
  SELECT coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'filename', migration.filename,
               'checksum', migration.checksum
             ) ORDER BY migration.filename
           ),
           '[]'::jsonb
         )
    INTO actual_migration_ledger
  FROM app_private.runtime_schema_migrations() AS migration;

  IF actual_migration_ledger <> p_expected_migration_ledger THEN
    RAISE EXCEPTION 'Property Predator founder bootstrap database ledger mismatch'
      USING ERRCODE = '55000';
  END IF;

  SELECT app_private.runtime_database_installation_id()
    INTO actual_installation_id;
  IF actual_installation_id IS DISTINCT FROM p_expected_installation_id THEN
    RAISE EXCEPTION 'Property Predator founder bootstrap database identity mismatch'
      USING ERRCODE = '55000';
  END IF;

  IF found_receipt THEN

    IF NOT EXISTS (
      SELECT 1
      FROM app.provider_connections AS connection
      JOIN app.property_predator_email_pilot_control_events AS control
        ON control.workspace_id = connection.workspace_id
       AND control.id = selected_receipt.control_event_id
       AND control.provider_connection_id = connection.id
      JOIN app.property_predator_email_pilot_seed_events AS seed
        ON seed.workspace_id = connection.workspace_id
       AND seed.id = selected_receipt.seed_event_id
      WHERE connection.workspace_id = selected_receipt.workspace_id
        AND connection.id = selected_receipt.provider_connection_id
        AND connection.provider_id = 'mailgun_eu'
        AND connection.provider_kind = 'email'
        AND connection.environment = 'live'
        AND connection.status = 'active'
        AND control.provider_effects_enabled = false
        AND control.email_delivery_enabled = false
        AND control.emergency_paused = true
        AND control.max_recipients = 10
        AND control.estimated_recipient_cost_usd_micros = 10000
        AND control.run_message_cap = 10
        AND control.monthly_message_cap = 100
        AND control.run_spend_cap_usd_micros = 100000
        AND control.monthly_spend_cap_usd_micros = 1000000
        AND seed.email_sha256 = public.digest(
          pg_catalog.convert_to('office@propertypredator.com', 'UTF8'),
          'sha256'
        )
        AND seed.state = 'owned'
    ) THEN
      RAISE EXCEPTION 'Property Predator founder bootstrap receipt evidence is incomplete'
        USING ERRCODE = '55000';
    END IF;

    RETURN QUERY SELECT
      selected_receipt.organization_id,
      selected_receipt.workspace_id,
      selected_receipt.owner_user_id,
      selected_receipt.setup_action_token_id,
      selected_receipt.setup_expires_at,
      selected_receipt.provider_connection_id,
      selected_receipt.control_event_id,
      selected_receipt.seed_event_id,
      false;
    RETURN;
  END IF;

  IF EXISTS (
       SELECT 1 FROM app_private.property_predator_founder_bootstrap_receipts
     )
     OR EXISTS (SELECT 1 FROM app_private.customer_provisioning_receipts)
     OR EXISTS (SELECT 1 FROM app.organizations)
     OR EXISTS (SELECT 1 FROM app.workspaces)
     OR EXISTS (SELECT 1 FROM app.users)
     OR EXISTS (SELECT 1 FROM app.provider_connections)
     OR EXISTS (
       SELECT 1 FROM app.property_predator_email_pilot_control_events
     )
     OR EXISTS (
       SELECT 1 FROM app.property_predator_email_pilot_seed_events
     ) THEN
    RAISE EXCEPTION 'Property Predator founder bootstrap requires an empty, unbootstrapped database'
      USING ERRCODE = '55000';
  END IF;

  SELECT provisioned_customer.*
    INTO provisioned
  FROM app_private.provision_customer_workspace(
    'property-predator-founder:' || normalized_change_reference,
    'Property Predator',
    'property-predator',
    'Growth HQ',
    'growth-hq',
    'office@propertypredator.com',
    'Property Predator Owner',
    p_setup_token_hash,
    'Europe/London',
    'en-GB',
    'GBP'
  ) AS provisioned_customer;

  IF provisioned.created_now IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Property Predator founder bootstrap did not create a fresh workspace'
      USING ERRCODE = '55000';
  END IF;

  INSERT INTO app.provider_connections (
    id, workspace_id, provider_id, provider_kind, environment, status,
    display_name, capabilities, created_by_user_id
  ) VALUES (
    created_provider_connection_id,
    provisioned.workspace_id,
    'mailgun_eu',
    'email',
    'live',
    'active',
    'Property Predator Mailgun EU',
    '["email.events", "email.send"]'::jsonb,
    provisioned.owner_user_id
  );

  INSERT INTO app.property_predator_email_pilot_control_events (
    id, workspace_id, provider_connection_id, provider_effects_enabled,
    email_delivery_enabled, emergency_paused, max_recipients,
    estimated_recipient_cost_usd_micros, run_message_cap,
    monthly_message_cap, run_spend_cap_usd_micros,
    monthly_spend_cap_usd_micros, reason, recorded_by, occurred_at
  ) VALUES (
    created_control_event_id,
    provisioned.workspace_id,
    created_provider_connection_id,
    false,
    false,
    true,
    10,
    10000,
    10,
    100,
    100000,
    1000000,
    'founder_bootstrap.dark',
    normalized_change_reference,
    statement_timestamp()
  );

  INSERT INTO app.property_predator_email_pilot_seed_events (
    id, workspace_id, email_sha256, state, attestation, recorded_by,
    occurred_at
  ) VALUES (
    created_seed_event_id,
    provisioned.workspace_id,
    public.digest(
      pg_catalog.convert_to('office@propertypredator.com', 'UTF8'),
      'sha256'
    ),
    'owned',
    'Owned Property Predator internal founder and seed mailbox',
    normalized_change_reference,
    statement_timestamp()
  );

  INSERT INTO app_private.property_predator_founder_bootstrap_receipts (
    change_reference, request_hash, installation_id,
    migration_ledger_sha256, owner_email_sha256, organization_id,
    workspace_id, owner_user_id, setup_action_token_id, setup_expires_at,
    provider_connection_id, control_event_id, seed_event_id
  ) VALUES (
    normalized_change_reference,
    stable_request_hash,
    p_expected_installation_id,
    migration_ledger_sha256,
    public.digest(
      pg_catalog.convert_to('office@propertypredator.com', 'UTF8'),
      'sha256'
    ),
    provisioned.organization_id,
    provisioned.workspace_id,
    provisioned.owner_user_id,
    provisioned.setup_action_token_id,
    provisioned.setup_expires_at,
    created_provider_connection_id,
    created_control_event_id,
    created_seed_event_id
  );

  RETURN QUERY SELECT
    provisioned.organization_id,
    provisioned.workspace_id,
    provisioned.owner_user_id,
    provisioned.setup_action_token_id,
    provisioned.setup_expires_at,
    created_provider_connection_id,
    created_control_event_id,
    created_seed_event_id,
    true;
END
$function$;

SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_onboarding_definer;

REVOKE ALL ON FUNCTION app_private.bootstrap_property_predator_founder(
  text, uuid, jsonb, bytea
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.bootstrap_property_predator_founder(
  text, uuid, jsonb, bytea
) TO r72_owner;

-- The offline wrapper must never become a runtime capability.
DO $founder_bootstrap_boundary$
DECLARE
  function_oid oid := pg_catalog.to_regprocedure(
    'app_private.bootstrap_property_predator_founder(text,uuid,jsonb,bytea)'
  );
  runtime_role text;
BEGIN
  IF function_oid IS NULL OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    WHERE procedure.oid = function_oid
      AND procedure.proowner = 'r72_onboarding_definer'::regrole
      AND procedure.prosecdef
      AND procedure.provolatile = 'v'
      AND procedure.proconfig = ARRAY['search_path=pg_catalog']::text[]
  ) THEN
    RAISE EXCEPTION 'Property Predator founder bootstrap function boundary is unsafe';
  END IF;

  FOREACH runtime_role IN ARRAY ARRAY[
    'r72_web',
    'r72_identity_command',
    'r72_crm_command',
    'r72_content_command',
    'r72_mailgun_webhook_command',
    'r72_mailgun_worker_command',
    'r72_provisioning_command',
    'r72_setup_delivery_command',
    'r72_setup_reissue_command'
  ]
  LOOP
    IF pg_catalog.has_function_privilege(runtime_role, function_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'Property Predator founder bootstrap is exposed to %',
        runtime_role;
    END IF;
  END LOOP;
END
$founder_bootstrap_boundary$;
