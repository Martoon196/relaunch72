-- R72-CONTENT-CENTRAL-001: brand-owned social promotion of SEO blog articles.
--
-- Additive only. Migration 0131 is untouched. This file adds:
--   * app.seo_blog_social_bindings — one registered, verified Zernio account per
--     brand workspace and network, with owner-configured caps that start at
--     zero/off. PP's legacy 1/day 3/month path (0097 literal hashes) is kept
--     byte-for-byte; registered bindings take a separate hash/cap branch.
--   * app.seo_blog_social_job_caps — the exact caps a job was enqueued under, so
--     effect-time hash recomputation and cap rechecks always agree.
--   * narrow SEO branches for planning (0101 admits only the two PP source
--     systems), enqueue (0097 embeds daily=1;monthly=3) and effect readiness,
--     plus a worker-side exact-source JIT proof for delayed calendar slots that
--     re-reads the authoritative current article/version/URL.
-- No function here calls a provider. The calendar worker remains the only
-- process that can call Zernio, through the unchanged claim/begin/settle
-- boundary.

SET LOCAL ROLE r72_owner;

CREATE TABLE app.seo_blog_social_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.seo_blog_brands(workspace_id) ON DELETE RESTRICT,
  provider_connection_id uuid NOT NULL,
  environment text NOT NULL DEFAULT 'live' CHECK (environment = 'live'),
  network text NOT NULL CHECK (network IN ('instagram', 'linkedin')),
  zernio_account_id uuid NOT NULL,
  provider_profile_id_sha256 bytea NOT NULL CHECK (octet_length(provider_profile_id_sha256) = 32),
  -- The clear provider account id is an account identifier, not a credential.
  -- It is readable only through worker/owner definer functions; the digest
  -- must match the verified 0074 account row.
  provider_account_id text NOT NULL CHECK (provider_account_id ~ '^[a-f0-9]{24}$'),
  provider_account_id_sha256 bytea NOT NULL CHECK (octet_length(provider_account_id_sha256) = 32),
  daily_cap integer NOT NULL DEFAULT 0 CHECK (daily_cap BETWEEN 0 AND 24),
  monthly_cap integer NOT NULL DEFAULT 0 CHECK (monthly_cap BETWEEN 0 AND 300),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  registered_by_user_id uuid NOT NULL,
  registered_request_id text NOT NULL CHECK (length(registered_request_id) BETWEEN 1 AND 128),
  registered_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  revoked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, provider_connection_id, environment)
    REFERENCES app.provider_connections (workspace_id, id, environment) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, zernio_account_id)
    REFERENCES app.property_predator_zernio_accounts (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, registered_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  CHECK (provider_account_id_sha256 = public.digest(provider_account_id, 'sha256')),
  CHECK (updated_at >= registered_at)
);
CREATE UNIQUE INDEX seo_blog_social_bindings_active_network_uq
  ON app.seo_blog_social_bindings (workspace_id, network) WHERE status = 'active';

CREATE TABLE app.seo_blog_social_binding_events (
  workspace_id uuid NOT NULL REFERENCES app.seo_blog_brands(workspace_id) ON DELETE RESTRICT,
  id bigint GENERATED ALWAYS AS IDENTITY,
  binding_id uuid NOT NULL,
  event text NOT NULL CHECK (event IN ('registered', 'caps_changed', 'revoked')),
  daily_cap integer NOT NULL CHECK (daily_cap BETWEEN 0 AND 24),
  monthly_cap integer NOT NULL CHECK (monthly_cap BETWEEN 0 AND 300),
  actor_user_id uuid NOT NULL,
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, binding_id)
    REFERENCES app.seo_blog_social_bindings (workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE app.seo_blog_social_job_caps (
  workspace_id uuid NOT NULL REFERENCES app.seo_blog_brands(workspace_id) ON DELETE RESTRICT,
  job_id uuid NOT NULL,
  binding_id uuid NOT NULL,
  daily_cap integer NOT NULL CHECK (daily_cap BETWEEN 1 AND 24),
  monthly_cap integer NOT NULL CHECK (monthly_cap BETWEEN 1 AND 300),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (workspace_id, job_id),
  FOREIGN KEY (workspace_id, job_id)
    REFERENCES app.property_predator_owned_social_jobs (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, binding_id)
    REFERENCES app.seo_blog_social_bindings (workspace_id, id) ON DELETE RESTRICT
);

-- One Zernio profile (the provider's account group) per brand. The clear
-- profile id is a provider identifier the owner reads from their Zernio
-- dashboard, not a credential; it lets the server verify that brand's own
-- account lifecycle webhooks and prepare that brand's one-use OAuth handoff.
CREATE TABLE app.seo_blog_zernio_profiles (
  workspace_id uuid PRIMARY KEY REFERENCES app.seo_blog_brands(workspace_id) ON DELETE RESTRICT,
  provider_connection_id uuid NOT NULL,
  environment text NOT NULL DEFAULT 'live' CHECK (environment = 'live'),
  provider_profile_id text NOT NULL CHECK (provider_profile_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$'),
  provider_profile_id_sha256 bytea NOT NULL UNIQUE CHECK (octet_length(provider_profile_id_sha256) = 32),
  registered_by_user_id uuid NOT NULL,
  registered_request_id text NOT NULL CHECK (length(registered_request_id) BETWEEN 1 AND 128),
  registered_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  FOREIGN KEY (workspace_id, provider_connection_id, environment)
    REFERENCES app.provider_connections (workspace_id, id, environment) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, registered_by_user_id)
    REFERENCES app.workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CHECK (provider_profile_id_sha256 = public.digest(provider_profile_id, 'sha256'))
);

CREATE FUNCTION app_private.seo_blog_social_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $f$
BEGIN
  RAISE EXCEPTION 'SEO blog social history is immutable' USING ERRCODE = '42501';
END $f$;
REVOKE ALL ON FUNCTION app_private.seo_blog_social_immutable() FROM PUBLIC;
CREATE TRIGGER seo_blog_social_binding_events_immutable BEFORE UPDATE OR DELETE
  ON app.seo_blog_social_binding_events FOR EACH ROW EXECUTE FUNCTION app_private.seo_blog_social_immutable();
CREATE TRIGGER seo_blog_social_job_caps_immutable BEFORE UPDATE OR DELETE
  ON app.seo_blog_social_job_caps FOR EACH ROW EXECUTE FUNCTION app_private.seo_blog_social_immutable();
CREATE TRIGGER seo_blog_zernio_profiles_immutable BEFORE UPDATE OR DELETE
  ON app.seo_blog_zernio_profiles FOR EACH ROW EXECUTE FUNCTION app_private.seo_blog_social_immutable();

DO $rls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['seo_blog_social_bindings', 'seo_blog_social_binding_events', 'seo_blog_social_job_caps', 'seo_blog_zernio_profiles'] LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON app.%I FROM PUBLIC', t);
    EXECUTE format('CREATE POLICY %I ON app.%I FOR ALL TO r72_owner USING (true) WITH CHECK (true)', t || '_owner_all', t);
    -- Definer functions scope rows to the installed workspace; the worker
    -- discovery function reads every active binding under the worker actor.
    EXECUTE format($p$CREATE POLICY %I ON app.%I FOR ALL TO r72_owned_social_definer
      USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
        OR current_setting('app.actor_kind', true) IN ('worker', 'webhook'))
      WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)$p$, t || '_owned_social_definer_all', t);
  END LOOP;
END $rls$;

GRANT SELECT, INSERT, UPDATE ON app.seo_blog_social_bindings TO r72_owned_social_definer;
GRANT SELECT, INSERT ON app.seo_blog_social_binding_events, app.seo_blog_social_job_caps, app.seo_blog_zernio_profiles TO r72_owned_social_definer;

INSERT INTO app_private.workspace_table_registry (schema_name, table_name, workspace_column)
VALUES ('app', 'seo_blog_social_bindings', 'workspace_id'),
  ('app', 'seo_blog_social_binding_events', 'workspace_id'),
  ('app', 'seo_blog_social_job_caps', 'workspace_id'),
  ('app', 'seo_blog_zernio_profiles', 'workspace_id');

-- Read-only visibility of SEO brand/article/version state for the social
-- definer, used by the parent guard below. Writes stay with r72_content_command.
CREATE POLICY seo_blog_brands_owned_social_definer_select ON app.seo_blog_brands
  FOR SELECT TO r72_owned_social_definer USING (true);
CREATE POLICY seo_blog_articles_owned_social_definer_select ON app.seo_blog_articles
  FOR SELECT TO r72_owned_social_definer USING (true);
CREATE POLICY seo_blog_article_versions_owned_social_definer_select ON app.seo_blog_article_versions
  FOR SELECT TO r72_owned_social_definer USING (true);
GRANT SELECT ON app.seo_blog_brands, app.seo_blog_articles, app.seo_blog_article_versions
  TO r72_owned_social_definer;

-- A brand's own live Zernio provider connection row can be created by the
-- registration function; PP's existing row is never touched.
CREATE POLICY provider_connections_seo_blog_definer_insert ON app.provider_connections
  FOR INSERT TO r72_owned_social_definer
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND provider_id = 'zernio' AND provider_kind = 'social' AND environment = 'live');
GRANT INSERT ON app.provider_connections TO r72_owned_social_definer;

-- Worker discovery reads cross every registered brand under the worker actor
-- only; the user-actor paths keep their exact workspace scoping.
CREATE POLICY provider_connections_seo_blog_worker_discovery_select ON app.provider_connections
  FOR SELECT TO r72_owned_social_definer USING (current_setting('app.actor_kind', true) = 'worker');
CREATE POLICY zernio_accounts_seo_blog_worker_discovery_select ON app.property_predator_zernio_accounts
  FOR SELECT TO r72_owned_social_definer USING (current_setting('app.actor_kind', true) = 'worker');
CREATE POLICY seo_blog_brands_public_social_definer_select ON app.seo_blog_brands
  FOR SELECT TO r72_public_social_definer USING (true);
GRANT SELECT ON app.seo_blog_brands TO r72_public_social_definer;
GRANT SELECT, INSERT ON app.property_predator_zernio_calendar_target_promotions TO r72_owned_social_definer;

GRANT CREATE ON SCHEMA app_private TO r72_owned_social_definer;
SET LOCAL ROLE r72_owned_social_definer;

-- Parent guard: the exact article version the social post was derived from is
-- still the article's current version, carries the same content digest and
-- reviewed canonical URL, and (when required) is verified public at that URL.
CREATE FUNCTION app_private.seo_blog_assert_article_promotion(
  p_workspace_id uuid, p_article_id uuid, p_article_version_id uuid,
  p_article_content_sha256 text, p_canonical_url text, p_require_published boolean
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $function$
  SELECT p_workspace_id IS NOT NULL AND p_article_id IS NOT NULL AND p_article_version_id IS NOT NULL
    AND p_article_content_sha256 ~ '^[0-9a-f]{64}$'
    AND p_canonical_url IS NOT NULL AND p_canonical_url ~ '^https://[^[:space:]]+$' AND length(p_canonical_url) <= 500
    AND EXISTS (
      SELECT 1
      FROM app.seo_blog_brands AS brand
      JOIN app.seo_blog_articles AS article
        ON article.workspace_id = brand.workspace_id AND article.id = p_article_id
      JOIN app.seo_blog_article_versions AS version
        ON version.workspace_id = article.workspace_id AND version.article_id = article.id
       AND version.id = p_article_version_id
      WHERE brand.workspace_id = p_workspace_id
        AND version.content_sha256 = p_article_content_sha256
        AND version.data->>'contentSha' = p_article_content_sha256
        AND version.data->'promotionPack'->>'canonicalUrl' = p_canonical_url
        AND article.data->>'currentVersionId' = p_article_version_id::text
        AND (
          NOT p_require_published
          OR (article.data->>'delivery' = 'published'
            AND article.data->>'publishedVersionId' = p_article_version_id::text
            AND article.data->>'publishedUrl' = p_canonical_url)
        )
    );
$function$;

CREATE FUNCTION app_private.seo_blog_register_zernio_profile(
  p_workspace_id uuid, p_display_name text, p_provider_profile_id text
) RETURNS TABLE(provider_connection_id uuid, disposition text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE selected_user uuid; selected_id uuid; existing app.seo_blog_zernio_profiles%ROWTYPE;
BEGIN
  IF session_user <> 'r72_zernio_social_command'
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'user'
     OR coalesce(current_setting('app.user_id', true), '') !~ '^[0-9a-f-]{36}$'
     OR coalesce(current_setting('app.request_id', true), '') = ''
     OR p_display_name IS NULL OR p_display_name <> btrim(p_display_name)
     OR length(p_display_name) NOT BETWEEN 1 AND 120
     OR p_provider_profile_id IS NULL OR p_provider_profile_id !~ '^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$' THEN
    RAISE EXCEPTION 'SEO social connection denied' USING ERRCODE = '42501';
  END IF;
  selected_user := current_setting('app.user_id')::uuid;
  IF NOT EXISTS (
    SELECT 1 FROM app.workspace_memberships AS membership
    WHERE membership.workspace_id = p_workspace_id AND membership.user_id = selected_user
      AND membership.status = 'active' AND membership.role IN ('owner', 'admin')
  ) OR NOT EXISTS (SELECT 1 FROM app.seo_blog_brands AS brand WHERE brand.workspace_id = p_workspace_id) THEN
    RAISE EXCEPTION 'SEO social connection denied' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'seo-blog-zernio-connection:' || p_workspace_id::text, 7200132));
  SELECT profile.* INTO existing FROM app.seo_blog_zernio_profiles AS profile
  WHERE profile.workspace_id = p_workspace_id;
  IF FOUND THEN
    IF existing.provider_profile_id_sha256 <> public.digest(p_provider_profile_id, 'sha256') THEN
      RAISE EXCEPTION 'This brand already has a different Zernio profile registered' USING ERRCODE = '40001';
    END IF;
    RETURN QUERY SELECT existing.provider_connection_id, 'replayed'::text; RETURN;
  END IF;
  -- A profile belongs to exactly one brand; the webhook router resolves a
  -- brand from the profile digest, so two brands can never share one.
  IF EXISTS (
    SELECT 1 FROM app.seo_blog_zernio_profiles AS profile
    WHERE profile.provider_profile_id_sha256 = public.digest(p_provider_profile_id, 'sha256')
  ) THEN
    RAISE EXCEPTION 'That Zernio profile is registered to another brand' USING ERRCODE = '40001';
  END IF;
  SELECT connection.id INTO selected_id
  FROM app.provider_connections AS connection
  WHERE connection.workspace_id = p_workspace_id AND connection.provider_id = 'zernio'
    AND connection.provider_kind = 'social' AND connection.environment = 'live'
    AND connection.status <> 'disabled'
  ORDER BY connection.created_at LIMIT 1;
  IF NOT FOUND THEN
    selected_id := gen_random_uuid();
    INSERT INTO app.provider_connections (
      id, workspace_id, provider_id, provider_kind, environment, status,
      display_name, capabilities, created_by_user_id
    ) VALUES (
      selected_id, p_workspace_id, 'zernio', 'social', 'live', 'active',
      p_display_name, '["social.publish"]'::jsonb, selected_user
    );
  END IF;
  INSERT INTO app.seo_blog_zernio_profiles (
    workspace_id, provider_connection_id, provider_profile_id, provider_profile_id_sha256,
    registered_by_user_id, registered_request_id
  ) VALUES (
    p_workspace_id, selected_id, p_provider_profile_id, public.digest(p_provider_profile_id, 'sha256'),
    selected_user, current_setting('app.request_id')
  );
  RETURN QUERY SELECT selected_id, 'applied'::text;
