-- SEO blog production engine (owned brands). Additive only.
--
-- One brand = one canonical app.workspaces row in the creating owner's
-- organisation, created through app_private.seo_blog_create_brand with an
-- owner membership in the same transaction (idempotent per user command).
-- Blog records are workspace-scoped with FORCED RLS for the existing
-- r72_content_command identity:
--   * user actor:   workspace = app.workspace_id AND can_manage_workspace(user, workspace)
--   * worker actor: workspace = app.workspace_id
-- Article versions, usage and activity are append-only. Publications and jobs
-- are unique on their idempotency keys. No provider effect happens in SQL.

SET LOCAL ROLE r72_owner;

CREATE TABLE app.seo_blog_brands (
  workspace_id uuid PRIMARY KEY REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL REFERENCES app.organizations(id) ON DELETE RESTRICT,
  created_by_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  website text CHECK (website IS NULL OR (website ~ '^https?://[^/?#[:space:]]+$' AND length(website) <= 300)),
  settings jsonb NOT NULL CHECK (jsonb_typeof(settings) = 'object'),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE app.seo_blog_brand_commands (
  user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  command_id uuid NOT NULL,
  workspace_id uuid NOT NULL REFERENCES app.seo_blog_brands(workspace_id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (user_id, command_id)
);

-- Typed envelope for low-contention records whose shape is validated in the
-- application: knowledge versions, profiles, inventory, plans, briefs, destinations.
CREATE TABLE app.seo_blog_records (
  workspace_id uuid NOT NULL REFERENCES app.seo_blog_brands(workspace_id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('knowledge', 'profile', 'inventory', 'plan', 'brief', 'destination')),
  id text NOT NULL CHECK (length(id) BETWEEN 1 AND 120),
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object' AND octet_length(data::text) <= 4000000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, kind, id)
);

CREATE TABLE app.seo_blog_blobs (
  workspace_id uuid NOT NULL REFERENCES app.seo_blog_brands(workspace_id) ON DELETE RESTRICT,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  mime text CHECK (mime IS NULL OR length(mime) <= 120),
  bytes bytea NOT NULL CHECK (octet_length(bytes) BETWEEN 1 AND 20971520),
  sha256 bytea NOT NULL CHECK (octet_length(sha256) = 32),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id)
);

CREATE TABLE app.seo_blog_articles (
  workspace_id uuid NOT NULL REFERENCES app.seo_blog_brands(workspace_id) ON DELETE RESTRICT,
  id uuid NOT NULL,
  brief_id uuid NOT NULL,
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 80),
  publish_at timestamptz,
  held boolean NOT NULL DEFAULT false,
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, brief_id),
  UNIQUE (workspace_id, slug)
);
CREATE INDEX seo_blog_articles_due_idx ON app.seo_blog_articles (publish_at) WHERE publish_at IS NOT NULL AND NOT held;

CREATE TABLE app.seo_blog_article_versions (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL,
  article_id uuid NOT NULL,
  number integer NOT NULL CHECK (number > 0),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, article_id, number),
  FOREIGN KEY (workspace_id, article_id) REFERENCES app.seo_blog_articles(workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE app.seo_blog_publications (
  workspace_id uuid NOT NULL REFERENCES app.seo_blog_brands(workspace_id) ON DELETE RESTRICT,
  id uuid NOT NULL,
  article_id uuid NOT NULL,
  version_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 10 AND 400),
  state text NOT NULL CHECK (state IN ('prepared', 'submitted', 'outcome_unknown', 'verifying', 'published', 'failed', 'cancelled')),
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, idempotency_key),
  FOREIGN KEY (workspace_id, version_id) REFERENCES app.seo_blog_article_versions(workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX seo_blog_publications_open_idx ON app.seo_blog_publications (workspace_id)
  WHERE state IN ('prepared', 'submitted', 'outcome_unknown', 'verifying');

CREATE TABLE app.seo_blog_jobs (
  workspace_id uuid NOT NULL REFERENCES app.seo_blog_brands(workspace_id) ON DELETE RESTRICT,
  id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('inventory', 'plan', 'write', 'publish', 'daily')),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 3 AND 200),
  state text NOT NULL CHECK (state IN ('queued', 'running', 'done', 'failed', 'cancelled', 'blocked')),
  run_after timestamptz NOT NULL,
  lease_expires_at timestamptz,
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, idempotency_key)
);
CREATE INDEX seo_blog_jobs_runnable_idx ON app.seo_blog_jobs (workspace_id, run_after) WHERE state IN ('queued', 'running');

