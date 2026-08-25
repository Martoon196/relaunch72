-- Durable company-content intake, immutable versions and explicit approvals.
-- This migration does not call a provider, publish content or create a generic
-- polymorphic approval surface. Every request and decision is tied through
-- same-workspace foreign keys to one exact, hash-addressed content version.

DO $content_command_role$
DECLARE
  unexpected_parent text;
  unexpected_member text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'r72_content_command'
  ) THEN
    CREATE ROLE r72_content_command LOGIN NOINHERIT;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles
    WHERE rolname = 'r72_content_command'
      AND rolcanlogin
      AND NOT rolinherit
      AND NOT rolsuper
      AND NOT rolcreatedb
      AND NOT rolcreaterole
      AND NOT rolreplication
      AND NOT rolbypassrls
  ) THEN
    RAISE EXCEPTION 'Unsafe role attributes: r72_content_command does not match the required capability shape';
  END IF;

  REVOKE r72_owner, r72_security_definer FROM r72_content_command;
  REVOKE r72_content_command FROM
    r72_web, r72_public, r72_worker, r72_webhook, r72_readonly,
    r72_crm_command, r72_identity_command, r72_provisioning_command,
    r72_setup_delivery_command, r72_setup_reissue_command,
    r72_external_event_command, r72_import_command;

  SELECT parent.rolname
    INTO unexpected_parent
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
  JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
  WHERE member.rolname = 'r72_content_command'
  LIMIT 1;

  IF unexpected_parent IS NOT NULL THEN
    RAISE EXCEPTION 'Unsafe content command membership: r72_content_command can SET ROLE %',
      unexpected_parent;
  END IF;

  SELECT member.rolname
    INTO unexpected_member
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
  JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
  WHERE parent.rolname = 'r72_content_command'
    AND member.rolname <> current_user
  LIMIT 1;

  IF unexpected_member IS NOT NULL THEN
    RAISE EXCEPTION 'Unsafe content command grant: % can SET ROLE r72_content_command',
      unexpected_member;
  END IF;

  EXECUTE format('GRANT r72_content_command TO %I', current_user);
END
$content_command_role$;

SET LOCAL ROLE r72_owner;

REVOKE ALL ON SCHEMA app, app_private FROM r72_content_command;
REVOKE ALL ON ALL TABLES IN SCHEMA app FROM r72_content_command;
REVOKE ALL ON ALL TABLES IN SCHEMA app_private FROM r72_content_command;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app_private FROM r72_content_command;
REVOKE CREATE ON SCHEMA public FROM r72_content_command;
GRANT USAGE ON SCHEMA app, app_private TO r72_content_command;
GRANT EXECUTE ON FUNCTION app_private.current_workspace_id(),
  app_private.current_user_id(), app_private.current_actor_kind(),
  app_private.current_request_id(),
  app_private.has_active_workspace_membership(uuid, uuid),
  app_private.can_write_workspace(uuid, uuid),
  app_private.can_manage_workspace(uuid, uuid)
TO r72_content_command;

-- A logical item is only an identity. All editable/display facts live in an
-- immutable version so there is no mutable "current content" row to approve.
CREATE TABLE app.company_content_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  source_system text NOT NULL CHECK (
    source_system = btrim(source_system)
    AND length(source_system) BETWEEN 1 AND 100
    AND source_system ~ '^[A-Za-z][A-Za-z0-9_.:-]{0,99}$'
  ),
  source_item_id text NOT NULL CHECK (
    source_item_id = btrim(source_item_id)
    AND length(source_item_id) BETWEEN 1 AND 500
  ),
  created_by_user_id uuid NOT NULL,
  created_request_id text NOT NULL CHECK (
    created_request_id = btrim(created_request_id)
    AND length(created_request_id) BETWEEN 1 AND 128
  ),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, source_system, source_item_id),
  UNIQUE (workspace_id, id, source_system, source_item_id),
  FOREIGN KEY (workspace_id, created_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT
);

