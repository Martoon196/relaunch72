-- Property Predator Operator Action Centre control overlay.
--
-- The operational queue remains a derived read model owned by its journey,
-- inbox, content, webinar, automation, provider-readiness and CRM sources. This
-- migration persists only operator-owned assignment and snooze controls. It
-- deliberately has no title, priority, due-date, status, completion, delivery
-- or provider-effect field and therefore cannot manufacture source truth.

DO $operator_action_role$
DECLARE
  unexpected_parent text;
  unexpected_member text;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles
    WHERE rolname = 'r72_operator_action_definer'
  ) THEN
    CREATE ROLE r72_operator_action_definer NOLOGIN NOINHERIT;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles
    WHERE rolname = 'r72_operator_action_definer'
      AND NOT rolcanlogin
      AND NOT rolinherit
      AND NOT rolsuper
      AND NOT rolcreatedb
      AND NOT rolcreaterole
      AND NOT rolreplication
      AND NOT rolbypassrls
  ) THEN
    RAISE EXCEPTION 'Unsafe role attributes: r72_operator_action_definer does not match the required capability shape';
  END IF;

  REVOKE r72_owner, r72_security_definer
    FROM r72_operator_action_definer;
  REVOKE r72_operator_action_definer FROM
    r72_web, r72_public, r72_worker, r72_webhook, r72_readonly,
    r72_crm_command, r72_identity_command, r72_provisioning_command,
    r72_setup_delivery_command, r72_setup_reissue_command,
    r72_external_event_command, r72_import_command,
    r72_content_command, r72_content_adapter,
    r72_mailgun_webhook_command, r72_mailgun_worker_command;

  SELECT parent.rolname
    INTO unexpected_parent
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
  JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
  WHERE member.rolname = 'r72_operator_action_definer'
  LIMIT 1;

  IF unexpected_parent IS NOT NULL THEN
    RAISE EXCEPTION 'Unsafe Operator Action definer membership: r72_operator_action_definer can SET ROLE %',
      unexpected_parent;
  END IF;

  SELECT member.rolname
    INTO unexpected_member
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
  JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
  WHERE parent.rolname = 'r72_operator_action_definer'
    AND member.rolname NOT IN ('r72_owner', current_user)
  LIMIT 1;

  IF unexpected_member IS NOT NULL THEN
    RAISE EXCEPTION 'Unsafe Operator Action definer grant: % can SET ROLE r72_operator_action_definer',
      unexpected_member;
  END IF;

  GRANT r72_operator_action_definer TO r72_owner;
END;
$operator_action_role$;

SET LOCAL ROLE r72_owner;

REVOKE ALL ON SCHEMA app, app_private FROM r72_operator_action_definer;
REVOKE ALL ON ALL TABLES IN SCHEMA app FROM r72_operator_action_definer;
REVOKE ALL ON ALL TABLES IN SCHEMA app_private FROM r72_operator_action_definer;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app_private FROM r72_operator_action_definer;
REVOKE CREATE ON SCHEMA public FROM r72_operator_action_definer;
GRANT USAGE ON SCHEMA app, app_private TO r72_operator_action_definer;
GRANT EXECUTE ON FUNCTION
  app_private.current_workspace_id(),
  app_private.current_user_id(),
  app_private.current_actor_kind(),
  app_private.current_request_id(),
  app_private.has_active_workspace_membership(uuid, uuid),
  app_private.can_write_workspace(uuid, uuid),
  app_private.can_manage_workspace(uuid, uuid)
TO r72_operator_action_definer;

-- The portal's ordinary app.users policy is deliberately self-only. Give the
-- no-login definer only the three columns required for a workspace assignment
-- directory; email, password, lifecycle and all other user facts remain
-- unavailable. Forced RLS still limits both relations to the selected
-- workspace before the function's manager/self rule is applied.
GRANT SELECT (workspace_id, user_id, role)
  ON app.workspace_memberships TO r72_operator_action_definer;
GRANT SELECT (id, display_name)
  ON app.users TO r72_operator_action_definer;

CREATE POLICY workspace_memberships_operator_action_definer_select
  ON app.workspace_memberships FOR SELECT TO r72_operator_action_definer
  USING (workspace_id = app_private.current_workspace_id());

CREATE POLICY users_operator_action_definer_select
  ON app.users FOR SELECT TO r72_operator_action_definer
  USING (
    EXISTS (
      SELECT 1
      FROM app.workspace_memberships AS assignable_membership
      WHERE assignable_membership.workspace_id = app_private.current_workspace_id()
        AND assignable_membership.user_id = users.id
    )
  );

CREATE TABLE app.operator_action_controls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  action_key text NOT NULL CHECK (
    action_key = btrim(action_key)
    AND length(action_key) BETWEEN 3 AND 160
    AND action_key ~ '^[a-z][a-z0-9._:-]{2,159}$'
  ),
  action_kind text NOT NULL CHECK (
    action_kind IN (
      'journey', 'inbox', 'content', 'webinar',
      'automation', 'provider', 'crm'
    )
  ),
  source_reference text NOT NULL CHECK (
    source_reference = btrim(source_reference)
    AND length(source_reference) BETWEEN 1 AND 500
  ),
  assignment_overridden boolean NOT NULL DEFAULT false,
  assigned_user_id uuid,
  snoozed_until timestamptz,
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_by_user_id uuid NOT NULL,
  updated_by_user_id uuid NOT NULL,
  created_request_id text NOT NULL CHECK (
    created_request_id = btrim(created_request_id)
    AND length(created_request_id) BETWEEN 1 AND 128
  ),
  updated_request_id text NOT NULL CHECK (
    updated_request_id = btrim(updated_request_id)
    AND length(updated_request_id) BETWEEN 1 AND 128
  ),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, action_key),
  UNIQUE (workspace_id, id, action_key, action_kind, source_reference),
  FOREIGN KEY (workspace_id, assigned_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, created_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, updated_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id)
    ON DELETE RESTRICT,
  CHECK (updated_at >= created_at)
);

