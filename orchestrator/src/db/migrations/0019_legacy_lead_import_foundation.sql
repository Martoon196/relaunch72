-- Replay-safe legacy lead import foundation. A dry run uses SELECT only; an
-- explicit manager commit writes staged rows, CRM contacts and immutable
-- provenance. Source-specific extraction/adapters remain outside this boundary.

DO $legacy_import_role$
DECLARE
  unexpected_parent text;
  unexpected_member text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'r72_import_command'
  ) THEN
    CREATE ROLE r72_import_command LOGIN NOINHERIT;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles
    WHERE rolname = 'r72_import_command'
      AND rolcanlogin
      AND NOT rolinherit
      AND NOT rolsuper
      AND NOT rolcreatedb
      AND NOT rolcreaterole
      AND NOT rolreplication
      AND NOT rolbypassrls
  ) THEN
    RAISE EXCEPTION 'Unsafe role attributes: r72_import_command does not match the required capability shape';
  END IF;

  REVOKE r72_owner, r72_security_definer FROM r72_import_command;
  REVOKE r72_import_command FROM
    r72_web, r72_public, r72_worker, r72_webhook, r72_readonly,
    r72_crm_command, r72_identity_command, r72_provisioning_command,
    r72_setup_delivery_command, r72_setup_reissue_command,
    r72_external_event_command;

  SELECT parent.rolname
    INTO unexpected_parent
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
  JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
  WHERE member.rolname = 'r72_import_command'
  LIMIT 1;

  IF unexpected_parent IS NOT NULL THEN
    RAISE EXCEPTION 'Unsafe import command membership: r72_import_command can SET ROLE %',
      unexpected_parent;
  END IF;

  SELECT member.rolname
    INTO unexpected_member
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
  JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
  WHERE parent.rolname = 'r72_import_command'
    AND member.rolname <> current_user
  LIMIT 1;

  IF unexpected_member IS NOT NULL THEN
    RAISE EXCEPTION 'Unsafe import command grant: % can SET ROLE r72_import_command',
      unexpected_member;
  END IF;

  EXECUTE format('GRANT r72_import_command TO %I', current_user);
END
$legacy_import_role$;

SET LOCAL ROLE r72_owner;

-- Fail closed before granting the exact manager-only import capability.
REVOKE ALL ON SCHEMA app, app_private FROM r72_import_command;
REVOKE ALL ON ALL TABLES IN SCHEMA app FROM r72_import_command;
REVOKE ALL ON ALL TABLES IN SCHEMA app_private FROM r72_import_command;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app_private FROM r72_import_command;
GRANT USAGE ON SCHEMA app, app_private TO r72_import_command;
GRANT EXECUTE ON FUNCTION app_private.current_workspace_id() TO r72_import_command;
GRANT EXECUTE ON FUNCTION app_private.current_user_id() TO r72_import_command;
GRANT EXECUTE ON FUNCTION app_private.current_actor_kind() TO r72_import_command;
GRANT EXECUTE ON FUNCTION app_private.current_request_id() TO r72_import_command;
GRANT EXECUTE ON FUNCTION app_private.has_active_workspace_membership(uuid, uuid)
  TO r72_import_command;
GRANT EXECUTE ON FUNCTION app_private.can_manage_workspace(uuid, uuid)
  TO r72_import_command;

