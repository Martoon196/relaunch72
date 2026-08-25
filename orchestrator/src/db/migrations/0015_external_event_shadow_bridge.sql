-- Property Predator's first source bridge is deliberately receipt-only.
-- Authenticated deliveries are journalled for observation and replay safety;
-- this migration cannot mutate CRM, conversion, consent, or outbox state.

DO $roles$
DECLARE
  role_name text;
  expected_login boolean;
  unexpected_member text;
  unexpected_parent text;
BEGIN
  FOR role_name, expected_login IN
    SELECT required_role.role_name, required_role.expected_login
    FROM (VALUES
      ('r72_external_event_definer', false),
      ('r72_external_event_command', true)
    ) AS required_role(role_name, expected_login)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = role_name
    ) THEN
      EXECUTE format(
        'CREATE ROLE %I %s NOINHERIT',
        role_name,
        CASE WHEN expected_login THEN 'LOGIN' ELSE 'NOLOGIN' END
      );
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_roles
      WHERE rolname = role_name
        AND rolcanlogin = expected_login
        AND NOT rolinherit
        AND NOT rolsuper
        AND NOT rolcreatedb
        AND NOT rolcreaterole
        AND NOT rolreplication
        AND NOT rolbypassrls
    ) THEN
      RAISE EXCEPTION 'Unsafe role attributes: % does not match the required capability shape',
        role_name;
    END IF;
  END LOOP;

  -- Passwords are deployment secrets, never migration content. This LOGIN is
  -- deliberately separate from the broad r72_webhook runtime identity.

  REVOKE r72_owner, r72_security_definer, r72_onboarding_definer,
    r72_setup_delivery_definer, r72_commerce_definer
    FROM r72_external_event_definer, r72_external_event_command;
  REVOKE r72_external_event_definer
    FROM r72_web, r72_public, r72_worker, r72_webhook, r72_readonly,
      r72_crm_command, r72_identity_command, r72_provisioning_command,
      r72_setup_delivery_command, r72_setup_reissue_command,
      r72_external_event_command;
  REVOKE r72_external_event_command
    FROM r72_web, r72_public, r72_worker, r72_webhook, r72_readonly,
      r72_crm_command, r72_identity_command, r72_provisioning_command,
      r72_setup_delivery_command, r72_setup_reissue_command,
      r72_external_event_definer, r72_owner;

  SELECT member.rolname, parent.rolname
    INTO unexpected_member, unexpected_parent
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
  JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
  WHERE member.rolname IN (
    'r72_external_event_definer', 'r72_external_event_command'
  )
  LIMIT 1;

  IF unexpected_member IS NOT NULL THEN
    RAISE EXCEPTION 'Unsafe external-event role membership: % can SET ROLE %',
      unexpected_member, unexpected_parent;
  END IF;

  SELECT member.rolname, parent.rolname
    INTO unexpected_member, unexpected_parent
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
  JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
  WHERE parent.rolname = 'r72_external_event_definer'
    AND member.rolname NOT IN ('r72_owner', current_user)
  LIMIT 1;

  IF unexpected_member IS NOT NULL THEN
    RAISE EXCEPTION 'Unsafe external-event role grant: % can SET ROLE %',
      unexpected_member, unexpected_parent;
  END IF;

  SELECT member.rolname, parent.rolname
    INTO unexpected_member, unexpected_parent
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
  JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
  WHERE parent.rolname = 'r72_external_event_command'
    AND member.rolname <> current_user
  LIMIT 1;

  IF unexpected_member IS NOT NULL THEN
    RAISE EXCEPTION 'Unsafe external-event command role grant: % can SET ROLE %',
      unexpected_member, unexpected_parent;
  END IF;

  GRANT r72_external_event_definer TO r72_owner;
  EXECUTE format('GRANT r72_external_event_command TO %I', current_user);
END
$roles$;

SET LOCAL ROLE r72_owner;

