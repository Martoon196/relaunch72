-- Repair the exact nested session fence used by the company-content sync
-- command definer. Production proved that the outer web role could execute
-- consume_company_content_sync_command, but its SECURITY DEFINER owner could
-- not invoke lock_active_portal_session, so no source read ever started.
--
-- This migration changes no application data and creates no provider effect.

SET LOCAL ROLE r72_owner;

DO $preflight$
DECLARE
  consume_oid oid := pg_catalog.to_regprocedure(
    'app_private.consume_company_content_sync_command(uuid,bytea,text)'
  );
  lock_oid oid := pg_catalog.to_regprocedure(
    'app_private.lock_active_portal_session(bytea,uuid,uuid)'
  );
BEGIN
  IF consume_oid IS NULL OR lock_oid IS NULL THEN
    RAISE EXCEPTION 'Company-content sync session boundary is unavailable'
      USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = procedure.proowner
    WHERE procedure.oid IN (consume_oid, lock_oid)
      AND owner_role.rolname = 'r72_security_definer'
      AND procedure.prosecdef
      AND procedure.proconfig = ARRAY['search_path=pg_catalog']::text[]
    GROUP BY owner_role.rolname
    HAVING pg_catalog.count(*) = 2
  ) THEN
    RAISE EXCEPTION 'Company-content sync session boundary ownership is unsafe'
      USING ERRCODE = '42501';
  END IF;
END
$preflight$;

GRANT EXECUTE ON FUNCTION app_private.lock_active_portal_session(bytea, uuid, uuid)
  TO r72_security_definer;

DO $repair_audit$
BEGIN
  IF NOT pg_catalog.has_function_privilege(
       'r72_security_definer',
       'app_private.lock_active_portal_session(bytea,uuid,uuid)', 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'Company-content sync definer cannot lock an active portal session'
      USING ERRCODE = '42501';
  END IF;
  IF NOT pg_catalog.has_function_privilege(
       'r72_web',
       'app_private.consume_company_content_sync_command(uuid,bytea,text)', 'EXECUTE'
     ) OR pg_catalog.has_function_privilege(
       'r72_web',
       'app_private.lock_active_portal_session(bytea,uuid,uuid)', 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'Company-content sync web capability widened or was lost'
      USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname IN ('app', 'app_private')
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND (
        pg_catalog.has_table_privilege('r72_web', relation.oid, 'SELECT')
        OR pg_catalog.has_table_privilege('r72_web', relation.oid, 'INSERT')
        OR pg_catalog.has_table_privilege('r72_web', relation.oid, 'UPDATE')
        OR pg_catalog.has_table_privilege('r72_web', relation.oid, 'DELETE')
        OR pg_catalog.has_table_privilege('r72_web', relation.oid, 'TRUNCATE')
      )
  ) THEN
    RAISE EXCEPTION 'Company-content sync web role gained a direct table capability'
      USING ERRCODE = '42501';
  END IF;
END
$repair_audit$;
