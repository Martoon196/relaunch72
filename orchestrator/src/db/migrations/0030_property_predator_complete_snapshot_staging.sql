-- Immutable, manager-only staging for the Property Predator complete account
-- snapshot. This migration creates no live import, provider or event-ingress
-- switch: verified fixture/source bytes must still pass an explicit dry run.

DO $snapshot_role_shape$
DECLARE
  candidate record;
BEGIN
  SELECT rolname, rolcanlogin, rolsuper, rolinherit, rolcreaterole,
         rolcreatedb, rolreplication, rolbypassrls
  INTO candidate
  FROM pg_catalog.pg_roles
  WHERE rolname = 'r72_import_command';
  IF candidate.rolname IS NULL
     OR NOT candidate.rolcanlogin
     OR candidate.rolsuper
     OR candidate.rolinherit
     OR candidate.rolcreaterole
     OR candidate.rolcreatedb
     OR candidate.rolreplication
     OR candidate.rolbypassrls THEN
    RAISE EXCEPTION 'Unsafe role attributes: r72_import_command is not the expected capability role';
  END IF;
END
$snapshot_role_shape$;

SET LOCAL ROLE r72_owner;

-- The reviewed v2 source name is URI-shaped. Expand only the legacy batch
-- source-name grammar; every pre-v2 value remains valid.
ALTER TABLE app_private.legacy_lead_import_batches
  DROP CONSTRAINT legacy_lead_import_batches_source_system_check;
ALTER TABLE app_private.legacy_lead_import_batches
  ADD CONSTRAINT legacy_lead_import_batches_source_system_check CHECK (
    source_system = lower(btrim(source_system))
    AND source_system ~ '^[a-z][a-z0-9_.:/-]{0,99}$'
  );

GRANT USAGE ON SCHEMA app, app_private TO r72_import_command;
GRANT EXECUTE ON FUNCTION app_private.current_workspace_id(),
  app_private.current_user_id(), app_private.current_actor_kind(),
  app_private.current_request_id() TO r72_import_command;
GRANT EXECUTE ON FUNCTION app_private.can_manage_workspace(uuid, uuid)
  TO r72_import_command;

CREATE TABLE app_private.property_predator_snapshot_manifests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  schema_version smallint NOT NULL CHECK (schema_version = 2),
  source_system text NOT NULL CHECK (
    source_system = 'property-predator.accounts/v2'
  ),
  snapshot_id uuid NOT NULL,
  generated_at timestamptz NOT NULL,
  watermark timestamptz NOT NULL,
  complete boolean NOT NULL CHECK (complete),
  page_count integer NOT NULL CHECK (page_count BETWEEN 1 AND 10000),
  record_count integer NOT NULL CHECK (record_count BETWEEN 0 AND 10000),
  event_high_watermark numeric(20, 0) NOT NULL CHECK (
    event_high_watermark >= 0
    AND event_high_watermark <= 99999999999999999999::numeric
  ),
  content_sha256 bytea NOT NULL CHECK (octet_length(content_sha256) = 32),
  envelope_sha256 bytea NOT NULL CHECK (octet_length(envelope_sha256) = 32),
  source_metadata jsonb NOT NULL CHECK ((
    jsonb_typeof(source_metadata) = 'object'
    AND source_metadata ?& ARRAY[
      'schemaVersion', 'sourceSystem', 'snapshotId', 'generatedAt',
      'watermark', 'complete', 'manifest'
    ]
    AND source_metadata - ARRAY[
      'schemaVersion', 'sourceSystem', 'snapshotId', 'generatedAt',
      'watermark', 'complete', 'manifest'
    ] = '{}'::jsonb
    AND jsonb_typeof(source_metadata -> 'manifest') = 'object'
    AND (source_metadata -> 'manifest') ?& ARRAY[
      'pageCount', 'recordCount', 'eventHighWatermark', 'contentSha256'
    ]
    AND (source_metadata -> 'manifest') - ARRAY[
      'pageCount', 'recordCount', 'eventHighWatermark', 'contentSha256'
    ] = '{}'::jsonb
    AND source_metadata ->> 'sourceSystem' = source_system
    AND source_metadata ->> 'snapshotId' = snapshot_id::text
    AND (source_metadata ->> 'schemaVersion')::integer = 2
    AND (source_metadata ->> 'complete')::boolean
    AND (source_metadata ->> 'generatedAt')::timestamptz = generated_at
    AND (source_metadata ->> 'watermark')::timestamptz = watermark
    AND (source_metadata -> 'manifest' ->> 'pageCount')::integer = page_count
    AND (source_metadata -> 'manifest' ->> 'recordCount')::integer = record_count
    AND source_metadata -> 'manifest' ->> 'eventHighWatermark' = event_high_watermark::text
    AND source_metadata -> 'manifest' ->> 'contentSha256' = encode(content_sha256, 'hex')
  ) IS TRUE),
  consent_default text NOT NULL CHECK (consent_default = 'unknown'),
  created_by_user_id uuid NOT NULL,
  request_id text NOT NULL CHECK (
    request_id = btrim(request_id) AND length(request_id) BETWEEN 1 AND 200
  ),
  staged_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, id, source_system, snapshot_id),
  UNIQUE (workspace_id, source_system, snapshot_id),
  FOREIGN KEY (workspace_id, created_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK (watermark <= generated_at),
  CHECK (staged_at >= generated_at)
);

