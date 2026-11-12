-- PP-FOLLOWUP-001: Property Predator owner follow-up flows can send their EMAIL steps through Postmark.
-- Additive only. 0001-0151 are unchanged: no MHP table, function, policy or trigger is altered, and no trigger is
-- added to any shared table. Every new table and function is pinned to the Property Predator workspace
-- d975ff66-336a-46c2-b36b-d7095a11af97 and owned by the new NOLOGIN r72_pp_followup_definer.
-- Copy stays in company_content_versions ('pp.followup-sequence' flows and 'pp.owner-email' messages, both exactly
-- approved). Recipients are existing CRM email contact points with a current granted 'email'/'marketing' consent
-- and no active suppression. The migration enrols nobody and has no provider effect.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

DO $role$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='r72_pp_followup_definer') THEN
    CREATE ROLE r72_pp_followup_definer NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='r72_pp_followup_definer' AND NOT rolcanlogin AND NOT rolinherit
      AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls)
    OR EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname='r72_pp_followup_definer') THEN
    RAISE EXCEPTION 'Unsafe PP follow-up function-owner attributes' USING ERRCODE='42501';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles p ON p.oid=m.roleid JOIN pg_roles c ON c.oid=m.member
    WHERE p.rolname='r72_pp_followup_definer' AND c.rolname NOT IN ('r72_owner',current_user)) THEN
    RAISE EXCEPTION 'Runtime membership in PP follow-up function owner denied' USING ERRCODE='42501';
  END IF;
  GRANT r72_pp_followup_definer TO r72_owner;
END $role$;

SET LOCAL ROLE r72_owner;

