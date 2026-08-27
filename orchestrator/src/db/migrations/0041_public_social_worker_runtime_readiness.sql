-- Allow the deterministic TEST-only social rail to prove that its bundled
-- release and database schema match before it starts polling. This adds no
-- table access, provider credential, live adapter or external capability.

DO $preflight$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles
    WHERE rolname = 'r72_public_social_worker_command'
      AND rolcanlogin AND NOT rolinherit AND NOT rolsuper
      AND NOT rolcreatedb AND NOT rolcreaterole
      AND NOT rolreplication AND NOT rolbypassrls
  ) THEN
    RAISE EXCEPTION 'Public-social TEST worker role is missing or unsafe';
  END IF;
  IF pg_catalog.to_regprocedure(
       'app_private.runtime_schema_migrations()'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'app_private.runtime_database_installation_id()'
     ) IS NULL THEN
    RAISE EXCEPTION 'Runtime readiness functions are unavailable';
  END IF;
END
$preflight$;

SET LOCAL ROLE r72_security_definer;

GRANT EXECUTE ON FUNCTION app_private.runtime_schema_migrations()
  TO r72_public_social_worker_command;

RESET ROLE;

DO $capability_audit$
DECLARE
  schema_migrations_oid oid := pg_catalog.to_regprocedure(
    'app_private.runtime_schema_migrations()'
  );
  installation_oid oid := pg_catalog.to_regprocedure(
    'app_private.runtime_database_installation_id()'
  );
BEGIN
  IF schema_migrations_oid IS NULL OR installation_oid IS NULL
     OR NOT pg_catalog.has_function_privilege(
       'r72_public_social_worker_command', schema_migrations_oid, 'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'r72_public_social_worker_command', installation_oid, 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'Public-social TEST worker runtime readiness is incomplete';
  END IF;
  IF pg_catalog.has_schema_privilege(
       'r72_public_social_worker_command', 'app_private', 'CREATE'
     )
     OR pg_catalog.has_schema_privilege(
       'r72_public_social_worker_command', 'app', 'USAGE'
     ) THEN
    RAISE EXCEPTION 'Public-social TEST worker gained an unsafe schema capability';
  END IF;
END
$capability_audit$;