CREATE TABLE app.company_content_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  content_item_id uuid NOT NULL,
  version_number integer NOT NULL CHECK (version_number > 0),
  previous_version_id uuid,
  origin text NOT NULL CHECK (origin IN ('imported', 'generated', 'edited')),
  content_kind text NOT NULL CHECK (
    content_kind IN (
      'article', 'document', 'email', 'image', 'social_post',
      'video', 'webinar', 'other'
    )
  ),
  title text NOT NULL CHECK (
    title = btrim(title) AND length(title) BETWEEN 1 AND 300
  ),
  source_system text NOT NULL CHECK (
    source_system = btrim(source_system)
    AND length(source_system) BETWEEN 1 AND 100
    AND source_system ~ '^[A-Za-z][A-Za-z0-9_.:-]{0,99}$'
  ),
  source_item_id text NOT NULL CHECK (
    source_item_id = btrim(source_item_id)
    AND length(source_item_id) BETWEEN 1 AND 500
  ),
  source_version text NOT NULL CHECK (
    source_version = btrim(source_version)
    AND length(source_version) BETWEEN 1 AND 500
  ),
  content_mime_type text NOT NULL CHECK (
    content_mime_type = lower(btrim(content_mime_type))
    AND length(content_mime_type) BETWEEN 3 AND 100
    AND content_mime_type ~ '^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$'
  ),
  content_body text NOT NULL CHECK (
    octet_length(content_body) BETWEEN 1 AND 1048576
  ),
  content_sha256 bytea GENERATED ALWAYS AS (
    public.digest(pg_catalog.convert_to(content_body, 'UTF8'), 'sha256')
  ) STORED,
  blob_storage_key text NOT NULL CHECK (
    blob_storage_key = btrim(blob_storage_key)
    AND length(blob_storage_key) BETWEEN 1 AND 1024
  ),
  blob_sha256 bytea NOT NULL CHECK (octet_length(blob_sha256) = 32),
  brand_snapshot_ref text NOT NULL CHECK (
    brand_snapshot_ref = btrim(brand_snapshot_ref)
    AND length(brand_snapshot_ref) BETWEEN 1 AND 1024
  ),
  brand_sha256 bytea NOT NULL CHECK (octet_length(brand_sha256) = 32),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(metadata) = 'object'
    AND octet_length(metadata::text) <= 65536
  ),
  created_by_user_id uuid NOT NULL,
  created_request_id text NOT NULL CHECK (
    created_request_id = btrim(created_request_id)
    AND length(created_request_id) BETWEEN 1 AND 128
  ),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, content_item_id, id),
  UNIQUE (workspace_id, content_item_id, version_number),
  UNIQUE (workspace_id, source_system, source_item_id, source_version),
  UNIQUE (workspace_id, content_item_id, id, content_sha256),
  UNIQUE (
    workspace_id, content_item_id, id, source_system, source_item_id,
    source_version, content_sha256, blob_sha256, brand_sha256
  ),
  FOREIGN KEY (workspace_id, content_item_id)
    REFERENCES app.company_content_items (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, content_item_id, source_system, source_item_id)
    REFERENCES app.company_content_items (
      workspace_id, id, source_system, source_item_id
    ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, content_item_id, previous_version_id)
    REFERENCES app.company_content_versions (workspace_id, content_item_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, created_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK ((version_number = 1) = (previous_version_id IS NULL))
);

CREATE INDEX company_content_versions_item_created_idx
  ON app.company_content_versions
    (workspace_id, content_item_id, version_number DESC, id);

-- A source attestation is separate from human approval. It proves only that an
-- adapter checked this exact source/content/blob/brand tuple against one exact
-- source catalogue snapshot for a bounded period. Outbound work must require
-- both approval and an unexpired attestation; neither implies the other.
CREATE TABLE app.company_content_source_attestations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  content_item_id uuid NOT NULL,
  content_version_id uuid NOT NULL,
  source_system text NOT NULL,
  source_item_id text NOT NULL,
  source_version text NOT NULL,
  content_sha256 bytea NOT NULL CHECK (octet_length(content_sha256) = 32),
  blob_sha256 bytea NOT NULL CHECK (octet_length(blob_sha256) = 32),
  brand_sha256 bytea NOT NULL CHECK (octet_length(brand_sha256) = 32),
  source_catalog_sha256 bytea NOT NULL
    CHECK (octet_length(source_catalog_sha256) = 32),
  checked_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  attested_by_user_id uuid NOT NULL,
  attested_request_id text NOT NULL CHECK (
    attested_request_id = btrim(attested_request_id)
    AND length(attested_request_id) BETWEEN 1 AND 128
  ),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (
    workspace_id, content_version_id, source_catalog_sha256, checked_at
  ),
  FOREIGN KEY (
    workspace_id, content_item_id, content_version_id,
    source_system, source_item_id, source_version,
    content_sha256, blob_sha256, brand_sha256
  ) REFERENCES app.company_content_versions (
    workspace_id, content_item_id, id,
    source_system, source_item_id, source_version,
    content_sha256, blob_sha256, brand_sha256
  ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, attested_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK (checked_at >= created_at - interval '5 minutes'),
  CHECK (checked_at <= created_at + interval '30 seconds'),
  CHECK (expires_at > checked_at),
  CHECK (expires_at <= checked_at + interval '15 minutes')
);

