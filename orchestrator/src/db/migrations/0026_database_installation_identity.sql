-- A branch-local, opaque installation identity lets every least-privilege
-- Property Predator production connection prove that it reaches the same
-- database installation. Runtime roles can execute the one-value function;
-- none receives direct access to the private singleton table.

SET LOCAL ROLE r72_owner;

CREATE TABLE app_private.database_installation_identity (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  installation_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid()
);

REVOKE ALL ON app_private.database_installation_identity
  FROM PUBLIC, r72_web, r72_identity_command, r72_crm_command,
    r72_content_command, r72_mailgun_webhook_command,
    r72_mailgun_worker_command;

INSERT INTO app_private.database_installation_identity DEFAULT VALUES;

-- The established non-login security-definer owns the read boundary and gets
-- the only non-owner table grant. Its CREATE privilege is temporary and is
-- removed again before any runtime role receives EXECUTE.
GRANT SELECT ON app_private.database_installation_identity
  TO r72_security_definer;
GRANT CREATE ON SCHEMA app_private TO r72_security_definer;

CREATE FUNCTION app_private.runtime_database_installation_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT installation.installation_id
  FROM app_private.database_installation_identity AS installation
  WHERE installation.singleton
$function$;

ALTER FUNCTION app_private.runtime_database_installation_id()
  OWNER TO r72_security_definer;
REVOKE CREATE ON SCHEMA app_private FROM r72_security_definer;

REVOKE ALL ON FUNCTION app_private.runtime_database_installation_id()
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.runtime_database_installation_id()
  TO r72_web, r72_identity_command, r72_crm_command,
    r72_content_command, r72_mailgun_webhook_command,
    r72_mailgun_worker_command;

-- 0025 deliberately rejects every app_private capability outside its exact
-- worker allowlist. Forward-extend that readiness proof for this one read-only
-- UUID function so the new grant cannot silently disable the worker.
GRANT CREATE ON SCHEMA app_private TO r72_mailgun_worker_definer;
SET LOCAL ROLE r72_mailgun_worker_definer;

CREATE OR REPLACE FUNCTION app_private.property_predator_email_pilot_boundary_ready()
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  authorize_oid oid := pg_catalog.to_regprocedure(
    'app_private.authorize_property_predator_email_pilot(uuid,uuid,uuid,uuid,bytea,bytea,uuid,date,text,text,uuid,uuid,uuid,bytea,jsonb,integer,bigint,integer,integer,bigint,bigint,boolean,boolean,boolean)'
  );
  cancel_oid oid := pg_catalog.to_regprocedure(
    'app_private.cancel_property_predator_email_pilot_before_call(uuid,uuid,bytea,text)'
  );
  settle_oid oid := pg_catalog.to_regprocedure(
    'app_private.settle_property_predator_email_pilot_call(uuid,uuid,bytea,text,text,timestamp with time zone,boolean,text,text)'
  );
  ready_oid oid := pg_catalog.to_regprocedure(
    'app_private.property_predator_email_pilot_boundary_ready()'
  );
  ledger_oid oid := pg_catalog.to_regprocedure(
    'app_private.runtime_schema_migrations()'
  );
  installation_oid oid := pg_catalog.to_regprocedure(
    'app_private.runtime_database_installation_id()'
  );
BEGIN
  IF session_user <> 'r72_mailgun_worker_command' THEN
    RAISE EXCEPTION 'Mailgun worker readiness denied' USING ERRCODE = '42501';
  END IF;
  RETURN authorize_oid IS NOT NULL AND cancel_oid IS NOT NULL
    AND settle_oid IS NOT NULL AND ready_oid IS NOT NULL
    AND ledger_oid IS NOT NULL AND installation_oid IS NOT NULL
    AND pg_catalog.to_regclass('app.property_predator_email_pilot_reservations') IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles AS role
      WHERE role.rolname = session_user
        AND role.rolcanlogin AND NOT role.rolinherit AND NOT role.rolsuper
        AND NOT role.rolcreatedb AND NOT role.rolcreaterole
        AND NOT role.rolreplication AND NOT role.rolbypassrls
    )
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_auth_members AS membership
      JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
      WHERE member.rolname = session_user
    )
    AND (
      SELECT count(*) = 4
      FROM pg_catalog.pg_proc AS procedure
      JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = procedure.proowner
      WHERE procedure.oid IN (authorize_oid, cancel_oid, settle_oid, ready_oid)
        AND owner_role.rolname = 'r72_mailgun_worker_definer'
        AND procedure.prosecdef
        AND procedure.proconfig = ARRAY['search_path=pg_catalog']::text[]
    )
    AND pg_catalog.has_schema_privilege(session_user, 'app_private', 'USAGE')
    AND NOT pg_catalog.has_schema_privilege(session_user, 'app_private', 'CREATE')
    AND NOT pg_catalog.has_schema_privilege(session_user, 'app', 'USAGE')
    AND NOT pg_catalog.has_schema_privilege(session_user, 'public', 'CREATE')
    AND pg_catalog.has_function_privilege(session_user, authorize_oid, 'EXECUTE')
    AND pg_catalog.has_function_privilege(session_user, cancel_oid, 'EXECUTE')
    AND pg_catalog.has_function_privilege(session_user, settle_oid, 'EXECUTE')
    AND pg_catalog.has_function_privilege(session_user, ready_oid, 'EXECUTE')
    AND pg_catalog.has_function_privilege(session_user, ledger_oid, 'EXECUTE')
    AND pg_catalog.has_function_privilege(session_user, installation_oid, 'EXECUTE')
    AND NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname IN ('app', 'app_private')
        AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND (
          pg_catalog.has_table_privilege(session_user, relation.oid, 'SELECT')
          OR pg_catalog.has_table_privilege(session_user, relation.oid, 'INSERT')
          OR pg_catalog.has_table_privilege(session_user, relation.oid, 'UPDATE')
          OR pg_catalog.has_table_privilege(session_user, relation.oid, 'DELETE')
          OR pg_catalog.has_table_privilege(session_user, relation.oid, 'TRUNCATE')
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS procedure
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
      WHERE namespace.nspname = 'app_private'
        AND procedure.oid NOT IN (
          authorize_oid, cancel_oid, settle_oid, ready_oid, ledger_oid,
          installation_oid
        )
        AND pg_catalog.has_function_privilege(session_user, procedure.oid, 'EXECUTE')
    );
