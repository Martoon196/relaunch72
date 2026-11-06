-- MHP-WA-INBOUND-001. Official signed first-contact intake, not marketing consent.
-- Preserve the exact historical implementations as private delegates. Public
-- command signatures/roles remain unchanged; PP and JOIN/STOP retain their gates.
SET LOCAL ROLE r72_owner;
GRANT CREATE ON SCHEMA app_private TO r72_whatsapp_live_definer;
CREATE POLICY mhp_whatsapp_first_contact_insert ON app.contacts FOR INSERT TO r72_whatsapp_live_definer
 WITH CHECK(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b'
  AND session_user='r72_whatsapp_live_webhook_command' AND current_setting('app.actor_kind',true)='webhook'
  AND owner_user_id IS NULL AND lifecycle_status='lead' AND source='mhp:whatsapp:inbound' AND deleted_at IS NULL);
SET LOCAL ROLE r72_whatsapp_live_definer;

ALTER FUNCTION app_private.record_whatsapp_live_inbound_projection(uuid,uuid,text,text,text,text,bytea,bytea,bytea,bytea,bytea,timestamptz)
 RENAME TO record_whatsapp_live_inbound_projection_0141;
REVOKE ALL ON FUNCTION app_private.record_whatsapp_live_inbound_projection_0141(uuid,uuid,text,text,text,text,bytea,bytea,bytea,bytea,bytea,timestamptz)
 FROM PUBLIC,r72_whatsapp_live_webhook_command;

CREATE FUNCTION app_private.record_whatsapp_live_inbound_projection(
 p_workspace_id uuid,p_binding_id uuid,p_external_event_id text,p_provider_message_id text,p_normalized_sender text,p_body_text text,
 p_sender_sha256 bytea,p_body_sha256 bytea,p_payload_sha256 bytea,p_signature_sha256 bytea,p_event_identity_sha256 bytea,p_occurred_at timestamptz)
RETURNS TABLE(disposition text,receipt_id uuid,conversation_id uuid,message_id uuid,message_version_id uuid,admin_call_task_id uuid,admin_call_origin_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE ws constant uuid:='2789228d-55a6-4688-b1e8-2f70abca990b'; failure text; created_contact uuid; created_point uuid;
BEGIN
 IF p_workspace_id IS DISTINCT FROM ws OR p_body_text~*'^[[:space:]]*(join|stop|stopall|unsubscribe|cancel|end|quit|optout|opt out)([^[:alnum:]]|$)' THEN
  RETURN QUERY SELECT * FROM app_private.record_whatsapp_live_inbound_projection_0141(p_workspace_id,p_binding_id,p_external_event_id,p_provider_message_id,
   p_normalized_sender,p_body_text,p_sender_sha256,p_body_sha256,p_payload_sha256,p_signature_sha256,p_event_identity_sha256,p_occurred_at);
  RETURN;
 END IF;
 IF session_user<>'r72_whatsapp_live_webhook_command' OR current_setting('app.workspace_id',true) IS DISTINCT FROM ws::text
  OR current_setting('app.actor_kind',true) IS DISTINCT FROM 'webhook' OR coalesce(current_setting('app.user_id',true),'')<>''
  OR p_normalized_sender IS NULL OR p_normalized_sender!~'^[1-9][0-9]{6,14}$' OR p_binding_id IS NULL
  OR p_external_event_id IS NULL OR length(p_external_event_id) NOT BETWEEN 1 AND 500
 THEN RAISE EXCEPTION 'MHP first-contact context denied' USING ERRCODE='42501'; END IF;
 -- Same ordering as the existing MHP JOIN/STOP wrapper. Lock the event before
 -- its sender; different messages cannot race into two contacts/conversations.
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
  format('mhp-wa-inbox:%s:%s:%s',p_workspace_id,p_binding_id,p_external_event_id),7200132));
 PERFORM app_private.mhp_event_phone_lock(ARRAY['mhp.event-whatsapp.phone:+'||p_normalized_sender]);
 BEGIN
  -- This original implementation first proves role/context, hashes, admission
  -- window and active binding. Only its exact missing-point refusal is caught.
  RETURN QUERY SELECT * FROM app_private.record_whatsapp_live_inbound_projection_0141(p_workspace_id,p_binding_id,p_external_event_id,p_provider_message_id,
   p_normalized_sender,p_body_text,p_sender_sha256,p_body_sha256,p_payload_sha256,p_signature_sha256,p_event_identity_sha256,p_occurred_at);
  RETURN;
 EXCEPTION WHEN foreign_key_violation THEN
  GET STACKED DIAGNOSTICS failure=MESSAGE_TEXT;
  IF failure<>'WhatsApp live inbound verified contact point not found' THEN RAISE; END IF;
 END;
 IF app_private.mhp_unlinked_opt_latest('whatsapp',public.digest('+'||p_normalized_sender,'sha256'))='stop'
  OR EXISTS(SELECT 1 FROM app_private.mhp_event_whatsapp_intents i WHERE i.phone_e164='+'||p_normalized_sender AND i.state IN('awaiting_join','held'))
 THEN RAISE EXCEPTION 'WhatsApp live inbound verified contact point not found' USING ERRCODE='23503'; END IF;
 -- Never merge or promote an imported/unverified/ambiguous existing identity.
 IF EXISTS(SELECT 1 FROM app.contact_points p WHERE p.workspace_id=ws AND p.kind='whatsapp' AND p.deleted_at IS NULL
  AND (CASE WHEN left(p.normalized_value,1)='+' THEN substring(p.normalized_value FROM 2) ELSE p.normalized_value END)=p_normalized_sender)
 THEN RAISE EXCEPTION 'MHP WhatsApp identity needs review' USING ERRCODE='23503'; END IF;
 created_contact:=gen_random_uuid(); created_point:=gen_random_uuid();
 INSERT INTO app.contacts(id,workspace_id,display_name,lifecycle_status,owner_user_id,source)
 VALUES(created_contact,ws,'WhatsApp enquiry','lead',NULL,'mhp:whatsapp:inbound');
 INSERT INTO app.contact_points(id,workspace_id,contact_id,kind,value,normalized_value,is_verified,consent_status,dedupe_state)
 VALUES(created_point,ws,created_contact,'whatsapp','+'||p_normalized_sender,p_normalized_sender,false,'unknown','normal');
 -- A signed Meta inbound proves this WhatsApp sender, not an email address or
 -- permission for future marketing. This UPDATE touches only the new point.
 UPDATE app.contact_points SET is_verified=true,row_version=row_version+1,updated_at=statement_timestamp()
 WHERE workspace_id=ws AND id=created_point AND NOT is_verified;
 RETURN QUERY SELECT * FROM app_private.record_whatsapp_live_inbound_projection_0141(p_workspace_id,p_binding_id,p_external_event_id,p_provider_message_id,
  p_normalized_sender,p_body_text,p_sender_sha256,p_body_sha256,p_payload_sha256,p_signature_sha256,p_event_identity_sha256,p_occurred_at);