CREATE INDEX company_content_source_attestations_current_idx
  ON app.company_content_source_attestations
    (workspace_id, content_item_id, content_version_id, checked_at DESC, id);

-- Requests bind the reviewer to the exact version and computed content digest.
CREATE TABLE app.company_content_approval_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  content_item_id uuid NOT NULL,
  content_version_id uuid NOT NULL,
  content_sha256 bytea NOT NULL CHECK (octet_length(content_sha256) = 32),
  request_number integer NOT NULL CHECK (request_number > 0),
  review_note text CHECK (
    review_note IS NULL OR (
      review_note = btrim(review_note)
      AND length(review_note) BETWEEN 1 AND 2000
    )
  ),
  requested_by_user_id uuid NOT NULL,
  requested_request_id text NOT NULL CHECK (
    requested_request_id = btrim(requested_request_id)
    AND length(requested_request_id) BETWEEN 1 AND 128
  ),
  requested_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, content_item_id, content_version_id, request_number),
  UNIQUE (
    workspace_id, content_item_id, content_version_id, id, content_sha256
  ),
  FOREIGN KEY (
    workspace_id, content_item_id, content_version_id, content_sha256
  ) REFERENCES app.company_content_versions (
    workspace_id, content_item_id, id, content_sha256
  ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, requested_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT
);

CREATE INDEX company_content_approval_requests_version_idx
  ON app.company_content_approval_requests
    (workspace_id, content_item_id, content_version_id, request_number DESC, id);

-- A request receives at most one immutable decision. A change or rejection is
-- followed by another explicit request (or, normally, another content version).
CREATE TABLE app.company_content_approval_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  content_item_id uuid NOT NULL,
  content_version_id uuid NOT NULL,
  approval_request_id uuid NOT NULL,
  content_sha256 bytea NOT NULL CHECK (octet_length(content_sha256) = 32),
  decision text NOT NULL CHECK (
    decision IN ('approved', 'rejected', 'changes_requested')
  ),
  decision_note text CHECK (
    decision_note IS NULL OR (
      decision_note = btrim(decision_note)
      AND length(decision_note) BETWEEN 1 AND 4000
    )
  ),
  decided_by_user_id uuid NOT NULL,
  decided_request_id text NOT NULL CHECK (
    decided_request_id = btrim(decided_request_id)
    AND length(decided_request_id) BETWEEN 1 AND 128
  ),
  decided_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, approval_request_id),
  FOREIGN KEY (
    workspace_id, content_item_id, content_version_id,
    approval_request_id, content_sha256
  ) REFERENCES app.company_content_approval_requests (
    workspace_id, content_item_id, content_version_id, id, content_sha256
  ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, decided_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK (decision = 'approved' OR decision_note IS NOT NULL)
);

CREATE INDEX company_content_approval_decisions_version_idx
  ON app.company_content_approval_decisions
    (workspace_id, content_item_id, content_version_id, decided_at DESC, id);

-- Direct command-role inserts remain fail-closed even if an application bug
-- submits a non-linear version or attempts to approve an already-stale one.
CREATE FUNCTION app_private.stamp_company_content_item_insert()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $function$
BEGIN
  NEW.created_by_user_id := app_private.current_user_id();
  NEW.created_request_id := app_private.current_request_id();
  NEW.created_at := statement_timestamp();
  RETURN NEW;
END
$function$;

CREATE FUNCTION app_private.guard_company_content_version_insert()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $function$
DECLARE
  previous_number integer;
  latest_number integer;
