-- PRIVATE DRAFT ONLY: Claude owns numbering, permissions review and integration.
-- Exact local output review only. No distribution, billing or provider permission.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
SET LOCAL ROLE r72_owner;
CREATE TABLE app.creative_media_local_output_reviews (
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
 FOREIGN KEY(workspace_id,output_id) REFERENCES app.creative_media_local_render_outputs(workspace_id,id),
 CHECK(decision<>'reviewed_private' OR (rights_confirmed AND claims_confirmed AND disclosure_confirmed))
);
CREATE TABLE app.creative_media_local_output_review_commands (
 workspace_id uuid NOT NULL, command_id uuid NOT NULL,
 output_id uuid NOT NULL, revision integer NOT NULL,
 input_sha256 text NOT NULL CHECK(input_sha256~'^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,command_id),
 FOREIGN KEY(workspace_id,output_id,revision)
   REFERENCES app.creative_media_local_output_reviews(workspace_id,output_id,revision)
);
DO $tables$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['creative_media_local_output_reviews','creative_media_local_output_review_commands'] LOOP
  EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON app.%I FROM PUBLIC,r72_content_command,r72_worker,r72_web',t);
  EXECUTE format('CREATE POLICY %I ON app.%I FOR ALL TO r72_owner USING(true) WITH CHECK(true)',t||'_owner',t);
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON app.%I FOR EACH ROW EXECUTE FUNCTION app_private.seo_blog_append_only()',t||'_immutable',t);
  INSERT INTO app_private.workspace_table_registry(schema_name,table_name,workspace_column) VALUES('app',t,'workspace_id');
 END LOOP;
END $tables$;
DO $reviews$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['creative_media_local_output_reviews','creative_media_local_output_review_commands'] LOOP
  EXECUTE format('CREATE POLICY %I ON app.%I FOR ALL TO r72_creative_studio_definer USING(workspace_id=app_private.current_workspace_id()) WITH CHECK(workspace_id=app_private.current_workspace_id())',t||'_studio',t);
  EXECUTE format('GRANT SELECT,INSERT ON app.%I TO r72_creative_studio_definer',t);
 END LOOP;
END $reviews$;
GRANT CREATE ON SCHEMA app_private TO r72_creative_studio_definer;
SET LOCAL ROLE r72_creative_studio_definer;
CREATE FUNCTION app_private.creative_media_local_output_review(
 p_workspace uuid,p_session bytea,p_action text,p_input jsonb
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; target app.creative_media_local_render_outputs;
 previous app.creative_media_local_output_reviews; command app.creative_media_local_output_review_commands;
 current_rev integer; next_rev integer; output_uuid uuid; cmd uuid; status text; approved boolean;
 input_hash text;
BEGIN
 IF p_session IS NULL OR app_private.current_actor_kind()<>'user' THEN
   RAISE EXCEPTION 'Active owner session required' USING ERRCODE='42501'; END IF;
 actor:=app_private.seo_media_owner(p_workspace,p_session);
 IF p_action='list' THEN
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object(
    'outputId',o.id,'revision',coalesce(r.revision,0),'sha256',o.sha256,
    'decision',r.decision,'createdAt',r.created_at,'reviewedBy',r.reviewed_by,
    'technicalStatus','verified_technical',
    'durationMs',o.duration_ms,'width',o.width,'height',o.height)
    ORDER BY o.created_at DESC)
    FROM app.creative_media_local_render_outputs o
    LEFT JOIN LATERAL (SELECT revision,decision,created_at,reviewed_by
      FROM app.creative_media_local_output_reviews
      WHERE workspace_id=o.workspace_id AND output_id=o.id
      ORDER BY revision DESC LIMIT 1) r ON true
    WHERE o.workspace_id=p_workspace),'[]'::jsonb);
 END IF;
 IF p_action<>'review' OR p_input IS NULL OR jsonb_typeof(p_input)<>'object'
   OR octet_length(p_input::text)>2000
   OR coalesce(p_input->>'outputId','')!~'^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
   OR coalesce(p_input->>'commandId','')!~'^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
   OR coalesce(p_input->>'outputSha256','')!~'^[a-f0-9]{64}$'
   OR coalesce(p_input->>'expectedRevision','')!~'^(0|[1-9][0-9]{0,2})$'
   OR coalesce(p_input->>'decision','') NOT IN('reviewed_private','rejected_private','withdrawn_private')
   OR jsonb_typeof(p_input->'rightsConfirmed') IS DISTINCT FROM 'boolean'
   OR jsonb_typeof(p_input->'claimsConfirmed') IS DISTINCT FROM 'boolean'
   OR jsonb_typeof(p_input->'disclosureConfirmed') IS DISTINCT FROM 'boolean' THEN
   RAISE EXCEPTION 'Invalid exact private review request' USING ERRCODE='22023'; END IF;
 output_uuid:=(p_input->>'outputId')::uuid;cmd:=(p_input->>'commandId')::uuid;
 status:=p_input->>'decision';current_rev:=(p_input->>'expectedRevision')::integer;
 approved:=p_input->>'rightsConfirmed'='true' AND p_input->>'claimsConfirmed'='true'
  AND p_input->>'disclosureConfirmed'='true';
 input_hash:=encode(public.digest(p_input::text,'sha256'),'hex');
 PERFORM pg_advisory_xact_lock(hashtextextended('rl72-local-output-review:'||p_workspace::text||':'||output_uuid::text,0));
 SELECT * INTO command FROM app.creative_media_local_output_review_commands
   WHERE workspace_id=p_workspace AND command_id=cmd;
 IF command.command_id IS NOT NULL THEN
  IF command.output_id IS DISTINCT FROM output_uuid OR command.input_sha256 IS DISTINCT FROM input_hash THEN
   RAISE EXCEPTION 'Review command changed content' USING ERRCODE='40001'; END IF;
  RETURN jsonb_build_object('outputId',output_uuid,'revision',command.revision,'replayed',true,'decision',status);
 END IF;
 SELECT * INTO target FROM app.creative_media_local_render_outputs
  WHERE workspace_id=p_workspace AND id=output_uuid;
 IF target.id IS NULL
   OR target.sha256 IS DISTINCT FROM p_input->>'outputSha256' THEN
   RAISE EXCEPTION 'Original unmodified private output required' USING ERRCODE='42501'; END IF;
 SELECT * INTO previous FROM app.creative_media_local_output_reviews
  WHERE workspace_id=p_workspace AND output_id=output_uuid ORDER BY revision DESC LIMIT 1;
 next_rev:=coalesce(previous.revision,0)+1;
 IF current_rev<>next_rev-1 OR next_rev>100 THEN
  RAISE EXCEPTION 'Review revision changed' USING ERRCODE='40001'; END IF;
 IF status='reviewed_private' THEN
  IF NOT approved OR coalesce(previous.decision,'')='reviewed_private'
    OR NOT EXISTS(SELECT 1 FROM app.creative_media_local_render_jobs j
      JOIN app.seo_blog_blobs b ON b.workspace_id=target.workspace_id AND b.id=target.blob_id
      WHERE j.workspace_id=p_workspace AND j.id=target.job_id
       AND j.state='completed' AND j.output_id=target.id
       AND j.source_sha256=target.source_sha256 AND j.plan_sha256=target.plan_sha256
       AND target.renderer_version='rl72-native-ffmpeg-v1'
       AND target.sha256=encode(b.sha256,'hex')
       AND target.sha256=encode(public.digest(b.bytes,'sha256'),'hex')
       AND target.byte_length=octet_length(b.bytes)) THEN
    RAISE EXCEPTION 'Technical probe and all three owner attestations required for private acceptance' USING ERRCODE='55000'; END IF;
 ELSIF status='withdrawn_private' THEN
  IF previous.decision IS DISTINCT FROM 'reviewed_private' THEN
    RAISE EXCEPTION 'Only previously reviewed private output can be withdrawn' USING ERRCODE='55000'; END IF;
 ELSE
  IF previous.decision IS NOT DISTINCT FROM 'rejected_private' THEN
    RAISE EXCEPTION 'Output already rejected' USING ERRCODE='55000'; END IF;
 END IF;
 INSERT INTO app.creative_media_local_output_reviews(workspace_id,output_id,revision,
   output_sha256,decision,rights_confirmed,claims_confirmed,disclosure_confirmed,reviewed_by)
 VALUES(p_workspace,output_uuid,next_rev,target.sha256,status,
   p_input->>'rightsConfirmed'='true',
   p_input->>'claimsConfirmed'='true',
   p_input->>'disclosureConfirmed'='true',actor);
 INSERT INTO app.creative_media_local_output_review_commands
   (workspace_id,command_id,output_id,revision,input_sha256)
 VALUES(p_workspace,cmd,output_uuid,next_rev,input_hash);
 RETURN jsonb_build_object('outputId',output_uuid,'revision',next_rev,'replayed',false,'decision',status);
END $f$;
REVOKE ALL ON FUNCTION app_private.creative_media_local_output_review(uuid,bytea,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.creative_media_local_output_review(uuid,bytea,text,jsonb)
 TO r72_content_command;
RESET ROLE;SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_creative_studio_definer;
