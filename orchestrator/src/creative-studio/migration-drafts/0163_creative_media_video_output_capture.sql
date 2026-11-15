-- 0162: immutable, unapproved provider output capture inside canonical SEO blob store.
-- The worker may persist verified bytes after a submitted paid job; neither
-- publication nor a financial settlement is implied by captured bytes.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
SET LOCAL ROLE r72_owner;
CREATE TABLE app.creative_media_video_outputs(
 workspace_id uuid NOT NULL,
 id uuid NOT NULL DEFAULT gen_random_uuid(),
 job_id uuid NOT NULL,
 slot integer NOT NULL CHECK(slot BETWEEN 0 AND 30),
 provider_asset_id text NOT NULL CHECK(length(provider_asset_id) BETWEEN 1 AND 160),
 blob_id uuid NOT NULL,
 sha256 text NOT NULL CHECK(sha256~'^[a-f0-9]{64}$'),
 byte_length integer NOT NULL CHECK(byte_length BETWEEN 1024 AND 20000000),
 mime text NOT NULL CHECK(mime IN('video/mp4','video/webm')),
 state text NOT NULL DEFAULT 'captured_unverified' CHECK(state='captured_unverified'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,id),UNIQUE(workspace_id,job_id,slot),
 FOREIGN KEY(workspace_id,job_id) REFERENCES app.creative_media_video_jobs(workspace_id,id),
 FOREIGN KEY(workspace_id,blob_id) REFERENCES app.seo_blog_blobs(workspace_id,id)
);
ALTER TABLE app.creative_media_video_outputs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.creative_media_video_outputs FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app.creative_media_video_outputs FROM PUBLIC,r72_web,r72_worker,r72_content_command;
CREATE POLICY creative_media_video_outputs_owner ON app.creative_media_video_outputs
 FOR ALL TO r72_owner USING(true) WITH CHECK(true);
CREATE POLICY creative_media_video_outputs_worker ON app.creative_media_video_outputs
 FOR ALL TO r72_media_job_definer
 USING(workspace_id=app_private.current_workspace_id())
 WITH CHECK(workspace_id=app_private.current_workspace_id());
CREATE POLICY creative_media_video_outputs_studio_read ON app.creative_media_video_outputs
 FOR SELECT TO r72_creative_studio_definer
 USING(workspace_id=app_private.current_workspace_id());
GRANT SELECT,INSERT ON app.creative_media_video_outputs TO r72_media_job_definer;
GRANT SELECT ON app.creative_media_video_outputs TO r72_creative_studio_definer;
GRANT INSERT ON app.seo_blog_blobs TO r72_media_job_definer;
CREATE POLICY seo_blog_blobs_media_video_output_insert ON app.seo_blog_blobs
 FOR INSERT TO r72_media_job_definer
 WITH CHECK(workspace_id=app_private.current_workspace_id() AND mime IN('video/mp4','video/webm')
  AND octet_length(bytes) BETWEEN 1024 AND 20000000
  AND sha256=public.digest(bytes,'sha256'));
CREATE TRIGGER creative_media_video_outputs_immutable
 BEFORE UPDATE OR DELETE ON app.creative_media_video_outputs
 FOR EACH ROW EXECUTE FUNCTION app_private.seo_blog_append_only();
INSERT INTO app_private.workspace_table_registry(schema_name,table_name,workspace_column)
 VALUES('app','creative_media_video_outputs','workspace_id');
