-- PRIVATE DRAFT: explicit owner release of exact canonical video media to an
-- existing canonical Zernio job. No new scheduler or posting transport.
SET LOCAL ROLE r72_owner;
CREATE TABLE app.creative_media_video_releases (
 workspace_id uuid NOT NULL,job_id uuid NOT NULL,content_version_id uuid NOT NULL,output_id uuid NOT NULL,
 output_sha256 text NOT NULL,review_revision integer NOT NULL,command_id uuid NOT NULL,created_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,job_id,content_version_id),UNIQUE(workspace_id,command_id),
 FOREIGN KEY(workspace_id,job_id) REFERENCES app.property_predator_owned_social_jobs(workspace_id,id),
 FOREIGN KEY(workspace_id,content_version_id) REFERENCES app.company_content_versions(workspace_id,id),
 FOREIGN KEY(workspace_id,output_id,review_revision) REFERENCES app.creative_media_local_output_reviews(workspace_id,output_id,revision)
);
CREATE TABLE app.creative_media_video_release_withdrawals (
 workspace_id uuid NOT NULL,job_id uuid NOT NULL,content_version_id uuid NOT NULL,command_id uuid NOT NULL,created_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(workspace_id,job_id,content_version_id),UNIQUE(workspace_id,command_id),
 FOREIGN KEY(workspace_id,job_id) REFERENCES app.property_predator_owned_social_jobs(workspace_id,id),
 FOREIGN KEY(workspace_id,content_version_id) REFERENCES app.company_content_versions(workspace_id,id)
);
DO $t$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['creative_media_video_releases','creative_media_video_release_withdrawals'] LOOP
  EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON app.%I FROM PUBLIC,r72_web,r72_worker,r72_content_command,r72_owned_social_worker_command',t);
  EXECUTE format('CREATE POLICY %I ON app.%I FOR ALL TO r72_owner USING(true) WITH CHECK(true)',t||'_owner',t);
  EXECUTE format('CREATE POLICY %I ON app.%I FOR ALL TO r72_creative_studio_definer USING(workspace_id=app_private.current_workspace_id()) WITH CHECK(workspace_id=app_private.current_workspace_id())',t||'_studio',t);
  EXECUTE format('CREATE POLICY %I ON app.%I FOR SELECT TO r72_media_job_definer USING(workspace_id=app_private.current_workspace_id())',t||'_worker',t);
  EXECUTE format('GRANT SELECT,INSERT ON app.%I TO r72_creative_studio_definer',t);EXECUTE format('GRANT SELECT ON app.%I TO r72_media_job_definer',t);
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON app.%I FOR EACH ROW EXECUTE FUNCTION app_private.seo_blog_append_only()',t||'_immutable',t);
  INSERT INTO app_private.workspace_table_registry(schema_name,table_name,workspace_column) VALUES('app',t,'workspace_id');
 END LOOP;
 FOREACH t IN ARRAY ARRAY['company_content_versions','company_content_source_attestations','company_content_approval_requests','company_content_approval_decisions','property_predator_owned_social_jobs','property_predator_owned_social_job_media','creative_media_local_output_reviews'] LOOP
  EXECUTE format('CREATE POLICY %I ON app.%I FOR SELECT TO r72_media_job_definer,r72_creative_studio_definer USING(workspace_id=app_private.current_workspace_id())',t||'_native_video_read',t);
  EXECUTE format('GRANT SELECT ON app.%I TO r72_media_job_definer,r72_creative_studio_definer',t);
 END LOOP;
