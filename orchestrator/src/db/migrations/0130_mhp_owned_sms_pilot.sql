-- MHP009A: one explicit owned-recipient SMS operation on the existing0056 rail.
-- Ratified SQL design036e2c593843ff043f7d0e3850a6f3263fdb0e0eb0827e34c7608bfba706779b.
-- No provider call, new queue, runtime table access, public capture or email change.
SET LOCAL ROLE r72_owner;
ALTER TABLE app_private.affiliate_compliance_subjects DROP CONSTRAINT affiliate_compliance_subjects_source_system_check;
ALTER TABLE app_private.affiliate_compliance_subjects ADD CONSTRAINT affiliate_compliance_subjects_source_system_check
 CHECK(source_system IN('property-predator-main','legacy-import','test-fixture','martin-howard-property'));
GRANT CREATE ON SCHEMA app_private TO r72_sms_definer,r72_mhp_prospect_definer;
GRANT EXECUTE ON FUNCTION app_private.mhp_owner_email_authorize(bytea) TO r72_sms_definer;
GRANT EXECUTE ON FUNCTION app_private.current_request_id(),app_private.current_user_id() TO r72_sms_definer;
GRANT SELECT,INSERT ON app.command_receipts TO r72_sms_definer;
GRANT UPDATE(result,status,response_status,completed_at) ON app.command_receipts TO r72_sms_definer;
CREATE POLICY mhp_owned_sms_receipts ON app.command_receipts TO r72_sms_definer
 USING(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND command_name='mhp.sms.owned-test'
  AND actor_user_id=nullif(current_setting('app.user_id',true),'')::uuid)
 WITH CHECK(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND command_name='mhp.sms.owned-test'
  AND actor_user_id=nullif(current_setting('app.user_id',true),'')::uuid AND current_setting('app.actor_kind',true)='user' AND session_user='r72_sms_command');
GRANT SELECT ON app.contacts,app.inboxes TO r72_sms_definer;
CREATE POLICY mhp_owned_sms_contacts_read ON app.contacts FOR SELECT TO r72_sms_definer
 USING(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND current_setting('app.actor_kind',true)='user' AND session_user='r72_sms_command');
CREATE POLICY mhp_owned_sms_inboxes_read ON app.inboxes FOR SELECT TO r72_sms_definer
 USING(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND channel='sms' AND environment='live' AND current_setting('app.actor_kind',true)='user');
GRANT INSERT ON app.inboxes,app.conversations,app.messages,app.message_versions,app.message_approval_requests,app.message_approval_decisions TO r72_sms_definer;
DO $policies$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['inboxes','conversations','messages','message_versions','message_approval_requests','message_approval_decisions'] LOOP
  EXECUTE format('CREATE POLICY mhp_owned_sms_user_insert ON app.%I FOR INSERT TO r72_sms_definer WITH CHECK(
   workspace_id=''2789228d-55a6-4688-b1e8-2f70abca990b'' AND current_setting(''app.actor_kind'',true)=''user''
   AND session_user=''r72_sms_command''%s)',t,CASE
    WHEN t IN('inboxes','conversations','messages','message_versions') THEN ' AND channel=''sms'' AND environment=''live'''
    ELSE '' END || CASE
    WHEN t='messages' THEN ' AND direction=''outbound'' AND source_kind=''user'' AND created_by_actor_kind=''user'' AND created_by_user_id=nullif(current_setting(''app.user_id'',true),'''')::uuid AND lifecycle=''draft'''
    WHEN t='message_versions' THEN ' AND version_number=1 AND created_by_actor_kind=''user'' AND created_by_user_id=nullif(current_setting(''app.user_id'',true),'''')::uuid AND created_request_id=current_setting(''app.request_id'',true) AND source_content_version_ref IS NOT NULL'
    WHEN t='message_approval_requests' THEN ' AND requested_by_user_id=nullif(current_setting(''app.user_id'',true),'''')::uuid AND requested_request_id=current_setting(''app.request_id'',true)'
    WHEN t='message_approval_decisions' THEN ' AND decided_by_user_id=nullif(current_setting(''app.user_id'',true),'''')::uuid AND decided_request_id=current_setting(''app.request_id'',true) AND decision=''approved'''
    ELSE '' END);
 END LOOP;
END $policies$;
GRANT SELECT,INSERT ON app_private.affiliate_compliance_subjects,app_private.affiliate_compliance_policy_pack_versions,
 app_private.affiliate_compliance_policy_review_events,app_private.affiliate_compliance_policy_publication_events,
 app_private.affiliate_compliance_specialist_decision_events,app_private.affiliate_compliance_permission_use_receipts TO r72_sms_definer;