CREATE TABLE app_private.legacy_lead_import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  schema_version smallint NOT NULL CHECK (schema_version = 1),
  source_system text NOT NULL CHECK (
    source_system = lower(btrim(source_system))
    AND source_system ~ '^[a-z][a-z0-9_.:-]{0,99}$'
  ),
  batch_key text NOT NULL CHECK (
    batch_key = btrim(batch_key)
    AND batch_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  input_sha256 bytea NOT NULL CHECK (octet_length(input_sha256) = 32),
  status text NOT NULL DEFAULT 'staged' CHECK (
    status IN ('staged', 'committing', 'committed', 'committed_with_quarantine')
  ),
  row_count integer NOT NULL CHECK (row_count BETWEEN 1 AND 10000),
  imported_count integer NOT NULL DEFAULT 0 CHECK (imported_count >= 0),
  matched_count integer NOT NULL DEFAULT 0 CHECK (matched_count >= 0),
  replayed_count integer NOT NULL DEFAULT 0 CHECK (replayed_count >= 0),
  quarantined_count integer NOT NULL DEFAULT 0 CHECK (quarantined_count >= 0),
  report jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(report) = 'object'),
  created_by_user_id uuid NOT NULL,
  request_id text NOT NULL CHECK (
    request_id = btrim(request_id) AND length(request_id) BETWEEN 1 AND 200
  ),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  committed_at timestamptz,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, id, source_system),
  UNIQUE (workspace_id, source_system, batch_key),
  FOREIGN KEY (workspace_id, created_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK (imported_count + matched_count + replayed_count + quarantined_count <= row_count),
  CHECK ((status IN ('committed', 'committed_with_quarantine')) = (committed_at IS NOT NULL)),
  CHECK (committed_at IS NULL OR committed_at >= created_at)
);

CREATE INDEX legacy_lead_import_batches_workspace_time_idx
  ON app_private.legacy_lead_import_batches
    (workspace_id, created_at DESC, id DESC);

CREATE TABLE app_private.legacy_lead_import_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  batch_id uuid NOT NULL,
  source_system text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal > 0),
  source_record_id text NOT NULL CHECK (
    source_record_id = btrim(source_record_id)
    AND length(source_record_id) BETWEEN 1 AND 300
    AND source_record_id !~ '[[:cntrl:]]'
  ),
  source_payload jsonb NOT NULL CHECK (jsonb_typeof(source_payload) = 'object'),
  source_payload_sha256 bytea NOT NULL CHECK (octet_length(source_payload_sha256) = 32),
  original_created_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'staged' CHECK (
    status IN ('staged', 'imported', 'matched', 'replayed', 'quarantined')
  ),
  matched_contact_id uuid,
  import_receipt_id uuid,
  resolution jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(resolution) = 'object'),
  staged_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  committed_at timestamptz,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, id, batch_id, source_system, source_record_id, source_payload_sha256),
  UNIQUE (workspace_id, batch_id, ordinal),
  UNIQUE (workspace_id, batch_id, source_record_id),
  FOREIGN KEY (workspace_id, batch_id, source_system)
    REFERENCES app_private.legacy_lead_import_batches
      (workspace_id, id, source_system) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, matched_contact_id)
    REFERENCES app.contacts (workspace_id, id) ON DELETE RESTRICT,
  CHECK ((status = 'staged') = (committed_at IS NULL)),
  CHECK (status = 'staged' OR resolution <> '{}'::jsonb),
  CHECK (status = 'quarantined' OR status = 'staged' OR matched_contact_id IS NOT NULL),
  CHECK (import_receipt_id IS NULL OR matched_contact_id IS NOT NULL),
  CHECK (committed_at IS NULL OR committed_at >= staged_at)
);

CREATE INDEX legacy_lead_import_rows_batch_status_idx
  ON app_private.legacy_lead_import_rows
    (workspace_id, batch_id, status, ordinal);