BEGIN
  NEW.created_by_user_id := app_private.current_user_id();
  NEW.created_request_id := app_private.current_request_id();
  NEW.created_at := statement_timestamp();

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'company-content:' || NEW.workspace_id::text || ':' || NEW.content_item_id::text,
      7200021
    )
  );

  SELECT max(version.version_number)
    INTO latest_number
  FROM app.company_content_versions AS version
  WHERE version.workspace_id = NEW.workspace_id
    AND version.content_item_id = NEW.content_item_id;

  IF latest_number IS NULL THEN
    IF NEW.version_number <> 1 OR NEW.previous_version_id IS NOT NULL THEN
      RAISE EXCEPTION 'first company content version must be version 1 without a predecessor'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT version.version_number
      INTO previous_number
    FROM app.company_content_versions AS version
    WHERE version.workspace_id = NEW.workspace_id
      AND version.content_item_id = NEW.content_item_id
      AND version.id = NEW.previous_version_id;

    IF previous_number IS NULL
       OR previous_number <> latest_number
       OR NEW.version_number <> latest_number + 1 THEN
      RAISE EXCEPTION 'company content versions must extend the current latest version'
        USING ERRCODE = '40001';
    END IF;
  END IF;

  RETURN NEW;
END
$function$;

CREATE FUNCTION app_private.guard_company_content_approval_request_insert()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $function$
DECLARE
  latest_version_id uuid;
  expected_request_number integer;
  latest_request_id uuid;
  latest_decision text;
BEGIN
  NEW.requested_by_user_id := app_private.current_user_id();
  NEW.requested_request_id := app_private.current_request_id();
  NEW.requested_at := statement_timestamp();

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'company-content:' || NEW.workspace_id::text || ':' || NEW.content_item_id::text,
      7200021
    )
  );

  SELECT version.id
    INTO latest_version_id
  FROM app.company_content_versions AS version
  WHERE version.workspace_id = NEW.workspace_id
    AND version.content_item_id = NEW.content_item_id
  ORDER BY version.version_number DESC, version.id
  LIMIT 1;

  IF latest_version_id IS DISTINCT FROM NEW.content_version_id THEN
    RAISE EXCEPTION 'approval may only be requested for the latest content version'
      USING ERRCODE = '40001';
  END IF;

  SELECT request.id, decision.decision
    INTO latest_request_id, latest_decision
  FROM app.company_content_approval_requests AS request
  LEFT JOIN app.company_content_approval_decisions AS decision
    ON decision.workspace_id = request.workspace_id
   AND decision.approval_request_id = request.id
  WHERE request.workspace_id = NEW.workspace_id
    AND request.content_item_id = NEW.content_item_id
    AND request.content_version_id = NEW.content_version_id
  ORDER BY request.request_number DESC, request.id
  LIMIT 1;

  IF latest_request_id IS NOT NULL AND latest_decision IS NULL THEN
    RAISE EXCEPTION 'content version already has a pending approval request'
      USING ERRCODE = '23505';
  END IF;
  IF latest_decision = 'approved' THEN
    RAISE EXCEPTION 'content version is already approved'
      USING ERRCODE = '23505';
  END IF;

  SELECT coalesce(max(request.request_number), 0) + 1
    INTO expected_request_number
  FROM app.company_content_approval_requests AS request
  WHERE request.workspace_id = NEW.workspace_id
    AND request.content_item_id = NEW.content_item_id
    AND request.content_version_id = NEW.content_version_id;

  IF NEW.request_number <> expected_request_number THEN
    RAISE EXCEPTION 'approval request number must be the next sequence value'
      USING ERRCODE = '40001';
  END IF;

  RETURN NEW;
END
$function$;

CREATE FUNCTION app_private.guard_company_content_source_attestation_insert()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $function$
BEGIN
  NEW.attested_by_user_id := app_private.current_user_id();
  NEW.attested_request_id := app_private.current_request_id();
  NEW.created_at := statement_timestamp();
  RETURN NEW;
END
$function$;

CREATE FUNCTION app_private.guard_company_content_approval_decision_insert()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $function$
DECLARE
  latest_version_id uuid;
