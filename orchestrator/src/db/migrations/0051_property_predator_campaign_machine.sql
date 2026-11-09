-- Durable Property Predator campaign-template and automation-recipe model.
--
-- This migration stores reusable campaign identities, exact immutable
-- versions, prewritten steps, LAPS milestone bindings, human review evidence
-- and stable reporting identities. It deliberately creates no queue, provider
-- command, recipient selector, send function or publication capability.

SET LOCAL ROLE r72_owner;

CREATE TABLE app.campaign_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  template_key citext NOT NULL CHECK (
    template_key::text = lower(template_key::text)
    AND template_key::text ~ '^[a-z][a-z0-9-]{0,62}$'
  ),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 180),
  description text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 1200),
  owner_specialist_id text NOT NULL CHECK (
    owner_specialist_id = btrim(owner_specialist_id)
    AND owner_specialist_id ~ '^[a-z][a-z0-9._/-]{2,199}$'
  ),
  created_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, template_key),
  FOREIGN KEY (workspace_id, created_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id)
    ON DELETE RESTRICT
);

CREATE TABLE app.campaign_template_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  template_id uuid NOT NULL,
  version_no integer NOT NULL CHECK (version_no > 0),
  definition jsonb NOT NULL CHECK (
    jsonb_typeof(definition) = 'object'
    AND octet_length(definition::text) BETWEEN 2 AND 65536
  ),
  definition_sha256 bytea NOT NULL CHECK (octet_length(definition_sha256) = 32),
  brand_brain_source_release_id uuid NOT NULL,
  brand_brain_manifest_sha256 bytea NOT NULL CHECK (
    octet_length(brand_brain_manifest_sha256) = 32
  ),
  canonical_brand_version text NOT NULL CHECK (
    canonical_brand_version = btrim(canonical_brand_version)
    AND length(canonical_brand_version) BETWEEN 1 AND 160
  ),
  specialist_chain jsonb NOT NULL CHECK (
    jsonb_typeof(specialist_chain) = 'array'
    AND jsonb_array_length(specialist_chain) BETWEEN 1 AND 8
    AND octet_length(specialist_chain::text) <= 4096
  ),
  licensed_method_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (
    jsonb_typeof(licensed_method_ids) = 'array'
    AND jsonb_array_length(licensed_method_ids) <= 12
    AND octet_length(licensed_method_ids::text) <= 4096
  ),
  laps_track text NOT NULL CHECK (laps_track IN ('self_serve', 'agency')),
  journey_version_id uuid NOT NULL,
  entry_milestone_id uuid NOT NULL,
  target_milestone_id uuid NOT NULL,
  activation_window_id uuid,
  audience_version_ref text CHECK (
    audience_version_ref IS NULL OR (
      audience_version_ref = btrim(audience_version_ref)
      AND length(audience_version_ref) BETWEEN 1 AND 300
      AND audience_version_ref !~ '[[:space:]@]'
    )
  ),
  offer_version_ref text CHECK (
    offer_version_ref IS NULL OR (
      offer_version_ref = btrim(offer_version_ref)
      AND length(offer_version_ref) BETWEEN 1 AND 300
      AND offer_version_ref !~ '[[:space:]@]'
    )
  ),
  purpose_key text NOT NULL CHECK (
    purpose_key = lower(btrim(purpose_key))
    AND purpose_key ~ '^[a-z][a-z0-9._-]{0,149}$'
  ),
  provider_effects boolean NOT NULL DEFAULT false CHECK (NOT provider_effects),
  created_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, id, journey_version_id),
  UNIQUE (workspace_id, id, definition_sha256),
  UNIQUE (workspace_id, template_id, id),
  UNIQUE (workspace_id, template_id, version_no),
  UNIQUE (workspace_id, template_id, definition_sha256),
  FOREIGN KEY (workspace_id, template_id)
    REFERENCES app.campaign_templates (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, journey_version_id)
    REFERENCES app.conversion_journey_versions (workspace_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, journey_version_id, entry_milestone_id)
    REFERENCES app.conversion_journey_milestones
      (workspace_id, journey_version_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, journey_version_id, target_milestone_id)
    REFERENCES app.conversion_journey_milestones
      (workspace_id, journey_version_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, created_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id)
    ON DELETE RESTRICT,
  CHECK (entry_milestone_id <> target_milestone_id)
);