-- Source integrity failures are retained as evidence without inventing a CRM
-- contact. This is the safe home for dangling affiliate/referral/commission
-- records until an operator can reconcile their missing source references.
CREATE TABLE app_private.legacy_lead_unresolved_attributions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  batch_id uuid NOT NULL,
  source_system text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal > 0),
  record_kind text NOT NULL CHECK (
    record_kind IN ('affiliate', 'referral', 'commission', 'attribution')
  ),
  source_record_id text NOT NULL CHECK (
    source_record_id = btrim(source_record_id)
    AND length(source_record_id) BETWEEN 1 AND 300
    AND source_record_id !~ '[[:cntrl:]]'
  ),
  referred_source_record_id text CHECK (
    referred_source_record_id IS NULL OR (
      referred_source_record_id = btrim(referred_source_record_id)
      AND length(referred_source_record_id) BETWEEN 1 AND 300
      AND referred_source_record_id !~ '[[:cntrl:]]'
    )
  ),
  affiliate_source_id text CHECK (
    affiliate_source_id IS NULL OR length(btrim(affiliate_source_id)) BETWEEN 1 AND 300
  ),
  affiliate_code text CHECK (
    affiliate_code IS NULL OR length(btrim(affiliate_code)) BETWEEN 1 AND 300
  ),
  referral_code text CHECK (
    referral_code IS NULL OR length(btrim(referral_code)) BETWEEN 1 AND 300
  ),
  source_payload jsonb NOT NULL CHECK (
    jsonb_typeof(source_payload) = 'object' AND source_payload <> '{}'::jsonb
  ),
  source_payload_sha256 bytea NOT NULL CHECK (octet_length(source_payload_sha256) = 32),
  original_created_at timestamptz NOT NULL,
  reason text NOT NULL CHECK (
    reason IN (
      'missing_contact', 'missing_affiliate_owner', 'broken_reference',
      'source_integrity_conflict'
    )
  ),
  quarantined_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (
    workspace_id, id, batch_id, source_system, record_kind,
    source_record_id, source_payload_sha256
  ),
  UNIQUE (workspace_id, batch_id, ordinal),
  UNIQUE (workspace_id, batch_id, record_kind, source_record_id),
  FOREIGN KEY (workspace_id, batch_id, source_system)
    REFERENCES app_private.legacy_lead_import_batches
      (workspace_id, id, source_system) ON DELETE CASCADE,
  CHECK (quarantined_at >= original_created_at)
);

CREATE INDEX legacy_lead_unresolved_source_idx
  ON app_private.legacy_lead_unresolved_attributions
    (workspace_id, source_system, record_kind, source_record_id);
CREATE INDEX legacy_lead_unresolved_referred_idx
  ON app_private.legacy_lead_unresolved_attributions
    (workspace_id, source_system, referred_source_record_id)
  WHERE referred_source_record_id IS NOT NULL;

-- One canonical receipt per source-owned unresolved record makes overlapping
-- full/incremental exports replay-safe. Batch staging may retain each export's
-- occurrence, while this ledger prevents the business fact being duplicated.
CREATE TABLE app_private.legacy_lead_unresolved_attribution_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  batch_id uuid NOT NULL,
  unresolved_row_id uuid NOT NULL,
  source_system text NOT NULL,
  record_kind text NOT NULL,
  source_record_id text NOT NULL,
  source_payload_sha256 bytea NOT NULL CHECK (octet_length(source_payload_sha256) = 32),
  original_created_at timestamptz NOT NULL,
  recorded_by_user_id uuid NOT NULL,
  request_id text NOT NULL CHECK (
    request_id = btrim(request_id) AND length(request_id) BETWEEN 1 AND 200
  ),
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, source_system, record_kind, source_record_id),
  FOREIGN KEY (
    workspace_id, unresolved_row_id, batch_id, source_system, record_kind,
    source_record_id, source_payload_sha256
  ) REFERENCES app_private.legacy_lead_unresolved_attributions (
    workspace_id, id, batch_id, source_system, record_kind,
    source_record_id, source_payload_sha256
  ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, recorded_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK (recorded_at >= original_created_at)
);

CREATE INDEX legacy_lead_unresolved_receipts_batch_idx
  ON app_private.legacy_lead_unresolved_attribution_receipts
    (workspace_id, batch_id, recorded_at DESC, id DESC);

