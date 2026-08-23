-- Relaunch72 first useful CRM loop: contacts, pipeline, opportunities, tasks,
-- trustworthy activity/history facts, idempotent command receipts and an
-- immutable transactional outbox. There are deliberately no provider effects.

-- 0001/0002 are already checksum-issued foundation migrations. Bootstrap the
-- new command identity here so databases already at 0002 can upgrade without
-- rewriting migration history, while fresh installs follow the same path.
DO $crm_command_role$
DECLARE
  unexpected_parent text;
  unexpected_member text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'r72_crm_command'
  ) THEN
    CREATE ROLE r72_crm_command;
  END IF;

  ALTER ROLE r72_crm_command
    LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;

  -- The command identity must never inherit or SET ROLE into an owner. Known
  -- dangerous memberships are stripped before the generic audit below.
  REVOKE r72_owner, r72_security_definer FROM r72_crm_command;
  REVOKE r72_crm_command
    FROM r72_web, r72_public, r72_worker, r72_webhook, r72_readonly;

  SELECT parent.rolname
    INTO unexpected_parent
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
  JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
  WHERE member.rolname = 'r72_crm_command'
  LIMIT 1;

  IF unexpected_parent IS NOT NULL THEN
    RAISE EXCEPTION 'Unsafe CRM command role membership: r72_crm_command can SET ROLE %',
      unexpected_parent;
  END IF;

  -- No runtime identity may assume the command role. The migration identity is
  -- the sole allowed member because isolated integration tests use SET ROLE.
  SELECT member.rolname
    INTO unexpected_member
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
  JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
  WHERE parent.rolname = 'r72_crm_command'
    AND member.rolname <> current_user
  LIMIT 1;

  IF unexpected_member IS NOT NULL THEN
    RAISE EXCEPTION 'Unsafe CRM command role grant: % can SET ROLE r72_crm_command',
      unexpected_member;
  END IF;

  EXECUTE format('GRANT r72_crm_command TO %I', current_user);
END
$crm_command_role$;

SET LOCAL ROLE r72_owner;

-- Fail closed if the role was pre-provisioned with unrelated access, then add
-- only the context/helper surface required by forced-RLS CRM commands.
REVOKE ALL ON SCHEMA app, app_private FROM r72_crm_command;
REVOKE ALL ON ALL TABLES IN SCHEMA app FROM r72_crm_command;
REVOKE ALL ON ALL TABLES IN SCHEMA app_private FROM r72_crm_command;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app_private FROM r72_crm_command;
GRANT USAGE ON SCHEMA app, app_private TO r72_crm_command;
GRANT EXECUTE ON FUNCTION app_private.current_workspace_id() TO r72_crm_command;
GRANT EXECUTE ON FUNCTION app_private.current_user_id() TO r72_crm_command;
GRANT EXECUTE ON FUNCTION app_private.current_actor_kind() TO r72_crm_command;
GRANT EXECUTE ON FUNCTION app_private.current_request_id() TO r72_crm_command;
GRANT EXECUTE ON FUNCTION app_private.has_active_workspace_membership(uuid, uuid)
  TO r72_crm_command;
GRANT EXECUTE ON FUNCTION app_private.can_write_workspace(uuid, uuid)
  TO r72_crm_command;
GRANT EXECUTE ON FUNCTION app_private.can_manage_workspace(uuid, uuid)
  TO r72_crm_command;

CREATE TABLE app.contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 200),
  company_name text CHECK (company_name IS NULL OR length(btrim(company_name)) BETWEEN 1 AND 200),
  lifecycle_status text NOT NULL DEFAULT 'lead'
    CHECK (lifecycle_status IN ('lead', 'customer', 'archived')),
  owner_user_id uuid,
  source text CHECK (source IS NULL OR length(btrim(source)) BETWEEN 1 AND 100),
  custom_fields jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(custom_fields) = 'object'),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deleted_at timestamptz,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, owner_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK (updated_at >= created_at),
  CHECK (deleted_at IS NULL OR deleted_at >= created_at),
  CHECK (deleted_at IS NULL OR lifecycle_status = 'archived')
);