CREATE TABLE app.campaign_template_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  template_version_id uuid NOT NULL,
  journey_version_id uuid NOT NULL,
  position integer NOT NULL CHECK (position BETWEEN 1 AND 64),
  step_key citext NOT NULL CHECK (
    step_key::text = lower(step_key::text)
    AND step_key::text ~ '^[a-z][a-z0-9-]{0,62}$'
  ),
  step_kind text NOT NULL CHECK (step_kind IN ('email', 'operator_task')),
  channel text NOT NULL CHECK (channel IN ('email', 'internal_task')),
  delay_minutes integer NOT NULL CHECK (delay_minutes BETWEEN 0 AND 525600),
  trigger_event_key text NOT NULL CHECK (
    trigger_event_key = lower(btrim(trigger_event_key))
    AND trigger_event_key ~ '^[a-z][a-z0-9._-]{0,149}$'
  ),
  target_milestone_id uuid NOT NULL,
  owned_specialist_id text NOT NULL CHECK (
    owned_specialist_id = btrim(owned_specialist_id)
    AND owned_specialist_id ~ '^[a-z][a-z0-9._/-]{2,199}$'
  ),
  subject_template text CHECK (
    subject_template IS NULL OR (
      subject_template = btrim(subject_template)
      AND length(subject_template) BETWEEN 1 AND 240
      AND subject_template !~* '[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}'
    )
  ),
  preview_template text CHECK (
    preview_template IS NULL OR (
      preview_template = btrim(preview_template)
      AND length(preview_template) BETWEEN 1 AND 320
      AND preview_template !~* '[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}'
    )
  ),
  body_template text NOT NULL CHECK (
    body_template = btrim(body_template)
    AND length(body_template) BETWEEN 1 AND 12000
    AND body_template !~* '[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}'
  ),
  cta_label text CHECK (
    cta_label IS NULL OR (
      cta_label = btrim(cta_label) AND length(cta_label) BETWEEN 1 AND 160
    )
  ),
  content_sha256 bytea NOT NULL CHECK (
    octet_length(content_sha256) = 32
    AND content_sha256 = public.digest(
      pg_catalog.convert_to(
        coalesce(subject_template, '') || pg_catalog.chr(31)
        || coalesce(preview_template, '') || pg_catalog.chr(31)
        || body_template || pg_catalog.chr(31) || coalesce(cta_label, ''),
        'UTF8'
      ),
      'sha256'
    )
  ),
  requires_human_approval boolean NOT NULL DEFAULT true,
  requires_current_permission boolean NOT NULL DEFAULT true,
  stop_condition_keys jsonb NOT NULL CHECK (
    jsonb_typeof(stop_condition_keys) = 'array'
    AND jsonb_array_length(stop_condition_keys) BETWEEN 1 AND 20
    AND octet_length(stop_condition_keys::text) <= 8192
  ),
  reporting_step_key text NOT NULL CHECK (
    reporting_step_key = lower(btrim(reporting_step_key))
    AND reporting_step_key ~ '^[a-z][a-z0-9._-]{0,149}$'
  ),
  provider_effects boolean NOT NULL DEFAULT false CHECK (NOT provider_effects),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, template_version_id, id),
  UNIQUE (workspace_id, template_version_id, position),
  UNIQUE (workspace_id, template_version_id, step_key),
  UNIQUE (workspace_id, template_version_id, reporting_step_key),
  FOREIGN KEY (workspace_id, template_version_id, journey_version_id)
    REFERENCES app.campaign_template_versions
      (workspace_id, id, journey_version_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, journey_version_id, target_milestone_id)
    REFERENCES app.conversion_journey_milestones
      (workspace_id, journey_version_id, id) ON DELETE RESTRICT,
  CHECK (
    (step_kind = 'email' AND channel = 'email'
      AND subject_template IS NOT NULL AND requires_current_permission)
    OR (step_kind = 'operator_task' AND channel = 'internal_task'
      AND subject_template IS NULL AND preview_template IS NULL
      AND cta_label IS NULL AND NOT requires_current_permission)
  )
);

