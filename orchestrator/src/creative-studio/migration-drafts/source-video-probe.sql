-- Trusted worker video metadata probes; do not authorise publication or provider use.
-- Failed/invalid sources are retained as private evidence only.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
SET LOCAL ROLE r72_owner;
CREATE TABLE app.creative_media_video_probes(
  workspace_id uuid NOT NULL,source_id uuid NOT NULL,
  source_sha256 text NOT NULL CHECK(source_sha256~'^[a-f0-9]{64}$'),
  status text NOT NULL CHECK(status IN('verified_technical','rejected')),
  duration_ms bigint CHECK(duration_ms IS NULL OR duration_ms BETWEEN 1000 AND 36000000),
  width integer CHECK(width IS NULL OR width BETWEEN 16 AND 7680),
  height integer CHECK(height IS NULL OR height BETWEEN 16 AND 4320),
  frame_rate numeric(8,3) CHECK(frame_rate IS NULL OR frame_rate BETWEEN 1 AND 240),
  video_codec text CHECK(video_codec IS NULL OR video_codec IN('h264','hevc','vp8','vp9','av1')),
  audio_present boolean,
  rejection_code text CHECK(rejection_code IS NULL OR rejection_code IN('unsupported','malformed','tool_unavailable','probe_failed')),
  checker_version text NOT NULL CHECK(length(checker_version) BETWEEN 3 AND 80),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,source_id),
  FOREIGN KEY(workspace_id,source_id) REFERENCES app.creative_media_source_videos(workspace_id,id),
  CHECK((status='verified_technical' AND duration_ms IS NOT NULL AND width IS NOT NULL AND height IS NOT NULL
    AND frame_rate IS NOT NULL AND video_codec IS NOT NULL AND rejection_code IS NULL)
    OR (status='rejected' AND rejection_code IS NOT NULL))
);
ALTER TABLE app.creative_media_video_probes ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.creative_media_video_probes FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app.creative_media_video_probes FROM PUBLIC,r72_web,r72_worker,r72_content_command;
CREATE POLICY creative_media_video_probes_owner ON app.creative_media_video_probes
  FOR ALL TO r72_owner USING(true) WITH CHECK(true);
CREATE POLICY creative_media_video_probes_worker ON app.creative_media_video_probes
  FOR ALL TO r72_native_video_definer
  USING(workspace_id=app_private.current_workspace_id())
  WITH CHECK(workspace_id=app_private.current_workspace_id());
CREATE POLICY creative_media_video_probes_studio_read ON app.creative_media_video_probes
  FOR SELECT TO r72_creative_studio_definer
  USING(workspace_id=app_private.current_workspace_id());
GRANT SELECT,INSERT ON app.creative_media_video_probes TO r72_native_video_definer;
GRANT SELECT ON app.creative_media_video_probes TO r72_creative_studio_definer;
GRANT SELECT ON app.creative_media_source_videos,app.seo_blog_blobs TO r72_native_video_definer;
CREATE POLICY creative_media_video_sources_worker_read ON app.creative_media_source_videos
  FOR SELECT TO r72_native_video_definer
  USING(workspace_id=app_private.current_workspace_id());
CREATE POLICY seo_blog_blobs_media_job_read ON app.seo_blog_blobs
  FOR SELECT TO r72_native_video_definer
  USING(workspace_id=app_private.current_workspace_id());
CREATE TRIGGER creative_media_video_probes_immutable
 BEFORE UPDATE OR DELETE ON app.creative_media_video_probes
 FOR EACH ROW EXECUTE FUNCTION app_private.seo_blog_append_only();
INSERT INTO app_private.workspace_table_registry(schema_name,table_name,workspace_column)
 VALUES('app','creative_media_video_probes','workspace_id');
GRANT CREATE ON SCHEMA app_private TO r72_native_video_definer;
SET LOCAL ROLE r72_native_video_definer;
CREATE FUNCTION app_private.creative_media_video_probe_source(p_workspace uuid,p_source uuid)
RETURNS TABLE(mime text,source_sha256 text,raw_bytes bytea)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 IF app_private.current_actor_kind()<>'worker' OR app_private.current_workspace_id() IS DISTINCT FROM p_workspace
 THEN RAISE EXCEPTION 'Trusted scoped worker required' USING ERRCODE='42501'; END IF;
 RETURN QUERY
 SELECT s.mime,s.sha256,b.bytes
 FROM app.creative_media_source_videos s JOIN app.seo_blog_blobs b
  ON b.workspace_id=s.workspace_id AND b.id=s.blob_id
 WHERE s.workspace_id=p_workspace AND s.id=p_source AND s.state='awaiting_probe'
   AND s.sha256=encode(public.digest(b.bytes,'sha256'),'hex')
   AND s.sha256=encode(b.sha256,'hex') AND s.byte_length=octet_length(b.bytes)
   AND NOT EXISTS(SELECT 1 FROM app.creative_media_video_probes p
     WHERE p.workspace_id=p_workspace AND p.source_id=p_source);
