-- Put every committed legacy lead onto the Journey Board without weakening the
-- append-only import boundary. The importer may execute one narrow function;
-- it never receives direct pipeline, stage, opportunity or outcome-table access.

DO $legacy_materializer_role$
DECLARE
  unexpected_member text;
  unexpected_parent text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'r72_legacy_materializer_definer'
  ) THEN
    CREATE ROLE r72_legacy_materializer_definer NOLOGIN NOINHERIT;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles
    WHERE rolname = 'r72_legacy_materializer_definer'
      AND NOT rolcanlogin
      AND NOT rolinherit
      AND NOT rolsuper
      AND NOT rolcreatedb
      AND NOT rolcreaterole
      AND NOT rolreplication
      AND NOT rolbypassrls
  ) THEN
    RAISE EXCEPTION 'Unsafe role attributes: r72_legacy_materializer_definer';
  END IF;

  REVOKE r72_owner, r72_security_definer, r72_onboarding_definer,
    r72_setup_delivery_definer, r72_commerce_definer,
    r72_external_event_definer, r72_growth_projector_definer,
    r72_journey_projector_definer
  FROM r72_legacy_materializer_definer;
  REVOKE r72_legacy_materializer_definer FROM
    r72_web, r72_public, r72_worker, r72_webhook, r72_readonly,
    r72_crm_command, r72_identity_command, r72_provisioning_command,
    r72_setup_delivery_command, r72_setup_reissue_command,
    r72_external_event_command, r72_import_command;

  SELECT member.rolname, parent.rolname
    INTO unexpected_member, unexpected_parent
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
  JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
  WHERE member.rolname = 'r72_legacy_materializer_definer'
  LIMIT 1;
  IF unexpected_member IS NOT NULL THEN
    RAISE EXCEPTION 'Unsafe legacy materializer membership: % can SET ROLE %',
      unexpected_member, unexpected_parent;
  END IF;

  SELECT member.rolname, parent.rolname
    INTO unexpected_member, unexpected_parent
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
  JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
  WHERE parent.rolname = 'r72_legacy_materializer_definer'
    AND member.rolname NOT IN ('r72_owner', current_user)
  LIMIT 1;
  IF unexpected_member IS NOT NULL THEN
    RAISE EXCEPTION 'Unsafe legacy materializer grant: % can SET ROLE %',
      unexpected_member, unexpected_parent;
  END IF;

  GRANT r72_legacy_materializer_definer TO r72_owner;
END
$legacy_materializer_role$;

SET LOCAL ROLE r72_owner;

