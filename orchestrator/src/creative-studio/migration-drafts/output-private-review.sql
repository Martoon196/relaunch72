-- PRIVATE DRAFT ONLY — Claude allocates migration numbers and reviews for production.
-- Only an isolated disposable PG test applies this file after the existing media drafts.
-- Two independent checks: trusted technical probe and genuine-owner exact-output
-- review. Neither authorises publishing, campaign scheduling or provider spending.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
SET LOCAL ROLE r72_owner;

CREATE TABLE app.creative_media_output_probes (
 workspace_id uuid NOT NULL, output_id uuid NOT NULL,
 output_sha256 text NOT NULL CHECK(output_sha256~'^[a-f0-9]{64}$'),
 status text NOT NULL CHECK(status IN('verified_technical','rejected')),
 duration_ms bigint CHECK(duration_ms IS NULL OR duration_ms BETWEEN 1000 AND 36000000),
 width integer CHECK(width IS NULL OR width BETWEEN 16 AND 7680),
 height integer CHECK(height IS NULL OR height BETWEEN 16 AND 4320),
 frame_rate numeric(8,3) CHECK(frame_rate IS NULL OR frame_rate BETWEEN 1 AND 240),
 video_codec text CHECK(video_codec IS NULL OR video_codec IN('h264','hevc','vp8','vp9','av1')),
 audio_present boolean,
 rejection_code text CHECK(rejection_code IS NULL OR rejection_code IN('unsupported','malformed','tool_unavailable','probe_failed')),
 checker_version text NOT NULL CHECK(length(checker_version) BETWEEN 3 AND 80),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,output_id),
 FOREIGN KEY(workspace_id,output_id) REFERENCES app.creative_media_video_outputs(workspace_id,id),
 CHECK((status='verified_technical' AND duration_ms IS NOT NULL AND width IS NOT NULL
    AND height IS NOT NULL AND frame_rate IS NOT NULL AND video_codec IS NOT NULL
    AND audio_present IS NOT NULL AND rejection_code IS NULL)
   OR (status='rejected' AND rejection_code IS NOT NULL
    AND duration_ms IS NULL AND width IS NULL AND height IS NULL AND frame_rate IS NULL
    AND video_codec IS NULL AND audio_present IS NULL))
);