CREATE TABLE app.seo_blog_usage (
  workspace_id uuid NOT NULL REFERENCES app.seo_blog_brands(workspace_id) ON DELETE RESTRICT,
  id bigint GENERATED ALWAYS AS IDENTITY,
  kind text NOT NULL CHECK (kind IN ('model_tokens', 'search_calls', 'images')),
  amount bigint NOT NULL CHECK (amount >= 0),
  at timestamptz NOT NULL,
  reference text NOT NULL CHECK (length(reference) <= 200),
  PRIMARY KEY (workspace_id, id)
);

CREATE TABLE app.seo_blog_activity (
  workspace_id uuid NOT NULL REFERENCES app.seo_blog_brands(workspace_id) ON DELETE RESTRICT,
  id bigint GENERATED ALWAYS AS IDENTITY,
  at timestamptz NOT NULL,
  actor text NOT NULL CHECK (length(actor) <= 80),
  kind text NOT NULL CHECK (length(kind) <= 80),
  message text NOT NULL CHECK (length(message) <= 2000),
  subject_id text CHECK (subject_id IS NULL OR length(subject_id) <= 120),
  PRIMARY KEY (workspace_id, id)
);

-- Immutability for append-only history.
CREATE FUNCTION app_private.seo_blog_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $f$
BEGIN
  RAISE EXCEPTION 'SEO blog history is append-only' USING ERRCODE = '42501';
END $f$;
REVOKE ALL ON FUNCTION app_private.seo_blog_append_only() FROM PUBLIC;
CREATE TRIGGER seo_blog_versions_immutable BEFORE UPDATE OR DELETE ON app.seo_blog_article_versions
  FOR EACH ROW EXECUTE FUNCTION app_private.seo_blog_append_only();
CREATE TRIGGER seo_blog_usage_immutable BEFORE UPDATE OR DELETE ON app.seo_blog_usage
  FOR EACH ROW EXECUTE FUNCTION app_private.seo_blog_append_only();
CREATE TRIGGER seo_blog_activity_immutable BEFORE UPDATE OR DELETE ON app.seo_blog_activity
  FOR EACH ROW EXECUTE FUNCTION app_private.seo_blog_append_only();

-- Row-level security.
DO $rls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['seo_blog_brands', 'seo_blog_brand_commands', 'seo_blog_records', 'seo_blog_blobs', 'seo_blog_articles',
    'seo_blog_article_versions', 'seo_blog_publications', 'seo_blog_jobs', 'seo_blog_usage', 'seo_blog_activity']
  LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON app.%I FROM PUBLIC', t);
    EXECUTE format('CREATE POLICY %I ON app.%I FOR ALL TO r72_owner USING (true) WITH CHECK (true)', t || '_owner', t);
    IF t <> 'seo_blog_brand_commands' THEN
      EXECUTE format($p$CREATE POLICY %I ON app.%I FOR ALL TO r72_content_command
        USING (workspace_id = app_private.current_workspace_id() AND (
          (app_private.current_actor_kind() = 'user' AND app_private.can_manage_workspace(app_private.current_user_id(), workspace_id))
          OR app_private.current_actor_kind() = 'worker'))
        WITH CHECK (workspace_id = app_private.current_workspace_id() AND (
          (app_private.current_actor_kind() = 'user' AND app_private.can_manage_workspace(app_private.current_user_id(), workspace_id))
          OR app_private.current_actor_kind() = 'worker'))$p$, t || '_content', t);
    END IF;
  END LOOP;
END $rls$;

GRANT SELECT, UPDATE ON app.seo_blog_brands TO r72_content_command;
GRANT SELECT, INSERT, UPDATE ON app.seo_blog_records, app.seo_blog_articles, app.seo_blog_publications, app.seo_blog_jobs TO r72_content_command;
GRANT SELECT, INSERT ON app.seo_blog_blobs, app.seo_blog_article_versions, app.seo_blog_usage, app.seo_blog_activity TO r72_content_command;

