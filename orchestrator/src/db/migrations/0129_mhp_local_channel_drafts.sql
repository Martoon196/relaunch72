-- GHQ-FOLLOWUP-006E draft-only proper local SMS/WhatsApp content references.
-- No provider template, queue, run, recipient or activation is created.
-- Ratified E design f1b9ed81169914bf3fdcd42e57288fb1c81071a1c81b1f5b2eaec9fad3bf90cd.
SET LOCAL ROLE r72_owner;
GRANT CREATE ON SCHEMA app_private TO r72_mhp_prospect_definer;
CREATE POLICY mhp_channel_items_read ON app.company_content_items FOR SELECT TO r72_mhp_prospect_definer
 USING(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND source_system IN('mhp.owner-sms','mhp.owner-whatsapp'));
CREATE POLICY mhp_channel_versions_read ON app.company_content_versions FOR SELECT TO r72_mhp_prospect_definer
 USING(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND source_system IN('mhp.owner-sms','mhp.owner-whatsapp'));
DO $policies$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['company_content_source_attestations','company_content_approval_requests','company_content_approval_decisions'] LOOP
  EXECUTE format('CREATE POLICY mhp_channel_local_read ON app.%I FOR SELECT TO r72_mhp_prospect_definer USING (
   workspace_id=''2789228d-55a6-4688-b1e8-2f70abca990b'' AND EXISTS(SELECT 1 FROM app.company_content_versions v
    WHERE v.workspace_id=%I.workspace_id AND v.id=%I.content_version_id AND v.source_system IN(''mhp.owner-sms'',''mhp.owner-whatsapp'')))',t,t,t);
 END LOOP;
END $policies$;
SET LOCAL ROLE r72_mhp_prospect_definer;
CREATE FUNCTION app_private.mhp_owner_channel_exact(p_version uuid,p_latest boolean) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE v app.company_content_versions%ROWTYPE; d jsonb; local jsonb; manifest jsonb; brand jsonb; channel text;
 keys text[]; remaining text; body text; parameter_count integer; highest integer;
