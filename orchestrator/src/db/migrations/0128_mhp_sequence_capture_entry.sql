-- GHQ-FOLLOWUP-006D1: genuine future webinar capture entry. No active rules are seeded.
-- Exact design fdc259a291280c21542319663f4a43c1fd0ecf77594cebca4f2d7f11cb5532f6.
SET LOCAL ROLE r72_owner;
GRANT CREATE ON SCHEMA app_private TO r72_mhp_prospect_definer;
ALTER TABLE app_private.mhp_prospect_signups
 ADD COLUMN entry_campaign text, ADD COLUMN entry_source text, ADD COLUMN entry_event_sequence bigint,
 ADD CONSTRAINT mhp_capture_entry_shape CHECK(
  (entry_campaign IS NULL AND entry_source IS NULL AND entry_event_sequence IS NULL) OR
  (entry_campaign IS NOT NULL AND entry_source IS NOT NULL AND entry_event_sequence IS NOT NULL
   AND kind='webinar' AND entry_campaign~'^[a-z0-9_-]{1,60}$' AND entry_source='mhp.capture/v2' AND entry_event_sequence>0)),
 ADD CONSTRAINT mhp_capture_entry_identity UNIQUE(id,prospect_id,entry_campaign,entry_event_sequence);
CREATE UNIQUE INDEX mhp_capture_entry_cursor ON app_private.mhp_prospect_signups(entry_campaign,entry_event_sequence) WHERE entry_event_sequence IS NOT NULL;
CREATE SEQUENCE app_private.mhp_capture_event_sequence AS bigint NO CYCLE;
REVOKE ALL ON SEQUENCE app_private.mhp_capture_event_sequence FROM PUBLIC;
GRANT USAGE ON SEQUENCE app_private.mhp_capture_event_sequence TO r72_mhp_prospect_definer;
CREATE TABLE app_private.mhp_sequence_entry_rules(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL CHECK(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b'),
 sequence_item_id uuid NOT NULL,sequence_version_id uuid NOT NULL,sequence_sha256 bytea NOT NULL CHECK(octet_length(sequence_sha256)=32),
 sequence_approval_id uuid NOT NULL,owner_user_id uuid NOT NULL,campaign text NOT NULL CHECK(campaign~'^[a-z0-9_-]{1,60}$'),
 event_name text NOT NULL DEFAULT 'webinar_signup' CHECK(event_name='webinar_signup'),entry_source text NOT NULL DEFAULT 'mhp.capture/v2' CHECK(entry_source='mhp.capture/v2'),
 activated_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL CHECK(expires_at>activated_at),
 activation_sequence bigint NOT NULL CHECK(activation_sequence>=0),cursor_sequence bigint NOT NULL CHECK(cursor_sequence>=activation_sequence),
 cursor_signup_id uuid,cursor_at timestamptz,last_swept_at timestamptz,disabled_at timestamptz,held_at timestamptz,held_reason text,
 CHECK((cursor_signup_id IS NULL)=(cursor_at IS NULL)),CHECK((held_at IS NULL)=(held_reason IS NULL)),
 CHECK(held_reason IS NULL OR held_reason IN('newer_sequence','content_changed','recovery')),
 UNIQUE(workspace_id,id,sequence_version_id,campaign),
 FOREIGN KEY(workspace_id,sequence_item_id,sequence_version_id,sequence_sha256) REFERENCES app.company_content_versions(workspace_id,content_item_id,id,content_sha256) ON DELETE RESTRICT,
 FOREIGN KEY(workspace_id,sequence_approval_id) REFERENCES app.company_content_approval_decisions(workspace_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(workspace_id,owner_user_id) REFERENCES app.workspace_memberships(workspace_id,user_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX mhp_entry_one_open ON app_private.mhp_sequence_entry_rules(sequence_item_id,campaign) WHERE disabled_at IS NULL;
CREATE INDEX mhp_entry_fair ON app_private.mhp_sequence_entry_rules(last_swept_at NULLS FIRST,id) WHERE disabled_at IS NULL AND held_at IS NULL;
ALTER TABLE app_private.mhp_followup_runs ADD COLUMN entry_rule_id uuid,ADD COLUMN entry_signup_id uuid,ADD COLUMN entry_event_sequence bigint,
 ADD CONSTRAINT mhp_run_entry_shape CHECK((entry_rule_id IS NULL AND entry_signup_id IS NULL AND entry_event_sequence IS NULL) OR
  (entry_rule_id IS NOT NULL AND entry_signup_id IS NOT NULL AND entry_event_sequence IS NOT NULL AND entry_event_sequence>0)),
 ADD CONSTRAINT mhp_run_entry_rule FOREIGN KEY(workspace_id,entry_rule_id,sequence_version_id,campaign)
 REFERENCES app_private.mhp_sequence_entry_rules(workspace_id,id,sequence_version_id,campaign) ON DELETE RESTRICT,
 ADD CONSTRAINT mhp_run_entry_signup FOREIGN KEY(entry_signup_id,prospect_id,campaign,entry_event_sequence)
 REFERENCES app_private.mhp_prospect_signups(id,prospect_id,entry_campaign,entry_event_sequence) ON DELETE RESTRICT,
 ADD CONSTRAINT mhp_run_entry_identity UNIQUE(workspace_id,id,entry_rule_id,entry_signup_id,entry_event_sequence,prospect_id);
CREATE TABLE app_private.mhp_sequence_entry_receipts(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL CHECK(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b'),
 rule_id uuid NOT NULL,signup_id uuid NOT NULL,event_sequence bigint NOT NULL CHECK(event_sequence>0),event_at timestamptz NOT NULL,
 prospect_id uuid NOT NULL,campaign text NOT NULL,sequence_version_id uuid NOT NULL,
 disposition text NOT NULL CHECK(disposition IN('enrolled','already_enrolled','blocked','skipped')),
 reason text NOT NULL CHECK(reason IN('accepted','version_already_enrolled','open_previous_version','no_consent','current_permission')),
 run_id uuid,observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((disposition='enrolled')=(run_id IS NOT NULL)),UNIQUE(rule_id,signup_id),UNIQUE(rule_id,event_sequence),
 FOREIGN KEY(workspace_id,rule_id,sequence_version_id,campaign) REFERENCES app_private.mhp_sequence_entry_rules(workspace_id,id,sequence_version_id,campaign) ON DELETE RESTRICT,
 FOREIGN KEY(signup_id,prospect_id,campaign,event_sequence) REFERENCES app_private.mhp_prospect_signups(id,prospect_id,entry_campaign,entry_event_sequence) ON DELETE RESTRICT,
 FOREIGN KEY(workspace_id,run_id,rule_id,signup_id,event_sequence,prospect_id) REFERENCES app_private.mhp_followup_runs(workspace_id,id,entry_rule_id,entry_signup_id,entry_event_sequence,prospect_id) ON DELETE RESTRICT
);
DO $rls$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['mhp_sequence_entry_rules','mhp_sequence_entry_receipts'] LOOP
  EXECUTE format('ALTER TABLE app_private.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE app_private.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY mhp_entry_owner ON app_private.%I TO r72_owner USING(true) WITH CHECK(true)',t);
  EXECUTE format('CREATE POLICY mhp_entry_definer ON app_private.%I TO r72_mhp_prospect_definer USING(workspace_id=''2789228d-55a6-4688-b1e8-2f70abca990b'') WITH CHECK(workspace_id=''2789228d-55a6-4688-b1e8-2f70abca990b'')',t);
  EXECUTE format('REVOKE ALL ON app_private.%I FROM PUBLIC',t);
  EXECUTE format('GRANT SELECT,INSERT ON app_private.%I TO r72_mhp_prospect_definer',t);
  INSERT INTO app_private.workspace_table_registry(schema_name,table_name,workspace_column) VALUES('app_private',t,'workspace_id');
 END LOOP;
END $rls$;
GRANT UPDATE ON app_private.mhp_sequence_entry_rules TO r72_mhp_prospect_definer;
CREATE POLICY mhp_entry_command_receipts ON app.command_receipts TO r72_mhp_prospect_definer
 USING(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND command_name IN('mhp.sequence.entry.activate','mhp.sequence.entry.off'))
 WITH CHECK(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND command_name IN('mhp.sequence.entry.activate','mhp.sequence.entry.off'));
SET LOCAL ROLE r72_mhp_prospect_definer;


CREATE OR REPLACE FUNCTION app_private.mhp_capture_signup(p_email text,p_first_name text,p_level text,p_consent boolean,p_consent_version text,
 p_kind text,p_label text,p_module text,p_link text,p_source_hash bytea,p_schedule jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE prospect app_private.mhp_prospects%ROWTYPE; created boolean:=false; item jsonb; queued integer:=0; signup_id uuid;
BEGIN
 IF p_email IS NULL OR p_email<>lower(btrim(p_email)) OR length(p_email)>320 OR p_email!~'^[^[:space:]@<>]+@[^[:space:]@<>]+\.[^[:space:]@<>]+$'
  OR p_consent IS NULL OR p_consent_version IS NULL OR length(p_consent_version) NOT BETWEEN 1 AND 40
  OR p_kind IS NULL OR p_kind NOT IN('sheet','webinar','waitlist') OR p_label IS NULL OR length(btrim(p_label)) NOT BETWEEN 1 AND 200
  OR (p_level IS NOT NULL AND p_level NOT IN('L1','L2','L3'))
  OR p_schedule IS NULL OR jsonb_typeof(p_schedule)<>'array' OR jsonb_array_length(p_schedule)>8 THEN
  RAISE EXCEPTION 'Invalid sign-up' USING ERRCODE='22023';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_email,121));
 SELECT * INTO prospect FROM app_private.mhp_prospects WHERE email::text=p_email FOR UPDATE;
 IF NOT FOUND THEN
  INSERT INTO app_private.mhp_prospects(email,first_name,level,marketing_consent,consent_version,consent_at)
  VALUES(p_email,NULLIF(btrim(p_first_name),''),p_level,p_consent,CASE WHEN p_consent THEN p_consent_version END,CASE WHEN p_consent THEN clock_timestamp() END)
  RETURNING * INTO prospect;
  created:=true;
 ELSE
  UPDATE app_private.mhp_prospects SET
   first_name=COALESCE(NULLIF(btrim(p_first_name),''),first_name),
   level=COALESCE(p_level,level),
   marketing_consent=marketing_consent OR p_consent,
   consent_version=CASE WHEN p_consent THEN p_consent_version ELSE consent_version END,
   consent_at=CASE WHEN p_consent THEN clock_timestamp() ELSE consent_at END,
   unsubscribed_at=CASE WHEN p_consent THEN NULL ELSE unsubscribed_at END,
   updated_at=clock_timestamp()
  WHERE id=prospect.id RETURNING * INTO prospect;
 END IF;
 INSERT INTO app_private.mhp_prospect_signups(prospect_id,kind,label,module,link,consent_given,consent_version,source_hash)
 VALUES(prospect.id,p_kind,btrim(p_label),NULLIF(btrim(p_module),''),NULLIF(btrim(p_link),''),p_consent,p_consent_version,p_source_hash) RETURNING id INTO signup_id;
 IF prospect.unsubscribed_at IS NULL THEN
  FOR item IN SELECT value FROM jsonb_array_elements(p_schedule) LOOP
   IF jsonb_typeof(item)<>'object' OR (item->>'template') !~ '^[a-z0-9_]{1,40}$' OR (item->>'campaign') !~ '^[a-z0-9_-]{1,60}$'
    OR (item->>'dueAt') IS NULL OR (item->>'expiresAt') IS NULL THEN RAISE EXCEPTION 'Invalid schedule' USING ERRCODE='22023'; END IF;
   INSERT INTO app_private.mhp_marketing_sends(prospect_id,template_key,campaign_key,context,due_at,expires_at)
   VALUES(prospect.id,item->>'template',item->>'campaign',COALESCE(item->'context','{}'::jsonb),(item->>'dueAt')::timestamptz,(item->>'expiresAt')::timestamptz)
   ON CONFLICT(prospect_id,template_key,campaign_key) DO UPDATE SET
    -- A fresh sign-up after an unsubscribe revives emails that were cancelled, never ones already sent.
    cancelled_at=NULL,failed_at=NULL,attempts=0,lease_until=NULL,due_at=EXCLUDED.due_at,expires_at=EXCLUDED.expires_at,context=EXCLUDED.context
   WHERE app_private.mhp_marketing_sends.sent_at IS NULL AND app_private.mhp_marketing_sends.cancelled_at IS NOT NULL;
   IF FOUND THEN queued:=queued+1; END IF;
  END LOOP;
 END IF;
 RETURN jsonb_build_object('signupId',signup_id,'prospectId',prospect.id,'created',created,'queued',queued,'unsubscribed',prospect.unsubscribed_at IS NOT NULL);
END $f$;


CREATE FUNCTION app_private.mhp_capture_signup_v2(p_email text,p_first_name text,p_level text,p_consent boolean,p_consent_version text,
 p_kind text,p_label text,p_module text,p_link text,p_source_hash bytea,p_schedule jsonb,p_campaign text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE outcome jsonb; ordinal bigint;
BEGIN
 IF p_kind='webinar' THEN
  IF p_campaign IS NULL OR p_campaign!~'^[a-z0-9_-]{1,60}$' OR p_schedule IS NULL OR jsonb_typeof(p_schedule)<>'array'
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_schedule) x WHERE x->>'campaign' IS DISTINCT FROM p_campaign
    OR x->>'template' IS NULL OR x->>'template' NOT IN('webinar_confirm','webinar_24h','webinar_1h','webinar_replay','webinar_followup'))
  THEN RAISE EXCEPTION 'Invalid trusted webinar campaign' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('mhp-capture-campaign:'||p_campaign,7200128));
 ELSIF p_campaign IS NOT NULL THEN RAISE EXCEPTION 'Campaign is only for webinar capture' USING ERRCODE='22023'; END IF;
 outcome:=app_private.mhp_capture_signup(p_email,p_first_name,p_level,p_consent,p_consent_version,p_kind,p_label,p_module,p_link,p_source_hash,p_schedule);
 IF p_kind='webinar' THEN
  ordinal:=nextval('app_private.mhp_capture_event_sequence');
  UPDATE app_private.mhp_prospect_signups SET entry_campaign=p_campaign,entry_source='mhp.capture/v2',entry_event_sequence=ordinal
   WHERE id=(outcome->>'signupId')::uuid AND prospect_id=(outcome->>'prospectId')::uuid AND kind='webinar' AND entry_campaign IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Actual capture identity unavailable' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN outcome||jsonb_build_object('campaign',p_campaign,'entryEventSequence',ordinal::text);
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
   IF NOT EXISTS(SELECT 1 FROM app.company_content_versions e WHERE e.workspace_id=v.workspace_id AND e.content_item_id=(step->>'contentItemId')::uuid
    AND e.id=(step->>'contentVersionId')::uuid AND e.content_sha256=decode(step->>'contentSha256','hex') AND e.source_system='mhp.owner-email')
   THEN RAISE EXCEPTION 'Message reference unavailable' USING ERRCODE='23514'; END IF;
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


CREATE FUNCTION app_private.mhp_sequence_entry_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $f$
BEGIN
 IF TG_TABLE_NAME='mhp_sequence_entry_receipts' THEN RAISE EXCEPTION 'Entry receipt is immutable' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='mhp_sequence_entry_rules' THEN
  IF (to_jsonb(NEW)-ARRAY['cursor_sequence','cursor_signup_id','cursor_at','last_swept_at','disabled_at','held_at','held_reason'])
   IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['cursor_sequence','cursor_signup_id','cursor_at','last_swept_at','disabled_at','held_at','held_reason'])
   OR NEW.cursor_sequence<OLD.cursor_sequence OR (OLD.disabled_at IS NOT NULL AND NEW.disabled_at IS DISTINCT FROM OLD.disabled_at)
   OR (OLD.held_at IS NOT NULL AND (NEW.held_at IS DISTINCT FROM OLD.held_at OR NEW.held_reason IS DISTINCT FROM OLD.held_reason))
  THEN RAISE EXCEPTION 'Activation identity is immutable' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='mhp_prospect_signups' THEN
  IF OLD.entry_event_sequence IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Accepted capture is immutable' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='mhp_followup_runs' THEN
  IF ROW(NEW.entry_rule_id,NEW.entry_signup_id,NEW.entry_event_sequence) IS DISTINCT FROM ROW(OLD.entry_rule_id,OLD.entry_signup_id,OLD.entry_event_sequence)
  THEN RAISE EXCEPTION 'Run capture identity is immutable' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $f$;
RESET ROLE;
SET LOCAL ROLE r72_owner;
CREATE TRIGGER mhp_entry_rule_immutable BEFORE UPDATE ON app_private.mhp_sequence_entry_rules FOR EACH ROW EXECUTE FUNCTION app_private.mhp_sequence_entry_immutable();
CREATE TRIGGER mhp_entry_receipt_immutable BEFORE UPDATE OR DELETE ON app_private.mhp_sequence_entry_receipts FOR EACH ROW EXECUTE FUNCTION app_private.mhp_sequence_entry_immutable();
CREATE TRIGGER mhp_entry_capture_immutable BEFORE UPDATE ON app_private.mhp_prospect_signups FOR EACH ROW EXECUTE FUNCTION app_private.mhp_sequence_entry_immutable();
CREATE TRIGGER mhp_entry_run_immutable BEFORE UPDATE ON app_private.mhp_followup_runs FOR EACH ROW EXECUTE FUNCTION app_private.mhp_sequence_entry_immutable();
SET LOCAL ROLE r72_mhp_prospect_definer;

CREATE FUNCTION app_private.mhp_sequence_run_allowed(p_run uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT EXISTS(SELECT 1 FROM app_private.mhp_followup_runs r JOIN app_private.mhp_prospects p ON p.id=r.prospect_id
 WHERE r.id=p_run AND p.marketing_consent AND p.unsubscribed_at IS NULL AND
  ((r.entry_rule_id IS NULL AND app_private.mhp_sequence_prospect_allowed(r.prospect_id,r.campaign)) OR
   (r.entry_rule_id IS NOT NULL AND EXISTS(SELECT 1 FROM app_private.mhp_sequence_entry_rules rule
    JOIN app_private.mhp_prospect_signups s ON s.id=r.entry_signup_id AND s.prospect_id=r.prospect_id AND s.entry_campaign=r.campaign
     AND s.entry_event_sequence=r.entry_event_sequence AND s.entry_source='mhp.capture/v2' AND s.kind='webinar' AND s.consent_given
    JOIN app_private.mhp_sequence_entry_receipts receipt ON receipt.rule_id=rule.id AND receipt.signup_id=s.id AND receipt.event_sequence=s.entry_event_sequence
     AND receipt.prospect_id=r.prospect_id AND receipt.run_id=r.id AND receipt.disposition='enrolled'
    WHERE rule.id=r.entry_rule_id AND rule.workspace_id=r.workspace_id AND rule.sequence_version_id=r.sequence_version_id
     AND rule.sequence_sha256=r.sequence_sha256 AND rule.sequence_approval_id=r.sequence_approval_id AND rule.owner_user_id=r.owner_user_id AND rule.campaign=r.campaign
     AND receipt.sequence_version_id=r.sequence_version_id AND receipt.campaign=r.campaign AND receipt.event_at=s.created_at AND s.entry_event_sequence>rule.activation_sequence))))
$f$;
CREATE FUNCTION app_private.mhp_sequence_run_audience(p_run uuid) RETURNS TABLE(label text,link text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT a.label,a.link FROM app_private.mhp_followup_runs r CROSS JOIN LATERAL app_private.mhp_owner_email_audience(r.campaign) a
  WHERE r.id=p_run AND r.entry_rule_id IS NULL AND a.prospect_id=r.prospect_id AND app_private.mhp_sequence_run_allowed(r.id)
 UNION ALL SELECT s.label,s.link FROM app_private.mhp_followup_runs r JOIN app_private.mhp_prospect_signups s ON s.id=r.entry_signup_id
  WHERE r.id=p_run AND r.entry_rule_id IS NOT NULL AND app_private.mhp_sequence_run_allowed(r.id)
$f$;


CREATE OR REPLACE FUNCTION app_private.mhp_sequence_claim(p_limit integer,p_lease_seconds integer,p_only_emails text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE candidate record; r app_private.mhp_followup_runs%ROWTYPE; q app_private.mhp_marketing_sends%ROWTYPE;
 proof app_private.mhp_owner_email_dispatch_proofs%ROWTYPE; exact jsonb; message jsonb; email jsonb; audience record;
 claimed jsonb:='[]'; lease uuid; until_at timestamptz; expiry timestamptz;
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 25 OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 900
  OR (p_only_emails IS NOT NULL AND cardinality(p_only_emails) NOT BETWEEN 1 AND 20) THEN RAISE EXCEPTION 'Invalid sequence claim' USING ERRCODE='22023'; END IF;
 -- Terminal suppression maintenance does not consume healthy held/future/test-filter rows.
 FOR candidate IN SELECT x.id FROM app_private.mhp_followup_runs x WHERE x.entry_rule_id IS NULL AND x.state IN('active','paused','held')
  AND NOT app_private.mhp_sequence_prospect_allowed(x.prospect_id,x.campaign) ORDER BY x.id LIMIT 500 LOOP
  SELECT * INTO r FROM app_private.mhp_followup_runs WHERE id=candidate.id FOR UPDATE SKIP LOCKED;
  IF NOT FOUND OR r.state NOT IN('active','paused','held') THEN CONTINUE; END IF;
  UPDATE app_private.mhp_followup_runs SET state='stopped',reason='unsubscribed',updated_at=clock_timestamp() WHERE id=r.id;
  UPDATE app_private.mhp_marketing_sends SET cancelled_at=clock_timestamp() WHERE sequence_run_id=r.id AND sent_at IS NULL AND cancelled_at IS NULL AND failed_at IS NULL
   AND (lease_until IS NULL OR lease_until<=clock_timestamp());
 END LOOP;
 FOR candidate IN SELECT x.id,x.sequence_version_id FROM app_private.mhp_followup_runs x JOIN app_private.mhp_prospects p ON p.id=x.prospect_id
  WHERE x.entry_rule_id IS NULL AND x.state='active' AND x.due_at<=clock_timestamp() AND p.unsubscribed_at IS NULL AND p.marketing_consent
   AND(p_only_emails IS NULL OR p.email::text=ANY(p_only_emails)) ORDER BY x.due_at,x.id LIMIT 500 LOOP
  IF NOT app_private.mhp_sequence_lock_items(candidate.sequence_version_id,true) THEN CONTINUE; END IF;
  SELECT * INTO r FROM app_private.mhp_followup_runs WHERE id=candidate.id FOR UPDATE SKIP LOCKED;
  IF NOT FOUND OR r.state<>'active' OR r.due_at>clock_timestamp() THEN CONTINUE; END IF;
  IF NOT app_private.mhp_sequence_prospect_allowed(r.prospect_id,r.campaign) THEN
   UPDATE app_private.mhp_followup_runs SET state='stopped',reason='unsubscribed',updated_at=clock_timestamp() WHERE id=r.id;CONTINUE;
  END IF;
  BEGIN
   exact:=app_private.mhp_sequence_exact(r.sequence_version_id,true,true);
   IF decode(exact->>'contentSha256','hex')<>r.sequence_sha256 OR (exact->>'approvalDecisionId')::uuid<>r.sequence_approval_id
    OR NOT app_private.mhp_marketing_workspace_allowed(r.owner_user_id,r.workspace_id) THEN RAISE EXCEPTION 'Sequence authority changed' USING ERRCODE='23514'; END IF;
   message:=exact->'definition'->'steps'->r.position;
   IF message->>'kind'<>'email' THEN RAISE EXCEPTION 'Sequence channel unavailable' USING ERRCODE='23514'; END IF;
   email:=app_private.mhp_owner_email_exact((message->>'contentVersionId')::uuid,true,true,true);
  EXCEPTION WHEN check_violation OR insufficient_privilege THEN
   UPDATE app_private.mhp_followup_runs SET state='held',reason='content_changed',updated_at=clock_timestamp() WHERE id=r.id;CONTINUE;
  END;
  expiry:=r.due_at+make_interval(hours=>(exact->'definition'->>'expiryHours')::integer);
  IF expiry<=clock_timestamp() THEN UPDATE app_private.mhp_followup_runs SET state='failed',reason='delivery_expired',updated_at=clock_timestamp() WHERE id=r.id;CONTINUE; END IF;
  IF r.current_send_id IS NULL THEN
   SELECT * INTO audience FROM app_private.mhp_owner_email_audience(r.campaign) a WHERE a.prospect_id=r.prospect_id;
   IF NOT FOUND THEN UPDATE app_private.mhp_followup_runs SET state='stopped',reason='unsubscribed',updated_at=clock_timestamp() WHERE id=r.id;CONTINUE; END IF;
   INSERT INTO app_private.mhp_marketing_sends(prospect_id,template_key,campaign_key,context,due_at,expires_at,
    owner_workspace_id,owner_content_item_id,owner_content_version_id,owner_content_sha256,owner_approval_decision_id,owner_user_id,owner_audience_campaign,sequence_run_id,sequence_step)
   VALUES(r.prospect_id,'owner_followup','seq-'||r.id::text||'-'||r.position::text,jsonb_build_object('label',audience.label,'link',audience.link),r.due_at,expiry,
    r.workspace_id,(email->>'contentItemId')::uuid,(email->>'contentVersionId')::uuid,decode(email->>'contentSha256','hex'),(email->>'approvalDecisionId')::uuid,r.owner_user_id,r.campaign,r.id,r.position)
   ON CONFLICT(sequence_run_id,sequence_step) DO NOTHING;
   SELECT * INTO q FROM app_private.mhp_marketing_sends WHERE sequence_run_id=r.id AND sequence_step=r.position FOR UPDATE;
   UPDATE app_private.mhp_followup_runs SET current_send_id=q.id,updated_at=clock_timestamp() WHERE id=r.id;r.current_send_id:=q.id;
  ELSE SELECT * INTO q FROM app_private.mhp_marketing_sends WHERE id=r.current_send_id FOR UPDATE SKIP LOCKED;IF NOT FOUND THEN CONTINUE; END IF; END IF;
  IF q.sequence_run_id IS DISTINCT FROM r.id OR q.sequence_step<>r.position OR q.owner_content_version_id<>(message->>'contentVersionId')::uuid
   OR q.owner_content_sha256<>decode(message->>'contentSha256','hex') THEN RAISE EXCEPTION 'Run step changed' USING ERRCODE='23514'; END IF;
  IF q.sent_at IS NOT NULL OR q.lease_until>clock_timestamp() THEN CONTINUE; END IF;
  IF q.cancelled_at IS NOT NULL THEN UPDATE app_private.mhp_followup_runs SET state='stopped',reason='unsubscribed',updated_at=clock_timestamp() WHERE id=r.id;CONTINUE; END IF;
  IF q.failed_at IS NOT NULL OR q.attempts>=5 OR q.expires_at<=clock_timestamp() THEN
   UPDATE app_private.mhp_followup_runs SET state='failed',reason=CASE WHEN q.expires_at<=clock_timestamp() THEN 'delivery_expired' ELSE 'delivery_failed' END,updated_at=clock_timestamp() WHERE id=r.id;CONTINUE; END IF;
  IF q.owner_held_at IS NOT NULL THEN UPDATE app_private.mhp_followup_runs SET state='held',reason='content_changed',updated_at=clock_timestamp() WHERE id=r.id;CONTINUE; END IF;
  proof:=NULL;SELECT * INTO proof FROM app_private.mhp_owner_email_dispatch_proofs WHERE send_id=q.id ORDER BY checked_at DESC,id DESC LIMIT 1;
  IF proof.id IS NOT NULL AND proof.accepted IS NULL AND proof.id IS DISTINCT FROM r.unknown_ack_proof_id THEN
   UPDATE app_private.mhp_followup_runs SET state='held',reason='outcome_unknown',updated_at=clock_timestamp() WHERE id=r.id;CONTINUE; END IF;
  IF q.due_at>clock_timestamp() THEN CONTINUE; END IF;
  lease:=gen_random_uuid();until_at:=clock_timestamp()+make_interval(secs=>p_lease_seconds);
  UPDATE app_private.mhp_marketing_sends SET owner_lease_id=lease,lease_until=until_at,attempts=attempts+1 WHERE id=q.id;
  claimed:=claimed||jsonb_build_array(jsonb_build_object('id',q.id,'leaseId',lease,'leaseUntil',until_at));
  IF jsonb_array_length(claimed)>=p_limit THEN EXIT; END IF;
 END LOOP;
 RETURN claimed;
END $f$;

CREATE OR REPLACE FUNCTION app_private.mhp_sequence_claim_v2(p_limit integer,p_lease_seconds integer,p_only_emails text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE candidate record; r app_private.mhp_followup_runs%ROWTYPE; q app_private.mhp_marketing_sends%ROWTYPE;
 proof app_private.mhp_owner_email_dispatch_proofs%ROWTYPE; exact jsonb; message jsonb; email jsonb; audience record;
 claimed jsonb:='[]'; lease uuid; until_at timestamptz; expiry timestamptz;
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 25 OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 900
  OR (p_only_emails IS NOT NULL AND cardinality(p_only_emails) NOT BETWEEN 1 AND 20) THEN RAISE EXCEPTION 'Invalid sequence claim' USING ERRCODE='22023'; END IF;
 -- Terminal suppression maintenance does not consume healthy held/future/test-filter rows.
 FOR candidate IN SELECT x.id FROM app_private.mhp_followup_runs x WHERE x.state IN('active','paused','held')
  AND NOT app_private.mhp_sequence_run_allowed(x.id) ORDER BY x.id LIMIT 500 LOOP
  SELECT * INTO r FROM app_private.mhp_followup_runs WHERE id=candidate.id FOR UPDATE SKIP LOCKED;
  IF NOT FOUND OR r.state NOT IN('active','paused','held') THEN CONTINUE; END IF;
  UPDATE app_private.mhp_followup_runs SET state='stopped',reason='unsubscribed',updated_at=clock_timestamp() WHERE id=r.id;
  UPDATE app_private.mhp_marketing_sends SET cancelled_at=clock_timestamp() WHERE sequence_run_id=r.id AND sent_at IS NULL AND cancelled_at IS NULL AND failed_at IS NULL
   AND (lease_until IS NULL OR lease_until<=clock_timestamp());
 END LOOP;
 FOR candidate IN SELECT x.id,x.sequence_version_id FROM app_private.mhp_followup_runs x JOIN app_private.mhp_prospects p ON p.id=x.prospect_id
  WHERE x.state='active' AND x.due_at<=clock_timestamp() AND p.unsubscribed_at IS NULL AND p.marketing_consent
   AND(p_only_emails IS NULL OR p.email::text=ANY(p_only_emails)) ORDER BY x.due_at,x.id LIMIT 500 LOOP
  IF NOT app_private.mhp_sequence_lock_items(candidate.sequence_version_id,true) THEN CONTINUE; END IF;
  SELECT * INTO r FROM app_private.mhp_followup_runs WHERE id=candidate.id FOR UPDATE SKIP LOCKED;
  IF NOT FOUND OR r.state<>'active' OR r.due_at>clock_timestamp() THEN CONTINUE; END IF;
  IF NOT app_private.mhp_sequence_run_allowed(r.id) THEN
   UPDATE app_private.mhp_followup_runs SET state='stopped',reason='unsubscribed',updated_at=clock_timestamp() WHERE id=r.id;CONTINUE;
  END IF;
  BEGIN
   exact:=app_private.mhp_sequence_exact(r.sequence_version_id,true,true);
   IF decode(exact->>'contentSha256','hex')<>r.sequence_sha256 OR (exact->>'approvalDecisionId')::uuid<>r.sequence_approval_id
    OR NOT app_private.mhp_marketing_workspace_allowed(r.owner_user_id,r.workspace_id) THEN RAISE EXCEPTION 'Sequence authority changed' USING ERRCODE='23514'; END IF;
   message:=exact->'definition'->'steps'->r.position;
   IF message->>'kind'<>'email' THEN RAISE EXCEPTION 'Sequence channel unavailable' USING ERRCODE='23514'; END IF;
   email:=app_private.mhp_owner_email_exact((message->>'contentVersionId')::uuid,true,true,true);
  EXCEPTION WHEN check_violation OR insufficient_privilege THEN
   UPDATE app_private.mhp_followup_runs SET state='held',reason='content_changed',updated_at=clock_timestamp() WHERE id=r.id;CONTINUE;
  END;
  expiry:=r.due_at+make_interval(hours=>(exact->'definition'->>'expiryHours')::integer);
  IF expiry<=clock_timestamp() THEN UPDATE app_private.mhp_followup_runs SET state='failed',reason='delivery_expired',updated_at=clock_timestamp() WHERE id=r.id;CONTINUE; END IF;
  IF r.current_send_id IS NULL THEN
   SELECT * INTO audience FROM app_private.mhp_sequence_run_audience(r.id);
   IF NOT FOUND THEN UPDATE app_private.mhp_followup_runs SET state='stopped',reason='unsubscribed',updated_at=clock_timestamp() WHERE id=r.id;CONTINUE; END IF;
   INSERT INTO app_private.mhp_marketing_sends(prospect_id,template_key,campaign_key,context,due_at,expires_at,
    owner_workspace_id,owner_content_item_id,owner_content_version_id,owner_content_sha256,owner_approval_decision_id,owner_user_id,owner_audience_campaign,sequence_run_id,sequence_step)
   VALUES(r.prospect_id,'owner_followup','seq-'||r.id::text||'-'||r.position::text,jsonb_build_object('label',audience.label,'link',audience.link),r.due_at,expiry,
    r.workspace_id,(email->>'contentItemId')::uuid,(email->>'contentVersionId')::uuid,decode(email->>'contentSha256','hex'),(email->>'approvalDecisionId')::uuid,r.owner_user_id,r.campaign,r.id,r.position)
   ON CONFLICT(sequence_run_id,sequence_step) DO NOTHING;
   SELECT * INTO q FROM app_private.mhp_marketing_sends WHERE sequence_run_id=r.id AND sequence_step=r.position FOR UPDATE;
   UPDATE app_private.mhp_followup_runs SET current_send_id=q.id,updated_at=clock_timestamp() WHERE id=r.id;r.current_send_id:=q.id;
  ELSE SELECT * INTO q FROM app_private.mhp_marketing_sends WHERE id=r.current_send_id FOR UPDATE SKIP LOCKED;IF NOT FOUND THEN CONTINUE; END IF; END IF;
  IF q.sequence_run_id IS DISTINCT FROM r.id OR q.sequence_step<>r.position OR q.owner_content_version_id<>(message->>'contentVersionId')::uuid
   OR q.owner_content_sha256<>decode(message->>'contentSha256','hex') THEN RAISE EXCEPTION 'Run step changed' USING ERRCODE='23514'; END IF;
  IF q.sent_at IS NOT NULL OR q.lease_until>clock_timestamp() THEN CONTINUE; END IF;
  IF q.cancelled_at IS NOT NULL THEN UPDATE app_private.mhp_followup_runs SET state='stopped',reason='unsubscribed',updated_at=clock_timestamp() WHERE id=r.id;CONTINUE; END IF;
  IF q.failed_at IS NOT NULL OR q.attempts>=5 OR q.expires_at<=clock_timestamp() THEN
   UPDATE app_private.mhp_followup_runs SET state='failed',reason=CASE WHEN q.expires_at<=clock_timestamp() THEN 'delivery_expired' ELSE 'delivery_failed' END,updated_at=clock_timestamp() WHERE id=r.id;CONTINUE; END IF;
  IF q.owner_held_at IS NOT NULL THEN UPDATE app_private.mhp_followup_runs SET state='held',reason='content_changed',updated_at=clock_timestamp() WHERE id=r.id;CONTINUE; END IF;
  proof:=NULL;SELECT * INTO proof FROM app_private.mhp_owner_email_dispatch_proofs WHERE send_id=q.id ORDER BY checked_at DESC,id DESC LIMIT 1;
  IF proof.id IS NOT NULL AND proof.accepted IS NULL AND proof.id IS DISTINCT FROM r.unknown_ack_proof_id THEN
   UPDATE app_private.mhp_followup_runs SET state='held',reason='outcome_unknown',updated_at=clock_timestamp() WHERE id=r.id;CONTINUE; END IF;
  IF q.due_at>clock_timestamp() THEN CONTINUE; END IF;
  lease:=gen_random_uuid();until_at:=clock_timestamp()+make_interval(secs=>p_lease_seconds);
  UPDATE app_private.mhp_marketing_sends SET owner_lease_id=lease,lease_until=until_at,attempts=attempts+1 WHERE id=q.id;
  claimed:=claimed||jsonb_build_array(jsonb_build_object('id',q.id,'leaseId',lease,'leaseUntil',until_at));
  IF jsonb_array_length(claimed)>=p_limit THEN EXIT; END IF;
 END LOOP;
 RETURN claimed;
END $f$;

CREATE OR REPLACE FUNCTION app_private.mhp_sequence_prepare_0127(p_send uuid,p_lease uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE run_id uuid; version_id uuid; r app_private.mhp_followup_runs%ROWTYPE; q app_private.mhp_marketing_sends%ROWTYPE; exact jsonb;
BEGIN
 SELECT s.sequence_run_id,linked.sequence_version_id INTO run_id,version_id FROM app_private.mhp_marketing_sends s JOIN app_private.mhp_followup_runs linked ON linked.id=s.sequence_run_id WHERE s.id=p_send;
 IF run_id IS NULL THEN RETURN NULL; END IF;
 PERFORM app_private.mhp_sequence_lock_items(version_id,false);
 SELECT * INTO r FROM app_private.mhp_followup_runs WHERE id=run_id FOR UPDATE;
 SELECT * INTO q FROM app_private.mhp_marketing_sends WHERE id=p_send FOR UPDATE;
 IF r.state<>'active' OR r.current_send_id IS DISTINCT FROM p_send OR r.position IS DISTINCT FROM q.sequence_step
  OR q.owner_lease_id IS DISTINCT FROM p_lease OR q.due_at>clock_timestamp() OR NOT app_private.mhp_sequence_run_allowed(r.id) THEN RETURN NULL; END IF;
 BEGIN
  exact:=app_private.mhp_sequence_exact(r.sequence_version_id,true,true);
  IF decode(exact->>'contentSha256','hex')<>r.sequence_sha256 OR (exact->>'approvalDecisionId')::uuid<>r.sequence_approval_id
   OR NOT app_private.mhp_marketing_workspace_allowed(r.owner_user_id,r.workspace_id) THEN RETURN NULL; END IF;
 EXCEPTION WHEN check_violation OR insufficient_privilege THEN RETURN NULL; END;
 RETURN app_private.mhp_prepare_owner_marketing_send_0126(p_send,p_lease);
END $f$;


CREATE OR REPLACE FUNCTION app_private.mhp_sequence_prepare(p_send uuid,p_lease uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 IF EXISTS(SELECT 1 FROM app_private.mhp_marketing_sends q JOIN app_private.mhp_followup_runs r ON r.id=q.sequence_run_id WHERE q.id=p_send AND r.entry_rule_id IS NOT NULL) THEN RETURN NULL; END IF;
 RETURN app_private.mhp_sequence_prepare_0127(p_send,p_lease);
END $f$;
CREATE FUNCTION app_private.mhp_sequence_prepare_v2(p_send uuid,p_lease uuid) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT app_private.mhp_sequence_prepare_0127(p_send,p_lease)
$f$;


CREATE OR REPLACE FUNCTION app_private.mhp_prepare_owner_marketing_send_0126(p_send uuid,p_lease uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE s app_private.mhp_marketing_sends%ROWTYPE; p app_private.mhp_prospects%ROWTYPE; item uuid; exact jsonb; proof uuid; checked timestamptz;
BEGIN
 IF p_send IS NULL OR p_lease IS NULL THEN RAISE EXCEPTION 'Invalid owner lease' USING ERRCODE='22023'; END IF;
 SELECT q.owner_content_item_id INTO item FROM app_private.mhp_marketing_sends q WHERE q.id=p_send AND q.owner_lease_id=p_lease;
 IF item IS NULL THEN RETURN NULL; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('company-content:2789228d-55a6-4688-b1e8-2f70abca990b:'||item::text,7200021));
 SELECT * INTO s FROM app_private.mhp_marketing_sends q WHERE q.id=p_send FOR UPDATE;
 IF s.owner_lease_id IS DISTINCT FROM p_lease OR s.lease_until<=clock_timestamp() OR s.lease_until IS NULL
  OR s.sent_at IS NOT NULL OR s.cancelled_at IS NOT NULL OR s.failed_at IS NOT NULL OR s.owner_held_at IS NOT NULL OR s.expires_at<=clock_timestamp()
  OR EXISTS(SELECT 1 FROM app_private.mhp_owner_email_dispatch_proofs old WHERE old.send_id=p_send AND old.lease_id=p_lease)
 THEN RETURN NULL; END IF;
 SELECT * INTO p FROM app_private.mhp_prospects x WHERE x.id=s.prospect_id;
 IF p.unsubscribed_at IS NOT NULL OR NOT p.marketing_consent
  OR NOT (CASE WHEN s.sequence_run_id IS NOT NULL THEN app_private.mhp_sequence_run_allowed(s.sequence_run_id) ELSE EXISTS(SELECT 1 FROM app_private.mhp_owner_email_audience(s.owner_audience_campaign) a WHERE a.prospect_id=s.prospect_id) END)
 THEN RETURN NULL; END IF;
 BEGIN
  exact:=app_private.mhp_owner_email_exact(s.owner_content_version_id,true,true,true);
  IF (exact->>'approvalDecisionId')::uuid<>s.owner_approval_decision_id OR decode(exact->>'contentSha256','hex')<>s.owner_content_sha256
   OR exact->>'audienceCampaign'<>s.owner_audience_campaign
   OR NOT app_private.mhp_marketing_workspace_allowed(s.owner_user_id,s.owner_workspace_id)
  THEN RETURN NULL; END IF;
 EXCEPTION WHEN check_violation OR insufficient_privilege THEN RETURN NULL; END;
 checked:=clock_timestamp();
 INSERT INTO app_private.mhp_owner_email_dispatch_proofs(workspace_id,send_id,lease_id,content_item_id,content_version_id,
  content_sha256,blob_sha256,brand_sha256,manifest_sha256,approval_decision_id,observed_role,observed_session_user,checked_at,expires_at)
 VALUES(s.owner_workspace_id,s.id,p_lease,s.owner_content_item_id,s.owner_content_version_id,s.owner_content_sha256,
  decode(exact->>'blobSha256','hex'),decode(exact->'brand'->>'sha256','hex'),decode(exact->>'manifestSha256','hex'),
  s.owner_approval_decision_id,'r72_identity_command',session_user,checked,least(s.lease_until,checked+interval '15 minutes')) RETURNING id INTO proof;
 RETURN jsonb_build_object('id',s.id,'leaseId',p_lease,'leaseUntil',s.lease_until,'proofId',proof,'prospectId',p.id,
  'email',p.email::text,'firstName',p.first_name,'context',s.context,'campaign',s.owner_audience_campaign,'exact',exact);
END $f$;

CREATE OR REPLACE FUNCTION app_private.mhp_sequence_command(p_session bytea,p_action text,p_command uuid,p_version uuid,p_campaign text,p_run uuid,p_ack_proof uuid,p_request text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; item uuid; exact jsonb; next jsonb; receipt jsonb; payload jsonb; r app_private.mhp_followup_runs%ROWTYPE;
 q app_private.mhp_marketing_sends%ROWTYPE; proof app_private.mhp_owner_email_dispatch_proofs%ROWTYPE;
 changed integer:=0; remaining integer:=0; blocked integer:=0; flying integer:=0; outcome jsonb;
BEGIN
 actor:=app_private.mhp_owner_email_authorize(p_session);
 IF NOT app_private.lock_active_portal_session(p_session,actor,'2789228d-55a6-4688-b1e8-2f70abca990b') THEN RAISE EXCEPTION 'Owner session changed' USING ERRCODE='42501'; END IF;
 IF p_action IS NULL OR p_action NOT IN('enrol','pause','resume','cancel','stop') OR p_version IS NULL OR p_campaign IS NULL OR p_campaign!~'^[a-z0-9_-]{1,60}$'
  OR (p_action='enrol' AND p_run IS NOT NULL) OR (p_ack_proof IS NOT NULL AND (p_action<>'resume' OR p_run IS NULL))
 THEN RAISE EXCEPTION 'Invalid sequence action' USING ERRCODE='22023'; END IF;
 SELECT content_item_id INTO item FROM app.company_content_versions WHERE workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND id=p_version AND source_system='mhp.followup-sequence';
 IF item IS NULL THEN RAISE EXCEPTION 'Sequence unavailable' USING ERRCODE='23514'; END IF;
 payload:=jsonb_build_object('version',p_version,'campaign',p_campaign,'run',p_run,'ackProof',p_ack_proof);
 IF p_ack_proof IS NOT NULL THEN
  SELECT * INTO proof FROM app_private.mhp_owner_email_dispatch_proofs WHERE id=p_ack_proof;
  payload:=payload||jsonb_build_object('ackSend',proof.send_id,'ackLease',proof.lease_id,'ackStep',(SELECT sequence_step FROM app_private.mhp_marketing_sends WHERE id=proof.send_id));
 END IF;
 receipt:=app_private.mhp_sequence_action_receipt(actor,p_action,p_command,payload,p_request);
 IF (receipt->>'replayed')::boolean THEN RETURN (receipt->'result')||jsonb_build_object('replayed',true); END IF;
 IF p_action='enrol' THEN
  PERFORM app_private.mhp_sequence_lock_items(p_version,false);
  exact:=app_private.mhp_sequence_exact(p_version,true,true);
  IF exact->>'campaign'<>p_campaign THEN RAISE EXCEPTION 'Sequence audience changed' USING ERRCODE='23514'; END IF;
  next:=app_private.mhp_sequence_next(exact->'definition',-1,clock_timestamp());
  INSERT INTO app_private.mhp_followup_runs(workspace_id,sequence_item_id,sequence_version_id,sequence_sha256,sequence_approval_id,owner_user_id,prospect_id,campaign,enrolment_command_id,state,position,due_at)
  SELECT '2789228d-55a6-4688-b1e8-2f70abca990b',item,p_version,decode(exact->>'contentSha256','hex'),(exact->>'approvalDecisionId')::uuid,actor,a.prospect_id,p_campaign,p_command,'active',(next->>'position')::integer,(next->>'dueAt')::timestamptz
  FROM app_private.mhp_owner_email_audience(p_campaign) a WHERE NOT EXISTS(SELECT 1 FROM app_private.mhp_followup_runs old WHERE old.sequence_version_id=p_version AND old.prospect_id=a.prospect_id AND old.campaign=p_campaign)
   AND NOT EXISTS(SELECT 1 FROM app_private.mhp_followup_runs old WHERE old.sequence_item_id=item AND old.prospect_id=a.prospect_id AND old.campaign=p_campaign AND old.state IN('active','paused','held'))
  ORDER BY a.prospect_id LIMIT 500 ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS changed=ROW_COUNT;
  SELECT count(*) INTO remaining FROM app_private.mhp_owner_email_audience(p_campaign) a
   WHERE NOT EXISTS(SELECT 1 FROM app_private.mhp_followup_runs old WHERE old.sequence_version_id=p_version AND old.prospect_id=a.prospect_id AND old.campaign=p_campaign)
    AND NOT EXISTS(SELECT 1 FROM app_private.mhp_followup_runs old WHERE old.sequence_item_id=item AND old.prospect_id=a.prospect_id AND old.campaign=p_campaign AND old.state IN('active','paused','held'));
  SELECT count(*) INTO blocked FROM app_private.mhp_followup_runs old WHERE old.sequence_item_id=item AND old.sequence_version_id<>p_version AND old.campaign=p_campaign AND old.state IN('active','paused','held');
 ELSE
  FOR r IN SELECT * FROM app_private.mhp_followup_runs WHERE sequence_item_id=item AND campaign=p_campaign AND (p_run IS NULL OR id=p_run)
   AND CASE p_action WHEN 'pause' THEN state='active' WHEN 'resume' THEN state IN('paused','held') ELSE state IN('active','paused','held') END ORDER BY id LIMIT 500 LOOP
   PERFORM app_private.mhp_sequence_lock_items(r.sequence_version_id,false);
   SELECT * INTO r FROM app_private.mhp_followup_runs WHERE id=r.id FOR UPDATE;
   IF r.state NOT IN('active','paused','held') THEN CONTINUE; END IF;
   IF r.current_send_id IS NOT NULL THEN SELECT * INTO q FROM app_private.mhp_marketing_sends WHERE id=r.current_send_id FOR UPDATE; ELSE q:=NULL; END IF;
   IF q.lease_until>clock_timestamp() AND q.sent_at IS NULL THEN flying:=flying+1; END IF;
   IF p_action='resume' THEN
    BEGIN exact:=app_private.mhp_sequence_exact(r.sequence_version_id,true,true);
    EXCEPTION WHEN check_violation OR insufficient_privilege THEN blocked:=blocked+1;CONTINUE; END;
    IF NOT app_private.mhp_sequence_run_allowed(r.id) OR (q.expires_at IS NOT NULL AND q.expires_at<=clock_timestamp())
     OR (q.owner_held_at IS NOT NULL AND q.owner_hold_reason IN('newer_draft','approval_or_brand_changed')) THEN blocked:=blocked+1;CONTINUE; END IF;
    proof:=NULL;
    SELECT * INTO proof FROM app_private.mhp_owner_email_dispatch_proofs WHERE send_id=r.current_send_id ORDER BY checked_at DESC,id DESC LIMIT 1;
    IF proof.id IS NOT NULL AND proof.accepted IS NULL AND proof.id IS DISTINCT FROM r.unknown_ack_proof_id THEN
     IF p_ack_proof IS DISTINCT FROM proof.id OR q.lease_until>clock_timestamp() THEN blocked:=blocked+1;CONTINUE; END IF;
    ELSIF p_ack_proof IS NOT NULL THEN RAISE EXCEPTION 'Unknown attempt changed; refresh before retrying' USING ERRCODE='23514'; END IF;
    UPDATE app_private.mhp_followup_runs SET state='active',reason=NULL,unknown_ack_proof_id=coalesce(p_ack_proof,unknown_ack_proof_id),updated_at=clock_timestamp() WHERE id=r.id;
    UPDATE app_private.mhp_marketing_sends SET owner_held_at=NULL,owner_hold_reason=NULL WHERE sequence_run_id=r.id AND sent_at IS NULL AND cancelled_at IS NULL AND failed_at IS NULL
     AND owner_hold_reason='recovery' AND (lease_until IS NULL OR lease_until<=clock_timestamp());
   ELSE
    UPDATE app_private.mhp_followup_runs SET state=CASE p_action WHEN 'pause' THEN 'paused' WHEN 'stop' THEN 'stopped' ELSE 'cancelled' END,
     reason=CASE WHEN p_action='stop' THEN 'manual' ELSE reason END,updated_at=clock_timestamp() WHERE id=r.id;
    IF p_action IN('cancel','stop') THEN UPDATE app_private.mhp_marketing_sends SET cancelled_at=clock_timestamp() WHERE sequence_run_id=r.id AND sent_at IS NULL AND cancelled_at IS NULL AND failed_at IS NULL
      AND (lease_until IS NULL OR lease_until<=clock_timestamp()); END IF;
   END IF;
   changed:=changed+1;
  END LOOP;
  SELECT count(*) INTO remaining FROM app_private.mhp_followup_runs WHERE sequence_item_id=item AND campaign=p_campaign AND (p_run IS NULL OR id=p_run)
   AND CASE p_action WHEN 'pause' THEN state='active' WHEN 'resume' THEN state IN('paused','held') ELSE state IN('active','paused','held') END;
 END IF;
 outcome:=jsonb_build_object('action',p_action,'contentItemId',item,'contentVersionId',p_version,'changed',changed,'remaining',remaining,'blocked',blocked,'inFlight',flying,'replayed',false);
 UPDATE app.command_receipts SET result=outcome,status='succeeded',response_status=200,completed_at=clock_timestamp() WHERE id=(receipt->>'receiptId')::uuid;
 RETURN outcome;
END $f$;

CREATE OR REPLACE FUNCTION app_private.mhp_sequence_new_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE r app_private.mhp_followup_runs%ROWTYPE;
BEGIN
 IF NEW.workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND NEW.source_system='mhp.followup-sequence' THEN
  PERFORM app_private.mhp_sequence_exact(NEW.id,false,true);
  UPDATE app_private.mhp_sequence_entry_rules SET held_at=coalesce(held_at,clock_timestamp()),held_reason=coalesce(held_reason,'newer_sequence') WHERE sequence_item_id=NEW.content_item_id AND sequence_version_id<>NEW.id AND disabled_at IS NULL;
  FOR r IN SELECT * FROM app_private.mhp_followup_runs WHERE sequence_item_id=NEW.content_item_id AND sequence_version_id<>NEW.id
   AND state IN('active','paused','held') ORDER BY id FOR UPDATE LOOP
   UPDATE app_private.mhp_followup_runs SET state='held',reason='newer_sequence',updated_at=clock_timestamp() WHERE id=r.id;
   UPDATE app_private.mhp_marketing_sends SET owner_held_at=coalesce(owner_held_at,clock_timestamp()),owner_hold_reason='newer_draft'
    WHERE sequence_run_id=r.id AND sent_at IS NULL AND cancelled_at IS NULL AND failed_at IS NULL AND (lease_until IS NULL OR lease_until<=clock_timestamp());
  END LOOP;
 END IF;
 RETURN NEW;
END $f$;

-- Reviewed source fragment composed verbatim into0128; no standalone execution.
CREATE FUNCTION app_private.mhp_sequence_entry_command(p_session bytea,p_action text,p_command uuid,p_version uuid,p_campaign text,p_rule uuid,p_expires timestamptz,p_request text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; item uuid; exact jsonb; payload jsonb; hashed bytea; old_receipt app.command_receipts%ROWTYPE;
 rule app_private.mhp_sequence_entry_rules%ROWTYPE; result jsonb; watermark bigint; receipt_id uuid;
BEGIN
 actor:=app_private.mhp_owner_email_authorize(p_session);
 IF NOT app_private.lock_active_portal_session(p_session,actor,'2789228d-55a6-4688-b1e8-2f70abca990b') THEN RAISE EXCEPTION 'Owner session changed' USING ERRCODE='42501'; END IF;
 IF p_action IS NULL OR p_action NOT IN('activate','off') OR p_command IS NULL OR p_version IS NULL
  OR p_campaign IS NULL OR p_campaign!~'^[a-z0-9_-]{1,60}$' OR p_request IS NULL OR p_request!~'^[!-~]{1,128}$'
  OR (p_action='activate' AND (p_rule IS NOT NULL OR p_expires IS NULL OR NOT isfinite(p_expires)))
  OR (p_action='off' AND (p_rule IS NULL OR p_expires IS NOT NULL))
 THEN RAISE EXCEPTION 'Invalid entry command' USING ERRCODE='22023'; END IF;
 SELECT content_item_id INTO item FROM app.company_content_versions WHERE id=p_version AND workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND source_system='mhp.followup-sequence';
 IF item IS NULL THEN RAISE EXCEPTION 'Sequence unavailable' USING ERRCODE='23514'; END IF;
 payload:=jsonb_build_object('version',p_version,'campaign',p_campaign,'rule',p_rule,'expires',p_expires);
 hashed:=public.digest(payload::text,'sha256');
 PERFORM pg_advisory_xact_lock(hashtextextended('mhp-sequence-entry-command:'||actor::text||':'||p_action||':'||p_command::text,7200128));
 SELECT * INTO old_receipt FROM app.command_receipts WHERE workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND actor_user_id=actor
  AND command_name='mhp.sequence.entry.'||p_action AND idempotency_key=p_command::text;
 IF FOUND THEN
  IF old_receipt.payload_hash IS DISTINCT FROM hashed THEN RAISE EXCEPTION 'Entry command input changed' USING ERRCODE='23514'; END IF;
  RETURN old_receipt.result||jsonb_build_object('replayed',true);
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('mhp-capture-campaign:'||p_campaign,7200128));
 PERFORM app_private.mhp_sequence_lock_items(p_version,false);
 IF p_action='activate' THEN
  IF p_expires<=clock_timestamp() THEN RAISE EXCEPTION 'Entry expiry must be in the future' USING ERRCODE='22023'; END IF;
  exact:=app_private.mhp_sequence_exact(p_version,true,true);
  IF exact->>'campaign' IS DISTINCT FROM p_campaign OR exact->'definition'->>'schema' IS DISTINCT FROM 'growthhq.followup-sequence/v2'
   OR exact->'definition'->'entry' IS DISTINCT FROM '{"mode":"webinar_signup","source":"mhp.capture/v2"}'::jsonb
  THEN RAISE EXCEPTION 'Published future entry intent required' USING ERRCODE='23514'; END IF;
  UPDATE app_private.mhp_sequence_entry_rules SET disabled_at=clock_timestamp() WHERE sequence_item_id=item AND campaign=p_campaign AND disabled_at IS NULL;
  -- VOLATILE fresh statement snapshot, after the commit-held campaign lock.
  SELECT coalesce(max(entry_event_sequence),0) INTO watermark FROM app_private.mhp_prospect_signups WHERE entry_campaign=p_campaign;
  INSERT INTO app_private.mhp_sequence_entry_rules(workspace_id,sequence_item_id,sequence_version_id,sequence_sha256,sequence_approval_id,owner_user_id,campaign,expires_at,activation_sequence,cursor_sequence)
  VALUES('2789228d-55a6-4688-b1e8-2f70abca990b',item,p_version,decode(exact->>'contentSha256','hex'),(exact->>'approvalDecisionId')::uuid,actor,p_campaign,p_expires,watermark,watermark) RETURNING * INTO rule;
 ELSE
  SELECT * INTO rule FROM app_private.mhp_sequence_entry_rules WHERE id=p_rule AND sequence_item_id=item AND sequence_version_id=p_version AND campaign=p_campaign FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Entry rule changed' USING ERRCODE='23514'; END IF;
  UPDATE app_private.mhp_sequence_entry_rules SET disabled_at=coalesce(disabled_at,clock_timestamp()) WHERE id=rule.id RETURNING * INTO rule;
 END IF;
 result:=jsonb_build_object('action',p_action,'contentItemId',item,'contentVersionId',p_version,'ruleId',rule.id,
  'state',CASE p_action WHEN 'activate' THEN 'active' ELSE 'off' END,'expiresAt',rule.expires_at,'watermark',rule.activation_sequence::text,'replayed',false);
 INSERT INTO app.command_receipts(workspace_id,actor_user_id,command_name,idempotency_key,request_id,payload_hash,status,result,response_status,completed_at)
 VALUES('2789228d-55a6-4688-b1e8-2f70abca990b',actor,'mhp.sequence.entry.'||p_action,p_command::text,p_request,hashed,'succeeded',result,200,clock_timestamp());
 RETURN result;
END $f$;

CREATE FUNCTION app_private.mhp_sequence_enrol_captures(p_limit integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE candidate record; rule app_private.mhp_sequence_entry_rules%ROWTYPE; signup app_private.mhp_prospect_signups%ROWTYPE;
 prospect app_private.mhp_prospects%ROWTYPE; exact jsonb; next jsonb; disposition text; why text; new_run uuid;
 processed integer:=0; enrolled integer:=0; already integer:=0; blocked integer:=0; skipped integer:=0; held integer:=0;
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Invalid entry sweep size' USING ERRCODE='22023'; END IF;
 FOR candidate IN SELECT id,sequence_version_id,campaign FROM app_private.mhp_sequence_entry_rules
  WHERE disabled_at IS NULL AND held_at IS NULL AND expires_at>clock_timestamp() ORDER BY last_swept_at NULLS FIRST,id LIMIT 5 LOOP
  IF NOT pg_try_advisory_xact_lock(hashtextextended('mhp-capture-campaign:'||candidate.campaign,7200128)) THEN CONTINUE; END IF;
  IF NOT app_private.mhp_sequence_lock_items(candidate.sequence_version_id,true) THEN CONTINUE; END IF;
  SELECT * INTO rule FROM app_private.mhp_sequence_entry_rules WHERE id=candidate.id FOR UPDATE SKIP LOCKED;
  IF NOT FOUND OR rule.disabled_at IS NOT NULL OR rule.held_at IS NOT NULL OR rule.expires_at<=clock_timestamp() THEN CONTINUE; END IF;
  BEGIN
   exact:=app_private.mhp_sequence_exact(rule.sequence_version_id,true,true);
   IF decode(exact->>'contentSha256','hex') IS DISTINCT FROM rule.sequence_sha256 OR (exact->>'approvalDecisionId')::uuid IS DISTINCT FROM rule.sequence_approval_id
    OR exact->>'campaign' IS DISTINCT FROM rule.campaign OR exact->'definition'->'entry' IS DISTINCT FROM '{"mode":"webinar_signup","source":"mhp.capture/v2"}'::jsonb
    OR NOT app_private.mhp_marketing_workspace_allowed(rule.owner_user_id,rule.workspace_id)
   THEN RAISE EXCEPTION 'Entry authority changed' USING ERRCODE='23514'; END IF;
  EXCEPTION WHEN check_violation OR insufficient_privilege THEN
   UPDATE app_private.mhp_sequence_entry_rules SET held_at=clock_timestamp(),held_reason='content_changed',last_swept_at=clock_timestamp() WHERE id=rule.id;
   held:=held+1;CONTINUE;
  END;
  next:=app_private.mhp_sequence_next(exact->'definition',-1,clock_timestamp());
  FOR signup IN SELECT * FROM app_private.mhp_prospect_signups s WHERE s.entry_campaign=rule.campaign AND s.entry_event_sequence>rule.cursor_sequence
   AND s.entry_event_sequence>rule.activation_sequence ORDER BY s.entry_event_sequence LIMIT (p_limit-processed) LOOP
   -- All genuine producer transactions for this campaign committed before this lock.
   -- The exact event is immutable; a prospect's current opt-out is rechecked under its row lock.
   SELECT * INTO prospect FROM app_private.mhp_prospects WHERE id=signup.prospect_id FOR UPDATE SKIP LOCKED;
   IF NOT FOUND THEN EXIT; END IF;
   new_run:=NULL;
   IF signup.entry_source IS DISTINCT FROM 'mhp.capture/v2' OR signup.kind<>'webinar' OR NOT signup.consent_given THEN disposition:='skipped';why:='no_consent';skipped:=skipped+1;
   ELSIF prospect.unsubscribed_at IS NOT NULL OR NOT prospect.marketing_consent THEN disposition:='blocked';why:='current_permission';blocked:=blocked+1;
   ELSIF EXISTS(SELECT 1 FROM app_private.mhp_followup_runs r WHERE r.sequence_version_id=rule.sequence_version_id AND r.prospect_id=signup.prospect_id AND r.campaign=rule.campaign)
    THEN disposition:='already_enrolled';why:='version_already_enrolled';already:=already+1;
   ELSIF EXISTS(SELECT 1 FROM app_private.mhp_followup_runs r WHERE r.sequence_item_id=rule.sequence_item_id AND r.prospect_id=signup.prospect_id AND r.campaign=rule.campaign AND r.state IN('active','paused','held'))
    THEN disposition:='blocked';why:='open_previous_version';blocked:=blocked+1;
   ELSE
    INSERT INTO app_private.mhp_followup_runs(workspace_id,sequence_item_id,sequence_version_id,sequence_sha256,sequence_approval_id,owner_user_id,prospect_id,campaign,enrolment_command_id,state,position,due_at,entry_rule_id,entry_signup_id,entry_event_sequence)
    VALUES(rule.workspace_id,rule.sequence_item_id,rule.sequence_version_id,rule.sequence_sha256,rule.sequence_approval_id,rule.owner_user_id,signup.prospect_id,rule.campaign,rule.id,'active',(next->>'position')::integer,(next->>'dueAt')::timestamptz,rule.id,signup.id,signup.entry_event_sequence)
    ON CONFLICT DO NOTHING RETURNING id INTO new_run;
    IF new_run IS NULL THEN disposition:='already_enrolled';why:='version_already_enrolled';already:=already+1;
    ELSE disposition:='enrolled';why:='accepted';enrolled:=enrolled+1; END IF;
   END IF;
   INSERT INTO app_private.mhp_sequence_entry_receipts(workspace_id,rule_id,signup_id,event_sequence,event_at,prospect_id,campaign,sequence_version_id,disposition,reason,run_id)
   VALUES(rule.workspace_id,rule.id,signup.id,signup.entry_event_sequence,signup.created_at,signup.prospect_id,rule.campaign,rule.sequence_version_id,disposition,why,new_run);
   UPDATE app_private.mhp_sequence_entry_rules SET cursor_sequence=signup.entry_event_sequence,cursor_signup_id=signup.id,cursor_at=signup.created_at WHERE id=rule.id;
   processed:=processed+1;
  END LOOP;
  UPDATE app_private.mhp_sequence_entry_rules SET last_swept_at=clock_timestamp() WHERE id=rule.id;
  IF processed>=p_limit THEN EXIT; END IF;
 END LOOP;
 RETURN jsonb_build_object('processed',processed,'enrolled',enrolled,'alreadyEnrolled',already,'blocked',blocked,'skipped',skipped,'heldRules',held);
END $f$;

ALTER FUNCTION app_private.mhp_sequence_snapshot(bytea,text) RENAME TO mhp_sequence_snapshot_0127;
CREATE FUNCTION app_private.mhp_sequence_snapshot(p_session bytea,p_campaign text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE result jsonb; rules jsonb; runs jsonb;
BEGIN
 result:=app_private.mhp_sequence_snapshot_0127(p_session,p_campaign);
 SELECT coalesce(jsonb_agg(to_jsonb(q)),'[]') INTO rules FROM(
  SELECT r.id,r.sequence_item_id AS "contentItemId",r.sequence_version_id AS "contentVersionId",
   CASE WHEN r.disabled_at IS NOT NULL THEN 'off' WHEN r.held_at IS NOT NULL THEN 'held' WHEN r.expires_at<=statement_timestamp() THEN 'expired' ELSE 'active' END AS state,
   r.activated_at AS "activatedAt",r.expires_at AS "expiresAt",r.held_reason AS "heldReason",r.cursor_sequence::text AS "cursorSequence",
   r.cursor_signup_id AS "cursorSignupId",r.cursor_at AS "cursorAt",r.last_swept_at AS "lastSweptAt",
   (SELECT count(*) FROM app_private.mhp_sequence_entry_receipts x WHERE x.rule_id=r.id) AS processed,
   (SELECT count(*) FROM app_private.mhp_sequence_entry_receipts x WHERE x.rule_id=r.id AND x.disposition='enrolled') AS enrolled,
   (SELECT count(*) FROM app_private.mhp_sequence_entry_receipts x WHERE x.rule_id=r.id AND x.disposition IN('skipped','already_enrolled')) AS skipped,
   (SELECT count(*) FROM app_private.mhp_sequence_entry_receipts x WHERE x.rule_id=r.id AND x.disposition='blocked') AS blocked
  FROM app_private.mhp_sequence_entry_rules r WHERE r.campaign=p_campaign ORDER BY r.activated_at DESC,r.id DESC LIMIT 50) q;
 SELECT coalesce(jsonb_agg(x.value||jsonb_build_object('definitionSchema',v.content_body::jsonb->>'schema') ORDER BY x.n),'[]') INTO runs
  FROM jsonb_array_elements(result->'runs') WITH ORDINALITY x(value,n) JOIN app.company_content_versions v ON v.id=(x.value->>'contentVersionId')::uuid;
 RETURN result||jsonb_build_object('entryRules',rules,'runs',runs);
END $f$;
GRANT EXECUTE ON FUNCTION app_private.mhp_sequence_snapshot(bytea,text) TO r72_web;
REVOKE EXECUTE ON FUNCTION app_private.mhp_sequence_snapshot_0127(bytea,text) FROM r72_web;

CREATE FUNCTION app_private.mhp_hold_sequence_entry() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE r app_private.mhp_followup_runs%ROWTYPE; held integer; flying integer:=0;
BEGIN
 UPDATE app_private.mhp_sequence_entry_rules SET held_at=coalesce(held_at,clock_timestamp()),held_reason=coalesce(held_reason,'recovery') WHERE disabled_at IS NULL;
 GET DIAGNOSTICS held=ROW_COUNT;
 FOR r IN SELECT * FROM app_private.mhp_followup_runs WHERE entry_rule_id IS NOT NULL AND state IN('active','paused','held') ORDER BY id FOR UPDATE LOOP
  UPDATE app_private.mhp_followup_runs SET state='held',reason=CASE WHEN reason IN('outcome_unknown','newer_sequence','content_changed') THEN reason ELSE 'recovery' END,updated_at=clock_timestamp() WHERE id=r.id;
  SELECT flying+count(*) INTO flying FROM app_private.mhp_marketing_sends WHERE sequence_run_id=r.id AND sent_at IS NULL AND lease_until>clock_timestamp();
  UPDATE app_private.mhp_marketing_sends SET owner_held_at=coalesce(owner_held_at,clock_timestamp()),owner_hold_reason=coalesce(owner_hold_reason,'recovery')
   WHERE sequence_run_id=r.id AND sent_at IS NULL AND cancelled_at IS NULL AND failed_at IS NULL AND (lease_until IS NULL OR lease_until<=clock_timestamp());
 END LOOP;
 RETURN jsonb_build_object('heldRules',held,'inFlight',flying,'resumed',0);
END $f$;



REVOKE ALL ON FUNCTION app_private.mhp_capture_signup_v2(text,text,text,boolean,text,text,text,text,text,bytea,jsonb,text),
 app_private.mhp_sequence_entry_immutable(),app_private.mhp_sequence_run_allowed(uuid),app_private.mhp_sequence_run_audience(uuid),
 app_private.mhp_sequence_claim_v2(integer,integer,text[]),app_private.mhp_sequence_prepare_0127(uuid,uuid),app_private.mhp_sequence_prepare_v2(uuid,uuid),
 app_private.mhp_sequence_entry_command(bytea,text,uuid,uuid,text,uuid,timestamptz,text),app_private.mhp_sequence_enrol_captures(integer),
 app_private.mhp_hold_sequence_entry(),app_private.mhp_sequence_snapshot_0127(bytea,text),app_private.mhp_sequence_snapshot(bytea,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.mhp_sequence_prepare_0127(uuid,uuid),app_private.mhp_prepare_owner_marketing_send_0126(uuid,uuid) FROM r72_identity_command;
GRANT EXECUTE ON FUNCTION app_private.mhp_capture_signup_v2(text,text,text,boolean,text,text,text,text,text,bytea,jsonb,text),
 app_private.mhp_sequence_claim_v2(integer,integer,text[]),app_private.mhp_sequence_prepare_v2(uuid,uuid),
 app_private.mhp_sequence_entry_command(bytea,text,uuid,uuid,text,uuid,timestamptz,text),app_private.mhp_sequence_enrol_captures(integer),app_private.mhp_hold_sequence_entry() TO r72_identity_command;
RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_mhp_prospect_definer;
RESET ROLE;