CREATE TABLE app.creative_media_output_reviews (
 workspace_id uuid NOT NULL, output_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision BETWEEN 1 AND 100),
 output_sha256 text NOT NULL CHECK(output_sha256~'^[a-f0-9]{64}$'),
 decision text NOT NULL CHECK(decision IN('reviewed_private','rejected_private','withdrawn_private')),
 rights_confirmed boolean NOT NULL DEFAULT false,
 claims_confirmed boolean NOT NULL DEFAULT false,
 disclosure_confirmed boolean NOT NULL DEFAULT false,
 reviewed_by uuid NOT NULL REFERENCES app.users(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,output_id,revision),
 FOREIGN KEY(workspace_id,output_id) REFERENCES app.creative_media_video_outputs(workspace_id,id),
 CHECK(decision<>'reviewed_private' OR (rights_confirmed AND claims_confirmed AND disclosure_confirmed))
);
CREATE TABLE app.creative_media_output_review_commands (
 workspace_id uuid NOT NULL, command_id uuid NOT NULL,
 output_id uuid NOT NULL, revision integer NOT NULL,
 input_sha256 text NOT NULL CHECK(input_sha256~'^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,command_id),
 FOREIGN KEY(workspace_id,output_id,revision)
   REFERENCES app.creative_media_output_reviews(workspace_id,output_id,revision)
);
DO $tables$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['creative_media_output_probes','creative_media_output_reviews','creative_media_output_review_commands'] LOOP
  EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON app.%I FROM PUBLIC,r72_content_command,r72_worker,r72_web',t);
  EXECUTE format('CREATE POLICY %I ON app.%I FOR ALL TO r72_owner USING(true) WITH CHECK(true)',t||'_owner',t);
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON app.%I FOR EACH ROW EXECUTE FUNCTION app_private.seo_blog_append_only()',t||'_immutable',t);
  INSERT INTO app_private.workspace_table_registry(schema_name,table_name,workspace_column)
    VALUES('app',t,'workspace_id');
 END LOOP;
END $tables$;
CREATE POLICY creative_media_output_probes_worker ON app.creative_media_output_probes
 FOR ALL TO r72_media_job_definer
 USING(workspace_id=app_private.current_workspace_id())
 WITH CHECK(workspace_id=app_private.current_workspace_id());
CREATE POLICY creative_media_output_probes_studio ON app.creative_media_output_probes
 FOR SELECT TO r72_creative_studio_definer
 USING(workspace_id=app_private.current_workspace_id());
GRANT SELECT,INSERT ON app.creative_media_output_probes TO r72_media_job_definer;
GRANT SELECT ON app.creative_media_output_probes TO r72_creative_studio_definer;
DO $reviews$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['creative_media_output_reviews','creative_media_output_review_commands'] LOOP
  EXECUTE format('CREATE POLICY %I ON app.%I FOR ALL TO r72_creative_studio_definer USING(workspace_id=app_private.current_workspace_id()) WITH CHECK(workspace_id=app_private.current_workspace_id())',t||'_studio',t);
  EXECUTE format('GRANT SELECT,INSERT ON app.%I TO r72_creative_studio_definer',t);
 END LOOP;
END $reviews$;
GRANT SELECT ON app.creative_media_video_outputs,app.seo_blog_blobs TO r72_media_job_definer,r72_creative_studio_definer;
GRANT CREATE ON SCHEMA app_private TO r72_media_job_definer;
SET LOCAL ROLE r72_media_job_definer;
CREATE FUNCTION app_private.creative_media_output_probe_bytes(p_workspace uuid,p_output uuid)
 RETURNS TABLE(output_sha256 text,raw_bytes bytea)
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 IF app_private.current_actor_kind()<>'worker'
    OR app_private.current_workspace_id() IS DISTINCT FROM p_workspace THEN
  RAISE EXCEPTION 'Scoped media worker required' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT o.sha256,b.bytes FROM app.creative_media_video_outputs o
  JOIN app.seo_blog_blobs b ON b.workspace_id=o.workspace_id AND b.id=o.blob_id
  WHERE o.workspace_id=p_workspace AND o.id=p_output AND o.state='captured_unverified'
    AND o.sha256=encode(b.sha256,'hex')
    AND o.sha256=encode(public.digest(b.bytes,'sha256'),'hex')
    AND o.byte_length=octet_length(b.bytes)
    AND NOT EXISTS (SELECT 1 FROM app.creative_media_output_probes p
      WHERE p.workspace_id=p_workspace AND p.output_id=p_output);
END $f$;
CREATE FUNCTION app_private.creative_media_output_probe_save(
 p_workspace uuid,p_output uuid,p_sha text,p_check jsonb
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE o app.creative_media_video_outputs; existing app.creative_media_output_probes;
 status text; code text; d bigint; w integer; h integer; fps numeric; codec text; audio boolean; checker text;
BEGIN
 IF app_private.current_actor_kind()<>'worker'
    OR app_private.current_workspace_id() IS DISTINCT FROM p_workspace THEN
  RAISE EXCEPTION 'Scoped media worker required' USING ERRCODE='42501'; END IF;
 IF p_check IS NULL OR jsonb_typeof(p_check)<>'object'
    OR octet_length(p_check::text)>1500 THEN
  RAISE EXCEPTION 'Invalid probe receipt' USING ERRCODE='22023'; END IF;
 status:=p_check->>'status';code:=p_check->>'rejectionCode';checker:=p_check->>'checkerVersion';
 IF checker IS NULL OR length(checker) NOT BETWEEN 3 AND 80 OR checker!~'^[a-zA-Z0-9_.-]+$'
 THEN RAISE EXCEPTION 'Trusted probe version required' USING ERRCODE='22023'; END IF;
 IF status='verified_technical' THEN
  IF coalesce(p_check->>'durationMs','')!~'^[0-9]{4,8}$'
    OR coalesce(p_check->>'width','')!~'^[0-9]{2,4}$'
    OR coalesce(p_check->>'height','')!~'^[0-9]{2,4}$'
    OR coalesce(p_check->>'frameRate','')!~'^[0-9]+(\.[0-9]{1,3})?$'
    OR p_check->>'videoCodec' NOT IN('h264','hevc','vp8','vp9','av1')
    OR jsonb_typeof(p_check->'audioPresent')<>'boolean'
    OR code IS NOT NULL THEN
   RAISE EXCEPTION 'Complete trusted technical metadata required' USING ERRCODE='22023'; END IF;
  d:=(p_check->>'durationMs')::bigint;w:=(p_check->>'width')::integer;
  h:=(p_check->>'height')::integer;fps:=(p_check->>'frameRate')::numeric;
  codec:=p_check->>'videoCodec';audio:=(p_check->>'audioPresent')::boolean;
 ELSIF status='rejected' THEN
  IF code NOT IN('unsupported','malformed','tool_unavailable','probe_failed')
    OR (p_check ?| ARRAY['durationMs','width','height','frameRate','videoCodec','audioPresent']) THEN
   RAISE EXCEPTION 'Unknown or ambiguous rejection' USING ERRCODE='22023'; END IF;
 ELSE RAISE EXCEPTION 'Unsupported technical probe status' USING ERRCODE='22023'; END IF;
 SELECT * INTO o FROM app.creative_media_video_outputs
  WHERE workspace_id=p_workspace AND id=p_output;
 IF o.id IS NULL OR o.state<>'captured_unverified' OR o.sha256 IS DISTINCT FROM p_sha THEN
  RAISE EXCEPTION 'Exact private output not found' USING ERRCODE='42501'; END IF;
 INSERT INTO app.creative_media_output_probes(workspace_id,output_id,output_sha256,status,
   duration_ms,width,height,frame_rate,video_codec,audio_present,rejection_code,checker_version)
 VALUES(p_workspace,p_output,p_sha,status,d,w,h,fps,codec,audio,code,checker)
 ON CONFLICT DO NOTHING RETURNING * INTO existing;
 IF existing.output_id IS NULL THEN
  SELECT * INTO existing FROM app.creative_media_output_probes
   WHERE workspace_id=p_workspace AND output_id=p_output;
  IF existing.output_sha256 IS DISTINCT FROM p_sha OR existing.status IS DISTINCT FROM status
    OR existing.duration_ms IS DISTINCT FROM d OR existing.width IS DISTINCT FROM w
    OR existing.height IS DISTINCT FROM h OR existing.frame_rate IS DISTINCT FROM fps
    OR existing.video_codec IS DISTINCT FROM codec OR existing.audio_present IS DISTINCT FROM audio
    OR existing.rejection_code IS DISTINCT FROM code OR existing.checker_version IS DISTINCT FROM checker THEN
   RAISE EXCEPTION 'Probe replay changed content' USING ERRCODE='40001'; END IF;
  RETURN jsonb_build_object('replayed',true,'status',existing.status);
 END IF;
 RETURN jsonb_build_object('replayed',false,'status',existing.status);
END $f$;
REVOKE ALL ON FUNCTION app_private.creative_media_output_probe_bytes(uuid,uuid),
 app_private.creative_media_output_probe_save(uuid,uuid,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.creative_media_output_probe_bytes(uuid,uuid),
 app_private.creative_media_output_probe_save(uuid,uuid,text,jsonb) TO r72_worker;
RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_media_job_definer;
GRANT CREATE ON SCHEMA app_private TO r72_creative_studio_definer;
SET LOCAL ROLE r72_creative_studio_definer;
CREATE FUNCTION app_private.creative_media_output_review(
 p_workspace uuid,p_session bytea,p_action text,p_input jsonb
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; target app.creative_media_video_outputs;
 previous app.creative_media_output_reviews; command app.creative_media_output_review_commands;
 current_rev integer; next_rev integer; output_uuid uuid; cmd uuid; status text; approved boolean;
 input_hash text;
BEGIN
 IF p_session IS NULL OR app_private.current_actor_kind()<>'user' THEN
   RAISE EXCEPTION 'Active owner session required' USING ERRCODE='42501'; END IF;
 actor:=app_private.seo_media_owner(p_workspace,p_session);
 IF p_action='list' THEN
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object(
    'outputId',r.output_id,'revision',r.revision,'sha256',r.output_sha256,
    'decision',r.decision,'createdAt',r.created_at,
    'reviewedBy',r.reviewed_by,'technicalStatus',coalesce(probe.status,'awaiting_probe'))
    ORDER BY r.created_at DESC)
    FROM (SELECT DISTINCT ON(output_id) * FROM app.creative_media_output_reviews
      WHERE workspace_id=p_workspace ORDER BY output_id,revision DESC) r
    LEFT JOIN app.creative_media_output_probes probe
      ON probe.workspace_id=r.workspace_id AND probe.output_id=r.output_id),'[]'::jsonb);
 END IF;
 IF p_action<>'review' OR p_input IS NULL OR jsonb_typeof(p_input)<>'object'
   OR octet_length(p_input::text)>2000
   OR coalesce(p_input->>'outputId','')!~'^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
   OR coalesce(p_input->>'commandId','')!~'^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
   OR coalesce(p_input->>'outputSha256','')!~'^[a-f0-9]{64}$'
   OR coalesce(p_input->>'expectedRevision','')!~'^(0|[1-9][0-9]{0,2})$'
   OR p_input->>'decision' NOT IN('reviewed_private','rejected_private','withdrawn_private')
   OR jsonb_typeof(p_input->'rightsConfirmed')<>'boolean'
   OR jsonb_typeof(p_input->'claimsConfirmed')<>'boolean'
   OR jsonb_typeof(p_input->'disclosureConfirmed')<>'boolean' THEN
   RAISE EXCEPTION 'Invalid exact private review request' USING ERRCODE='22023'; END IF;
 output_uuid:=(p_input->>'outputId')::uuid;cmd:=(p_input->>'commandId')::uuid;
 status:=p_input->>'decision';current_rev:=(p_input->>'expectedRevision')::integer;
 approved:=p_input->>'rightsConfirmed'='true' AND p_input->>'claimsConfirmed'='true'
  AND p_input->>'disclosureConfirmed'='true';
 input_hash:=encode(public.digest(p_input::text,'sha256'),'hex');
 PERFORM pg_advisory_xact_lock(hashtextextended('rl72-output-review:'||p_workspace::text||':'||output_uuid::text,0));
 SELECT * INTO command FROM app.creative_media_output_review_commands
   WHERE workspace_id=p_workspace AND command_id=cmd;
 IF command.command_id IS NOT NULL THEN
  IF command.output_id IS DISTINCT FROM output_uuid OR command.input_sha256 IS DISTINCT FROM input_hash THEN
   RAISE EXCEPTION 'Review command changed content' USING ERRCODE='40001'; END IF;
  RETURN jsonb_build_object('outputId',output_uuid,'revision',command.revision,'replayed',true,'decision',status);
 END IF;
 SELECT * INTO target FROM app.creative_media_video_outputs
  WHERE workspace_id=p_workspace AND id=output_uuid;
 IF target.id IS NULL OR target.state<>'captured_unverified'
   OR target.sha256 IS DISTINCT FROM p_input->>'outputSha256' THEN
   RAISE EXCEPTION 'Original unmodified private output required' USING ERRCODE='42501'; END IF;
 SELECT * INTO previous FROM app.creative_media_output_reviews
  WHERE workspace_id=p_workspace AND output_id=output_uuid ORDER BY revision DESC LIMIT 1;
 next_rev:=coalesce(previous.revision,0)+1;
 IF current_rev<>next_rev-1 OR next_rev>100 THEN
  RAISE EXCEPTION 'Review revision changed' USING ERRCODE='40001'; END IF;
 IF status='reviewed_private' THEN
  IF NOT approved OR coalesce(previous.decision,'')='reviewed_private'
    OR NOT EXISTS(SELECT 1 FROM app.creative_media_output_probes p
      WHERE p.workspace_id=p_workspace AND p.output_id=output_uuid
       AND p.output_sha256=target.sha256 AND p.status='verified_technical') THEN
    RAISE EXCEPTION 'Technical probe and all three owner attestations required for private acceptance' USING ERRCODE='55000'; END IF;
 ELSIF status='withdrawn_private' THEN
  IF previous.decision IS DISTINCT FROM 'reviewed_private' THEN
    RAISE EXCEPTION 'Only previously reviewed private output can be withdrawn' USING ERRCODE='55000'; END IF;
 ELSE
  IF previous.decision IS NOT DISTINCT FROM 'rejected_private' THEN
    RAISE EXCEPTION 'Output already rejected' USING ERRCODE='55000'; END IF;
 END IF;
 INSERT INTO app.creative_media_output_reviews(workspace_id,output_id,revision,
   output_sha256,decision,rights_confirmed,claims_confirmed,disclosure_confirmed,reviewed_by)
 VALUES(p_workspace,output_uuid,next_rev,target.sha256,status,
   p_input->>'rightsConfirmed'='true',
   p_input->>'claimsConfirmed'='true',
   p_input->>'disclosureConfirmed'='true',actor);
 INSERT INTO app.creative_media_output_review_commands
   (workspace_id,command_id,output_id,revision,input_sha256)
 VALUES(p_workspace,cmd,output_uuid,next_rev,input_hash);
 RETURN jsonb_build_object('outputId',output_uuid,'revision',next_rev,'replayed',false,'decision',status);
END $f$;
REVOKE ALL ON FUNCTION app_private.creative_media_output_review(uuid,bytea,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.creative_media_output_review(uuid,bytea,text,jsonb)
 TO r72_content_command;
RESET ROLE;SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_creative_studio_definer;