END $f$;
CREATE FUNCTION app_private.creative_media_video_probe_record(
 p_workspace uuid,p_source uuid,p_source_sha text,p_check jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE s app.creative_media_source_videos; result app.creative_media_video_probes;
  status text; code text; duration bigint; w integer; h integer; fps numeric; codec text; audio boolean; checker text;
BEGIN
 IF app_private.current_actor_kind()<>'worker' OR app_private.current_workspace_id() IS DISTINCT FROM p_workspace
 THEN RAISE EXCEPTION 'Trusted scoped worker required' USING ERRCODE='42501'; END IF;
 IF p_check IS NULL OR jsonb_typeof(p_check)<>'object' OR octet_length(p_check::text)>1500
 THEN RAISE EXCEPTION 'Invalid probe receipt' USING ERRCODE='22023'; END IF;
 status:=p_check->>'status';code:=p_check->>'rejectionCode';
 checker:=p_check->>'checkerVersion';
 IF checker IS NULL OR length(checker) NOT BETWEEN 3 AND 80 OR checker!~'^[a-zA-Z0-9_.-]+$'
 THEN RAISE EXCEPTION 'Trusted probe version required' USING ERRCODE='22023'; END IF;
 IF status='verified_technical' THEN
  IF coalesce(p_check->>'durationMs','')!~'^[0-9]{4,8}$'
    OR coalesce(p_check->>'width','')!~'^[0-9]{2,4}$'
    OR coalesce(p_check->>'height','')!~'^[0-9]{2,4}$'
    OR coalesce(p_check->>'frameRate','')!~'^[0-9]+(\.[0-9]{1,3})?$'
    OR p_check->>'videoCodec' NOT IN('h264','hevc','vp8','vp9','av1')
    OR jsonb_typeof(p_check->'audioPresent')<>'boolean' OR code IS NOT NULL THEN
     RAISE EXCEPTION 'Complete verified technical metadata required' USING ERRCODE='22023'; END IF;
  duration:=(p_check->>'durationMs')::bigint;w:=(p_check->>'width')::int;h:=(p_check->>'height')::int;
  fps:=(p_check->>'frameRate')::numeric;codec:=p_check->>'videoCodec';audio:=(p_check->>'audioPresent')::boolean;
 ELSIF status='rejected' THEN
  IF code NOT IN('unsupported','malformed','tool_unavailable','probe_failed')
  THEN RAISE EXCEPTION 'Known safe rejection code required' USING ERRCODE='22023'; END IF;
 ELSE RAISE EXCEPTION 'Unsupported probe status' USING ERRCODE='22023'; END IF;
 SELECT * INTO s FROM app.creative_media_source_videos
  WHERE workspace_id=p_workspace AND id=p_source;
 IF s.id IS NULL OR s.sha256 IS DISTINCT FROM p_source_sha THEN
  RAISE EXCEPTION 'Unmatched source bytes' USING ERRCODE='42501'; END IF;
 INSERT INTO app.creative_media_video_probes(workspace_id,source_id,source_sha256,status,
   duration_ms,width,height,frame_rate,video_codec,audio_present,rejection_code,checker_version)
 VALUES(p_workspace,p_source,p_source_sha,status,duration,w,h,fps,codec,audio,code,checker)
 ON CONFLICT DO NOTHING RETURNING * INTO result;
 IF result.source_id IS NULL THEN
  SELECT * INTO result FROM app.creative_media_video_probes
   WHERE workspace_id=p_workspace AND source_id=p_source;
  IF result.source_sha256 IS DISTINCT FROM p_source_sha OR result.status IS DISTINCT FROM status
    OR result.checker_version IS DISTINCT FROM checker OR result.duration_ms IS DISTINCT FROM duration
    OR result.width IS DISTINCT FROM w OR result.height IS DISTINCT FROM h OR result.frame_rate IS DISTINCT FROM fps
    OR result.video_codec IS DISTINCT FROM codec OR result.audio_present IS DISTINCT FROM audio
    OR result.rejection_code IS DISTINCT FROM code THEN
   RAISE EXCEPTION 'Probe replay changed receipt' USING ERRCODE='40001'; END IF;
  RETURN jsonb_build_object('replayed',true,'status',result.status);
 END IF;
 RETURN jsonb_build_object('replayed',false,'status',result.status);
END $f$;
REVOKE ALL ON FUNCTION app_private.creative_media_video_probe_source(uuid,uuid),
 app_private.creative_media_video_probe_record(uuid,uuid,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.creative_media_video_probe_source(uuid,uuid),
 app_private.creative_media_video_probe_record(uuid,uuid,text,jsonb) TO r72_worker;
RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_native_video_definer;
GRANT CREATE ON SCHEMA app_private TO r72_creative_studio_definer;
SET LOCAL ROLE r72_creative_studio_definer;
CREATE FUNCTION app_private.creative_media_video_probe_owner_list(p_workspace uuid,p_session bytea)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 IF p_session IS NULL OR app_private.current_actor_kind()<>'user' THEN
  RAISE EXCEPTION 'Signed-in owner required' USING ERRCODE='42501'; END IF;
 PERFORM app_private.seo_media_owner(p_workspace,p_session);
 RETURN coalesce((SELECT jsonb_agg(jsonb_build_object(
  'sourceId',p.source_id,'status',p.status,'durationMs',p.duration_ms,
  'width',p.width,'height',p.height,'frameRate',p.frame_rate,
  'videoCodec',p.video_codec,'audioPresent',p.audio_present,'rejectionCode',p.rejection_code)
  ORDER BY p.created_at DESC) FROM app.creative_media_video_probes p
  WHERE p.workspace_id=p_workspace),'[]'::jsonb);
END $f$;
REVOKE ALL ON FUNCTION app_private.creative_media_video_probe_owner_list(uuid,bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.creative_media_video_probe_owner_list(uuid,bytea) TO r72_content_command;
RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_creative_studio_definer;
