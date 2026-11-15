-- 0160: owner-only byte reads for private source preview. No public URL or provider handoff.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
SET LOCAL ROLE r72_owner;
GRANT CREATE ON SCHEMA app_private TO r72_creative_studio_definer;
SET LOCAL ROLE r72_creative_studio_definer;
CREATE FUNCTION app_private.creative_media_video_source_bytes(
  p_workspace uuid,p_session bytea,p_source uuid
) RETURNS TABLE(mime text,bytes bytea,sha256 text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid;
BEGIN
  IF p_session IS NULL OR app_private.current_actor_kind()<>'user'
    OR app_private.current_workspace_id() IS DISTINCT FROM p_workspace THEN
    RAISE EXCEPTION 'Private source owner session required' USING ERRCODE='42501'; END IF;
  actor:=app_private.seo_media_owner(p_workspace,p_session);
  RETURN QUERY
  SELECT s.mime,b.bytes,s.sha256
    FROM app.creative_media_source_videos s
    JOIN app.seo_blog_blobs b ON b.workspace_id=s.workspace_id AND b.id=s.blob_id
    WHERE s.workspace_id=p_workspace AND s.id=p_source
      AND s.state='awaiting_probe'
      AND s.sha256=encode(public.digest(b.bytes,'sha256'),'hex')
      AND s.sha256=encode(b.sha256,'hex')
      AND s.byte_length=octet_length(b.bytes);
END $f$;
REVOKE ALL ON FUNCTION app_private.creative_media_video_source_bytes(uuid,bytea,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.creative_media_video_source_bytes(uuid,bytea,uuid)
 TO r72_content_command;
RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_creative_studio_definer;
