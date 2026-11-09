-- Property Predator operational Conversion Inbox foundation.
--
-- This forward-only migration does not send, publish, deploy or call a
-- provider. It adds durable operator evidence around the existing unified
-- app.conversations/messages/tasks model, and projects an already verified
-- Meta WhatsApp inbound event into that same model.

DO $roles$
DECLARE unsafe_parent text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'r72_operational_inbox_definer'
  ) THEN
    CREATE ROLE r72_operational_inbox_definer NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'r72_operational_inbox_definer'
      AND NOT rolcanlogin AND NOT rolinherit AND NOT rolsuper
      AND NOT rolcreatedb AND NOT rolcreaterole
      AND NOT rolreplication AND NOT rolbypassrls
  ) THEN
    RAISE EXCEPTION 'Unsafe operational inbox definer role attributes';
  END IF;
  REVOKE r72_owner, r72_security_definer,
    r72_whatsapp_live_definer, r72_mailgun_webhook_definer
    FROM r72_operational_inbox_definer;
  REVOKE r72_operational_inbox_definer
    FROM r72_web, r72_public, r72_worker, r72_webhook, r72_readonly,
      r72_crm_command, r72_whatsapp_live_webhook_command;
  SELECT parent.rolname INTO unsafe_parent
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
  JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
  WHERE member.rolname = 'r72_operational_inbox_definer'
  LIMIT 1;
  IF unsafe_parent IS NOT NULL THEN
    RAISE EXCEPTION 'Unsafe operational inbox definer parent: %', unsafe_parent;
  END IF;
  GRANT r72_operational_inbox_definer TO r72_owner;
END
$roles$;

SET LOCAL ROLE r72_owner;

REVOKE ALL ON SCHEMA app, app_private
  FROM r72_operational_inbox_definer;
REVOKE ALL ON ALL TABLES IN SCHEMA app
  FROM r72_operational_inbox_definer;
REVOKE ALL ON ALL TABLES IN SCHEMA app_private
  FROM r72_operational_inbox_definer;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app_private
  FROM r72_operational_inbox_definer;
REVOKE CREATE ON SCHEMA public
  FROM r72_operational_inbox_definer, r72_crm_command;
GRANT USAGE ON SCHEMA app, app_private
  TO r72_operational_inbox_definer;

-- Assignment is mutable operational state. This immutable event is therefore
-- necessary to retain who changed it, under which active portal session, and
-- against which optimistic row version.
CREATE TABLE app.property_predator_inbox_assignment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  conversation_id uuid NOT NULL,
  previous_assigned_user_id uuid,
  assigned_user_id uuid,
  expected_row_version bigint NOT NULL CHECK (expected_row_version > 0),
  resulting_row_version bigint NOT NULL CHECK (
    resulting_row_version = expected_row_version + 1
  ),
  actor_user_id uuid NOT NULL,
  command_receipt_id uuid NOT NULL,
  request_id text NOT NULL CHECK (
    request_id = btrim(request_id)
    AND length(request_id) BETWEEN 1 AND 128
    AND request_id !~ '[^[:graph:]]'
  ),
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, command_receipt_id),
  FOREIGN KEY (workspace_id, conversation_id)
    REFERENCES app.conversations (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, previous_assigned_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, assigned_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, actor_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, command_receipt_id)
    REFERENCES app.command_receipts (workspace_id, id) ON DELETE RESTRICT,
  CHECK (previous_assigned_user_id IS DISTINCT FROM assigned_user_id)
);

CREATE TABLE app.property_predator_admin_call_task_origins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  task_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  source_message_id uuid,
  source_channel text NOT NULL CHECK (
    source_channel IN ('email', 'whatsapp', 'instagram', 'facebook')
  ),
  origin_kind text NOT NULL CHECK (
    origin_kind IN ('operator_created', 'signed_inbound')
  ),
  source_provider text NOT NULL CHECK (
    source_provider IN ('operator', 'mailgun_eu', 'meta_whatsapp_cloud')
  ),
  source_receipt_id uuid,
  source_event_identity_sha256 bytea NOT NULL CHECK (
    octet_length(source_event_identity_sha256) = 32
  ),
  actor_kind text NOT NULL CHECK (actor_kind IN ('user', 'webhook')),
  actor_user_id uuid,
  command_receipt_id uuid,
  request_id text NOT NULL CHECK (
    request_id = btrim(request_id)
    AND length(request_id) BETWEEN 1 AND 128
    AND request_id !~ '[^[:graph:]]'
  ),
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, task_id),
  UNIQUE (workspace_id, command_receipt_id),
  FOREIGN KEY (workspace_id, task_id)
    REFERENCES app.tasks (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, conversation_id, contact_id)
    REFERENCES app.conversations (workspace_id, id, contact_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, conversation_id, source_message_id)
    REFERENCES app.messages (workspace_id, conversation_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, actor_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, command_receipt_id)
    REFERENCES app.command_receipts (workspace_id, id) ON DELETE RESTRICT,
  CHECK ((actor_kind = 'user') = (actor_user_id IS NOT NULL)),
  CHECK ((actor_kind = 'user') = (command_receipt_id IS NOT NULL)),
  CHECK ((origin_kind = 'operator_created') = (source_provider = 'operator')),
  CHECK ((origin_kind = 'signed_inbound') = (source_receipt_id IS NOT NULL)),
  CHECK (recorded_at >= occurred_at - interval '5 minutes')
);

CREATE INDEX property_predator_admin_call_origins_conversation_idx
  ON app.property_predator_admin_call_task_origins
    (workspace_id, conversation_id, recorded_at DESC, id);

CREATE TABLE app.property_predator_admin_call_outcomes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  origin_id uuid NOT NULL,
  task_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  outcome text NOT NULL CHECK (outcome IN (
    'connected', 'voicemail', 'no_answer', 'wrong_number',
    'follow_up_requested', 'not_interested', 'qualified', 'converted'
  )),
  summary text NOT NULL CHECK (
    summary = btrim(summary) AND octet_length(summary) BETWEEN 1 AND 8000
  ),
  next_action_kind text CHECK (next_action_kind IS NULL OR next_action_kind IN (
    'call', 'reply_draft', 'consent_review', 'internal_follow_up'
  )),
  next_action_title text CHECK (
    next_action_title IS NULL OR (
      next_action_title = btrim(next_action_title)
      AND length(next_action_title) BETWEEN 1 AND 300
    )
  ),
  next_action_due_at timestamptz,
  next_action_priority text CHECK (
    next_action_priority IS NULL OR next_action_priority IN ('normal', 'high', 'urgent')
  ),
  next_task_id uuid,
  recorded_by_user_id uuid NOT NULL,
  command_receipt_id uuid NOT NULL,
  payload_sha256 bytea NOT NULL CHECK (octet_length(payload_sha256) = 32),
  request_id text NOT NULL CHECK (
    request_id = btrim(request_id)
    AND length(request_id) BETWEEN 1 AND 128
    AND request_id !~ '[^[:graph:]]'
  ),
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, task_id),
  UNIQUE (workspace_id, origin_id),
  UNIQUE (workspace_id, command_receipt_id),
  FOREIGN KEY (workspace_id, origin_id)
    REFERENCES app.property_predator_admin_call_task_origins
      (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, task_id)
    REFERENCES app.tasks (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, conversation_id, contact_id)
    REFERENCES app.conversations (workspace_id, id, contact_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, next_task_id)
    REFERENCES app.tasks (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, recorded_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, command_receipt_id)
    REFERENCES app.command_receipts (workspace_id, id) ON DELETE RESTRICT,
  CHECK (
    (next_action_kind IS NULL AND next_action_title IS NULL
      AND next_action_due_at IS NULL AND next_action_priority IS NULL
      AND next_task_id IS NULL)
    OR (next_action_kind IS NOT NULL AND next_action_title IS NOT NULL
      AND next_action_due_at IS NOT NULL AND next_action_priority IS NOT NULL
      AND next_task_id IS NOT NULL)
  ),
  CHECK (recorded_at >= occurred_at - interval '5 minutes')
);

CREATE INDEX property_predator_admin_call_outcomes_conversation_idx
  ON app.property_predator_admin_call_outcomes
    (workspace_id, conversation_id, occurred_at DESC, id);

-- The 0053 receipt intentionally stores hashes only. This append-only link
-- proves which exact receipt was projected into the existing inbox and Lead
-- 360 rows while keeping the verified body only in immutable message_versions.
CREATE TABLE app.property_predator_whatsapp_live_inbox_projections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  receipt_id uuid NOT NULL UNIQUE
    REFERENCES app.property_predator_whatsapp_live_receipts(id) ON DELETE RESTRICT,
  binding_id uuid NOT NULL,
  inbox_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  contact_point_id uuid NOT NULL,
  inbound_message_id uuid NOT NULL,
  inbound_message_version_id uuid NOT NULL,
  inbound_version_number integer NOT NULL DEFAULT 1 CHECK (inbound_version_number = 1),
  admin_call_task_id uuid NOT NULL,
  admin_call_origin_id uuid NOT NULL,
  sender_identity_sha256 bytea NOT NULL CHECK (
    octet_length(sender_identity_sha256) = 32
  ),
  body_sha256 bytea NOT NULL CHECK (octet_length(body_sha256) = 32),
  payload_sha256 bytea NOT NULL CHECK (octet_length(payload_sha256) = 32),
  signature_sha256 bytea NOT NULL CHECK (octet_length(signature_sha256) = 32),
  event_identity_sha256 bytea NOT NULL CHECK (
    octet_length(event_identity_sha256) = 32
  ),
  occurred_at timestamptz NOT NULL,
  request_id text NOT NULL CHECK (
    request_id = btrim(request_id)
    AND length(request_id) BETWEEN 1 AND 128
    AND request_id !~ '[^[:graph:]]'
  ),
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, inbound_message_id),
  UNIQUE (workspace_id, admin_call_task_id),
  UNIQUE (workspace_id, admin_call_origin_id),
  UNIQUE (workspace_id, binding_id, event_identity_sha256),
  FOREIGN KEY (workspace_id, binding_id)
    REFERENCES app.property_predator_whatsapp_live_bindings
      (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, inbox_id)
    REFERENCES app.inboxes (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, conversation_id, contact_id)
    REFERENCES app.conversations (workspace_id, id, contact_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, contact_point_id, contact_id)
    REFERENCES app.contact_points (workspace_id, id, contact_id) ON DELETE RESTRICT,
  FOREIGN KEY (
    workspace_id, conversation_id, inbound_message_id,
    inbound_message_version_id, inbound_version_number, body_sha256
  ) REFERENCES app.message_versions (
    workspace_id, conversation_id, message_id,
    id, version_number, body_sha256
  ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, admin_call_task_id)
    REFERENCES app.tasks (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, admin_call_origin_id)
    REFERENCES app.property_predator_admin_call_task_origins
      (workspace_id, id) ON DELETE RESTRICT,
  CHECK (recorded_at >= occurred_at - interval '5 minutes')
);

CREATE INDEX property_predator_whatsapp_live_inbox_projection_conversation_idx
  ON app.property_predator_whatsapp_live_inbox_projections
    (workspace_id, conversation_id, occurred_at DESC, id);

CREATE FUNCTION app_private.reject_operational_inbox_evidence_mutation()
RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog
AS $function$
BEGIN
  RAISE EXCEPTION 'Operational inbox evidence is append-only'
    USING ERRCODE = '55000';
  RETURN NULL;
END
$function$;

REVOKE ALL ON FUNCTION app_private.reject_operational_inbox_evidence_mutation()
  FROM PUBLIC;

DO $evidence_triggers$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'property_predator_inbox_assignment_events',
    'property_predator_admin_call_task_origins',
    'property_predator_admin_call_outcomes',
    'property_predator_whatsapp_live_inbox_projections'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON app.%I
       FOR EACH ROW EXECUTE FUNCTION app_private.reject_operational_inbox_evidence_mutation()',
      table_name || '_append_only', table_name
    );
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON app.%I FOR ALL TO r72_owner USING (true) WITH CHECK (true)',
      table_name || '_owner_all', table_name
    );
    EXECUTE format(
      'CREATE POLICY %I ON app.%I FOR SELECT TO r72_web USING (
         workspace_id = nullif(current_setting(''app.workspace_id'', true), '''')::uuid
         AND current_setting(''app.actor_kind'', true) = ''user''
         AND app_private.has_active_workspace_membership(
           nullif(current_setting(''app.user_id'', true), '''')::uuid, workspace_id
         )
       )', table_name || '_web_select', table_name
    );
  END LOOP;
END
$evidence_triggers$;

REVOKE ALL ON app.property_predator_inbox_assignment_events,
  app.property_predator_admin_call_task_origins,
  app.property_predator_admin_call_outcomes,
  app.property_predator_whatsapp_live_inbox_projections
  FROM PUBLIC, r72_crm_command, r72_whatsapp_live_webhook_command;