END $t$;
GRANT EXECUTE ON FUNCTION app_private.seo_blog_brand(uuid) TO r72_media_job_definer;
GRANT CREATE ON SCHEMA app_private TO r72_media_job_definer;
SET LOCAL ROLE r72_media_job_definer;
CREATE FUNCTION app_private.creative_media_video_ready(p_workspace uuid,p_job uuid,p_version uuid,p_require_release boolean)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE v app.company_content_versions; o app.creative_media_local_render_outputs;r app.creative_media_local_output_reviews; manifest jsonb; grant_rec app.creative_media_video_releases;job_copy text;
BEGIN
 IF app_private.current_workspace_id() IS DISTINCT FROM p_workspace THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('rl72-media-lifecycle:'||p_workspace::text,0));
 SELECT version.* INTO v FROM app.company_content_versions version JOIN app.property_predator_owned_social_job_media media
  ON media.workspace_id=version.workspace_id AND media.content_version_id=version.id AND media.content_sha256=version.content_sha256 AND media.blob_sha256=version.blob_sha256
  JOIN app.property_predator_owned_social_jobs job ON job.workspace_id=media.workspace_id AND job.id=media.job_id
  WHERE job.workspace_id=p_workspace AND job.id=p_job AND version.id=p_version AND job.provider_id='zernio'
   AND job.network IN('instagram','linkedin') AND job.state IN('queued','leased','calling')
   AND version.source_system='relaunch72.private-video' AND version.content_kind='video' AND version.content_mime_type='video/mp4';
 IF v.id IS NULL THEN RETURN false; END IF;
 manifest:=v.content_body::jsonb->'video';
 SELECT text_body INTO job_copy FROM app.property_predator_owned_social_jobs WHERE workspace_id=p_workspace AND id=p_job;
 IF job_copy IS DISTINCT FROM (v.content_body::jsonb->>'publicationCopy') THEN RETURN false; END IF;
 IF coalesce(manifest->>'outputId','')!~'^[a-f0-9-]{36}$' THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('rl72-local-output-review:'||p_workspace::text||':'||(manifest->>'outputId'),0));
 SELECT * INTO o FROM app.creative_media_local_render_outputs WHERE workspace_id=p_workspace AND id=(manifest->>'outputId')::uuid;
 SELECT * INTO r FROM app.creative_media_local_output_reviews WHERE workspace_id=p_workspace AND output_id=o.id ORDER BY revision DESC LIMIT 1;
 IF EXISTS(SELECT 1 FROM app.creative_media_erasures e WHERE e.workspace_id=p_workspace AND ((e.kind='local_output' AND e.id=o.id) OR (e.kind='source' AND e.id=(SELECT source_id FROM app.creative_media_local_render_jobs WHERE workspace_id=p_workspace AND id=o.job_id)))) OR o.id IS NULL OR r.decision IS DISTINCT FROM 'reviewed_private' OR r.revision IS DISTINCT FROM (manifest->>'reviewRevision')::integer
  OR o.sha256 IS DISTINCT FROM manifest->>'sha256' OR o.sha256 IS DISTINCT FROM encode(v.blob_sha256,'hex')
  OR o.source_sha256 IS DISTINCT FROM manifest->>'sourceSha256' OR o.plan_sha256 IS DISTINCT FROM manifest->>'planSha256'
  OR v.blob_storage_key IS DISTINCT FROM 'rl72-native-video/'||p_workspace::text||'/'||o.id::text||'/'||o.sha256||'.mp4'
  OR encode(v.brand_sha256,'hex') IS DISTINCT FROM encode(public.digest(to_jsonb(app_private.seo_blog_brand(p_workspace))::text,'sha256'),'hex')
  OR EXISTS(SELECT 1 FROM app.company_content_versions newer WHERE workspace_id=p_workspace AND content_item_id=v.content_item_id AND version_number>v.version_number)
  OR NOT EXISTS(SELECT 1 FROM app.company_content_source_attestations a WHERE a.workspace_id=p_workspace AND a.content_version_id=v.id AND a.content_sha256=v.content_sha256 AND a.blob_sha256=v.blob_sha256 AND a.brand_sha256=v.brand_sha256 AND a.checked_at<=clock_timestamp() AND a.expires_at>clock_timestamp())
  OR NOT EXISTS(SELECT 1 FROM app.property_predator_owned_social_job_media m JOIN app.company_content_approval_decisions d ON d.workspace_id=m.workspace_id AND d.id=m.approval_decision_id AND d.approval_request_id=m.approval_request_id AND d.content_version_id=v.id AND d.content_sha256=v.content_sha256 AND d.decision='approved'
    JOIN app.company_content_approval_requests req ON req.workspace_id=d.workspace_id AND req.id=d.approval_request_id
    WHERE m.workspace_id=p_workspace AND m.job_id=p_job AND m.content_version_id=v.id
     AND req.request_number=(SELECT max(request_number) FROM app.company_content_approval_requests WHERE workspace_id=p_workspace AND content_version_id=v.id)) THEN RETURN false; END IF;
 -- Canonical queue approval is the only publication approval. This adapter
 -- adds exact-byte readiness and an owner takedown, never a second authorize UI.
 IF EXISTS(SELECT 1 FROM app.creative_media_video_release_withdrawals WHERE workspace_id=p_workspace AND job_id=p_job AND content_version_id=v.id) THEN RETURN false; END IF;
 RETURN true;
