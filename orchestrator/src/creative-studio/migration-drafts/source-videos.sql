-- Private source intake reuses the existing workspace blob store. No publish/provider permission.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
SET LOCAL ROLE r72_owner;
CREATE TABLE app.creative_media_source_videos(
  workspace_id uuid NOT NULL REFERENCES app.seo_blog_brands(workspace_id),
  id uuid NOT NULL DEFAULT gen_random_uuid(), command_id uuid NOT NULL,
  blob_id uuid,
  storage_kind text NOT NULL DEFAULT 'pg_blob' CHECK(storage_kind IN('pg_blob','private_object')),
  object_key text,
  file_name text NOT NULL CHECK(length(file_name) BETWEEN 1 AND 160),
  sha256 text NOT NULL CHECK(sha256~'^[a-f0-9]{64}$'),
  byte_length integer NOT NULL CHECK(byte_length BETWEEN 1024 AND 1073741824),
  mime text NOT NULL CHECK(mime IN ('video/mp4','video/webm')),
  rights text NOT NULL CHECK(rights IN ('owned','licensed')),
  evidence_sha256 text CHECK(evidence_sha256 IS NULL OR evidence_sha256~'^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'awaiting_probe' CHECK(state='awaiting_probe'),
  owner_user_id uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,command_id),
  FOREIGN KEY(workspace_id,blob_id) REFERENCES app.seo_blog_blobs(workspace_id,id),
  CHECK((storage_kind='pg_blob' AND blob_id IS NOT NULL AND object_key IS NULL AND byte_length<=20000000) OR (storage_kind='private_object' AND blob_id IS NULL AND object_key IS NOT NULL)),
  CHECK(rights<>'licensed' OR evidence_sha256 IS NOT NULL)
);
ALTER TABLE app.creative_media_source_videos ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.creative_media_source_videos FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app.creative_media_source_videos FROM PUBLIC,r72_web,r72_worker,r72_content_command;
CREATE POLICY creative_media_source_videos_owner ON app.creative_media_source_videos
  FOR ALL TO r72_owner USING(true) WITH CHECK(true);
CREATE POLICY creative_media_source_videos_scope ON app.creative_media_source_videos
  FOR ALL TO r72_creative_studio_definer
  USING(workspace_id=app_private.current_workspace_id())
  WITH CHECK(workspace_id=app_private.current_workspace_id());
GRANT SELECT,INSERT ON app.creative_media_source_videos TO r72_creative_studio_definer;
CREATE TRIGGER creative_media_source_videos_immutable
  BEFORE UPDATE OR DELETE ON app.creative_media_source_videos
  FOR EACH ROW EXECUTE FUNCTION app_private.seo_blog_append_only();
INSERT INTO app_private.workspace_table_registry(schema_name,table_name,workspace_column)
  VALUES('app','creative_media_source_videos','workspace_id');
GRANT INSERT ON app.seo_blog_blobs TO r72_creative_studio_definer;
CREATE POLICY seo_blog_blobs_creative_video_source_insert ON app.seo_blog_blobs
  FOR INSERT TO r72_creative_studio_definer
  WITH CHECK(workspace_id=app_private.current_workspace_id()
    AND mime IN('video/mp4','video/webm')
    AND octet_length(bytes) BETWEEN 1024 AND 20000000
    AND sha256=public.digest(bytes,'sha256'));