CREATE INDEX contacts_workspace_updated_idx
  ON app.contacts (workspace_id, updated_at DESC, id)
  WHERE deleted_at IS NULL;
CREATE INDEX contacts_workspace_owner_lifecycle_idx
  ON app.contacts (workspace_id, owner_user_id, lifecycle_status, updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE app.contact_points (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('email', 'phone', 'whatsapp', 'social', 'other')),
  label text CHECK (label IS NULL OR length(btrim(label)) BETWEEN 1 AND 50),
  value text NOT NULL CHECK (length(btrim(value)) BETWEEN 1 AND 500),
  normalized_value text NOT NULL
    CHECK (normalized_value = btrim(normalized_value) AND length(normalized_value) BETWEEN 1 AND 500),
  is_primary boolean NOT NULL DEFAULT false,
  is_verified boolean NOT NULL DEFAULT false,
  dedupe_state text NOT NULL DEFAULT 'normal'
    CHECK (dedupe_state IN ('normal', 'shared', 'quarantined')),
  consent_status text NOT NULL DEFAULT 'unknown'
    CHECK (consent_status IN ('unknown', 'opted_in', 'opted_out')),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deleted_at timestamptz,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, contact_id)
    REFERENCES app.contacts (workspace_id, id) ON DELETE CASCADE,
  CHECK (updated_at >= created_at),
  CHECK (deleted_at IS NULL OR deleted_at >= created_at),
  CHECK (deleted_at IS NULL OR NOT is_primary)
);

CREATE UNIQUE INDEX contact_points_normalized_active_uq
  ON app.contact_points (workspace_id, kind, normalized_value)
  WHERE deleted_at IS NULL AND dedupe_state = 'normal';
CREATE UNIQUE INDEX contact_points_one_primary_kind_uq
  ON app.contact_points (workspace_id, contact_id, kind)
  WHERE deleted_at IS NULL AND is_primary;
CREATE INDEX contact_points_contact_idx
  ON app.contact_points (workspace_id, contact_id, kind, id)
  WHERE deleted_at IS NULL;

CREATE TABLE app.pipelines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  slug citext NOT NULL CHECK (
    slug::text = lower(slug::text)
    AND slug::text ~ '^[a-z0-9][a-z0-9-]{0,62}$'
  ),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  is_default boolean NOT NULL DEFAULT false,
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, slug),
  CHECK (updated_at >= created_at),
  CHECK (NOT is_default OR status = 'active')
);

CREATE UNIQUE INDEX pipelines_one_default_uq
  ON app.pipelines (workspace_id)
  WHERE is_default;
CREATE INDEX pipelines_workspace_status_idx
  ON app.pipelines (workspace_id, status, created_at, id);

CREATE TABLE app.pipeline_stages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  pipeline_id uuid NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  slug citext NOT NULL CHECK (
    slug::text = lower(slug::text)
    AND slug::text ~ '^[a-z0-9][a-z0-9-]{0,62}$'
  ),
  position integer NOT NULL CHECK (position > 0),
  stage_type text NOT NULL CHECK (stage_type IN ('open', 'won', 'lost')),
  is_terminal boolean NOT NULL DEFAULT false,
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, pipeline_id, id),
  UNIQUE (workspace_id, pipeline_id, id, stage_type),
  UNIQUE (workspace_id, pipeline_id, slug),
  UNIQUE (workspace_id, pipeline_id, position),
  FOREIGN KEY (workspace_id, pipeline_id)
    REFERENCES app.pipelines (workspace_id, id) ON DELETE CASCADE,
  CHECK (is_terminal = (stage_type IN ('won', 'lost'))),
  CHECK (updated_at >= created_at)
);

CREATE INDEX pipeline_stages_board_order_idx
  ON app.pipeline_stages (workspace_id, pipeline_id, position, id);

