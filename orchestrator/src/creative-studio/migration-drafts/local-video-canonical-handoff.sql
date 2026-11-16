-- PRIVATE DRAFT. Exact owner-reviewed local video -> canonical pending review.
-- This capability does not approve, release bytes, schedule or publish.
SET LOCAL ROLE r72_owner;
GRANT CREATE ON SCHEMA app_private TO r72_creative_studio_definer;
SET LOCAL ROLE r72_creative_studio_definer;
CREATE FUNCTION app_private.creative_media_local_manifest(p_workspace uuid,p_session bytea,p_output uuid,p_revision integer,p_sha text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE o app.creative_media_local_render_outputs; r app.creative_media_local_output_reviews; brand jsonb;
BEGIN
 IF p_session IS NULL OR app_private.current_actor_kind() IS DISTINCT FROM 'user' THEN RAISE EXCEPTION 'Exact owner session required' USING ERRCODE='42501'; END IF;
 PERFORM app_private.seo_media_owner(p_workspace,p_session);
 PERFORM pg_advisory_xact_lock(hashtextextended('rl72-local-output-review:'||p_workspace::text||':'||p_output::text,0));
 SELECT * INTO o FROM app.creative_media_local_render_outputs WHERE workspace_id=p_workspace AND id=p_output;
 SELECT * INTO r FROM app.creative_media_local_output_reviews WHERE workspace_id=p_workspace AND output_id=p_output ORDER BY revision DESC LIMIT 1;
 IF o.id IS NULL OR o.sha256 IS DISTINCT FROM p_sha OR r.revision IS DISTINCT FROM p_revision
  OR r.decision IS DISTINCT FROM 'reviewed_private' OR r.output_sha256 IS DISTINCT FROM o.sha256
  OR NOT EXISTS(SELECT 1 FROM app.seo_blog_blobs b WHERE b.workspace_id=p_workspace AND b.id=o.blob_id
    AND o.sha256=encode(public.digest(b.bytes,'sha256'),'hex') AND o.byte_length=octet_length(b.bytes)) THEN
  RAISE EXCEPTION 'Exact current private review required' USING ERRCODE='55000'; END IF;
 brand:=to_jsonb(app_private.seo_blog_brand(p_workspace));
 IF brand IS NULL THEN RAISE EXCEPTION 'Brand snapshot unavailable' USING ERRCODE='42501'; END IF;
 RETURN jsonb_build_object('schema','relaunch72.private-video/v1','workspaceId',p_workspace,'outputId',o.id,
  'sha256',o.sha256,'sourceSha256',o.source_sha256,'planSha256',o.plan_sha256,'byteLength',o.byte_length,
  'durationMs',o.duration_ms,'width',o.width,'height',o.height,'audioPresent',o.audio_present,
  'storageKey','seo-blog/blobs/'||p_workspace::text||'/'||o.blob_id::text,
  'reviewRevision',r.revision,'reviewedAt',r.created_at,'reviewedBy',r.reviewed_by,
  'brandSha256',encode(public.digest(brand::text,'sha256'),'hex'));
END $f$;
REVOKE ALL ON FUNCTION app_private.creative_media_local_manifest(uuid,bytea,uuid,integer,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.creative_media_local_manifest(uuid,bytea,uuid,integer,text) TO r72_content_command,r72_content_adapter;
RESET ROLE;SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_creative_studio_definer;