-- One person (one CRM email endpoint) in one exact published flow version.
CREATE TABLE app_private.pp_followup_runs(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL CHECK(workspace_id='d975ff66-336a-46c2-b36b-d7095a11af97'),
 sequence_item_id uuid NOT NULL,sequence_version_id uuid NOT NULL,
 sequence_sha256 bytea NOT NULL CHECK(octet_length(sequence_sha256)=32),
 sequence_approval_id uuid NOT NULL,owner_user_id uuid NOT NULL,
 contact_id uuid NOT NULL,contact_point_id uuid NOT NULL,
 endpoint_identity_sha256 bytea NOT NULL CHECK(octet_length(endpoint_identity_sha256)=32),
 enrolment_command_id uuid NOT NULL,
 state text NOT NULL CHECK(state IN('active','paused','held','completed','stopped','cancelled','failed')),
 position integer NOT NULL CHECK(position BETWEEN 0 AND 23),due_at timestamptz NOT NULL,
 current_send_id uuid,unknown_ack_proof_id uuid,
 reason text CHECK(reason IS NULL OR reason IN('newer_sequence','content_changed','outcome_unknown','unsubscribed','delivery_expired','delivery_failed','manual','recovery')),
 last_accepted_at timestamptz,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(workspace_id,id),UNIQUE(sequence_version_id,contact_point_id),
 FOREIGN KEY(workspace_id,sequence_item_id,sequence_version_id,sequence_sha256)
  REFERENCES app.company_content_versions(workspace_id,content_item_id,id,content_sha256) ON DELETE RESTRICT,
 FOREIGN KEY(workspace_id,sequence_approval_id) REFERENCES app.company_content_approval_decisions(workspace_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(workspace_id,owner_user_id) REFERENCES app.workspace_memberships(workspace_id,user_id) ON DELETE RESTRICT,
 FOREIGN KEY(workspace_id,contact_point_id,contact_id) REFERENCES app.contact_points(workspace_id,id,contact_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX pp_followup_one_open_run ON app_private.pp_followup_runs(sequence_item_id,contact_point_id) WHERE state IN('active','paused','held');
CREATE INDEX pp_followup_due ON app_private.pp_followup_runs(due_at,id) WHERE state='active';

-- One email step of one run. Never marked sent without a provider message id.
CREATE TABLE app_private.pp_followup_sends(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL CHECK(workspace_id='d975ff66-336a-46c2-b36b-d7095a11af97'),
 run_id uuid NOT NULL REFERENCES app_private.pp_followup_runs(id) ON DELETE RESTRICT,
 step integer NOT NULL CHECK(step BETWEEN 0 AND 23),
 content_item_id uuid NOT NULL,content_version_id uuid NOT NULL,
 content_sha256 bytea NOT NULL CHECK(octet_length(content_sha256)=32),approval_decision_id uuid NOT NULL,
 due_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 100),
 lease_id uuid,lease_until timestamptz,sent_at timestamptz,provider_reference text,
 cancelled_at timestamptz,failed_at timestamptz,held_at timestamptz,hold_reason text,last_failure text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(run_id,step),
 FOREIGN KEY(workspace_id,content_item_id,content_version_id,content_sha256)
  REFERENCES app.company_content_versions(workspace_id,content_item_id,id,content_sha256) ON DELETE RESTRICT,
 FOREIGN KEY(workspace_id,approval_decision_id) REFERENCES app.company_content_approval_decisions(workspace_id,id) ON DELETE RESTRICT,
 CHECK(expires_at>due_at),CHECK(lease_id IS NULL OR lease_until IS NOT NULL),
 CHECK((sent_at IS NULL)=(provider_reference IS NULL)),
 CHECK(provider_reference IS NULL OR length(provider_reference) BETWEEN 1 AND 200),
 CHECK((held_at IS NULL)=(hold_reason IS NULL)),CHECK(hold_reason IS NULL OR hold_reason='recovery'),
 CHECK(last_failure IS NULL OR last_failure='delivery_not_accepted')
);
ALTER TABLE app_private.pp_followup_runs ADD CONSTRAINT pp_followup_current_send_fk
 FOREIGN KEY(current_send_id) REFERENCES app_private.pp_followup_sends(id) ON DELETE RESTRICT;

-- One verified handoff per send lease, written before the provider call.
CREATE TABLE app_private.pp_followup_dispatch_proofs(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL CHECK(workspace_id='d975ff66-336a-46c2-b36b-d7095a11af97'),
 send_id uuid NOT NULL REFERENCES app_private.pp_followup_sends(id) ON DELETE RESTRICT,lease_id uuid NOT NULL,
 content_version_id uuid NOT NULL,content_sha256 bytea NOT NULL CHECK(octet_length(content_sha256)=32),
 approval_decision_id uuid NOT NULL,endpoint_identity_sha256 bytea NOT NULL CHECK(octet_length(endpoint_identity_sha256)=32),
 observed_session_user text NOT NULL,
 checked_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL,
 accepted boolean,provider_reference text,completed_at timestamptz,
 UNIQUE(send_id,lease_id),
 CHECK(expires_at>checked_at AND expires_at<=checked_at+interval '15 minutes'),
 CHECK((accepted IS NULL)=(completed_at IS NULL)),
 CHECK(provider_reference IS NULL OR length(provider_reference) BETWEEN 1 AND 200),
 CHECK(accepted IS DISTINCT FROM true OR provider_reference IS NOT NULL)
);
ALTER TABLE app_private.pp_followup_runs ADD CONSTRAINT pp_followup_unknown_ack_fk
 FOREIGN KEY(unknown_ack_proof_id) REFERENCES app_private.pp_followup_dispatch_proofs(id) ON DELETE RESTRICT;

-- Owner command idempotency, private to this feature.
CREATE TABLE app_private.pp_followup_commands(
 workspace_id uuid NOT NULL CHECK(workspace_id='d975ff66-336a-46c2-b36b-d7095a11af97'),
 actor_user_id uuid NOT NULL,action text NOT NULL CHECK(action IN('enrol','pause','resume','cancel','stop')),
 command_id uuid NOT NULL,payload_sha256 bytea NOT NULL CHECK(octet_length(payload_sha256)=32),
 request_id text NOT NULL CHECK(request_id~'^[!-~]{1,128}$'),result jsonb CHECK(result IS NULL OR jsonb_typeof(result)='object'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),completed_at timestamptz,
 PRIMARY KEY(workspace_id,actor_user_id,action,command_id),
 FOREIGN KEY(workspace_id,actor_user_id) REFERENCES app.workspace_memberships(workspace_id,user_id) ON DELETE RESTRICT,
 CHECK((result IS NULL)=(completed_at IS NULL))
);

DO $tables$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pp_followup_runs','pp_followup_sends','pp_followup_dispatch_proofs','pp_followup_commands'] LOOP
    EXECUTE format('ALTER TABLE app_private.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE app_private.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON app_private.%I FROM PUBLIC',t);
    EXECUTE format('CREATE POLICY %I ON app_private.%I TO r72_owner USING(true) WITH CHECK(true)',t||'_owner',t);
    EXECUTE format('CREATE POLICY %I ON app_private.%I TO r72_pp_followup_definer USING(workspace_id=''d975ff66-336a-46c2-b36b-d7095a11af97'') WITH CHECK(workspace_id=''d975ff66-336a-46c2-b36b-d7095a11af97'')',t||'_definer',t);
    INSERT INTO app_private.workspace_table_registry(schema_name,table_name,workspace_column) VALUES('app_private',t,'workspace_id');
  END LOOP;
END $tables$;
GRANT SELECT,INSERT,UPDATE ON app_private.pp_followup_runs,app_private.pp_followup_sends,app_private.pp_followup_commands TO r72_pp_followup_definer;
GRANT SELECT,INSERT ON app_private.pp_followup_dispatch_proofs TO r72_pp_followup_definer;
GRANT UPDATE(accepted,provider_reference,completed_at) ON app_private.pp_followup_dispatch_proofs TO r72_pp_followup_definer;

CREATE FUNCTION app_private.pp_followup_proof_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $f$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'PP follow-up dispatch proof is immutable' USING ERRCODE='42501'; END IF;
 IF OLD.accepted IS NOT NULL OR NEW.accepted IS NULL OR NEW.completed_at IS NULL
  OR (to_jsonb(OLD)-ARRAY['accepted','provider_reference','completed_at']) IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['accepted','provider_reference','completed_at'])
 THEN RAISE EXCEPTION 'PP follow-up dispatch proof identity is immutable' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $f$;
REVOKE ALL ON FUNCTION app_private.pp_followup_proof_immutable() FROM PUBLIC;
CREATE TRIGGER pp_followup_proof_immutable BEFORE UPDATE OR DELETE ON app_private.pp_followup_dispatch_proofs
 FOR EACH ROW EXECUTE FUNCTION app_private.pp_followup_proof_immutable();

-- Exact reads of the PP workspace only: its flow and owner-email content, approvals, CRM email endpoints and
-- permission ledger. The one write outside this feature's tables is an unsubscribe suppression event.
GRANT USAGE ON SCHEMA app,app_private TO r72_pp_followup_definer;
GRANT SELECT ON app.company_content_versions,app.company_content_source_attestations,app.company_content_approval_requests,
 app.company_content_approval_decisions,app.contacts,app.contact_points,app.communication_consent_events,app.communication_suppression_events
 TO r72_pp_followup_definer;
GRANT INSERT ON app.communication_suppression_events TO r72_pp_followup_definer;
CREATE POLICY pp_followup_versions_read ON app.company_content_versions FOR SELECT TO r72_pp_followup_definer
 USING(workspace_id='d975ff66-336a-46c2-b36b-d7095a11af97' AND source_system IN('pp.followup-sequence','pp.owner-email'));
DO $policies$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['company_content_source_attestations','company_content_approval_requests','company_content_approval_decisions'] LOOP
  EXECUTE format('CREATE POLICY pp_followup_local_read ON app.%I FOR SELECT TO r72_pp_followup_definer USING (
   workspace_id=''d975ff66-336a-46c2-b36b-d7095a11af97'' AND EXISTS(SELECT 1 FROM app.company_content_versions v
    WHERE v.workspace_id=%I.workspace_id AND v.id=%I.content_version_id AND v.source_system IN(''pp.followup-sequence'',''pp.owner-email'')))',t,t,t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['contacts','contact_points','communication_consent_events','communication_suppression_events'] LOOP
  EXECUTE format('CREATE POLICY pp_followup_read ON app.%I FOR SELECT TO r72_pp_followup_definer USING(workspace_id=''d975ff66-336a-46c2-b36b-d7095a11af97'')',t);
 END LOOP;
END $policies$;
CREATE POLICY pp_followup_unsubscribe ON app.communication_suppression_events FOR INSERT TO r72_pp_followup_definer
 WITH CHECK(workspace_id='d975ff66-336a-46c2-b36b-d7095a11af97' AND channel='email' AND purpose='marketing' AND state='suppressed'
  AND reason='recipient_unsubscribe' AND source='pp.followup.unsubscribe' AND actor_kind='system' AND actor_user_id IS NULL);
GRANT EXECUTE ON FUNCTION app_private.resolve_portal_session(bytea),app_private.lock_active_portal_session(bytea,uuid,uuid),
 app_private.can_manage_workspace(uuid,uuid) TO r72_pp_followup_definer;
GRANT CREATE ON SCHEMA app_private TO r72_pp_followup_definer;
SET LOCAL ROLE r72_pp_followup_definer;

-- Same canonical JSON as the TypeScript company-content writer (sorted keys, integral numbers).
CREATE FUNCTION app_private.pp_followup_canonical(p jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $f$
DECLARE result text; kind text:=jsonb_typeof(p);
BEGIN
 IF kind='object' THEN SELECT '{'||coalesce(string_agg(to_json(k)::text||':'||app_private.pp_followup_canonical(v),',' ORDER BY k COLLATE "C"),'')||'}' INTO result FROM jsonb_each(p) AS x(k,v);
 ELSIF kind='array' THEN SELECT '['||coalesce(string_agg(app_private.pp_followup_canonical(v),',' ORDER BY n),'')||']' INTO result FROM jsonb_array_elements(p) WITH ORDINALITY AS x(v,n);
 ELSIF kind='string' THEN result:=to_json(p#>>'{}')::text;
 ELSIF kind='number' AND (p::text)::numeric=trunc((p::text)::numeric) THEN result:=trunc((p::text)::numeric)::text;
 ELSE result:=p::text; END IF;
 RETURN result;
END $f$;

-- A selected PP portal session of an active owner/admin. p_lock serialises owner commands with session revocation.
CREATE FUNCTION app_private.pp_followup_authorize(p_session bytea,p_lock boolean) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; selected uuid;
BEGIN
 IF p_session IS NULL OR octet_length(p_session)<>32 OR p_lock IS NULL THEN RAISE EXCEPTION 'Invalid owner session' USING ERRCODE='42501'; END IF;
 SELECT r.user_id,r.selected_workspace_id INTO actor,selected FROM app_private.resolve_portal_session(p_session) r;
 IF actor IS NULL OR selected IS DISTINCT FROM 'd975ff66-336a-46c2-b36b-d7095a11af97'::uuid OR NOT app_private.can_manage_workspace(actor,selected)
  OR (p_lock AND NOT app_private.lock_active_portal_session(p_session,actor,selected))
 THEN RAISE EXCEPTION 'Selected Property Predator owner session required' USING ERRCODE='42501'; END IF;
 RETURN actor;
END $f$;

-- Shared provenance check for a local PP version: bytes, inline blob, manifest, brand digest, attestation,
-- latest-version and approval-by-a-current-manager rules. Brand currency is rechecked by the portal at enrolment.
CREATE FUNCTION app_private.pp_followup_local_exact(p_version uuid,p_source text,p_approved boolean,p_latest boolean) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE v app.company_content_versions%ROWTYPE; local jsonb; manifest jsonb; digest bytea; decision uuid; expected jsonb; meta_key text;
BEGIN
 IF p_source NOT IN('pp.followup-sequence','pp.owner-email') THEN RAISE EXCEPTION 'Invalid PP source' USING ERRCODE='22023'; END IF;
 SELECT * INTO v FROM app.company_content_versions WHERE id=p_version AND workspace_id='d975ff66-336a-46c2-b36b-d7095a11af97' AND source_system=p_source;
 IF NOT FOUND OR v.source_version!~'^edit:[0-9a-f-]{36}$'
  OR (p_source='pp.followup-sequence' AND (v.content_kind<>'other' OR v.content_mime_type<>'application/vnd.growthhq.followup-sequence+json' OR v.source_item_id!~'^sequence:[0-9a-f-]{36}$'))
  OR (p_source='pp.owner-email' AND (v.content_kind<>'email' OR v.content_mime_type<>'application/vnd.propertypredator.email-draft+json' OR v.source_item_id!~'^owner-email:[0-9a-f-]{36}$'))
 THEN RAISE EXCEPTION 'Invalid PP local version' USING ERRCODE='23514'; END IF;
 meta_key:=CASE p_source WHEN 'pp.followup-sequence' THEN 'flowSequence' ELSE 'flowMessage' END;
 local:=v.metadata->meta_key;
 IF jsonb_typeof(local) IS DISTINCT FROM 'object' OR local->>'authoredBy' IS DISTINCT FROM 'native-owner'
  OR local->>'schema' IS DISTINCT FROM (CASE p_source WHEN 'pp.followup-sequence' THEN 'growthhq.local-sequence/v1' ELSE 'growthhq.local-message/v1' END)
  OR jsonb_typeof(local->'brandCanonical') IS DISTINCT FROM 'string' OR jsonb_typeof(local->'manifestCanonical') IS DISTINCT FROM 'string'
  OR app_private.pp_followup_canonical(v.content_body::jsonb)<>v.content_body OR public.digest(v.content_body,'sha256')<>v.content_sha256
  OR v.blob_sha256<>v.content_sha256 OR v.blob_storage_key<>'inline:'||p_source||':'||encode(v.content_sha256,'hex')
  OR public.digest(local->>'brandCanonical','sha256')<>v.brand_sha256
  OR v.brand_snapshot_ref IS DISTINCT FROM 'native-organization-brand/v1:'||coalesce((local->>'brandCanonical')::jsonb->>'organizationId','')||':'||encode(v.brand_sha256,'hex')
 THEN RAISE EXCEPTION 'PP local bytes or provenance mismatch' USING ERRCODE='23514'; END IF;
 manifest:=(local->>'manifestCanonical')::jsonb; digest:=public.digest(local->>'manifestCanonical','sha256');
 expected:=jsonb_build_object('schema',CASE p_source WHEN 'pp.followup-sequence' THEN 'pp.followup-sequence-source/v1' ELSE 'pp.owner-message-source/v1' END,
  'workspaceId',v.workspace_id::text,'sourceSystem',v.source_system,'sourceItemId',v.source_item_id,'sourceVersion',v.source_version,
  'contentSha256',encode(v.content_sha256,'hex'),'blobStorageKey',v.blob_storage_key,'blobSha256',encode(v.blob_sha256,'hex'),
  'brandSnapshotRef',v.brand_snapshot_ref,'brandSha256',encode(v.brand_sha256,'hex'))
  ||CASE p_source WHEN 'pp.followup-sequence' THEN jsonb_build_object('audienceCampaign','pp-owner-followup') ELSE jsonb_build_object('channel','email') END;
 IF app_private.pp_followup_canonical(manifest) IS DISTINCT FROM local->>'manifestCanonical' OR manifest IS DISTINCT FROM expected
  OR local->>'manifestSha256' IS DISTINCT FROM encode(digest,'hex')
 THEN RAISE EXCEPTION 'PP local source manifest mismatch' USING ERRCODE='23514'; END IF;
 IF p_approved AND NOT EXISTS(SELECT 1 FROM app.company_content_source_attestations a WHERE a.workspace_id=v.workspace_id AND a.content_version_id=v.id
  AND a.source_catalog_sha256=digest AND a.content_sha256=v.content_sha256 AND a.blob_sha256=v.blob_sha256 AND a.brand_sha256=v.brand_sha256)
 THEN RAISE EXCEPTION 'PP local source observation missing' USING ERRCODE='23514'; END IF;
 IF p_latest AND EXISTS(SELECT 1 FROM app.company_content_versions n WHERE n.workspace_id=v.workspace_id AND n.content_item_id=v.content_item_id AND n.version_number>v.version_number)
 THEN RAISE EXCEPTION 'A newer PP draft exists' USING ERRCODE='23514'; END IF;
 SELECT d.id INTO decision FROM app.company_content_approval_decisions d
 JOIN app.company_content_approval_requests r ON r.workspace_id=d.workspace_id AND r.id=d.approval_request_id
 WHERE d.workspace_id=v.workspace_id AND d.content_version_id=v.id AND d.content_sha256=v.content_sha256 AND d.decision='approved'
  AND app_private.can_manage_workspace(d.decided_by_user_id,d.workspace_id)
  AND r.request_number=(SELECT max(latest.request_number) FROM app.company_content_approval_requests latest WHERE latest.workspace_id=v.workspace_id AND latest.content_version_id=v.id)
 ORDER BY d.decided_at DESC,d.id DESC LIMIT 1;
 IF p_approved AND decision IS NULL THEN RAISE EXCEPTION 'Latest owner approval required' USING ERRCODE='23514'; END IF;
 IF NOT app_private.can_manage_workspace(v.created_by_user_id,v.workspace_id) THEN RAISE EXCEPTION 'Current author permission required' USING ERRCODE='42501'; END IF;
 RETURN jsonb_build_object('contentItemId',v.content_item_id,'contentVersionId',v.id,'versionNumber',v.version_number,'title',v.title,
  'canonicalContent',v.content_body,'contentSha256',encode(v.content_sha256,'hex'),'manifestSha256',encode(digest,'hex'),'approvalDecisionId',decision);
END $f$;

-- One PP owner email: the canonical propertypredator.email-draft/v1 shape on top of the shared provenance check.
CREATE FUNCTION app_private.pp_followup_message_exact(p_version uuid,p_approved boolean,p_latest boolean) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE exact jsonb; body jsonb;
BEGIN
 exact:=app_private.pp_followup_local_exact(p_version,'pp.owner-email',p_approved,p_latest);
 body:=(exact->>'canonicalContent')::jsonb;
 IF jsonb_typeof(body) IS DISTINCT FROM 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(body) k) IS DISTINCT FROM ARRAY['bodyText','schema','subject']
  OR body->>'schema'<>'propertypredator.email-draft/v1' OR jsonb_typeof(body->'subject') IS DISTINCT FROM 'string'
  OR jsonb_typeof(body->'bodyText') IS DISTINCT FROM 'string' OR length(body->>'subject') NOT BETWEEN 1 AND 500 OR body->>'subject'~'[[:cntrl:]]'
  OR length(btrim(body->>'bodyText'))=0 OR octet_length(body->>'bodyText')>50000
 THEN RAISE EXCEPTION 'Invalid canonical PP email copy' USING ERRCODE='23514'; END IF;
 RETURN exact;
END $f$;

-- One PP flow: the shared growthhq.followup-sequence contract (v1, or v2 with manual owner entry). When approved,
-- every message step must be an approved latest PP email and no unconnected automatic stop may be selected.
CREATE FUNCTION app_private.pp_followup_sequence_exact(p_version uuid,p_approved boolean,p_latest boolean) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE exact jsonb; d jsonb; step jsonb; keys text[]; step_keys text[]:='{}'; total_wait bigint:=0; messages integer:=0; email jsonb;
BEGIN
 exact:=app_private.pp_followup_local_exact(p_version,'pp.followup-sequence',p_approved,p_latest);
 d:=(exact->>'canonicalContent')::jsonb;
 SELECT array_agg(k ORDER BY k) INTO keys FROM jsonb_object_keys(d) k;
 IF NOT((d->>'schema'='growthhq.followup-sequence/v1' AND keys IS NOT DISTINCT FROM ARRAY['brand','campaign','expiryHours','schema','steps','stopOn','title'])
   OR (d->>'schema'='growthhq.followup-sequence/v2' AND keys IS NOT DISTINCT FROM ARRAY['brand','campaign','entry','expiryHours','schema','steps','stopOn','title']
    AND d->'entry' IS NOT DISTINCT FROM '{"mode":"manual","source":"manual_owner"}'::jsonb))
  OR d->>'brand' IS DISTINCT FROM 'pp' OR d->>'campaign' IS DISTINCT FROM 'pp-owner-followup' OR d->>'title' IS DISTINCT FROM exact->>'title'
  OR jsonb_typeof(d->'expiryHours') IS DISTINCT FROM 'number' OR (d->>'expiryHours')!~'^[0-9]+$' OR (d->>'expiryHours')::integer NOT BETWEEN 1 AND 168
  OR jsonb_typeof(d->'stopOn') IS DISTINCT FROM 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(d->'stopOn') k) IS DISTINCT FROM ARRAY['booked','purchased','reply']
  OR EXISTS(SELECT 1 FROM jsonb_each(d->'stopOn') x WHERE jsonb_typeof(x.value)<>'boolean')
  OR jsonb_typeof(d->'steps') IS DISTINCT FROM 'array' OR jsonb_array_length(d->'steps') NOT BETWEEN 1 AND 24
 THEN RAISE EXCEPTION 'Invalid PP flow definition' USING ERRCODE='23514'; END IF;
 FOR step IN SELECT value FROM jsonb_array_elements(d->'steps') LOOP
  IF jsonb_typeof(step)<>'object' OR step->>'key' IS NULL OR step->>'key'!~'^[a-z][a-z0-9_-]{0,49}$' OR step->>'key'=ANY(step_keys)
  THEN RAISE EXCEPTION 'Invalid PP flow step identity' USING ERRCODE='23514'; END IF;
  step_keys:=array_append(step_keys,step->>'key');
  SELECT array_agg(k ORDER BY k) INTO keys FROM jsonb_object_keys(step) k;
  IF step->>'kind'='wait' THEN
   IF keys IS DISTINCT FROM ARRAY['key','kind','minutes'] OR jsonb_typeof(step->'minutes')<>'number' OR (step->>'minutes')!~'^[0-9]+$'
    OR (step->>'minutes')::bigint NOT BETWEEN 0 AND 525600 THEN RAISE EXCEPTION 'Invalid PP wait' USING ERRCODE='23514'; END IF;
   total_wait:=total_wait+(step->>'minutes')::bigint;
  ELSE
   IF keys IS DISTINCT FROM ARRAY['contentItemId','contentSha256','contentVersionId','key','kind'] OR step->>'kind' IS NULL OR step->>'kind' NOT IN('email','sms','whatsapp')
    OR step->>'contentItemId'!~'^[0-9a-f-]{36}$' OR step->>'contentVersionId'!~'^[0-9a-f-]{36}$' OR step->>'contentSha256'!~'^[0-9a-f]{64}$'
   THEN RAISE EXCEPTION 'Invalid PP message reference' USING ERRCODE='23514'; END IF;
   IF p_approved THEN
    IF step->>'kind'<>'email' THEN RAISE EXCEPTION 'This PP message channel is not connected' USING ERRCODE='23514'; END IF;
    email:=app_private.pp_followup_message_exact((step->>'contentVersionId')::uuid,true,true);
    IF email->>'contentItemId'<>step->>'contentItemId' OR email->>'contentSha256'<>step->>'contentSha256'
    THEN RAISE EXCEPTION 'PP message reference changed' USING ERRCODE='23514'; END IF;
   END IF;
   messages:=messages+1;
  END IF;
 END LOOP;
 IF messages=0 OR step->>'kind'='wait' OR total_wait>525600 THEN RAISE EXCEPTION 'Invalid PP flow timeline' USING ERRCODE='23514'; END IF;
 IF p_approved AND EXISTS(SELECT 1 FROM jsonb_each(d->'stopOn') x WHERE x.value='true'::jsonb)
 THEN RAISE EXCEPTION 'Selected automatic stop source is not connected' USING ERRCODE='23514'; END IF;
 RETURN exact||jsonb_build_object('definition',d);
END $f$;

-- Current endpoint for a PP CRM email contact point (null when deleted, quarantined, shared or archived).
CREATE FUNCTION app_private.pp_followup_endpoint(p_point uuid) RETURNS TABLE(contact_id uuid,email text,display_name text,identity_sha256 bytea)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT p.contact_id,p.normalized_value,c.display_name,public.digest(p.kind||chr(31)||p.value||chr(31)||p.normalized_value,'sha256')
 FROM app.contact_points p JOIN app.contacts c ON c.workspace_id=p.workspace_id AND c.id=p.contact_id
 WHERE p.workspace_id='d975ff66-336a-46c2-b36b-d7095a11af97' AND p.id=p_point AND p.kind='email' AND p.deleted_at IS NULL
  AND p.dedupe_state='normal' AND c.deleted_at IS NULL AND c.lifecycle_status<>'archived'
$f$;

-- Permission for marketing email to exactly this endpoint identity: no active email suppression (any purpose-free or
-- marketing scope) and the latest email/marketing consent is granted. The mutable consent_status column is never used.
CREATE FUNCTION app_private.pp_followup_endpoint_allowed(p_point uuid,p_identity bytea) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT EXISTS(SELECT 1 FROM app_private.pp_followup_endpoint(p_point) e WHERE e.identity_sha256=p_identity)
  AND NOT EXISTS(SELECT 1 FROM(SELECT DISTINCT ON(coalesce(s.purpose,'')) s.state FROM app.communication_suppression_events s
   WHERE s.workspace_id='d975ff66-336a-46c2-b36b-d7095a11af97' AND s.contact_point_id=p_point AND s.channel='email'
    AND(s.purpose IS NULL OR s.purpose='marketing') AND s.endpoint_identity_sha256=p_identity AND s.occurred_at<=statement_timestamp()+interval '5 minutes'
   ORDER BY coalesce(s.purpose,''),s.occurred_at DESC,s.recorded_at DESC,s.id DESC) latest WHERE latest.state='suppressed')
  AND coalesce((SELECT c.state='granted' FROM app.communication_consent_events c
   WHERE c.workspace_id='d975ff66-336a-46c2-b36b-d7095a11af97' AND c.contact_point_id=p_point AND c.channel='email' AND c.purpose='marketing'
    AND c.endpoint_identity_sha256=p_identity AND c.occurred_at<=statement_timestamp()+interval '5 minutes'
   ORDER BY c.occurred_at DESC,c.recorded_at DESC,c.id DESC LIMIT 1),false)
$f$;

CREATE FUNCTION app_private.pp_followup_next(p_definition jsonb,p_position integer,p_accepted timestamptz) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $f$
DECLARE step record; waiting integer:=0;
BEGIN
 FOR step IN SELECT value,ordinality::integer-1 AS position FROM jsonb_array_elements(p_definition->'steps') WITH ORDINALITY WHERE ordinality-1>p_position ORDER BY ordinality LOOP
  IF step.value->>'kind'='wait' THEN waiting:=waiting+(step.value->>'minutes')::integer;
  ELSE RETURN jsonb_build_object('position',step.position,'dueAt',p_accepted+make_interval(mins=>waiting)); END IF;
 END LOOP;
 RETURN NULL;
END $f$;

-- Stop one run for a terminal permission/content reason and cancel its unleased unsent step.
CREATE FUNCTION app_private.pp_followup_end_run(p_run uuid,p_state text,p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 IF p_state NOT IN('stopped','cancelled','failed') THEN RAISE EXCEPTION 'Invalid PP run end' USING ERRCODE='22023'; END IF;
 UPDATE app_private.pp_followup_runs SET state=p_state,reason=coalesce(p_reason,reason),updated_at=clock_timestamp() WHERE id=p_run;
 UPDATE app_private.pp_followup_sends SET cancelled_at=clock_timestamp() WHERE run_id=p_run AND sent_at IS NULL AND cancelled_at IS NULL AND failed_at IS NULL
  AND (lease_until IS NULL OR lease_until<=clock_timestamp());
END $f$;

CREATE FUNCTION app_private.pp_followup_snapshot(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE runs jsonb; contacts jsonb; permitted integer;
BEGIN
 PERFORM app_private.pp_followup_authorize(p_session,false);
 SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY q."createdAt" DESC,q.id DESC),'[]') INTO runs FROM(
  SELECT r.id,r.sequence_item_id AS "contentItemId",r.sequence_version_id AS "contentVersionId",r.contact_id AS "contactId",
   r.contact_point_id AS "contactPointId",p.normalized_value AS email,c.display_name AS "displayName",
   r.state,r.position,r.due_at AS "dueAt",r.reason,r.created_at AS "createdAt",r.last_accepted_at AS "lastAcceptedAt",
   coalesce(s.lease_until>statement_timestamp() AND s.sent_at IS NULL AND s.lease_id IS NOT NULL,false) AS "inFlight",
   CASE WHEN proof.accepted IS NULL AND proof.id IS DISTINCT FROM r.unknown_ack_proof_id THEN proof.id END AS "unknownProofId",
   coalesce((SELECT jsonb_agg(jsonb_build_object('position',j.step,'acceptedAt',j.sent_at,'dueAt',j.due_at,'expiresAt',j.expires_at,
    'cancelled',j.cancelled_at IS NOT NULL,'failed',j.failed_at IS NOT NULL,'held',j.held_at IS NOT NULL,
    'inFlight',j.lease_id IS NOT NULL AND j.lease_until>statement_timestamp() AND j.sent_at IS NULL) ORDER BY j.step)
    FROM app_private.pp_followup_sends j WHERE j.run_id=r.id),'[]') AS steps
  FROM app_private.pp_followup_runs r JOIN app.contact_points p ON p.workspace_id=r.workspace_id AND p.id=r.contact_point_id
  JOIN app.contacts c ON c.workspace_id=r.workspace_id AND c.id=r.contact_id
  LEFT JOIN app_private.pp_followup_sends s ON s.id=r.current_send_id
  LEFT JOIN LATERAL(SELECT x.id,x.accepted FROM app_private.pp_followup_dispatch_proofs x WHERE x.send_id=s.id ORDER BY x.checked_at DESC,x.id DESC LIMIT 1) proof ON true
  ORDER BY r.created_at DESC,r.id DESC LIMIT 100)q;
 -- People who can be enrolled now: a granted email/marketing consent on the current endpoint and no suppression.
 SELECT count(*) INTO permitted FROM app.contact_points p WHERE p.workspace_id='d975ff66-336a-46c2-b36b-d7095a11af97' AND p.kind='email' AND p.deleted_at IS NULL
  AND EXISTS(SELECT 1 FROM app.communication_consent_events g WHERE g.workspace_id=p.workspace_id AND g.contact_point_id=p.id AND g.channel='email' AND g.purpose='marketing' AND g.state='granted')
  AND EXISTS(SELECT 1 FROM app_private.pp_followup_endpoint(p.id) e WHERE app_private.pp_followup_endpoint_allowed(p.id,e.identity_sha256));
 SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY q."displayName",q."contactPointId"),'[]') INTO contacts FROM(
  SELECT e.contact_id AS "contactId",p.id AS "contactPointId",e.display_name AS "displayName",e.email,
   EXISTS(SELECT 1 FROM app_private.pp_followup_runs o WHERE o.contact_point_id=p.id AND o.state IN('active','paused','held')) AS "inOpenRun"
  FROM app.contact_points p CROSS JOIN LATERAL app_private.pp_followup_endpoint(p.id) e
  WHERE p.workspace_id='d975ff66-336a-46c2-b36b-d7095a11af97' AND p.kind='email' AND p.deleted_at IS NULL
   AND EXISTS(SELECT 1 FROM app.communication_consent_events g WHERE g.workspace_id=p.workspace_id AND g.contact_point_id=p.id AND g.channel='email' AND g.purpose='marketing' AND g.state='granted')
   AND app_private.pp_followup_endpoint_allowed(p.id,e.identity_sha256)
  ORDER BY e.display_name,p.id LIMIT 200)q;
 RETURN jsonb_build_object('campaign','pp-owner-followup','permitted',permitted,'contacts',contacts,'runs',runs,
  'runCount',(SELECT count(*) FROM app_private.pp_followup_runs));