END
$function$;

-- Owner/admin read of the brand's registered profile and live connection.
CREATE FUNCTION app_private.seo_blog_zernio_profile(p_workspace_id uuid)
RETURNS TABLE(provider_connection_id uuid, provider_profile_id text, registered_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $function$
  SELECT profile.provider_connection_id, profile.provider_profile_id, profile.registered_at
  FROM app.seo_blog_zernio_profiles AS profile
  WHERE session_user IN ('r72_zernio_social_command', 'r72_content_command')
    AND current_setting('app.workspace_id', true) = p_workspace_id::text
    AND current_setting('app.actor_kind', true) = 'user'
    AND coalesce(current_setting('app.user_id', true), '') ~ '^[0-9a-f-]{36}$'
    AND profile.workspace_id = p_workspace_id
    AND EXISTS (
      SELECT 1 FROM app.workspace_memberships AS membership
      WHERE membership.workspace_id = p_workspace_id
        AND membership.user_id = current_setting('app.user_id')::uuid
        AND membership.status = 'active' AND membership.role IN ('owner', 'admin'));
$function$;

-- Webhook routing: the signed account-lifecycle ingress resolves which brand a
-- provider profile belongs to before it verifies the event against that
-- brand's exact credential binding. PP's env-bound profiles are never here.
CREATE FUNCTION app_private.seo_blog_zernio_profile_workspace(p_provider_profile_id_sha256 bytea)
RETURNS TABLE(workspace_id uuid, provider_connection_id uuid, provider_profile_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $function$
  -- The registration row's foreign key pins the live Zernio connection; the
  -- receipt function re-checks that connection's status under the brand scope.
  SELECT profile.workspace_id, profile.provider_connection_id, profile.provider_profile_id
  FROM app.seo_blog_zernio_profiles AS profile
  WHERE session_user = 'r72_zernio_social_command'
    AND ((current_setting('app.actor_kind', true) = 'webhook'
          AND coalesce(current_setting('app.user_id', true), '') = '')
      OR (current_setting('app.actor_kind', true) = 'user'
          AND coalesce(current_setting('app.user_id', true), '') ~ '^[0-9a-f-]{36}$'))
    AND p_provider_profile_id_sha256 IS NOT NULL AND octet_length(p_provider_profile_id_sha256) = 32
    AND profile.provider_profile_id_sha256 = p_provider_profile_id_sha256;
$function$;

-- Owner registration of the brand's own verified account. Caps default to 0
-- (off) and are only ever set here by an owner/admin of that brand.
CREATE FUNCTION app_private.seo_blog_register_social_binding(
  p_workspace_id uuid, p_provider_connection_id uuid, p_network text,
  p_provider_account_id text, p_daily_cap integer, p_monthly_cap integer
) RETURNS TABLE(binding_id uuid, disposition text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE selected_user uuid; selected_account record; existing app.seo_blog_social_bindings%ROWTYPE;
  selected_id uuid; selected_disposition text;
BEGIN
  IF session_user <> 'r72_zernio_social_command'
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'user'
     OR coalesce(current_setting('app.user_id', true), '') !~ '^[0-9a-f-]{36}$'
     OR coalesce(current_setting('app.request_id', true), '') = ''
     OR p_network NOT IN ('instagram', 'linkedin')
     OR p_provider_account_id IS NULL OR p_provider_account_id !~ '^[a-f0-9]{24}$'
     OR p_daily_cap IS NULL OR p_daily_cap NOT BETWEEN 0 AND 24
     OR p_monthly_cap IS NULL OR p_monthly_cap NOT BETWEEN 0 AND 300 THEN
    RAISE EXCEPTION 'SEO social binding denied' USING ERRCODE = '42501';
  END IF;
  selected_user := current_setting('app.user_id')::uuid;
  IF NOT EXISTS (
    SELECT 1 FROM app.workspace_memberships AS membership
    WHERE membership.workspace_id = p_workspace_id AND membership.user_id = selected_user
      AND membership.status = 'active' AND membership.role IN ('owner', 'admin')
  ) OR NOT EXISTS (SELECT 1 FROM app.seo_blog_brands AS brand WHERE brand.workspace_id = p_workspace_id) THEN
    RAISE EXCEPTION 'SEO social binding denied' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'seo-blog-social-binding:' || p_workspace_id::text || ':' || p_network, 7200132));

  -- The account must be this brand's own verified, still-connected Zernio
  -- account on this brand's live connection. PP's accounts are never visible.
  SELECT account.id AS zernio_account_id, account.provider_profile_id_sha256
  INTO selected_account
  FROM app.property_predator_zernio_accounts AS account
  JOIN app.provider_connections AS connection
    ON connection.workspace_id = account.workspace_id AND connection.id = account.provider_connection_id
   AND connection.environment = account.environment
  WHERE account.workspace_id = p_workspace_id
    AND account.provider_connection_id = p_provider_connection_id
    AND account.network = p_network AND account.status = 'active'
    AND account.provider_account_id_sha256 = public.digest(p_provider_account_id, 'sha256')
    AND account.provider_profile_id_sha256 = (
      SELECT profile.provider_profile_id_sha256 FROM app.seo_blog_zernio_profiles AS profile
      WHERE profile.workspace_id = p_workspace_id AND profile.provider_connection_id = p_provider_connection_id)
    AND connection.provider_id = 'zernio' AND connection.provider_kind = 'social'
    AND connection.environment = 'live' AND connection.status = 'active'
    AND EXISTS (
      SELECT 1 FROM app.property_predator_zernio_account_webhook_receipts AS connected
      WHERE connected.workspace_id = account.workspace_id
        AND connected.provider_connection_id = account.provider_connection_id
        AND connected.event_type = 'account.connected' AND connected.network = account.network
        AND connected.provider_profile_id_sha256 = account.provider_profile_id_sha256
        AND connected.provider_account_id_sha256 = account.provider_account_id_sha256
        AND NOT EXISTS (
          SELECT 1 FROM app.property_predator_zernio_account_webhook_receipts AS disconnected
          WHERE disconnected.workspace_id = connected.workspace_id
            AND disconnected.provider_connection_id = connected.provider_connection_id
            AND disconnected.event_type = 'account.disconnected' AND disconnected.network = connected.network
            AND disconnected.provider_profile_id_sha256 = connected.provider_profile_id_sha256
            AND disconnected.provider_account_id_sha256 = connected.provider_account_id_sha256
            AND disconnected.occurred_at >= connected.occurred_at
        )
    );
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SEO social account is not a verified account of this brand' USING ERRCODE = '42501';
  END IF;

  SELECT binding.* INTO existing FROM app.seo_blog_social_bindings AS binding
  WHERE binding.workspace_id = p_workspace_id AND binding.network = p_network AND binding.status = 'active'
  FOR UPDATE;
  IF FOUND AND existing.provider_connection_id = p_provider_connection_id
     AND existing.zernio_account_id = selected_account.zernio_account_id THEN
    IF existing.daily_cap = p_daily_cap AND existing.monthly_cap = p_monthly_cap THEN
      RETURN QUERY SELECT existing.id, 'replayed'::text; RETURN;
    END IF;
    UPDATE app.seo_blog_social_bindings SET daily_cap = p_daily_cap, monthly_cap = p_monthly_cap,
      updated_at = statement_timestamp()
    WHERE workspace_id = p_workspace_id AND id = existing.id;
    INSERT INTO app.seo_blog_social_binding_events (workspace_id, binding_id, event, daily_cap, monthly_cap, actor_user_id, request_id)
    VALUES (p_workspace_id, existing.id, 'caps_changed', p_daily_cap, p_monthly_cap, selected_user, current_setting('app.request_id'));
    RETURN QUERY SELECT existing.id, 'caps_changed'::text; RETURN;
  END IF;
  IF FOUND THEN
    UPDATE app.seo_blog_social_bindings SET status = 'revoked', revoked_at = statement_timestamp(),
      updated_at = statement_timestamp()
    WHERE workspace_id = p_workspace_id AND id = existing.id;
    INSERT INTO app.seo_blog_social_binding_events (workspace_id, binding_id, event, daily_cap, monthly_cap, actor_user_id, request_id)
    VALUES (p_workspace_id, existing.id, 'revoked', existing.daily_cap, existing.monthly_cap, selected_user, current_setting('app.request_id'));
  END IF;
  selected_id := gen_random_uuid();
  INSERT INTO app.seo_blog_social_bindings (
    id, workspace_id, provider_connection_id, environment, network, zernio_account_id,
    provider_profile_id_sha256, provider_account_id, provider_account_id_sha256,
    daily_cap, monthly_cap, status, registered_by_user_id, registered_request_id
  ) VALUES (
    selected_id, p_workspace_id, p_provider_connection_id, 'live', p_network, selected_account.zernio_account_id,
    selected_account.provider_profile_id_sha256, p_provider_account_id, public.digest(p_provider_account_id, 'sha256'),
    p_daily_cap, p_monthly_cap, 'active', selected_user, current_setting('app.request_id')
  );
  INSERT INTO app.seo_blog_social_binding_events (workspace_id, binding_id, event, daily_cap, monthly_cap, actor_user_id, request_id)
  VALUES (p_workspace_id, selected_id, 'registered', p_daily_cap, p_monthly_cap, selected_user, current_setting('app.request_id'));
  selected_disposition := 'applied';
  RETURN QUERY SELECT selected_id, selected_disposition;
END
$function$;

CREATE FUNCTION app_private.seo_blog_revoke_social_binding(p_workspace_id uuid, p_binding_id uuid)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE selected_user uuid; existing app.seo_blog_social_bindings%ROWTYPE;
BEGIN
  IF session_user <> 'r72_zernio_social_command'
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'user'
     OR coalesce(current_setting('app.user_id', true), '') !~ '^[0-9a-f-]{36}$'
     OR coalesce(current_setting('app.request_id', true), '') = '' OR p_binding_id IS NULL THEN
    RAISE EXCEPTION 'SEO social binding denied' USING ERRCODE = '42501';
  END IF;
  selected_user := current_setting('app.user_id')::uuid;
  IF NOT EXISTS (
    SELECT 1 FROM app.workspace_memberships AS membership
    WHERE membership.workspace_id = p_workspace_id AND membership.user_id = selected_user
      AND membership.status = 'active' AND membership.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'SEO social binding denied' USING ERRCODE = '42501';
  END IF;
  SELECT binding.* INTO existing FROM app.seo_blog_social_bindings AS binding
  WHERE binding.workspace_id = p_workspace_id AND binding.id = p_binding_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF existing.status = 'revoked' THEN RETURN true; END IF;
  UPDATE app.seo_blog_social_bindings SET status = 'revoked', revoked_at = statement_timestamp(),
    updated_at = statement_timestamp()
  WHERE workspace_id = p_workspace_id AND id = p_binding_id;
  INSERT INTO app.seo_blog_social_binding_events (workspace_id, binding_id, event, daily_cap, monthly_cap, actor_user_id, request_id)
  VALUES (p_workspace_id, p_binding_id, 'revoked', existing.daily_cap, existing.monthly_cap, selected_user, current_setting('app.request_id'));
  RETURN true;
END
$function$;

CREATE FUNCTION app_private.seo_blog_social_bindings(p_workspace_id uuid)
RETURNS TABLE(
  binding_id uuid, provider_connection_id uuid, network text, zernio_account_id uuid,
  provider_account_id_sha256 text, username text, display_name text, account_status text,
  daily_cap integer, monthly_cap integer, status text, registered_at timestamptz, revoked_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $function$
  SELECT binding.id, binding.provider_connection_id, binding.network, binding.zernio_account_id,
    encode(binding.provider_account_id_sha256, 'hex'), account.username, account.display_name, account.status,
    binding.daily_cap, binding.monthly_cap, binding.status, binding.registered_at, binding.revoked_at
  FROM app.seo_blog_social_bindings AS binding
  JOIN app.property_predator_zernio_accounts AS account
    ON account.workspace_id = binding.workspace_id AND account.id = binding.zernio_account_id
  WHERE session_user IN ('r72_zernio_social_command', 'r72_content_command')
    AND current_setting('app.workspace_id', true) = p_workspace_id::text
    AND current_setting('app.actor_kind', true) = 'user'
    AND binding.workspace_id = p_workspace_id
    AND EXISTS (
      SELECT 1 FROM app.workspace_memberships AS membership
      WHERE membership.workspace_id = p_workspace_id
        AND membership.user_id = nullif(current_setting('app.user_id', true), '')::uuid
        AND membership.status = 'active' AND membership.role IN ('owner', 'admin')
    )
  ORDER BY binding.status, binding.network, binding.registered_at DESC;
$function$;

-- Server-authoritative worker discovery: every brand whose owner registered a
-- verified account with caps above zero. The worker never inherits PP's
-- environment accounts for these workspaces.
CREATE FUNCTION app_private.seo_blog_social_dispatch_targets()
RETURNS TABLE(
  workspace_id uuid, provider_connection_id uuid, network text,
  provider_account_id text, daily_cap integer, monthly_cap integer
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $function$
  SELECT binding.workspace_id, binding.provider_connection_id, binding.network,
    binding.provider_account_id, binding.daily_cap, binding.monthly_cap
  FROM app.seo_blog_social_bindings AS binding
  JOIN app.property_predator_zernio_accounts AS account
    ON account.workspace_id = binding.workspace_id AND account.id = binding.zernio_account_id
   AND account.status = 'active'
  JOIN app.provider_connections AS connection
    ON connection.workspace_id = binding.workspace_id AND connection.id = binding.provider_connection_id
   AND connection.provider_id = 'zernio' AND connection.provider_kind = 'social'
   AND connection.environment = 'live' AND connection.status = 'active'
  WHERE session_user = 'r72_owned_social_worker_command'
    AND current_setting('app.actor_kind', true) = 'worker'
    AND coalesce(current_setting('app.user_id', true), '') = ''
    AND binding.status = 'active' AND binding.daily_cap > 0 AND binding.monthly_cap > 0
  ORDER BY binding.workspace_id, binding.network
  LIMIT 500;
$function$;

-- Cap check used by begin-call. Legacy PP jobs (no caps row) keep the exact
-- 0085 predicate (day <= 1, month <= 3). Registered jobs use the LOWER of the
-- caps they were enqueued under and the brand's current caps, and stop when
-- the owner lowers a cap to zero or revokes the binding.
CREATE FUNCTION app_private.zernio_calendar_job_cap_ok(p_workspace_id uuid, p_job_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $function$
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM app.seo_blog_social_job_caps AS caps
      WHERE caps.workspace_id = p_workspace_id AND caps.job_id = p_job_id
    ) THEN EXISTS (
      SELECT 1 FROM app.property_predator_owned_social_jobs AS job
      WHERE job.workspace_id = p_workspace_id AND job.id = p_job_id
        AND (SELECT count(*) FROM app.property_predator_owned_social_jobs AS capped_day
          WHERE capped_day.workspace_id = job.workspace_id
            AND capped_day.provider_id = 'zernio'
            AND capped_day.zernio_account_id = job.zernio_account_id
            AND capped_day.network = job.network
            AND capped_day.utc_day = job.utc_day
            AND capped_day.state <> 'cancelled') <= 1
        AND (SELECT count(*) FROM app.property_predator_owned_social_jobs AS capped_month
          WHERE capped_month.workspace_id = job.workspace_id
            AND capped_month.provider_id = 'zernio'
            AND capped_month.zernio_account_id = job.zernio_account_id
            AND capped_month.network = job.network
            AND capped_month.utc_month = job.utc_month
            AND capped_month.state <> 'cancelled') <= 3
    )
    ELSE EXISTS (
      SELECT 1
      FROM app.property_predator_owned_social_jobs AS job
      JOIN app.seo_blog_social_job_caps AS caps
        ON caps.workspace_id = job.workspace_id AND caps.job_id = job.id
      JOIN app.seo_blog_social_bindings AS binding
        ON binding.workspace_id = caps.workspace_id AND binding.id = caps.binding_id
       AND binding.status = 'active' AND binding.network = job.network
       AND binding.zernio_account_id = job.zernio_account_id
       AND binding.provider_connection_id = job.provider_connection_id
      WHERE job.workspace_id = p_workspace_id AND job.id = p_job_id
        AND binding.daily_cap > 0 AND binding.monthly_cap > 0
        AND (SELECT count(*) FROM app.property_predator_owned_social_jobs AS capped_day
          WHERE capped_day.workspace_id = job.workspace_id
            AND capped_day.provider_id = 'zernio'
            AND capped_day.zernio_account_id = job.zernio_account_id
            AND capped_day.network = job.network
            AND capped_day.utc_day = job.utc_day
            AND capped_day.state <> 'cancelled') <= least(caps.daily_cap, binding.daily_cap)
        AND (SELECT count(*) FROM app.property_predator_owned_social_jobs AS capped_month
          WHERE capped_month.workspace_id = job.workspace_id
            AND capped_month.provider_id = 'zernio'
            AND capped_month.zernio_account_id = job.zernio_account_id
            AND capped_month.network = job.network
            AND capped_month.utc_month = job.utc_month
            AND capped_month.state <> 'cancelled') <= least(caps.monthly_cap, binding.monthly_cap)
    )
  END;
$function$;

-- Effect readiness for registered-brand jobs: the shared 0080 proof/approval
-- predicate, the 0085 binding predicate, the TEST-to-LIVE promotion, exact
-- hash recomputation under the enqueue caps, and the live parent guard.
CREATE FUNCTION app_private.seo_blog_zernio_job_effect_ready(p_workspace_id uuid, p_job_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $function$
  SELECT app_private.owned_social_job_effect_ready_v2(p_workspace_id, p_job_id)
    AND app_private.zernio_calendar_binding_ready(p_workspace_id, p_job_id)
    AND EXISTS (
      SELECT 1
      FROM app.property_predator_owned_social_jobs AS job
      JOIN app.seo_blog_social_job_caps AS caps
        ON caps.workspace_id = job.workspace_id AND caps.job_id = job.id
      JOIN app.seo_blog_social_bindings AS binding
        ON binding.workspace_id = caps.workspace_id AND binding.id = caps.binding_id
       AND binding.status = 'active' AND binding.network = job.network
       AND binding.zernio_account_id = job.zernio_account_id
       AND binding.provider_connection_id = job.provider_connection_id
       AND binding.daily_cap > 0 AND binding.monthly_cap > 0
      JOIN app.property_predator_zernio_calendar_target_promotions AS promotion
        ON promotion.workspace_id = job.workspace_id
       AND promotion.planning_intent_id = job.planning_intent_id
       AND promotion.planning_target_id = job.planning_target_id
       AND promotion.live_provider_connection_id = job.provider_connection_id
       AND promotion.provider_id = job.provider_id
       AND promotion.zernio_publish_binding_id = job.zernio_publish_binding_id
       AND promotion.zernio_account_id = job.zernio_account_id
       AND promotion.network = job.network
      JOIN app.public_social_planning_intent_targets AS planned_target
        ON planned_target.workspace_id = promotion.workspace_id
       AND planned_target.intent_id = promotion.planning_intent_id
       AND planned_target.target_id = promotion.planning_target_id
       AND planned_target.network = promotion.network
       AND planned_target.account_ref_sha256 = promotion.test_account_ref_sha256
      JOIN app.company_content_versions AS version
        ON version.workspace_id = job.workspace_id AND version.id = job.content_version_id
       AND version.content_item_id = job.content_item_id
      WHERE job.workspace_id = p_workspace_id AND job.id = p_job_id
        AND job.provider_id = 'zernio' AND job.profile_id IS NULL
        AND version.source_system = 'relaunch72.seo-blog'
        AND app_private.seo_blog_assert_article_promotion(
          job.workspace_id,
          nullif(version.metadata->>'articleId', '')::uuid,
          nullif(version.metadata->>'articleVersionId', '')::uuid,
          version.metadata->>'articleContentSha',
          version.metadata->>'canonicalUrl',
          true)
        AND job.idempotency_key_sha256 = public.digest(pg_catalog.concat_ws('|',
          'relaunch72.seo-blog-zernio-calendar-command/v1', job.workspace_id,
          promotion.test_provider_connection_id, job.provider_connection_id,
          promotion.id, job.network,
          encode(promotion.test_account_ref_sha256, 'hex'),
          encode(promotion.provider_profile_id_sha256, 'hex'),
          encode(promotion.provider_account_id_sha256, 'hex'),
          job.planning_intent_id, job.planning_target_id, job.content_item_id,
          job.content_version_id, job.approval_request_id,
          job.approval_decision_id, job.source_attestation_id,
          job.operation_tag,
          pg_catalog.floor(pg_catalog.date_part('epoch', job.scheduled_for) * 1000000)::bigint,
          encode(job.content_sha256, 'hex'), encode(job.text_sha256, 'hex'),
          'daily=' || caps.daily_cap::text || ';monthly=' || caps.monthly_cap::text,
          caps.binding_id
        ), 'sha256')
        AND job.request_sha256 = public.digest(pg_catalog.concat_ws('|',
          'relaunch72.seo-blog-zernio-calendar-job/v1', job.workspace_id,
          promotion.id, promotion.test_provider_connection_id,
          job.provider_connection_id, job.zernio_publish_binding_id,
          job.zernio_account_id, job.network,
          encode(promotion.test_account_ref_sha256, 'hex'),
          encode(promotion.provider_profile_id_sha256, 'hex'),
          encode(promotion.provider_account_id_sha256, 'hex'),
          job.planning_intent_id, job.planning_target_id, job.content_item_id,
          job.content_version_id, job.approval_request_id,
          job.approval_decision_id, job.source_attestation_id,
          job.operation_tag,
          pg_catalog.floor(pg_catalog.date_part('epoch', job.scheduled_for) * 1000000)::bigint,
          encode(job.content_sha256, 'hex'), encode(job.text_sha256, 'hex'),
          caps.binding_id
        ), 'sha256')
    );
$function$;

-- Same signature as 0097. Legacy PP jobs evaluate the unchanged 0097 predicate;
-- registered-brand jobs take the SEO branch. Nothing else is altered.
CREATE OR REPLACE FUNCTION app_private.zernio_calendar_job_effect_ready(
  p_workspace_id uuid, p_job_id uuid
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $function$
  SELECT (
    app_private.owned_social_job_effect_ready_v2(p_workspace_id, p_job_id)
    AND app_private.zernio_calendar_binding_ready(p_workspace_id, p_job_id)
    AND EXISTS (
      SELECT 1
      FROM app.property_predator_owned_social_jobs AS job
      JOIN app.property_predator_zernio_calendar_target_promotions AS promotion
        ON promotion.workspace_id = job.workspace_id
       AND promotion.planning_intent_id = job.planning_intent_id
       AND promotion.planning_target_id = job.planning_target_id
       AND promotion.live_provider_connection_id = job.provider_connection_id
       AND promotion.provider_id = job.provider_id
       AND promotion.zernio_publish_binding_id = job.zernio_publish_binding_id
       AND promotion.zernio_account_id = job.zernio_account_id
       AND promotion.network = job.network
      JOIN app.public_social_planning_intent_targets AS planned_target
        ON planned_target.workspace_id = promotion.workspace_id
       AND planned_target.intent_id = promotion.planning_intent_id
       AND planned_target.target_id = promotion.planning_target_id
       AND planned_target.provider_connection_id = promotion.test_provider_connection_id
       AND planned_target.network = promotion.network
       AND planned_target.environment = promotion.test_environment
       AND planned_target.account_ref_sha256 = promotion.test_account_ref_sha256
      JOIN app.public_social_targets AS registry
        ON registry.workspace_id = planned_target.workspace_id
       AND registry.id = planned_target.target_id
       AND registry.provider_connection_id = planned_target.provider_connection_id
       AND registry.network = planned_target.network
       AND registry.environment = planned_target.environment
       AND registry.account_ref_sha256 = planned_target.account_ref_sha256
      JOIN app.provider_connections AS test_connection
        ON test_connection.workspace_id = registry.workspace_id
       AND test_connection.id = registry.provider_connection_id
       AND test_connection.environment = registry.environment
      JOIN app.property_predator_zernio_publish_bindings AS binding
        ON binding.workspace_id = promotion.workspace_id
       AND binding.id = promotion.zernio_publish_binding_id
       AND binding.provider_connection_id = promotion.live_provider_connection_id
       AND binding.provider_id = promotion.provider_id
       AND binding.network = promotion.network
       AND binding.zernio_account_id = promotion.zernio_account_id
       AND binding.provider_profile_id_sha256 = promotion.provider_profile_id_sha256
       AND binding.provider_account_id_sha256 = promotion.provider_account_id_sha256
       AND binding.publish_capability_evidence_sha256 =
         promotion.publish_capability_evidence_sha256
       AND binding.ownership_evidence_sha256 = promotion.ownership_evidence_sha256
      JOIN app.property_predator_zernio_accounts AS account
        ON account.workspace_id = binding.workspace_id
       AND account.id = binding.zernio_account_id
       AND account.provider_connection_id = binding.provider_connection_id
       AND account.environment = binding.environment
       AND account.network = binding.network
       AND account.provider_profile_id_sha256 = binding.provider_profile_id_sha256
       AND account.provider_account_id_sha256 = binding.provider_account_id_sha256
      JOIN app.provider_connections AS live_connection
        ON live_connection.workspace_id = binding.workspace_id
       AND live_connection.id = binding.provider_connection_id
       AND live_connection.environment = binding.environment
      JOIN app.property_predator_zernio_account_webhook_receipts AS connected_receipt
        ON connected_receipt.workspace_id = promotion.workspace_id
       AND connected_receipt.event_id = promotion.connected_receipt_id
       AND connected_receipt.provider_connection_id = promotion.live_provider_connection_id
       AND connected_receipt.environment = promotion.live_environment
       AND connected_receipt.event_type = promotion.connected_event_type
       AND connected_receipt.network = promotion.network
       AND connected_receipt.provider_profile_id_sha256 =
         promotion.provider_profile_id_sha256
       AND connected_receipt.provider_account_id_sha256 =
         promotion.provider_account_id_sha256
       AND connected_receipt.receipt_sha256 = promotion.ownership_evidence_sha256
      WHERE job.workspace_id = p_workspace_id AND job.id = p_job_id
        AND job.provider_id = 'zernio' AND job.profile_id IS NULL
        AND promotion.test_environment = 'test'
        AND promotion.live_environment = 'live'
        AND promotion.connected_event_type = 'account.connected'
        AND registry.test_account_ref = 'test-account:' || job.network || ':'
          || encode(promotion.provider_account_id_sha256, 'hex')
        AND test_connection.provider_id = 'public_social_dark_simulator'
        AND test_connection.provider_kind = 'social'
        AND test_connection.environment = 'test'
        AND test_connection.status = 'active'
        AND test_connection.capabilities @> '["social.publish"]'::jsonb
        AND account.status = 'active'
        AND live_connection.provider_id = 'zernio'
        AND live_connection.provider_kind = 'social'
        AND live_connection.environment = 'live'
        AND live_connection.status = 'active'
        AND promotion.promotion_sha256 = public.digest(pg_catalog.concat_ws('|',
          'propertypredator.zernio-calendar-target-promotion/v1',
          promotion.workspace_id, promotion.id, promotion.planning_intent_id,
          promotion.planning_target_id, promotion.test_provider_connection_id,
          promotion.network, encode(promotion.test_account_ref_sha256, 'hex'),
          promotion.live_provider_connection_id,
          promotion.zernio_publish_binding_id, promotion.zernio_account_id,
          encode(promotion.provider_profile_id_sha256, 'hex'),
          encode(promotion.provider_account_id_sha256, 'hex'),
          promotion.connected_receipt_id,
          encode(promotion.ownership_evidence_sha256, 'hex'),
          encode(promotion.publish_capability_evidence_sha256, 'hex'),
          promotion.promoted_by_user_id, promotion.promoted_request_id,
          pg_catalog.floor(
            pg_catalog.date_part('epoch', promotion.promoted_at) * 1000000
          )::bigint
        ), 'sha256')
        AND job.idempotency_key_sha256 = public.digest(pg_catalog.concat_ws('|',
          'propertypredator.zernio-calendar-command/v2', job.workspace_id,
          promotion.test_provider_connection_id, job.provider_connection_id,
          promotion.id, job.network,
          encode(promotion.test_account_ref_sha256, 'hex'),
          encode(promotion.provider_profile_id_sha256, 'hex'),
          encode(promotion.provider_account_id_sha256, 'hex'),
          job.planning_intent_id, job.planning_target_id, job.content_item_id,
          job.content_version_id, job.approval_request_id,
          job.approval_decision_id, job.source_attestation_id,
          job.operation_tag,
          pg_catalog.floor(
            pg_catalog.date_part('epoch', job.scheduled_for) * 1000000
          )::bigint,
          encode(job.content_sha256, 'hex'), encode(job.text_sha256, 'hex'),
          'daily=1;monthly=3'
        ), 'sha256')
        AND job.request_sha256 = public.digest(pg_catalog.concat_ws('|',
          'propertypredator.zernio-calendar-job/v2', job.workspace_id,
          promotion.id, promotion.test_provider_connection_id,
          job.provider_connection_id, job.zernio_publish_binding_id,
          job.zernio_account_id, job.network,
          encode(promotion.test_account_ref_sha256, 'hex'),
          encode(promotion.provider_profile_id_sha256, 'hex'),
          encode(promotion.provider_account_id_sha256, 'hex'),
          job.planning_intent_id, job.planning_target_id, job.content_item_id,
          job.content_version_id, job.approval_request_id,
          job.approval_decision_id, job.source_attestation_id,
          job.operation_tag,
          pg_catalog.floor(
            pg_catalog.date_part('epoch', job.scheduled_for) * 1000000
          )::bigint,
          encode(job.content_sha256, 'hex'), encode(job.text_sha256, 'hex')
        ), 'sha256')
        AND NOT EXISTS (
          SELECT 1
          FROM app.property_predator_zernio_account_webhook_receipts AS disconnected
          WHERE disconnected.workspace_id = connected_receipt.workspace_id
            AND disconnected.provider_connection_id =
              connected_receipt.provider_connection_id
            AND disconnected.event_type = 'account.disconnected'
            AND disconnected.network = connected_receipt.network
            AND disconnected.provider_profile_id_sha256 =
              connected_receipt.provider_profile_id_sha256
            AND disconnected.provider_account_id_sha256 =
              connected_receipt.provider_account_id_sha256
            AND disconnected.occurred_at >= connected_receipt.occurred_at
        )
        AND NOT EXISTS (
          SELECT 1
          FROM app.property_predator_zernio_publish_binding_revocations AS revocation
          WHERE revocation.workspace_id = binding.workspace_id
            AND revocation.binding_id = binding.id
        )
    )
  ) OR app_private.seo_blog_zernio_job_effect_ready(p_workspace_id, p_job_id);
$function$;

-- Same signature and body as 0085 except that the two literal cap counts are
-- replaced by app_private.zernio_calendar_job_cap_ok, whose legacy branch
-- reproduces them exactly for jobs without a registered caps row.
CREATE OR REPLACE FUNCTION app_private.begin_zernio_calendar_call(
  p_workspace_id uuid, p_job_id uuid, p_lease_version bigint,
  p_lease_token bytea, p_provider_effects_enabled boolean,
  p_emergency_paused boolean
) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE changed integer; selected record; locked_content_item uuid;
BEGIN
  IF session_user <> 'r72_owned_social_worker_command'
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'worker'
     OR coalesce(current_setting('app.user_id', true), '') <> ''
     OR coalesce(current_setting('app.request_id', true), '') = ''
     OR p_lease_token IS NULL OR octet_length(p_lease_token) <> 32
     OR p_provider_effects_enabled IS DISTINCT FROM true
     OR p_emergency_paused IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'Zernio calendar begin-call denied' USING ERRCODE = '42501';
  END IF;

  SELECT job.planning_intent_id, job.planning_target_id, job.lease_attempt_kind,
    job.zernio_publish_binding_id, job.zernio_account_id, job.network
    INTO selected
  FROM app.property_predator_owned_social_jobs AS job
  JOIN app.property_predator_owned_social_job_leases AS lease
    ON lease.workspace_id = job.workspace_id AND lease.job_id = job.id
   AND lease.lease_version = job.lease_version
   AND lease.lease_token_sha256 = public.digest(p_lease_token, 'sha256')
  WHERE job.workspace_id = p_workspace_id AND job.id = p_job_id
    AND job.provider_id = 'zernio' AND job.profile_id IS NULL
    AND job.state = 'leased' AND job.lease_version = p_lease_version
    AND job.lease_expires_at > statement_timestamp();
  IF NOT FOUND THEN RETURN false; END IF;

  IF selected.lease_attempt_kind = 'publish' THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'public-social-planning-target:' || p_workspace_id::text || ':'
          || selected.planning_intent_id::text || ':'
          || selected.planning_target_id::text,
        7200040
      )
    );
  END IF;

  FOR locked_content_item IN
    SELECT content_identity.content_item_id
    FROM (
      SELECT job.content_item_id
      FROM app.property_predator_owned_social_jobs AS job
      WHERE job.workspace_id = p_workspace_id AND job.id = p_job_id
        AND job.provider_id = 'zernio'
      UNION
      SELECT media.content_item_id
      FROM app.property_predator_owned_social_job_media AS media
      JOIN app.property_predator_owned_social_jobs AS job
        ON job.workspace_id = media.workspace_id AND job.id = media.job_id
      WHERE media.workspace_id = p_workspace_id AND media.job_id = p_job_id
        AND job.provider_id = 'zernio'
    ) AS content_identity
    ORDER BY content_identity.content_item_id
  LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'company-content:' || p_workspace_id::text || ':'
          || locked_content_item::text,
        7200021
      )
    );
  END LOOP;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'zernio-calendar-publish-binding:' || p_workspace_id::text || ':'
        || selected.zernio_publish_binding_id::text,
      7200085
    )
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'zernio-calendar-publish-account:' || p_workspace_id::text || ':'
        || selected.zernio_account_id::text || ':' || selected.network,
      7200085
    )
  );

  SELECT job.planning_intent_id, job.planning_target_id,
    job.lease_attempt_kind, job.zernio_publish_binding_id,
    job.zernio_account_id, job.provider_connection_id, job.network
    INTO selected
  FROM app.property_predator_owned_social_jobs AS job
  JOIN app.property_predator_owned_social_job_leases AS lease
    ON lease.workspace_id = job.workspace_id AND lease.job_id = job.id
   AND lease.lease_version = job.lease_version
   AND lease.lease_token_sha256 = public.digest(p_lease_token, 'sha256')
  WHERE job.workspace_id = p_workspace_id AND job.id = p_job_id
    AND job.provider_id = 'zernio' AND job.profile_id IS NULL
    AND job.state = 'leased' AND job.lease_version = p_lease_version
    AND job.lease_expires_at > statement_timestamp()
  FOR UPDATE OF job;
  IF NOT FOUND THEN RETURN false; END IF;

  -- Freeze the exact provider connection, immutable binding and current active
  -- account status across the provider-call transition.
  PERFORM binding.id
  FROM app.property_predator_zernio_publish_bindings AS binding
  JOIN app.property_predator_zernio_accounts AS account
    ON account.workspace_id = binding.workspace_id
   AND account.id = binding.zernio_account_id
   AND account.provider_connection_id = binding.provider_connection_id
   AND account.provider_profile_id_sha256 = binding.provider_profile_id_sha256
   AND account.provider_account_id_sha256 = binding.provider_account_id_sha256
   AND account.network = binding.network
  JOIN app.provider_connections AS connection
    ON connection.workspace_id = binding.workspace_id
   AND connection.id = binding.provider_connection_id
   AND connection.environment = binding.environment
  WHERE binding.workspace_id = p_workspace_id
    AND binding.id = selected.zernio_publish_binding_id
    AND binding.zernio_account_id = selected.zernio_account_id
    AND binding.provider_connection_id = selected.provider_connection_id
    AND binding.provider_id = 'zernio' AND binding.network = selected.network
    AND account.status = 'active'
    AND connection.provider_id = 'zernio' AND connection.provider_kind = 'social'
    AND connection.environment = 'live' AND connection.status = 'active'
    AND NOT EXISTS (
      SELECT 1 FROM app.property_predator_zernio_publish_binding_revocations AS revocation
      WHERE revocation.workspace_id = binding.workspace_id
        AND revocation.binding_id = binding.id
    )
  ;
  IF NOT FOUND THEN RETURN false; END IF;

  UPDATE app.property_predator_owned_social_jobs AS job SET
    state = 'calling', calling_at = statement_timestamp(),
    updated_at = statement_timestamp()
  FROM app.property_predator_owned_social_job_leases AS lease
  WHERE job.workspace_id = p_workspace_id AND job.id = p_job_id
    AND job.provider_id = 'zernio' AND job.profile_id IS NULL
    AND job.state = 'leased' AND job.lease_version = p_lease_version
    AND job.lease_expires_at > statement_timestamp()
    AND lease.workspace_id = job.workspace_id AND lease.job_id = job.id
    AND lease.lease_version = job.lease_version
    AND lease.lease_token_sha256 = public.digest(p_lease_token, 'sha256')
    AND app_private.zernio_calendar_binding_ready(job.workspace_id, job.id)
    AND (job.lease_attempt_kind = 'reconcile' OR (
      app_private.zernio_calendar_job_effect_ready(job.workspace_id, job.id)
      AND job.utc_day = (statement_timestamp() AT TIME ZONE 'UTC')::date
      AND job.utc_month = date_trunc('month', statement_timestamp() AT TIME ZONE 'UTC')::date
      AND app_private.zernio_calendar_job_cap_ok(job.workspace_id, job.id)
    ));
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END
$function$;