END $f$;
REVOKE ALL ON FUNCTION app_private.record_whatsapp_live_inbound_projection(uuid,uuid,text,text,text,text,bytea,bytea,bytea,bytea,bytea,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.record_whatsapp_live_inbound_projection(uuid,uuid,text,text,text,text,bytea,bytea,bytea,bytea,bytea,timestamptz)
 TO r72_whatsapp_live_webhook_command;

ALTER FUNCTION app_private.record_whatsapp_live_status(uuid,uuid,text,text,bytea,text,bytea,timestamptz) RENAME TO record_whatsapp_live_status_0141;
REVOKE ALL ON FUNCTION app_private.record_whatsapp_live_status_0141(uuid,uuid,text,text,bytea,text,bytea,timestamptz)
 FROM PUBLIC,r72_whatsapp_live_webhook_command;
CREATE FUNCTION app_private.record_whatsapp_live_status(p_workspace_id uuid,p_binding_id uuid,p_external_event_id text,
 p_provider_message_id text,p_recipient_sha256 bytea,p_status text,p_payload_sha256 bytea,p_occurred_at timestamptz) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE ws constant uuid:='2789228d-55a6-4688-b1e8-2f70abca990b'; prior app.property_predator_whatsapp_live_receipts%ROWTYPE; failure text;
BEGIN
 IF p_workspace_id IS DISTINCT FROM ws THEN
  RETURN app_private.record_whatsapp_live_status_0141(p_workspace_id,p_binding_id,p_external_event_id,p_provider_message_id,p_recipient_sha256,p_status,p_payload_sha256,p_occurred_at);
 END IF;
 IF session_user<>'r72_whatsapp_live_webhook_command' OR current_setting('app.workspace_id',true) IS DISTINCT FROM ws::text
  OR current_setting('app.actor_kind',true) IS DISTINCT FROM 'webhook' OR coalesce(current_setting('app.user_id',true),'')<>''
  OR coalesce(current_setting('app.request_id',true),'')='' OR p_binding_id IS NULL
  OR p_external_event_id IS NULL OR p_external_event_id<>btrim(p_external_event_id) OR length(p_external_event_id) NOT BETWEEN 1 AND 500
  OR p_provider_message_id IS NULL OR p_provider_message_id!~'^wamid[.][A-Za-z0-9_=-]{1,190}$'
  OR p_status IS NULL OR p_status NOT IN('sent','delivered','read','failed','deleted')
  OR octet_length(p_recipient_sha256) IS DISTINCT FROM 32 OR octet_length(p_payload_sha256) IS DISTINCT FROM 32
  OR p_occurred_at IS NULL THEN RAISE EXCEPTION 'MHP WhatsApp status context denied' USING ERRCODE='42501'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(format('pp-whatsapp-webhook:%s:%s:%s',ws,p_binding_id,p_external_event_id),0));
 SELECT * INTO prior FROM app.property_predator_whatsapp_live_receipts r
 WHERE r.workspace_id=ws AND r.binding_id=p_binding_id AND r.external_event_id=p_external_event_id AND r.safe_code='mhp_whatsapp_unmatched_status';
 IF FOUND THEN
  RETURN CASE WHEN prior.job_id IS NOT NULL OR prior.provider_message_id IS DISTINCT FROM p_provider_message_id
   OR prior.recipient_or_sender_sha256 IS DISTINCT FROM p_recipient_sha256 OR prior.event_kind IS DISTINCT FROM p_status
   OR prior.payload_sha256 IS DISTINCT FROM p_payload_sha256 OR prior.provider_occurred_at IS DISTINCT FROM p_occurred_at
   THEN 'conflict' ELSE 'replayed' END;
 END IF;
 BEGIN
  RETURN app_private.record_whatsapp_live_status_0141(ws,p_binding_id,p_external_event_id,p_provider_message_id,p_recipient_sha256,p_status,p_payload_sha256,p_occurred_at);
 EXCEPTION WHEN insufficient_privilege THEN
  GET STACKED DIAGNOSTICS failure=MESSAGE_TEXT;
  IF failure<>'WhatsApp status has no exact outbound job' THEN RAISE; END IF;
 END;
 IF p_occurred_at<statement_timestamp()-interval '7 days' OR p_occurred_at>statement_timestamp()+interval '5 minutes'
  OR NOT EXISTS(SELECT 1 FROM app.property_predator_whatsapp_live_bindings b JOIN app.provider_connections c
   ON c.workspace_id=b.workspace_id AND c.id=b.provider_connection_id
   WHERE b.workspace_id=ws AND b.id=p_binding_id AND b.status='active' AND b.environment='live'
    AND c.provider_id='meta_whatsapp_cloud' AND c.status='active' AND c.environment='live'
    AND NOT EXISTS(SELECT 1 FROM app.property_predator_whatsapp_live_binding_revocations v WHERE v.workspace_id=ws AND v.binding_id=b.id))
 THEN RAISE EXCEPTION 'MHP unmatched WhatsApp status binding denied' USING ERRCODE='42501'; END IF;
 -- Record the signed observation, never fabricate a job, authority, consent or
 -- campaign settlement for an operator/provider-console send.
 INSERT INTO app.property_predator_whatsapp_live_receipts(workspace_id,job_id,binding_id,external_event_id,event_kind,
  provider_message_id,recipient_or_sender_sha256,body_sha256,payload_sha256,safe_code,provider_occurred_at)
 VALUES(ws,NULL,p_binding_id,p_external_event_id,p_status,p_provider_message_id,p_recipient_sha256,NULL,p_payload_sha256,'mhp_whatsapp_unmatched_status',p_occurred_at);
 RETURN 'applied';
END $f$;
REVOKE ALL ON FUNCTION app_private.record_whatsapp_live_status(uuid,uuid,text,text,bytea,text,bytea,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.record_whatsapp_live_status(uuid,uuid,text,text,bytea,text,bytea,timestamptz) TO r72_whatsapp_live_webhook_command;
RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_whatsapp_live_definer;
DO $audit$ BEGIN
 IF has_function_privilege('r72_whatsapp_live_webhook_command','app_private.record_whatsapp_live_inbound_projection_0141(uuid,uuid,text,text,text,text,bytea,bytea,bytea,bytea,bytea,timestamptz)','EXECUTE')
  OR has_function_privilege('r72_whatsapp_live_webhook_command','app_private.record_whatsapp_live_status_0141(uuid,uuid,text,text,bytea,text,bytea,timestamptz)','EXECUTE')
 THEN RAISE EXCEPTION 'Internal WhatsApp delegates must not be command capabilities'; END IF;
END $audit$;
