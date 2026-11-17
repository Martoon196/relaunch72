-- Owner erase and opt-in retention. No default library expiry.
SET LOCAL ROLE r72_owner;
CREATE TABLE app.creative_media_retention_settings(workspace_id uuid PRIMARY KEY REFERENCES app.seo_blog_brands(workspace_id),source_output_days integer CHECK(source_output_days BETWEEN 1 AND 3650));
ALTER TABLE app.creative_media_retention_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.creative_media_retention_settings FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app.creative_media_retention_settings FROM PUBLIC,r72_web,r72_worker,r72_content_command;
CREATE POLICY media_retention_settings_owner ON app.creative_media_retention_settings FOR ALL TO r72_owner USING(true) WITH CHECK(true);
CREATE POLICY media_retention_settings_worker ON app.creative_media_retention_settings FOR SELECT TO r72_native_video_definer USING(workspace_id=app_private.current_workspace_id());
GRANT SELECT ON app.creative_media_retention_settings TO r72_native_video_definer;
INSERT INTO app_private.workspace_table_registry(schema_name,table_name,workspace_column) VALUES('app','creative_media_retention_settings','workspace_id');
-- Missing row or NULL means retain indefinitely; operator must record the owner's explicit retention choice.
GRANT SELECT,UPDATE ON app.seo_blog_blobs TO r72_native_video_definer;
CREATE POLICY media_payload_erase ON app.seo_blog_blobs FOR UPDATE TO r72_native_video_definer USING(workspace_id=app_private.current_workspace_id()) WITH CHECK(workspace_id=app_private.current_workspace_id());
GRANT CREATE ON SCHEMA app_private TO r72_creative_studio_definer;
SET LOCAL ROLE r72_creative_studio_definer;
CREATE FUNCTION app_private.creative_media_erase_owner(p_workspace uuid,p_session bytea,p_kind text,p_id uuid)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid;
BEGIN
 IF app_private.current_actor_kind() IS DISTINCT FROM 'user' THEN RAISE EXCEPTION 'Owner required' USING ERRCODE='42501'; END IF;
 actor:=app_private.seo_media_owner(p_workspace,p_session);
 PERFORM pg_advisory_xact_lock(hashtextextended('rl72-media-lifecycle:'||p_workspace::text,0));

 IF NOT ((p_kind='source' AND EXISTS(SELECT 1 FROM app.creative_media_source_videos WHERE workspace_id=p_workspace AND id=p_id)) OR (p_kind='local_output' AND EXISTS(SELECT 1 FROM app.creative_media_local_render_outputs WHERE workspace_id=p_workspace AND id=p_id))) THEN RAISE EXCEPTION 'Private asset unavailable' USING ERRCODE='42501'; END IF;
 INSERT INTO app.creative_media_erasures(workspace_id,id,kind,requested_by,reason) VALUES(p_workspace,p_id,p_kind,actor,'owner') ON CONFLICT DO NOTHING;
 -- Source erasure immediately takes down its derived local outputs as well.
 IF p_kind='source' THEN
 INSERT INTO app.creative_media_erasures(workspace_id,id,kind,requested_by,reason)
 SELECT p_workspace,o.id,'local_output',actor,'owner' FROM app.creative_media_local_render_outputs o JOIN app.creative_media_local_render_jobs j ON j.workspace_id=o.workspace_id AND j.id=o.job_id WHERE j.workspace_id=p_workspace AND j.source_id=p_id ON CONFLICT DO NOTHING;
 END IF;
