-- Repair the founder endpoint writer's exact read surface.
--
-- Migration 0064 orders existing endpoints by created_at, but its column-level
-- SELECT grant omitted created_at. PostgreSQL therefore raised 42501 before an
-- existing unverified endpoint could be verified. This adds only that missing
-- column; it does not widen the role to table-level SELECT or any new write.

SET LOCAL ROLE r72_owner;

GRANT SELECT (created_at) ON app.contact_points
  TO r72_contact_endpoint_definer;

DO $repair_audit$
BEGIN
  IF NOT pg_catalog.has_column_privilege(
       'r72_contact_endpoint_definer', 'app.contact_points', 'created_at', 'SELECT'
     ) THEN
    RAISE EXCEPTION 'Founder endpoint definer still cannot order existing endpoints'
      USING ERRCODE = '42501';
  END IF;
  IF pg_catalog.has_table_privilege(
       'r72_contact_endpoint_definer', 'app.contact_points', 'SELECT'
     ) THEN
    RAISE EXCEPTION 'Founder endpoint repair widened to table-level SELECT'
      USING ERRCODE = '42501';
  END IF;
END
$repair_audit$;