CREATE TABLE app.opportunities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL,
  pipeline_id uuid NOT NULL,
  stage_id uuid NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'won', 'lost')),
  value_minor bigint NOT NULL DEFAULT 0 CHECK (value_minor >= 0),
  currency text NOT NULL DEFAULT 'GBP' CHECK (currency ~ '^[A-Z]{3}$'),
  probability smallint NOT NULL DEFAULT 0 CHECK (probability BETWEEN 0 AND 100),
  owner_user_id uuid,
  expected_close_date date,
  closed_at timestamptz,
  loss_reason text CHECK (loss_reason IS NULL OR length(btrim(loss_reason)) BETWEEN 1 AND 1000),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, id, contact_id),
  UNIQUE (workspace_id, pipeline_id, id),
  FOREIGN KEY (workspace_id, contact_id)
    REFERENCES app.contacts (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, pipeline_id)
    REFERENCES app.pipelines (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, pipeline_id, stage_id, status)
    REFERENCES app.pipeline_stages (workspace_id, pipeline_id, id, stage_type) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, owner_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK ((status = 'open') = (closed_at IS NULL)),
  CHECK (status = 'lost' OR loss_reason IS NULL),
  CHECK (updated_at >= created_at),
  CHECK (closed_at IS NULL OR closed_at >= created_at)
);

CREATE INDEX opportunities_board_idx
  ON app.opportunities (workspace_id, pipeline_id, stage_id, updated_at DESC, id);
CREATE INDEX opportunities_contact_idx
  ON app.opportunities (workspace_id, contact_id, status, updated_at DESC, id);
CREATE INDEX opportunities_owner_idx
  ON app.opportunities (workspace_id, owner_user_id, status, expected_close_date, id);

CREATE TABLE app.opportunity_stage_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  pipeline_id uuid NOT NULL,
  opportunity_id uuid NOT NULL,
  from_stage_id uuid,
  to_stage_id uuid NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('user', 'worker', 'webhook', 'system')),
  changed_by_user_id uuid,
  request_id text CHECK (request_id IS NULL OR length(request_id) BETWEEN 1 AND 128),
  correlation_id text CHECK (correlation_id IS NULL OR length(correlation_id) BETWEEN 1 AND 128),
  note text CHECK (note IS NULL OR length(btrim(note)) BETWEEN 1 AND 2000),
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, pipeline_id, opportunity_id)
    REFERENCES app.opportunities (workspace_id, pipeline_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, pipeline_id, from_stage_id)
    REFERENCES app.pipeline_stages (workspace_id, pipeline_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, pipeline_id, to_stage_id)
    REFERENCES app.pipeline_stages (workspace_id, pipeline_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, changed_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK (from_stage_id IS NULL OR from_stage_id <> to_stage_id),
  CHECK ((actor_kind = 'user') = (changed_by_user_id IS NOT NULL))
);

CREATE INDEX opportunity_stage_history_timeline_idx
  ON app.opportunity_stage_history (workspace_id, opportunity_id, changed_at DESC, id);

CREATE TABLE app.tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  contact_id uuid,
  opportunity_id uuid,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 300),
  description text CHECK (description IS NULL OR length(description) BETWEEN 1 AND 10000),
  assignee_user_id uuid,
  priority text NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'cancelled')),
  due_at timestamptz,
  completed_at timestamptz,
  completed_by_user_id uuid,
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, contact_id)
    REFERENCES app.contacts (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, opportunity_id, contact_id)
    REFERENCES app.opportunities (workspace_id, id, contact_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, assignee_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, completed_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
  CHECK ((status = 'completed') = (completed_by_user_id IS NOT NULL)),
  CHECK (opportunity_id IS NULL OR contact_id IS NOT NULL),
  CHECK (updated_at >= created_at),
  CHECK (completed_at IS NULL OR completed_at >= created_at)
);

