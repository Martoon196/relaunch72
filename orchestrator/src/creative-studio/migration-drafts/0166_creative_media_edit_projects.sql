-- 0166: append-only editable video plans bound to existing private source bytes.
-- All plans remain PRIVATE. NO publishing, cost admission or provider calls.
SET LOCAL lock_timeout='5s';SET LOCAL statement_timeout='60s';
SET LOCAL ROLE r72_owner;
CREATE TABLE app.creative_media_edit_projects(
 workspace_id uuid NOT NULL REFERENCES app.seo_blog_brands(workspace_id),
 id uuid NOT NULL,revision integer NOT NULL CHECK(revision BETWEEN 1 AND 100),
 source_id uuid NOT NULL,source_sha256 text NOT NULL CHECK(source_sha256~'^[a-f0-9]{64}$'),
 plan jsonb NOT NULL CHECK(jsonb_typeof(plan)='object' AND octet_length(plan::text)<=12000),
 plan_sha256 text NOT NULL CHECK(plan_sha256~'^[a-f0-9]{64}$'),
 created_by uuid NOT NULL REFERENCES app.users(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,id,revision),
 FOREIGN KEY(workspace_id,source_id) REFERENCES app.creative_media_source_videos(workspace_id,id)
);
CREATE TABLE app.creative_media_edit_commands(
 workspace_id uuid NOT NULL REFERENCES app.seo_blog_brands(workspace_id),
 command_id uuid NOT NULL,project_id uuid NOT NULL,revision integer NOT NULL,
 plan_sha256 text NOT NULL CHECK(plan_sha256~'^[a-f0-9]{64}$'),
 actor_user_id uuid NOT NULL REFERENCES app.users(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,command_id),
 FOREIGN KEY(workspace_id,project_id,revision) REFERENCES app.creative_media_edit_projects(workspace_id,id,revision)
);
DO $tables$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['creative_media_edit_projects','creative_media_edit_commands'] LOOP
 EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('REVOKE ALL ON app.%I FROM PUBLIC,r72_worker,r72_web,r72_content_command',t);
 EXECUTE format('CREATE POLICY %I ON app.%I FOR ALL TO r72_owner USING(true) WITH CHECK(true)',t||'_owner',t);
 EXECUTE format('CREATE POLICY %I ON app.%I FOR ALL TO r72_creative_studio_definer USING(workspace_id=app_private.current_workspace_id()) WITH CHECK(workspace_id=app_private.current_workspace_id())',t||'_scope',t);
 EXECUTE format('GRANT SELECT,INSERT ON app.%I TO r72_creative_studio_definer',t);
 EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON app.%I FOR EACH ROW EXECUTE FUNCTION app_private.seo_blog_append_only()',t||'_immutable',t);
 INSERT INTO app_private.workspace_table_registry(schema_name,table_name,workspace_column)
  VALUES('app',t,'workspace_id');
 END LOOP;
