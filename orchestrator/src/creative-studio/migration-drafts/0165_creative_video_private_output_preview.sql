-- Owner-only preview of captured but unapproved media; no social or payment capability.
SET LOCAL lock_timeout='5s';SET LOCAL statement_timeout='60s';
SET LOCAL ROLE r72_owner;
GRANT CREATE ON SCHEMA app_private TO r72_creative_studio_definer;
SET LOCAL ROLE r72_creative_studio_definer;
CREATE FUNCTION app_private.creative_media_video_output_bytes(
 p_workspace uuid,p_session bytea,p_output uuid
) RETURNS TABLE(mime text,bytes bytea,sha256 text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 IF p_session IS NULL OR app_private.current_actor_kind()<>'user'
   OR app_private.current_workspace_id() IS DISTINCT FROM p_workspace THEN
  RAISE EXCEPTION 'Private output owner required' USING ERRCODE='42501'; END IF;
 PERFORM app_private.seo_media_owner(p_workspace,p_session);
 RETURN QUERY SELECT o.mime,b.bytes,o.sha256
 FROM app.creative_media_video_outputs o JOIN app.seo_blog_blobs b
 ON b.workspace_id=o.workspace_id AND b.id=o.blob_id
 WHERE o.workspace_id=p_workspace AND o.id=p_output AND NOT EXISTS(SELECT 1 FROM app.creative_media_erasures e WHERE e.workspace_id=p_workspace AND e.kind='provider_output' AND e.id=p_output) AND o.state='captured_unverified'
 AND o.sha256=encode(b.sha256,'hex')
 AND o.sha256=encode(public.digest(b.bytes,'sha256'),'hex')
 AND o.byte_length=octet_length(b.bytes);
END $f$;
REVOKE ALL ON FUNCTION app_private.creative_media_video_output_bytes(uuid,bytea,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.creative_media_video_output_bytes(uuid,bytea,uuid)
 TO r72_content_command;
RESET ROLE;SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_creative_studio_definer;