-- Registered-brand enqueue. Mirrors 0097's connected-account command but binds
-- the brand's registry row, requires the SEO source/parent guard, embeds the
-- enqueue caps in the exact hashes and records them for effect-time checks.
-- Latent 0085 defect, exposed by the first real lease under this journey:
-- claim_zernio_calendar_job returns a column named job_id and also writes
-- `ON CONFLICT (workspace_id, job_id)` to the lease table, which PL/pgSQL
-- reports as an ambiguous reference the moment a job is actually claimable.
-- The body below is the exact 0085 text with one directive added at the top:
-- an ON CONFLICT target can only ever mean the table column.
CREATE OR REPLACE FUNCTION app_private.claim_zernio_calendar_job(
  p_workspace_id uuid, p_provider_connection_id uuid, p_networks text[],
  p_lease_token bytea, p_lease_seconds integer
) RETURNS TABLE(
  job_id uuid, binding_id uuid, zernio_account_id uuid,
  lease_version bigint, attempt_kind text, network text
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
#variable_conflict use_column
DECLARE selected app.property_predator_owned_social_jobs%ROWTYPE; selected_kind text;
  next_version bigint; recovered app.property_predator_owned_social_jobs%ROWTYPE;
BEGIN
  IF session_user <> 'r72_owned_social_worker_command'
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'worker'
     OR coalesce(current_setting('app.user_id', true), '') <> ''
     OR coalesce(current_setting('app.request_id', true), '') = ''
     OR p_networks IS NULL OR cardinality(p_networks) NOT BETWEEN 1 AND 2
     OR NOT (p_networks <@ ARRAY['instagram', 'linkedin']::text[])
     OR (SELECT count(DISTINCT requested.network_name)
           FROM unnest(p_networks) AS requested(network_name))
          <> cardinality(p_networks)
     OR p_lease_token IS NULL OR octet_length(p_lease_token) <> 32
     OR p_lease_seconds NOT BETWEEN 30 AND 300 THEN
    RAISE EXCEPTION 'Zernio calendar claim denied' USING ERRCODE = '42501';
  END IF;

  FOR recovered IN
    SELECT job.* FROM app.property_predator_owned_social_jobs AS job
    WHERE job.workspace_id = p_workspace_id
      AND job.provider_id = 'zernio'
      AND job.provider_connection_id = p_provider_connection_id
      AND job.network = ANY(p_networks)
      AND job.state IN ('leased', 'calling')
      AND job.lease_expires_at <= statement_timestamp()
    ORDER BY job.lease_expires_at, job.id
    FOR UPDATE SKIP LOCKED
  LOOP
    IF recovered.state = 'calling' THEN
      INSERT INTO app.property_predator_owned_social_receipts (
        workspace_id, job_id, lease_version, provider_id, attempt_kind, event_kind,
        provider_external_id, receipt_sha256, safe_code, provider_occurred_at
      ) VALUES (
        recovered.workspace_id, recovered.id, recovered.lease_version,
        'zernio', recovered.lease_attempt_kind, 'outcome_unknown',
        recovered.provider_external_id,
        public.digest(
          format('zernio_worker_call_lease_expired:%s:%s',
            recovered.id, recovered.lease_version),
          'sha256'
        ),
        'zernio_worker_call_lease_expired_unknown', statement_timestamp()
      ) ON CONFLICT (workspace_id, job_id, lease_version) DO NOTHING;
    END IF;
    UPDATE app.property_predator_owned_social_jobs SET
      state = CASE
        WHEN recovered.state = 'calling' THEN 'needs_attention'
        WHEN recovered.lease_attempt_kind = 'publish' THEN 'queued'
        ELSE 'reconciliation_pending'
      END,
      available_at = CASE WHEN recovered.lease_attempt_kind = 'publish'
        THEN statement_timestamp() ELSE available_at END,
      next_reconcile_at = CASE
        WHEN recovered.state = 'leased' AND recovered.lease_attempt_kind = 'reconcile'
          THEN statement_timestamp()
        ELSE NULL
      END,
      lease_attempt_kind = NULL, lease_expires_at = NULL,
      settled_at = CASE WHEN recovered.state = 'calling'
        THEN statement_timestamp() ELSE settled_at END,
      updated_at = statement_timestamp()
    WHERE workspace_id = recovered.workspace_id AND id = recovered.id
      AND provider_id = 'zernio';
    DELETE FROM app.property_predator_owned_social_job_leases
    WHERE workspace_id = recovered.workspace_id AND job_id = recovered.id;
  END LOOP;

  UPDATE app.property_predator_owned_social_jobs AS job SET
    state = 'cancelled', next_reconcile_at = NULL,
    settled_at = statement_timestamp(), updated_at = statement_timestamp()
  WHERE job.workspace_id = p_workspace_id AND job.provider_id = 'zernio'
    AND job.provider_connection_id = p_provider_connection_id
    AND job.network = ANY(p_networks) AND job.state = 'queued'
    AND (
      EXISTS (
        SELECT 1 FROM app.public_social_planning_target_cancellations AS cancellation
        WHERE cancellation.workspace_id = job.workspace_id
          AND cancellation.intent_id = job.planning_intent_id
          AND cancellation.target_id = job.planning_target_id
      )
      OR EXISTS (
        SELECT 1 FROM app.public_social_planning_target_supersessions AS supersession
        WHERE supersession.workspace_id = job.workspace_id
          AND supersession.predecessor_intent_id = job.planning_intent_id
          AND supersession.predecessor_target_id = job.planning_target_id
      )
    );

  UPDATE app.property_predator_owned_social_jobs AS job SET
    state = 'needs_attention', next_reconcile_at = NULL,
    settled_at = statement_timestamp(), updated_at = statement_timestamp()
  WHERE job.workspace_id = p_workspace_id AND job.provider_id = 'zernio'
    AND job.provider_connection_id = p_provider_connection_id
    AND job.network = ANY(p_networks) AND job.state = 'queued'
    AND job.available_at <= statement_timestamp() - interval '5 minutes'
    AND NOT app_private.zernio_calendar_job_effect_ready(job.workspace_id, job.id);

  UPDATE app.property_predator_owned_social_jobs AS job SET
    state = 'needs_attention', next_reconcile_at = NULL,
    settled_at = statement_timestamp(), updated_at = statement_timestamp()
  WHERE job.workspace_id = p_workspace_id AND job.provider_id = 'zernio'
    AND job.provider_connection_id = p_provider_connection_id
    AND job.network = ANY(p_networks)
    AND ((job.state = 'queued' AND job.available_at <= statement_timestamp())
      OR (job.state = 'reconciliation_pending'
        AND job.next_reconcile_at <= statement_timestamp()))
    AND (
      (job.state = 'queued'
        AND job.utc_day <> (statement_timestamp() AT TIME ZONE 'UTC')::date)
      OR NOT app_private.zernio_calendar_binding_ready(job.workspace_id, job.id)
    );

  UPDATE app.property_predator_owned_social_jobs AS job SET
    state = 'needs_attention', next_reconcile_at = NULL,
    settled_at = statement_timestamp(), updated_at = statement_timestamp()
  WHERE job.workspace_id = p_workspace_id AND job.provider_id = 'zernio'
    AND job.provider_connection_id = p_provider_connection_id
    AND job.network = ANY(p_networks)
    AND ((job.state = 'queued' AND job.available_at <= statement_timestamp())
      OR (job.state = 'reconciliation_pending'
        AND job.next_reconcile_at <= statement_timestamp()))
    AND job.claim_count >= 12;

  SELECT job.* INTO selected FROM app.property_predator_owned_social_jobs AS job
  WHERE job.workspace_id = p_workspace_id AND job.provider_id = 'zernio'
    AND job.provider_connection_id = p_provider_connection_id
    AND job.network = ANY(p_networks)
    AND ((job.state = 'queued' AND job.available_at <= statement_timestamp())
      OR (job.state = 'reconciliation_pending'
        AND job.next_reconcile_at <= statement_timestamp()))
    AND job.claim_count < 12
    AND (job.state = 'reconciliation_pending'
      OR app_private.zernio_calendar_job_effect_ready(job.workspace_id, job.id))
    AND app_private.zernio_calendar_binding_ready(job.workspace_id, job.id)
  ORDER BY CASE WHEN job.state = 'reconciliation_pending' THEN 0 ELSE 1 END,
    coalesce(job.next_reconcile_at, job.available_at), job.created_at
  LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN; END IF;
  selected_kind := CASE WHEN selected.state = 'queued' THEN 'publish' ELSE 'reconcile' END;
  next_version := selected.lease_version + 1;
  UPDATE app.property_predator_owned_social_jobs SET
    state = 'leased', lease_version = next_version,
    lease_attempt_kind = selected_kind,
    lease_expires_at = statement_timestamp() + make_interval(secs => p_lease_seconds),
    claim_count = claim_count + 1, leased_at = statement_timestamp(),
    next_reconcile_at = NULL, updated_at = statement_timestamp()
  WHERE workspace_id = p_workspace_id AND id = selected.id
    AND provider_id = 'zernio';
  INSERT INTO app.property_predator_owned_social_job_leases
    (workspace_id, job_id, lease_version, lease_token_sha256)
  VALUES (
    p_workspace_id, selected.id, next_version,
    public.digest(p_lease_token, 'sha256')
  ) ON CONFLICT (workspace_id, job_id) DO UPDATE SET
    lease_version = EXCLUDED.lease_version,
    lease_token_sha256 = EXCLUDED.lease_token_sha256,
    issued_at = statement_timestamp();
  RETURN QUERY SELECT selected.id, selected.zernio_publish_binding_id,
    selected.zernio_account_id, next_version, selected_kind, selected.network;
END
$function$;

CREATE FUNCTION app_private.seo_blog_enqueue_zernio_calendar(
  p_workspace_id uuid, p_binding_id uuid,
  p_planning_intent_id uuid, p_planning_target_id uuid,
  p_content_item_id uuid, p_content_version_id uuid,
  p_approval_request_id uuid, p_approval_decision_id uuid,
  p_source_attestation_id uuid, p_operation_tag text, p_scheduled_for timestamptz
) RETURNS TABLE(job_id uuid, idempotency_key_sha256 bytea, daily_cap integer, monthly_cap integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE
  selected_user uuid;
  selected_binding app.seo_blog_social_bindings%ROWTYPE;
  selected_target record;
  selected_account record;
  selected_publish_binding_id uuid;
  selected_publish_binding_count integer;
  selected_promotion app.property_predator_zernio_calendar_target_promotions%ROWTYPE;
  selected_promotion_id uuid;
  selected_promotion_sha256 bytea;
  selected_version record;
  selected_capability_sha256 bytea;
  selected_idempotency_sha256 bytea;
  selected_request_sha256 bytea;
  selected_job_id uuid := gen_random_uuid();
  selected_effect_at timestamptz;
  selected_verified_at timestamptz := statement_timestamp();
  selected_promoted_at timestamptz := statement_timestamp();
  selected_caps_label text;
  existing record;
BEGIN
  IF session_user <> 'r72_zernio_social_command'
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'user'
     OR coalesce(current_setting('app.user_id', true), '') !~ '^[0-9a-f-]{36}$'
     OR coalesce(current_setting('app.request_id', true), '') = ''
     OR current_setting('transaction_isolation') IS DISTINCT FROM 'serializable'
     OR current_setting('transaction_read_only') IS DISTINCT FROM 'off'
     OR p_binding_id IS NULL OR p_planning_intent_id IS NULL OR p_planning_target_id IS NULL
     OR p_content_item_id IS NULL OR p_content_version_id IS NULL
     OR p_approval_request_id IS NULL OR p_approval_decision_id IS NULL
     OR p_source_attestation_id IS NULL OR p_scheduled_for IS NULL
     OR p_operation_tag IS NULL OR p_operation_tag !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$' THEN
    RAISE EXCEPTION 'SEO social calendar command denied' USING ERRCODE = '42501';
  END IF;
  selected_user := current_setting('app.user_id')::uuid;
  IF NOT EXISTS (
    SELECT 1 FROM app.workspace_memberships AS membership
    WHERE membership.workspace_id = p_workspace_id AND membership.user_id = selected_user
      AND membership.status = 'active' AND membership.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'SEO social calendar command denied' USING ERRCODE = '42501';
  END IF;

  SELECT binding.* INTO selected_binding FROM app.seo_blog_social_bindings AS binding
  WHERE binding.workspace_id = p_workspace_id AND binding.id = p_binding_id AND binding.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SEO social account is not registered for this brand' USING ERRCODE = '42501';
  END IF;
  IF selected_binding.daily_cap < 1 OR selected_binding.monthly_cap < 1 THEN
    RAISE EXCEPTION 'SEO social publishing is switched off for this brand' USING ERRCODE = '55000';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'public-social-planning-target:' || p_workspace_id::text || ':'
      || p_planning_intent_id::text || ':' || p_planning_target_id::text, 7200040));
  SELECT target.provider_connection_id AS test_provider_connection_id, target.network,
    target.account_ref_sha256 AS test_account_ref_sha256
  INTO selected_target
  FROM app.public_social_planning_intents AS intent
  JOIN app.public_social_planning_intent_targets AS target
    ON target.workspace_id = intent.workspace_id AND target.intent_id = intent.id
  WHERE intent.workspace_id = p_workspace_id AND intent.id = p_planning_intent_id
    AND target.target_id = p_planning_target_id AND target.network = selected_binding.network
    AND target.environment = 'test';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SEO social TEST planning target denied' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'zernio-calendar-connected-command:' || p_workspace_id::text || ':'
      || selected_binding.provider_connection_id::text || ':' || selected_binding.network || ':'
      || encode(selected_binding.provider_account_id_sha256, 'hex'), 7200088));

  SELECT account.id AS zernio_account_id, account.provider_profile_id_sha256,
    account.provider_account_id_sha256, connected_receipt.event_id AS connected_receipt_id,
    connected_receipt.receipt_sha256 AS ownership_evidence_sha256
  INTO selected_account
  FROM app.property_predator_zernio_accounts AS account
  JOIN app.provider_connections AS connection
    ON connection.workspace_id = account.workspace_id AND connection.id = account.provider_connection_id
   AND connection.environment = account.environment
  JOIN LATERAL (
    SELECT receipt.event_id, receipt.receipt_sha256
    FROM app.property_predator_zernio_account_webhook_receipts AS receipt
    WHERE receipt.workspace_id = account.workspace_id
      AND receipt.provider_connection_id = account.provider_connection_id
      AND receipt.environment = account.environment
      AND receipt.event_type = 'account.connected' AND receipt.network = account.network
      AND receipt.provider_profile_id_sha256 = account.provider_profile_id_sha256
      AND receipt.provider_account_id_sha256 = account.provider_account_id_sha256
      AND NOT EXISTS (
        SELECT 1 FROM app.property_predator_zernio_account_webhook_receipts AS disconnected_receipt
        WHERE disconnected_receipt.workspace_id = receipt.workspace_id
          AND disconnected_receipt.provider_connection_id = receipt.provider_connection_id
          AND disconnected_receipt.environment = receipt.environment
          AND disconnected_receipt.event_type = 'account.disconnected'
          AND disconnected_receipt.network = receipt.network
          AND disconnected_receipt.provider_profile_id_sha256 = receipt.provider_profile_id_sha256
          AND disconnected_receipt.provider_account_id_sha256 = receipt.provider_account_id_sha256
          AND disconnected_receipt.occurred_at >= receipt.occurred_at
      )
    ORDER BY receipt.occurred_at DESC, receipt.received_at DESC, receipt.event_id DESC
    LIMIT 1
  ) AS connected_receipt ON true
  WHERE account.workspace_id = p_workspace_id
    AND account.id = selected_binding.zernio_account_id
    AND account.provider_connection_id = selected_binding.provider_connection_id
    AND account.network = selected_binding.network
    AND account.provider_profile_id_sha256 = selected_binding.provider_profile_id_sha256
    AND account.provider_account_id_sha256 = selected_binding.provider_account_id_sha256
    AND account.status = 'active'
    AND connection.provider_id = 'zernio' AND connection.provider_kind = 'social'
    AND connection.environment = 'live' AND connection.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SEO social connected account denied' USING ERRCODE = '42501';
  END IF;

  PERFORM registry.id
  FROM app.public_social_targets AS registry
  JOIN app.provider_connections AS test_connection
    ON test_connection.workspace_id = registry.workspace_id
   AND test_connection.id = registry.provider_connection_id
   AND test_connection.environment = registry.environment
  WHERE registry.workspace_id = p_workspace_id AND registry.id = p_planning_target_id
    AND registry.provider_connection_id = selected_target.test_provider_connection_id
    AND registry.network = selected_binding.network AND registry.environment = 'test'
    AND registry.account_ref_sha256 = selected_target.test_account_ref_sha256
    AND registry.test_account_ref = 'test-account:' || selected_binding.network || ':'
      || encode(selected_account.provider_account_id_sha256, 'hex')
    AND test_connection.provider_id = 'public_social_dark_simulator'
    AND test_connection.provider_kind = 'social' AND test_connection.environment = 'test'
    AND test_connection.status = 'active'
    AND test_connection.capabilities @> '["social.publish"]'::jsonb;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SEO social TEST-to-LIVE target identity denied' USING ERRCODE = '42501';
  END IF;

  selected_capability_sha256 := public.digest(pg_catalog.concat_ws('|',
    'propertypredator.zernio-calendar-publish-capability/v1',
    p_workspace_id, selected_binding.provider_connection_id, selected_account.zernio_account_id,
    selected_binding.network, encode(selected_account.provider_profile_id_sha256, 'hex'),
    encode(selected_account.provider_account_id_sha256, 'hex'),
    encode(selected_account.ownership_evidence_sha256, 'hex')
  ), 'sha256');

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'zernio-calendar-binding:' || p_workspace_id::text || ':'
      || selected_account.zernio_account_id::text || ':' || selected_binding.network, 7200085));
  SELECT count(*)::integer INTO selected_publish_binding_count
  FROM app.property_predator_zernio_publish_bindings AS binding
  WHERE binding.workspace_id = p_workspace_id
    AND binding.provider_connection_id = selected_binding.provider_connection_id
    AND binding.zernio_account_id = selected_account.zernio_account_id
    AND binding.provider_id = 'zernio' AND binding.network = selected_binding.network
    AND binding.provider_profile_id_sha256 = selected_account.provider_profile_id_sha256
    AND binding.provider_account_id_sha256 = selected_account.provider_account_id_sha256
    AND binding.publish_capability_evidence_sha256 = selected_capability_sha256
    AND binding.ownership_evidence_sha256 = selected_account.ownership_evidence_sha256
    AND NOT EXISTS (
      SELECT 1 FROM app.property_predator_zernio_publish_binding_revocations AS revocation
      WHERE revocation.workspace_id = binding.workspace_id AND revocation.binding_id = binding.id);
  IF selected_publish_binding_count > 1 THEN
    RAISE EXCEPTION 'SEO social publish binding is ambiguous' USING ERRCODE = '40001';
  ELSIF selected_publish_binding_count = 1 THEN
    SELECT binding.id INTO selected_publish_binding_id
    FROM app.property_predator_zernio_publish_bindings AS binding
    WHERE binding.workspace_id = p_workspace_id
      AND binding.provider_connection_id = selected_binding.provider_connection_id
      AND binding.zernio_account_id = selected_account.zernio_account_id
      AND binding.provider_id = 'zernio' AND binding.network = selected_binding.network
      AND binding.provider_profile_id_sha256 = selected_account.provider_profile_id_sha256
      AND binding.provider_account_id_sha256 = selected_account.provider_account_id_sha256
      AND binding.publish_capability_evidence_sha256 = selected_capability_sha256
      AND binding.ownership_evidence_sha256 = selected_account.ownership_evidence_sha256
      AND NOT EXISTS (
        SELECT 1 FROM app.property_predator_zernio_publish_binding_revocations AS revocation
        WHERE revocation.workspace_id = binding.workspace_id AND revocation.binding_id = binding.id);
  ELSE
    IF EXISTS (
      SELECT 1 FROM app.property_predator_zernio_publish_bindings AS binding
      WHERE binding.workspace_id = p_workspace_id
        AND binding.provider_connection_id = selected_binding.provider_connection_id
        AND binding.zernio_account_id = selected_account.zernio_account_id
        AND binding.provider_id = 'zernio' AND binding.network = selected_binding.network
        AND NOT EXISTS (
          SELECT 1 FROM app.property_predator_zernio_publish_binding_revocations AS revocation
          WHERE revocation.workspace_id = binding.workspace_id AND revocation.binding_id = binding.id)
    ) THEN
      RAISE EXCEPTION 'SEO social active binding evidence is stale' USING ERRCODE = '40001';
    END IF;
    selected_publish_binding_id := app_private.record_zernio_calendar_publish_binding(
      p_workspace_id, selected_binding.provider_connection_id, gen_random_uuid(),
      selected_account.zernio_account_id, selected_binding.network,
      selected_account.provider_profile_id_sha256, selected_account.provider_account_id_sha256,
      selected_capability_sha256, selected_account.ownership_evidence_sha256, selected_verified_at);
  END IF;

  SELECT promotion.* INTO selected_promotion
  FROM app.property_predator_zernio_calendar_target_promotions AS promotion
  WHERE promotion.workspace_id = p_workspace_id
    AND promotion.planning_intent_id = p_planning_intent_id
    AND promotion.planning_target_id = p_planning_target_id;
  IF FOUND THEN
    IF selected_promotion.test_provider_connection_id <> selected_target.test_provider_connection_id
       OR selected_promotion.test_environment <> 'test'
       OR selected_promotion.network <> selected_binding.network
       OR selected_promotion.test_account_ref_sha256 <> selected_target.test_account_ref_sha256
       OR selected_promotion.live_provider_connection_id <> selected_binding.provider_connection_id
       OR selected_promotion.live_environment <> 'live'
       OR selected_promotion.provider_id <> 'zernio'
       OR selected_promotion.zernio_publish_binding_id <> selected_publish_binding_id
       OR selected_promotion.zernio_account_id <> selected_account.zernio_account_id
       OR selected_promotion.provider_profile_id_sha256 <> selected_account.provider_profile_id_sha256
       OR selected_promotion.provider_account_id_sha256 <> selected_account.provider_account_id_sha256
       OR selected_promotion.connected_receipt_id <> selected_account.connected_receipt_id
       OR selected_promotion.connected_event_type <> 'account.connected'
       OR selected_promotion.ownership_evidence_sha256 <> selected_account.ownership_evidence_sha256
       OR selected_promotion.publish_capability_evidence_sha256 <> selected_capability_sha256 THEN
      RAISE EXCEPTION 'SEO social target promotion conflict' USING ERRCODE = '40001';
    END IF;
    selected_promotion_id := selected_promotion.id;
  ELSE
    selected_promotion_id := gen_random_uuid();
    selected_promotion_sha256 := public.digest(pg_catalog.concat_ws('|',
      'propertypredator.zernio-calendar-target-promotion/v1',
      p_workspace_id, selected_promotion_id, p_planning_intent_id,
      p_planning_target_id, selected_target.test_provider_connection_id,
      selected_binding.network, encode(selected_target.test_account_ref_sha256, 'hex'),
      selected_binding.provider_connection_id, selected_publish_binding_id,
      selected_account.zernio_account_id,
      encode(selected_account.provider_profile_id_sha256, 'hex'),
      encode(selected_account.provider_account_id_sha256, 'hex'),
      selected_account.connected_receipt_id,
      encode(selected_account.ownership_evidence_sha256, 'hex'),
      encode(selected_capability_sha256, 'hex'), selected_user,
      current_setting('app.request_id'),
      pg_catalog.floor(pg_catalog.date_part('epoch', selected_promoted_at) * 1000000)::bigint
    ), 'sha256');
    INSERT INTO app.property_predator_zernio_calendar_target_promotions (
      id, workspace_id, planning_intent_id, planning_target_id,
      test_provider_connection_id, test_environment, network,
      test_account_ref_sha256, live_provider_connection_id, live_environment,
      provider_id, zernio_publish_binding_id, zernio_account_id,
      provider_profile_id_sha256, provider_account_id_sha256,
      connected_receipt_id, connected_event_type, ownership_evidence_sha256,
      publish_capability_evidence_sha256, promotion_sha256,
      promoted_by_user_id, promoted_request_id, promoted_at
    ) VALUES (
      selected_promotion_id, p_workspace_id, p_planning_intent_id, p_planning_target_id,
      selected_target.test_provider_connection_id, 'test', selected_binding.network,
      selected_target.test_account_ref_sha256, selected_binding.provider_connection_id, 'live',
      'zernio', selected_publish_binding_id, selected_account.zernio_account_id,
      selected_account.provider_profile_id_sha256, selected_account.provider_account_id_sha256,
      selected_account.connected_receipt_id, 'account.connected',
      selected_account.ownership_evidence_sha256, selected_capability_sha256,
      selected_promotion_sha256, selected_user, current_setting('app.request_id'), selected_promoted_at
    );
  END IF;

  -- Exact content evidence: the planned SEO social version, its approval and a
  -- currently fresh attestation, plus the live parent guard.
  SELECT version.content_body, version.content_sha256, version.metadata INTO selected_version
  FROM app.public_social_planning_intents AS intent
  JOIN app.public_social_planning_intent_targets AS target
    ON target.workspace_id = intent.workspace_id AND target.intent_id = intent.id
   AND target.target_id = p_planning_target_id AND target.network = selected_binding.network
   AND target.provider_connection_id = selected_target.test_provider_connection_id
   AND target.environment = 'test' AND target.account_ref_sha256 = selected_target.test_account_ref_sha256
  JOIN app.company_content_versions AS version
    ON version.workspace_id = intent.workspace_id AND version.content_item_id = intent.content_item_id
   AND version.id = intent.content_version_id AND version.content_sha256 = intent.content_sha256
  JOIN app.company_content_approval_requests AS request
    ON request.workspace_id = version.workspace_id AND request.id = p_approval_request_id
   AND request.content_item_id = version.content_item_id AND request.content_version_id = version.id
   AND request.content_sha256 = version.content_sha256
  JOIN app.company_content_approval_decisions AS decision
    ON decision.workspace_id = request.workspace_id AND decision.id = p_approval_decision_id
   AND decision.approval_request_id = request.id AND decision.decision = 'approved'
  JOIN app.company_content_source_attestations AS attestation
    ON attestation.workspace_id = version.workspace_id AND attestation.id = p_source_attestation_id
   AND attestation.content_item_id = version.content_item_id AND attestation.content_version_id = version.id
   AND attestation.content_sha256 = version.content_sha256 AND attestation.blob_sha256 = version.blob_sha256
   AND attestation.brand_sha256 = version.brand_sha256
  WHERE intent.workspace_id = p_workspace_id AND intent.id = p_planning_intent_id
    AND intent.content_item_id = p_content_item_id AND intent.content_version_id = p_content_version_id
    AND intent.approval_request_id = p_approval_request_id AND intent.approval_decision_id = p_approval_decision_id
    AND intent.planning_source_attestation_id = p_source_attestation_id
    AND intent.desired_for = p_scheduled_for
    AND version.content_kind = 'social_post' AND version.source_system = 'relaunch72.seo-blog'
    AND version.metadata->>'network' = selected_binding.network
    AND app_private.seo_blog_assert_article_promotion(
      p_workspace_id, nullif(version.metadata->>'articleId', '')::uuid,
      nullif(version.metadata->>'articleVersionId', '')::uuid,
      version.metadata->>'articleContentSha', version.metadata->>'canonicalUrl', true)
    AND attestation.checked_at <= statement_timestamp() AND attestation.expires_at > statement_timestamp()
    AND NOT EXISTS (
      SELECT 1 FROM app.public_social_planning_target_cancellations AS cancellation
      WHERE cancellation.workspace_id = target.workspace_id AND cancellation.intent_id = target.intent_id
        AND cancellation.target_id = target.target_id)
    AND NOT EXISTS (
      SELECT 1 FROM app.public_social_planning_target_supersessions AS supersession
      WHERE supersession.workspace_id = target.workspace_id
        AND supersession.predecessor_intent_id = target.intent_id
        AND supersession.predecessor_target_id = target.target_id)
    AND NOT EXISTS (
      SELECT 1 FROM app.company_content_approval_requests AS later_request
      WHERE later_request.workspace_id = request.workspace_id
        AND later_request.content_item_id = request.content_item_id
        AND later_request.content_version_id = request.content_version_id
        AND later_request.request_number > request.request_number)
    AND NOT EXISTS (
      SELECT 1 FROM app.company_content_versions AS newer
      WHERE newer.workspace_id = version.workspace_id AND newer.content_item_id = version.content_item_id
        AND newer.version_number > version.version_number);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SEO social content evidence denied' USING ERRCODE = '42501';
  END IF;
  IF length(selected_version.content_body) >
      (CASE selected_binding.network WHEN 'instagram' THEN 2200 ELSE 3000 END) THEN
    RAISE EXCEPTION 'SEO social network text denied' USING ERRCODE = '22023';
  END IF;
  -- Art direction is never an image: Instagram needs real approved media, which
  -- this release does not attach. LinkedIn text promotion stands on its own.
  IF selected_binding.network = 'instagram' THEN
    RAISE EXCEPTION 'Instagram promotion requires a real approved image' USING ERRCODE = '55000';
  END IF;

  selected_caps_label := 'daily=' || selected_binding.daily_cap::text || ';monthly=' || selected_binding.monthly_cap::text;
  selected_idempotency_sha256 := public.digest(pg_catalog.concat_ws('|',
    'relaunch72.seo-blog-zernio-calendar-command/v1', p_workspace_id,
    selected_target.test_provider_connection_id, selected_binding.provider_connection_id,
    selected_promotion_id, selected_binding.network,
    encode(selected_target.test_account_ref_sha256, 'hex'),
    encode(selected_account.provider_profile_id_sha256, 'hex'),
    encode(selected_account.provider_account_id_sha256, 'hex'),
    p_planning_intent_id, p_planning_target_id, p_content_item_id,
    p_content_version_id, p_approval_request_id, p_approval_decision_id,
    p_source_attestation_id, p_operation_tag,
    pg_catalog.floor(pg_catalog.date_part('epoch', p_scheduled_for) * 1000000)::bigint,
    encode(selected_version.content_sha256, 'hex'),
    encode(public.digest(selected_version.content_body, 'sha256'), 'hex'),
    selected_caps_label, selected_binding.id
  ), 'sha256');
  selected_request_sha256 := public.digest(pg_catalog.concat_ws('|',
    'relaunch72.seo-blog-zernio-calendar-job/v1', p_workspace_id,
    selected_promotion_id, selected_target.test_provider_connection_id,
    selected_binding.provider_connection_id, selected_publish_binding_id, selected_account.zernio_account_id,
    selected_binding.network, encode(selected_target.test_account_ref_sha256, 'hex'),
    encode(selected_account.provider_profile_id_sha256, 'hex'),
    encode(selected_account.provider_account_id_sha256, 'hex'),
    p_planning_intent_id, p_planning_target_id, p_content_item_id,
    p_content_version_id, p_approval_request_id, p_approval_decision_id,
    p_source_attestation_id, p_operation_tag,
    pg_catalog.floor(pg_catalog.date_part('epoch', p_scheduled_for) * 1000000)::bigint,
    encode(selected_version.content_sha256, 'hex'),
    encode(public.digest(selected_version.content_body, 'sha256'), 'hex'),
    selected_binding.id
  ), 'sha256');

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'zernio-calendar-publish-binding:' || p_workspace_id::text || ':' || selected_publish_binding_id::text, 7200085));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'zernio-calendar-publish-account:' || p_workspace_id::text || ':'
      || selected_account.zernio_account_id::text || ':' || selected_binding.network, 7200085));

  SELECT job.* INTO existing FROM app.property_predator_owned_social_jobs AS job
  WHERE job.workspace_id = p_workspace_id AND job.idempotency_key_sha256 = selected_idempotency_sha256;
  IF FOUND THEN
    IF existing.request_sha256 <> selected_request_sha256 OR existing.provider_id <> 'zernio'
       OR existing.provider_connection_id <> selected_binding.provider_connection_id
       OR existing.profile_id IS NOT NULL
       OR existing.zernio_publish_binding_id <> selected_publish_binding_id
       OR existing.zernio_account_id <> selected_account.zernio_account_id
       OR existing.network <> selected_binding.network
       OR existing.planning_intent_id <> p_planning_intent_id
       OR existing.planning_target_id <> p_planning_target_id
       OR existing.content_item_id <> p_content_item_id
       OR existing.content_version_id <> p_content_version_id
       OR existing.approval_request_id <> p_approval_request_id
       OR existing.approval_decision_id <> p_approval_decision_id
       OR existing.source_attestation_id <> p_source_attestation_id
       OR existing.operation_tag <> p_operation_tag
       OR existing.scheduled_for <> p_scheduled_for THEN
      RAISE EXCEPTION 'SEO social calendar idempotency conflict' USING ERRCODE = '40001';
    END IF;
    RETURN QUERY SELECT existing.id, selected_idempotency_sha256, selected_binding.daily_cap, selected_binding.monthly_cap;
    RETURN;
  END IF;

  selected_effect_at := greatest(statement_timestamp(), p_scheduled_for);
  IF (SELECT count(*) FROM app.property_predator_owned_social_jobs AS job
      WHERE job.workspace_id = p_workspace_id AND job.provider_id = 'zernio'
        AND job.zernio_account_id = selected_account.zernio_account_id
        AND job.network = selected_binding.network
        AND job.utc_day = (selected_effect_at AT TIME ZONE 'UTC')::date
        AND job.state <> 'cancelled') >= selected_binding.daily_cap
     OR (SELECT count(*) FROM app.property_predator_owned_social_jobs AS job
      WHERE job.workspace_id = p_workspace_id AND job.provider_id = 'zernio'
        AND job.zernio_account_id = selected_account.zernio_account_id
        AND job.network = selected_binding.network
        AND job.utc_month = date_trunc('month', selected_effect_at AT TIME ZONE 'UTC')::date
        AND job.state <> 'cancelled') >= selected_binding.monthly_cap THEN
    RAISE EXCEPTION 'The publish cap for this account is already used for that day or month' USING ERRCODE = '55000';
  END IF;

  INSERT INTO app.property_predator_owned_social_jobs (
    id, workspace_id, provider_connection_id, provider_id, profile_id,
    zernio_publish_binding_id, zernio_account_id, environment, network,
    planning_intent_id, planning_target_id, content_item_id,
    content_version_id, content_sha256, approval_request_id,
    approval_decision_id, source_attestation_id, operation_tag,
    idempotency_key_sha256, request_sha256, text_body, scheduled_for,
    utc_day, utc_month, available_at, created_by_user_id
  ) VALUES (
    selected_job_id, p_workspace_id, selected_binding.provider_connection_id, 'zernio', NULL,
    selected_publish_binding_id, selected_account.zernio_account_id, 'live', selected_binding.network,
    p_planning_intent_id, p_planning_target_id, p_content_item_id,
    p_content_version_id, selected_version.content_sha256,
    p_approval_request_id, p_approval_decision_id, p_source_attestation_id,
    p_operation_tag, selected_idempotency_sha256, selected_request_sha256,
    selected_version.content_body, p_scheduled_for,
    (selected_effect_at AT TIME ZONE 'UTC')::date,
    date_trunc('month', selected_effect_at AT TIME ZONE 'UTC')::date,
    selected_effect_at, selected_user
  );
  INSERT INTO app.seo_blog_social_job_caps (workspace_id, job_id, binding_id, daily_cap, monthly_cap)
  VALUES (p_workspace_id, selected_job_id, selected_binding.id, selected_binding.daily_cap, selected_binding.monthly_cap);

  RETURN QUERY SELECT selected_job_id, selected_idempotency_sha256, selected_binding.daily_cap, selected_binding.monthly_cap;