CREATE INDEX operator_action_controls_active_queue_idx
  ON app.operator_action_controls
    (workspace_id, snoozed_until, assigned_user_id, action_kind, action_key);

-- Each changed overlay revision appends exactly one immutable event. The event
-- repeats the stable source identity so an audit export remains intelligible
-- without copying mutable source facts into this control layer.
CREATE TABLE app.operator_action_control_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  control_id uuid NOT NULL,
  action_key text NOT NULL,
  action_kind text NOT NULL,
  source_reference text NOT NULL,
  event_kind text NOT NULL CHECK (
    event_kind IN ('assignment_changed', 'snooze_changed')
  ),
  previous_assignment_overridden boolean NOT NULL,
  assignment_overridden boolean NOT NULL,
  previous_assigned_user_id uuid,
  assigned_user_id uuid,
  previous_snoozed_until timestamptz,
  snoozed_until timestamptz,
  control_row_version bigint NOT NULL CHECK (control_row_version > 0),
  actor_user_id uuid NOT NULL,
  request_id text NOT NULL CHECK (
    request_id = btrim(request_id)
    AND length(request_id) BETWEEN 1 AND 128
  ),
  occurred_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, control_id, control_row_version),
  FOREIGN KEY (
    workspace_id, control_id, action_key, action_kind, source_reference
  ) REFERENCES app.operator_action_controls (
    workspace_id, id, action_key, action_kind, source_reference
  ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, previous_assigned_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, assigned_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, actor_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id)
    ON DELETE RESTRICT,
  CHECK (
    (
      event_kind = 'assignment_changed'
      AND (
        previous_assignment_overridden IS DISTINCT FROM assignment_overridden
        OR previous_assigned_user_id IS DISTINCT FROM assigned_user_id
      )
      AND previous_snoozed_until IS NOT DISTINCT FROM snoozed_until
    ) OR (
      event_kind = 'snooze_changed'
      AND previous_snoozed_until IS DISTINCT FROM snoozed_until
      AND previous_assignment_overridden IS NOT DISTINCT FROM assignment_overridden
      AND previous_assigned_user_id IS NOT DISTINCT FROM assigned_user_id
    )
  )
);

CREATE INDEX operator_action_control_events_timeline_idx
  ON app.operator_action_control_events
    (workspace_id, action_key, occurred_at DESC, id);

-- Commands are atomic: a successful mutation and its terminal receipt commit
-- together. Failed commands leave no misleading success fact. A retry with the
-- same semantic input returns this immutable result; key reuse with different
-- input fails closed.
CREATE TABLE app.operator_action_command_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  actor_user_id uuid NOT NULL,
  command_name text NOT NULL CHECK (
    command_name IN ('operatorAction.assign', 'operatorAction.snooze')
  ),
  idempotency_key text NOT NULL CHECK (
    idempotency_key = btrim(idempotency_key)
    AND length(idempotency_key) BETWEEN 8 AND 200
    AND idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$'
  ),
  payload_hash bytea NOT NULL CHECK (octet_length(payload_hash) = 32),
  request_id text NOT NULL CHECK (
    request_id = btrim(request_id)
    AND length(request_id) BETWEEN 1 AND 128
  ),
  action_key text NOT NULL,
  action_kind text NOT NULL,
  source_reference text NOT NULL,
  control_id uuid NOT NULL,
  event_id uuid,
  changed boolean NOT NULL,
  resulting_assignment_overridden boolean NOT NULL,
  resulting_assigned_user_id uuid,
  resulting_snoozed_until timestamptz,
  resulting_row_version bigint NOT NULL CHECK (resulting_row_version > 0),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, actor_user_id, command_name, idempotency_key),
  FOREIGN KEY (workspace_id, actor_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (
    workspace_id, control_id, action_key, action_kind, source_reference
  ) REFERENCES app.operator_action_controls (
    workspace_id, id, action_key, action_kind, source_reference
  ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES app.operator_action_control_events (workspace_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, resulting_assigned_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id)
    ON DELETE RESTRICT,
  CHECK (changed = (event_id IS NOT NULL))
);

CREATE INDEX operator_action_command_receipts_action_idx
  ON app.operator_action_command_receipts
    (workspace_id, action_key, created_at DESC, id);

CREATE FUNCTION app_private.reject_operator_action_append_only_mutation()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $function$
BEGIN
  RAISE EXCEPTION 'Operator Action audit events and command receipts are append-only'
    USING ERRCODE = '55000';
END;
$function$;

REVOKE ALL ON FUNCTION
  app_private.reject_operator_action_append_only_mutation()
FROM PUBLIC;

CREATE TRIGGER operator_action_control_events_immutable
BEFORE UPDATE OR DELETE ON app.operator_action_control_events
FOR EACH ROW EXECUTE FUNCTION
  app_private.reject_operator_action_append_only_mutation();

CREATE TRIGGER operator_action_command_receipts_immutable
BEFORE UPDATE OR DELETE ON app.operator_action_command_receipts
FOR EACH ROW EXECUTE FUNCTION
  app_private.reject_operator_action_append_only_mutation();

DO $operator_action_rls$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'operator_action_controls',
    'operator_action_control_events',
    'operator_action_command_receipts'
  ]
  LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON app.%I FOR ALL TO r72_owner USING (true) WITH CHECK (true)',
      table_name || '_owner_all', table_name
    );
    EXECUTE format(
      'CREATE POLICY %I ON app.%I FOR ALL TO r72_operator_action_definer USING (true) WITH CHECK (true)',
      table_name || '_definer_all', table_name
    );
  END LOOP;
