-- Repair the read-only portal-session capability used by the Zernio account
-- snapshot. Migration 0074 granted the write-side lock fence, but read-only
-- transactions deliberately use active_portal_session instead.
--
-- This migration changes no application data and creates no provider effect.

SET LOCAL ROLE r72_owner;

GRANT EXECUTE ON FUNCTION app_private.active_portal_session(bytea, uuid, uuid)
  TO r72_zernio_social_command;

DO $repair_audit$
BEGIN
  IF NOT pg_catalog.has_function_privilege(
       'r72_zernio_social_command',
       'app_private.active_portal_session(bytea,uuid,uuid)', 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'Zernio social command cannot validate a read-only portal session'
      USING ERRCODE = '42501';
  END IF;
  IF NOT pg_catalog.has_function_privilege(
       'r72_zernio_social_command',
       'app_private.lock_active_portal_session(bytea,uuid,uuid)', 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'Zernio social command lost its write-side portal session fence'
      USING ERRCODE = '42501';
  END IF;
  IF NOT pg_catalog.has_function_privilege(
       'r72_zernio_social_command',
       'app_private.read_zernio_social_accounts(uuid,uuid,bytea)', 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'Zernio social command lost its account snapshot boundary'
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
        pg_catalog.has_table_privilege(
          'r72_zernio_social_command', relation.oid, 'SELECT'
        )
        OR pg_catalog.has_table_privilege(
          'r72_zernio_social_command', relation.oid, 'INSERT'
        )
        OR pg_catalog.has_table_privilege(
          'r72_zernio_social_command', relation.oid, 'UPDATE'
        )
        OR pg_catalog.has_table_privilege(
          'r72_zernio_social_command', relation.oid, 'DELETE'
        )
        OR pg_catalog.has_table_privilege(
          'r72_zernio_social_command', relation.oid, 'TRUNCATE'
        )
      )
  ) THEN
    RAISE EXCEPTION 'Zernio social command gained a direct table capability'
      USING ERRCODE = '42501';
  END IF;
END
$repair_audit$;