GRANT SELECT ON app.property_predator_inbox_assignment_events,
  app.property_predator_admin_call_task_origins,
  app.property_predator_admin_call_outcomes,
  app.property_predator_whatsapp_live_inbox_projections
  TO r72_web;

-- Existing 0050 facts are sufficient to create exact origins without
-- rewriting the signed receipt or the task. Future 0050 facts are materialised
-- lazily by the outcome command before the task can be completed.
INSERT INTO app.property_predator_admin_call_task_origins (
  workspace_id, task_id, conversation_id, contact_id, source_message_id,
  source_channel, origin_kind, source_provider, source_receipt_id,
  source_event_identity_sha256, actor_kind, actor_user_id,
  command_receipt_id, request_id, occurred_at, recorded_at
)
SELECT receipt.workspace_id, receipt.admin_call_task_id,
  receipt.conversation_id, receipt.contact_id, receipt.inbound_message_id,
  'email', 'signed_inbound', 'mailgun_eu', receipt.id,
  receipt.event_identity_sha256, 'webhook', NULL, NULL,
  receipt.request_id, receipt.occurred_at, receipt.received_at
FROM app.property_predator_mailgun_inbound_receipts AS receipt
ON CONFLICT (workspace_id, task_id) DO NOTHING;

INSERT INTO app_private.workspace_table_registry
  (schema_name, table_name, workspace_column)
VALUES
  ('app', 'property_predator_inbox_assignment_events', 'workspace_id'),
  ('app', 'property_predator_admin_call_task_origins', 'workspace_id'),
  ('app', 'property_predator_admin_call_outcomes', 'workspace_id'),
  ('app', 'property_predator_whatsapp_live_inbox_projections', 'workspace_id');

-- Exact dependency surface for user commands. The LOGIN keeps no direct
-- access to any 0055 evidence table; only this NOLOGIN function owner can see
-- the rows and every policy remains tenant/user bound under FORCE RLS.
GRANT EXECUTE ON FUNCTION app_private.current_workspace_id(),
  app_private.current_user_id(), app_private.current_actor_kind(),
  app_private.current_request_id(),
  app_private.has_active_workspace_membership(uuid, uuid),
  app_private.can_write_workspace(uuid, uuid),
  app_private.can_manage_workspace(uuid, uuid),
  app_private.lock_active_portal_session(bytea, uuid, uuid)
  TO r72_operational_inbox_definer;

GRANT SELECT ON app.workspace_memberships, app.contacts,
  app.conversations, app.messages, app.command_receipts
  TO r72_operational_inbox_definer;
GRANT INSERT ON app.messages, app.message_versions, app.tasks, app.activities,
  app.command_receipts TO r72_operational_inbox_definer;
GRANT UPDATE (assigned_user_id, unread_count, last_message_at, row_version, updated_at)
  ON app.conversations TO r72_operational_inbox_definer;
GRANT SELECT ON app.tasks TO r72_operational_inbox_definer;
GRANT UPDATE (
  status, completed_at, completed_by_user_id, row_version, updated_at
) ON app.tasks TO r72_operational_inbox_definer;
GRANT UPDATE (result, status, response_status, completed_at)
  ON app.command_receipts TO r72_operational_inbox_definer;
GRANT SELECT, INSERT ON app.property_predator_inbox_assignment_events,
  app.property_predator_admin_call_task_origins,
  app.property_predator_admin_call_outcomes
  TO r72_operational_inbox_definer;

CREATE POLICY operational_inbox_membership_select
  ON app.workspace_memberships FOR SELECT TO r72_operational_inbox_definer
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND current_setting('app.actor_kind', true) = 'user'
  );
CREATE POLICY operational_inbox_contacts_select
  ON app.contacts FOR SELECT TO r72_operational_inbox_definer
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND current_setting('app.actor_kind', true) = 'user'
  );
CREATE POLICY operational_inbox_conversations_select
  ON app.conversations FOR SELECT TO r72_operational_inbox_definer
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND current_setting('app.actor_kind', true) = 'user'
    AND channel IN ('email', 'whatsapp', 'instagram', 'facebook')
  );
CREATE POLICY operational_inbox_conversations_update
  ON app.conversations FOR UPDATE TO r72_operational_inbox_definer
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND current_setting('app.actor_kind', true) = 'user'
    AND channel IN ('email', 'whatsapp', 'instagram', 'facebook')
  ) WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND current_setting('app.actor_kind', true) = 'user'
    AND channel IN ('email', 'whatsapp', 'instagram', 'facebook')
  );
CREATE POLICY operational_inbox_messages_select
  ON app.messages FOR SELECT TO r72_operational_inbox_definer
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND current_setting('app.actor_kind', true) = 'user'
    AND channel IN ('email', 'whatsapp', 'instagram', 'facebook')
  );
CREATE POLICY operational_inbox_internal_note_insert
  ON app.messages FOR INSERT TO r72_operational_inbox_definer
  WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND current_setting('app.actor_kind', true) = 'user'
    AND channel IN ('email', 'whatsapp', 'instagram', 'facebook')
    AND direction = 'internal_note' AND lifecycle = 'received'
    AND source_kind = 'user' AND created_by_actor_kind = 'user'
    AND created_by_user_id = nullif(current_setting('app.user_id', true), '')::uuid
  );
CREATE POLICY operational_inbox_internal_note_version_insert
  ON app.message_versions FOR INSERT TO r72_operational_inbox_definer
  WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND current_setting('app.actor_kind', true) = 'user'
    AND channel IN ('email', 'whatsapp', 'instagram', 'facebook')
    AND version_number = 1 AND created_by_actor_kind = 'user'
    AND created_by_user_id = nullif(current_setting('app.user_id', true), '')::uuid
    AND created_request_id = current_setting('app.request_id', true)
    AND source_content_version_ref IS NULL
    AND source_content_sha256 IS NULL
    AND source_content_approval_ref IS NULL
  );
CREATE POLICY operational_inbox_tasks_select
  ON app.tasks FOR SELECT TO r72_operational_inbox_definer
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND current_setting('app.actor_kind', true) = 'user'
  );
CREATE POLICY operational_inbox_tasks_insert
  ON app.tasks FOR INSERT TO r72_operational_inbox_definer
  WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND current_setting('app.actor_kind', true) = 'user'
    AND status = 'open'
  );
CREATE POLICY operational_inbox_tasks_update
  ON app.tasks FOR UPDATE TO r72_operational_inbox_definer
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND current_setting('app.actor_kind', true) = 'user'
    AND status = 'open'
  ) WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND current_setting('app.actor_kind', true) = 'user'
    AND status = 'completed'
    AND completed_by_user_id = nullif(current_setting('app.user_id', true), '')::uuid
  );
CREATE POLICY operational_inbox_activities_insert
  ON app.activities FOR INSERT TO r72_operational_inbox_definer
  WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND current_setting('app.actor_kind', true) = 'user'
    AND actor_kind = 'user'
    AND actor_user_id = nullif(current_setting('app.user_id', true), '')::uuid
    AND activity_type IN (
      'inbox.admin_call.created', 'inbox.admin_call.outcome_recorded'
    )
  );
CREATE POLICY operational_inbox_command_receipts_select
  ON app.command_receipts FOR SELECT TO r72_operational_inbox_definer
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND actor_user_id = nullif(current_setting('app.user_id', true), '')::uuid
    AND command_name LIKE 'operational_inbox.%'
  );
CREATE POLICY operational_inbox_command_receipts_insert
  ON app.command_receipts FOR INSERT TO r72_operational_inbox_definer
  WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND actor_user_id = nullif(current_setting('app.user_id', true), '')::uuid
    AND command_name LIKE 'operational_inbox.%'
    AND request_id = current_setting('app.request_id', true)
    AND status = 'started' AND result IS NULL
  );
CREATE POLICY operational_inbox_command_receipts_update
  ON app.command_receipts FOR UPDATE TO r72_operational_inbox_definer
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND actor_user_id = nullif(current_setting('app.user_id', true), '')::uuid
    AND command_name LIKE 'operational_inbox.%'
    AND status = 'started'
  ) WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND actor_user_id = nullif(current_setting('app.user_id', true), '')::uuid
    AND command_name LIKE 'operational_inbox.%'
    AND status = 'succeeded' AND result IS NOT NULL AND response_status = 200
  );

CREATE POLICY operational_inbox_assignment_definer_select
  ON app.property_predator_inbox_assignment_events FOR SELECT
  TO r72_operational_inbox_definer
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND current_setting('app.actor_kind', true) = 'user'
  );
CREATE POLICY operational_inbox_assignment_definer_insert
  ON app.property_predator_inbox_assignment_events FOR INSERT
  TO r72_operational_inbox_definer
  WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND actor_user_id = nullif(current_setting('app.user_id', true), '')::uuid
    AND request_id = current_setting('app.request_id', true)
  );
CREATE POLICY operational_inbox_origin_definer_select
  ON app.property_predator_admin_call_task_origins FOR SELECT
  TO r72_operational_inbox_definer
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND current_setting('app.actor_kind', true) = 'user'
  );
CREATE POLICY operational_inbox_origin_definer_insert
  ON app.property_predator_admin_call_task_origins FOR INSERT
  TO r72_operational_inbox_definer
  WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND current_setting('app.actor_kind', true) = 'user'
    AND (
      (actor_kind = 'user'
        AND actor_user_id = nullif(current_setting('app.user_id', true), '')::uuid
        AND request_id = current_setting('app.request_id', true))
      OR (actor_kind = 'webhook' AND actor_user_id IS NULL)
    )
  );
CREATE POLICY operational_inbox_outcome_definer_select
  ON app.property_predator_admin_call_outcomes FOR SELECT
  TO r72_operational_inbox_definer
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND current_setting('app.actor_kind', true) = 'user'
  );
CREATE POLICY operational_inbox_outcome_definer_insert
  ON app.property_predator_admin_call_outcomes FOR INSERT
  TO r72_operational_inbox_definer
  WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND recorded_by_user_id = nullif(current_setting('app.user_id', true), '')::uuid
    AND request_id = current_setting('app.request_id', true)
  );

GRANT SELECT ON app.property_predator_mailgun_inbound_receipts
  TO r72_operational_inbox_definer;
CREATE POLICY property_predator_mailgun_inbound_operational_select
  ON app.property_predator_mailgun_inbound_receipts FOR SELECT
  TO r72_operational_inbox_definer
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND current_setting('app.actor_kind', true) = 'user'
  );

GRANT CREATE ON SCHEMA app_private TO r72_operational_inbox_definer;
SET LOCAL ROLE r72_operational_inbox_definer;

CREATE FUNCTION app_private.assert_operational_inbox_user_context(
  p_workspace_id uuid,
  p_session_token_sha256 bytea
)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog
AS $function$
DECLARE
  selected_user_id uuid;
  selected_request_id text := current_setting('app.request_id', true);
BEGIN
  IF session_user <> 'r72_crm_command'
     OR p_workspace_id IS NULL
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'user'
     OR coalesce(current_setting('app.user_id', true), '')
       !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR selected_request_id IS NULL
     OR selected_request_id <> btrim(selected_request_id)
     OR length(selected_request_id) NOT BETWEEN 1 AND 128
     OR selected_request_id ~ '[^[:graph:]]'
     OR p_session_token_sha256 IS NULL
     OR octet_length(p_session_token_sha256) <> 32 THEN
    RAISE EXCEPTION 'Operational inbox user context denied'
      USING ERRCODE = '42501';
  END IF;
  selected_user_id := current_setting('app.user_id', true)::uuid;
  IF NOT app_private.lock_active_portal_session(
       p_session_token_sha256, selected_user_id, p_workspace_id
     )
     OR NOT app_private.can_write_workspace(selected_user_id, p_workspace_id) THEN
    RAISE EXCEPTION 'Operational inbox active portal session denied'
      USING ERRCODE = '42501';
  END IF;
  RETURN selected_user_id;
END
$function$;

CREATE FUNCTION app_private.begin_operational_inbox_command(
  p_workspace_id uuid,
  p_actor_user_id uuid,
  p_command_name text,
  p_command_key text,
  p_payload_sha256 bytea
)
RETURNS TABLE (command_receipt_id uuid, replay_result jsonb)
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog
AS $function$
DECLARE
  existing app.command_receipts%ROWTYPE;
  created_id uuid := gen_random_uuid();