CREATE TABLE app_private.property_predator_snapshot_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  manifest_id uuid NOT NULL,
  source_system text NOT NULL CHECK (
    source_system = 'property-predator.accounts/v2'
  ),
  snapshot_id uuid NOT NULL,
  page_number integer NOT NULL CHECK (page_number BETWEEN 1 AND 10000),
  cursor text CHECK (
    cursor IS NULL OR (
      cursor = btrim(cursor) AND length(cursor) BETWEEN 1 AND 500
      AND cursor !~ '[[:cntrl:]]'
    )
  ),
  next_cursor text CHECK (
    next_cursor IS NULL OR (
      next_cursor = btrim(next_cursor) AND length(next_cursor) BETWEEN 1 AND 500
      AND next_cursor !~ '[[:cntrl:]]'
    )
  ),
  previous_page_sha256 bytea CHECK (
    previous_page_sha256 IS NULL OR octet_length(previous_page_sha256) = 32
  ),
  page_sha256 bytea NOT NULL CHECK (octet_length(page_sha256) = 32),
  record_count integer NOT NULL CHECK (record_count BETWEEN 0 AND 500),
  source_envelope jsonb NOT NULL CHECK ((
    jsonb_typeof(source_envelope) = 'object'
    AND source_envelope ?& ARRAY[
      'schemaVersion', 'sourceSystem', 'snapshotId', 'generatedAt',
      'watermark', 'complete', 'manifest', 'pages'
    ]
    AND source_envelope - ARRAY[
      'schemaVersion', 'sourceSystem', 'snapshotId', 'generatedAt',
      'watermark', 'complete', 'manifest', 'pages'
    ] = '{}'::jsonb
    AND source_envelope ->> 'sourceSystem' = source_system
    AND source_envelope ->> 'snapshotId' = snapshot_id::text
    AND (source_envelope ->> 'schemaVersion')::integer = 2
    AND (source_envelope ->> 'complete')::boolean
    AND jsonb_typeof(source_envelope -> 'manifest') = 'object'
    AND (source_envelope -> 'manifest') ?& ARRAY[
      'pageCount', 'recordCount', 'eventHighWatermark', 'contentSha256'
    ]
    AND (source_envelope -> 'manifest') - ARRAY[
      'pageCount', 'recordCount', 'eventHighWatermark', 'contentSha256'
    ] = '{}'::jsonb
    AND jsonb_typeof(source_envelope -> 'pages') = 'array'
    AND jsonb_array_length(source_envelope -> 'pages') = 1
    AND (source_envelope -> 'pages' -> 0) ?& ARRAY[
      'pageNumber', 'cursor', 'nextCursor', 'previousPageSha256',
      'records', 'pageSha256'
    ]
    AND (source_envelope -> 'pages' -> 0) - ARRAY[
      'pageNumber', 'cursor', 'nextCursor', 'previousPageSha256',
      'records', 'pageSha256'
    ] = '{}'::jsonb
    AND (source_envelope -> 'pages' -> 0 ->> 'pageNumber')::integer = page_number
    AND (source_envelope -> 'pages' -> 0 ->> 'cursor') IS NOT DISTINCT FROM cursor
    AND (source_envelope -> 'pages' -> 0 ->> 'nextCursor') IS NOT DISTINCT FROM next_cursor
    AND (source_envelope -> 'pages' -> 0 ->> 'previousPageSha256')
      IS NOT DISTINCT FROM CASE
        WHEN previous_page_sha256 IS NULL THEN NULL
        ELSE encode(previous_page_sha256, 'hex')
      END
    AND jsonb_typeof(source_envelope -> 'pages' -> 0 -> 'records') = 'array'
    AND jsonb_array_length(source_envelope -> 'pages' -> 0 -> 'records') = record_count
    AND source_envelope -> 'pages' -> 0 ->> 'pageSha256' = encode(page_sha256, 'hex')
  ) IS TRUE),
  staged_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, manifest_id, page_number),
  UNIQUE (workspace_id, manifest_id, page_sha256),
  FOREIGN KEY (workspace_id, manifest_id, source_system, snapshot_id)
    REFERENCES app_private.property_predator_snapshot_manifests
      (workspace_id, id, source_system, snapshot_id) ON DELETE CASCADE,
  CHECK ((page_number = 1) = (cursor IS NULL)),
  CHECK ((page_number = 1) = (previous_page_sha256 IS NULL))
);