BEGIN
  NEW.decided_by_user_id := app_private.current_user_id();
  NEW.decided_request_id := app_private.current_request_id();
  NEW.decided_at := statement_timestamp();

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'company-content:' || NEW.workspace_id::text || ':' || NEW.content_item_id::text,
      7200021
    )
  );

  SELECT version.id
    INTO latest_version_id
  FROM app.company_content_versions AS version
  WHERE version.workspace_id = NEW.workspace_id
    AND version.content_item_id = NEW.content_item_id
  ORDER BY version.version_number DESC, version.id
  LIMIT 1;

  IF latest_version_id IS DISTINCT FROM NEW.content_version_id THEN
    RAISE EXCEPTION 'a stale content version cannot receive a new approval decision'
      USING ERRCODE = '40001';
  END IF;

  RETURN NEW;
END
$function$;

CREATE FUNCTION app_private.reject_company_content_mutation()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $function$
BEGIN
  RAISE EXCEPTION 'company content versions and approval records are append-only'
    USING ERRCODE = '55000';
END
$function$;

-- Trigger functions are owned by r72_owner (the active migration role) and
-- are never an application-callable capability. PostgreSQL can still execute
-- them through their bound triggers after PUBLIC execution is removed.
REVOKE ALL ON FUNCTION app_private.stamp_company_content_item_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.guard_company_content_version_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.guard_company_content_source_attestation_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.guard_company_content_approval_request_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.guard_company_content_approval_decision_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.reject_company_content_mutation() FROM PUBLIC;

CREATE TRIGGER company_content_items_guard_insert
BEFORE INSERT ON app.company_content_items
FOR EACH ROW EXECUTE FUNCTION app_private.stamp_company_content_item_insert();

CREATE TRIGGER company_content_versions_guard_insert
BEFORE INSERT ON app.company_content_versions
FOR EACH ROW EXECUTE FUNCTION app_private.guard_company_content_version_insert();

CREATE TRIGGER company_content_approval_requests_guard_insert
BEFORE INSERT ON app.company_content_approval_requests
FOR EACH ROW EXECUTE FUNCTION app_private.guard_company_content_approval_request_insert();

CREATE TRIGGER company_content_source_attestations_guard_insert
BEFORE INSERT ON app.company_content_source_attestations
FOR EACH ROW EXECUTE FUNCTION app_private.guard_company_content_source_attestation_insert();

CREATE TRIGGER company_content_approval_decisions_guard_insert
BEFORE INSERT ON app.company_content_approval_decisions
FOR EACH ROW EXECUTE FUNCTION app_private.guard_company_content_approval_decision_insert();

DO $immutable_triggers$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'company_content_items', 'company_content_versions',
    'company_content_source_attestations',
    'company_content_approval_requests', 'company_content_approval_decisions'
  ]
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON app.%I
       FOR EACH ROW EXECUTE FUNCTION app_private.reject_company_content_mutation()',
      table_name || '_immutable', table_name
    );
  END LOOP;
END
$immutable_triggers$;

DO $content_rls$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'company_content_items', 'company_content_versions',
    'company_content_source_attestations',
    'company_content_approval_requests', 'company_content_approval_decisions'
  ]
  LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON app.%I FOR ALL TO r72_owner USING (true) WITH CHECK (true)',
      table_name || '_owner_all', table_name
    );
    EXECUTE format(
      'CREATE POLICY %I ON app.%I FOR SELECT TO r72_web, r72_content_command
       USING (
         workspace_id = app_private.current_workspace_id()
         AND app_private.has_active_workspace_membership(
           app_private.current_user_id(), workspace_id
         )
       )',
      table_name || '_member_select', table_name
    );
  END LOOP;
END
$content_rls$;

CREATE POLICY company_content_items_command_insert
  ON app.company_content_items FOR INSERT TO r72_content_command WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND created_by_user_id = app_private.current_user_id()
    AND created_request_id = app_private.current_request_id()
    AND app_private.can_write_workspace(created_by_user_id, workspace_id)
  );

CREATE POLICY company_content_versions_command_insert
  ON app.company_content_versions FOR INSERT TO r72_content_command WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND created_by_user_id = app_private.current_user_id()
    AND created_request_id = app_private.current_request_id()
    AND app_private.can_write_workspace(created_by_user_id, workspace_id)
  );

CREATE POLICY company_content_source_attestations_command_insert
  ON app.company_content_source_attestations
  FOR INSERT TO r72_content_command WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND attested_by_user_id = app_private.current_user_id()
    AND attested_request_id = app_private.current_request_id()
    AND app_private.can_write_workspace(attested_by_user_id, workspace_id)
  );