REVOKE ALL ON SCHEMA app, app_private FROM r72_external_event_definer;
REVOKE ALL ON SCHEMA app, app_private FROM r72_external_event_command;
REVOKE ALL ON ALL TABLES IN SCHEMA app FROM r72_external_event_definer;
REVOKE ALL ON ALL TABLES IN SCHEMA app_private FROM r72_external_event_definer;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app_private FROM r72_external_event_definer;
REVOKE ALL ON ALL TABLES IN SCHEMA app FROM r72_external_event_command;
REVOKE ALL ON ALL TABLES IN SCHEMA app_private FROM r72_external_event_command;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app_private FROM r72_external_event_command;
REVOKE CREATE ON SCHEMA public FROM r72_external_event_definer;
REVOKE CREATE ON SCHEMA public FROM r72_external_event_command;

-- Kept in app_private so no workspace runtime role can enumerate PII-bearing
-- payloads or their digests. The only runtime entrypoint returns two harmless
-- disposition fields and has no UPDATE or DELETE path.
CREATE TABLE app_private.external_event_shadow_receipts (
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  source text NOT NULL CHECK (source = 'property_predator'),
  event_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN (
    'identity.account.created',
    'privacy.consent.updated',
    'affiliate.referral.attributed',
    'product.analysis.completed',
    'commerce.purchase.completed',
    'commerce.purchase.refunded',
    'commerce.subscription.cancelled'
  )),
  event_version smallint NOT NULL CHECK (event_version = 1),
  occurred_at timestamptz NOT NULL,
  correlation_id uuid NOT NULL,
  subject_kind text NOT NULL CHECK (subject_kind = 'account'),
  subject_id uuid NOT NULL,
  payload_sha256 bytea NOT NULL CHECK (octet_length(payload_sha256) = 32),
  event_payload jsonb NOT NULL CHECK (jsonb_typeof(event_payload) = 'object'),
  signature_key_id text NOT NULL CHECK (
    length(signature_key_id) BETWEEN 1 AND 64
    AND signature_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  ),
  signature_timestamp timestamptz NOT NULL,
  disposition text NOT NULL DEFAULT 'shadow' CHECK (disposition = 'shadow'),
  actor_kind text NOT NULL DEFAULT 'webhook' CHECK (actor_kind = 'webhook'),
  request_id text NOT NULL CHECK (
    length(request_id) BETWEEN 1 AND 128
    AND request_id !~ '[^[:graph:]]'
  ),
  received_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (workspace_id, source, event_id)
);

REVOKE ALL ON app_private.external_event_shadow_receipts
  FROM PUBLIC, r72_web, r72_public, r72_worker, r72_webhook, r72_readonly,
    r72_crm_command, r72_identity_command, r72_provisioning_command,
    r72_setup_delivery_command, r72_setup_reissue_command,
    r72_external_event_command;

GRANT USAGE ON SCHEMA app_private TO r72_external_event_definer;
GRANT SELECT, INSERT ON app_private.external_event_shadow_receipts
  TO r72_external_event_definer;
GRANT EXECUTE ON FUNCTION app_private.current_workspace_id(),
  app_private.current_actor_kind(), app_private.current_request_id()
  TO r72_external_event_definer;

-- The ingress LOGIN can install transaction-local request context and execute
-- exactly one receipt recorder. It cannot see the journal or any app table.
GRANT USAGE ON SCHEMA app_private TO r72_external_event_command;
GRANT EXECUTE ON FUNCTION app_private.current_workspace_id(),
  app_private.current_actor_kind(), app_private.current_request_id()
  TO r72_external_event_command;

GRANT CREATE ON SCHEMA app_private TO r72_external_event_definer;
SET LOCAL ROLE r72_external_event_definer;

