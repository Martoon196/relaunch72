-- PRIVATE DRAFT: bounded, explicitly scoped technical/offline worker discovery.
-- No paid submit, social schedule, cross-tenant scan or automatic deployment.
SET LOCAL ROLE r72_owner;
CREATE TABLE app.creative_media_probe_retries(workspace_id uuid NOT NULL,source_id uuid NOT NULL,attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),retry_at timestamptz NOT NULL DEFAULT clock_timestamp(),last_error text,PRIMARY KEY(workspace_id,source_id),FOREIGN KEY(workspace_id,source_id) REFERENCES app.creative_media_source_videos(workspace_id,id));
ALTER TABLE app.creative_media_probe_retries ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.creative_media_probe_retries FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app.creative_media_probe_retries FROM PUBLIC,r72_worker,r72_content_command,r72_web;
CREATE POLICY probe_retries_owner ON app.creative_media_probe_retries FOR ALL TO r72_owner USING(true) WITH CHECK(true);
CREATE POLICY probe_retries_worker ON app.creative_media_probe_retries FOR ALL TO r72_native_video_definer USING(workspace_id=app_private.current_workspace_id()) WITH CHECK(workspace_id=app_private.current_workspace_id());
GRANT SELECT,INSERT,UPDATE ON app.creative_media_probe_retries TO r72_native_video_definer;
INSERT INTO app_private.workspace_table_registry(schema_name,table_name,workspace_column) VALUES('app','creative_media_probe_retries','workspace_id');
GRANT CREATE ON SCHEMA app_private TO r72_native_video_definer;
SET LOCAL ROLE r72_native_video_definer;
CREATE FUNCTION app_private.creative_media_work_pending(p_workspace uuid,p_limit integer)
RETURNS TABLE(kind text,id uuid) LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 IF app_private.current_actor_kind() IS DISTINCT FROM 'worker'
  OR app_private.current_workspace_id() IS DISTINCT FROM p_workspace THEN
  RAISE EXCEPTION 'Scoped worker required' USING ERRCODE='42501'; END IF;
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 10 THEN RAISE EXCEPTION 'Bounded worker limit required' USING ERRCODE='22023'; END IF;
 -- Offline rendering is deterministic and has no paid side effect. Reclaim only
 -- expired leases; reset token fences any late settlement. Three attempts max.
 UPDATE app.creative_media_local_render_jobs SET state='failed',error_code='render_failed',updated_at=clock_timestamp()
 WHERE workspace_id=p_workspace AND state='claimed' AND claim_until<=clock_timestamp() AND attempts>=3;
 UPDATE app.creative_media_local_render_jobs SET state='queued',claim_token=NULL,claim_until=NULL,error_code=NULL,retry_at=clock_timestamp()+interval '1 minute',updated_at=clock_timestamp()
 WHERE workspace_id=p_workspace AND attempts<3 AND ((state='claimed' AND claim_until<=clock_timestamp()) OR (state='failed' AND error_code IN('render_failed','renderer_unavailable') AND updated_at<clock_timestamp()-interval '1 minute'));
 RETURN QUERY SELECT work.kind,work.id FROM (
  SELECT 'probe'::text AS kind,s.id,s.created_at FROM app.creative_media_source_videos s
   WHERE s.workspace_id=p_workspace AND NOT EXISTS(SELECT 1 FROM app.creative_media_probe_retries r WHERE r.workspace_id=s.workspace_id AND r.source_id=s.id AND (r.attempts>=3 OR r.retry_at>clock_timestamp())) AND NOT EXISTS(SELECT 1 FROM app.creative_media_erasures e WHERE e.workspace_id=p_workspace AND e.kind='source' AND e.id=s.id) AND NOT EXISTS(SELECT 1 FROM app.creative_media_video_probes p WHERE p.workspace_id=s.workspace_id AND p.source_id=s.id)
  UNION ALL
  SELECT 'render-local'::text,j.id,j.created_at FROM app.creative_media_local_render_jobs j
   WHERE j.workspace_id=p_workspace AND j.state='queued' AND j.retry_at<=clock_timestamp()
 ) work ORDER BY work.created_at,work.kind,work.id LIMIT p_limit;
END $f$;
REVOKE ALL ON FUNCTION app_private.creative_media_work_pending(uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.creative_media_work_pending(uuid,integer) TO r72_worker;
RESET ROLE;SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_native_video_definer;

SET LOCAL ROLE r72_owner;GRANT CREATE ON SCHEMA app_private TO r72_native_video_definer;SET LOCAL ROLE r72_native_video_definer;
CREATE FUNCTION app_private.creative_media_probe_defer(p_workspace uuid,p_source uuid)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 IF app_private.current_actor_kind() IS DISTINCT FROM 'worker' OR app_private.current_workspace_id() IS DISTINCT FROM p_workspace THEN RAISE EXCEPTION 'Scoped worker required' USING ERRCODE='42501'; END IF;
 INSERT INTO app.creative_media_probe_retries(workspace_id,source_id,attempts,retry_at,last_error) VALUES(p_workspace,p_source,1,clock_timestamp()+interval '1 minute','file_unavailable') ON CONFLICT(workspace_id,source_id) DO UPDATE SET attempts=least(3,creative_media_probe_retries.attempts+1),retry_at=clock_timestamp()+interval '5 minutes',last_error='file_unavailable';
END $f$;
REVOKE ALL ON FUNCTION app_private.creative_media_probe_defer(uuid,uuid) FROM PUBLIC;GRANT EXECUTE ON FUNCTION app_private.creative_media_probe_defer(uuid,uuid) TO r72_worker;
RESET ROLE;SET LOCAL ROLE r72_owner;REVOKE CREATE ON SCHEMA app_private FROM r72_native_video_definer;
