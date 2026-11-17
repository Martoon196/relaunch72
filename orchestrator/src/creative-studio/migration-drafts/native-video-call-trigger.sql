-- Isolated native-video trigger boundary. Text/image jobs never enter the media guard.
SET LOCAL ROLE r72_owner;
GRANT EXECUTE ON FUNCTION app_private.current_workspace_id(),app_private.current_actor_kind() TO r72_media_job_definer;
CREATE FUNCTION app_private.creative_media_job_has_native_video(p_workspace uuid,p_job uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT EXISTS(SELECT 1 FROM app.property_predator_owned_social_job_media m JOIN app.company_content_versions v ON v.workspace_id=m.workspace_id AND v.id=m.content_version_id WHERE m.workspace_id=p_workspace AND m.job_id=p_job AND v.source_system='relaunch72.private-video' AND v.content_kind='video')
$f$;
REVOKE ALL ON FUNCTION app_private.creative_media_job_has_native_video(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.creative_media_job_has_native_video(uuid,uuid) TO r72_owned_social_definer,r72_owned_social_worker_command;
CREATE TRIGGER creative_media_native_video_call_guard BEFORE UPDATE OF state ON app.property_predator_owned_social_jobs
FOR EACH ROW WHEN (NEW.state='calling' AND OLD.state IS DISTINCT FROM 'calling' AND app_private.creative_media_job_has_native_video(NEW.workspace_id,NEW.id))
EXECUTE FUNCTION app_private.creative_media_video_call_guard();