INSERT INTO app_private.workspace_table_registry (schema_name, table_name, workspace_column)
SELECT 'app', t, 'workspace_id' FROM unnest(ARRAY['seo_blog_brands', 'seo_blog_records', 'seo_blog_blobs', 'seo_blog_articles',
  'seo_blog_article_versions', 'seo_blog_publications', 'seo_blog_jobs', 'seo_blog_usage', 'seo_blog_activity']) AS t;

-- Add brand: workspace + owner membership + blog brand row, atomically and
-- idempotently per (user, command). The organisation is the one that owns the
-- caller's currently selected workspace; the caller must be an organisation owner.
CREATE FUNCTION app_private.seo_blog_create_brand(p_command uuid, p_name text, p_slug text, p_website text, p_settings jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $f$
DECLARE
  actor uuid := app_private.current_user_id();
  current_ws uuid := app_private.current_workspace_id();
  org uuid;
  existing uuid;
  ws uuid;
  v_slug text;
  n integer := 1;
BEGIN
  IF app_private.current_actor_kind() <> 'user' OR actor IS NULL OR current_ws IS NULL OR p_command IS NULL THEN
    RAISE EXCEPTION 'Owner session required' USING ERRCODE = '42501';
  END IF;
  IF p_name IS NULL OR length(btrim(p_name)) NOT BETWEEN 2 AND 120 OR p_name ~ '[[:cntrl:]]'
     OR p_slug IS NULL OR p_slug !~ '^[a-z0-9][a-z0-9-]{1,59}$'
     OR (p_website IS NOT NULL AND (p_website !~ '^https?://[^/?#[:space:]]+$' OR length(p_website) > 300))
     OR p_settings IS NULL OR jsonb_typeof(p_settings) <> 'object' THEN
    RAISE EXCEPTION 'Invalid brand' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('seo-blog-brand:' || actor::text, 131));
  SELECT c.workspace_id INTO existing FROM app.seo_blog_brand_commands c WHERE c.user_id = actor AND c.command_id = p_command;
  IF existing IS NOT NULL THEN
    RETURN jsonb_build_object('workspaceId', existing, 'created', false);
  END IF;
  SELECT w.organization_id INTO org FROM app.workspaces w WHERE w.id = current_ws AND w.status = 'active';
  IF org IS NULL OR NOT EXISTS (
    SELECT 1 FROM app.organization_memberships m JOIN app.organizations o ON o.id = m.organization_id
    WHERE m.organization_id = org AND m.user_id = actor AND m.role = 'owner' AND m.status = 'active' AND m.revoked_at IS NULL AND o.status = 'active')
  THEN
    RAISE EXCEPTION 'Only an organisation owner can add brands' USING ERRCODE = '42501';
  END IF;
  v_slug := p_slug;
  WHILE EXISTS (SELECT 1 FROM app.workspaces w WHERE w.organization_id = org AND w.slug::text = v_slug) LOOP
    n := n + 1;
    v_slug := left(p_slug, 56) || '-' || n::text;
  END LOOP;
  INSERT INTO app.workspaces (organization_id, name, slug) VALUES (org, btrim(p_name), v_slug) RETURNING id INTO ws;
  INSERT INTO app.workspace_memberships (workspace_id, organization_id, user_id, role, status, source_organization_id, granted_by_user_id)
    VALUES (ws, org, actor, 'owner', 'active', org, actor);
  INSERT INTO app.seo_blog_brands (workspace_id, organization_id, created_by_user_id, website, settings)
    VALUES (ws, org, actor, p_website, p_settings);
  INSERT INTO app.seo_blog_brand_commands (user_id, command_id, workspace_id) VALUES (actor, p_command, ws);
  RETURN jsonb_build_object('workspaceId', ws, 'created', true);
END $f$;

CREATE FUNCTION app_private.seo_blog_list_brands()
RETURNS SETOF jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $f$
  SELECT jsonb_build_object('id', b.workspace_id, 'organizationId', b.organization_id, 'name', w.name, 'slug', w.slug::text,
    'website', b.website, 'locale', w.locale, 'timezone', w.timezone, 'settings', b.settings,
    'createdAt', b.created_at, 'createdBy', b.created_by_user_id, 'rowVersion', b.row_version)
  FROM app.seo_blog_brands b JOIN app.workspaces w ON w.id = b.workspace_id
  WHERE app_private.current_actor_kind() = 'user' AND w.status = 'active'
    AND app_private.can_manage_workspace(app_private.current_user_id(), b.workspace_id)
  ORDER BY w.name
