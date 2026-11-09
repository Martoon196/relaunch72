-- 0143 Creative Studio library: owner-only, append-only artwork, storyboard and video versions, exact approvals and
-- draft campaign hand-offs for any programme brand. Additive only; 0001-0142 are unchanged.
-- No provider call, paid-generation admission, scheduler, publishing, outreach or ad-spend capability.
-- Rendered bytes live in the existing workspace-scoped app.seo_blog_blobs.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

DO $role$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='r72_creative_studio_definer') THEN
    CREATE ROLE r72_creative_studio_definer NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='r72_creative_studio_definer' AND NOT rolcanlogin AND NOT rolinherit
      AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls)
    OR EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname='r72_creative_studio_definer') THEN
    RAISE EXCEPTION 'Unsafe creative studio function-owner attributes' USING ERRCODE='42501';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles p ON p.oid=m.roleid JOIN pg_roles c ON c.oid=m.member
    WHERE p.rolname='r72_creative_studio_definer' AND c.rolname NOT IN ('r72_owner',current_user)) THEN
    RAISE EXCEPTION 'Runtime membership in creative studio function owner denied' USING ERRCODE='42501';
  END IF;
  GRANT r72_creative_studio_definer TO r72_owner;
END $role$;

SET LOCAL ROLE r72_owner;

CREATE TABLE app.creative_studio_kits(
  workspace_id uuid NOT NULL REFERENCES app.seo_blog_brands(workspace_id), version integer NOT NULL CHECK(version>0),
  sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'), logo_blob_id uuid,
  data jsonb NOT NULL CHECK(jsonb_typeof(data)='object' AND octet_length(data::text)<=65536),
  created_by uuid NOT NULL REFERENCES app.users(id), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,version), FOREIGN KEY(workspace_id,logo_blob_id) REFERENCES app.seo_blog_blobs(workspace_id,id)
);
CREATE TABLE app.creative_studio_sets(
  workspace_id uuid NOT NULL REFERENCES app.seo_blog_brands(workspace_id), id uuid NOT NULL,
  data jsonb NOT NULL CHECK(jsonb_typeof(data)='object' AND octet_length(data::text)<=65536),
  created_by uuid NOT NULL REFERENCES app.users(id), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,id)
);
CREATE TABLE app.creative_studio_versions(
  workspace_id uuid NOT NULL, id uuid NOT NULL, set_id uuid NOT NULL,
  variant_key text NOT NULL CHECK(variant_key ~ '^c[1-9]:((storyboard|video)_(square|portrait|vertical|landscape):0|(square|portrait|vertical|landscape|article):[0-9])$'),
  number integer NOT NULL CHECK(number>0), parent_id uuid, blob_id uuid NOT NULL,
  render_sha256 text NOT NULL CHECK(render_sha256 ~ '^[0-9a-f]{64}$'),
  profile_version integer NOT NULL CHECK(profile_version>0), facts_sha text NOT NULL, kit_version integer NOT NULL CHECK(kit_version>=0),
  blocking boolean NOT NULL, figures_flagged boolean NOT NULL,
  data jsonb NOT NULL CHECK(jsonb_typeof(data)='object' AND octet_length(data::text)<=262144),
  created_by uuid NOT NULL REFERENCES app.users(id), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,set_id,variant_key,number),
  FOREIGN KEY(workspace_id,set_id) REFERENCES app.creative_studio_sets(workspace_id,id),
  FOREIGN KEY(workspace_id,blob_id) REFERENCES app.seo_blog_blobs(workspace_id,id),
  FOREIGN KEY(workspace_id,parent_id) REFERENCES app.creative_studio_versions(workspace_id,id),
  CHECK((number=1)=(parent_id IS NULL))
);
CREATE TABLE app.creative_studio_approvals(
  workspace_id uuid NOT NULL, id uuid NOT NULL, version_id uuid NOT NULL,
  render_sha256 text NOT NULL CHECK(render_sha256 ~ '^[0-9a-f]{64}$'),
  profile_version integer NOT NULL, facts_sha text NOT NULL, kit_version integer NOT NULL, figures_confirmed boolean NOT NULL,
  data jsonb NOT NULL CHECK(jsonb_typeof(data)='object' AND octet_length(data::text)<=16384),
  approved_by uuid NOT NULL REFERENCES app.users(id), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,version_id),
  FOREIGN KEY(workspace_id,version_id) REFERENCES app.creative_studio_versions(workspace_id,id)
);
CREATE TABLE app.creative_studio_handoffs(
  workspace_id uuid NOT NULL, id uuid NOT NULL, version_id uuid NOT NULL, approval_id uuid NOT NULL,
  target jsonb NOT NULL CHECK(jsonb_typeof(target)='object' AND octet_length(target::text)<=1024),
  data jsonb NOT NULL CHECK(jsonb_typeof(data)='object' AND octet_length(data::text)<=16384),
  created_by uuid NOT NULL REFERENCES app.users(id), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,id),
  FOREIGN KEY(workspace_id,version_id) REFERENCES app.creative_studio_versions(workspace_id,id),
  FOREIGN KEY(workspace_id,approval_id) REFERENCES app.creative_studio_approvals(workspace_id,id)
);
CREATE TABLE app.creative_studio_commands(
  workspace_id uuid NOT NULL REFERENCES app.seo_blog_brands(workspace_id), id uuid NOT NULL,
  action text NOT NULL CHECK(action IN ('kit_save','set_create','versions_append','approve','handoff','finding_record','pattern_share','pattern_withdraw')),
  input_sha256 text NOT NULL CHECK(input_sha256 ~ '^[0-9a-f]{64}$'), result_id text NOT NULL CHECK(length(result_id) BETWEEN 1 AND 80),
  actor_user_id uuid NOT NULL REFERENCES app.users(id), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,id)
);