BEGIN
  IF p_workspace_id IS NULL OR p_actor_user_id IS NULL
     OR p_command_name NOT IN (
       'operational_inbox.assign_conversation',
       'operational_inbox.append_internal_note',
       'operational_inbox.create_admin_call_task',
       'operational_inbox.record_admin_call_outcome'
     )
     OR p_command_key IS NULL
     OR p_command_key !~ '^[A-Za-z0-9_-]{16,128}$'
     OR p_payload_sha256 IS NULL
     OR octet_length(p_payload_sha256) <> 32 THEN
    RAISE EXCEPTION 'Operational inbox command evidence is invalid'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'operational-inbox:' || p_workspace_id::text || ':'
      || p_actor_user_id::text || ':' || p_command_name || ':' || p_command_key,
    7200055
  ));

  SELECT receipt.* INTO existing
  FROM app.command_receipts AS receipt
  WHERE receipt.workspace_id = p_workspace_id
    AND receipt.actor_user_id = p_actor_user_id
    AND receipt.command_name = p_command_name
    AND receipt.idempotency_key = p_command_key;
  IF FOUND THEN
    IF existing.payload_hash IS DISTINCT FROM p_payload_sha256 THEN
      RAISE EXCEPTION 'Operational inbox idempotency conflict'
        USING ERRCODE = '22000';
    END IF;
    IF existing.status = 'succeeded' AND existing.result IS NOT NULL THEN
      RETURN QUERY SELECT existing.id, existing.result;
      RETURN;
    END IF;
    RAISE EXCEPTION 'Operational inbox command is already in progress'
      USING ERRCODE = '55000';
  END IF;

  INSERT INTO app.command_receipts (
    id, workspace_id, command_name, idempotency_key, request_id,
    actor_user_id, payload_hash, result, status
  ) VALUES (
    created_id, p_workspace_id, p_command_name, p_command_key,
    current_setting('app.request_id', true), p_actor_user_id,
    p_payload_sha256, NULL, 'started'
  );
  RETURN QUERY SELECT created_id, NULL::jsonb;
END
$function$;

CREATE FUNCTION app_private.finish_operational_inbox_command(
  p_workspace_id uuid,
  p_actor_user_id uuid,
  p_command_receipt_id uuid,
  p_result jsonb
)
RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog
AS $function$
DECLARE changed integer;
BEGIN
  IF p_result IS NULL OR pg_catalog.jsonb_typeof(p_result) <> 'object' THEN
    RAISE EXCEPTION 'Operational inbox result evidence is invalid'
      USING ERRCODE = '22023';
  END IF;
  UPDATE app.command_receipts AS receipt
  SET result = p_result, status = 'succeeded', response_status = 200,
      completed_at = statement_timestamp()
  WHERE receipt.workspace_id = p_workspace_id
    AND receipt.id = p_command_receipt_id
    AND receipt.actor_user_id = p_actor_user_id
    AND receipt.status = 'started';
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN
    RAISE EXCEPTION 'Operational inbox command receipt was lost'
      USING ERRCODE = '40001';
  END IF;
END
$function$;

CREATE FUNCTION app_private.assign_operational_inbox_conversation(
  p_workspace_id uuid,
  p_session_token_sha256 bytea,
  p_conversation_id uuid,
  p_assigned_user_id uuid,
  p_expected_row_version bigint,
  p_command_key text
)
RETURNS TABLE (
  disposition text,
  conversation_id uuid,
  assigned_user_id uuid,
  row_version bigint
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  selected_user_id uuid;
  selected_conversation app.conversations%ROWTYPE;
  selected_receipt_id uuid;
  selected_replay jsonb;
  selected_payload bytea;
  selected_is_manager boolean;
  selected_row_version bigint;
BEGIN
  selected_user_id := app_private.assert_operational_inbox_user_context(
    p_workspace_id, p_session_token_sha256
  );
  IF p_conversation_id IS NULL OR p_expected_row_version IS NULL
     OR p_expected_row_version < 1 THEN
    RAISE EXCEPTION 'Operational inbox assignment input is invalid'
      USING ERRCODE = '22023';
  END IF;
  selected_payload := public.digest(pg_catalog.convert_to(
    'assign/v1' || pg_catalog.chr(31) || p_workspace_id::text
      || pg_catalog.chr(31) || p_conversation_id::text
      || pg_catalog.chr(31) || coalesce(p_assigned_user_id::text, 'unassigned')
      || pg_catalog.chr(31) || p_expected_row_version::text,
    'UTF8'
  ), 'sha256');
  SELECT command.command_receipt_id, command.replay_result
    INTO STRICT selected_receipt_id, selected_replay
  FROM app_private.begin_operational_inbox_command(
    p_workspace_id, selected_user_id,
    'operational_inbox.assign_conversation', p_command_key, selected_payload
  ) AS command;
  IF selected_replay IS NOT NULL THEN
    RETURN QUERY SELECT 'replayed',
      (selected_replay->>'conversationId')::uuid,
      nullif(selected_replay->>'assignedUserId', '')::uuid,
      (selected_replay->>'rowVersion')::bigint;
    RETURN;
  END IF;

  SELECT conversation.* INTO selected_conversation
  FROM app.conversations AS conversation
  WHERE conversation.workspace_id = p_workspace_id
    AND conversation.id = p_conversation_id
    AND conversation.channel IN ('email', 'whatsapp', 'instagram', 'facebook')
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Operational inbox conversation not found'
      USING ERRCODE = '23503';
  END IF;
  IF selected_conversation.row_version <> p_expected_row_version THEN
    RAISE EXCEPTION 'Operational inbox conversation version conflict'
      USING ERRCODE = '40001';
  END IF;
  IF selected_conversation.assigned_user_id IS NOT DISTINCT FROM p_assigned_user_id THEN
    RAISE EXCEPTION 'Operational inbox assignment is unchanged'
      USING ERRCODE = '22023';
  END IF;
  SELECT membership.role IN ('owner', 'admin') INTO selected_is_manager
  FROM app.workspace_memberships AS membership
  WHERE membership.workspace_id = p_workspace_id
    AND membership.user_id = selected_user_id
    AND membership.status = 'active';
  selected_is_manager := coalesce(selected_is_manager, false);
  IF p_assigned_user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM app.workspace_memberships AS membership
    WHERE membership.workspace_id = p_workspace_id
      AND membership.user_id = p_assigned_user_id
      AND membership.status = 'active'
      AND membership.role <> 'viewer'
  ) THEN
    RAISE EXCEPTION 'Operational inbox assignee is unavailable'
      USING ERRCODE = '23503';
  END IF;
  IF (p_assigned_user_id IS NOT NULL
      AND p_assigned_user_id <> selected_user_id AND NOT selected_is_manager)
     OR (p_assigned_user_id IS NULL
      AND selected_conversation.assigned_user_id IS DISTINCT FROM selected_user_id
      AND NOT selected_is_manager) THEN
    RAISE EXCEPTION 'Operational inbox assignment permission denied'
      USING ERRCODE = '42501';
  END IF;

  UPDATE app.conversations AS conversation
  SET assigned_user_id = p_assigned_user_id,
      row_version = conversation.row_version + 1
  WHERE conversation.workspace_id = p_workspace_id
    AND conversation.id = p_conversation_id
    AND conversation.row_version = p_expected_row_version
  RETURNING conversation.row_version INTO selected_row_version;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Operational inbox conversation version conflict'
      USING ERRCODE = '40001';
  END IF;

  INSERT INTO app.property_predator_inbox_assignment_events (
    workspace_id, conversation_id, previous_assigned_user_id,
    assigned_user_id, expected_row_version, resulting_row_version,
    actor_user_id, command_receipt_id, request_id
  ) VALUES (
    p_workspace_id, p_conversation_id,
    selected_conversation.assigned_user_id, p_assigned_user_id,
    p_expected_row_version, selected_row_version,
    selected_user_id, selected_receipt_id,
    current_setting('app.request_id', true)
  );

  PERFORM app_private.finish_operational_inbox_command(
    p_workspace_id, selected_user_id, selected_receipt_id,
    pg_catalog.jsonb_build_object(
      'conversationId', p_conversation_id,
      'assignedUserId', coalesce(p_assigned_user_id::text, ''),
      'rowVersion', selected_row_version
    )
  );
  RETURN QUERY SELECT 'applied', p_conversation_id,
    p_assigned_user_id, selected_row_version;
END
$function$;

