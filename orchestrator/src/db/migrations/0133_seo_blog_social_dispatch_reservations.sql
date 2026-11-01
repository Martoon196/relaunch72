-- R72-CENTRAL-SOCIAL-IDEMPOTENCY-001. Frozen0131/0132 are unchanged.
-- Registered SEO promotions alone gain permanent exact-slot deduplication and
-- one nonterminal job per canonical content version/network. PP rows have no
-- seo_blog_social_job_caps row and do not enter these predicates.
SET LOCAL ROLE r72_owner;

CREATE TABLE app.seo_blog_social_dispatch_slots (
  workspace_id uuid NOT NULL REFERENCES app.seo_blog_brands(workspace_id) ON DELETE RESTRICT,
  job_id uuid NOT NULL,
  content_version_id uuid NOT NULL,
  network text NOT NULL CHECK (network IN ('instagram', 'linkedin')),
  scheduled_for timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, job_id),
  UNIQUE (workspace_id, content_version_id, network, scheduled_for),
  FOREIGN KEY (workspace_id, job_id) REFERENCES app.property_predator_owned_social_jobs(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, content_version_id) REFERENCES app.company_content_versions(workspace_id, id) ON DELETE RESTRICT
);
ALTER TABLE app.seo_blog_social_dispatch_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.seo_blog_social_dispatch_slots FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app.seo_blog_social_dispatch_slots FROM PUBLIC;
CREATE POLICY seo_blog_social_dispatch_slots_owner_all ON app.seo_blog_social_dispatch_slots FOR ALL TO r72_owner USING (true) WITH CHECK (true);
CREATE POLICY seo_blog_social_dispatch_slots_definer_all ON app.seo_blog_social_dispatch_slots FOR ALL TO r72_owned_social_definer
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.seo_blog_social_dispatch_slots TO r72_owned_social_definer;
INSERT INTO app_private.workspace_table_registry(schema_name, table_name, workspace_column)
VALUES ('app', 'seo_blog_social_dispatch_slots', 'workspace_id');

-- Fail closed if an earlier uncorrected build produced duplicate exact slots.
INSERT INTO app.seo_blog_social_dispatch_slots(workspace_id, job_id, content_version_id, network, scheduled_for)
SELECT job.workspace_id, job.id, job.content_version_id, job.network, job.scheduled_for
FROM app.property_predator_owned_social_jobs AS job
JOIN app.seo_blog_social_job_caps AS caps ON caps.workspace_id = job.workspace_id AND caps.job_id = job.id
JOIN app.company_content_versions AS version ON version.workspace_id = job.workspace_id AND version.id = job.content_version_id
WHERE version.source_system = 'relaunch72.seo-blog';

GRANT CREATE ON SCHEMA app_private TO r72_owned_social_definer;
SET LOCAL ROLE r72_owned_social_definer;
CREATE FUNCTION app_private.seo_blog_check_social_dispatch_unique() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE selected_job app.property_predator_owned_social_jobs%ROWTYPE; selected_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'seo_blog_social_job_caps' THEN selected_id := NEW.job_id;
  ELSE selected_id := NEW.id; END IF;
  SELECT job.* INTO selected_job FROM app.property_predator_owned_social_jobs AS job
  JOIN app.seo_blog_social_job_caps AS caps ON caps.workspace_id = job.workspace_id AND caps.job_id = job.id
  JOIN app.company_content_versions AS version ON version.workspace_id = job.workspace_id AND version.id = job.content_version_id
  WHERE job.workspace_id = NEW.workspace_id AND job.id = selected_id AND version.source_system = 'relaunch72.seo-blog';
  IF NOT FOUND THEN RETURN NEW; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'seo-social-dispatch:' || selected_job.workspace_id::text || ':' || selected_job.content_version_id::text || ':' || selected_job.network, 7200133));
  IF selected_job.state NOT IN ('succeeded', 'failed', 'cancelled') AND EXISTS (
    SELECT 1 FROM app.seo_blog_social_dispatch_slots AS slot
    JOIN app.property_predator_owned_social_jobs AS job ON job.workspace_id = slot.workspace_id AND job.id = slot.job_id
    WHERE slot.workspace_id = selected_job.workspace_id AND slot.content_version_id = selected_job.content_version_id
      AND slot.network = selected_job.network AND slot.job_id <> selected_job.id
      AND job.state NOT IN ('succeeded', 'failed', 'cancelled')
  ) THEN RAISE EXCEPTION 'This exact promotion already has an active dispatch' USING ERRCODE = '55000'; END IF;
  IF TG_TABLE_NAME = 'seo_blog_social_job_caps' THEN
    INSERT INTO app.seo_blog_social_dispatch_slots(workspace_id, job_id, content_version_id, network, scheduled_for)
    VALUES (selected_job.workspace_id, selected_job.id, selected_job.content_version_id, selected_job.network, selected_job.scheduled_for);
  END IF;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION app_private.seo_blog_check_social_dispatch_unique() FROM PUBLIC;