CREATE TABLE app_private.legacy_lead_import_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  batch_id uuid NOT NULL,
  row_id uuid NOT NULL,
  source_system text NOT NULL,
  source_record_id text NOT NULL,
  source_payload_sha256 bytea NOT NULL CHECK (octet_length(source_payload_sha256) = 32),
  contact_id uuid NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('created', 'matched')),
  original_created_at timestamptz NOT NULL,
  imported_by_user_id uuid NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, id, contact_id),
  UNIQUE (
    workspace_id, id, contact_id, source_system, source_record_id,
    source_payload_sha256
  ),
  UNIQUE (workspace_id, source_system, source_record_id),
  FOREIGN KEY (
    workspace_id, row_id, batch_id, source_system, source_record_id,
    source_payload_sha256
  ) REFERENCES app_private.legacy_lead_import_rows (
    workspace_id, id, batch_id, source_system, source_record_id,
    source_payload_sha256
  ) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, contact_id)
    REFERENCES app.contacts (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, imported_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK (imported_at >= original_created_at)
);

CREATE INDEX legacy_lead_import_receipts_contact_idx
  ON app_private.legacy_lead_import_receipts
    (workspace_id, contact_id, imported_at DESC, id DESC);

ALTER TABLE app_private.legacy_lead_import_rows
  ADD CONSTRAINT legacy_lead_import_rows_receipt_fk
  FOREIGN KEY (workspace_id, import_receipt_id, matched_contact_id)
  REFERENCES app_private.legacy_lead_import_receipts
    (workspace_id, id, contact_id)
  ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

-- Sanitised, product-visible source provenance. The original canonical row
-- stays in the private staging boundary; no raw contact PII is exposed here.
CREATE TABLE app.contact_import_provenance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL,
  import_receipt_id uuid NOT NULL,
  source_system text NOT NULL,
  source_record_id text NOT NULL,
  source_payload_sha256 bytea NOT NULL CHECK (octet_length(source_payload_sha256) = 32),
  original_created_at timestamptz NOT NULL,
  imported_at timestamptz NOT NULL,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, id, contact_id, source_system, source_record_id),
  UNIQUE (workspace_id, source_system, source_record_id),
  FOREIGN KEY (
    workspace_id, import_receipt_id, contact_id, source_system,
    source_record_id, source_payload_sha256
  ) REFERENCES app_private.legacy_lead_import_receipts (
    workspace_id, id, contact_id, source_system,
    source_record_id, source_payload_sha256
  ) ON DELETE RESTRICT,
  CHECK (imported_at >= original_created_at)
);

CREATE INDEX contact_import_provenance_contact_idx
  ON app.contact_import_provenance
    (workspace_id, contact_id, original_created_at DESC, id DESC);

-- Legacy affiliate identifiers are source-owned strings, not fabricated UUIDs.
-- They can be reconciled to a canonical affiliate later without losing bytes.
CREATE TABLE app.contact_import_attribution_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL,
  provenance_id uuid NOT NULL,
  source_system text NOT NULL,
  source_record_id text NOT NULL,
  affiliate_source_id text CHECK (
    affiliate_source_id IS NULL OR length(btrim(affiliate_source_id)) BETWEEN 1 AND 300
  ),
  affiliate_name text CHECK (
    affiliate_name IS NULL OR length(btrim(affiliate_name)) BETWEEN 1 AND 300
  ),
  affiliate_code text CHECK (
    affiliate_code IS NULL OR length(btrim(affiliate_code)) BETWEEN 1 AND 300
  ),
  referral_code text CHECK (
    referral_code IS NULL OR length(btrim(referral_code)) BETWEEN 1 AND 300
  ),
  utm_source text CHECK (utm_source IS NULL OR length(btrim(utm_source)) BETWEEN 1 AND 300),
  utm_medium text CHECK (utm_medium IS NULL OR length(btrim(utm_medium)) BETWEEN 1 AND 300),
  utm_campaign text CHECK (utm_campaign IS NULL OR length(btrim(utm_campaign)) BETWEEN 1 AND 500),
  utm_term text CHECK (utm_term IS NULL OR length(btrim(utm_term)) BETWEEN 1 AND 500),
  utm_content text CHECK (utm_content IS NULL OR length(btrim(utm_content)) BETWEEN 1 AND 500),
  referrer_url text CHECK (referrer_url IS NULL OR length(btrim(referrer_url)) BETWEEN 1 AND 2048),
  landing_url text CHECK (landing_url IS NULL OR length(btrim(landing_url)) BETWEEN 1 AND 2048),
  attributed_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, id, contact_id, source_system, source_record_id),
  UNIQUE (workspace_id, source_system, source_record_id),
  FOREIGN KEY (
    workspace_id, provenance_id, contact_id, source_system, source_record_id
  ) REFERENCES app.contact_import_provenance (
    workspace_id, id, contact_id, source_system, source_record_id
  ) ON DELETE RESTRICT,
  CHECK (recorded_at >= attributed_at)
);