END $tables$;
GRANT SELECT ON app.creative_media_source_videos TO r72_creative_studio_definer;
GRANT CREATE ON SCHEMA app_private TO r72_creative_studio_definer;
SET LOCAL ROLE r72_creative_studio_definer;
CREATE FUNCTION app_private.creative_media_edit_command(
 p_workspace uuid,p_session bytea,p_action text,p_input jsonb
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; project_id uuid;cmd uuid;source_id uuid;source app.creative_media_source_videos;
 old app.creative_media_edit_projects;previous integer;requested integer;replay app.creative_media_edit_commands;
 raw text;plan_data jsonb;sha text;
BEGIN
 IF p_session IS NULL OR app_private.current_actor_kind()<>'user' THEN
  RAISE EXCEPTION 'Owner editor session required' USING ERRCODE='42501'; END IF;
 actor:=app_private.seo_media_owner(p_workspace,p_session);
 IF p_action='list' THEN
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('id',p.id,'revision',p.revision,
   'sourceId',p.source_id,'sourceSha256',p.source_sha256,'plan',p.plan,
   'planSha256',p.plan_sha256,'createdAt',p.created_at) ORDER BY p.created_at DESC)
   FROM (SELECT DISTINCT ON (id) * FROM app.creative_media_edit_projects
    WHERE workspace_id=p_workspace ORDER BY id,revision DESC) p),'[]'::jsonb);
 END IF;
 IF p_action NOT IN('get','save') OR p_input IS NULL OR jsonb_typeof(p_input)<>'object'
   OR octet_length(p_input::text)>16000 THEN
  RAISE EXCEPTION 'Unsupported timeline action' USING ERRCODE='22023'; END IF;
 IF coalesce(p_input->>'projectId','')!~'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
 THEN RAISE EXCEPTION 'Invalid timeline project id' USING ERRCODE='22023'; END IF;
 project_id:=(p_input->>'projectId')::uuid;
 IF p_action='get' THEN
  SELECT * INTO old FROM app.creative_media_edit_projects
   WHERE workspace_id=p_workspace AND id=project_id ORDER BY revision DESC LIMIT 1;
  IF old.id IS NULL THEN RETURN 'null'::jsonb; END IF;
  RETURN jsonb_build_object('id',old.id,'revision',old.revision,
   'sourceId',old.source_id,'sourceSha256',old.source_sha256,
   'plan',old.plan,'planSha256',old.plan_sha256,'createdAt',old.created_at);
 END IF;
 IF coalesce(p_input->>'commandId','')!~'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
 OR coalesce(p_input->>'sourceId','')!~'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
 OR coalesce(p_input->>'sourceSha256','')!~'^[a-f0-9]{64}$'
 OR coalesce(p_input->>'planSha256','')!~'^[a-f0-9]{64}$'
 OR coalesce(p_input->>'expectedRevision','')!~'^(0|[1-9][0-9]{0,2})$' THEN
  RAISE EXCEPTION 'Invalid edit submission' USING ERRCODE='22023'; END IF;
 cmd:=(p_input->>'commandId')::uuid; source_id:=(p_input->>'sourceId')::uuid;
 requested:=(p_input->>'expectedRevision')::integer;
 raw:=p_input->>'planRaw';
 IF raw IS NULL OR octet_length(raw) NOT BETWEEN 40 AND 12000
 OR encode(public.digest(raw,'sha256'),'hex') IS DISTINCT FROM p_input->>'planSha256' THEN
  RAISE EXCEPTION 'Reviewed timeline digest mismatch' USING ERRCODE='22023'; END IF;
 plan_data:=raw::jsonb;
 IF jsonb_typeof(plan_data)<>'object' OR plan_data->>'canvas' NOT IN('portrait','square','landscape')
 OR jsonb_typeof(plan_data->'clips')<>'array' OR jsonb_array_length(plan_data->'clips') NOT BETWEEN 1 AND 12
 OR coalesce(length(plan_data->>'disclosure'),0)>280 OR coalesce(plan_data->>'disclosure','')!~*'(^|[[:space:]])#ad([[:space:]]|$)' THEN
  RAISE EXCEPTION 'Invalid or incomplete timeline payload' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(plan_data->'clips') c
  WHERE jsonb_typeof(c)<>'object' OR coalesce(c->>'startMs','')!~'^[0-9]{1,8}$'
  OR coalesce(c->>'endMs','')!~'^[0-9]{1,8}$'
  OR (c->>'endMs')::bigint<=(c->>'startMs')::bigint
  OR (c->>'endMs')::bigint>36000000
  OR c->>'transition' NOT IN('cut','fade')
  OR c->>'speed' NOT IN('0.5','1','2') OR length(coalesce(c->>'caption',''))>240) THEN
   RAISE EXCEPTION 'Invalid clip timing or transition' USING ERRCODE='22023'; END IF;
 SELECT * INTO source FROM app.creative_media_source_videos
 WHERE workspace_id=p_workspace AND id=source_id;
 IF source.id IS NULL OR source.sha256 IS DISTINCT FROM p_input->>'sourceSha256' THEN
  RAISE EXCEPTION 'Source not in this private workspace or digest changed' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('rl72-video-edit:'||p_workspace::text||':'||project_id::text,0));
 SELECT * INTO replay FROM app.creative_media_edit_commands
  WHERE workspace_id=p_workspace AND command_id=cmd;
 IF replay.command_id IS NOT NULL THEN
  IF replay.project_id IS DISTINCT FROM project_id OR replay.plan_sha256 IS DISTINCT FROM p_input->>'planSha256'
  THEN RAISE EXCEPTION 'Timeline command replay changed content' USING ERRCODE='40001'; END IF;
  RETURN jsonb_build_object('id',project_id,'revision',replay.revision,'replayed',true);
 END IF;
 SELECT coalesce(max(revision),0) INTO previous FROM app.creative_media_edit_projects
 WHERE workspace_id=p_workspace AND id=project_id;
 IF previous<>requested OR previous>=100 THEN
  RAISE EXCEPTION 'Timeline changed; refresh version' USING ERRCODE='40001'; END IF;
 INSERT INTO app.creative_media_edit_projects(workspace_id,id,revision,source_id,source_sha256,
  plan,plan_sha256,created_by)
 VALUES(p_workspace,project_id,previous+1,source_id,source.sha256,plan_data,
  p_input->>'planSha256',actor);
 INSERT INTO app.creative_media_edit_commands(workspace_id,command_id,project_id,revision,
  plan_sha256,actor_user_id)
 VALUES(p_workspace,cmd,project_id,previous+1,p_input->>'planSha256',actor);
 RETURN jsonb_build_object('id',project_id,'revision',previous+1,'replayed',false);
END $f$;
REVOKE ALL ON FUNCTION app_private.creative_media_edit_command(uuid,bytea,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.creative_media_edit_command(uuid,bytea,text,jsonb)
 TO r72_content_command;
RESET ROLE;SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_creative_studio_definer;
