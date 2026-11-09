-- Let the metadata-only company-asset reader prove that it is connected to
-- the exact Growth HQ database installation before the production portal is
-- composed. This adds no table write, approval, generation or provider effect.

DO $preflight$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles
    WHERE rolname = 'r72_content_adapter'
      AND rolcanlogin AND NOT rolinherit AND NOT rolsuper
      AND NOT rolcreatedb AND NOT rolcreaterole
      AND NOT rolreplication AND NOT rolbypassrls
  ) THEN
    RAISE EXCEPTION 'Content-adapter role is missing or unsafe';
  END IF;
  IF pg_catalog.to_regprocedure(
       'app_private.runtime_database_installation_id()'
     ) IS NULL THEN
    RAISE EXCEPTION 'Runtime installation identity is unavailable';
  END IF;
END
$preflight$;

SET LOCAL ROLE r72_security_definer;

GRANT EXECUTE ON FUNCTION app_private.runtime_database_installation_id()
  TO r72_content_adapter;

RESET ROLE;

DO $capability_audit$
BEGIN
  IF NOT pg_catalog.has_function_privilege(
       'r72_content_adapter',
       'app_private.runtime_database_installation_id()',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'Content-adapter installation readiness is incomplete';
  END IF;
  IF NOT pg_catalog.has_schema_privilege(
       'r72_content_adapter', 'app_private', 'USAGE'
     )
     OR pg_catalog.has_schema_privilege(
       'r72_content_adapter', 'app_private', 'CREATE'
     )
     OR pg_catalog.has_table_privilege(
       'r72_content_adapter', 'app.provider_operations', 'INSERT'
     )
     OR pg_catalog.has_function_privilege(
       'r72_content_adapter',
       'app_private.lock_active_portal_session(bytea,uuid,uuid)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'Content-adapter gained an unsafe runtime capability';
  END IF;
END
$capability_audit$;