BEGIN
 SELECT * INTO v FROM app.company_content_versions WHERE id=p_version AND workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b'
  AND source_system IN('mhp.owner-sms','mhp.owner-whatsapp');
 IF NOT FOUND OR v.content_kind<>'other' OR v.source_version!~'^edit:[0-9a-f-]{36}$' THEN RAISE EXCEPTION 'Local channel draft unavailable' USING ERRCODE='23514'; END IF;
 channel:=CASE v.source_system WHEN 'mhp.owner-sms' THEN 'sms' ELSE 'whatsapp' END;
 IF v.source_item_id!~('^owner-'||channel||':[0-9a-f-]{36}$') OR v.content_mime_type IS DISTINCT FROM ('application/vnd.growthhq.'||(CASE channel WHEN 'sms' THEN 'sms-draft' ELSE 'whatsapp-template-draft' END)||'+json')
 THEN RAISE EXCEPTION 'Local channel source mismatch' USING ERRCODE='23514'; END IF;
 d:=v.content_body::jsonb;local:=v.metadata->'mhpChannelDraft';brand:=app_private.mhp_owner_email_brand();body:=d->>'bodyText';
 IF jsonb_typeof(d)<>'object' OR jsonb_typeof(d->'bodyText') IS DISTINCT FROM 'string' OR body!~'[^[:space:]]'
  OR translate(body,chr(9)||chr(10)||chr(13),'')~'[[:cntrl:]]'
  OR app_private.mhp_sequence_canonical(d) IS DISTINCT FROM v.content_body OR public.digest(v.content_body,'sha256') IS DISTINCT FROM v.content_sha256
  OR v.blob_sha256 IS DISTINCT FROM v.content_sha256 OR v.blob_storage_key IS DISTINCT FROM 'inline:mhp.owner-'||channel||':'||encode(v.content_sha256,'hex')
  OR local->>'schema' IS DISTINCT FROM 'mhp.channel-draft-local/v1' OR local->>'authoredBy' IS DISTINCT FROM 'native-owner'
  OR local->>'brandCanonical' IS DISTINCT FROM brand->>'canonical' OR v.brand_snapshot_ref IS DISTINCT FROM brand->>'ref'
  OR encode(v.brand_sha256,'hex') IS DISTINCT FROM brand->>'sha256'
 THEN RAISE EXCEPTION 'Local channel bytes or brand changed' USING ERRCODE='23514'; END IF;
 SELECT array_agg(k ORDER BY k) INTO keys FROM jsonb_object_keys(d) k;
 IF channel='sms' THEN
  IF keys IS DISTINCT FROM ARRAY['bodyText','schema'] OR d->>'schema' IS DISTINCT FROM 'growthhq.sms-draft/v1' OR length(body)>1530 OR octet_length(body)>8000
  THEN RAISE EXCEPTION 'Invalid local SMS draft' USING ERRCODE='23514'; END IF;
  remaining:=regexp_replace(body,'\{\{(FIRSTNAME|LINK)\}\}','','g');
 ELSE
  IF keys IS DISTINCT FROM ARRAY['bodyText','language','schema','templateName'] OR d->>'schema' IS DISTINCT FROM 'growthhq.whatsapp-template-draft/v1'
   OR jsonb_typeof(d->'templateName') IS DISTINCT FROM 'string' OR d->>'templateName'!~'^[a-z][a-z0-9_]{0,99}$'
   OR jsonb_typeof(d->'language') IS DISTINCT FROM 'string' OR d->>'language'!~'^[a-z]{2}(_[A-Z]{2})?$' OR length(body)>4096 OR octet_length(body)>16000
  THEN RAISE EXCEPTION 'Invalid local WhatsApp template draft' USING ERRCODE='23514'; END IF;
  remaining:=regexp_replace(body,'\{\{([1-9]|10)\}\}','','g');
  SELECT count(DISTINCT x[1]),max(x[1]::integer) INTO parameter_count,highest FROM regexp_matches(body,'\{\{([1-9]|10)\}\}','g') x;
  IF parameter_count<>coalesce(highest,0) THEN RAISE EXCEPTION 'Template parameters must be consecutive' USING ERRCODE='23514'; END IF;
 END IF;
 IF position('{{' IN remaining)>0 OR position('}}' IN remaining)>0 THEN RAISE EXCEPTION 'Invalid local message placeholder' USING ERRCODE='23514'; END IF;
 manifest:=(local->>'manifestCanonical')::jsonb;
 IF app_private.mhp_sequence_canonical(manifest) IS DISTINCT FROM local->>'manifestCanonical'
  OR manifest IS DISTINCT FROM jsonb_build_object('schema','mhp.channel-draft-source/v1','workspaceId',v.workspace_id::text,
   'sourceSystem',v.source_system,'sourceItemId',v.source_item_id,'sourceVersion',v.source_version,'contentSha256',encode(v.content_sha256,'hex'),
   'blobStorageKey',v.blob_storage_key,'blobSha256',encode(v.blob_sha256,'hex'),'brandSnapshotRef',v.brand_snapshot_ref,'brandSha256',encode(v.brand_sha256,'hex'),'channel',channel)
  OR local->>'manifestSha256' IS DISTINCT FROM encode(public.digest(local->>'manifestCanonical','sha256'),'hex')
 THEN RAISE EXCEPTION 'Local channel source manifest mismatch' USING ERRCODE='23514'; END IF;
 IF p_latest AND EXISTS(SELECT 1 FROM app.company_content_versions newer WHERE newer.workspace_id=v.workspace_id AND newer.content_item_id=v.content_item_id AND newer.version_number>v.version_number)
 THEN RAISE EXCEPTION 'A newer local message draft exists' USING ERRCODE='23514'; END IF;
 IF NOT app_private.mhp_marketing_workspace_allowed(v.created_by_user_id,v.workspace_id) THEN RAISE EXCEPTION 'Local message author permission changed' USING ERRCODE='42501'; END IF;
 RETURN jsonb_build_object('channel',channel,'contentItemId',v.content_item_id,'contentVersionId',v.id,'contentSha256',encode(v.content_sha256,'hex'),'payload',d);
