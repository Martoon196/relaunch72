-- The Zernio begin function removes expired one-use intents before inserting
-- their replacement. Migration 0074 granted its definer SELECT, INSERT and
-- UPDATE on that table but omitted the exact DELETE capability PostgreSQL
-- requires even when the DELETE matches no rows.
--
-- This migration changes no application data and creates no provider effect.

SET LOCAL ROLE r72_owner;

GRANT DELETE ON app.property_predator_zernio_connection_intents
  TO r72_zernio_social_definer;

DO $repair_audit$
BEGIN
  IF NOT pg_catalog.has_table_privilege(
       'r72_zernio_social_definer',
       'app.property_predator_zernio_connection_intents', 'DELETE'
     ) THEN
    RAISE EXCEPTION 'Zernio social definer cannot retire expired connection intents'
      USING ERRCODE = '42501';
  END IF;
  IF pg_catalog.has_table_privilege(
       'r72_zernio_social_definer',
       'app.property_predator_zernio_accounts', 'DELETE'
     ) OR pg_catalog.has_table_privilege(
       'r72_zernio_social_definer',
       'app.property_predator_zernio_account_webhook_receipts', 'DELETE'
     ) THEN
    RAISE EXCEPTION 'Zernio social definer gained an evidence deletion capability'
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