END;
$operator_action_rls$;

CREATE POLICY operator_action_controls_member_select
  ON app.operator_action_controls FOR SELECT TO r72_web
  USING (
    workspace_id = app_private.current_workspace_id()
    AND app_private.has_active_workspace_membership(
      app_private.current_user_id(), workspace_id
    )
  );

GRANT SELECT ON app.operator_action_controls TO r72_web;

GRANT SELECT, INSERT, UPDATE ON app.operator_action_controls
  TO r72_operator_action_definer;
GRANT SELECT, INSERT ON
  app.operator_action_control_events,
  app.operator_action_command_receipts
TO r72_operator_action_definer;

-- Assignment is intentionally a team-control command, not source completion.
-- Managers may assign any active writable member. A non-manager may claim an
-- unassigned action for themselves or release only their own assignment.
-- The service must resolve action_key/action_kind/source_reference from its
-- authoritative server-side queue; these fields must never be trusted from a
-- browser form because the database cannot join every heterogeneous source.
CREATE FUNCTION app_private.set_operator_action_assignment(
  p_action_key text,
  p_action_kind text,
  p_source_reference text,
  p_assigned_user_id uuid,
  p_expected_row_version bigint,
  p_idempotency_key text
)
RETURNS TABLE (
  control_id uuid,
  action_key text,
  action_kind text,
  source_reference text,
  assignment_overridden boolean,
  assigned_user_id uuid,
  snoozed_until timestamptz,
  row_version bigint,
  changed boolean,
  event_id uuid,
  command_receipt_id uuid,
  replayed boolean
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  trusted_workspace_id uuid := app_private.current_workspace_id();
  trusted_actor_user_id uuid := app_private.current_user_id();
  trusted_request_id text := app_private.current_request_id();
  normalized_action_key text := btrim(p_action_key);
  normalized_source_reference text := btrim(p_source_reference);
  normalized_idempotency_key text := btrim(p_idempotency_key);
  request_hash bytea;
  existing_receipt app.operator_action_command_receipts%ROWTYPE;
  current_control app.operator_action_controls%ROWTYPE;
  resulting_control app.operator_action_controls%ROWTYPE;
  created_event_id uuid;
  created_receipt_id uuid;
  did_change boolean;
  actor_can_manage boolean;
BEGIN
  IF trusted_workspace_id IS NULL
     OR trusted_actor_user_id IS NULL
     OR trusted_request_id IS NULL
     OR trusted_request_id <> btrim(trusted_request_id)
     OR length(trusted_request_id) NOT BETWEEN 1 AND 128
     OR app_private.current_actor_kind() <> 'user'
     OR NOT app_private.can_write_workspace(
       trusted_actor_user_id, trusted_workspace_id
     ) THEN
    RAISE EXCEPTION 'Operator Action assignment requires an active writable user context'
      USING ERRCODE = '42501';
  END IF;

  IF p_action_key IS NULL
     OR p_action_key <> normalized_action_key
     OR length(normalized_action_key) NOT BETWEEN 3 AND 160
     OR normalized_action_key !~ '^[a-z][a-z0-9._:-]{2,159}$'
     OR p_action_kind IS NULL
     OR p_action_kind NOT IN (
       'journey', 'inbox', 'content', 'webinar',
       'automation', 'provider', 'crm'
     )
     OR p_source_reference IS NULL
     OR p_source_reference <> normalized_source_reference
     OR length(normalized_source_reference) NOT BETWEEN 1 AND 500
     OR p_expected_row_version IS NULL
     OR p_expected_row_version < 0
     OR p_idempotency_key IS NULL
     OR p_idempotency_key <> normalized_idempotency_key
     OR length(normalized_idempotency_key) NOT BETWEEN 8 AND 200
     OR normalized_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' THEN
    RAISE EXCEPTION 'Invalid Operator Action assignment input'
      USING ERRCODE = '22023';
  END IF;

  request_hash := public.digest(
    pg_catalog.convert_to(
      pg_catalog.jsonb_build_array(
        'operatorAction.assign', normalized_action_key, p_action_kind,
        normalized_source_reference, p_assigned_user_id,
        p_expected_row_version
      )::text,
      'UTF8'
    ),
    'sha256'
  );

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'operator-action-receipt:' || trusted_workspace_id::text || ':'
      || trusted_actor_user_id::text || ':operatorAction.assign:'
      || normalized_idempotency_key,
      7200028
    )
  );

  SELECT receipt.*
    INTO existing_receipt
  FROM app.operator_action_command_receipts AS receipt
  WHERE receipt.workspace_id = trusted_workspace_id
    AND receipt.actor_user_id = trusted_actor_user_id
    AND receipt.command_name = 'operatorAction.assign'
    AND receipt.idempotency_key = normalized_idempotency_key;

  IF FOUND THEN
    IF existing_receipt.payload_hash <> request_hash THEN
      RAISE EXCEPTION 'Operator Action assignment idempotency key was reused with different input'
        USING ERRCODE = '22023';
    END IF;
    RETURN QUERY SELECT
      existing_receipt.control_id,
      existing_receipt.action_key,
      existing_receipt.action_kind,
      existing_receipt.source_reference,
      existing_receipt.resulting_assignment_overridden,
      existing_receipt.resulting_assigned_user_id,
      existing_receipt.resulting_snoozed_until,
      existing_receipt.resulting_row_version,
      existing_receipt.changed,
      existing_receipt.event_id,
      existing_receipt.id,
      true;
    RETURN;
  END IF;

  actor_can_manage := app_private.can_manage_workspace(
    trusted_actor_user_id, trusted_workspace_id
  );

  IF p_assigned_user_id IS NOT NULL
     AND NOT app_private.can_write_workspace(
       p_assigned_user_id, trusted_workspace_id
     ) THEN
    RAISE EXCEPTION 'Operator Action assignee must be an active writable workspace member'
      USING ERRCODE = '42501';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'operator-action-control:' || trusted_workspace_id::text || ':'
      || normalized_action_key,
      7200028
    )
  );

  SELECT control.*
    INTO current_control
  FROM app.operator_action_controls AS control
  WHERE control.workspace_id = trusted_workspace_id
    AND control.action_key = normalized_action_key
  FOR UPDATE;

  IF NOT FOUND THEN
    IF p_expected_row_version <> 0 THEN
      RAISE EXCEPTION 'Operator Action assignment has a stale row version'
        USING ERRCODE = '40001';
    END IF;
    IF NOT actor_can_manage THEN
      IF p_assigned_user_id IS NULL THEN
        RAISE EXCEPTION 'A member cannot clear an Operator Action assignment without an explicit self-owned overlay'
          USING ERRCODE = '42501';
      END IF;
      IF p_assigned_user_id IS DISTINCT FROM trusted_actor_user_id THEN
        RAISE EXCEPTION 'Only a workspace manager may assign another member'
          USING ERRCODE = '42501';
      END IF;
    END IF;

    INSERT INTO app.operator_action_controls (
      workspace_id, action_key, action_kind, source_reference,
      assignment_overridden, assigned_user_id, snoozed_until, row_version,
      created_by_user_id, updated_by_user_id,
      created_request_id, updated_request_id
    ) VALUES (
      trusted_workspace_id, normalized_action_key, p_action_kind,
      normalized_source_reference, true, p_assigned_user_id, NULL, 1,
      trusted_actor_user_id, trusted_actor_user_id,
      trusted_request_id, trusted_request_id
    )
    RETURNING * INTO resulting_control;
    did_change := true;
  ELSE
    IF current_control.action_kind <> p_action_kind
       OR current_control.source_reference <> normalized_source_reference THEN
      RAISE EXCEPTION 'Operator Action key is already bound to different source identity'
        USING ERRCODE = '22023';
    END IF;
    IF current_control.row_version <> p_expected_row_version THEN
      RAISE EXCEPTION 'Operator Action assignment has a stale row version'
        USING ERRCODE = '40001';
    END IF;

    IF NOT actor_can_manage THEN
      IF p_assigned_user_id IS NULL THEN
        IF NOT current_control.assignment_overridden
           OR current_control.assigned_user_id IS DISTINCT FROM trusted_actor_user_id THEN
          RAISE EXCEPTION 'A member may release only their own Operator Action assignment'
            USING ERRCODE = '42501';
        END IF;
      ELSIF p_assigned_user_id = trusted_actor_user_id THEN
        IF current_control.assigned_user_id IS NOT NULL
           AND current_control.assigned_user_id <> trusted_actor_user_id THEN
          RAISE EXCEPTION 'A member cannot take another member''s Operator Action assignment'
            USING ERRCODE = '42501';
        END IF;
      ELSE
        RAISE EXCEPTION 'Only a workspace manager may assign another member'
          USING ERRCODE = '42501';
      END IF;
    END IF;

    did_change := NOT current_control.assignment_overridden
      OR current_control.assigned_user_id IS DISTINCT FROM p_assigned_user_id;
    IF did_change THEN
      UPDATE app.operator_action_controls AS control
      SET assignment_overridden = true,
          assigned_user_id = p_assigned_user_id,
          row_version = control.row_version + 1,
          updated_by_user_id = trusted_actor_user_id,
          updated_request_id = trusted_request_id,
          updated_at = statement_timestamp()
      WHERE control.workspace_id = trusted_workspace_id
        AND control.id = current_control.id
      RETURNING control.* INTO resulting_control;
    ELSE
      resulting_control := current_control;
    END IF;
  END IF;

  IF did_change THEN
    INSERT INTO app.operator_action_control_events (
      workspace_id, control_id, action_key, action_kind, source_reference,
      event_kind, previous_assignment_overridden, assignment_overridden,
      previous_assigned_user_id, assigned_user_id,
      previous_snoozed_until, snoozed_until, control_row_version,
      actor_user_id, request_id
    ) VALUES (
      trusted_workspace_id, resulting_control.id,
      resulting_control.action_key, resulting_control.action_kind,
      resulting_control.source_reference, 'assignment_changed',
      CASE WHEN current_control.id IS NULL THEN false
        ELSE current_control.assignment_overridden END,
      resulting_control.assignment_overridden,
      CASE WHEN current_control.id IS NULL THEN NULL
        ELSE current_control.assigned_user_id END,
      resulting_control.assigned_user_id,
      CASE WHEN current_control.id IS NULL THEN resulting_control.snoozed_until
        ELSE current_control.snoozed_until END,
      resulting_control.snoozed_until,
      resulting_control.row_version, trusted_actor_user_id,
      trusted_request_id
    )
    RETURNING id INTO created_event_id;
  END IF;

  INSERT INTO app.operator_action_command_receipts (
    workspace_id, actor_user_id, command_name, idempotency_key,
    payload_hash, request_id, action_key, action_kind, source_reference,
    control_id, event_id, changed, resulting_assigned_user_id,
    resulting_assignment_overridden, resulting_snoozed_until,
    resulting_row_version
  ) VALUES (
    trusted_workspace_id, trusted_actor_user_id, 'operatorAction.assign',
    normalized_idempotency_key, request_hash, trusted_request_id,
    resulting_control.action_key, resulting_control.action_kind,
    resulting_control.source_reference, resulting_control.id,
    created_event_id, did_change, resulting_control.assigned_user_id,
    resulting_control.assignment_overridden,
    resulting_control.snoozed_until, resulting_control.row_version
  )
  RETURNING id INTO created_receipt_id;

  RETURN QUERY SELECT
    resulting_control.id,
    resulting_control.action_key,
    resulting_control.action_kind,
    resulting_control.source_reference,
    resulting_control.assignment_overridden,
    resulting_control.assigned_user_id,
    resulting_control.snoozed_until,
    resulting_control.row_version,
    did_change,
    created_event_id,
    created_receipt_id,
    false;