CREATE FUNCTION app_private.append_operational_inbox_internal_note(
  p_workspace_id uuid,
  p_session_token_sha256 bytea,
  p_conversation_id uuid,
  p_body_text text,
  p_command_key text
)
RETURNS TABLE (
  disposition text,
  conversation_id uuid,
  message_id uuid,
  message_version_id uuid,
  version_number integer,
  body_sha256 bytea,
  conversation_row_version bigint
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  selected_user_id uuid;
  selected_conversation app.conversations%ROWTYPE;
  selected_receipt_id uuid;
  selected_replay jsonb;
  selected_body_sha bytea;
  selected_payload bytea;
  created_message_id uuid := gen_random_uuid();
  created_version_id uuid := gen_random_uuid();
  selected_occurred_at timestamptz := statement_timestamp();
  selected_row_version bigint;
BEGIN
  selected_user_id := app_private.assert_operational_inbox_user_context(
    p_workspace_id, p_session_token_sha256
  );
  IF p_conversation_id IS NULL OR p_body_text IS NULL
     OR btrim(p_body_text) = ''
     OR octet_length(p_body_text) NOT BETWEEN 1 AND 20000 THEN
    RAISE EXCEPTION 'Operational inbox internal note is invalid'
      USING ERRCODE = '22023';
  END IF;
  selected_body_sha := public.digest(p_body_text, 'sha256');
  selected_payload := public.digest(pg_catalog.convert_to(
    'internal-note/v1' || pg_catalog.chr(31) || p_workspace_id::text
      || pg_catalog.chr(31) || p_conversation_id::text
      || pg_catalog.chr(31) || pg_catalog.encode(selected_body_sha, 'hex'),
    'UTF8'
  ), 'sha256');
  SELECT command.command_receipt_id, command.replay_result
    INTO STRICT selected_receipt_id, selected_replay
  FROM app_private.begin_operational_inbox_command(
    p_workspace_id, selected_user_id,
    'operational_inbox.append_internal_note', p_command_key, selected_payload
  ) AS command;
  IF selected_replay IS NOT NULL THEN
    RETURN QUERY SELECT 'replayed',
      (selected_replay->>'conversationId')::uuid,
      (selected_replay->>'messageId')::uuid,
      (selected_replay->>'messageVersionId')::uuid,
      (selected_replay->>'versionNumber')::integer,
      pg_catalog.decode(selected_replay->>'bodySha256', 'hex'),
      (selected_replay->>'conversationRowVersion')::bigint;
    RETURN;
  END IF;

  SELECT conversation.* INTO selected_conversation
  FROM app.conversations AS conversation
  WHERE conversation.workspace_id = p_workspace_id
    AND conversation.id = p_conversation_id
    AND conversation.channel IN ('email', 'whatsapp', 'instagram', 'facebook')
    AND conversation.state IN ('open', 'snoozed')
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Operational inbox conversation not found'
      USING ERRCODE = '23503';
  END IF;

  SET CONSTRAINTS ALL DEFERRED;
  INSERT INTO app.messages (
    id, workspace_id, conversation_id, contact_id, contact_point_id,
    channel, environment, direction, lifecycle, source_kind,
    current_version_id, current_version_number, current_body_sha256,
    created_by_actor_kind, created_by_user_id, occurred_at
  ) VALUES (
    created_message_id, p_workspace_id, p_conversation_id,
    selected_conversation.contact_id, NULL,
    selected_conversation.channel, selected_conversation.environment,
    'internal_note', 'received', 'user',
    created_version_id, 1, selected_body_sha,
    'user', selected_user_id, selected_occurred_at
  );
  INSERT INTO app.message_versions (
    id, workspace_id, conversation_id, message_id,
    channel, environment, version_number, body_format, body_text,
    created_by_actor_kind, created_by_user_id, created_request_id
  ) VALUES (
    created_version_id, p_workspace_id, p_conversation_id, created_message_id,
    selected_conversation.channel, selected_conversation.environment,
    1, 'plain_text', p_body_text,
    'user', selected_user_id, current_setting('app.request_id', true)
  );
  UPDATE app.conversations AS conversation
  SET last_message_at = greatest(
        coalesce(conversation.last_message_at, selected_occurred_at),
        selected_occurred_at
      ),
      row_version = conversation.row_version + 1
  WHERE conversation.workspace_id = p_workspace_id
    AND conversation.id = p_conversation_id
  RETURNING conversation.row_version INTO selected_row_version;

  PERFORM app_private.finish_operational_inbox_command(
    p_workspace_id, selected_user_id, selected_receipt_id,
    pg_catalog.jsonb_build_object(
      'conversationId', p_conversation_id, 'messageId', created_message_id,
      'messageVersionId', created_version_id, 'versionNumber', 1,
      'bodySha256', pg_catalog.encode(selected_body_sha, 'hex'),
      'conversationRowVersion', selected_row_version
    )
  );
  RETURN QUERY SELECT 'applied', p_conversation_id,
    created_message_id, created_version_id, 1,
    selected_body_sha, selected_row_version;
END
$function$;

CREATE FUNCTION app_private.create_operational_inbox_admin_call_task(
  p_workspace_id uuid,
  p_session_token_sha256 bytea,
  p_conversation_id uuid,
  p_priority text,
  p_due_at timestamptz,
  p_note text,
  p_command_key text
)
RETURNS TABLE (
  disposition text,
  conversation_id uuid,
  contact_id uuid,
  task_id uuid,
  task_row_version bigint
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  selected_user_id uuid;
  selected_conversation app.conversations%ROWTYPE;
  selected_assignee_user_id uuid;
  selected_receipt_id uuid;
  selected_replay jsonb;
  selected_payload bytea;
  created_task_id uuid := gen_random_uuid();
  created_origin_id uuid := gen_random_uuid();
  selected_channel text;
BEGIN
  selected_user_id := app_private.assert_operational_inbox_user_context(
    p_workspace_id, p_session_token_sha256
  );
  IF p_conversation_id IS NULL OR p_priority NOT IN ('high', 'urgent')
     OR p_due_at IS NULL
     OR p_due_at < statement_timestamp() - interval '5 minutes'
     OR p_due_at > statement_timestamp() + interval '90 days'
     OR (p_note IS NOT NULL AND (
       p_note <> btrim(p_note) OR octet_length(p_note) NOT BETWEEN 1 AND 4000
     )) THEN
    RAISE EXCEPTION 'Operational inbox admin call input is invalid'
      USING ERRCODE = '22023';
  END IF;
  selected_payload := public.digest(pg_catalog.convert_to(
    'admin-call/v1' || pg_catalog.chr(31) || p_workspace_id::text
      || pg_catalog.chr(31) || p_conversation_id::text
      || pg_catalog.chr(31) || p_priority
      || pg_catalog.chr(31) || pg_catalog.to_char(
        p_due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ) || pg_catalog.chr(31) || coalesce(p_note, ''),
    'UTF8'
  ), 'sha256');
  SELECT command.command_receipt_id, command.replay_result
    INTO STRICT selected_receipt_id, selected_replay
  FROM app_private.begin_operational_inbox_command(
    p_workspace_id, selected_user_id,
    'operational_inbox.create_admin_call_task', p_command_key, selected_payload
  ) AS command;
  IF selected_replay IS NOT NULL THEN
    RETURN QUERY SELECT 'replayed',
      (selected_replay->>'conversationId')::uuid,
      (selected_replay->>'contactId')::uuid,
      (selected_replay->>'taskId')::uuid,
      (selected_replay->>'taskRowVersion')::bigint;
    RETURN;
  END IF;

  SELECT conversation.* INTO selected_conversation
  FROM app.conversations AS conversation
  WHERE conversation.workspace_id = p_workspace_id
    AND conversation.id = p_conversation_id
    AND conversation.contact_id IS NOT NULL
    AND conversation.channel IN ('email', 'whatsapp', 'instagram', 'facebook')
    AND conversation.state IN ('open', 'snoozed');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Operational inbox conversation not found'
      USING ERRCODE = '23503';
  END IF;

  SELECT membership.user_id INTO selected_assignee_user_id
  FROM app.workspace_memberships AS membership
  WHERE membership.workspace_id = p_workspace_id
    AND membership.user_id = selected_conversation.assigned_user_id
    AND membership.status = 'active' AND membership.role <> 'viewer';
  selected_assignee_user_id := coalesce(selected_assignee_user_id, selected_user_id);
  selected_channel := CASE
    WHEN selected_conversation.channel IN ('instagram', 'facebook') THEN 'social'
    ELSE selected_conversation.channel
  END;

  INSERT INTO app.tasks (
    id, workspace_id, contact_id, title, description,
    assignee_user_id, priority, status, due_at
  ) VALUES (
    created_task_id, p_workspace_id, selected_conversation.contact_id,
    'Admin call: follow up Conversion Inbox',
    coalesce(p_note,
      'Open the linked Conversion Inbox thread and Lead 360 before calling.'),
    selected_assignee_user_id, p_priority, 'open', p_due_at
  );
  INSERT INTO app.property_predator_admin_call_task_origins (
    id, workspace_id, task_id, conversation_id, contact_id,
    source_message_id, source_channel, origin_kind, source_provider,
    source_receipt_id, source_event_identity_sha256,
    actor_kind, actor_user_id, command_receipt_id,
    request_id, occurred_at
  ) VALUES (
    created_origin_id, p_workspace_id, created_task_id,
    p_conversation_id, selected_conversation.contact_id,
    NULL, selected_conversation.channel, 'operator_created', 'operator',
    NULL, selected_payload, 'user', selected_user_id, selected_receipt_id,
    current_setting('app.request_id', true), statement_timestamp()
  );
  INSERT INTO app.activities (
    workspace_id, contact_id, task_id, activity_type, channel,
    actor_kind, actor_user_id, subject, body, metadata,
    request_id, correlation_id, occurred_at
  ) VALUES (
    p_workspace_id, selected_conversation.contact_id, created_task_id,
    'inbox.admin_call.created', selected_channel,
    'user', selected_user_id, 'Admin call task created from Conversion Inbox',
    p_note,
    pg_catalog.jsonb_build_object(
      'conversationId', p_conversation_id, 'originId', created_origin_id
    ), current_setting('app.request_id', true), selected_receipt_id::text,
    statement_timestamp()
  );

  PERFORM app_private.finish_operational_inbox_command(
    p_workspace_id, selected_user_id, selected_receipt_id,
    pg_catalog.jsonb_build_object(
      'conversationId', p_conversation_id,
      'contactId', selected_conversation.contact_id,
      'taskId', created_task_id, 'taskRowVersion', 1
    )
  );
  RETURN QUERY SELECT 'applied', p_conversation_id,
    selected_conversation.contact_id, created_task_id, 1::bigint;
END
$function$;

CREATE FUNCTION app_private.record_operational_inbox_admin_call_outcome(
  p_workspace_id uuid,
  p_session_token_sha256 bytea,
  p_conversation_id uuid,
  p_task_id uuid,
  p_expected_task_row_version bigint,
  p_outcome text,
  p_summary text,
  p_occurred_at timestamptz,
  p_next_action_kind text,
  p_next_action_title text,
  p_next_action_due_at timestamptz,
  p_next_action_priority text,
  p_command_key text
)
RETURNS TABLE (
  disposition text,
  conversation_id uuid,
  contact_id uuid,
  outcome_id uuid,
  completed_task_id uuid,
  completed_task_row_version bigint,
  next_task_id uuid,
  next_task_row_version bigint
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  selected_user_id uuid;
  selected_task app.tasks%ROWTYPE;
  selected_origin app.property_predator_admin_call_task_origins%ROWTYPE;
  selected_conversation app.conversations%ROWTYPE;
  selected_mailgun app.property_predator_mailgun_inbound_receipts%ROWTYPE;
  selected_receipt_id uuid;
  selected_replay jsonb;
  selected_payload bytea;
  selected_is_manager boolean;
  selected_channel text;
  selected_completed_row_version bigint;
  created_origin_id uuid := gen_random_uuid();
  created_outcome_id uuid := gen_random_uuid();
  created_next_task_id uuid;
  created_next_task_row_version bigint;
BEGIN
  selected_user_id := app_private.assert_operational_inbox_user_context(
    p_workspace_id, p_session_token_sha256
  );
  IF p_conversation_id IS NULL OR p_task_id IS NULL
     OR p_expected_task_row_version IS NULL OR p_expected_task_row_version < 1
     OR p_outcome NOT IN (
       'connected', 'voicemail', 'no_answer', 'wrong_number',
       'follow_up_requested', 'not_interested', 'qualified', 'converted'
     )
     OR p_summary IS NULL OR p_summary <> btrim(p_summary)
     OR octet_length(p_summary) NOT BETWEEN 1 AND 8000
     OR p_occurred_at IS NULL
     OR p_occurred_at < statement_timestamp() - interval '30 days'
     OR p_occurred_at > statement_timestamp() + interval '5 minutes'
     OR NOT (
       (p_next_action_kind IS NULL AND p_next_action_title IS NULL
         AND p_next_action_due_at IS NULL AND p_next_action_priority IS NULL)
       OR (p_next_action_kind IN (
           'call', 'reply_draft', 'consent_review', 'internal_follow_up'
         )
         AND p_next_action_title = btrim(p_next_action_title)
         AND length(p_next_action_title) BETWEEN 1 AND 300
         AND p_next_action_due_at IS NOT NULL
         AND p_next_action_due_at >= p_occurred_at - interval '5 minutes'
         AND p_next_action_due_at <= statement_timestamp() + interval '365 days'
         AND p_next_action_priority IN ('normal', 'high', 'urgent'))
     ) THEN
    RAISE EXCEPTION 'Operational inbox call outcome input is invalid'
      USING ERRCODE = '22023';
  END IF;

  selected_payload := public.digest(pg_catalog.convert_to(
    'call-outcome/v1' || pg_catalog.chr(31) || p_workspace_id::text
      || pg_catalog.chr(31) || p_conversation_id::text
      || pg_catalog.chr(31) || p_task_id::text
      || pg_catalog.chr(31) || p_expected_task_row_version::text
      || pg_catalog.chr(31) || p_outcome
      || pg_catalog.chr(31) || p_summary
      || pg_catalog.chr(31) || pg_catalog.to_char(
        p_occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ) || pg_catalog.chr(31) || coalesce(p_next_action_kind, '')
      || pg_catalog.chr(31) || coalesce(p_next_action_title, '')
      || pg_catalog.chr(31) || coalesce(pg_catalog.to_char(
        p_next_action_due_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ), '') || pg_catalog.chr(31) || coalesce(p_next_action_priority, ''),
    'UTF8'
  ), 'sha256');
  SELECT command.command_receipt_id, command.replay_result
    INTO STRICT selected_receipt_id, selected_replay
  FROM app_private.begin_operational_inbox_command(
    p_workspace_id, selected_user_id,
    'operational_inbox.record_admin_call_outcome', p_command_key, selected_payload
  ) AS command;
  IF selected_replay IS NOT NULL THEN
    RETURN QUERY SELECT 'replayed',
      (selected_replay->>'conversationId')::uuid,
      (selected_replay->>'contactId')::uuid,
      (selected_replay->>'outcomeId')::uuid,
      (selected_replay->>'completedTaskId')::uuid,
      (selected_replay->>'completedTaskRowVersion')::bigint,
      nullif(selected_replay->>'nextTaskId', '')::uuid,
      nullif(selected_replay->>'nextTaskRowVersion', '')::bigint;
    RETURN;
  END IF;

  SELECT task.* INTO selected_task
  FROM app.tasks AS task
  WHERE task.workspace_id = p_workspace_id AND task.id = p_task_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Operational inbox admin call task not found'
      USING ERRCODE = '23503';
  END IF;
  IF selected_task.status <> 'open'
     OR selected_task.row_version <> p_expected_task_row_version THEN
    RAISE EXCEPTION 'Operational inbox admin call task version conflict'
      USING ERRCODE = '40001';
  END IF;

  SELECT origin.* INTO selected_origin
  FROM app.property_predator_admin_call_task_origins AS origin
  WHERE origin.workspace_id = p_workspace_id
    AND origin.task_id = p_task_id
    AND origin.conversation_id = p_conversation_id;
  IF NOT FOUND THEN
    -- 0050 remains immutable. Materialise its exact signed receipt lazily so
    -- post-0055 replies cannot be completed without origin evidence.
    SELECT receipt.* INTO selected_mailgun
    FROM app.property_predator_mailgun_inbound_receipts AS receipt
    WHERE receipt.workspace_id = p_workspace_id
      AND receipt.admin_call_task_id = p_task_id
      AND receipt.conversation_id = p_conversation_id;
    IF FOUND THEN
      INSERT INTO app.property_predator_admin_call_task_origins (
        id, workspace_id, task_id, conversation_id, contact_id,
        source_message_id, source_channel, origin_kind, source_provider,
        source_receipt_id, source_event_identity_sha256,
        actor_kind, actor_user_id, command_receipt_id,
        request_id, occurred_at, recorded_at
      ) VALUES (
        created_origin_id, p_workspace_id, p_task_id, p_conversation_id,
        selected_mailgun.contact_id, selected_mailgun.inbound_message_id,
        'email', 'signed_inbound', 'mailgun_eu', selected_mailgun.id,
        selected_mailgun.event_identity_sha256,
        'webhook', NULL, NULL, selected_mailgun.request_id,
        selected_mailgun.occurred_at, selected_mailgun.received_at
      )
      ON CONFLICT (workspace_id, task_id) DO NOTHING;
      SELECT origin.* INTO selected_origin
      FROM app.property_predator_admin_call_task_origins AS origin
      WHERE origin.workspace_id = p_workspace_id
        AND origin.task_id = p_task_id
        AND origin.conversation_id = p_conversation_id;
    END IF;
  END IF;
  IF selected_origin.id IS NULL
     OR selected_origin.contact_id IS DISTINCT FROM selected_task.contact_id THEN
    RAISE EXCEPTION 'Operational inbox admin call origin not found'
      USING ERRCODE = '23503';
  END IF;
  IF EXISTS (
    SELECT 1 FROM app.property_predator_admin_call_outcomes AS outcome
    WHERE outcome.workspace_id = p_workspace_id AND outcome.task_id = p_task_id
  ) THEN
    RAISE EXCEPTION 'Operational inbox call outcome conflicts with existing evidence'
      USING ERRCODE = '22000';
  END IF;

  SELECT conversation.* INTO selected_conversation
  FROM app.conversations AS conversation
  WHERE conversation.workspace_id = p_workspace_id
    AND conversation.id = p_conversation_id
    AND conversation.contact_id = selected_task.contact_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Operational inbox conversation not found'
      USING ERRCODE = '23503';
  END IF;
  SELECT membership.role IN ('owner', 'admin') INTO selected_is_manager
  FROM app.workspace_memberships AS membership
  WHERE membership.workspace_id = p_workspace_id
    AND membership.user_id = selected_user_id
    AND membership.status = 'active';
  IF selected_task.assignee_user_id IS DISTINCT FROM selected_user_id
     AND NOT coalesce(selected_is_manager, false) THEN
    RAISE EXCEPTION 'Admin call outcome requires assigned self or manager'
      USING ERRCODE = '42501';
  END IF;

  IF p_next_action_kind IS NOT NULL THEN
    created_next_task_id := gen_random_uuid();
    created_next_task_row_version := 1;
    INSERT INTO app.tasks (
      id, workspace_id, contact_id, title, description,
      assignee_user_id, priority, status, due_at
    ) VALUES (
      created_next_task_id, p_workspace_id, selected_task.contact_id,
      p_next_action_title,
      'Created atomically from recorded admin-call outcome: ' || p_outcome,
      coalesce(selected_task.assignee_user_id, selected_user_id),
      p_next_action_priority, 'open', p_next_action_due_at
    );
  END IF;

  UPDATE app.tasks AS task
  SET status = 'completed', completed_at = statement_timestamp(),
      completed_by_user_id = selected_user_id,
      row_version = task.row_version + 1,
      updated_at = statement_timestamp()
  WHERE task.workspace_id = p_workspace_id AND task.id = p_task_id
    AND task.status = 'open'
    AND task.row_version = p_expected_task_row_version
  RETURNING task.row_version INTO selected_completed_row_version;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Operational inbox admin call task version conflict'
      USING ERRCODE = '40001';
  END IF;

  INSERT INTO app.property_predator_admin_call_outcomes (
    id, workspace_id, origin_id, task_id, conversation_id, contact_id,
    outcome, summary, next_action_kind, next_action_title,
    next_action_due_at, next_action_priority, next_task_id,
    recorded_by_user_id, command_receipt_id, payload_sha256,
    request_id, occurred_at
  ) VALUES (
    created_outcome_id, p_workspace_id, selected_origin.id,
    p_task_id, p_conversation_id, selected_task.contact_id,
    p_outcome, p_summary, p_next_action_kind, p_next_action_title,
    p_next_action_due_at, p_next_action_priority, created_next_task_id,
    selected_user_id, selected_receipt_id, selected_payload,
    current_setting('app.request_id', true), p_occurred_at
  );
  selected_channel := CASE
    WHEN selected_conversation.channel IN ('instagram', 'facebook') THEN 'social'
    ELSE selected_conversation.channel
  END;
  INSERT INTO app.activities (
    workspace_id, contact_id, task_id, activity_type, channel,
    actor_kind, actor_user_id, subject, body, metadata,
    request_id, correlation_id, occurred_at
  ) VALUES (
    p_workspace_id, selected_task.contact_id, p_task_id,
    'inbox.admin_call.outcome_recorded', selected_channel,
    'user', selected_user_id, 'Admin call outcome recorded', p_summary,
    pg_catalog.jsonb_build_object(
      'conversationId', p_conversation_id, 'outcomeId', created_outcome_id,
      'outcome', p_outcome, 'nextActionKind', p_next_action_kind,
      'nextTaskId', created_next_task_id
    ), current_setting('app.request_id', true), selected_receipt_id::text,
    least(p_occurred_at, statement_timestamp())
  );

  PERFORM app_private.finish_operational_inbox_command(
    p_workspace_id, selected_user_id, selected_receipt_id,
    pg_catalog.jsonb_build_object(
      'conversationId', p_conversation_id,
      'contactId', selected_task.contact_id,
      'outcomeId', created_outcome_id, 'completedTaskId', p_task_id,
      'completedTaskRowVersion', selected_completed_row_version,
      'nextTaskId', coalesce(created_next_task_id::text, ''),
      'nextTaskRowVersion', coalesce(created_next_task_row_version::text, '')
    )
  );
  RETURN QUERY SELECT 'applied', p_conversation_id,
    selected_task.contact_id, created_outcome_id, p_task_id,
    selected_completed_row_version, created_next_task_id,
    created_next_task_row_version;
END
$function$;

RESET ROLE;
SET LOCAL ROLE r72_owner;

-- The existing 0053 webhook LOGIN remains table-blind. Its existing NOLOGIN
-- definer receives only the extra columns needed to append one verified
-- WhatsApp event to the existing Conversion Inbox.
GRANT SELECT ON app.contacts, app.inboxes, app.conversations
  TO r72_whatsapp_live_definer;
GRANT INSERT ON app.conversations, app.messages, app.message_versions,
  app.tasks, app.activities TO r72_whatsapp_live_definer;
GRANT UPDATE (
  assigned_user_id, unread_count, last_message_at, row_version, updated_at
) ON app.conversations TO r72_whatsapp_live_definer;
GRANT SELECT, INSERT ON app.property_predator_admin_call_task_origins,
  app.property_predator_whatsapp_live_inbox_projections
  TO r72_whatsapp_live_definer;

CREATE POLICY contacts_whatsapp_inbox_projection_select
  ON app.contacts FOR SELECT TO r72_whatsapp_live_definer
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND current_setting('app.actor_kind', true) = 'webhook'
  );
CREATE POLICY inboxes_whatsapp_inbox_projection_select
  ON app.inboxes FOR SELECT TO r72_whatsapp_live_definer
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND current_setting('app.actor_kind', true) = 'webhook'
    AND environment = 'live' AND channel = 'whatsapp'
  );
CREATE POLICY conversations_whatsapp_inbox_projection_select
  ON app.conversations FOR SELECT TO r72_whatsapp_live_definer
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND current_setting('app.actor_kind', true) = 'webhook'
    AND environment = 'live' AND channel = 'whatsapp'
  );