-- One contact-level receipt makes importer retries deterministic without
-- imposing a product-wide uniqueness rule on legitimate sales opportunities.
CREATE TABLE app_private.legacy_lead_board_materializations (
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL,
  source_provenance_id uuid NOT NULL,
  source_system text NOT NULL,
  source_record_id text NOT NULL,
  opportunity_id uuid,
  pipeline_id uuid,
  stage_id uuid,
  last_disposition text NOT NULL CHECK (
    last_disposition IN ('created', 'existing', 'blocked')
  ),
  failure_reason text CHECK (
    failure_reason IS NULL OR failure_reason IN (
      'contact_inactive', 'default_pipeline_missing', 'first_open_stage_missing'
    )
  ),
  attempt_count integer NOT NULL DEFAULT 1 CHECK (attempt_count > 0),
  first_attempted_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  last_attempted_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  materialized_at timestamptz,
  PRIMARY KEY (workspace_id, contact_id),
  UNIQUE (workspace_id, opportunity_id),
  FOREIGN KEY (workspace_id, contact_id)
    REFERENCES app.contacts (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (
    workspace_id, source_provenance_id, contact_id, source_system, source_record_id
  ) REFERENCES app.contact_import_provenance (
    workspace_id, id, contact_id, source_system, source_record_id
  ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, opportunity_id, contact_id)
    REFERENCES app.opportunities (workspace_id, id, contact_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, pipeline_id)
    REFERENCES app.pipelines (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, pipeline_id, stage_id)
    REFERENCES app.pipeline_stages (workspace_id, pipeline_id, id) ON DELETE RESTRICT,
  CHECK (last_attempted_at >= first_attempted_at),
  CHECK (materialized_at IS NULL OR materialized_at >= first_attempted_at),
  CHECK (
    (
      last_disposition = 'blocked'
      AND opportunity_id IS NULL
      AND failure_reason IS NOT NULL
      AND materialized_at IS NULL
      AND (
        (failure_reason IN ('contact_inactive', 'default_pipeline_missing')
          AND stage_id IS NULL)
        OR (failure_reason = 'first_open_stage_missing'
          AND pipeline_id IS NOT NULL AND stage_id IS NULL)
      )
    ) OR (
      last_disposition IN ('created', 'existing')
      AND opportunity_id IS NOT NULL
      AND pipeline_id IS NOT NULL
      AND stage_id IS NOT NULL
      AND failure_reason IS NULL
      AND materialized_at IS NOT NULL
    )
  )
);

CREATE INDEX legacy_lead_board_materializations_outcome_idx
  ON app_private.legacy_lead_board_materializations
    (workspace_id, last_disposition, failure_reason, last_attempted_at, contact_id);

ALTER TABLE app_private.legacy_lead_board_materializations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.legacy_lead_board_materializations FORCE ROW LEVEL SECURITY;
CREATE POLICY legacy_lead_board_materializations_owner_all
  ON app_private.legacy_lead_board_materializations
  FOR ALL TO r72_owner USING (true) WITH CHECK (true);
CREATE POLICY legacy_lead_board_materializations_definer_all
  ON app_private.legacy_lead_board_materializations
  FOR ALL TO r72_legacy_materializer_definer USING (true) WITH CHECK (true);

INSERT INTO app_private.workspace_table_registry
  (schema_name, table_name, workspace_column)
VALUES ('app_private', 'legacy_lead_board_materializations', 'workspace_id');

-- The definer can observe only the records required to prove an immutable
-- import source and choose/adopt an opportunity in the configured default lane.
REVOKE ALL ON SCHEMA app, app_private FROM r72_legacy_materializer_definer;
REVOKE ALL ON ALL TABLES IN SCHEMA app FROM r72_legacy_materializer_definer;
REVOKE ALL ON ALL TABLES IN SCHEMA app_private FROM r72_legacy_materializer_definer;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app_private
  FROM r72_legacy_materializer_definer;
REVOKE CREATE ON SCHEMA public FROM r72_legacy_materializer_definer;
GRANT USAGE ON SCHEMA app, app_private TO r72_legacy_materializer_definer;
GRANT EXECUTE ON FUNCTION app_private.current_workspace_id(),
  app_private.current_user_id(), app_private.current_actor_kind(),
  app_private.can_manage_workspace(uuid, uuid)
TO r72_legacy_materializer_definer;
GRANT SELECT ON app.workspaces, app.contacts, app.contact_import_provenance,
  app.pipelines, app.pipeline_stages, app.opportunities,
  app_private.legacy_lead_board_materializations
TO r72_legacy_materializer_definer;
GRANT INSERT ON app.opportunities,
  app_private.legacy_lead_board_materializations
TO r72_legacy_materializer_definer;
GRANT UPDATE (
  opportunity_id, pipeline_id, stage_id, last_disposition, failure_reason,
  attempt_count, last_attempted_at, materialized_at
) ON app_private.legacy_lead_board_materializations
TO r72_legacy_materializer_definer;

CREATE POLICY contacts_legacy_materializer_select ON app.contacts
  FOR SELECT TO r72_legacy_materializer_definer USING (true);
CREATE POLICY workspaces_legacy_materializer_select ON app.workspaces
  FOR SELECT TO r72_legacy_materializer_definer USING (true);
CREATE POLICY contact_import_provenance_legacy_materializer_select
  ON app.contact_import_provenance
  FOR SELECT TO r72_legacy_materializer_definer USING (true);
CREATE POLICY pipelines_legacy_materializer_select ON app.pipelines
  FOR SELECT TO r72_legacy_materializer_definer USING (true);
CREATE POLICY pipeline_stages_legacy_materializer_select ON app.pipeline_stages
  FOR SELECT TO r72_legacy_materializer_definer USING (true);
CREATE POLICY opportunities_legacy_materializer_select ON app.opportunities
  FOR SELECT TO r72_legacy_materializer_definer USING (true);
CREATE POLICY opportunities_legacy_materializer_insert ON app.opportunities
  FOR INSERT TO r72_legacy_materializer_definer WITH CHECK (true);

-- Internal core: callable only by the owner during migration/backfill and by
-- the validated public wrapper under the non-login definer identity.
GRANT CREATE ON SCHEMA app_private TO r72_legacy_materializer_definer;
SET LOCAL ROLE r72_legacy_materializer_definer;

CREATE FUNCTION app_private.materialize_legacy_lead_board_opportunity(
  p_workspace_id uuid,
  p_contact_id uuid,
  p_source_system text,
  p_source_record_id text
)
RETURNS TABLE (
  disposition text,
  opportunity_id uuid,
  pipeline_id uuid,
  stage_id uuid,
  failure_reason text
)
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $function$
DECLARE
  trusted_provenance_id uuid;
  contact_name text;
  contact_lifecycle_status text;
  contact_deleted_at timestamptz;
  workspace_currency text;
  chosen_opportunity_id uuid;
  chosen_pipeline_id uuid;
  chosen_stage_id uuid;
  first_open_stage_id uuid;
  attempted_at timestamptz := statement_timestamp();
BEGIN
  IF p_workspace_id IS NULL OR p_contact_id IS NULL
     OR p_source_system IS NULL OR p_source_record_id IS NULL THEN
    RAISE EXCEPTION 'legacy board materialization requires complete source identity'
      USING ERRCODE = '22023';
  END IF;

  SELECT provenance.id, contact.display_name, contact.lifecycle_status,
         contact.deleted_at, workspace.currency
    INTO trusted_provenance_id, contact_name, contact_lifecycle_status,
         contact_deleted_at, workspace_currency
  FROM app.contact_import_provenance AS provenance
  JOIN app.contacts AS contact
    ON contact.workspace_id = provenance.workspace_id
   AND contact.id = provenance.contact_id
  JOIN app.workspaces AS workspace
    ON workspace.id = provenance.workspace_id
  WHERE provenance.workspace_id = p_workspace_id
    AND provenance.contact_id = p_contact_id
    AND provenance.source_system = p_source_system
    AND provenance.source_record_id = p_source_record_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'legacy board materialization requires exact committed provenance'
      USING ERRCODE = '23503';
  END IF;

  -- All importer calls for one contact share a transaction lock, including
  -- different source rows that dedupe onto the same live person.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'legacy-lead-board:' || p_workspace_id::text || ':' || p_contact_id::text,
      7200020
    )
  );

  IF contact_deleted_at IS NOT NULL OR contact_lifecycle_status = 'archived' THEN
    INSERT INTO app_private.legacy_lead_board_materializations (
      workspace_id, contact_id, source_provenance_id, source_system,
      source_record_id, opportunity_id, pipeline_id, stage_id,
      last_disposition, failure_reason, attempt_count,
      first_attempted_at, last_attempted_at, materialized_at
    ) VALUES (
      p_workspace_id, p_contact_id, trusted_provenance_id, p_source_system,
      p_source_record_id, NULL, NULL, NULL,
      'blocked', 'contact_inactive', 1, attempted_at, attempted_at, NULL
    )
    ON CONFLICT (workspace_id, contact_id) DO UPDATE SET
      opportunity_id = NULL,
      pipeline_id = NULL,
      stage_id = NULL,
      last_disposition = 'blocked',
      failure_reason = 'contact_inactive',
      attempt_count = app_private.legacy_lead_board_materializations.attempt_count + 1,
      last_attempted_at = attempted_at,
      materialized_at = NULL;
    RETURN QUERY SELECT
      'blocked'::text, NULL::uuid, NULL::uuid, NULL::uuid,
      'contact_inactive'::text;
    RETURN;
  END IF;

  SELECT pipeline.id
    INTO chosen_pipeline_id
  FROM app.pipelines AS pipeline
  WHERE pipeline.workspace_id = p_workspace_id
    AND pipeline.is_default
    AND pipeline.status = 'active';
  IF NOT FOUND THEN
    INSERT INTO app_private.legacy_lead_board_materializations (
      workspace_id, contact_id, source_provenance_id, source_system,
      source_record_id, opportunity_id, pipeline_id, stage_id,
      last_disposition, failure_reason, attempt_count,
      first_attempted_at, last_attempted_at, materialized_at
    ) VALUES (
      p_workspace_id, p_contact_id, trusted_provenance_id, p_source_system,
      p_source_record_id, NULL, NULL, NULL,
      'blocked', 'default_pipeline_missing', 1, attempted_at, attempted_at, NULL
    )
    ON CONFLICT (workspace_id, contact_id) DO UPDATE SET
      opportunity_id = NULL,
      pipeline_id = NULL,
      stage_id = NULL,
      last_disposition = 'blocked',
      failure_reason = 'default_pipeline_missing',
      attempt_count = app_private.legacy_lead_board_materializations.attempt_count + 1,
      last_attempted_at = attempted_at,
      materialized_at = NULL;
    RETURN QUERY SELECT
      'blocked'::text, NULL::uuid, NULL::uuid, NULL::uuid,
      'default_pipeline_missing'::text;
    RETURN;
  END IF;

  SELECT stage.id
    INTO first_open_stage_id
  FROM app.pipeline_stages AS stage
  WHERE stage.workspace_id = p_workspace_id
    AND stage.pipeline_id = chosen_pipeline_id
    AND stage.stage_type = 'open'
    AND NOT stage.is_terminal
  ORDER BY stage.position, stage.id
  LIMIT 1;
  IF NOT FOUND THEN
    INSERT INTO app_private.legacy_lead_board_materializations (
      workspace_id, contact_id, source_provenance_id, source_system,
      source_record_id, opportunity_id, pipeline_id, stage_id,
      last_disposition, failure_reason, attempt_count,
      first_attempted_at, last_attempted_at, materialized_at
    ) VALUES (
      p_workspace_id, p_contact_id, trusted_provenance_id, p_source_system,
      p_source_record_id, NULL, chosen_pipeline_id, NULL,
      'blocked', 'first_open_stage_missing', 1, attempted_at, attempted_at, NULL
    )
    ON CONFLICT (workspace_id, contact_id) DO UPDATE SET
      opportunity_id = NULL,
      pipeline_id = chosen_pipeline_id,
      stage_id = NULL,
      last_disposition = 'blocked',
      failure_reason = 'first_open_stage_missing',
      attempt_count = app_private.legacy_lead_board_materializations.attempt_count + 1,
      last_attempted_at = attempted_at,
      materialized_at = NULL;
    RETURN QUERY SELECT
      'blocked'::text, NULL::uuid, chosen_pipeline_id, NULL::uuid,
      'first_open_stage_missing'::text;
    RETURN;
  END IF;

  -- Adopt an existing opportunity in the current default pipeline. The import
  -- path does not create a duplicate just to force the person into lane one.
  SELECT opportunity.id, opportunity.stage_id
    INTO chosen_opportunity_id, chosen_stage_id
  FROM app.opportunities AS opportunity
  WHERE opportunity.workspace_id = p_workspace_id
    AND opportunity.contact_id = p_contact_id
    AND opportunity.pipeline_id = chosen_pipeline_id
  ORDER BY
    CASE opportunity.status WHEN 'open' THEN 0 WHEN 'won' THEN 1 ELSE 2 END,
    opportunity.updated_at DESC,
    opportunity.id
  LIMIT 1;

  IF chosen_opportunity_id IS NULL THEN
    chosen_opportunity_id := pg_catalog.gen_random_uuid();
    chosen_stage_id := first_open_stage_id;
    INSERT INTO app.opportunities (
      id, workspace_id, contact_id, pipeline_id, stage_id, name, status,
      value_minor, currency, probability, owner_user_id,
      row_version, created_at, updated_at
    ) VALUES (
      chosen_opportunity_id, p_workspace_id, p_contact_id,
      chosen_pipeline_id, chosen_stage_id, contact_name, 'open',
      0, workspace_currency, 0, NULL, 1, attempted_at, attempted_at
    );

    INSERT INTO app_private.legacy_lead_board_materializations (
      workspace_id, contact_id, source_provenance_id, source_system,
      source_record_id, opportunity_id, pipeline_id, stage_id,
      last_disposition, failure_reason, attempt_count,
      first_attempted_at, last_attempted_at, materialized_at
    ) VALUES (
      p_workspace_id, p_contact_id, trusted_provenance_id, p_source_system,
      p_source_record_id, chosen_opportunity_id, chosen_pipeline_id,
      chosen_stage_id, 'created', NULL, 1, attempted_at, attempted_at, attempted_at
    )
    ON CONFLICT (workspace_id, contact_id) DO UPDATE SET
      opportunity_id = chosen_opportunity_id,
      pipeline_id = chosen_pipeline_id,
      stage_id = chosen_stage_id,
      last_disposition = 'created',
      failure_reason = NULL,
      attempt_count = app_private.legacy_lead_board_materializations.attempt_count + 1,
      last_attempted_at = attempted_at,
      materialized_at = attempted_at;
    RETURN QUERY SELECT
      'created'::text, chosen_opportunity_id, chosen_pipeline_id,
      chosen_stage_id, NULL::text;
    RETURN;
  END IF;

  INSERT INTO app_private.legacy_lead_board_materializations (
    workspace_id, contact_id, source_provenance_id, source_system,
    source_record_id, opportunity_id, pipeline_id, stage_id,
    last_disposition, failure_reason, attempt_count,
    first_attempted_at, last_attempted_at, materialized_at
  ) VALUES (
    p_workspace_id, p_contact_id, trusted_provenance_id, p_source_system,
    p_source_record_id, chosen_opportunity_id, chosen_pipeline_id,
    chosen_stage_id, 'existing', NULL, 1, attempted_at, attempted_at, attempted_at
  )
  ON CONFLICT (workspace_id, contact_id) DO UPDATE SET
    opportunity_id = chosen_opportunity_id,
    pipeline_id = chosen_pipeline_id,
    stage_id = chosen_stage_id,
    last_disposition = 'existing',
    failure_reason = NULL,
    attempt_count = app_private.legacy_lead_board_materializations.attempt_count + 1,
    last_attempted_at = attempted_at,
    materialized_at = attempted_at;
  RETURN QUERY SELECT
    'existing'::text, chosen_opportunity_id, chosen_pipeline_id,
    chosen_stage_id, NULL::text;
