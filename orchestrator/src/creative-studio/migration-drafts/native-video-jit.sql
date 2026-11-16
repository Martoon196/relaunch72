-- PRIVATE DRAFT. Exact local media source adapter; canonical proof schema/window.
SET LOCAL ROLE r72_owner;
GRANT CREATE ON SCHEMA app_private TO r72_media_job_definer;
SET LOCAL ROLE r72_media_job_definer;
CREATE FUNCTION app_private.creative_media_native_version_current(p_workspace uuid,p_version uuid,p_fresh boolean)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE v app.company_content_versions;o app.creative_media_local_render_outputs;r app.creative_media_local_output_reviews;m jsonb;
BEGIN
 IF app_private.current_workspace_id() IS DISTINCT FROM p_workspace THEN RETURN false;END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('rl72-media-lifecycle:'||p_workspace::text,0));
 SELECT * INTO v FROM app.company_content_versions WHERE workspace_id=p_workspace AND id=p_version AND source_system='relaunch72.private-video' AND content_kind='video' AND content_mime_type='video/mp4';
 IF v.id IS NULL THEN RETURN false;END IF;
 m:=v.content_body::jsonb->'video';
 IF NOT pg_input_is_valid(m->>'outputId','uuid') OR NOT pg_input_is_valid(m->>'reviewRevision','integer') THEN RETURN false;END IF;
 SELECT * INTO o FROM app.creative_media_local_render_outputs WHERE workspace_id=p_workspace AND id=(m->>'outputId')::uuid;
 SELECT * INTO r FROM app.creative_media_local_output_reviews WHERE workspace_id=p_workspace AND output_id=o.id ORDER BY revision DESC LIMIT 1;
 IF o.id IS NULL OR r.decision IS DISTINCT FROM 'reviewed_private' OR r.revision IS DISTINCT FROM (m->>'reviewRevision')::integer
 OR o.sha256 IS DISTINCT FROM m->>'sha256' OR o.sha256 IS DISTINCT FROM encode(v.blob_sha256,'hex')
 OR o.source_sha256 IS DISTINCT FROM m->>'sourceSha256' OR o.plan_sha256 IS DISTINCT FROM m->>'planSha256'
 OR v.blob_storage_key IS DISTINCT FROM 'rl72-native-video/'||p_workspace::text||'/'||o.id::text||'/'||o.sha256||'.mp4'
 OR encode(v.brand_sha256,'hex') IS DISTINCT FROM encode(public.digest(to_jsonb(app_private.seo_blog_brand(p_workspace))::text,'sha256'),'hex')
 OR EXISTS(SELECT 1 FROM app.company_content_versions WHERE workspace_id=p_workspace AND content_item_id=v.content_item_id AND version_number>v.version_number)
 OR NOT EXISTS(SELECT 1 FROM app.seo_blog_blobs WHERE workspace_id=p_workspace AND id=o.blob_id AND public.digest(bytes,'sha256')=v.blob_sha256 AND octet_length(bytes)=o.byte_length)
 OR NOT EXISTS(SELECT 1 FROM app.creative_media_local_render_jobs j JOIN app.creative_media_source_videos s ON s.workspace_id=j.workspace_id AND s.id=j.source_id JOIN app.creative_media_video_probes p ON p.workspace_id=s.workspace_id AND p.source_id=s.id AND p.source_sha256=s.sha256
   JOIN app.creative_media_edit_projects e ON e.workspace_id=j.workspace_id AND e.id=j.project_id AND e.revision=j.revision
   WHERE j.workspace_id=p_workspace AND j.id=o.job_id AND j.state='completed' AND j.output_id=o.id AND s.sha256=o.source_sha256 AND e.plan_sha256=o.plan_sha256
    AND e.plan->>'disclosure'~*'(^|[[:space:]])#ad([[:space:]]|$)' AND s.rights IN('owned','licensed') AND (s.rights='owned' OR s.evidence_sha256 IS NOT NULL) AND p.status='verified_technical'
    AND NOT EXISTS(SELECT 1 FROM app.creative_media_erasures gone WHERE gone.workspace_id=p_workspace AND ((gone.kind='source' AND gone.id=s.id) OR (gone.kind='local_output' AND gone.id=o.id))))
 OR NOT EXISTS(SELECT 1 FROM app.company_content_approval_requests q JOIN app.company_content_approval_decisions d ON d.workspace_id=q.workspace_id AND d.approval_request_id=q.id AND d.content_version_id=v.id AND d.content_sha256=v.content_sha256 AND d.decision='approved' WHERE q.workspace_id=p_workspace AND q.content_version_id=v.id AND NOT EXISTS(SELECT 1 FROM app.company_content_approval_requests later WHERE later.workspace_id=p_workspace AND later.content_version_id=v.id AND later.request_number>q.request_number)) THEN RETURN false;END IF;
 IF p_fresh AND NOT EXISTS(SELECT 1 FROM app.company_content_source_attestations WHERE workspace_id=p_workspace AND content_version_id=v.id AND content_sha256=v.content_sha256 AND blob_sha256=v.blob_sha256 AND brand_sha256=v.brand_sha256 AND checked_at<=statement_timestamp() AND expires_at>statement_timestamp()) THEN RETURN false;END IF;
 RETURN true;
