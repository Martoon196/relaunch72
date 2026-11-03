-- 010-1: private immutable media and canonical-approval/publication capabilities.
-- No provider, scheduler or public route is created. Operator paid admission defaults disabled/zero.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='r72_seo_media_definer') THEN
    CREATE ROLE r72_seo_media_definer NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='r72_seo_media_definer'
    AND NOT rolcanlogin AND NOT rolinherit AND NOT rolsuper AND NOT rolcreatedb
    AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls) THEN
    RAISE EXCEPTION 'Unsafe SEO media function-owner attributes' USING ERRCODE='42501';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles child ON child.oid=m.member
    WHERE child.rolname='r72_seo_media_definer') THEN
    RAISE EXCEPTION 'SEO media function owner must not inherit any role' USING ERRCODE='42501';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles parent ON parent.oid=m.roleid
    JOIN pg_catalog.pg_roles child ON child.oid=m.member WHERE parent.rolname='r72_seo_media_definer'
      AND child.rolname NOT IN ('r72_owner',current_user)) THEN
    RAISE EXCEPTION 'Runtime membership in SEO media function owner denied' USING ERRCODE='42501';
  END IF;
  GRANT r72_seo_media_definer TO r72_owner;
END $role$;

SET LOCAL ROLE r72_owner;

CREATE TABLE app.seo_blog_media_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.seo_blog_brands(workspace_id) ON DELETE RESTRICT,
  blob_id uuid NOT NULL,
  asset_kind text NOT NULL CHECK(asset_kind IN ('candidate','variant')),
  byte_sha256 bytea NOT NULL CHECK(octet_length(byte_sha256)=32),
  byte_length integer NOT NULL CHECK(byte_length BETWEEN 1 AND 8388608),
  mime_type text NOT NULL CHECK(mime_type='image/jpeg'),
  width integer, height integer,
  source_asset_id uuid,
  recipe jsonb,
  provenance jsonb NOT NULL CHECK(jsonb_typeof(provenance)='object' AND octet_length(provenance::text)<=65536),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(workspace_id,id), UNIQUE(workspace_id,id,byte_sha256),
  FOREIGN KEY(workspace_id,blob_id) REFERENCES app.seo_blog_blobs(workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,source_asset_id) REFERENCES app.seo_blog_media_assets(workspace_id,id) ON DELETE RESTRICT,
  CHECK((asset_kind='candidate' AND width IS NULL AND height IS NULL AND source_asset_id IS NULL AND recipe IS NULL)
    OR (asset_kind='variant' AND width IS NOT NULL AND height IS NOT NULL AND recipe IS NOT NULL AND width BETWEEN 200 AND 2048 AND height BETWEEN 200 AND 2048
      AND width::bigint*height<=1500000 AND byte_length<=600000 AND source_asset_id IS NOT NULL AND jsonb_typeof(recipe)='object'))
);

CREATE TABLE app.seo_blog_media_preparations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.seo_blog_brands(workspace_id) ON DELETE RESTRICT,
  source_asset_id uuid NOT NULL, source_sha256 bytea NOT NULL CHECK(octet_length(source_sha256)=32),
  outcome text NOT NULL CHECK(outcome IN ('prepared','rejected')),
  detail text CHECK(detail IS NULL OR length(detail) BETWEEN 1 AND 500),
  result jsonb NOT NULL CHECK(jsonb_typeof(result)='object' AND octet_length(result::text)<=262144),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(workspace_id,id),
  FOREIGN KEY(workspace_id,source_asset_id,source_sha256) REFERENCES app.seo_blog_media_assets(workspace_id,id,byte_sha256) ON DELETE RESTRICT,
  CHECK((outcome='prepared' AND detail IS NULL) OR (outcome='rejected' AND detail IS NOT NULL))
);

CREATE TABLE app.seo_blog_media_commands (
  workspace_id uuid NOT NULL REFERENCES app.seo_blog_brands(workspace_id) ON DELETE RESTRICT,
  id uuid NOT NULL,
  action text NOT NULL CHECK(action IN ('candidate','prepare','reserve_use','authorize','withdraw','authorize_social_use','refresh_social_image_attestation',
    'authorize_campaign_queue','cancel_campaign_queue','materialize_campaign_queue')),
  actor_kind text NOT NULL CHECK(actor_kind IN ('user','worker')),
  actor_user_id uuid REFERENCES app.users(id) ON DELETE RESTRICT,
  payload_sha256 bytea NOT NULL CHECK(octet_length(payload_sha256)=32),
  prospective_release_id uuid UNIQUE,
  result jsonb NOT NULL CHECK(jsonb_typeof(result)='object' AND octet_length(result::text)<=262144),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,prospective_release_id),
  CHECK((actor_kind='user' AND actor_user_id IS NOT NULL) OR (actor_kind='worker' AND actor_user_id IS NULL)),
  CHECK((action='reserve_use')=(prospective_release_id IS NOT NULL))
);

CREATE TABLE app.seo_blog_media_owner_authorizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  use_kind text NOT NULL DEFAULT 'blog_hero' CHECK(use_kind IN ('blog_hero','social_variant')),
  social_use jsonb CHECK(social_use IS NULL OR (jsonb_typeof(social_use)='object' AND octet_length(social_use::text)<=262144)),
  workspace_id uuid NOT NULL REFERENCES app.seo_blog_brands(workspace_id) ON DELETE RESTRICT,
  reservation_command_id uuid NOT NULL,
  asset_id uuid NOT NULL, asset_sha256 bytea NOT NULL CHECK(octet_length(asset_sha256)=32),
  article_version_id uuid NOT NULL,
  article_content_sha256 text NOT NULL CHECK(article_content_sha256 ~ '^[0-9a-f]{64}$'),
  reviewed_intent_sha256 bytea NOT NULL CHECK(octet_length(reviewed_intent_sha256)=32),
  canonical_item_id uuid NOT NULL, canonical_version_id uuid NOT NULL,
  canonical_content_sha256 bytea NOT NULL CHECK(octet_length(canonical_content_sha256)=32),
  approval_request_id uuid NOT NULL, approval_decision_id uuid NOT NULL,
  authorizing_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(workspace_id,id),
  FOREIGN KEY(workspace_id,reservation_command_id) REFERENCES app.seo_blog_media_commands(workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,asset_id,asset_sha256) REFERENCES app.seo_blog_media_assets(workspace_id,id,byte_sha256) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,article_version_id) REFERENCES app.seo_blog_article_versions(workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,canonical_item_id,canonical_version_id,canonical_content_sha256)
    REFERENCES app.company_content_versions(workspace_id,content_item_id,id,content_sha256) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,canonical_item_id,canonical_version_id,approval_request_id,canonical_content_sha256)
    REFERENCES app.company_content_approval_requests(workspace_id,content_item_id,content_version_id,id,content_sha256) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,approval_decision_id) REFERENCES app.company_content_approval_decisions(workspace_id,id) ON DELETE RESTRICT,
  CHECK((use_kind='blog_hero' AND social_use IS NULL) OR (use_kind='social_variant' AND social_use IS NOT NULL))
);

CREATE TABLE app.seo_blog_media_public_releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.seo_blog_brands(workspace_id) ON DELETE RESTRICT,
  release_id uuid NOT NULL,
  publication_id uuid NOT NULL,
  owner_authorization_id uuid NOT NULL,
  reservation_command_id uuid NOT NULL,
  asset_id uuid NOT NULL, asset_sha256 bytea NOT NULL CHECK(octet_length(asset_sha256)=32),
  slot text NOT NULL CHECK(slot='hero'),
  snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object' AND octet_length(snapshot::text)<=262144),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(workspace_id,id), UNIQUE(workspace_id,publication_id,slot),
  FOREIGN KEY(workspace_id,release_id) REFERENCES app.seo_blog_media_commands(workspace_id,prospective_release_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,publication_id) REFERENCES app.seo_blog_publications(workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,owner_authorization_id) REFERENCES app.seo_blog_media_owner_authorizations(workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,reservation_command_id) REFERENCES app.seo_blog_media_commands(workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,asset_id,asset_sha256) REFERENCES app.seo_blog_media_assets(workspace_id,id,byte_sha256) ON DELETE RESTRICT
);

CREATE TABLE app.seo_blog_media_withdrawals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.seo_blog_brands(workspace_id) ON DELETE RESTRICT,
  scope text NOT NULL CHECK(scope IN ('asset','release')),
  asset_id uuid NOT NULL, asset_sha256 bytea NOT NULL CHECK(octet_length(asset_sha256)=32),
  release_id uuid,
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000),
  actor_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(workspace_id,id),
  FOREIGN KEY(workspace_id,asset_id,asset_sha256) REFERENCES app.seo_blog_media_assets(workspace_id,id,byte_sha256) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,release_id) REFERENCES app.seo_blog_media_commands(workspace_id,prospective_release_id) ON DELETE RESTRICT,
  CHECK((scope='asset' AND release_id IS NULL) OR (scope='release' AND release_id IS NOT NULL))
);

-- Paid-start ledger: no runtime table grants; legacy jobs/usage retain their existing command grants.
CREATE TABLE app.seo_blog_image_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.seo_blog_brands(workspace_id) ON DELETE RESTRICT,
  job_id uuid NOT NULL, intent_id uuid NOT NULL, start_nonce uuid NOT NULL UNIQUE,
  lease_owner text NOT NULL CHECK(length(lease_owner) BETWEEN 1 AND 200), lease_attempt integer NOT NULL CHECK(lease_attempt>0),
  intent_sha256 bytea NOT NULL CHECK(octet_length(intent_sha256)=32), request_sha256 bytea NOT NULL CHECK(octet_length(request_sha256)=32),
  source_sha256 bytea NOT NULL CHECK(octet_length(source_sha256)=32), visual_sha256 bytea NOT NULL CHECK(octet_length(visual_sha256)=32),
  profile_sha256 bytea NOT NULL CHECK(octet_length(profile_sha256)=32), source_snapshot jsonb NOT NULL CHECK(jsonb_typeof(source_snapshot)='object'),
  sponsor_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  model text NOT NULL CHECK(model='gpt-image-2'), quality text NOT NULL CHECK(quality='medium'),
  allowance_period date NOT NULL CHECK(extract(day FROM allowance_period)=1), reserved_microusd bigint NOT NULL CHECK(reserved_microusd>0),
  policy_version bigint NOT NULL CHECK(policy_version>0), policy_sha256 bytea NOT NULL CHECK(octet_length(policy_sha256)=32),
  policy_snapshot jsonb NOT NULL CHECK(jsonb_typeof(policy_snapshot)='object'),
  outcome text NOT NULL DEFAULT 'started' CHECK(outcome IN ('started','outcome_unknown','candidate_received','rejected','not_started','operator_resolved')),
  receipts jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(receipts)='array' AND jsonb_array_length(receipts)<=2),
  candidate_asset_id uuid, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  operator_resolution jsonb CHECK(operator_resolution IS NULL OR jsonb_typeof(operator_resolution)='object'),
  UNIQUE(workspace_id,id), UNIQUE(workspace_id,job_id), UNIQUE(workspace_id,intent_id), UNIQUE(workspace_id,id,start_nonce),
  FOREIGN KEY(workspace_id,job_id) REFERENCES app.seo_blog_jobs(workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,candidate_asset_id) REFERENCES app.seo_blog_media_assets(workspace_id,id) ON DELETE RESTRICT,
  CHECK(allowance_period=date_trunc('month',created_at AT TIME ZONE 'UTC')::date)
);
CREATE TABLE app_private.seo_image_operator_policy (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), version bigint NOT NULL CHECK(version>0),
  config jsonb NOT NULL CHECK(jsonb_typeof(config)='object'), sha256 bytea NOT NULL CHECK(octet_length(sha256)=32),
  admission_epoch bigint NOT NULL DEFAULT 0 CHECK(admission_epoch>=0)
);
INSERT INTO app_private.seo_image_operator_policy(singleton,version,config,sha256)
  SELECT true,1,c,public.digest('1:'||c::text,'sha256') FROM (SELECT '{"enabled":false,"model":"gpt-image-2","quality":"medium","maxConcurrency":0,"monthlyMicrousd":0,"perAttemptMicrousd":0}'::jsonb c) initial;
ALTER TABLE app_private.seo_image_operator_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.seo_image_operator_policy FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.seo_image_operator_policy FROM PUBLIC;
CREATE POLICY seo_image_policy_owner ON app_private.seo_image_operator_policy FOR ALL TO r72_owner USING(true) WITH CHECK(true);
CREATE POLICY seo_image_policy_media_read ON app_private.seo_image_operator_policy FOR SELECT TO r72_seo_media_definer USING(true);
CREATE POLICY seo_image_policy_media_epoch ON app_private.seo_image_operator_policy FOR UPDATE TO r72_seo_media_definer USING(true) WITH CHECK(true);
GRANT SELECT,UPDATE(admission_epoch) ON app_private.seo_image_operator_policy TO r72_seo_media_definer;
ALTER TABLE app.seo_blog_image_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.seo_blog_image_attempts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app.seo_blog_image_attempts FROM PUBLIC;
CREATE POLICY seo_image_attempt_owner ON app.seo_blog_image_attempts FOR ALL TO r72_owner USING(true) WITH CHECK(true);
CREATE POLICY seo_image_attempt_definer ON app.seo_blog_image_attempts FOR ALL TO r72_seo_media_definer USING(true) WITH CHECK(true);
GRANT SELECT,INSERT ON app.seo_blog_image_attempts TO r72_seo_media_definer;
GRANT UPDATE(outcome,receipts,candidate_asset_id) ON app.seo_blog_image_attempts TO r72_seo_media_definer;
INSERT INTO app_private.workspace_table_registry(schema_name,table_name,workspace_column) VALUES('app','seo_blog_image_attempts','workspace_id');
DO $namespace$
BEGIN
  IF EXISTS(SELECT 1 FROM app.seo_blog_usage WHERE kind='images' AND reference LIKE 'seo-image-start:%') THEN
    RAISE EXCEPTION 'New image allowance namespace already populated; explicit review required' USING ERRCODE='55000';
  END IF;
END $namespace$;
CREATE UNIQUE INDEX seo_image_start_one_usage ON app.seo_blog_usage(workspace_id,reference)
  WHERE kind='images' AND reference LIKE 'seo-image-start:%';