-- Receipt recovery is database-only, and does not revive an expired proof or
-- claim/send a job. The real selected portal session is locked by the facade;
-- this capability additionally verifies target-brand membership and exact tuple.
CREATE FUNCTION app_private.seo_blog_recover_social_dispatch(
  p_workspace_id uuid, p_intent_id uuid, p_content_version_id uuid,
  p_network text, p_scheduled_for timestamptz, p_binding_id uuid,
  p_article_id uuid, p_article_version_id uuid
) RETURNS TABLE(intent_id uuid, job_id uuid, daily_cap integer, monthly_cap integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
BEGIN
  IF session_user <> 'r72_zernio_social_command'
    OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
    OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'user'
    OR coalesce(current_setting('app.user_id', true), '') !~ '^[0-9a-f-]{36}$'
    OR coalesce(current_setting('app.request_id', true), '') = ''
    OR NOT EXISTS (SELECT 1 FROM app.workspace_memberships AS membership WHERE membership.workspace_id = p_workspace_id
      AND membership.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND membership.status = 'active' AND membership.role IN ('owner', 'admin'))
  THEN RAISE EXCEPTION 'SEO social dispatch recovery denied' USING ERRCODE = '42501'; END IF;
  RETURN QUERY
  SELECT job.planning_intent_id, job.id, caps.daily_cap, caps.monthly_cap
  FROM app.property_predator_owned_social_jobs AS job
  JOIN app.seo_blog_social_job_caps AS caps ON caps.workspace_id = job.workspace_id AND caps.job_id = job.id AND caps.binding_id = p_binding_id
  JOIN app.seo_blog_social_bindings AS binding ON binding.workspace_id = caps.workspace_id AND binding.id = caps.binding_id
    AND binding.provider_connection_id = job.provider_connection_id AND binding.zernio_account_id = job.zernio_account_id AND binding.network = job.network
  JOIN app.provider_connections AS connection ON connection.workspace_id = binding.workspace_id AND connection.id = binding.provider_connection_id
    AND connection.provider_id = 'zernio' AND connection.provider_kind = 'social' AND connection.environment = 'live'
  JOIN app.property_predator_zernio_accounts AS account ON account.workspace_id = binding.workspace_id AND account.id = binding.zernio_account_id
    AND account.provider_connection_id = binding.provider_connection_id AND account.network = binding.network
    AND account.provider_profile_id_sha256 = binding.provider_profile_id_sha256 AND account.provider_account_id_sha256 = binding.provider_account_id_sha256
  JOIN app.company_content_versions AS version ON version.workspace_id = job.workspace_id AND version.id = job.content_version_id
    AND version.content_item_id = job.content_item_id AND version.source_system = 'relaunch72.seo-blog'
    AND version.metadata->>'articleId' = p_article_id::text AND version.metadata->>'articleVersionId' = p_article_version_id::text
    AND version.metadata->>'network' = p_network
  JOIN app.company_content_approval_requests AS request ON request.workspace_id = job.workspace_id AND request.id = job.approval_request_id
    AND request.content_version_id = version.id AND request.content_sha256 = version.content_sha256
  JOIN app.company_content_approval_decisions AS decision ON decision.workspace_id = job.workspace_id AND decision.id = job.approval_decision_id
    AND decision.approval_request_id = request.id AND decision.content_sha256 = version.content_sha256 AND decision.decision = 'approved'
  WHERE job.workspace_id = p_workspace_id AND job.planning_intent_id = p_intent_id
    AND job.content_version_id = p_content_version_id AND job.network = p_network AND job.scheduled_for = p_scheduled_for
    AND job.operation_tag = 'seo-blog:' || p_intent_id::text AND job.provider_id = 'zernio'
    ;
  -- This reports immutable history, not permission to send. Current pause,
  -- approval, caps and connected-account controls remain at JIT/atomic begin.
  IF NOT FOUND AND EXISTS (SELECT 1 FROM app.property_predator_owned_social_jobs AS job
      WHERE job.workspace_id = p_workspace_id AND job.planning_intent_id = p_intent_id) THEN
    RAISE EXCEPTION 'The reserved dispatch tuple does not match its committed receipt' USING ERRCODE = '42501';
  END IF;
END $function$;
REVOKE ALL ON FUNCTION app_private.seo_blog_recover_social_dispatch(uuid,uuid,uuid,text,timestamptz,uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.seo_blog_recover_social_dispatch(uuid,uuid,uuid,text,timestamptz,uuid,uuid,uuid) TO r72_zernio_social_command;

SET LOCAL ROLE r72_owner;
CREATE TRIGGER seo_blog_social_dispatch_caps_unique AFTER INSERT ON app.seo_blog_social_job_caps
  FOR EACH ROW EXECUTE FUNCTION app_private.seo_blog_check_social_dispatch_unique();
CREATE TRIGGER seo_blog_social_dispatch_state_unique AFTER UPDATE OF state ON app.property_predator_owned_social_jobs
  FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state)
  EXECUTE FUNCTION app_private.seo_blog_check_social_dispatch_unique();
CREATE TRIGGER seo_blog_social_dispatch_slots_immutable BEFORE UPDATE OR DELETE ON app.seo_blog_social_dispatch_slots
  FOR EACH ROW EXECUTE FUNCTION app_private.seo_blog_social_immutable();
REVOKE CREATE ON SCHEMA app_private FROM r72_owned_social_definer;

DO $audit$
DECLARE login_name text;
BEGIN
  FOREACH login_name IN ARRAY ARRAY['r72_web','r72_content_adapter','r72_content_command','r72_zernio_social_command','r72_owned_social_worker_command'] LOOP
    IF has_table_privilege(login_name, 'app.seo_blog_social_dispatch_slots', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') THEN
      RAISE EXCEPTION 'SEO dispatch slots must remain table-blind: %', login_name;
    END IF;
  END LOOP;
  IF has_function_privilege('public', 'app_private.seo_blog_recover_social_dispatch(uuid,uuid,uuid,text,timestamptz,uuid,uuid,uuid)', 'EXECUTE')
    OR has_function_privilege('r72_owned_social_worker_command', 'app_private.seo_blog_recover_social_dispatch(uuid,uuid,uuid,text,timestamptz,uuid,uuid,uuid)', 'EXECUTE')
    OR NOT has_function_privilege('r72_zernio_social_command', 'app_private.seo_blog_recover_social_dispatch(uuid,uuid,uuid,text,timestamptz,uuid,uuid,uuid)', 'EXECUTE')
  THEN RAISE EXCEPTION 'SEO dispatch receipt capability crossed a role boundary'; END IF;
  IF EXISTS (
    SELECT slot.workspace_id, slot.content_version_id, slot.network
    FROM app.seo_blog_social_dispatch_slots AS slot
    JOIN app.property_predator_owned_social_jobs AS job ON job.workspace_id = slot.workspace_id AND job.id = slot.job_id
    WHERE job.state NOT IN ('succeeded','failed','cancelled')
    GROUP BY slot.workspace_id, slot.content_version_id, slot.network HAVING count(*) > 1
  ) THEN RAISE EXCEPTION 'Existing duplicate active SEO dispatches require review'; END IF;
END $audit$;

-- R72-CENTRAL-SOCIAL-PAUSE-002. Lock just the authoritative parent rows through
-- the publish begin decision. This helper owns no caller-selected mutation and
-- is executable only by the existing social definer, never a login or PUBLIC.
CREATE FUNCTION app_private.seo_blog_lock_dispatch_parent(p_workspace_id uuid, p_job_id uuid)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE selected record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app.seo_blog_social_job_caps AS caps WHERE caps.workspace_id = p_workspace_id AND caps.job_id = p_job_id) THEN
    RETURN true; -- The established PP path stays unchanged.
  END IF;
  IF session_user <> 'r72_owned_social_worker_command'
    OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
    OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'worker'
    OR coalesce(current_setting('app.user_id', true), '') <> ''
  THEN RAISE EXCEPTION 'SEO social publish parent lock denied' USING ERRCODE = '42501'; END IF;
  SELECT brand.settings, article.data AS article_data, version.metadata INTO selected
  FROM app.property_predator_owned_social_jobs AS job
  JOIN app.company_content_versions AS version ON version.workspace_id = job.workspace_id AND version.id = job.content_version_id
    AND version.source_system = 'relaunch72.seo-blog'
  JOIN app.seo_blog_brands AS brand ON brand.workspace_id = job.workspace_id
  JOIN app.seo_blog_articles AS article ON article.workspace_id = brand.workspace_id AND article.id::text = version.metadata->>'articleId'
  WHERE job.workspace_id = p_workspace_id AND job.id = p_job_id
  FOR SHARE OF brand, article;
  IF NOT FOUND THEN RETURN false; END IF;
  RETURN selected.settings->>'pauseAll' IS DISTINCT FROM 'true'
    AND selected.article_data->>'currentVersionId' = selected.metadata->>'articleVersionId'
    AND selected.article_data->>'delivery' = 'published'
    AND selected.article_data->>'publishedVersionId' = selected.metadata->>'articleVersionId'
    AND selected.article_data->>'publishedUrl' = selected.metadata->>'canonicalUrl';
END $function$;
REVOKE ALL ON FUNCTION app_private.seo_blog_lock_dispatch_parent(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.seo_blog_lock_dispatch_parent(uuid,uuid) TO r72_owned_social_definer;

CREATE FUNCTION app_private.seo_blog_lock_jit_programme(p_workspace_id uuid)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE settings jsonb;
BEGIN
  IF session_user <> 'r72_content_command'
    OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
    OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'worker'
    OR coalesce(current_setting('app.user_id', true), '') <> ''
  THEN RAISE EXCEPTION 'SEO social JIT programme lock denied' USING ERRCODE = '42501'; END IF;
  SELECT brand.settings INTO settings FROM app.seo_blog_brands AS brand WHERE brand.workspace_id = p_workspace_id FOR SHARE;
  RETURN FOUND AND settings->>'pauseAll' IS DISTINCT FROM 'true';
END $function$;
REVOKE ALL ON FUNCTION app_private.seo_blog_lock_jit_programme(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.seo_blog_lock_jit_programme(uuid) TO r72_public_social_definer;

-- Preserve issued bodies and privileges, applying only the named insertions.
-- Every anchor is checked so unexpected schema drift stops this migration.
GRANT CREATE ON SCHEMA app_private TO r72_owned_social_definer, r72_public_social_definer;
SET LOCAL ROLE r72_owned_social_definer;
DO $parent_pause$
DECLARE definition text; needle text := E'        AND (\n          NOT p_require_published';
BEGIN
  definition := pg_catalog.pg_get_functiondef('app_private.seo_blog_assert_article_promotion(uuid,uuid,uuid,text,text,boolean)'::regprocedure);
  IF (length(definition) - length(replace(definition, needle, ''))) / length(needle) <> 1 THEN
    RAISE EXCEPTION 'Unexpected132 parent guard body'; END IF;
  EXECUTE replace(definition, needle,
    E'        AND (NOT p_require_published OR brand.settings->>''pauseAll'' IS DISTINCT FROM ''true'')\n' || needle);
END $parent_pause$;
DO $begin_pause$
DECLARE definition text; needle text := E'  UPDATE app.property_predator_owned_social_jobs AS job SET\n    state = ''calling''';
BEGIN
  definition := pg_catalog.pg_get_functiondef('app_private.begin_zernio_calendar_call(uuid,uuid,bigint,bytea,boolean,boolean)'::regprocedure);
  IF (length(definition) - length(replace(definition, needle, ''))) / length(needle) <> 1 THEN
    RAISE EXCEPTION 'Unexpected132 begin-call body'; END IF;
  EXECUTE replace(definition, needle,
    E'  IF selected.lease_attempt_kind = ''publish'' AND NOT app_private.seo_blog_lock_dispatch_parent(p_workspace_id, p_job_id) THEN RETURN false; END IF;\n\n' || needle);
END $begin_pause$;
SET LOCAL ROLE r72_public_social_definer;
DO $jit_pause$
DECLARE definition text; needle text := E'    parent_ok := app_private.seo_blog_assert_article_promotion(';
BEGIN
  definition := pg_catalog.pg_get_functiondef('app_private.seo_blog_attest_due_promotions(uuid)'::regprocedure);
  IF (length(definition) - length(replace(definition, needle, ''))) / length(needle) <> 1 THEN
    RAISE EXCEPTION 'Unexpected132 JIT body'; END IF;
  EXECUTE replace(definition, needle,
    E'    IF NOT app_private.seo_blog_lock_jit_programme(p_workspace_id) THEN CONTINUE; END IF;\n' || needle);
END $jit_pause$;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_owned_social_definer, r72_public_social_definer;
