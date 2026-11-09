-- MHP009B-F3: direct same-browser signup handoff. No inbox-ownership claim.
-- Existing email-link access, explicit consent, signed JOIN, STOP and owner batch remain.
SET LOCAL ROLE r72_owner;
ALTER TABLE app_private.mhp_event_phone_intents ADD COLUMN access_authority text
 CHECK(access_authority IS NULL OR (kind='access' AND access_authority='signup_post'));
-- Existing table SELECT grant; no LOGIN table access. The closed command returns only eligibility.
CREATE POLICY mhp_event_phone_signup_email_read ON app.contact_points FOR SELECT TO r72_mhp_prospect_definer
 USING(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND session_user='r72_identity_command' AND kind='email');
GRANT CREATE ON SCHEMA app_private TO r72_mhp_prospect_definer;
SET LOCAL ROLE r72_mhp_prospect_definer;
CREATE FUNCTION app_private.mhp_event_phone_from_signup(p_signup uuid,p_prospect uuid,p_campaign text,p_capability_sha bytea,p_source_sha bytea) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE signup app_private.mhp_prospect_signups%ROWTYPE; prospect app_private.mhp_prospects%ROWTYPE;
 existing app_private.mhp_event_phone_intents%ROWTYPE; programme jsonb; key_sha bytea; payload_sha bytea;
 stamp timestamptz:=statement_timestamp(); expiry timestamptz;
