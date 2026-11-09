-- 0143 Creative Studio library: owner-only, append-only artwork versions, exact image approvals and
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
  variant_key text NOT NULL CHECK(variant_key ~ '^c[1-9]:(square|portrait|vertical|landscape|article):[0-9]$'),
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
  action text NOT NULL CHECK(action IN ('kit_save','set_create','versions_append','approve','handoff')),
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
CREATE POLICY seo_blog_blobs_creative_read ON app.seo_blog_blobs FOR SELECT TO r72_creative_studio_definer USING(workspace_id=app_private.current_workspace_id());
CREATE POLICY seo_blog_articles_creative_read ON app.seo_blog_articles FOR SELECT TO r72_creative_studio_definer USING(workspace_id=app_private.current_workspace_id());
CREATE POLICY seo_blog_creator_campaigns_creative_read ON app.seo_blog_creator_campaigns FOR SELECT TO r72_creative_studio_definer USING(workspace_id=app_private.current_workspace_id());
GRANT CREATE ON SCHEMA app_private TO r72_creative_studio_definer;
SET LOCAL ROLE r72_creative_studio_definer;

-- Insert one artwork version after independently rechecking brand context, lineage and stored bytes.
CREATE FUNCTION app_private.creative_studio_insert_version(p_workspace uuid,p_actor uuid,p_set uuid,p_v jsonb,p_profile jsonb,p_kit integer)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE k text; expected integer; parent uuid;
BEGIN
  IF p_v->>'brandId' IS DISTINCT FROM p_workspace::text OR p_v->>'setId' IS DISTINCT FROM p_set::text OR p_v->>'createdBy' IS DISTINCT FROM p_actor::text
    OR coalesce(p_v->>'id','') !~ '^[0-9a-f-]{36}$' OR jsonb_typeof(p_v->'issues') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Invalid creative version' USING ERRCODE='22023';
  END IF;
  IF p_profile IS NULL OR p_v#>>'{context,profileVersion}' IS DISTINCT FROM p_profile->>'version'
    OR p_v#>>'{context,factsSha}' IS DISTINCT FROM p_profile->>'factsSha' OR (p_v#>>'{context,kitVersion}')::integer IS DISTINCT FROM p_kit THEN
    RAISE EXCEPTION 'Brand facts or the creative kit changed while rendering. Try again.' USING ERRCODE='55000';
  END IF;
  k:=(p_v->>'conceptKey')||':'||(p_v->>'placement')||':'||(p_v->>'card');
  SELECT coalesce(max(number),0)+1 INTO expected FROM app.creative_studio_versions WHERE workspace_id=p_workspace AND set_id=p_set AND variant_key=k;
  SELECT id INTO parent FROM app.creative_studio_versions WHERE workspace_id=p_workspace AND set_id=p_set AND variant_key=k AND number=expected-1;
  IF (p_v->>'number')::integer IS DISTINCT FROM expected OR (p_v->>'parentVersionId') IS DISTINCT FROM parent::text THEN
    RAISE EXCEPTION 'This artwork changed while you were editing. Refresh and review the current version.' USING ERRCODE='40001';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM app.seo_blog_blobs b WHERE b.workspace_id=p_workspace AND b.id=(p_v#>>'{render,blobId}')::uuid
    AND encode(b.sha256,'hex')=p_v#>>'{render,sha256}' AND b.mime='image/jpeg') THEN
    RAISE EXCEPTION 'Rendered artwork bytes are missing or do not match' USING ERRCODE='42501';
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
      k:=(v->>'conceptKey')||':'||(v->>'placement')||':'||(v->>'card');
      IF k=ANY(keys) THEN RAISE EXCEPTION 'Duplicate artwork variant in one command' USING ERRCODE='22023'; END IF;
      keys:=keys||k;
      PERFORM app_private.creative_studio_insert_version(p_workspace,actor,v_set,v,prof,kit_v);
    END LOOP;
    rid:=v_set::text;
  ELSIF p_action='approve' THEN
    a:=p_input->'approval';
    SELECT * INTO ver FROM app.creative_studio_versions WHERE workspace_id=p_workspace AND id=(a->>'versionId')::uuid;
    IF ver.id IS NULL OR a->>'approvedBy' IS DISTINCT FROM actor::text OR a->>'scope' IS DISTINCT FROM 'image_only' THEN RAISE EXCEPTION 'Artwork version not found' USING ERRCODE='22023'; END IF;
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
    INSERT INTO app.creative_studio_handoffs(workspace_id,id,version_id,approval_id,target,data,created_by) VALUES(p_workspace,(a->>'id')::uuid,ver.id,appr.id,a->'target',a,actor);
    rid:=a->>'id';
  END IF;
  INSERT INTO app.creative_studio_commands(workspace_id,id,action,input_sha256,result_id,actor_user_id) VALUES(p_workspace,(p_input->>'commandId')::uuid,p_action,p_input->>'inputSha',rid,actor);
  RETURN jsonb_build_object('replayed',false,'id',rid);
END $f$;

REVOKE ALL ON FUNCTION app_private.creative_studio_insert_version(uuid,uuid,uuid,jsonb,jsonb,integer),app_private.creative_studio_command(uuid,bytea,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.creative_studio_command(uuid,bytea,text,jsonb) TO r72_content_command;

RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_creative_studio_definer;
