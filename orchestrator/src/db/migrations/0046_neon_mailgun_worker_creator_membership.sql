-- PostgreSQL 16+ automatically grants a newly created role back to a
-- non-superuser CREATEROLE creator with ADMIN TRUE, INHERIT FALSE and SET
-- FALSE. Neon exposes that safe, bootstrap-superuser grant to the database
-- owner and it cannot be removed by the owner. Remove the separate effective
-- self-grant left by 0025 and teach the runtime boundary to accept only the
-- single unavoidable, non-effective creator grant.

DO $membership_repair$
DECLARE
  owner_self_grants integer;
BEGIN
  SELECT pg_catalog.count(*)::integer
  INTO owner_self_grants
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
  JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
  JOIN pg_catalog.pg_roles AS grantor ON grantor.oid = membership.grantor
  WHERE parent.rolname = 'r72_mailgun_worker_command'
    AND member.rolname = session_user
    AND grantor.rolname = session_user
    AND (membership.inherit_option OR membership.set_option);

  IF owner_self_grants > 1 THEN
    RAISE EXCEPTION
      'Multiple effective owner grants target the Mailgun worker role';
  END IF;

  IF owner_self_grants = 1 THEN
    EXECUTE pg_catalog.format(
      'REVOKE r72_mailgun_worker_command FROM %I GRANTED BY %I RESTRICT',
      session_user,
      session_user
    );
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members AS membership
    JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
    WHERE parent.rolname = 'r72_mailgun_worker_command'
      AND (membership.inherit_option OR membership.set_option)
  ) THEN
    RAISE EXCEPTION
      'Effective membership still targets the Mailgun worker role';
  END IF;
END
$membership_repair$;

SET LOCAL ROLE r72_owner;

GRANT CREATE ON SCHEMA app_private TO r72_mailgun_worker_definer;
SET LOCAL ROLE r72_mailgun_worker_definer;

CREATE OR REPLACE FUNCTION app_private.property_predator_email_pilot_boundary_ready()
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  required_oid oid;
  required_oids oid[] := ARRAY[
    to_regprocedure('app_private.authorize_property_predator_email_pilot(uuid,uuid,uuid,uuid,bytea,bytea,uuid,date,text,text,uuid,uuid,uuid,bytea,jsonb,integer,bigint,integer,integer,bigint,bigint,boolean,boolean,boolean)'),
    to_regprocedure('app_private.cancel_property_predator_email_pilot_before_call(uuid,uuid,bytea,text)'),
    to_regprocedure('app_private.settle_property_predator_email_pilot_call(uuid,uuid,bytea,text,text,timestamp with time zone,boolean,text,text)'),
    to_regprocedure('app_private.claim_property_predator_mailgun_job(uuid,uuid,bytea,integer)'),
    to_regprocedure('app_private.renew_property_predator_mailgun_job(uuid,uuid,bigint,bytea,integer)'),
    to_regprocedure('app_private.begin_property_predator_mailgun_job_call(uuid,uuid,uuid,bigint,bytea,boolean,boolean,boolean,bigint,bigint)'),
    to_regprocedure('app_private.settle_property_predator_mailgun_job(uuid,uuid,bigint,bytea,text,text,timestamp with time zone,boolean,text,text)'),
    to_regprocedure('app_private.recover_one_property_predator_mailgun_job(uuid,uuid)'),
    to_regprocedure('app_private.property_predator_email_pilot_boundary_ready()')
  ];
  ledger_oid oid := to_regprocedure('app_private.runtime_schema_migrations()');
  installation_oid oid := to_regprocedure(
    'app_private.runtime_database_installation_id()'
  );
  session_role_oid oid := to_regrole(session_user);
  database_owner_oid oid;
