-- PRIVATE DRAFT: bounded, explicitly scoped technical/offline worker discovery.
-- No paid submit, social schedule, cross-tenant scan or automatic deployment.
SET LOCAL ROLE r72_owner;
GRANT CREATE ON SCHEMA app_private TO r72_media_job_definer;
SET LOCAL ROLE r72_media_job_definer;
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
   WHERE s.workspace_id=p_workspace AND NOT EXISTS(SELECT 1 FROM app.creative_media_erasures e WHERE e.workspace_id=p_workspace AND e.kind='source' AND e.id=s.id) AND NOT EXISTS(SELECT 1 FROM app.creative_media_video_probes p WHERE p.workspace_id=s.workspace_id AND p.source_id=s.id)
  UNION ALL
  SELECT 'render-local'::text,j.id,j.created_at FROM app.creative_media_local_render_jobs j
   WHERE j.workspace_id=p_workspace AND j.state='queued' AND j.retry_at<=clock_timestamp()
  UNION ALL
  SELECT 'probe-output'::text,o.id,o.created_at FROM app.creative_media_video_outputs o
   WHERE o.workspace_id=p_workspace AND o.state='captured_unverified'
    AND NOT EXISTS(SELECT 1 FROM app.creative_media_output_probes p WHERE p.workspace_id=o.workspace_id AND p.output_id=o.id)
 ) work ORDER BY work.created_at,work.kind,work.id LIMIT p_limit;
END $f$;
REVOKE ALL ON FUNCTION app_private.creative_media_work_pending(uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.creative_media_work_pending(uuid,integer) TO r72_worker;
RESET ROLE;SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_media_job_definer;
