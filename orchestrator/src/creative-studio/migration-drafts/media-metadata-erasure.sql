-- Erase owner text while retaining digest/identity audit evidence. Only tombstoned source metadata may change.
SET LOCAL ROLE r72_owner;
GRANT UPDATE(file_name) ON app.creative_media_source_videos TO r72_native_video_definer;
GRANT UPDATE(plan) ON app.creative_media_edit_projects TO r72_native_video_definer;
GRANT SELECT,UPDATE(metadata) ON app.creative_media_object_uploads TO r72_native_video_definer;
CREATE POLICY metadata_erasure_source ON app.creative_media_source_videos FOR UPDATE TO r72_native_video_definer USING(workspace_id=app_private.current_workspace_id()) WITH CHECK(workspace_id=app_private.current_workspace_id());
CREATE POLICY metadata_erasure_edit ON app.creative_media_edit_projects FOR UPDATE TO r72_native_video_definer USING(workspace_id=app_private.current_workspace_id()) WITH CHECK(workspace_id=app_private.current_workspace_id());
CREATE POLICY metadata_erasure_upload ON app.creative_media_object_uploads FOR ALL TO r72_native_video_definer USING(workspace_id=app_private.current_workspace_id()) WITH CHECK(workspace_id=app_private.current_workspace_id());
CREATE FUNCTION app_private.creative_media_metadata_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 IF TG_OP='UPDATE' AND app_private.current_actor_kind()='worker' AND app_private.current_workspace_id()=OLD.workspace_id AND EXISTS(SELECT 1 FROM app.creative_media_erasures e WHERE e.workspace_id=OLD.workspace_id AND e.kind='source' AND e.id=coalesce((to_jsonb(OLD)->>'source_id')::uuid,OLD.id)) THEN
  IF TG_TABLE_NAME='creative_media_source_videos' AND to_jsonb(NEW)->>'file_name'='Deleted video' AND (to_jsonb(NEW)-'file_name')=(to_jsonb(OLD)-'file_name') THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME='creative_media_edit_projects' AND to_jsonb(NEW)->'plan'='{"erased":true}'::jsonb AND (to_jsonb(NEW)-'plan')=(to_jsonb(OLD)-'plan') THEN RETURN NEW; END IF;
 END IF;
 RAISE EXCEPTION 'Media records are immutable except tombstoned owner text erasure' USING ERRCODE='55000';
END $f$;
REVOKE ALL ON FUNCTION app_private.creative_media_metadata_guard() FROM PUBLIC;
DROP TRIGGER creative_media_source_videos_immutable ON app.creative_media_source_videos;
CREATE TRIGGER creative_media_source_videos_immutable BEFORE UPDATE OR DELETE ON app.creative_media_source_videos FOR EACH ROW EXECUTE FUNCTION app_private.creative_media_metadata_guard();
DROP TRIGGER creative_media_edit_projects_immutable ON app.creative_media_edit_projects;
CREATE TRIGGER creative_media_edit_projects_immutable BEFORE UPDATE OR DELETE ON app.creative_media_edit_projects FOR EACH ROW EXECUTE FUNCTION app_private.creative_media_metadata_guard();