GRANT CREATE ON SCHEMA app_private TO r72_media_job_definer;
SET LOCAL ROLE r72_media_job_definer;
CREATE FUNCTION app_private.creative_media_video_output_capture(
 p_workspace uuid,p_job uuid,p_claim uuid,p_provider_id text,p_slot integer,
 p_asset_id text,p_mime text,p_hash text,p_bytes bytea
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE job app.creative_media_video_jobs; saved app.creative_media_video_outputs;
  actual text; blob uuid;
BEGIN
 IF app_private.current_actor_kind()<>'worker' OR app_private.current_workspace_id() IS DISTINCT FROM p_workspace
 THEN RAISE EXCEPTION 'Scoped video worker required' USING ERRCODE='42501'; END IF;
 IF p_bytes IS NULL OR octet_length(p_bytes) NOT BETWEEN 1024 AND 20000000
    OR p_mime NOT IN('video/mp4','video/webm')
    OR p_slot NOT BETWEEN 0 AND 30
    OR p_asset_id IS NULL OR length(p_asset_id) NOT BETWEEN 1 AND 160
    OR p_asset_id~'[[:cntrl:]<>]' OR p_provider_id IS NULL OR p_provider_id~'[[:cntrl:]<>]'
    OR coalesce(p_hash,'')!~'^[a-f0-9]{64}$' THEN
  RAISE EXCEPTION 'Invalid captured video receipt' USING ERRCODE='22023'; END IF;
 IF (p_mime='video/mp4' AND substring(p_bytes from 5 for 4)<>decode('66747970','hex'))
  OR (p_mime='video/webm' AND substring(p_bytes from 1 for 4)<>decode('1a45dfa3','hex')) THEN
   RAISE EXCEPTION 'Media container signature does not match MIME' USING ERRCODE='22023'; END IF;
 actual:=encode(public.digest(p_bytes,'sha256'),'hex');
 IF actual IS DISTINCT FROM p_hash THEN
   RAISE EXCEPTION 'Provider bytes do not match captured SHA' USING ERRCODE='22023'; END IF;
 SELECT * INTO job FROM app.creative_media_video_jobs
  WHERE workspace_id=p_workspace AND id=p_job FOR UPDATE;
 IF job.id IS NULL OR job.state<>'submitted' OR job.claim_token IS DISTINCT FROM p_claim
   OR job.provider_job_id IS DISTINCT FROM p_provider_id THEN
   RAISE EXCEPTION 'Submitted exact provider attempt required' USING ERRCODE='42501'; END IF;
 SELECT * INTO saved FROM app.creative_media_video_outputs
  WHERE workspace_id=p_workspace AND job_id=p_job AND slot=p_slot;
 IF saved.id IS NOT NULL THEN
   IF saved.provider_asset_id IS DISTINCT FROM p_asset_id
      OR saved.sha256 IS DISTINCT FROM p_hash OR saved.mime IS DISTINCT FROM p_mime THEN
      RAISE EXCEPTION 'Output replay changed provider asset' USING ERRCODE='40001'; END IF;
   RETURN jsonb_build_object('id',saved.id,'sha256',saved.sha256,'replayed',true,'state',saved.state);
 END IF;
 blob:=gen_random_uuid();
 INSERT INTO app.seo_blog_blobs(workspace_id,id,mime,bytes,sha256)
 VALUES(p_workspace,blob,p_mime,p_bytes,public.digest(p_bytes,'sha256'));
 INSERT INTO app.creative_media_video_outputs(workspace_id,job_id,slot,provider_asset_id,
   blob_id,sha256,byte_length,mime)
 VALUES(p_workspace,p_job,p_slot,p_asset_id,blob,p_hash,octet_length(p_bytes),p_mime)
 RETURNING * INTO saved;
 RETURN jsonb_build_object('id',saved.id,'sha256',saved.sha256,'replayed',false,'state',saved.state);
END $f$;
CREATE FUNCTION app_private.creative_media_video_output_pending(p_workspace uuid,p_job uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE j app.creative_media_video_jobs;
BEGIN
 IF app_private.current_actor_kind()<>'worker' OR app_private.current_workspace_id() IS DISTINCT FROM p_workspace
 THEN RAISE EXCEPTION 'Scoped worker required' USING ERRCODE='42501'; END IF;
 SELECT * INTO j FROM app.creative_media_video_jobs
 WHERE workspace_id=p_workspace AND id=p_job AND state='submitted';
 IF j.id IS NULL OR j.provider_job_id IS NULL THEN
  RAISE EXCEPTION 'No submitted provider job available' USING ERRCODE='55000'; END IF;
 RETURN jsonb_build_object('jobId',j.id,'claimToken',j.claim_token,'providerId',j.provider_job_id,
   'kind',j.kind,'reservedMicrousd',j.reserved_microusd);
END $f$;
REVOKE ALL ON FUNCTION app_private.creative_media_video_output_capture(uuid,uuid,uuid,text,integer,text,text,text,bytea),
 app_private.creative_media_video_output_pending(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.creative_media_video_output_capture(uuid,uuid,uuid,text,integer,text,text,text,bytea),
 app_private.creative_media_video_output_pending(uuid,uuid) TO r72_worker;
RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_media_job_definer;
GRANT CREATE ON SCHEMA app_private TO r72_creative_studio_definer;
SET LOCAL ROLE r72_creative_studio_definer;
CREATE FUNCTION app_private.creative_media_video_outputs_owner(p_workspace uuid,p_session bytea)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 IF p_session IS NULL OR app_private.current_actor_kind()<>'user' THEN
   RAISE EXCEPTION 'Video owner session required' USING ERRCODE='42501'; END IF;
 PERFORM app_private.seo_media_owner(p_workspace,p_session);
 RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('id',o.id,'jobId',o.job_id,
  'sha256',o.sha256,'mime',o.mime,'slot',o.slot,
  'state',o.state,'byteLength',o.byte_length,'createdAt',o.created_at)
  ORDER BY o.created_at DESC)
  FROM app.creative_media_video_outputs o WHERE o.workspace_id=p_workspace),'[]'::jsonb);
END $f$;
REVOKE ALL ON FUNCTION app_private.creative_media_video_outputs_owner(uuid,bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.creative_media_video_outputs_owner(uuid,bytea) TO r72_content_command;
RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_creative_studio_definer;
