-- PRIVATE DRAFT: Native, zero-provider-cost render jobs. Claude assigns version
-- and merges SQL with the existing Creative Studio schema at bolt-on time.
-- A source is NOT admitted unless its persisted SHA and independently measured
-- technical probe match the owner-saved timeline's latest immutable revision.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
SET LOCAL ROLE r72_owner;
CREATE TABLE app.creative_media_local_render_jobs (
 workspace_id uuid NOT NULL REFERENCES app.seo_blog_brands(workspace_id),
 id uuid NOT NULL,
 command_id uuid NOT NULL,
 project_id uuid NOT NULL,
 revision integer NOT NULL,
 source_id uuid NOT NULL,
 source_sha256 text NOT NULL CHECK(source_sha256~'^[a-f0-9]{64}$'),
 plan_sha256 text NOT NULL CHECK(plan_sha256~'^[a-f0-9]{64}$'),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
 retry_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 requested_by uuid NOT NULL REFERENCES app.users(id),
 rights_attested boolean NOT NULL DEFAULT true,
 state text NOT NULL DEFAULT 'queued'
   CHECK(state IN('queued','claimed','completed','failed')),
 claim_token uuid,claim_until timestamptz,
 output_id uuid,
 error_code text CHECK(error_code IS NULL OR error_code IN
  ('render_failed','renderer_unavailable','source_changed','output_invalid','tool_limit')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,id),UNIQUE(workspace_id,command_id),
 FOREIGN KEY(workspace_id,project_id,revision)
   REFERENCES app.creative_media_edit_projects(workspace_id,id,revision),
 FOREIGN KEY(workspace_id,source_id)
   REFERENCES app.creative_media_source_videos(workspace_id,id),
 CHECK((state='queued' AND claim_token IS NULL AND claim_until IS NULL AND output_id IS NULL)
  OR (state='claimed' AND claim_token IS NOT NULL AND claim_until IS NOT NULL AND output_id IS NULL)
  OR (state='completed' AND claim_token IS NOT NULL AND output_id IS NOT NULL)
  OR (state='failed' AND claim_token IS NOT NULL AND output_id IS NULL AND error_code IS NOT NULL))
);
CREATE TABLE app.creative_media_local_render_outputs (
 workspace_id uuid NOT NULL,
 id uuid NOT NULL,
 job_id uuid NOT NULL,
 blob_id uuid NOT NULL,
 source_sha256 text NOT NULL CHECK(source_sha256~'^[a-f0-9]{64}$'),
 plan_sha256 text NOT NULL CHECK(plan_sha256~'^[a-f0-9]{64}$'),
 sha256 text NOT NULL CHECK(sha256~'^[a-f0-9]{64}$'),
 byte_length integer NOT NULL CHECK(byte_length BETWEEN 1024 AND 19999999),
 mime text NOT NULL DEFAULT 'video/mp4' CHECK(mime='video/mp4'),
 duration_ms bigint NOT NULL CHECK(duration_ms BETWEEN 1000 AND 300000),
 width integer NOT NULL CHECK(width IN(720,1280)),
 height integer NOT NULL CHECK(height IN(720,1280)),
 audio_present boolean NOT NULL,
 renderer_version text NOT NULL CHECK(renderer_version='rl72-native-ffmpeg-v1'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,id),UNIQUE(workspace_id,job_id),
 FOREIGN KEY(workspace_id,job_id) REFERENCES app.creative_media_local_render_jobs(workspace_id,id),
 FOREIGN KEY(workspace_id,blob_id) REFERENCES app.seo_blog_blobs(workspace_id,id)
);
DO $tables$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['creative_media_local_render_jobs','creative_media_local_render_outputs'] LOOP
  EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON app.%I FROM PUBLIC,r72_web,r72_content_command,r72_worker',t);
  EXECUTE format('CREATE POLICY %I ON app.%I FOR ALL TO r72_owner USING(true) WITH CHECK(true)',t||'_owner',t);
  EXECUTE format('CREATE POLICY %I ON app.%I FOR ALL TO r72_creative_studio_definer USING(workspace_id=app_private.current_workspace_id()) WITH CHECK(workspace_id=app_private.current_workspace_id())',t||'_studio',t);
  EXECUTE format('CREATE POLICY %I ON app.%I FOR ALL TO r72_media_job_definer USING(workspace_id=app_private.current_workspace_id()) WITH CHECK(workspace_id=app_private.current_workspace_id())',t||'_worker',t);
  INSERT INTO app_private.workspace_table_registry(schema_name,table_name,workspace_column)
   VALUES('app',t,'workspace_id');
 END LOOP;