CREATE FUNCTION app_private.record_external_event_shadow_receipt(
  p_workspace_id uuid,
  p_source text,
  p_event_id uuid,
  p_event_type text,
  p_event_version smallint,
  p_occurred_at timestamptz,
  p_correlation_id uuid,
  p_subject_kind text,
  p_subject_id uuid,
  p_payload_sha256 bytea,
  p_event_payload jsonb,
  p_signature_key_id text,
  p_signature_timestamp timestamptz
)
RETURNS TABLE (
  disposition text,
  replayed boolean
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  trusted_workspace_id uuid := app_private.current_workspace_id();
  trusted_actor_kind text := app_private.current_actor_kind();
  trusted_request_id text := app_private.current_request_id();
  inserted_receipt_count integer;
  existing_payload_sha256 bytea;
BEGIN
  IF trusted_actor_kind IS DISTINCT FROM 'webhook'
     OR trusted_workspace_id IS NULL
     OR p_workspace_id IS DISTINCT FROM trusted_workspace_id THEN
    RAISE EXCEPTION 'external event receipt context denied'
      USING ERRCODE = '42501';
  END IF;

  IF trusted_request_id IS NULL
     OR length(trusted_request_id) NOT BETWEEN 1 AND 128
     OR trusted_request_id ~ '[^[:graph:]]'
     OR p_source IS DISTINCT FROM 'property_predator'
     OR p_event_id IS NULL
     OR p_event_type IS NULL
     OR p_event_type NOT IN (
       'identity.account.created',
       'privacy.consent.updated',
       'affiliate.referral.attributed',
       'product.analysis.completed',
       'commerce.purchase.completed',
       'commerce.purchase.refunded',
       'commerce.subscription.cancelled'
     )
     OR p_event_version IS DISTINCT FROM 1
     OR p_occurred_at IS NULL
     OR p_correlation_id IS NULL
     OR p_subject_kind IS DISTINCT FROM 'account'
     OR p_subject_id IS NULL
     OR p_payload_sha256 IS NULL
     OR octet_length(p_payload_sha256) <> 32
     OR p_signature_key_id IS NULL
     OR length(p_signature_key_id) NOT BETWEEN 1 AND 64
     OR p_signature_key_id !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
     OR p_signature_timestamp IS NULL
     OR p_event_payload IS NULL
     OR jsonb_typeof(p_event_payload) IS DISTINCT FROM 'object'
     OR NOT (p_event_payload ?& ARRAY[
       'id', 'type', 'version', 'occurredAt', 'correlationId', 'subject', 'data'
     ])
     OR p_event_payload - ARRAY[
       'id', 'type', 'version', 'occurredAt', 'correlationId', 'subject', 'data'
     ] <> '{}'::jsonb
     OR p_event_payload->>'id' IS DISTINCT FROM p_event_id::text
     OR p_event_payload->>'type' IS DISTINCT FROM p_event_type
     OR p_event_payload->>'version' IS DISTINCT FROM p_event_version::text
     OR (p_event_payload->>'occurredAt')::timestamptz IS DISTINCT FROM p_occurred_at
     OR p_event_payload->>'correlationId' IS DISTINCT FROM p_correlation_id::text
     OR jsonb_typeof(p_event_payload->'subject') IS DISTINCT FROM 'object'
     OR NOT ((p_event_payload->'subject') ?& ARRAY['kind', 'id'])
     OR (p_event_payload->'subject') - ARRAY['kind', 'id'] <> '{}'::jsonb
     OR p_event_payload->'subject'->>'kind' IS DISTINCT FROM p_subject_kind
     OR p_event_payload->'subject'->>'id' IS DISTINCT FROM p_subject_id::text
     OR jsonb_typeof(p_event_payload->'data') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'invalid external event shadow receipt input'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO app_private.external_event_shadow_receipts (
    workspace_id,
    source,
    event_id,
    event_type,
    event_version,
    occurred_at,
    correlation_id,
    subject_kind,
    subject_id,
    payload_sha256,
    event_payload,
    signature_key_id,
    signature_timestamp,
    disposition,
    actor_kind,
    request_id
  ) VALUES (
    trusted_workspace_id,
    p_source,
    p_event_id,
    p_event_type,
    p_event_version,
    p_occurred_at,
    p_correlation_id,
    p_subject_kind,
    p_subject_id,
    p_payload_sha256,
    p_event_payload,
    p_signature_key_id,
    p_signature_timestamp,
    'shadow',
    'webhook',
    trusted_request_id
  )
  ON CONFLICT (workspace_id, source, event_id) DO NOTHING;

  GET DIAGNOSTICS inserted_receipt_count = ROW_COUNT;
  IF inserted_receipt_count = 0 THEN
    SELECT receipt.payload_sha256
      INTO existing_payload_sha256
    FROM app_private.external_event_shadow_receipts AS receipt
    WHERE receipt.workspace_id = trusted_workspace_id
      AND receipt.source = p_source
      AND receipt.event_id = p_event_id;

    IF NOT FOUND OR existing_payload_sha256 IS DISTINCT FROM p_payload_sha256 THEN
      RAISE EXCEPTION 'external event id was replayed with different payload bytes'
        USING ERRCODE = '22000';
    END IF;

    RETURN QUERY SELECT 'shadow'::text, true;
    RETURN;
  END IF;

  RETURN QUERY SELECT 'shadow'::text, false;
END
$function$;

SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_external_event_definer;

REVOKE ALL ON FUNCTION app_private.record_external_event_shadow_receipt(
  uuid, text, uuid, text, smallint, timestamptz, uuid, text, uuid, bytea,
  jsonb, text, timestamptz
) FROM PUBLIC, r72_web, r72_public, r72_worker, r72_webhook, r72_readonly,
  r72_crm_command, r72_identity_command, r72_provisioning_command,
  r72_setup_delivery_command, r72_setup_reissue_command,
  r72_external_event_command;

GRANT EXECUTE ON FUNCTION app_private.record_external_event_shadow_receipt(
  uuid, text, uuid, text, smallint, timestamptz, uuid, text, uuid, bytea,
  jsonb, text, timestamptz
) TO r72_external_event_command;

-- Fail the migration if either identity has gained anything wider than the
-- deliberately tiny capability map above. This audits effective privileges,
-- including accidental grants inherited through PUBLIC.
DO $capability_audit$
DECLARE
  recorder_oid oid := pg_catalog.to_regprocedure(
    'app_private.record_external_event_shadow_receipt(uuid,text,uuid,text,smallint,timestamptz,uuid,text,uuid,bytea,jsonb,text,timestamptz)'
  );
  unexpected_object text;
BEGIN
  IF recorder_oid IS NULL OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = procedure.proowner
    WHERE procedure.oid = recorder_oid
      AND owner_role.rolname = 'r72_external_event_definer'
      AND procedure.prosecdef
      AND procedure.proconfig = ARRAY['search_path=pg_catalog']::text[]
  ) THEN
    RAISE EXCEPTION 'External-event recorder ownership or SECURITY DEFINER settings are unsafe';
  END IF;

  IF NOT pg_catalog.has_schema_privilege(
       'r72_external_event_command', 'app_private', 'USAGE'
     )
     OR pg_catalog.has_schema_privilege(
       'r72_external_event_command', 'app_private', 'CREATE'
     )
     OR pg_catalog.has_schema_privilege(
       'r72_external_event_command', 'app', 'USAGE'
     )
     OR pg_catalog.has_schema_privilege(
       'r72_external_event_command', 'app', 'CREATE'
     ) THEN
    RAISE EXCEPTION 'External-event command schema privileges are unsafe';
  END IF;

  SELECT format('%I.%I', namespace.nspname, relation.relname)
    INTO unexpected_object
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname IN ('app', 'app_private')
    AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND (
      pg_catalog.has_table_privilege('r72_external_event_command', relation.oid, 'SELECT')
      OR pg_catalog.has_table_privilege('r72_external_event_command', relation.oid, 'INSERT')
      OR pg_catalog.has_table_privilege('r72_external_event_command', relation.oid, 'UPDATE')
      OR pg_catalog.has_table_privilege('r72_external_event_command', relation.oid, 'DELETE')
      OR pg_catalog.has_table_privilege('r72_external_event_command', relation.oid, 'TRUNCATE')
      OR pg_catalog.has_table_privilege('r72_external_event_command', relation.oid, 'REFERENCES')
      OR pg_catalog.has_table_privilege('r72_external_event_command', relation.oid, 'TRIGGER')
    )
  LIMIT 1;

  IF unexpected_object IS NOT NULL THEN
    RAISE EXCEPTION 'External-event command unexpectedly has table privilege on %',
      unexpected_object;
  END IF;

  SELECT format('%I.%I(%s)', namespace.nspname, procedure.proname,
      pg_catalog.pg_get_function_identity_arguments(procedure.oid))
    INTO unexpected_object
  FROM pg_catalog.pg_proc AS procedure
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
  WHERE namespace.nspname = 'app_private'
    AND pg_catalog.has_function_privilege(
      'r72_external_event_command', procedure.oid, 'EXECUTE'
    )
    AND procedure.oid NOT IN (
      recorder_oid,
      pg_catalog.to_regprocedure('app_private.current_workspace_id()'),
      pg_catalog.to_regprocedure('app_private.current_actor_kind()'),
      pg_catalog.to_regprocedure('app_private.current_request_id()')
    )
  LIMIT 1;

  IF unexpected_object IS NOT NULL THEN
    RAISE EXCEPTION 'External-event command unexpectedly can execute %',
      unexpected_object;
  END IF;

  IF NOT pg_catalog.has_function_privilege(
       'r72_external_event_command', recorder_oid, 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'External-event command cannot execute the receipt recorder';
  END IF;

  IF NOT pg_catalog.has_schema_privilege(
       'r72_external_event_definer', 'app_private', 'USAGE'
     )
     OR pg_catalog.has_schema_privilege(
       'r72_external_event_definer', 'app_private', 'CREATE'
     )
     OR pg_catalog.has_schema_privilege(
       'r72_external_event_definer', 'app', 'USAGE'
     )
     OR pg_catalog.has_schema_privilege(
       'r72_external_event_definer', 'app', 'CREATE'
     ) THEN
    RAISE EXCEPTION 'External-event definer schema privileges are unsafe';
  END IF;

  SELECT format('%I.%I(%s)', namespace.nspname, procedure.proname,
      pg_catalog.pg_get_function_identity_arguments(procedure.oid))
    INTO unexpected_object
  FROM pg_catalog.pg_proc AS procedure
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
  WHERE namespace.nspname = 'app_private'
    AND pg_catalog.has_function_privilege(
      'r72_external_event_definer', procedure.oid, 'EXECUTE'
    )
    AND procedure.oid NOT IN (
      recorder_oid,
      pg_catalog.to_regprocedure('app_private.current_workspace_id()'),
      pg_catalog.to_regprocedure('app_private.current_actor_kind()'),
      pg_catalog.to_regprocedure('app_private.current_request_id()')
    )
  LIMIT 1;

  IF unexpected_object IS NOT NULL THEN
    RAISE EXCEPTION 'External-event definer unexpectedly can execute %',
      unexpected_object;
  END IF;

  SELECT format('%I.%I', namespace.nspname, relation.relname)
    INTO unexpected_object
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname IN ('app', 'app_private')
    AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND relation.oid <> 'app_private.external_event_shadow_receipts'::regclass
    AND (
      pg_catalog.has_table_privilege('r72_external_event_definer', relation.oid, 'SELECT')
      OR pg_catalog.has_table_privilege('r72_external_event_definer', relation.oid, 'INSERT')
      OR pg_catalog.has_table_privilege('r72_external_event_definer', relation.oid, 'UPDATE')
      OR pg_catalog.has_table_privilege('r72_external_event_definer', relation.oid, 'DELETE')
      OR pg_catalog.has_table_privilege('r72_external_event_definer', relation.oid, 'TRUNCATE')
      OR pg_catalog.has_table_privilege('r72_external_event_definer', relation.oid, 'REFERENCES')
      OR pg_catalog.has_table_privilege('r72_external_event_definer', relation.oid, 'TRIGGER')
    )
  LIMIT 1;

  IF unexpected_object IS NOT NULL THEN
    RAISE EXCEPTION 'External-event definer unexpectedly has table privilege on %',
      unexpected_object;
  END IF;

  IF NOT pg_catalog.has_table_privilege(
       'r72_external_event_definer',
       'app_private.external_event_shadow_receipts',
       'SELECT'
     )
     OR NOT pg_catalog.has_table_privilege(
       'r72_external_event_definer',
       'app_private.external_event_shadow_receipts',
       'INSERT'
     )
     OR pg_catalog.has_table_privilege(
       'r72_external_event_definer',
       'app_private.external_event_shadow_receipts',
       'UPDATE'
     )
     OR pg_catalog.has_table_privilege(
       'r72_external_event_definer',
       'app_private.external_event_shadow_receipts',
       'DELETE'
     )
     OR pg_catalog.has_table_privilege(
       'r72_external_event_definer',
       'app_private.external_event_shadow_receipts',
       'TRUNCATE'
     )
     OR pg_catalog.has_table_privilege(
       'r72_external_event_definer',
       'app_private.external_event_shadow_receipts',
       'REFERENCES'
     )
     OR pg_catalog.has_table_privilege(
       'r72_external_event_definer',
       'app_private.external_event_shadow_receipts',
       'TRIGGER'
     ) THEN
    RAISE EXCEPTION 'External-event definer receipt-table privileges are unsafe';
  END IF;
END
$capability_audit$;