DO $tables$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['creative_studio_kits','creative_studio_sets','creative_studio_versions','creative_studio_approvals',
    'creative_studio_handoffs','creative_studio_commands'] LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON app.%I FROM PUBLIC,r72_content_command,r72_web,r72_worker',t);
    EXECUTE format('CREATE POLICY %I ON app.%I FOR ALL TO r72_owner USING(true) WITH CHECK(true)',t||'_owner',t);
    EXECUTE format('CREATE POLICY %I ON app.%I FOR ALL TO r72_creative_studio_definer USING(workspace_id=app_private.current_workspace_id()) WITH CHECK(workspace_id=app_private.current_workspace_id())',t||'_scope',t);
    EXECUTE format('GRANT SELECT,INSERT ON app.%I TO r72_creative_studio_definer',t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON app.%I FOR EACH ROW EXECUTE FUNCTION app_private.seo_blog_append_only()',t||'_immutable',t);
    INSERT INTO app_private.workspace_table_registry(schema_name,table_name,workspace_column) VALUES('app',t,'workspace_id');
  END LOOP;
END $tables$;

GRANT USAGE ON SCHEMA app,app_private TO r72_creative_studio_definer;
GRANT EXECUTE ON FUNCTION app_private.current_workspace_id(),app_private.current_user_id(),app_private.current_actor_kind(),
  app_private.seo_blog_brand(uuid),app_private.seo_media_owner(uuid,bytea),app_private.seo_creator_profile(uuid)
  TO r72_creative_studio_definer;
GRANT SELECT ON app.seo_blog_blobs,app.seo_blog_articles,app.seo_blog_creator_campaigns TO r72_creative_studio_definer;
GRANT SELECT ON app.seo_blog_media_assets TO r72_creative_studio_definer;
CREATE POLICY seo_blog_media_assets_creative_read ON app.seo_blog_media_assets FOR SELECT TO r72_creative_studio_definer USING(workspace_id=app_private.current_workspace_id());
CREATE POLICY seo_blog_blobs_creative_read ON app.seo_blog_blobs FOR SELECT TO r72_creative_studio_definer USING(workspace_id=app_private.current_workspace_id());
CREATE POLICY seo_blog_articles_creative_read ON app.seo_blog_articles FOR SELECT TO r72_creative_studio_definer USING(workspace_id=app_private.current_workspace_id());
CREATE POLICY seo_blog_creator_campaigns_creative_read ON app.seo_blog_creator_campaigns FOR SELECT TO r72_creative_studio_definer USING(workspace_id=app_private.current_workspace_id());
GRANT CREATE ON SCHEMA app_private TO r72_creative_studio_definer;
SET LOCAL ROLE r72_creative_studio_definer;

-- Image versions keep their original key; storyboards and videos are separate lineages per concept and format.
CREATE FUNCTION app_private.creative_studio_variant_key(p_v jsonb)
RETURNS text LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
  SELECT (p_v->>'conceptKey')||':'||CASE WHEN coalesce(p_v->>'media','image')='image' THEN '' ELSE (p_v->>'media')||'_' END||(p_v->>'placement')||':'||(p_v->>'card')
$f$;

-- Insert one artwork version after independently rechecking brand context, lineage and stored bytes.
CREATE FUNCTION app_private.creative_studio_insert_version(p_workspace uuid,p_actor uuid,p_set uuid,p_v jsonb,p_profile jsonb,p_kit integer)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE k text; expected integer; parent uuid; media text:=coalesce(p_v->>'media','image'); source app.creative_studio_versions;
BEGIN
  IF media NOT IN ('image','storyboard','video') THEN RAISE EXCEPTION 'Invalid creative media' USING ERRCODE='22023'; END IF;
  IF p_v->>'brandId' IS DISTINCT FROM p_workspace::text OR p_v->>'setId' IS DISTINCT FROM p_set::text OR p_v->>'createdBy' IS DISTINCT FROM p_actor::text
    OR coalesce(p_v->>'id','') !~ '^[0-9a-f-]{36}$' OR jsonb_typeof(p_v->'issues') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Invalid creative version' USING ERRCODE='22023';
  END IF;
  IF p_profile IS NULL OR p_v#>>'{context,profileVersion}' IS DISTINCT FROM p_profile->>'version'
    OR p_v#>>'{context,factsSha}' IS DISTINCT FROM p_profile->>'factsSha' OR (p_v#>>'{context,kitVersion}')::integer IS DISTINCT FROM p_kit THEN
    RAISE EXCEPTION 'Brand facts or the creative kit changed while rendering. Try again.' USING ERRCODE='55000';
  END IF;
  k:=app_private.creative_studio_variant_key(p_v);
  SELECT coalesce(max(number),0)+1 INTO expected FROM app.creative_studio_versions WHERE workspace_id=p_workspace AND set_id=p_set AND variant_key=k;
  SELECT id INTO parent FROM app.creative_studio_versions WHERE workspace_id=p_workspace AND set_id=p_set AND variant_key=k AND number=expected-1;
  IF (p_v->>'number')::integer IS DISTINCT FROM expected OR (p_v->>'parentVersionId') IS DISTINCT FROM parent::text THEN
    RAISE EXCEPTION 'This artwork changed while you were editing. Refresh and review the current version.' USING ERRCODE='40001';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM app.seo_blog_blobs b WHERE b.workspace_id=p_workspace AND b.id=(p_v#>>'{render,blobId}')::uuid
    AND encode(b.sha256,'hex')=p_v#>>'{render,sha256}' AND b.mime=ANY(CASE WHEN media='video' THEN ARRAY['video/mp4','video/webm'] ELSE ARRAY['image/jpeg'] END)) THEN
    RAISE EXCEPTION 'Rendered artwork bytes are missing or do not match' USING ERRCODE='42501';
  END IF;
  -- A video is always rendered from one exact storyboard version of the same concept and format.
  IF media='video' THEN
    SELECT * INTO source FROM app.creative_studio_versions WHERE workspace_id=p_workspace AND id=(p_v#>>'{variant,storyboard,sourceStoryboardVersionId}')::uuid;
    IF source.id IS NULL OR source.set_id<>p_set OR source.variant_key IS DISTINCT FROM (p_v->>'conceptKey')||':storyboard_'||(p_v->>'placement')||':0'
      OR source.data->>'specSha256' IS DISTINCT FROM p_v#>>'{variant,storyboard,sourceStoryboardSpecSha256}' THEN
      RAISE EXCEPTION 'A video must be rendered from an exact storyboard version of the same concept and format' USING ERRCODE='55000';
    END IF;
  END IF;
  INSERT INTO app.creative_studio_versions(workspace_id,id,set_id,variant_key,number,parent_id,blob_id,render_sha256,profile_version,facts_sha,kit_version,blocking,figures_flagged,data,created_by)
    VALUES(p_workspace,(p_v->>'id')::uuid,p_set,k,expected,parent,(p_v#>>'{render,blobId}')::uuid,p_v#>>'{render,sha256}',
      (p_v#>>'{context,profileVersion}')::integer,p_v#>>'{context,factsSha}',p_kit,
      EXISTS(SELECT 1 FROM jsonb_array_elements(p_v->'issues') i WHERE i->'blocking'='true'::jsonb),
      EXISTS(SELECT 1 FROM jsonb_array_elements(p_v->'issues') i WHERE i->>'code'='unsupported_figure'),p_v,p_actor);
END $f$;

-- The one owner command boundary. Reads and writes require a genuine current managing owner session.
CREATE FUNCTION app_private.creative_studio_command(p_workspace uuid,p_session bytea,p_action text,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; prof jsonb; kit_v integer; cmd app.creative_studio_commands; rid text; v jsonb; keys text[]:='{}'; k text;
  ver app.creative_studio_versions; appr app.creative_studio_approvals; v_set uuid; a jsonb;
BEGIN
  actor:=app_private.seo_media_owner(p_workspace,p_session);
  IF app_private.seo_blog_brand(p_workspace) IS NULL THEN RAISE EXCEPTION 'Brand unavailable' USING ERRCODE='42501'; END IF;
  IF p_input IS NULL OR jsonb_typeof(p_input)<>'object' OR octet_length(p_input::text)>4194304 THEN RAISE EXCEPTION 'Invalid creative command' USING ERRCODE='22023'; END IF;
  IF p_action='kit_latest' THEN RETURN (SELECT data FROM app.creative_studio_kits WHERE workspace_id=p_workspace ORDER BY version DESC LIMIT 1); END IF;
  IF p_action='set_list' THEN
    RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('set',s.data,
      'versionCount',(SELECT count(*) FROM app.creative_studio_versions v WHERE v.workspace_id=s.workspace_id AND v.set_id=s.id),
      'approvedCount',(SELECT count(*) FROM app.creative_studio_approvals x JOIN app.creative_studio_versions v ON v.workspace_id=x.workspace_id AND v.id=x.version_id
        WHERE x.workspace_id=s.workspace_id AND v.set_id=s.id)) ORDER BY s.created_at DESC,s.id)
      FROM app.creative_studio_sets s WHERE s.workspace_id=p_workspace),'[]'::jsonb);
  END IF;
  IF p_action='set_get' THEN
    v_set:=(p_input->>'setId')::uuid;
    IF NOT EXISTS(SELECT 1 FROM app.creative_studio_sets WHERE workspace_id=p_workspace AND id=v_set) THEN RETURN NULL; END IF;
    RETURN jsonb_build_object('set',(SELECT data FROM app.creative_studio_sets WHERE workspace_id=p_workspace AND id=v_set),
      'versions',coalesce((SELECT jsonb_agg(data ORDER BY variant_key,number) FROM app.creative_studio_versions WHERE workspace_id=p_workspace AND set_id=v_set),'[]'::jsonb),
      'approvals',coalesce((SELECT jsonb_agg(x.data ORDER BY x.created_at) FROM app.creative_studio_approvals x JOIN app.creative_studio_versions v ON v.workspace_id=x.workspace_id AND v.id=x.version_id WHERE x.workspace_id=p_workspace AND v.set_id=v_set),'[]'::jsonb),
      'handoffs',coalesce((SELECT jsonb_agg(h.data ORDER BY h.created_at) FROM app.creative_studio_handoffs h JOIN app.creative_studio_versions v ON v.workspace_id=h.workspace_id AND v.id=h.version_id WHERE h.workspace_id=p_workspace AND v.set_id=v_set),'[]'::jsonb));
  END IF;
  IF p_action='version_get' THEN
    SELECT * INTO ver FROM app.creative_studio_versions WHERE workspace_id=p_workspace AND id=(p_input->>'versionId')::uuid;
    IF ver.id IS NULL THEN RETURN NULL; END IF;
    RETURN jsonb_build_object('version',ver.data,
      'head',NOT EXISTS(SELECT 1 FROM app.creative_studio_versions WHERE workspace_id=p_workspace AND set_id=ver.set_id AND variant_key=ver.variant_key AND number>ver.number),
      'approval',(SELECT data FROM app.creative_studio_approvals WHERE workspace_id=p_workspace AND version_id=ver.id));
  END IF;
  IF p_action='command_get' THEN
    SELECT * INTO cmd FROM app.creative_studio_commands WHERE workspace_id=p_workspace AND id=(p_input->>'commandId')::uuid;
    IF cmd.id IS NULL THEN RETURN NULL; END IF;
    IF cmd.input_sha256 IS DISTINCT FROM p_input->>'inputSha' THEN RAISE EXCEPTION 'This request was already used for different content' USING ERRCODE='40001'; END IF;
    RETURN jsonb_build_object('replayed',true,'id',cmd.result_id);
  END IF;
  IF p_action NOT IN ('kit_save','set_create','versions_append','approve','handoff') THEN RAISE EXCEPTION 'Unknown creative command' USING ERRCODE='22023'; END IF;
  -- Serialise every write for this brand: lineage, approvals and command replay cannot race.
  PERFORM pg_advisory_xact_lock(hashtextextended('r72-creative-studio:'||p_workspace::text,0));
  SELECT * INTO cmd FROM app.creative_studio_commands WHERE workspace_id=p_workspace AND id=(p_input->>'commandId')::uuid;
  IF cmd.id IS NOT NULL THEN
    IF cmd.input_sha256 IS DISTINCT FROM p_input->>'inputSha' OR cmd.action<>p_action THEN RAISE EXCEPTION 'This request was already used for different content' USING ERRCODE='40001'; END IF;
    RETURN jsonb_build_object('replayed',true,'id',cmd.result_id);
  END IF;
  IF coalesce(p_input->>'commandId','') !~ '^[0-9a-f-]{36}$' OR coalesce(p_input->>'inputSha','') !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'Invalid creative command' USING ERRCODE='22023'; END IF;
  prof:=app_private.seo_creator_profile(p_workspace);
  SELECT coalesce(max(version),0) INTO kit_v FROM app.creative_studio_kits WHERE workspace_id=p_workspace;

  IF p_action='kit_save' THEN
    v:=p_input->'kit';
    IF v->>'brandId' IS DISTINCT FROM p_workspace::text OR (v->>'version')::integer IS DISTINCT FROM kit_v+1 OR v->>'createdBy' IS DISTINCT FROM actor::text
      OR coalesce(v->>'sha256','') !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'The creative kit changed. Refresh and try again.' USING ERRCODE='40001'; END IF;
    IF jsonb_typeof(v->'logo')='object' AND NOT EXISTS(SELECT 1 FROM app.seo_blog_blobs b WHERE b.workspace_id=p_workspace AND b.id=(v#>>'{logo,blobId}')::uuid
      AND encode(b.sha256,'hex')=v#>>'{logo,sha256}') THEN RAISE EXCEPTION 'Logo bytes are missing or do not match' USING ERRCODE='42501'; END IF;
    INSERT INTO app.creative_studio_kits(workspace_id,version,sha256,logo_blob_id,data,created_by)
      VALUES(p_workspace,kit_v+1,v->>'sha256',CASE WHEN jsonb_typeof(v->'logo')='object' THEN (v#>>'{logo,blobId}')::uuid END,v,actor);
    rid:=(kit_v+1)::text;
  ELSIF p_action IN ('set_create','versions_append') THEN
    IF p_action='set_create' THEN
      v:=p_input->'set'; v_set:=(v->>'id')::uuid;
      IF v->>'brandId' IS DISTINCT FROM p_workspace::text OR v->>'createdBy' IS DISTINCT FROM actor::text OR v_set IS NULL THEN RAISE EXCEPTION 'Invalid creative set' USING ERRCODE='22023'; END IF;
      INSERT INTO app.creative_studio_sets(workspace_id,id,data,created_by) VALUES(p_workspace,v_set,v,actor);
    ELSE
      v_set:=(p_input->>'setId')::uuid;
      IF NOT EXISTS(SELECT 1 FROM app.creative_studio_sets WHERE workspace_id=p_workspace AND id=v_set) THEN RAISE EXCEPTION 'Creative set not found' USING ERRCODE='22023'; END IF;
    END IF;
    IF jsonb_typeof(p_input->'versions') IS DISTINCT FROM 'array' OR jsonb_array_length(p_input->'versions') NOT BETWEEN 1 AND 24 THEN RAISE EXCEPTION 'Invalid creative versions' USING ERRCODE='22023'; END IF;
    FOR v IN SELECT value FROM jsonb_array_elements(p_input->'versions') LOOP
      k:=app_private.creative_studio_variant_key(v);
      IF k=ANY(keys) THEN RAISE EXCEPTION 'Duplicate artwork variant in one command' USING ERRCODE='22023'; END IF;
      keys:=keys||k;
      PERFORM app_private.creative_studio_insert_version(p_workspace,actor,v_set,v,prof,kit_v);
    END LOOP;
    rid:=v_set::text;
  ELSIF p_action='approve' THEN
    a:=p_input->'approval';
    SELECT * INTO ver FROM app.creative_studio_versions WHERE workspace_id=p_workspace AND id=(a->>'versionId')::uuid;
    IF ver.id IS NULL OR a->>'approvedBy' IS DISTINCT FROM actor::text OR a->>'scope' IS DISTINCT FROM 'image_only' THEN RAISE EXCEPTION 'Artwork version not found' USING ERRCODE='22023'; END IF;
    IF ver.variant_key ~ '^c[1-9]:storyboard_' THEN RAISE EXCEPTION 'A storyboard is a plan made of still frames, not a video. Render the video and approve that.' USING ERRCODE='55000'; END IF;
    IF EXISTS(SELECT 1 FROM app.creative_studio_versions WHERE workspace_id=p_workspace AND set_id=ver.set_id AND variant_key=ver.variant_key AND number>ver.number) THEN
      RAISE EXCEPTION 'A newer version of this artwork exists. Review and approve the current version.' USING ERRCODE='55000'; END IF;
    IF a->>'renderSha256' IS DISTINCT FROM ver.render_sha256 THEN RAISE EXCEPTION 'The artwork changed since you reviewed it.' USING ERRCODE='55000'; END IF;
    IF prof IS NULL OR ver.profile_version::text IS DISTINCT FROM prof->>'version' OR ver.facts_sha IS DISTINCT FROM prof->>'factsSha' OR ver.kit_version<>kit_v
      OR a#>>'{context,profileVersion}' IS DISTINCT FROM prof->>'version' OR a#>>'{context,factsSha}' IS DISTINCT FROM prof->>'factsSha'
      OR (a#>>'{context,kitVersion}')::integer IS DISTINCT FROM kit_v THEN
      RAISE EXCEPTION 'Brand facts or the creative kit changed since this version was made. Refresh it before approval.' USING ERRCODE='55000'; END IF;
    IF ver.blocking THEN RAISE EXCEPTION 'Resolve the blocking layout or copy issues before approval.' USING ERRCODE='55000'; END IF;
    IF ver.figures_flagged AND a->'figuresConfirmed' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'Confirm the unsupported figures before approval.' USING ERRCODE='55000'; END IF;
    INSERT INTO app.creative_studio_approvals(workspace_id,id,version_id,render_sha256,profile_version,facts_sha,kit_version,figures_confirmed,data,approved_by)
      VALUES(p_workspace,(a->>'id')::uuid,ver.id,ver.render_sha256,ver.profile_version,ver.facts_sha,kit_v,coalesce((a->>'figuresConfirmed')::boolean,false),a,actor);
    rid:=a->>'id';
  ELSE -- handoff
    a:=p_input->'handoff';
    SELECT * INTO ver FROM app.creative_studio_versions WHERE workspace_id=p_workspace AND id=(a->>'versionId')::uuid;
    SELECT * INTO appr FROM app.creative_studio_approvals WHERE workspace_id=p_workspace AND version_id=ver.id;
    IF ver.id IS NULL OR appr.id IS NULL OR appr.id::text IS DISTINCT FROM a->>'approvalId' OR a->>'createdBy' IS DISTINCT FROM actor::text
      OR a->>'state' IS DISTINCT FROM 'ready_for_review' THEN RAISE EXCEPTION 'Only an approved artwork version can be added to a campaign.' USING ERRCODE='55000'; END IF;
    IF EXISTS(SELECT 1 FROM app.creative_studio_versions WHERE workspace_id=p_workspace AND set_id=ver.set_id AND variant_key=ver.variant_key AND number>ver.number)
      OR prof IS NULL OR appr.profile_version::text IS DISTINCT FROM prof->>'version' OR appr.facts_sha IS DISTINCT FROM prof->>'factsSha' OR appr.kit_version<>kit_v THEN
      RAISE EXCEPTION 'This approval is no longer current. Refresh and approve the current artwork.' USING ERRCODE='55000'; END IF;
    IF NOT ((a#>>'{target,kind}'='article_campaign' AND EXISTS(SELECT 1 FROM app.seo_blog_articles x WHERE x.workspace_id=p_workspace AND x.id::text=a#>>'{target,articleId}'))
      OR (a#>>'{target,kind}'='creator_campaign' AND EXISTS(SELECT 1 FROM app.seo_blog_creator_campaigns x WHERE x.workspace_id=p_workspace AND x.id::text=a#>>'{target,campaignId}'))) THEN
      RAISE EXCEPTION 'That campaign was not found for this brand.' USING ERRCODE='22023'; END IF;
    -- Milestone 4: the route says which existing integration received the exact approved bytes, and is checked here.
    IF a->>'route' IS NULL OR a->>'route' NOT IN ('article_media','tracked_link','export_only') THEN RAISE EXCEPTION 'Unknown hand-off route' USING ERRCODE='22023'; END IF;
    IF a->>'route'='article_media' AND NOT (a#>>'{target,kind}'='article_campaign' AND coalesce(ver.data->>'media','image')='image' AND EXISTS(
        SELECT 1 FROM app.seo_blog_media_assets variant JOIN app.seo_blog_media_assets cand ON cand.workspace_id=variant.workspace_id AND cand.id=variant.source_asset_id
        WHERE variant.workspace_id=p_workspace AND variant.id::text=a#>>'{articleMedia,variantAssetId}' AND variant.asset_kind='variant'
          AND encode(variant.byte_sha256,'hex')=a#>>'{articleMedia,variantSha256}' AND variant.recipe->>'profile'=a#>>'{articleMedia,profile}'
          AND cand.id::text=a#>>'{articleMedia,candidateAssetId}' AND cand.asset_kind='candidate' AND encode(cand.byte_sha256,'hex')=ver.render_sha256
          AND cand.provenance->>'sourceName'='creative-studio-'||ver.id::text||'.jpg')) THEN
      RAISE EXCEPTION 'The article image does not match this approved artwork.' USING ERRCODE='55000'; END IF;
    IF a->>'route'='tracked_link' AND NOT (a#>>'{target,kind}'='creator_campaign'
        AND a#>>'{target,concept}' ~ '^[0-9]{1,2}$' AND a#>>'{trackedLink,concept}' IS NOT DISTINCT FROM a#>>'{target,concept}'
        AND a#>>'{trackedLink,utmContent}' = 'concept-'||((a#>>'{target,concept}')::int+1)||'-cs'||left(replace(ver.id::text,'-',''),8)
        AND EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(prof->'conversionPages','[]'::jsonb)) cp
          WHERE lower(regexp_replace(cp->>'url','^https?://(www[.])?([^/?#]+).*$','\2'))=lower(regexp_replace(a#>>'{trackedLink,url}','^https?://(www[.])?([^/?#]+).*$','\2')))
        AND a#>>'{trackedLink,utmCampaign}' ~ ('^[a-z0-9-]{1,40}-'||left(replace(a#>>'{target,campaignId}','-',''),8)||'$')
        AND position('utm_content='||(a#>>'{trackedLink,utmContent}') IN a#>>'{trackedLink,url}')>0
        AND position('utm_campaign='||(a#>>'{trackedLink,utmCampaign}') IN a#>>'{trackedLink,url}')>0) THEN
      RAISE EXCEPTION 'The tracked link does not carry this campaign and artwork.' USING ERRCODE='22023'; END IF;
    INSERT INTO app.creative_studio_handoffs(workspace_id,id,version_id,approval_id,target,data,created_by) VALUES(p_workspace,(a->>'id')::uuid,ver.id,appr.id,a->'target',a,actor);
    rid:=a->>'id';
  END IF;
  INSERT INTO app.creative_studio_commands(workspace_id,id,action,input_sha256,result_id,actor_user_id) VALUES(p_workspace,(p_input->>'commandId')::uuid,p_action,p_input->>'inputSha',rid,actor);
  RETURN jsonb_build_object('replayed',false,'id',rid);
END $f$;

REVOKE ALL ON FUNCTION app_private.creative_studio_variant_key(jsonb),app_private.creative_studio_insert_version(uuid,uuid,uuid,jsonb,jsonb,integer),app_private.creative_studio_command(uuid,bytea,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.creative_studio_command(uuid,bytea,text,jsonb) TO r72_content_command;

RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_creative_studio_definer;


-- ─── Milestone 2: acquisition campaign proposals reuse the reviewed 0139 creator boundary ───
-- Only the kind/stage lists change: 'acquisition' requires the reviewed conversion-copy pack, reserves the same
-- writing allowance atomically with every other creator run, and is charged once by the receipt boundary.
-- Function bodies below are 0139 verbatim apart from those three lists.
DO $creator_kind$
BEGIN
  IF (SELECT count(*) FROM pg_constraint WHERE conrelid='app.seo_blog_creator_campaigns'::regclass AND conname='seo_blog_creator_campaigns_kind_check'
      AND contype='c' AND pg_get_constraintdef(oid)='CHECK ((kind = ANY (ARRAY[''email''::text, ''advocacy''::text])))')<>1 THEN
    RAISE EXCEPTION 'Unexpected 0139 creator kind constraint' USING ERRCODE='55000';
  END IF;
  ALTER TABLE app.seo_blog_creator_campaigns DROP CONSTRAINT seo_blog_creator_campaigns_kind_check;
  ALTER TABLE app.seo_blog_creator_campaigns ADD CONSTRAINT seo_blog_creator_campaigns_kind_check CHECK(kind IN ('email','advocacy','acquisition'));
END $creator_kind$;
GRANT CREATE ON SCHEMA app_private TO r72_seo_method_definer;
SET LOCAL ROLE r72_seo_method_definer;

CREATE OR REPLACE FUNCTION app_private.seo_creator_command(p_workspace uuid,p_session bytea,p_id uuid,p_action text,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; c app.seo_blog_creator_campaigns; v app.seo_blog_creator_versions; p jsonb; a app.seo_blog_method_assignments;
 used bigint; reserved bigint; ceiling bigint; receipt jsonb; body text; sha text; next_state text; required_pack text;
BEGIN
 actor:=app_private.seo_media_owner(p_workspace,p_session);
 IF app_private.seo_blog_brand(p_workspace) IS NULL THEN RAISE EXCEPTION 'Brand unavailable' USING ERRCODE='42501'; END IF;
 IF p_action='list' THEN RETURN coalesce((SELECT jsonb_agg(app_private.seo_creator_record(p_workspace,id) ORDER BY created_at DESC) FROM app.seo_blog_creator_campaigns WHERE workspace_id=p_workspace),'[]'::jsonb); END IF;
 IF p_action='get' THEN RETURN app_private.seo_creator_record(p_workspace,p_id); END IF;
 IF p_action NOT IN ('begin','complete','edit','approve','recover') THEN RAISE EXCEPTION 'Unknown creator command' USING ERRCODE='22023'; END IF;
 -- Serialise allowance reservations with assignment changes and other creator starts for this brand.
 PERFORM workspace_id FROM app.seo_blog_brands WHERE workspace_id=p_workspace FOR UPDATE;
 SELECT * INTO c FROM app.seo_blog_creator_campaigns WHERE workspace_id=p_workspace AND id=p_id FOR UPDATE;
 SELECT * INTO a FROM app.seo_blog_method_assignments WHERE workspace_id=p_workspace ORDER BY revision DESC LIMIT 1;
 p:=app_private.seo_creator_profile(p_workspace);
 IF p_action='begin' THEN
   IF c.id IS NOT NULL THEN
     IF c.input_hash IS DISTINCT FROM p_input->>'inputHash' THEN RAISE EXCEPTION 'Command input changed' USING ERRCODE='40001'; END IF;
     RETURN jsonb_build_object('created',false,'record',app_private.seo_creator_record(p_workspace,p_id));
   END IF;
   required_pack:=CASE p_input#>>'{brief,kind}' WHEN 'email' THEN 'email-writing' WHEN 'advocacy' THEN 'advocacy-and-referral' WHEN 'acquisition' THEN 'conversion-copy' ELSE NULL END;
   IF p_id IS NULL OR p_input->>'brandId' IS DISTINCT FROM p_workspace::text OR p_input->>'actorId' IS DISTINCT FROM actor::text
     OR required_pack IS NULL OR p_input->>'id' IS DISTINCT FROM p_id::text OR (p_input->>'reservation')::bigint<>350000
     OR p IS NULL OR p->>'version' IS DISTINCT FROM p_input->>'profileVersion' OR p->>'factsSha' IS DISTINCT FROM p_input->>'factsSha'
     OR a.revision IS NULL OR a.revision IS DISTINCT FROM (p_input->>'assignmentRevision')::integer THEN
     RAISE EXCEPTION 'Current confirmed profile and method assignment required' USING ERRCODE='55000'; END IF;
   IF NOT EXISTS(SELECT 1 FROM app.seo_blog_brands b JOIN app.seo_blog_method_private_organizations o ON o.organization_id=b.organization_id WHERE b.workspace_id=p_workspace)
     OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(a.pins) pin JOIN app.seo_blog_method_releases r ON r.pack_id=pin->>'packId' AND r.version=pin->>'version' AND r.canonical_sha256=pin->>'hash'
       WHERE r.pack_id=required_pack AND r.version='0.1.1' AND r.private_approval='approved') THEN RAISE EXCEPTION 'Reviewed private creator assignment required' USING ERRCODE='42501'; END IF;
   IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p->'conversionPages') page WHERE page->>'url'=p_input#>>'{brief,cta,url}' AND page->>'label'=p_input#>>'{brief,cta,label}') THEN RAISE EXCEPTION 'Approved brand action required' USING ERRCODE='22023'; END IF;
   SELECT coalesce(sum(amount),0) INTO used FROM app.seo_blog_usage WHERE workspace_id=p_workspace AND kind='model_tokens' AND at>=date_trunc('month',clock_timestamp());
   SELECT coalesce(sum(reserved_tokens),0) INTO reserved FROM app.seo_blog_creator_campaigns WHERE workspace_id=p_workspace;
   SELECT (settings#>>'{budgets,modelTokensPerMonth}')::bigint INTO ceiling FROM app.seo_blog_brands WHERE workspace_id=p_workspace;
   IF ceiling IS NULL OR ceiling-used-reserved<350000 THEN RAISE EXCEPTION 'More writing allowance is needed for this campaign; pending or uncertain runs retain their reservation' USING ERRCODE='55000'; END IF;
   INSERT INTO app.seo_blog_creator_campaigns(workspace_id,id,kind,input_hash,brief,profile_version,facts_sha,assignment_revision,method_receipt_id,reserved_tokens,state,created_by)
     VALUES(p_workspace,p_id,p_input#>>'{brief,kind}',p_input->>'inputHash',p_input->'brief',(p_input->>'profileVersion')::integer,p_input->>'factsSha',a.revision,(p_input->>'methodReceiptId')::uuid,350000,'generating',actor);
   RETURN jsonb_build_object('created',true,'record',app_private.seo_creator_record(p_workspace,p_id));
 END IF;
 IF c.id IS NULL THEN RAISE EXCEPTION 'Campaign not found' USING ERRCODE='22023'; END IF;
 IF p_action='recover' THEN
   p_action:='complete';p_input:=jsonb_build_object('receiptId',c.method_receipt_id,'detail','Recovered the saved generation receipt without another model call.');
 END IF;
 IF p_action='complete' THEN
   IF c.method_receipt_id IS DISTINCT FROM (p_input->>'receiptId')::uuid THEN RAISE EXCEPTION 'Wrong campaign receipt' USING ERRCODE='42501'; END IF;
   SELECT data INTO receipt FROM app.seo_blog_method_receipts WHERE workspace_id=p_workspace AND id=c.method_receipt_id;
   IF c.state<>'generating' AND NOT(c.state='unknown' AND receipt->>'outcome' IN ('accepted','rejected')) THEN RETURN app_private.seo_creator_record(p_workspace,p_id); END IF;
   body:=coalesce(p_input->>'contentText',CASE WHEN receipt->>'outcome'='accepted' THEN receipt->>'resultText' ELSE NULL END);
   IF receipt IS NULL OR receipt->>'outcome'='unknown' THEN next_state:='unknown';
   ELSIF receipt->>'outcome'='rejected' THEN next_state:='held';
   ELSIF body IS NOT NULL AND receipt->>'outcome'='accepted' THEN
     sha:=encode(sha256(convert_to(body,'UTF8')),'hex');
     IF receipt->>'assetRef' IS DISTINCT FROM 'creator:'||p_id::text OR receipt->>'stage' IS DISTINCT FROM c.kind
       OR receipt->>'resultHash' IS DISTINCT FROM sha OR receipt->>'profileVersion' IS DISTINCT FROM c.profile_version::text
       OR receipt#>>'{assignment,revision}' IS DISTINCT FROM c.assignment_revision::text THEN RAISE EXCEPTION 'Campaign body does not match generation receipt' USING ERRCODE='42501'; END IF;
     INSERT INTO app.seo_blog_creator_versions(workspace_id,campaign_id,number,content_text,content_sha,method_receipt_id,created_by) VALUES(p_workspace,p_id,1,body,sha,c.method_receipt_id,actor);
     next_state:='draft';
   ELSE next_state:='held'; END IF;
   IF next_state='draft' AND (p IS NULL OR p->>'version' IS DISTINCT FROM c.profile_version::text OR p->>'factsSha' IS DISTINCT FROM c.facts_sha OR a.revision IS DISTINCT FROM c.assignment_revision) THEN next_state:='held'; END IF;
   UPDATE app.seo_blog_creator_campaigns SET state=next_state,current_version=CASE WHEN sha IS NOT NULL THEN 1 ELSE 0 END,
     reserved_tokens=CASE WHEN next_state='unknown' THEN reserved_tokens ELSE 0 END,row_version=row_version+1,
     detail=CASE WHEN next_state='held' AND sha IS NOT NULL THEN 'Brand context or production rules changed during generation. Create a new campaign from the current confirmed inputs.' ELSE left(coalesce(p_input->>'detail','Review this campaign'),800) END WHERE workspace_id=p_workspace AND id=p_id;
   RETURN app_private.seo_creator_record(p_workspace,p_id);
 END IF;
 SELECT * INTO v FROM app.seo_blog_creator_versions WHERE workspace_id=p_workspace AND campaign_id=p_id AND number=c.current_version;
 IF c.row_version IS DISTINCT FROM (p_input->>'expectedRowVersion')::integer OR v.content_sha IS NULL OR v.content_sha IS DISTINCT FROM p_input->>'expectedSha' THEN RAISE EXCEPTION 'Campaign version changed' USING ERRCODE='40001'; END IF;
 IF p IS NULL OR p->>'version' IS DISTINCT FROM c.profile_version::text OR p->>'factsSha' IS DISTINCT FROM c.facts_sha OR a.revision IS DISTINCT FROM c.assignment_revision THEN RAISE EXCEPTION 'Current profile or production rules changed; create a new campaign from the confirmed inputs' USING ERRCODE='55000'; END IF;
 IF c.state IN ('generating','held','unknown') THEN RAISE EXCEPTION 'Held or uncertain generation cannot be approved or edited as a clean draft' USING ERRCODE='55000'; END IF;
 IF p_action='edit' THEN
   body:=p_input->>'contentText';sha:=encode(sha256(convert_to(body,'UTF8')),'hex');
   IF sha=v.content_sha THEN RETURN app_private.seo_creator_record(p_workspace,p_id); END IF;
   INSERT INTO app.seo_blog_creator_versions(workspace_id,campaign_id,number,content_text,content_sha,created_by) VALUES(p_workspace,p_id,c.current_version+1,body,sha,actor);
   UPDATE app.seo_blog_creator_campaigns SET current_version=current_version+1,state='draft',approval=NULL,row_version=row_version+1,detail='Owner edit saved. Review this new version before export.' WHERE workspace_id=p_workspace AND id=p_id;
 ELSE
   UPDATE app.seo_blog_creator_campaigns SET state='approved',approval=jsonb_build_object('version',current_version,'contentSha',v.content_sha,'by',actor,'at',clock_timestamp()),row_version=row_version+1,detail='Approved authoring draft. No messages have been sent or scheduled.' WHERE workspace_id=p_workspace AND id=p_id;
 END IF;
 RETURN app_private.seo_creator_record(p_workspace,p_id);
END $f$;

CREATE OR REPLACE FUNCTION app_private.seo_method_save_receipt(p_workspace uuid,p_session bytea,p_data jsonb)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE a app.seo_blog_method_assignments; pin jsonb; saved app.seo_blog_method_receipts;
BEGIN
  PERFORM app_private.seo_media_private_actor(p_workspace,p_session);
  IF app_private.seo_blog_brand(p_workspace) IS NULL THEN RAISE EXCEPTION 'Brand unavailable' USING ERRCODE='42501'; END IF;
  IF p_data->>'brandId' IS DISTINCT FROM p_workspace::text OR p_data->>'approvalState' IS DISTINCT FROM 'draft'
    OR p_data->>'outcome' IS NULL OR p_data->>'outcome' NOT IN ('accepted','rejected','unknown')
    OR p_data->>'stage' IS NULL OR p_data->>'stage' NOT IN ('planning','blog','revision','social','email','advocacy','acquisition')
    OR p_data->>'promptHash' IS NULL OR p_data#>>'{usage,tokensIn}' IS NULL OR p_data#>>'{usage,tokensOut}' IS NULL
    OR p_data->>'revisionPasses' IS NULL OR p_data->>'profileVersion' IS NULL OR (p_data->>'profileVersion')::integer<1
    OR (p_data->>'outcome'='accepted' AND (p_data->>'resultHash' IS NULL OR p_data->>'resultHash' !~ '^[0-9a-f]{64}$'))
    OR jsonb_typeof(p_data->'pins') IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_data->'pins') NOT BETWEEN 1 AND 12 OR p_data->>'promptHash' !~ '^[0-9a-f]{64}$'
    OR (p_data#>>'{usage,tokensIn}')::bigint NOT BETWEEN 0 AND 10000000
    OR (p_data#>>'{usage,tokensOut}')::bigint NOT BETWEEN 0 AND 10000000
    OR (p_data->>'revisionPasses')::integer NOT BETWEEN 0 AND 1 THEN
    RAISE EXCEPTION 'Invalid method receipt' USING ERRCODE='22023';
  END IF;
  SELECT * INTO a FROM app.seo_blog_method_assignments WHERE workspace_id=p_workspace
    AND revision=(p_data#>>'{assignment,revision}')::integer;
  IF a.revision IS NULL OR a.scope IS DISTINCT FROM p_data#>>'{assignment,scope}'
    OR a.pins IS DISTINCT FROM p_data#>'{assignment,pins}' THEN RAISE EXCEPTION 'Invalid assignment receipt' USING ERRCODE='42501'; END IF;
  FOR pin IN SELECT value FROM jsonb_array_elements(p_data->'pins') LOOP
    IF NOT a.pins @> jsonb_build_array(pin) OR NOT EXISTS(SELECT 1 FROM app.seo_blog_method_releases r
      WHERE r.pack_id=pin->>'packId' AND r.version=pin->>'version' AND r.canonical_sha256=pin->>'hash' AND r.private_approval='approved')
      THEN RAISE EXCEPTION 'Unapproved receipt method' USING ERRCODE='42501'; END IF;
  END LOOP;
  SELECT * INTO saved FROM app.seo_blog_method_receipts WHERE workspace_id=p_workspace AND id=(p_data->>'id')::uuid;
  IF saved.id IS NOT NULL THEN
    IF saved.data IS DISTINCT FROM p_data THEN RAISE EXCEPTION 'Receipt is immutable' USING ERRCODE='42501'; END IF;
    RETURN;
  END IF;
  INSERT INTO app.seo_blog_method_receipts(workspace_id,id,assignment_revision,data)
    VALUES(p_workspace,(p_data->>'id')::uuid,a.revision,p_data);
  -- Blog success usage stays in its engine. Creator usage and rejected calls are charged once here, even if a later asset save fails.
  IF p_data->>'outcome'<>'accepted' OR p_data->>'stage' IN ('email','advocacy','acquisition') THEN
    INSERT INTO app.seo_blog_usage(workspace_id,kind,amount,at,reference) VALUES(p_workspace,'model_tokens',
      (p_data#>>'{usage,tokensIn}')::bigint+(p_data#>>'{usage,tokensOut}')::bigint,clock_timestamp(),'method-cost:'||(p_data->>'id'));
  END IF;
END $f$;

RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_seo_method_definer;

-- ─── Milestone 4: distribution states and outcomes, read from the existing systems ───
-- Read-only. No table is added: delivery states come from the existing SEO posting-plan receipts and the existing
-- connected-calendar jobs; outcomes come from the existing CRM, journey and commerce records joined by the UTM
-- values already stored in the existing contact attribution tables. Nothing is written, queued, sent or charged.
GRANT SELECT ON app.seo_blog_media_commands,app.property_predator_owned_social_jobs,app.property_predator_owned_social_receipts,
  app.contacts,app.contact_attribution_facts,app.contact_import_attribution_facts,app.opportunities,app.opportunity_stage_history,
  app.pipeline_stages,app.conversion_milestone_facts,app.conversion_commerce_facts TO r72_creative_studio_definer;
GRANT EXECUTE ON FUNCTION app_private.seo_media_campaign_queue_receipt_id(uuid) TO r72_creative_studio_definer;
DO $read$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['seo_blog_media_commands','property_predator_owned_social_jobs','property_predator_owned_social_receipts',
    'contacts','contact_attribution_facts','contact_import_attribution_facts','opportunities','opportunity_stage_history',
    'pipeline_stages','conversion_milestone_facts','conversion_commerce_facts'] LOOP
    EXECUTE format('CREATE POLICY %I ON app.%I FOR SELECT TO r72_creative_studio_definer USING(workspace_id=app_private.current_workspace_id())',t||'_creative_read',t);
  END LOOP;
END $read$;

RESET ROLE;
SET LOCAL ROLE r72_owner;
GRANT CREATE ON SCHEMA app_private TO r72_creative_studio_definer;
SET LOCAL ROLE r72_creative_studio_definer;

CREATE FUNCTION app_private.creative_studio_outcome_buckets(p_workspace uuid,campaign text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
  IF app_private.current_workspace_id() IS DISTINCT FROM p_workspace THEN RAISE EXCEPTION 'Workspace mismatch' USING ERRCODE='42501'; END IF;
    -- One bucket per contact (its latest matching touch), so no contact is counted twice. Exact UTM match only.
    RETURN (WITH touches AS (
        SELECT contact_id,utm_content,attributed_at FROM app.contact_attribution_facts WHERE workspace_id=p_workspace AND utm_campaign=campaign
        UNION ALL
        SELECT contact_id,utm_content,attributed_at FROM app.contact_import_attribution_facts WHERE workspace_id=p_workspace AND utm_campaign=campaign),
      latest AS (SELECT DISTINCT ON (t.contact_id) t.contact_id,coalesce(t.utm_content,'') AS content,t.attributed_at
        FROM touches t JOIN app.contacts c ON c.workspace_id=p_workspace AND c.id=t.contact_id AND c.deleted_at IS NULL
        ORDER BY t.contact_id,t.attributed_at DESC),
      facts AS (SELECT l.content,l.contact_id,l.attributed_at,
        EXISTS(SELECT 1 FROM app.opportunities o WHERE o.workspace_id=p_workspace AND o.contact_id=l.contact_id AND (o.status='won' OR EXISTS(
          SELECT 1 FROM app.opportunity_stage_history h JOIN app.pipeline_stages s ON s.workspace_id=h.workspace_id AND s.id=h.to_stage_id
          WHERE h.workspace_id=p_workspace AND h.opportunity_id=o.id AND s.slug='qualified')
          OR EXISTS(SELECT 1 FROM app.pipeline_stages s WHERE s.workspace_id=p_workspace AND s.id=o.stage_id AND s.slug='qualified'))) AS qualified,
        EXISTS(SELECT 1 FROM app.conversion_milestone_facts f WHERE f.workspace_id=p_workspace AND f.contact_id=l.contact_id AND f.milestone_semantic='appointment') AS booked,
        EXISTS(SELECT 1 FROM app.conversion_commerce_facts f WHERE f.workspace_id=p_workspace AND f.contact_id=l.contact_id AND f.fact_type='payment_collected')
          OR EXISTS(SELECT 1 FROM app.conversion_milestone_facts f WHERE f.workspace_id=p_workspace AND f.contact_id=l.contact_id AND f.milestone_semantic='sale')
          OR EXISTS(SELECT 1 FROM app.opportunities o WHERE o.workspace_id=p_workspace AND o.contact_id=l.contact_id AND o.status='won') AS sold,
        EXISTS(SELECT 1 FROM app.conversion_commerce_facts f WHERE f.workspace_id=p_workspace AND f.contact_id=l.contact_id AND f.fact_type='subscription_cancelled') AS cancelled,
        (SELECT c.lifecycle_status='customer' FROM app.contacts c WHERE c.workspace_id=p_workspace AND c.id=l.contact_id) AS customer
        FROM latest l)
      SELECT coalesce(jsonb_agg(jsonb_build_object('utmContent',b.content,'leads',b.leads,
        'qualified',b.qualified,'booked',b.booked,'sold',b.sold,'customers',b.customers,'subscriptionsCancelled',b.cancelled,'firstAt',b.first_at,'lastAt',b.last_at) ORDER BY b.content),'[]'::jsonb)
      FROM (SELECT content,count(*) AS leads,count(*) FILTER (WHERE qualified) AS qualified,count(*) FILTER (WHERE booked) AS booked,count(*) FILTER (WHERE sold) AS sold,
        count(*) FILTER (WHERE customer) AS customers,count(*) FILTER (WHERE cancelled) AS cancelled,min(attributed_at) AS first_at,max(attributed_at) AS last_at FROM facts GROUP BY content) b);
END $f$;
REVOKE ALL ON FUNCTION app_private.creative_studio_outcome_buckets(uuid,text) FROM PUBLIC;

-- VOLATILE because the owner check locks the session row; the body itself only reads.
CREATE FUNCTION app_private.creative_studio_distribution(p_workspace uuid,p_session bytea,p_action text,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; campaign text; queues uuid[];
BEGIN
  actor:=app_private.seo_media_owner(p_workspace,p_session);
  IF app_private.seo_blog_brand(p_workspace) IS NULL THEN RAISE EXCEPTION 'Brand unavailable' USING ERRCODE='42501'; END IF;
  IF p_input IS NULL OR jsonb_typeof(p_input)<>'object' OR octet_length(p_input::text)>16384 THEN RAISE EXCEPTION 'Invalid distribution read' USING ERRCODE='22023'; END IF;
  IF p_action='delivery' THEN
    -- Only posting plans this brand's owner authorised; each state is what the calendar job and its receipts record.
    IF jsonb_typeof(p_input->'queues') IS DISTINCT FROM 'array' OR jsonb_array_length(p_input->'queues')>64
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_input->'queues') x WHERE jsonb_typeof(x)<>'string' OR (x#>>'{}') !~ '^[0-9a-f-]{36}$') THEN
      RAISE EXCEPTION 'Invalid distribution read' USING ERRCODE='22023'; END IF;
    queues:=ARRAY(SELECT x::uuid FROM jsonb_array_elements_text(p_input->'queues') x);
    RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('queueIntentId',q.id,
        'cancelled',EXISTS(SELECT 1 FROM app.seo_blog_media_commands c WHERE c.workspace_id=p_workspace AND c.action='cancel_campaign_queue' AND c.result->>'queueIntentId'=q.id::text),
        'superseded',EXISTS(SELECT 1 FROM app.seo_blog_media_commands n WHERE n.workspace_id=p_workspace AND n.action='authorize_campaign_queue' AND n.actor_kind='user' AND n.result->>'supersedesQueueIntentId'=q.id::text),
        'materialized',m.result IS NOT NULL AND m.result->>'kind'='materialized',
        'scheduledFor',m.result->>'scheduledFor',
        'jobState',j.state,
        'providerPostRecorded',j.provider_external_id IS NOT NULL,
        'events',coalesce((SELECT jsonb_agg(jsonb_build_object('kind',r.event_kind,'at',r.provider_occurred_at,'code',r.safe_code) ORDER BY r.provider_occurred_at,r.lease_version)
          FROM app.property_predator_owned_social_receipts r WHERE r.workspace_id=p_workspace AND r.job_id=j.id),'[]'::jsonb)) ORDER BY q.created_at)
      FROM app.seo_blog_media_commands q
      LEFT JOIN app.seo_blog_media_commands m ON m.workspace_id=q.workspace_id AND m.id=app_private.seo_media_campaign_queue_receipt_id(q.id) AND m.action='materialize_campaign_queue'
      LEFT JOIN app.property_predator_owned_social_jobs j ON j.workspace_id=q.workspace_id AND j.id::text=m.result->>'jobId'
      WHERE q.workspace_id=p_workspace AND q.action='authorize_campaign_queue' AND q.actor_kind='user' AND q.id=ANY(queues)),'[]'::jsonb);
  END IF;
  IF p_action='outcomes' THEN
    campaign:=p_input->>'utmCampaign';
    IF campaign IS NULL OR campaign !~ '^[a-z0-9-]{1,40}-[0-9a-f]{8}$' THEN RAISE EXCEPTION 'Invalid distribution read' USING ERRCODE='22023'; END IF;
    RETURN jsonb_build_object('utmCampaign',campaign,'readAt',clock_timestamp(),'buckets',app_private.creative_studio_outcome_buckets(p_workspace,campaign));
  END IF;
  RAISE EXCEPTION 'Unknown distribution read' USING ERRCODE='22023';
END $f$;

REVOKE ALL ON FUNCTION app_private.creative_studio_distribution(uuid,bytea,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.creative_studio_distribution(uuid,bytea,text,jsonb) TO r72_content_command;

RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_creative_studio_definer;

-- ─── Milestone 5: learning journal and owner-authorised general patterns ───
-- Findings are recorded only by the managing owner and only with evidence this boundary recomputes itself from
-- the existing CRM outcome rows, so a finding cannot cite counts that were never observed. Patterns are short,
-- owner-written generalisations with no figures, links, colours, brand names or offer names; they are visible only
-- to the same person's other managed brands, are labelled as patterns (not evidence) and can be withdrawn.
CREATE TABLE app.creative_studio_findings(
  workspace_id uuid NOT NULL REFERENCES app.seo_blog_brands(workspace_id), id uuid NOT NULL, campaign_id uuid NOT NULL,
  utm_campaign text NOT NULL CHECK(utm_campaign ~ '^[a-z0-9-]{1,40}-[0-9a-f]{8}$'),
  evidence jsonb NOT NULL CHECK(jsonb_typeof(evidence)='array' AND octet_length(evidence::text)<=65536),
  data jsonb NOT NULL CHECK(jsonb_typeof(data)='object' AND octet_length(data::text)<=65536),
  recorded_by uuid NOT NULL REFERENCES app.users(id), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,id)
);
CREATE TABLE app.creative_studio_patterns(
  workspace_id uuid NOT NULL REFERENCES app.seo_blog_brands(workspace_id), id uuid NOT NULL, pattern_id uuid NOT NULL, finding_id uuid NOT NULL,
  state text NOT NULL CHECK(state IN ('shared','withdrawn')),
  statement text NOT NULL CHECK(length(statement) BETWEEN 20 AND 300 AND statement !~ '[0-9]' AND statement !~* '(https?:|www[.]|@|#[0-9a-f]{3}|[£$€%]|utm_)'),
  decided_by uuid NOT NULL REFERENCES app.users(id), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,id),
  FOREIGN KEY(workspace_id,finding_id) REFERENCES app.creative_studio_findings(workspace_id,id)
);
DO $learning$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['creative_studio_findings','creative_studio_patterns'] LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON app.%I FROM PUBLIC,r72_content_command,r72_web,r72_worker',t);
    EXECUTE format('CREATE POLICY %I ON app.%I FOR ALL TO r72_owner USING(true) WITH CHECK(true)',t||'_owner',t);
    EXECUTE format('CREATE POLICY %I ON app.%I FOR INSERT TO r72_creative_studio_definer WITH CHECK(workspace_id=app_private.current_workspace_id())',t||'_insert',t);
    EXECUTE format('GRANT SELECT,INSERT ON app.%I TO r72_creative_studio_definer',t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON app.%I FOR EACH ROW EXECUTE FUNCTION app_private.seo_blog_append_only()',t||'_immutable',t);
    INSERT INTO app_private.workspace_table_registry(schema_name,table_name,workspace_column) VALUES('app',t,'workspace_id');
  END LOOP;
END $learning$;
CREATE POLICY creative_studio_findings_scope ON app.creative_studio_findings FOR SELECT TO r72_creative_studio_definer USING(workspace_id=app_private.current_workspace_id());
-- Cross-brand reads reach only brands the current person also manages; the function below further limits them to shared rows.
CREATE POLICY creative_studio_patterns_scope ON app.creative_studio_patterns FOR SELECT TO r72_creative_studio_definer
  USING(workspace_id=app_private.current_workspace_id() OR app_private.can_manage_workspace(app_private.current_user_id(),workspace_id));
GRANT EXECUTE ON FUNCTION app_private.can_manage_workspace(uuid,uuid) TO r72_creative_studio_definer;

RESET ROLE;
SET LOCAL ROLE r72_owner;
GRANT CREATE ON SCHEMA app_private TO r72_creative_studio_definer;
SET LOCAL ROLE r72_creative_studio_definer;

CREATE FUNCTION app_private.creative_studio_learning(p_workspace uuid,p_session bytea,p_action text,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; cmd app.creative_studio_commands; a jsonb; computed jsonb; brand jsonb; prof jsonb; term text; latest app.creative_studio_patterns;
  canon_computed jsonb; canon_claimed jsonb; e jsonb; rid text;
BEGIN
  actor:=app_private.seo_media_owner(p_workspace,p_session);
  brand:=app_private.seo_blog_brand(p_workspace);
  IF brand IS NULL THEN RAISE EXCEPTION 'Brand unavailable' USING ERRCODE='42501'; END IF;
  IF p_input IS NULL OR jsonb_typeof(p_input)<>'object' OR octet_length(p_input::text)>131072 THEN RAISE EXCEPTION 'Invalid learning command' USING ERRCODE='22023'; END IF;
  IF p_action='finding_list' THEN
    RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('id',f.id,'campaignId',f.campaign_id,'utmCampaign',f.utm_campaign,'evidence',f.evidence,'data',f.data,'recordedBy',f.recorded_by,'recordedAt',f.created_at) ORDER BY f.created_at DESC)
      FROM (SELECT * FROM app.creative_studio_findings WHERE workspace_id=p_workspace AND (p_input->>'campaignId' IS NULL OR campaign_id::text=p_input->>'campaignId') ORDER BY created_at DESC LIMIT 50) f),'[]'::jsonb);
  END IF;
  IF p_action IN ('patterns_mine','patterns_other') THEN
    RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('patternId',x.pattern_id,'findingId',x.finding_id,'statement',x.statement,'state',x.state,'decidedAt',x.created_at,
        'own',x.workspace_id=p_workspace) ORDER BY x.created_at DESC)
      FROM (SELECT DISTINCT ON (pt.workspace_id,pt.pattern_id) pt.* FROM app.creative_studio_patterns pt
        WHERE CASE WHEN p_action='patterns_mine' THEN pt.workspace_id=p_workspace
          ELSE pt.workspace_id<>p_workspace AND app_private.can_manage_workspace(actor,pt.workspace_id) END
        ORDER BY pt.workspace_id,pt.pattern_id,pt.created_at DESC,pt.id DESC) x
      WHERE p_action='patterns_mine' OR x.state='shared'),'[]'::jsonb);
  END IF;
  IF p_action NOT IN ('finding_record','pattern_share','pattern_withdraw') THEN RAISE EXCEPTION 'Unknown learning command' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('r72-creative-studio:'||p_workspace::text,0));
  SELECT * INTO cmd FROM app.creative_studio_commands WHERE workspace_id=p_workspace AND id=(p_input->>'commandId')::uuid;
  IF cmd.id IS NOT NULL THEN
    IF cmd.input_sha256 IS DISTINCT FROM p_input->>'inputSha' OR cmd.action<>p_action THEN RAISE EXCEPTION 'This request was already used for different content' USING ERRCODE='40001'; END IF;
    RETURN jsonb_build_object('replayed',true,'id',cmd.result_id);
  END IF;
  IF coalesce(p_input->>'commandId','') !~ '^[0-9a-f-]{36}$' OR coalesce(p_input->>'inputSha','') !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'Invalid learning command' USING ERRCODE='22023'; END IF;

  IF p_action='finding_record' THEN
    a:=p_input->'finding';
    IF coalesce(a->>'campaignId','') !~ '^[0-9a-f-]{36}$' THEN RAISE EXCEPTION 'Record findings for one of this brand''s acquisition campaigns.' USING ERRCODE='22023'; END IF;
    IF a->>'recordedBy' IS DISTINCT FROM actor::text OR coalesce(a->>'id','') !~ '^[0-9a-f-]{36}$'
      OR NOT EXISTS(SELECT 1 FROM app.seo_blog_creator_campaigns c WHERE c.workspace_id=p_workspace AND c.id::text=a->>'campaignId' AND c.kind='acquisition')
      OR coalesce(a->>'utmCampaign','') !~ ('^[a-z0-9-]{1,40}-'||left(replace(a->>'campaignId','-',''),8)||'$')
      OR jsonb_typeof(a#>'{snapshot,findings}') IS DISTINCT FROM 'array' OR jsonb_array_length(a#>'{snapshot,findings}') NOT BETWEEN 1 AND 40 THEN
      RAISE EXCEPTION 'Record findings for one of this brand''s acquisition campaigns.' USING ERRCODE='22023'; END IF;
    -- Evidence is recomputed here from the existing CRM rows; the claimed read must match it exactly.
    computed:=app_private.creative_studio_outcome_buckets(p_workspace,a->>'utmCampaign');
    SELECT coalesce(jsonb_agg(jsonb_build_array(b->>'utmContent',(b->>'leads')::int,(b->>'qualified')::int,(b->>'booked')::int,(b->>'sold')::int,(b->>'customers')::int) ORDER BY b->>'utmContent'),'[]'::jsonb)
      INTO canon_computed FROM jsonb_array_elements(computed) b;
    SELECT coalesce(jsonb_agg(jsonb_build_array(b->>'utmContent',(b->>'leads')::int,(b->>'qualified')::int,(b->>'booked')::int,(b->>'sold')::int,(b->>'customers')::int) ORDER BY b->>'utmContent'),'[]'::jsonb)
      INTO canon_claimed FROM jsonb_array_elements(coalesce(a#>'{read,buckets}','[]'::jsonb)) b;
    IF canon_claimed IS DISTINCT FROM canon_computed THEN RAISE EXCEPTION 'Outcomes changed since these findings were prepared. Refresh and review them again.' USING ERRCODE='55000'; END IF;
    -- Every observation or comparison must cite at least one observed bucket; only gaps may stand without evidence.
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(a#>'{snapshot,findings}') f WHERE f->>'kind' NOT IN ('observation','comparison','gap')
        OR (f->>'kind'<>'gap' AND (jsonb_typeof(f->'evidence') IS DISTINCT FROM 'array' OR jsonb_array_length(f->'evidence')=0))) THEN
      RAISE EXCEPTION 'A finding cites outcomes that were not observed.' USING ERRCODE='55000'; END IF;
    FOR e IN SELECT x FROM jsonb_array_elements(a#>'{snapshot,findings}') f, jsonb_array_elements(coalesce(f->'evidence','[]'::jsonb)) x LOOP
      -- Exact ordered equality (jsonb array containment would ignore order and could accept swapped counts).
      IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(canon_computed) c
          WHERE c=jsonb_build_array(e->>'utmContent',(e->>'leads')::int,(e->>'qualified')::int,(e->>'booked')::int,(e->>'sold')::int,(e->>'customers')::int))
        OR e->>'utmCampaign' IS DISTINCT FROM a->>'utmCampaign' THEN
        RAISE EXCEPTION 'A finding cites outcomes that were not observed.' USING ERRCODE='55000'; END IF;
    END LOOP;
    INSERT INTO app.creative_studio_findings(workspace_id,id,campaign_id,utm_campaign,evidence,data,recorded_by)
      VALUES(p_workspace,(a->>'id')::uuid,(a->>'campaignId')::uuid,a->>'utmCampaign',computed,a,actor);
    rid:=a->>'id';
  ELSE
    a:=p_input->'pattern';
    IF a->>'decidedBy' IS DISTINCT FROM actor::text OR coalesce(a->>'id','') !~ '^[0-9a-f-]{36}$' OR coalesce(a->>'patternId','') !~ '^[0-9a-f-]{36}$' THEN
      RAISE EXCEPTION 'Invalid pattern decision' USING ERRCODE='22023'; END IF;
    SELECT * INTO latest FROM app.creative_studio_patterns WHERE workspace_id=p_workspace AND pattern_id=(a->>'patternId')::uuid ORDER BY created_at DESC,id DESC LIMIT 1;
    IF p_action='pattern_withdraw' THEN
      IF latest.id IS NULL OR latest.state<>'shared' THEN RAISE EXCEPTION 'Only a currently shared pattern can be withdrawn.' USING ERRCODE='55000'; END IF;
      INSERT INTO app.creative_studio_patterns(workspace_id,id,pattern_id,finding_id,state,statement,decided_by) VALUES(p_workspace,(a->>'id')::uuid,latest.pattern_id,latest.finding_id,'withdrawn',latest.statement,actor);
    ELSE
      IF latest.id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM app.creative_studio_findings WHERE workspace_id=p_workspace AND id::text=a->>'findingId') THEN
        RAISE EXCEPTION 'Share a pattern from one of this brand''s recorded findings.' USING ERRCODE='22023'; END IF;
      -- Nothing brand-specific may travel: brand name, website host and offer names are refused here as well as in the form.
      prof:=app_private.seo_creator_profile(p_workspace);
      FOR term IN SELECT brand->>'name' UNION ALL SELECT regexp_replace(coalesce(brand->>'website',''),'^https?://(www[.])?([^/]+).*$','\2')
        UNION ALL SELECT o->>'name' FROM jsonb_array_elements(coalesce(prof->'offers','[]'::jsonb)) o LOOP
        IF length(coalesce(term,''))>=3 AND position(lower(term) IN lower(a->>'statement'))>0 THEN
          RAISE EXCEPTION 'A shared pattern cannot name this brand, its website or its offers.' USING ERRCODE='22023'; END IF;
      END LOOP;
      INSERT INTO app.creative_studio_patterns(workspace_id,id,pattern_id,finding_id,state,statement,decided_by)
        VALUES(p_workspace,(a->>'id')::uuid,(a->>'patternId')::uuid,(a->>'findingId')::uuid,'shared',btrim(a->>'statement'),actor);
    END IF;
    rid:=a->>'id';
  END IF;
  INSERT INTO app.creative_studio_commands(workspace_id,id,action,input_sha256,result_id,actor_user_id) VALUES(p_workspace,(p_input->>'commandId')::uuid,p_action,p_input->>'inputSha',rid,actor);
  RETURN jsonb_build_object('replayed',false,'id',rid);
END $f$;

REVOKE ALL ON FUNCTION app_private.creative_studio_learning(uuid,bytea,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.creative_studio_learning(uuid,bytea,text,jsonb) TO r72_content_command;

RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_creative_studio_definer;