END $f$;

CREATE OR REPLACE FUNCTION app_private.mhp_sequence_exact(p_version uuid,p_approved boolean,p_latest boolean) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE v app.company_content_versions%ROWTYPE; d jsonb; local jsonb; manifest jsonb; brand jsonb; step jsonb; exact jsonb;
 keys text[]; step_keys text[]:='{}'; total_wait bigint:=0; messages integer:=0; decision uuid; digest bytea;
BEGIN
 SELECT * INTO v FROM app.company_content_versions WHERE id=p_version AND workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND source_system='mhp.followup-sequence';
 IF NOT FOUND OR v.content_kind<>'other' OR v.content_mime_type<>'application/vnd.growthhq.followup-sequence+json'
  OR v.source_item_id!~'^sequence:[0-9a-f-]{36}$' OR v.source_version!~'^edit:[0-9a-f-]{36}$'
 THEN RAISE EXCEPTION 'Invalid sequence version' USING ERRCODE='23514'; END IF;
 d:=v.content_body::jsonb;local:=v.metadata->'mhpSequence';brand:=app_private.mhp_owner_email_brand();
 SELECT array_agg(k ORDER BY k) INTO keys FROM jsonb_object_keys(d) k;
 IF NOT (
   (d->>'schema'='growthhq.followup-sequence/v1' AND keys=ARRAY['brand','campaign','expiryHours','schema','steps','stopOn','title']) OR
   (d->>'schema'='growthhq.followup-sequence/v2' AND keys=ARRAY['brand','campaign','entry','expiryHours','schema','steps','stopOn','title']
    AND jsonb_typeof(d->'entry')='object' AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(d->'entry') k)=ARRAY['mode','source']
    AND d->'entry' IN('{"mode":"manual","source":"manual_owner"}'::jsonb,'{"mode":"webinar_signup","source":"mhp.capture/v2"}'::jsonb))
  ) IS TRUE
  OR d->>'brand' IS DISTINCT FROM 'mhp' OR jsonb_typeof(d->'campaign') IS DISTINCT FROM 'string' OR d->>'campaign'!~'^[a-z0-9_-]{1,60}$' OR d->>'title' IS DISTINCT FROM v.title
  OR jsonb_typeof(d->'title')<>'string' OR length(d->>'title') NOT BETWEEN 1 AND 180 OR d->>'title'<>btrim(d->>'title') OR d->>'title'~'[[:cntrl:]]'
  OR jsonb_typeof(d->'expiryHours')<>'number' OR (d->>'expiryHours')!~'^[0-9]+$' OR (d->>'expiryHours')::integer NOT BETWEEN 1 AND 168
  OR jsonb_typeof(d->'stopOn')<>'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(d->'stopOn') k) IS DISTINCT FROM ARRAY['booked','purchased','reply']
  OR EXISTS(SELECT 1 FROM jsonb_each(d->'stopOn') x WHERE jsonb_typeof(x.value)<>'boolean')
  OR jsonb_typeof(d->'steps')<>'array' OR jsonb_array_length(d->'steps') NOT BETWEEN 1 AND 24
  OR app_private.mhp_sequence_canonical(d)<>v.content_body OR public.digest(v.content_body,'sha256')<>v.content_sha256
  OR v.blob_sha256<>v.content_sha256 OR v.blob_storage_key<>'inline:mhp.followup-sequence:'||encode(v.content_sha256,'hex')
  OR local->>'schema' IS DISTINCT FROM 'mhp.followup-sequence-local/v1' OR local->>'authoredBy' IS DISTINCT FROM 'native-owner'
  OR local->>'brandCanonical' IS DISTINCT FROM brand->>'canonical' OR v.brand_snapshot_ref IS DISTINCT FROM brand->>'ref'
  OR encode(v.brand_sha256,'hex') IS DISTINCT FROM brand->>'sha256'
 THEN RAISE EXCEPTION 'Sequence bytes or brand changed' USING ERRCODE='23514'; END IF;
 FOR step IN SELECT value FROM jsonb_array_elements(d->'steps') LOOP
  IF jsonb_typeof(step)<>'object' OR step->>'key' IS NULL OR step->>'key'!~'^[a-z][a-z0-9_-]{0,49}$' OR step->>'key'=ANY(step_keys)
  THEN RAISE EXCEPTION 'Invalid sequence step identity' USING ERRCODE='23514'; END IF;
  step_keys:=array_append(step_keys,step->>'key');
  SELECT array_agg(k ORDER BY k) INTO keys FROM jsonb_object_keys(step) k;
  IF step->>'kind'='wait' THEN
   IF keys IS DISTINCT FROM ARRAY['key','kind','minutes'] OR jsonb_typeof(step->'minutes')<>'number' OR (step->>'minutes')!~'^[0-9]+$'
    OR (step->>'minutes')::bigint NOT BETWEEN 0 AND 525600 THEN RAISE EXCEPTION 'Invalid wait' USING ERRCODE='23514'; END IF;
   total_wait:=total_wait+(step->>'minutes')::bigint;
  ELSE
   IF keys IS DISTINCT FROM ARRAY['contentItemId','contentSha256','contentVersionId','key','kind'] OR step->>'kind' IS NULL OR step->>'kind' NOT IN('email','sms','whatsapp')
    OR step->>'contentItemId'!~'^[0-9a-f-]{36}$' OR step->>'contentVersionId'!~'^[0-9a-f-]{36}$' OR step->>'contentSha256'!~'^[0-9a-f]{64}$'
   THEN RAISE EXCEPTION 'Invalid message reference' USING ERRCODE='23514'; END IF;
   IF step->>'kind'='email' THEN
    IF NOT EXISTS(SELECT 1 FROM app.company_content_versions e WHERE e.workspace_id=v.workspace_id AND e.content_item_id=(step->>'contentItemId')::uuid
     AND e.id=(step->>'contentVersionId')::uuid AND e.content_sha256=decode(step->>'contentSha256','hex') AND e.source_system='mhp.owner-email')
    THEN RAISE EXCEPTION 'Message reference unavailable' USING ERRCODE='23514'; END IF;
   ELSE
    exact:=app_private.mhp_owner_channel_exact((step->>'contentVersionId')::uuid,true);
    IF exact->>'channel' IS DISTINCT FROM step->>'kind' OR exact->>'contentItemId' IS DISTINCT FROM step->>'contentItemId'
     OR exact->>'contentSha256' IS DISTINCT FROM step->>'contentSha256' THEN RAISE EXCEPTION 'Local channel reference changed' USING ERRCODE='23514'; END IF;
   END IF;
   IF p_approved THEN
    IF step->>'kind'<>'email' THEN RAISE EXCEPTION 'This message channel is not connected' USING ERRCODE='23514'; END IF;
    exact:=app_private.mhp_owner_email_exact((step->>'contentVersionId')::uuid,true,true,true);
    IF exact->>'audienceCampaign'<>d->>'campaign' THEN RAISE EXCEPTION 'Message audience changed' USING ERRCODE='23514'; END IF;
   END IF;
   messages:=messages+1;
  END IF;
 END LOOP;
 IF messages=0 OR step->>'kind'='wait' OR total_wait>525600 THEN RAISE EXCEPTION 'Invalid sequence timeline' USING ERRCODE='23514'; END IF;
 IF p_approved AND EXISTS(SELECT 1 FROM jsonb_each(d->'stopOn') x WHERE x.value='true'::jsonb)
 THEN RAISE EXCEPTION 'Selected automatic stop source is not connected' USING ERRCODE='23514'; END IF;
 manifest:=(local->>'manifestCanonical')::jsonb;digest:=public.digest(local->>'manifestCanonical','sha256');
 IF app_private.mhp_sequence_canonical(manifest) IS DISTINCT FROM local->>'manifestCanonical'
  OR manifest IS DISTINCT FROM jsonb_build_object('schema','mhp.followup-sequence-source/v1','workspaceId',v.workspace_id::text,
   'sourceSystem',v.source_system,'sourceItemId',v.source_item_id,'sourceVersion',v.source_version,
   'contentSha256',encode(v.content_sha256,'hex'),'blobStorageKey',v.blob_storage_key,'blobSha256',encode(v.blob_sha256,'hex'),
   'brandSnapshotRef',v.brand_snapshot_ref,'brandSha256',encode(v.brand_sha256,'hex'),'audienceCampaign',d->>'campaign')
  OR local->>'manifestSha256' IS DISTINCT FROM encode(digest,'hex')
 THEN RAISE EXCEPTION 'Sequence source manifest mismatch' USING ERRCODE='23514'; END IF;
 IF p_latest AND EXISTS(SELECT 1 FROM app.company_content_versions newer WHERE newer.workspace_id=v.workspace_id AND newer.content_item_id=v.content_item_id AND newer.version_number>v.version_number)
 THEN RAISE EXCEPTION 'A newer sequence draft exists' USING ERRCODE='23514'; END IF;
 SELECT a.id INTO decision FROM app.company_content_approval_decisions a JOIN app.company_content_approval_requests r ON r.workspace_id=a.workspace_id AND r.id=a.approval_request_id
 WHERE a.workspace_id=v.workspace_id AND a.content_version_id=v.id AND a.content_sha256=v.content_sha256 AND a.decision='approved'
  AND app_private.mhp_marketing_workspace_allowed(a.decided_by_user_id,a.workspace_id)
  AND r.request_number=(SELECT max(latest.request_number) FROM app.company_content_approval_requests latest WHERE latest.workspace_id=v.workspace_id AND latest.content_version_id=v.id)
 ORDER BY a.decided_at DESC,a.id DESC LIMIT 1;
 IF p_approved AND (decision IS NULL OR NOT EXISTS(SELECT 1 FROM app.company_content_source_attestations a WHERE a.workspace_id=v.workspace_id AND a.content_version_id=v.id
  AND a.source_catalog_sha256=digest AND a.content_sha256=v.content_sha256 AND a.blob_sha256=v.blob_sha256 AND a.brand_sha256=v.brand_sha256))
 THEN RAISE EXCEPTION 'Published exact sequence required' USING ERRCODE='23514'; END IF;
 IF NOT app_private.mhp_marketing_workspace_allowed(v.created_by_user_id,v.workspace_id) THEN RAISE EXCEPTION 'Sequence author permission changed' USING ERRCODE='42501'; END IF;
 RETURN jsonb_build_object('contentItemId',v.content_item_id,'contentVersionId',v.id,'versionNumber',v.version_number,'previousVersionId',v.previous_version_id,
  'title',v.title,'sourceItemId',v.source_item_id,'sourceVersion',v.source_version,'canonicalContent',v.content_body,'contentSha256',encode(v.content_sha256,'hex'),
  'blobSha256',encode(v.blob_sha256,'hex'),'brand',brand,'manifestCanonical',local->>'manifestCanonical','manifestSha256',encode(digest,'hex'),
  'approvalDecisionId',decision,'authorId',v.created_by_user_id,'campaign',d->>'campaign','definition',d);
END $f$;

REVOKE ALL ON FUNCTION app_private.mhp_owner_channel_exact(uuid,boolean) FROM PUBLIC,r72_web,r72_identity_command,r72_content_adapter,r72_content_command;
RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_mhp_prospect_definer;
RESET ROLE;