END $f$;
REVOKE ALL ON FUNCTION app_private.creative_media_erase_owner(uuid,bytea,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.creative_media_erase_owner(uuid,bytea,text,uuid) TO r72_content_command;
RESET ROLE;SET LOCAL ROLE r72_owner;REVOKE CREATE ON SCHEMA app_private FROM r72_creative_studio_definer;
GRANT CREATE ON SCHEMA app_private TO r72_native_video_definer;
SET LOCAL ROLE r72_native_video_definer;
CREATE FUNCTION app_private.creative_media_retention(p_workspace uuid,p_ack_kind text DEFAULT NULL,p_ack_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE retention_days integer; erasure_rec app.creative_media_erasures;blob uuid;s app.creative_media_source_videos;result jsonb:='[]'::jsonb;
BEGIN
 IF app_private.current_actor_kind() IS DISTINCT FROM 'worker' OR app_private.current_workspace_id() IS DISTINCT FROM p_workspace THEN RAISE EXCEPTION 'Scoped worker required' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('rl72-media-lifecycle:'||p_workspace::text,0));
 SELECT source_output_days INTO retention_days FROM app.creative_media_retention_settings WHERE workspace_id=p_workspace;
 UPDATE app.creative_media_source_videos erased_source SET file_name='Deleted video' WHERE erased_source.workspace_id=p_workspace AND erased_source.file_name<>'Deleted video' AND EXISTS(SELECT 1 FROM app.creative_media_erasures e WHERE e.workspace_id=p_workspace AND e.kind='source' AND e.id=erased_source.id);
 UPDATE app.creative_media_edit_projects p SET plan='{"erased":true}'::jsonb WHERE p.workspace_id=p_workspace AND p.plan<>'{"erased":true}'::jsonb AND EXISTS(SELECT 1 FROM app.creative_media_erasures e WHERE e.workspace_id=p_workspace AND e.kind='source' AND e.id=p.source_id);
 UPDATE app.creative_media_object_uploads u SET metadata='{"erased":true}'::jsonb WHERE u.workspace_id=p_workspace AND u.metadata<>'{"erased":true}'::jsonb AND EXISTS(SELECT 1 FROM app.creative_media_erasures e WHERE e.workspace_id=p_workspace AND e.kind='source' AND e.id=u.id);
 IF p_ack_id IS NOT NULL THEN UPDATE app.creative_media_erasures SET erased_at=clock_timestamp() WHERE workspace_id=p_workspace AND id=p_ack_id AND kind=p_ack_kind;RETURN '[]'::jsonb;END IF;
 INSERT INTO app.creative_media_erasures(workspace_id,id,kind,reason) SELECT p_workspace,id,'source','retention' FROM app.creative_media_source_videos candidate WHERE workspace_id=p_workspace AND retention_days IS NOT NULL AND created_at<clock_timestamp()-make_interval(days=>retention_days) AND NOT EXISTS(SELECT 1 FROM app.creative_media_erasures existing WHERE existing.workspace_id=p_workspace AND existing.kind='source' AND existing.id=candidate.id) ORDER BY created_at LIMIT 3 ON CONFLICT DO NOTHING;
 INSERT INTO app.creative_media_erasures(workspace_id,id,kind,reason) SELECT p_workspace,id,'local_output','retention' FROM app.creative_media_local_render_outputs candidate WHERE workspace_id=p_workspace AND retention_days IS NOT NULL AND created_at<clock_timestamp()-make_interval(days=>retention_days) AND NOT EXISTS(SELECT 1 FROM app.creative_media_erasures existing WHERE existing.workspace_id=p_workspace AND existing.kind='local_output' AND existing.id=candidate.id) ORDER BY created_at LIMIT 3 ON CONFLICT DO NOTHING;
 INSERT INTO app.creative_media_erasures(workspace_id,id,kind,reason) SELECT p_workspace,o.id,'local_output','retention' FROM app.creative_media_local_render_outputs o JOIN app.creative_media_local_render_jobs j ON j.workspace_id=o.workspace_id AND j.id=o.job_id JOIN app.creative_media_erasures e ON e.workspace_id=j.workspace_id AND e.id=j.source_id AND e.kind='source' WHERE o.workspace_id=p_workspace ON CONFLICT DO NOTHING;
 UPDATE app.creative_media_local_render_jobs j SET state='failed',claim_token=coalesce(claim_token,gen_random_uuid()),error_code='source_changed',updated_at=clock_timestamp() WHERE j.workspace_id=p_workspace AND j.state IN('queued','claimed') AND EXISTS(SELECT 1 FROM app.creative_media_erasures e WHERE e.workspace_id=p_workspace AND e.kind='source' AND e.id=j.source_id);
 FOR erasure_rec IN SELECT * FROM app.creative_media_erasures WHERE workspace_id=p_workspace AND erased_at IS NULL ORDER BY created_at LIMIT 10 FOR UPDATE SKIP LOCKED LOOP
 blob:=NULL;
 IF erasure_rec.kind='source' THEN
  SELECT * INTO s FROM app.creative_media_source_videos WHERE workspace_id=p_workspace AND id=erasure_rec.id;blob:=s.blob_id;
  IF s.storage_kind='private_object' THEN
   result:=result||jsonb_build_array(jsonb_build_object('kind',erasure_rec.kind,'id',erasure_rec.id,'object',jsonb_build_object('workspaceId',p_workspace,'sourceId',s.id,'objectKey',s.object_key,'mime',s.mime,'sha256',s.sha256,'byteLength',s.byte_length)));
   CONTINUE;
  END IF;
 ELSIF erasure_rec.kind='local_output' THEN SELECT blob_id INTO blob FROM app.creative_media_local_render_outputs WHERE workspace_id=p_workspace AND id=erasure_rec.id;
 END IF;
 -- Retain only a one-byte erasure marker, not the source/output payload.
 UPDATE app.seo_blog_blobs SET bytes=decode('00','hex'),sha256=public.digest(decode('00','hex'),'sha256') WHERE workspace_id=p_workspace AND id=blob;
 UPDATE app.creative_media_erasures SET erased_at=clock_timestamp() WHERE workspace_id=p_workspace AND id=erasure_rec.id AND kind=erasure_rec.kind;
 END LOOP;RETURN result;
END $f$;
REVOKE ALL ON FUNCTION app_private.creative_media_retention(uuid,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.creative_media_retention(uuid,text,uuid) TO r72_worker;
RESET ROLE;SET LOCAL ROLE r72_owner;REVOKE CREATE ON SCHEMA app_private FROM r72_native_video_definer;
-- Narrow global discovery, only UUIDs; worker still enters each workspace scope.
CREATE FUNCTION app_private.creative_media_worker_workspaces(p_after uuid)
RETURNS TABLE(workspace_id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT x.workspace_id FROM (SELECT workspace_id FROM app.creative_media_source_videos UNION SELECT workspace_id FROM app.creative_media_object_uploads UNION SELECT workspace_id FROM app.creative_media_local_render_jobs) x WHERE p_after IS NULL OR x.workspace_id>p_after ORDER BY x.workspace_id LIMIT 10
$f$;
REVOKE ALL ON FUNCTION app_private.creative_media_worker_workspaces(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.creative_media_worker_workspaces(uuid) TO r72_worker;
-- An owner explicitly opts into expiry, or restores indefinite retention with NULL.
SET LOCAL ROLE r72_owner;
GRANT SELECT,INSERT,UPDATE ON app.creative_media_retention_settings TO r72_creative_studio_definer;
CREATE POLICY media_retention_settings_studio ON app.creative_media_retention_settings FOR ALL TO r72_creative_studio_definer USING(workspace_id=app_private.current_workspace_id()) WITH CHECK(workspace_id=app_private.current_workspace_id());
GRANT CREATE ON SCHEMA app_private TO r72_creative_studio_definer;
SET LOCAL ROLE r72_creative_studio_definer;
CREATE FUNCTION app_private.creative_media_retention_owner(p_workspace uuid,p_session bytea,p_days integer,p_confirm boolean)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 IF app_private.current_actor_kind() IS DISTINCT FROM 'user' OR p_confirm IS DISTINCT FROM true THEN RAISE EXCEPTION 'Explicit owner retention choice required' USING ERRCODE='42501'; END IF;
 PERFORM app_private.seo_media_owner(p_workspace,p_session);
 IF p_days IS NOT NULL AND p_days NOT BETWEEN 1 AND 3650 THEN RAISE EXCEPTION 'Retention must be indefinite or 1 to 3650 days' USING ERRCODE='22023'; END IF;
 INSERT INTO app.creative_media_retention_settings(workspace_id,source_output_days) VALUES(p_workspace,p_days) ON CONFLICT(workspace_id) DO UPDATE SET source_output_days=excluded.source_output_days;
END $f$;
REVOKE ALL ON FUNCTION app_private.creative_media_retention_owner(uuid,bytea,integer,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.creative_media_retention_owner(uuid,bytea,integer,boolean) TO r72_content_command;
RESET ROLE;SET LOCAL ROLE r72_owner;REVOKE CREATE ON SCHEMA app_private FROM r72_creative_studio_definer;