DO $policies$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['affiliate_compliance_subjects','affiliate_compliance_policy_pack_versions','affiliate_compliance_policy_review_events',
  'affiliate_compliance_policy_publication_events','affiliate_compliance_specialist_decision_events','affiliate_compliance_permission_use_receipts'] LOOP
  EXECUTE format('CREATE POLICY mhp_owned_sms_operational_review ON app_private.%I TO r72_sms_definer
   USING(workspace_id=''2789228d-55a6-4688-b1e8-2f70abca990b'' AND current_setting(''app.actor_kind'',true)=''user'' AND session_user=''r72_sms_command'')
   WITH CHECK(workspace_id=''2789228d-55a6-4688-b1e8-2f70abca990b'' AND current_setting(''app.actor_kind'',true)=''user'' AND session_user=''r72_sms_command''
    AND recorded_by_user_id=nullif(current_setting(''app.user_id'',true),'''')::uuid AND recorded_request_id=current_setting(''app.request_id'',true))',t);
 END LOOP;
END $policies$;
GRANT INSERT ON app.communication_consent_events TO r72_sms_definer;
CREATE POLICY mhp_owned_sms_permission ON app.communication_consent_events FOR INSERT TO r72_sms_definer
 WITH CHECK(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND current_setting('app.actor_kind',true)='user'
  AND session_user='r72_sms_command' AND channel='sms' AND purpose='marketing' AND state='granted' AND lawful_basis='consent'
  AND source='mhp.owned-sms.self-test' AND policy_version='mhp.owned-sms-self-test/v1'
  AND actor_kind='user' AND actor_user_id=nullif(current_setting('app.user_id',true),'')::uuid);

SET LOCAL ROLE r72_mhp_prospect_definer;
CREATE FUNCTION app_private.mhp_owned_sms_content(p_version uuid,p_sha bytea) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE exact jsonb; v app.company_content_versions%ROWTYPE; approval uuid; manifest_sha bytea; observation app.company_content_source_attestations%ROWTYPE;
BEGIN
 exact:=app_private.mhp_owner_channel_exact(p_version,true);
 SELECT * INTO v FROM app.company_content_versions WHERE workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND id=p_version;
 IF exact->>'channel' IS DISTINCT FROM 'sms' OR v.content_sha256 IS DISTINCT FROM p_sha
  OR exact->'payload'->>'bodyText'!~'^[\r\n\x20-\x5a\x5f\x61-\x7a]+$'
  OR position('{{' IN exact->'payload'->>'bodyText')>0 OR position('}}' IN exact->'payload'->>'bodyText')>0
 THEN RAISE EXCEPTION 'Exact owned SMS source required' USING ERRCODE='23514'; END IF;
 manifest_sha:=decode(v.metadata->'mhpChannelDraft'->>'manifestSha256','hex');
 SELECT * INTO observation FROM app.company_content_source_attestations a WHERE a.workspace_id=v.workspace_id
  AND a.content_item_id=v.content_item_id AND a.content_version_id=v.id ORDER BY a.checked_at DESC,a.id DESC LIMIT 1;
 IF observation.id IS NULL OR observation.source_catalog_sha256 IS DISTINCT FROM manifest_sha
  OR observation.content_sha256 IS DISTINCT FROM v.content_sha256 OR observation.blob_sha256 IS DISTINCT FROM v.blob_sha256
  OR observation.brand_sha256 IS DISTINCT FROM v.brand_sha256 OR observation.source_system IS DISTINCT FROM v.source_system
  OR observation.source_item_id IS DISTINCT FROM v.source_item_id OR observation.source_version IS DISTINCT FROM v.source_version
  OR observation.checked_at>statement_timestamp() OR observation.expires_at<=statement_timestamp()
 THEN RAISE EXCEPTION 'Current exact owned SMS source observation required' USING ERRCODE='23514'; END IF;
 SELECT d.id INTO approval FROM app.company_content_approval_decisions d
 JOIN app.company_content_approval_requests r ON r.workspace_id=d.workspace_id AND r.id=d.approval_request_id
 WHERE d.workspace_id=v.workspace_id AND d.content_version_id=v.id AND d.content_sha256=v.content_sha256 AND d.decision='approved'
  AND app_private.mhp_marketing_workspace_allowed(d.decided_by_user_id,d.workspace_id)
  AND r.request_number=(SELECT max(n.request_number) FROM app.company_content_approval_requests n WHERE n.workspace_id=v.workspace_id AND n.content_version_id=v.id)
 ORDER BY d.decided_at DESC,d.id DESC LIMIT 1;
 IF approval IS NULL THEN RAISE EXCEPTION 'Current owner SMS source approval required' USING ERRCODE='23514'; END IF;
 RETURN exact||jsonb_build_object('sourceItemId',v.source_item_id,'sourceVersion',v.source_version,'approvalId',approval,'bodyText',exact->'payload'->>'bodyText');
END $f$;
REVOKE ALL ON FUNCTION app_private.mhp_owned_sms_content(uuid,bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.mhp_owned_sms_content(uuid,bytea) TO r72_sms_definer;

SET LOCAL ROLE r72_sms_definer;
CREATE FUNCTION app_private.mhp_owned_sms_snapshot(p_session bytea,p_contact uuid,p_phone text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; point uuid; binding app.property_predator_sms_bindings%ROWTYPE; verified boolean:=false; suppressed boolean:=false; saved jsonb;
BEGIN
 actor:=app_private.mhp_owner_email_authorize(p_session);
 IF session_user<>'r72_sms_command' OR current_setting('app.workspace_id',true) IS DISTINCT FROM '2789228d-55a6-4688-b1e8-2f70abca990b'
  OR current_setting('app.actor_kind',true) IS DISTINCT FROM 'user' OR current_setting('app.user_id',true) IS DISTINCT FROM actor::text
  OR p_contact IS NULL OR p_phone IS NULL OR p_phone!~'^\+44[0-9]{9,10}$'
 THEN RAISE EXCEPTION 'MHP owned SMS session required' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT 1 FROM app.contacts c WHERE c.workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND c.id=p_contact AND c.deleted_at IS NULL)
 THEN RAISE EXCEPTION 'MHP owned contact required' USING ERRCODE='42501'; END IF;
 SELECT b.* INTO binding FROM app.property_predator_sms_bindings b WHERE b.workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b'
  AND b.status='active' AND NOT EXISTS(SELECT 1 FROM app.property_predator_sms_binding_revocations r WHERE r.workspace_id=b.workspace_id AND r.binding_id=b.id)
 ORDER BY b.created_at DESC LIMIT 1;
 SELECT p.id,p.is_verified AND EXISTS(SELECT 1 FROM app_private.sms_phone_verification_receipts v WHERE v.workspace_id=p.workspace_id
   AND v.contact_point_id=p.id AND v.phone_identity_sha256=public.digest(p.normalized_value,'sha256') AND v.verified_by_user_id=actor)
 INTO point,verified FROM app.contact_points p WHERE p.workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND p.contact_id=p_contact
  AND p.kind='phone' AND p.normalized_value=p_phone AND p.deleted_at IS NULL AND p.dedupe_state='normal';
 SELECT coalesce(bool_or(e.state='suppressed'),false) INTO suppressed FROM (
  SELECT DISTINCT ON(coalesce(s.purpose,'')) s.state FROM app.communication_suppression_events s
  WHERE s.workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND s.contact_point_id=point AND s.channel='sms' AND(s.purpose IS NULL OR s.purpose='marketing')
  ORDER BY coalesce(s.purpose,''),s.occurred_at DESC,s.recorded_at DESC,s.id DESC) e;
 SELECT r.result||jsonb_build_object('state',j.state,'replayed',true) INTO saved FROM app.command_receipts r
 JOIN app.property_predator_sms_jobs j ON j.workspace_id=r.workspace_id AND j.id=(r.result->>'jobId')::uuid
 WHERE r.workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND r.actor_user_id=actor AND r.command_name='mhp.sms.owned-test' AND r.status='succeeded'
 ORDER BY r.completed_at DESC,r.id DESC LIMIT 1;
 RETURN jsonb_build_object('bindingId',binding.id,'senderNumber',binding.sender_number,'contactId',p_contact,'contactPointId',point,
  'verified',coalesce(verified,false),'suppressed',suppressed,'lastResult',saved);
END $f$;

CREATE FUNCTION app_private.mhp_owned_sms_send(p_session bytea,p_command uuid,p_binding uuid,p_contact uuid,p_point uuid,p_content_version uuid,
 p_content_sha256 bytea,p_review_version text,p_confirmed boolean,p_lookup_only boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE
 ws constant uuid:='2789228d-55a6-4688-b1e8-2f70abca990b'; actor uuid; request text:=current_setting('app.request_id',true);
 payload bytea; prior app.command_receipts%ROWTYPE; exact jsonb; binding app.property_predator_sms_bindings%ROWTYPE;
 point app.contact_points%ROWTYPE; endpoint_sha bytea; body text; body_sha bytea; segments integer; prepared timestamptz; expiry timestamptz;
 inbox uuid; conversation uuid; message uuid:=gen_random_uuid(); version uuid:=gen_random_uuid(); approval_request uuid:=gen_random_uuid(); approval uuid:=gen_random_uuid();
 consent uuid:=gen_random_uuid(); subject uuid:=gen_random_uuid(); pack uuid:=gen_random_uuid(); legal uuid:=gen_random_uuid(); commercial uuid:=gen_random_uuid();
 publication uuid:=gen_random_uuid(); sender_route uuid:=gen_random_uuid(); instigator_route uuid:=gen_random_uuid(); permission_use uuid:=gen_random_uuid();
 operation uuid:=gen_random_uuid(); delivery uuid:=gen_random_uuid(); correlation uuid:=gen_random_uuid(); command_receipt uuid:=gen_random_uuid();
 facts jsonb; facts_sha bytea; scope bytea; nonce bytea; request_sha bytea; queued record; outcome jsonb; current_state text;
 permission_text constant text:='I agree to receive one Martin Howard Property test SMS on this verified number. This does not subscribe me to future SMS or WhatsApp.';
 review_authority constant text:='mhp.founder-operator-review-not-legal-advice';
BEGIN
 actor:=app_private.mhp_owner_email_authorize(p_session);
 IF session_user<>'r72_sms_command' OR current_setting('app.workspace_id',true) IS DISTINCT FROM ws::text
  OR current_setting('app.actor_kind',true) IS DISTINCT FROM 'user' OR current_setting('app.user_id',true) IS DISTINCT FROM actor::text
  OR request IS NULL OR length(request) NOT BETWEEN 1 AND 128 OR p_command IS NULL OR p_binding IS NULL OR p_contact IS NULL OR p_point IS NULL
  OR p_content_version IS NULL OR p_content_sha256 IS NULL OR octet_length(p_content_sha256)<>32 OR p_confirmed IS DISTINCT FROM true
  OR p_review_version IS DISTINCT FROM 'mhp.owned-sms-self-test/v1' OR p_lookup_only IS NULL
 THEN RAISE EXCEPTION 'MHP owned SMS action denied' USING ERRCODE='42501'; END IF;
 payload:=public.digest(jsonb_build_object('schema',p_review_version,'workspace',ws,'actor',actor,'binding',p_binding,'contact',p_contact,'point',p_point,
  'contentVersion',p_content_version,'contentSha256',encode(p_content_sha256,'hex'),'confirmed',p_confirmed)::text,'sha256');
 SELECT * INTO prior FROM app.command_receipts r WHERE r.workspace_id=ws AND r.actor_user_id=actor AND r.command_name='mhp.sms.owned-test' AND r.idempotency_key=p_command::text;
 IF FOUND THEN
  IF prior.payload_hash IS DISTINCT FROM payload OR prior.status<>'succeeded' THEN RAISE EXCEPTION 'Owned SMS replay conflicts' USING ERRCODE='40001'; END IF;
  SELECT j.state INTO current_state FROM app.property_predator_sms_jobs j WHERE j.workspace_id=ws AND j.id=(prior.result->>'jobId')::uuid;
  IF current_state IS NULL THEN RAISE EXCEPTION 'Owned SMS history unavailable' USING ERRCODE='23514'; END IF;
  RETURN prior.result||jsonb_build_object('state',current_state,'replayed',true);
 END IF;
 IF p_lookup_only THEN RETURN jsonb_build_object('not_started',true); END IF;
 IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed'
 THEN RAISE EXCEPTION 'New owned SMS preparation requires read committed' USING ERRCODE='25000'; END IF;
 exact:=app_private.mhp_owned_sms_content(p_content_version,p_content_sha256);
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('company-content:'||ws::text||':'||(exact->>'contentItemId'),7200021));
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('mhp.sms.owned-test:'||ws::text||':'||actor::text||':'||p_command::text,7200130));
 -- Recheck after the item/command locks; a concurrent identical commit wins once.
 SELECT * INTO prior FROM app.command_receipts r WHERE r.workspace_id=ws AND r.actor_user_id=actor AND r.command_name='mhp.sms.owned-test' AND r.idempotency_key=p_command::text;
 IF FOUND THEN
  IF prior.payload_hash IS DISTINCT FROM payload OR prior.status<>'succeeded' THEN RAISE EXCEPTION 'Owned SMS replay conflicts' USING ERRCODE='40001'; END IF;
  SELECT j.state INTO current_state FROM app.property_predator_sms_jobs j WHERE j.workspace_id=ws AND j.id=(prior.result->>'jobId')::uuid;
  RETURN prior.result||jsonb_build_object('state',current_state,'replayed',true);
 END IF;
 exact:=app_private.mhp_owned_sms_content(p_content_version,p_content_sha256);
 SELECT b.* INTO binding FROM app.property_predator_sms_bindings b JOIN app.provider_connections pc ON pc.workspace_id=b.workspace_id AND pc.id=b.provider_connection_id
 JOIN app.channel_endpoints ce ON ce.workspace_id=b.workspace_id AND ce.id=b.channel_endpoint_id AND ce.provider_connection_id=pc.id
 WHERE b.workspace_id=ws AND b.id=p_binding AND b.status='active' AND b.sender_number='+447861935832'
  AND pc.provider_id='twilio_messaging' AND pc.provider_kind='sms' AND pc.environment='live' AND pc.status='active'
  AND ce.channel='sms' AND ce.environment='live' AND ce.status='active' AND ce.normalized_address=b.sender_number
  AND NOT EXISTS(SELECT 1 FROM app.property_predator_sms_binding_revocations r WHERE r.workspace_id=b.workspace_id AND r.binding_id=b.id)
 ;
 IF binding.id IS NULL THEN RAISE EXCEPTION 'Actual MHP SMS binding required' USING ERRCODE='42501'; END IF;
 SELECT p.* INTO point FROM app.contact_points p JOIN app.contacts c ON c.workspace_id=p.workspace_id AND c.id=p.contact_id
 WHERE p.workspace_id=ws AND p.id=p_point AND p.contact_id=p_contact AND p.kind='phone' AND p.is_verified AND p.dedupe_state='normal'
  AND p.deleted_at IS NULL AND c.deleted_at IS NULL AND p.normalized_value~'^\+44[0-9]{9,10}$'
  AND EXISTS(SELECT 1 FROM app_private.sms_phone_verification_receipts v WHERE v.workspace_id=p.workspace_id AND v.contact_point_id=p.id
   AND v.phone_identity_sha256=public.digest(p.normalized_value,'sha256') AND v.verified_by_user_id=actor)
 ;
 IF point.id IS NULL THEN RAISE EXCEPTION 'Actual verified owned MHP phone required' USING ERRCODE='42501'; END IF;
 IF EXISTS(SELECT 1 FROM(SELECT DISTINCT ON(coalesce(s.purpose,'')) s.state FROM app.communication_suppression_events s
  WHERE s.workspace_id=ws AND s.contact_point_id=point.id AND s.channel='sms' AND(s.purpose IS NULL OR s.purpose='marketing')
  ORDER BY coalesce(s.purpose,''),s.occurred_at DESC,s.recorded_at DESC,s.id DESC) latest WHERE latest.state='suppressed')
 THEN RAISE EXCEPTION 'Owned SMS opt-out is active' USING ERRCODE='42501'; END IF;
 prepared:=date_trunc('milliseconds',statement_timestamp()); expiry:=prepared+interval '4 minutes'; body:=exact->>'bodyText';body_sha:=public.digest(body,'sha256');
 IF clock_timestamp()>=expiry THEN RAISE EXCEPTION 'Owned SMS preparation expired while waiting' USING ERRCODE='23514'; END IF;
 endpoint_sha:=public.digest(point.kind||chr(31)||point.value||chr(31)||point.normalized_value,'sha256');
 segments:=CASE WHEN char_length(body)<=160 THEN 1 ELSE ceil(char_length(body)/153.0)::integer END;
 INSERT INTO app.command_receipts(id,workspace_id,command_name,idempotency_key,request_id,actor_user_id,payload_hash)
 VALUES(command_receipt,ws,'mhp.sms.owned-test',p_command::text,request,actor,payload);
 INSERT INTO app.inboxes(workspace_id,channel_endpoint_id,provider_connection_id,channel,environment,name)
 VALUES(ws,binding.channel_endpoint_id,binding.provider_connection_id,'sms','live','Martin Howard Property texts')
 ON CONFLICT(workspace_id,channel_endpoint_id) DO NOTHING;
 SELECT i.id INTO inbox FROM app.inboxes i WHERE i.workspace_id=ws AND i.channel_endpoint_id=binding.channel_endpoint_id AND i.status='active';
 IF inbox IS NULL THEN RAISE EXCEPTION 'MHP SMS inbox unavailable' USING ERRCODE='23514'; END IF;
 INSERT INTO app.conversations(workspace_id,inbox_id,channel,environment,contact_id,assigned_user_id,subject)
 VALUES(ws,inbox,'sms','live',p_contact,actor,'Martin Howard Property owned test')
 ON CONFLICT(workspace_id,inbox_id,contact_id) WHERE contact_id IS NOT NULL AND state IN('open','snoozed') DO NOTHING;
 SELECT c.id INTO conversation FROM app.conversations c WHERE c.workspace_id=ws AND c.inbox_id=inbox AND c.contact_id=p_contact AND c.state IN('open','snoozed');
 INSERT INTO app.messages(id,workspace_id,conversation_id,contact_id,contact_point_id,channel,environment,direction,lifecycle,source_kind,
  current_version_id,current_version_number,current_body_sha256,created_by_actor_kind,created_by_user_id,occurred_at)
 VALUES(message,ws,conversation,p_contact,p_point,'sms','live','outbound','draft','user',version,1,body_sha,'user',actor,prepared);
 INSERT INTO app.message_versions(id,workspace_id,conversation_id,message_id,channel,environment,version_number,body_text,
  source_content_version_ref,source_content_sha256,source_content_approval_ref,created_by_actor_kind,created_by_user_id,created_request_id)
 VALUES(version,ws,conversation,message,'sms','live',1,body,p_content_version::text,p_content_sha256,exact->>'approvalId','user',actor,request);
 IF NOT EXISTS(SELECT 1 FROM app.message_versions v WHERE v.workspace_id=ws AND v.id=version AND v.body_sha256=body_sha)
 THEN RAISE EXCEPTION 'Generated SMS body digest mismatch' USING ERRCODE='23514'; END IF;
 INSERT INTO app.message_approval_requests(id,workspace_id,conversation_id,message_id,message_version_id,version_number,body_sha256,request_number,review_note,requested_by_user_id,requested_request_id)
 VALUES(approval_request,ws,conversation,message,version,1,body_sha,1,'Owner reviewed one exact MHP self-test; no future phone subscription.',actor,request);
 UPDATE app.messages SET lifecycle='approval_pending',row_version=row_version+1,updated_at=statement_timestamp() WHERE workspace_id=ws AND id=message;
 INSERT INTO app.message_approval_decisions(id,workspace_id,conversation_id,message_id,message_version_id,approval_request_id,version_number,body_sha256,decision,decision_note,decided_by_user_id,decided_request_id)
 VALUES(approval,ws,conversation,message,version,approval_request,1,body_sha,'approved','Actual owner operational review, not external legal advice.',actor,request);
 UPDATE app.messages SET lifecycle='approved',row_version=row_version+1,updated_at=statement_timestamp() WHERE workspace_id=ws AND id=message;
 facts:=jsonb_build_object('schema',p_review_version,'owner',actor,'request',request,'command',p_command,'binding',binding.id,'sender',binding.sender_number,
  'recipientIdentitySha256',encode(endpoint_sha,'hex'),'contact',p_contact,'point',p_point,'contentVersion',p_content_version,'contentSha256',encode(p_content_sha256,'hex'),
  'messageVersion',version,'messageBodySha256',encode(body_sha,'hex'),'oneMessageOnly',true,'futureSmsSubscription',false,'whatsappSubscription',false,
  'reviewAuthority',review_authority,'permissionText',permission_text,'legalEntity','MH196 Ltd','brand','Martin Howard Property');
 facts_sha:=public.digest(facts::text,'sha256');
 INSERT INTO app.communication_consent_events(id,workspace_id,contact_id,contact_point_id,channel,purpose,state,lawful_basis,source,policy_version,
  policy_text_sha256,source_event_id,actor_kind,actor_user_id,evidence,endpoint_identity_sha256,occurred_at)
 VALUES(consent,ws,p_contact,p_point,'sms','marketing','granted','consent','mhp.owned-sms.self-test',p_review_version,
  public.digest(permission_text,'sha256'),p_command::text,'user',actor,facts,endpoint_sha,prepared);
 scope:=public.digest(format('sms:%s:%s:%s:%s:%s:%s:%s',ws,binding.provider_connection_id,binding.sender_number,version,encode(endpoint_sha,'hex'),'marketing',consent),'sha256');
 -- This producer truthfully records an owner operational self-test review.
 -- The ledger dimension names do not claim a solicitor or external review.
 INSERT INTO app_private.affiliate_compliance_subjects(id,workspace_id,source_system,source_subject_key,legal_identity_sha256,recorded_by_user_id,recorded_request_id)
 VALUES(subject,ws,'martin-howard-property','mhp.owned-sms:'||p_command::text,public.digest('MH196 Ltd:Martin Howard Property:'||actor::text,'sha256'),actor,request);
 INSERT INTO app_private.affiliate_compliance_policy_pack_versions(id,workspace_id,pack_key,pack_version,bundle_sha256,document_refs,drafting_status,source_commit,source_commit_meaning,recorded_by_user_id,recorded_request_id)
 VALUES(pack,ws,'mhp_owned_sms_self_test',p_command::text,facts_sha,jsonb_build_array(
  jsonb_build_object('documentType','owner_review','documentId','mhp.owner-review:'||p_command::text,'documentVersion','v1','contentSha256',encode(facts_sha,'hex')),
  jsonb_build_object('documentType','sender_ownership','documentId','mhp.sender-ownership:'||binding.id::text,'documentVersion','v1','contentSha256',encode(binding.ownership_evidence_sha256,'hex')),
  jsonb_build_object('documentType','owned_phone_verification','documentId','mhp.owned-phone-verification:'||point.id::text,'documentVersion','v1',
   'contentSha256',encode(public.digest(jsonb_build_object('point',point.id,'verifiedBy',actor,'phoneIdentitySha256',encode(public.digest(point.normalized_value,'sha256'),'hex'))::text,'sha256'),'hex')),
  jsonb_build_object('documentType','exact_message','documentId','mhp.exact-message:'||version::text,'documentVersion','v1','contentSha256',encode(body_sha,'hex')),
  jsonb_build_object('documentType','one_test_permission','documentId','mhp.one-test-permission:'||consent::text,'documentVersion','v1','contentSha256',encode(public.digest(permission_text,'sha256'),'hex'))),
  'draft_complete','69652270584f1dc0cf737fe2ff7cd9a19e3a4d28','drafting-provenance-only',actor,request);
 INSERT INTO app_private.affiliate_compliance_policy_review_events(id,workspace_id,policy_pack_id,bundle_sha256,review_dimension,decision,specialist_reference,decision_reference,decision_sha256,occurred_at,recorded_by_user_id,recorded_request_id)
 VALUES(legal,ws,pack,facts_sha,'legal','approved',review_authority,'mhp.owned-self-test:'||p_command::text,public.digest(facts_sha||convert_to(':owner-legal-dimension','UTF8'),'sha256'),prepared,actor,request),
  (commercial,ws,pack,facts_sha,'commercial','approved',review_authority,'mhp.owned-self-test:'||p_command::text,public.digest(facts_sha||convert_to(':owner-commercial-dimension','UTF8'),'sha256'),prepared,actor,request);
 INSERT INTO app_private.affiliate_compliance_policy_publication_events(id,workspace_id,policy_pack_id,bundle_sha256,publication_state,legal_review_event_id,commercial_review_event_id,effective_at,expires_at,reacceptance_class,publication_reference,recorded_by_user_id,recorded_request_id)
 VALUES(publication,ws,pack,facts_sha,'published',legal,commercial,prepared,expiry,'none','mhp.owned-self-test:'||p_command::text,actor,request);
 INSERT INTO app_private.affiliate_compliance_specialist_decision_events(id,workspace_id,subject_id,decision_kind,decision_scope_ref,action_scope_sha256,decision_state,route_classification,
  party_reference,responsibility_reference,specialist_reference,decision_sha256,valid_from,valid_until,recorded_by_user_id,recorded_request_id)
 VALUES(sender_route,ws,subject,'pecr_sender_route','mhp.owned-self-test:'||p_command::text,scope,'approved','individual_consent','mhp.sender.MH196Ltd','mhp.instigator.MH196Ltd',review_authority,
   public.digest(facts_sha||convert_to(':sender','UTF8'),'sha256'),prepared,expiry,actor,request),
  (instigator_route,ws,subject,'pecr_instigator_route','mhp.owned-self-test:'||p_command::text,scope,'approved','individual_consent','mhp.sender.MH196Ltd','mhp.instigator.MH196Ltd',review_authority,
   public.digest(facts_sha||convert_to(':instigator','UTF8'),'sha256'),prepared,expiry,actor,request);
 nonce:=public.digest('mhp.sms.owned-test:'||ws::text||':'||actor::text||':'||p_command::text,'sha256');
 INSERT INTO app_private.affiliate_compliance_permission_use_receipts(id,workspace_id,subject_id,permission,action_scope_sha256,evidence_snapshot_sha256,decision_nonce_sha256,
  evaluated_at,decision_expires_at,consumed_at,recorded_by_user_id,recorded_request_id)
 VALUES(permission_use,ws,subject,'sms.send',scope,facts_sha,nonce,prepared,expiry,prepared,actor,request);
 request_sha:=app_private.derive_sms_live_request_digest(ws,binding.provider_connection_id,version,approval_request,approval,binding.channel_endpoint_id,consent,subject,
  publication,sender_route,instigator_route,permission_use,expiry,operation,delivery,correlation,nonce);
 SELECT * INTO queued FROM app_private.authorize_and_enqueue_sms_live_job(ws,binding.provider_connection_id,version,approval_request,approval,binding.channel_endpoint_id,consent,subject,
  publication,sender_route,instigator_route,permission_use,expiry,operation,delivery,correlation,nonce,request_sha,segments);
 IF queued.job_id IS NULL THEN RAISE EXCEPTION 'Owned SMS enqueue returned no job' USING ERRCODE='23514'; END IF;
 IF clock_timestamp()>=expiry THEN RAISE EXCEPTION 'Owned SMS authority expired before completion' USING ERRCODE='23514'; END IF;
 outcome:=jsonb_build_object('jobId',queued.job_id,'messageVersionId',version,'contentVersionId',p_content_version,'commandId',p_command,
  'authorityExpiresAt',to_char(expiry AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'state','queued','replayed',false,
  'consentId',consent,'messageApprovalRequestId',approval_request,'messageApprovalDecisionId',approval,'policyPublicationId',publication,'permissionUseId',permission_use,
  'reviewAuthority',review_authority,'providerEffects','none');
 UPDATE app.command_receipts SET result=outcome,status='succeeded',response_status=200,completed_at=clock_timestamp() WHERE id=command_receipt AND workspace_id=ws;
 RETURN outcome;
END $f$;

-- R8: exact0056 claim body; only disambiguate its existing lease PK conflict target.
CREATE OR REPLACE FUNCTION app_private.claim_sms_live_job(
  p_workspace_id uuid, p_provider_connection_id uuid,
  p_lease_token bytea, p_lease_seconds integer
) RETURNS TABLE (job_id uuid, lease_version bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE selected record;
  recovered app.property_predator_sms_jobs%ROWTYPE;
  timeout_event_id text;
  timeout_safe_code text;
BEGIN
  IF session_user <> 'r72_sms_worker_command'
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'worker'
     OR coalesce(current_setting('app.user_id', true), '') <> ''
     OR coalesce(current_setting('app.request_id', true), '') = ''
     OR octet_length(p_lease_token) <> 32 OR p_lease_seconds NOT BETWEEN 30 AND 300 THEN
    RAISE EXCEPTION 'Twilio SMS claim denied' USING ERRCODE = '42501';
  END IF;
  -- A lost lease before calling is safe to requeue. Once calling began, or an
  -- authenticated status callback failed to arrive by its deadline, append
  -- immutable outcome-unknown evidence and quarantine every mutable projection.
  FOR recovered IN
    SELECT job.* FROM app.property_predator_sms_jobs AS job
    WHERE job.workspace_id = p_workspace_id
      AND job.provider_connection_id = p_provider_connection_id
      AND (
        (job.state IN ('leased', 'calling')
          AND job.lease_expires_at <= statement_timestamp())
        OR (job.state = 'awaiting_receipt'
          AND job.receipt_deadline <= statement_timestamp())
      )
    FOR UPDATE SKIP LOCKED
  LOOP
    IF recovered.state IN ('calling', 'awaiting_receipt') THEN
      timeout_event_id := CASE WHEN recovered.state = 'calling'
        THEN format('worker-timeout:%s:%s', recovered.id, recovered.lease_version)
        ELSE format('receipt-timeout:%s', recovered.id) END;
      timeout_safe_code := CASE WHEN recovered.state = 'calling'
        THEN 'twilio_sms_call_outcome_unknown'
        ELSE 'twilio_sms_receipt_outcome_unknown' END;
      INSERT INTO app.property_predator_sms_receipts (
        workspace_id, job_id, provider_connection_id, external_event_id,
        event_kind, provider_message_id, recipient_or_sender_sha256,
        body_sha256, payload_sha256, safe_code, provider_occurred_at
      ) VALUES (
        recovered.workspace_id, recovered.id, recovered.provider_connection_id,
        timeout_event_id, 'outcome_unknown', recovered.provider_external_id,
        recovered.recipient_sha256, NULL,
        public.digest(timeout_event_id, 'sha256'),
        timeout_safe_code, statement_timestamp()
      ) ON CONFLICT (workspace_id, provider_connection_id, external_event_id)
        DO NOTHING;
      UPDATE app.message_deliveries SET status = 'reconciliation_required',
        updated_at = statement_timestamp()
      WHERE workspace_id = recovered.workspace_id
        AND id = recovered.message_delivery_id
        AND status IN ('sending', 'accepted');
      UPDATE app.provider_operations AS operation SET
        state = 'reconciliation_required', next_attempt_at = 'infinity'::timestamptz,
        lease_token_hash = NULL, lease_expires_at = NULL,
        last_error_code = timeout_safe_code,
        last_summary = 'Twilio SMS provider outcome is unknown; manual reconciliation required',
        row_version = operation.row_version + 1,
        updated_at = statement_timestamp(), completed_at = NULL
      WHERE operation.workspace_id = recovered.workspace_id
        AND operation.id = recovered.operation_id
        AND operation.message_delivery_id = recovered.message_delivery_id
        AND operation.provider_connection_id = recovered.provider_connection_id
        AND operation.idempotency_key ~ '^twilio-sms-live:[0-9a-f]{64}$';
    END IF;
    UPDATE app.property_predator_sms_jobs SET
      state = CASE WHEN recovered.state = 'leased' AND recovered.claim_count < 8
        THEN 'queued' ELSE 'needs_attention' END,
      available_at = CASE WHEN recovered.state = 'leased' AND recovered.claim_count < 8
        THEN statement_timestamp() ELSE recovered.available_at END,
      lease_expires_at = NULL, receipt_deadline = NULL,
      settled_at = CASE WHEN recovered.state = 'leased' AND recovered.claim_count < 8
        THEN recovered.settled_at ELSE statement_timestamp() END,
      updated_at = statement_timestamp()
    WHERE workspace_id = recovered.workspace_id AND id = recovered.id;
    DELETE FROM app.property_predator_sms_job_leases
    WHERE workspace_id = recovered.workspace_id AND job_id = recovered.id;
  END LOOP;

  SELECT job.id, job.lease_version INTO selected
  FROM app.property_predator_sms_jobs AS job
  JOIN app.property_predator_sms_authorities AS authority
    ON authority.workspace_id = job.workspace_id AND authority.id = job.authority_id
   AND authority.provider_connection_id = job.provider_connection_id
   AND authority.message_delivery_id = job.message_delivery_id
   AND authority.recipient_sha256 = job.recipient_sha256
  JOIN app.provider_connections AS connection
    ON connection.workspace_id = job.workspace_id
   AND connection.id = job.provider_connection_id
   AND connection.provider_id = 'twilio_messaging' AND connection.provider_kind = 'sms'
   AND connection.environment = 'live' AND connection.status = 'active'
   AND connection.capabilities @> '["sms.send"]'::jsonb
  JOIN app.contact_points AS point
    ON point.workspace_id = authority.workspace_id
   AND point.id = authority.contact_point_id AND point.contact_id = authority.contact_id
   AND point.kind = 'phone' AND point.deleted_at IS NULL
   AND point.is_verified AND point.dedupe_state = 'normal'
   AND public.digest(point.normalized_value, 'sha256') = job.recipient_sha256
  JOIN app.communication_consent_events AS consent
    ON consent.workspace_id = authority.workspace_id AND consent.id = authority.consent_event_id
   AND consent.contact_id = authority.contact_id
   AND consent.contact_point_id = authority.contact_point_id
   AND consent.channel = 'sms' AND consent.purpose = authority.purpose
   AND consent.state = 'granted' AND consent.lawful_basis = authority.lawful_basis
   AND consent.endpoint_identity_sha256 = authority.endpoint_identity_sha256
  WHERE job.workspace_id = p_workspace_id
    AND job.provider_connection_id = p_provider_connection_id
    AND job.state = 'queued' AND job.available_at <= statement_timestamp()
    AND authority.valid_until > statement_timestamp()
    AND consent.id = (
      SELECT latest.id FROM app.communication_consent_events AS latest
      WHERE latest.workspace_id = authority.workspace_id
        AND latest.contact_point_id = authority.contact_point_id
        AND latest.channel = 'sms' AND latest.purpose = authority.purpose
      ORDER BY latest.occurred_at DESC, latest.recorded_at DESC, latest.id DESC LIMIT 1
    )
    AND NOT EXISTS (
      SELECT 1 FROM app.communication_suppression_events AS suppression
      WHERE suppression.workspace_id = authority.workspace_id
        AND suppression.contact_point_id = authority.contact_point_id
        AND suppression.channel = 'sms'
        AND (suppression.purpose IS NULL OR suppression.purpose = authority.purpose)
        AND suppression.state = 'suppressed'
        AND suppression.id = (
          SELECT latest.id FROM app.communication_suppression_events AS latest
          WHERE latest.workspace_id = suppression.workspace_id
            AND latest.contact_point_id = suppression.contact_point_id
            AND latest.channel = suppression.channel
            AND latest.purpose IS NOT DISTINCT FROM suppression.purpose
          ORDER BY latest.occurred_at DESC, latest.recorded_at DESC, latest.id DESC LIMIT 1
        )
    )
  ORDER BY job.available_at, job.created_at, job.id
  LIMIT 1 FOR UPDATE OF job SKIP LOCKED;
  IF selected.id IS NULL THEN RETURN; END IF;
  UPDATE app.property_predator_sms_jobs SET state = 'leased',
    lease_version = property_predator_sms_jobs.lease_version + 1,
    lease_expires_at = statement_timestamp() + make_interval(secs => p_lease_seconds),
    claim_count = claim_count + 1, updated_at = statement_timestamp()
  WHERE workspace_id = p_workspace_id AND id = selected.id
  RETURNING property_predator_sms_jobs.lease_version
    INTO selected.lease_version;
  INSERT INTO app.property_predator_sms_job_leases (
    workspace_id, job_id, lease_version, lease_token_sha256
  ) VALUES (
    p_workspace_id, selected.id, selected.lease_version,
    public.digest(p_lease_token, 'sha256')
  ) ON CONFLICT ON CONSTRAINT property_predator_sms_job_leases_pkey DO UPDATE SET
    lease_version = EXCLUDED.lease_version,
    lease_token_sha256 = EXCLUDED.lease_token_sha256,
    issued_at = statement_timestamp();
  RETURN QUERY SELECT selected.id, selected.lease_version;
END
$function$;

REVOKE ALL ON FUNCTION app_private.mhp_owned_sms_snapshot(bytea,uuid,text),app_private.mhp_owned_sms_send(bytea,uuid,uuid,uuid,uuid,uuid,bytea,text,boolean,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.mhp_owned_sms_snapshot(bytea,uuid,text),app_private.mhp_owned_sms_send(bytea,uuid,uuid,uuid,uuid,uuid,bytea,text,boolean,boolean) TO r72_sms_command;
SET LOCAL ROLE r72_owner;
GRANT EXECUTE ON FUNCTION app_private.derive_sms_live_request_digest(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,timestamptz,uuid,uuid,uuid,bytea),
 app_private.authorize_and_enqueue_sms_live_job(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,timestamptz,uuid,uuid,uuid,bytea,bytea,integer) TO r72_sms_definer;
REVOKE CREATE ON SCHEMA app_private FROM r72_sms_definer,r72_mhp_prospect_definer;