GRANT CREATE ON SCHEMA app_private TO r72_creative_studio_definer;
SET LOCAL ROLE r72_creative_studio_definer;
CREATE FUNCTION app_private.creative_media_video_source_command(
  p_workspace uuid,p_session bytea,p_action text,p_command uuid,p_meta jsonb,p_bytes bytea
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; source app.creative_media_source_videos; blob uuid; hash text;
  fname text; mime text; rights text; evidence text;
BEGIN
  IF p_session IS NULL OR app_private.current_actor_kind()<>'user' THEN
    RAISE EXCEPTION 'Active video owner session required' USING ERRCODE='42501'; END IF;
  actor:=app_private.seo_media_owner(p_workspace,p_session);
  IF app_private.seo_blog_brand(p_workspace) IS NULL THEN
    RAISE EXCEPTION 'Brand not available' USING ERRCODE='42501'; END IF;
  IF p_action='list' THEN
    RETURN coalesce((SELECT jsonb_agg(jsonb_build_object(
      'id',s.id,'fileName',s.file_name,'sha256',s.sha256,'byteLength',s.byte_length,
      'mime',s.mime,'rights',s.rights,'evidenceSha256',s.evidence_sha256,
      'state',CASE WHEN EXISTS(SELECT 1 FROM app.creative_media_erasures e WHERE e.workspace_id=s.workspace_id AND e.kind='source' AND e.id=s.id) THEN 'deleted' WHEN EXISTS(SELECT 1 FROM app.creative_media_video_probes p WHERE p.workspace_id=s.workspace_id AND p.source_id=s.id) THEN (SELECT p.status FROM app.creative_media_video_probes p WHERE p.workspace_id=s.workspace_id AND p.source_id=s.id) WHEN EXISTS(SELECT 1 FROM app.creative_media_probe_retries r WHERE r.workspace_id=s.workspace_id AND r.source_id=s.id) THEN 'retry_pending' ELSE coalesce((SELECT p.status FROM app.creative_media_video_probes p WHERE p.workspace_id=s.workspace_id AND p.source_id=s.id),s.state) END,'createdAt',s.created_at,'storageKind',s.storage_kind) ORDER BY s.created_at DESC)
      FROM app.creative_media_source_videos s WHERE s.workspace_id=p_workspace),'[]'::jsonb);
  END IF;
  IF p_action<>'upload' OR p_command IS NULL OR p_meta IS NULL OR p_bytes IS NULL
    OR jsonb_typeof(p_meta)<>'object' OR octet_length(p_meta::text)>1024
    OR octet_length(p_bytes) NOT BETWEEN 1024 AND 20000000
    OR p_meta->>'rightsConfirmed' IS DISTINCT FROM 'true'
    OR p_meta->>'rights' NOT IN('owned','licensed') THEN
    RAISE EXCEPTION 'Invalid private video upload' USING ERRCODE='22023'; END IF;
  hash:=encode(public.digest(p_bytes,'sha256'),'hex');
  fname:=p_meta->>'fileName';mime:=p_meta->>'mime';rights:=p_meta->>'rights';
  evidence:=NULLIF(p_meta->>'evidenceSha256','');
  IF hash IS DISTINCT FROM p_meta->>'sha256'
    OR fname IS NULL OR length(fname) NOT BETWEEN 1 AND 160
    OR fname~'[[:cntrl:]<>/\\]'
    OR mime NOT IN('video/mp4','video/webm')
    OR (rights='licensed' AND coalesce(evidence,'') !~ '^[a-f0-9]{64}$')
    OR (evidence IS NOT NULL AND evidence !~ '^[a-f0-9]{64}$')
    OR (mime='video/mp4' AND (
       right(lower(fname),4)<>'.mp4' OR substring(p_bytes from 5 for 4)<>decode('66747970','hex')))
    OR (mime='video/webm' AND (
       right(lower(fname),5)<>'.webm' OR substring(p_bytes from 1 for 4)<>decode('1a45dfa3','hex'))) THEN
    RAISE EXCEPTION 'Source digest, container or rights mismatch' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('rl72-media-source:'||p_workspace::text,0));
  SELECT * INTO source FROM app.creative_media_source_videos
    WHERE workspace_id=p_workspace AND command_id=p_command;
  IF source.id IS NOT NULL THEN
    IF source.sha256 IS DISTINCT FROM hash OR source.file_name IS DISTINCT FROM fname
       OR source.mime IS DISTINCT FROM mime OR source.rights IS DISTINCT FROM rights
       OR source.evidence_sha256 IS DISTINCT FROM evidence THEN
      RAISE EXCEPTION 'Video source command replay changed input' USING ERRCODE='40001'; END IF;
    RETURN jsonb_build_object('id',source.id,'sha256',source.sha256,
      'replayed',true,'state',source.state);
  END IF;
  IF (SELECT count(*) FROM app.creative_media_source_videos s WHERE workspace_id=p_workspace AND storage_kind='pg_blob' AND NOT EXISTS(SELECT 1 FROM app.creative_media_erasures e WHERE e.workspace_id=p_workspace AND e.kind='source' AND e.id=s.id AND e.erased_at IS NOT NULL))>=50 OR (SELECT coalesce(sum(byte_length),0) FROM app.creative_media_source_videos s WHERE workspace_id=p_workspace AND storage_kind='pg_blob' AND NOT EXISTS(SELECT 1 FROM app.creative_media_erasures e WHERE e.workspace_id=p_workspace AND e.kind='source' AND e.id=s.id AND e.erased_at IS NOT NULL))+octet_length(p_bytes)>200000000 THEN RAISE EXCEPTION 'Your video library is full (50 uploads or 200 MB). Delete unused sources before uploading.' USING ERRCODE='54000'; END IF;
  blob:=gen_random_uuid();
  INSERT INTO app.seo_blog_blobs(workspace_id,id,mime,bytes,sha256)
    VALUES(p_workspace,blob,mime,p_bytes,public.digest(p_bytes,'sha256'));
  INSERT INTO app.creative_media_source_videos(workspace_id,command_id,blob_id,file_name,
    sha256,byte_length,mime,rights,evidence_sha256,owner_user_id)
    VALUES(p_workspace,p_command,blob,fname,hash,octet_length(p_bytes),mime,rights,evidence,actor)
    RETURNING * INTO source;
  RETURN jsonb_build_object('id',source.id,'sha256',source.sha256,
    'replayed',false,'state',source.state);
END $f$;
REVOKE ALL ON FUNCTION app_private.creative_media_video_source_command(uuid,bytea,text,uuid,jsonb,bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.creative_media_video_source_command(uuid,bytea,text,uuid,jsonb,bytea)
  TO r72_content_command;
RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_creative_studio_definer;