EXCEPTION WHEN invalid_text_representation THEN RETURN false;
END $f$;
CREATE FUNCTION app_private.creative_media_native_post_current(p_workspace uuid,p_version uuid,p_fresh boolean)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE v app.company_content_versions;video app.company_content_versions;
BEGIN
 IF app_private.current_workspace_id() IS DISTINCT FROM p_workspace THEN RETURN false;END IF;
 SELECT * INTO v FROM app.company_content_versions WHERE workspace_id=p_workspace AND id=p_version AND source_system='relaunch72.private-video-post' AND content_kind='social_post' AND content_mime_type='text/plain';
 IF v.id IS NULL OR NOT pg_input_is_valid(v.metadata->>'nativeVideoVersionId','uuid') THEN RETURN false;END IF;
 SELECT * INTO video FROM app.company_content_versions WHERE workspace_id=p_workspace AND id=(v.metadata->>'nativeVideoVersionId')::uuid;
 IF video.id IS NULL OR NOT app_private.creative_media_native_version_current(p_workspace,video.id,p_fresh)
 OR v.content_body IS DISTINCT FROM video.content_body::jsonb->>'publicationCopy'
 OR v.metadata->>'network' IS DISTINCT FROM video.content_body::jsonb->>'platform'
 OR v.source_item_id IS DISTINCT FROM video.id::text OR v.source_version IS DISTINCT FROM encode(video.content_sha256,'hex')
 OR v.brand_sha256 IS DISTINCT FROM video.brand_sha256 OR public.digest(v.content_body,'sha256') IS DISTINCT FROM v.content_sha256 OR v.blob_sha256 IS DISTINCT FROM v.content_sha256
 OR EXISTS(SELECT 1 FROM app.company_content_versions WHERE workspace_id=p_workspace AND content_item_id=v.content_item_id AND version_number>v.version_number)
 OR NOT EXISTS(SELECT 1 FROM app.company_content_approval_requests q JOIN app.company_content_approval_decisions d ON d.workspace_id=q.workspace_id AND d.approval_request_id=q.id AND d.content_version_id=v.id AND d.content_sha256=v.content_sha256 AND d.decision='approved' WHERE q.workspace_id=p_workspace AND q.content_version_id=v.id AND NOT EXISTS(SELECT 1 FROM app.company_content_approval_requests later WHERE later.workspace_id=p_workspace AND later.content_version_id=v.id AND later.request_number>q.request_number)) THEN RETURN false;END IF;
 IF p_fresh AND NOT EXISTS(SELECT 1 FROM app.company_content_source_attestations WHERE workspace_id=p_workspace AND content_version_id=v.id AND content_sha256=v.content_sha256 AND blob_sha256=v.blob_sha256 AND brand_sha256=v.brand_sha256 AND checked_at<=statement_timestamp() AND expires_at>statement_timestamp()) THEN RETURN false;END IF;
 RETURN true;