$f$;

CREATE FUNCTION app_private.seo_blog_brand(p_workspace uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $f$
  SELECT jsonb_build_object('id', b.workspace_id, 'organizationId', b.organization_id, 'name', w.name, 'slug', w.slug::text,
    'website', b.website, 'locale', w.locale, 'timezone', w.timezone, 'settings', b.settings,
    'createdAt', b.created_at, 'createdBy', b.created_by_user_id, 'rowVersion', b.row_version)
  FROM app.seo_blog_brands b JOIN app.workspaces w ON w.id = b.workspace_id
  WHERE b.workspace_id = p_workspace AND p_workspace = app_private.current_workspace_id() AND w.status = 'active'
    AND ((app_private.current_actor_kind() = 'user' AND app_private.can_manage_workspace(app_private.current_user_id(), p_workspace))
      OR app_private.current_actor_kind() = 'worker')
$f$;

-- Brand basics live on the canonical workspace; only a manager of it may change them.
CREATE FUNCTION app_private.seo_blog_update_brand(p_workspace uuid, p_row_version bigint, p_website text, p_locale text, p_timezone text, p_settings jsonb)
RETURNS bigint LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $f$
DECLARE next_version bigint;
BEGIN
  IF p_workspace IS DISTINCT FROM app_private.current_workspace_id() OR NOT (
       (app_private.current_actor_kind() = 'user' AND app_private.can_manage_workspace(app_private.current_user_id(), p_workspace))
       OR app_private.current_actor_kind() = 'worker') THEN
    RAISE EXCEPTION 'Brand unavailable' USING ERRCODE = '42501';
  END IF;
  IF (p_website IS NOT NULL AND (p_website !~ '^https?://[^/?#[:space:]]+$' OR length(p_website) > 300))
     OR p_locale !~ '^[a-z]{2,3}(-[A-Z]{2})?$' OR length(p_timezone) NOT BETWEEN 1 AND 100 OR jsonb_typeof(p_settings) <> 'object' THEN
    RAISE EXCEPTION 'Invalid brand settings' USING ERRCODE = '22023';
  END IF;
  UPDATE app.seo_blog_brands SET website = p_website, settings = p_settings, row_version = row_version + 1, updated_at = clock_timestamp()
   WHERE workspace_id = p_workspace AND row_version = p_row_version RETURNING row_version INTO next_version;
  IF next_version IS NULL THEN RETURN NULL; END IF;
  UPDATE app.workspaces SET locale = p_locale, timezone = p_timezone, row_version = row_version + 1, updated_at = clock_timestamp()
   WHERE id = p_workspace AND (locale IS DISTINCT FROM p_locale OR timezone IS DISTINCT FROM p_timezone);
  RETURN next_version;
END $f$;

-- Worker discovery across brands: only ids, only for the worker actor.
CREATE FUNCTION app_private.seo_blog_active_workspaces(p_now timestamptz)
RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $f$
  SELECT DISTINCT x.workspace_id FROM (
    SELECT a.workspace_id FROM app.seo_blog_articles a WHERE a.publish_at <= p_now AND NOT a.held
    UNION SELECT p.workspace_id FROM app.seo_blog_publications p WHERE p.state IN ('prepared', 'submitted', 'outcome_unknown', 'verifying')
    UNION SELECT j.workspace_id FROM app.seo_blog_jobs j WHERE j.state IN ('queued', 'running')
    UNION SELECT b.workspace_id FROM app.seo_blog_brands b WHERE (b.settings ->> 'ongoingProduction')::boolean
  ) x
  WHERE app_private.current_actor_kind() = 'worker'
  LIMIT 500
$f$;

REVOKE ALL ON FUNCTION app_private.seo_blog_create_brand(uuid, text, text, text, jsonb), app_private.seo_blog_list_brands(), app_private.seo_blog_brand(uuid),
  app_private.seo_blog_update_brand(uuid, bigint, text, text, text, jsonb), app_private.seo_blog_active_workspaces(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.seo_blog_create_brand(uuid, text, text, text, jsonb), app_private.seo_blog_list_brands(), app_private.seo_blog_brand(uuid),
  app_private.seo_blog_update_brand(uuid, bigint, text, text, text, jsonb), app_private.seo_blog_active_workspaces(timestamptz) TO r72_content_command;