END
$function$;

REVOKE ALL ON FUNCTION app_private.property_predator_email_pilot_boundary_ready()
  FROM PUBLIC;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_mailgun_worker_definer;
GRANT EXECUTE ON FUNCTION app_private.property_predator_email_pilot_boundary_ready()
  TO r72_mailgun_worker_command;

-- Fail the migration if default privileges or ownership drift widened either
-- side of the boundary. The function owner is necessarily executable too; it
-- is a NOLOGIN role and has only SELECT on this table.
DO $installation_identity_boundary_check$
DECLARE
  role_name text;
  function_oid oid := pg_catalog.to_regprocedure(
    'app_private.runtime_database_installation_id()'
  );
  relation_oid oid := pg_catalog.to_regclass(
    'app_private.database_installation_identity'
  );
  unexpected_grantee text;
BEGIN
  IF function_oid IS NULL OR relation_oid IS NULL THEN
    RAISE EXCEPTION 'Database installation identity boundary is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    WHERE procedure.oid = function_oid
      AND procedure.proowner = 'r72_security_definer'::regrole
      AND procedure.prorettype = 'uuid'::regtype
      AND procedure.prosecdef
      AND procedure.provolatile = 's'
      AND procedure.proconfig = ARRAY['search_path=pg_catalog']::text[]
  ) THEN
    RAISE EXCEPTION 'Database installation identity function is unsafe';
  END IF;

  FOREACH role_name IN ARRAY ARRAY[
    'r72_web',
    'r72_identity_command',
    'r72_crm_command',
    'r72_content_command',
    'r72_mailgun_webhook_command',
    'r72_mailgun_worker_command'
  ]
  LOOP
    IF NOT pg_catalog.has_schema_privilege(
         role_name, 'app_private', 'USAGE'
       ) OR NOT pg_catalog.has_function_privilege(
         role_name, function_oid, 'EXECUTE'
       ) THEN
      RAISE EXCEPTION 'Database installation identity function is unavailable to %',
        role_name;
    END IF;

    IF pg_catalog.has_table_privilege(role_name, relation_oid, 'SELECT')
       OR pg_catalog.has_table_privilege(role_name, relation_oid, 'INSERT')
       OR pg_catalog.has_table_privilege(role_name, relation_oid, 'UPDATE')
       OR pg_catalog.has_table_privilege(role_name, relation_oid, 'DELETE')
       OR pg_catalog.has_table_privilege(role_name, relation_oid, 'TRUNCATE')
       OR pg_catalog.has_table_privilege(role_name, relation_oid, 'REFERENCES')
       OR pg_catalog.has_table_privilege(role_name, relation_oid, 'TRIGGER') THEN
      RAISE EXCEPTION 'Database installation identity table is exposed to %',
        role_name;
    END IF;
  END LOOP;

  SELECT CASE
      WHEN privilege.grantee = 0 THEN 'PUBLIC'
      ELSE pg_catalog.pg_get_userbyid(privilege.grantee)
    END
    INTO unexpected_grantee
  FROM pg_catalog.pg_proc AS procedure
  CROSS JOIN LATERAL pg_catalog.aclexplode(
    COALESCE(
      procedure.proacl,
      pg_catalog.acldefault('f', procedure.proowner)
    )
  ) AS privilege
  WHERE procedure.oid = function_oid
    AND privilege.privilege_type = 'EXECUTE'
    AND privilege.grantee <> procedure.proowner
    AND privilege.grantee <> ALL (ARRAY[
      'r72_web'::regrole::oid,
      'r72_identity_command'::regrole::oid,
      'r72_crm_command'::regrole::oid,
      'r72_content_command'::regrole::oid,
      'r72_mailgun_webhook_command'::regrole::oid,
      'r72_mailgun_worker_command'::regrole::oid
    ])
  LIMIT 1;

  IF unexpected_grantee IS NOT NULL THEN
    RAISE EXCEPTION 'Database installation identity function is exposed to %',
      unexpected_grantee;
  END IF;

  unexpected_grantee := NULL;
  SELECT CASE
      WHEN privilege.grantee = 0 THEN 'PUBLIC'
      ELSE pg_catalog.pg_get_userbyid(privilege.grantee)
    END
    INTO unexpected_grantee
  FROM pg_catalog.pg_class AS relation
  CROSS JOIN LATERAL pg_catalog.aclexplode(
    COALESCE(
      relation.relacl,
      pg_catalog.acldefault('r', relation.relowner)
    )
  ) AS privilege
  WHERE relation.oid = relation_oid
    AND privilege.grantee <> relation.relowner
    AND NOT (
      privilege.grantee = 'r72_security_definer'::regrole::oid
      AND privilege.privilege_type = 'SELECT'
    )
  LIMIT 1;

  IF unexpected_grantee IS NOT NULL THEN
    RAISE EXCEPTION 'Database installation identity table is exposed to %',
      unexpected_grantee;
  END IF;
END
$installation_identity_boundary_check$;