CREATE INDEX contact_import_attribution_contact_idx
  ON app.contact_import_attribution_facts
    (workspace_id, contact_id, attributed_at DESC, id DESC);
CREATE INDEX contact_import_attribution_affiliate_idx
  ON app.contact_import_attribution_facts
    (workspace_id, affiliate_source_id, attributed_at DESC, id DESC)
  WHERE affiliate_source_id IS NOT NULL;
CREATE INDEX contact_import_attribution_referral_idx
  ON app.contact_import_attribution_facts
    (workspace_id, referral_code, attributed_at DESC, id DESC)
  WHERE referral_code IS NOT NULL;

-- Exact source-owned attribution JSON is intentionally private. The ordinary
-- portal role sees only the typed fields above, never URL tokens, IP addresses,
-- provider metadata or PII an export may carry inside its raw object.
CREATE TABLE app_private.contact_import_attribution_payloads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  attribution_fact_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  source_system text NOT NULL,
  source_record_id text NOT NULL,
  raw_attribution jsonb NOT NULL CHECK (
    jsonb_typeof(raw_attribution) = 'object' AND raw_attribution <> '{}'::jsonb
  ),
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, attribution_fact_id),
  UNIQUE (workspace_id, source_system, source_record_id),
  FOREIGN KEY (
    workspace_id, attribution_fact_id, contact_id, source_system, source_record_id
  ) REFERENCES app.contact_import_attribution_facts (
    workspace_id, id, contact_id, source_system, source_record_id
  ) ON DELETE RESTRICT
);

-- Database-owned audit identity and timestamps. The import login cannot claim
-- another manager as the operator or backdate its own staging/commit actions.
CREATE FUNCTION app_private.guard_legacy_import_append()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app, app_private
AS $legacy_import_append$
BEGIN
  CASE TG_TABLE_NAME
    WHEN 'legacy_lead_import_batches' THEN
      NEW.created_by_user_id := app_private.current_user_id();
      NEW.request_id := app_private.current_request_id();
      NEW.created_at := statement_timestamp();
      NEW.status := 'staged';
      NEW.imported_count := 0;
      NEW.matched_count := 0;
      NEW.replayed_count := 0;
      NEW.quarantined_count := 0;
      NEW.report := '{}'::jsonb;
      NEW.committed_at := NULL;
    WHEN 'legacy_lead_import_rows' THEN
      NEW.status := 'staged';
      NEW.matched_contact_id := NULL;
      NEW.import_receipt_id := NULL;
      NEW.resolution := '{}'::jsonb;
      NEW.staged_at := statement_timestamp();
      NEW.committed_at := NULL;
    WHEN 'legacy_lead_import_receipts' THEN
      NEW.imported_by_user_id := app_private.current_user_id();
      NEW.imported_at := statement_timestamp();
    WHEN 'legacy_lead_unresolved_attributions' THEN
      NEW.quarantined_at := statement_timestamp();
    WHEN 'legacy_lead_unresolved_attribution_receipts' THEN
      NEW.recorded_by_user_id := app_private.current_user_id();
      NEW.request_id := app_private.current_request_id();
      NEW.recorded_at := statement_timestamp();
    WHEN 'contact_import_provenance' THEN
      NEW.imported_at := statement_timestamp();
    WHEN 'contact_import_attribution_facts' THEN
      NEW.recorded_at := statement_timestamp();
    WHEN 'contact_import_attribution_payloads' THEN
      NEW.recorded_at := statement_timestamp();
    ELSE
      RAISE EXCEPTION 'Unexpected legacy import append table: %', TG_TABLE_NAME;
  END CASE;
  RETURN NEW;