CREATE TABLE app.campaign_automation_recipe_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  recipe_id uuid NOT NULL,
  template_version_id uuid NOT NULL,
  version_no integer NOT NULL CHECK (version_no > 0),
  entry_event_key text NOT NULL CHECK (
    entry_event_key = lower(btrim(entry_event_key))
    AND entry_event_key ~ '^[a-z][a-z0-9._-]{0,149}$'
  ),
  stop_event_keys jsonb NOT NULL CHECK (
    jsonb_typeof(stop_event_keys) = 'array'
    AND jsonb_array_length(stop_event_keys) BETWEEN 1 AND 24
    AND octet_length(stop_event_keys::text) <= 8192
  ),
  idempotency_scope text NOT NULL CHECK (
    idempotency_scope = lower(btrim(idempotency_scope))
    AND idempotency_scope ~ '^[a-z][a-z0-9._-]{0,199}$'
  ),
  recipe_sha256 bytea NOT NULL CHECK (octet_length(recipe_sha256) = 32),
  provider_effects boolean NOT NULL DEFAULT false CHECK (NOT provider_effects),
  created_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, recipe_id, version_no),
  UNIQUE (workspace_id, recipe_id, recipe_sha256),
  UNIQUE (workspace_id, template_version_id, id),
  FOREIGN KEY (workspace_id, template_version_id)
    REFERENCES app.campaign_template_versions (workspace_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, created_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id)
    ON DELETE RESTRICT
);

CREATE TABLE app.campaign_reporting_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  template_version_id uuid NOT NULL,
  template_version_sha256 bytea NOT NULL CHECK (
    octet_length(template_version_sha256) = 32
  ),
  reporting_key citext NOT NULL CHECK (
    reporting_key::text = lower(reporting_key::text)
    AND reporting_key::text ~ '^[a-z][a-z0-9._-]{0,149}$'
  ),
  attribution_namespace text NOT NULL CHECK (
    attribution_namespace = lower(btrim(attribution_namespace))
    AND attribution_namespace ~ '^[a-z][a-z0-9._-]{0,149}$'
  ),
  metric_schema_sha256 bytea NOT NULL CHECK (
    octet_length(metric_schema_sha256) = 32
  ),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, template_version_id),
  UNIQUE (workspace_id, reporting_key),
  FOREIGN KEY (workspace_id, template_version_id, template_version_sha256)
    REFERENCES app.campaign_template_versions
      (workspace_id, id, definition_sha256) ON DELETE RESTRICT
);

CREATE TABLE app.campaign_template_approval_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  template_version_id uuid NOT NULL,
  template_version_sha256 bytea NOT NULL CHECK (
    octet_length(template_version_sha256) = 32
  ),
  request_no integer NOT NULL CHECK (request_no > 0),
  review_dimensions jsonb NOT NULL CHECK (
    jsonb_typeof(review_dimensions) = 'array'
    AND jsonb_array_length(review_dimensions) BETWEEN 1 AND 12
    AND review_dimensions @> '["brand","truth","laps","consent","channel"]'::jsonb
    AND octet_length(review_dimensions::text) <= 4096
  ),
  requested_by_user_id uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, template_version_id, request_no),
  UNIQUE (workspace_id, template_version_id, id, template_version_sha256),
  FOREIGN KEY (workspace_id, template_version_id, template_version_sha256)
    REFERENCES app.campaign_template_versions
      (workspace_id, id, definition_sha256) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, requested_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id)
    ON DELETE RESTRICT
);

CREATE TABLE app.campaign_template_approval_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  approval_request_id uuid NOT NULL,
  template_version_id uuid NOT NULL,
  template_version_sha256 bytea NOT NULL CHECK (
    octet_length(template_version_sha256) = 32
  ),
  decision text NOT NULL CHECK (decision IN ('approved', 'rejected')),
  note_sha256 bytea CHECK (note_sha256 IS NULL OR octet_length(note_sha256) = 32),
  decided_by_user_id uuid NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, approval_request_id),
  FOREIGN KEY (
    workspace_id, template_version_id, approval_request_id,
    template_version_sha256
  ) REFERENCES app.campaign_template_approval_requests (
    workspace_id, template_version_id, id, template_version_sha256
  ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, template_version_id, template_version_sha256)
    REFERENCES app.campaign_template_versions
      (workspace_id, id, definition_sha256) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, decided_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id)
    ON DELETE RESTRICT
);