BEGIN
 IF session_user<>'r72_identity_command' OR p_signup IS NULL OR p_prospect IS NULL OR p_campaign IS NULL
  OR p_campaign!~'^webinar-[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR octet_length(p_capability_sha) IS DISTINCT FROM 32
  OR octet_length(p_source_sha) IS DISTINCT FROM 32
 THEN RAISE EXCEPTION 'Invalid signup phone handoff' USING ERRCODE='22023'; END IF;
 key_sha:=public.digest('mhp.event-phone.signup:'||p_signup::text,'sha256');
 payload_sha:=public.digest('mhp.event-phone.signup-payload/v1:'||p_signup::text||':'||p_prospect::text||':'||p_campaign||':'||encode(p_capability_sha,'hex')||':'||encode(p_source_sha,'hex'),'sha256');
 -- Same campaign lock as real capture_v2, then the existing event/prospect key.
 PERFORM pg_advisory_xact_lock(hashtextextended('mhp-capture-campaign:'||p_campaign,7200128));
 PERFORM app_private.mhp_event_phone_lock(ARRAY['mhp.event-phone.prospect:'||p_campaign||':'||p_prospect::text]);
 SELECT * INTO existing FROM app_private.mhp_event_phone_intents i
 WHERE i.workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND i.request_key_sha256=key_sha;
 IF FOUND THEN
  IF existing.payload_sha256 IS DISTINCT FROM payload_sha OR existing.signup_id IS DISTINCT FROM p_signup
   OR existing.prospect_id IS DISTINCT FROM p_prospect OR existing.campaign IS DISTINCT FROM p_campaign
   OR existing.source_sha256 IS DISTINCT FROM p_source_sha OR existing.capability_sha256 IS DISTINCT FROM p_capability_sha
   OR existing.access_authority IS DISTINCT FROM 'signup_post'
  THEN RAISE EXCEPTION 'Signup phone handoff conflicts' USING ERRCODE='40001'; END IF;
  RETURN jsonb_build_object('ok',existing.state='open' AND existing.capability_expires_at>clock_timestamp(),'replayed',true,
   'expiresAt',to_char(existing.capability_expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'));
 END IF;
 SELECT * INTO signup FROM app_private.mhp_prospect_signups s WHERE s.id=p_signup AND s.prospect_id=p_prospect
  AND s.entry_campaign=p_campaign AND s.entry_source='mhp.capture/v2' AND s.entry_event_sequence>0
  AND s.kind='webinar' AND s.consent_given AND s.source_hash=p_source_sha;
 IF NOT FOUND OR signup.created_at<clock_timestamp()-interval '2 minutes' OR signup.created_at>clock_timestamp()
 THEN RETURN jsonb_build_object('ok',false); END IF;
 SELECT * INTO prospect FROM app_private.mhp_prospects p WHERE p.id=p_prospect;
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',false); END IF;
 IF EXISTS(SELECT 1 FROM app_private.mhp_prospect_signups s WHERE s.prospect_id=p_prospect AND s.id<>p_signup AND s.kind='webinar'
   AND (s.entry_campaign=p_campaign OR s.entry_campaign IS NULL))
  OR EXISTS(SELECT 1 FROM app.contact_points p WHERE p.workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b'
   AND p.kind='email' AND lower(p.normalized_value)=prospect.email::text)
 THEN RETURN jsonb_build_object('ok',false); END IF;
 programme:=app_private.mhp_event_phone_current_programme();
 IF programme IS NULL OR programme->>'event' IS DISTINCT FROM p_campaign
  OR (programme->>'dueAt')::timestamptz<=clock_timestamp()+interval '1 minute'
 THEN RETURN jsonb_build_object('ok',false); END IF;
 -- Do not renew a two-minute capture if a lock or query consumed its authority window.
 IF signup.created_at<clock_timestamp()-interval '2 minutes' THEN RETURN jsonb_build_object('ok',false); END IF;
 stamp:=clock_timestamp(); expiry:=stamp+interval '15 minutes';
 INSERT INTO app_private.mhp_event_phone_intents(workspace_id,prospect_id,signup_id,campaign,programme_version_id,kind,revision,state,
  command_id,request_key_sha256,payload_sha256,source_sha256,email_identity_sha256,access_token_sha256,access_expires_at,
  access_consumed_at,capability_sha256,capability_expires_at,access_authority,created_at,updated_at)
 VALUES('2789228d-55a6-4688-b1e8-2f70abca990b',p_prospect,p_signup,p_campaign,(programme->>'programmeVersionId')::uuid,'access',1,'open',
  gen_random_uuid(),key_sha,payload_sha,p_source_sha,public.digest('mhp.event-phone.email:'||prospect.email::text,'sha256'),
  public.digest('mhp.event-phone.signup-unused-access/v1:'||encode(p_capability_sha,'hex'),'sha256'),expiry,
  stamp,p_capability_sha,expiry,'signup_post',stamp,stamp);
 RETURN jsonb_build_object('ok',true,'replayed',false,'expiresAt',to_char(expiry AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'));
END $f$;
REVOKE ALL ON FUNCTION app_private.mhp_event_phone_from_signup(uuid,uuid,text,bytea,bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.mhp_event_phone_from_signup(uuid,uuid,text,bytea,bytea) TO r72_identity_command;
RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_mhp_prospect_definer;

-- Mode-aware JOIN: parent access authority is immutable. Same-browser signup
-- NEVER proves an email address and cannot attach to an existing CRM identity.
GRANT CREATE ON SCHEMA app_private TO r72_sms_definer;
SET LOCAL ROLE r72_sms_definer;
CREATE OR REPLACE FUNCTION app_private.mhp_record_event_sms_inbound(p_workspace uuid,p_connection uuid,p_external_event text,p_message_sid text,
 p_normalized_sender text,p_opt_evidence text,p_body text,p_sender_sha bytea,p_body_sha bytea,p_payload_sha bytea,p_signature_sha bytea,
 p_event_identity_sha bytea,p_occurred timestamptz) RETURNS TABLE(disposition text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE ws constant uuid:='2789228d-55a6-4688-b1e8-2f70abca990b'; nonce text; intent app_private.mhp_event_phone_intents%ROWTYPE;
 programme jsonb; binding app.property_predator_sms_bindings%ROWTYPE; prospect app_private.mhp_prospects%ROWTYPE; phone text;
 phone_point app.contact_points%ROWTYPE; email_point app.contact_points%ROWTYPE; ambiguous boolean:=false; contact uuid; point uuid;
 endpoint_sha bytea; consent uuid:=gen_random_uuid(); receipt uuid:=gen_random_uuid(); outcome text; now_at timestamptz:=statement_timestamp();
 grant_row record; stop_point app.contact_points%ROWTYPE; withdrawn_consent uuid; phone_sha bytea;
 unlinked app_private.mhp_unlinked_opt_events%ROWTYPE; signup_post boolean:=false;
BEGIN
 IF session_user<>'r72_sms_webhook_command' OR p_workspace IS DISTINCT FROM ws OR current_setting('app.workspace_id',true) IS DISTINCT FROM ws::text
  OR current_setting('app.actor_kind',true) IS DISTINCT FROM 'webhook' OR coalesce(current_setting('app.user_id',true),'')<>''
  OR p_message_sid IS NULL OR p_message_sid!~'^(?:SM|MM)[0-9a-f]{32}$' OR p_external_event IS DISTINCT FROM 'inbound:'||p_message_sid
  OR p_normalized_sender IS NULL OR p_normalized_sender!~'^44[0-9]{9,10}$' OR p_body IS NULL OR p_opt_evidence IS NULL
  OR p_sender_sha IS DISTINCT FROM public.digest(p_normalized_sender,'sha256') OR p_body_sha IS DISTINCT FROM public.digest(p_body,'sha256')
  OR octet_length(p_payload_sha) IS DISTINCT FROM 32 OR octet_length(p_signature_sha) IS DISTINCT FROM 32
  OR octet_length(p_event_identity_sha) IS DISTINCT FROM 32 OR p_occurred IS NULL
 THEN RAISE EXCEPTION 'MHP event inbound evidence is invalid' USING ERRCODE='22023'; END IF;
 -- Same event key as the existing projection (re-entrant), so replays serialise.
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(format('pp-sms-inbox:%s:%s:%s',p_workspace,p_connection,p_external_event),7200056));
 SELECT * INTO unlinked FROM app_private.mhp_unlinked_opt_events e
 WHERE e.workspace_id=ws AND e.channel='sms' AND e.provider_event_id=p_external_event;
 IF unlinked.id IS NOT NULL THEN
  -- The legacy projection has no receipt for an unknown sender, so compare the immutable
  -- unlinked evidence itself before treating this provider ID as an identical replay.
  RETURN QUERY SELECT CASE WHEN
   unlinked.provider_connection_id IS DISTINCT FROM p_connection
   OR unlinked.provider_message_id IS DISTINCT FROM p_message_sid
   OR unlinked.phone_identity_sha256 IS DISTINCT FROM public.digest('+'||p_normalized_sender,'sha256')
   OR unlinked.opt_evidence IS DISTINCT FROM p_opt_evidence
   OR unlinked.body_sha256 IS DISTINCT FROM p_body_sha
   OR unlinked.payload_sha256 IS DISTINCT FROM p_payload_sha
   OR unlinked.signature_sha256 IS DISTINCT FROM p_signature_sha
   OR unlinked.event_identity_sha256 IS DISTINCT FROM p_event_identity_sha
   OR unlinked.occurred_at IS DISTINCT FROM p_occurred
   THEN 'conflict'::text ELSE 'replayed'::text END; RETURN;
 END IF;
 IF EXISTS(SELECT 1 FROM app_private.mhp_event_phone_receipts r WHERE r.provider_connection_id=p_connection AND r.provider_event_id=p_external_event)
  OR EXISTS(SELECT 1 FROM app_private.mhp_event_phone_intents i WHERE i.consumed_provider_event_id=p_external_event) THEN
  outcome:=app_private.mhp_event_sms_project(p_workspace,p_connection,p_external_event,p_message_sid,p_normalized_sender,p_opt_evidence,p_body,
   p_sender_sha,p_body_sha,p_payload_sha,p_signature_sha,p_event_identity_sha,p_occurred,true);
  RETURN QUERY SELECT CASE WHEN outcome='conflict' THEN 'conflict' ELSE 'replayed' END; RETURN;
 END IF;
 phone:='+'||p_normalized_sender;
 nonce:=lower(substring(p_body FROM '^[[:space:]]*[Jj][Oo][Ii][Nn][[:space:]]+([A-Za-z2-7]{26})[[:space:]]*$'));
 IF p_opt_evidence='' AND nonce IS NOT NULL THEN
  SELECT * INTO intent FROM app_private.mhp_event_phone_intents i
  WHERE i.join_nonce_sha256=public.digest('mhp.event-phone.join/v1:'||nonce,'sha256') AND i.kind='sms';
  IF intent.id IS NOT NULL THEN
   -- Same order as choose/withdraw: advisory prospect+phone keys, then the row.
   PERFORM app_private.mhp_event_phone_lock(ARRAY['mhp.event-phone.prospect:'||intent.campaign||':'||intent.prospect_id::text,'mhp.event-phone.phone:'||phone]);
   SELECT * INTO intent FROM app_private.mhp_event_phone_intents i WHERE i.id=intent.id FOR UPDATE;
  END IF;
 END IF;
 IF intent.id IS NULL OR intent.state<>'awaiting_join' OR intent.phone_e164 IS DISTINCT FROM phone THEN
  -- Not a valid JOIN for this number: ordinary existing inbound/STOP behaviour. Only a signed
  -- STOP/START may survive an unknown sender (Astra item 1); every other text keeps the refusal.
  outcome:=app_private.mhp_event_sms_project(p_workspace,p_connection,p_external_event,p_message_sid,p_normalized_sender,p_opt_evidence,p_body,
   p_sender_sha,p_body_sha,p_payload_sha,p_signature_sha,p_event_identity_sha,p_occurred,p_opt_evidence IN('stop','start'));
  IF outcome='unprojected' THEN
   -- A verified point exists but the inbox could not project: the existing refusal, unchanged.
   IF EXISTS(SELECT 1 FROM app.contact_points p WHERE p.workspace_id=ws AND p.kind='phone' AND p.deleted_at IS NULL AND p.is_verified
    AND p.dedupe_state='normal' AND regexp_replace(p.normalized_value,'^\+','')=p_normalized_sender)
   THEN RAISE EXCEPTION 'MHP event inbound could not be projected' USING ERRCODE='23503'; END IF;
   -- No point for this number: record the signed opt event against the phone digest only.
   phone_sha:=public.digest(phone,'sha256');
   PERFORM app_private.mhp_event_phone_lock(coalesce((SELECT array_agg('mhp.event-phone.prospect:'||i.campaign||':'||i.prospect_id::text)
    FROM app_private.mhp_event_phone_intents i WHERE i.kind='sms' AND i.state='awaiting_join' AND i.phone_identity_sha256=phone_sha),'{}'::text[])
    ||ARRAY['mhp.event-phone.phone:'||phone]);
   INSERT INTO app_private.mhp_unlinked_opt_events(workspace_id,channel,provider_connection_id,provider_event_id,provider_message_id,phone_identity_sha256,
    opt_evidence,body_sha256,payload_sha256,signature_sha256,event_identity_sha256,recorded_by_role,occurred_at)
   VALUES(ws,'sms',p_connection,p_external_event,p_message_sid,phone_sha,p_opt_evidence,p_body_sha,p_payload_sha,p_signature_sha,p_event_identity_sha,
    'r72_sms_webhook_command',p_occurred);
   IF p_opt_evidence='stop' THEN
    -- A pending JOIN for this number can no longer verify until a signed START.
    UPDATE app_private.mhp_event_phone_intents SET state='held',hold_reason='suppressed',updated_at=now_at
    WHERE kind='sms' AND state='awaiting_join' AND phone_identity_sha256=phone_sha;
   END IF;
   RETURN QUERY SELECT ('unlinked_'||p_opt_evidence)::text; RETURN;
  END IF;
  IF outcome='applied' AND p_opt_evidence='stop' THEN
   SELECT p.* INTO stop_point FROM app.contact_points p WHERE p.workspace_id=ws AND p.kind='phone' AND p.deleted_at IS NULL AND p.is_verified
    AND p.dedupe_state='normal' AND regexp_replace(p.normalized_value,'^\+','')=p_normalized_sender;
   PERFORM app_private.mhp_event_phone_lock(coalesce((SELECT array_agg('mhp.event-phone.prospect:'||i.campaign||':'||i.prospect_id::text)
    FROM app_private.mhp_event_phone_intents i WHERE i.kind='sms' AND i.state='verified' AND i.point_id=stop_point.id),'{}'::text[]));
   FOR grant_row IN SELECT i.id AS intent_id,i.prospect_id,i.campaign,r.* FROM app_private.mhp_event_phone_intents i
    JOIN app_private.mhp_event_phone_receipts r ON r.id=i.result_receipt_id
    WHERE i.kind='sms' AND i.state='verified' AND i.point_id=stop_point.id ORDER BY i.campaign,i.prospect_id FOR UPDATE OF i LOOP
    IF app_private.mhp_event_phone_current_receipt(grant_row.prospect_id,grant_row.campaign) IS DISTINCT FROM grant_row.id THEN CONTINUE; END IF;
    withdrawn_consent:=gen_random_uuid();
    INSERT INTO app.communication_consent_events(id,workspace_id,contact_id,contact_point_id,channel,purpose,state,lawful_basis,source,policy_version,
     policy_text_sha256,source_event_id,actor_kind,actor_user_id,evidence,endpoint_identity_sha256,occurred_at)
    VALUES(withdrawn_consent,ws,grant_row.contact_id,grant_row.contact_point_id,'sms',grant_row.purpose,'withdrawn',NULL,'mhp.event-phone.stop',
     grant_row.consent_revision,grant_row.consent_text_sha256,p_external_event,'webhook',NULL,
     jsonb_build_object('reason','signed_stop','receiptId',grant_row.id),grant_row.endpoint_identity_sha256,p_occurred);
    INSERT INTO app_private.mhp_event_phone_receipts(workspace_id,intent_id,intent_revision,campaign,prospect_id,signup_id,channel,purpose,contact_id,
     contact_point_id,endpoint_identity_sha256,phone_identity_sha256,decision,consent_revision,consent_text_sha256,consent_event_id,proof_kind,
     provider_connection_id,sender_binding_id,channel_endpoint_id,provider_account_sid_sha256,provider_service_sid_sha256,destination_e164,
     provider_event_id,provider_message_sid,payload_sha256,signature_sha256,body_sha256,event_identity_sha256,occurred_at,supersedes_receipt_id,request_sha256)
    VALUES(ws,grant_row.intent_id,grant_row.intent_revision,grant_row.campaign,grant_row.prospect_id,grant_row.signup_id,'sms',grant_row.purpose,
     grant_row.contact_id,grant_row.contact_point_id,grant_row.endpoint_identity_sha256,grant_row.phone_identity_sha256,'withdrawn',
     grant_row.consent_revision,grant_row.consent_text_sha256,withdrawn_consent,'signed_twilio_stop',p_connection,grant_row.sender_binding_id,
     grant_row.channel_endpoint_id,grant_row.provider_account_sid_sha256,grant_row.provider_service_sid_sha256,grant_row.destination_e164,
     p_external_event,p_message_sid,p_payload_sha,p_signature_sha,p_body_sha,p_event_identity_sha,p_occurred,grant_row.id,p_event_identity_sha);
    UPDATE app_private.mhp_event_phone_intents SET state='withdrawn',updated_at=now_at WHERE id=grant_row.intent_id;
    UPDATE app_private.mhp_marketing_sends SET event_held_at=now_at,event_hold_reason='receipt_changed'
    WHERE delivery_channel='sms' AND event_receipt_id=grant_row.id AND cancelled_at IS NULL AND event_held_at IS NULL;
   END LOOP;
  END IF;
  RETURN QUERY SELECT outcome; RETURN;
 END IF;
 IF intent.join_expires_at<=now_at THEN
  UPDATE app_private.mhp_event_phone_intents SET state='expired',updated_at=now_at WHERE id=intent.id;
  outcome:=app_private.mhp_event_sms_project(p_workspace,p_connection,p_external_event,p_message_sid,p_normalized_sender,p_opt_evidence,p_body,
   p_sender_sha,p_body_sha,p_payload_sha,p_signature_sha,p_event_identity_sha,p_occurred,true);
  RETURN QUERY SELECT 'event_join_expired'::text; RETURN;
 END IF;
 programme:=app_private.mhp_event_phone_current_programme();
 SELECT b.* INTO binding FROM app.property_predator_sms_bindings b WHERE b.workspace_id=ws AND b.id=(programme->>'senderBindingId')::uuid
  AND b.provider_connection_id=p_connection AND b.status='active' AND b.sender_number~'^\+44[0-9]{9,10}$'
  AND NOT EXISTS(SELECT 1 FROM app.property_predator_sms_binding_revocations r WHERE r.workspace_id=b.workspace_id AND r.binding_id=b.id);
 IF programme IS NULL OR programme->>'event' IS DISTINCT FROM intent.campaign OR programme->>'consentRevision' IS DISTINCT FROM intent.consent_revision
  OR programme->>'consentTextSha256' IS DISTINCT FROM encode(intent.consent_text_sha256,'hex') OR binding.id IS NULL THEN
  UPDATE app_private.mhp_event_phone_intents SET state='held',hold_reason='programme_changed',join_consumed_at=now_at,
   consumed_provider_event_id=p_external_event,updated_at=now_at WHERE id=intent.id;
  outcome:=app_private.mhp_event_sms_project(p_workspace,p_connection,p_external_event,p_message_sid,p_normalized_sender,p_opt_evidence,p_body,
   p_sender_sha,p_body_sha,p_payload_sha,p_signature_sha,p_event_identity_sha,p_occurred,true);
  RETURN QUERY SELECT 'event_held'::text; RETURN;
 END IF;
 IF app_private.mhp_unlinked_opt_latest('sms',intent.phone_identity_sha256)='stop' THEN
  -- This number texted STOP before it had a point and has not texted START since (Astra item 1).
  UPDATE app_private.mhp_event_phone_intents SET state='held',hold_reason='suppressed',join_consumed_at=now_at,
   consumed_provider_event_id=p_external_event,updated_at=now_at WHERE id=intent.id;
  outcome:=app_private.mhp_event_sms_project(p_workspace,p_connection,p_external_event,p_message_sid,p_normalized_sender,p_opt_evidence,p_body,
   p_sender_sha,p_body_sha,p_payload_sha,p_signature_sha,p_event_identity_sha,p_occurred,true);
  RETURN QUERY SELECT 'event_held'::text; RETURN;
 END IF;
 SELECT * INTO prospect FROM app_private.mhp_prospects p WHERE p.id=intent.prospect_id;
 -- Same-browser registration never inherits an email-link ownership claim.
 SELECT a.access_authority='signup_post' INTO signup_post FROM app_private.mhp_event_phone_intents a
 WHERE a.id=intent.parent_access_id AND a.kind='access' AND a.prospect_id=intent.prospect_id AND a.signup_id=intent.signup_id AND a.campaign=intent.campaign;
 signup_post:=coalesce(signup_post,false);
 IF signup_post THEN
  -- Include deleted/non-normal/unverified identities. This slice never merges them.
  IF EXISTS(SELECT 1 FROM app.contact_points p WHERE p.workspace_id=ws
   AND ((p.kind='phone' AND p.normalized_value=phone) OR (p.kind='email' AND lower(p.normalized_value)=prospect.email::text)))
  THEN ambiguous:=true; END IF;
 ELSE
 -- Legacy email-link projection is unchanged.
 IF (SELECT count(*) FROM app.contact_points p WHERE p.workspace_id=ws AND p.kind='phone' AND p.normalized_value=phone AND p.deleted_at IS NULL)>1
  OR EXISTS(SELECT 1 FROM app.contact_points p WHERE p.workspace_id=ws AND p.kind='phone' AND p.normalized_value=phone AND p.deleted_at IS NULL AND p.dedupe_state<>'normal')
  OR (SELECT count(*) FROM app.contact_points p WHERE p.workspace_id=ws AND p.kind='email' AND p.normalized_value=prospect.email::text AND p.deleted_at IS NULL)>1
  OR EXISTS(SELECT 1 FROM app.contact_points p WHERE p.workspace_id=ws AND p.kind='email' AND p.normalized_value=prospect.email::text AND p.deleted_at IS NULL AND p.dedupe_state<>'normal')
 THEN ambiguous:=true; END IF;
 SELECT p.* INTO phone_point FROM app.contact_points p WHERE p.workspace_id=ws AND p.kind='phone' AND p.normalized_value=phone AND p.deleted_at IS NULL AND p.dedupe_state='normal';
 SELECT p.* INTO email_point FROM app.contact_points p WHERE p.workspace_id=ws AND p.kind='email' AND p.normalized_value=prospect.email::text AND p.deleted_at IS NULL AND p.dedupe_state='normal';
 IF phone_point.id IS NOT NULL AND email_point.id IS NOT NULL AND phone_point.contact_id<>email_point.contact_id THEN ambiguous:=true; END IF;
 contact:=coalesce(phone_point.contact_id,email_point.contact_id);
 END IF;
 IF contact IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app.contacts c WHERE c.workspace_id=ws AND c.id=contact AND c.deleted_at IS NULL) THEN ambiguous:=true; END IF;
 IF NOT ambiguous AND EXISTS(SELECT 1 FROM(SELECT DISTINCT ON(coalesce(s.purpose,'')) s.state FROM app.communication_suppression_events s
   WHERE s.workspace_id=ws AND s.contact_point_id=phone_point.id AND s.channel='sms' AND(s.purpose IS NULL OR s.purpose=programme->>'purpose')
   ORDER BY coalesce(s.purpose,''),s.occurred_at DESC,s.recorded_at DESC,s.id DESC) latest WHERE latest.state='suppressed') THEN
  UPDATE app_private.mhp_event_phone_intents SET state='held',hold_reason='suppressed',join_consumed_at=now_at,
   consumed_provider_event_id=p_external_event,updated_at=now_at WHERE id=intent.id;
  outcome:=app_private.mhp_event_sms_project(p_workspace,p_connection,p_external_event,p_message_sid,p_normalized_sender,p_opt_evidence,p_body,
   p_sender_sha,p_body_sha,p_payload_sha,p_signature_sha,p_event_identity_sha,p_occurred,true);
  RETURN QUERY SELECT 'event_held'::text; RETURN;
 END IF;
 IF ambiguous THEN
  UPDATE app_private.mhp_event_phone_intents SET state='held',hold_reason='crm_ambiguous',join_consumed_at=now_at,
   consumed_provider_event_id=p_external_event,updated_at=now_at WHERE id=intent.id;
  outcome:=app_private.mhp_event_sms_project(p_workspace,p_connection,p_external_event,p_message_sid,p_normalized_sender,p_opt_evidence,p_body,
   p_sender_sha,p_body_sha,p_payload_sha,p_signature_sha,p_event_identity_sha,p_occurred,true);
  RETURN QUERY SELECT 'event_held'::text; RETURN;
 END IF;
 IF contact IS NULL THEN
  contact:=gen_random_uuid();
  INSERT INTO app.contacts(id,workspace_id,display_name,lifecycle_status,owner_user_id,source)
  VALUES(contact,ws,left(coalesce(nullif(btrim(prospect.first_name),''),prospect.email::text),200),'lead',NULL,'mhp:event-phone:'||intent.campaign);
 END IF;
 IF NOT signup_post AND email_point.id IS NULL THEN
  INSERT INTO app.contact_points(workspace_id,contact_id,kind,value,normalized_value,is_verified,consent_status,dedupe_state)
  VALUES(ws,contact,'email',prospect.email::text,prospect.email::text,true,'unknown','normal');
 END IF;
 IF phone_point.id IS NULL THEN
  point:=gen_random_uuid();
  INSERT INTO app.contact_points(id,workspace_id,contact_id,kind,value,normalized_value,is_verified,consent_status,dedupe_state)
  VALUES(point,ws,contact,'phone',phone,phone,false,'unknown','normal');
  SELECT p.* INTO phone_point FROM app.contact_points p WHERE p.workspace_id=ws AND p.id=point;
 END IF;
 IF NOT phone_point.is_verified THEN
  UPDATE app.contact_points SET is_verified=true,row_version=row_version+1,updated_at=statement_timestamp() WHERE workspace_id=ws AND id=phone_point.id AND NOT is_verified;
 END IF;
 endpoint_sha:=public.digest(phone_point.kind||chr(31)||phone_point.value||chr(31)||phone_point.normalized_value,'sha256');
 INSERT INTO app.communication_consent_events(id,workspace_id,contact_id,contact_point_id,channel,purpose,state,lawful_basis,source,policy_version,
  policy_text_sha256,source_event_id,actor_kind,actor_user_id,evidence,endpoint_identity_sha256,occurred_at)
 VALUES(consent,ws,contact,phone_point.id,'sms',programme->>'purpose','granted','consent','mhp.event-phone.join',intent.consent_revision,
  intent.consent_text_sha256,p_external_event,'webhook',NULL,jsonb_build_object('schema','mhp.event-phone-grant/v1','intentId',intent.id,
   'revision',intent.revision,'receiptId',receipt,'campaign',intent.campaign,'emailProof',CASE WHEN signup_post THEN NULL ELSE 'single-use-link' END,
   'registrationProof',CASE WHEN signup_post THEN 'same-browser-signup-post' ELSE 'email-link' END,'phoneProof','signed-inbound-join',
   'generalMarketing',false),endpoint_sha,p_occurred);
 INSERT INTO app_private.mhp_event_phone_receipts(id,workspace_id,intent_id,intent_revision,campaign,prospect_id,signup_id,channel,purpose,contact_id,
  contact_point_id,endpoint_identity_sha256,phone_identity_sha256,decision,consent_revision,consent_text_sha256,consent_event_id,proof_kind,
  provider_connection_id,sender_binding_id,channel_endpoint_id,provider_account_sid_sha256,provider_service_sid_sha256,destination_e164,
  provider_event_id,provider_message_sid,payload_sha256,signature_sha256,body_sha256,event_identity_sha256,occurred_at,request_sha256)
 VALUES(receipt,ws,intent.id,intent.revision,intent.campaign,intent.prospect_id,intent.signup_id,'sms',programme->>'purpose',contact,phone_point.id,
  endpoint_sha,intent.phone_identity_sha256,'granted',intent.consent_revision,intent.consent_text_sha256,consent,'signed_twilio_join',p_connection,
  binding.id,binding.channel_endpoint_id,binding.account_sid_sha256,binding.messaging_service_sid_sha256,binding.sender_number,
  p_external_event,p_message_sid,p_payload_sha,p_signature_sha,p_body_sha,p_event_identity_sha,p_occurred,p_event_identity_sha);
 UPDATE app_private.mhp_event_phone_intents SET state='verified',join_consumed_at=now_at,consumed_provider_event_id=p_external_event,
  contact_id=contact,point_id=phone_point.id,result_receipt_id=receipt,updated_at=now_at WHERE id=intent.id;
 outcome:=app_private.mhp_event_sms_project(p_workspace,p_connection,p_external_event,p_message_sid,p_normalized_sender,p_opt_evidence,p_body,
  p_sender_sha,p_body_sha,p_payload_sha,p_signature_sha,p_event_identity_sha,p_occurred,false);
 IF outcome IS DISTINCT FROM 'applied' THEN RAISE EXCEPTION 'MHP event JOIN projection did not apply' USING ERRCODE='40001'; END IF;
 RETURN QUERY SELECT 'event_joined'::text;
END $f$;
RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_sms_definer;
RESET ROLE;