DO $tables$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['seo_blog_media_assets','seo_blog_media_preparations','seo_blog_media_commands',
    'seo_blog_media_owner_authorizations','seo_blog_media_public_releases','seo_blog_media_withdrawals'] LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON app.%I FROM PUBLIC',t);
    EXECUTE format('CREATE POLICY %I ON app.%I FOR ALL TO r72_owner USING(true) WITH CHECK(true)',t||'_owner',t);
    EXECUTE format('CREATE POLICY %I ON app.%I FOR ALL TO r72_seo_media_definer USING(true) WITH CHECK(true)',t||'_definer',t);
    EXECUTE format('GRANT SELECT,INSERT ON app.%I TO r72_seo_media_definer',t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON app.%I FOR EACH ROW EXECUTE FUNCTION app_private.seo_blog_append_only()',t||'_immutable',t);
    INSERT INTO app_private.workspace_table_registry(schema_name,table_name,workspace_column) VALUES('app',t,'workspace_id');
  END LOOP;
END $tables$;

GRANT USAGE ON SCHEMA app,app_private TO r72_seo_media_definer;
GRANT SELECT,INSERT ON app.seo_blog_blobs TO r72_seo_media_definer;
CREATE POLICY seo_blog_blobs_media_select ON app.seo_blog_blobs FOR SELECT TO r72_seo_media_definer USING(true);
CREATE POLICY seo_blog_blobs_media_insert ON app.seo_blog_blobs FOR INSERT TO r72_seo_media_definer WITH CHECK(true);

DO $reads$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['seo_blog_brands','seo_blog_articles','seo_blog_article_versions','seo_blog_publications',
    'company_content_items','company_content_versions','company_content_approval_requests','company_content_approval_decisions','company_content_source_attestations',
    'seo_blog_records','seo_blog_jobs','seo_blog_usage'] LOOP
    EXECUTE format('GRANT SELECT ON app.%I TO r72_seo_media_definer',t);
    EXECUTE format('CREATE POLICY %I ON app.%I FOR SELECT TO r72_seo_media_definer USING(true)',t||'_media_read',t);
  END LOOP;
END $reads$;
-- 010-SOCIAL-ASSET-USE-001: only the genuine-owner exact-use refresh capability may append this source tuple.
-- No runtime INSERT grant and no relaxation of the generic latest-version attestation service.
GRANT INSERT ON app.company_content_source_attestations TO r72_seo_media_definer;
CREATE POLICY company_content_attestations_media_use ON app.company_content_source_attestations FOR INSERT TO r72_seo_media_definer WITH CHECK(
  source_system='relaunch72.seo-media' AND workspace_id=app_private.current_workspace_id()
  AND app_private.current_actor_kind()='user' AND attested_by_user_id=app_private.current_user_id()
  AND app_private.can_manage_workspace(attested_by_user_id,workspace_id)
  AND EXISTS(SELECT 1 FROM app.seo_blog_media_owner_authorizations authorized
    WHERE authorized.workspace_id=company_content_source_attestations.workspace_id AND authorized.use_kind='social_variant'
      AND authorized.canonical_item_id=company_content_source_attestations.content_item_id
      AND authorized.canonical_version_id=company_content_source_attestations.content_version_id
      AND authorized.canonical_content_sha256=company_content_source_attestations.content_sha256
      AND authorized.asset_sha256=company_content_source_attestations.blob_sha256)
);
-- SELECT FOR UPDATE/SHARE requires UPDATE privilege. Only these immutable identity columns are granted;
-- no capability function updates them, and the immutable media trigger still refuses actual mutation.
GRANT UPDATE(workspace_id) ON app.seo_blog_brands,app.seo_blog_articles,app.seo_blog_publications TO r72_seo_media_definer;
CREATE POLICY seo_blog_brands_media_lock ON app.seo_blog_brands FOR UPDATE TO r72_seo_media_definer USING(true) WITH CHECK(true);
CREATE POLICY seo_blog_articles_media_lock ON app.seo_blog_articles FOR UPDATE TO r72_seo_media_definer USING(true) WITH CHECK(true);
CREATE POLICY seo_blog_publications_media_lock ON app.seo_blog_publications FOR UPDATE TO r72_seo_media_definer USING(true) WITH CHECK(true);
GRANT EXECUTE ON FUNCTION app_private.resolve_session(bytea),app_private.lock_active_portal_session(bytea,uuid,uuid),
  app_private.can_manage_workspace(uuid,uuid),app_private.current_workspace_id(),app_private.current_user_id(),
  app_private.current_actor_kind(),app_private.current_request_id(),app_private.seo_blog_brand(uuid) TO r72_seo_media_definer;
GRANT CREATE ON SCHEMA app_private TO r72_seo_media_definer;
SET LOCAL ROLE r72_seo_media_definer;

CREATE FUNCTION app_private.seo_media_owner(p_workspace uuid,p_session bytea)
RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; selected uuid;
BEGIN
  IF p_session IS NULL OR octet_length(p_session)<>32 OR app_private.current_actor_kind()<>'user'
    OR app_private.current_workspace_id() IS DISTINCT FROM p_workspace THEN
    RAISE EXCEPTION 'Genuine owner session required' USING ERRCODE='42501';
  END IF;
  SELECT s.user_id,s.selected_workspace_id INTO actor,selected FROM app_private.resolve_session(p_session) s;
  IF actor IS NULL OR actor IS DISTINCT FROM app_private.current_user_id()
    OR NOT app_private.lock_active_portal_session(p_session,actor,selected)
    OR NOT app_private.can_manage_workspace(actor,p_workspace) THEN
    RAISE EXCEPTION 'Genuine current managing owner required' USING ERRCODE='42501';
  END IF;
  RETURN actor;
END $f$;

CREATE FUNCTION app_private.seo_media_private_actor(p_workspace uuid,p_session bytea)
RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
  IF app_private.current_workspace_id() IS DISTINCT FROM p_workspace
    OR NOT pg_has_role(session_user,'r72_content_command','MEMBER') THEN
    RAISE EXCEPTION 'Media workspace mismatch' USING ERRCODE='42501';
  END IF;
  IF app_private.current_actor_kind()='worker' AND app_private.current_user_id() IS NULL AND p_session IS NULL THEN RETURN NULL; END IF;
  RETURN app_private.seo_media_owner(p_workspace,p_session);
END $f$;

CREATE FUNCTION app_private.seo_media_asset_json(p_workspace uuid,p_asset uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
  SELECT jsonb_build_object('id',a.id,'workspaceId',a.workspace_id,'blobId',a.blob_id,'kind',a.asset_kind,
    'validation',CASE WHEN a.asset_kind='candidate' THEN 'candidate_only' ELSE 'prepared_jpeg' END,
    'sha256',encode(a.byte_sha256,'hex'),'byteLength',a.byte_length,'mimeType',a.mime_type,'width',a.width,'height',a.height,
    'sourceAssetId',a.source_asset_id,'recipe',a.recipe,'provenance',a.provenance,'createdAt',a.created_at)
  FROM app.seo_blog_media_assets a WHERE a.workspace_id=p_workspace AND a.id=p_asset
$f$;

CREATE FUNCTION app_private.seo_media_lock_brand(p_workspace uuid)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
  PERFORM 1 FROM app.seo_blog_brands WHERE workspace_id=p_workspace FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Media brand not found' USING ERRCODE='P0002'; END IF;
END $f$;

CREATE FUNCTION app_private.seo_media_replay(p_workspace uuid,p_command uuid,p_action text,p_actor uuid,p_hash bytea)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE saved app.seo_blog_media_commands%ROWTYPE;
BEGIN
  SELECT * INTO saved FROM app.seo_blog_media_commands WHERE workspace_id=p_workspace AND id=p_command;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF saved.action<>p_action OR saved.actor_kind IS DISTINCT FROM app_private.current_actor_kind()
    OR saved.actor_user_id IS DISTINCT FROM p_actor OR saved.payload_sha256<>p_hash THEN
    RAISE EXCEPTION 'Media command reused for different inputs' USING ERRCODE='23505';
  END IF;
  RETURN saved.result;
END $f$;

CREATE FUNCTION app_private.seo_media_command(p_workspace uuid,p_command uuid,p_action text,p_actor uuid,p_hash bytea,p_result jsonb,p_release uuid DEFAULT NULL)
RETURNS void LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
  INSERT INTO app.seo_blog_media_commands(workspace_id,id,action,actor_kind,actor_user_id,payload_sha256,result,prospective_release_id)
    VALUES(p_workspace,p_command,p_action,app_private.current_actor_kind(),p_actor,p_hash,p_result,p_release)
$f$;

CREATE FUNCTION app_private.seo_media_store_candidate_internal(p_workspace uuid,p_session bytea,p_command uuid,p_bytes bytea,p_provenance jsonb,p_receipt jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; request_hash bytea; replayed jsonb; blob_id uuid:=gen_random_uuid(); asset_id uuid:=gen_random_uuid(); result jsonb;
BEGIN
  actor:=app_private.seo_media_private_actor(p_workspace,p_session);
  IF p_command IS NULL OR p_bytes IS NULL OR octet_length(p_bytes) NOT BETWEEN 1 AND 8388608
    OR jsonb_typeof(p_provenance) IS DISTINCT FROM 'object' OR jsonb_typeof(p_receipt) IS DISTINCT FROM 'object'
    OR octet_length(p_provenance::text)>65536 OR octet_length(p_receipt::text)>65536 THEN
    RAISE EXCEPTION 'Invalid private image candidate' USING ERRCODE='22023';
  END IF;
  IF p_provenance->>'kind' NOT IN ('uploaded','generated') OR p_provenance->>'kind' IS NULL
    OR coalesce(p_provenance->>'brandSha256','') !~ '^[0-9a-f]{64}$'
    OR length(coalesce(p_provenance->>'sourceName','')) NOT BETWEEN 1 AND 200
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_provenance) k WHERE k<>ALL(ARRAY['kind','brandSha256','sourceName','generation']))
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_receipt) k WHERE k<>ALL(ARRAY['outcome','code','requestSha256','providerRequestIdSha256','httpStatus','usage'])) THEN
    RAISE EXCEPTION 'Invalid private image provenance or safe receipt' USING ERRCODE='22023';
  END IF;
  IF p_provenance->>'kind'='generated' AND (jsonb_typeof(p_provenance->'generation') IS DISTINCT FROM 'object'
    OR coalesce(p_provenance#>>'{generation,intentId}','') !~ '^[0-9a-f-]{36}$'
    OR coalesce(p_provenance#>>'{generation,nonce}','') !~ '^[0-9a-f-]{36}$'
    OR coalesce(p_provenance#>>'{generation,requestSha256}','') !~ '^[0-9a-f]{64}$'
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_provenance->'generation') k WHERE k<>ALL(ARRAY['intentId','nonce','requestSha256']))) THEN
    RAISE EXCEPTION 'Generated candidate needs its durable source operation reference' USING ERRCODE='22023';
  END IF;
  PERFORM app_private.seo_media_lock_brand(p_workspace);
  IF p_provenance->>'kind'='generated' AND NOT EXISTS(SELECT 1 FROM app.seo_blog_image_attempts a WHERE a.workspace_id=p_workspace
    AND a.intent_id=(p_provenance#>>'{generation,intentId}')::uuid AND a.start_nonce=(p_provenance#>>'{generation,nonce}')::uuid
    AND encode(a.request_sha256,'hex')=p_provenance#>>'{generation,requestSha256}'
    AND encode(a.profile_sha256,'hex')=p_provenance->>'brandSha256') THEN
    RAISE EXCEPTION 'Generated image does not bind a real same-workspace admitted attempt' USING ERRCODE='42501';
  END IF;
  request_hash:=public.digest(jsonb_build_object('action','candidate','workspace',p_workspace,'actor',actor,
    'bytesSha',encode(public.digest(p_bytes,'sha256'),'hex'),'provenance',p_provenance,'receipt',p_receipt)::text,'sha256');
  replayed:=app_private.seo_media_replay(p_workspace,p_command,'candidate',actor,request_hash);
  IF replayed IS NOT NULL THEN RETURN replayed->'asset'; END IF;
  INSERT INTO app.seo_blog_blobs(workspace_id,id,mime,bytes,sha256)
    VALUES(p_workspace,blob_id,'image/jpeg',p_bytes,public.digest(p_bytes,'sha256'));
  INSERT INTO app.seo_blog_media_assets(id,workspace_id,blob_id,asset_kind,byte_sha256,byte_length,mime_type,provenance)
    VALUES(asset_id,p_workspace,blob_id,'candidate',public.digest(p_bytes,'sha256'),octet_length(p_bytes),'image/jpeg',p_provenance);
  result:=app_private.seo_media_asset_json(p_workspace,asset_id);
  PERFORM app_private.seo_media_command(p_workspace,p_command,'candidate',actor,request_hash,jsonb_build_object('asset',result,'transportReceipt',p_receipt));
  RETURN result;
END $f$;

CREATE FUNCTION app_private.seo_media_read_private(p_workspace uuid,p_session bytea,p_asset uuid,p_sha text)
RETURNS TABLE(asset jsonb,bytes bytea) LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
  PERFORM app_private.seo_media_private_actor(p_workspace,p_session);
  RETURN QUERY SELECT app_private.seo_media_asset_json(p_workspace,a.id),b.bytes
    FROM app.seo_blog_media_assets a JOIN app.seo_blog_blobs b ON b.workspace_id=a.workspace_id AND b.id=a.blob_id
    WHERE a.workspace_id=p_workspace AND a.id=p_asset AND encode(a.byte_sha256,'hex')=p_sha
      AND public.digest(b.bytes,'sha256')=a.byte_sha256 AND b.sha256=a.byte_sha256 AND octet_length(b.bytes)=a.byte_length;
END $f$;

CREATE FUNCTION app_private.seo_media_prepare(p_workspace uuid,p_session bytea,p_command uuid,p_source uuid,p_sha text,
  p_outcome text,p_detail text,p_bytes bytea[],p_recipes jsonb,p_dimensions jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; source app.seo_blog_media_assets%ROWTYPE; request_hash bytea; replayed jsonb; result jsonb;
  n integer:=coalesce(cardinality(p_bytes),0); i integer; recipe jsonb; item bytea; blob_id uuid; asset_id uuid;
  preparation_id uuid:=gen_random_uuid(); variants jsonb:='[]'; hashes jsonb:='[]'; source_width integer; source_height integer;
  w integer; h integer; profile text; seen_profiles text[]:=ARRAY[]::text[];
BEGIN
  actor:=app_private.seo_media_private_actor(p_workspace,p_session);
  IF p_command IS NULL OR p_source IS NULL OR coalesce(p_sha,'') !~ '^[0-9a-f]{64}$'
    OR jsonb_typeof(p_recipes) IS DISTINCT FROM 'array' OR n>3 OR jsonb_array_length(p_recipes)<>n
    OR p_outcome IS NULL OR p_outcome NOT IN ('prepared','rejected') THEN
    RAISE EXCEPTION 'Invalid local preparation result' USING ERRCODE='22023';
  END IF;
  IF p_outcome='prepared' THEN
    IF n<1 OR p_detail IS NOT NULL OR jsonb_typeof(p_dimensions) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'Prepared image requires measured source dimensions and bounded variants' USING ERRCODE='22023';
    END IF;
    source_width:=(p_dimensions->>'width')::integer; source_height:=(p_dimensions->>'height')::integer;
    IF source_width IS NULL OR source_height IS NULL OR source_width NOT BETWEEN 1 AND 8192 OR source_height NOT BETWEEN 1 AND 8192
      OR source_width::bigint*source_height>8000000 THEN RAISE EXCEPTION 'Unsafe measured source dimensions' USING ERRCODE='22023'; END IF;
  ELSIF n<>0 OR length(coalesce(p_detail,'')) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'Rejected preparation needs a bounded failure receipt and no variants' USING ERRCODE='22023';
  END IF;
  PERFORM app_private.seo_media_lock_brand(p_workspace);
  SELECT * INTO source FROM app.seo_blog_media_assets WHERE workspace_id=p_workspace AND id=p_source
    AND asset_kind='candidate' AND encode(byte_sha256,'hex')=p_sha;
  IF NOT FOUND THEN RAISE EXCEPTION 'Exact candidate not found' USING ERRCODE='P0002'; END IF;
  FOR i IN 1..n LOOP
    item:=p_bytes[i]; recipe:=p_recipes->(i-1); profile:=recipe->>'profile';
    IF item IS NULL OR octet_length(item) NOT BETWEEN 20 AND 600000 OR substring(item FROM 1 FOR 2)<>decode('ffd8','hex')
      OR substring(item FROM octet_length(item)-1 FOR 2)<>decode('ffd9','hex') OR jsonb_typeof(recipe) IS DISTINCT FROM 'object'
      OR recipe->>'version' IS DISTINCT FROM 'r72-jpeg-focal-v1' OR recipe->>'sourceSha256' IS DISTINCT FROM p_sha
      OR recipe->'metadataStripped' IS DISTINCT FROM 'true'::jsonb OR profile IS NULL OR profile<>ALL(ARRAY['blog','instagram','linkedin'])
      OR profile=ANY(seen_profiles) THEN RAISE EXCEPTION 'Variant is not an exact supported preparation output' USING ERRCODE='22023'; END IF;
    w:=(recipe->>'width')::integer; h:=(recipe->>'height')::integer;
    IF w IS NULL OR h IS NULL OR (profile='blog' AND (w<>1600 OR h<>900)) OR (profile='instagram' AND (w<>1080 OR h<>1350))
      OR (profile='linkedin' AND (w<>1200 OR h<>627)) OR coalesce((recipe->>'quality')::integer,0)<>ALL(ARRAY[85,70,55])
      OR jsonb_typeof(recipe#>'{focal,x}') IS DISTINCT FROM 'number' OR jsonb_typeof(recipe#>'{focal,y}') IS DISTINCT FROM 'number'
      OR (recipe#>>'{focal,x}')::numeric NOT BETWEEN 0 AND 1 OR (recipe#>>'{focal,y}')::numeric NOT BETWEEN 0 AND 1
      OR jsonb_typeof(recipe#>'{crop,x}') IS DISTINCT FROM 'number' OR jsonb_typeof(recipe#>'{crop,y}') IS DISTINCT FROM 'number'
      OR jsonb_typeof(recipe#>'{crop,width}') IS DISTINCT FROM 'number' OR jsonb_typeof(recipe#>'{crop,height}') IS DISTINCT FROM 'number'
      OR (recipe#>>'{crop,x}')::numeric<0 OR (recipe#>>'{crop,y}')::numeric<0 OR (recipe#>>'{crop,width}')::numeric<=0 OR (recipe#>>'{crop,height}')::numeric<=0
      OR (recipe#>>'{crop,x}')::numeric+(recipe#>>'{crop,width}')::numeric>source_width+0.000001
      OR (recipe#>>'{crop,y}')::numeric+(recipe#>>'{crop,height}')::numeric>source_height+0.000001 THEN
      RAISE EXCEPTION 'Variant recipe does not match measured preparation' USING ERRCODE='22023';
    END IF;
    seen_profiles:=array_append(seen_profiles,profile);
    hashes:=hashes||jsonb_build_array(encode(public.digest(item,'sha256'),'hex'));
  END LOOP;
  request_hash:=public.digest(jsonb_build_object('action','prepare','workspace',p_workspace,'actor',actor,'source',p_source,'sha',p_sha,
    'outcome',p_outcome,'detail',p_detail,'recipes',p_recipes,'sourceDimensions',p_dimensions,'byteHashes',hashes)::text,'sha256');
  replayed:=app_private.seo_media_replay(p_workspace,p_command,'prepare',actor,request_hash);
  IF replayed IS NOT NULL THEN RETURN replayed->'preparation'; END IF;
  FOR i IN 1..n LOOP
    item:=p_bytes[i]; recipe:=p_recipes->(i-1); blob_id:=gen_random_uuid(); asset_id:=gen_random_uuid();
    INSERT INTO app.seo_blog_blobs(workspace_id,id,mime,bytes,sha256) VALUES(p_workspace,blob_id,'image/jpeg',item,public.digest(item,'sha256'));
    INSERT INTO app.seo_blog_media_assets(id,workspace_id,blob_id,asset_kind,byte_sha256,byte_length,mime_type,width,height,source_asset_id,recipe,provenance)
      VALUES(asset_id,p_workspace,blob_id,'variant',public.digest(item,'sha256'),octet_length(item),'image/jpeg',(recipe->>'width')::integer,
        (recipe->>'height')::integer,p_source,recipe,source.provenance);
    variants:=variants||jsonb_build_array(app_private.seo_media_asset_json(p_workspace,asset_id));
  END LOOP;
  result:=jsonb_build_object('id',preparation_id,'workspaceId',p_workspace,'sourceAssetId',p_source,'sourceSha256',p_sha,
    'sourceDimensions',p_dimensions,'outcome',p_outcome,'variants',variants,'detail',p_detail);
  INSERT INTO app.seo_blog_media_preparations(id,workspace_id,source_asset_id,source_sha256,outcome,detail,result)
    VALUES(preparation_id,p_workspace,p_source,decode(p_sha,'hex'),p_outcome,p_detail,result);
  PERFORM app_private.seo_media_command(p_workspace,p_command,'prepare',actor,request_hash,jsonb_build_object('preparation',result));
  RETURN result;
END $f$;

CREATE FUNCTION app_private.seo_media_withdrawn(p_workspace uuid,p_asset uuid,p_release uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
  SELECT EXISTS(SELECT 1 FROM app.seo_blog_media_withdrawals w WHERE w.workspace_id=p_workspace AND w.asset_id=p_asset
    AND (w.scope='asset' OR (w.scope='release' AND w.release_id=p_release)))
$f$;

CREATE FUNCTION app_private.seo_media_reserve_use(p_workspace uuid,p_session bytea,p_command uuid,p_article uuid,p_asset uuid,p_sha text,p_origin text,p_presentation jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; request_hash bytea; replayed jsonb; asset app.seo_blog_media_assets%ROWTYPE;
  release_id uuid:=gen_random_uuid(); result jsonb; alt text;
BEGIN
  actor:=app_private.seo_media_owner(p_workspace,p_session);
  IF p_command IS NULL OR p_article IS NULL OR p_asset IS NULL OR coalesce(p_sha,'') !~ '^[0-9a-f]{64}$'
    OR coalesce(p_origin,'') !~ '^https://[a-z0-9][a-z0-9.-]*[a-z0-9]$' OR length(p_origin)>300
    OR jsonb_typeof(p_presentation) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Invalid prospective media use' USING ERRCODE='22023';
  END IF;
  alt:=p_presentation->>'alt';
  IF p_presentation->>'slot' IS DISTINCT FROM 'hero' OR jsonb_typeof(p_presentation->'alt') IS DISTINCT FROM 'string'
    OR length(btrim(coalesce(alt,''))) NOT BETWEEN 1 AND 200 OR alt ~ '[[:cntrl:]]'
    OR alt IS DISTINCT FROM btrim(alt)
    OR p_presentation->>'profile' IS DISTINCT FROM 'blog'
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_presentation) k WHERE k<>ALL(ARRAY['profile','slot','alt'])) THEN
    RAISE EXCEPTION 'An exact supported presentation and reviewed alt text are required' USING ERRCODE='22023';
  END IF;
  PERFORM app_private.seo_media_lock_brand(p_workspace);
  request_hash:=public.digest(jsonb_build_object('action','reserve_use','workspace',p_workspace,'actor',actor,'article',p_article,
    'asset',p_asset,'sha',p_sha,'origin',p_origin,'presentation',p_presentation)::text,'sha256');
  replayed:=app_private.seo_media_replay(p_workspace,p_command,'reserve_use',actor,request_hash);
  IF replayed IS NOT NULL THEN RETURN replayed; END IF;
  PERFORM 1 FROM app.seo_blog_articles WHERE workspace_id=p_workspace AND id=p_article FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Media article not found' USING ERRCODE='P0002'; END IF;
  SELECT * INTO asset FROM app.seo_blog_media_assets WHERE workspace_id=p_workspace AND id=p_asset
    AND asset_kind='variant' AND encode(byte_sha256,'hex')=p_sha AND recipe->>'profile'=p_presentation->>'profile';
  IF NOT FOUND OR app_private.seo_media_withdrawn(p_workspace,p_asset,NULL) THEN
    RAISE EXCEPTION 'Exact prepared media is unavailable' USING ERRCODE='55000';
  END IF;
  result:=jsonb_build_object('commandId',p_command,'workspaceId',p_workspace,'articleId',p_article,'assetId',p_asset,'assetSha256',p_sha,
    'prospectiveReleaseId',release_id,'prospectiveUrl',p_origin||'/api/public/seo-blog/media/'||release_id::text||'/'||p_sha||'.jpg',
    'presentation',p_presentation);
  PERFORM app_private.seo_media_command(p_workspace,p_command,'reserve_use',actor,request_hash,result,release_id);
  RETURN result;
END $f$;

CREATE FUNCTION app_private.seo_media_asset_manifest(p_workspace uuid,p_asset uuid,p_sha text,p_profile text,p_alt text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
  SELECT jsonb_build_object('schema','relaunch72.seo-media/v1','assetId',a.id,'byteSha256',encode(a.byte_sha256,'hex'),
    'byteLength',a.byte_length,'mimeType',a.mime_type,'width',a.width,'height',a.height,'recipe',a.recipe,
    'presentation',jsonb_build_object('profile',p_profile,'alt',p_alt),'provenance',a.provenance)
  FROM app.seo_blog_media_assets a
  JOIN app.seo_blog_blobs b ON b.workspace_id=a.workspace_id AND b.id=a.blob_id
  JOIN app.seo_blog_media_assets original ON original.workspace_id=a.workspace_id AND original.id=a.source_asset_id AND original.asset_kind='candidate'
  JOIN app.seo_blog_blobs original_blob ON original_blob.workspace_id=original.workspace_id AND original_blob.id=original.blob_id
  WHERE a.workspace_id=p_workspace AND a.id=p_asset AND encode(a.byte_sha256,'hex')=p_sha AND a.asset_kind='variant'
    AND p_profile=ANY(ARRAY['blog','instagram','linkedin']) AND a.recipe->>'profile'=p_profile
    AND length(p_alt) BETWEEN 1 AND 200 AND p_alt=btrim(p_alt) AND p_alt !~ '[[:cntrl:]]'
    AND a.mime_type='image/jpeg' AND a.recipe->>'sourceSha256'=encode(original.byte_sha256,'hex')
    AND a.recipe->'metadataStripped'='true'::jsonb AND (a.recipe->>'width')::integer=a.width AND (a.recipe->>'height')::integer=a.height
    AND substring(b.bytes FROM 1 FOR 2)=decode('ffd8','hex') AND substring(b.bytes FROM octet_length(b.bytes)-1 FOR 2)=decode('ffd9','hex')
    AND public.digest(b.bytes,'sha256')=a.byte_sha256 AND b.sha256=a.byte_sha256 AND octet_length(b.bytes)=a.byte_length
    AND public.digest(original_blob.bytes,'sha256')=original.byte_sha256 AND original_blob.sha256=original.byte_sha256
    AND octet_length(original_blob.bytes)=original.byte_length AND NOT app_private.seo_media_withdrawn(p_workspace,a.id,NULL)
$f$;

CREATE FUNCTION app_private.seo_media_manifest(p_workspace uuid,p_reservation uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
  SELECT app_private.seo_media_asset_manifest(p_workspace,(c.result->>'assetId')::uuid,c.result->>'assetSha256',
    c.result#>>'{presentation,profile}',c.result#>>'{presentation,alt}') FROM app.seo_blog_media_commands c
  WHERE c.workspace_id=p_workspace AND c.id=p_reservation AND c.action='reserve_use'
$f$;

CREATE FUNCTION app_private.seo_media_review_manifest(p_workspace uuid,p_session bytea,p_reservation uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
  PERFORM app_private.seo_media_owner(p_workspace,p_session);
  RETURN app_private.seo_media_manifest(p_workspace,p_reservation);
END $f$;

CREATE FUNCTION app_private.seo_media_quality_eligible(p_workspace uuid,p_manifest jsonb,p_canonical jsonb)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE item_id uuid:=(p_canonical->>'contentItemId')::uuid; version_id uuid:=(p_canonical->>'contentVersionId')::uuid;
  request_id uuid:=(p_canonical->>'approvalRequestId')::uuid; decision_id uuid:=(p_canonical->>'approvalDecisionId')::uuid;
  manifest jsonb:=p_manifest; selected_version app.company_content_versions%ROWTYPE;
BEGIN
  IF item_id IS NULL OR version_id IS NULL OR request_id IS NULL OR decision_id IS NULL
    OR coalesce(p_canonical->>'contentSha256','') !~ '^[0-9a-f]{64}$' THEN
    RETURN false;
  END IF;
  SELECT * INTO selected_version FROM app.company_content_versions v WHERE v.workspace_id=p_workspace
    AND v.content_item_id=item_id AND v.id=version_id AND encode(v.content_sha256,'hex')=p_canonical->>'contentSha256';
  IF NOT FOUND OR manifest IS NULL OR selected_version.content_kind<>'image' OR selected_version.content_mime_type<>'application/json'
    OR selected_version.content_body::jsonb IS DISTINCT FROM manifest
    OR encode(selected_version.blob_sha256,'hex') IS DISTINCT FROM manifest->>'byteSha256'
    OR encode(selected_version.brand_sha256,'hex') IS DISTINCT FROM manifest#>>'{provenance,brandSha256}'
    OR selected_version.blob_storage_key IS DISTINCT FROM 'seo-blog-media/'||(manifest->>'assetId')||'/'||(manifest->>'byteSha256')
    OR selected_version.source_system IS DISTINCT FROM 'relaunch72.seo-media'
    OR selected_version.source_item_id IS DISTINCT FROM manifest->>'assetId'
    OR selected_version.source_version IS DISTINCT FROM 'media:v1:'||(manifest->>'byteSha256')||':'||(manifest#>>'{presentation,profile}')||':'||
      encode(public.digest(manifest#>>'{presentation,alt}','sha256'),'hex') THEN
    RETURN false;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM app.company_content_approval_requests r JOIN app.company_content_approval_decisions d
      ON d.workspace_id=r.workspace_id AND d.approval_request_id=r.id AND d.content_item_id=r.content_item_id
      AND d.content_version_id=r.content_version_id AND d.content_sha256=r.content_sha256
    WHERE r.workspace_id=p_workspace AND r.id=request_id AND d.id=decision_id AND d.decision='approved'
      AND r.content_item_id=item_id AND r.content_version_id=version_id AND r.content_sha256=selected_version.content_sha256
      AND NOT EXISTS(SELECT 1 FROM app.company_content_approval_requests later WHERE later.workspace_id=p_workspace
        AND later.content_item_id=item_id AND later.content_version_id=version_id AND later.request_number>r.request_number)) THEN
    RETURN false;
  END IF;
  RETURN true;
EXCEPTION WHEN data_exception THEN RETURN false;
END $f$;

CREATE FUNCTION app_private.seo_media_assert_manifest(p_workspace uuid,p_manifest jsonb,p_canonical jsonb)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
  -- Same lock as canonical version/request/decision insert guards. No legacy guard is changed.
  PERFORM pg_advisory_xact_lock(hashtextextended('company-content:'||p_workspace::text||':'||(p_canonical->>'contentItemId'),7200021));
  IF NOT app_private.seo_media_quality_eligible(p_workspace,p_manifest,p_canonical) THEN
    RAISE EXCEPTION 'Exact selected canonical image/pixels/presentation/latest eligible approval required' USING ERRCODE='55000';
  END IF;
END $f$;

CREATE FUNCTION app_private.seo_media_assert_canonical(p_workspace uuid,p_reservation uuid,p_canonical jsonb)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
  PERFORM app_private.seo_media_assert_manifest(p_workspace,app_private.seo_media_manifest(p_workspace,p_reservation),p_canonical);
END $f$;

CREATE FUNCTION app_private.seo_media_review_asset(p_workspace uuid,p_session bytea,p_asset uuid,p_sha text,p_profile text,p_alt text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
  PERFORM app_private.seo_media_owner(p_workspace,p_session);
  PERFORM app_private.seo_media_lock_brand(p_workspace);
  RETURN app_private.seo_media_asset_manifest(p_workspace,p_asset,p_sha,p_profile,p_alt);
END $f$;

CREATE FUNCTION app_private.seo_media_authorization_json(p_workspace uuid,p_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
  SELECT jsonb_build_object('id',a.id,'useKind',a.use_kind,'socialUse',a.social_use,'workspaceId',a.workspace_id,'reservationCommandId',a.reservation_command_id,'assetId',a.asset_id,
    'assetSha256',encode(a.asset_sha256,'hex'),'articleVersionId',a.article_version_id,'articleContentSha256',a.article_content_sha256,
    'reviewedIntentSha256',encode(a.reviewed_intent_sha256,'hex'),'authorizingUserId',a.authorizing_user_id,'canonical',jsonb_build_object(
      'contentItemId',a.canonical_item_id,'contentVersionId',a.canonical_version_id,'contentSha256',encode(a.canonical_content_sha256,'hex'),
      'approvalRequestId',a.approval_request_id,'approvalDecisionId',a.approval_decision_id))
  FROM app.seo_blog_media_owner_authorizations a WHERE a.workspace_id=p_workspace AND a.id=p_id
$f$;

CREATE FUNCTION app_private.seo_media_authorize(p_workspace uuid,p_session bytea,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; command_id uuid:=(p_input->>'commandId')::uuid; reservation_id uuid:=(p_input->>'reservationCommandId')::uuid;
  version_id uuid:=(p_input->>'articleVersionId')::uuid; authorization_id uuid:=gen_random_uuid(); request_hash bytea; replayed jsonb;
  reservation app.seo_blog_media_commands%ROWTYPE; version app.seo_blog_article_versions%ROWTYPE; article app.seo_blog_articles%ROWTYPE; result jsonb;
BEGIN
  actor:=app_private.seo_media_owner(p_workspace,p_session);
  IF command_id IS NULL OR reservation_id IS NULL OR version_id IS NULL OR coalesce(p_input->>'articleContentSha256','') !~ '^[0-9a-f]{64}$'
    OR coalesce(p_input->>'reviewedIntentSha256','') !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'Invalid exact media authorization' USING ERRCODE='22023'; END IF;
  PERFORM app_private.seo_media_lock_brand(p_workspace);
  request_hash:=public.digest(jsonb_build_object('action','authorize','workspace',p_workspace,'actor',actor,'input',p_input)::text,'sha256');
  replayed:=app_private.seo_media_replay(p_workspace,command_id,'authorize',actor,request_hash);
  IF replayed IS NOT NULL THEN RETURN replayed; END IF;
  SELECT * INTO reservation FROM app.seo_blog_media_commands WHERE workspace_id=p_workspace AND id=reservation_id AND action='reserve_use';
  IF NOT FOUND THEN RAISE EXCEPTION 'Prospective media URL was not reserved' USING ERRCODE='55000'; END IF;
  SELECT * INTO article FROM app.seo_blog_articles WHERE workspace_id=p_workspace AND id=(reservation.result->>'articleId')::uuid FOR UPDATE;
  SELECT * INTO version FROM app.seo_blog_article_versions WHERE workspace_id=p_workspace AND id=version_id
    AND article_id=article.id AND content_sha256=p_input->>'articleContentSha256';
  IF article.id IS NULL OR version.id IS NULL OR article.data->>'currentVersionId' IS DISTINCT FROM version_id::text
    OR coalesce(version.data#>>'{websiteTarget,deliverySha}',version.content_sha256) IS DISTINCT FROM p_input->>'reviewedIntentSha256'
    OR version.data#>>'{body,image,url}' IS DISTINCT FROM reservation.result->>'prospectiveUrl'
    OR version.data#>>'{body,image,alt}' IS DISTINCT FROM reservation.result#>>'{presentation,alt}'
    OR app_private.seo_media_withdrawn(p_workspace,(reservation.result->>'assetId')::uuid,reservation.prospective_release_id) THEN
    RAISE EXCEPTION 'Final reviewed article does not contain the exact prospective image URL and alt' USING ERRCODE='55000';
  END IF;
  PERFORM app_private.seo_media_assert_canonical(p_workspace,reservation_id,p_input->'canonical');
  INSERT INTO app.seo_blog_media_owner_authorizations(id,workspace_id,reservation_command_id,asset_id,asset_sha256,article_version_id,
    article_content_sha256,reviewed_intent_sha256,canonical_item_id,canonical_version_id,canonical_content_sha256,
    approval_request_id,approval_decision_id,authorizing_user_id)
    VALUES(authorization_id,p_workspace,reservation_id,(reservation.result->>'assetId')::uuid,decode(reservation.result->>'assetSha256','hex'),version_id,
      version.content_sha256,decode(p_input->>'reviewedIntentSha256','hex'),(p_input#>>'{canonical,contentItemId}')::uuid,
      (p_input#>>'{canonical,contentVersionId}')::uuid,decode(p_input#>>'{canonical,contentSha256}','hex'),
      (p_input#>>'{canonical,approvalRequestId}')::uuid,(p_input#>>'{canonical,approvalDecisionId}')::uuid,actor);
  result:=app_private.seo_media_authorization_json(p_workspace,authorization_id);
  PERFORM app_private.seo_media_command(p_workspace,command_id,'authorize',actor,request_hash,result);
  RETURN result;
END $f$;

CREATE FUNCTION app_private.seo_media_withdraw(p_workspace uuid,p_session bytea,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; command_id uuid:=(p_input->>'commandId')::uuid; asset_id uuid; release_id uuid;
  withdrawal_id uuid:=gen_random_uuid(); request_hash bytea; replayed jsonb; result jsonb; withdrawn_at timestamptz:=clock_timestamp();
BEGIN
  actor:=app_private.seo_media_owner(p_workspace,p_session);
  IF command_id IS NULL OR p_input->>'scope' IS NULL OR p_input->>'scope' NOT IN ('asset','release')
    OR coalesce(p_input->>'assetSha256','') !~ '^[0-9a-f]{64}$'
    OR length(btrim(coalesce(p_input->>'reason',''))) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'Exact image withdrawal and reason required' USING ERRCODE='22023';
  END IF;
  PERFORM app_private.seo_media_lock_brand(p_workspace);
  request_hash:=public.digest(jsonb_build_object('action','withdraw','workspace',p_workspace,'actor',actor,'input',p_input)::text,'sha256');
  replayed:=app_private.seo_media_replay(p_workspace,command_id,'withdraw',actor,request_hash);
  IF replayed IS NOT NULL THEN RETURN replayed; END IF;
  IF p_input->>'scope'='asset' THEN
    asset_id:=(p_input->>'assetId')::uuid;
  ELSE
    release_id:=(p_input->>'releaseId')::uuid;
    SELECT (c.result->>'assetId')::uuid INTO asset_id FROM app.seo_blog_media_commands c
      WHERE c.workspace_id=p_workspace AND c.prospective_release_id=release_id AND c.action='reserve_use';
  END IF;
  IF asset_id IS NULL OR NOT EXISTS(SELECT 1 FROM app.seo_blog_media_assets a WHERE a.workspace_id=p_workspace AND a.id=asset_id
    AND encode(a.byte_sha256,'hex')=p_input->>'assetSha256') THEN
    RAISE EXCEPTION 'Exact image withdrawal target not found' USING ERRCODE='P0002';
  END IF;
  INSERT INTO app.seo_blog_media_withdrawals(id,workspace_id,scope,asset_id,asset_sha256,release_id,reason,actor_user_id,created_at)
    VALUES(withdrawal_id,p_workspace,p_input->>'scope',asset_id,decode(p_input->>'assetSha256','hex'),release_id,btrim(p_input->>'reason'),actor,withdrawn_at);
  result:=jsonb_build_object('id',withdrawal_id,'scope',p_input->>'scope','targetId',coalesce(release_id,asset_id),
    'assetSha256',p_input->>'assetSha256','withdrawnAt',withdrawn_at);
  PERFORM app_private.seo_media_command(p_workspace,command_id,'withdraw',actor,request_hash,result);
  RETURN result;
END $f$;

-- This reader deliberately consults the durable release and explicit withdrawal history only.
-- A later draft, canonical revision or membership removal cannot erase an already-reviewed public image.
CREATE FUNCTION app_private.read_released_seo_media(p_release uuid,p_sha text)
RETURNS TABLE(release_id uuid,sha256 text,mime_type text,bytes bytea)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
  SELECT r.release_id,encode(a.byte_sha256,'hex'),a.mime_type,b.bytes
    FROM app.seo_blog_media_public_releases r
    JOIN app.seo_blog_media_assets a ON a.workspace_id=r.workspace_id AND a.id=r.asset_id AND a.byte_sha256=r.asset_sha256
    JOIN app.seo_blog_blobs b ON b.workspace_id=a.workspace_id AND b.id=a.blob_id
    WHERE r.release_id=p_release AND encode(a.byte_sha256,'hex')=p_sha AND a.asset_kind='variant'
      AND b.sha256=a.byte_sha256 AND public.digest(b.bytes,'sha256')=a.byte_sha256 AND octet_length(b.bytes)=a.byte_length
      AND NOT app_private.seo_media_withdrawn(r.workspace_id,r.asset_id,r.release_id)
    ORDER BY r.created_at,r.id LIMIT 1
$f$;

CREATE FUNCTION app_private.seo_media_destination_identity(p_destination jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
  SELECT jsonb_build_object('id',p_destination->'id','brandId',p_destination->'brandId','type',p_destination->'type',
    'publicBaseUrl',p_destination->'publicBaseUrl','config',p_destination->'config','sealedCredential',p_destination->'sealedCredential',
    'capability',CASE WHEN p_destination#>>'{websiteCapability,protocol}'='v2' THEN jsonb_build_object('protocol','v2',
      'capabilities',p_destination#>'{websiteCapability,capabilities}') WHEN p_destination->'websiteCapability' IS NOT NULL
      AND p_destination->'websiteCapability'<>'null'::jsonb THEN jsonb_build_object('protocol','legacy') ELSE 'null'::jsonb END)
$f$;

CREATE FUNCTION app_private.seo_media_publication_boundary(p_workspace uuid,p_session bytea,p_publication uuid,p_authorization uuid,p_intent_sha text,p_release boolean)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; brand app.seo_blog_brands%ROWTYPE; article app.seo_blog_articles%ROWTYPE;
  publication app.seo_blog_publications%ROWTYPE; media_authorization app.seo_blog_media_owner_authorizations%ROWTYPE;
  reservation app.seo_blog_media_commands%ROWTYPE; version app.seo_blog_article_versions%ROWTYPE;
  asset app.seo_blog_media_assets%ROWTYPE; previous app.seo_blog_media_public_releases%ROWTYPE;
  binding_id uuid:=gen_random_uuid(); result jsonb; canonical jsonb; destination jsonb;
BEGIN
  -- Only the command role owns this wrapper; helpers are not runtime capabilities.
  actor:=app_private.seo_media_private_actor(p_workspace,p_session);
  IF p_publication IS NULL OR p_authorization IS NULL OR coalesce(p_intent_sha,'') !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Exact publication image binding required' USING ERRCODE='22023';
  END IF;
  -- Compatible with beginPublication's existing brand SHARE lock: never upgrade it after article lock.
  SELECT * INTO brand FROM app.seo_blog_brands WHERE workspace_id=p_workspace FOR SHARE;
  SELECT * INTO media_authorization FROM app.seo_blog_media_owner_authorizations WHERE workspace_id=p_workspace AND id=p_authorization;
  IF brand.workspace_id IS NULL OR media_authorization.id IS NULL THEN RAISE EXCEPTION 'Media authorization not found' USING ERRCODE='P0002'; END IF;
  IF media_authorization.use_kind<>'blog_hero' THEN RAISE EXCEPTION 'Social use cannot release a public hero' USING ERRCODE='42501'; END IF;
  SELECT * INTO reservation FROM app.seo_blog_media_commands WHERE workspace_id=p_workspace AND id=media_authorization.reservation_command_id;
  SELECT * INTO version FROM app.seo_blog_article_versions WHERE workspace_id=p_workspace AND id=media_authorization.article_version_id;
  SELECT * INTO article FROM app.seo_blog_articles WHERE workspace_id=p_workspace AND id=version.article_id FOR UPDATE;
  SELECT * INTO publication FROM app.seo_blog_publications WHERE workspace_id=p_workspace AND id=p_publication FOR UPDATE;
  SELECT * INTO previous FROM app.seo_blog_media_public_releases WHERE workspace_id=p_workspace AND publication_id=p_publication AND slot='hero';
  IF previous.id IS NOT NULL THEN
    IF previous.owner_authorization_id<>p_authorization OR media_authorization.reviewed_intent_sha256<>decode(p_intent_sha,'hex') THEN
      RAISE EXCEPTION 'Publication media receipt conflicts with its immutable input' USING ERRCODE='23505';
    END IF;
    IF p_release THEN RETURN previous.snapshot; END IF;
  END IF;
  -- Existing destination upserts take the brand UPDATE lock; this boundary's SHARE lock pins their semantic identity.
  SELECT r.data INTO destination FROM app.seo_blog_records r WHERE r.workspace_id=p_workspace AND r.kind='destination'
    AND r.id=publication.data->>'destinationId';
  IF article.id IS NULL OR publication.id IS NULL OR publication.article_id<>article.id OR publication.version_id<>version.id
    OR publication.state<>'prepared' OR article.data->>'currentVersionId' IS DISTINCT FROM version.id::text
    OR publication.data->>'contentSha' IS DISTINCT FROM version.content_sha256
    OR media_authorization.article_content_sha256<>version.content_sha256
    OR media_authorization.reviewed_intent_sha256<>decode(p_intent_sha,'hex')
    OR publication.data#>>'{websiteSnapshot,reviewedIntentSha}' IS DISTINCT FROM p_intent_sha
    OR destination->>'status' IS DISTINCT FROM 'connected'
    OR destination->>'id' IS DISTINCT FROM publication.data->>'destinationId'
    OR destination->>'brandId' IS DISTINCT FROM p_workspace::text
    OR app_private.seo_media_destination_identity(destination) IS DISTINCT FROM
      app_private.seo_media_destination_identity(publication.data#>'{websiteSnapshot,destination}')
    OR coalesce(publication.data#>'{websiteSnapshot,target}','null') IS DISTINCT FROM coalesce(version.data->'websiteTarget','null')
    OR (version.data->'websiteTarget' IS NOT NULL AND version.data->'websiteTarget'<>'null'::jsonb AND (
      version.data#>>'{websiteTarget,destinationId}' IS DISTINCT FROM publication.data->>'destinationId'
      OR version.data#>>'{websiteTarget,target,canonicalUrl}' IS DISTINCT FROM publication.data->>'publicUrl'
      OR destination#>>'{websiteCapability,protocol}' IS DISTINCT FROM 'v2'
      OR destination#>>'{websiteCapability,capabilities,siteId}' IS DISTINCT FROM version.data#>>'{websiteTarget,target,siteId}'
      OR destination#>>'{websiteCapability,capabilities,capabilitiesSha}' IS DISTINCT FROM version.data#>>'{websiteTarget,target,capabilitiesSha}'))
    OR coalesce(version.data#>>'{websiteTarget,deliverySha}',version.content_sha256) IS DISTINCT FROM p_intent_sha
    OR version.data#>>'{body,image,url}' IS DISTINCT FROM reservation.result->>'prospectiveUrl'
    OR version.data#>>'{body,image,alt}' IS DISTINCT FROM reservation.result#>>'{presentation,alt}'
    OR coalesce((brand.settings->>'pauseAll')::boolean,false)
    OR article.held OR article.data->'hold' IS DISTINCT FROM 'null'::jsonb
    OR NOT app_private.can_manage_workspace(media_authorization.authorizing_user_id,p_workspace)
    OR app_private.seo_media_withdrawn(p_workspace,media_authorization.asset_id,reservation.prospective_release_id) THEN
    RAISE EXCEPTION 'Current publication/image authorization is held or stale' USING ERRCODE='55000';
  END IF;
  -- Preserve the established approved/auto-unflagged publication policy; image review remains mandatory in either case.
  IF publication.data#>>'{policy,rule}'='approved' THEN
    IF publication.data#>>'{policy,approvedVersionId}' IS DISTINCT FROM version.id::text
      OR article.data#>>'{approval,versionId}' IS DISTINCT FROM version.id::text
      OR article.data#>>'{approval,contentSha}' IS DISTINCT FROM version.content_sha256 THEN
      RAISE EXCEPTION 'Article publication approval changed' USING ERRCODE='55000';
    END IF;
  ELSIF publication.data#>>'{policy,rule}' IS DISTINCT FROM 'auto_unflagged'
    OR publication.data#>'{policy,autoPublish}' IS DISTINCT FROM 'true'::jsonb
    OR publication.data#>'{policy,requiresApproval}' IS DISTINCT FROM 'false'::jsonb
    OR NOT coalesce((brand.settings->>'autoPublish')::boolean,false)
    OR coalesce((article.data->>'requiresApproval')::boolean,true) THEN
    RAISE EXCEPTION 'Current article publication policy is not eligible' USING ERRCODE='55000';
  END IF;
  IF article.data#>>'{checks,versionId}' IS DISTINCT FROM version.id::text
    OR article.data#>>'{checks,contentSha}' IS DISTINCT FROM version.content_sha256
    OR coalesce(article.data#>>'{checks,status}','critical')='critical' THEN
    RAISE EXCEPTION 'Exact current article checks required' USING ERRCODE='55000';
  END IF;
  canonical:=jsonb_build_object('contentItemId',media_authorization.canonical_item_id,'contentVersionId',media_authorization.canonical_version_id,
    'contentSha256',encode(media_authorization.canonical_content_sha256,'hex'),'approvalRequestId',media_authorization.approval_request_id,
    'approvalDecisionId',media_authorization.approval_decision_id);
  PERFORM app_private.seo_media_assert_canonical(p_workspace,reservation.id,canonical);
  SELECT * INTO asset FROM app.seo_blog_media_assets WHERE workspace_id=p_workspace AND id=media_authorization.asset_id
    AND byte_sha256=media_authorization.asset_sha256 AND asset_kind='variant';
  IF asset.id IS NULL THEN RAISE EXCEPTION 'Prepared exact image missing' USING ERRCODE='55000'; END IF;
  IF NOT p_release THEN RETURN jsonb_build_object('eligible',true); END IF;
  result:=jsonb_build_object('id',reservation.prospective_release_id,'bindingId',binding_id,'workspaceId',p_workspace,
    'publicationId',p_publication,'ownerAuthorizationId',p_authorization,'assetId',asset.id,'assetSha256',encode(asset.byte_sha256,'hex'),
    'publicUrl',reservation.result->>'prospectiveUrl','mimeType',asset.mime_type,'width',asset.width,'height',asset.height,
    'alt',reservation.result#>>'{presentation,alt}');
  INSERT INTO app.seo_blog_media_public_releases(id,workspace_id,release_id,publication_id,owner_authorization_id,reservation_command_id,
    asset_id,asset_sha256,slot,snapshot) VALUES(binding_id,p_workspace,reservation.prospective_release_id,p_publication,p_authorization,
      reservation.id,asset.id,asset.byte_sha256,'hero',result);
  RETURN result;
END $f$;

-- Fixed modes: history/release replay never substitutes for current authority to perform a new website write.
CREATE FUNCTION app_private.seo_media_release(p_workspace uuid,p_session bytea,p_publication uuid,p_authorization uuid,p_intent_sha text)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
  SELECT app_private.seo_media_publication_boundary(p_workspace,p_session,p_publication,p_authorization,p_intent_sha,true)
$f$;
CREATE FUNCTION app_private.seo_media_assert_publication_effect(p_workspace uuid,p_session bytea,p_publication uuid,p_authorization uuid,p_intent_sha text)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
  PERFORM app_private.seo_media_publication_boundary(p_workspace,p_session,p_publication,p_authorization,p_intent_sha,false);
END $f$;

-- Image-attempt admission and final ACL closure follow below before freeze.
CREATE FUNCTION app_private.seo_image_source(p_workspace uuid,p_article uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE profile jsonb; documents jsonb; version app.seo_blog_article_versions%ROWTYPE; article app.seo_blog_articles%ROWTYPE;
  snapshot jsonb; visual jsonb; website text; brand_name text;
BEGIN
  SELECT data INTO profile FROM app.seo_blog_records WHERE workspace_id=p_workspace AND kind='profile' ORDER BY id DESC LIMIT 1;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',d.data->'id','version',d.data->'version','category',d.data->'category','title',d.data->'title',
    'sha256',d.data->'sha256','blobId',d.data->'blobId','status',d.data->'status',
    'hasText',length(coalesce(d.data->>'text',''))>0,'textSha256',encode(public.digest(coalesce(d.data->>'text',''),'sha256'),'hex')) ORDER BY d.data->>'id'),'[]') INTO documents FROM (
    SELECT DISTINCT ON (r.data->>'id') r.data FROM app.seo_blog_records r
    WHERE workspace_id=p_workspace AND kind='knowledge' ORDER BY r.data->>'id',(r.data->>'version')::integer DESC
  ) d WHERE coalesce((d.data->>'active')::boolean,false);
  SELECT * INTO article FROM app.seo_blog_articles WHERE workspace_id=p_workspace AND id=p_article;
  SELECT * INTO version FROM app.seo_blog_article_versions WHERE workspace_id=p_workspace AND id=(article.data->>'currentVersionId')::uuid;
  SELECT b.website INTO website FROM app.seo_blog_brands b WHERE b.workspace_id=p_workspace;
  SELECT app_private.seo_blog_brand(p_workspace)->>'name' INTO brand_name;
  IF article.id IS NULL OR version.id IS NULL OR version.article_id<>article.id THEN RETURN NULL; END IF;
  SELECT coalesce(jsonb_agg(d ORDER BY d->>'id'),'[]') INTO visual FROM jsonb_array_elements(documents) d WHERE d->>'category'='visual_guidance';
  snapshot:=jsonb_build_object('recipe','seo-image-source-v1','brandName',brand_name,'profile',profile,'knowledge',documents,'website',website,
    'articleId',article.id,'articleVersionId',version.id,'articleContentSha256',version.content_sha256,'articleBody',version.data->'body');
  RETURN jsonb_build_object('recipe','seo-image-source-v1','workspaceId',p_workspace,'articleId',article.id,'articleVersionId',version.id,
    'articleContentSha256',version.content_sha256,'snapshot',snapshot,'sourceSha256',encode(public.digest(snapshot::text,'sha256'),'hex'),
    'profileSha256',encode(public.digest(coalesce(profile,'null')::text,'sha256'),'hex'),
    'visualSha256',encode(public.digest(visual::text,'sha256'),'hex'));
END $f$;

CREATE FUNCTION app_private.seo_image_source_hold(p_workspace uuid,p_source jsonb,p_sponsor uuid,p_automatic boolean)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE settings jsonb; profile jsonb:=p_source#>'{snapshot,profile}'; documents jsonb:=p_source#>'{snapshot,knowledge}'; current_refs jsonb; approved_refs jsonb;
BEGIN
  SELECT b.settings INTO settings FROM app.seo_blog_brands b WHERE b.workspace_id=p_workspace;
  IF settings IS NULL OR p_source IS NULL THEN RETURN 'source_missing'; END IF;
  IF settings#>'{media,imageGenerationEnabled}' IS DISTINCT FROM 'true'::jsonb THEN RETURN 'image_generation_disabled'; END IF;
  IF coalesce((settings->>'pauseAll')::boolean,false) THEN RETURN 'programme_paused'; END IF;
  IF p_automatic AND settings->'ongoingProduction' IS DISTINCT FROM 'true'::jsonb THEN RETURN 'ongoing_production_disabled'; END IF;
  IF profile IS NULL OR profile->>'confirmedAt' IS NULL THEN RETURN 'profile_unconfirmed'; END IF;
  IF p_sponsor IS NULL OR NOT app_private.can_manage_workspace(p_sponsor,p_workspace) THEN RETURN 'sponsor_ineligible'; END IF;
  IF p_automatic AND profile->>'confirmedBy' IS DISTINCT FROM p_sponsor::text THEN RETURN 'sponsor_changed'; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',d->>'id','sha',d->>'sha256') ORDER BY d->>'id'),'[]') INTO current_refs
    FROM jsonb_array_elements(coalesce(documents,'[]')) d WHERE d->>'category'=ANY(ARRAY['product_facts','approved_claims','faqs','brand_guidelines','other'])
      AND coalesce((d->>'hasText')::boolean,false);
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',d->>'documentId','sha',d->>'sha256') ORDER BY d->>'documentId'),'[]') INTO approved_refs
    FROM jsonb_array_elements(coalesce(profile->'knowledge','[]')) d WHERE d->>'category'=ANY(ARRAY['product_facts','approved_claims','faqs','brand_guidelines','other']);
  IF current_refs IS DISTINCT FROM approved_refs THEN RETURN 'profile_facts_changed'; END IF;
  RETURN NULL;
END $f$;

CREATE FUNCTION app_private.seo_image_read_source(p_workspace uuid,p_session bytea,p_article uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
  PERFORM app_private.seo_media_private_actor(p_workspace,p_session);
  PERFORM app_private.seo_media_lock_brand(p_workspace);
  RETURN app_private.seo_image_source(p_workspace,p_article);
END $f$;

CREATE FUNCTION app_private.seo_image_check_intent(p_workspace uuid,p_session bytea,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; sponsor uuid:=(p_input->>'sponsorUserId')::uuid; source jsonb; reason text; automatic boolean;
  retained app.seo_blog_jobs%ROWTYPE; prior app.seo_blog_image_attempts%ROWTYPE;
BEGIN
  actor:=app_private.seo_media_private_actor(p_workspace,p_session); automatic:=actor IS NULL;
  PERFORM app_private.seo_media_lock_brand(p_workspace);
  IF NOT automatic AND actor IS DISTINCT FROM sponsor THEN RAISE EXCEPTION 'Image intent sponsor must be actual requester' USING ERRCODE='42501'; END IF;
  -- Same-source active work wins even over a new confirmed command; no double-click or concurrent-init second start.
  SELECT * INTO retained FROM app.seo_blog_jobs j WHERE j.workspace_id=p_workspace AND j.kind='write'
    AND j.data#>>'{payload,stage}'='image' AND j.data#>>'{payload,image,schema}'='relaunch72.seo-image-intent/v1'
    AND j.data#>'{payload,image,source}'=p_input->'source' AND j.state IN ('queued','running') ORDER BY j.created_at,j.id LIMIT 1;
  IF retained.id IS NOT NULL THEN RETURN jsonb_build_object('kind','existing_job','job',retained.data||jsonb_build_object('state',retained.state,'rowVersion',retained.row_version)); END IF;
  IF automatic THEN
    SELECT * INTO retained FROM app.seo_blog_jobs j WHERE j.workspace_id=p_workspace AND j.kind='write'
      AND j.data#>>'{payload,stage}'='image' AND j.data#>>'{payload,image,schema}'='relaunch72.seo-image-intent/v1'
      AND j.data#>>'{payload,image,articleId}'=p_input#>>'{source,articleId}'
      AND j.data#>>'{payload,image,articleVersionId}'=p_input#>>'{source,articleVersionId}' ORDER BY j.created_at DESC,j.id DESC LIMIT 1;
    IF retained.id IS NOT NULL THEN RETURN jsonb_build_object('kind','existing_job','job',retained.data||jsonb_build_object('state',retained.state,'rowVersion',retained.row_version)); END IF;
  ELSE
    SELECT * INTO prior FROM app.seo_blog_image_attempts a WHERE a.workspace_id=p_workspace
      AND a.source_snapshot->>'articleId'=p_input#>>'{source,articleId}' ORDER BY a.created_at DESC,a.id DESC LIMIT 1;
    IF prior.id IS NOT NULL AND (p_input->'confirmedNewIntent' IS DISTINCT FROM 'true'::jsonb
      OR p_input->>'replacesIntentId' IS DISTINCT FROM prior.intent_id::text) THEN
      RETURN jsonb_build_object('kind','held','reason','new_intent_confirmation_required','replacesIntentId',prior.intent_id);
    END IF;
  END IF;
  source:=app_private.seo_image_source(p_workspace,(p_input#>>'{source,articleId}')::uuid);
  IF source IS DISTINCT FROM p_input->'source' THEN RETURN jsonb_build_object('kind','held','reason','source_changed'); END IF;
  reason:=app_private.seo_image_source_hold(p_workspace,source,sponsor,automatic);
  IF reason IS NOT NULL THEN RETURN jsonb_build_object('kind','held','reason',reason); END IF;
  RETURN jsonb_build_object('kind','ready','automatic',automatic,'source',source);
END $f$;

CREATE FUNCTION app_private.seo_image_alias_actor(p_workspace uuid,p_session bytea,p_sponsor uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; profile jsonb; confirmer uuid;
BEGIN
  actor:=app_private.seo_media_private_actor(p_workspace,p_session);
  IF actor IS NOT NULL THEN RETURN jsonb_build_object('requestedBy',actor,'origin','owner'); END IF;
  SELECT r.data INTO profile FROM app.seo_blog_records r WHERE r.workspace_id=p_workspace AND r.kind='profile' ORDER BY r.id DESC LIMIT 1;
  IF profile->>'confirmedAt' IS NULL OR coalesce(profile->>'confirmedBy','') !~ '^[0-9a-f-]{36}$' THEN
    RETURN jsonb_build_object('kind','held','reason','profile_unconfirmed');
  END IF;
  confirmer:=(profile->>'confirmedBy')::uuid;
  IF confirmer IS DISTINCT FROM p_sponsor OR NOT app_private.can_manage_workspace(confirmer,p_workspace) THEN
    RETURN jsonb_build_object('kind','held','reason','sponsor_ineligible');
  END IF;
  RETURN jsonb_build_object('requestedBy',confirmer,'origin','programme');
END $f$;

CREATE FUNCTION app_private.seo_image_read_policy()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
  SELECT config||jsonb_build_object('version',version,'sha256',encode(sha256,'hex'),'admissionEpoch',admission_epoch)
  FROM app_private.seo_image_operator_policy WHERE singleton
$f$;

CREATE FUNCTION app_private.seo_image_reserve(p_workspace uuid,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE job app.seo_blog_jobs%ROWTYPE; image jsonb; source jsonb; existing app.seo_blog_image_attempts%ROWTYPE;
  policy app_private.seo_image_operator_policy%ROWTYPE; reason text; sponsor uuid; attempt_id uuid:=gen_random_uuid();
  nonce uuid:=(p_input->>'nonce')::uuid; this_period date:=(date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC'))::date;
  active_count bigint; reserved numeric; brand_volume bigint; image_limit bigint; policy_result jsonb;
BEGIN
  IF app_private.seo_media_private_actor(p_workspace,NULL) IS NOT NULL OR app_private.current_actor_kind()<>'worker'
    OR nonce IS NULL THEN RAISE EXCEPTION 'Actual content worker required for image start' USING ERRCODE='42501'; END IF;
  PERFORM app_private.seo_media_lock_brand(p_workspace);
  SELECT * INTO job FROM app.seo_blog_jobs WHERE workspace_id=p_workspace AND id=(p_input->>'jobId')::uuid;
  SELECT * INTO existing FROM app.seo_blog_image_attempts WHERE workspace_id=p_workspace AND job_id=job.id;
  IF existing.id IS NOT NULL THEN
    IF existing.intent_id IS DISTINCT FROM (p_input->>'intentId')::uuid
      OR encode(existing.request_sha256,'hex') IS DISTINCT FROM p_input->>'requestSha256'
      OR encode(existing.intent_sha256,'hex') IS DISTINCT FROM p_input->>'intentSha256' THEN
      RAISE EXCEPTION 'Image start identity conflicts with durable attempt' USING ERRCODE='23505';
    END IF;
    IF existing.outcome='operator_resolved' THEN RETURN jsonb_build_object('kind','held','reason','attempt_resolved'); END IF;
    IF jsonb_array_length(existing.receipts)>0 THEN
      reason:=app_private.seo_image_apply_hold(p_workspace,existing.id,existing.start_nonce,p_input->>'leaseOwner',(p_input->>'leaseAttempt')::integer);
      RETURN jsonb_build_object('kind','existing_receipt','attemptId',existing.id,'nonce',existing.start_nonce,
        'receipt',existing.receipts->-1->'receipt','candidate',app_private.seo_media_asset_json(p_workspace,existing.candidate_asset_id),
        'applyEligible',reason IS NULL,'hold',reason);
    END IF;
    RETURN jsonb_build_object('kind','existing_started','attemptId',existing.id,'nonce',existing.start_nonce,'reason','outcome_unknown');
  END IF;
  IF EXISTS(SELECT 1 FROM app.seo_blog_image_attempts a WHERE a.start_nonce=nonce) THEN
    RAISE EXCEPTION 'Image start nonce already used' USING ERRCODE='23505';
  END IF;
  image:=job.data#>'{payload,image}';
  IF job.id IS NULL OR job.kind<>'write' OR job.data#>>'{payload,stage}' IS DISTINCT FROM 'image'
    OR image->>'schema' IS DISTINCT FROM 'relaunch72.seo-image-intent/v1'
    OR image->>'sourceSnapshotVersion' IS DISTINCT FROM 'seo-image-source-v1'
    OR job.state<>'running' OR job.lease_expires_at<=clock_timestamp() OR job.lease_expires_at IS NULL
    OR job.data->>'leaseOwner' IS DISTINCT FROM p_input->>'leaseOwner'
    OR job.data->>'attempts' IS DISTINCT FROM p_input->>'leaseAttempt'
    OR image->>'intentId' IS DISTINCT FROM p_input->>'intentId'
    OR image->>'intentSha256' IS DISTINCT FROM p_input->>'intentSha256'
    OR image->>'requestSha256' IS DISTINCT FROM p_input->>'requestSha256'
    OR image->>'sourceSha256' IS DISTINCT FROM p_input->>'sourceSha256' OR image->>'profileSha256' IS DISTINCT FROM p_input->>'profileSha256'
    OR image->>'visualSha256' IS DISTINCT FROM p_input->>'visualSha256' OR image->>'articleId' IS DISTINCT FROM p_input->>'articleId'
    OR image->>'articleVersionId' IS DISTINCT FROM p_input->>'articleVersionId'
    OR image->>'articleContentSha256' IS DISTINCT FROM p_input->>'articleContentSha256'
    OR image->>'sponsorUserId' IS DISTINCT FROM p_input->>'sponsorUserId'
    OR image->>'sourceSnapshotVersion' IS DISTINCT FROM p_input->>'sourceSnapshotVersion' THEN
    RETURN jsonb_build_object('kind','held','reason','claim_or_intent_changed');
  END IF;
  -- Some existing article updates lock only their article row. Pin this own source before the global gate wait.
  PERFORM 1 FROM app.seo_blog_articles WHERE workspace_id=p_workspace AND id=(image->>'articleId')::uuid FOR SHARE;
  source:=app_private.seo_image_source(p_workspace,(image#>>'{source,articleId}')::uuid);
  IF source IS DISTINCT FROM image->'source' OR source->'snapshot' IS DISTINCT FROM image->'sourceSnapshot'
    OR source->>'sourceSha256' IS DISTINCT FROM image->>'sourceSha256' OR source->>'profileSha256' IS DISTINCT FROM image->>'profileSha256'
    OR source->>'visualSha256' IS DISTINCT FROM image->>'visualSha256' OR source->>'articleId' IS DISTINCT FROM image->>'articleId'
    OR source->>'articleVersionId' IS DISTINCT FROM image->>'articleVersionId'
    OR source->>'articleContentSha256' IS DISTINCT FROM image->>'articleContentSha256' THEN
    RETURN jsonb_build_object('kind','held','reason','source_changed');
  END IF;
  sponsor:=(image->>'sponsorUserId')::uuid;
  reason:=app_private.seo_image_source_hold(p_workspace,source,sponsor,coalesce((image->>'automatic')::boolean,true));
  IF reason IS NOT NULL THEN RETURN jsonb_build_object('kind','held','reason',reason); END IF;
  IF NOT coalesce((p_input->>'providerConfigured')::boolean,false) THEN RETURN jsonb_build_object('kind','held','reason','provider_unconfigured'); END IF;
  -- The caller already owns its job row; aggregate other brands without row-locking them.
  -- A real row UPDATE gives SERIALIZABLE snapshots a conflict even if the visible aggregate is stale.
  UPDATE app_private.seo_image_operator_policy SET admission_epoch=admission_epoch+1 WHERE singleton RETURNING * INTO policy;
  reason:=app_private.seo_image_source_hold(p_workspace,source,sponsor,coalesce((image->>'automatic')::boolean,true));
  IF reason IS NOT NULL THEN RETURN jsonb_build_object('kind','held','reason',reason); END IF;
  this_period:=date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC')::date;
  IF policy.version IS DISTINCT FROM (p_input->>'expectedPolicyVersion')::bigint
    OR encode(policy.sha256,'hex') IS DISTINCT FROM p_input->>'expectedPolicySha256'
    OR image->>'expectedPolicyVersion' IS DISTINCT FROM p_input->>'expectedPolicyVersion'
    OR image->>'expectedPolicySha256' IS DISTINCT FROM p_input->>'expectedPolicySha256' THEN
    RETURN jsonb_build_object('kind','held','reason','operator_policy_changed');
  END IF;
  IF NOT coalesce((policy.config->>'enabled')::boolean,false)
    OR coalesce((policy.config->>'maxConcurrency')::bigint,0)<=0
    OR coalesce((policy.config->>'perAttemptMicrousd')::bigint,0)<=0
    OR coalesce((policy.config->>'monthlyMicrousd')::bigint,0)<=0 THEN
    RETURN jsonb_build_object('kind','held','reason','operator_policy_disabled');
  END IF;
  IF image->>'model' IS DISTINCT FROM policy.config->>'model' OR image->>'quality' IS DISTINCT FROM policy.config->>'quality' THEN
    RETURN jsonb_build_object('kind','held','reason','operator_model_mismatch');
  END IF;
  SELECT count(*) FILTER(WHERE a.outcome IN ('started','outcome_unknown')),
    coalesce(sum(a.reserved_microusd) FILTER(WHERE a.allowance_period=this_period OR a.outcome IN ('started','outcome_unknown')),0)
    INTO active_count,reserved FROM app.seo_blog_image_attempts a;
  IF active_count>=(policy.config->>'maxConcurrency')::bigint THEN RETURN jsonb_build_object('kind','held','reason','global_concurrency'); END IF;
  IF reserved+(policy.config->>'perAttemptMicrousd')::numeric>(policy.config->>'monthlyMicrousd')::numeric THEN
    RETURN jsonb_build_object('kind','held','reason','global_cost_reservation');
  END IF;
  SELECT coalesce((settings#>>'{budgets,imagesPerMonth}')::bigint,0) INTO image_limit FROM app.seo_blog_brands WHERE workspace_id=p_workspace;
  SELECT coalesce(sum(u.amount),0)+(SELECT count(*) FROM app.seo_blog_image_attempts a WHERE a.workspace_id=p_workspace
    AND a.allowance_period<this_period AND a.outcome IN ('started','outcome_unknown')) INTO brand_volume
    FROM app.seo_blog_usage u WHERE u.workspace_id=p_workspace AND u.kind='images'
      AND date_trunc('month',u.at AT TIME ZONE 'UTC')::date=this_period;
  IF image_limit<=0 OR brand_volume>=image_limit THEN RETURN jsonb_build_object('kind','held','reason','brand_image_allowance'); END IF;
  INSERT INTO app.seo_blog_image_attempts(id,workspace_id,job_id,intent_id,start_nonce,lease_owner,lease_attempt,intent_sha256,request_sha256,
    source_sha256,visual_sha256,profile_sha256,source_snapshot,sponsor_user_id,model,quality,allowance_period,reserved_microusd,
    policy_version,policy_sha256,policy_snapshot) VALUES(attempt_id,p_workspace,job.id,(image->>'intentId')::uuid,nonce,p_input->>'leaseOwner',
      (p_input->>'leaseAttempt')::integer,decode(image->>'intentSha256','hex'),decode(image->>'requestSha256','hex'),
      decode(source->>'sourceSha256','hex'),decode(source->>'visualSha256','hex'),decode(source->>'profileSha256','hex'),source,sponsor,
      image->>'model',image->>'quality',this_period,(policy.config->>'perAttemptMicrousd')::bigint,policy.version,policy.sha256,policy.config);
  policy_result:=policy.config||jsonb_build_object('version',policy.version,'sha256',encode(policy.sha256,'hex'),'admissionEpoch',policy.admission_epoch);
  RETURN jsonb_build_object('kind','admitted','attemptId',attempt_id,'nonce',nonce,'policy',policy_result);
END $f$;

CREATE FUNCTION app_private.seo_image_check_apply(p_workspace uuid,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE reason text;
BEGIN
  IF app_private.seo_media_private_actor(p_workspace,NULL) IS NOT NULL OR app_private.current_actor_kind()<>'worker' THEN
    RAISE EXCEPTION 'Actual content worker required' USING ERRCODE='42501';
  END IF;
  PERFORM app_private.seo_media_lock_brand(p_workspace);
  reason:=app_private.seo_image_apply_hold(p_workspace,(p_input->>'attemptId')::uuid,(p_input->>'nonce')::uuid,
    p_input->>'leaseOwner',(p_input->>'leaseAttempt')::integer);
  RETURN jsonb_build_object('eligible',reason IS NULL,'hold',reason);
END $f$;

CREATE FUNCTION app_private.seo_image_attempt_job(p_workspace uuid,p_attempt uuid)
RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE job_id uuid;
BEGIN
  IF app_private.seo_media_private_actor(p_workspace,NULL) IS NOT NULL OR app_private.current_actor_kind()<>'worker' THEN
    RAISE EXCEPTION 'Actual content worker required' USING ERRCODE='42501';
  END IF;
  SELECT a.job_id INTO job_id FROM app.seo_blog_image_attempts a WHERE a.workspace_id=p_workspace AND a.id=p_attempt;
  RETURN job_id;
END $f$;

-- Deferred INSERT-only proof: the existing command client must commit the exact job projection/debit with its new reservation.
-- No later cancellation or job edit revalidates this historical proof or erases a reservation.
CREATE FUNCTION app_private.seo_image_admission_commit_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE job app.seo_blog_jobs%ROWTYPE; debit_count bigint;
BEGIN
  SELECT * INTO job FROM app.seo_blog_jobs WHERE workspace_id=NEW.workspace_id AND id=NEW.job_id;
  IF job.state IS DISTINCT FROM 'running' OR job.data#>>'{payload,stage}' IS DISTINCT FROM 'image'
    OR job.data#>>'{payload,image,start,nonce}' IS DISTINCT FROM NEW.start_nonce::text
    OR job.data#>>'{payload,image,start,attemptId}' IS DISTINCT FROM NEW.id::text
    OR job.data#>>'{payload,image,intentId}' IS DISTINCT FROM NEW.intent_id::text
    OR job.data->>'leaseOwner' IS DISTINCT FROM NEW.lease_owner OR job.data->>'attempts' IS DISTINCT FROM NEW.lease_attempt::text
    OR job.lease_expires_at IS NULL OR job.lease_expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'Image admission missing atomic current-claim start projection' USING ERRCODE='23514';
  END IF;
  SELECT count(*) INTO debit_count FROM app.seo_blog_usage u WHERE u.workspace_id=NEW.workspace_id AND u.kind='images'
    AND u.reference='seo-image-start:'||NEW.id::text AND u.amount=1
    AND date_trunc('month',u.at AT TIME ZONE 'UTC')::date=NEW.allowance_period;
  IF debit_count<>1 OR EXISTS(SELECT 1 FROM app.seo_blog_usage u WHERE u.workspace_id=NEW.workspace_id AND u.kind='images'
    AND u.reference='seo-image-start:'||NEW.id::text AND (u.amount<>1 OR date_trunc('month',u.at AT TIME ZONE 'UTC')::date<>NEW.allowance_period)) THEN
    RAISE EXCEPTION 'Image admission requires exactly one matching UTC allowance debit' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $f$;

CREATE FUNCTION app_private.seo_media_validate_receipt(p_receipt jsonb)
RETURNS void LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE value jsonb;
BEGIN
  IF jsonb_typeof(p_receipt) IS DISTINCT FROM 'object' OR octet_length(p_receipt::text)>4096
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_receipt) k WHERE k<>ALL(ARRAY['outcome','code','requestSha256','providerRequestIdSha256','httpStatus','usage']))
    OR coalesce(p_receipt->>'outcome','')<>ALL(ARRAY['not_started','candidate_received','rejected','outcome_unknown','uploaded'])
    OR coalesce(p_receipt->>'code','')<>ALL(ARRAY['aborted','candidate_received','provider_rejected','transport_interrupted','invalid_response','response_limit','uploaded'])
    OR (p_receipt->>'requestSha256' IS NOT NULL AND p_receipt->>'requestSha256' !~ '^[0-9a-f]{64}$')
    OR (p_receipt->>'providerRequestIdSha256' IS NOT NULL AND p_receipt->>'providerRequestIdSha256' !~ '^[0-9a-f]{64}$') THEN
    RAISE EXCEPTION 'Invalid safe media receipt' USING ERRCODE='22023';
  END IF;
  IF (p_receipt->>'outcome'='uploaded' AND p_receipt->>'code'<>'uploaded')
    OR (p_receipt->>'outcome'='not_started' AND p_receipt->>'code'<>'aborted')
    OR (p_receipt->>'outcome'='candidate_received' AND p_receipt->>'code'<>'candidate_received')
    OR (p_receipt->>'outcome'='rejected' AND p_receipt->>'code'<>'provider_rejected')
    OR (p_receipt->>'outcome'='outcome_unknown' AND p_receipt->>'code'<>ALL(ARRAY['transport_interrupted','invalid_response','response_limit'])) THEN
    RAISE EXCEPTION 'Receipt outcome/code must describe the same observed boundary' USING ERRCODE='22023';
  END IF;
  IF p_receipt->>'httpStatus' IS NOT NULL AND (jsonb_typeof(p_receipt->'httpStatus')<>'number'
    OR p_receipt->>'httpStatus' !~ '^[1-5][0-9]{2}$') THEN RAISE EXCEPTION 'Invalid HTTP evidence' USING ERRCODE='22023'; END IF;
  IF p_receipt->'usage' IS NOT NULL AND p_receipt->'usage'<>'null'::jsonb THEN
    IF jsonb_typeof(p_receipt->'usage')<>'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_receipt->'usage') k
      WHERE k<>ALL(ARRAY['inputTokens','outputTokens','totalTokens','inputTextTokens','inputImageTokens','outputImageTokens'])) THEN
      RAISE EXCEPTION 'Invalid usage evidence' USING ERRCODE='22023';
    END IF;
    FOR value IN SELECT v FROM jsonb_each(p_receipt->'usage') e(k,v) LOOP
      IF value<>'null'::jsonb AND (jsonb_typeof(value)<>'number' OR value::text !~ '^[0-9]+$' OR value::numeric>9007199254740991) THEN
        RAISE EXCEPTION 'Unknown usage must remain null; known usage must be a nonnegative safe integer' USING ERRCODE='22023';
      END IF;
    END LOOP;
  END IF;
END $f$;

CREATE FUNCTION app_private.seo_media_store_candidate(p_workspace uuid,p_session bytea,p_command uuid,p_bytes bytea,p_provenance jsonb,p_receipt jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
  PERFORM app_private.seo_media_owner(p_workspace,p_session);
  IF p_provenance->>'kind' IS DISTINCT FROM 'uploaded' OR p_receipt->>'outcome' IS DISTINCT FROM 'uploaded' THEN
    RAISE EXCEPTION 'Generated bytes must use atomic attempt receipt persistence' USING ERRCODE='42501';
  END IF;
  PERFORM app_private.seo_media_validate_receipt(p_receipt);
  RETURN app_private.seo_media_store_candidate_internal(p_workspace,p_session,p_command,p_bytes,p_provenance,p_receipt);
END $f$;

CREATE FUNCTION app_private.seo_image_apply_hold(p_workspace uuid,p_attempt uuid,p_nonce uuid,p_lease_owner text,p_lease_attempt integer)
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE attempt app.seo_blog_image_attempts%ROWTYPE; job app.seo_blog_jobs%ROWTYPE; source jsonb; reason text;
  policy app_private.seo_image_operator_policy%ROWTYPE;
BEGIN
  SELECT * INTO attempt FROM app.seo_blog_image_attempts WHERE workspace_id=p_workspace AND id=p_attempt AND start_nonce=p_nonce;
  IF attempt.id IS NULL THEN RETURN 'attempt_missing'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(attempt.receipts) r
    WHERE r#>>'{receipt,requestSha256}' IS DISTINCT FROM encode(attempt.request_sha256,'hex')) THEN RETURN 'request_identity_mismatch'; END IF;
  SELECT * INTO job FROM app.seo_blog_jobs WHERE workspace_id=p_workspace AND id=attempt.job_id;
  IF job.state IS DISTINCT FROM 'running' OR job.lease_expires_at IS NULL OR job.lease_expires_at<=clock_timestamp()
    OR job.data->>'leaseOwner' IS DISTINCT FROM p_lease_owner OR job.data->>'attempts' IS DISTINCT FROM p_lease_attempt::text
    OR job.data#>>'{payload,image,intentId}' IS DISTINCT FROM attempt.intent_id::text
    OR job.data#>>'{payload,image,requestSha256}' IS DISTINCT FROM encode(attempt.request_sha256,'hex') THEN RETURN 'claim_changed'; END IF;
  IF attempt.outcome IS DISTINCT FROM 'candidate_received' THEN RETURN 'candidate_unavailable'; END IF;
  source:=app_private.seo_image_source(p_workspace,(attempt.source_snapshot->>'articleId')::uuid);
  IF source IS DISTINCT FROM attempt.source_snapshot THEN RETURN 'source_changed'; END IF;
  reason:=app_private.seo_image_source_hold(p_workspace,source,attempt.sponsor_user_id,coalesce((job.data#>>'{payload,image,automatic}')::boolean,true));
  IF reason IS NOT NULL THEN RETURN reason; END IF;
  SELECT * INTO policy FROM app_private.seo_image_operator_policy WHERE singleton FOR SHARE;
  IF NOT coalesce((policy.config->>'enabled')::boolean,false) THEN RETURN 'operator_policy_disabled'; END IF;
  IF policy.version IS DISTINCT FROM attempt.policy_version OR policy.sha256 IS DISTINCT FROM attempt.policy_sha256 THEN RETURN 'operator_policy_changed'; END IF;
  RETURN NULL;
END $f$;

CREATE FUNCTION app_private.seo_image_record_receipt(p_workspace uuid,p_input jsonb,p_bytes bytea,p_provenance jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE attempt app.seo_blog_image_attempts%ROWTYPE; receipt jsonb:=p_input->'receipt'; receipt_hash text; candidate jsonb;
  receipt_entry jsonb; previous jsonb; reason text; request_hash text; outcome text; identity_mismatch boolean;
BEGIN
  IF app_private.seo_media_private_actor(p_workspace,NULL) IS NOT NULL OR app_private.current_actor_kind()<>'worker' THEN
    RAISE EXCEPTION 'Actual content worker required for paid receipt' USING ERRCODE='42501';
  END IF;
  PERFORM app_private.seo_media_validate_receipt(receipt);
  IF coalesce(receipt->>'requestSha256','') !~ '^[0-9a-f]{64}$'
    OR (p_bytes IS NOT NULL AND octet_length(p_bytes) NOT BETWEEN 1 AND 8388608) THEN
    RAISE EXCEPTION 'Exact safe actual request identity and bounded bytes required' USING ERRCODE='22023';
  END IF;
  PERFORM app_private.seo_media_lock_brand(p_workspace);
  SELECT * INTO attempt FROM app.seo_blog_image_attempts WHERE workspace_id=p_workspace AND id=(p_input->>'attemptId')::uuid FOR UPDATE;
  IF attempt.id IS NULL OR attempt.start_nonce IS DISTINCT FROM (p_input->>'nonce')::uuid
    OR encode(attempt.request_sha256,'hex') IS DISTINCT FROM p_input->>'requestSha256'
    OR attempt.lease_owner IS DISTINCT FROM p_input->>'leaseOwner' OR attempt.lease_attempt::text IS DISTINCT FROM p_input->>'leaseAttempt'
    OR receipt->>'outcome'='uploaded' THEN
    RAISE EXCEPTION 'Receipt does not bind original admitted worker operation' USING ERRCODE='42501';
  END IF;
  identity_mismatch:=receipt->>'requestSha256' IS DISTINCT FROM encode(attempt.request_sha256,'hex')
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(attempt.receipts) r
      WHERE r#>>'{receipt,requestSha256}' IS DISTINCT FROM encode(attempt.request_sha256,'hex'));
  -- All bytes and safe evidence participate in immutable receipt identity, including malformed-but-received candidates.
  IF p_input->>'observedCandidateSha256' IS NOT NULL AND p_input->>'observedCandidateSha256' !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Invalid observed candidate digest' USING ERRCODE='22023';
  END IF;
  receipt_hash:=encode(public.digest(jsonb_build_object('receipt',receipt,'candidateSha',CASE WHEN p_bytes IS NULL THEN p_input->>'observedCandidateSha256'
    ELSE encode(public.digest(p_bytes,'sha256'),'hex') END,'provenance',p_provenance)::text,'sha256'),'hex');
  SELECT r INTO previous FROM jsonb_array_elements(attempt.receipts) r WHERE r->>'sha256'=receipt_hash;
  IF previous IS NULL THEN
    IF jsonb_array_length(attempt.receipts)>0 AND attempt.outcome NOT IN ('started','outcome_unknown') THEN
      RAISE EXCEPTION 'Conflicting final receipt for immutable image attempt' USING ERRCODE='23505';
    END IF;
    IF jsonb_array_length(attempt.receipts)>0 AND receipt->>'outcome'='outcome_unknown' THEN
      RAISE EXCEPTION 'Conflicting uncertain receipt for immutable image attempt' USING ERRCODE='23505';
    END IF;
    outcome:=receipt->>'outcome';
    IF outcome='candidate_received' AND p_bytes IS NULL THEN RAISE EXCEPTION 'Candidate receipt missing bytes' USING ERRCODE='22023'; END IF;
    IF p_bytes IS NOT NULL AND NOT identity_mismatch THEN
      IF p_provenance->>'kind' IS DISTINCT FROM 'generated'
        OR p_provenance#>>'{generation,intentId}' IS DISTINCT FROM attempt.intent_id::text
        OR p_provenance#>>'{generation,nonce}' IS DISTINCT FROM attempt.start_nonce::text
        OR p_provenance#>>'{generation,requestSha256}' IS DISTINCT FROM encode(attempt.request_sha256,'hex')
        OR p_provenance->>'brandSha256' IS DISTINCT FROM encode(attempt.profile_sha256,'hex') THEN
        RAISE EXCEPTION 'Candidate does not bind same-workspace original admitted attempt' USING ERRCODE='42501';
      END IF;
      -- Deterministic command ID is the attempt ID; it cannot become a second model call or candidate after a lost ACK.
      IF attempt.candidate_asset_id IS NOT NULL THEN
        SELECT app_private.seo_media_asset_json(p_workspace,a.id) INTO candidate FROM app.seo_blog_media_assets a
          WHERE a.workspace_id=p_workspace AND a.id=attempt.candidate_asset_id AND a.byte_sha256=public.digest(p_bytes,'sha256')
            AND a.provenance=p_provenance;
        IF candidate IS NULL THEN RAISE EXCEPTION 'Late candidate conflicts with stored immutable pixels' USING ERRCODE='23505'; END IF;
      ELSE candidate:=app_private.seo_media_store_candidate_internal(p_workspace,NULL,attempt.id,p_bytes,p_provenance,receipt); END IF;
    ELSE candidate:=app_private.seo_media_asset_json(p_workspace,attempt.candidate_asset_id); END IF;
    receipt_entry:=jsonb_build_object('sha256',receipt_hash,'receipt',receipt,'candidateId',candidate->>'id',
      'candidateSha256',CASE WHEN p_bytes IS NULL THEN p_input->>'observedCandidateSha256' ELSE encode(public.digest(p_bytes,'sha256'),'hex') END,'at',clock_timestamp());
    UPDATE app.seo_blog_image_attempts SET receipts=receipts||jsonb_build_array(receipt_entry),
      outcome=CASE WHEN identity_mismatch THEN 'outcome_unknown' ELSE receipt->>'outcome' END,
      candidate_asset_id=coalesce((candidate->>'id')::uuid,candidate_asset_id) WHERE workspace_id=p_workspace AND id=attempt.id;
  ELSE candidate:=app_private.seo_media_asset_json(p_workspace,attempt.candidate_asset_id); END IF;
  reason:=app_private.seo_image_apply_hold(p_workspace,attempt.id,attempt.start_nonce,p_input->>'leaseOwner',(p_input->>'leaseAttempt')::integer);
  RETURN jsonb_build_object('attemptId',attempt.id,'nonce',attempt.start_nonce,'candidate',candidate,'receipt',receipt,
    'applyEligible',reason IS NULL,'hold',reason);
END $f$;

CREATE FUNCTION app_private.seo_image_policy_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE k text;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Stable operator admission row cannot be deleted' USING ERRCODE='55000'; END IF;
  IF NEW.singleton IS DISTINCT FROM true OR NEW.config->>'model' IS DISTINCT FROM 'gpt-image-2'
    OR NEW.config->>'quality' IS DISTINCT FROM 'medium' OR jsonb_typeof(NEW.config->'enabled') IS DISTINCT FROM 'boolean'
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(NEW.config) key WHERE key<>ALL(ARRAY['enabled','model','quality','maxConcurrency','monthlyMicrousd','perAttemptMicrousd'])) THEN
    RAISE EXCEPTION 'Invalid trusted operator image policy' USING ERRCODE='22023';
  END IF;
  FOREACH k IN ARRAY ARRAY['maxConcurrency','monthlyMicrousd','perAttemptMicrousd'] LOOP
    IF jsonb_typeof(NEW.config->k) IS DISTINCT FROM 'number' OR NEW.config->>k !~ '^[0-9]+$'
      OR (NEW.config->>k)::numeric>9007199254740991 THEN RAISE EXCEPTION 'Policy limits must be safe nonnegative integers' USING ERRCODE='22023'; END IF;
  END LOOP;
  IF NEW.config IS DISTINCT FROM OLD.config THEN
    IF NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'Changed operator policy requires next version' USING ERRCODE='55000'; END IF;
  ELSIF NEW.version<>OLD.version THEN RAISE EXCEPTION 'Policy version change requires changed configuration' USING ERRCODE='55000'; END IF;
  IF NEW.admission_epoch<OLD.admission_epoch THEN RAISE EXCEPTION 'Admission epoch is monotonic' USING ERRCODE='55000'; END IF;
  NEW.sha256:=public.digest(NEW.version::text||':'||NEW.config::text,'sha256');
  RETURN NEW;
END $f$;

CREATE FUNCTION app_private.seo_image_attempt_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $f$
BEGIN
  IF TG_OP='DELETE' OR (to_jsonb(NEW)-ARRAY['outcome','receipts','candidate_asset_id','operator_resolution'])
    IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['outcome','receipts','candidate_asset_id','operator_resolution']) THEN
    RAISE EXCEPTION 'Admitted image attempt identity/reservation is immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.operator_resolution IS DISTINCT FROM OLD.operator_resolution THEN
    IF current_user<>'r72_owner' OR NEW.outcome<>'operator_resolved' OR OLD.operator_resolution IS NOT NULL
      OR length(btrim(coalesce(NEW.operator_resolution->>'reason',''))) NOT BETWEEN 1 AND 1000 THEN
      RAISE EXCEPTION 'Explicit trusted operator resolution required' USING ERRCODE='42501';
    END IF;
    IF NEW.receipts IS DISTINCT FROM OLD.receipts OR NEW.candidate_asset_id IS DISTINCT FROM OLD.candidate_asset_id THEN
      RAISE EXCEPTION 'Operator resolution retains original receipt and candidate history' USING ERRCODE='55000';
    END IF;
    NEW.operator_resolution:=NEW.operator_resolution||jsonb_build_object('by',session_user,'at',clock_timestamp());
  ELSIF NEW.receipts IS DISTINCT FROM OLD.receipts THEN
    IF OLD.outcome NOT IN ('started','outcome_unknown') OR jsonb_array_length(NEW.receipts)<>jsonb_array_length(OLD.receipts)+1
      OR (NEW.receipts- (jsonb_array_length(NEW.receipts)-1)) IS DISTINCT FROM OLD.receipts THEN
      RAISE EXCEPTION 'Image receipts are append-only and final outcomes immutable' USING ERRCODE='55000';
    END IF;
  ELSIF NEW.outcome IS DISTINCT FROM OLD.outcome OR NEW.candidate_asset_id IS DISTINCT FROM OLD.candidate_asset_id THEN
    RAISE EXCEPTION 'Image outcome requires a durable receipt or operator resolution' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $f$;

-- Bounded canonical serializer for the NEW SEO campaign recipe; no MHP capability is invoked or changed.
CREATE FUNCTION app_private.seo_media_campaign_canonical(p_value jsonb,p_depth integer DEFAULT 0)
RETURNS text LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE kind text:=jsonb_typeof(p_value); result text;
BEGIN
  IF p_depth>20 OR p_value IS NULL OR octet_length(p_value::text)>1000000 THEN RAISE EXCEPTION 'Campaign canonical bound exceeded' USING ERRCODE='22023'; END IF;
  IF kind='object' THEN
    IF EXISTS(SELECT 1 FROM jsonb_object_keys(p_value) k WHERE k !~ '^[A-Za-z][A-Za-z0-9_]*$') THEN
      RAISE EXCEPTION 'Campaign keys must use the versioned ASCII schema' USING ERRCODE='22023';
    END IF;
    SELECT '{'||coalesce(string_agg(to_json(k)::text||':'||app_private.seo_media_campaign_canonical(v,p_depth+1),',' ORDER BY k COLLATE "C"),'')||'}'
      INTO result FROM jsonb_each(p_value) e(k,v);
  ELSIF kind='array' THEN
    SELECT '['||coalesce(string_agg(app_private.seo_media_campaign_canonical(v,p_depth+1),',' ORDER BY n),'')||']'
      INTO result FROM jsonb_array_elements(p_value) WITH ORDINALITY e(v,n);
  ELSIF kind='string' THEN result:=to_json(p_value#>>'{}')::text;
  ELSIF kind='number' THEN
    IF (p_value::text)::numeric<>trunc((p_value::text)::numeric) OR abs((p_value::text)::numeric)>9007199254740991 THEN
      RAISE EXCEPTION 'Campaign numbers must be safe integers' USING ERRCODE='22023';
    END IF;
    result:=trunc((p_value::text)::numeric)::text;
  ELSE result:=p_value::text; END IF;
  RETURN result;
END $f$;

CREATE FUNCTION app_private.seo_media_campaign_revision(p_workspace uuid,p_article uuid,p_variant uuid,p_revision uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE matches jsonb; result jsonb; revision jsonb;
BEGIN
  SELECT coalesce(jsonb_agg(jsonb_build_object('campaign',a.data->'campaign','variant',v,'revision',r)),'[]') INTO matches
    FROM app.seo_blog_articles a JOIN app.seo_blog_article_versions parent ON parent.workspace_id=a.workspace_id AND parent.article_id=a.id
      AND parent.id::text=a.data->>'currentVersionId'
    CROSS JOIN LATERAL jsonb_array_elements(a.data#>'{campaign,variants}') v
    CROSS JOIN LATERAL jsonb_array_elements(v->'revisions') r
    WHERE a.workspace_id=p_workspace AND a.id=p_article AND a.data#>>'{campaign,schema}'='relaunch72.seo-campaign/v1'
      AND a.data#>>'{campaign,articleVersionId}'=parent.id::text AND a.data#>>'{campaign,articleContentSha}'=parent.content_sha256
      AND parent.data->>'contentSha'=parent.content_sha256 AND v->>'id'=p_variant::text AND v->'omitted'='false'::jsonb
      AND v->>'currentRevisionId'=p_revision::text AND r->>'id'=p_revision::text AND r->>'variantId'=p_variant::text
      AND r->>'articleVersionId'=parent.id::text AND r->>'articleContentSha'=parent.content_sha256
      AND r->>'canonicalUrl'=parent.data#>>'{promotionPack,canonicalUrl}';
  IF jsonb_array_length(matches)<>1 THEN RETURN NULL; END IF;
  result:=matches->0;revision:=result->'revision';
  IF revision->>'recipe' IS DISTINCT FROM 'r72-social-three-angle-v1' OR coalesce(revision->>'network','')<>ALL(ARRAY['instagram','linkedin'])
    OR revision->>'network' IS DISTINCT FROM result#>>'{variant,network}'
    OR revision->>'angle' IS DISTINCT FROM result#>>'{variant,angle}' OR coalesce(revision->>'angle','')<>ALL(ARRAY['launch','takeaway','follow_up'])
    OR NOT (revision ?& ARRAY['id','variantId','articleVersionId','articleContentSha','canonicalUrl','network','angle','recipe','title','copy','artworkInstructions','relativeDays','media','createdAt','createdBy','sha256'])
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(revision) k WHERE k<>ALL(ARRAY['id','variantId','articleVersionId','articleContentSha','canonicalUrl','network','angle','recipe','title','copy','artworkInstructions','relativeDays','media','createdAt','createdBy','sha256']))
    OR jsonb_typeof(revision->'title') IS DISTINCT FROM 'string' OR length(coalesce(revision->>'title','')) NOT BETWEEN 1 AND 300
    OR jsonb_typeof(revision->'copy') IS DISTINCT FROM 'string' OR length(coalesce(revision->>'copy','')) NOT BETWEEN 1 AND 3000
    OR (jsonb_typeof(revision->'artworkInstructions') NOT IN ('string','null'))
    OR jsonb_typeof(revision->'createdAt') IS DISTINCT FROM 'string' OR jsonb_typeof(revision->'createdBy') IS DISTINCT FROM 'string'
    OR coalesce(revision->>'canonicalUrl','') !~ '^https://[^[:space:]]+$' OR length(revision->>'canonicalUrl')>500
    OR jsonb_typeof(revision->'relativeDays') IS DISTINCT FROM 'number'
    OR (revision->>'relativeDays')::integer IS DISTINCT FROM (CASE revision->>'angle' WHEN 'launch' THEN 0 WHEN 'takeaway' THEN 3 WHEN 'follow_up' THEN 7 END)
    OR coalesce(revision->>'sha256','') !~ '^[0-9a-f]{64}$'
    OR encode(public.digest(app_private.seo_media_campaign_canonical(revision-'sha256'),'sha256'),'hex') IS DISTINCT FROM revision->>'sha256' THEN RETURN NULL; END IF;
  RETURN result;
EXCEPTION WHEN data_exception THEN RETURN NULL;
END $f$;

CREATE FUNCTION app_private.seo_media_social_authorization_json(p_workspace uuid,p_use uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
  SELECT a.social_use-'revision'||jsonb_build_object('id',a.id,'useId',a.id,'useKind',a.use_kind,'workspaceId',a.workspace_id,
    'articleVersionId',a.article_version_id,'articleContentSha',a.article_content_sha256,'assetId',a.asset_id,'assetSha256',encode(a.asset_sha256,'hex'),
    'authorizingUserId',a.authorizing_user_id,'canonical',jsonb_build_object('contentItemId',a.canonical_item_id,'contentVersionId',a.canonical_version_id,
    'contentSha256',encode(a.canonical_content_sha256,'hex'),'approvalRequestId',a.approval_request_id,'approvalDecisionId',a.approval_decision_id))
  FROM app.seo_blog_media_owner_authorizations a WHERE a.workspace_id=p_workspace AND a.id=p_use AND a.use_kind='social_variant'
$f$;

CREATE FUNCTION app_private.seo_media_social_use_eligible(p_workspace uuid,p_use uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE media_authorization app.seo_blog_media_owner_authorizations%ROWTYPE; current_source jsonb; manifest jsonb; canonical jsonb; revision jsonb;
BEGIN
  SELECT * INTO media_authorization FROM app.seo_blog_media_owner_authorizations WHERE workspace_id=p_workspace AND id=p_use AND use_kind='social_variant';
  IF media_authorization.id IS NULL OR NOT app_private.can_manage_workspace(media_authorization.authorizing_user_id,p_workspace)
    OR app_private.seo_media_withdrawn(p_workspace,media_authorization.asset_id,NULL) THEN RETURN false; END IF;
  current_source:=app_private.seo_media_campaign_revision(p_workspace,(media_authorization.social_use->>'articleId')::uuid,
    (media_authorization.social_use->>'variantId')::uuid,(media_authorization.social_use->>'variantRevisionId')::uuid);
  revision:=current_source->'revision';
  IF revision IS NULL OR revision IS DISTINCT FROM media_authorization.social_use->'revision'
    OR revision#>>'{media,useId}' IS DISTINCT FROM p_use::text OR revision->>'articleVersionId' IS DISTINCT FROM media_authorization.article_version_id::text
    OR revision->>'articleContentSha' IS DISTINCT FROM media_authorization.article_content_sha256 THEN RETURN false; END IF;
  manifest:=app_private.seo_media_asset_manifest(p_workspace,media_authorization.asset_id,encode(media_authorization.asset_sha256,'hex'),
    media_authorization.social_use->>'profile',media_authorization.social_use->>'alt');
  canonical:=jsonb_build_object('contentItemId',media_authorization.canonical_item_id,'contentVersionId',media_authorization.canonical_version_id,
    'contentSha256',encode(media_authorization.canonical_content_sha256,'hex'),'approvalRequestId',media_authorization.approval_request_id,
    'approvalDecisionId',media_authorization.approval_decision_id);
  RETURN app_private.seo_media_quality_eligible(p_workspace,manifest,canonical);
EXCEPTION WHEN data_exception THEN RETURN false;
END $f$;

CREATE FUNCTION app_private.seo_media_authorize_social_use(p_workspace uuid,p_session bytea,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; command_id uuid:=(p_input->>'commandId')::uuid; use_id uuid:=(p_input->>'useId')::uuid;
  source jsonb; revision jsonb; manifest jsonb; canonical jsonb:=p_input->'canonical'; request_hash bytea; replayed jsonb; result jsonb; social_use jsonb;
BEGIN
  actor:=app_private.seo_media_owner(p_workspace,p_session);
  IF command_id IS NULL OR use_id IS NULL THEN RAISE EXCEPTION 'Immutable use and command identities required' USING ERRCODE='22023'; END IF;
  PERFORM app_private.seo_media_lock_brand(p_workspace);
  request_hash:=public.digest(jsonb_build_object('action','authorize_social_use','actor',actor,'input',p_input)::text,'sha256');
  replayed:=app_private.seo_media_replay(p_workspace,command_id,'authorize_social_use',actor,request_hash);
  IF replayed IS NOT NULL THEN RETURN replayed; END IF;
  PERFORM 1 FROM app.seo_blog_articles WHERE workspace_id=p_workspace AND id=(p_input->>'articleId')::uuid FOR UPDATE;
  source:=app_private.seo_media_campaign_revision(p_workspace,(p_input->>'articleId')::uuid,(p_input->>'variantId')::uuid,(p_input->>'variantRevisionId')::uuid);
  revision:=source->'revision';
  IF revision IS NULL OR revision->>'sha256' IS DISTINCT FROM p_input->>'variantSha256'
    OR revision->>'articleVersionId' IS DISTINCT FROM p_input->>'articleVersionId' OR revision->>'articleContentSha' IS DISTINCT FROM p_input->>'articleContentSha'
    OR revision->>'network' IS DISTINCT FROM p_input->>'network' OR p_input->>'profile' IS DISTINCT FROM p_input->>'network'
    OR revision->'media' IS DISTINCT FROM jsonb_build_object('useId',use_id,'assetId',p_input->>'assetId','assetSha256',p_input->>'assetSha256',
      'profile',p_input->>'profile','alt',p_input->>'alt','canonical',canonical) THEN
    RAISE EXCEPTION 'Exact current native social revision/media use required' USING ERRCODE='55000';
  END IF;
  manifest:=app_private.seo_media_asset_manifest(p_workspace,(p_input->>'assetId')::uuid,p_input->>'assetSha256',p_input->>'profile',p_input->>'alt');
  PERFORM app_private.seo_media_assert_manifest(p_workspace,manifest,canonical);
  IF EXISTS(SELECT 1 FROM app.seo_blog_media_owner_authorizations WHERE id=use_id) THEN
    RAISE EXCEPTION 'Prospective social use identity already bound; exact command receipt required' USING ERRCODE='23505';
  END IF;
  social_use:=jsonb_build_object('articleId',p_input->>'articleId','variantId',p_input->>'variantId','variantRevisionId',p_input->>'variantRevisionId',
    'variantSha256',revision->>'sha256','network',revision->>'network','angle',revision->>'angle','profile',p_input->>'profile','alt',p_input->>'alt','revision',revision);
  result:=(p_input-'commandId')||jsonb_build_object('id',use_id,'useKind','social_variant','workspaceId',p_workspace,'authorizingUserId',actor);
  PERFORM app_private.seo_media_command(p_workspace,command_id,'authorize_social_use',actor,request_hash,result);
  INSERT INTO app.seo_blog_media_owner_authorizations(id,use_kind,social_use,workspace_id,reservation_command_id,asset_id,asset_sha256,article_version_id,
    article_content_sha256,reviewed_intent_sha256,canonical_item_id,canonical_version_id,canonical_content_sha256,approval_request_id,approval_decision_id,authorizing_user_id)
    VALUES(use_id,'social_variant',social_use,p_workspace,command_id,(p_input->>'assetId')::uuid,decode(p_input->>'assetSha256','hex'),(p_input->>'articleVersionId')::uuid,
      p_input->>'articleContentSha',decode(revision->>'sha256','hex'),(canonical->>'contentItemId')::uuid,(canonical->>'contentVersionId')::uuid,
      decode(canonical->>'contentSha256','hex'),(canonical->>'approvalRequestId')::uuid,(canonical->>'approvalDecisionId')::uuid,actor);
  RETURN result;
END $f$;

CREATE FUNCTION app_private.seo_media_refresh_social_image_attestation(p_workspace uuid,p_session bytea,p_use uuid,p_command uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; media_authorization app.seo_blog_media_owner_authorizations%ROWTYPE; selected app.company_content_versions%ROWTYPE;
  request_hash bytea; replayed jsonb; result jsonb; observed_at timestamptz; attestation_id uuid:=gen_random_uuid(); manifest jsonb; canonical jsonb;
BEGIN
  actor:=app_private.seo_media_owner(p_workspace,p_session);
  IF p_use IS NULL OR p_command IS NULL THEN RAISE EXCEPTION 'Exact use/observation command required' USING ERRCODE='22023'; END IF;
  PERFORM app_private.seo_media_lock_brand(p_workspace);
  request_hash:=public.digest(jsonb_build_object('action','refresh_social_image_attestation','workspace',p_workspace,'actor',actor,'useId',p_use)::text,'sha256');
  replayed:=app_private.seo_media_replay(p_workspace,p_command,'refresh_social_image_attestation',actor,request_hash);
  IF replayed IS NOT NULL THEN RETURN replayed; END IF;
  SELECT * INTO media_authorization FROM app.seo_blog_media_owner_authorizations WHERE workspace_id=p_workspace AND id=p_use AND use_kind='social_variant';
  IF media_authorization.id IS NULL THEN RAISE EXCEPTION 'Exact social image use missing' USING ERRCODE='55000'; END IF;
  PERFORM 1 FROM app.seo_blog_articles WHERE workspace_id=p_workspace AND id=(media_authorization.social_use->>'articleId')::uuid FOR UPDATE;
  IF NOT app_private.seo_media_social_use_eligible(p_workspace,p_use) THEN RAISE EXCEPTION 'Current exact social image use/quality/bytes required' USING ERRCODE='55000'; END IF;
  manifest:=app_private.seo_media_asset_manifest(p_workspace,media_authorization.asset_id,encode(media_authorization.asset_sha256,'hex'),media_authorization.social_use->>'profile',media_authorization.social_use->>'alt');
  canonical:=jsonb_build_object('contentItemId',media_authorization.canonical_item_id,'contentVersionId',media_authorization.canonical_version_id,
    'contentSha256',encode(media_authorization.canonical_content_sha256,'hex'),'approvalRequestId',media_authorization.approval_request_id,'approvalDecisionId',media_authorization.approval_decision_id);
  PERFORM app_private.seo_media_assert_manifest(p_workspace,manifest,canonical);
  SELECT * INTO selected FROM app.company_content_versions WHERE workspace_id=p_workspace AND id=media_authorization.canonical_version_id;
  observed_at:=clock_timestamp();
  INSERT INTO app.company_content_source_attestations(id,workspace_id,content_item_id,content_version_id,source_system,source_item_id,source_version,
    content_sha256,blob_sha256,brand_sha256,source_catalog_sha256,checked_at,expires_at,attested_by_user_id,attested_request_id,created_at)
    VALUES(attestation_id,p_workspace,selected.content_item_id,selected.id,selected.source_system,selected.source_item_id,selected.source_version,
      selected.content_sha256,selected.blob_sha256,selected.brand_sha256,
      public.digest(jsonb_build_object('schema','relaunch72.seo-social-image-observation/v1','useId',p_use,'revision',media_authorization.social_use->'revision',
        'manifest',manifest,'observation',p_command,'observedAt',observed_at)::text,'sha256'),
      observed_at,observed_at+interval '15 minutes',actor,current_setting('app.request_id'),observed_at);
  result:=jsonb_build_object('useId',p_use,'sourceAttestationId',attestation_id,'expiresAt',observed_at+interval '15 minutes');
  PERFORM app_private.seo_media_command(p_workspace,p_command,'refresh_social_image_attestation',actor,request_hash,result);
  RETURN result;
END $f$;

CREATE FUNCTION app_private.seo_media_campaign_source(p_workspace uuid,p_article uuid,p_variant uuid,p_revision uuid,p_require_published boolean)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE source jsonb; revision jsonb; article app.seo_blog_articles%ROWTYPE; media_authorization app.seo_blog_media_owner_authorizations%ROWTYPE;
  expected jsonb; image jsonb; media jsonb; asset app.seo_blog_media_assets%ROWTYPE; raw bytea;
BEGIN
  source:=app_private.seo_media_campaign_revision(p_workspace,p_article,p_variant,p_revision);revision:=source->'revision';
  IF revision IS NULL OR p_require_published IS NULL THEN RETURN NULL; END IF;
  IF NOT app_private.seo_blog_assert_article_promotion(p_workspace,p_article,(revision->>'articleVersionId')::uuid,
    revision->>'articleContentSha',revision->>'canonicalUrl',p_require_published) THEN RETURN NULL; END IF;
  IF p_require_published THEN
    SELECT * INTO article FROM app.seo_blog_articles WHERE workspace_id=p_workspace AND id=p_article;
    IF article.held OR article.data->'hold' IS DISTINCT FROM 'null'::jsonb OR NOT EXISTS(
      SELECT 1 FROM app.seo_blog_publications publication WHERE publication.workspace_id=p_workspace AND publication.article_id=p_article
        AND publication.version_id::text=revision->>'articleVersionId' AND publication.state='published'
        AND publication.data->>'contentSha'=revision->>'articleContentSha' AND publication.data->>'publicUrl'=revision->>'canonicalUrl'
        AND jsonb_typeof(publication.data->'verifiedAt')='string' AND length(publication.data->>'verifiedAt')>0
        AND ((publication.data#>>'{policy,rule}'='approved' AND publication.data#>>'{policy,approvedVersionId}'=revision->>'articleVersionId')
          OR (publication.data#>>'{policy,rule}'='auto_unflagged' AND publication.data#>'{policy,autoPublish}'='true'::jsonb
            AND publication.data#>'{policy,requiresApproval}'='false'::jsonb))) THEN RETURN NULL; END IF;
  END IF;
  media:=revision->'media';
  IF media IS NULL OR media='null'::jsonb THEN
    IF revision->>'network'<>'linkedin' THEN RETURN NULL; END IF;
  ELSE
    IF media->>'profile' IS DISTINCT FROM revision->>'network'
      OR NOT app_private.seo_media_social_use_eligible(p_workspace,(media->>'useId')::uuid) THEN RETURN NULL; END IF;
    SELECT * INTO media_authorization FROM app.seo_blog_media_owner_authorizations WHERE workspace_id=p_workspace AND id=(media->>'useId')::uuid AND use_kind='social_variant';
    IF media_authorization.id IS NULL OR media_authorization.social_use->'revision' IS DISTINCT FROM revision THEN RETURN NULL; END IF;
    SELECT * INTO asset FROM app.seo_blog_media_assets a WHERE a.workspace_id=p_workspace AND a.id=media_authorization.asset_id AND a.byte_sha256=media_authorization.asset_sha256;
    SELECT b.bytes INTO raw FROM app.seo_blog_blobs b WHERE b.workspace_id=p_workspace AND b.id=asset.blob_id;
    IF asset.id IS NULL OR public.digest(raw,'sha256')<>asset.byte_sha256 THEN RETURN NULL; END IF;
    image:=jsonb_build_object('mimeType','image/jpeg','base64',replace(encode(raw,'base64'),E'\n',''),'sha256',encode(asset.byte_sha256,'hex'),
      'width',asset.width,'height',asset.height,'alt',media->>'alt');
  END IF;
  expected:=jsonb_build_object('schema','propertypredator.company-content/v1','type','seo_campaign','kind','article_promotion','platform',revision->>'network',
    'title',revision->>'title','body',(revision->>'copy')||E'\n\n'||(revision->>'canonicalUrl'),'artwork_instructions',revision->'artworkInstructions',
    'cta_url',revision->>'canonicalUrl','contextSha256',revision->>'sha256');
  IF image IS NOT NULL THEN expected:=expected||jsonb_build_object('image',image); END IF;
  RETURN source||jsonb_build_object('body',expected,'mediaUse',app_private.seo_media_social_authorization_json(p_workspace,media_authorization.id));
EXCEPTION WHEN data_exception THEN RETURN NULL;
END $f$;

CREATE FUNCTION app_private.seo_blog_assert_campaign_revision(p_workspace uuid,p_article uuid,p_parent uuid,p_variant uuid,p_revision uuid,p_sha text,p_require_published boolean)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE source jsonb;
BEGIN
  IF app_private.current_workspace_id() IS DISTINCT FROM p_workspace THEN RETURN false; END IF;
  IF app_private.current_actor_kind() IS DISTINCT FROM 'user'
    OR NOT app_private.can_manage_workspace(app_private.current_user_id(),p_workspace) THEN RETURN false; END IF;
  PERFORM 1 FROM app.seo_blog_brands WHERE workspace_id=p_workspace FOR UPDATE;
  PERFORM 1 FROM app.seo_blog_articles WHERE workspace_id=p_workspace AND id=p_article FOR UPDATE;
  source:=app_private.seo_media_campaign_source(p_workspace,p_article,p_variant,p_revision,p_require_published);
  RETURN source IS NOT NULL AND source#>>'{revision,articleVersionId}'=p_parent::text AND source#>>'{revision,sha256}'=p_sha;
EXCEPTION WHEN data_exception THEN RETURN false;
END $f$;

CREATE FUNCTION app_private.seo_blog_assert_campaign_content(p_workspace uuid,p_content_version uuid,p_require_published boolean)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE version app.company_content_versions%ROWTYPE; source jsonb; revision jsonb; metadata jsonb; expected jsonb;
BEGIN
  IF app_private.current_workspace_id() IS DISTINCT FROM p_workspace THEN RETURN false; END IF;
  SELECT * INTO version FROM app.company_content_versions WHERE workspace_id=p_workspace AND id=p_content_version;
  metadata:=version.metadata;
  IF version.id IS NULL OR version.source_system<>'relaunch72.seo-blog' OR version.content_kind<>'social_post'
    OR version.content_mime_type<>'application/vnd.propertypredator.company-content+json'
    OR metadata->>'source' IS DISTINCT FROM 'relaunch72.seo-blog' OR metadata->>'campaignSchema' IS DISTINCT FROM 'relaunch72.seo-campaign/v1'
    OR metadata->>'brandId' IS DISTINCT FROM p_workspace::text THEN RETURN false; END IF;
  source:=app_private.seo_media_campaign_source(p_workspace,(metadata->>'articleId')::uuid,(metadata->>'variantId')::uuid,
    (metadata->>'variantRevisionId')::uuid,p_require_published);revision:=source->'revision';expected:=source->'body';
  IF revision IS NULL OR metadata->>'articleVersionId' IS DISTINCT FROM revision->>'articleVersionId'
    OR metadata->>'articleContentSha' IS DISTINCT FROM revision->>'articleContentSha'
    OR metadata->>'canonicalUrl' IS DISTINCT FROM revision->>'canonicalUrl' OR metadata->>'network' IS DISTINCT FROM revision->>'network'
    OR metadata->>'variantSha256' IS DISTINCT FROM revision->>'sha256'
    OR version.source_item_id IS DISTINCT FROM p_workspace::text||':'||(metadata->>'articleId')||':'||(revision->>'network')||':'||(revision->>'variantId')
    OR version.source_version IS DISTINCT FROM 'campaign:v1:'||(revision->>'articleVersionId')||':'||(revision->>'id')||':'||(revision->>'sha256')
    OR version.content_body IS DISTINCT FROM app_private.seo_media_campaign_canonical(expected)
    OR version.content_sha256<>public.digest(version.content_body,'sha256') THEN RETURN false; END IF;
  IF revision->'media' IS NULL OR revision->'media'='null'::jsonb THEN
    IF metadata ?| ARRAY['mediaUseId','mediaAssetId','mediaSha256'] THEN RETURN false; END IF;
  ELSIF metadata->>'mediaUseId' IS DISTINCT FROM revision#>>'{media,useId}' OR metadata->>'mediaAssetId' IS DISTINCT FROM revision#>>'{media,assetId}'
    OR metadata->>'mediaSha256' IS DISTINCT FROM revision#>>'{media,assetSha256}' THEN RETURN false;
  END IF;
  IF p_require_published AND (EXISTS(SELECT 1 FROM app.company_content_versions newer WHERE newer.workspace_id=p_workspace
      AND newer.content_item_id=version.content_item_id AND newer.version_number>version.version_number)
    OR NOT EXISTS(SELECT 1 FROM app.company_content_approval_requests request JOIN app.company_content_approval_decisions decision
      ON decision.workspace_id=request.workspace_id AND decision.approval_request_id=request.id AND decision.content_sha256=request.content_sha256
      AND decision.decision='approved' WHERE request.workspace_id=p_workspace AND request.content_version_id=version.id
        AND request.content_sha256=version.content_sha256 AND NOT EXISTS(SELECT 1 FROM app.company_content_approval_requests later
          WHERE later.workspace_id=p_workspace AND later.content_version_id=request.content_version_id AND later.request_number>request.request_number))) THEN RETURN false; END IF;
  RETURN true;
EXCEPTION WHEN data_exception THEN RETURN false;
END $f$;

CREATE FUNCTION app_private.seo_media_campaign_marker(p_system text,p_mime text,p_metadata jsonb,p_body text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE body jsonb;
BEGIN
  IF p_system IS DISTINCT FROM 'relaunch72.seo-blog' OR p_mime IS DISTINCT FROM 'application/vnd.propertypredator.company-content+json'
    OR p_metadata->>'source' IS DISTINCT FROM 'relaunch72.seo-blog' OR p_metadata->>'campaignSchema' IS DISTINCT FROM 'relaunch72.seo-campaign/v1'
    OR p_body IS NULL OR octet_length(p_body)>900000 THEN RETURN false; END IF;
  body:=p_body::jsonb;
  RETURN coalesce(body->>'schema'='propertypredator.company-content/v1' AND body->>'type'='seo_campaign'
    AND body->>'kind'='article_promotion' AND body->>'platform'=p_metadata->>'network',false);
EXCEPTION WHEN data_exception THEN RETURN false;
END $f$;

CREATE FUNCTION app_private.seo_media_campaign_family(p_system text,p_mime text,p_metadata jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
  SELECT coalesce(p_system='relaunch72.seo-blog' AND (p_metadata ? 'campaignSchema' OR p_mime='application/vnd.propertypredator.company-content+json'),false)
$f$;

CREATE FUNCTION app_private.seo_media_campaign_evidence(p_workspace uuid,p_post uuid,p_require_published boolean DEFAULT true)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE post app.company_content_versions%ROWTYPE; image app.company_content_versions%ROWTYPE; media_authorization app.seo_blog_media_owner_authorizations%ROWTYPE;
  selected_attestation app.company_content_source_attestations%ROWTYPE; approved_at timestamptz;
BEGIN
  IF NOT app_private.seo_blog_assert_campaign_content(p_workspace,p_post,p_require_published) THEN RETURN NULL; END IF;
  SELECT * INTO post FROM app.company_content_versions WHERE workspace_id=p_workspace AND id=p_post;
  IF post.metadata->>'mediaUseId' IS NULL THEN RETURN jsonb_build_object('image','null'::jsonb); END IF;
  SELECT * INTO media_authorization FROM app.seo_blog_media_owner_authorizations WHERE workspace_id=p_workspace AND id=(post.metadata->>'mediaUseId')::uuid AND use_kind='social_variant';
  SELECT * INTO image FROM app.company_content_versions WHERE workspace_id=p_workspace AND id=media_authorization.canonical_version_id;
  SELECT decision.decided_at INTO approved_at FROM app.company_content_approval_decisions decision
    WHERE decision.workspace_id=p_workspace AND decision.id=media_authorization.approval_decision_id;
  SELECT attestation.* INTO selected_attestation FROM app.company_content_source_attestations attestation
    JOIN app.seo_blog_media_commands receipt ON receipt.workspace_id=attestation.workspace_id AND receipt.action='refresh_social_image_attestation'
      AND receipt.result->>'useId'=media_authorization.id::text AND receipt.result->>'sourceAttestationId'=attestation.id::text
    WHERE attestation.workspace_id=p_workspace AND attestation.content_version_id=image.id AND attestation.content_sha256=image.content_sha256
      AND attestation.blob_sha256=image.blob_sha256 AND attestation.brand_sha256=image.brand_sha256
    ORDER BY attestation.checked_at DESC,attestation.id DESC LIMIT 1;
  RETURN jsonb_build_object('image',jsonb_build_object('ordinal',1,'useId',media_authorization.id,'assetId',media_authorization.asset_id,
    'contentItemId',image.content_item_id,'contentVersionId',image.id,'contentSha256',encode(image.content_sha256,'hex'),
    'blobSha256',encode(image.blob_sha256,'hex'),'brandSha256',encode(image.brand_sha256,'hex'),'blobStorageKey',image.blob_storage_key,
    'contentMimeType',image.content_mime_type,'approvalRequestId',media_authorization.approval_request_id,'approvalDecisionId',media_authorization.approval_decision_id,
    'approvedAt',approved_at,'sourceAttestationId',selected_attestation.id,'attestationCheckedAt',selected_attestation.checked_at,'attestationExpiresAt',selected_attestation.expires_at));
EXCEPTION WHEN data_exception THEN RETURN NULL;
END $f$;

-- Private immutable material for the already-leased exact operation. It deliberately permits read-only reconciliation
-- after source changes/withdrawal; the unchanged begin boundary still requires fresh effect readiness before any upload/send.
CREATE FUNCTION app_private.seo_media_campaign_pinned_image(p_workspace uuid,p_post uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE post app.company_content_versions%ROWTYPE; media_authorization app.seo_blog_media_owner_authorizations%ROWTYPE;
  revision jsonb; asset app.seo_blog_media_assets%ROWTYPE; raw bytea; inline_image jsonb; expected jsonb;
BEGIN
  IF session_user<>'r72_owned_social_worker_command' OR app_private.current_workspace_id() IS DISTINCT FROM p_workspace
    OR app_private.current_actor_kind()<>'worker' OR app_private.current_user_id() IS NOT NULL THEN RETURN NULL; END IF;
  SELECT * INTO post FROM app.company_content_versions WHERE workspace_id=p_workspace AND id=p_post;
  IF NOT app_private.seo_media_campaign_marker(post.source_system,post.content_mime_type,post.metadata,post.content_body)
    OR post.metadata->>'mediaUseId' IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO media_authorization FROM app.seo_blog_media_owner_authorizations WHERE workspace_id=p_workspace
    AND id=(post.metadata->>'mediaUseId')::uuid AND use_kind='social_variant';
  revision:=media_authorization.social_use->'revision';
  IF revision IS NULL OR revision#>>'{media,useId}' IS DISTINCT FROM media_authorization.id::text
    OR post.metadata->>'mediaAssetId' IS DISTINCT FROM media_authorization.asset_id::text
    OR post.metadata->>'mediaSha256' IS DISTINCT FROM encode(media_authorization.asset_sha256,'hex')
    OR post.metadata->>'variantId' IS DISTINCT FROM revision->>'variantId' OR post.metadata->>'variantRevisionId' IS DISTINCT FROM revision->>'id'
    OR post.metadata->>'variantSha256' IS DISTINCT FROM revision->>'sha256'
    OR post.source_item_id IS DISTINCT FROM p_workspace::text||':'||(media_authorization.social_use->>'articleId')||':'||(revision->>'network')||':'||(revision->>'variantId')
    OR post.source_version IS DISTINCT FROM 'campaign:v1:'||(revision->>'articleVersionId')||':'||(revision->>'id')||':'||(revision->>'sha256') THEN RETURN NULL; END IF;
  SELECT * INTO asset FROM app.seo_blog_media_assets WHERE workspace_id=p_workspace AND id=media_authorization.asset_id AND byte_sha256=media_authorization.asset_sha256;
  SELECT b.bytes INTO raw FROM app.seo_blog_blobs b WHERE b.workspace_id=p_workspace AND b.id=asset.blob_id;
  IF asset.id IS NULL OR public.digest(raw,'sha256')<>asset.byte_sha256 THEN RETURN NULL; END IF;
  inline_image:=jsonb_build_object('mimeType','image/jpeg','base64',replace(encode(raw,'base64'),E'\n',''),'sha256',encode(asset.byte_sha256,'hex'),
    'width',asset.width,'height',asset.height,'alt',revision#>>'{media,alt}');
  expected:=jsonb_build_object('schema','propertypredator.company-content/v1','type','seo_campaign','kind','article_promotion','platform',revision->>'network',
    'title',revision->>'title','body',(revision->>'copy')||E'\n\n'||(revision->>'canonicalUrl'),'artwork_instructions',revision->'artworkInstructions',
    'cta_url',revision->>'canonicalUrl','contextSha256',revision->>'sha256','image',inline_image);
  IF post.content_body IS DISTINCT FROM app_private.seo_media_campaign_canonical(expected) THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('storageKey','seo-blog-media/'||asset.id::text||'/'||encode(asset.byte_sha256,'hex'),
    'blobSha256',encode(asset.byte_sha256,'hex'),'mimeType','image/jpeg','inlineImage',inline_image,
    'seoCampaign',jsonb_build_object('system','relaunch72.seo-blog','workspaceId',p_workspace,'articleId',media_authorization.social_use->>'articleId',
      'articleVersionId',media_authorization.article_version_id,'variantId',revision->>'variantId','variantRevisionId',revision->>'id',
      'variantSha256',revision->>'sha256','mediaUseId',media_authorization.id,'assetId',asset.id));
EXCEPTION WHEN data_exception THEN RETURN NULL;
END $f$;

CREATE FUNCTION app_private.seo_media_campaign_queue_time(p_verified_at timestamptz,p_rule jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE zone text:=p_rule->>'timezone'; days integer; wall timestamp; guess timestamptz; resolved timestamptz; candidates integer;
BEGIN
  IF zone IS NULL OR NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=zone) THEN RETURN jsonb_build_object('kind','held','reason','invalid_timezone'); END IF;
  IF p_rule->>'kind'='pinned' THEN
    IF coalesce(p_rule->>'atUtc','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$' THEN
      RETURN jsonb_build_object('kind','held','reason','invalid_pin');
    END IF;
    resolved:=(p_rule->>'atUtc')::timestamptz;
  ELSIF p_rule->>'kind'='relative_verified' THEN
    IF jsonb_typeof(p_rule->'days') IS DISTINCT FROM 'number' OR (p_rule->>'days')<>ALL(ARRAY['0','3','7'])
      OR p_rule->'afterMinutes' IS DISTINCT FROM '60'::jsonb THEN RETURN jsonb_build_object('kind','held','reason','invalid_relative_rule'); END IF;
    IF p_verified_at IS NULL THEN RETURN jsonb_build_object('kind','held','reason','awaiting_verified_parent'); END IF;
    days:=(p_rule->>'days')::integer;
    IF days=0 THEN resolved:=p_verified_at; -- The exact known UTC event already resolves its original fold.
    ELSE
      wall:=(p_verified_at AT TIME ZONE zone)+make_interval(days=>days);guess:=wall AT TIME ZONE zone;
      -- Explicitly detect gaps/overlaps instead of PostgreSQL's implicit standard-time preference.
      -- Current/future IANA civil offsets are minute-based; this bound includes date-line and half-hour transitions.
      SELECT count(*)::integer,min(candidate) INTO candidates,resolved FROM generate_series(guess-interval '26 hours',guess+interval '26 hours',interval '1 minute') candidate
        WHERE candidate AT TIME ZONE zone=wall;
      IF candidates=0 THEN RETURN jsonb_build_object('kind','held','reason','timezone_gap'); END IF;
      IF candidates<>1 THEN RETURN jsonb_build_object('kind','held','reason','timezone_ambiguous'); END IF;
    END IF;
    resolved:=resolved+interval '60 minutes';
  ELSE RETURN jsonb_build_object('kind','held','reason','invalid_date_rule'); END IF;
  RETURN jsonb_build_object('kind','resolved','atUtc',resolved,'timezone',zone);
EXCEPTION WHEN data_exception THEN RETURN jsonb_build_object('kind','held','reason','invalid_date_rule');
END $f$;

-- These instructions are genuine-session commands, never authority copied from worker-writable Article JSON.
CREATE FUNCTION app_private.seo_media_campaign_queue_receipt_id(p_queue uuid)
RETURNS uuid LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
  SELECT (substr(h,1,8)||'-'||substr(h,9,4)||'-5'||substr(h,14,3)||'-8'||substr(h,18,3)||'-'||substr(h,21,12))::uuid
  FROM (SELECT encode(public.digest('relaunch72.seo-campaign-queue-receipt/v1:'||p_queue::text,'sha256'),'hex') h) seed
$f$;

CREATE FUNCTION app_private.seo_media_campaign_queue_current(p_workspace uuid,p_queue uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE instruction app.seo_blog_media_commands%ROWTYPE;
BEGIN
  SELECT * INTO instruction FROM app.seo_blog_media_commands WHERE workspace_id=p_workspace AND id=p_queue
    AND action='authorize_campaign_queue' AND actor_kind='user';
  IF instruction.id IS NULL OR NOT app_private.can_manage_workspace(instruction.actor_user_id,p_workspace)
    OR EXISTS(SELECT 1 FROM app.seo_blog_media_commands cancellation WHERE cancellation.workspace_id=p_workspace
      AND cancellation.action='cancel_campaign_queue' AND cancellation.result->>'queueIntentId'=p_queue::text)
    OR EXISTS(SELECT 1 FROM app.seo_blog_media_commands later WHERE later.workspace_id=p_workspace
      AND later.action='authorize_campaign_queue' AND later.result->>'articleId'=instruction.result->>'articleId'
      AND later.result->>'variantId'=instruction.result->>'variantId'
      AND (later.created_at,later.id)>(instruction.created_at,instruction.id)) THEN RETURN NULL; END IF;
  RETURN instruction.result;
END $f$;

CREATE FUNCTION app_private.seo_media_authorize_campaign_queue(p_workspace uuid,p_session bytea,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; command uuid:=(p_input->>'commandId')::uuid; request_hash bytea; replayed jsonb; result jsonb;
  post app.company_content_versions%ROWTYPE; revision jsonb; source jsonb; binding jsonb; approved record; observed uuid;
  target_digest text; previous uuid; rule jsonb:=p_input->'dateRule'; time_check jsonb; brand_timezone text; image_evidence jsonb;
BEGIN
  actor:=app_private.seo_media_owner(p_workspace,p_session);
  IF command IS NULL OR jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_input) k
    WHERE k<>ALL(ARRAY['commandId','articleId','articleVersionId','articleContentSha','variantId','variantRevisionId','variantSha256','contentVersionId','bindingId','dateRule'])) THEN
    RAISE EXCEPTION 'Exact campaign queue command required' USING ERRCODE='22023'; END IF;
  PERFORM app_private.seo_media_lock_brand(p_workspace);
  request_hash:=public.digest(jsonb_build_object('action','authorize_campaign_queue','workspace',p_workspace,'actor',actor,'input',p_input)::text,'sha256');
  replayed:=app_private.seo_media_replay(p_workspace,command,'authorize_campaign_queue',actor,request_hash);
  IF replayed IS NOT NULL THEN RETURN replayed; END IF;
  PERFORM 1 FROM app.seo_blog_articles WHERE workspace_id=p_workspace AND id=(p_input->>'articleId')::uuid FOR UPDATE;
  SELECT * INTO post FROM app.company_content_versions WHERE workspace_id=p_workspace AND id=(p_input->>'contentVersionId')::uuid;
  IF NOT app_private.seo_blog_assert_campaign_content(p_workspace,post.id,false) THEN
    RAISE EXCEPTION 'Current exact campaign post required' USING ERRCODE='55000'; END IF;
  source:=app_private.seo_media_campaign_source(p_workspace,(p_input->>'articleId')::uuid,(p_input->>'variantId')::uuid,(p_input->>'variantRevisionId')::uuid,false);
  revision:=source->'revision';
  IF revision IS NULL OR revision->>'articleVersionId' IS DISTINCT FROM p_input->>'articleVersionId'
    OR revision->>'articleContentSha' IS DISTINCT FROM p_input->>'articleContentSha' OR revision->>'sha256' IS DISTINCT FROM p_input->>'variantSha256'
    OR post.metadata->>'articleId' IS DISTINCT FROM p_input->>'articleId' OR post.metadata->>'variantId' IS DISTINCT FROM p_input->>'variantId'
    OR post.metadata->>'variantRevisionId' IS DISTINCT FROM p_input->>'variantRevisionId'
    OR EXISTS(SELECT 1 FROM app.company_content_versions newer WHERE newer.workspace_id=p_workspace AND newer.content_item_id=post.content_item_id AND newer.version_number>post.version_number) THEN
    RAISE EXCEPTION 'Campaign queue source changed' USING ERRCODE='55000'; END IF;
  SELECT request.id request_id,decision.id decision_id INTO approved FROM app.company_content_approval_requests request
    JOIN app.company_content_approval_decisions decision ON decision.workspace_id=request.workspace_id AND decision.approval_request_id=request.id
      AND decision.content_sha256=request.content_sha256 AND decision.decision='approved'
    WHERE request.workspace_id=p_workspace AND request.content_version_id=post.id AND request.content_sha256=post.content_sha256
      AND NOT EXISTS(SELECT 1 FROM app.company_content_approval_requests later WHERE later.workspace_id=p_workspace
        AND later.content_version_id=post.id AND later.request_number>request.request_number);
  SELECT a.id INTO observed FROM app.company_content_source_attestations a WHERE a.workspace_id=p_workspace AND a.content_version_id=post.id
    AND a.content_sha256=post.content_sha256 AND a.blob_sha256=post.blob_sha256 AND a.brand_sha256=post.brand_sha256
    AND a.checked_at<=statement_timestamp() AND a.expires_at>statement_timestamp() AND a.attested_by_user_id=actor
    ORDER BY a.checked_at DESC,a.id DESC LIMIT 1;
  IF approved.request_id IS NULL OR observed IS NULL THEN RAISE EXCEPTION 'Approved and owner-observed exact post required' USING ERRCODE='55000'; END IF;
  image_evidence:=app_private.seo_media_campaign_evidence(p_workspace,post.id,false)->'image';
  IF revision->'media' IS DISTINCT FROM 'null'::jsonb AND (image_evidence IS NULL OR image_evidence='null'::jsonb
    OR image_evidence->>'sourceAttestationId' IS NULL OR (image_evidence->>'attestationExpiresAt')::timestamptz<=statement_timestamp()) THEN
    RAISE EXCEPTION 'Fresh owner-observed exact social image required' USING ERRCODE='55000'; END IF;
  binding:=app_private.seo_blog_campaign_binding(p_workspace,(p_input->>'bindingId')::uuid,revision->>'network');
  IF binding IS NULL THEN RAISE EXCEPTION 'Current registered campaign account required' USING ERRCODE='55000'; END IF;
  IF binding->>'targetId' IS NULL THEN RAISE EXCEPTION 'seo.campaign_planner_target_missing' USING ERRCODE='P0136'; END IF;
  brand_timezone:=app_private.seo_blog_brand(p_workspace)->>'timezone';
  IF rule->>'timezone' IS DISTINCT FROM brand_timezone OR jsonb_typeof(rule) IS DISTINCT FROM 'object'
    OR (rule->>'kind'='relative_verified' AND (rule->'days' IS DISTINCT FROM revision->'relativeDays'
      OR EXISTS(SELECT 1 FROM jsonb_object_keys(rule) k WHERE k<>ALL(ARRAY['kind','days','afterMinutes','timezone']))))
    OR (rule->>'kind'='pinned' AND EXISTS(SELECT 1 FROM jsonb_object_keys(rule) k WHERE k<>ALL(ARRAY['kind','atUtc','timezone']))) THEN
    RAISE EXCEPTION 'Queue dates must use the reviewed variant rule and brand timezone' USING ERRCODE='22023'; END IF;
  time_check:=app_private.seo_media_campaign_queue_time(NULL,rule);
  IF time_check->>'kind'='held' AND time_check->>'reason'<>'awaiting_verified_parent' THEN
    RAISE EXCEPTION 'Invalid campaign queue date rule' USING ERRCODE='22023'; END IF;
  SELECT coalesce(v.data#>>'{websiteTarget,deliverySha}',v.content_sha256) INTO target_digest FROM app.seo_blog_article_versions v
    WHERE v.workspace_id=p_workspace AND v.id=(revision->>'articleVersionId')::uuid;
  SELECT c.id INTO previous FROM app.seo_blog_media_commands c WHERE c.workspace_id=p_workspace AND c.action='authorize_campaign_queue'
    AND c.result->>'articleId'=p_input->>'articleId' AND c.result->>'variantId'=p_input->>'variantId' ORDER BY c.created_at DESC,c.id DESC LIMIT 1;
  result:=p_input-'commandId'||jsonb_build_object('queueIntentId',command,'authorizingUserId',actor,'contentItemId',post.content_item_id,
    'contentSha256',encode(post.content_sha256,'hex'),'approvalRequestId',approved.request_id,'approvalDecisionId',approved.decision_id,
    'sourceAttestationId',observed,'canonicalUrl',revision->>'canonicalUrl','reviewedIntentSha',target_digest,
    'revision',jsonb_build_object('id',revision->>'id','network',revision->>'network','angle',revision->>'angle','relativeDays',revision->'relativeDays'),
    'binding',binding,'imageEvidence',image_evidence,'supersedesQueueIntentId',previous);
  PERFORM app_private.seo_media_command(p_workspace,command,'authorize_campaign_queue',actor,request_hash,result);
  IF previous IS NOT NULL THEN PERFORM app_private.seo_blog_cancel_campaign_target(p_workspace,previous,actor); END IF;
  RETURN result;
END $f$;

CREATE FUNCTION app_private.seo_media_cancel_campaign_queue(p_workspace uuid,p_session bytea,p_queue uuid,p_command uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; request_hash bytea; replayed jsonb; result jsonb;
BEGIN
  actor:=app_private.seo_media_owner(p_workspace,p_session);PERFORM app_private.seo_media_lock_brand(p_workspace);
  request_hash:=public.digest(jsonb_build_object('action','cancel_campaign_queue','workspace',p_workspace,'actor',actor,'queue',p_queue)::text,'sha256');
  replayed:=app_private.seo_media_replay(p_workspace,p_command,'cancel_campaign_queue',actor,request_hash);IF replayed IS NOT NULL THEN RETURN replayed; END IF;
  IF NOT EXISTS(SELECT 1 FROM app.seo_blog_media_commands WHERE workspace_id=p_workspace AND id=p_queue AND action='authorize_campaign_queue') THEN
    RAISE EXCEPTION 'Campaign instruction not found' USING ERRCODE='P0002'; END IF;
  result:=jsonb_build_object('queueIntentId',p_queue,'cancelled',true);
  PERFORM app_private.seo_media_command(p_workspace,p_command,'cancel_campaign_queue',actor,request_hash,result);
  PERFORM app_private.seo_blog_cancel_campaign_target(p_workspace,p_queue,actor);
  RETURN result;
END $f$;

-- firstVerifiedAt is latched by the verified-publication store. Legacy latest verifiedAt is never guessed to be the first event.
CREATE FUNCTION app_private.seo_media_campaign_parent_anchor(p_workspace uuid,p_queue uuid,p_instruction jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE parent app.seo_blog_publications%ROWTYPE; receipt jsonb; stable_at timestamptz; anchor_at timestamptz; anchor_kind text;
BEGIN
  SELECT result INTO receipt FROM app.seo_blog_media_commands WHERE workspace_id=p_workspace
    AND id=app_private.seo_media_campaign_queue_receipt_id(p_queue) AND action='materialize_campaign_queue' AND actor_kind='worker';
  IF receipt IS NOT NULL THEN
    SELECT * INTO parent FROM app.seo_blog_publications p WHERE p.workspace_id=p_workspace AND p.id=(receipt->>'anchorPublicationId')::uuid;
  ELSE
    IF p_instruction#>>'{dateRule,kind}'='relative_verified' AND EXISTS(SELECT 1 FROM app.seo_blog_publications p
      WHERE p.workspace_id=p_workspace AND p.article_id=(p_instruction->>'articleId')::uuid AND p.version_id=(p_instruction->>'articleVersionId')::uuid
        AND p.state='published' AND p.data->>'contentSha'=p_instruction->>'articleContentSha' AND p.data->>'publicUrl'=p_instruction->>'canonicalUrl'
        AND jsonb_typeof(p.data->'verifiedAt')='string' AND (p.data->>'verifiedAt')::timestamptz<=statement_timestamp()
        AND ((p.data#>>'{policy,rule}'='approved' AND p.data#>>'{policy,approvedVersionId}'=p_instruction->>'articleVersionId')
          OR (p.data#>>'{policy,rule}'='auto_unflagged' AND p.data#>'{policy,autoPublish}'='true'::jsonb AND p.data#>'{policy,requiresApproval}'='false'::jsonb))
        AND (jsonb_typeof(p.data->'firstVerifiedAt') IS DISTINCT FROM 'string' OR (p.data->>'firstVerifiedAt')::timestamptz>(p.data->>'verifiedAt')::timestamptz)) THEN
      RETURN NULL; -- A newer known event cannot prove the earliest date among unknown historical events.
    END IF;
    SELECT * INTO parent FROM app.seo_blog_publications p WHERE p.workspace_id=p_workspace AND p.article_id=(p_instruction->>'articleId')::uuid
      AND p.version_id=(p_instruction->>'articleVersionId')::uuid AND p.state='published'
      AND p.data->>'contentSha'=p_instruction->>'articleContentSha' AND p.data->>'publicUrl'=p_instruction->>'canonicalUrl'
      AND jsonb_typeof(p.data->'verifiedAt')='string' AND (p.data->>'verifiedAt')::timestamptz<=statement_timestamp()
      AND ((p.data#>>'{policy,rule}'='approved' AND p.data#>>'{policy,approvedVersionId}'=p_instruction->>'articleVersionId')
        OR (p.data#>>'{policy,rule}'='auto_unflagged' AND p.data#>'{policy,autoPublish}'='true'::jsonb AND p.data#>'{policy,requiresApproval}'='false'::jsonb))
      AND (p_instruction#>>'{dateRule,kind}'='pinned' OR (jsonb_typeof(p.data->'firstVerifiedAt')='string'
        AND (p.data->>'firstVerifiedAt')::timestamptz<=(p.data->>'verifiedAt')::timestamptz))
      ORDER BY CASE WHEN jsonb_typeof(p.data->'firstVerifiedAt')='string' THEN 0 ELSE 1 END,
        coalesce((p.data->>'firstVerifiedAt')::timestamptz,(p.data->>'verifiedAt')::timestamptz),p.id LIMIT 1;
  END IF;
  IF parent.id IS NULL OR parent.article_id::text IS DISTINCT FROM p_instruction->>'articleId'
    OR parent.version_id::text IS DISTINCT FROM p_instruction->>'articleVersionId' OR parent.state<>'published'
    OR parent.data->>'contentSha' IS DISTINCT FROM p_instruction->>'articleContentSha'
    OR parent.data->>'publicUrl' IS DISTINCT FROM p_instruction->>'canonicalUrl'
    OR jsonb_typeof(parent.data->'verifiedAt') IS DISTINCT FROM 'string' OR (parent.data->>'verifiedAt')::timestamptz>statement_timestamp()
    OR (((parent.data#>>'{policy,rule}'='approved' AND parent.data#>>'{policy,approvedVersionId}'=p_instruction->>'articleVersionId')
      OR (parent.data#>>'{policy,rule}'='auto_unflagged' AND parent.data#>'{policy,autoPublish}'='true'::jsonb AND parent.data#>'{policy,requiresApproval}'='false'::jsonb)) IS DISTINCT FROM TRUE) THEN RETURN NULL; END IF;
  IF jsonb_typeof(parent.data->'firstVerifiedAt')='string' THEN stable_at:=(parent.data->>'firstVerifiedAt')::timestamptz; END IF;
  IF receipt IS NOT NULL THEN
    anchor_at:=(receipt->>'anchorVerifiedAt')::timestamptz;anchor_kind:=receipt->>'anchorKind';
    IF receipt->>'queueIntentId' IS DISTINCT FROM p_queue::text OR anchor_at IS NULL OR anchor_at>(parent.data->>'verifiedAt')::timestamptz
      OR (anchor_kind='first_verified' AND stable_at IS DISTINCT FROM anchor_at)
      OR (anchor_kind='legacy_pinned_observation' AND p_instruction#>>'{dateRule,kind}' IS DISTINCT FROM 'pinned')
      OR coalesce(anchor_kind,'')<>ALL(ARRAY['first_verified','legacy_pinned_observation']) THEN RETURN NULL; END IF;
  ELSIF stable_at IS NOT NULL AND stable_at<=(parent.data->>'verifiedAt')::timestamptz THEN anchor_at:=stable_at;anchor_kind:='first_verified';
  ELSIF p_instruction#>>'{dateRule,kind}'='pinned' THEN anchor_at:=(parent.data->>'verifiedAt')::timestamptz;anchor_kind:='legacy_pinned_observation';
  ELSE RETURN NULL; END IF;
  RETURN jsonb_build_object('anchorPublicationId',parent.id,'anchorVerifiedAt',anchor_at,'anchorKind',anchor_kind);
EXCEPTION WHEN data_exception THEN RETURN NULL;
END $f$;

-- Private cores rederive this authority; their callers cannot pass a substitute owner or waive a current check.
CREATE FUNCTION app_private.seo_media_campaign_queue_authority(p_workspace uuid,p_queue uuid,p_post uuid,p_binding uuid,p_slot timestamptz DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE instruction jsonb; post app.company_content_versions%ROWTYPE; current_binding jsonb; anchor jsonb;
  resolved jsonb; current_target text;
BEGIN
  IF session_user NOT IN ('r72_content_command','r72_owned_social_worker_command') OR app_private.current_workspace_id() IS DISTINCT FROM p_workspace
    OR app_private.current_actor_kind()<>'worker' OR app_private.current_user_id() IS NOT NULL THEN RETURN NULL; END IF;
  instruction:=app_private.seo_media_campaign_queue_current(p_workspace,p_queue);
  IF instruction IS NULL OR instruction->>'contentVersionId' IS DISTINCT FROM p_post::text
    OR instruction->>'bindingId' IS DISTINCT FROM p_binding::text OR NOT app_private.seo_blog_assert_campaign_content(p_workspace,p_post,true) THEN RETURN NULL; END IF;
  SELECT * INTO post FROM app.company_content_versions WHERE workspace_id=p_workspace AND id=p_post;
  IF post.metadata->>'variantRevisionId' IS DISTINCT FROM instruction->>'variantRevisionId' OR post.metadata->>'variantSha256' IS DISTINCT FROM instruction->>'variantSha256'
    OR post.content_item_id::text IS DISTINCT FROM instruction->>'contentItemId' OR encode(post.content_sha256,'hex') IS DISTINCT FROM instruction->>'contentSha256'
    OR NOT EXISTS(SELECT 1 FROM app.company_content_approval_requests r JOIN app.company_content_approval_decisions d
      ON d.workspace_id=r.workspace_id AND d.approval_request_id=r.id AND d.decision='approved' AND d.content_sha256=r.content_sha256
      WHERE r.workspace_id=p_workspace AND r.id=(instruction->>'approvalRequestId')::uuid AND d.id=(instruction->>'approvalDecisionId')::uuid
        AND r.content_version_id=p_post AND r.content_sha256=post.content_sha256
        AND NOT EXISTS(SELECT 1 FROM app.company_content_approval_requests later WHERE later.workspace_id=p_workspace AND later.content_version_id=p_post AND later.request_number>r.request_number)) THEN RETURN NULL; END IF;
  SELECT coalesce(v.data#>>'{websiteTarget,deliverySha}',v.content_sha256) INTO current_target FROM app.seo_blog_article_versions v
    WHERE v.workspace_id=p_workspace AND v.id=(instruction->>'articleVersionId')::uuid;
  IF current_target IS DISTINCT FROM instruction->>'reviewedIntentSha' THEN RETURN NULL; END IF;
  current_binding:=app_private.seo_blog_campaign_binding(p_workspace,p_binding,instruction#>>'{revision,network}');
  IF current_binding IS NULL OR (current_binding-'dailyCap'-'monthlyCap') IS DISTINCT FROM ((instruction->'binding')-'dailyCap'-'monthlyCap') THEN RETURN NULL; END IF;
  current_binding:=current_binding||jsonb_build_object('dailyCap',least((current_binding->>'dailyCap')::int,(instruction#>>'{binding,dailyCap}')::int),
    'monthlyCap',least((current_binding->>'monthlyCap')::int,(instruction#>>'{binding,monthlyCap}')::int));
  anchor:=app_private.seo_media_campaign_parent_anchor(p_workspace,p_queue,instruction);
  IF anchor IS NULL THEN RETURN NULL; END IF;
  resolved:=app_private.seo_media_campaign_queue_time((anchor->>'anchorVerifiedAt')::timestamptz,instruction->'dateRule');
  IF resolved->>'kind'<>'resolved' OR (p_slot IS NOT NULL AND (resolved->>'atUtc')::timestamptz IS DISTINCT FROM p_slot) THEN RETURN NULL; END IF;
  RETURN instruction||anchor||jsonb_build_object('binding',current_binding,'resolved',resolved);
EXCEPTION WHEN data_exception THEN RETURN NULL;
END $f$;

CREATE FUNCTION app_private.seo_media_campaign_queue_material(p_workspace uuid,p_queue uuid,p_post uuid,p_slot timestamptz)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE instruction jsonb;
BEGIN
  instruction:=app_private.seo_media_campaign_queue_current(p_workspace,p_queue);
  IF instruction IS NULL THEN RETURN NULL; END IF;
  RETURN app_private.seo_media_campaign_queue_authority(p_workspace,p_queue,p_post,(instruction->>'bindingId')::uuid,p_slot);
END $f$;

CREATE FUNCTION app_private.seo_media_campaign_queue_job_authority(p_workspace uuid,p_queue uuid,p_job uuid,p_post uuid,p_binding uuid,p_slot timestamptz)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE receipt jsonb; authority jsonb;
BEGIN
  SELECT result INTO receipt FROM app.seo_blog_media_commands WHERE workspace_id=p_workspace
    AND id=app_private.seo_media_campaign_queue_receipt_id(p_queue) AND action='materialize_campaign_queue' AND actor_kind='worker';
  IF receipt->>'queueIntentId' IS DISTINCT FROM p_queue::text OR receipt->>'jobId' IS DISTINCT FROM p_job::text
    OR receipt->>'contentVersionId' IS DISTINCT FROM p_post::text OR receipt->>'bindingId' IS DISTINCT FROM p_binding::text
    OR (receipt->>'scheduledFor')::timestamptz IS DISTINCT FROM p_slot THEN RETURN false; END IF;
  authority:=app_private.seo_media_campaign_queue_authority(p_workspace,p_queue,p_post,p_binding,p_slot);
  RETURN authority IS NOT NULL AND receipt->>'authorizingUserId'=authority->>'authorizingUserId'
    AND receipt->>'anchorPublicationId'=authority->>'anchorPublicationId' AND receipt->>'anchorKind'=authority->>'anchorKind'
    AND (receipt->>'anchorVerifiedAt')::timestamptz=(authority->>'anchorVerifiedAt')::timestamptz;
EXCEPTION WHEN data_exception THEN RETURN false;
END $f$;

CREATE FUNCTION app_private.seo_media_campaign_queue_jit_ready(p_workspace uuid,p_queue uuid,p_post uuid,p_slot timestamptz)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE receipt jsonb;
BEGIN
  SELECT result INTO receipt FROM app.seo_blog_media_commands WHERE workspace_id=p_workspace
    AND id=app_private.seo_media_campaign_queue_receipt_id(p_queue) AND action='materialize_campaign_queue' AND actor_kind='worker';
  IF receipt IS NULL THEN RETURN false; END IF;
  RETURN app_private.seo_media_campaign_queue_job_authority(p_workspace,p_queue,(receipt->>'jobId')::uuid,p_post,(receipt->>'bindingId')::uuid,p_slot);
EXCEPTION WHEN data_exception THEN RETURN false;
END $f$;

CREATE FUNCTION app_private.seo_media_campaign_queue_receipt(p_workspace uuid,p_queue uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE receipt jsonb;
BEGIN
  IF session_user<>'r72_content_command' OR app_private.current_workspace_id() IS DISTINCT FROM p_workspace
    OR app_private.current_actor_kind()<>'worker' OR app_private.current_user_id() IS NOT NULL THEN
    RAISE EXCEPTION 'Actual content worker required' USING ERRCODE='42501'; END IF;
  SELECT result INTO receipt FROM app.seo_blog_media_commands WHERE workspace_id=p_workspace
    AND id=app_private.seo_media_campaign_queue_receipt_id(p_queue) AND action='materialize_campaign_queue' AND actor_kind='worker';
  RETURN receipt;
END $f$;

-- Only immutable explicit owner cancellation/supersession authorizes known-unsent retirement; revocation/pause alone does not.
CREATE FUNCTION app_private.seo_media_campaign_queue_explicitly_retired(p_workspace uuid,p_queue uuid,p_job uuid,p_post uuid,p_binding uuid,p_slot timestamptz)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE instruction app.seo_blog_media_commands%ROWTYPE; receipt jsonb;
BEGIN
  IF session_user<>'r72_content_command' OR app_private.current_workspace_id() IS DISTINCT FROM p_workspace
    OR app_private.current_actor_kind()<>'worker' OR app_private.current_user_id() IS NOT NULL THEN RETURN false; END IF;
  SELECT * INTO instruction FROM app.seo_blog_media_commands WHERE workspace_id=p_workspace AND id=p_queue AND action='authorize_campaign_queue' AND actor_kind='user';
  receipt:=app_private.seo_media_campaign_queue_receipt(p_workspace,p_queue);
  IF instruction.id IS NULL OR receipt->>'queueIntentId' IS DISTINCT FROM p_queue::text OR receipt->>'jobId' IS DISTINCT FROM p_job::text
    OR receipt->>'contentVersionId' IS DISTINCT FROM p_post::text OR receipt->>'bindingId' IS DISTINCT FROM p_binding::text
    OR instruction.result->>'contentVersionId' IS DISTINCT FROM p_post::text OR instruction.result->>'bindingId' IS DISTINCT FROM p_binding::text
    OR (receipt->>'scheduledFor')::timestamptz IS DISTINCT FROM p_slot THEN RETURN false; END IF;
  RETURN EXISTS(SELECT 1 FROM app.seo_blog_media_commands c WHERE c.workspace_id=p_workspace AND c.action='cancel_campaign_queue' AND c.actor_kind='user'
      AND c.result->>'queueIntentId'=p_queue::text)
    OR EXISTS(SELECT 1 FROM app.seo_blog_media_commands newer WHERE newer.workspace_id=p_workspace AND newer.action='authorize_campaign_queue' AND newer.actor_kind='user'
      AND newer.result->>'articleId'=instruction.result->>'articleId' AND newer.result->>'variantId'=instruction.result->>'variantId'
      AND (newer.created_at,newer.id)>(instruction.created_at,instruction.id));
EXCEPTION WHEN data_exception THEN RETURN false;
END $f$;

CREATE FUNCTION app_private.seo_blog_materialize_campaign_queue(p_workspace uuid,p_queue uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE instruction jsonb; authority jsonb; receipt jsonb; receipt_id uuid; materialized record; planned record; result jsonb; slot timestamptz;
BEGIN
  IF session_user<>'r72_content_command' OR app_private.seo_media_private_actor(p_workspace,NULL) IS NOT NULL
    OR app_private.current_actor_kind()<>'worker' THEN RAISE EXCEPTION 'Actual content worker required' USING ERRCODE='42501'; END IF;
  PERFORM app_private.seo_media_lock_brand(p_workspace);
  receipt_id:=app_private.seo_media_campaign_queue_receipt_id(p_queue);
  SELECT c.result INTO receipt FROM app.seo_blog_media_commands c WHERE c.workspace_id=p_workspace AND c.id=receipt_id
    AND c.action='materialize_campaign_queue' AND c.actor_kind='worker';
  IF receipt IS NOT NULL THEN RETURN receipt; END IF; -- History only, before fresh controls.
  instruction:=app_private.seo_media_campaign_queue_current(p_workspace,p_queue);
  IF instruction IS NULL THEN RETURN jsonb_build_object('kind','held','reason','instruction_cancelled_superseded_or_owner_revoked'); END IF;
  PERFORM 1 FROM app.seo_blog_articles WHERE workspace_id=p_workspace AND id=(instruction->>'articleId')::uuid FOR SHARE;
  authority:=app_private.seo_media_campaign_queue_material(p_workspace,p_queue,(instruction->>'contentVersionId')::uuid,NULL);
  IF authority IS NULL THEN
    IF instruction#>>'{dateRule,kind}'='relative_verified' AND EXISTS(SELECT 1 FROM app.seo_blog_publications p
      WHERE p.workspace_id=p_workspace AND p.article_id=(instruction->>'articleId')::uuid AND p.version_id=(instruction->>'articleVersionId')::uuid
        AND p.state='published' AND p.data->>'publicUrl'=instruction->>'canonicalUrl' AND jsonb_typeof(p.data->'verifiedAt')='string')
      AND app_private.seo_media_campaign_parent_anchor(p_workspace,p_queue,instruction) IS NULL THEN
      RETURN jsonb_build_object('kind','held','reason','stable_first_verification_anchor_required_choose_owner_pin'); END IF;
    RETURN jsonb_build_object('kind','held','reason','awaiting_exact_verified_parent_or_current_controls');
  END IF;
  slot:=(authority#>>'{resolved,atUtc}')::timestamptz;
  IF slot<statement_timestamp()-interval '5 seconds' OR slot>statement_timestamp()+interval '366 days' THEN
    RETURN jsonb_build_object('kind','held','reason','slot_elapsed_or_outside_horizon'); END IF;
  SELECT * INTO planned FROM app_private.seo_blog_campaign_plan_core(p_workspace,p_queue,(authority->>'contentVersionId')::uuid,
    slot,ARRAY[(authority#>>'{binding,targetId}')::uuid],p_queue);
  SELECT * INTO materialized FROM app_private.seo_blog_campaign_enqueue_core(p_workspace,(authority->>'bindingId')::uuid,p_queue,
    (authority#>>'{binding,targetId}')::uuid,(authority->>'contentItemId')::uuid,(authority->>'contentVersionId')::uuid,
    (authority->>'approvalRequestId')::uuid,(authority->>'approvalDecisionId')::uuid,(authority->>'sourceAttestationId')::uuid,
    'seo-campaign:'||p_queue::text,slot,p_queue);
  result:=jsonb_build_object('kind','materialized','queueIntentId',p_queue,'intentId',p_queue,'jobId',materialized.job_id,
    'contentVersionId',authority->>'contentVersionId','bindingId',authority->>'bindingId','authorizingUserId',authority->>'authorizingUserId',
    'executingActor','worker','scheduledFor',slot,'anchorPublicationId',authority->>'anchorPublicationId',
    'anchorVerifiedAt',authority->>'anchorVerifiedAt','anchorKind',authority->>'anchorKind','timezone',authority#>>'{resolved,timezone}',
    'dailyCap',materialized.daily_cap,'monthlyCap',materialized.monthly_cap);
  PERFORM app_private.seo_media_command(p_workspace,receipt_id,'materialize_campaign_queue',NULL,
    public.digest(jsonb_build_object('queueIntentId',p_queue,'instruction',instruction)::text,'sha256'),result);
  RETURN result;
END $f$;

-- Cross-workspace worker discovery returns IDs only from genuine commands, never arbitrary Article JSON.
CREATE FUNCTION app_private.seo_media_campaign_queue_discoverable(p_workspace uuid,p_queue uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE instruction jsonb; source jsonb; post app.company_content_versions%ROWTYPE; binding jsonb; anchor jsonb; resolved jsonb;
BEGIN
  instruction:=app_private.seo_media_campaign_queue_current(p_workspace,p_queue);
  IF instruction IS NULL THEN RETURN false; END IF;
  source:=app_private.seo_media_campaign_source(p_workspace,(instruction->>'articleId')::uuid,(instruction->>'variantId')::uuid,
    (instruction->>'variantRevisionId')::uuid,true);
  IF source IS NULL OR source#>>'{revision,sha256}' IS DISTINCT FROM instruction->>'variantSha256' THEN RETURN false; END IF;
  SELECT * INTO post FROM app.company_content_versions WHERE workspace_id=p_workspace AND id=(instruction->>'contentVersionId')::uuid;
  IF post.content_body IS DISTINCT FROM app_private.seo_media_campaign_canonical(source->'body')
    OR encode(post.content_sha256,'hex') IS DISTINCT FROM instruction->>'contentSha256'
    OR EXISTS(SELECT 1 FROM app.company_content_versions newer WHERE newer.workspace_id=p_workspace AND newer.content_item_id=post.content_item_id AND newer.version_number>post.version_number)
    OR NOT EXISTS(SELECT 1 FROM app.company_content_approval_requests r JOIN app.company_content_approval_decisions d
      ON d.workspace_id=r.workspace_id AND d.approval_request_id=r.id AND d.decision='approved' AND d.content_sha256=r.content_sha256
      WHERE r.workspace_id=p_workspace AND r.id=(instruction->>'approvalRequestId')::uuid AND d.id=(instruction->>'approvalDecisionId')::uuid
        AND r.content_version_id=post.id AND r.content_sha256=post.content_sha256
        AND NOT EXISTS(SELECT 1 FROM app.company_content_approval_requests later WHERE later.workspace_id=p_workspace AND later.content_version_id=post.id AND later.request_number>r.request_number)) THEN RETURN false; END IF;
  binding:=app_private.seo_blog_campaign_binding(p_workspace,(instruction->>'bindingId')::uuid,instruction#>>'{revision,network}');
  IF binding IS NULL OR (binding-'dailyCap'-'monthlyCap') IS DISTINCT FROM ((instruction->'binding')-'dailyCap'-'monthlyCap') THEN RETURN false; END IF;
  anchor:=app_private.seo_media_campaign_parent_anchor(p_workspace,p_queue,instruction);
  IF anchor IS NULL THEN RETURN false; END IF;
  resolved:=app_private.seo_media_campaign_queue_time((anchor->>'anchorVerifiedAt')::timestamptz,instruction->'dateRule');
  RETURN coalesce(resolved->>'kind'='resolved' AND (resolved->>'atUtc')::timestamptz>=statement_timestamp()-interval '5 seconds'
    AND (resolved->>'atUtc')::timestamptz<=statement_timestamp()+interval '366 days',false);
EXCEPTION WHEN data_exception THEN RETURN false;
END $f$;

CREATE FUNCTION app_private.seo_media_pending_campaign_queues(p_workspace uuid,p_article uuid DEFAULT NULL,p_after uuid DEFAULT NULL,p_limit integer DEFAULT 50)
RETURNS SETOF uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
  IF session_user<>'r72_content_command' OR app_private.current_workspace_id() IS DISTINCT FROM p_workspace
    OR NOT ((app_private.current_actor_kind()='worker' AND app_private.current_user_id() IS NULL)
      OR (app_private.current_actor_kind()='user' AND app_private.can_manage_workspace(app_private.current_user_id(),p_workspace))) THEN
    RAISE EXCEPTION 'Actual content worker required' USING ERRCODE='42501'; END IF;
  IF p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Bounded campaign discovery required' USING ERRCODE='22023'; END IF;
  RETURN QUERY SELECT c.id FROM app.seo_blog_media_commands c WHERE c.workspace_id=p_workspace AND c.action='authorize_campaign_queue'
    AND (p_article IS NULL OR c.result->>'articleId'=p_article::text)
    AND (p_after IS NULL OR c.id>p_after)
    AND NOT EXISTS(SELECT 1 FROM app.seo_blog_media_commands receipt WHERE receipt.workspace_id=c.workspace_id
      AND receipt.id=app_private.seo_media_campaign_queue_receipt_id(c.id) AND receipt.action='materialize_campaign_queue')
    AND app_private.seo_media_campaign_queue_current(p_workspace,c.id) IS NOT NULL
    AND (p_article IS NOT NULL OR app_private.seo_media_campaign_queue_discoverable(p_workspace,c.id)) ORDER BY c.id LIMIT p_limit;
END $f$;

CREATE FUNCTION app_private.seo_blog_campaign_queue_workspaces(p_after uuid DEFAULT NULL,p_limit integer DEFAULT 50)
RETURNS SETOF uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
  IF session_user<>'r72_content_command' OR app_private.current_actor_kind()<>'worker' OR app_private.current_user_id() IS NOT NULL THEN
    RAISE EXCEPTION 'Actual content worker required' USING ERRCODE='42501'; END IF;
  IF p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Bounded campaign discovery required' USING ERRCODE='22023'; END IF;
  RETURN QUERY SELECT DISTINCT c.workspace_id FROM app.seo_blog_media_commands c WHERE c.action='authorize_campaign_queue'
    AND (p_after IS NULL OR c.workspace_id>p_after)
    AND NOT EXISTS(SELECT 1 FROM app.seo_blog_media_commands receipt WHERE receipt.workspace_id=c.workspace_id
      AND receipt.id=app_private.seo_media_campaign_queue_receipt_id(c.id) AND receipt.action='materialize_campaign_queue')
    AND app_private.seo_media_campaign_queue_discoverable(c.workspace_id,c.id) ORDER BY c.workspace_id LIMIT p_limit;
END $f$;

CREATE FUNCTION app_private.seo_media_patch_once(p_definition text,p_needle text,p_replacement text)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $f$
BEGIN
  IF length(p_needle)=0 OR (length(p_definition)-length(replace(p_definition,p_needle,'')))/length(p_needle)<>1 THEN
    RAISE EXCEPTION 'Unexpected010 upstream function anchor: %',left(p_needle,160); END IF;
  RETURN replace(p_definition,p_needle,p_replacement);
END $f$;

CREATE FUNCTION app_private.seo_media_campaign_selected_image(p_workspace uuid,p_post uuid,p_image uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
  RETURN app_private.seo_blog_assert_campaign_content(p_workspace,p_post,true) AND EXISTS(
    SELECT 1 FROM app.company_content_versions post JOIN app.seo_blog_media_owner_authorizations a
      ON a.workspace_id=post.workspace_id AND a.id=(post.metadata->>'mediaUseId')::uuid AND a.use_kind='social_variant'
    WHERE post.workspace_id=p_workspace AND post.id=p_post AND a.canonical_version_id=p_image
      AND app_private.seo_media_social_use_eligible(p_workspace,a.id));
EXCEPTION WHEN data_exception THEN RETURN false;
END $f$;

CREATE FUNCTION app_private.seo_image_verify_preparation(p_workspace uuid,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE attempt app.seo_blog_image_attempts%ROWTYPE; reason text; candidate jsonb; variant jsonb; selected jsonb;
  variants jsonb:='[]'; profiles text[]:=ARRAY[]::text[]; identities uuid[]:=ARRAY[]::uuid[];
BEGIN
  IF app_private.seo_media_private_actor(p_workspace,NULL) IS NOT NULL OR app_private.current_actor_kind()<>'worker' THEN
    RAISE EXCEPTION 'Actual content worker required' USING ERRCODE='42501';
  END IF;
  PERFORM app_private.seo_media_lock_brand(p_workspace);
  reason:=app_private.seo_image_apply_hold(p_workspace,(p_input->>'attemptId')::uuid,(p_input->>'nonce')::uuid,
    p_input->>'leaseOwner',(p_input->>'leaseAttempt')::integer);
  IF reason IS NOT NULL THEN RETURN jsonb_build_object('eligible',false,'hold',reason); END IF;
  SELECT * INTO attempt FROM app.seo_blog_image_attempts WHERE workspace_id=p_workspace AND id=(p_input->>'attemptId')::uuid;
  SELECT app_private.seo_media_asset_json(p_workspace,a.id) INTO candidate FROM app.seo_blog_media_assets a
    JOIN app.seo_blog_blobs b ON b.workspace_id=a.workspace_id AND b.id=a.blob_id
    WHERE a.workspace_id=p_workspace AND a.id=attempt.candidate_asset_id AND a.id=(p_input->>'candidateAssetId')::uuid
      AND a.asset_kind='candidate' AND encode(a.byte_sha256,'hex')=p_input->>'candidateSha256'
      AND a.byte_sha256=b.sha256 AND a.byte_sha256=public.digest(b.bytes,'sha256') AND a.byte_length=octet_length(b.bytes);
  IF candidate IS NULL OR jsonb_typeof(p_input->'variants') IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_input->'variants') NOT BETWEEN 1 AND 3 THEN
    RETURN jsonb_build_object('eligible',false,'hold','candidate_integrity');
  END IF;
  FOR variant IN SELECT v FROM jsonb_array_elements(p_input->'variants') v LOOP
    IF variant->>'profile'=ANY(profiles) OR (variant->>'assetId')::uuid=ANY(identities) THEN
      RETURN jsonb_build_object('eligible',false,'hold','candidate_integrity');
    END IF;
    SELECT app_private.seo_media_asset_json(p_workspace,a.id) INTO selected FROM app.seo_blog_media_assets a
      JOIN app.seo_blog_blobs b ON b.workspace_id=a.workspace_id AND b.id=a.blob_id
      WHERE a.workspace_id=p_workspace AND a.id=(variant->>'assetId')::uuid AND a.asset_kind='variant'
        AND a.source_asset_id=attempt.candidate_asset_id AND encode(a.byte_sha256,'hex')=variant->>'sha256'
        AND a.recipe->>'sourceSha256'=p_input->>'candidateSha256' AND a.recipe->>'profile'=variant->>'profile'
        AND a.byte_sha256=b.sha256 AND a.byte_sha256=public.digest(b.bytes,'sha256') AND a.byte_length=octet_length(b.bytes);
    IF selected IS NULL THEN RETURN jsonb_build_object('eligible',false,'hold','candidate_integrity'); END IF;
    variants:=variants||jsonb_build_array(selected);profiles:=array_append(profiles,variant->>'profile');identities:=array_append(identities,(variant->>'assetId')::uuid);
  END LOOP;
  RETURN jsonb_build_object('eligible',true,'preparation',jsonb_build_object('candidate',candidate,'variants',variants));
END $f$;

-- A function owner receives no legacy write capability. Only its narrow new-ledger capabilities are callable.
DO $acl$
DECLARE fn record;
BEGIN
  FOR fn IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='app_private' AND (p.proname ~ '^seo_(media|image)_' OR p.proname IN ('read_released_seo_media','seo_blog_assert_campaign_content','seo_blog_assert_campaign_revision',
      'seo_blog_materialize_campaign_queue','seo_blog_campaign_queue_workspaces')) LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',fn.signature);
  END LOOP;
END $acl$;
GRANT EXECUTE ON FUNCTION app_private.seo_media_store_candidate(uuid,bytea,uuid,bytea,jsonb,jsonb),
  app_private.seo_media_read_private(uuid,bytea,uuid,text),app_private.seo_media_prepare(uuid,bytea,uuid,uuid,text,text,text,bytea[],jsonb,jsonb),
  app_private.seo_media_reserve_use(uuid,bytea,uuid,uuid,uuid,text,text,jsonb),app_private.seo_media_review_manifest(uuid,bytea,uuid),
  app_private.seo_media_review_asset(uuid,bytea,uuid,text,text,text),
  app_private.seo_media_authorize_social_use(uuid,bytea,jsonb),app_private.seo_media_refresh_social_image_attestation(uuid,bytea,uuid,uuid),
  app_private.seo_media_authorize_campaign_queue(uuid,bytea,jsonb),app_private.seo_media_cancel_campaign_queue(uuid,bytea,uuid,uuid),
  app_private.seo_blog_materialize_campaign_queue(uuid,uuid),app_private.seo_media_pending_campaign_queues(uuid,uuid,uuid,integer),app_private.seo_blog_campaign_queue_workspaces(uuid,integer),
  app_private.seo_media_campaign_queue_receipt(uuid,uuid),
  app_private.seo_media_authorize(uuid,bytea,jsonb),app_private.seo_media_release(uuid,bytea,uuid,uuid,text),
  app_private.seo_media_assert_publication_effect(uuid,bytea,uuid,uuid,text),
  app_private.seo_media_withdraw(uuid,bytea,jsonb),app_private.seo_image_read_source(uuid,bytea,uuid),
  app_private.seo_image_check_intent(uuid,bytea,jsonb),app_private.seo_image_read_policy(),app_private.seo_image_reserve(uuid,jsonb),
  app_private.seo_image_alias_actor(uuid,bytea,uuid),
  app_private.seo_image_record_receipt(uuid,jsonb,bytea,jsonb),app_private.seo_image_check_apply(uuid,jsonb),
  app_private.seo_image_attempt_job(uuid,uuid),app_private.seo_image_verify_preparation(uuid,jsonb) TO r72_content_command;
GRANT EXECUTE ON FUNCTION app_private.read_released_seo_media(uuid,text) TO r72_web;
GRANT EXECUTE ON FUNCTION app_private.seo_blog_assert_campaign_content(uuid,uuid,boolean)
  TO r72_content_adapter,r72_content_command,r72_zernio_social_command,r72_owned_social_definer,r72_public_social_definer;
GRANT EXECUTE ON FUNCTION app_private.seo_blog_assert_campaign_revision(uuid,uuid,uuid,uuid,uuid,text,boolean) TO r72_content_adapter,r72_content_command;
GRANT EXECUTE ON FUNCTION app_private.seo_media_campaign_marker(text,text,jsonb,text),app_private.seo_media_campaign_evidence(uuid,uuid,boolean)
  TO r72_owned_social_definer,r72_public_social_definer;
GRANT EXECUTE ON FUNCTION app_private.seo_media_campaign_family(text,text,jsonb) TO r72_owned_social_definer,r72_public_social_definer;
GRANT EXECUTE ON FUNCTION app_private.seo_media_campaign_pinned_image(uuid,uuid) TO r72_owned_social_definer;
GRANT EXECUTE ON FUNCTION app_private.seo_media_campaign_queue_explicitly_retired(uuid,uuid,uuid,uuid,uuid,timestamptz) TO r72_owned_social_definer;
GRANT EXECUTE ON FUNCTION app_private.seo_media_patch_once(text,text,text),app_private.seo_media_campaign_selected_image(uuid,uuid,uuid)
  TO r72_owned_social_definer,r72_public_social_definer;
GRANT EXECUTE ON FUNCTION app_private.seo_media_campaign_queue_authority(uuid,uuid,uuid,uuid,timestamptz),
  app_private.seo_media_campaign_queue_material(uuid,uuid,uuid,timestamptz),app_private.seo_media_campaign_queue_jit_ready(uuid,uuid,uuid,timestamptz),
  app_private.seo_media_campaign_queue_job_authority(uuid,uuid,uuid,uuid,uuid,timestamptz)
  TO r72_owned_social_definer,r72_public_social_definer;
GRANT EXECUTE ON FUNCTION app_private.seo_media_refresh_social_image_attestation(uuid,bytea,uuid,uuid) TO r72_content_adapter;
-- CREATE TRIGGER checks EXECUTE at creation; the owner-only grants exist for these statements alone.
GRANT EXECUTE ON FUNCTION app_private.seo_image_admission_commit_guard(),app_private.seo_image_policy_guard(),
  app_private.seo_image_attempt_guard() TO r72_owner;
SET LOCAL ROLE r72_owner;
CREATE CONSTRAINT TRIGGER seo_image_atomic_admission AFTER INSERT ON app.seo_blog_image_attempts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_private.seo_image_admission_commit_guard();
CREATE TRIGGER seo_image_policy_immutable_identity BEFORE UPDATE OR DELETE ON app_private.seo_image_operator_policy
  FOR EACH ROW EXECUTE FUNCTION app_private.seo_image_policy_guard();
CREATE TRIGGER seo_image_attempt_immutable_identity BEFORE UPDATE OR DELETE ON app.seo_blog_image_attempts
  FOR EACH ROW EXECUTE FUNCTION app_private.seo_image_attempt_guard();
SET LOCAL ROLE r72_seo_media_definer;
REVOKE EXECUTE ON FUNCTION app_private.seo_image_admission_commit_guard(),app_private.seo_image_policy_guard(),
  app_private.seo_image_attempt_guard() FROM r72_owner;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_seo_media_definer;
SET LOCAL ROLE r72_owned_social_definer;
GRANT EXECUTE ON FUNCTION app_private.seo_blog_assert_article_promotion(uuid,uuid,uuid,text,text,boolean) TO r72_seo_media_definer;
SET LOCAL ROLE r72_owner;

-- Explicit010 source-scoped capabilities, owned by the existing social function owners.
-- DDL-only CREATE grants are revoked in this same atomic block; no runtime schema privilege persists.
GRANT EXECUTE ON FUNCTION app_private.current_workspace_id(),app_private.current_actor_kind(),app_private.current_user_id() TO r72_owned_social_definer;
GRANT CREATE ON SCHEMA app_private TO r72_owned_social_definer;
SET LOCAL ROLE r72_owned_social_definer;
CREATE FUNCTION app_private.seo_blog_campaign_binding(p_workspace uuid,p_binding uuid,p_network text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE result jsonb; matches integer;
BEGIN
  IF app_private.current_workspace_id() IS DISTINCT FROM p_workspace AND NOT(session_user='r72_content_command'
    AND app_private.current_actor_kind()='worker' AND app_private.current_user_id() IS NULL) THEN RETURN NULL; END IF;
  SELECT count(*)::integer,min(candidate::text)::jsonb INTO matches,result FROM (
    SELECT jsonb_build_object('id',b.id,'targetId',target.id,'providerConnectionId',b.provider_connection_id,
      'testProviderConnectionId',target.provider_connection_id,'accountId',b.zernio_account_id,'network',b.network,
      'profileSha256',encode(b.provider_profile_id_sha256,'hex'),'accountSha256',encode(b.provider_account_id_sha256,'hex'),
      'ownershipSha256',encode(connected.receipt_sha256,'hex'),'dailyCap',b.daily_cap,'monthlyCap',b.monthly_cap) candidate
    FROM app.seo_blog_social_bindings b JOIN app.property_predator_zernio_accounts account
      ON account.workspace_id=b.workspace_id AND account.id=b.zernio_account_id AND account.provider_connection_id=b.provider_connection_id
      AND account.network=b.network AND account.provider_profile_id_sha256=b.provider_profile_id_sha256
      AND account.provider_account_id_sha256=b.provider_account_id_sha256 AND account.status='active'
    JOIN app.provider_connections live ON live.workspace_id=b.workspace_id AND live.id=b.provider_connection_id
      AND live.provider_id='zernio' AND live.provider_kind='social' AND live.environment='live' AND live.status='active'
    JOIN LATERAL(SELECT r.receipt_sha256 FROM app.property_predator_zernio_account_webhook_receipts r
      WHERE r.workspace_id=b.workspace_id AND r.provider_connection_id=b.provider_connection_id AND r.environment='live'
        AND r.event_type='account.connected' AND r.network=b.network AND r.provider_profile_id_sha256=b.provider_profile_id_sha256
        AND r.provider_account_id_sha256=b.provider_account_id_sha256 AND NOT EXISTS(
          SELECT 1 FROM app.property_predator_zernio_account_webhook_receipts d WHERE d.workspace_id=r.workspace_id
            AND d.provider_connection_id=r.provider_connection_id AND d.environment=r.environment AND d.network=r.network
            AND d.provider_profile_id_sha256=r.provider_profile_id_sha256 AND d.provider_account_id_sha256=r.provider_account_id_sha256
            AND d.event_type='account.disconnected' AND d.occurred_at>=r.occurred_at)
      ORDER BY r.occurred_at DESC,r.received_at DESC,r.event_id DESC LIMIT 1) connected ON true
    LEFT JOIN app.public_social_targets target ON target.workspace_id=b.workspace_id AND target.network=b.network AND target.environment='test'
      AND target.test_account_ref='test-account:'||b.network||':'||encode(b.provider_account_id_sha256,'hex')
    LEFT JOIN app.provider_connections test ON test.workspace_id=target.workspace_id AND test.id=target.provider_connection_id
      AND test.provider_id='public_social_dark_simulator' AND test.provider_kind='social' AND test.environment='test' AND test.status='active'
      AND test.capabilities @> '["social.publish"]'::jsonb
    WHERE b.workspace_id=p_workspace AND b.id=p_binding AND b.network=p_network AND b.status='active' AND b.daily_cap>0 AND b.monthly_cap>0
      AND (target.id IS NULL OR test.id IS NOT NULL)
  ) candidates;
  IF matches<>1 THEN RETURN NULL; END IF;
  RETURN result;
END $f$;
REVOKE ALL ON FUNCTION app_private.seo_blog_campaign_binding(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.seo_blog_campaign_binding(uuid,uuid,text) TO r72_seo_media_definer;

CREATE FUNCTION app_private.seo_blog_campaign_job_ready(p_workspace uuid,p_job uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
  SELECT EXISTS(SELECT 1 FROM app.property_predator_owned_social_jobs j JOIN app.seo_blog_social_job_caps caps
    ON caps.workspace_id=j.workspace_id AND caps.job_id=j.id JOIN app.company_content_versions v
    ON v.workspace_id=j.workspace_id AND v.id=j.content_version_id
    WHERE j.workspace_id=p_workspace AND j.id=p_job AND j.provider_id='zernio' AND j.profile_id IS NULL
      AND app_private.seo_media_campaign_marker(v.source_system,v.content_mime_type,v.metadata,v.content_body)
      AND j.operation_tag='seo-campaign:'||j.planning_intent_id::text
      AND app_private.seo_media_campaign_queue_job_authority(p_workspace,j.planning_intent_id,j.id,v.id,caps.binding_id,j.scheduled_for))
$f$;
REVOKE ALL ON FUNCTION app_private.seo_blog_campaign_job_ready(uuid,uuid) FROM PUBLIC;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_owned_social_definer;

GRANT CREATE ON SCHEMA app_private TO r72_public_social_definer;
SET LOCAL ROLE r72_public_social_definer;
CREATE FUNCTION app_private.seo_blog_cancel_campaign_target(p_workspace uuid,p_queue uuid,p_actor uuid)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
  -- Private media caller has already stored its genuine-session cancel/superseding owner command.
  INSERT INTO app.public_social_planning_target_cancellations(workspace_id,intent_id,target_id,cancellation_kind,reason_sha256,cancelled_by_user_id,cancelled_request_id)
    SELECT p_workspace,p_queue,target.target_id,'user_cancelled',public.digest('seo-campaign-owner-cancel:'||p_queue::text,'sha256'),p_actor,current_setting('app.request_id')
    FROM app.public_social_planning_intent_targets target WHERE target.workspace_id=p_workspace AND target.intent_id=p_queue
    ON CONFLICT(workspace_id,intent_id,target_id) DO NOTHING;
END $f$;
REVOKE ALL ON FUNCTION app_private.seo_blog_cancel_campaign_target(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.seo_blog_cancel_campaign_target(uuid,uuid,uuid) TO r72_seo_media_definer;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_public_social_definer;

-- Explicitly promoted nested0085 core: the original public USER function is not replaced.
GRANT CREATE ON SCHEMA app_private TO r72_owned_social_definer;
SET LOCAL ROLE r72_owned_social_definer;
DO $campaign_binding_core$
DECLARE definition text;
BEGIN
  IF (SELECT encode(public.digest(prosrc,'sha256'),'hex') FROM pg_proc WHERE oid='app_private.record_zernio_calendar_publish_binding(uuid,uuid,uuid,uuid,text,bytea,bytea,bytea,bytea,timestamptz)'::regprocedure)
    <>'d6cc5fec179002db0b887ee9c0d9e88700d43ccbecea73339298f863386f08da' THEN RAISE EXCEPTION 'Unexpected0085 binding fingerprint'; END IF;
  definition:=pg_get_functiondef('app_private.record_zernio_calendar_publish_binding(uuid,uuid,uuid,uuid,text,bytea,bytea,bytea,bytea,timestamptz)'::regprocedure);
  definition:=app_private.seo_media_patch_once(definition,'record_zernio_calendar_publish_binding(', 'seo_blog_campaign_binding_core(');
  definition:=app_private.seo_media_patch_once(definition,'p_verified_at timestamp with time zone)',
    'p_verified_at timestamp with time zone, p_queue uuid, p_post uuid, p_slot timestamp with time zone)');
  definition:=app_private.seo_media_patch_once(definition,'DECLARE selected_user uuid; existing', 'DECLARE selected_queue jsonb; selected_user uuid; existing');
  definition:=app_private.seo_media_patch_once(definition,E'BEGIN\n  IF session_user',$start$BEGIN
  selected_queue:=app_private.seo_media_campaign_queue_material(p_workspace_id,p_queue,p_post,p_slot);
  IF selected_queue IS NULL
    OR selected_queue#>>'{binding,providerConnectionId}' IS DISTINCT FROM p_provider_connection_id::text
    OR selected_queue#>>'{binding,accountId}' IS DISTINCT FROM p_zernio_account_id::text
    OR selected_queue#>>'{binding,network}' IS DISTINCT FROM p_network
    OR selected_queue#>>'{binding,profileSha256}' IS DISTINCT FROM encode(p_provider_profile_id_sha256,'hex')
    OR selected_queue#>>'{binding,accountSha256}' IS DISTINCT FROM encode(p_provider_account_id_sha256,'hex')
    OR selected_queue#>>'{binding,ownershipSha256}' IS DISTINCT FROM encode(p_ownership_evidence_sha256,'hex')
    OR p_publish_capability_evidence_sha256 IS DISTINCT FROM public.digest(pg_catalog.concat_ws('|',
      'propertypredator.zernio-calendar-publish-capability/v1',p_workspace_id,p_provider_connection_id,p_zernio_account_id,p_network,
      encode(p_provider_profile_id_sha256,'hex'),encode(p_provider_account_id_sha256,'hex'),encode(p_ownership_evidence_sha256,'hex')),'sha256') THEN
    RAISE EXCEPTION 'Exact campaign queue account authority required' USING ERRCODE='42501'; END IF;
  IF session_user$start$);
  definition:=app_private.seo_media_patch_once(definition,'session_user <> ''r72_zernio_social_command''','session_user <> ''r72_content_command''');
  definition:=app_private.seo_media_patch_once(definition,'current_setting(''app.actor_kind'', true) IS DISTINCT FROM ''user''','current_setting(''app.actor_kind'', true) IS DISTINCT FROM ''worker''');
  definition:=app_private.seo_media_patch_once(definition,'current_setting(''app.user_id'', true) !~ ''^[0-9a-f-]{36}$''','coalesce(current_setting(''app.user_id'', true),'''') <> ''''');
  definition:=app_private.seo_media_patch_once(definition,'selected_user := current_setting(''app.user_id'')::uuid;','selected_user := (selected_queue->>''authorizingUserId'')::uuid;');
  EXECUTE definition;
END $campaign_binding_core$;
REVOKE ALL ON FUNCTION app_private.seo_blog_campaign_binding_core(uuid,uuid,uuid,uuid,text,bytea,bytea,bytea,bytea,timestamptz,uuid,uuid,timestamptz) FROM PUBLIC;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_owned_social_definer;

GRANT CREATE ON SCHEMA app_private TO r72_owned_social_definer;
SET LOCAL ROLE r72_owned_social_definer;
DO $campaign_enqueue$
DECLARE definition text;
BEGIN
  IF (SELECT encode(public.digest(prosrc,'sha256'),'hex') FROM pg_proc WHERE oid='app_private.seo_blog_enqueue_zernio_calendar(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,timestamptz)'::regprocedure)
    <>'d227799937290f1940795e10236dbc9f3e64e2d1812226455938b99066174029' THEN RAISE EXCEPTION 'Unexpected132 enqueue fingerprint'; END IF;
  definition:=pg_get_functiondef('app_private.seo_blog_enqueue_zernio_calendar(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,timestamptz)'::regprocedure);
  definition:=app_private.seo_media_patch_once(definition,'  selected_user uuid;',
    '  selected_user uuid; selected_queue jsonb; selected_image jsonb; selected_campaign boolean:=false;');
  definition:=app_private.seo_media_patch_once(definition,'SELECT version.content_body, version.content_sha256, version.metadata INTO selected_version',
    'SELECT version.content_body, version.content_sha256, version.metadata, version.content_mime_type INTO selected_version');
  definition:=app_private.seo_media_patch_once(definition,'  IF length(selected_version.content_body) >',$insert$
  IF app_private.seo_media_campaign_family('relaunch72.seo-blog',selected_version.content_mime_type,selected_version.metadata) THEN
    RAISE EXCEPTION 'Native campaign posts require their genuine-owner queue instruction' USING ERRCODE='42501';
  END IF;
  IF length(selected_version.content_body) >$insert$);
  EXECUTE definition; -- Existing public USER campaign enqueue now fails explicitly; plainSEO gate/body remains.
  definition:=app_private.seo_media_patch_once(definition,'seo_blog_enqueue_zernio_calendar(', 'seo_blog_campaign_enqueue_core(');
  definition:=app_private.seo_media_patch_once(definition,'p_scheduled_for timestamp with time zone)',
    'p_scheduled_for timestamp with time zone, p_queue uuid)');
  definition:=app_private.seo_media_patch_once(definition,E'BEGIN\n  IF session_user',$start$BEGIN
  selected_queue:=app_private.seo_media_campaign_queue_authority(p_workspace_id,p_queue,p_content_version_id,p_binding_id,p_scheduled_for);
  IF selected_queue IS NULL OR p_planning_intent_id IS DISTINCT FROM p_queue
    OR p_planning_target_id::text IS DISTINCT FROM selected_queue#>>'{binding,targetId}'
    OR p_content_item_id::text IS DISTINCT FROM selected_queue->>'contentItemId'
    OR p_approval_request_id::text IS DISTINCT FROM selected_queue->>'approvalRequestId'
    OR p_approval_decision_id::text IS DISTINCT FROM selected_queue->>'approvalDecisionId'
    OR p_source_attestation_id::text IS DISTINCT FROM selected_queue->>'sourceAttestationId'
    OR p_operation_tag IS DISTINCT FROM 'seo-campaign:'||p_queue::text THEN
    RAISE EXCEPTION 'Exact genuine-owner campaign queue authority required' USING ERRCODE='42501'; END IF;
  IF session_user$start$);
  definition:=app_private.seo_media_patch_once(definition,'session_user <> ''r72_zernio_social_command''','session_user <> ''r72_content_command''');
  definition:=app_private.seo_media_patch_once(definition,'current_setting(''app.actor_kind'', true) IS DISTINCT FROM ''user''','current_setting(''app.actor_kind'', true) IS DISTINCT FROM ''worker''');
  definition:=app_private.seo_media_patch_once(definition,'coalesce(current_setting(''app.user_id'', true), '''') !~ ''^[0-9a-f-]{36}$''',
    'coalesce(current_setting(''app.user_id'', true), '''') <> ''''');
  definition:=app_private.seo_media_patch_once(definition,'selected_user := current_setting(''app.user_id'')::uuid;',
    'selected_user := (selected_queue->>''authorizingUserId'')::uuid;');
  definition:=app_private.seo_media_patch_once(definition,'  IF selected_binding.daily_cap < 1 OR selected_binding.monthly_cap < 1 THEN',$insert$
  selected_binding.daily_cap:=(selected_queue#>>'{binding,dailyCap}')::integer;
  selected_binding.monthly_cap:=(selected_queue#>>'{binding,monthlyCap}')::integer;
  IF selected_binding.daily_cap < 1 OR selected_binding.monthly_cap < 1 THEN$insert$);
  definition:=app_private.seo_media_patch_once(definition,'app_private.record_zernio_calendar_publish_binding(', 'app_private.seo_blog_campaign_binding_core(');
  definition:=app_private.seo_media_patch_once(definition,'selected_capability_sha256, selected_account.ownership_evidence_sha256, selected_verified_at);',
    'selected_capability_sha256, selected_account.ownership_evidence_sha256, selected_verified_at,p_queue,p_content_version_id,p_scheduled_for);');
  definition:=app_private.seo_media_patch_once(definition,'    AND attestation.checked_at <= statement_timestamp() AND attestation.expires_at > statement_timestamp()',
    '    AND attestation.id=(selected_queue->>''sourceAttestationId'')::uuid');
  definition:=app_private.seo_media_patch_once(definition,'    RAISE EXCEPTION ''Native campaign posts require their genuine-owner queue instruction'' USING ERRCODE=''42501'';',$insert$
    IF NOT app_private.seo_blog_assert_campaign_content(p_workspace_id,p_content_version_id,true) THEN RAISE EXCEPTION 'Campaign source changed' USING ERRCODE='42501'; END IF;
    selected_campaign:=true;selected_image:=selected_queue->'imageEvidence';
    selected_version.content_body:=app_private.company_content_social_publication_copy(selected_version.content_body);$insert$);
  definition:=app_private.seo_media_patch_once(definition,'  IF length(selected_version.content_body) >',
    E'  IF NOT selected_campaign THEN RAISE EXCEPTION ''Only native campaign queues admitted'' USING ERRCODE=''42501''; END IF;\n  IF length(selected_version.content_body) >');
  definition:=app_private.seo_media_patch_once(definition,'  IF selected_binding.network = ''instagram'' THEN',
    '  IF selected_binding.network = ''instagram'' AND (selected_image IS NULL OR selected_image=''null''::jsonb) THEN');
  definition:=app_private.seo_media_patch_once(definition,'  INSERT INTO app.seo_blog_social_job_caps (workspace_id, job_id, binding_id, daily_cap, monthly_cap)',$insert$
  INSERT INTO app.property_predator_owned_social_job_media(workspace_id,job_id,ordinal,content_item_id,content_version_id,content_sha256,blob_sha256,blob_storage_key,content_mime_type,
    approval_request_id,approval_decision_id,source_attestation_id)
    SELECT p_workspace_id,selected_job_id,m.ordinal,m.content_item_id,m.content_version_id,m.content_sha256,m.blob_sha256,v.blob_storage_key,v.content_mime_type,
      m.approval_request_id,m.approval_decision_id,m.planning_source_attestation_id FROM app.public_social_planning_intent_media m
      JOIN app.company_content_versions v ON v.workspace_id=m.workspace_id AND v.id=m.content_version_id
    WHERE m.workspace_id=p_workspace_id AND m.intent_id=p_planning_intent_id;
  IF (SELECT count(*) FROM app.property_predator_owned_social_job_media WHERE workspace_id=p_workspace_id AND job_id=selected_job_id)
    <>(CASE WHEN selected_image IS NULL OR selected_image='null'::jsonb THEN 0 ELSE 1 END) THEN
    RAISE EXCEPTION 'Exact campaign media evidence missing' USING ERRCODE='42501'; END IF;
  INSERT INTO app.seo_blog_social_job_caps (workspace_id, job_id, binding_id, daily_cap, monthly_cap)$insert$);
  EXECUTE definition;
END $campaign_enqueue$;
REVOKE ALL ON FUNCTION app_private.seo_blog_campaign_enqueue_core(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,timestamptz,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.seo_blog_campaign_enqueue_core(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,timestamptz,uuid) TO r72_seo_media_definer;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_owned_social_definer;

-- 010-QUEUE-OWNER-INTENT-001: exact issued132 planner, named material changes, private source-validated worker core.
-- The public USER gate is retained; DDL privilege exists only through this bounded block and is revoked below.
GRANT CREATE ON SCHEMA app_private TO r72_public_social_definer;
SET LOCAL ROLE r72_public_social_definer;
DO $campaign_plan$
DECLARE definition text; old_gate text;
BEGIN
  IF (SELECT encode(public.digest(prosrc,'sha256'),'hex') FROM pg_proc WHERE oid='app_private.seo_blog_create_promotion_planning_intent(uuid,uuid,uuid,timestamptz,uuid[])'::regprocedure)
    <>'71633057ca6a66dc07c4e9cf92e831921f706cdd01cb6d0838d3e9b06dc103f7' THEN RAISE EXCEPTION 'Unexpected132 SEO planner fingerprint'; END IF;
  definition:=pg_get_functiondef('app_private.seo_blog_create_promotion_planning_intent(uuid,uuid,uuid,timestamptz,uuid[])'::regprocedure);
  definition:=app_private.seo_media_patch_once(definition,'  resolved_targets jsonb; calculated_intent_sha256 bytea;',
    '  resolved_targets jsonb; calculated_intent_sha256 bytea; selected_queue jsonb; selected_image jsonb; resolved_media jsonb:=''[]''::jsonb;');
  definition:=app_private.seo_media_patch_once(definition,'  WITH requested AS (',$insert$
  IF EXISTS(SELECT 1 FROM app.company_content_versions v WHERE v.workspace_id=p_workspace_id AND v.id=p_content_version_id
    AND app_private.seo_media_campaign_marker(v.source_system,v.content_mime_type,v.metadata,v.content_body)) THEN
    IF NOT app_private.seo_blog_assert_campaign_content(p_workspace_id,p_content_version_id,true) THEN RAISE EXCEPTION 'Campaign source changed' USING ERRCODE='42501'; END IF;
    selected_image:=app_private.seo_media_campaign_evidence(p_workspace_id,p_content_version_id,true)->'image';
    IF selected_image IS NOT NULL AND selected_image<>'null'::jsonb THEN
      IF selected_image->>'sourceAttestationId' IS NULL OR (selected_image->>'attestationExpiresAt')::timestamptz<=statement_timestamp() THEN
        RAISE EXCEPTION 'Fresh approved image observation required' USING ERRCODE='42501'; END IF;
      resolved_media:=jsonb_build_array(jsonb_build_object('ordinal',1,'contentItemId',selected_image->>'contentItemId','contentVersionId',selected_image->>'contentVersionId',
        'contentSha256',selected_image->>'contentSha256','blobSha256',selected_image->>'blobSha256','brandSha256',selected_image->>'brandSha256',
        'approvalRequestId',selected_image->>'approvalRequestId','approvalDecisionId',selected_image->>'approvalDecisionId','sourceAttestationId',selected_image->>'sourceAttestationId'));
    END IF;
  END IF;
  WITH requested AS ($insert$);
  definition:=app_private.seo_media_patch_once(definition,'''maxAttempts'', 4, ''targets'', resolved_targets, ''media'', ''[]''::jsonb',
    '''maxAttempts'', 4, ''targets'', resolved_targets, ''media'', resolved_media');
  definition:=app_private.seo_media_patch_once(definition,'  INSERT INTO app.public_social_revalidation_jobs (workspace_id, intent_id, state, attempt_count, max_attempts, next_attempt_at)',$insert$
  IF selected_image IS NOT NULL AND selected_image<>'null'::jsonb THEN
    INSERT INTO app.public_social_planning_intent_media(workspace_id,intent_id,ordinal,content_item_id,content_version_id,content_sha256,blob_sha256,brand_sha256,
      approval_request_id,approval_decision_id,planning_source_attestation_id)
    VALUES(p_workspace_id,p_intent_id,1,(selected_image->>'contentItemId')::uuid,(selected_image->>'contentVersionId')::uuid,
      decode(selected_image->>'contentSha256','hex'),decode(selected_image->>'blobSha256','hex'),decode(selected_image->>'brandSha256','hex'),
      (selected_image->>'approvalRequestId')::uuid,(selected_image->>'approvalDecisionId')::uuid,(selected_image->>'sourceAttestationId')::uuid);
  END IF;
  INSERT INTO app.public_social_revalidation_jobs (workspace_id, intent_id, state, attempt_count, max_attempts, next_attempt_at)$insert$);
  EXECUTE definition;
  definition:=app_private.seo_media_patch_once(definition,'seo_blog_create_promotion_planning_intent(', 'seo_blog_campaign_plan_core(');
  definition:=app_private.seo_media_patch_once(definition,'p_target_ids uuid[])','p_target_ids uuid[], p_queue uuid)');
  old_gate:=substring(definition FROM position('  IF session_user' IN definition) FOR position('  -- One deterministic container' IN definition)-position('  IF session_user' IN definition));
  definition:=app_private.seo_media_patch_once(definition,old_gate,$gate$  selected_queue:=app_private.seo_media_campaign_queue_material(p_workspace_id,p_queue,p_content_version_id,p_desired_for);
  IF session_user<>'r72_content_command' OR current_setting('transaction_isolation')<>'serializable'
    OR selected_queue IS NULL OR p_intent_id IS DISTINCT FROM p_queue
    OR p_target_ids IS DISTINCT FROM ARRAY[(selected_queue#>>'{binding,targetId}')::uuid] THEN
    RAISE EXCEPTION 'Exact genuine-owner campaign queue authority required' USING ERRCODE='42501'; END IF;
  actor_id:=(selected_queue->>'authorizingUserId')::uuid;request_id:=current_setting('app.request_id');target_count:=1;distinct_target_count:=1;

$gate$);
  definition:=app_private.seo_media_patch_once(definition,'      AND attestation.checked_at <= statement_timestamp() AND attestation.expires_at > statement_timestamp()',
    '      AND attestation.id=(selected_queue->>''sourceAttestationId'')::uuid');
  definition:=app_private.seo_media_patch_once(definition,'selected_image:=app_private.seo_media_campaign_evidence(p_workspace_id,p_content_version_id,true)->''image'';',
    'selected_image:=selected_queue->''imageEvidence'';');
  definition:=app_private.seo_media_patch_once(definition,'IF selected_image->>''sourceAttestationId'' IS NULL OR (selected_image->>''attestationExpiresAt'')::timestamptz<=statement_timestamp() THEN',
    'IF selected_image->>''sourceAttestationId'' IS NULL THEN');
  EXECUTE definition;
END $campaign_plan$;
REVOKE ALL ON FUNCTION app_private.seo_blog_campaign_plan_core(uuid,uuid,uuid,timestamptz,uuid[],uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.seo_blog_campaign_plan_core(uuid,uuid,uuid,timestamptz,uuid[],uuid) TO r72_seo_media_definer;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_public_social_definer;

-- Preserve every old rail predicate; only the new SEO campaign source gets publication-text and selected-image alternatives.
GRANT CREATE ON SCHEMA app_private TO r72_owned_social_definer;
SET LOCAL ROLE r72_owned_social_definer;
DO $campaign_effect$
DECLARE definition text; campaign text:='app_private.seo_blog_campaign_job_ready(job.workspace_id,job.id)';
BEGIN
  IF (SELECT encode(public.digest(prosrc,'sha256'),'hex') FROM pg_proc WHERE oid='app_private.owned_social_job_effect_ready_v2(uuid,uuid)'::regprocedure)
    <>'2f6a7552fcfbb9d34ed2954683239c1a4b5d1967bf9e459e4e8af39504f00456' THEN RAISE EXCEPTION 'Unexpected0080 effect fingerprint'; END IF;
  definition:=pg_get_functiondef('app_private.owned_social_job_effect_ready_v2(uuid,uuid)'::regprocedure);
  definition:=app_private.seo_media_patch_once(definition,'version.content_body = job.text_body',
    '(version.content_body = job.text_body OR ('||campaign||' AND app_private.company_content_social_publication_copy(version.content_body)=job.text_body))');
  definition:=app_private.seo_media_patch_once(definition,'public.digest(version.content_body, ''sha256'') = job.text_sha256',
    '(public.digest(version.content_body, ''sha256'') = job.text_sha256 OR ('||campaign||' AND public.digest(app_private.company_content_social_publication_copy(version.content_body),''sha256'')=job.text_sha256))');
  definition:=app_private.seo_media_patch_once(definition,E'                AND newer_media.version_number > media_version.version_number\n            )',
    E'                AND newer_media.version_number > media_version.version_number\n            ) AND NOT ('||campaign||' AND app_private.seo_media_campaign_selected_image(job.workspace_id,version.id,media_version.id))');
  EXECUTE definition;
  IF (SELECT encode(public.digest(prosrc,'sha256'),'hex') FROM pg_proc WHERE oid='app_private.seo_blog_zernio_job_effect_ready(uuid,uuid)'::regprocedure)
    <>'508b2baa278bc88124c2403eb5da5a2c32986eabebbf660b006983e86767eff4' THEN RAISE EXCEPTION 'Unexpected132 SEO effect fingerprint'; END IF;
  definition:=pg_get_functiondef('app_private.seo_blog_zernio_job_effect_ready(uuid,uuid)'::regprocedure);
  definition:=app_private.seo_media_patch_once(definition,'        AND version.source_system = ''relaunch72.seo-blog''',
    E'        AND version.source_system = ''relaunch72.seo-blog''\n        AND (NOT app_private.seo_media_campaign_family(version.source_system,version.content_mime_type,version.metadata) OR app_private.seo_blog_campaign_job_ready(job.workspace_id,job.id))');
  EXECUTE definition;
END $campaign_effect$;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_owned_social_definer;

GRANT CREATE ON SCHEMA app_private TO r72_public_social_definer;
SET LOCAL ROLE r72_public_social_definer;
DO $campaign_jit$
DECLARE definition text;
BEGIN
  IF (SELECT encode(public.digest(prosrc,'sha256'),'hex') FROM pg_proc WHERE oid='app_private.seo_blog_attest_due_promotions(uuid)'::regprocedure)
    <>'c2dc1971e25344c0cf042f8a526cc04dc25f6436e8a290fa6b6054e2b2fd1d0e' THEN RAISE EXCEPTION 'Unexpected133 JIT fingerprint'; END IF;
  definition:=pg_get_functiondef('app_private.seo_blog_attest_due_promotions(uuid)'::regprocedure);
  definition:=app_private.seo_media_patch_once(definition,'      version.metadata, version.version_number',
    '      version.metadata, version.version_number, version.content_mime_type');
  definition:=app_private.seo_media_patch_once(definition,'    parent_ok := app_private.seo_blog_assert_article_promotion(',$insert$
    parent_ok := (NOT app_private.seo_media_campaign_family('relaunch72.seo-blog',selected.content_mime_type,selected.metadata)
      OR (app_private.seo_blog_assert_campaign_content(p_workspace_id,selected.content_version_id,true)
        AND app_private.seo_media_campaign_queue_jit_ready(p_workspace_id,selected.intent_id,selected.content_version_id,selected.desired_for)))
      AND app_private.seo_blog_assert_article_promotion($insert$);
  definition:=app_private.seo_media_patch_once(definition,'    UPDATE app.public_social_revalidation_jobs SET state = ''verified'', current_proof_id = proof_id,',$insert$
    IF selected.metadata->>'campaignSchema'='relaunch72.seo-campaign/v1' THEN
      INSERT INTO app.public_social_revalidation_proof_media(workspace_id,proof_id,intent_id,ordinal,content_item_id,content_version_id,content_sha256,
        blob_sha256,brand_sha256,source_resource_version_id,source_approval_id,source_approved_at,source_catalog_sha256,checked_at,expires_at)
        SELECT p_workspace_id,proof_id,selected.intent_id,m.ordinal,m.content_item_id,m.content_version_id,m.content_sha256,m.blob_sha256,m.brand_sha256,
          m.content_version_id,m.approval_decision_id,least(d.decided_at,statement_timestamp()),catalog,statement_timestamp(),statement_timestamp()+interval '15 minutes'
        FROM app.public_social_planning_intent_media m JOIN app.company_content_approval_decisions d
          ON d.workspace_id=m.workspace_id AND d.id=m.approval_decision_id
        WHERE m.workspace_id=p_workspace_id AND m.intent_id=selected.intent_id;
    END IF;
    UPDATE app.public_social_revalidation_jobs SET state = 'verified', current_proof_id = proof_id,$insert$);
  EXECUTE definition;
END $campaign_jit$;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_public_social_definer;

GRANT CREATE ON SCHEMA app_private TO r72_owned_social_definer;
SET LOCAL ROLE r72_owned_social_definer;
DO $campaign_loader$
DECLARE definition text;
BEGIN
  definition:=pg_get_functiondef('app_private.load_zernio_calendar_job(uuid,uuid,bigint,bytea)'::regprocedure);
  definition:=app_private.seo_media_patch_once(definition,'SELECT jsonb_agg(jsonb_build_object(',$insert$SELECT jsonb_agg(CASE WHEN EXISTS(
        SELECT 1 FROM app.company_content_versions post JOIN app.seo_blog_social_job_caps caps ON caps.workspace_id=post.workspace_id AND caps.job_id=job.id
        WHERE post.workspace_id=job.workspace_id AND post.id=job.content_version_id AND job.provider_id='zernio' AND job.profile_id IS NULL
          AND app_private.seo_media_campaign_family(post.source_system,post.content_mime_type,post.metadata))
        THEN app_private.seo_media_campaign_pinned_image(job.workspace_id,job.content_version_id) ELSE jsonb_build_object($insert$);
  definition:=app_private.seo_media_patch_once(definition,'      ) ORDER BY media_row.ordinal)','      ) END ORDER BY media_row.ordinal)');
  definition:=app_private.seo_media_patch_once(definition,'        AND image IS NOT NULL',$insert$        AND image IS NOT NULL
        AND NOT app_private.seo_media_campaign_family(version.source_system,version.content_mime_type,version.metadata)$insert$);
  EXECUTE definition;
END $campaign_loader$;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_owned_social_definer;

-- Deliberately separate from materialization:133's terminal-state trigger takes a source advisory lock.
-- The caller must COMMIT this job-only transaction before acquiring any materialization brand/article lock.
GRANT CREATE ON SCHEMA app_private TO r72_owned_social_definer;
SET LOCAL ROLE r72_owned_social_definer;
CREATE FUNCTION app_private.seo_blog_retire_cancelled_campaign_jobs(p_workspace uuid)
RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE selected record; retired integer:=0;
BEGIN
  IF session_user<>'r72_content_command' OR app_private.current_workspace_id() IS DISTINCT FROM p_workspace
    OR app_private.current_actor_kind()<>'worker' OR app_private.current_user_id() IS NOT NULL THEN
    RAISE EXCEPTION 'Actual content worker required' USING ERRCODE='42501'; END IF;
  FOR selected IN SELECT j.id FROM app.property_predator_owned_social_jobs j
    JOIN app.seo_blog_social_job_caps caps ON caps.workspace_id=j.workspace_id AND caps.job_id=j.id
    JOIN app.company_content_versions v ON v.workspace_id=j.workspace_id AND v.id=j.content_version_id
    WHERE j.workspace_id=p_workspace AND j.provider_id='zernio' AND j.profile_id IS NULL AND j.state='needs_attention'
      AND j.calling_at IS NULL AND j.provider_external_id IS NULL AND j.reconcile_count=0
      AND j.lease_attempt_kind IS DISTINCT FROM 'reconcile'
      AND j.operation_tag='seo-campaign:'||j.planning_intent_id::text
      AND app_private.seo_media_campaign_marker(v.source_system,v.content_mime_type,v.metadata,v.content_body)
      AND NOT EXISTS(SELECT 1 FROM app.property_predator_owned_social_receipts r WHERE r.workspace_id=j.workspace_id AND r.job_id=j.id)
      AND app_private.seo_media_campaign_queue_explicitly_retired(p_workspace,j.planning_intent_id,j.id,v.id,caps.binding_id,j.scheduled_for)
    ORDER BY j.id FOR UPDATE OF j SKIP LOCKED LIMIT 20
  LOOP
    UPDATE app.property_predator_owned_social_jobs SET state='cancelled',lease_attempt_kind=NULL,lease_expires_at=NULL,next_reconcile_at=NULL,
      settled_at=statement_timestamp(),updated_at=statement_timestamp() WHERE workspace_id=p_workspace AND id=selected.id;
    DELETE FROM app.property_predator_owned_social_job_leases WHERE workspace_id=p_workspace AND job_id=selected.id;
    retired:=retired+1;
  END LOOP;
  RETURN retired;
END $f$;
REVOKE ALL ON FUNCTION app_private.seo_blog_retire_cancelled_campaign_jobs(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.seo_blog_retire_cancelled_campaign_jobs(uuid) TO r72_content_command;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_owned_social_definer;

DO $media_final_acl$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['r72_seo_media_definer','r72_owned_social_definer','r72_public_social_definer'] LOOP
    IF has_schema_privilege(role_name,'app_private','CREATE') THEN RAISE EXCEPTION '010 DDL schema privilege persisted: %',role_name; END IF;
  END LOOP;
  FOREACH role_name IN ARRAY ARRAY['r72_content_command','r72_content_adapter','r72_web','r72_owned_social_worker_command','r72_zernio_social_command'] LOOP
    IF has_function_privilege(role_name,'app_private.seo_blog_campaign_plan_core(uuid,uuid,uuid,timestamptz,uuid[],uuid)','EXECUTE')
      OR has_function_privilege(role_name,'app_private.seo_blog_campaign_enqueue_core(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,timestamptz,uuid)','EXECUTE')
      OR has_function_privilege(role_name,'app_private.seo_blog_campaign_binding_core(uuid,uuid,uuid,uuid,text,bytea,bytea,bytea,bytea,timestamptz,uuid,uuid,timestamptz)','EXECUTE') THEN
      RAISE EXCEPTION '010 private mature core crossed LOGIN boundary: %',role_name; END IF;
  END LOOP;
END $media_final_acl$;