END
$legacy_import_append$;
REVOKE ALL ON FUNCTION app_private.guard_legacy_import_append() FROM PUBLIC;

CREATE TRIGGER legacy_lead_import_batches_guard_insert
  BEFORE INSERT ON app_private.legacy_lead_import_batches
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_legacy_import_append();
CREATE TRIGGER legacy_lead_import_rows_guard_insert
  BEFORE INSERT ON app_private.legacy_lead_import_rows
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_legacy_import_append();
CREATE TRIGGER legacy_lead_import_receipts_guard_insert
  BEFORE INSERT ON app_private.legacy_lead_import_receipts
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_legacy_import_append();
CREATE TRIGGER legacy_lead_unresolved_guard_insert
  BEFORE INSERT ON app_private.legacy_lead_unresolved_attributions
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_legacy_import_append();
CREATE TRIGGER legacy_lead_unresolved_receipts_guard_insert
  BEFORE INSERT ON app_private.legacy_lead_unresolved_attribution_receipts
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_legacy_import_append();
CREATE TRIGGER contact_import_provenance_guard_insert
  BEFORE INSERT ON app.contact_import_provenance
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_legacy_import_append();
CREATE TRIGGER contact_import_attribution_guard_insert
  BEFORE INSERT ON app.contact_import_attribution_facts
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_legacy_import_append();
CREATE TRIGGER contact_import_attribution_payload_guard_insert
  BEFORE INSERT ON app_private.contact_import_attribution_payloads
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_legacy_import_append();

CREATE FUNCTION app_private.guard_legacy_import_batch_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app, app_private
AS $legacy_import_batch_update$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
     OR NEW.source_system IS DISTINCT FROM OLD.source_system
     OR NEW.batch_key IS DISTINCT FROM OLD.batch_key
     OR NEW.input_sha256 IS DISTINCT FROM OLD.input_sha256
     OR NEW.row_count IS DISTINCT FROM OLD.row_count
     OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
     OR NEW.request_id IS DISTINCT FROM OLD.request_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Legacy import batch audit fields are immutable';
  END IF;

  IF OLD.status = 'staged' AND NEW.status = 'committing' THEN
    IF NEW.imported_count <> 0 OR NEW.matched_count <> 0
       OR NEW.replayed_count <> 0 OR NEW.quarantined_count <> 0
       OR NEW.report <> '{}'::jsonb OR NEW.committed_at IS NOT NULL THEN
      RAISE EXCEPTION 'Legacy import batch claim cannot forge a result';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'committing'
     AND NEW.status IN ('committed', 'committed_with_quarantine') THEN
    IF NEW.imported_count + NEW.matched_count + NEW.replayed_count
         + NEW.quarantined_count <> NEW.row_count
       OR NEW.report = '{}'::jsonb
       OR (NEW.quarantined_count > 0 AND NEW.status <> 'committed_with_quarantine')
       OR (NEW.quarantined_count = 0 AND NEW.status <> 'committed') THEN
      RAISE EXCEPTION 'Legacy import batch completion is internally inconsistent';
    END IF;
    NEW.committed_at := statement_timestamp();
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Legacy import batch status transition is not allowed';
END
$legacy_import_batch_update$;
REVOKE ALL ON FUNCTION app_private.guard_legacy_import_batch_update() FROM PUBLIC;
CREATE TRIGGER legacy_lead_import_batches_guard_update
  BEFORE UPDATE ON app_private.legacy_lead_import_batches
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_legacy_import_batch_update();