END $tables$;
GRANT SELECT,INSERT ON app.creative_media_local_render_jobs TO r72_creative_studio_definer;
GRANT SELECT ON app.creative_media_local_render_outputs TO r72_creative_studio_definer;
GRANT SELECT,UPDATE ON app.creative_media_local_render_jobs TO r72_media_job_definer;
GRANT SELECT,INSERT ON app.creative_media_local_render_outputs TO r72_media_job_definer;
GRANT SELECT ON app.creative_media_video_probes TO r72_creative_studio_definer;
GRANT SELECT ON app.creative_media_edit_projects TO r72_media_job_definer;
CREATE POLICY creative_media_edit_projects_worker_read ON app.creative_media_edit_projects
 FOR SELECT TO r72_media_job_definer
 USING(workspace_id=app_private.current_workspace_id());
GRANT SELECT ON app.creative_media_source_videos TO r72_media_job_definer;
GRANT SELECT ON app.seo_blog_blobs TO r72_media_job_definer;
CREATE TRIGGER creative_media_local_render_outputs_immutable
 BEFORE UPDATE OR DELETE ON app.creative_media_local_render_outputs
 FOR EACH ROW EXECUTE FUNCTION app_private.seo_blog_append_only();
-- Jobs are only mutated inside the protected worker definer and never through
-- owner, public or content-command table access.
GRANT CREATE ON SCHEMA app_private TO r72_creative_studio_definer;
SET LOCAL ROLE r72_creative_studio_definer;
CREATE FUNCTION app_private.creative_media_local_render_owner(
 p_workspace uuid,p_session bytea,p_action text,p_input jsonb
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid;source app.creative_media_source_videos;
 project app.creative_media_edit_projects;existing app.creative_media_local_render_jobs;
 v_project_id uuid;v_job_id uuid;v_command_id uuid;v_revision integer;
BEGIN
 IF p_session IS NULL OR app_private.current_actor_kind()<>'user'
   OR app_private.current_workspace_id() IS DISTINCT FROM p_workspace THEN
  RAISE EXCEPTION 'Authenticated editor owner workspace required' USING ERRCODE='42501'; END IF;
 actor:=app_private.seo_media_owner(p_workspace,p_session);
 IF p_action='list' THEN
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('id',j.id,'projectId',j.project_id,
   'revision',j.revision,'state',j.state,'sourceId',j.source_id,
   'sourceSha256',j.source_sha256,'planSha256',j.plan_sha256,
   'outputId',j.output_id,'createdAt',j.created_at,'updatedAt',j.updated_at)
   ORDER BY j.created_at DESC)
   FROM app.creative_media_local_render_jobs j
   WHERE j.workspace_id=p_workspace),'[]'::jsonb);
 END IF;
 IF p_action='outputs' THEN
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object(
    'id',o.id,'jobId',o.job_id,'sha256',o.sha256,
    'sourceSha256',o.source_sha256,'planSha256',o.plan_sha256,
    'durationMs',o.duration_ms,'width',o.width,'height',o.height,
    'audioPresent',o.audio_present,'byteLength',o.byte_length,'createdAt',o.created_at)
    ORDER BY o.created_at DESC)
   FROM app.creative_media_local_render_outputs o WHERE o.workspace_id=p_workspace),'[]'::jsonb);
 END IF;
 IF p_action<>'enqueue' OR p_input IS NULL OR jsonb_typeof(p_input)<>'object'
  OR octet_length(p_input::text)>1600 OR p_input->>'rightsConfirmed' IS DISTINCT FROM 'true'
  OR coalesce(p_input->>'jobId','')!~'^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
  OR coalesce(p_input->>'commandId','')!~'^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
  OR coalesce(p_input->>'projectId','')!~'^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
  OR coalesce(p_input->>'revision','')!~'^[1-9][0-9]{0,2}$'
  OR coalesce(p_input->>'sourceSha256','')!~'^[a-f0-9]{64}$'
  OR coalesce(p_input->>'planSha256','')!~'^[a-f0-9]{64}$' THEN
  RAISE EXCEPTION 'Exact version and separately confirmed rights required' USING ERRCODE='22023'; END IF;
 v_job_id:=(p_input->>'jobId')::uuid;
 v_command_id:=(p_input->>'commandId')::uuid;
 v_project_id:=(p_input->>'projectId')::uuid;
 v_revision:=(p_input->>'revision')::integer;
 PERFORM pg_advisory_xact_lock(hashtextextended('rl72-local-render:'||p_workspace::text,0));
 SELECT * INTO existing FROM app.creative_media_local_render_jobs j
  WHERE j.workspace_id=p_workspace AND j.command_id=v_command_id;
 IF existing.id IS NOT NULL THEN
  IF existing.id IS DISTINCT FROM v_job_id OR existing.project_id IS DISTINCT FROM v_project_id
   OR existing.revision IS DISTINCT FROM v_revision
   OR existing.source_sha256 IS DISTINCT FROM p_input->>'sourceSha256'
   OR existing.plan_sha256 IS DISTINCT FROM p_input->>'planSha256' THEN
   RAISE EXCEPTION 'Local render command replay changed the reviewed version' USING ERRCODE='40001'; END IF;
  RETURN jsonb_build_object('id',v_job_id,'state',existing.state,'replayed',true);
 END IF;
 SELECT * INTO project FROM app.creative_media_edit_projects p
  WHERE p.workspace_id=p_workspace AND p.id=v_project_id AND p.revision=v_revision;
 IF project.id IS NULL OR v_revision<>(SELECT max(p.revision) FROM app.creative_media_edit_projects p
  WHERE p.workspace_id=p_workspace AND p.id=v_project_id) THEN
  RAISE EXCEPTION 'Timeline changed; only the latest immutable edit may render' USING ERRCODE='55000'; END IF;
 IF project.source_sha256 IS DISTINCT FROM p_input->>'sourceSha256'
  OR project.plan_sha256 IS DISTINCT FROM p_input->>'planSha256' THEN
  RAISE EXCEPTION 'Approved source and plan SHA changed' USING ERRCODE='40001'; END IF;
 SELECT * INTO source FROM app.creative_media_source_videos
  WHERE workspace_id=p_workspace AND id=project.source_id;
 IF source.id IS NULL OR source.sha256 IS DISTINCT FROM project.source_sha256
   OR source.state<>'awaiting_probe' OR source.rights NOT IN('owned','licensed')
   OR (source.rights='licensed' AND source.evidence_sha256 IS NULL) THEN
  RAISE EXCEPTION 'Private owned or licensed source evidence required' USING ERRCODE='55000'; END IF;
 IF NOT EXISTS(SELECT 1 FROM app.creative_media_video_probes probe
   WHERE probe.workspace_id=p_workspace AND probe.source_id=source.id
    AND probe.source_sha256=source.sha256 AND probe.status='verified_technical') THEN
  RAISE EXCEPTION 'Independent source video probe must pass first' USING ERRCODE='55000'; END IF;
 IF (SELECT count(*) FROM app.creative_media_local_render_jobs WHERE workspace_id=p_workspace AND state IN('queued','claimed'))>=20 OR (SELECT coalesce(sum(byte_length),0) FROM app.creative_media_local_render_outputs o WHERE workspace_id=p_workspace AND NOT EXISTS(SELECT 1 FROM app.creative_media_erasures e WHERE e.workspace_id=p_workspace AND e.kind='local_output' AND e.id=o.id AND e.erased_at IS NOT NULL))>=200000000 THEN RAISE EXCEPTION 'Media queue or output storage cap reached' USING ERRCODE='54000'; END IF;
 INSERT INTO app.creative_media_local_render_jobs(workspace_id,id,command_id,
   project_id,revision,source_id,source_sha256,plan_sha256,requested_by)
 VALUES(p_workspace,v_job_id,v_command_id,v_project_id,v_revision,source.id,
   source.sha256,project.plan_sha256,actor);
 RETURN jsonb_build_object('id',v_job_id,'state','queued','replayed',false);