CREATE POLICY conversations_whatsapp_inbox_projection_insert
  ON app.conversations FOR INSERT TO r72_whatsapp_live_definer
  WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND current_setting('app.actor_kind', true) = 'webhook'
    AND environment = 'live' AND channel = 'whatsapp'
    AND state = 'open' AND unread_count = 0 AND row_version = 1
  );
CREATE POLICY conversations_whatsapp_inbox_projection_update
  ON app.conversations FOR UPDATE TO r72_whatsapp_live_definer
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND current_setting('app.actor_kind', true) = 'webhook'
    AND environment = 'live' AND channel = 'whatsapp'
  ) WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND current_setting('app.actor_kind', true) = 'webhook'
    AND environment = 'live' AND channel = 'whatsapp'
  );
CREATE POLICY messages_whatsapp_inbox_projection_insert
  ON app.messages FOR INSERT TO r72_whatsapp_live_definer
  WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND current_setting('app.actor_kind', true) = 'webhook'
    AND environment = 'live' AND channel = 'whatsapp'
    AND direction = 'inbound' AND lifecycle = 'received'
    AND source_kind = 'verified_webhook'
    AND created_by_actor_kind = 'webhook' AND created_by_user_id IS NULL
  );
CREATE POLICY message_versions_whatsapp_inbox_projection_insert
  ON app.message_versions FOR INSERT TO r72_whatsapp_live_definer
  WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND current_setting('app.actor_kind', true) = 'webhook'
    AND environment = 'live' AND channel = 'whatsapp'
    AND version_number = 1 AND created_by_actor_kind = 'webhook'
    AND created_by_user_id IS NULL
    AND created_request_id = current_setting('app.request_id', true)
    AND source_content_version_ref IS NULL
    AND source_content_sha256 IS NULL
    AND source_content_approval_ref IS NULL
  );
CREATE POLICY tasks_whatsapp_inbox_projection_insert
  ON app.tasks FOR INSERT TO r72_whatsapp_live_definer
  WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND current_setting('app.actor_kind', true) = 'webhook'
    AND status = 'open' AND priority = 'urgent'
  );
CREATE POLICY activities_whatsapp_inbox_projection_insert
  ON app.activities FOR INSERT TO r72_whatsapp_live_definer
  WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND current_setting('app.actor_kind', true) = 'webhook'
    AND activity_type = 'inbox.whatsapp.reply_received'
    AND channel = 'whatsapp' AND actor_kind = 'webhook'
    AND actor_user_id IS NULL
  );
CREATE POLICY admin_call_origins_whatsapp_projection_select
  ON app.property_predator_admin_call_task_origins FOR SELECT
  TO r72_whatsapp_live_definer
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND current_setting('app.actor_kind', true) = 'webhook'
  );
CREATE POLICY admin_call_origins_whatsapp_projection_insert
  ON app.property_predator_admin_call_task_origins FOR INSERT
  TO r72_whatsapp_live_definer
  WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND current_setting('app.actor_kind', true) = 'webhook'
    AND source_channel = 'whatsapp'
    AND origin_kind = 'signed_inbound'
    AND source_provider = 'meta_whatsapp_cloud'
    AND actor_kind = 'webhook' AND actor_user_id IS NULL
    AND command_receipt_id IS NULL
    AND request_id = current_setting('app.request_id', true)
  );
CREATE POLICY whatsapp_live_inbox_projections_definer_select
  ON app.property_predator_whatsapp_live_inbox_projections FOR SELECT
  TO r72_whatsapp_live_definer
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND current_setting('app.actor_kind', true) = 'webhook'
  );
CREATE POLICY whatsapp_live_inbox_projections_definer_insert
  ON app.property_predator_whatsapp_live_inbox_projections FOR INSERT
  TO r72_whatsapp_live_definer
  WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND current_setting('app.actor_kind', true) = 'webhook'
    AND request_id = current_setting('app.request_id', true)
  );

GRANT CREATE ON SCHEMA app_private TO r72_whatsapp_live_definer;
SET LOCAL ROLE r72_whatsapp_live_definer;

