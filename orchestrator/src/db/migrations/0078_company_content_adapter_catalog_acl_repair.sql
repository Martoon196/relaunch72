-- Production proved that the content-adapter catalogue query reaches the two
-- immutable approval tables to derive only request identity and decision state,
-- but migration 0021 granted the adapter neither RLS visibility nor the exact
-- columns used by that read. Keep human approval mutation and review notes
-- private while restoring only the existing read-only catalogue projection.
--
-- This migration changes no application data and creates no provider effect.

SET LOCAL ROLE r72_owner;

DO $preflight$
BEGIN
  IF pg_catalog.to_regclass('app.company_content_approval_requests') IS NULL
     OR pg_catalog.to_regclass('app.company_content_approval_decisions') IS NULL THEN
    RAISE EXCEPTION 'Company-content approval catalogue tables are unavailable'
      USING ERRCODE = '42501';
  END IF;
END
$preflight$;

CREATE POLICY company_content_approval_requests_adapter_catalog_select
  ON app.company_content_approval_requests
  FOR SELECT TO r72_content_adapter
  USING (
    workspace_id = app_private.current_workspace_id()
    AND app_private.has_active_workspace_membership(
      app_private.current_user_id(), workspace_id
    )
  );

CREATE POLICY company_content_approval_decisions_adapter_catalog_select
  ON app.company_content_approval_decisions
  FOR SELECT TO r72_content_adapter
  USING (
    workspace_id = app_private.current_workspace_id()
    AND app_private.has_active_workspace_membership(
      app_private.current_user_id(), workspace_id
    )
  );

GRANT SELECT (
  id, workspace_id, content_item_id, content_version_id, request_number
) ON app.company_content_approval_requests TO r72_content_adapter;

GRANT SELECT (
  id, workspace_id, approval_request_id, decision
) ON app.company_content_approval_decisions TO r72_content_adapter;

DO $repair_audit$
DECLARE
  column_name text;
BEGIN
  FOREACH column_name IN ARRAY ARRAY[
    'id', 'workspace_id', 'content_item_id', 'content_version_id', 'request_number'
  ] LOOP
    IF NOT pg_catalog.has_column_privilege(
      'r72_content_adapter', 'app.company_content_approval_requests', column_name, 'SELECT'
    ) THEN
      RAISE EXCEPTION 'Content adapter is missing approval-request catalogue column %', column_name
        USING ERRCODE = '42501';
    END IF;
  END LOOP;

  FOREACH column_name IN ARRAY ARRAY[
    'id', 'workspace_id', 'approval_request_id', 'decision'
  ] LOOP
    IF NOT pg_catalog.has_column_privilege(
      'r72_content_adapter', 'app.company_content_approval_decisions', column_name, 'SELECT'
    ) THEN
      RAISE EXCEPTION 'Content adapter is missing approval-decision catalogue column %', column_name
        USING ERRCODE = '42501';
    END IF;
  END LOOP;

  FOREACH column_name IN ARRAY ARRAY[
    'content_sha256', 'review_note', 'requested_by_user_id',
    'requested_request_id', 'requested_at'
  ] LOOP
    IF pg_catalog.has_column_privilege(
      'r72_content_adapter', 'app.company_content_approval_requests', column_name, 'SELECT'
    ) THEN
      RAISE EXCEPTION 'Content adapter can inspect private approval-request column %', column_name
        USING ERRCODE = '42501';
    END IF;
  END LOOP;

  FOREACH column_name IN ARRAY ARRAY[
    'content_item_id', 'content_version_id', 'content_sha256', 'decision_note',
    'decided_by_user_id', 'decided_request_id', 'decided_at'
  ] LOOP
    IF pg_catalog.has_column_privilege(
      'r72_content_adapter', 'app.company_content_approval_decisions', column_name, 'SELECT'
    ) THEN
      RAISE EXCEPTION 'Content adapter can inspect private approval-decision column %', column_name
        USING ERRCODE = '42501';
    END IF;
  END LOOP;

  IF pg_catalog.has_table_privilege(
       'r72_content_adapter', 'app.company_content_approval_requests', 'SELECT'
     )
     OR pg_catalog.has_table_privilege(
       'r72_content_adapter', 'app.company_content_approval_decisions', 'SELECT'
     )
     OR pg_catalog.has_table_privilege(
       'r72_content_adapter', 'app.company_content_approval_requests', 'INSERT'
     )
     OR pg_catalog.has_table_privilege(
       'r72_content_adapter', 'app.company_content_approval_requests', 'UPDATE'
     )
     OR pg_catalog.has_table_privilege(
       'r72_content_adapter', 'app.company_content_approval_requests', 'DELETE'
     )
     OR pg_catalog.has_table_privilege(
       'r72_content_adapter', 'app.company_content_approval_requests', 'TRUNCATE'
     )
     OR pg_catalog.has_table_privilege(
       'r72_content_adapter', 'app.company_content_approval_decisions', 'INSERT'
     )
     OR pg_catalog.has_table_privilege(
       'r72_content_adapter', 'app.company_content_approval_decisions', 'UPDATE'
     )
     OR pg_catalog.has_table_privilege(
       'r72_content_adapter', 'app.company_content_approval_decisions', 'DELETE'
     )
     OR pg_catalog.has_table_privilege(
       'r72_content_adapter', 'app.company_content_approval_decisions', 'TRUNCATE'
     ) THEN
    RAISE EXCEPTION 'Content adapter approval-table capability is broader than the catalogue read'
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies
    WHERE schemaname = 'app'
      AND tablename = 'company_content_approval_requests'
      AND policyname = 'company_content_approval_requests_adapter_catalog_select'
      AND cmd = 'SELECT'
      AND roles = ARRAY['r72_content_adapter']::name[]
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies
    WHERE schemaname = 'app'
      AND tablename = 'company_content_approval_decisions'
      AND policyname = 'company_content_approval_decisions_adapter_catalog_select'
      AND cmd = 'SELECT'
      AND roles = ARRAY['r72_content_adapter']::name[]
  ) THEN
    RAISE EXCEPTION 'Content adapter approval catalogue RLS policies are not exact'
      USING ERRCODE = '42501';
  END IF;
END
$repair_audit$;

RESET ROLE;