END $f$;
CREATE FUNCTION app_private.creative_media_local_render_bytes(
 p_workspace uuid,p_session bytea,p_output uuid
) RETURNS TABLE(mime text,raw_bytes bytea,sha256 text)
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 IF p_session IS NULL OR app_private.current_actor_kind()<>'user'
    OR app_private.current_workspace_id() IS DISTINCT FROM p_workspace THEN
  RAISE EXCEPTION 'Owner output workspace required' USING ERRCODE='42501'; END IF;
 PERFORM app_private.seo_media_owner(p_workspace,p_session);
 RETURN QUERY SELECT o.mime,b.bytes,o.sha256
  FROM app.creative_media_local_render_outputs o
  JOIN app.seo_blog_blobs b ON b.workspace_id=o.workspace_id AND b.id=o.blob_id
  WHERE o.workspace_id=p_workspace AND o.id=p_output AND NOT EXISTS(SELECT 1 FROM app.creative_media_erasures e WHERE e.workspace_id=p_workspace AND e.kind='local_output' AND e.id=p_output)
   AND o.sha256=encode(public.digest(b.bytes,'sha256'),'hex')
   AND o.sha256=encode(b.sha256,'hex')
   AND o.byte_length=octet_length(b.bytes);
END $f$;
REVOKE ALL ON FUNCTION app_private.creative_media_local_render_owner(uuid,bytea,text,jsonb),
 app_private.creative_media_local_render_bytes(uuid,bytea,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.creative_media_local_render_owner(uuid,bytea,text,jsonb),
 app_private.creative_media_local_render_bytes(uuid,bytea,uuid) TO r72_content_command;
RESET ROLE;SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_creative_studio_definer;
GRANT CREATE ON SCHEMA app_private TO r72_media_job_definer;
SET LOCAL ROLE r72_media_job_definer;
CREATE FUNCTION app_private.creative_media_local_render_claim(
 p_workspace uuid,p_job uuid
) RETURNS TABLE(claim_token uuid,plan jsonb,plan_sha256 text,
 source_sha256 text,raw_bytes bytea,
 duration_ms bigint,width integer,height integer,frame_rate numeric,
 video_codec text,audio_present boolean,checker_version text,
 storage_kind text,object_key text,source_id uuid,source_byte_length bigint,source_mime text)
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE j app.creative_media_local_render_jobs;
BEGIN
 IF app_private.current_actor_kind()<>'worker'
    OR app_private.current_workspace_id() IS DISTINCT FROM p_workspace THEN
   RAISE EXCEPTION 'Scoped local renderer worker required' USING ERRCODE='42501'; END IF;
 SELECT * INTO j FROM app.creative_media_local_render_jobs
  WHERE workspace_id=p_workspace AND id=p_job FOR UPDATE;
 IF EXISTS(SELECT 1 FROM app.creative_media_erasures e WHERE e.workspace_id=p_workspace AND e.kind='source' AND e.id=j.source_id) OR j.id IS NULL OR j.state<>'queued' OR j.claim_token IS NOT NULL OR j.retry_at>clock_timestamp() OR j.attempts>=3 THEN
  RAISE EXCEPTION 'Offline render job cannot be claimed again' USING ERRCODE='55000'; END IF;
 -- Before committing a lease, validate all input references and blobs again.
 IF NOT EXISTS(SELECT 1 FROM app.creative_media_edit_projects p
  WHERE p.workspace_id=p_workspace AND p.id=j.project_id AND p.revision=j.revision
   AND p.source_id=j.source_id AND p.source_sha256=j.source_sha256
   AND p.plan_sha256=j.plan_sha256
   AND p.revision=(SELECT max(pp.revision) FROM app.creative_media_edit_projects pp
    WHERE pp.workspace_id=p_workspace AND pp.id=j.project_id)) THEN
  UPDATE app.creative_media_local_render_jobs SET state='failed',claim_token=gen_random_uuid(),error_code='source_changed',updated_at=clock_timestamp() WHERE workspace_id=p_workspace AND id=p_job;RETURN; END IF;
 IF NOT EXISTS(SELECT 1 FROM app.creative_media_source_videos s
   LEFT JOIN app.seo_blog_blobs b ON b.workspace_id=s.workspace_id AND b.id=s.blob_id
   JOIN app.creative_media_video_probes probe
     ON probe.workspace_id=s.workspace_id AND probe.source_id=s.id
   WHERE s.workspace_id=p_workspace AND s.id=j.source_id AND s.sha256=j.source_sha256
    AND probe.status='verified_technical' AND probe.source_sha256=s.sha256
    AND ((s.storage_kind='pg_blob' AND encode(public.digest(b.bytes,'sha256'),'hex')=s.sha256
    AND encode(b.sha256,'hex')=s.sha256 AND s.byte_length=octet_length(b.bytes)) OR (s.storage_kind='private_object' AND s.object_key IS NOT NULL))) THEN
  UPDATE app.creative_media_local_render_jobs SET state='failed',claim_token=gen_random_uuid(),error_code='source_changed',updated_at=clock_timestamp() WHERE workspace_id=p_workspace AND id=p_job;RETURN; END IF;
 UPDATE app.creative_media_local_render_jobs SET state='claimed',attempts=attempts+1,
  claim_token=gen_random_uuid(),claim_until=clock_timestamp()+interval '10 minutes',
  updated_at=clock_timestamp()
 WHERE workspace_id=p_workspace AND id=p_job RETURNING * INTO j;
 RETURN QUERY
 SELECT j.claim_token,p.plan,j.plan_sha256,j.source_sha256,b.bytes,
   probe.duration_ms,probe.width,probe.height,probe.frame_rate,
   probe.video_codec,probe.audio_present,probe.checker_version,s.storage_kind,s.object_key,s.id,s.byte_length::bigint,s.mime
 FROM app.creative_media_edit_projects p
 JOIN app.creative_media_source_videos s
  ON s.workspace_id=p.workspace_id AND s.id=j.source_id
 LEFT JOIN app.seo_blog_blobs b ON b.workspace_id=s.workspace_id AND b.id=s.blob_id
 JOIN app.creative_media_video_probes probe
  ON probe.workspace_id=s.workspace_id AND probe.source_id=s.id
 WHERE p.workspace_id=p_workspace AND p.id=j.project_id AND p.revision=j.revision
  AND s.sha256=j.source_sha256 AND probe.status='verified_technical'
  AND probe.source_sha256=j.source_sha256
  AND (s.storage_kind='private_object' OR encode(public.digest(b.bytes,'sha256'),'hex')=j.source_sha256);
END $f$;
CREATE FUNCTION app_private.creative_media_local_render_settle(
 p_workspace uuid,p_job uuid,p_claim uuid,p_action text,p_media jsonb,p_bytes bytea
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE j app.creative_media_local_render_jobs;
  stored app.creative_media_local_render_outputs;
  blob uuid;v_output_id uuid;hash text;length integer;
BEGIN
 IF app_private.current_actor_kind()<>'worker'
    OR app_private.current_workspace_id() IS DISTINCT FROM p_workspace THEN
  RAISE EXCEPTION 'Scoped worker required to settle local render' USING ERRCODE='42501'; END IF;
 SELECT * INTO j FROM app.creative_media_local_render_jobs
  WHERE workspace_id=p_workspace AND id=p_job FOR UPDATE;
 IF j.id IS NULL OR j.claim_token IS NULL OR j.claim_token IS DISTINCT FROM p_claim THEN
  RAISE EXCEPTION 'Exact offline render claim token required' USING ERRCODE='42501'; END IF;
 IF j.state='completed' AND p_action='complete' THEN
  SELECT * INTO stored FROM app.creative_media_local_render_outputs
   WHERE workspace_id=p_workspace AND job_id=p_job;
  IF stored.id IS NOT NULL AND stored.sha256 IS NOT DISTINCT FROM p_media->>'sha256'
    AND stored.plan_sha256 IS NOT DISTINCT FROM j.plan_sha256 THEN
   RETURN jsonb_build_object('id',stored.id,'sha256',stored.sha256,'replayed',true); END IF;
  RAISE EXCEPTION 'Completed job output changed on replay' USING ERRCODE='40001';
 END IF;
 IF EXISTS(SELECT 1 FROM app.creative_media_erasures e WHERE e.workspace_id=p_workspace AND e.kind='source' AND e.id=j.source_id) OR j.state<>'claimed' OR j.claim_until<=clock_timestamp() THEN
  RAISE EXCEPTION 'Live offline render lease required' USING ERRCODE='55000'; END IF;
 IF p_action='fail' THEN
  IF p_bytes IS NOT NULL OR p_media IS NULL
   OR p_media->>'reason' NOT IN('render_failed','renderer_unavailable','source_changed',
    'output_invalid','tool_limit') THEN
   RAISE EXCEPTION 'Safe failure code required' USING ERRCODE='22023'; END IF;
  UPDATE app.creative_media_local_render_jobs SET state='failed',error_code=p_media->>'reason',
   updated_at=clock_timestamp()
  WHERE workspace_id=p_workspace AND id=p_job;
  RETURN jsonb_build_object('id',p_job,'state','failed');
 END IF;
 IF p_action<>'complete' OR p_media IS NULL OR jsonb_typeof(p_media)<>'object'
   OR octet_length(p_media::text)>1800 OR p_bytes IS NULL THEN
  RAISE EXCEPTION 'Complete exact local render output required' USING ERRCODE='22023'; END IF;
 length:=octet_length(p_bytes);
 hash:=encode(public.digest(p_bytes,'sha256'),'hex');
 IF length NOT BETWEEN 1024 AND 19999999
   OR substring(p_bytes from 5 for 4)<>decode('66747970','hex')
   OR hash IS DISTINCT FROM p_media->>'sha256'
   OR p_media->>'sourceSha256' IS DISTINCT FROM j.source_sha256
   OR p_media->>'planSha256' IS DISTINCT FROM j.plan_sha256
   OR p_media->>'mime' IS DISTINCT FROM 'video/mp4'
   OR p_media->>'renderVersion' IS DISTINCT FROM 'rl72-native-ffmpeg-v1'
   OR coalesce(p_media->>'durationMs','')!~'^[1-9][0-9]{3,5}$'
   OR coalesce(p_media->>'width','') NOT IN('720','1280')
   OR coalesce(p_media->>'height','') NOT IN('720','1280')
   OR (p_media->>'width'='1280' AND p_media->>'height'<>'720')
   OR jsonb_typeof(p_media->'audioPresent')<>'boolean' THEN
  RAISE EXCEPTION 'Offline renderer output integrity or technical metadata mismatch'
    USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('rl72-local-render:'||p_workspace::text,0));
 IF (SELECT count(*) FROM app.creative_media_local_render_outputs o WHERE workspace_id=p_workspace AND NOT EXISTS(SELECT 1 FROM app.creative_media_erasures e WHERE e.workspace_id=p_workspace AND e.kind='local_output' AND e.id=o.id AND e.erased_at IS NOT NULL))>=50 OR (SELECT coalesce(sum(byte_length),0) FROM app.creative_media_local_render_outputs o WHERE workspace_id=p_workspace AND NOT EXISTS(SELECT 1 FROM app.creative_media_erasures e WHERE e.workspace_id=p_workspace AND e.kind='local_output' AND e.id=o.id AND e.erased_at IS NOT NULL))+length>200000000 THEN RAISE EXCEPTION 'Private output storage cap reached' USING ERRCODE='54000'; END IF;
 blob:=gen_random_uuid();v_output_id:=gen_random_uuid();
 INSERT INTO app.seo_blog_blobs(workspace_id,id,mime,bytes,sha256)
 VALUES(p_workspace,blob,'video/mp4',p_bytes,public.digest(p_bytes,'sha256'));
 INSERT INTO app.creative_media_local_render_outputs(workspace_id,id,job_id,blob_id,
  source_sha256,plan_sha256,sha256,byte_length,mime,duration_ms,width,height,
  audio_present,renderer_version)
 VALUES(p_workspace,v_output_id,p_job,blob,j.source_sha256,j.plan_sha256,hash,
  length,'video/mp4',(p_media->>'durationMs')::bigint,(p_media->>'width')::integer,
  (p_media->>'height')::integer,(p_media->>'audioPresent')::boolean,
  'rl72-native-ffmpeg-v1');
 UPDATE app.creative_media_local_render_jobs SET state='completed',output_id=v_output_id,
  updated_at=clock_timestamp() WHERE workspace_id=p_workspace AND id=p_job;
 RETURN jsonb_build_object('id',v_output_id,'sha256',hash,'state','completed','replayed',false);
END $f$;
REVOKE ALL ON FUNCTION app_private.creative_media_local_render_claim(uuid,uuid),
 app_private.creative_media_local_render_settle(uuid,uuid,uuid,text,jsonb,bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.creative_media_local_render_claim(uuid,uuid),
 app_private.creative_media_local_render_settle(uuid,uuid,uuid,text,jsonb,bytea) TO r72_worker;
CREATE FUNCTION app_private.creative_media_render_heartbeat(p_workspace uuid,p_job uuid,p_claim uuid)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 IF app_private.current_actor_kind() IS DISTINCT FROM 'worker' OR app_private.current_workspace_id() IS DISTINCT FROM p_workspace THEN RAISE EXCEPTION 'Scoped worker required' USING ERRCODE='42501'; END IF;
 UPDATE app.creative_media_local_render_jobs SET claim_until=clock_timestamp()+interval '10 minutes',updated_at=clock_timestamp() WHERE workspace_id=p_workspace AND id=p_job AND claim_token=p_claim AND state='claimed' AND claim_until>clock_timestamp();
 RETURN FOUND;
END $f$;
REVOKE ALL ON FUNCTION app_private.creative_media_render_heartbeat(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.creative_media_render_heartbeat(uuid,uuid,uuid) TO r72_worker;
RESET ROLE;SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_media_job_definer;