CREATE FUNCTION app_private.guard_legacy_import_row_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app, app_private
AS $legacy_import_row_update$
DECLARE
  receipt_outcome text;
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.batch_id IS DISTINCT FROM OLD.batch_id
     OR NEW.source_system IS DISTINCT FROM OLD.source_system
     OR NEW.ordinal IS DISTINCT FROM OLD.ordinal
     OR NEW.source_record_id IS DISTINCT FROM OLD.source_record_id
     OR NEW.source_payload IS DISTINCT FROM OLD.source_payload
     OR NEW.source_payload_sha256 IS DISTINCT FROM OLD.source_payload_sha256
     OR NEW.original_created_at IS DISTINCT FROM OLD.original_created_at
     OR NEW.staged_at IS DISTINCT FROM OLD.staged_at
     OR OLD.status <> 'staged'
     OR NEW.status NOT IN ('imported', 'matched', 'replayed', 'quarantined')
     OR NEW.resolution = '{}'::jsonb THEN
    RAISE EXCEPTION 'Legacy import row transition is not allowed';
  END IF;

  IF NEW.status = 'quarantined' THEN
    IF NEW.import_receipt_id IS NOT NULL THEN
      RAISE EXCEPTION 'Quarantined legacy rows cannot claim an import receipt';
    END IF;
  ELSE
    IF NEW.matched_contact_id IS NULL OR NEW.import_receipt_id IS NULL THEN
      RAISE EXCEPTION 'Resolved legacy rows require a contact and receipt';
    END IF;
    SELECT receipt.outcome
      INTO receipt_outcome
    FROM app_private.legacy_lead_import_receipts AS receipt
    WHERE receipt.workspace_id = NEW.workspace_id
      AND receipt.id = NEW.import_receipt_id
      AND receipt.contact_id = NEW.matched_contact_id;
    IF receipt_outcome IS NULL
       OR (NEW.status = 'imported' AND receipt_outcome <> 'created')
       OR (NEW.status = 'matched' AND receipt_outcome <> 'matched') THEN
      RAISE EXCEPTION 'Legacy import row receipt does not support its resolution';
    END IF;
  END IF;

  NEW.committed_at := statement_timestamp();
  RETURN NEW;
END
$legacy_import_row_update$;
REVOKE ALL ON FUNCTION app_private.guard_legacy_import_row_update() FROM PUBLIC;
CREATE TRIGGER legacy_lead_import_rows_guard_update
  BEFORE UPDATE ON app_private.legacy_lead_import_rows
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_legacy_import_row_update();

DO $legacy_import_rls$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'legacy_lead_import_batches',
    'legacy_lead_import_rows',
    'legacy_lead_import_receipts',
    'legacy_lead_unresolved_attributions',
    'legacy_lead_unresolved_attribution_receipts',
    'contact_import_attribution_payloads'
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

  FOREACH table_name IN ARRAY ARRAY[
    'contact_import_provenance',
    'contact_import_attribution_facts'
  ]
  LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON app.%I FOR ALL TO r72_owner USING (true) WITH CHECK (true)',
      table_name || '_owner_all', table_name
    );
    EXECUTE format(
      'CREATE POLICY %I ON app.%I FOR SELECT TO r72_web USING (
         workspace_id = app_private.current_workspace_id()
         AND app_private.has_active_workspace_membership(
           app_private.current_user_id(), app_private.current_workspace_id()
         )
       )',
      table_name || '_member_select', table_name
    );
    EXECUTE format(
      'CREATE POLICY %I ON app.%I FOR SELECT TO r72_import_command USING (
         workspace_id = app_private.current_workspace_id()
         AND app_private.can_manage_workspace(
           app_private.current_user_id(), app_private.current_workspace_id()
         )
       )',
      table_name || '_manager_select', table_name
    );
    EXECUTE format(
      'CREATE POLICY %I ON app.%I FOR INSERT TO r72_import_command WITH CHECK (
         workspace_id = app_private.current_workspace_id()
         AND app_private.can_manage_workspace(
           app_private.current_user_id(), app_private.current_workspace_id()
         )
       )',
      table_name || '_manager_insert', table_name
    );
  END LOOP;