CREATE TABLE app_private.property_predator_snapshot_quarantine (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  manifest_id uuid NOT NULL,
  source_system text NOT NULL CHECK (
    source_system = 'property-predator.accounts/v2'
  ),
  snapshot_id uuid NOT NULL,
  page_number integer NOT NULL CHECK (page_number BETWEEN 1 AND 10000),
  record_index integer NOT NULL CHECK (record_index BETWEEN 0 AND 499),
  account_id uuid NOT NULL,
  reason text NOT NULL CHECK (reason IN (
    'duplicate_account_id',
    'duplicate_verified_email',
    'duplicate_affiliate_id',
    'duplicate_affiliate_code',
    'missing_parent_affiliate',
    'self_parent_affiliate',
    'affiliate_parent_cycle',
    'duplicate_referral_id',
    'missing_attribution_affiliate',
    'invalid_attribution_affiliate',
    'attribution_affiliate_code_mismatch'
  )),
  quarantined_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, manifest_id, page_number, record_index, reason),
  FOREIGN KEY (workspace_id, manifest_id, source_system, snapshot_id)
    REFERENCES app_private.property_predator_snapshot_manifests
      (workspace_id, id, source_system, snapshot_id) ON DELETE CASCADE
);

CREATE INDEX property_predator_snapshot_manifests_workspace_time_idx
  ON app_private.property_predator_snapshot_manifests
    (workspace_id, staged_at DESC, id DESC);
CREATE INDEX property_predator_snapshot_quarantine_manifest_idx
  ON app_private.property_predator_snapshot_quarantine
    (workspace_id, manifest_id, page_number, record_index);

CREATE FUNCTION app_private.guard_property_predator_snapshot_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
DECLARE
  parent_manifest app_private.property_predator_snapshot_manifests%ROWTYPE;
  staged_account_id text;
BEGIN
  IF app_private.current_actor_kind() IS DISTINCT FROM 'user'
     OR app_private.current_user_id() IS NULL
     OR NEW.workspace_id IS DISTINCT FROM app_private.current_workspace_id()
     OR NOT app_private.can_manage_workspace(
       app_private.current_user_id(), app_private.current_workspace_id()
     ) THEN
    RAISE EXCEPTION 'Property Predator snapshot staging requires a workspace manager'
      USING ERRCODE = '42501';
  END IF;
  IF TG_TABLE_NAME = 'property_predator_snapshot_manifests' THEN
    IF NEW.created_by_user_id IS DISTINCT FROM app_private.current_user_id()
       OR NEW.request_id IS DISTINCT FROM app_private.current_request_id() THEN
      RAISE EXCEPTION 'Property Predator snapshot actor evidence is invalid'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'property_predator_snapshot_pages' THEN
    SELECT * INTO parent_manifest
    FROM app_private.property_predator_snapshot_manifests
    WHERE workspace_id = NEW.workspace_id
      AND id = NEW.manifest_id
      AND source_system = NEW.source_system
      AND snapshot_id = NEW.snapshot_id;
    IF NOT FOUND OR NOT ((
      (NEW.source_envelope ->> 'generatedAt')::timestamptz = parent_manifest.generated_at
      AND (NEW.source_envelope ->> 'watermark')::timestamptz = parent_manifest.watermark
      AND (NEW.source_envelope -> 'manifest' ->> 'pageCount')::integer
        = parent_manifest.page_count
      AND (NEW.source_envelope -> 'manifest' ->> 'recordCount')::integer
        = parent_manifest.record_count
      AND NEW.source_envelope -> 'manifest' ->> 'eventHighWatermark'
        = parent_manifest.event_high_watermark::text
      AND NEW.source_envelope -> 'manifest' ->> 'contentSha256'
        = encode(parent_manifest.content_sha256, 'hex')
    ) IS TRUE) THEN
      RAISE EXCEPTION 'Property Predator snapshot page does not match its manifest'
        USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'property_predator_snapshot_quarantine' THEN
    SELECT page.source_envelope #>> ARRAY[
      'pages', '0', 'records', NEW.record_index::text, 'account', 'id'
    ] INTO staged_account_id
    FROM app_private.property_predator_snapshot_pages AS page
    WHERE page.workspace_id = NEW.workspace_id
      AND page.manifest_id = NEW.manifest_id
      AND page.source_system = NEW.source_system
      AND page.snapshot_id = NEW.snapshot_id
      AND page.page_number = NEW.page_number;
    IF staged_account_id IS DISTINCT FROM NEW.account_id::text THEN
      RAISE EXCEPTION 'Property Predator quarantine does not identify its staged raw record'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;
