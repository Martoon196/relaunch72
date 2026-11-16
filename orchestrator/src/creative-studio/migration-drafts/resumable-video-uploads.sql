-- PRIVATE DRAFT ONLY. Resumable pilot intake into the canonical private blob store.
-- The canonical 20 MB ceiling is retained. No new public store or provider URL.
SET LOCAL ROLE r72_owner;
CREATE TABLE app.creative_media_uploads (
 workspace_id uuid NOT NULL REFERENCES app.seo_blog_brands(workspace_id), id uuid NOT NULL,
 metadata jsonb NOT NULL CHECK(jsonb_typeof(metadata)='object' AND octet_length(metadata::text)<2048),
 expected_bytes integer NOT NULL CHECK(expected_bytes BETWEEN 1024 AND 20000000),
 expected_sha256 text NOT NULL CHECK(expected_sha256~'^[a-f0-9]{64}$'),
 state text NOT NULL DEFAULT 'uploading' CHECK(state IN('uploading','completed','cancelled')),
 source_id uuid, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '24 hours',
 PRIMARY KEY(workspace_id,id),
 CHECK((state='completed')=(source_id IS NOT NULL))
);
CREATE TABLE app.creative_media_upload_parts (
 workspace_id uuid NOT NULL, upload_id uuid NOT NULL, part_no integer NOT NULL CHECK(part_no BETWEEN 0 AND 19),
 bytes bytea NOT NULL CHECK(octet_length(bytes) BETWEEN 1 AND 1000000),
 sha256 text NOT NULL CHECK(sha256=encode(public.digest(bytes,'sha256'),'hex')),
 PRIMARY KEY(workspace_id,upload_id,part_no),
 FOREIGN KEY(workspace_id,upload_id) REFERENCES app.creative_media_uploads(workspace_id,id)
);
DO $t$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['creative_media_uploads','creative_media_upload_parts'] LOOP
  EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON app.%I FROM PUBLIC,r72_web,r72_content_command,r72_worker',t);
  EXECUTE format('CREATE POLICY %I ON app.%I FOR ALL TO r72_owner USING(true) WITH CHECK(true)',t||'_owner',t);
  EXECUTE format('CREATE POLICY %I ON app.%I FOR ALL TO r72_creative_studio_definer USING(workspace_id=app_private.current_workspace_id()) WITH CHECK(workspace_id=app_private.current_workspace_id())',t||'_scope',t);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON app.%I TO r72_creative_studio_definer',t);
  INSERT INTO app_private.workspace_table_registry(schema_name,table_name,workspace_column) VALUES('app',t,'workspace_id');
 END LOOP;
END $t$;
GRANT CREATE ON SCHEMA app_private TO r72_creative_studio_definer;
SET LOCAL ROLE r72_creative_studio_definer;
CREATE FUNCTION app_private.creative_media_upload(p_workspace uuid,p_session bytea,p_action text,p_id uuid,p_input jsonb,p_bytes bytea)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE u app.creative_media_uploads; old_part app.creative_media_upload_parts;
 part integer; expected integer; assembled bytea; saved jsonb; meta jsonb;