CREATE INDEX tasks_assignee_queue_idx
  ON app.tasks (workspace_id, assignee_user_id, status, due_at, id);
CREATE INDEX tasks_contact_idx
  ON app.tasks (workspace_id, contact_id, status, due_at, id);
CREATE INDEX tasks_opportunity_idx
  ON app.tasks (workspace_id, opportunity_id, status, due_at, id);

CREATE TABLE app.activities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  contact_id uuid,
  opportunity_id uuid,
  task_id uuid,
  activity_type text NOT NULL
    CHECK (activity_type = btrim(activity_type) AND length(activity_type) BETWEEN 1 AND 100),
  channel text CHECK (
    channel IS NULL OR channel IN ('crm', 'email', 'sms', 'whatsapp', 'social', 'webinar', 'system')
  ),
  actor_kind text NOT NULL CHECK (actor_kind IN ('user', 'worker', 'webhook', 'system')),
  actor_user_id uuid,
  subject text NOT NULL CHECK (length(btrim(subject)) BETWEEN 1 AND 500),
  body text CHECK (body IS NULL OR length(body) BETWEEN 1 AND 20000),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  request_id text CHECK (request_id IS NULL OR length(request_id) BETWEEN 1 AND 128),
  correlation_id text CHECK (correlation_id IS NULL OR length(correlation_id) BETWEEN 1 AND 128),
  causation_id text CHECK (causation_id IS NULL OR length(causation_id) BETWEEN 1 AND 128),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, contact_id)
    REFERENCES app.contacts (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, opportunity_id)
    REFERENCES app.opportunities (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, task_id)
    REFERENCES app.tasks (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, actor_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK (contact_id IS NOT NULL OR opportunity_id IS NOT NULL OR task_id IS NOT NULL),
  CHECK ((actor_kind = 'user') = (actor_user_id IS NOT NULL)),
  CHECK (created_at >= occurred_at)
);

CREATE INDEX activities_contact_timeline_idx
  ON app.activities (workspace_id, contact_id, occurred_at DESC, id)
  WHERE contact_id IS NOT NULL;
CREATE INDEX activities_opportunity_timeline_idx
  ON app.activities (workspace_id, opportunity_id, occurred_at DESC, id)
  WHERE opportunity_id IS NOT NULL;
CREATE INDEX activities_task_timeline_idx
  ON app.activities (workspace_id, task_id, occurred_at DESC, id)
  WHERE task_id IS NOT NULL;

CREATE TABLE app.command_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  command_name text NOT NULL
    CHECK (command_name = btrim(command_name) AND length(command_name) BETWEEN 1 AND 100),
  idempotency_key text NOT NULL
    CHECK (idempotency_key = btrim(idempotency_key) AND length(idempotency_key) BETWEEN 1 AND 200),
  request_id text CHECK (request_id IS NULL OR length(request_id) BETWEEN 1 AND 128),
  actor_user_id uuid NOT NULL,
  payload_hash bytea NOT NULL CHECK (octet_length(payload_hash) = 32),
  result jsonb,
  status text NOT NULL DEFAULT 'started' CHECK (status IN ('started', 'succeeded', 'failed')),
  response_status integer CHECK (response_status IS NULL OR response_status BETWEEN 100 AND 599),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, actor_user_id, command_name, idempotency_key),
  FOREIGN KEY (workspace_id, actor_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
  CHECK ((status = 'started') = (completed_at IS NULL)),
  CHECK (status = 'started' OR response_status IS NOT NULL),
  CHECK (completed_at IS NULL OR completed_at >= created_at)
);