END;
$function$;

-- Snooze is a shared operator control available to any active writable member.
-- NULL means unsnooze. A non-NULL value must be a bounded future instant.
CREATE FUNCTION app_private.set_operator_action_snooze(
  p_action_key text,
  p_action_kind text,
  p_source_reference text,
  p_snoozed_until timestamptz,
  p_expected_row_version bigint,
  p_idempotency_key text
)
RETURNS TABLE (
  control_id uuid,
  action_key text,
  action_kind text,
  source_reference text,
  assignment_overridden boolean,
  assigned_user_id uuid,
  snoozed_until timestamptz,
  row_version bigint,
  changed boolean,
  event_id uuid,
  command_receipt_id uuid,
  replayed boolean
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  trusted_workspace_id uuid := app_private.current_workspace_id();
  trusted_actor_user_id uuid := app_private.current_user_id();
  trusted_request_id text := app_private.current_request_id();
  normalized_action_key text := btrim(p_action_key);
  normalized_source_reference text := btrim(p_source_reference);
  normalized_idempotency_key text := btrim(p_idempotency_key);
  request_hash bytea;
  existing_receipt app.operator_action_command_receipts%ROWTYPE;
  current_control app.operator_action_controls%ROWTYPE;
  resulting_control app.operator_action_controls%ROWTYPE;
  created_event_id uuid;
  created_receipt_id uuid;
  did_change boolean;
BEGIN
  IF trusted_workspace_id IS NULL
     OR trusted_actor_user_id IS NULL
     OR trusted_request_id IS NULL
     OR trusted_request_id <> btrim(trusted_request_id)
     OR length(trusted_request_id) NOT BETWEEN 1 AND 128
     OR app_private.current_actor_kind() <> 'user'
     OR NOT app_private.can_write_workspace(
       trusted_actor_user_id, trusted_workspace_id
     ) THEN
    RAISE EXCEPTION 'Operator Action snooze requires an active writable user context'
      USING ERRCODE = '42501';
  END IF;

  IF p_action_key IS NULL
     OR p_action_key <> normalized_action_key
     OR length(normalized_action_key) NOT BETWEEN 3 AND 160
     OR normalized_action_key !~ '^[a-z][a-z0-9._:-]{2,159}$'
     OR p_action_kind IS NULL
     OR p_action_kind NOT IN (
       'journey', 'inbox', 'content', 'webinar',
       'automation', 'provider', 'crm'
     )
     OR p_source_reference IS NULL
     OR p_source_reference <> normalized_source_reference
     OR length(normalized_source_reference) NOT BETWEEN 1 AND 500
     OR p_expected_row_version IS NULL
     OR p_expected_row_version < 0
     OR p_idempotency_key IS NULL
     OR p_idempotency_key <> normalized_idempotency_key
     OR length(normalized_idempotency_key) NOT BETWEEN 8 AND 200
     OR normalized_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' THEN
    RAISE EXCEPTION 'Invalid Operator Action snooze input'
      USING ERRCODE = '22023';
  END IF;

  request_hash := public.digest(
    pg_catalog.convert_to(
      pg_catalog.jsonb_build_array(
        'operatorAction.snooze', normalized_action_key, p_action_kind,
        normalized_source_reference, p_snoozed_until,
        p_expected_row_version
      )::text,
      'UTF8'
    ),
    'sha256'
  );

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'operator-action-receipt:' || trusted_workspace_id::text || ':'
      || trusted_actor_user_id::text || ':operatorAction.snooze:'
      || normalized_idempotency_key,
      7200028
    )
  );

  SELECT receipt.*
    INTO existing_receipt
  FROM app.operator_action_command_receipts AS receipt
  WHERE receipt.workspace_id = trusted_workspace_id
    AND receipt.actor_user_id = trusted_actor_user_id
    AND receipt.command_name = 'operatorAction.snooze'
    AND receipt.idempotency_key = normalized_idempotency_key;

  IF FOUND THEN
    IF existing_receipt.payload_hash <> request_hash THEN
      RAISE EXCEPTION 'Operator Action snooze idempotency key was reused with different input'
        USING ERRCODE = '22023';
    END IF;
    RETURN QUERY SELECT
      existing_receipt.control_id,
      existing_receipt.action_key,
      existing_receipt.action_kind,
      existing_receipt.source_reference,
      existing_receipt.resulting_assignment_overridden,
      existing_receipt.resulting_assigned_user_id,
      existing_receipt.resulting_snoozed_until,
      existing_receipt.resulting_row_version,
      existing_receipt.changed,
      existing_receipt.event_id,
      existing_receipt.id,
      true;
    RETURN;
  END IF;

  IF p_snoozed_until IS NOT NULL
     AND (
       p_snoozed_until <= statement_timestamp()
       OR p_snoozed_until > statement_timestamp() + interval '365 days'
     ) THEN
    RAISE EXCEPTION 'Operator Action snooze must be a bounded future instant'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'operator-action-control:' || trusted_workspace_id::text || ':'
      || normalized_action_key,
      7200028
    )
  );

  SELECT control.*
    INTO current_control
  FROM app.operator_action_controls AS control
  WHERE control.workspace_id = trusted_workspace_id
    AND control.action_key = normalized_action_key
  FOR UPDATE;

  IF NOT FOUND THEN
    IF p_expected_row_version <> 0 THEN
      RAISE EXCEPTION 'Operator Action snooze has a stale row version'
        USING ERRCODE = '40001';
    END IF;
    IF p_snoozed_until IS NULL THEN
      RAISE EXCEPTION 'An absent Operator Action snooze cannot be cleared'
        USING ERRCODE = '22023';
    END IF;

    INSERT INTO app.operator_action_controls (
      workspace_id, action_key, action_kind, source_reference,
      assignment_overridden, assigned_user_id, snoozed_until, row_version,
      created_by_user_id, updated_by_user_id,
      created_request_id, updated_request_id
    ) VALUES (
      trusted_workspace_id, normalized_action_key, p_action_kind,
      normalized_source_reference, false, NULL, p_snoozed_until, 1,
      trusted_actor_user_id, trusted_actor_user_id,
      trusted_request_id, trusted_request_id
    )
    RETURNING * INTO resulting_control;
    did_change := true;
  ELSE
    IF current_control.action_kind <> p_action_kind
       OR current_control.source_reference <> normalized_source_reference THEN
      RAISE EXCEPTION 'Operator Action key is already bound to different source identity'
        USING ERRCODE = '22023';
    END IF;
    IF current_control.row_version <> p_expected_row_version THEN
      RAISE EXCEPTION 'Operator Action snooze has a stale row version'
        USING ERRCODE = '40001';
    END IF;

    did_change := current_control.snoozed_until IS DISTINCT FROM p_snoozed_until;
    IF did_change THEN
      UPDATE app.operator_action_controls AS control
      SET snoozed_until = p_snoozed_until,
          row_version = control.row_version + 1,
          updated_by_user_id = trusted_actor_user_id,
          updated_request_id = trusted_request_id,
          updated_at = statement_timestamp()
      WHERE control.workspace_id = trusted_workspace_id
        AND control.id = current_control.id
      RETURNING control.* INTO resulting_control;
    ELSE
      resulting_control := current_control;
    END IF;
  END IF;

  IF did_change THEN
    INSERT INTO app.operator_action_control_events (
      workspace_id, control_id, action_key, action_kind, source_reference,
      event_kind, previous_assignment_overridden, assignment_overridden,
      previous_assigned_user_id, assigned_user_id,
      previous_snoozed_until, snoozed_until, control_row_version,
      actor_user_id, request_id
    ) VALUES (
      trusted_workspace_id, resulting_control.id,
      resulting_control.action_key, resulting_control.action_kind,
      resulting_control.source_reference, 'snooze_changed',
      CASE WHEN current_control.id IS NULL THEN false
        ELSE current_control.assignment_overridden END,
      resulting_control.assignment_overridden,
      CASE WHEN current_control.id IS NULL THEN resulting_control.assigned_user_id
        ELSE current_control.assigned_user_id END,
      resulting_control.assigned_user_id,
      CASE WHEN current_control.id IS NULL THEN NULL
        ELSE current_control.snoozed_until END,
      resulting_control.snoozed_until,
      resulting_control.row_version, trusted_actor_user_id,
      trusted_request_id
    )
    RETURNING id INTO created_event_id;
  END IF;

  INSERT INTO app.operator_action_command_receipts (
    workspace_id, actor_user_id, command_name, idempotency_key,
    payload_hash, request_id, action_key, action_kind, source_reference,
    control_id, event_id, changed, resulting_assigned_user_id,
    resulting_assignment_overridden, resulting_snoozed_until,
    resulting_row_version
  ) VALUES (
    trusted_workspace_id, trusted_actor_user_id, 'operatorAction.snooze',
    normalized_idempotency_key, request_hash, trusted_request_id,
    resulting_control.action_key, resulting_control.action_kind,
    resulting_control.source_reference, resulting_control.id,
    created_event_id, did_change, resulting_control.assigned_user_id,
    resulting_control.assignment_overridden,
    resulting_control.snoozed_until, resulting_control.row_version
  )
  RETURNING id INTO created_receipt_id;

  RETURN QUERY SELECT
    resulting_control.id,
    resulting_control.action_key,
    resulting_control.action_kind,
    resulting_control.source_reference,
    resulting_control.assignment_overridden,
    resulting_control.assigned_user_id,
    resulting_control.snoozed_until,
    resulting_control.row_version,
    did_change,
    created_event_id,
    created_receipt_id,
    false;