CREATE FUNCTION app_private.record_whatsapp_live_inbound_projection(
  p_workspace_id uuid,
  p_binding_id uuid,
  p_external_event_id text,
  p_provider_message_id text,
  p_normalized_sender text,
  p_body_text text,
  p_sender_sha256 bytea,
  p_body_sha256 bytea,
  p_payload_sha256 bytea,
  p_signature_sha256 bytea,
  p_event_identity_sha256 bytea,
  p_occurred_at timestamptz
)
RETURNS TABLE (
  disposition text,
  receipt_id uuid,
  conversation_id uuid,
  message_id uuid,
  message_version_id uuid,
  admin_call_task_id uuid,
  admin_call_origin_id uuid
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  selected_request_id text := current_setting('app.request_id', true);
  selected_binding app.property_predator_whatsapp_live_bindings%ROWTYPE;
  selected_receipt app.property_predator_whatsapp_live_receipts%ROWTYPE;
  selected_projection app.property_predator_whatsapp_live_inbox_projections%ROWTYPE;
  selected_point app.contact_points%ROWTYPE;
  selected_inbox app.inboxes%ROWTYPE;
  selected_conversation app.conversations%ROWTYPE;
  selected_contact app.contacts%ROWTYPE;
  selected_assignee_user_id uuid;
  expected_event_identity_sha256 bytea;
  created_receipt_id uuid := gen_random_uuid();
  created_conversation_id uuid;
  created_message_id uuid := gen_random_uuid();
  created_version_id uuid := gen_random_uuid();
  created_task_id uuid := gen_random_uuid();
  created_origin_id uuid := gen_random_uuid();
BEGIN
  IF session_user <> 'r72_whatsapp_live_webhook_command'
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'webhook'
     OR coalesce(current_setting('app.user_id', true), '') <> ''
     OR selected_request_id IS NULL OR selected_request_id <> btrim(selected_request_id)
     OR length(selected_request_id) NOT BETWEEN 1 AND 128
     OR selected_request_id ~ '[^[:graph:]]'
     OR p_binding_id IS NULL
     OR p_external_event_id IS NULL OR p_external_event_id <> btrim(p_external_event_id)
     OR length(p_external_event_id) NOT BETWEEN 1 AND 500
     OR p_provider_message_id !~ '^wamid[.][A-Za-z0-9_=-]{1,190}$'
     OR p_normalized_sender !~ '^[1-9][0-9]{6,14}$'
     OR p_body_text IS NULL OR btrim(p_body_text) = ''
     OR octet_length(p_body_text) NOT BETWEEN 1 AND 4096
     OR octet_length(p_sender_sha256) <> 32
     OR octet_length(p_body_sha256) <> 32
     OR octet_length(p_payload_sha256) <> 32
     OR octet_length(p_signature_sha256) <> 32
     OR octet_length(p_event_identity_sha256) <> 32
     OR p_occurred_at IS NULL OR p_occurred_at > statement_timestamp() + interval '5 minutes'
     OR p_sender_sha256 <> public.digest(p_normalized_sender, 'sha256')
     OR p_body_sha256 <> public.digest(p_body_text, 'sha256') THEN
    RAISE EXCEPTION 'WhatsApp live inbound projection evidence is invalid'
      USING ERRCODE = '22023';
  END IF;
  expected_event_identity_sha256 := public.digest(
    p_external_event_id || pg_catalog.chr(31)
      || p_provider_message_id || pg_catalog.chr(31)
      || pg_catalog.encode(p_sender_sha256, 'hex') || pg_catalog.chr(31)
      || pg_catalog.encode(p_body_sha256, 'hex') || pg_catalog.chr(31)
      || pg_catalog.encode(p_payload_sha256, 'hex') || pg_catalog.chr(31)
      || pg_catalog.encode(p_signature_sha256, 'hex'),
    'sha256'
  );
  IF p_event_identity_sha256 IS DISTINCT FROM expected_event_identity_sha256 THEN
    RAISE EXCEPTION 'WhatsApp live inbound event identity is invalid'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    format('pp-whatsapp-inbox:%s:%s:%s',
      p_workspace_id, p_binding_id, p_external_event_id), 7200055
  ));
  SELECT receipt.* INTO selected_receipt
  FROM app.property_predator_whatsapp_live_receipts AS receipt
  WHERE receipt.workspace_id = p_workspace_id
    AND receipt.binding_id = p_binding_id
    AND receipt.external_event_id = p_external_event_id;
  IF FOUND THEN
    IF selected_receipt.event_kind <> 'inbound_received'
       OR selected_receipt.provider_message_id IS DISTINCT FROM p_provider_message_id
       OR selected_receipt.recipient_or_sender_sha256 IS DISTINCT FROM p_sender_sha256
       OR selected_receipt.body_sha256 IS DISTINCT FROM p_body_sha256
       OR selected_receipt.payload_sha256 IS DISTINCT FROM p_payload_sha256
       OR selected_receipt.provider_occurred_at IS DISTINCT FROM p_occurred_at THEN
      RETURN QUERY SELECT 'conflict', selected_receipt.id,
        NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid;
      RETURN;
    END IF;
    SELECT projection.* INTO selected_projection
    FROM app.property_predator_whatsapp_live_inbox_projections AS projection
    WHERE projection.workspace_id = p_workspace_id
      AND projection.receipt_id = selected_receipt.id;
    IF FOUND THEN
      IF selected_projection.signature_sha256 IS DISTINCT FROM p_signature_sha256
         OR selected_projection.event_identity_sha256 IS DISTINCT FROM p_event_identity_sha256
         OR selected_projection.sender_identity_sha256 IS DISTINCT FROM p_sender_sha256
         OR selected_projection.body_sha256 IS DISTINCT FROM p_body_sha256
         OR selected_projection.payload_sha256 IS DISTINCT FROM p_payload_sha256 THEN
        RETURN QUERY SELECT 'conflict', selected_receipt.id,
          NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid;
        RETURN;
      END IF;
      RETURN QUERY SELECT 'replayed', selected_receipt.id,
        selected_projection.conversation_id,
        selected_projection.inbound_message_id,
        selected_projection.inbound_message_version_id,
        selected_projection.admin_call_task_id,
        selected_projection.admin_call_origin_id;
      RETURN;
    END IF;
    created_receipt_id := selected_receipt.id;
  ELSIF p_occurred_at < statement_timestamp() - interval '7 days' THEN
    RAISE EXCEPTION 'WhatsApp live inbound event is outside the admission window'
      USING ERRCODE = '22023';
  END IF;

  SELECT binding.* INTO selected_binding
  FROM app.property_predator_whatsapp_live_bindings AS binding
  JOIN app.provider_connections AS connection
    ON connection.workspace_id = binding.workspace_id
   AND connection.id = binding.provider_connection_id
   AND connection.environment = binding.environment
  WHERE binding.workspace_id = p_workspace_id AND binding.id = p_binding_id
    AND binding.provider_id = 'meta_whatsapp_cloud'
    AND binding.environment = 'live' AND binding.status = 'active'
    AND connection.provider_id = 'meta_whatsapp_cloud'
    AND connection.provider_kind = 'messaging'
    AND connection.environment = 'live' AND connection.status = 'active'
    AND NOT EXISTS (
      SELECT 1 FROM app.property_predator_whatsapp_live_binding_revocations AS revocation
      WHERE revocation.workspace_id = binding.workspace_id
        AND revocation.binding_id = binding.id
    );
  IF NOT FOUND THEN
    RAISE EXCEPTION 'WhatsApp live inbound active binding denied'
      USING ERRCODE = '42501';
  END IF;

  BEGIN
    SELECT point.* INTO STRICT selected_point
    FROM app.contact_points AS point
    WHERE point.workspace_id = p_workspace_id
      AND point.kind = 'whatsapp'
      AND point.deleted_at IS NULL AND point.is_verified
      AND point.dedupe_state = 'normal'
      AND regexp_replace(point.normalized_value, '^\\+', '') = p_normalized_sender;
  EXCEPTION
    WHEN NO_DATA_FOUND THEN
      RAISE EXCEPTION 'WhatsApp live inbound verified contact point not found'
        USING ERRCODE = '23503';
    WHEN TOO_MANY_ROWS THEN
      RAISE EXCEPTION 'WhatsApp live inbound contact identity is ambiguous'
        USING ERRCODE = '22000';
  END;

  BEGIN
    SELECT inbox.* INTO STRICT selected_inbox
    FROM app.inboxes AS inbox
    WHERE inbox.workspace_id = p_workspace_id
      AND inbox.provider_connection_id = selected_binding.provider_connection_id
      AND inbox.channel = 'whatsapp' AND inbox.environment = 'live'
      AND inbox.status = 'active';
  EXCEPTION
    WHEN NO_DATA_FOUND THEN
      RAISE EXCEPTION 'WhatsApp live inbound inbox is not composed'
        USING ERRCODE = '23503';
    WHEN TOO_MANY_ROWS THEN
      RAISE EXCEPTION 'WhatsApp live inbound inbox binding is ambiguous'
        USING ERRCODE = '22000';
  END;

  SELECT contact.* INTO selected_contact
  FROM app.contacts AS contact
  WHERE contact.workspace_id = p_workspace_id
    AND contact.id = selected_point.contact_id
    AND contact.deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'WhatsApp live inbound contact not found'
      USING ERRCODE = '23503';
  END IF;

  SELECT conversation.* INTO selected_conversation
  FROM app.conversations AS conversation
  WHERE conversation.workspace_id = p_workspace_id
    AND conversation.inbox_id = selected_inbox.id
    AND conversation.contact_id = selected_point.contact_id
    AND conversation.channel = 'whatsapp' AND conversation.environment = 'live'
    AND conversation.state IN ('open', 'snoozed')
  FOR UPDATE;

  IF selected_conversation.assigned_user_id IS NOT NULL THEN
    SELECT membership.user_id INTO selected_assignee_user_id
    FROM app.workspace_memberships AS membership
    WHERE membership.workspace_id = p_workspace_id
      AND membership.user_id = selected_conversation.assigned_user_id
      AND membership.status = 'active' AND membership.role <> 'viewer';
  END IF;
  IF selected_assignee_user_id IS NULL AND selected_contact.owner_user_id IS NOT NULL THEN
    SELECT membership.user_id INTO selected_assignee_user_id
    FROM app.workspace_memberships AS membership
    WHERE membership.workspace_id = p_workspace_id
      AND membership.user_id = selected_contact.owner_user_id
      AND membership.status = 'active' AND membership.role <> 'viewer';
  END IF;
  IF selected_assignee_user_id IS NULL THEN
    SELECT membership.user_id INTO selected_assignee_user_id
    FROM app.workspace_memberships AS membership
    WHERE membership.workspace_id = p_workspace_id
      AND membership.status = 'active'
      AND membership.role IN ('owner', 'admin')
    ORDER BY CASE membership.role WHEN 'owner' THEN 1 ELSE 2 END,
      membership.granted_at, membership.user_id
    LIMIT 1;
  END IF;
  IF selected_assignee_user_id IS NULL THEN
    RAISE EXCEPTION 'WhatsApp live inbound has no active admin-call assignee'
      USING ERRCODE = '23503';
  END IF;

  IF selected_conversation.id IS NULL THEN
    created_conversation_id := gen_random_uuid();
    INSERT INTO app.conversations (
      id, workspace_id, inbox_id, channel, environment, contact_id,
      assigned_user_id, state, subject, unread_count, last_message_at
    ) VALUES (
      created_conversation_id, p_workspace_id, selected_inbox.id,
      'whatsapp', 'live', selected_point.contact_id,
      selected_assignee_user_id, 'open', 'Meta WhatsApp conversation',
      0, greatest(p_occurred_at, statement_timestamp())
    );
    SELECT conversation.* INTO selected_conversation
    FROM app.conversations AS conversation
    WHERE conversation.workspace_id = p_workspace_id
      AND conversation.id = created_conversation_id
    FOR UPDATE;
  END IF;

  IF selected_receipt.id IS NULL THEN
    INSERT INTO app.property_predator_whatsapp_live_receipts (
      id, workspace_id, job_id, binding_id, external_event_id, event_kind,
      provider_message_id, recipient_or_sender_sha256, body_sha256,
      payload_sha256, safe_code, provider_occurred_at
    ) VALUES (
      created_receipt_id, p_workspace_id, NULL, p_binding_id,
      p_external_event_id, 'inbound_received', p_provider_message_id,
      p_sender_sha256, p_body_sha256, p_payload_sha256,
      'meta_whatsapp_signed_inbound_projected', p_occurred_at
    );
  END IF;

  SET CONSTRAINTS ALL DEFERRED;
  INSERT INTO app.messages (
    id, workspace_id, conversation_id, contact_id, contact_point_id,
    channel, environment, direction, lifecycle, source_kind,
    current_version_id, current_version_number, current_body_sha256,
    created_by_actor_kind, created_by_user_id, occurred_at
  ) VALUES (
    created_message_id, p_workspace_id, selected_conversation.id,
    selected_point.contact_id, selected_point.id,
    'whatsapp', 'live', 'inbound', 'received', 'verified_webhook',
    created_version_id, 1, p_body_sha256,
    'webhook', NULL, p_occurred_at
  );
  INSERT INTO app.message_versions (
    id, workspace_id, conversation_id, message_id,
    channel, environment, version_number, body_format, body_text,
    created_by_actor_kind, created_by_user_id, created_request_id
  ) VALUES (
    created_version_id, p_workspace_id, selected_conversation.id,
    created_message_id, 'whatsapp', 'live', 1, 'plain_text', p_body_text,
    'webhook', NULL, selected_request_id
  );
  UPDATE app.conversations AS conversation
  SET assigned_user_id = selected_assignee_user_id,
      unread_count = least(conversation.unread_count + 1, 1000000),
      last_message_at = greatest(
        coalesce(conversation.last_message_at, p_occurred_at), p_occurred_at
      ), row_version = conversation.row_version + 1,
      updated_at = statement_timestamp()
  WHERE conversation.workspace_id = p_workspace_id
    AND conversation.id = selected_conversation.id;
  INSERT INTO app.tasks (
    id, workspace_id, contact_id, title, description,
    assignee_user_id, priority, status, due_at
  ) VALUES (
    created_task_id, p_workspace_id, selected_point.contact_id,
    'Call lead after verified Meta WhatsApp reply',
    'A signed Meta WhatsApp inbound message reached Conversion Inbox. Open the linked Lead 360 record and record the call outcome.',
    selected_assignee_user_id, 'urgent', 'open',
    statement_timestamp() + interval '15 minutes'
  );
  INSERT INTO app.property_predator_admin_call_task_origins (
    id, workspace_id, task_id, conversation_id, contact_id,
    source_message_id, source_channel, origin_kind, source_provider,
    source_receipt_id, source_event_identity_sha256,
    actor_kind, actor_user_id, command_receipt_id,
    request_id, occurred_at
  ) VALUES (
    created_origin_id, p_workspace_id, created_task_id,
    selected_conversation.id, selected_point.contact_id,
    created_message_id, 'whatsapp', 'signed_inbound',
    'meta_whatsapp_cloud', created_receipt_id, p_event_identity_sha256,
    'webhook', NULL, NULL, selected_request_id, p_occurred_at
  );
  INSERT INTO app.activities (
    workspace_id, contact_id, task_id, activity_type, channel,
    actor_kind, actor_user_id, subject, body, metadata,
    request_id, correlation_id, occurred_at
  ) VALUES (
    p_workspace_id, selected_point.contact_id, created_task_id,
    'inbox.whatsapp.reply_received', 'whatsapp', 'webhook', NULL,
    'Verified Meta WhatsApp reply received',
    'Conversion Inbox received a signed Meta WhatsApp reply and created an urgent admin call task.',
    pg_catalog.jsonb_build_object(
      'receiptId', created_receipt_id,
      'conversationId', selected_conversation.id,
      'messageId', created_message_id
    ), selected_request_id, created_receipt_id::text,
    least(p_occurred_at, statement_timestamp())
  );
  INSERT INTO app.property_predator_whatsapp_live_inbox_projections (
    workspace_id, receipt_id, binding_id, inbox_id,
    conversation_id, contact_id, contact_point_id,
    inbound_message_id, inbound_message_version_id,
    inbound_version_number, admin_call_task_id, admin_call_origin_id,
    sender_identity_sha256, body_sha256, payload_sha256,
    signature_sha256, event_identity_sha256, occurred_at, request_id
  ) VALUES (
    p_workspace_id, created_receipt_id, p_binding_id, selected_inbox.id,
    selected_conversation.id, selected_point.contact_id, selected_point.id,
    created_message_id, created_version_id, 1,
    created_task_id, created_origin_id, p_sender_sha256, p_body_sha256,
    p_payload_sha256, p_signature_sha256, p_event_identity_sha256,
    p_occurred_at, selected_request_id
  );

  RETURN QUERY SELECT 'applied', created_receipt_id,
    selected_conversation.id, created_message_id, created_version_id,
    created_task_id, created_origin_id;