CREATE TABLE app.outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  aggregate_type text NOT NULL
    CHECK (aggregate_type = btrim(aggregate_type) AND length(aggregate_type) BETWEEN 1 AND 100),
  aggregate_id uuid NOT NULL,
  event_type text NOT NULL
    CHECK (event_type = btrim(event_type) AND length(event_type) BETWEEN 1 AND 150),
  event_version integer NOT NULL DEFAULT 1 CHECK (event_version > 0),
  idempotency_key text NOT NULL DEFAULT gen_random_uuid()::text
    CHECK (idempotency_key = btrim(idempotency_key) AND length(idempotency_key) BETWEEN 1 AND 200),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  request_id text CHECK (request_id IS NULL OR length(request_id) BETWEEN 1 AND 128),
  correlation_id text CHECK (correlation_id IS NULL OR length(correlation_id) BETWEEN 1 AND 128),
  causation_id text CHECK (causation_id IS NULL OR length(causation_id) BETWEEN 1 AND 128),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  status text NOT NULL DEFAULT 'pending' CHECK (status = 'pending'),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count = 0),
  published_at timestamptz CHECK (published_at IS NULL),
  last_error text CHECK (last_error IS NULL),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, idempotency_key),
  CHECK (created_at >= occurred_at)
);

CREATE INDEX outbox_events_pending_idx
  ON app.outbox_events (workspace_id, available_at, created_at, id);
CREATE INDEX outbox_events_aggregate_idx
  ON app.outbox_events (workspace_id, aggregate_type, aggregate_id, created_at, id);

-- No workspace-bearing table exists for even one transaction without forced
-- RLS. The owner policy is exclusively for migrations and controlled tests.
DO $rls$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'contacts', 'contact_points', 'pipelines', 'pipeline_stages',
    'opportunities', 'opportunity_stage_history', 'tasks', 'activities',
    'command_receipts', 'outbox_events'
  ]
  LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON app.%I FOR ALL TO r72_owner USING (true) WITH CHECK (true)',
      table_name || '_owner_all',
      table_name
    );
  END LOOP;
END
$rls$;

-- Both the portal's read-only web pool and the isolated command pool may read
-- CRM state, but only for an active member in the selected workspace.
DO $read_policies$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'contacts', 'contact_points', 'pipelines', 'pipeline_stages',
    'opportunities', 'opportunity_stage_history', 'tasks', 'activities'
  ]
  LOOP
    EXECUTE format(
      'CREATE POLICY %I ON app.%I FOR SELECT TO r72_web, r72_crm_command USING (
         workspace_id = app_private.current_workspace_id()
         AND app_private.has_active_workspace_membership(
           app_private.current_user_id(), app_private.current_workspace_id()
         )
       )',
       table_name || '_member_select',
      table_name
    );
  END LOOP;
END
$read_policies$;

-- The portal web pool has no CRM mutation grants. All user-initiated writes go
-- through the isolated command pool; can_write_workspace still keeps viewers
-- read-only and makes membership revocation immediate.
DO $crm_write_policies$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['contacts', 'contact_points', 'opportunities', 'tasks']
  LOOP
    EXECUTE format(
       'CREATE POLICY %I ON app.%I FOR INSERT TO r72_crm_command WITH CHECK (
         workspace_id = app_private.current_workspace_id()
         AND app_private.can_write_workspace(
           app_private.current_user_id(), app_private.current_workspace_id()
         )
       )',
       table_name || '_command_insert',
      table_name
    );
    EXECUTE format(
       'CREATE POLICY %I ON app.%I FOR UPDATE TO r72_crm_command USING (
         workspace_id = app_private.current_workspace_id()
         AND app_private.can_write_workspace(
           app_private.current_user_id(), app_private.current_workspace_id()
         )
       ) WITH CHECK (
         workspace_id = app_private.current_workspace_id()
         AND app_private.can_write_workspace(
           app_private.current_user_id(), app_private.current_workspace_id()
         )
       )',
       table_name || '_command_update',
      table_name
    );
  END LOOP;
END
$crm_write_policies$;