END $f$;

CREATE FUNCTION app_private.pp_followup_command(p_session bytea,p_action text,p_command uuid,p_version uuid,p_point uuid,p_run uuid,p_ack_proof uuid,p_request text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; item uuid; exact jsonb; next jsonb; payload jsonb; prior app_private.pp_followup_commands%ROWTYPE; r app_private.pp_followup_runs%ROWTYPE;
 q app_private.pp_followup_sends%ROWTYPE; proof app_private.pp_followup_dispatch_proofs%ROWTYPE; endpoint record;
 changed integer:=0; remaining integer:=0; blocked integer:=0; flying integer:=0; outcome jsonb; why text;
BEGIN
 actor:=app_private.pp_followup_authorize(p_session,true);
 IF p_action IS NULL OR p_action NOT IN('enrol','pause','resume','cancel','stop') OR p_command IS NULL OR p_version IS NULL
  OR p_request IS NULL OR p_request!~'^[!-~]{1,128}$' OR (p_action='enrol')<>(p_point IS NOT NULL) OR (p_action='enrol' AND p_run IS NOT NULL)
  OR (p_ack_proof IS NOT NULL AND (p_action<>'resume' OR p_run IS NULL))
 THEN RAISE EXCEPTION 'Invalid PP flow action' USING ERRCODE='22023'; END IF;
 SELECT content_item_id INTO item FROM app.company_content_versions WHERE workspace_id='d975ff66-336a-46c2-b36b-d7095a11af97' AND id=p_version AND source_system='pp.followup-sequence';
 IF item IS NULL THEN RAISE EXCEPTION 'PP flow unavailable' USING ERRCODE='23514'; END IF;
 payload:=jsonb_build_object('version',p_version,'point',p_point,'run',p_run,'ackProof',p_ack_proof);
 PERFORM pg_advisory_xact_lock(hashtextextended('pp-followup-command:'||actor::text||':'||p_action||':'||p_command::text,7200152));
 SELECT * INTO prior FROM app_private.pp_followup_commands WHERE workspace_id='d975ff66-336a-46c2-b36b-d7095a11af97' AND actor_user_id=actor AND action=p_action AND command_id=p_command;
 IF FOUND THEN
  IF prior.payload_sha256<>public.digest(payload::text,'sha256') OR prior.result IS NULL THEN RAISE EXCEPTION 'PP flow command input changed' USING ERRCODE='23514'; END IF;
  RETURN prior.result||jsonb_build_object('replayed',true);
 END IF;
 IF p_action='enrol' THEN
  exact:=app_private.pp_followup_sequence_exact(p_version,true,true);
  SELECT * INTO endpoint FROM app_private.pp_followup_endpoint(p_point);
  IF endpoint.contact_id IS NULL OR NOT app_private.pp_followup_endpoint_allowed(p_point,endpoint.identity_sha256) THEN blocked:=1; why:='not_permitted';
  ELSIF EXISTS(SELECT 1 FROM app_private.pp_followup_runs o WHERE o.sequence_version_id=p_version AND o.contact_point_id=p_point) THEN blocked:=1; why:='already_enrolled';
  ELSIF EXISTS(SELECT 1 FROM app_private.pp_followup_runs o WHERE o.sequence_item_id=item AND o.contact_point_id=p_point AND o.state IN('active','paused','held')) THEN blocked:=1; why:='older_version_open';
  ELSE
   next:=app_private.pp_followup_next(exact->'definition',-1,clock_timestamp());
   INSERT INTO app_private.pp_followup_runs(workspace_id,sequence_item_id,sequence_version_id,sequence_sha256,sequence_approval_id,owner_user_id,
    contact_id,contact_point_id,endpoint_identity_sha256,enrolment_command_id,state,position,due_at)
   VALUES('d975ff66-336a-46c2-b36b-d7095a11af97',item,p_version,decode(exact->>'contentSha256','hex'),(exact->>'approvalDecisionId')::uuid,actor,
    endpoint.contact_id,p_point,endpoint.identity_sha256,p_command,'active',(next->>'position')::integer,(next->>'dueAt')::timestamptz)
   ON CONFLICT DO NOTHING;
   GET DIAGNOSTICS changed=ROW_COUNT;
   IF changed=0 THEN blocked:=1; why:='already_enrolled'; END IF;
  END IF;
 ELSE
  FOR r IN SELECT * FROM app_private.pp_followup_runs WHERE sequence_item_id=item AND (p_run IS NULL OR id=p_run)
   AND CASE p_action WHEN 'pause' THEN state='active' WHEN 'resume' THEN state IN('paused','held') ELSE state IN('active','paused','held') END ORDER BY id LIMIT 500 LOOP
   SELECT * INTO r FROM app_private.pp_followup_runs WHERE id=r.id FOR UPDATE;
   IF r.state NOT IN('active','paused','held') THEN CONTINUE; END IF;
   IF r.current_send_id IS NOT NULL THEN SELECT * INTO q FROM app_private.pp_followup_sends WHERE id=r.current_send_id FOR UPDATE; ELSE q:=NULL; END IF;
   IF q.lease_id IS NOT NULL AND q.lease_until>clock_timestamp() AND q.sent_at IS NULL THEN flying:=flying+1; END IF;
   IF p_action='resume' THEN
    BEGIN exact:=app_private.pp_followup_sequence_exact(r.sequence_version_id,true,true);
    EXCEPTION WHEN check_violation OR insufficient_privilege THEN blocked:=blocked+1;CONTINUE; END;
    IF decode(exact->>'contentSha256','hex')<>r.sequence_sha256 OR NOT app_private.pp_followup_endpoint_allowed(r.contact_point_id,r.endpoint_identity_sha256)
     OR (q.expires_at IS NOT NULL AND q.expires_at<=clock_timestamp()) THEN blocked:=blocked+1;CONTINUE; END IF;
    proof:=NULL;
    SELECT * INTO proof FROM app_private.pp_followup_dispatch_proofs WHERE send_id=r.current_send_id ORDER BY checked_at DESC,id DESC LIMIT 1;
    IF proof.id IS NOT NULL AND proof.accepted IS NULL AND proof.id IS DISTINCT FROM r.unknown_ack_proof_id THEN
     IF p_ack_proof IS DISTINCT FROM proof.id OR q.lease_until>clock_timestamp() THEN blocked:=blocked+1;CONTINUE; END IF;
    ELSIF p_ack_proof IS NOT NULL THEN RAISE EXCEPTION 'Unknown attempt changed; refresh before retrying' USING ERRCODE='23514'; END IF;
    -- A resumed run follows the current exact approval decision of the same pinned bytes.
    UPDATE app_private.pp_followup_runs SET state='active',reason=NULL,sequence_approval_id=(exact->>'approvalDecisionId')::uuid,
     unknown_ack_proof_id=coalesce(p_ack_proof,unknown_ack_proof_id),updated_at=clock_timestamp() WHERE id=r.id;
    UPDATE app_private.pp_followup_sends SET held_at=NULL,hold_reason=NULL WHERE run_id=r.id AND sent_at IS NULL AND cancelled_at IS NULL AND failed_at IS NULL
     AND hold_reason='recovery' AND (lease_until IS NULL OR lease_until<=clock_timestamp());
   ELSIF p_action='pause' THEN
    UPDATE app_private.pp_followup_runs SET state='paused',updated_at=clock_timestamp() WHERE id=r.id;
   ELSE
    PERFORM app_private.pp_followup_end_run(r.id,CASE p_action WHEN 'stop' THEN 'stopped' ELSE 'cancelled' END,CASE WHEN p_action='stop' THEN 'manual' END);
   END IF;
   changed:=changed+1;
  END LOOP;
  SELECT count(*) INTO remaining FROM app_private.pp_followup_runs WHERE sequence_item_id=item AND (p_run IS NULL OR id=p_run)
   AND CASE p_action WHEN 'pause' THEN state='active' WHEN 'resume' THEN state IN('paused','held') ELSE state IN('active','paused','held') END;
 END IF;
 outcome:=jsonb_build_object('action',p_action,'contentItemId',item,'contentVersionId',p_version,'changed',changed,'remaining',remaining,
  'blocked',blocked,'inFlight',flying,'reason',why,'replayed',false);
 INSERT INTO app_private.pp_followup_commands(workspace_id,actor_user_id,action,command_id,payload_sha256,request_id,result,completed_at)
 VALUES('d975ff66-336a-46c2-b36b-d7095a11af97',actor,p_action,p_command,public.digest(payload::text,'sha256'),p_request,outcome,clock_timestamp());
 RETURN outcome;
END $f$;

CREATE FUNCTION app_private.pp_followup_claim(p_limit integer,p_lease_seconds integer,p_only_emails text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE candidate record; r app_private.pp_followup_runs%ROWTYPE; q app_private.pp_followup_sends%ROWTYPE; proof app_private.pp_followup_dispatch_proofs%ROWTYPE;
 exact jsonb; message jsonb; email jsonb; claimed jsonb:='[]'; lease uuid; until_at timestamptz; expiry timestamptz;
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 25 OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 900
  OR (p_only_emails IS NOT NULL AND cardinality(p_only_emails) NOT BETWEEN 1 AND 20) THEN RAISE EXCEPTION 'Invalid PP follow-up claim' USING ERRCODE='22023'; END IF;
 -- Permission maintenance first: an unsubscribe, withdrawal or changed address stops the run before anything is due.
 FOR candidate IN SELECT x.id FROM app_private.pp_followup_runs x WHERE x.state IN('active','paused','held')
  AND NOT app_private.pp_followup_endpoint_allowed(x.contact_point_id,x.endpoint_identity_sha256) ORDER BY x.id LIMIT 500 LOOP
  SELECT * INTO r FROM app_private.pp_followup_runs WHERE id=candidate.id FOR UPDATE SKIP LOCKED;
  IF NOT FOUND OR r.state NOT IN('active','paused','held') THEN CONTINUE; END IF;
  PERFORM app_private.pp_followup_end_run(r.id,'stopped','unsubscribed');
 END LOOP;
 FOR candidate IN SELECT x.id FROM app_private.pp_followup_runs x JOIN app.contact_points p ON p.workspace_id=x.workspace_id AND p.id=x.contact_point_id
  WHERE x.state='active' AND x.due_at<=clock_timestamp() AND (p_only_emails IS NULL OR p.normalized_value=ANY(p_only_emails))
  ORDER BY x.due_at,x.id LIMIT 500 LOOP
  SELECT * INTO r FROM app_private.pp_followup_runs WHERE id=candidate.id FOR UPDATE SKIP LOCKED;
  IF NOT FOUND OR r.state<>'active' OR r.due_at>clock_timestamp() THEN CONTINUE; END IF;
  IF NOT app_private.pp_followup_endpoint_allowed(r.contact_point_id,r.endpoint_identity_sha256) THEN PERFORM app_private.pp_followup_end_run(r.id,'stopped','unsubscribed');CONTINUE; END IF;
  BEGIN
   exact:=app_private.pp_followup_sequence_exact(r.sequence_version_id,true,true);
   IF decode(exact->>'contentSha256','hex')<>r.sequence_sha256 OR (exact->>'approvalDecisionId')::uuid<>r.sequence_approval_id
    OR NOT app_private.can_manage_workspace(r.owner_user_id,r.workspace_id) THEN RAISE EXCEPTION 'PP flow authority changed' USING ERRCODE='23514'; END IF;
   message:=exact->'definition'->'steps'->r.position;
   IF message->>'kind' IS DISTINCT FROM 'email' THEN RAISE EXCEPTION 'PP flow channel unavailable' USING ERRCODE='23514'; END IF;
   email:=app_private.pp_followup_message_exact((message->>'contentVersionId')::uuid,true,true);
  EXCEPTION WHEN check_violation OR insufficient_privilege THEN
   UPDATE app_private.pp_followup_runs SET state='held',updated_at=clock_timestamp(),
    reason=CASE WHEN EXISTS(SELECT 1 FROM app.company_content_versions n JOIN app.company_content_versions o ON o.workspace_id=n.workspace_id AND o.content_item_id=n.content_item_id
     WHERE o.id=r.sequence_version_id AND n.version_number>o.version_number) THEN 'newer_sequence' ELSE 'content_changed' END WHERE id=r.id;
   CONTINUE;
  END;
  expiry:=r.due_at+make_interval(hours=>(exact->'definition'->>'expiryHours')::integer);
  IF expiry<=clock_timestamp() THEN PERFORM app_private.pp_followup_end_run(r.id,'failed','delivery_expired');CONTINUE; END IF;
  IF r.current_send_id IS NULL THEN
   INSERT INTO app_private.pp_followup_sends(workspace_id,run_id,step,content_item_id,content_version_id,content_sha256,approval_decision_id,due_at,expires_at)
   VALUES(r.workspace_id,r.id,r.position,(email->>'contentItemId')::uuid,(email->>'contentVersionId')::uuid,decode(email->>'contentSha256','hex'),
    (email->>'approvalDecisionId')::uuid,r.due_at,expiry)
   ON CONFLICT(run_id,step) DO NOTHING;
   SELECT * INTO q FROM app_private.pp_followup_sends WHERE run_id=r.id AND step=r.position FOR UPDATE;
   UPDATE app_private.pp_followup_runs SET current_send_id=q.id,updated_at=clock_timestamp() WHERE id=r.id;r.current_send_id:=q.id;
  ELSE SELECT * INTO q FROM app_private.pp_followup_sends WHERE id=r.current_send_id FOR UPDATE SKIP LOCKED;IF NOT FOUND THEN CONTINUE; END IF; END IF;
  IF q.run_id IS DISTINCT FROM r.id OR q.step<>r.position OR q.content_version_id<>(message->>'contentVersionId')::uuid
   OR encode(q.content_sha256,'hex')<>message->>'contentSha256' THEN
   UPDATE app_private.pp_followup_runs SET state='held',reason='content_changed',updated_at=clock_timestamp() WHERE id=r.id;CONTINUE; END IF;
  IF q.sent_at IS NOT NULL OR q.lease_until>clock_timestamp() THEN CONTINUE; END IF;
  IF q.cancelled_at IS NOT NULL THEN UPDATE app_private.pp_followup_runs SET state='stopped',reason='unsubscribed',updated_at=clock_timestamp() WHERE id=r.id;CONTINUE; END IF;
  IF q.failed_at IS NOT NULL OR q.attempts>=5 OR q.expires_at<=clock_timestamp() THEN
   UPDATE app_private.pp_followup_sends SET failed_at=coalesce(failed_at,clock_timestamp()),lease_id=NULL WHERE id=q.id;
   UPDATE app_private.pp_followup_runs SET state='failed',reason=CASE WHEN q.expires_at<=clock_timestamp() THEN 'delivery_expired' ELSE 'delivery_failed' END,updated_at=clock_timestamp() WHERE id=r.id;CONTINUE; END IF;
  IF q.held_at IS NOT NULL THEN UPDATE app_private.pp_followup_runs SET state='held',reason='recovery',updated_at=clock_timestamp() WHERE id=r.id;CONTINUE; END IF;
  proof:=NULL;SELECT * INTO proof FROM app_private.pp_followup_dispatch_proofs WHERE send_id=q.id ORDER BY checked_at DESC,id DESC LIMIT 1;
  IF proof.id IS NOT NULL AND proof.accepted IS NULL AND proof.id IS DISTINCT FROM r.unknown_ack_proof_id THEN
   UPDATE app_private.pp_followup_runs SET state='held',reason='outcome_unknown',updated_at=clock_timestamp() WHERE id=r.id;CONTINUE; END IF;
  IF q.due_at>clock_timestamp() THEN CONTINUE; END IF;
  lease:=gen_random_uuid();until_at:=clock_timestamp()+make_interval(secs=>p_lease_seconds);
  UPDATE app_private.pp_followup_sends SET lease_id=lease,lease_until=until_at,attempts=attempts+1 WHERE id=q.id;
  claimed:=claimed||jsonb_build_array(jsonb_build_object('id',q.id,'leaseId',lease,'leaseUntil',until_at));
  IF jsonb_array_length(claimed)>=p_limit THEN EXIT; END IF;
 END LOOP;
 RETURN claimed;
END $f$;

-- Re-verify everything under the lease and write the dispatch proof. Only a returned proof may reach Postmark.
CREATE FUNCTION app_private.pp_followup_prepare(p_send uuid,p_lease uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE run_id uuid; r app_private.pp_followup_runs%ROWTYPE; q app_private.pp_followup_sends%ROWTYPE; exact jsonb; email jsonb; endpoint record; proof uuid; checked timestamptz;
BEGIN
 IF p_send IS NULL OR p_lease IS NULL THEN RAISE EXCEPTION 'Invalid PP follow-up lease' USING ERRCODE='22023'; END IF;
 SELECT s.run_id INTO run_id FROM app_private.pp_followup_sends s WHERE s.id=p_send AND s.lease_id=p_lease;
 IF run_id IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO r FROM app_private.pp_followup_runs WHERE id=run_id FOR UPDATE;
 SELECT * INTO q FROM app_private.pp_followup_sends WHERE id=p_send FOR UPDATE;
 IF r.state<>'active' OR r.current_send_id IS DISTINCT FROM p_send OR r.position IS DISTINCT FROM q.step
  OR q.lease_id IS DISTINCT FROM p_lease OR q.lease_until IS NULL OR q.lease_until<=clock_timestamp() OR q.due_at>clock_timestamp()
  OR q.sent_at IS NOT NULL OR q.cancelled_at IS NOT NULL OR q.failed_at IS NOT NULL OR q.held_at IS NOT NULL OR q.expires_at<=clock_timestamp()
  OR EXISTS(SELECT 1 FROM app_private.pp_followup_dispatch_proofs old WHERE old.send_id=p_send AND old.lease_id=p_lease)
  OR NOT app_private.pp_followup_endpoint_allowed(r.contact_point_id,r.endpoint_identity_sha256) THEN RETURN NULL; END IF;
 BEGIN
  exact:=app_private.pp_followup_sequence_exact(r.sequence_version_id,true,true);
  IF decode(exact->>'contentSha256','hex')<>r.sequence_sha256 OR (exact->>'approvalDecisionId')::uuid<>r.sequence_approval_id
   OR NOT app_private.can_manage_workspace(r.owner_user_id,r.workspace_id) THEN RETURN NULL; END IF;
  email:=app_private.pp_followup_message_exact(q.content_version_id,true,true);
  IF decode(email->>'contentSha256','hex')<>q.content_sha256 OR (email->>'approvalDecisionId')::uuid<>q.approval_decision_id THEN RETURN NULL; END IF;
 EXCEPTION WHEN check_violation OR insufficient_privilege THEN RETURN NULL; END;
 SELECT * INTO endpoint FROM app_private.pp_followup_endpoint(r.contact_point_id);
 checked:=clock_timestamp();
 INSERT INTO app_private.pp_followup_dispatch_proofs(workspace_id,send_id,lease_id,content_version_id,content_sha256,approval_decision_id,
  endpoint_identity_sha256,observed_session_user,checked_at,expires_at)
 VALUES(q.workspace_id,q.id,p_lease,q.content_version_id,q.content_sha256,q.approval_decision_id,r.endpoint_identity_sha256,session_user,checked,
  least(q.lease_until,checked+interval '15 minutes')) RETURNING id INTO proof;
 RETURN jsonb_build_object('id',q.id,'leaseId',p_lease,'leaseUntil',q.lease_until,'proofId',proof,'runId',r.id,'step',q.step,
  'contactPointId',r.contact_point_id,'email',endpoint.email,'displayName',endpoint.display_name,
  'contentVersionId',q.content_version_id,'canonicalContent',email->>'canonicalContent','contentSha256',email->>'contentSha256');
END $f$;

-- Only a provider acceptance with its message id marks a step sent and advances the run.
CREATE FUNCTION app_private.pp_followup_settle(p_send uuid,p_lease uuid,p_accepted boolean,p_reference text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE run_id uuid; r app_private.pp_followup_runs%ROWTYPE; q app_private.pp_followup_sends%ROWTYPE; definition jsonb; next jsonb;
BEGIN
 IF p_send IS NULL OR p_lease IS NULL OR p_accepted IS NULL OR (p_accepted AND (p_reference IS NULL OR length(p_reference) NOT BETWEEN 1 AND 200))
 THEN RAISE EXCEPTION 'Invalid PP follow-up settlement' USING ERRCODE='22023'; END IF;
 SELECT s.run_id INTO run_id FROM app_private.pp_followup_sends s WHERE s.id=p_send;
 IF run_id IS NULL THEN RAISE EXCEPTION 'PP follow-up lease is no longer current' USING ERRCODE='23514'; END IF;
 SELECT * INTO r FROM app_private.pp_followup_runs WHERE id=run_id FOR UPDATE;
 SELECT * INTO q FROM app_private.pp_followup_sends WHERE id=p_send FOR UPDATE;
 IF q.lease_id IS DISTINCT FROM p_lease OR q.lease_until IS NULL OR q.lease_until<=clock_timestamp() OR q.sent_at IS NOT NULL
 THEN RAISE EXCEPTION 'PP follow-up lease is no longer current' USING ERRCODE='23514'; END IF;
 IF p_accepted AND NOT EXISTS(SELECT 1 FROM app_private.pp_followup_dispatch_proofs p WHERE p.send_id=p_send AND p.lease_id=p_lease
  AND p.content_version_id=q.content_version_id AND p.content_sha256=q.content_sha256 AND p.accepted IS NULL AND p.expires_at>clock_timestamp())
 THEN RAISE EXCEPTION 'PP follow-up dispatch proof required' USING ERRCODE='23514'; END IF;
 UPDATE app_private.pp_followup_dispatch_proofs SET accepted=p_accepted,provider_reference=CASE WHEN p_accepted THEN p_reference END,completed_at=clock_timestamp()
 WHERE send_id=p_send AND lease_id=p_lease AND accepted IS NULL;
 IF NOT p_accepted THEN
  UPDATE app_private.pp_followup_sends SET lease_id=NULL,lease_until=clock_timestamp()+make_interval(mins=>5*attempts),last_failure='delivery_not_accepted' WHERE id=p_send;
  RETURN;
 END IF;
 -- A later unsubscribe cannot undo an acceptance that already happened; it stops the next step.
 UPDATE app_private.pp_followup_sends SET sent_at=clock_timestamp(),provider_reference=p_reference,lease_id=NULL,lease_until=NULL,last_failure=NULL WHERE id=p_send
 RETURNING * INTO q;
 IF r.current_send_id IS DISTINCT FROM q.id OR r.position<>q.step THEN RETURN; END IF;
 IF r.state NOT IN('active','paused','held') THEN UPDATE app_private.pp_followup_runs SET last_accepted_at=q.sent_at,updated_at=clock_timestamp() WHERE id=r.id;RETURN; END IF;
 SELECT content_body::jsonb INTO definition FROM app.company_content_versions WHERE id=r.sequence_version_id AND workspace_id=r.workspace_id;
 next:=app_private.pp_followup_next(definition,r.position,q.sent_at);
 UPDATE app_private.pp_followup_runs SET state=CASE WHEN next IS NULL THEN 'completed' ELSE state END,
  position=CASE WHEN next IS NULL THEN position ELSE (next->>'position')::integer END,
  due_at=CASE WHEN next IS NULL THEN due_at ELSE (next->>'dueAt')::timestamptz END,current_send_id=NULL,
  last_accepted_at=q.sent_at,unknown_ack_proof_id=NULL,updated_at=clock_timestamp() WHERE id=r.id;
END $f$;

-- Any failure after a proof is an unknown outcome: hold the run for an explicit owner decision, never retry silently.
CREATE FUNCTION app_private.pp_followup_unknown(p_send uuid,p_lease uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE run_id uuid; r app_private.pp_followup_runs%ROWTYPE; q app_private.pp_followup_sends%ROWTYPE;
BEGIN
 SELECT s.run_id INTO run_id FROM app_private.pp_followup_sends s WHERE s.id=p_send;
 IF run_id IS NULL THEN RETURN; END IF;
 SELECT * INTO r FROM app_private.pp_followup_runs WHERE id=run_id FOR UPDATE;
 SELECT * INTO q FROM app_private.pp_followup_sends WHERE id=p_send FOR UPDATE;
 IF r.current_send_id=p_send AND r.state IN('active','paused','held') AND q.sent_at IS NULL AND q.lease_id=p_lease
  AND EXISTS(SELECT 1 FROM app_private.pp_followup_dispatch_proofs WHERE send_id=p_send AND lease_id=p_lease AND accepted IS NULL)
 THEN UPDATE app_private.pp_followup_runs SET state='held',reason='outcome_unknown',updated_at=clock_timestamp() WHERE id=r.id; END IF;
END $f$;

-- Signed one-click unsubscribe: append a marketing-email suppression for the current endpoint and stop its open runs.
CREATE FUNCTION app_private.pp_followup_unsubscribe(p_point uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE endpoint record; latest text; stopped integer:=0; r record;
BEGIN
 IF p_point IS NULL THEN RAISE EXCEPTION 'Invalid unsubscribe' USING ERRCODE='22023'; END IF;
 SELECT p.contact_id,public.digest(p.kind||chr(31)||p.value||chr(31)||p.normalized_value,'sha256') AS identity INTO endpoint
 FROM app.contact_points p WHERE p.workspace_id='d975ff66-336a-46c2-b36b-d7095a11af97' AND p.id=p_point AND p.kind='email';
 IF endpoint.contact_id IS NULL THEN RETURN jsonb_build_object('known',false,'recorded',false,'stopped',0); END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('pp-followup-unsubscribe:'||p_point::text,7200152));
 SELECT s.state INTO latest FROM app.communication_suppression_events s WHERE s.workspace_id='d975ff66-336a-46c2-b36b-d7095a11af97'
  AND s.contact_point_id=p_point AND s.channel='email' AND s.purpose='marketing' AND s.endpoint_identity_sha256=endpoint.identity
 ORDER BY s.occurred_at DESC,s.recorded_at DESC,s.id DESC LIMIT 1;
 IF latest IS DISTINCT FROM 'suppressed' THEN
  INSERT INTO app.communication_suppression_events(workspace_id,contact_id,contact_point_id,channel,purpose,state,reason,source,actor_kind,evidence,occurred_at)
  VALUES('d975ff66-336a-46c2-b36b-d7095a11af97',endpoint.contact_id,p_point,'email','marketing','suppressed','recipient_unsubscribe','pp.followup.unsubscribe','system',
   jsonb_build_object('route','signed_unsubscribe_link'),statement_timestamp());
 END IF;
 FOR r IN SELECT id FROM app_private.pp_followup_runs WHERE contact_point_id=p_point AND state IN('active','paused','held') ORDER BY id FOR UPDATE LOOP
  PERFORM app_private.pp_followup_end_run(r.id,'stopped','unsubscribed'); stopped:=stopped+1;
 END LOOP;
 RETURN jsonb_build_object('known',true,'recorded',latest IS DISTINCT FROM 'suppressed','stopped',stopped);
END $f$;

-- Release recovery: hold every open run; each needs an explicit owner resume.
CREATE FUNCTION app_private.pp_followup_hold_runs() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE r app_private.pp_followup_runs%ROWTYPE; held integer:=0; flying integer:=0;
BEGIN
 FOR r IN SELECT * FROM app_private.pp_followup_runs WHERE state IN('active','paused','held') ORDER BY id FOR UPDATE LOOP
  UPDATE app_private.pp_followup_runs SET state='held',reason=CASE WHEN reason IN('outcome_unknown','newer_sequence','content_changed') THEN reason ELSE 'recovery' END,updated_at=clock_timestamp() WHERE id=r.id;
  held:=held+1;
  SELECT flying+count(*) INTO flying FROM app_private.pp_followup_sends WHERE run_id=r.id AND sent_at IS NULL AND lease_id IS NOT NULL AND lease_until>clock_timestamp();
  UPDATE app_private.pp_followup_sends SET held_at=coalesce(held_at,clock_timestamp()),hold_reason='recovery'
   WHERE run_id=r.id AND sent_at IS NULL AND cancelled_at IS NULL AND failed_at IS NULL AND (lease_until IS NULL OR lease_until<=clock_timestamp()) AND held_at IS NULL;
 END LOOP;
 RETURN jsonb_build_object('held',held,'inFlight',flying,'resumed',0);
END $f$;

REVOKE ALL ON FUNCTION app_private.pp_followup_canonical(jsonb),app_private.pp_followup_authorize(bytea,boolean),
 app_private.pp_followup_local_exact(uuid,text,boolean,boolean),app_private.pp_followup_message_exact(uuid,boolean,boolean),
 app_private.pp_followup_sequence_exact(uuid,boolean,boolean),app_private.pp_followup_endpoint(uuid),app_private.pp_followup_endpoint_allowed(uuid,bytea),
 app_private.pp_followup_next(jsonb,integer,timestamptz),app_private.pp_followup_end_run(uuid,text,text),app_private.pp_followup_snapshot(bytea),
 app_private.pp_followup_command(bytea,text,uuid,uuid,uuid,uuid,uuid,text),app_private.pp_followup_claim(integer,integer,text[]),
 app_private.pp_followup_prepare(uuid,uuid),app_private.pp_followup_settle(uuid,uuid,boolean,text),app_private.pp_followup_unknown(uuid,uuid),
 app_private.pp_followup_unsubscribe(uuid),app_private.pp_followup_hold_runs() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.pp_followup_snapshot(bytea) TO r72_web;
GRANT EXECUTE ON FUNCTION app_private.pp_followup_command(bytea,text,uuid,uuid,uuid,uuid,uuid,text),app_private.pp_followup_claim(integer,integer,text[]),
 app_private.pp_followup_prepare(uuid,uuid),app_private.pp_followup_settle(uuid,uuid,boolean,text),app_private.pp_followup_unknown(uuid,uuid),
 app_private.pp_followup_unsubscribe(uuid),app_private.pp_followup_hold_runs() TO r72_identity_command;
RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_pp_followup_definer;
RESET ROLE;