BEGIN
  SELECT database.datdba
  INTO database_owner_oid
  FROM pg_catalog.pg_database AS database
  WHERE database.datname = current_database();

  IF session_user <> 'r72_mailgun_worker_command'
     OR session_role_oid IS NULL OR database_owner_oid IS NULL
     OR array_position(required_oids, NULL::oid) IS NOT NULL
     OR ledger_oid IS NULL OR installation_oid IS NULL
     OR pg_catalog.to_regclass('app.property_predator_mailgun_jobs') IS NULL
     OR pg_catalog.to_regclass('app.property_predator_mailgun_job_lease_hashes') IS NULL THEN
    RETURN false;
  END IF;
  FOREACH required_oid IN ARRAY required_oids LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc AS procedure
      JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = procedure.proowner
      WHERE procedure.oid = required_oid
        AND owner_role.rolname = 'r72_mailgun_worker_definer'
        AND procedure.prosecdef
        AND procedure.proconfig = ARRAY['search_path=pg_catalog']::text[]
        AND pg_catalog.has_function_privilege(session_user, procedure.oid, 'EXECUTE')
    ) THEN RETURN false; END IF;
  END LOOP;
  RETURN EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles AS role
      WHERE role.rolname = session_user
        AND role.rolcanlogin AND NOT role.rolinherit AND NOT role.rolsuper
        AND NOT role.rolcreatedb AND NOT role.rolcreaterole
        AND NOT role.rolreplication AND NOT role.rolbypassrls
    )
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_auth_members AS membership
      WHERE membership.member = session_role_oid
    )
    AND 1 = (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_auth_members AS membership
      WHERE membership.roleid = session_role_oid
    )
    AND EXISTS (
      SELECT 1
      FROM pg_catalog.pg_auth_members AS membership
      JOIN pg_catalog.pg_roles AS grantor
        ON grantor.oid = membership.grantor
      WHERE membership.roleid = session_role_oid
        AND membership.member = database_owner_oid
        AND grantor.rolsuper
        AND membership.admin_option
        AND NOT membership.inherit_option
        AND NOT membership.set_option
    )
    AND NOT pg_catalog.pg_has_role(
      database_owner_oid, session_role_oid, 'USAGE'
    )
    AND NOT pg_catalog.pg_has_role(
      database_owner_oid, session_role_oid, 'SET'
    )
    AND pg_catalog.has_function_privilege(session_user, ledger_oid, 'EXECUTE')
    AND pg_catalog.has_function_privilege(session_user, installation_oid, 'EXECUTE')
    AND pg_catalog.has_schema_privilege(session_user, 'app_private', 'USAGE')
    AND NOT pg_catalog.has_schema_privilege(session_user, 'app_private', 'CREATE')
    AND NOT pg_catalog.has_schema_privilege(session_user, 'app', 'USAGE')
    AND NOT pg_catalog.has_schema_privilege(session_user, 'public', 'CREATE')
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname IN ('app', 'app_private')
        AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND (
          has_table_privilege(session_user, relation.oid, 'SELECT')
          OR has_table_privilege(session_user, relation.oid, 'INSERT')
          OR has_table_privilege(session_user, relation.oid, 'UPDATE')
          OR has_table_privilege(session_user, relation.oid, 'DELETE')
          OR has_table_privilege(session_user, relation.oid, 'TRUNCATE')
        )
    )
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc AS procedure
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = procedure.pronamespace
      WHERE namespace.nspname = 'app_private'
        AND procedure.oid <> ALL(required_oids)
        AND procedure.oid NOT IN (ledger_oid, installation_oid)
        AND pg_catalog.has_function_privilege(
          session_user, procedure.oid, 'EXECUTE'
        )
    );
END
$function$;

SET LOCAL ROLE r72_owner;

REVOKE ALL ON FUNCTION app_private.property_predator_email_pilot_boundary_ready()
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.property_predator_email_pilot_boundary_ready()
  TO r72_mailgun_worker_command;
REVOKE CREATE ON SCHEMA app_private FROM r72_mailgun_worker_definer;

RESET ROLE;