-- Pipeline configuration is deliberately owner/admin only.
DO $pipeline_policies$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['pipelines', 'pipeline_stages']
  LOOP
    EXECUTE format(
       'CREATE POLICY %I ON app.%I FOR INSERT TO r72_crm_command WITH CHECK (
         workspace_id = app_private.current_workspace_id()
         AND app_private.can_manage_workspace(
           app_private.current_user_id(), app_private.current_workspace_id()
         )
       )',
       table_name || '_command_manager_insert',
      table_name
    );
    EXECUTE format(
       'CREATE POLICY %I ON app.%I FOR UPDATE TO r72_crm_command USING (
         workspace_id = app_private.current_workspace_id()
         AND app_private.can_manage_workspace(
           app_private.current_user_id(), app_private.current_workspace_id()
         )
       ) WITH CHECK (
         workspace_id = app_private.current_workspace_id()
         AND app_private.can_manage_workspace(
           app_private.current_user_id(), app_private.current_workspace_id()
         )
       )',
       table_name || '_command_manager_update',
      table_name
    );
    EXECUTE format(
       'CREATE POLICY %I ON app.%I FOR DELETE TO r72_crm_command USING (
         workspace_id = app_private.current_workspace_id()
         AND app_private.can_manage_workspace(
           app_private.current_user_id(), app_private.current_workspace_id()
         )
       )',
       table_name || '_command_manager_delete',
      table_name
    );
  END LOOP;
END
$pipeline_policies$;

-- Sales and marketers may use an active default pipeline but may not manage its
-- configuration. PostgreSQL row locks also consult UPDATE RLS policies, so a
-- direct SELECT ... FOR SHARE would incorrectly make CRM commands manager-only.
-- This narrowly-scoped helper performs the lifecycle check and lock under the
-- non-login security-definer identity, while still requiring the caller's
-- current user/workspace settings to pass can_write_workspace.
GRANT SELECT ON app.pipelines, app.pipeline_stages TO r72_security_definer;
GRANT UPDATE (status) ON app.pipelines TO r72_security_definer;
GRANT UPDATE (name) ON app.pipeline_stages TO r72_security_definer;

CREATE POLICY pipelines_security_lock_select ON app.pipelines
  FOR SELECT TO r72_security_definer USING (true);
CREATE POLICY pipelines_security_lock_update ON app.pipelines
  FOR UPDATE TO r72_security_definer USING (true) WITH CHECK (true);
CREATE POLICY pipeline_stages_security_lock_select ON app.pipeline_stages
  FOR SELECT TO r72_security_definer USING (true);
CREATE POLICY pipeline_stages_security_lock_update ON app.pipeline_stages
  FOR UPDATE TO r72_security_definer USING (true) WITH CHECK (true);

GRANT CREATE ON SCHEMA app_private TO r72_security_definer;
CREATE FUNCTION app_private.lock_active_default_pipeline_stage(
  p_stage_id uuid,
  p_pipeline_id uuid
)
RETURNS TABLE (id uuid, pipeline_id uuid, status text)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT stage.id, stage.pipeline_id, stage.stage_type
  FROM app.pipeline_stages AS stage
  JOIN app.pipelines AS pipeline
    ON pipeline.workspace_id = stage.workspace_id
   AND pipeline.id = stage.pipeline_id
  WHERE stage.id = p_stage_id
    AND stage.pipeline_id = p_pipeline_id
    AND stage.workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND pipeline.status = 'active'
    AND pipeline.is_default
    AND app_private.can_write_workspace(
      nullif(current_setting('app.user_id', true), '')::uuid,
      nullif(current_setting('app.workspace_id', true), '')::uuid
    )
  FOR SHARE OF pipeline, stage
$function$;
ALTER FUNCTION app_private.lock_active_default_pipeline_stage(uuid, uuid)
  OWNER TO r72_security_definer;