CREATE POLICY company_content_approval_requests_command_insert
  ON app.company_content_approval_requests FOR INSERT TO r72_content_command WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND requested_by_user_id = app_private.current_user_id()
    AND requested_request_id = app_private.current_request_id()
    AND app_private.can_write_workspace(requested_by_user_id, workspace_id)
  );

CREATE POLICY company_content_approval_decisions_manager_insert
  ON app.company_content_approval_decisions FOR INSERT TO r72_content_command WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND decided_by_user_id = app_private.current_user_id()
    AND decided_request_id = app_private.current_request_id()
    AND app_private.can_manage_workspace(decided_by_user_id, workspace_id)
  );

-- Reuse the established caller-scoped request hash/idempotency ledger. Only
-- this role's own receipts are visible and only terminal fields may change.
CREATE POLICY command_receipts_content_select ON app.command_receipts
  FOR SELECT TO r72_content_command USING (
    workspace_id = app_private.current_workspace_id()
    AND actor_user_id = app_private.current_user_id()
    AND app_private.has_active_workspace_membership(actor_user_id, workspace_id)
    AND command_name LIKE 'companyContent.%'
  );
CREATE POLICY command_receipts_content_insert ON app.command_receipts
  FOR INSERT TO r72_content_command WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND actor_user_id = app_private.current_user_id()
    AND app_private.can_write_workspace(actor_user_id, workspace_id)
    AND command_name LIKE 'companyContent.%'
    AND status = 'started'
  );
CREATE POLICY command_receipts_content_update ON app.command_receipts
  FOR UPDATE TO r72_content_command USING (
    workspace_id = app_private.current_workspace_id()
    AND actor_user_id = app_private.current_user_id()
    AND app_private.can_write_workspace(actor_user_id, workspace_id)
    AND command_name LIKE 'companyContent.%'
    AND status = 'started'
  ) WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND actor_user_id = app_private.current_user_id()
    AND app_private.can_write_workspace(actor_user_id, workspace_id)
    AND command_name LIKE 'companyContent.%'
    AND status IN ('succeeded', 'failed')
  );

GRANT SELECT ON app.company_content_items, app.company_content_versions,
  app.company_content_source_attestations,
  app.company_content_approval_requests, app.company_content_approval_decisions
TO r72_web, r72_content_command;
GRANT INSERT ON app.company_content_items, app.company_content_versions,
  app.company_content_source_attestations,
  app.company_content_approval_requests, app.company_content_approval_decisions
TO r72_content_command;
GRANT SELECT, INSERT ON app.command_receipts TO r72_content_command;
GRANT UPDATE (result, status, response_status, completed_at)
  ON app.command_receipts TO r72_content_command;

INSERT INTO app_private.workspace_table_registry
  (schema_name, table_name, workspace_column)
VALUES
  ('app', 'company_content_items', 'workspace_id'),
  ('app', 'company_content_versions', 'workspace_id'),
  ('app', 'company_content_source_attestations', 'workspace_id'),
  ('app', 'company_content_approval_requests', 'workspace_id'),
  ('app', 'company_content_approval_decisions', 'workspace_id');

-- Assert the migration leaves no table mutation path on the web identity and
-- no update/delete capability on immutable content tables for the command role.
DO $content_capability_check$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'company_content_items', 'company_content_versions',
    'company_content_source_attestations',
    'company_content_approval_requests', 'company_content_approval_decisions'
  ]
  LOOP
    IF pg_catalog.has_table_privilege('r72_web', 'app.' || table_name, 'INSERT')
       OR pg_catalog.has_table_privilege('r72_web', 'app.' || table_name, 'UPDATE')
       OR pg_catalog.has_table_privilege('r72_web', 'app.' || table_name, 'DELETE')
       OR pg_catalog.has_table_privilege('r72_content_command', 'app.' || table_name, 'UPDATE')
       OR pg_catalog.has_table_privilege('r72_content_command', 'app.' || table_name, 'DELETE') THEN
      RAISE EXCEPTION 'Unsafe company content table capability on %', table_name;
    END IF;
  END LOOP;
END
$content_capability_check$;