REVOKE ALL ON FUNCTION app_private.guard_property_predator_snapshot_insert() FROM PUBLIC;

CREATE TRIGGER property_predator_snapshot_manifests_guard_insert
  BEFORE INSERT ON app_private.property_predator_snapshot_manifests
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_property_predator_snapshot_insert();
CREATE TRIGGER property_predator_snapshot_pages_guard_insert
  BEFORE INSERT ON app_private.property_predator_snapshot_pages
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_property_predator_snapshot_insert();
CREATE TRIGGER property_predator_snapshot_quarantine_guard_insert
  BEFORE INSERT ON app_private.property_predator_snapshot_quarantine
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_property_predator_snapshot_insert();

DO $snapshot_rls$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'property_predator_snapshot_manifests',
    'property_predator_snapshot_pages',
    'property_predator_snapshot_quarantine'
  ]
  LOOP
    EXECUTE format('ALTER TABLE app_private.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE app_private.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON app_private.%I FOR ALL TO r72_owner USING (true) WITH CHECK (true)',
      table_name || '_owner_all', table_name
    );
    EXECUTE format(
      'CREATE POLICY %I ON app_private.%I FOR SELECT TO r72_import_command USING (
         workspace_id = app_private.current_workspace_id()
         AND app_private.can_manage_workspace(
           app_private.current_user_id(), app_private.current_workspace_id()
         )
       )',
      table_name || '_manager_select', table_name
    );
    EXECUTE format(
      'CREATE POLICY %I ON app_private.%I FOR INSERT TO r72_import_command WITH CHECK (
         workspace_id = app_private.current_workspace_id()
         AND app_private.can_manage_workspace(
           app_private.current_user_id(), app_private.current_workspace_id()
         )
       )',
      table_name || '_manager_insert', table_name
    );
  END LOOP;
END
$snapshot_rls$;

GRANT SELECT, INSERT ON
  app_private.property_predator_snapshot_manifests,
  app_private.property_predator_snapshot_pages,
  app_private.property_predator_snapshot_quarantine
TO r72_import_command;

REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON
  app_private.property_predator_snapshot_manifests,
  app_private.property_predator_snapshot_pages,
  app_private.property_predator_snapshot_quarantine
FROM r72_import_command, r72_web, r72_worker, r72_webhook,
  r72_external_event_command, r72_crm_command;

INSERT INTO app_private.workspace_table_registry
  (schema_name, table_name, workspace_column)
VALUES
  ('app_private', 'property_predator_snapshot_manifests', 'workspace_id'),
  ('app_private', 'property_predator_snapshot_pages', 'workspace_id'),
  ('app_private', 'property_predator_snapshot_quarantine', 'workspace_id');

DO $snapshot_privilege_assertions$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'property_predator_snapshot_manifests',
    'property_predator_snapshot_pages',
    'property_predator_snapshot_quarantine'
  ]
  LOOP
    IF has_table_privilege('r72_import_command', 'app_private.' || table_name, 'UPDATE')
       OR has_table_privilege('r72_import_command', 'app_private.' || table_name, 'DELETE')
       OR has_table_privilege('r72_web', 'app_private.' || table_name, 'SELECT') THEN
      RAISE EXCEPTION 'Unsafe Property Predator snapshot privilege on %', table_name;
    END IF;
  END LOOP;
END
$snapshot_privilege_assertions$;