CREATE INDEX campaign_template_versions_lookup_idx
  ON app.campaign_template_versions
    (workspace_id, template_id, version_no DESC, id);
CREATE INDEX campaign_template_steps_order_idx
  ON app.campaign_template_steps
    (workspace_id, template_version_id, position, id);
CREATE INDEX campaign_template_approval_requests_latest_idx
  ON app.campaign_template_approval_requests
    (workspace_id, template_version_id, request_no DESC, id);

CREATE FUNCTION app_private.guard_campaign_template_approval_request()
RETURNS trigger
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog
AS $function$
DECLARE
  selected_template_id uuid;
  selected_version_no integer;
  expected_request_no integer;
BEGIN
  SELECT version.template_id, version.version_no
    INTO selected_template_id, selected_version_no
  FROM app.campaign_template_versions AS version
  WHERE version.workspace_id = NEW.workspace_id
    AND version.id = NEW.template_version_id
    AND version.definition_sha256 = NEW.template_version_sha256;
  IF NOT FOUND OR EXISTS (
    SELECT 1 FROM app.campaign_template_versions AS newer
    WHERE newer.workspace_id = NEW.workspace_id
      AND newer.template_id = selected_template_id
      AND newer.version_no > selected_version_no
  ) THEN
    RAISE EXCEPTION 'campaign approval requires the latest immutable template version'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM app.campaign_template_approval_requests AS request
    LEFT JOIN app.campaign_template_approval_decisions AS decision
      ON decision.workspace_id = request.workspace_id
     AND decision.approval_request_id = request.id
    WHERE request.workspace_id = NEW.workspace_id
      AND request.template_version_id = NEW.template_version_id
      AND decision.id IS NULL
  ) THEN
    RAISE EXCEPTION 'campaign template version already has a pending approval request'
      USING ERRCODE = '23505';
  END IF;
  SELECT coalesce(max(request.request_no), 0) + 1
    INTO expected_request_no
  FROM app.campaign_template_approval_requests AS request
  WHERE request.workspace_id = NEW.workspace_id
    AND request.template_version_id = NEW.template_version_id;
  IF NEW.request_no <> expected_request_no THEN
    RAISE EXCEPTION 'campaign approval request number must be the next value'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

CREATE FUNCTION app_private.guard_campaign_template_approval_decision()
RETURNS trigger
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM app.campaign_template_approval_requests AS request
    JOIN app.campaign_template_versions AS version
      ON version.workspace_id = request.workspace_id
     AND version.id = request.template_version_id
     AND version.definition_sha256 = request.template_version_sha256
    WHERE request.workspace_id = NEW.workspace_id
      AND request.id = NEW.approval_request_id
      AND request.template_version_id = NEW.template_version_id
      AND request.template_version_sha256 = NEW.template_version_sha256
      AND request.id = (
        SELECT latest.id
        FROM app.campaign_template_approval_requests AS latest
        WHERE latest.workspace_id = request.workspace_id
          AND latest.template_version_id = request.template_version_id
        ORDER BY latest.request_no DESC, latest.id DESC LIMIT 1
      )
      AND request.requested_at <= NEW.decided_at
      AND NOT EXISTS (
        SELECT 1 FROM app.campaign_template_versions AS newer
        WHERE newer.workspace_id = version.workspace_id
          AND newer.template_id = version.template_id
          AND newer.version_no > version.version_no
      )
  ) THEN
    RAISE EXCEPTION 'campaign approval decision does not bind the latest exact request'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

CREATE FUNCTION app_private.reject_campaign_machine_history_change()
RETURNS trigger
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog
AS $function$
BEGIN
  RAISE EXCEPTION 'campaign versions, steps, recipes, reporting and review evidence are append-only'
    USING ERRCODE = '55000';
