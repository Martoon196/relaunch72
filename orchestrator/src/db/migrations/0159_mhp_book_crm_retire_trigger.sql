-- 0159: retire the 17 Nov 2026 hand-applied "book sign-up into the CRM" database trigger. Book sign-ups are now copied
-- into the MHP brand CRM by the application, through the CRM's own command (crm.createLead) as the brand's lead owner,
-- after the sign-up is committed (src/mhp/book-leads-service.ts). The hand-applied pieces are recorded in
-- docs/ops/mhp-book-contact-sync-20261117.sql and docs/ops/mhp-book-pipeline-sync-20261117.sql; this file removes them.
--
-- Converges both starting states to the same end state:
--   production-shaped: 0001-0158 plus the two docs/ops files applied by hand;
--   fresh:             0001-0158 only (every statement below is then a no-op).
-- Removed, each only if present:
--   trigger  mhp_book_contact_after_signup ON app_private.mhp_prospect_signups
--   function app_private.mhp_book_contact_after_signup()
--   policies mhp_book_* for r72_mhp_prospect_definer on app.contacts, app.contact_points, app.pipelines,
--            app.pipeline_stages, app.opportunities, app.opportunity_stage_history, app.tasks (the ten named in the two
--            files, and any other policy of that name prefix on those tables for that role)
--   grants   to r72_mhp_prospect_definer, exactly the ones the two files added and no earlier migration gives it:
--            SELECT, INSERT on app.contacts; INSERT on app.contact_points; SELECT on app.pipelines, app.pipeline_stages;
--            SELECT, INSERT on app.opportunities; INSERT on app.opportunity_stage_history, app.tasks; CREATE on schema
--            app_private (already revoked by the files themselves).
-- Kept: SELECT on app.contact_points (granted by 0134 for the webinar text-reminder hand-off) and every policy of 0134
-- and 0135 on that table; every other privilege of r72_mhp_prospect_definer.
-- No row is read, inserted, updated or deleted. Every CRM row the trigger made (contacts, email points, enquiries, stage
-- history, tasks) stays exactly as it is; the application recognises those leads and only fills in what was skipped.
-- Transactional (the runner wraps each file), idempotent, safe to retry; short lock timeouts.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

SET LOCAL ROLE r72_owner;
DROP TRIGGER IF EXISTS mhp_book_contact_after_signup ON app_private.mhp_prospect_signups;
RESET ROLE;

-- The function belongs to r72_mhp_prospect_definer (the files created it under that role).
SET LOCAL ROLE r72_mhp_prospect_definer;
DROP FUNCTION IF EXISTS app_private.mhp_book_contact_after_signup();
RESET ROLE;

SET LOCAL ROLE r72_owner;
DROP POLICY IF EXISTS mhp_book_contact_read ON app.contacts;
DROP POLICY IF EXISTS mhp_book_contact_insert ON app.contacts;
DROP POLICY IF EXISTS mhp_book_point_read ON app.contact_points;
DROP POLICY IF EXISTS mhp_book_point_insert ON app.contact_points;
DROP POLICY IF EXISTS mhp_book_pipeline_read ON app.pipelines;
DROP POLICY IF EXISTS mhp_book_stage_read ON app.pipeline_stages;
DROP POLICY IF EXISTS mhp_book_opportunity_read ON app.opportunities;
DROP POLICY IF EXISTS mhp_book_opportunity_insert ON app.opportunities;
DROP POLICY IF EXISTS mhp_book_history_insert ON app.opportunity_stage_history;
DROP POLICY IF EXISTS mhp_book_task_insert ON app.tasks;
DO $policies$
DECLARE p record;
BEGIN
  -- Any further hand-made policy of the same family on the same seven tables for the same role.
  FOR p IN SELECT pol.polname, cls.relname FROM pg_catalog.pg_policy pol
      JOIN pg_catalog.pg_class cls ON cls.oid=pol.polrelid
      JOIN pg_catalog.pg_namespace nsp ON nsp.oid=cls.relnamespace
    WHERE nsp.nspname='app' AND pol.polname LIKE 'mhp\_book\_%'
      AND cls.relname IN ('contacts','contact_points','pipelines','pipeline_stages','opportunities','opportunity_stage_history','tasks')
      AND (SELECT oid FROM pg_catalog.pg_roles WHERE rolname='r72_mhp_prospect_definer')=ANY(pol.polroles)
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON app.%I', p.polname, p.relname);
  END LOOP;
END $policies$;

REVOKE SELECT, INSERT ON app.contacts FROM r72_mhp_prospect_definer;
REVOKE INSERT ON app.contact_points FROM r72_mhp_prospect_definer;
REVOKE SELECT ON app.pipelines, app.pipeline_stages FROM r72_mhp_prospect_definer;
REVOKE SELECT, INSERT ON app.opportunities FROM r72_mhp_prospect_definer;
REVOKE INSERT ON app.opportunity_stage_history, app.tasks FROM r72_mhp_prospect_definer;
REVOKE CREATE ON SCHEMA app_private FROM r72_mhp_prospect_definer;
RESET ROLE;

DO $verify$
BEGIN
  IF to_regprocedure('app_private.mhp_book_contact_after_signup()') IS NOT NULL
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE tgname='mhp_book_contact_after_signup')
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_policies WHERE schemaname='app' AND policyname LIKE 'mhp\_book\_%'
      AND tablename IN ('contacts','contact_points','pipelines','pipeline_stages','opportunities','opportunity_stage_history','tasks'))
    OR has_table_privilege('r72_mhp_prospect_definer','app.contacts','SELECT')
    OR has_table_privilege('r72_mhp_prospect_definer','app.contacts','INSERT')
    OR has_table_privilege('r72_mhp_prospect_definer','app.contact_points','INSERT')
    OR has_table_privilege('r72_mhp_prospect_definer','app.pipelines','SELECT')
    OR has_table_privilege('r72_mhp_prospect_definer','app.pipeline_stages','SELECT')
    OR has_table_privilege('r72_mhp_prospect_definer','app.opportunities','SELECT')
    OR has_table_privilege('r72_mhp_prospect_definer','app.opportunities','INSERT')
    OR has_table_privilege('r72_mhp_prospect_definer','app.opportunity_stage_history','INSERT')
    OR has_table_privilege('r72_mhp_prospect_definer','app.tasks','INSERT')
    OR has_schema_privilege('r72_mhp_prospect_definer','app_private','CREATE')
    OR NOT has_table_privilege('r72_mhp_prospect_definer','app.contact_points','SELECT') THEN
    RAISE EXCEPTION '0159: the book sign-up trigger, its policies or its grants are still present' USING ERRCODE='55000';
  END IF;
END $verify$;
