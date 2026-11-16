-- PRIVATE DRAFT: large private sources in the SAME canonical source catalogue.
-- Physical objects reside on a configured private durable filesystem, never public URLs.
SET LOCAL ROLE r72_owner;
CREATE TABLE app.creative_media_object_uploads (
 workspace_id uuid NOT NULL REFERENCES app.seo_blog_brands(workspace_id), id uuid NOT NULL,
 metadata jsonb NOT NULL CHECK(jsonb_typeof(metadata)='object' AND octet_length(metadata::text)<=3000),
 byte_length bigint NOT NULL CHECK(byte_length BETWEEN 1024 AND 1073741824),
 sha256 text NOT NULL CHECK(sha256~'^[a-f0-9]{64}$'),
 state text NOT NULL DEFAULT 'uploading' CHECK(state IN('uploading','completed','cancelled')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '24 hours',
 PRIMARY KEY(workspace_id,id)
);
ALTER TABLE app.creative_media_object_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.creative_media_object_uploads FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app.creative_media_object_uploads FROM PUBLIC,r72_web,r72_worker,r72_content_command;
CREATE POLICY creative_media_object_uploads_owner ON app.creative_media_object_uploads FOR ALL TO r72_owner USING(true) WITH CHECK(true);
CREATE POLICY creative_media_object_uploads_scope ON app.creative_media_object_uploads FOR ALL TO r72_creative_studio_definer USING(workspace_id=app_private.current_workspace_id()) WITH CHECK(workspace_id=app_private.current_workspace_id());
GRANT SELECT,INSERT,UPDATE ON app.creative_media_object_uploads TO r72_creative_studio_definer;
INSERT INTO app_private.workspace_table_registry(schema_name,table_name,workspace_column) VALUES('app','creative_media_object_uploads','workspace_id');
GRANT CREATE ON SCHEMA app_private TO r72_creative_studio_definer;
SET LOCAL ROLE r72_creative_studio_definer;
CREATE FUNCTION app_private.creative_media_object_upload(p_workspace uuid,p_session bytea,p_action text,p_id uuid,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; u app.creative_media_object_uploads; key text; total bigint;
BEGIN
 IF p_session IS NULL OR app_private.current_actor_kind() IS DISTINCT FROM 'user' OR p_id IS NULL THEN RAISE EXCEPTION 'Owner session required' USING ERRCODE='42501'; END IF;
 actor:=app_private.seo_media_owner(p_workspace,p_session);
 IF coalesce(p_action,'') NOT IN('begin','status','complete','cancel','source') OR p_input IS NULL OR jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR octet_length(p_input::text)>4000 THEN RAISE EXCEPTION 'Invalid object upload command' USING ERRCODE='22023'; END IF;
 IF p_action='source' THEN
  RETURN (SELECT jsonb_build_object('workspaceId',s.workspace_id,'sourceId',s.id,'sha256',s.sha256,'byteLength',s.byte_length,'mime',s.mime,'objectKey',s.object_key)
   FROM app.creative_media_source_videos s WHERE workspace_id=p_workspace AND id=p_id AND storage_kind='private_object' AND NOT EXISTS(SELECT 1 FROM app.creative_media_erasures e WHERE e.workspace_id=p_workspace AND e.kind='source' AND e.id=p_id)); END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('media-object-upload:'||p_workspace::text,0));
 SELECT * INTO u FROM app.creative_media_object_uploads WHERE workspace_id=p_workspace AND id=p_id FOR UPDATE;
 IF p_action='begin' THEN
  IF coalesce(p_input->>'byteLength','')!~'^[0-9]{4,10}$' OR (p_input->>'byteLength')::bigint NOT BETWEEN 1024 AND 1073741824
   OR coalesce(p_input->>'sha256','')!~'^[a-f0-9]{64}$' OR p_input->>'rightsConfirmed' IS DISTINCT FROM 'true'
   OR coalesce(p_input->>'rights','') NOT IN('owned','licensed') OR coalesce(p_input->>'mime','') NOT IN('video/mp4','video/webm')
   OR length(coalesce(p_input->>'fileName','')) NOT BETWEEN 1 AND 160 OR p_input->>'fileName'~'[[:cntrl:]<>/\\]'
   OR (p_input->>'mime'='video/mp4' AND lower(right(p_input->>'fileName',4))<>'.mp4')
   OR (p_input->>'mime'='video/webm' AND lower(right(p_input->>'fileName',5))<>'.webm')
   OR (p_input->>'rights'='licensed' AND coalesce(p_input->>'evidenceSha256','')!~'^[a-f0-9]{64}$')
   OR (p_input->>'evidenceSha256' IS NOT NULL AND p_input->>'evidenceSha256'!~'^[a-f0-9]{64}$') THEN RAISE EXCEPTION 'Exact object metadata and rights required' USING ERRCODE='22023'; END IF;
  IF u.id IS NOT NULL THEN
   IF u.metadata IS DISTINCT FROM p_input THEN RAISE EXCEPTION 'Object upload replay changed metadata' USING ERRCODE='40001'; END IF;
  ELSE
   IF EXISTS(SELECT 1 FROM app.creative_media_source_videos WHERE workspace_id=p_workspace AND id=p_id) THEN RAISE EXCEPTION 'Source identity already catalogued' USING ERRCODE='40001'; END IF;
   IF (SELECT count(*) FROM app.creative_media_object_uploads WHERE workspace_id=p_workspace AND state='uploading' AND expires_at>clock_timestamp())>=3 THEN RAISE EXCEPTION 'Pending object upload cap reached' USING ERRCODE='55000'; END IF;
   SELECT coalesce(sum(byte_length),0) INTO total FROM app.creative_media_source_videos WHERE workspace_id=p_workspace AND storage_kind='private_object' AND NOT EXISTS(SELECT 1 FROM app.creative_media_erasures e WHERE e.workspace_id=p_workspace AND e.id=creative_media_source_videos.id AND e.kind='source' AND e.erased_at IS NOT NULL);
   total:=total+(SELECT coalesce(sum(byte_length),0) FROM app.creative_media_object_uploads WHERE workspace_id=p_workspace AND state='uploading' AND expires_at>clock_timestamp());
   IF total+(p_input->>'byteLength')::bigint>10737418240 THEN RAISE EXCEPTION 'Private workspace storage cap reached' USING ERRCODE='55000'; END IF;
   INSERT INTO app.creative_media_object_uploads(workspace_id,id,metadata,byte_length,sha256) VALUES(p_workspace,p_id,p_input,(p_input->>'byteLength')::bigint,p_input->>'sha256') RETURNING * INTO u;
  END IF;
 END IF;
 IF u.id IS NULL THEN RAISE EXCEPTION 'Private object upload unavailable' USING ERRCODE='42501'; END IF;
 key:=p_workspace::text||'/'||p_id::text||'/'||u.sha256||CASE WHEN u.metadata->>'mime'='video/mp4' THEN '.mp4' ELSE '.webm' END;
 IF p_action='cancel' THEN
  IF u.state='completed' THEN RAISE EXCEPTION 'Completed source cannot be cancelled as an upload' USING ERRCODE='55000'; END IF;
  UPDATE app.creative_media_object_uploads SET state='cancelled' WHERE workspace_id=p_workspace AND id=p_id RETURNING * INTO u;
 ELSIF p_action='complete' THEN
  IF u.state='cancelled' OR (u.state='uploading' AND u.expires_at<=clock_timestamp()) THEN RAISE EXCEPTION 'Object upload closed or expired' USING ERRCODE='55000'; END IF;
  -- Bytes are independently checked by the private filesystem service and later worker probe.
  -- This record remains awaiting_probe, never technically or publicly approved.
  IF EXISTS(SELECT 1 FROM app.creative_media_source_videos WHERE workspace_id=p_workspace AND id=p_id AND (storage_kind IS DISTINCT FROM 'private_object' OR object_key IS DISTINCT FROM key OR sha256 IS DISTINCT FROM u.sha256 OR byte_length IS DISTINCT FROM u.byte_length)) THEN RAISE EXCEPTION 'Canonical object identity changed' USING ERRCODE='40001'; END IF;
  INSERT INTO app.creative_media_source_videos(workspace_id,id,command_id,blob_id,storage_kind,object_key,file_name,sha256,byte_length,mime,rights,evidence_sha256,owner_user_id)
   VALUES(p_workspace,p_id,p_id,NULL,'private_object',key,u.metadata->>'fileName',u.sha256,u.byte_length,u.metadata->>'mime',u.metadata->>'rights',u.metadata->>'evidenceSha256',actor) ON CONFLICT DO NOTHING;
  UPDATE app.creative_media_object_uploads SET state='completed' WHERE workspace_id=p_workspace AND id=p_id RETURNING * INTO u;
 END IF;
 RETURN jsonb_build_object('workspaceId',p_workspace,'sourceId',p_id,'sha256',u.sha256,'byteLength',u.byte_length,'mime',u.metadata->>'mime','objectKey',key,'state',u.state,'expiresAt',u.expires_at,'partBytes',8388608);
END $f$;
REVOKE ALL ON FUNCTION app_private.creative_media_object_upload(uuid,bytea,text,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.creative_media_object_upload(uuid,bytea,text,uuid,jsonb) TO r72_content_command;
RESET ROLE;SET LOCAL ROLE r72_owner;REVOKE CREATE ON SCHEMA app_private FROM r72_creative_studio_definer;
GRANT CREATE ON SCHEMA app_private TO r72_media_job_definer;
SET LOCAL ROLE r72_media_job_definer;
CREATE FUNCTION app_private.creative_media_object_source_worker(p_workspace uuid,p_source uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 IF app_private.current_actor_kind() IS DISTINCT FROM 'worker' OR app_private.current_workspace_id() IS DISTINCT FROM p_workspace THEN RAISE EXCEPTION 'Scoped source worker required' USING ERRCODE='42501'; END IF;
 RETURN (SELECT jsonb_build_object('workspaceId',s.workspace_id,'sourceId',s.id,'sha256',s.sha256,'byteLength',s.byte_length,'mime',s.mime,'objectKey',s.object_key) FROM app.creative_media_source_videos s WHERE workspace_id=p_workspace AND id=p_source AND storage_kind='private_object' AND NOT EXISTS(SELECT 1 FROM app.creative_media_erasures e WHERE e.workspace_id=p_workspace AND e.kind='source' AND e.id=p_source));
END $f$;
REVOKE ALL ON FUNCTION app_private.creative_media_object_source_worker(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.creative_media_object_source_worker(uuid,uuid) TO r72_worker;
RESET ROLE;SET LOCAL ROLE r72_owner;REVOKE CREATE ON SCHEMA app_private FROM r72_media_job_definer;
-- Explicit scoped housekeeping for expired/cancelled staging and orphaned assembly.
SET LOCAL ROLE r72_owner;
ALTER TABLE app.creative_media_object_uploads ADD COLUMN last_cleanup_at timestamptz;
CREATE POLICY creative_media_object_uploads_cleanup ON app.creative_media_object_uploads FOR ALL TO r72_media_job_definer USING(workspace_id=app_private.current_workspace_id()) WITH CHECK(workspace_id=app_private.current_workspace_id());
GRANT SELECT,UPDATE ON app.creative_media_object_uploads TO r72_media_job_definer;
GRANT CREATE ON SCHEMA app_private TO r72_media_job_definer;
SET LOCAL ROLE r72_media_job_definer;
CREATE FUNCTION app_private.creative_media_object_cleanup(p_workspace uuid,p_limit integer)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE u app.creative_media_object_uploads;result jsonb:='[]'::jsonb;
BEGIN
 IF app_private.current_actor_kind() IS DISTINCT FROM 'worker' OR app_private.current_workspace_id() IS DISTINCT FROM p_workspace THEN RAISE EXCEPTION 'Scoped cleanup worker required' USING ERRCODE='42501'; END IF;
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 10 THEN RAISE EXCEPTION 'Bounded cleanup required' USING ERRCODE='22023'; END IF;
 FOR u IN SELECT * FROM app.creative_media_object_uploads WHERE workspace_id=p_workspace AND (state='cancelled' OR (state='uploading' AND expires_at<=clock_timestamp()))
  AND (last_cleanup_at IS NULL OR last_cleanup_at<clock_timestamp()-interval '1 hour')
  ORDER BY last_cleanup_at NULLS FIRST,created_at,id LIMIT p_limit FOR UPDATE SKIP LOCKED LOOP
  IF NOT EXISTS(SELECT 1 FROM app.creative_media_source_videos WHERE workspace_id=p_workspace AND id=u.id) THEN
   UPDATE app.creative_media_object_uploads SET state='cancelled',last_cleanup_at=clock_timestamp() WHERE workspace_id=p_workspace AND id=u.id;
   result:=result||jsonb_build_array(jsonb_build_object('workspaceId',p_workspace,'sourceId',u.id,'sha256',u.sha256,'byteLength',u.byte_length,'mime',u.metadata->>'mime',
    'objectKey',p_workspace::text||'/'||u.id::text||'/'||u.sha256||CASE WHEN u.metadata->>'mime'='video/mp4' THEN '.mp4' ELSE '.webm' END));
  END IF;
 END LOOP;RETURN result;
END $f$;
REVOKE ALL ON FUNCTION app_private.creative_media_object_cleanup(uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.creative_media_object_cleanup(uuid,integer) TO r72_worker;
RESET ROLE;SET LOCAL ROLE r72_owner;REVOKE CREATE ON SCHEMA app_private FROM r72_media_job_definer;