BEGIN
 IF p_session IS NULL OR app_private.current_actor_kind() IS DISTINCT FROM 'user' THEN
  RAISE EXCEPTION 'Owner session required' USING ERRCODE='42501'; END IF;
 PERFORM app_private.seo_media_owner(p_workspace,p_session);
 IF p_id IS NULL OR coalesce(p_action,'') NOT IN('begin','status','part','complete','cancel')
  OR p_input IS NULL OR jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR octet_length(p_input::text)>2500 THEN
  RAISE EXCEPTION 'Invalid upload command' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('rl72-upload:'||p_workspace::text,0));
 SELECT * INTO u FROM app.creative_media_uploads WHERE workspace_id=p_workspace AND id=p_id FOR UPDATE;
 IF p_action='begin' THEN
  meta:=p_input->'metadata';
  IF coalesce(p_input->>'byteLength','')!~'^[0-9]{4,8}$'
   OR (p_input->>'byteLength')::integer NOT BETWEEN 1024 AND 20000000
   OR coalesce(p_input->>'sha256','')!~'^[a-f0-9]{64}$'
   OR jsonb_typeof(meta) IS DISTINCT FROM 'object'
   OR meta->>'rightsConfirmed' IS DISTINCT FROM 'true'
   OR coalesce(meta->>'rights','') NOT IN('owned','licensed')
   OR length(coalesce(meta->>'fileName','')) NOT BETWEEN 1 AND 160
   OR meta->>'fileName'~'[[:cntrl:]<>/\\]' OR lower(meta->>'fileName')!~'\.(mp4|webm)$'
   OR (meta->>'rights'='licensed' AND coalesce(meta->>'evidenceSha256','')!~'^[a-f0-9]{64}$')
   OR coalesce(meta->>'mime','') NOT IN('video/mp4','video/webm') THEN
   RAISE EXCEPTION 'Source metadata and rights required' USING ERRCODE='22023'; END IF;
  IF u.id IS NOT NULL THEN
   IF u.metadata IS DISTINCT FROM meta OR u.expected_bytes IS DISTINCT FROM (p_input->>'byteLength')::integer
    OR u.expected_sha256 IS DISTINCT FROM p_input->>'sha256' THEN
    RAISE EXCEPTION 'Upload replay changed input' USING ERRCODE='40001'; END IF;
  ELSE
   IF (SELECT count(*) FROM app.creative_media_uploads WHERE workspace_id=p_workspace AND state='uploading' AND expires_at>clock_timestamp())>=3 THEN
    RAISE EXCEPTION 'Three pending upload limit reached' USING ERRCODE='55000'; END IF;
   -- Expired bytes have no authority and are removed before more staging space is admitted.
   DELETE FROM app.creative_media_upload_parts part USING app.creative_media_uploads upload
    WHERE part.workspace_id=p_workspace AND upload.workspace_id=part.workspace_id AND upload.id=part.upload_id
     AND upload.expires_at<=clock_timestamp();
   INSERT INTO app.creative_media_uploads(workspace_id,id,metadata,expected_bytes,expected_sha256)
   VALUES(p_workspace,p_id,meta,(p_input->>'byteLength')::integer,p_input->>'sha256') RETURNING * INTO u;
  END IF;
 END IF;
 IF u.id IS NULL THEN RAISE EXCEPTION 'Private upload unavailable' USING ERRCODE='42501'; END IF;
 IF p_action='cancel' AND u.state='uploading' THEN
  DELETE FROM app.creative_media_upload_parts WHERE workspace_id=p_workspace AND upload_id=p_id;
  UPDATE app.creative_media_uploads SET state='cancelled' WHERE workspace_id=p_workspace AND id=p_id RETURNING * INTO u;
 ELSIF p_action IN('part','complete') THEN
  IF u.state='completed' AND p_action='complete' THEN
   RETURN jsonb_build_object('id',u.source_id,'sha256',u.expected_sha256,'state','awaiting_probe','replayed',true); END IF;
  IF u.state<>'uploading' OR u.expires_at<=clock_timestamp() THEN
   RAISE EXCEPTION 'Upload expired or closed' USING ERRCODE='55000'; END IF;
  IF p_action='part' THEN
   IF coalesce(p_input->>'part','')!~'^[0-9]{1,2}$' OR p_bytes IS NULL THEN
    RAISE EXCEPTION 'Part bytes required' USING ERRCODE='22023'; END IF;
   part:=(p_input->>'part')::integer;
   expected:=least(1000000,u.expected_bytes-part*1000000);
   IF part NOT BETWEEN 0 AND 19 OR expected<=0 OR octet_length(p_bytes)<>expected
    OR encode(public.digest(p_bytes,'sha256'),'hex') IS DISTINCT FROM p_input->>'sha256' THEN
    RAISE EXCEPTION 'Upload part length or checksum changed' USING ERRCODE='22023'; END IF;
   SELECT * INTO old_part FROM app.creative_media_upload_parts WHERE workspace_id=p_workspace AND upload_id=p_id AND part_no=part;
   IF old_part.upload_id IS NOT NULL AND old_part.sha256 IS DISTINCT FROM p_input->>'sha256' THEN
    RAISE EXCEPTION 'Upload part replay changed bytes' USING ERRCODE='40001'; END IF;
   INSERT INTO app.creative_media_upload_parts VALUES(p_workspace,p_id,part,p_bytes,p_input->>'sha256') ON CONFLICT DO NOTHING;
  ELSE
   SELECT string_agg(bytes,''::bytea ORDER BY part_no) INTO assembled FROM app.creative_media_upload_parts
    WHERE workspace_id=p_workspace AND upload_id=p_id;
   IF assembled IS NULL OR octet_length(assembled)<>u.expected_bytes
    OR encode(public.digest(assembled,'sha256'),'hex')<>u.expected_sha256 THEN
    RAISE EXCEPTION 'Complete exact source checksum required' USING ERRCODE='55000'; END IF;
   saved:=app_private.creative_media_video_source_command(p_workspace,p_session,'upload',p_id,
     u.metadata||jsonb_build_object('sha256',u.expected_sha256),assembled);
   UPDATE app.creative_media_uploads SET state='completed',source_id=(saved->>'id')::uuid WHERE workspace_id=p_workspace AND id=p_id;
   DELETE FROM app.creative_media_upload_parts WHERE workspace_id=p_workspace AND upload_id=p_id;
   RETURN saved;
  END IF;
 END IF;
 RETURN jsonb_build_object('uploadId',u.id,'state',u.state,'byteLength',u.expected_bytes,'sha256',u.expected_sha256,
  'sourceId',u.source_id,'expiresAt',u.expires_at,'partBytes',1000000,
  'parts',coalesce((SELECT jsonb_agg(part_no ORDER BY part_no) FROM app.creative_media_upload_parts WHERE workspace_id=p_workspace AND upload_id=p_id),'[]'::jsonb));
END $f$;
REVOKE ALL ON FUNCTION app_private.creative_media_upload(uuid,bytea,text,uuid,jsonb,bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.creative_media_upload(uuid,bytea,text,uuid,jsonb,bytea) TO r72_content_command;
RESET ROLE;SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_creative_studio_definer;