END
$function$;

RESET ROLE;
SET LOCAL ROLE r72_owner;

GRANT SELECT ON app.provider_connections,
  app.property_predator_owned_social_profiles,
  app.property_predator_owned_social_profile_revocations,
  app.property_predator_owned_social_jobs,
  app.property_predator_owned_social_receipts,
  app.property_predator_whatsapp_live_bindings,
  app.property_predator_whatsapp_live_binding_revocations,
  app.property_predator_whatsapp_live_jobs,
  app.property_predator_whatsapp_live_receipts,
  app.property_predator_customer_email_jobs,
  app.property_predator_customer_email_receipts
  TO r72_operational_inbox_definer;

DO $channel_truth_policies$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'provider_connections',
    'property_predator_owned_social_profiles',
    'property_predator_owned_social_profile_revocations',
    'property_predator_owned_social_jobs',
    'property_predator_owned_social_receipts',
    'property_predator_whatsapp_live_bindings',
    'property_predator_whatsapp_live_binding_revocations',
    'property_predator_whatsapp_live_jobs',
    'property_predator_whatsapp_live_receipts',
    'property_predator_customer_email_jobs',
    'property_predator_customer_email_receipts'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY %I ON app.%I FOR SELECT TO r72_operational_inbox_definer
       USING (
         workspace_id = nullif(current_setting(''app.workspace_id'', true), '''')::uuid
         AND current_setting(''app.actor_kind'', true) = ''user''
       )', 'operational_channel_truth_' || table_name || '_select', table_name
    );
  END LOOP;
END
$channel_truth_policies$;

GRANT CREATE ON SCHEMA app_private TO r72_operational_inbox_definer;
SET LOCAL ROLE r72_operational_inbox_definer;

CREATE FUNCTION app_private.property_predator_live_channel_truth()
RETURNS TABLE (
  workspace_id uuid,
  snapshot_at timestamptz,
  rail text,
  connection_state text,
  inbound_state text,
  outbound_or_reply_state text,
  receipt_state text,
  daily_used bigint,
  daily_limit bigint,
  monthly_used bigint,
  monthly_limit bigint,
  blocker_codes text[],
  latest_receipt_id uuid,
  latest_receipt_outcome text,
  latest_receipt_at timestamptz,
  latest_receipt_evidence_sha256 text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  selected_workspace_id uuid;
  selected_user_id uuid;
  selected_now timestamptz := statement_timestamp();
  selected_connection boolean;
  selected_binding boolean;
  selected_pending boolean;
  selected_event_kind text;
  selected_evidence bytea;
BEGIN
  IF session_user <> 'r72_web'
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'user'
     OR coalesce(current_setting('app.workspace_id', true), '')
       !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR coalesce(current_setting('app.user_id', true), '')
       !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'Live channel truth context denied'
      USING ERRCODE = '42501';
  END IF;
  selected_workspace_id := current_setting('app.workspace_id', true)::uuid;
  selected_user_id := current_setting('app.user_id', true)::uuid;
  IF NOT EXISTS (
    SELECT 1 FROM app.workspace_memberships AS membership
    WHERE membership.workspace_id = selected_workspace_id
      AND membership.user_id = selected_user_id
      AND membership.status = 'active'
  ) THEN
    RAISE EXCEPTION 'Live channel truth membership denied'
      USING ERRCODE = '42501';
  END IF;

  -- Customer email: 10/day and 50/month are the exact initial 0054 caps.
  workspace_id := selected_workspace_id;
  snapshot_at := selected_now;
  rail := 'customer_email';
  daily_limit := 10;
  monthly_limit := 50;
  SELECT least(count(*)::bigint, daily_limit) INTO daily_used
  FROM app.property_predator_customer_email_jobs AS job
  WHERE job.workspace_id = selected_workspace_id
    AND job.utc_day = (selected_now AT TIME ZONE 'UTC')::date
    AND job.state <> 'cancelled';
  SELECT least(count(*)::bigint, monthly_limit) INTO monthly_used
  FROM app.property_predator_customer_email_jobs AS job
  WHERE job.workspace_id = selected_workspace_id
    AND job.utc_month = date_trunc('month', selected_now AT TIME ZONE 'UTC')::date
    AND job.state <> 'cancelled';
  SELECT EXISTS (
    SELECT 1 FROM app.provider_connections AS connection
    WHERE connection.workspace_id = selected_workspace_id
      AND connection.provider_id = 'mailgun_eu'
      AND connection.provider_kind = 'email'
      AND connection.environment = 'live' AND connection.status = 'active'
  ) INTO selected_connection;
  connection_state := CASE WHEN selected_connection THEN 'ready' ELSE 'not_configured' END;
  inbound_state := CASE WHEN selected_connection THEN 'ready' ELSE 'not_ready' END;
  outbound_or_reply_state := CASE
    WHEN daily_used = daily_limit OR monthly_used = monthly_limit THEN 'cap_reached'
    WHEN selected_connection THEN 'approval_required' ELSE 'blocked'
  END;
  SELECT receipt.id, receipt.event_kind, receipt.recorded_at,
      receipt.payload_sha256
    INTO latest_receipt_id, selected_event_kind, latest_receipt_at, selected_evidence
  FROM app.property_predator_customer_email_receipts AS receipt
  WHERE receipt.workspace_id = selected_workspace_id
  ORDER BY receipt.recorded_at DESC, receipt.id DESC LIMIT 1;
  SELECT EXISTS (
    SELECT 1 FROM app.property_predator_customer_email_jobs AS job
    WHERE job.workspace_id = selected_workspace_id
      AND job.state IN ('queued', 'leased', 'calling', 'awaiting_receipt')
  ) INTO selected_pending;
  IF latest_receipt_id IS NULL THEN
    receipt_state := CASE WHEN selected_pending THEN 'pending' ELSE 'none' END;
    latest_receipt_outcome := NULL;
    latest_receipt_evidence_sha256 := NULL;
  ELSE
    latest_receipt_outcome := CASE
      WHEN selected_event_kind = 'outcome_unknown' THEN 'outcome_unknown'
      WHEN selected_event_kind IN ('dispatch_failed', 'failed', 'complained', 'unsubscribed')
        THEN 'failed'
      WHEN selected_event_kind IN ('dispatch_accepted', 'accepted') THEN 'accepted'
      ELSE 'succeeded'
    END;
    receipt_state := CASE
      WHEN latest_receipt_outcome = 'outcome_unknown' THEN 'outcome_unknown'
      WHEN latest_receipt_outcome = 'failed' THEN 'needs_attention'
      ELSE 'healthy'
    END;
    latest_receipt_evidence_sha256 := pg_catalog.encode(selected_evidence, 'hex');
  END IF;
  blocker_codes := ARRAY[]::text[];
  IF NOT selected_connection THEN
    blocker_codes := blocker_codes || ARRAY['PROVIDER_NOT_CONFIGURED', 'INGRESS_NOT_READY'];
  END IF;
  IF outbound_or_reply_state = 'approval_required' THEN
    blocker_codes := blocker_codes || ARRAY['APPROVAL_REQUIRED'];
  ELSIF outbound_or_reply_state = 'cap_reached' THEN
    blocker_codes := blocker_codes || ARRAY['CAP_REACHED'];
  END IF;
  IF receipt_state = 'needs_attention' THEN
    blocker_codes := blocker_codes || ARRAY['RECEIPT_NEEDS_ATTENTION'];
  ELSIF receipt_state = 'outcome_unknown' THEN
    blocker_codes := blocker_codes || ARRAY['OUTCOME_UNKNOWN_QUARANTINED'];
  END IF;
  RETURN NEXT;

  -- Owned public social: exact Ayrshare/X identity, 1/day and 3/month.
  rail := 'owned_social';
  daily_limit := 1;
  monthly_limit := 3;
  SELECT least(count(*)::bigint, daily_limit) INTO daily_used
  FROM app.property_predator_owned_social_jobs AS job
  WHERE job.workspace_id = selected_workspace_id
    AND job.utc_day = (selected_now AT TIME ZONE 'UTC')::date
    AND job.state <> 'cancelled';
  SELECT least(count(*)::bigint, monthly_limit) INTO monthly_used
  FROM app.property_predator_owned_social_jobs AS job
  WHERE job.workspace_id = selected_workspace_id
    AND job.utc_month = date_trunc('month', selected_now AT TIME ZONE 'UTC')::date
    AND job.state <> 'cancelled';
  SELECT EXISTS (
    SELECT 1 FROM app.provider_connections AS connection
    WHERE connection.workspace_id = selected_workspace_id
      AND connection.provider_id = 'ayrshare'
      AND connection.provider_kind = 'social'
      AND connection.environment = 'live' AND connection.status = 'active'
  ) INTO selected_connection;
  SELECT EXISTS (
    SELECT 1 FROM app.property_predator_owned_social_profiles AS profile
    JOIN app.provider_connections AS connection
      ON connection.workspace_id = profile.workspace_id
     AND connection.id = profile.provider_connection_id
    WHERE profile.workspace_id = selected_workspace_id
      AND profile.provider_id = 'ayrshare' AND profile.network = 'x'
      AND connection.status = 'active'
      AND NOT EXISTS (
        SELECT 1 FROM app.property_predator_owned_social_profile_revocations AS revocation
        WHERE revocation.workspace_id = profile.workspace_id
          AND revocation.profile_id = profile.id
      )
  ) INTO selected_binding;
  connection_state := CASE WHEN selected_binding THEN 'ready'
    WHEN selected_connection THEN 'configured' ELSE 'not_configured' END;
  inbound_state := 'not_supported';
  outbound_or_reply_state := CASE
    WHEN daily_used = daily_limit OR monthly_used = monthly_limit THEN 'cap_reached'
    WHEN selected_binding THEN 'approval_required' ELSE 'blocked'
  END;
  latest_receipt_id := NULL; latest_receipt_at := NULL;
  selected_event_kind := NULL; selected_evidence := NULL;
  SELECT receipt.id, receipt.event_kind, receipt.recorded_at,
      receipt.receipt_sha256
    INTO latest_receipt_id, selected_event_kind, latest_receipt_at, selected_evidence
  FROM app.property_predator_owned_social_receipts AS receipt
  WHERE receipt.workspace_id = selected_workspace_id
  ORDER BY receipt.recorded_at DESC, receipt.id DESC LIMIT 1;
  SELECT EXISTS (
    SELECT 1 FROM app.property_predator_owned_social_jobs AS job
    WHERE job.workspace_id = selected_workspace_id
      AND job.state IN ('queued', 'leased', 'calling', 'reconciliation_pending')
  ) INTO selected_pending;
  IF latest_receipt_id IS NULL THEN
    receipt_state := CASE WHEN selected_pending THEN 'pending' ELSE 'none' END;
    latest_receipt_outcome := NULL;
    latest_receipt_evidence_sha256 := NULL;
  ELSE
    latest_receipt_outcome := CASE
      WHEN selected_event_kind = 'outcome_unknown' THEN 'outcome_unknown'
      WHEN selected_event_kind = 'failed' THEN 'failed'
      WHEN selected_event_kind = 'accepted' THEN 'accepted' ELSE 'succeeded'
    END;
    receipt_state := CASE
      WHEN latest_receipt_outcome = 'outcome_unknown' THEN 'outcome_unknown'
      WHEN latest_receipt_outcome = 'failed' THEN 'needs_attention'
      ELSE 'healthy'
    END;
    latest_receipt_evidence_sha256 := pg_catalog.encode(selected_evidence, 'hex');
  END IF;
  blocker_codes := ARRAY[]::text[];
  IF NOT selected_connection THEN
    blocker_codes := blocker_codes || ARRAY['PROVIDER_NOT_CONFIGURED'];
  ELSIF NOT selected_binding THEN
    blocker_codes := blocker_codes || ARRAY['IDENTITY_BINDING_REQUIRED'];
  END IF;
  IF outbound_or_reply_state = 'approval_required' THEN
    blocker_codes := blocker_codes || ARRAY['APPROVAL_REQUIRED'];
  ELSIF outbound_or_reply_state = 'cap_reached' THEN
    blocker_codes := blocker_codes || ARRAY['CAP_REACHED'];
  END IF;
  IF receipt_state = 'needs_attention' THEN
    blocker_codes := blocker_codes || ARRAY['RECEIPT_NEEDS_ATTENTION'];
  ELSIF receipt_state = 'outcome_unknown' THEN
    blocker_codes := blocker_codes || ARRAY['OUTCOME_UNKNOWN_QUARANTINED'];
  END IF;
  RETURN NEXT;

  -- Meta WhatsApp: exact current owned-number binding, 1/day and 3/month.
  rail := 'whatsapp';
  daily_limit := 1;
  monthly_limit := 3;
  SELECT least(count(*)::bigint, daily_limit) INTO daily_used
  FROM app.property_predator_whatsapp_live_jobs AS job
  WHERE job.workspace_id = selected_workspace_id
    AND job.utc_day = (selected_now AT TIME ZONE 'UTC')::date
    AND job.state <> 'cancelled';
  SELECT least(count(*)::bigint, monthly_limit) INTO monthly_used
  FROM app.property_predator_whatsapp_live_jobs AS job
  WHERE job.workspace_id = selected_workspace_id
    AND job.utc_month = date_trunc('month', selected_now AT TIME ZONE 'UTC')::date
    AND job.state <> 'cancelled';
  SELECT EXISTS (
    SELECT 1 FROM app.provider_connections AS connection
    WHERE connection.workspace_id = selected_workspace_id
      AND connection.provider_id = 'meta_whatsapp_cloud'
      AND connection.provider_kind = 'messaging'
      AND connection.environment = 'live' AND connection.status = 'active'
  ) INTO selected_connection;
  SELECT EXISTS (
    SELECT 1 FROM app.property_predator_whatsapp_live_bindings AS binding
    JOIN app.provider_connections AS connection
      ON connection.workspace_id = binding.workspace_id
     AND connection.id = binding.provider_connection_id
    WHERE binding.workspace_id = selected_workspace_id
      AND binding.status = 'active' AND connection.status = 'active'
      AND NOT EXISTS (
        SELECT 1 FROM app.property_predator_whatsapp_live_binding_revocations AS revocation
        WHERE revocation.workspace_id = binding.workspace_id
          AND revocation.binding_id = binding.id
      )
  ) INTO selected_binding;
  connection_state := CASE WHEN selected_binding THEN 'ready'
    WHEN selected_connection THEN 'configured' ELSE 'not_configured' END;
  inbound_state := CASE WHEN selected_binding THEN 'ready' ELSE 'not_ready' END;
  outbound_or_reply_state := CASE
    WHEN daily_used = daily_limit OR monthly_used = monthly_limit THEN 'cap_reached'
    WHEN selected_binding THEN 'approval_required' ELSE 'blocked'
  END;
  latest_receipt_id := NULL; latest_receipt_at := NULL;
  selected_event_kind := NULL; selected_evidence := NULL;
  SELECT receipt.id, receipt.event_kind, receipt.recorded_at,
      receipt.payload_sha256
    INTO latest_receipt_id, selected_event_kind, latest_receipt_at, selected_evidence
  FROM app.property_predator_whatsapp_live_receipts AS receipt
  WHERE receipt.workspace_id = selected_workspace_id
  ORDER BY receipt.recorded_at DESC, receipt.id DESC LIMIT 1;
  SELECT EXISTS (
    SELECT 1 FROM app.property_predator_whatsapp_live_jobs AS job
    WHERE job.workspace_id = selected_workspace_id
      AND job.state IN ('queued', 'leased', 'calling', 'awaiting_status')
  ) INTO selected_pending;
  IF latest_receipt_id IS NULL THEN
    receipt_state := CASE WHEN selected_pending THEN 'pending' ELSE 'none' END;
    latest_receipt_outcome := NULL;
    latest_receipt_evidence_sha256 := NULL;
  ELSE
    latest_receipt_outcome := CASE
      WHEN selected_event_kind = 'inbound_received' THEN 'inbound_verified'
      WHEN selected_event_kind = 'outcome_unknown' THEN 'outcome_unknown'
      WHEN selected_event_kind IN ('failed', 'deleted') THEN 'failed'
      WHEN selected_event_kind IN ('accepted', 'sent') THEN 'accepted'
      ELSE 'succeeded'
    END;
    receipt_state := CASE
      WHEN latest_receipt_outcome = 'outcome_unknown' THEN 'outcome_unknown'
      WHEN latest_receipt_outcome = 'failed' THEN 'needs_attention'
      ELSE 'healthy'
    END;
    latest_receipt_evidence_sha256 := pg_catalog.encode(selected_evidence, 'hex');
  END IF;
  blocker_codes := ARRAY[]::text[];
  IF NOT selected_connection THEN
    blocker_codes := blocker_codes || ARRAY['PROVIDER_NOT_CONFIGURED', 'INGRESS_NOT_READY'];
  ELSIF NOT selected_binding THEN
    blocker_codes := blocker_codes || ARRAY['IDENTITY_BINDING_REQUIRED', 'INGRESS_NOT_READY'];
  END IF;
  IF outbound_or_reply_state = 'approval_required' THEN
    blocker_codes := blocker_codes || ARRAY['APPROVAL_REQUIRED'];
  ELSIF outbound_or_reply_state = 'cap_reached' THEN
    blocker_codes := blocker_codes || ARRAY['CAP_REACHED'];
  END IF;
  IF receipt_state = 'needs_attention' THEN
    blocker_codes := blocker_codes || ARRAY['RECEIPT_NEEDS_ATTENTION'];
  ELSIF receipt_state = 'outcome_unknown' THEN
    blocker_codes := blocker_codes || ARRAY['OUTCOME_UNKNOWN_QUARANTINED'];
  END IF;
  RETURN NEXT;

  -- Live social-DM ingress has no composed provider adapter in this release.
  rail := 'social_dm';
  connection_state := 'not_composed';
  inbound_state := 'not_ready';
  outbound_or_reply_state := 'not_supported';
  receipt_state := 'none';
  daily_used := 0; daily_limit := 0;
  monthly_used := 0; monthly_limit := 0;
  blocker_codes := ARRAY['LIVE_ADAPTER_NOT_COMPOSED'];
  latest_receipt_id := NULL; latest_receipt_outcome := NULL;
  latest_receipt_at := NULL; latest_receipt_evidence_sha256 := NULL;
  RETURN NEXT;
END
$function$;

RESET ROLE;
SET LOCAL ROLE r72_owner;

-- Close the temporary DDL capability before exposing the exact callable
-- boundaries. PostgreSQL grants function execution to PUBLIC by default, so
-- every helper and command is explicitly closed before the three LOGIN roles
-- receive only the entry points they require.
REVOKE CREATE ON SCHEMA app_private
  FROM r72_operational_inbox_definer, r72_whatsapp_live_definer;

REVOKE ALL ON FUNCTION app_private.assert_operational_inbox_user_context(
  uuid, bytea
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.begin_operational_inbox_command(
  uuid, uuid, text, text, bytea
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.finish_operational_inbox_command(
  uuid, uuid, uuid, jsonb
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.assign_operational_inbox_conversation(
  uuid, bytea, uuid, uuid, bigint, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.append_operational_inbox_internal_note(
  uuid, bytea, uuid, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.create_operational_inbox_admin_call_task(
  uuid, bytea, uuid, text, timestamptz, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.record_operational_inbox_admin_call_outcome(
  uuid, bytea, uuid, uuid, bigint, text, text, timestamptz,
  text, text, timestamptz, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.record_whatsapp_live_inbound_projection(
  uuid, uuid, text, text, text, text,
  bytea, bytea, bytea, bytea, bytea, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.property_predator_live_channel_truth()
  FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app_private.assign_operational_inbox_conversation(
  uuid, bytea, uuid, uuid, bigint, text
) TO r72_crm_command;
GRANT EXECUTE ON FUNCTION app_private.append_operational_inbox_internal_note(
  uuid, bytea, uuid, text, text
) TO r72_crm_command;
GRANT EXECUTE ON FUNCTION app_private.create_operational_inbox_admin_call_task(
  uuid, bytea, uuid, text, timestamptz, text, text
) TO r72_crm_command;
GRANT EXECUTE ON FUNCTION app_private.record_operational_inbox_admin_call_outcome(
  uuid, bytea, uuid, uuid, bigint, text, text, timestamptz,
  text, text, timestamptz, text, text
) TO r72_crm_command;

-- 0055 is the only live WhatsApp inbound entry point: the 0053 hash-only
-- receipt function is intentionally retired so a verified event cannot skip
-- the canonical Conversion Inbox and admin-call projection.
REVOKE EXECUTE ON FUNCTION app_private.record_whatsapp_live_inbound_receipt(
  uuid, uuid, text, text, bytea, bytea, bytea, timestamptz
) FROM r72_whatsapp_live_webhook_command;
GRANT EXECUTE ON FUNCTION app_private.record_whatsapp_live_inbound_projection(
  uuid, uuid, text, text, text, text,
  bytea, bytea, bytea, bytea, bytea, timestamptz
) TO r72_whatsapp_live_webhook_command;

GRANT EXECUTE ON FUNCTION app_private.property_predator_live_channel_truth()
  TO r72_web;

-- The command identities retain no direct relation access. Only their exact
-- SECURITY DEFINER functions may cross the tenant boundary, and those
-- functions revalidate the portal/webhook context on every call.
DO $capability_audit$
DECLARE checked_role text; unsafe_object text;
BEGIN
  FOREACH checked_role IN ARRAY ARRAY[
    'r72_crm_command',
    'r72_whatsapp_live_webhook_command',
    'r72_web'
  ] LOOP
    SELECT format('%I.%I', namespace.nspname, relation.relname)
      INTO unsafe_object
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname IN ('app', 'app_private')
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND relation.relname IN (
        'property_predator_inbox_assignment_events',
        'property_predator_admin_call_task_origins',
        'property_predator_admin_call_outcomes',
        'property_predator_whatsapp_live_inbox_projections'
      )
      AND (
        (checked_role <> 'r72_web'
          AND has_table_privilege(checked_role, relation.oid, 'SELECT'))
        OR has_table_privilege(checked_role, relation.oid, 'INSERT')
        OR has_table_privilege(checked_role, relation.oid, 'UPDATE')
        OR has_table_privilege(checked_role, relation.oid, 'DELETE')
        OR has_table_privilege(checked_role, relation.oid, 'TRUNCATE')
      )
    LIMIT 1;
    IF unsafe_object IS NOT NULL THEN
      RAISE EXCEPTION 'Unsafe operational inbox table capability: % -> %',
        checked_role, unsafe_object;
    END IF;
  END LOOP;
END
$capability_audit$;
