-- 0144 Creative Studio library: owner-only, append-only artwork, storyboard and video versions, exact approvals and
-- draft campaign hand-offs for any programme brand. Additive only; 0001-0143 are unchanged (renumbered from 0143 after MHP took that number; never applied as 0143).
-- Sections 1-4 make no provider call. Section 5 adds typed-brief image generation only through the existing 0137 paid-image
-- admission (operator policy, global lock, brand allowance, receipts), off with a zero studio allowance by default.
-- Section 6 adds brand enquiry capture through the existing CRM lead command, with validated campaign touches.
-- No scheduler, publishing, outreach or ad-spend capability.
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
-- Durable render jobs: the definer reads the claimed job row (never writes it) to bind a worker to one sponsor and command.
GRANT SELECT ON app.seo_blog_jobs TO r72_creative_studio_definer;
CREATE POLICY seo_blog_jobs_creative_read ON app.seo_blog_jobs FOR SELECT TO r72_creative_studio_definer USING(workspace_id=app_private.current_workspace_id());
GRANT EXECUTE ON FUNCTION app_private.can_manage_workspace(uuid,uuid) TO r72_creative_studio_definer;
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

-- The one owner command boundary. Reads and writes require a genuine current managing owner session, with one narrow
-- exception: a worker holding the current lease of a durable creative_render job acts for that job's sponsor (who must
-- still manage the brand), may only read and append rendered versions, and may write only under the job's own command.
-- Approval, hand-off and kit changes always need the owner's session.
CREATE FUNCTION app_private.creative_studio_command(p_workspace uuid,p_session bytea,p_action text,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; prof jsonb; kit_v integer; cmd app.creative_studio_commands; rid text; v jsonb; keys text[]:='{}'; k text;
  ver app.creative_studio_versions; appr app.creative_studio_approvals; v_set uuid; a jsonb; job app.seo_blog_jobs; render_op text; render_set uuid;
BEGIN
  IF p_session IS NULL AND app_private.current_actor_kind()='worker' AND app_private.current_user_id() IS NULL THEN
    IF p_action NOT IN ('render_actor','kit_latest','set_get','version_get','command_get','set_create','versions_append')
      OR coalesce(p_input#>>'{job,id}','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'Not allowed for a render task' USING ERRCODE='42501'; END IF;
    SELECT * INTO job FROM app.seo_blog_jobs WHERE workspace_id=p_workspace AND id=(p_input#>>'{job,id}')::uuid;
    IF job.id IS NULL OR job.state<>'running' OR job.lease_expires_at IS NULL OR job.lease_expires_at<=clock_timestamp()
      OR job.kind<>'write' OR job.data#>>'{payload,stage}' IS DISTINCT FROM 'creative_render'
      OR job.data#>>'{payload,render,schema}' IS DISTINCT FROM 'relaunch72.creative-render/v1'
      OR job.data->>'leaseOwner' IS DISTINCT FROM p_input#>>'{job,leaseOwner}' OR job.data->>'attempts' IS DISTINCT FROM p_input#>>'{job,attempt}'
      OR coalesce(job.data#>>'{payload,render,sponsorUserId}','') !~ '^[0-9a-f-]{36}$' THEN
      RAISE EXCEPTION 'This render task is not running under this claim' USING ERRCODE='42501'; END IF;
    actor:=(job.data#>>'{payload,render,sponsorUserId}')::uuid;
    IF NOT app_private.can_manage_workspace(actor,p_workspace) THEN RAISE EXCEPTION 'The requesting owner no longer manages this brand' USING ERRCODE='42501'; END IF;
    IF p_action IN ('command_get','set_create','versions_append') AND p_input->>'commandId' IS DISTINCT FROM job.data#>>'{payload,render,commandId}' THEN
      RAISE EXCEPTION 'A render task may only write its own command' USING ERRCODE='42501'; END IF;
    -- Writes are bound to the operation the owner queued: a draft may only create its set; every other operation may
    -- only append to the set it names (directly, or through the version it edits).
    render_op:=job.data#>>'{payload,render,operation,op}';
    IF p_action='set_create' AND render_op IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION 'Only a draft task may create an artwork set' USING ERRCODE='42501'; END IF;
    IF p_action='versions_append' THEN
      render_set:=CASE WHEN render_op IN ('refresh','edit','storyboard') AND coalesce(job.data#>>'{payload,render,operation,setId}','') ~ '^[0-9a-f-]{36}$'
          THEN (job.data#>>'{payload,render,operation,setId}')::uuid
        WHEN render_op IN ('focal','storyboard_edit','video') AND coalesce(job.data#>>'{payload,render,operation,versionId}','') ~ '^[0-9a-f-]{36}$'
          THEN (SELECT set_id FROM app.creative_studio_versions WHERE workspace_id=p_workspace AND id=(job.data#>>'{payload,render,operation,versionId}')::uuid) END;
      IF render_set IS NULL OR coalesce(p_input->>'setId','') !~ '^[0-9a-f-]{36}$' OR (p_input->>'setId')::uuid<>render_set THEN
        RAISE EXCEPTION 'A render task may only add to its own artwork set' USING ERRCODE='42501'; END IF;
    END IF;
    IF p_action='render_actor' THEN RETURN to_jsonb(actor::text); END IF;
  ELSE
    actor:=app_private.seo_media_owner(p_workspace,p_session);
  END IF;
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
    -- Qualified: the owner's mapped stage (by id) or a later non-lost stage of that pipeline, or a won opportunity.
    -- Without a mapping only won opportunities count, and the read says so (no slug is trusted).
    -- Outcomes count only when they happened at or after the touch, so an old customer who sends a new enquiry does not
    -- hand their earlier purchase to this campaign. An enquiry touch is judged by the opportunity it created; "customer"
    -- for an enquiry touch requires that the enquiry created the contact or its own opportunity was won.
    RETURN (WITH cap AS (SELECT c.pipeline_id,s.position AS qpos FROM app.creative_studio_capture c JOIN app.pipeline_stages s
          ON s.workspace_id=c.workspace_id AND s.id=c.qualified_stage_id WHERE c.workspace_id=p_workspace),
      reached AS (SELECT s.id FROM app.pipeline_stages s JOIN cap ON s.pipeline_id=cap.pipeline_id WHERE s.workspace_id=p_workspace AND s.position>=cap.qpos AND s.stage_type<>'lost'),
      touches AS (
        SELECT contact_id,utm_content,attributed_at,NULL::uuid AS opportunity_id,NULL::boolean AS created_contact FROM app.contact_attribution_facts WHERE workspace_id=p_workspace AND utm_campaign=campaign
        UNION ALL
        SELECT contact_id,utm_content,attributed_at,NULL::uuid,NULL::boolean FROM app.contact_import_attribution_facts WHERE workspace_id=p_workspace AND utm_campaign=campaign
        UNION ALL
        SELECT contact_id,utm_content,captured_at,opportunity_id,created_contact FROM app.creative_studio_lead_touches WHERE workspace_id=p_workspace AND utm_campaign=campaign),
      latest AS (SELECT DISTINCT ON (t.contact_id) t.contact_id,coalesce(t.utm_content,'') AS content,t.attributed_at,t.opportunity_id,t.created_contact
        FROM touches t JOIN app.contacts c ON c.workspace_id=p_workspace AND c.id=t.contact_id AND c.deleted_at IS NULL
        ORDER BY t.contact_id,t.attributed_at DESC),
      -- Opportunities that may speak for a touch: the enquiry's own, or (legacy touches) any of the contact's opportunities.
      opps AS (SELECT l.contact_id,o.id,
          (o.status='won' AND (l.opportunity_id IS NOT NULL OR coalesce(o.closed_at,o.created_at)>=l.attributed_at)) AS won,
          ((o.stage_id IN (SELECT id FROM reached) AND (l.opportunity_id IS NOT NULL OR o.created_at>=l.attributed_at))
            OR EXISTS(SELECT 1 FROM app.opportunity_stage_history h WHERE h.workspace_id=p_workspace AND h.opportunity_id=o.id AND h.to_stage_id IN (SELECT id FROM reached)
              AND (l.opportunity_id IS NOT NULL OR h.changed_at>=l.attributed_at))) AS reached_stage
        FROM latest l JOIN app.opportunities o ON o.workspace_id=p_workspace AND o.contact_id=l.contact_id AND (l.opportunity_id IS NULL OR o.id=l.opportunity_id)),
      facts AS (SELECT l.content,l.contact_id,l.attributed_at,
        EXISTS(SELECT 1 FROM opps x WHERE x.contact_id=l.contact_id AND (x.won OR x.reached_stage)) AS qualified,
        EXISTS(SELECT 1 FROM app.conversion_milestone_facts f WHERE f.workspace_id=p_workspace AND f.contact_id=l.contact_id AND f.milestone_semantic='appointment' AND f.occurred_at>=l.attributed_at) AS booked,
        EXISTS(SELECT 1 FROM app.conversion_commerce_facts f WHERE f.workspace_id=p_workspace AND f.contact_id=l.contact_id AND f.fact_type='payment_collected' AND f.occurred_at>=l.attributed_at)
          OR EXISTS(SELECT 1 FROM app.conversion_milestone_facts f WHERE f.workspace_id=p_workspace AND f.contact_id=l.contact_id AND f.milestone_semantic='sale' AND f.occurred_at>=l.attributed_at)
          OR EXISTS(SELECT 1 FROM opps x WHERE x.contact_id=l.contact_id AND x.won) AS sold,
        EXISTS(SELECT 1 FROM app.conversion_commerce_facts f WHERE f.workspace_id=p_workspace AND f.contact_id=l.contact_id AND f.fact_type='subscription_cancelled' AND f.occurred_at>=l.attributed_at) AS cancelled,
        ((SELECT c.lifecycle_status='customer' FROM app.contacts c WHERE c.workspace_id=p_workspace AND c.id=l.contact_id)
          AND (l.opportunity_id IS NULL OR l.created_contact OR EXISTS(SELECT 1 FROM opps x WHERE x.contact_id=l.contact_id AND x.won))) AS customer
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
    RETURN jsonb_build_object('utmCampaign',campaign,'readAt',clock_timestamp(),'buckets',app_private.creative_studio_outcome_buckets(p_workspace,campaign),
      'qualifiedMapped',EXISTS(SELECT 1 FROM app.creative_studio_capture WHERE workspace_id=p_workspace));
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



-- ─── 0144 section 5: genuinely new images from a typed Creative Studio brief ───
-- Reuses the existing paid article-image boundary (0137) instead of a second one: the same provider transport,
-- seo_blog_image_attempts, operator policy and global admission lock, per-brand image allowance and usage debit,
-- receipt recording, private candidate storage, uncertain-outcome holds and the existing worker job table.
-- A brief is an immutable owner-written version bound to this brand; a generated image is a private candidate,
-- never an approval. Studio generation is off with a zero allowance until a managing owner configures it.
CREATE TABLE app.creative_studio_briefs(
  workspace_id uuid NOT NULL REFERENCES app.seo_blog_brands(workspace_id), id uuid NOT NULL, version integer NOT NULL CHECK(version BETWEEN 1 AND 1000),
  data jsonb NOT NULL CHECK(jsonb_typeof(data)='object' AND octet_length(data::text)<=8192),
  created_by uuid NOT NULL REFERENCES app.users(id), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,id,version)
);
CREATE TABLE app.creative_studio_generations(
  workspace_id uuid NOT NULL REFERENCES app.seo_blog_brands(workspace_id), id uuid NOT NULL, brief_id uuid NOT NULL, brief_version integer NOT NULL,
  job_id uuid NOT NULL, intent_id uuid NOT NULL, attempt_id uuid NOT NULL, candidate_asset_id uuid NOT NULL,
  candidate_sha256 text NOT NULL CHECK(candidate_sha256 ~ '^[0-9a-f]{64}$'),
  width integer NOT NULL CHECK(width BETWEEN 256 AND 4096), height integer NOT NULL CHECK(height BETWEEN 256 AND 4096),
  data jsonb NOT NULL CHECK(jsonb_typeof(data)='object' AND octet_length(data::text)<=8192),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,attempt_id),
  FOREIGN KEY(workspace_id,brief_id,brief_version) REFERENCES app.creative_studio_briefs(workspace_id,id,version),
  FOREIGN KEY(workspace_id,candidate_asset_id) REFERENCES app.seo_blog_media_assets(workspace_id,id)
);
DO $generation$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['creative_studio_briefs','creative_studio_generations'] LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON app.%I FROM PUBLIC,r72_content_command,r72_web,r72_worker',t);
    EXECUTE format('CREATE POLICY %I ON app.%I FOR ALL TO r72_owner USING(true) WITH CHECK(true)',t||'_owner',t);
    EXECUTE format('CREATE POLICY %I ON app.%I FOR ALL TO r72_seo_media_definer USING(workspace_id=app_private.current_workspace_id()) WITH CHECK(workspace_id=app_private.current_workspace_id())',t||'_media',t);
    EXECUTE format('CREATE POLICY %I ON app.%I FOR SELECT TO r72_creative_studio_definer USING(workspace_id=app_private.current_workspace_id())',t||'_studio_read',t);
    EXECUTE format('GRANT SELECT,INSERT ON app.%I TO r72_seo_media_definer',t);
    EXECUTE format('GRANT SELECT ON app.%I TO r72_creative_studio_definer',t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON app.%I FOR EACH ROW EXECUTE FUNCTION app_private.seo_blog_append_only()',t||'_immutable',t);
    INSERT INTO app_private.workspace_table_registry(schema_name,table_name,workspace_column) VALUES('app',t,'workspace_id');
  END LOOP;
END $generation$;
-- Brief and generation commands reuse the studio command ledger for replay.
GRANT SELECT,INSERT ON app.creative_studio_commands TO r72_seo_media_definer;
CREATE POLICY creative_studio_commands_media ON app.creative_studio_commands FOR ALL TO r72_seo_media_definer
  USING(workspace_id=app_private.current_workspace_id()) WITH CHECK(workspace_id=app_private.current_workspace_id());
ALTER TABLE app.creative_studio_commands DROP CONSTRAINT creative_studio_commands_action_check;
ALTER TABLE app.creative_studio_commands ADD CONSTRAINT creative_studio_commands_action_check
  CHECK(action IN ('kit_save','set_create','versions_append','approve','handoff','finding_record','pattern_share','pattern_withdraw','brief_save','render_enqueue'));

RESET ROLE;
SET LOCAL ROLE r72_owner;
GRANT CREATE ON SCHEMA app_private TO r72_seo_media_definer;
SET LOCAL ROLE r72_seo_media_definer;

-- The live source for one exact brief version: the same profile/knowledge evidence the article source uses, the brief,
-- and its reference images re-validated as current, non-withdrawn private assets of this brand. NULL when unusable.
CREATE FUNCTION app_private.creative_studio_brief_source(p_workspace uuid,p_brief uuid,p_version integer)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE profile jsonb; documents jsonb; visual jsonb; brief app.creative_studio_briefs%ROWTYPE; website text; brand_name text; snapshot jsonb; ref jsonb;
BEGIN
  SELECT * INTO brief FROM app.creative_studio_briefs WHERE workspace_id=p_workspace AND id=p_brief AND version=p_version;
  IF brief.id IS NULL THEN RETURN NULL; END IF;
  FOR ref IN SELECT x FROM jsonb_array_elements(coalesce(brief.data->'references','[]'::jsonb)) x LOOP
    IF NOT EXISTS(SELECT 1 FROM app.seo_blog_media_assets m WHERE m.workspace_id=p_workspace AND m.id::text=ref->>'assetId'
        AND encode(m.byte_sha256,'hex')=ref->>'sha256') OR app_private.seo_media_withdrawn(p_workspace,(ref->>'assetId')::uuid,NULL) THEN
      RETURN NULL; END IF;
  END LOOP;
  SELECT data INTO profile FROM app.seo_blog_records WHERE workspace_id=p_workspace AND kind='profile' ORDER BY id DESC LIMIT 1;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',d.data->'id','version',d.data->'version','category',d.data->'category','title',d.data->'title',
    'sha256',d.data->'sha256','blobId',d.data->'blobId','status',d.data->'status',
    'hasText',length(coalesce(d.data->>'text',''))>0,'textSha256',encode(public.digest(coalesce(d.data->>'text',''),'sha256'),'hex')) ORDER BY d.data->>'id'),'[]') INTO documents FROM (
    SELECT DISTINCT ON (r.data->>'id') r.data FROM app.seo_blog_records r
    WHERE workspace_id=p_workspace AND kind='knowledge' ORDER BY r.data->>'id',(r.data->>'version')::integer DESC
  ) d WHERE coalesce((d.data->>'active')::boolean,false);
  SELECT b.website INTO website FROM app.seo_blog_brands b WHERE b.workspace_id=p_workspace;
  SELECT app_private.seo_blog_brand(p_workspace)->>'name' INTO brand_name;
  SELECT coalesce(jsonb_agg(d ORDER BY d->>'id'),'[]') INTO visual FROM jsonb_array_elements(documents) d WHERE d->>'category'='visual_guidance';
  snapshot:=jsonb_build_object('recipe','creative-brief-source-v1','brandName',brand_name,'profile',profile,'knowledge',documents,'website',website,
    'briefId',brief.id,'briefVersion',brief.version,'brief',brief.data,'briefCreatedBy',brief.created_by);
  RETURN jsonb_build_object('recipe','creative-brief-source-v1','workspaceId',p_workspace,'briefId',brief.id,'briefVersion',brief.version,
    'snapshot',snapshot,'sourceSha256',encode(public.digest(snapshot::text,'sha256'),'hex'),
    'profileSha256',encode(public.digest(coalesce(profile,'null')::text,'sha256'),'hex'),
    'visualSha256',encode(public.digest(visual::text,'sha256'),'hex'));
END $f$;

-- Studio holds: the studio's own switch (not the blog-image switch), the programme pause, a confirmed profile whose
-- factual documents are unchanged, and a sponsor who can still manage this brand.
CREATE FUNCTION app_private.creative_studio_image_hold(p_workspace uuid,p_source jsonb,p_sponsor uuid)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE settings jsonb; profile jsonb:=p_source#>'{snapshot,profile}'; documents jsonb:=p_source#>'{snapshot,knowledge}'; current_refs jsonb; approved_refs jsonb;
BEGIN
  SELECT b.settings INTO settings FROM app.seo_blog_brands b WHERE b.workspace_id=p_workspace;
  IF settings IS NULL OR p_source IS NULL THEN RETURN 'source_missing'; END IF;
  IF settings#>'{studioImages,enabled}' IS DISTINCT FROM 'true'::jsonb THEN RETURN 'studio_generation_disabled'; END IF;
  IF coalesce((settings->>'pauseAll')::boolean,false) THEN RETURN 'programme_paused'; END IF;
  IF profile IS NULL OR profile->>'confirmedAt' IS NULL THEN RETURN 'profile_unconfirmed'; END IF;
  IF p_sponsor IS NULL OR NOT app_private.can_manage_workspace(p_sponsor,p_workspace) THEN RETURN 'sponsor_ineligible'; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',d->>'id','sha',d->>'sha256') ORDER BY d->>'id'),'[]') INTO current_refs
    FROM jsonb_array_elements(coalesce(documents,'[]')) d WHERE d->>'category'=ANY(ARRAY['product_facts','approved_claims','faqs','brand_guidelines','other'])
      AND coalesce((d->>'hasText')::boolean,false);
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',d->>'documentId','sha',d->>'sha256') ORDER BY d->>'documentId'),'[]') INTO approved_refs
    FROM jsonb_array_elements(coalesce(profile->'knowledge','[]')) d WHERE d->>'category'=ANY(ARRAY['product_facts','approved_claims','faqs','brand_guidelines','other']);
  IF current_refs IS DISTINCT FROM approved_refs THEN RETURN 'profile_facts_changed'; END IF;
  RETURN NULL;
END $f$;

CREATE OR REPLACE FUNCTION app_private.seo_image_reserve(p_workspace uuid,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE job app.seo_blog_jobs%ROWTYPE; image jsonb; source jsonb; existing app.seo_blog_image_attempts%ROWTYPE;
  policy app_private.seo_image_operator_policy%ROWTYPE; reason text; sponsor uuid; attempt_id uuid:=gen_random_uuid();
  nonce uuid:=(p_input->>'nonce')::uuid; this_period date:=(date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC'))::date;
  active_count bigint; reserved numeric; brand_volume bigint; image_limit bigint; policy_result jsonb;
  creative boolean; studio_volume bigint; studio_limit bigint;
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
  -- 0144: a Creative Studio typed brief is a second, explicitly validated source kind. Everything after the
  -- source check (operator policy, global lock, concurrency, cost and brand allowance) is shared and unchanged.
  creative:=image->>'schema'='relaunch72.creative-image-intent/v1';
  IF creative THEN
    IF job.id IS NULL OR job.kind<>'write' OR job.data#>>'{payload,stage}' IS DISTINCT FROM 'image'
      OR image->>'sourceSnapshotVersion' IS DISTINCT FROM 'creative-brief-source-v1'
      OR job.state<>'running' OR job.lease_expires_at<=clock_timestamp() OR job.lease_expires_at IS NULL
      OR job.data->>'leaseOwner' IS DISTINCT FROM p_input->>'leaseOwner'
      OR job.data->>'attempts' IS DISTINCT FROM p_input->>'leaseAttempt'
      OR image->>'intentId' IS DISTINCT FROM p_input->>'intentId'
      OR image->>'intentSha256' IS DISTINCT FROM p_input->>'intentSha256'
      OR image->>'requestSha256' IS DISTINCT FROM p_input->>'requestSha256'
      OR image->>'sourceSha256' IS DISTINCT FROM p_input->>'sourceSha256' OR image->>'profileSha256' IS DISTINCT FROM p_input->>'profileSha256'
      OR image->>'visualSha256' IS DISTINCT FROM p_input->>'visualSha256'
      OR image->>'briefId' IS DISTINCT FROM p_input->>'briefId' OR image->>'briefVersion' IS DISTINCT FROM p_input->>'briefVersion'
      OR image->>'sponsorUserId' IS DISTINCT FROM p_input->>'sponsorUserId'
      OR image->>'sourceSnapshotVersion' IS DISTINCT FROM p_input->>'sourceSnapshotVersion' THEN
      RETURN jsonb_build_object('kind','held','reason','claim_or_intent_changed');
    END IF;
    source:=app_private.creative_studio_brief_source(p_workspace,(image->>'briefId')::uuid,(image->>'briefVersion')::integer);
    IF source IS DISTINCT FROM image->'source' OR source->'snapshot' IS DISTINCT FROM image->'sourceSnapshot'
      OR source->>'sourceSha256' IS DISTINCT FROM image->>'sourceSha256' OR source->>'profileSha256' IS DISTINCT FROM image->>'profileSha256'
      OR source->>'visualSha256' IS DISTINCT FROM image->>'visualSha256' THEN
      RETURN jsonb_build_object('kind','held','reason','source_changed');
    END IF;
    sponsor:=(image->>'sponsorUserId')::uuid;
    reason:=app_private.creative_studio_image_hold(p_workspace,source,sponsor);
    IF reason IS NOT NULL THEN RETURN jsonb_build_object('kind','held','reason',reason); END IF;
  ELSE
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
  END IF;
  IF NOT coalesce((p_input->>'providerConfigured')::boolean,false) THEN RETURN jsonb_build_object('kind','held','reason','provider_unconfigured'); END IF;
  -- The caller already owns its job row; aggregate other brands without row-locking them.
  -- A real row UPDATE gives SERIALIZABLE snapshots a conflict even if the visible aggregate is stale.
  UPDATE app_private.seo_image_operator_policy SET admission_epoch=admission_epoch+1 WHERE singleton RETURNING * INTO policy;
  reason:=CASE WHEN creative THEN app_private.creative_studio_image_hold(p_workspace,source,sponsor)
    ELSE app_private.seo_image_source_hold(p_workspace,source,sponsor,coalesce((image->>'automatic')::boolean,true)) END;
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
  -- Studio briefs also need their own owner-set studio allowance (default zero); the brand image allowance above stays shared.
  IF creative THEN
    SELECT CASE WHEN settings#>'{studioImages,enabled}'='true'::jsonb AND jsonb_typeof(settings#>'{studioImages,perMonth}')='number'
      THEN (settings#>>'{studioImages,perMonth}')::bigint ELSE 0 END INTO studio_limit FROM app.seo_blog_brands WHERE workspace_id=p_workspace;
    SELECT count(*) INTO studio_volume FROM app.seo_blog_image_attempts a WHERE a.workspace_id=p_workspace
      AND a.source_snapshot->>'recipe'='creative-brief-source-v1'
      AND (a.allowance_period=this_period OR a.outcome IN ('started','outcome_unknown'));
    IF studio_limit<=0 OR studio_volume>=studio_limit THEN RETURN jsonb_build_object('kind','held','reason','studio_image_allowance'); END IF;
  END IF;
  INSERT INTO app.seo_blog_image_attempts(id,workspace_id,job_id,intent_id,start_nonce,lease_owner,lease_attempt,intent_sha256,request_sha256,
    source_sha256,visual_sha256,profile_sha256,source_snapshot,sponsor_user_id,model,quality,allowance_period,reserved_microusd,
    policy_version,policy_sha256,policy_snapshot) VALUES(attempt_id,p_workspace,job.id,(image->>'intentId')::uuid,nonce,p_input->>'leaseOwner',
      (p_input->>'leaseAttempt')::integer,decode(image->>'intentSha256','hex'),decode(image->>'requestSha256','hex'),
      decode(source->>'sourceSha256','hex'),decode(source->>'visualSha256','hex'),decode(source->>'profileSha256','hex'),source,sponsor,
      image->>'model',image->>'quality',this_period,(policy.config->>'perAttemptMicrousd')::bigint,policy.version,policy.sha256,policy.config);
  policy_result:=policy.config||jsonb_build_object('version',policy.version,'sha256',encode(policy.sha256,'hex'),'admissionEpoch',policy.admission_epoch);
  RETURN jsonb_build_object('kind','admitted','attemptId',attempt_id,'nonce',nonce,'policy',policy_result);
END $f$;

CREATE OR REPLACE FUNCTION app_private.seo_image_apply_hold(p_workspace uuid,p_attempt uuid,p_nonce uuid,p_lease_owner text,p_lease_attempt integer)
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
  -- 0144: a paid studio image is recorded privately (never approved or published) once its sponsor can still manage the
  -- brand; later brief, profile or policy changes do not discard pixels that were already paid for.
  IF attempt.source_snapshot->>'recipe'='creative-brief-source-v1' THEN
    IF job.data#>>'{payload,image,schema}' IS DISTINCT FROM 'relaunch72.creative-image-intent/v1' THEN RETURN 'claim_changed'; END IF;
    IF NOT app_private.can_manage_workspace(attempt.sponsor_user_id,p_workspace) THEN RETURN 'sponsor_ineligible'; END IF;
    RETURN NULL;
  END IF;
  source:=app_private.seo_image_source(p_workspace,(attempt.source_snapshot->>'articleId')::uuid);
  IF source IS DISTINCT FROM attempt.source_snapshot THEN RETURN 'source_changed'; END IF;
  reason:=app_private.seo_image_source_hold(p_workspace,source,attempt.sponsor_user_id,coalesce((job.data#>>'{payload,image,automatic}')::boolean,true));
  IF reason IS NOT NULL THEN RETURN reason; END IF;
  SELECT * INTO policy FROM app_private.seo_image_operator_policy WHERE singleton FOR SHARE;
  IF NOT coalesce((policy.config->>'enabled')::boolean,false) THEN RETURN 'operator_policy_disabled'; END IF;
  IF policy.version IS DISTINCT FROM attempt.policy_version OR policy.sha256 IS DISTINCT FROM attempt.policy_sha256 THEN RETURN 'operator_policy_changed'; END IF;
  RETURN NULL;
END $f$;

-- Owner or worker read of one brief version's live source (as seo_image_read_source does for an article).
CREATE FUNCTION app_private.creative_studio_read_brief_source(p_workspace uuid,p_session bytea,p_brief uuid,p_version integer)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
  PERFORM app_private.seo_media_private_actor(p_workspace,p_session);
  PERFORM app_private.seo_media_lock_brand(p_workspace);
  RETURN app_private.creative_studio_brief_source(p_workspace,p_brief,p_version);
END $f$;

-- Owner command: save one immutable brief version. The brief describes only the picture; headlines, prices,
-- logos and disclosures are composited exactly later and are never sent to the image provider.
CREATE FUNCTION app_private.creative_studio_save_brief(p_workspace uuid,p_session bytea,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; cmd app.creative_studio_commands; b jsonb:=p_input->'brief'; next_version integer; ref jsonb; refs integer;
BEGIN
  actor:=app_private.seo_media_owner(p_workspace,p_session);
  IF app_private.seo_blog_brand(p_workspace) IS NULL THEN RAISE EXCEPTION 'Brand unavailable' USING ERRCODE='42501'; END IF;
  IF coalesce(p_input->>'commandId','') !~ '^[0-9a-f-]{36}$' OR coalesce(p_input->>'inputSha','') !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'Invalid brief command' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('r72-creative-studio:'||p_workspace::text,0));
  SELECT * INTO cmd FROM app.creative_studio_commands WHERE workspace_id=p_workspace AND id=(p_input->>'commandId')::uuid;
  IF cmd.id IS NOT NULL THEN
    IF cmd.input_sha256 IS DISTINCT FROM p_input->>'inputSha' OR cmd.action<>'brief_save' THEN RAISE EXCEPTION 'This request was already used for different content' USING ERRCODE='40001'; END IF;
    RETURN jsonb_build_object('replayed',true,'id',cmd.result_id);
  END IF;
  refs:=jsonb_array_length(coalesce(b->'references','[]'::jsonb));
  IF jsonb_typeof(b) IS DISTINCT FROM 'object' OR coalesce(b->>'id','') !~ '^[0-9a-f-]{36}$'
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(b) k WHERE k<>ALL(ARRAY['id','text','size','references','useVisualGuidance','title']))
    OR length(coalesce(b->>'text','')) NOT BETWEEN 10 AND 1500 OR b->>'text' ~* '(https?:|www[.]|@)' OR b->>'text' ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]'
    OR length(coalesce(b->>'title','')) NOT BETWEEN 1 AND 80
    OR coalesce(b->>'size','') NOT IN ('1536x1024','1024x1024','1024x1536')
    OR jsonb_typeof(b->'useVisualGuidance') IS DISTINCT FROM 'boolean'
    OR jsonb_typeof(coalesce(b->'references','[]'::jsonb))<>'array' OR refs>3 THEN
    RAISE EXCEPTION 'Check the image brief: describe the picture in 10 to 1500 characters without links, and choose a supported size.' USING ERRCODE='22023';
  END IF;
  FOR ref IN SELECT x FROM jsonb_array_elements(coalesce(b->'references','[]'::jsonb)) x LOOP
    IF jsonb_typeof(ref)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(ref))<>2 OR coalesce(ref->>'assetId','') !~ '^[0-9a-f-]{36}$' OR coalesce(ref->>'sha256','') !~ '^[0-9a-f]{64}$'
      OR NOT EXISTS(SELECT 1 FROM app.seo_blog_media_assets m WHERE m.workspace_id=p_workspace AND m.id::text=ref->>'assetId' AND encode(m.byte_sha256,'hex')=ref->>'sha256')
      OR app_private.seo_media_withdrawn(p_workspace,(ref->>'assetId')::uuid,NULL) THEN
      RAISE EXCEPTION 'A reference image is not a current private image of this brand.' USING ERRCODE='22023'; END IF;
  END LOOP;
  SELECT coalesce(max(version),0)+1 INTO next_version FROM app.creative_studio_briefs WHERE workspace_id=p_workspace AND id=(b->>'id')::uuid;
  INSERT INTO app.creative_studio_briefs(workspace_id,id,version,data,created_by) VALUES(p_workspace,(b->>'id')::uuid,next_version,b-'id',actor);
  INSERT INTO app.creative_studio_commands(workspace_id,id,action,input_sha256,result_id,actor_user_id)
    VALUES(p_workspace,(p_input->>'commandId')::uuid,'brief_save',p_input->>'inputSha',(b->>'id')||':'||next_version,actor);
  RETURN jsonb_build_object('replayed',false,'id',(b->>'id')||':'||next_version);
END $f$;

-- Owner intent check (mirrors seo_image_check_intent for a brief): active work for the same exact brief version wins,
-- and once that version has a paid attempt, another paid generation needs an explicit new intent naming the last one.
CREATE FUNCTION app_private.creative_studio_check_image_intent(p_workspace uuid,p_session bytea,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; sponsor uuid:=(p_input->>'sponsorUserId')::uuid; source jsonb; reason text; retained app.seo_blog_jobs%ROWTYPE; prior app.seo_blog_image_attempts%ROWTYPE;
BEGIN
  actor:=app_private.seo_media_private_actor(p_workspace,p_session);
  IF actor IS NULL OR actor IS DISTINCT FROM sponsor THEN RAISE EXCEPTION 'Studio image intent requires the genuine requesting owner' USING ERRCODE='42501'; END IF;
  PERFORM app_private.seo_media_lock_brand(p_workspace);
  SELECT * INTO retained FROM app.seo_blog_jobs j WHERE j.workspace_id=p_workspace AND j.kind='write'
    AND j.data#>>'{payload,stage}'='image' AND j.data#>>'{payload,image,schema}'='relaunch72.creative-image-intent/v1'
    AND j.data#>>'{payload,image,briefId}'=p_input#>>'{source,briefId}' AND j.data#>>'{payload,image,briefVersion}'=p_input#>>'{source,briefVersion}'
    AND j.state IN ('queued','running') ORDER BY j.created_at,j.id LIMIT 1;
  IF retained.id IS NOT NULL THEN RETURN jsonb_build_object('kind','existing_job','job',retained.data||jsonb_build_object('state',retained.state,'rowVersion',retained.row_version)); END IF;
  SELECT * INTO prior FROM app.seo_blog_image_attempts a WHERE a.workspace_id=p_workspace AND a.source_snapshot->>'recipe'='creative-brief-source-v1'
    AND a.source_snapshot->>'briefId'=p_input#>>'{source,briefId}' AND a.source_snapshot->>'briefVersion'=p_input#>>'{source,briefVersion}'
    ORDER BY a.created_at DESC,a.id DESC LIMIT 1;
  IF prior.id IS NOT NULL AND (p_input->'confirmedNewIntent' IS DISTINCT FROM 'true'::jsonb OR p_input->>'replacesIntentId' IS DISTINCT FROM prior.intent_id::text) THEN
    RETURN jsonb_build_object('kind','held','reason','new_intent_confirmation_required','replacesIntentId',prior.intent_id);
  END IF;
  source:=app_private.creative_studio_brief_source(p_workspace,(p_input#>>'{source,briefId}')::uuid,(p_input#>>'{source,briefVersion}')::integer);
  IF source IS NULL OR source IS DISTINCT FROM p_input->'source' THEN RETURN jsonb_build_object('kind','held','reason','source_changed'); END IF;
  reason:=app_private.creative_studio_image_hold(p_workspace,source,sponsor);
  IF reason IS NOT NULL THEN RETURN jsonb_build_object('kind','held','reason',reason); END IF;
  RETURN jsonb_build_object('kind','ready','source',source);
END $f$;

-- Owner reads: brief versions, generation jobs and results, and this month's studio and brand image usage.
CREATE FUNCTION app_private.creative_studio_generation_state(p_workspace uuid,p_session bytea,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; this_period date:=(date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC'))::date; brief_filter uuid; gen_filter uuid;
BEGIN
  actor:=app_private.seo_media_owner(p_workspace,p_session);
  IF app_private.seo_blog_brand(p_workspace) IS NULL THEN RAISE EXCEPTION 'Brand unavailable' USING ERRCODE='42501'; END IF;
  brief_filter:=CASE WHEN coalesce(p_input->>'briefId','') ~ '^[0-9a-f-]{36}$' THEN (p_input->>'briefId')::uuid END;
  gen_filter:=CASE WHEN coalesce(p_input->>'generationId','') ~ '^[0-9a-f-]{36}$' THEN (p_input->>'generationId')::uuid END;
  RETURN jsonb_build_object(
    'briefs',coalesce((SELECT jsonb_agg(jsonb_build_object('id',b.id,'version',b.version,'data',b.data,'createdBy',b.created_by,'createdAt',b.created_at) ORDER BY b.created_at DESC)
      FROM (SELECT * FROM app.creative_studio_briefs WHERE workspace_id=p_workspace AND (brief_filter IS NULL OR id=brief_filter) ORDER BY created_at DESC LIMIT 60) b),'[]'::jsonb),
    'generations',coalesce((SELECT jsonb_agg(jsonb_build_object('id',g.id,'briefId',g.brief_id,'briefVersion',g.brief_version,'jobId',g.job_id,'intentId',g.intent_id,
        'attemptId',g.attempt_id,'assetId',g.candidate_asset_id,'sha256',g.candidate_sha256,'width',g.width,'height',g.height,'data',g.data,'createdAt',g.created_at) ORDER BY g.created_at DESC)
      FROM (SELECT * FROM app.creative_studio_generations WHERE workspace_id=p_workspace AND (brief_filter IS NULL OR brief_id=brief_filter) AND (gen_filter IS NULL OR id=gen_filter) ORDER BY created_at DESC LIMIT 60) g),'[]'::jsonb),
    'jobs',coalesce((SELECT jsonb_agg(jsonb_build_object('id',j.id,'state',j.state,'briefId',j.data#>>'{payload,image,briefId}','briefVersion',(j.data#>>'{payload,image,briefVersion}')::integer,
        'intentId',j.data#>>'{payload,image,intentId}','progress',j.data->>'progress','error',j.data->>'error','result',j.data#>'{payload,image,result}',
        'paidAttemptStarted',j.data#>'{payload,image,start,nonce}' IS NOT NULL,'createdAt',j.created_at,'updatedAt',j.updated_at) ORDER BY j.created_at DESC)
      FROM (SELECT * FROM app.seo_blog_jobs WHERE workspace_id=p_workspace AND kind='write' AND data#>>'{payload,stage}'='image'
        AND data#>>'{payload,image,schema}'='relaunch72.creative-image-intent/v1'
        AND (brief_filter IS NULL OR data#>>'{payload,image,briefId}'=brief_filter::text) ORDER BY created_at DESC LIMIT 60) j),'[]'::jsonb),
    'attempts',coalesce((SELECT jsonb_agg(jsonb_build_object('jobId',a.job_id,'intentId',a.intent_id,'outcome',a.outcome,'reservedMicrousd',a.reserved_microusd,
        'usage',a.receipts->-1#>'{receipt,usage}','createdAt',a.created_at) ORDER BY a.created_at DESC)
      FROM (SELECT * FROM app.seo_blog_image_attempts WHERE workspace_id=p_workspace AND source_snapshot->>'recipe'='creative-brief-source-v1'
        AND (brief_filter IS NULL OR source_snapshot->>'briefId'=brief_filter::text) ORDER BY created_at DESC LIMIT 60) a),'[]'::jsonb),
    'usage',jsonb_build_object(
      'brandImagesThisMonth',(SELECT coalesce(sum(u.amount),0) FROM app.seo_blog_usage u WHERE u.workspace_id=p_workspace AND u.kind='images'
        AND date_trunc('month',u.at AT TIME ZONE 'UTC')::date=this_period),
      -- Unresolved attempts from earlier months still count against the brand allowance at admission (as seo_image_reserve does).
      'brandUnresolvedEarlier',(SELECT count(*) FROM app.seo_blog_image_attempts a WHERE a.workspace_id=p_workspace
        AND a.allowance_period<this_period AND a.outcome IN ('started','outcome_unknown')),
      'studioImagesCounted',(SELECT count(*) FROM app.seo_blog_image_attempts a WHERE a.workspace_id=p_workspace AND a.source_snapshot->>'recipe'='creative-brief-source-v1'
        AND (a.allowance_period=this_period OR a.outcome IN ('started','outcome_unknown'))),
      'studioUnresolved',(SELECT count(*) FROM app.seo_blog_image_attempts a WHERE a.workspace_id=p_workspace AND a.source_snapshot->>'recipe'='creative-brief-source-v1'
        AND a.outcome IN ('started','outcome_unknown')),
      'period',this_period));
END $f$;

-- Worker boundary: record a received studio candidate as a private generated image of its brief, bound to the exact
-- admitted attempt and current claim. Idempotent per attempt. The caller marks its job done in the same transaction.
CREATE FUNCTION app_private.creative_studio_record_generation(p_workspace uuid,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE attempt app.seo_blog_image_attempts%ROWTYPE; job app.seo_blog_jobs%ROWTYPE; reason text; existing app.creative_studio_generations%ROWTYPE; gid uuid;
BEGIN
  IF app_private.seo_media_private_actor(p_workspace,NULL) IS NOT NULL OR app_private.current_actor_kind()<>'worker' THEN
    RAISE EXCEPTION 'Actual content worker required' USING ERRCODE='42501'; END IF;
  PERFORM app_private.seo_media_lock_brand(p_workspace);
  SELECT * INTO attempt FROM app.seo_blog_image_attempts WHERE workspace_id=p_workspace AND id=(p_input->>'attemptId')::uuid AND start_nonce=(p_input->>'nonce')::uuid;
  IF attempt.id IS NULL OR attempt.source_snapshot->>'recipe' IS DISTINCT FROM 'creative-brief-source-v1' THEN RETURN jsonb_build_object('recorded',false,'hold','attempt_missing'); END IF;
  SELECT * INTO existing FROM app.creative_studio_generations WHERE workspace_id=p_workspace AND attempt_id=attempt.id;
  IF existing.id IS NOT NULL THEN RETURN jsonb_build_object('recorded',true,'replayed',true,'id',existing.id); END IF;
  reason:=app_private.seo_image_apply_hold(p_workspace,attempt.id,attempt.start_nonce,p_input->>'leaseOwner',(p_input->>'leaseAttempt')::integer);
  IF reason IS NOT NULL THEN RETURN jsonb_build_object('recorded',false,'hold',reason); END IF;
  SELECT * INTO job FROM app.seo_blog_jobs WHERE workspace_id=p_workspace AND id=attempt.job_id;
  IF attempt.candidate_asset_id IS NULL OR NOT EXISTS(SELECT 1 FROM app.seo_blog_media_assets m WHERE m.workspace_id=p_workspace AND m.id=attempt.candidate_asset_id
      AND encode(m.byte_sha256,'hex')=p_input->>'candidateSha256' AND m.asset_kind='candidate')
    OR coalesce((p_input->>'width')::integer,0) NOT BETWEEN 256 AND 4096 OR coalesce((p_input->>'height')::integer,0) NOT BETWEEN 256 AND 4096 THEN
    RETURN jsonb_build_object('recorded',false,'hold','candidate_unverified'); END IF;
  gid:=gen_random_uuid();
  INSERT INTO app.creative_studio_generations(workspace_id,id,brief_id,brief_version,job_id,intent_id,attempt_id,candidate_asset_id,candidate_sha256,width,height,data)
    VALUES(p_workspace,gid,(attempt.source_snapshot->>'briefId')::uuid,(attempt.source_snapshot->>'briefVersion')::integer,job.id,attempt.intent_id,attempt.id,
      attempt.candidate_asset_id,p_input->>'candidateSha256',(p_input->>'width')::integer,(p_input->>'height')::integer,
      jsonb_build_object('model',attempt.model,'quality',attempt.quality,'size',job.data#>>'{payload,image,size}','references',jsonb_array_length(coalesce(attempt.source_snapshot#>'{brief,references}','[]'::jsonb)),
        'sponsorUserId',attempt.sponsor_user_id,'reservedMicrousd',attempt.reserved_microusd,'usage',attempt.receipts->-1#>'{receipt,usage}'));
  RETURN jsonb_build_object('recorded',true,'replayed',false,'id',gid);
END $f$;

REVOKE ALL ON FUNCTION app_private.creative_studio_brief_source(uuid,uuid,integer),app_private.creative_studio_image_hold(uuid,jsonb,uuid),
  app_private.creative_studio_read_brief_source(uuid,bytea,uuid,integer),
  app_private.creative_studio_save_brief(uuid,bytea,jsonb),app_private.creative_studio_check_image_intent(uuid,bytea,jsonb),
  app_private.creative_studio_generation_state(uuid,bytea,jsonb),app_private.creative_studio_record_generation(uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.creative_studio_save_brief(uuid,bytea,jsonb),app_private.creative_studio_check_image_intent(uuid,bytea,jsonb),
  app_private.creative_studio_read_brief_source(uuid,bytea,uuid,integer),
  app_private.creative_studio_generation_state(uuid,bytea,jsonb),app_private.creative_studio_record_generation(uuid,jsonb) TO r72_content_command;

RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_seo_media_definer;


-- ─── Section 6: campaign enquiries into the existing CRM, and an explicit qualified-stage mapping ───
-- A brand-scoped public enquiry form (hosted, or embedded on the brand's own page) creates the lead through the existing
-- CRM command (crm.createLead, acting as the owner who switched capture on, as the Growth HQ inbox does). A campaign
-- touch is stored only when the untrusted UTM values match a tracked link this brand actually issued for its own
-- acquisition campaign; malformed or other-brand references are not stored. The affiliate attribution tables are not
-- touched. "Qualified" is read from the owner's mapped stage id (and later non-lost stages of that pipeline), never a slug.
GRANT SELECT,INSERT ON app.pipelines,app.pipeline_stages TO r72_creative_studio_definer;
GRANT SELECT ON app.command_receipts,app.seo_blog_brands,app.workspaces TO r72_creative_studio_definer;
CREATE POLICY seo_blog_brands_creative_read ON app.seo_blog_brands FOR SELECT TO r72_creative_studio_definer USING(workspace_id=app_private.current_workspace_id());
CREATE POLICY workspaces_creative_read ON app.workspaces FOR SELECT TO r72_creative_studio_definer USING(id=app_private.current_workspace_id());
CREATE POLICY pipelines_creative_studio ON app.pipelines FOR ALL TO r72_creative_studio_definer
  USING(workspace_id=app_private.current_workspace_id()) WITH CHECK(workspace_id=app_private.current_workspace_id());
CREATE POLICY pipeline_stages_creative_studio_write ON app.pipeline_stages FOR INSERT TO r72_creative_studio_definer
  WITH CHECK(workspace_id=app_private.current_workspace_id());
CREATE POLICY command_receipts_creative_read ON app.command_receipts FOR SELECT TO r72_creative_studio_definer
  USING(workspace_id=app_private.current_workspace_id() AND command_name='crm.createLead' AND idempotency_key LIKE 'creative.enquiry.%');

CREATE TABLE app.creative_studio_capture(
  workspace_id uuid PRIMARY KEY REFERENCES app.seo_blog_brands(workspace_id),
  public_key text NOT NULL UNIQUE CHECK(public_key ~ '^[a-f0-9]{24}$'),
  enabled boolean NOT NULL DEFAULT false,
  owner_user_id uuid NOT NULL REFERENCES app.users(id),
  pipeline_id uuid NOT NULL, new_stage_id uuid NOT NULL, qualified_stage_id uuid NOT NULL,
  privacy_url text CHECK(privacy_url IS NULL OR (privacy_url ~ '^https://[^[:space:]<>"]+$' AND length(privacy_url) BETWEEN 12 AND 500)),
  row_version integer NOT NULL DEFAULT 1 CHECK(row_version>0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(workspace_id,pipeline_id,new_stage_id) REFERENCES app.pipeline_stages(workspace_id,pipeline_id,id),
  FOREIGN KEY(workspace_id,pipeline_id,qualified_stage_id) REFERENCES app.pipeline_stages(workspace_id,pipeline_id,id),
  CHECK(NOT enabled OR privacy_url IS NOT NULL), CHECK(new_stage_id<>qualified_stage_id)
);
CREATE TABLE app.creative_studio_lead_touches(
  workspace_id uuid NOT NULL REFERENCES app.seo_blog_brands(workspace_id), id uuid NOT NULL DEFAULT gen_random_uuid(),
  crm_command_key text NOT NULL CHECK(crm_command_key ~ '^creative\.enquiry\.[0-9a-f]{64}$'),
  contact_id uuid NOT NULL, opportunity_id uuid NOT NULL, campaign_id uuid NOT NULL, handoff_id uuid NOT NULL,
  utm_source text NOT NULL CHECK(utm_source ~ '^[a-z0-9_-]{1,40}$'), utm_medium text NOT NULL CHECK(utm_medium ~ '^[a-z0-9_-]{1,40}$'),
  utm_campaign text NOT NULL CHECK(utm_campaign ~ '^[a-z0-9-]{1,40}-[0-9a-f]{8}$'), utm_content text NOT NULL CHECK(utm_content ~ '^concept-[0-9]{1,2}-cs[0-9a-f]{8}$'),
  -- Whether this enquiry created the contact (the CRM command may attach a new opportunity to an existing contact).
  created_contact boolean NOT NULL DEFAULT false,
  captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,crm_command_key),
  -- Contact erasure removes the touch with the contact; touches are otherwise never edited.
  FOREIGN KEY(workspace_id,contact_id) REFERENCES app.contacts(workspace_id,id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,opportunity_id,contact_id) REFERENCES app.opportunities(workspace_id,id,contact_id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,campaign_id) REFERENCES app.seo_blog_creator_campaigns(workspace_id,id),
  FOREIGN KEY(workspace_id,handoff_id) REFERENCES app.creative_studio_handoffs(workspace_id,id)
);
CREATE INDEX creative_studio_lead_touches_campaign ON app.creative_studio_lead_touches(workspace_id,utm_campaign);
-- One row per admitted form submission (keyed by the form nonce), so the hourly cap is enforced under the capture row lock.
CREATE TABLE app.creative_studio_enquiry_admissions(
  workspace_id uuid NOT NULL REFERENCES app.seo_blog_brands(workspace_id), nonce_hash text NOT NULL CHECK(nonce_hash ~ '^[0-9a-f]{64}$'),
  admitted_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(workspace_id,nonce_hash)
);
CREATE INDEX creative_studio_enquiry_admissions_recent ON app.creative_studio_enquiry_admissions(workspace_id,admitted_at);
DO $capture$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['creative_studio_capture','creative_studio_lead_touches','creative_studio_enquiry_admissions'] LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON app.%I FROM PUBLIC,r72_content_command,r72_web,r72_worker',t);
    EXECUTE format('CREATE POLICY %I ON app.%I FOR ALL TO r72_owner USING(true) WITH CHECK(true)',t||'_owner',t);
    EXECUTE format('CREATE POLICY %I ON app.%I FOR ALL TO r72_creative_studio_definer USING(workspace_id=app_private.current_workspace_id()) WITH CHECK(workspace_id=app_private.current_workspace_id())',t||'_scope',t);
    INSERT INTO app_private.workspace_table_registry(schema_name,table_name,workspace_column) VALUES('app',t,'workspace_id');
  END LOOP;
END $capture$;
GRANT SELECT,INSERT,UPDATE ON app.creative_studio_capture TO r72_creative_studio_definer;
GRANT SELECT,INSERT ON app.creative_studio_lead_touches TO r72_creative_studio_definer;
GRANT SELECT,INSERT,DELETE ON app.creative_studio_enquiry_admissions TO r72_creative_studio_definer;
CREATE TRIGGER creative_studio_lead_touches_immutable BEFORE UPDATE ON app.creative_studio_lead_touches FOR EACH ROW EXECUTE FUNCTION app_private.seo_blog_append_only();

GRANT CREATE ON SCHEMA app_private TO r72_creative_studio_definer;
SET LOCAL ROLE r72_creative_studio_definer;

-- Owner settings: read, or save (switch on/off, privacy notice, stage mapping). A brand with no CRM pipeline gets the
-- standard "Enquiries" pipeline; an existing default pipeline is used as it is, with stages the owner chooses.
CREATE FUNCTION app_private.creative_studio_capture_setup(p_workspace uuid,p_session bytea,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; cap app.creative_studio_capture; pipe uuid; new_s uuid; qual_s uuid; new_pos integer; qual_pos integer; stages jsonb; action text:=p_input->>'action'; pipe_slug text:='enquiries';
BEGIN
  actor:=app_private.seo_media_owner(p_workspace,p_session);
  IF app_private.seo_blog_brand(p_workspace) IS NULL THEN RAISE EXCEPTION 'Brand unavailable' USING ERRCODE='42501'; END IF;
  IF action NOT IN ('read','save','rotate') THEN RAISE EXCEPTION 'Unknown enquiry setting' USING ERRCODE='22023'; END IF;
  -- Writes serialise on the brand (there is no row to lock before the first save).
  IF action<>'read' THEN PERFORM pg_advisory_xact_lock(hashtextextended('r72-creative-enquiries:'||p_workspace::text,0)); END IF;
  SELECT * INTO cap FROM app.creative_studio_capture WHERE workspace_id=p_workspace;
  pipe:=coalesce(cap.pipeline_id,(SELECT id FROM app.pipelines WHERE workspace_id=p_workspace AND is_default AND status='active'));
  IF action='rotate' THEN
    IF cap.workspace_id IS NULL OR (p_input->>'expectedVersion')::integer IS DISTINCT FROM cap.row_version THEN RAISE EXCEPTION 'Enquiry settings changed. Refresh and try again.' USING ERRCODE='40001'; END IF;
    UPDATE app.creative_studio_capture SET public_key=left(md5(gen_random_uuid()::text||clock_timestamp()::text),24),row_version=row_version+1,updated_at=clock_timestamp() WHERE workspace_id=p_workspace;
    SELECT * INTO cap FROM app.creative_studio_capture WHERE workspace_id=p_workspace;
  ELSIF action='save' THEN
    IF (p_input->>'expectedVersion')::integer IS DISTINCT FROM coalesce(cap.row_version,0) THEN RAISE EXCEPTION 'Enquiry settings changed. Refresh and try again.' USING ERRCODE='40001'; END IF;
    IF pipe IS NULL THEN
      IF EXISTS(SELECT 1 FROM app.pipelines WHERE workspace_id=p_workspace AND slug::text=pipe_slug) THEN pipe_slug:='enquiries-'||left(replace(gen_random_uuid()::text,'-',''),6); END IF;
      INSERT INTO app.pipelines(workspace_id,name,slug,is_default) VALUES(p_workspace,'Enquiries',pipe_slug,true) RETURNING id INTO pipe;
      INSERT INTO app.pipeline_stages(workspace_id,pipeline_id,name,slug,position,stage_type,is_terminal)
        SELECT p_workspace,pipe,label,slug,position,kind,kind IN ('won','lost') FROM (VALUES ('New enquiry','new',10,'open'),('Contacted','contacted',20,'open'),
          ('Qualified','qualified',30,'open'),('Won','won',40,'won'),('Not proceeding','not-proceeding',50,'lost')) AS s(label,slug,position,kind);
      SELECT id INTO new_s FROM app.pipeline_stages WHERE workspace_id=p_workspace AND pipeline_id=pipe AND position=10;
      SELECT id INTO qual_s FROM app.pipeline_stages WHERE workspace_id=p_workspace AND pipeline_id=pipe AND position=30;
    ELSE
      new_s:=coalesce(nullif(p_input->>'newStageId','')::uuid,cap.new_stage_id); qual_s:=coalesce(nullif(p_input->>'qualifiedStageId','')::uuid,cap.qualified_stage_id);
      -- First save on an existing pipeline: default to its first open stage and the first stage named "Qualified…" (else the next open stage).
      IF new_s IS NULL THEN SELECT id INTO new_s FROM app.pipeline_stages WHERE workspace_id=p_workspace AND pipeline_id=pipe AND stage_type='open' AND NOT is_terminal ORDER BY position LIMIT 1; END IF;
      IF qual_s IS NULL THEN
        SELECT id INTO qual_s FROM app.pipeline_stages WHERE workspace_id=p_workspace AND pipeline_id=pipe AND stage_type='open' AND (slug::text ILIKE 'qualif%' OR name ILIKE 'qualif%') ORDER BY position LIMIT 1;
        IF qual_s IS NULL THEN SELECT s.id INTO qual_s FROM app.pipeline_stages s WHERE s.workspace_id=p_workspace AND s.pipeline_id=pipe AND s.stage_type='open'
          AND s.position>(SELECT position FROM app.pipeline_stages WHERE workspace_id=p_workspace AND id=new_s) ORDER BY s.position LIMIT 1; END IF;
      END IF;
    END IF;
    SELECT position INTO new_pos FROM app.pipeline_stages WHERE workspace_id=p_workspace AND pipeline_id=pipe AND id=new_s AND stage_type='open' AND NOT is_terminal;
    SELECT position INTO qual_pos FROM app.pipeline_stages WHERE workspace_id=p_workspace AND pipeline_id=pipe AND id=qual_s AND stage_type='open';
    IF new_pos IS NULL OR qual_pos IS NULL OR qual_pos<=new_pos THEN
      RAISE EXCEPTION 'Choose an open first stage for new enquiries and a later open stage that means qualified.' USING ERRCODE='22023'; END IF;
    IF coalesce((p_input->>'enabled')::boolean,false) AND (coalesce(p_input->>'privacyUrl','') !~ '^https://[^[:space:]<>"]+$' OR length(p_input->>'privacyUrl') NOT BETWEEN 12 AND 500) THEN
      RAISE EXCEPTION 'Add the https link to the brand''s privacy notice before switching enquiries on.' USING ERRCODE='22023'; END IF;
    IF cap.workspace_id IS NULL THEN
      INSERT INTO app.creative_studio_capture(workspace_id,public_key,enabled,owner_user_id,pipeline_id,new_stage_id,qualified_stage_id,privacy_url)
        VALUES(p_workspace,left(md5(gen_random_uuid()::text||clock_timestamp()::text),24),coalesce((p_input->>'enabled')::boolean,false),actor,pipe,new_s,qual_s,nullif(p_input->>'privacyUrl',''));
    ELSE
      UPDATE app.creative_studio_capture SET enabled=coalesce((p_input->>'enabled')::boolean,false),owner_user_id=actor,pipeline_id=pipe,new_stage_id=new_s,
        qualified_stage_id=qual_s,privacy_url=nullif(p_input->>'privacyUrl',''),row_version=row_version+1,updated_at=clock_timestamp() WHERE workspace_id=p_workspace;
    END IF;
    SELECT * INTO cap FROM app.creative_studio_capture WHERE workspace_id=p_workspace;
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name,'type',stage_type,'position',position) ORDER BY position),'[]') INTO stages
    FROM app.pipeline_stages WHERE workspace_id=p_workspace AND pipeline_id=pipe;
  RETURN jsonb_build_object('configured',cap.workspace_id IS NOT NULL,'enabled',coalesce(cap.enabled,false),'publicKey',cap.public_key,'privacyUrl',cap.privacy_url,
    'ownerUserId',cap.owner_user_id,'pipelineId',pipe,'pipelineName',(SELECT name FROM app.pipelines WHERE workspace_id=p_workspace AND id=pipe),
    'newStageId',cap.new_stage_id,'qualifiedStageId',cap.qualified_stage_id,'rowVersion',coalesce(cap.row_version,0),'stages',stages,
    'touches',(SELECT count(*) FROM app.creative_studio_lead_touches WHERE workspace_id=p_workspace));
END $f$;

-- Public ingress (actor kind webhook, no session): the form's target, only while the owner keeps it on and still
-- manages the brand and the brand is not paused. frameOrigins are the brand's own site and confirmed conversion-page
-- hosts: the only origins allowed to embed the form.
CREATE FUNCTION app_private.creative_studio_capture_target(p_workspace uuid,p_key text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE cap app.creative_studio_capture; brand_name text; settings jsonb; website text; origins jsonb;
BEGIN
  IF app_private.current_actor_kind()<>'webhook' OR app_private.current_workspace_id() IS DISTINCT FROM p_workspace OR coalesce(p_key,'') !~ '^[a-f0-9]{24}$' THEN RETURN NULL; END IF;
  SELECT * INTO cap FROM app.creative_studio_capture WHERE workspace_id=p_workspace AND public_key=p_key AND enabled;
  SELECT w.name,b.settings,b.website INTO brand_name,settings,website FROM app.seo_blog_brands b JOIN app.workspaces w ON w.id=b.workspace_id WHERE b.workspace_id=p_workspace AND w.status='active';
  IF cap.workspace_id IS NULL OR brand_name IS NULL OR coalesce((settings->>'pauseAll')::boolean,false)
    OR NOT app_private.can_manage_workspace(cap.owner_user_id,p_workspace) THEN RETURN NULL; END IF;
  SELECT coalesce(jsonb_agg(DISTINCT o),'[]'::jsonb) INTO origins FROM (
    SELECT 'https://'||host AS o FROM (SELECT lower(regexp_replace(u,'^https?://(www[.])?([^/?#:]+).*$','\2')) AS host FROM (
      SELECT website AS u UNION ALL SELECT cp->>'url' FROM jsonb_array_elements(coalesce(app_private.seo_creator_profile(p_workspace)->'conversionPages','[]'::jsonb)) cp) s
      WHERE u ~ '^https?://[^/?#:]+') h WHERE host ~ '^[a-z0-9.-]{3,253}$'
    UNION ALL
    SELECT 'https://www.'||host FROM (SELECT lower(regexp_replace(u,'^https?://(www[.])?([^/?#:]+).*$','\2')) AS host FROM (
      SELECT website AS u UNION ALL SELECT cp->>'url' FROM jsonb_array_elements(coalesce(app_private.seo_creator_profile(p_workspace)->'conversionPages','[]'::jsonb)) cp) s
      WHERE u ~ '^https?://[^/?#:]+') h WHERE host ~ '^[a-z0-9.-]{3,253}$' AND host NOT LIKE 'www.%') x;
  RETURN jsonb_build_object('brandName',brand_name,'privacyUrl',cap.privacy_url,'ownerUserId',cap.owner_user_id,'pipelineId',cap.pipeline_id,'stageId',cap.new_stage_id,'frameOrigins',origins);
END $f$;

-- Admission of one validated form submission (webhook actor), under the capture row lock, so at most 50 enquiries per
-- rolling hour are admitted per brand however many arrive at once. The same nonce is admitted once (a resubmit replays).
CREATE FUNCTION app_private.creative_studio_capture_admit(p_workspace uuid,p_key text,p_nonce_hash text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE cap app.creative_studio_capture; recent bigint;
BEGIN
  IF app_private.current_actor_kind()<>'webhook' OR app_private.current_workspace_id() IS DISTINCT FROM p_workspace OR coalesce(p_key,'') !~ '^[a-f0-9]{24}$'
    OR coalesce(p_nonce_hash,'') !~ '^[0-9a-f]{64}$' THEN RETURN jsonb_build_object('admitted',false,'reason','unavailable'); END IF;
  SELECT * INTO cap FROM app.creative_studio_capture WHERE workspace_id=p_workspace AND public_key=p_key AND enabled FOR UPDATE;
  IF cap.workspace_id IS NULL OR app_private.creative_studio_capture_target(p_workspace,p_key) IS NULL THEN RETURN jsonb_build_object('admitted',false,'reason','unavailable'); END IF;
  IF EXISTS(SELECT 1 FROM app.creative_studio_enquiry_admissions WHERE workspace_id=p_workspace AND nonce_hash=p_nonce_hash) THEN RETURN jsonb_build_object('admitted',true,'replayed',true); END IF;
  DELETE FROM app.creative_studio_enquiry_admissions WHERE workspace_id=p_workspace AND admitted_at<clock_timestamp()-interval '1 day';
  SELECT count(*) INTO recent FROM app.creative_studio_enquiry_admissions WHERE workspace_id=p_workspace AND admitted_at>clock_timestamp()-interval '1 hour';
  IF recent>=50 THEN RETURN jsonb_build_object('admitted',false,'reason','rate_limited'); END IF;
  INSERT INTO app.creative_studio_enquiry_admissions(workspace_id,nonce_hash) VALUES(p_workspace,p_nonce_hash);
  RETURN jsonb_build_object('admitted',true,'replayed',false);
END $f$;

-- After crm.createLead succeeded for this enquiry (as the capture owner), store the campaign touch if, and only if,
-- the UTM values are exactly a tracked link this brand issued for its own acquisition campaign.
CREATE FUNCTION app_private.creative_studio_record_touch(p_workspace uuid,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE cap app.creative_studio_capture; receipt app.command_receipts; h app.creative_studio_handoffs; camp text:=p_input->>'utmCampaign'; content text:=p_input->>'utmContent';
  src text:=p_input->>'utmSource'; med text:=p_input->>'utmMedium';
BEGIN
  SELECT * INTO cap FROM app.creative_studio_capture WHERE workspace_id=p_workspace AND enabled;
  IF cap.workspace_id IS NULL OR app_private.current_actor_kind()<>'user' OR app_private.current_user_id() IS DISTINCT FROM cap.owner_user_id
    OR NOT app_private.can_manage_workspace(cap.owner_user_id,p_workspace) THEN RAISE EXCEPTION 'Enquiry capture is not active for this brand' USING ERRCODE='42501'; END IF;
  IF coalesce(p_input->>'commandKey','') !~ '^creative\.enquiry\.[0-9a-f]{64}$' THEN RAISE EXCEPTION 'Invalid enquiry' USING ERRCODE='22023'; END IF;
  SELECT * INTO receipt FROM app.command_receipts WHERE workspace_id=p_workspace AND actor_user_id=cap.owner_user_id AND command_name='crm.createLead'
    AND idempotency_key=p_input->>'commandKey' AND status='succeeded';
  IF receipt.id IS NULL THEN RAISE EXCEPTION 'The enquiry was not recorded in the CRM' USING ERRCODE='55000'; END IF;
  IF EXISTS(SELECT 1 FROM app.creative_studio_lead_touches WHERE workspace_id=p_workspace AND crm_command_key=receipt.idempotency_key) THEN
    RETURN jsonb_build_object('recorded',true,'replayed',true); END IF;
  IF coalesce(receipt.result->>'contactId','') !~ '^[0-9a-f-]{36}$' OR coalesce(receipt.result->>'opportunityId','') !~ '^[0-9a-f-]{36}$' THEN
    RAISE EXCEPTION 'The enquiry receipt is incomplete' USING ERRCODE='55000'; END IF;
  IF coalesce(camp,'') !~ '^[a-z0-9-]{1,40}-[0-9a-f]{8}$' OR coalesce(content,'') !~ '^concept-[0-9]{1,2}-cs[0-9a-f]{8}$'
    OR coalesce(src,'') !~ '^[a-z0-9_-]{1,40}$' OR coalesce(med,'') !~ '^[a-z0-9_-]{1,40}$' THEN
    RETURN jsonb_build_object('recorded',false,'reason','no_campaign_reference'); END IF;
  -- The same concept may be handed off on several channels: any hand-off this brand issued whose own link carries
  -- exactly these campaign, content, source and medium values qualifies.
  SELECT x.* INTO h FROM app.creative_studio_handoffs x JOIN app.seo_blog_creator_campaigns c ON c.workspace_id=x.workspace_id AND c.id::text=x.data#>>'{target,campaignId}'
    WHERE x.workspace_id=p_workspace AND x.data->>'route'='tracked_link' AND x.data#>>'{trackedLink,utmCampaign}'=camp AND x.data#>>'{trackedLink,utmContent}'=content
      AND right(camp,8)=left(replace(c.id::text,'-',''),8)
      AND position('utm_source='||src||'&' IN (x.data#>>'{trackedLink,url}')||'&')>0 AND position('utm_medium='||med||'&' IN (x.data#>>'{trackedLink,url}')||'&')>0
    ORDER BY x.created_at LIMIT 1;
  IF h.id IS NULL THEN RETURN jsonb_build_object('recorded',false,'reason','unknown_or_other_brand_reference'); END IF;
  INSERT INTO app.creative_studio_lead_touches(workspace_id,crm_command_key,contact_id,opportunity_id,campaign_id,handoff_id,utm_source,utm_medium,utm_campaign,utm_content,created_contact)
    VALUES(p_workspace,receipt.idempotency_key,(receipt.result->>'contactId')::uuid,(receipt.result->>'opportunityId')::uuid,(h.data#>>'{target,campaignId}')::uuid,h.id,src,med,camp,content,
      coalesce((receipt.result->>'createdContact')::boolean,false))
    ON CONFLICT (workspace_id,crm_command_key) DO NOTHING;
  IF NOT FOUND THEN RETURN jsonb_build_object('recorded',true,'replayed',true); END IF;
  RETURN jsonb_build_object('recorded',true,'replayed',false,'campaignId',h.data#>>'{target,campaignId}');
END $f$;

REVOKE ALL ON FUNCTION app_private.creative_studio_capture_setup(uuid,bytea,jsonb),app_private.creative_studio_capture_target(uuid,text),
  app_private.creative_studio_capture_admit(uuid,text,text),app_private.creative_studio_record_touch(uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.creative_studio_capture_setup(uuid,bytea,jsonb),app_private.creative_studio_capture_target(uuid,text),
  app_private.creative_studio_capture_admit(uuid,text,text),app_private.creative_studio_record_touch(uuid,jsonb) TO r72_content_command;

RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_creative_studio_definer;