END
$legacy_import_rls$;

CREATE POLICY legacy_lead_import_batches_manager_update
  ON app_private.legacy_lead_import_batches
  FOR UPDATE TO r72_import_command USING (
    workspace_id = app_private.current_workspace_id()
    AND app_private.can_manage_workspace(
      app_private.current_user_id(), app_private.current_workspace_id()
    )
  ) WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND app_private.can_manage_workspace(
      app_private.current_user_id(), app_private.current_workspace_id()
    )
  );

CREATE POLICY legacy_lead_import_rows_manager_update
  ON app_private.legacy_lead_import_rows
  FOR UPDATE TO r72_import_command USING (
    workspace_id = app_private.current_workspace_id()
    AND app_private.can_manage_workspace(
      app_private.current_user_id(), app_private.current_workspace_id()
    )
  ) WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND app_private.can_manage_workspace(
      app_private.current_user_id(), app_private.current_workspace_id()
    )
  );

-- Extend the existing CRM boundary only as far as import rehearsal/append.
CREATE POLICY contacts_import_manager_select ON app.contacts
  FOR SELECT TO r72_import_command USING (
    workspace_id = app_private.current_workspace_id()
    AND app_private.can_manage_workspace(
      app_private.current_user_id(), app_private.current_workspace_id()
    )
  );
CREATE POLICY contacts_import_manager_insert ON app.contacts
  FOR INSERT TO r72_import_command WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND app_private.can_manage_workspace(
      app_private.current_user_id(), app_private.current_workspace_id()
    )
  );
CREATE POLICY contact_points_import_manager_select ON app.contact_points
  FOR SELECT TO r72_import_command USING (
    workspace_id = app_private.current_workspace_id()
    AND app_private.can_manage_workspace(
      app_private.current_user_id(), app_private.current_workspace_id()
    )
  );
CREATE POLICY contact_points_import_manager_insert ON app.contact_points
  FOR INSERT TO r72_import_command WITH CHECK (
    workspace_id = app_private.current_workspace_id()
    AND app_private.can_manage_workspace(
      app_private.current_user_id(), app_private.current_workspace_id()
    )
  );

GRANT SELECT, INSERT ON app.contacts, app.contact_points TO r72_import_command;
GRANT SELECT, INSERT ON
  app.contact_import_provenance,
  app.contact_import_attribution_facts
TO r72_import_command;
GRANT SELECT ON
  app.contact_import_provenance,
  app.contact_import_attribution_facts
TO r72_web;

GRANT SELECT, INSERT ON
  app_private.legacy_lead_import_batches,
  app_private.legacy_lead_import_rows,
  app_private.legacy_lead_import_receipts,
  app_private.legacy_lead_unresolved_attributions,
  app_private.legacy_lead_unresolved_attribution_receipts,
  app_private.contact_import_attribution_payloads
TO r72_import_command;
GRANT UPDATE (
  status, imported_count, matched_count, replayed_count,
  quarantined_count, report, committed_at
) ON app_private.legacy_lead_import_batches TO r72_import_command;
GRANT UPDATE (
  status, matched_contact_id, import_receipt_id, resolution, committed_at
) ON app_private.legacy_lead_import_rows TO r72_import_command;

INSERT INTO app_private.workspace_table_registry
  (schema_name, table_name, workspace_column)
VALUES
  ('app_private', 'legacy_lead_import_batches', 'workspace_id'),
  ('app_private', 'legacy_lead_import_rows', 'workspace_id'),
  ('app_private', 'legacy_lead_import_receipts', 'workspace_id'),
  ('app_private', 'legacy_lead_unresolved_attributions', 'workspace_id'),
  ('app_private', 'legacy_lead_unresolved_attribution_receipts', 'workspace_id'),
  ('app_private', 'contact_import_attribution_payloads', 'workspace_id'),
  ('app', 'contact_import_provenance', 'workspace_id'),
  ('app', 'contact_import_attribution_facts', 'workspace_id');