END
$function$;

CREATE FUNCTION app_private.ensure_legacy_lead_board_opportunity(
  p_contact_id uuid,
  p_source_system text,
  p_source_record_id text
)
RETURNS TABLE (
  disposition text,
  opportunity_id uuid,
  pipeline_id uuid,
  stage_id uuid,
  failure_reason text
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  trusted_workspace_id uuid := app_private.current_workspace_id();
  trusted_user_id uuid := app_private.current_user_id();
  trusted_actor_kind text := app_private.current_actor_kind();
BEGIN
  IF trusted_actor_kind IS DISTINCT FROM 'user'
     OR trusted_workspace_id IS NULL
     OR trusted_user_id IS NULL
     OR NOT app_private.can_manage_workspace(
       trusted_user_id, trusted_workspace_id
     ) THEN
    RAISE EXCEPTION 'legacy board materialization requires a workspace manager'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT materialized.disposition, materialized.opportunity_id,
         materialized.pipeline_id, materialized.stage_id,
         materialized.failure_reason
  FROM app_private.materialize_legacy_lead_board_opportunity(
    trusted_workspace_id, p_contact_id, p_source_system, p_source_record_id
  ) AS materialized;
END
$function$;

RESET ROLE;
SET LOCAL ROLE r72_owner;

ALTER FUNCTION app_private.materialize_legacy_lead_board_opportunity(
  uuid, uuid, text, text
) OWNER TO r72_legacy_materializer_definer;
ALTER FUNCTION app_private.ensure_legacy_lead_board_opportunity(
  uuid, text, text
) OWNER TO r72_legacy_materializer_definer;
REVOKE CREATE ON SCHEMA app_private FROM r72_legacy_materializer_definer;

REVOKE ALL ON FUNCTION app_private.materialize_legacy_lead_board_opportunity(
  uuid, uuid, text, text
) FROM PUBLIC, r72_import_command, r72_web, r72_public, r72_worker,
  r72_webhook, r72_readonly, r72_crm_command;
REVOKE ALL ON FUNCTION app_private.ensure_legacy_lead_board_opportunity(
  uuid, text, text
) FROM PUBLIC, r72_web, r72_public, r72_worker,
  r72_webhook, r72_readonly, r72_crm_command;
GRANT EXECUTE ON FUNCTION app_private.ensure_legacy_lead_board_opportunity(
  uuid, text, text
) TO r72_import_command;

-- Backfill every already-committed imported contact. The earliest immutable
-- provenance row is retained as the materialization source. Missing topology
-- produces a durable blocked receipt instead of fabricated configuration.
DO $legacy_board_backfill$
DECLARE
  source_row record;
BEGIN
  FOR source_row IN
    SELECT DISTINCT ON (provenance.workspace_id, provenance.contact_id)
      provenance.workspace_id,
      provenance.contact_id,
      provenance.source_system,
      provenance.source_record_id
    FROM app.contact_import_provenance AS provenance
    ORDER BY provenance.workspace_id, provenance.contact_id,
      provenance.original_created_at, provenance.id
  LOOP
    PERFORM *
    FROM app_private.materialize_legacy_lead_board_opportunity(
      source_row.workspace_id,
      source_row.contact_id,
      source_row.source_system,
      source_row.source_record_id
    );
  END LOOP;
END
$legacy_board_backfill$;

-- Fail closed if a future edit accidentally turns the narrow function grant
-- into direct CRM/table access for the import login.
DO $legacy_materializer_security_check$
DECLARE
  wrapper_oid regprocedure :=
    'app_private.ensure_legacy_lead_board_opportunity(uuid,text,text)'::regprocedure;
  core_oid regprocedure :=
    'app_private.materialize_legacy_lead_board_opportunity(uuid,uuid,text,text)'::regprocedure;
BEGIN
  IF NOT pg_catalog.has_function_privilege(
       'r72_import_command', wrapper_oid, 'EXECUTE'
     ) OR pg_catalog.has_function_privilege(
       'r72_import_command', core_oid, 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'Legacy board materializer function capability map is unsafe';
  END IF;

  IF pg_catalog.has_table_privilege(
       'r72_import_command', 'app.opportunities', 'INSERT'
     ) OR pg_catalog.has_table_privilege(
       'r72_import_command',
       'app_private.legacy_lead_board_materializations', 'SELECT'
     ) OR pg_catalog.has_table_privilege(
       'r72_import_command',
       'app_private.legacy_lead_board_materializations', 'INSERT'
     ) THEN
    RAISE EXCEPTION 'Import command unexpectedly has direct board materialization access';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = procedure.proowner
    WHERE procedure.oid = wrapper_oid
      AND owner_role.rolname = 'r72_legacy_materializer_definer'
      AND procedure.prosecdef
      AND procedure.proconfig = ARRAY['search_path=pg_catalog']::text[]
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = procedure.proowner
    WHERE procedure.oid = core_oid
      AND owner_role.rolname = 'r72_legacy_materializer_definer'
      AND NOT procedure.prosecdef
      AND procedure.proconfig = ARRAY['search_path=pg_catalog']::text[]
  ) THEN
    RAISE EXCEPTION 'Legacy board materializer ownership or search path is unsafe';
  END IF;
END
$legacy_materializer_security_check$;