END $f$;
REVOKE ALL ON FUNCTION app_private.creative_media_native_version_current(uuid,uuid,boolean),app_private.creative_media_native_post_current(uuid,uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.creative_media_native_version_current(uuid,uuid,boolean),app_private.creative_media_native_post_current(uuid,uuid,boolean) TO r72_public_social_definer,r72_creative_studio_definer;
RESET ROLE;SET LOCAL ROLE r72_owner;REVOKE CREATE ON SCHEMA app_private FROM r72_media_job_definer;
GRANT CREATE ON SCHEMA app_private TO r72_public_social_definer;
SET LOCAL ROLE r72_public_social_definer;
CREATE FUNCTION app_private.creative_media_attest_due_native(p_workspace uuid)
RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE selected record;media record;proof uuid;catalog bytea;decision_at timestamptz;n integer:=0;
BEGIN
 IF session_user<>'r72_worker' OR current_setting('app.actor_kind',true) IS DISTINCT FROM 'worker' OR current_setting('app.workspace_id',true) IS DISTINCT FROM p_workspace::text OR coalesce(current_setting('app.user_id',true),'')<>'' THEN RAISE EXCEPTION 'Scoped offline attestor required' USING ERRCODE='42501';END IF;
 FOR selected IN SELECT j.id job_id,j.lease_version,j.attempt_count,j.max_attempts,i.*,v.metadata FROM app.public_social_revalidation_jobs j JOIN app.public_social_planning_intents i ON i.workspace_id=j.workspace_id AND i.id=j.intent_id JOIN app.company_content_versions v ON v.workspace_id=i.workspace_id AND v.id=i.content_version_id
 WHERE j.workspace_id=p_workspace AND v.source_system='relaunch72.private-video-post' AND j.state IN('waiting_for_window','retry_wait') AND j.next_attempt_at<=statement_timestamp() ORDER BY j.next_attempt_at,j.id LIMIT 10 FOR UPDATE OF j SKIP LOCKED LOOP
  IF selected.desired_for>statement_timestamp()+interval '10 minutes' THEN CONTINUE;END IF;
  IF selected.desired_for<statement_timestamp()-interval '5 minutes' OR selected.attempt_count>=selected.max_attempts OR NOT app_private.creative_media_native_post_current(p_workspace,selected.content_version_id,false)
  OR (SELECT count(*) FROM app.public_social_planning_intent_media WHERE workspace_id=p_workspace AND intent_id=selected.id)<>1
  OR EXISTS(SELECT 1 FROM app.public_social_planning_intent_targets t WHERE t.workspace_id=p_workspace AND t.intent_id=selected.id AND (EXISTS(SELECT 1 FROM app.public_social_planning_target_cancellations WHERE workspace_id=p_workspace AND intent_id=t.intent_id AND target_id=t.target_id) OR EXISTS(SELECT 1 FROM app.public_social_planning_target_supersessions WHERE workspace_id=p_workspace AND predecessor_intent_id=t.intent_id AND predecessor_target_id=t.target_id))) THEN
   UPDATE app.public_social_revalidation_jobs SET state='cancelled',last_error_code='native.source_changed',completed_at=statement_timestamp(),updated_at=statement_timestamp(),row_version=row_version+1 WHERE workspace_id=p_workspace AND id=selected.job_id;CONTINUE;END IF;
  SELECT m.*,d.decided_at INTO media FROM app.public_social_planning_intent_media m JOIN app.company_content_approval_decisions d ON d.workspace_id=m.workspace_id AND d.id=m.approval_decision_id AND d.decision='approved' WHERE m.workspace_id=p_workspace AND m.intent_id=selected.id AND m.content_version_id=(selected.metadata->>'nativeVideoVersionId')::uuid;
  IF media.content_version_id IS NULL THEN RAISE EXCEPTION 'Exact video planning tuple required' USING ERRCODE='55000';END IF;
  proof:=gen_random_uuid();catalog:=public.digest(concat_ws('|','rl72.native-video-jit/v1',p_workspace,selected.id,encode(selected.content_sha256,'hex'),media.content_version_id,encode(media.blob_sha256,'hex'),statement_timestamp()),'sha256');
  SELECT decided_at INTO decision_at FROM app.company_content_approval_decisions WHERE workspace_id=p_workspace AND id=selected.approval_decision_id;
  INSERT INTO app.public_social_revalidation_proofs(id,workspace_id,job_id,intent_id,intent_sha256,content_item_id,content_version_id,content_sha256,blob_sha256,brand_sha256,evidence_type,source_resource_version_id,source_approval_id,source_approved_at,source_catalog_sha256,checked_at,expires_at,worker_id,lease_version)
   VALUES(proof,p_workspace,selected.job_id,selected.id,selected.intent_sha256,selected.content_item_id,selected.content_version_id,selected.content_sha256,selected.blob_sha256,selected.brand_sha256,'legacy',selected.content_version_id,selected.approval_decision_id,decision_at,catalog,statement_timestamp(),statement_timestamp()+interval '15 minutes','8b0203f1-7680-423e-b0ed-d1665477b8f2',selected.lease_version+1);
  INSERT INTO app.public_social_revalidation_proof_media(workspace_id,proof_id,intent_id,ordinal,content_item_id,content_version_id,content_sha256,blob_sha256,brand_sha256,source_resource_version_id,source_approval_id,source_approved_at,source_catalog_sha256,checked_at,expires_at)
   VALUES(p_workspace,proof,selected.id,media.ordinal,media.content_item_id,media.content_version_id,media.content_sha256,media.blob_sha256,media.brand_sha256,media.content_version_id,media.approval_decision_id,media.decided_at,catalog,statement_timestamp(),statement_timestamp()+interval '15 minutes');
  UPDATE app.public_social_revalidation_jobs SET state='verified',current_proof_id=proof,lease_version=lease_version+1,attempt_count=attempt_count+1,last_error_code=NULL,updated_at=statement_timestamp(),row_version=row_version+1 WHERE workspace_id=p_workspace AND id=selected.job_id;n:=n+1;
 END LOOP;RETURN n;
END $f$;
REVOKE ALL ON FUNCTION app_private.creative_media_attest_due_native(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.creative_media_attest_due_native(uuid) TO r72_worker;
RESET ROLE;SET LOCAL ROLE r72_owner;REVOKE CREATE ON SCHEMA app_private FROM r72_public_social_definer;
SET LOCAL ROLE r72_owner;
GRANT INSERT ON app.company_content_source_attestations TO r72_creative_studio_definer;
CREATE POLICY native_video_owner_refresh ON app.company_content_source_attestations FOR INSERT TO r72_creative_studio_definer WITH CHECK(workspace_id=app_private.current_workspace_id());
GRANT CREATE ON SCHEMA app_private TO r72_creative_studio_definer;
SET LOCAL ROLE r72_creative_studio_definer;
CREATE FUNCTION app_private.creative_media_refresh_native_planning(p_workspace uuid,p_session bytea,p_post uuid)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid;v app.company_content_versions;video uuid;
BEGIN
 IF app_private.current_actor_kind() IS DISTINCT FROM 'user' THEN RAISE EXCEPTION 'Owner required' USING ERRCODE='42501';END IF;
 actor:=app_private.seo_media_owner(p_workspace,p_session);
 IF NOT app_private.creative_media_native_post_current(p_workspace,p_post,false) THEN RAISE EXCEPTION 'Current canonical approved native post and media required' USING ERRCODE='55000';END IF;
 SELECT (metadata->>'nativeVideoVersionId')::uuid INTO video FROM app.company_content_versions WHERE workspace_id=p_workspace AND id=p_post;
 FOR v IN SELECT * FROM app.company_content_versions WHERE workspace_id=p_workspace AND id IN(p_post,video) LOOP
 INSERT INTO app.company_content_source_attestations(id,workspace_id,content_item_id,content_version_id,source_system,source_item_id,source_version,content_sha256,blob_sha256,brand_sha256,source_catalog_sha256,checked_at,expires_at,attested_by_user_id,attested_request_id)
 VALUES(gen_random_uuid(),p_workspace,v.content_item_id,v.id,v.source_system,v.source_item_id,v.source_version,v.content_sha256,v.blob_sha256,v.brand_sha256,public.digest(concat_ws('|','rl72.native-planning/v1',v.id,encode(v.blob_sha256,'hex'),statement_timestamp()),'sha256'),statement_timestamp(),statement_timestamp()+interval '15 minutes',actor,current_setting('app.request_id'));
 END LOOP;
END $f$;
REVOKE ALL ON FUNCTION app_private.creative_media_refresh_native_planning(uuid,bytea,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.creative_media_refresh_native_planning(uuid,bytea,uuid) TO r72_content_adapter;
RESET ROLE;SET LOCAL ROLE r72_owner;REVOKE CREATE ON SCHEMA app_private FROM r72_creative_studio_definer;
GRANT CREATE ON SCHEMA app_private TO r72_public_social_definer;
SET LOCAL ROLE r72_public_social_definer;
CREATE FUNCTION app_private.creative_media_native_plan_ticket(p_workspace uuid,p_intent uuid)
RETURNS TABLE(content_item_id uuid,content_version_id uuid,approval_request_id uuid,approval_decision_id uuid,source_attestation_id uuid,target_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 PERFORM app_private.assert_public_social_manager(p_workspace);
 RETURN QUERY SELECT i.content_item_id,i.content_version_id,i.approval_request_id,i.approval_decision_id,i.planning_source_attestation_id,t.target_id FROM app.public_social_planning_intents i JOIN app.company_content_versions v ON v.workspace_id=i.workspace_id AND v.id=i.content_version_id JOIN app.public_social_planning_intent_targets t ON t.workspace_id=i.workspace_id AND t.intent_id=i.id WHERE i.workspace_id=p_workspace AND i.id=p_intent AND v.source_system='relaunch72.private-video-post';
END $f$;
REVOKE ALL ON FUNCTION app_private.creative_media_native_plan_ticket(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.creative_media_native_plan_ticket(uuid,uuid) TO r72_public_social_command;
RESET ROLE;SET LOCAL ROLE r72_owner;REVOKE CREATE ON SCHEMA app_private FROM r72_public_social_definer;