END $f$;
CREATE FUNCTION app_private.creative_media_video_release_bytes(p_workspace uuid,p_job uuid,p_version uuid)
RETURNS TABLE(sha256 text,raw_bytes bytea) LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 IF app_private.current_actor_kind() IS DISTINCT FROM 'worker' OR NOT app_private.creative_media_video_ready(p_workspace,p_job,p_version,true)
  OR NOT EXISTS(SELECT 1 FROM app.property_predator_owned_social_jobs WHERE workspace_id=p_workspace AND id=p_job AND state IN('leased','calling') AND lease_expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'Current exact video release and worker lease required' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT o.sha256,b.bytes FROM app.creative_media_video_releases g JOIN app.creative_media_local_render_outputs o ON o.workspace_id=g.workspace_id AND o.id=g.output_id
  JOIN app.seo_blog_blobs b ON b.workspace_id=o.workspace_id AND b.id=o.blob_id
  WHERE g.workspace_id=p_workspace AND g.job_id=p_job AND g.content_version_id=p_version AND o.sha256=encode(public.digest(b.bytes,'sha256'),'hex') AND o.byte_length=octet_length(b.bytes);
END $f$;
CREATE FUNCTION app_private.creative_media_video_call_guard() RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE media record;
BEGIN
 IF NEW.state='calling' AND OLD.state IS DISTINCT FROM 'calling' THEN
  FOR media IN SELECT v.id FROM app.property_predator_owned_social_job_media m JOIN app.company_content_versions v ON v.workspace_id=m.workspace_id AND v.id=m.content_version_id WHERE m.workspace_id=NEW.workspace_id AND m.job_id=NEW.id AND v.source_system='relaunch72.private-video' LOOP
   IF NOT app_private.creative_media_video_ready(NEW.workspace_id,NEW.id,media.id,true) THEN RAISE EXCEPTION 'Native video release withdrawn or stale' USING ERRCODE='55000'; END IF;
  END LOOP;
 END IF;RETURN NEW;
END $f$;
REVOKE ALL ON FUNCTION app_private.creative_media_video_ready(uuid,uuid,uuid,boolean),app_private.creative_media_video_release_bytes(uuid,uuid,uuid),app_private.creative_media_video_call_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.creative_media_video_ready(uuid,uuid,uuid,boolean) TO r72_creative_studio_definer;
GRANT EXECUTE ON FUNCTION app_private.creative_media_video_release_bytes(uuid,uuid,uuid) TO r72_owned_social_worker_command;
RESET ROLE;SET LOCAL ROLE r72_owner;
CREATE TRIGGER creative_media_native_video_call_guard BEFORE UPDATE ON app.property_predator_owned_social_jobs FOR EACH ROW EXECUTE FUNCTION app_private.creative_media_video_call_guard();
REVOKE CREATE ON SCHEMA app_private FROM r72_media_job_definer;
GRANT CREATE ON SCHEMA app_private TO r72_creative_studio_definer;
SET LOCAL ROLE r72_creative_studio_definer;
CREATE FUNCTION app_private.creative_media_video_release_owner(p_workspace uuid,p_session bytea,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid;j uuid;v uuid;cmd uuid;manifest jsonb;previous app.creative_media_video_releases;
BEGIN
 IF p_session IS NULL OR app_private.current_actor_kind() IS DISTINCT FROM 'user' THEN RAISE EXCEPTION 'Owner session required' USING ERRCODE='42501'; END IF;
 actor:=app_private.seo_media_owner(p_workspace,p_session);
 PERFORM pg_advisory_xact_lock(hashtextextended('rl72-media-lifecycle:'||p_workspace::text,0));

 IF p_input IS NULL OR jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR octet_length(p_input::text)>1200 OR p_input->>'consent' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'Exact public distribution consent required' USING ERRCODE='22023'; END IF;
 j:=(p_input->>'jobId')::uuid;v:=(p_input->>'contentVersionId')::uuid;cmd:=(p_input->>'commandId')::uuid;
 IF j IS NULL OR v IS NULL OR cmd IS NULL OR coalesce(p_input->>'action','') NOT IN('withdraw') THEN RAISE EXCEPTION 'Exact release IDs required' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('media-public-release:'||p_workspace::text||':'||j::text,0));
 IF p_input->>'action'='withdraw' THEN
  INSERT INTO app.creative_media_video_release_withdrawals(workspace_id,job_id,content_version_id,command_id,created_by) VALUES(p_workspace,j,v,cmd,actor) ON CONFLICT (workspace_id,job_id,content_version_id) DO NOTHING;
  RETURN jsonb_build_object('state','withdrawn'); END IF;
 RAISE EXCEPTION 'Use the canonical approval queue; no second video authorization' USING ERRCODE='22023';
END $f$;
REVOKE ALL ON FUNCTION app_private.creative_media_video_release_owner(uuid,bytea,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.creative_media_video_release_owner(uuid,bytea,jsonb) TO r72_content_command;
RESET ROLE;SET LOCAL ROLE r72_owner;REVOKE CREATE ON SCHEMA app_private FROM r72_creative_studio_definer;
GRANT CREATE ON SCHEMA app_private TO r72_media_job_definer;
SET LOCAL ROLE r72_media_job_definer;
CREATE FUNCTION app_private.creative_media_video_release_by_key(p_workspace uuid,p_job uuid,p_key text,p_sha text)
RETURNS TABLE(sha256 text,raw_bytes bytea) LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE version_id uuid;
BEGIN
 IF app_private.current_actor_kind() IS DISTINCT FROM 'worker' OR app_private.current_workspace_id() IS DISTINCT FROM p_workspace THEN RAISE EXCEPTION 'Scoped social worker required' USING ERRCODE='42501'; END IF;
 SELECT m.content_version_id INTO version_id FROM app.property_predator_owned_social_job_media m JOIN app.company_content_versions v ON v.workspace_id=m.workspace_id AND v.id=m.content_version_id
 WHERE m.workspace_id=p_workspace AND m.job_id=p_job AND m.blob_storage_key=p_key AND encode(m.blob_sha256,'hex')=p_sha AND m.content_mime_type='video/mp4' AND v.source_system='relaunch72.private-video';
 IF version_id IS NULL THEN RAISE EXCEPTION 'Exact native video is not attached to this job' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT * FROM app_private.creative_media_video_release_bytes(p_workspace,p_job,version_id);
END $f$;
REVOKE ALL ON FUNCTION app_private.creative_media_video_release_by_key(uuid,uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.creative_media_video_release_by_key(uuid,uuid,text,text) TO r72_owned_social_worker_command;
RESET ROLE;SET LOCAL ROLE r72_owner;REVOKE CREATE ON SCHEMA app_private FROM r72_media_job_definer;