END;
$function$;

-- A bounded, RLS-context-only assignment directory. Manager authority is
-- derived inside PostgreSQL rather than accepted as a caller hint. Managers
-- see active writable members; ordinary writers see only themselves; viewers
-- receive an empty set. The function never exposes email or password data.
CREATE FUNCTION app_private.list_operator_action_assignable_members(
  p_limit integer
)
RETURNS TABLE (
  user_id uuid,
  display_name text,
  role text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  trusted_workspace_id uuid := app_private.current_workspace_id();
  trusted_user_id uuid := app_private.current_user_id();
  caller_can_write boolean;
  caller_can_manage boolean;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 101 THEN
    RAISE EXCEPTION 'Operator Action member limit must be between 1 and 101'
      USING ERRCODE = '22023';
  END IF;

  IF trusted_workspace_id IS NULL
     OR trusted_user_id IS NULL
     OR app_private.current_actor_kind() <> 'user'
     OR NOT app_private.has_active_workspace_membership(
       trusted_user_id, trusted_workspace_id
     ) THEN
    RAISE EXCEPTION 'Operator Action member directory requires an active workspace user context'
      USING ERRCODE = '42501';
  END IF;

  caller_can_write := app_private.can_write_workspace(
    trusted_user_id, trusted_workspace_id
  );
  caller_can_manage := app_private.can_manage_workspace(
    trusted_user_id, trusted_workspace_id
  );

  RETURN QUERY
  SELECT membership.user_id,
         coalesce(
           nullif(btrim(person.display_name), ''),
           'Member ' || left(membership.user_id::text, 8)
         )::text,
         membership.role::text
  FROM app.workspace_memberships AS membership
  JOIN app.users AS person ON person.id = membership.user_id
  WHERE caller_can_write
    AND membership.workspace_id = trusted_workspace_id
    AND membership.role IN ('owner', 'admin', 'marketer', 'sales')
    AND app_private.can_write_workspace(
      membership.user_id, trusted_workspace_id
    )
    AND (
      caller_can_manage
      OR membership.user_id = trusted_user_id
    )
  ORDER BY
    CASE membership.role
      WHEN 'owner' THEN 0
      WHEN 'admin' THEN 1
      WHEN 'marketer' THEN 2
      ELSE 3
    END,
    pg_catalog.lower(coalesce(nullif(btrim(person.display_name), ''), '')),
    membership.user_id
  LIMIT p_limit;
END;
$function$;

COMMENT ON FUNCTION app_private.set_operator_action_assignment(
  text, text, text, uuid, bigint, text
) IS 'Caller must resolve action identity from the authoritative server-side queue; source identity must never be trusted from a browser form.';

COMMENT ON FUNCTION app_private.set_operator_action_snooze(
  text, text, text, timestamptz, bigint, text
) IS 'Caller must resolve action identity from the authoritative server-side queue; source identity must never be trusted from a browser form.';

COMMENT ON FUNCTION app_private.list_operator_action_assignable_members(integer)
  IS 'Bounded workspace assignment directory: managers see active writable members; ordinary writers see self; viewers see none.';

GRANT CREATE ON SCHEMA app_private TO r72_operator_action_definer;
ALTER FUNCTION app_private.set_operator_action_assignment(
  text, text, text, uuid, bigint, text
) OWNER TO r72_operator_action_definer;
ALTER FUNCTION app_private.set_operator_action_snooze(
  text, text, text, timestamptz, bigint, text
) OWNER TO r72_operator_action_definer;
ALTER FUNCTION app_private.list_operator_action_assignable_members(integer)
  OWNER TO r72_operator_action_definer;
REVOKE CREATE ON SCHEMA app_private FROM r72_operator_action_definer;

REVOKE ALL ON FUNCTION app_private.set_operator_action_assignment(
  text, text, text, uuid, bigint, text
) FROM PUBLIC, r72_web, r72_public, r72_worker, r72_webhook, r72_readonly,
  r72_identity_command, r72_provisioning_command,
  r72_setup_delivery_command, r72_setup_reissue_command,
  r72_external_event_command, r72_import_command,
  r72_content_command, r72_content_adapter,
  r72_mailgun_webhook_command, r72_mailgun_worker_command;
REVOKE ALL ON FUNCTION app_private.set_operator_action_snooze(
  text, text, text, timestamptz, bigint, text
) FROM PUBLIC, r72_web, r72_public, r72_worker, r72_webhook, r72_readonly,
  r72_identity_command, r72_provisioning_command,
  r72_setup_delivery_command, r72_setup_reissue_command,
  r72_external_event_command, r72_import_command,
  r72_content_command, r72_content_adapter,
  r72_mailgun_webhook_command, r72_mailgun_worker_command;
REVOKE ALL ON FUNCTION app_private.list_operator_action_assignable_members(integer)
FROM PUBLIC, r72_public, r72_worker, r72_webhook, r72_readonly,
  r72_crm_command, r72_identity_command, r72_provisioning_command,
  r72_setup_delivery_command, r72_setup_reissue_command,
  r72_external_event_command, r72_import_command,
  r72_content_command, r72_content_adapter,
  r72_mailgun_webhook_command, r72_mailgun_worker_command;

GRANT EXECUTE ON FUNCTION app_private.set_operator_action_assignment(
  text, text, text, uuid, bigint, text
) TO r72_crm_command;
GRANT EXECUTE ON FUNCTION app_private.set_operator_action_snooze(
  text, text, text, timestamptz, bigint, text
) TO r72_crm_command;
GRANT EXECUTE ON FUNCTION
  app_private.list_operator_action_assignable_members(integer)
TO r72_web;

INSERT INTO app_private.workspace_table_registry
  (schema_name, table_name, workspace_column)
VALUES
  ('app', 'operator_action_controls', 'workspace_id'),
  ('app', 'operator_action_control_events', 'workspace_id'),
  ('app', 'operator_action_command_receipts', 'workspace_id');

-- Fail the migration if any user-facing role accidentally gained a direct
-- mutation path, or if any provider/worker/webhook identity can observe this
-- human control plane. Only r72_crm_command may invoke its two primitives.
DO $operator_action_capability_check$
DECLARE
  table_name text;
  isolated_role text;
  assignment_oid oid := 'app_private.set_operator_action_assignment(text,text,text,uuid,bigint,text)'::regprocedure::oid;
  snooze_oid oid := 'app_private.set_operator_action_snooze(text,text,text,timestamp with time zone,bigint,text)'::regprocedure::oid;
  member_directory_oid oid := 'app_private.list_operator_action_assignable_members(integer)'::regprocedure::oid;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'operator_action_controls',
    'operator_action_control_events',
    'operator_action_command_receipts'
  ]
  LOOP
    IF pg_catalog.has_table_privilege('r72_web', 'app.' || table_name, 'INSERT')
       OR pg_catalog.has_table_privilege('r72_web', 'app.' || table_name, 'UPDATE')
       OR pg_catalog.has_table_privilege('r72_web', 'app.' || table_name, 'DELETE')
       OR (
         table_name <> 'operator_action_controls'
         AND pg_catalog.has_any_column_privilege(
           'r72_web', 'app.' || table_name, 'SELECT'
         )
       )
       OR pg_catalog.has_any_column_privilege(
         'r72_crm_command', 'app.' || table_name, 'SELECT'
       )
       OR pg_catalog.has_table_privilege('r72_crm_command', 'app.' || table_name, 'INSERT')
       OR pg_catalog.has_table_privilege('r72_crm_command', 'app.' || table_name, 'UPDATE')
       OR pg_catalog.has_table_privilege('r72_crm_command', 'app.' || table_name, 'DELETE') THEN
      RAISE EXCEPTION 'Unsafe direct Operator Action mutation capability on %', table_name;
    END IF;
  END LOOP;

  IF NOT pg_catalog.has_any_column_privilege(
       'r72_web', 'app.operator_action_controls', 'SELECT'
     ) THEN
    RAISE EXCEPTION 'Operator Action control overlay is not readable by r72_web';
  END IF;

  FOREACH isolated_role IN ARRAY ARRAY[
    'r72_public', 'r72_worker', 'r72_webhook', 'r72_readonly',
    'r72_identity_command', 'r72_provisioning_command',
    'r72_setup_delivery_command', 'r72_setup_reissue_command',
    'r72_external_event_command', 'r72_import_command',
    'r72_content_command', 'r72_content_adapter',
    'r72_mailgun_webhook_command', 'r72_mailgun_worker_command'
  ]
  LOOP
    FOREACH table_name IN ARRAY ARRAY[
      'operator_action_controls',
      'operator_action_control_events',
      'operator_action_command_receipts'
    ]
    LOOP
      IF pg_catalog.has_any_column_privilege(
           isolated_role, 'app.' || table_name, 'SELECT'
         )
         OR pg_catalog.has_table_privilege(
           isolated_role, 'app.' || table_name, 'INSERT'
         )
         OR pg_catalog.has_any_column_privilege(
           isolated_role, 'app.' || table_name, 'UPDATE'
         )
         OR pg_catalog.has_table_privilege(
           isolated_role, 'app.' || table_name, 'DELETE'
         ) THEN
        RAISE EXCEPTION 'Unsafe Operator Action capability: % can access %',
          isolated_role, table_name;
      END IF;
    END LOOP;

    IF pg_catalog.has_function_privilege(
         isolated_role, assignment_oid, 'EXECUTE'
       )
       OR pg_catalog.has_function_privilege(
         isolated_role, snooze_oid, 'EXECUTE'
       )
       OR pg_catalog.has_function_privilege(
         isolated_role, member_directory_oid, 'EXECUTE'
       ) THEN
      RAISE EXCEPTION 'Unsafe Operator Action command capability on %',
        isolated_role;
    END IF;
  END LOOP;

  IF NOT pg_catalog.has_function_privilege(
       'r72_crm_command', assignment_oid, 'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'r72_crm_command', snooze_oid, 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'Operator Action command functions are not bound to r72_crm_command';
  END IF;

  IF NOT pg_catalog.has_function_privilege(
       'r72_web', member_directory_oid, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'r72_crm_command', member_directory_oid, 'EXECUTE'
     )
     OR pg_catalog.has_column_privilege(
       'r72_operator_action_definer', 'app.users', 'email', 'SELECT'
     )
     OR pg_catalog.has_column_privilege(
       'r72_operator_action_definer', 'app.users', 'password_hash', 'SELECT'
     ) THEN
    RAISE EXCEPTION 'Operator Action member directory capability is not exact';
  END IF;
END;
$operator_action_capability_check$;