END
$function$;

REVOKE ALL ON FUNCTION app_private.guard_campaign_template_approval_request()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.guard_campaign_template_approval_decision()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.reject_campaign_machine_history_change()
  FROM PUBLIC;

CREATE TRIGGER campaign_template_approval_requests_guard_insert
  BEFORE INSERT ON app.campaign_template_approval_requests
  FOR EACH ROW EXECUTE FUNCTION
    app_private.guard_campaign_template_approval_request();
CREATE TRIGGER campaign_template_approval_decisions_guard_insert
  BEFORE INSERT ON app.campaign_template_approval_decisions
  FOR EACH ROW EXECUTE FUNCTION
    app_private.guard_campaign_template_approval_decision();

DO $append_only$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'campaign_template_versions', 'campaign_template_steps',
    'campaign_automation_recipe_versions', 'campaign_reporting_identities',
    'campaign_template_approval_requests',
    'campaign_template_approval_decisions'
  ] LOOP
    EXECUTE pg_catalog.format(
      'CREATE TRIGGER %I_reject_history_change '
      || 'BEFORE UPDATE OR DELETE ON app.%I FOR EACH ROW '
      || 'EXECUTE FUNCTION app_private.reject_campaign_machine_history_change()',
      table_name, table_name
    );
  END LOOP;
END
$append_only$;

ALTER TABLE app.campaign_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.campaign_template_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.campaign_template_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.campaign_automation_recipe_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.campaign_reporting_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.campaign_template_approval_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.campaign_template_approval_decisions ENABLE ROW LEVEL SECURITY;

DO $read_policies$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'campaign_templates', 'campaign_template_versions',
    'campaign_template_steps', 'campaign_automation_recipe_versions',
    'campaign_reporting_identities', 'campaign_template_approval_requests',
    'campaign_template_approval_decisions'
  ] LOOP
    EXECUTE pg_catalog.format(
      'CREATE POLICY %I_web_select ON app.%I FOR SELECT TO r72_web USING ('
      || 'workspace_id = nullif(current_setting(''app.workspace_id'', true), '''')::uuid '
      || 'AND EXISTS (SELECT 1 FROM app.workspace_memberships AS membership '
      || 'WHERE membership.workspace_id = nullif(current_setting(''app.workspace_id'', true), '''')::uuid '
      || 'AND membership.user_id = nullif(current_setting(''app.user_id'', true), '''')::uuid '
      || 'AND membership.status = ''active''))',
      table_name, table_name
    );
  END LOOP;
END
$read_policies$;

REVOKE ALL ON app.campaign_templates, app.campaign_template_versions,
  app.campaign_template_steps, app.campaign_automation_recipe_versions,
  app.campaign_reporting_identities, app.campaign_template_approval_requests,
  app.campaign_template_approval_decisions FROM PUBLIC;
GRANT SELECT ON app.campaign_templates, app.campaign_template_versions,
  app.campaign_template_steps, app.campaign_automation_recipe_versions,
  app.campaign_reporting_identities, app.campaign_template_approval_requests,
  app.campaign_template_approval_decisions TO r72_web;

DO $capability_audit$
DECLARE role_name text;
DECLARE table_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY[
    'r72_provider_operation_definer', 'r72_mailgun_worker_definer',
    'r72_external_event_definer', 'r72_public_social_test_worker'
  ] LOOP
    IF pg_catalog.to_regrole(role_name) IS NOT NULL THEN
      FOREACH table_name IN ARRAY ARRAY[
        'campaign_templates', 'campaign_template_versions',
        'campaign_template_steps', 'campaign_automation_recipe_versions',
        'campaign_reporting_identities', 'campaign_template_approval_requests',
        'campaign_template_approval_decisions'
      ] LOOP
        IF pg_catalog.has_table_privilege(
          role_name, 'app.' || table_name, 'INSERT,UPDATE,DELETE,TRUNCATE'
        ) THEN
          RAISE EXCEPTION 'provider-capable role % can mutate campaign machine table %',
            role_name, table_name;
        END IF;
      END LOOP;
    END IF;
  END LOOP;
END
$capability_audit$;

RESET ROLE;