REVOKE CREATE ON SCHEMA app_private FROM r72_security_definer;
REVOKE ALL ON FUNCTION app_private.lock_active_default_pipeline_stage(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.lock_active_default_pipeline_stage(uuid, uuid)
  TO r72_crm_command;

-- History, activities and outbox rows are append-only facts. Only the command
-- role can append user-initiated facts; the web and worker roles cannot mutate
-- them directly.
CREATE POLICY opportunity_stage_history_command_insert ON app.opportunity_stage_history
  FOR INSERT TO r72_crm_command WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND app_private.can_write_workspace(app_private.current_user_id(), workspace_id)
    AND actor_kind = 'user'
    AND changed_by_user_id = app_private.current_user_id()
  );
CREATE POLICY activities_command_insert ON app.activities
  FOR INSERT TO r72_crm_command WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND app_private.can_write_workspace(app_private.current_user_id(), workspace_id)
    AND actor_kind = 'user'
    AND actor_user_id = app_private.current_user_id()
  );
CREATE POLICY outbox_events_command_insert ON app.outbox_events
  FOR INSERT TO r72_crm_command WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND app_private.can_write_workspace(app_private.current_user_id(), workspace_id)
    AND status = 'pending'
    AND attempt_count = 0
    AND published_at IS NULL
    AND last_error IS NULL
  );

-- A command receipt is private to its caller as well as its workspace. It can
-- progress from started to one terminal state, but its identity/request hash
-- cannot be rewritten because those columns receive no UPDATE grant below.
CREATE POLICY command_receipts_command_select ON app.command_receipts
  FOR SELECT TO r72_crm_command USING (
    workspace_id = app_private.current_workspace_id()
    AND actor_user_id = app_private.current_user_id()
    AND app_private.has_active_workspace_membership(actor_user_id, workspace_id)
  );
CREATE POLICY command_receipts_command_insert ON app.command_receipts
  FOR INSERT TO r72_crm_command WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND actor_user_id = app_private.current_user_id()
    AND app_private.can_write_workspace(actor_user_id, workspace_id)
    AND status = 'started'
  );
CREATE POLICY command_receipts_command_update ON app.command_receipts
  FOR UPDATE TO r72_crm_command USING (
    workspace_id = app_private.current_workspace_id()
    AND actor_user_id = app_private.current_user_id()
    AND app_private.can_write_workspace(actor_user_id, workspace_id)
    AND status = 'started'
  ) WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND actor_user_id = app_private.current_user_id()
    AND app_private.can_write_workspace(actor_user_id, workspace_id)
    AND status IN ('succeeded', 'failed')
  );

-- Scoped workers can build projections later, but this slice gives them reads
-- only; no provider delivery or CRM mutation path is introduced here.
DO $worker_read_policies$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'contacts', 'contact_points', 'pipelines', 'pipeline_stages',
    'opportunities', 'opportunity_stage_history', 'tasks', 'activities',
    'outbox_events'
  ]
  LOOP
    EXECUTE format(
      'CREATE POLICY %I ON app.%I FOR SELECT TO r72_worker
       USING (workspace_id = app_private.current_workspace_id())',
      table_name || '_worker_select',
      table_name
    );
  END LOOP;
END
$worker_read_policies$;

GRANT SELECT ON app.contacts, app.contact_points, app.pipelines,
  app.pipeline_stages, app.opportunities, app.opportunity_stage_history,
  app.tasks, app.activities TO r72_web;

GRANT SELECT, INSERT ON app.contacts TO r72_crm_command;
GRANT UPDATE (display_name, company_name, lifecycle_status, owner_user_id, source,
  custom_fields, row_version, updated_at, deleted_at)
  ON app.contacts TO r72_crm_command;

GRANT SELECT, INSERT ON app.contact_points TO r72_crm_command;
GRANT UPDATE (kind, label, value, normalized_value, is_primary, is_verified,
  dedupe_state, consent_status, row_version, updated_at, deleted_at)
  ON app.contact_points TO r72_crm_command;

GRANT SELECT, INSERT, DELETE ON app.pipelines TO r72_crm_command;
GRANT UPDATE (name, slug, status, is_default, row_version, updated_at)
  ON app.pipelines TO r72_crm_command;
