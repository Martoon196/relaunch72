-- GHQ-FOLLOWUP-006A: orchestration references only; copy remains in company_content_versions.
-- Exact design ratified by Astra before SQL. No enrolments or provider effects from migration.
SET LOCAL ROLE r72_owner;
GRANT CREATE ON SCHEMA app_private TO r72_mhp_prospect_definer;
CREATE TABLE app_private.mhp_followup_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL CHECK(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b'),
 sequence_item_id uuid NOT NULL,sequence_version_id uuid NOT NULL,
 sequence_sha256 bytea NOT NULL CHECK(octet_length(sequence_sha256)=32),
 sequence_approval_id uuid NOT NULL,owner_user_id uuid NOT NULL,
 prospect_id uuid NOT NULL REFERENCES app_private.mhp_prospects(id) ON DELETE RESTRICT,
 campaign text NOT NULL CHECK(campaign~'^[a-z0-9_-]{1,60}$'),enrolment_command_id uuid NOT NULL,
 state text NOT NULL CHECK(state IN('active','paused','held','completed','stopped','cancelled','failed')),
 position integer NOT NULL CHECK(position BETWEEN 0 AND 23),due_at timestamptz NOT NULL,
 current_send_id uuid REFERENCES app_private.mhp_marketing_sends(id) ON DELETE RESTRICT,
 unknown_ack_proof_id uuid REFERENCES app_private.mhp_owner_email_dispatch_proofs(id) ON DELETE RESTRICT,
 reason text CHECK(reason IS NULL OR reason IN('newer_sequence','content_changed','outcome_unknown','unsubscribed','delivery_expired','delivery_failed','manual','recovery')),
 last_accepted_at timestamptz,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(workspace_id,id,prospect_id),UNIQUE(workspace_id,sequence_version_id,prospect_id,campaign),
 FOREIGN KEY(workspace_id,sequence_item_id,sequence_version_id,sequence_sha256)
  REFERENCES app.company_content_versions(workspace_id,content_item_id,id,content_sha256) ON DELETE RESTRICT,
 FOREIGN KEY(workspace_id,sequence_approval_id) REFERENCES app.company_content_approval_decisions(workspace_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(workspace_id,owner_user_id) REFERENCES app.workspace_memberships(workspace_id,user_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX mhp_followup_one_open_run ON app_private.mhp_followup_runs(workspace_id,sequence_item_id,prospect_id,campaign)
 WHERE state IN('active','paused','held');
CREATE INDEX mhp_followup_due ON app_private.mhp_followup_runs(due_at,id) WHERE state='active';
ALTER TABLE app_private.mhp_followup_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.mhp_followup_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY mhp_followup_owner ON app_private.mhp_followup_runs TO r72_owner USING(true) WITH CHECK(true);
CREATE POLICY mhp_followup_definer ON app_private.mhp_followup_runs TO r72_mhp_prospect_definer
 USING(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b') WITH CHECK(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b');
REVOKE ALL ON app_private.mhp_followup_runs FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON app_private.mhp_followup_runs TO r72_mhp_prospect_definer;
INSERT INTO app_private.workspace_table_registry(schema_name,table_name,workspace_column)
 VALUES('app_private','mhp_followup_runs','workspace_id');
ALTER TABLE app_private.mhp_marketing_sends
 ADD COLUMN sequence_run_id uuid,ADD COLUMN sequence_step integer,
 ADD CONSTRAINT mhp_sequence_send_link CHECK((sequence_run_id IS NULL)=(sequence_step IS NULL)
  AND (sequence_run_id IS NULL OR (owner_workspace_id IS NOT NULL AND sequence_step BETWEEN 0 AND 23))),
 ADD CONSTRAINT mhp_sequence_send_run_fk FOREIGN KEY(owner_workspace_id,sequence_run_id,prospect_id)
  REFERENCES app_private.mhp_followup_runs(workspace_id,id,prospect_id) ON DELETE RESTRICT,
 ADD CONSTRAINT mhp_sequence_send_once UNIQUE(sequence_run_id,sequence_step);
ALTER TABLE app_private.mhp_marketing_sends DROP CONSTRAINT mhp_owner_email_shape;
ALTER TABLE app_private.mhp_marketing_sends ADD CONSTRAINT mhp_owner_email_shape CHECK (
 (owner_workspace_id IS NULL AND owner_content_item_id IS NULL AND owner_content_version_id IS NULL
  AND owner_content_sha256 IS NULL AND owner_approval_decision_id IS NULL AND owner_user_id IS NULL
  AND owner_audience_campaign IS NULL AND owner_lease_id IS NULL AND owner_held_at IS NULL
  AND owner_hold_reason IS NULL AND owner_last_failure IS NULL AND sequence_run_id IS NULL)
 OR(owner_workspace_id IS NOT NULL AND owner_workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND owner_content_item_id IS NOT NULL
  AND owner_content_version_id IS NOT NULL AND owner_content_sha256 IS NOT NULL AND octet_length(owner_content_sha256)=32
  AND owner_approval_decision_id IS NOT NULL AND owner_user_id IS NOT NULL AND owner_audience_campaign IS NOT NULL
  AND owner_audience_campaign~'^[a-z0-9_-]{1,60}$' AND template_key='owner_followup'
  AND ((sequence_run_id IS NULL AND campaign_key='owner-'||owner_content_item_id::text)
    OR(sequence_run_id IS NOT NULL AND campaign_key='seq-'||sequence_run_id::text||'-'||sequence_step::text))
  AND (owner_lease_id IS NULL OR lease_until IS NOT NULL) AND (owner_held_at IS NULL)=(owner_hold_reason IS NULL)
  AND (owner_hold_reason IS NULL OR owner_hold_reason IN('newer_draft','approval_or_brand_changed','recovery'))
  AND (owner_last_failure IS NULL OR owner_last_failure='delivery_not_accepted')));
CREATE POLICY mhp_sequence_items_read ON app.company_content_items FOR SELECT TO r72_mhp_prospect_definer
 USING(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND source_system='mhp.followup-sequence');
CREATE POLICY mhp_sequence_versions_read ON app.company_content_versions FOR SELECT TO r72_mhp_prospect_definer
 USING(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND source_system='mhp.followup-sequence');
DO $policies$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['company_content_source_attestations','company_content_approval_requests','company_content_approval_decisions'] LOOP
  EXECUTE format('CREATE POLICY mhp_sequence_local_read ON app.%I FOR SELECT TO r72_mhp_prospect_definer USING (
   workspace_id=''2789228d-55a6-4688-b1e8-2f70abca990b'' AND EXISTS(SELECT 1 FROM app.company_content_versions v
    WHERE v.workspace_id=%I.workspace_id AND v.id=%I.content_version_id AND v.source_system=''mhp.followup-sequence''))',t,t,t);
 END LOOP;
END $policies$;
CREATE POLICY mhp_sequence_receipts ON app.command_receipts TO r72_mhp_prospect_definer
 USING(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND command_name IN('mhp.sequence.enrol','mhp.sequence.pause','mhp.sequence.resume','mhp.sequence.cancel','mhp.sequence.stop'))
 WITH CHECK(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND command_name IN('mhp.sequence.enrol','mhp.sequence.pause','mhp.sequence.resume','mhp.sequence.cancel','mhp.sequence.stop'));
SET LOCAL ROLE r72_mhp_prospect_definer;

CREATE FUNCTION app_private.mhp_sequence_canonical(p jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $f$
DECLARE result text; kind text:=jsonb_typeof(p);
BEGIN
 IF kind='object' THEN SELECT '{'||coalesce(string_agg(to_json(k)::text||':'||app_private.mhp_sequence_canonical(v),',' ORDER BY k COLLATE "C"),'')||'}' INTO result FROM jsonb_each(p) AS x(k,v);
 ELSIF kind='array' THEN SELECT '['||coalesce(string_agg(app_private.mhp_sequence_canonical(v),',' ORDER BY n),'')||']' INTO result FROM jsonb_array_elements(p) WITH ORDINALITY AS x(v,n);
 ELSIF kind='string' THEN result:=to_json(p#>>'{}')::text;
 ELSIF kind='number' AND (p::text)::numeric=trunc((p::text)::numeric) THEN result:=trunc((p::text)::numeric)::text;
 ELSE result:=p::text; END IF;
 RETURN result;
END $f$;

-- The renamed0126 implementations are private building blocks; old runtime names
-- refuse sequence handoffs. The new sequence adapter alone uses the run-aware path.
ALTER FUNCTION app_private.mhp_prepare_owner_marketing_send(uuid,uuid) RENAME TO mhp_prepare_owner_marketing_send_0126;
ALTER FUNCTION app_private.mhp_settle_owner_marketing_send(uuid,uuid,boolean,text) RENAME TO mhp_settle_owner_marketing_send_0126;
REVOKE ALL ON FUNCTION app_private.mhp_prepare_owner_marketing_send_0126(uuid,uuid),app_private.mhp_settle_owner_marketing_send_0126(uuid,uuid,boolean,text) FROM PUBLIC,r72_identity_command;

CREATE FUNCTION app_private.mhp_prepare_owner_marketing_send(p_send uuid,p_lease uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 IF EXISTS(SELECT 1 FROM app_private.mhp_marketing_sends WHERE id=p_send AND sequence_run_id IS NOT NULL) THEN RETURN NULL; END IF;
 RETURN app_private.mhp_prepare_owner_marketing_send_0126(p_send,p_lease);
END $f$;

CREATE FUNCTION app_private.mhp_sequence_exact(p_version uuid,p_approved boolean,p_latest boolean) RETURNS jsonb
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
 IF keys IS DISTINCT FROM ARRAY['brand','campaign','expiryHours','schema','steps','stopOn','title'] OR d->>'schema' IS DISTINCT FROM 'growthhq.followup-sequence/v1'
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

CREATE FUNCTION app_private.mhp_sequence_lock_items(p_version uuid,p_try boolean) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE v app.company_content_versions%ROWTYPE; item uuid; key bigint;
BEGIN
 SELECT * INTO v FROM app.company_content_versions WHERE id=p_version AND workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND source_system='mhp.followup-sequence';
 IF NOT FOUND THEN RAISE EXCEPTION 'Sequence unavailable' USING ERRCODE='23514'; END IF;
 key:=hashtextextended('company-content:2789228d-55a6-4688-b1e8-2f70abca990b:'||v.content_item_id::text,7200021);
 IF p_try THEN IF NOT pg_try_advisory_xact_lock(key) THEN RETURN false; END IF; ELSE PERFORM pg_advisory_xact_lock(key); END IF;
 FOR item IN SELECT DISTINCT (s->>'contentItemId')::uuid FROM jsonb_array_elements(v.content_body::jsonb->'steps') s WHERE s->>'kind'<>'wait' ORDER BY 1 LOOP
  key:=hashtextextended('company-content:2789228d-55a6-4688-b1e8-2f70abca990b:'||item::text,7200021);
  IF p_try THEN IF NOT pg_try_advisory_xact_lock(key) THEN RETURN false; END IF; ELSE PERFORM pg_advisory_xact_lock(key); END IF;
 END LOOP;
 RETURN true;
END $f$;

CREATE FUNCTION app_private.mhp_sequence_new_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE r app_private.mhp_followup_runs%ROWTYPE;
BEGIN
 IF NEW.workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND NEW.source_system='mhp.followup-sequence' THEN
  PERFORM app_private.mhp_sequence_exact(NEW.id,false,true);
  FOR r IN SELECT * FROM app_private.mhp_followup_runs WHERE sequence_item_id=NEW.content_item_id AND sequence_version_id<>NEW.id
   AND state IN('active','paused','held') ORDER BY id FOR UPDATE LOOP
   UPDATE app_private.mhp_followup_runs SET state='held',reason='newer_sequence',updated_at=clock_timestamp() WHERE id=r.id;
   UPDATE app_private.mhp_marketing_sends SET owner_held_at=coalesce(owner_held_at,clock_timestamp()),owner_hold_reason='newer_draft'
    WHERE sequence_run_id=r.id AND sent_at IS NULL AND cancelled_at IS NULL AND failed_at IS NULL AND (lease_until IS NULL OR lease_until<=clock_timestamp());
  END LOOP;
 END IF;
 RETURN NEW;
END $f$;
RESET ROLE;
SET LOCAL ROLE r72_owner;
CREATE TRIGGER mhp_sequence_new_version AFTER INSERT ON app.company_content_versions FOR EACH ROW EXECUTE FUNCTION app_private.mhp_sequence_new_version();
SET LOCAL ROLE r72_mhp_prospect_definer;

CREATE FUNCTION app_private.mhp_sequence_prospect_allowed(p_prospect uuid,p_campaign text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT EXISTS(SELECT 1 FROM app_private.mhp_prospects p
  CROSS JOIN LATERAL(SELECT min(anchor.created_at) AS captured_at FROM app_private.mhp_marketing_sends anchor
   WHERE anchor.prospect_id=p.id AND anchor.campaign_key=p_campaign AND anchor.owner_content_version_id IS NULL
    AND anchor.template_key IN('webinar_confirm','webinar_24h','webinar_1h','webinar_replay','webinar_followup')) captured
  CROSS JOIN LATERAL(SELECT signup.consent_given FROM app_private.mhp_prospect_signups signup
   WHERE signup.prospect_id=p.id AND signup.kind='webinar' AND signup.created_at<=captured.captured_at
   ORDER BY signup.created_at DESC,signup.id DESC LIMIT 1) latest
  WHERE p.id=p_prospect AND p.unsubscribed_at IS NULL AND p.marketing_consent AND latest.consent_given)
$f$;

CREATE FUNCTION app_private.mhp_sequence_next(p_definition jsonb,p_position integer,p_accepted timestamptz) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $f$
DECLARE step record; waiting integer:=0;
BEGIN
 FOR step IN SELECT value,ordinality::integer-1 AS position FROM jsonb_array_elements(p_definition->'steps') WITH ORDINALITY WHERE ordinality-1>p_position ORDER BY ordinality LOOP
  IF step.value->>'kind'='wait' THEN waiting:=waiting+(step.value->>'minutes')::integer;
  ELSE RETURN jsonb_build_object('position',step.position,'dueAt',p_accepted+make_interval(mins=>waiting)); END IF;
 END LOOP;
 RETURN NULL;
END $f$;

CREATE FUNCTION app_private.mhp_sequence_local_version(p_session bytea,p_version uuid,p_revision text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE v app.company_content_versions%ROWTYPE; exact jsonb; valid boolean:=true;
BEGIN
 PERFORM app_private.mhp_owner_email_authorize(p_session);
 IF (p_version IS NULL)=(p_revision IS NULL) OR (p_revision IS NOT NULL AND p_revision!~'^edit:[0-9a-f-]{36}$') THEN RAISE EXCEPTION 'Invalid sequence lookup' USING ERRCODE='22023'; END IF;
 SELECT * INTO v FROM app.company_content_versions WHERE workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND source_system='mhp.followup-sequence'
  AND ((p_version IS NOT NULL AND id=p_version) OR(p_revision IS NOT NULL AND source_version=p_revision));
 IF NOT FOUND THEN RETURN NULL; END IF;
 BEGIN exact:=app_private.mhp_sequence_exact(v.id,false,true); EXCEPTION WHEN check_violation OR insufficient_privilege THEN valid:=false; END;
 RETURN jsonb_build_object('contentItemId',v.content_item_id,'contentVersionId',v.id,'versionNumber',v.version_number,'previousVersionId',v.previous_version_id,
  'title',v.title,'sourceItemId',v.source_item_id,'sourceVersion',v.source_version,'canonicalContent',v.content_body,'contentSha256',encode(v.content_sha256,'hex'),
  'blobSha256',encode(v.blob_sha256,'hex'),'brandSha256',encode(v.brand_sha256,'hex'),'metadata',v.metadata,'valid',valid,'exact',exact);
END $f$;

CREATE FUNCTION app_private.mhp_sequence_snapshot(p_session bytea,p_campaign text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE eligible integer; audience integer; runs jsonb;
BEGIN
 PERFORM app_private.mhp_owner_email_authorize(p_session);
 IF p_campaign IS NULL OR p_campaign!~'^[a-z0-9_-]{1,60}$' THEN RAISE EXCEPTION 'Invalid audience' USING ERRCODE='22023'; END IF;
 SELECT count(*) INTO eligible FROM app_private.mhp_owner_email_audience(p_campaign);
 SELECT count(DISTINCT prospect_id) INTO audience FROM app_private.mhp_marketing_sends
  WHERE campaign_key=p_campaign AND owner_content_version_id IS NULL AND template_key IN('webinar_confirm','webinar_24h','webinar_1h','webinar_replay','webinar_followup');
 SELECT coalesce(jsonb_agg(to_jsonb(q)),'[]') INTO runs FROM(
  SELECT r.id,r.sequence_item_id AS "contentItemId",r.sequence_version_id AS "contentVersionId",p.email::text AS email,p.first_name AS "firstName",
   r.state,r.position,r.due_at AS "dueAt",r.reason,r.created_at AS "createdAt",r.last_accepted_at AS "lastAcceptedAt",
   coalesce(s.lease_until>statement_timestamp() AND s.sent_at IS NULL,false) AS "inFlight",
   CASE WHEN proof.accepted IS NULL AND proof.id IS DISTINCT FROM r.unknown_ack_proof_id THEN proof.id END AS "unknownProofId",
   coalesce((SELECT jsonb_agg(jsonb_build_object('position',j.sequence_step,'acceptedAt',j.sent_at,'dueAt',j.due_at,
    'expiresAt',j.expires_at,'cancelled',j.cancelled_at IS NOT NULL,'failed',j.failed_at IS NOT NULL,'held',j.owner_held_at IS NOT NULL,
    'inFlight',j.lease_until>statement_timestamp() AND j.sent_at IS NULL) ORDER BY j.sequence_step)
    FROM app_private.mhp_marketing_sends j WHERE j.sequence_run_id=r.id),'[]') AS steps
  FROM app_private.mhp_followup_runs r JOIN app_private.mhp_prospects p ON p.id=r.prospect_id
  LEFT JOIN app_private.mhp_marketing_sends s ON s.id=r.current_send_id
  LEFT JOIN LATERAL(SELECT x.id,x.accepted FROM app_private.mhp_owner_email_dispatch_proofs x WHERE x.send_id=s.id ORDER BY x.checked_at DESC,x.id DESC LIMIT 1) proof ON true
  WHERE r.campaign=p_campaign ORDER BY r.created_at DESC,r.id DESC LIMIT 100)q;
 RETURN jsonb_build_object('brand',app_private.mhp_owner_email_brand(),'campaign',p_campaign,'eligible',eligible,'blocked',greatest(audience-eligible,0),'runs',runs,
  'runCount',(SELECT count(*) FROM app_private.mhp_followup_runs WHERE campaign=p_campaign));
END $f$;

CREATE FUNCTION app_private.mhp_sequence_action_receipt(p_actor uuid,p_action text,p_command uuid,p_payload jsonb,p_request text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE r app.command_receipts%ROWTYPE; hashed bytea;
BEGIN
 IF p_actor IS NULL OR p_command IS NULL OR p_action IS NULL OR p_action NOT IN('enrol','pause','resume','cancel','stop')
  OR p_request IS NULL OR p_request!~'^[!-~]{1,128}$' THEN RAISE EXCEPTION 'Invalid sequence command' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('mhp-sequence-command:'||p_actor::text||':'||p_action||':'||p_command::text,7200127));
 hashed:=public.digest(p_payload::text,'sha256');
 SELECT * INTO r FROM app.command_receipts WHERE workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND actor_user_id=p_actor
  AND command_name='mhp.sequence.'||p_action AND idempotency_key=p_command::text;
 IF FOUND THEN
  IF r.payload_hash<>hashed THEN RAISE EXCEPTION 'Sequence command input changed' USING ERRCODE='23514'; END IF;
  RETURN jsonb_build_object('receiptId',r.id,'replayed',true,'result',r.result,'status',r.status);
 END IF;
 INSERT INTO app.command_receipts(workspace_id,actor_user_id,command_name,idempotency_key,request_id,payload_hash,status,result)
 VALUES('2789228d-55a6-4688-b1e8-2f70abca990b',p_actor,'mhp.sequence.'||p_action,p_command::text,p_request,hashed,'started',p_payload) RETURNING * INTO r;
 RETURN jsonb_build_object('receiptId',r.id,'replayed',false);
END $f$;

CREATE FUNCTION app_private.mhp_sequence_command(p_session bytea,p_action text,p_command uuid,p_version uuid,p_campaign text,p_run uuid,p_ack_proof uuid,p_request text) RETURNS jsonb
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
    IF NOT app_private.mhp_sequence_prospect_allowed(r.prospect_id,r.campaign) OR (q.expires_at IS NOT NULL AND q.expires_at<=clock_timestamp())
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

CREATE FUNCTION app_private.mhp_sequence_claim(p_limit integer,p_lease_seconds integer,p_only_emails text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE candidate record; r app_private.mhp_followup_runs%ROWTYPE; q app_private.mhp_marketing_sends%ROWTYPE;
 proof app_private.mhp_owner_email_dispatch_proofs%ROWTYPE; exact jsonb; message jsonb; email jsonb; audience record;
 claimed jsonb:='[]'; lease uuid; until_at timestamptz; expiry timestamptz;
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 25 OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 900
  OR (p_only_emails IS NOT NULL AND cardinality(p_only_emails) NOT BETWEEN 1 AND 20) THEN RAISE EXCEPTION 'Invalid sequence claim' USING ERRCODE='22023'; END IF;
 -- Terminal suppression maintenance does not consume healthy held/future/test-filter rows.
 FOR candidate IN SELECT x.id FROM app_private.mhp_followup_runs x WHERE x.state IN('active','paused','held')
  AND NOT app_private.mhp_sequence_prospect_allowed(x.prospect_id,x.campaign) ORDER BY x.id LIMIT 500 LOOP
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

CREATE FUNCTION app_private.mhp_sequence_prepare(p_send uuid,p_lease uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE run_id uuid; version_id uuid; r app_private.mhp_followup_runs%ROWTYPE; q app_private.mhp_marketing_sends%ROWTYPE; exact jsonb;
BEGIN
 SELECT s.sequence_run_id,linked.sequence_version_id INTO run_id,version_id FROM app_private.mhp_marketing_sends s JOIN app_private.mhp_followup_runs linked ON linked.id=s.sequence_run_id WHERE s.id=p_send;
 IF run_id IS NULL THEN RETURN NULL; END IF;
 PERFORM app_private.mhp_sequence_lock_items(version_id,false);
 SELECT * INTO r FROM app_private.mhp_followup_runs WHERE id=run_id FOR UPDATE;
 SELECT * INTO q FROM app_private.mhp_marketing_sends WHERE id=p_send FOR UPDATE;
 IF r.state<>'active' OR r.current_send_id IS DISTINCT FROM p_send OR r.position IS DISTINCT FROM q.sequence_step
  OR q.owner_lease_id IS DISTINCT FROM p_lease OR q.due_at>clock_timestamp() OR NOT app_private.mhp_sequence_prospect_allowed(r.prospect_id,r.campaign) THEN RETURN NULL; END IF;
 BEGIN
  exact:=app_private.mhp_sequence_exact(r.sequence_version_id,true,true);
  IF decode(exact->>'contentSha256','hex')<>r.sequence_sha256 OR (exact->>'approvalDecisionId')::uuid<>r.sequence_approval_id
   OR NOT app_private.mhp_marketing_workspace_allowed(r.owner_user_id,r.workspace_id) THEN RETURN NULL; END IF;
 EXCEPTION WHEN check_violation OR insufficient_privilege THEN RETURN NULL; END;
 RETURN app_private.mhp_prepare_owner_marketing_send_0126(p_send,p_lease);
END $f$;

CREATE FUNCTION app_private.mhp_settle_owner_marketing_send(p_send uuid,p_lease uuid,p_accepted boolean,p_reference text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE run_id uuid; r app_private.mhp_followup_runs%ROWTYPE; q app_private.mhp_marketing_sends%ROWTYPE; definition jsonb; next jsonb;
BEGIN
 SELECT sequence_run_id INTO run_id FROM app_private.mhp_marketing_sends WHERE id=p_send;
 IF run_id IS NOT NULL THEN SELECT * INTO r FROM app_private.mhp_followup_runs WHERE id=run_id FOR UPDATE; END IF;
 PERFORM app_private.mhp_settle_owner_marketing_send_0126(p_send,p_lease,p_accepted,p_reference);
 IF run_id IS NULL OR NOT p_accepted THEN RETURN; END IF;
 SELECT * INTO q FROM app_private.mhp_marketing_sends WHERE id=p_send;
 IF q.sent_at IS NULL OR r.current_send_id IS DISTINCT FROM q.id OR r.position<>q.sequence_step THEN RETURN; END IF;
 IF r.state NOT IN('active','paused','held') THEN UPDATE app_private.mhp_followup_runs SET last_accepted_at=q.sent_at,updated_at=clock_timestamp() WHERE id=r.id;RETURN; END IF;
 SELECT content_body::jsonb INTO definition FROM app.company_content_versions WHERE id=r.sequence_version_id AND workspace_id=r.workspace_id;
 next:=app_private.mhp_sequence_next(definition,r.position,q.sent_at);
 UPDATE app_private.mhp_followup_runs SET state=CASE WHEN next IS NULL THEN 'completed' ELSE state END,
  position=CASE WHEN next IS NULL THEN position ELSE (next->>'position')::integer END,
  due_at=CASE WHEN next IS NULL THEN due_at ELSE (next->>'dueAt')::timestamptz END,current_send_id=NULL,
  last_accepted_at=q.sent_at,unknown_ack_proof_id=NULL,updated_at=clock_timestamp() WHERE id=r.id;
END $f$;

CREATE FUNCTION app_private.mhp_sequence_unknown(p_send uuid,p_lease uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE run_id uuid; r app_private.mhp_followup_runs%ROWTYPE; q app_private.mhp_marketing_sends%ROWTYPE;
BEGIN
 SELECT sequence_run_id INTO run_id FROM app_private.mhp_marketing_sends WHERE id=p_send;
 IF run_id IS NULL THEN RETURN; END IF;
 SELECT * INTO r FROM app_private.mhp_followup_runs WHERE id=run_id FOR UPDATE;
 SELECT * INTO q FROM app_private.mhp_marketing_sends WHERE id=p_send FOR UPDATE;
 IF r.current_send_id=p_send AND r.state IN('active','paused','held') AND q.sent_at IS NULL AND q.owner_lease_id=p_lease
  AND EXISTS(SELECT 1 FROM app_private.mhp_owner_email_dispatch_proofs WHERE send_id=p_send AND lease_id=p_lease AND accepted IS NULL)
 THEN UPDATE app_private.mhp_followup_runs SET state='held',reason='outcome_unknown',updated_at=clock_timestamp() WHERE id=r.id; END IF;
END $f$;

CREATE FUNCTION app_private.mhp_hold_sequence_runs() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE r app_private.mhp_followup_runs%ROWTYPE; held integer:=0; flying integer:=0;
BEGIN
 FOR r IN SELECT * FROM app_private.mhp_followup_runs WHERE state IN('active','paused','held') ORDER BY id FOR UPDATE LOOP
  UPDATE app_private.mhp_followup_runs SET state='held',reason=CASE WHEN reason IN('outcome_unknown','newer_sequence','content_changed') THEN reason ELSE 'recovery' END,updated_at=clock_timestamp() WHERE id=r.id;
  held:=held+1;
  SELECT flying+count(*) INTO flying FROM app_private.mhp_marketing_sends WHERE sequence_run_id=r.id AND sent_at IS NULL AND lease_until>clock_timestamp();
  UPDATE app_private.mhp_marketing_sends SET owner_held_at=coalesce(owner_held_at,clock_timestamp()),owner_hold_reason='recovery'
   WHERE sequence_run_id=r.id AND sent_at IS NULL AND cancelled_at IS NULL AND failed_at IS NULL AND (lease_until IS NULL OR lease_until<=clock_timestamp()) AND owner_held_at IS NULL;
 END LOOP;
 RETURN jsonb_build_object('held',held,'inFlight',flying,'resumed',0);
END $f$;

-- Exact0126 standalone compatibility bodies; only sequence discriminator exclusions changed.
CREATE OR REPLACE FUNCTION app_private.mhp_owner_email_queue_command(p_session bytea,p_action text,p_command uuid,p_version uuid,p_campaign text,
 p_due timestamptz,p_expires timestamptz,p_request text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; item uuid; exact jsonb; receipt jsonb; outcome jsonb; changed integer:=0; remaining integer:=0; inflight integer:=0;
BEGIN
 actor:=app_private.mhp_owner_email_authorize(p_session);
 IF NOT app_private.lock_active_portal_session(p_session,actor,'2789228d-55a6-4688-b1e8-2f70abca990b')
 THEN RAISE EXCEPTION 'Owner session changed' USING ERRCODE='42501'; END IF;
 IF p_action IS NULL OR p_action NOT IN('schedule','replace','cancel') OR p_version IS NULL
  OR p_campaign IS NULL OR p_campaign!~'^[a-z0-9_-]{1,60}$' THEN RAISE EXCEPTION 'Invalid email action' USING ERRCODE='22023'; END IF;
 receipt:=app_private.mhp_owner_email_action_receipt(actor,p_action,p_command,jsonb_build_object('version',p_version,'campaign',p_campaign,'due',p_due,'expires',p_expires),p_request);
 IF (receipt->>'replayed')::boolean THEN RETURN (receipt->'result')||jsonb_build_object('replayed',true); END IF;
 SELECT v.content_item_id INTO item FROM app.company_content_versions v WHERE v.id=p_version
  AND v.workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND v.source_system='mhp.owner-email';
 IF item IS NULL THEN RAISE EXCEPTION 'Local email unavailable' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('company-content:2789228d-55a6-4688-b1e8-2f70abca990b:'||item::text,7200021));
 SELECT count(*) INTO inflight FROM app_private.mhp_marketing_sends s WHERE s.owner_content_item_id=item AND s.sequence_run_id IS NULL
  AND s.sent_at IS NULL AND s.cancelled_at IS NULL AND s.failed_at IS NULL AND s.owner_lease_id IS NOT NULL AND s.lease_until>clock_timestamp();
 IF p_action='cancel' THEN
  IF p_due IS NOT NULL OR p_expires IS NOT NULL THEN RAISE EXCEPTION 'Cancel has no schedule' USING ERRCODE='22023'; END IF;
  WITH targets AS(SELECT s.id FROM app_private.mhp_marketing_sends s WHERE s.owner_content_item_id=item AND s.sequence_run_id IS NULL
   AND s.sent_at IS NULL AND s.cancelled_at IS NULL AND s.failed_at IS NULL
   AND (s.owner_lease_id IS NULL OR s.lease_until<=clock_timestamp()) ORDER BY s.id LIMIT 500 FOR UPDATE SKIP LOCKED)
  UPDATE app_private.mhp_marketing_sends s SET cancelled_at=clock_timestamp() FROM targets t WHERE s.id=t.id;
  GET DIAGNOSTICS changed=ROW_COUNT;
  SELECT count(*) INTO remaining FROM app_private.mhp_marketing_sends s WHERE s.owner_content_item_id=item AND s.sequence_run_id IS NULL
   AND s.sent_at IS NULL AND s.cancelled_at IS NULL AND s.failed_at IS NULL AND (s.owner_lease_id IS NULL OR s.lease_until<=clock_timestamp());
 ELSE
  IF p_due IS NULL OR p_expires IS NULL OR NOT isfinite(p_due) OR NOT isfinite(p_expires)
   OR p_due<clock_timestamp() OR p_expires<=p_due THEN RAISE EXCEPTION 'Choose future send and expiry times' USING ERRCODE='22023'; END IF;
  exact:=app_private.mhp_owner_email_exact(p_version,true,true,true);
  IF exact->>'audienceCampaign'<>p_campaign THEN RAISE EXCEPTION 'Email audience changed' USING ERRCODE='23514'; END IF;
  IF p_action='schedule' THEN
   INSERT INTO app_private.mhp_marketing_sends(prospect_id,template_key,campaign_key,context,due_at,expires_at,
    owner_workspace_id,owner_content_item_id,owner_content_version_id,owner_content_sha256,owner_approval_decision_id,owner_user_id,owner_audience_campaign)
   SELECT a.prospect_id,'owner_followup','owner-'||item::text,jsonb_build_object('label',a.label,'link',a.link),p_due,p_expires,
    '2789228d-55a6-4688-b1e8-2f70abca990b',item,p_version,decode(exact->>'contentSha256','hex'),(exact->>'approvalDecisionId')::uuid,actor,p_campaign
   FROM app_private.mhp_owner_email_audience(p_campaign) a
   WHERE NOT EXISTS(SELECT 1 FROM app_private.mhp_marketing_sends s WHERE s.prospect_id=a.prospect_id AND s.owner_content_item_id=item AND s.sequence_run_id IS NULL)
   ORDER BY a.prospect_id LIMIT 500 ON CONFLICT(prospect_id,template_key,campaign_key) DO NOTHING;
   GET DIAGNOSTICS changed=ROW_COUNT;
   SELECT count(*) INTO remaining FROM app_private.mhp_owner_email_audience(p_campaign) a
    WHERE NOT EXISTS(SELECT 1 FROM app_private.mhp_marketing_sends s WHERE s.prospect_id=a.prospect_id AND s.owner_content_item_id=item AND s.sequence_run_id IS NULL);
  ELSE
   WITH targets AS(SELECT s.id FROM app_private.mhp_marketing_sends s JOIN app_private.mhp_owner_email_audience(p_campaign) a ON a.prospect_id=s.prospect_id
    WHERE s.owner_content_item_id=item AND s.sequence_run_id IS NULL AND s.sent_at IS NULL AND s.cancelled_at IS NULL AND s.failed_at IS NULL
     AND (s.owner_lease_id IS NULL OR s.lease_until<=clock_timestamp())
     AND (s.owner_held_at IS NOT NULL OR s.owner_content_version_id<>p_version OR s.due_at<>p_due OR s.expires_at<>p_expires)
    ORDER BY s.id LIMIT 500 FOR UPDATE OF s SKIP LOCKED)
   UPDATE app_private.mhp_marketing_sends s SET owner_content_version_id=p_version,owner_content_sha256=decode(exact->>'contentSha256','hex'),
    owner_approval_decision_id=(exact->>'approvalDecisionId')::uuid,owner_user_id=actor,due_at=p_due,expires_at=p_expires,
    owner_held_at=NULL,owner_hold_reason=NULL,owner_lease_id=NULL,lease_until=NULL,owner_last_failure=NULL
   FROM targets t WHERE s.id=t.id;
   GET DIAGNOSTICS changed=ROW_COUNT;
   SELECT count(*) INTO remaining FROM app_private.mhp_marketing_sends s JOIN app_private.mhp_owner_email_audience(p_campaign) a ON a.prospect_id=s.prospect_id
    WHERE s.owner_content_item_id=item AND s.sequence_run_id IS NULL AND s.sent_at IS NULL AND s.cancelled_at IS NULL AND s.failed_at IS NULL
     AND (s.owner_lease_id IS NULL OR s.lease_until<=clock_timestamp())
     AND (s.owner_held_at IS NOT NULL OR s.owner_content_version_id<>p_version OR s.due_at<>p_due OR s.expires_at<>p_expires);
  END IF;
 END IF;
 outcome:=jsonb_build_object('action',p_action,'contentItemId',item,'contentVersionId',p_version,'changed',changed,'remaining',remaining,'inFlight',inflight,'replayed',false);
 UPDATE app.command_receipts SET result=outcome,status='succeeded',response_status=200,completed_at=clock_timestamp()
 WHERE id=(receipt->>'receiptId')::uuid;
 RETURN outcome;
END $f$;

CREATE OR REPLACE FUNCTION app_private.mhp_claim_owner_marketing_sends(p_limit integer,p_lease_seconds integer,p_only_emails text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE candidate record; s app_private.mhp_marketing_sends%ROWTYPE; p app_private.mhp_prospects%ROWTYPE;
 exact jsonb; claimed jsonb:='[]'; next_lease uuid; until_at timestamptz;
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 25 OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 900
  OR (p_only_emails IS NOT NULL AND cardinality(p_only_emails) NOT BETWEEN 1 AND 20)
 THEN RAISE EXCEPTION 'Invalid owner claim' USING ERRCODE='22023'; END IF;
 -- Terminal-only maintenance is independent of due time, holds and test recipients.
 -- Healthy held/future/other-recipient rows must not consume this bounded scan.
 FOR candidate IN SELECT q.id,q.owner_content_item_id FROM app_private.mhp_marketing_sends q
  JOIN app_private.mhp_prospects x ON x.id=q.prospect_id
  WHERE q.owner_content_version_id IS NOT NULL AND q.sequence_run_id IS NULL AND q.sent_at IS NULL AND q.cancelled_at IS NULL AND q.failed_at IS NULL
   AND (q.lease_until IS NULL OR q.lease_until<=clock_timestamp())
   AND (q.expires_at<=clock_timestamp() OR q.attempts>=5 OR x.unsubscribed_at IS NOT NULL OR NOT x.marketing_consent
    OR NOT EXISTS(
     SELECT 1 FROM (SELECT min(anchor.created_at) AS captured_at FROM app_private.mhp_marketing_sends anchor
      WHERE anchor.prospect_id=q.prospect_id AND anchor.campaign_key=q.owner_audience_campaign AND anchor.owner_content_version_id IS NULL
       AND anchor.template_key IN('webinar_confirm','webinar_24h','webinar_1h','webinar_replay','webinar_followup')) captured
     CROSS JOIN LATERAL(SELECT signup.consent_given FROM app_private.mhp_prospect_signups signup
      WHERE signup.prospect_id=q.prospect_id AND signup.kind='webinar' AND signup.created_at<=captured.captured_at
      ORDER BY signup.created_at DESC,signup.id DESC LIMIT 1) latest WHERE latest.consent_given))
  ORDER BY q.due_at,q.id LIMIT 500
 LOOP
  IF NOT pg_try_advisory_xact_lock(hashtextextended('company-content:2789228d-55a6-4688-b1e8-2f70abca990b:'||candidate.owner_content_item_id::text,7200021)) THEN CONTINUE; END IF;
  SELECT * INTO s FROM app_private.mhp_marketing_sends q WHERE q.id=candidate.id FOR UPDATE SKIP LOCKED;
  IF NOT FOUND OR s.sent_at IS NOT NULL OR s.cancelled_at IS NOT NULL OR s.failed_at IS NOT NULL
   OR s.lease_until>clock_timestamp() THEN CONTINUE; END IF;
  SELECT * INTO p FROM app_private.mhp_prospects x WHERE x.id=s.prospect_id;
  IF s.expires_at<=clock_timestamp() OR p.unsubscribed_at IS NOT NULL OR NOT p.marketing_consent
   OR NOT EXISTS(
    SELECT 1 FROM (SELECT min(anchor.created_at) AS captured_at FROM app_private.mhp_marketing_sends anchor
     WHERE anchor.prospect_id=s.prospect_id AND anchor.campaign_key=s.owner_audience_campaign AND anchor.owner_content_version_id IS NULL
      AND anchor.template_key IN('webinar_confirm','webinar_24h','webinar_1h','webinar_replay','webinar_followup')) captured
    CROSS JOIN LATERAL(SELECT signup.consent_given FROM app_private.mhp_prospect_signups signup
     WHERE signup.prospect_id=s.prospect_id AND signup.kind='webinar' AND signup.created_at<=captured.captured_at
     ORDER BY signup.created_at DESC,signup.id DESC LIMIT 1) latest WHERE latest.consent_given)
  THEN UPDATE app_private.mhp_marketing_sends SET cancelled_at=clock_timestamp() WHERE id=s.id;
  ELSIF s.attempts>=5 THEN UPDATE app_private.mhp_marketing_sends SET failed_at=clock_timestamp() WHERE id=s.id; END IF;
 END LOOP;
 FOR candidate IN SELECT q.id,q.owner_content_item_id FROM app_private.mhp_marketing_sends q
  JOIN app_private.mhp_prospects x ON x.id=q.prospect_id
  WHERE q.owner_content_version_id IS NOT NULL AND q.sequence_run_id IS NULL AND q.sent_at IS NULL AND q.cancelled_at IS NULL AND q.failed_at IS NULL
   AND q.owner_held_at IS NULL AND q.due_at<=clock_timestamp() AND q.expires_at>clock_timestamp() AND q.attempts<5
   AND (q.lease_until IS NULL OR q.lease_until<=clock_timestamp())
   AND x.unsubscribed_at IS NULL AND x.marketing_consent
   AND (p_only_emails IS NULL OR x.email::text=ANY(p_only_emails))
   AND EXISTS(
    SELECT 1 FROM (SELECT min(anchor.created_at) AS captured_at FROM app_private.mhp_marketing_sends anchor
     WHERE anchor.prospect_id=q.prospect_id AND anchor.campaign_key=q.owner_audience_campaign AND anchor.owner_content_version_id IS NULL
      AND anchor.template_key IN('webinar_confirm','webinar_24h','webinar_1h','webinar_replay','webinar_followup')) captured
    CROSS JOIN LATERAL(SELECT signup.consent_given FROM app_private.mhp_prospect_signups signup
     WHERE signup.prospect_id=q.prospect_id AND signup.kind='webinar' AND signup.created_at<=captured.captured_at
     ORDER BY signup.created_at DESC,signup.id DESC LIMIT 1) latest WHERE latest.consent_given)
  ORDER BY q.due_at,q.id LIMIT 500
 LOOP
  IF NOT pg_try_advisory_xact_lock(hashtextextended('company-content:2789228d-55a6-4688-b1e8-2f70abca990b:'||candidate.owner_content_item_id::text,7200021)) THEN CONTINUE; END IF;
  SELECT * INTO s FROM app_private.mhp_marketing_sends q WHERE q.id=candidate.id FOR UPDATE SKIP LOCKED;
  IF NOT FOUND OR s.sent_at IS NOT NULL OR s.cancelled_at IS NOT NULL OR s.failed_at IS NOT NULL
   OR s.lease_until>clock_timestamp() THEN CONTINUE; END IF;
  SELECT * INTO p FROM app_private.mhp_prospects x WHERE x.id=s.prospect_id;
  IF s.expires_at<=clock_timestamp() OR p.unsubscribed_at IS NOT NULL OR NOT p.marketing_consent
   OR NOT EXISTS(
    SELECT 1 FROM (SELECT min(anchor.created_at) AS captured_at FROM app_private.mhp_marketing_sends anchor
     WHERE anchor.prospect_id=s.prospect_id AND anchor.campaign_key=s.owner_audience_campaign AND anchor.owner_content_version_id IS NULL
      AND anchor.template_key IN('webinar_confirm','webinar_24h','webinar_1h','webinar_replay','webinar_followup')) captured
    CROSS JOIN LATERAL(SELECT signup.consent_given FROM app_private.mhp_prospect_signups signup
     WHERE signup.prospect_id=s.prospect_id AND signup.kind='webinar' AND signup.created_at<=captured.captured_at
     ORDER BY signup.created_at DESC,signup.id DESC LIMIT 1) latest WHERE latest.consent_given)
  THEN UPDATE app_private.mhp_marketing_sends SET cancelled_at=clock_timestamp() WHERE id=s.id; CONTINUE; END IF;
  IF s.attempts>=5 THEN UPDATE app_private.mhp_marketing_sends SET failed_at=clock_timestamp() WHERE id=s.id; CONTINUE; END IF;
  IF s.owner_held_at IS NOT NULL OR s.due_at>clock_timestamp()
   OR (p_only_emails IS NOT NULL AND NOT p.email::text=ANY(p_only_emails)) THEN CONTINUE; END IF;
  BEGIN
   exact:=app_private.mhp_owner_email_exact(s.owner_content_version_id,true,true,true);
   IF (exact->>'approvalDecisionId')::uuid<>s.owner_approval_decision_id
    OR decode(exact->>'contentSha256','hex')<>s.owner_content_sha256
    OR exact->>'audienceCampaign'<>s.owner_audience_campaign
    OR NOT app_private.mhp_marketing_workspace_allowed(s.owner_user_id,s.owner_workspace_id)
   THEN RAISE EXCEPTION 'Pinned owner permission changed' USING ERRCODE='23514'; END IF;
  EXCEPTION WHEN check_violation OR insufficient_privilege THEN
   UPDATE app_private.mhp_marketing_sends SET owner_held_at=clock_timestamp(),owner_hold_reason='approval_or_brand_changed' WHERE id=s.id;
   CONTINUE;
  END;
  next_lease:=gen_random_uuid();until_at:=clock_timestamp()+make_interval(secs=>p_lease_seconds);
  UPDATE app_private.mhp_marketing_sends SET owner_lease_id=next_lease,lease_until=until_at,attempts=attempts+1 WHERE id=s.id;
  claimed:=claimed||jsonb_build_array(jsonb_build_object('id',s.id,'leaseId',next_lease,'leaseUntil',until_at));
  IF jsonb_array_length(claimed)>=p_limit THEN EXIT; END IF;
 END LOOP;
 RETURN claimed;
END $f$;

CREATE OR REPLACE FUNCTION app_private.mhp_owner_email_snapshot(p_session bytea,p_campaign text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; automatic jsonb; owner_items jsonb; tests jsonb; eligible integer;
BEGIN
 actor:=app_private.mhp_owner_email_authorize(p_session);
 IF p_campaign IS NULL OR p_campaign!~'^[a-z0-9_-]{1,60}$' THEN RAISE EXCEPTION 'Invalid webinar campaign' USING ERRCODE='22023'; END IF;
 SELECT count(*) INTO eligible FROM app_private.mhp_owner_email_audience(p_campaign);
 SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.template),'[]') INTO automatic FROM(
  SELECT s.template_key AS template,count(*) AS total,count(*) FILTER(WHERE s.sent_at IS NOT NULL) AS sent,
   count(*) FILTER(WHERE s.sent_at IS NULL AND s.cancelled_at IS NULL AND s.failed_at IS NULL) AS pending,
   count(*) FILTER(WHERE s.failed_at IS NOT NULL) AS failed,count(*) FILTER(WHERE s.cancelled_at IS NOT NULL) AS cancelled
  FROM app_private.mhp_marketing_sends s WHERE s.owner_content_version_id IS NULL AND s.campaign_key=p_campaign
  GROUP BY s.template_key) t;
 SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t."contentItemId"),'[]') INTO owner_items FROM(
  SELECT s.owner_content_item_id AS "contentItemId",count(*) AS total,
   count(*) FILTER(WHERE s.sent_at IS NOT NULL) AS sent,
   count(*) FILTER(WHERE s.sent_at IS NULL AND s.cancelled_at IS NULL AND s.failed_at IS NULL AND s.owner_lease_id IS NOT NULL AND s.lease_until>statement_timestamp()) AS "inFlight",
   count(*) FILTER(WHERE s.sent_at IS NULL AND s.cancelled_at IS NULL AND s.failed_at IS NULL AND s.owner_held_at IS NOT NULL AND (s.owner_lease_id IS NULL OR s.lease_until<=statement_timestamp())) AS held,
   count(*) FILTER(WHERE s.sent_at IS NULL AND s.cancelled_at IS NULL AND s.failed_at IS NULL AND s.owner_held_at IS NULL AND (s.owner_lease_id IS NULL OR s.lease_until<=statement_timestamp())) AS pending,
   count(*) FILTER(WHERE s.failed_at IS NOT NULL) AS failed,count(*) FILTER(WHERE s.cancelled_at IS NOT NULL) AS cancelled,
   min(s.due_at) AS "dueAt",max(s.expires_at) AS "expiresAt",max(s.owner_hold_reason) AS "holdReason",max(s.owner_last_failure) AS "lastFailure"
  FROM app_private.mhp_marketing_sends s WHERE s.owner_workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b'
   AND s.owner_audience_campaign=p_campaign AND s.sequence_run_id IS NULL GROUP BY s.owner_content_item_id ORDER BY s.owner_content_item_id LIMIT 50) t;
 SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t."createdAt" DESC),'[]') INTO tests FROM(
  SELECT r.created_at AS "createdAt",r.result->>'contentVersionId' AS "contentVersionId",
   CASE WHEN r.status='succeeded' THEN 'accepted' ELSE 'unknown' END AS status
  FROM app.command_receipts r WHERE r.workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND r.actor_user_id=actor
   AND r.command_name='mhp.ownerEmail.test' ORDER BY r.created_at DESC,r.id DESC LIMIT 20) t;
 RETURN jsonb_build_object('brand',app_private.mhp_owner_email_brand(),'campaign',p_campaign,'eligible',eligible,
  'automatic',automatic,'ownerItems',owner_items,'tests',tests);
END $f$;

REVOKE ALL ON FUNCTION app_private.mhp_sequence_canonical(jsonb),app_private.mhp_sequence_exact(uuid,boolean,boolean),
 app_private.mhp_sequence_lock_items(uuid,boolean),app_private.mhp_sequence_new_version(),app_private.mhp_sequence_prospect_allowed(uuid,text),
 app_private.mhp_sequence_next(jsonb,integer,timestamptz),app_private.mhp_sequence_local_version(bytea,uuid,text),app_private.mhp_sequence_snapshot(bytea,text),
 app_private.mhp_sequence_action_receipt(uuid,text,uuid,jsonb,text),app_private.mhp_sequence_command(bytea,text,uuid,uuid,text,uuid,uuid,text),
 app_private.mhp_sequence_claim(integer,integer,text[]),app_private.mhp_sequence_prepare(uuid,uuid),app_private.mhp_sequence_unknown(uuid,uuid),app_private.mhp_hold_sequence_runs(),
 app_private.mhp_prepare_owner_marketing_send(uuid,uuid),app_private.mhp_settle_owner_marketing_send(uuid,uuid,boolean,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.mhp_sequence_snapshot(bytea,text),app_private.mhp_sequence_local_version(bytea,uuid,text) TO r72_web;
GRANT EXECUTE ON FUNCTION app_private.mhp_sequence_command(bytea,text,uuid,uuid,text,uuid,uuid,text),app_private.mhp_sequence_claim(integer,integer,text[]),
 app_private.mhp_sequence_prepare(uuid,uuid),app_private.mhp_sequence_unknown(uuid,uuid),app_private.mhp_hold_sequence_runs(),
 app_private.mhp_prepare_owner_marketing_send(uuid,uuid),app_private.mhp_settle_owner_marketing_send(uuid,uuid,boolean,text) TO r72_identity_command;
RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_mhp_prospect_definer;
RESET ROLE;