END
$function$;

RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_owned_social_definer;
GRANT CREATE ON SCHEMA app_private TO r72_public_social_definer;
SET LOCAL ROLE r72_public_social_definer;

-- Narrow SEO planning branch. 0101's planner admits only the two PP source
-- systems and is left untouched; this creates the same intent/target/
-- revalidation rows (same intent digest contract) for an exact approved,
-- attested SEO promotion version whose parent article is verified public.
CREATE FUNCTION app_private.seo_blog_create_promotion_planning_intent(
  p_workspace_id uuid, p_intent_id uuid, p_content_version_id uuid,
  p_desired_for timestamptz, p_target_ids uuid[]
) RETURNS TABLE(intent_id uuid, intent_sha256 text, disposition text, campaign_id uuid, revision_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE
  actor_id uuid; request_id text;
  selected_campaign_id uuid; selected_revision_id uuid; campaign_seed text;
  existing app.public_social_planning_intents%ROWTYPE;
  existing_targets uuid[]; target_count integer; distinct_target_count integer;
  main_content_item_id uuid; main_content_sha256 bytea; main_blob_sha256 bytea; main_brand_sha256 bytea;
  main_approval_request_id uuid; main_approval_decision_id uuid; main_attestation_id uuid;
  resolved_targets jsonb; calculated_intent_sha256 bytea;
BEGIN
  IF session_user <> 'r72_zernio_social_command'
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'user'
     OR coalesce(current_setting('app.user_id', true), '') !~ '^[0-9a-f-]{36}$'
     OR coalesce(current_setting('app.request_id', true), '') = ''
     OR p_intent_id IS NULL OR p_content_version_id IS NULL OR p_desired_for IS NULL
     OR p_target_ids IS NULL OR cardinality(p_target_ids) NOT BETWEEN 1 AND 2
     OR array_position(p_target_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'SEO social planning denied' USING ERRCODE = '42501';
  END IF;
  actor_id := current_setting('app.user_id')::uuid;
  request_id := current_setting('app.request_id');
  -- Same manager assertion as 0101's PP planner (definer-scoped membership read).
  PERFORM app_private.assert_public_social_manager(p_workspace_id);
  SELECT count(*), count(DISTINCT value) INTO target_count, distinct_target_count FROM unnest(p_target_ids) AS value;
  IF target_count <> distinct_target_count THEN
    RAISE EXCEPTION 'planning targets must be unique' USING ERRCODE = '22023';
  END IF;

  -- One deterministic container campaign per brand for blog promotion.
  campaign_seed := encode(public.digest('relaunch72.seo-blog-promotion-campaign/v1|' || p_workspace_id::text, 'sha256'), 'hex');
  selected_campaign_id := pg_catalog.format('%s-%s-%s-%s-%s', substr(campaign_seed, 1, 8), substr(campaign_seed, 9, 4),
    '5' || substr(campaign_seed, 14, 3), '8' || substr(campaign_seed, 18, 3), substr(campaign_seed, 21, 12))::uuid;
  campaign_seed := encode(public.digest('relaunch72.seo-blog-promotion-revision/v1|' || p_workspace_id::text, 'sha256'), 'hex');
  selected_revision_id := pg_catalog.format('%s-%s-%s-%s-%s', substr(campaign_seed, 1, 8), substr(campaign_seed, 9, 4),
    '5' || substr(campaign_seed, 14, 3), '8' || substr(campaign_seed, 18, 3), substr(campaign_seed, 21, 12))::uuid;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'seo-blog-promotion-campaign:' || p_workspace_id::text, 7200132));
  IF NOT EXISTS (SELECT 1 FROM app.public_social_campaigns AS campaign
      WHERE campaign.workspace_id = p_workspace_id AND campaign.id = selected_campaign_id) THEN
    INSERT INTO app.public_social_campaigns (id, workspace_id, campaign_key, created_by_user_id, created_request_id)
    VALUES (selected_campaign_id, p_workspace_id, 'seo-blog-promotions', actor_id, request_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.public_social_campaign_revisions AS revision
      WHERE revision.workspace_id = p_workspace_id AND revision.campaign_id = selected_campaign_id
        AND revision.id = selected_revision_id) THEN
    INSERT INTO app.public_social_campaign_revisions (
      id, workspace_id, campaign_id, revision_number, previous_revision_id, title, objective, timezone,
      revision_sha256, created_by_user_id, created_request_id
    ) VALUES (
      selected_revision_id, p_workspace_id, selected_campaign_id, 1, NULL,
      'Blog article promotion', 'Promote verified public blog articles on the brand''s own connected accounts.',
      'Europe/London',
      public.digest('relaunch72.seo-blog-promotion-revision/v1|' || p_workspace_id::text || '|' || selected_campaign_id::text, 'sha256'),
      actor_id, request_id
    );
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'public-social-planning-intent:' || p_workspace_id::text || ':' || p_intent_id::text, 7200040));
  SELECT intent.* INTO existing FROM app.public_social_planning_intents AS intent
  WHERE intent.workspace_id = p_workspace_id AND intent.id = p_intent_id;
  IF FOUND THEN
    SELECT array_agg(target.target_id ORDER BY target.ordinal) INTO existing_targets
    FROM app.public_social_planning_intent_targets AS target
    WHERE target.workspace_id = p_workspace_id AND target.intent_id = p_intent_id;
    IF existing.campaign_id IS DISTINCT FROM selected_campaign_id
       OR existing.campaign_revision_id IS DISTINCT FROM selected_revision_id
       OR existing.content_version_id IS DISTINCT FROM p_content_version_id
       OR existing.desired_for IS DISTINCT FROM p_desired_for
       OR existing_targets IS DISTINCT FROM p_target_ids THEN
      RAISE EXCEPTION 'planning intent id was reused with different inputs' USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT p_intent_id, encode(existing.intent_sha256, 'hex'), 'replayed'::text, selected_campaign_id, selected_revision_id;
    RETURN;
  END IF;
  IF p_desired_for < statement_timestamp() - interval '5 seconds'
     OR p_desired_for > statement_timestamp() + interval '366 days' THEN
    RAISE EXCEPTION 'planning time is outside the horizon' USING ERRCODE = '22023';
  END IF;

  SELECT version.content_item_id, version.content_sha256, version.blob_sha256, version.brand_sha256,
    approved.request_id, approved.decision_id, fresh.attestation_id
  INTO main_content_item_id, main_content_sha256, main_blob_sha256, main_brand_sha256,
    main_approval_request_id, main_approval_decision_id, main_attestation_id
  FROM app.company_content_versions AS version
  JOIN LATERAL (
    SELECT request.id AS request_id, decision.id AS decision_id
    FROM app.company_content_approval_requests AS request
    JOIN app.company_content_approval_decisions AS decision
      ON decision.workspace_id = request.workspace_id AND decision.content_item_id = request.content_item_id
     AND decision.content_version_id = request.content_version_id AND decision.approval_request_id = request.id
     AND decision.content_sha256 = request.content_sha256 AND decision.decision = 'approved'
    WHERE request.workspace_id = version.workspace_id AND request.content_item_id = version.content_item_id
      AND request.content_version_id = version.id AND request.content_sha256 = version.content_sha256
      AND NOT EXISTS (
        SELECT 1 FROM app.company_content_approval_requests AS later_request
        WHERE later_request.workspace_id = request.workspace_id
          AND later_request.content_item_id = request.content_item_id
          AND later_request.content_version_id = request.content_version_id
          AND later_request.request_number > request.request_number)
    ORDER BY request.request_number DESC, request.id LIMIT 1
  ) AS approved ON true
  JOIN LATERAL (
    SELECT attestation.id AS attestation_id
    FROM app.company_content_source_attestations AS attestation
    WHERE attestation.workspace_id = version.workspace_id AND attestation.content_item_id = version.content_item_id
      AND attestation.content_version_id = version.id AND attestation.content_sha256 = version.content_sha256
      AND attestation.blob_sha256 = version.blob_sha256 AND attestation.brand_sha256 = version.brand_sha256
      AND attestation.checked_at <= statement_timestamp() AND attestation.expires_at > statement_timestamp()
    ORDER BY attestation.checked_at DESC, attestation.id LIMIT 1
  ) AS fresh ON true
  WHERE version.workspace_id = p_workspace_id AND version.id = p_content_version_id
    AND version.content_kind = 'social_post'
    AND version.source_system = 'relaunch72.seo-blog'
    AND version.metadata->>'source' = 'relaunch72.seo-blog'
    AND version.metadata->>'network' IN ('instagram', 'linkedin')
    AND version.metadata->>'brandId' = p_workspace_id::text
    AND app_private.seo_blog_assert_article_promotion(
      p_workspace_id, nullif(version.metadata->>'articleId', '')::uuid,
      nullif(version.metadata->>'articleVersionId', '')::uuid,
      version.metadata->>'articleContentSha', version.metadata->>'canonicalUrl', true)
    AND public.digest(version.content_body, 'sha256') = version.content_sha256
    AND app_private.public_social_body_supported(version.content_body)
    AND NOT EXISTS (
      SELECT 1 FROM app.company_content_versions AS newer
      WHERE newer.workspace_id = version.workspace_id AND newer.content_item_id = version.content_item_id
        AND newer.version_number > version.version_number);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SEO promotion is not currently approved, attested and verified public' USING ERRCODE = '42501';
  END IF;

  WITH requested AS (
    SELECT requested_target_id, ordinal::integer FROM unnest(p_target_ids) WITH ORDINALITY AS input(requested_target_id, ordinal)
  )
  SELECT jsonb_agg(jsonb_build_object(
      'ordinal', requested.ordinal, 'targetId', target.id, 'providerConnectionId', target.provider_connection_id,
      'network', target.network, 'accountRefSha256', encode(target.account_ref_sha256, 'hex')
    ) ORDER BY requested.ordinal) INTO resolved_targets
  FROM requested
  JOIN app.public_social_targets AS target ON target.workspace_id = p_workspace_id AND target.id = requested.requested_target_id
  JOIN app.provider_connections AS connection ON connection.workspace_id = target.workspace_id AND connection.id = target.provider_connection_id
  WHERE target.environment = 'test' AND connection.provider_id = 'public_social_dark_simulator'
    AND connection.provider_kind = 'social' AND connection.environment = 'test' AND connection.status = 'active';
  IF jsonb_array_length(COALESCE(resolved_targets, '[]'::jsonb)) <> target_count THEN
    RAISE EXCEPTION 'one or more TEST public-social targets are unavailable' USING ERRCODE = '42501';
  END IF;

  calculated_intent_sha256 := public.digest(jsonb_build_object(
    'contract', 'public-social-planning-intent/v1', 'workspaceId', p_workspace_id, 'intentId', p_intent_id,
    'campaignId', selected_campaign_id, 'revisionId', selected_revision_id, 'contentVersionId', p_content_version_id,
    'contentSha256', encode(main_content_sha256, 'hex'), 'approvalRequestId', main_approval_request_id,
    'approvalDecisionId', main_approval_decision_id, 'planningAttestationId', main_attestation_id,
    'desiredFor', to_char(p_desired_for AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'maxAttempts', 4, 'targets', resolved_targets, 'media', '[]'::jsonb
  )::text, 'sha256');

  INSERT INTO app.public_social_planning_intents (
    id, workspace_id, campaign_id, campaign_revision_id, content_item_id, content_version_id, content_sha256,
    blob_sha256, brand_sha256, approval_request_id, approval_decision_id, planning_source_attestation_id,
    desired_for, max_attempts, intent_sha256, created_by_user_id, created_request_id
  ) VALUES (
    p_intent_id, p_workspace_id, selected_campaign_id, selected_revision_id, main_content_item_id, p_content_version_id,
    main_content_sha256, main_blob_sha256, main_brand_sha256, main_approval_request_id, main_approval_decision_id,
    main_attestation_id, p_desired_for, 4, calculated_intent_sha256, actor_id, request_id
  );
  INSERT INTO app.public_social_planning_intent_targets (
    workspace_id, intent_id, ordinal, target_id, provider_connection_id, network, environment, account_ref_sha256
  )
  SELECT p_workspace_id, p_intent_id, (entry->>'ordinal')::smallint, (entry->>'targetId')::uuid,
    (entry->>'providerConnectionId')::uuid, entry->>'network', 'test', decode(entry->>'accountRefSha256', 'hex')
  FROM jsonb_array_elements(resolved_targets) AS entry;
  INSERT INTO app.public_social_revalidation_jobs (workspace_id, intent_id, state, attempt_count, max_attempts, next_attempt_at)
  VALUES (p_workspace_id, p_intent_id, 'waiting_for_window', 0, 4,
    GREATEST(p_desired_for - interval '10 minutes', statement_timestamp()));
  RETURN QUERY SELECT p_intent_id, encode(calculated_intent_sha256, 'hex'), 'applied'::text, selected_campaign_id, selected_revision_id;
END
$function$;

-- Worker-side exact-source JIT proof for delayed slots. The SEO worker (the
-- trusted r72_content_command worker actor) calls this for each brand shortly
-- before a slot. It re-reads the authoritative article/version/URL and the
-- canonical approval, then writes the same short-lived proof row the 0080
-- effect predicate requires. A proof is never extended; a changed parent or a
-- missed window becomes a visible held state instead of a stale send.
CREATE FUNCTION app_private.seo_blog_attest_due_promotions(p_workspace_id uuid)
RETURNS TABLE(revalidation_job_id uuid, intent_id uuid, state text, detail text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE selected record; proof_id uuid; worker_uuid uuid := '5e0b1096-7a68-5e7c-8c4e-5b2a7c4d1f32';
  parent_ok boolean; decision_at timestamptz; catalog bytea;
BEGIN
  IF session_user <> 'r72_content_command'
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'worker'
     OR coalesce(current_setting('app.user_id', true), '') <> ''
     OR coalesce(current_setting('app.request_id', true), '') = '' THEN
    RAISE EXCEPTION 'SEO social attestation denied' USING ERRCODE = '42501';
  END IF;
  FOR selected IN
    SELECT job.id AS job_id, job.lease_version, job.attempt_count, job.max_attempts, job.state AS job_state,
      intent.id AS intent_id, intent.intent_sha256, intent.content_item_id, intent.content_version_id,
      intent.content_sha256, intent.blob_sha256, intent.brand_sha256, intent.desired_for,
      intent.approval_request_id, intent.approval_decision_id,
      version.metadata, version.version_number
    FROM app.public_social_revalidation_jobs AS job
    JOIN app.public_social_planning_intents AS intent
      ON intent.workspace_id = job.workspace_id AND intent.id = job.intent_id
    JOIN app.company_content_versions AS version
      ON version.workspace_id = intent.workspace_id AND version.id = intent.content_version_id
     AND version.content_item_id = intent.content_item_id AND version.content_sha256 = intent.content_sha256
    WHERE job.workspace_id = p_workspace_id
      AND version.source_system = 'relaunch72.seo-blog'
      AND job.state IN ('waiting_for_window', 'retry_wait')
      AND job.next_attempt_at <= statement_timestamp()
    ORDER BY job.next_attempt_at, job.created_at, job.id
    FOR UPDATE OF job SKIP LOCKED
    LIMIT 20
  LOOP
    IF selected.desired_for < statement_timestamp() - interval '5 minutes' THEN
      UPDATE app.public_social_revalidation_jobs SET state = 'window_expired', last_error_code = 'seo.window_expired',
        updated_at = statement_timestamp(), row_version = row_version + 1, completed_at = statement_timestamp()
      WHERE workspace_id = p_workspace_id AND id = selected.job_id;
      revalidation_job_id := selected.job_id; intent_id := selected.intent_id; state := 'window_expired';
      detail := 'The slot passed before the article could be re-verified.'; RETURN NEXT; CONTINUE;
    END IF;
    IF selected.desired_for > statement_timestamp() + interval '10 minutes' THEN
      CONTINUE; -- not yet inside the proof window
    END IF;
    parent_ok := app_private.seo_blog_assert_article_promotion(
      p_workspace_id, nullif(selected.metadata->>'articleId', '')::uuid,
      nullif(selected.metadata->>'articleVersionId', '')::uuid,
      selected.metadata->>'articleContentSha', selected.metadata->>'canonicalUrl', true)
      AND NOT EXISTS (
        SELECT 1 FROM app.company_content_versions AS newer
        WHERE newer.workspace_id = p_workspace_id AND newer.content_item_id = selected.content_item_id
          AND newer.version_number > selected.version_number)
      AND EXISTS (
        SELECT 1 FROM app.company_content_approval_requests AS request
        JOIN app.company_content_approval_decisions AS decision
          ON decision.workspace_id = request.workspace_id AND decision.id = selected.approval_decision_id
         AND decision.approval_request_id = request.id AND decision.decision = 'approved'
        WHERE request.workspace_id = p_workspace_id AND request.id = selected.approval_request_id
          AND request.content_version_id = selected.content_version_id
          AND NOT EXISTS (
            SELECT 1 FROM app.company_content_approval_requests AS later_request
            WHERE later_request.workspace_id = request.workspace_id
              AND later_request.content_item_id = request.content_item_id
              AND later_request.content_version_id = request.content_version_id
              AND later_request.request_number > request.request_number))
      AND NOT EXISTS (
        SELECT 1 FROM app.public_social_planning_intent_targets AS target
        JOIN app.public_social_planning_target_cancellations AS cancellation
          ON cancellation.workspace_id = target.workspace_id AND cancellation.intent_id = target.intent_id
         AND cancellation.target_id = target.target_id
        WHERE target.workspace_id = p_workspace_id AND target.intent_id = selected.intent_id);
    IF NOT parent_ok THEN
      UPDATE app.public_social_revalidation_jobs SET state = 'cancelled', last_error_code = 'seo.parent_changed',
        updated_at = statement_timestamp(), row_version = row_version + 1, completed_at = statement_timestamp()
      WHERE workspace_id = p_workspace_id AND id = selected.job_id;
      revalidation_job_id := selected.job_id; intent_id := selected.intent_id; state := 'cancelled';
      detail := 'The article, its URL, its approval or this post changed; nothing will be sent.'; RETURN NEXT; CONTINUE;
    END IF;
    IF selected.attempt_count >= selected.max_attempts THEN
      UPDATE app.public_social_revalidation_jobs SET state = 'dead_letter', last_error_code = 'seo.attempts_exhausted',
        updated_at = statement_timestamp(), row_version = row_version + 1, completed_at = statement_timestamp()
      WHERE workspace_id = p_workspace_id AND id = selected.job_id;
      revalidation_job_id := selected.job_id; intent_id := selected.intent_id; state := 'dead_letter';
      detail := 'Too many verification attempts.'; RETURN NEXT; CONTINUE;
    END IF;
    SELECT decision.decided_at INTO decision_at FROM app.company_content_approval_decisions AS decision
    WHERE decision.workspace_id = p_workspace_id AND decision.id = selected.approval_decision_id;
    proof_id := gen_random_uuid();
    catalog := public.digest(pg_catalog.concat_ws('|', 'relaunch72.seo-blog-promotion-proof/v1',
      p_workspace_id, selected.intent_id, selected.content_version_id, encode(selected.content_sha256, 'hex'),
      selected.metadata->>'articleId', selected.metadata->>'articleVersionId',
      selected.metadata->>'articleContentSha', selected.metadata->>'canonicalUrl',
      pg_catalog.floor(pg_catalog.date_part('epoch', statement_timestamp()) * 1000000)::bigint), 'sha256');
    INSERT INTO app.public_social_revalidation_proofs (
      id, workspace_id, job_id, intent_id, intent_sha256, content_item_id, content_version_id, content_sha256,
      blob_sha256, brand_sha256, evidence_type, source_resource_version_id, source_approval_id, source_approved_at,
      source_catalog_sha256, checked_at, expires_at, worker_id, lease_version
    ) VALUES (
      proof_id, p_workspace_id, selected.job_id, selected.intent_id, selected.intent_sha256, selected.content_item_id,
      selected.content_version_id, selected.content_sha256, selected.blob_sha256, selected.brand_sha256, 'legacy',
      nullif(selected.metadata->>'articleVersionId', '')::uuid, selected.approval_decision_id,
      least(decision_at, statement_timestamp()),
      catalog, statement_timestamp(), statement_timestamp() + interval '15 minutes', worker_uuid, selected.lease_version + 1
    );
    UPDATE app.public_social_revalidation_jobs SET state = 'verified', current_proof_id = proof_id,
      lease_version = lease_version + 1, attempt_count = attempt_count + 1, last_error_code = NULL,
      updated_at = statement_timestamp(), row_version = row_version + 1
    WHERE workspace_id = p_workspace_id AND id = selected.job_id;
    revalidation_job_id := selected.job_id; intent_id := selected.intent_id; state := 'verified';
    detail := 'Article re-verified from the current source; proof valid for 15 minutes.'; RETURN NEXT;
  END LOOP;
  RETURN;
END
$function$;

-- Worker discovery for the SEO worker: brands with an SEO promotion slot whose
-- short-lived proof is due. Read-only; the per-brand attestation above does
-- the work under that brand's workspace setting.
CREATE FUNCTION app_private.seo_blog_social_attestation_workspaces()
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $function$
  SELECT DISTINCT job.workspace_id
  FROM app.public_social_revalidation_jobs AS job
  JOIN app.public_social_planning_intents AS intent
    ON intent.workspace_id = job.workspace_id AND intent.id = job.intent_id
  JOIN app.company_content_versions AS version
    ON version.workspace_id = intent.workspace_id AND version.id = intent.content_version_id
  JOIN app.seo_blog_brands AS brand ON brand.workspace_id = job.workspace_id
  WHERE session_user = 'r72_content_command'
    AND current_setting('app.actor_kind', true) = 'worker'
    AND coalesce(current_setting('app.user_id', true), '') = ''
    AND version.source_system = 'relaunch72.seo-blog'
    AND job.state IN ('waiting_for_window', 'retry_wait')
    AND job.next_attempt_at <= statement_timestamp()
  LIMIT 200;
$function$;

RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_public_social_definer;

-- Grants are issued by each owning definer role, exactly as 0085/0097 did.
SET LOCAL ROLE r72_owned_social_definer;
REVOKE ALL ON FUNCTION
  app_private.seo_blog_assert_article_promotion(uuid, uuid, uuid, text, text, boolean),
  app_private.seo_blog_register_zernio_profile(uuid, text, text),
  app_private.seo_blog_zernio_profile(uuid),
  app_private.seo_blog_zernio_profile_workspace(bytea),
  app_private.seo_blog_register_social_binding(uuid, uuid, text, text, integer, integer),
  app_private.seo_blog_revoke_social_binding(uuid, uuid),
  app_private.seo_blog_social_bindings(uuid),
  app_private.seo_blog_social_dispatch_targets(),
  app_private.zernio_calendar_job_cap_ok(uuid, uuid),
  app_private.seo_blog_zernio_job_effect_ready(uuid, uuid),
  app_private.zernio_calendar_job_effect_ready(uuid, uuid),
  app_private.begin_zernio_calendar_call(uuid, uuid, bigint, bytea, boolean, boolean),
  app_private.seo_blog_enqueue_zernio_calendar(uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, timestamptz)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app_private.seo_blog_assert_article_promotion(uuid, uuid, uuid, text, text, boolean)
  TO r72_content_command, r72_content_adapter, r72_zernio_social_command, r72_owned_social_worker_command, r72_public_social_definer;
GRANT EXECUTE ON FUNCTION
  app_private.seo_blog_register_zernio_profile(uuid, text, text),
  app_private.seo_blog_zernio_profile_workspace(bytea),
  app_private.seo_blog_register_social_binding(uuid, uuid, text, text, integer, integer),
  app_private.seo_blog_revoke_social_binding(uuid, uuid),
  app_private.seo_blog_enqueue_zernio_calendar(uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, timestamptz)
  TO r72_zernio_social_command;
GRANT EXECUTE ON FUNCTION app_private.seo_blog_social_bindings(uuid), app_private.seo_blog_zernio_profile(uuid)
  TO r72_zernio_social_command, r72_content_command;
GRANT EXECUTE ON FUNCTION app_private.seo_blog_social_dispatch_targets()
  TO r72_owned_social_worker_command;
GRANT EXECUTE ON FUNCTION app_private.begin_zernio_calendar_call(uuid, uuid, bigint, bytea, boolean, boolean)
  TO r72_owned_social_worker_command;

RESET ROLE;
SET LOCAL ROLE r72_public_social_definer;
REVOKE ALL ON FUNCTION
  app_private.seo_blog_create_promotion_planning_intent(uuid, uuid, uuid, timestamptz, uuid[]),
  app_private.seo_blog_attest_due_promotions(uuid),
  app_private.seo_blog_social_attestation_workspaces()
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.seo_blog_create_promotion_planning_intent(uuid, uuid, uuid, timestamptz, uuid[])
  TO r72_zernio_social_command;
GRANT EXECUTE ON FUNCTION app_private.seo_blog_attest_due_promotions(uuid), app_private.seo_blog_social_attestation_workspaces()
  TO r72_content_command;

RESET ROLE;
SET LOCAL ROLE r72_owner;

DO $capability_audit$
DECLARE signature text; expected_owner text; unsafe_table text;
BEGIN
  FOR signature, expected_owner IN
    SELECT * FROM (VALUES
      ('app_private.seo_blog_assert_article_promotion(uuid,uuid,uuid,text,text,boolean)', 'r72_owned_social_definer'),
      ('app_private.seo_blog_register_zernio_profile(uuid,text,text)', 'r72_owned_social_definer'),
      ('app_private.seo_blog_zernio_profile(uuid)', 'r72_owned_social_definer'),
      ('app_private.seo_blog_zernio_profile_workspace(bytea)', 'r72_owned_social_definer'),
      ('app_private.seo_blog_register_social_binding(uuid,uuid,text,text,integer,integer)', 'r72_owned_social_definer'),
      ('app_private.seo_blog_revoke_social_binding(uuid,uuid)', 'r72_owned_social_definer'),
      ('app_private.seo_blog_social_bindings(uuid)', 'r72_owned_social_definer'),
      ('app_private.seo_blog_social_dispatch_targets()', 'r72_owned_social_definer'),
      ('app_private.zernio_calendar_job_cap_ok(uuid,uuid)', 'r72_owned_social_definer'),
      ('app_private.seo_blog_zernio_job_effect_ready(uuid,uuid)', 'r72_owned_social_definer'),
      ('app_private.zernio_calendar_job_effect_ready(uuid,uuid)', 'r72_owned_social_definer'),
      ('app_private.begin_zernio_calendar_call(uuid,uuid,bigint,bytea,boolean,boolean)', 'r72_owned_social_definer'),
      ('app_private.seo_blog_enqueue_zernio_calendar(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,timestamptz)', 'r72_owned_social_definer'),
      ('app_private.seo_blog_create_promotion_planning_intent(uuid,uuid,uuid,timestamptz,uuid[])', 'r72_public_social_definer'),
      ('app_private.seo_blog_attest_due_promotions(uuid)', 'r72_public_social_definer'),
      ('app_private.seo_blog_social_attestation_workspaces()', 'r72_public_social_definer')
    ) AS expected(signature, owner_role)
  LOOP
    IF pg_catalog.to_regprocedure(signature) IS NULL OR NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc AS procedure
      WHERE procedure.oid = pg_catalog.to_regprocedure(signature)
        AND procedure.proowner = expected_owner::regrole
        AND procedure.prosecdef
        AND procedure.proconfig @> ARRAY['search_path=pg_catalog']::text[]
        AND NOT pg_catalog.has_function_privilege('public', procedure.oid, 'EXECUTE')
    ) THEN
      RAISE EXCEPTION 'SEO social capability audit failed: %', signature;
    END IF;
  END LOOP;
  -- Login roles stay table-blind on the new tables.
  SELECT pg_catalog.format('%I.%I', namespace.nspname, relation.relname) INTO unsafe_table
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname = 'app' AND (relation.relname LIKE 'seo_blog_social_%' OR relation.relname = 'seo_blog_zernio_profiles')
    AND relation.relkind = 'r'
    AND (has_table_privilege('r72_zernio_social_command', relation.oid, 'SELECT')
      OR has_table_privilege('r72_content_command', relation.oid, 'SELECT')
      OR has_table_privilege('r72_owned_social_worker_command', relation.oid, 'SELECT')
      OR has_table_privilege('r72_web', relation.oid, 'SELECT'))
  LIMIT 1;
  IF unsafe_table IS NOT NULL THEN
    RAISE EXCEPTION 'SEO social login role is not table-blind: %', unsafe_table;
  END IF;
  IF NOT has_function_privilege('r72_owned_social_worker_command',
       'app_private.begin_zernio_calendar_call(uuid,uuid,bigint,bytea,boolean,boolean)', 'EXECUTE')
     OR has_function_privilege('r72_zernio_social_command',
       'app_private.begin_zernio_calendar_call(uuid,uuid,bigint,bytea,boolean,boolean)', 'EXECUTE')
     OR has_function_privilege('r72_content_command',
       'app_private.seo_blog_enqueue_zernio_calendar(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,timestamptz)', 'EXECUTE')
     OR has_function_privilege('r72_owned_social_worker_command',
       'app_private.seo_blog_attest_due_promotions(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'SEO social function grants crossed a role boundary';
  END IF;
END
$capability_audit$;