GRANT SELECT, INSERT, DELETE ON app.pipeline_stages TO r72_crm_command;
GRANT UPDATE (name, slug, position, stage_type, is_terminal, row_version, updated_at)
  ON app.pipeline_stages TO r72_crm_command;

GRANT SELECT, INSERT ON app.opportunities TO r72_crm_command;
GRANT UPDATE (contact_id, pipeline_id, stage_id, name, status, value_minor,
  currency, probability, owner_user_id, expected_close_date, closed_at,
  loss_reason, row_version, updated_at)
  ON app.opportunities TO r72_crm_command;

GRANT SELECT, INSERT ON app.opportunity_stage_history TO r72_crm_command;
GRANT SELECT, INSERT ON app.activities TO r72_crm_command;

GRANT SELECT, INSERT ON app.tasks TO r72_crm_command;
GRANT UPDATE (contact_id, opportunity_id, title, description, assignee_user_id,
  priority, status, due_at, completed_at, completed_by_user_id, row_version,
  updated_at)
  ON app.tasks TO r72_crm_command;

GRANT SELECT, INSERT ON app.command_receipts TO r72_crm_command;
GRANT UPDATE (result, status, response_status, completed_at)
  ON app.command_receipts TO r72_crm_command;
GRANT INSERT ON app.outbox_events TO r72_crm_command;

GRANT SELECT ON app.contacts, app.contact_points, app.pipelines,
  app.pipeline_stages, app.opportunities, app.opportunity_stage_history,
  app.tasks, app.activities, app.outbox_events TO r72_worker;

INSERT INTO app_private.workspace_table_registry (schema_name, table_name, workspace_column)
VALUES
  ('app', 'contacts', 'workspace_id'),
  ('app', 'contact_points', 'workspace_id'),
  ('app', 'pipelines', 'workspace_id'),
  ('app', 'pipeline_stages', 'workspace_id'),
  ('app', 'opportunities', 'workspace_id'),
  ('app', 'opportunity_stage_history', 'workspace_id'),
  ('app', 'tasks', 'workspace_id'),
  ('app', 'activities', 'workspace_id'),
  ('app', 'command_receipts', 'workspace_id'),
  ('app', 'outbox_events', 'workspace_id');

-- Seed one useful pipeline for workspaces that already exist. These statements
-- are safe if a pre-seeded workspace already has a `sales` pipeline or a
-- different default pipeline. Future workspaces are seeded by their creation
-- command rather than a hidden trigger.
INSERT INTO app.pipelines (workspace_id, name, slug, is_default)
SELECT workspace.id, 'Sales', 'sales', false
FROM app.workspaces AS workspace
ON CONFLICT (workspace_id, slug) DO NOTHING;

UPDATE app.pipelines AS pipeline
SET is_default = true,
    row_version = pipeline.row_version + 1,
    updated_at = clock_timestamp()
WHERE pipeline.slug = 'sales'
  AND pipeline.status = 'active'
  AND NOT EXISTS (
    SELECT 1
    FROM app.pipelines AS existing_default
    WHERE existing_default.workspace_id = pipeline.workspace_id
      AND existing_default.is_default
  );

INSERT INTO app.pipeline_stages
  (workspace_id, pipeline_id, name, slug, position, stage_type, is_terminal)
SELECT pipeline.workspace_id,
       pipeline.id,
       seed.name,
       seed.slug,
       seed.position,
       seed.stage_type,
       seed.stage_type IN ('won', 'lost')
FROM app.pipelines AS pipeline
CROSS JOIN (
  VALUES
    ('New lead', 'new-lead', 1, 'open'),
    ('Qualified', 'qualified', 2, 'open'),
    ('Proposal', 'proposal', 3, 'open'),
    ('Won', 'won', 4, 'won'),
    ('Lost', 'lost', 5, 'lost')
) AS seed(name, slug, position, stage_type)
WHERE pipeline.slug = 'sales'
ON CONFLICT DO NOTHING;
