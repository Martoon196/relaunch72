-- Private person-to-person inbox records. A first message creates no CRM or consent identity.
SET LOCAL ROLE r72_owner;
CREATE POLICY mhp_wa_direct_queue_opt_read ON app_private.mhp_unlinked_opt_events
 FOR SELECT TO r72_whatsapp_live_definer USING(channel='whatsapp' AND session_user IN ('r72_crm_command','r72_web')
 AND current_setting('app.workspace_id',true)='2789228d-55a6-4688-b1e8-2f70abca990b');
CREATE TABLE app_private.mhp_wa_direct_threads (
  id uuid PRIMARY KEY, workspace_id uuid NOT NULL CHECK (workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b'),
  inbox_id uuid NOT NULL, binding_id uuid NOT NULL, sender text NOT NULL CHECK(sender~'^[1-9][0-9]{6,14}$'),
  UNIQUE(binding_id,sender),
  FOREIGN KEY(workspace_id,inbox_id) REFERENCES app.inboxes(workspace_id,id),
  FOREIGN KEY(workspace_id,binding_id) REFERENCES app.property_predator_whatsapp_live_bindings(workspace_id,id)
);
CREATE TABLE app_private.mhp_wa_direct_received (
  id uuid PRIMARY KEY, thread_id uuid NOT NULL REFERENCES app_private.mhp_wa_direct_threads,
  binding_id uuid NOT NULL, external_id text NOT NULL, provider_id text NOT NULL, body text NOT NULL,
  identity_sha bytea NOT NULL CHECK(octet_length(identity_sha)=32), occurred_at timestamptz NOT NULL,
  native_conversation_id uuid,
  UNIQUE(binding_id,external_id), UNIQUE(binding_id,provider_id)
);
CREATE INDEX mhp_wa_direct_received_order ON app_private.mhp_wa_direct_received(thread_id,occurred_at DESC,id DESC);
CREATE TABLE app_private.mhp_wa_direct_replies (
  id uuid PRIMARY KEY, thread_id uuid NOT NULL REFERENCES app_private.mhp_wa_direct_threads,
  owner_id uuid NOT NULL REFERENCES app.users, body text NOT NULL CHECK(octet_length(body) BETWEEN 1 AND 4096),
  state text NOT NULL CHECK(state IN('queued','calling','accepted','failed','outcome_unknown','expired')),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(), began_at timestamptz,
  provider_id text UNIQUE, settled_at timestamptz
);
CREATE INDEX mhp_wa_direct_reply_queue ON app_private.mhp_wa_direct_replies(state,created_at);
DO $policies$
DECLARE tab text;
BEGIN
 FOREACH tab IN ARRAY ARRAY['mhp_wa_direct_threads','mhp_wa_direct_received','mhp_wa_direct_replies'] LOOP
   EXECUTE format('ALTER TABLE app_private.%I ENABLE ROW LEVEL SECURITY',tab);
   EXECUTE format('ALTER TABLE app_private.%I FORCE ROW LEVEL SECURITY',tab);
   EXECUTE format('CREATE POLICY direct_inbox_roles ON app_private.%I TO r72_whatsapp_live_definer
     USING(current_setting(''app.workspace_id'',true)=''2789228d-55a6-4688-b1e8-2f70abca990b'')
     WITH CHECK(current_setting(''app.workspace_id'',true)=''2789228d-55a6-4688-b1e8-2f70abca990b'')',tab);
 END LOOP;
END $policies$;
GRANT SELECT,INSERT ON app_private.mhp_wa_direct_threads,app_private.mhp_wa_direct_received,app_private.mhp_wa_direct_replies TO r72_whatsapp_live_definer;
GRANT UPDATE(state,began_at,provider_id,settled_at) ON app_private.mhp_wa_direct_replies TO r72_whatsapp_live_definer;
GRANT CREATE ON SCHEMA app_private TO r72_whatsapp_live_definer;
SET LOCAL ROLE r72_whatsapp_live_definer;

ALTER FUNCTION app_private.record_whatsapp_live_inbound_projection(uuid,uuid,text,text,text,text,bytea,bytea,bytea,bytea,bytea,timestamptz)
 RENAME TO record_whatsapp_live_inbound_before_0143;
REVOKE ALL ON FUNCTION app_private.record_whatsapp_live_inbound_before_0143(uuid,uuid,text,text,text,text,bytea,bytea,bytea,bytea,bytea,timestamptz)
 FROM PUBLIC,r72_whatsapp_live_webhook_command;

CREATE FUNCTION app_private.record_whatsapp_live_inbound_projection(
 p_workspace_id uuid,p_binding_id uuid,p_external_event_id text,p_provider_message_id text,p_normalized_sender text,p_body_text text,
 p_sender_sha256 bytea,p_body_sha256 bytea,p_payload_sha256 bytea,p_signature_sha256 bytea,p_event_identity_sha256 bytea,p_occurred_at timestamptz)
RETURNS TABLE(disposition text,receipt_id uuid,conversation_id uuid,message_id uuid,message_version_id uuid,admin_call_task_id uuid,admin_call_origin_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE ws constant uuid:='2789228d-55a6-4688-b1e8-2f70abca990b';
 old app_private.mhp_wa_direct_received%ROWTYPE; target app_private.mhp_wa_direct_threads%ROWTYPE;
 native_disposition text; native_receipt uuid; native_thread uuid; native_message uuid; native_version uuid; native_task uuid; native_origin uuid; failure text; inbox uuid; received uuid; identity bytea;
BEGIN
 IF p_workspace_id IS DISTINCT FROM ws OR p_body_text~*'^[[:space:]]*(join|stop|stopall|unsubscribe|cancel|end|quit|optout|opt out)([^[:alnum:]]|$)' THEN
  RETURN QUERY SELECT * FROM app_private.record_whatsapp_live_inbound_before_0143(p_workspace_id,p_binding_id,p_external_event_id,p_provider_message_id,p_normalized_sender,p_body_text,
   p_sender_sha256,p_body_sha256,p_payload_sha256,p_signature_sha256,p_event_identity_sha256,p_occurred_at);
  RETURN;
 END IF;
 IF session_user<>'r72_whatsapp_live_webhook_command' OR current_setting('app.workspace_id',true) IS DISTINCT FROM ws::text
  OR current_setting('app.actor_kind',true) IS DISTINCT FROM 'webhook' OR coalesce(current_setting('app.user_id',true),'')<>''
  OR p_normalized_sender IS NULL OR p_body_text IS NULL OR p_external_event_id IS NULL OR p_provider_message_id IS NULL
  OR p_sender_sha256 IS DISTINCT FROM public.digest(p_normalized_sender,'sha256') OR p_body_sha256 IS DISTINCT FROM public.digest(p_body_text,'sha256')
  OR octet_length(p_payload_sha256) IS DISTINCT FROM 32 OR octet_length(p_signature_sha256) IS DISTINCT FROM 32 THEN
  RAISE EXCEPTION 'MHP inbox evidence denied' USING ERRCODE='42501';
 END IF;
 identity:=public.digest(concat_ws(chr(31),p_external_event_id,p_provider_message_id,encode(p_sender_sha256,'hex'),encode(p_body_sha256,'hex'),encode(p_payload_sha256,'hex'),encode(p_signature_sha256,'hex')),'sha256');
 IF p_event_identity_sha256 IS DISTINCT FROM identity THEN RAISE EXCEPTION 'MHP inbox identity denied' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('mhp.direct.event:'||p_binding_id||':'||p_external_event_id,143));
 PERFORM pg_advisory_xact_lock(hashtextextended('mhp.direct:'||p_binding_id||':'||p_provider_message_id,143));
 PERFORM app_private.mhp_event_phone_lock(ARRAY['mhp.event-whatsapp.phone:+'||p_normalized_sender]);
 SELECT * INTO old FROM app_private.mhp_wa_direct_received r WHERE r.binding_id=p_binding_id AND
    (r.external_id=p_external_event_id OR r.provider_id=p_provider_message_id) ORDER BY r.id LIMIT 1;
 IF FOUND THEN
   IF old.identity_sha IS DISTINCT FROM identity OR old.occurred_at IS DISTINCT FROM p_occurred_at THEN
    RETURN QUERY SELECT 'conflict'::text,old.id,NULL::uuid,NULL::uuid,NULL::uuid,NULL::uuid,NULL::uuid;
   ELSIF old.native_conversation_id IS NOT NULL THEN
    RETURN QUERY SELECT * FROM app_private.record_whatsapp_live_inbound_before_0143(p_workspace_id,p_binding_id,p_external_event_id,p_provider_message_id,p_normalized_sender,p_body_text,
     p_sender_sha256,p_body_sha256,p_payload_sha256,p_signature_sha256,p_event_identity_sha256,p_occurred_at);
   ELSE
    RETURN QUERY SELECT 'replayed'::text,old.id,old.thread_id,old.id,NULL::uuid,NULL::uuid,NULL::uuid;
   END IF;
   RETURN;
 END IF;
 BEGIN
  -- Always let the established rail authenticate the binding, evidence and admission window.
  SELECT * INTO STRICT native_disposition,native_receipt,native_thread,native_message,native_version,native_task,native_origin FROM app_private.record_whatsapp_live_inbound_before_0143(p_workspace_id,p_binding_id,p_external_event_id,p_provider_message_id,p_normalized_sender,p_body_text,
    p_sender_sha256,p_body_sha256,p_payload_sha256,p_signature_sha256,p_event_identity_sha256,p_occurred_at);
  IF native_disposition='conflict' THEN RETURN QUERY SELECT native_disposition,native_receipt,native_thread,native_message,native_version,native_task,native_origin; RETURN; END IF;
 EXCEPTION WHEN foreign_key_violation THEN
  GET STACKED DIAGNOSTICS failure=MESSAGE_TEXT;
  IF failure<>'WhatsApp live inbound verified contact point not found' THEN RAISE; END IF;
 END;
 SELECT i.id INTO STRICT inbox FROM app.property_predator_whatsapp_live_bindings b JOIN app.inboxes i
  ON i.workspace_id=b.workspace_id AND i.provider_connection_id=b.provider_connection_id
  WHERE b.workspace_id=ws AND b.id=p_binding_id AND i.channel='whatsapp' AND i.environment='live' AND i.status='active';
 SELECT * INTO target FROM app_private.mhp_wa_direct_threads t WHERE t.binding_id=p_binding_id AND t.sender=p_normalized_sender;
 IF NOT FOUND THEN
   INSERT INTO app_private.mhp_wa_direct_threads(id,workspace_id,inbox_id,binding_id,sender)
    VALUES(coalesce(native_thread,gen_random_uuid()),ws,inbox,p_binding_id,p_normalized_sender) RETURNING * INTO target;
 END IF;
 received:=coalesce(native_message,gen_random_uuid());
 INSERT INTO app_private.mhp_wa_direct_received(id,thread_id,binding_id,external_id,provider_id,body,identity_sha,occurred_at,native_conversation_id)
 VALUES(received,target.id,p_binding_id,p_external_event_id,p_provider_message_id,p_body_text,identity,p_occurred_at,native_thread);
 IF native_disposition IS NOT NULL THEN RETURN QUERY SELECT native_disposition,native_receipt,native_thread,native_message,native_version,native_task,native_origin; ELSE
  RETURN QUERY SELECT 'applied'::text,received,target.id,received,NULL::uuid,NULL::uuid,NULL::uuid;
 END IF;
END $f$;
REVOKE ALL ON FUNCTION app_private.record_whatsapp_live_inbound_projection(uuid,uuid,text,text,text,text,bytea,bytea,bytea,bytea,bytea,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.record_whatsapp_live_inbound_projection(uuid,uuid,text,text,text,text,bytea,bytea,bytea,bytea,bytea,timestamptz)
 TO r72_whatsapp_live_webhook_command;
RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_whatsapp_live_definer;

-- Return the active native-owner predicate inside the processing transaction,
-- including for a delayed worker operation after a role has been revoked.
GRANT CREATE ON SCHEMA app_private TO r72_security_definer,r72_whatsapp_live_definer;
SET LOCAL ROLE r72_security_definer;
CREATE FUNCTION app_private.mhp_wa_direct_owner(actor uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT EXISTS(SELECT 1 FROM app.users u JOIN app.workspace_memberships wm ON wm.user_id=u.id
  JOIN app.workspaces w ON w.id=wm.workspace_id AND w.organization_id=wm.organization_id
  JOIN app.organization_memberships om ON om.organization_id=w.organization_id AND om.user_id=u.id
  JOIN app.organizations o ON o.id=w.organization_id
  WHERE w.id='2789228d-55a6-4688-b1e8-2f70abca990b' AND w.status='active' AND o.status='active'
   AND u.id=actor AND u.status='active' AND u.email_verified_at IS NOT NULL
   AND wm.role='owner' AND wm.status='active' AND wm.revoked_at IS NULL
   AND om.role='owner' AND om.status='active' AND om.revoked_at IS NULL)
$f$;
REVOKE ALL ON FUNCTION app_private.mhp_wa_direct_owner(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.mhp_wa_direct_owner(uuid) TO r72_whatsapp_live_definer;
RESET ROLE;
SET LOCAL ROLE r72_whatsapp_live_definer;

CREATE FUNCTION app_private.mhp_wa_direct_history(p_inbox uuid,p_thread uuid)
RETURNS TABLE(thread_id uuid,id uuid,label text,body text,occurred_at timestamptz,direction text,reply_state text,native_thread_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT t.id,x.id,'WhatsApp · '||right(t.sender,4),x.body,x.occurred_at,x.direction,x.state,native.native_conversation_id
 FROM app_private.mhp_wa_direct_threads t CROSS JOIN LATERAL (
  SELECT r.id,r.body,r.occurred_at,'incoming'::text AS direction,NULL::text AS state
  FROM app_private.mhp_wa_direct_received r WHERE r.thread_id=t.id
  UNION ALL
  SELECT s.id,s.body,s.created_at,'outgoing',CASE WHEN s.state='accepted' THEN coalesce((
    SELECT receipt.event_kind FROM app.property_predator_whatsapp_live_receipts receipt
    WHERE receipt.workspace_id=t.workspace_id AND receipt.binding_id=t.binding_id AND receipt.provider_message_id=s.provider_id
      AND receipt.recipient_or_sender_sha256=public.digest(t.sender,'sha256') AND receipt.safe_code='mhp_wa_direct_status'
    ORDER BY receipt.provider_occurred_at DESC,CASE receipt.event_kind WHEN 'read' THEN 3 WHEN 'delivered' THEN 2 WHEN 'sent' THEN 1 ELSE 0 END DESC LIMIT 1
   ),s.state) WHEN s.state='calling' AND s.began_at<now()-interval '2 minutes' THEN 'outcome_unknown' ELSE s.state END
  FROM app_private.mhp_wa_direct_replies s WHERE s.thread_id=t.id
 ) x LEFT JOIN LATERAL (SELECT r.native_conversation_id FROM app_private.mhp_wa_direct_received r
   WHERE r.thread_id=t.id AND r.native_conversation_id IS NOT NULL ORDER BY r.occurred_at DESC,r.id DESC LIMIT 1) native ON true
 WHERE t.workspace_id::text=current_setting('app.workspace_id',true) AND t.inbox_id=p_inbox AND (p_thread IS NULL OR t.id=p_thread)
  AND current_setting('app.actor_kind',true)='user' AND app_private.mhp_wa_direct_owner(nullif(current_setting('app.user_id',true),'')::uuid)
$f$;
REVOKE ALL ON FUNCTION app_private.mhp_wa_direct_history(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.mhp_wa_direct_history(uuid,uuid) TO r72_web;

CREATE FUNCTION app_private.mhp_wa_direct_window(p_thread uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $f$
 SELECT EXISTS(SELECT 1 FROM app_private.mhp_wa_direct_threads t WHERE t.id=p_thread
  AND EXISTS(SELECT 1 FROM app_private.mhp_wa_direct_received r WHERE r.thread_id=t.id
    AND r.occurred_at>statement_timestamp()-interval '24 hours' AND r.occurred_at<=statement_timestamp())
  AND (app_private.mhp_event_whatsapp_binding(t.binding_id)).id=t.binding_id
  AND app_private.mhp_unlinked_opt_latest('whatsapp',public.digest('+'||t.sender,'sha256')) IS DISTINCT FROM 'stop'
  AND NOT EXISTS(SELECT 1 FROM app.contact_points p WHERE p.workspace_id=t.workspace_id AND p.kind='whatsapp'
    AND p.deleted_at IS NULL AND ltrim(p.normalized_value,'+')=t.sender AND (p.consent_status='opted_out'
      OR EXISTS(SELECT 1 FROM (SELECT DISTINCT ON (coalesce(s.purpose,'')) s.state
       FROM app.communication_suppression_events s WHERE s.workspace_id=p.workspace_id AND s.contact_point_id=p.id
       AND s.channel='whatsapp' ORDER BY coalesce(s.purpose,''),s.occurred_at DESC,s.recorded_at DESC,s.id DESC) latest
       WHERE latest.state='suppressed'))))
$f$;
REVOKE ALL ON FUNCTION app_private.mhp_wa_direct_window(uuid) FROM PUBLIC;
CREATE FUNCTION app_private.mhp_wa_direct_can_reply(p_inbox uuid,p_thread uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT current_setting('app.actor_kind',true)='user'
  AND app_private.mhp_wa_direct_owner(nullif(current_setting('app.user_id',true),'')::uuid)
  AND EXISTS(SELECT 1 FROM app_private.mhp_wa_direct_threads t WHERE t.workspace_id::text=current_setting('app.workspace_id',true)
    AND t.inbox_id=p_inbox AND t.id=p_thread AND app_private.mhp_wa_direct_window(t.id))
$f$;
REVOKE ALL ON FUNCTION app_private.mhp_wa_direct_can_reply(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.mhp_wa_direct_can_reply(uuid,uuid) TO r72_web;
CREATE FUNCTION app_private.mhp_wa_direct_queue(p_id uuid,p_inbox uuid,p_thread uuid,p_body text) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid:=nullif(current_setting('app.user_id',true),'')::uuid; prior app_private.mhp_wa_direct_replies%ROWTYPE;
BEGIN
 IF session_user<>'r72_crm_command' OR current_setting('app.actor_kind',true) IS DISTINCT FROM 'user' OR NOT app_private.mhp_wa_direct_owner(actor)
  OR p_id IS NULL OR p_body IS NULL OR length(btrim(p_body))=0 OR octet_length(p_body)>4096
  OR NOT EXISTS(SELECT 1 FROM app_private.mhp_wa_direct_threads t WHERE t.id=p_thread AND t.inbox_id=p_inbox AND t.workspace_id::text=current_setting('app.workspace_id',true))
 THEN RETURN 'refused'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('mhp.wa.reply:'||p_id,143));
 SELECT * INTO prior FROM app_private.mhp_wa_direct_replies WHERE id=p_id;
 IF FOUND THEN RETURN CASE WHEN prior.owner_id=actor AND prior.thread_id=p_thread AND prior.body=p_body THEN prior.state ELSE 'conflict' END; END IF;
 IF NOT app_private.mhp_wa_direct_window(p_thread) THEN RETURN 'refused'; END IF;
 INSERT INTO app_private.mhp_wa_direct_replies(id,thread_id,owner_id,body,state) VALUES(p_id,p_thread,actor,p_body,'queued');
 RETURN 'queued';
END $f$;
REVOKE ALL ON FUNCTION app_private.mhp_wa_direct_queue(uuid,uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.mhp_wa_direct_queue(uuid,uuid,uuid,text) TO r72_crm_command;

CREATE FUNCTION app_private.mhp_wa_direct_begin(p_workspace uuid,p_binding uuid,p_connection uuid)
RETURNS TABLE(reply_id uuid,recipient text,body text,provider_connection_id uuid,app_id text,waba_id text,phone_number_id text,graph_api_version text,
 secret_key_version text,secret_iv bytea,secret_ciphertext bytea,secret_auth_tag bytea,secret_aad_sha256 bytea,secret_payload_sha256 bytea)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE item record; binding app.property_predator_whatsapp_live_bindings%ROWTYPE;
BEGIN
 PERFORM app_private.mhp_event_whatsapp_worker_context(p_workspace);
 binding:=app_private.mhp_event_whatsapp_binding(p_binding);
 IF binding.id IS NULL OR binding.provider_connection_id IS DISTINCT FROM p_connection THEN RETURN; END IF;
 SELECT s.id,s.owner_id,s.thread_id,t.sender,s.body INTO item
 FROM app_private.mhp_wa_direct_replies s JOIN app_private.mhp_wa_direct_threads t ON t.id=s.thread_id
 WHERE t.workspace_id=p_workspace AND t.binding_id=p_binding AND s.state='queued'
 ORDER BY s.created_at,s.id LIMIT 1 FOR UPDATE OF s SKIP LOCKED;
 IF NOT FOUND THEN RETURN; END IF;
 PERFORM app_private.mhp_event_phone_lock(ARRAY['mhp.event-whatsapp.phone:+'||item.sender]);
 IF NOT app_private.mhp_wa_direct_owner(item.owner_id) OR NOT app_private.mhp_wa_direct_window(item.thread_id) THEN
  UPDATE app_private.mhp_wa_direct_replies s SET state='expired',settled_at=statement_timestamp() WHERE s.id=item.id; RETURN;
 END IF;
 UPDATE app_private.mhp_wa_direct_replies s SET state='calling',began_at=statement_timestamp() WHERE s.id=item.id;
 RETURN QUERY SELECT item.id,item.sender,item.body,binding.provider_connection_id,binding.app_id,binding.waba_id,binding.phone_number_id,binding.graph_api_version,
  binding.secret_key_version,binding.secret_iv,binding.secret_ciphertext,binding.secret_auth_tag,binding.secret_aad_sha256,binding.secret_payload_sha256;
END $f$;
CREATE FUNCTION app_private.mhp_wa_direct_finish(p_workspace uuid,p_binding uuid,p_id uuid,p_state text,p_provider_id text)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 PERFORM app_private.mhp_event_whatsapp_worker_context(p_workspace);
 IF p_state IS NULL OR p_state NOT IN('accepted','failed','outcome_unknown') OR (p_state='accepted')<>(p_provider_id IS NOT NULL)
  OR (p_provider_id IS NOT NULL AND p_provider_id!~'^wamid[.][A-Za-z0-9_=-]{1,190}$') THEN RETURN false; END IF;
 UPDATE app_private.mhp_wa_direct_replies s SET state=p_state,settled_at=statement_timestamp(),provider_id=p_provider_id
 FROM app_private.mhp_wa_direct_threads t WHERE t.workspace_id=p_workspace AND t.binding_id=p_binding AND t.id=s.thread_id AND s.id=p_id AND s.state='calling';
 RETURN FOUND;
END $f$;
REVOKE ALL ON FUNCTION app_private.mhp_wa_direct_begin(uuid,uuid,uuid),app_private.mhp_wa_direct_finish(uuid,uuid,uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.mhp_wa_direct_begin(uuid,uuid,uuid),app_private.mhp_wa_direct_finish(uuid,uuid,uuid,text,text) TO r72_whatsapp_live_worker_command;
ALTER FUNCTION app_private.record_whatsapp_live_status(uuid,uuid,text,text,bytea,text,bytea,timestamptz) RENAME TO record_whatsapp_live_status_before_0143;
REVOKE ALL ON FUNCTION app_private.record_whatsapp_live_status_before_0143(uuid,uuid,text,text,bytea,text,bytea,timestamptz)
 FROM PUBLIC,r72_whatsapp_live_webhook_command;
CREATE FUNCTION app_private.record_whatsapp_live_status(p_workspace_id uuid,p_binding_id uuid,p_external_event_id text,
 p_provider_message_id text,p_recipient_sha256 bytea,p_status text,p_payload_sha256 bytea,p_occurred_at timestamptz) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE ws constant uuid:='2789228d-55a6-4688-b1e8-2f70abca990b'; prior app.property_predator_whatsapp_live_receipts%ROWTYPE; failure text;
BEGIN
 IF p_workspace_id IS DISTINCT FROM ws THEN
  RETURN app_private.record_whatsapp_live_status_before_0143(p_workspace_id,p_binding_id,p_external_event_id,p_provider_message_id,p_recipient_sha256,p_status,p_payload_sha256,p_occurred_at);
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
 WHERE r.workspace_id=ws AND r.binding_id=p_binding_id AND r.external_event_id=p_external_event_id AND r.safe_code='mhp_wa_direct_status';
 IF FOUND THEN
  RETURN CASE WHEN prior.job_id IS NOT NULL OR prior.provider_message_id IS DISTINCT FROM p_provider_message_id
   OR prior.recipient_or_sender_sha256 IS DISTINCT FROM p_recipient_sha256 OR prior.event_kind IS DISTINCT FROM p_status
   OR prior.payload_sha256 IS DISTINCT FROM p_payload_sha256 OR prior.provider_occurred_at IS DISTINCT FROM p_occurred_at
   THEN 'conflict' ELSE 'replayed' END;
 END IF;
 BEGIN
  RETURN app_private.record_whatsapp_live_status_before_0143(ws,p_binding_id,p_external_event_id,p_provider_message_id,p_recipient_sha256,p_status,p_payload_sha256,p_occurred_at);
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
 -- Meta can deliver a status before the worker commits its provider message ID.
 IF NOT EXISTS(SELECT 1 FROM app_private.mhp_wa_direct_threads t JOIN app_private.mhp_wa_direct_replies r ON r.thread_id=t.id
  WHERE t.workspace_id=ws AND t.binding_id=p_binding_id AND public.digest(t.sender,'sha256')=p_recipient_sha256
    AND (r.provider_id=p_provider_message_id OR (r.provider_id IS NULL AND r.state IN('calling','outcome_unknown')
      AND r.began_at BETWEEN p_occurred_at-interval '1 day' AND p_occurred_at+interval '5 minutes'))) THEN
  RAISE EXCEPTION 'WhatsApp status has no exact outbound job' USING ERRCODE='42501'; END IF;
 INSERT INTO app.property_predator_whatsapp_live_receipts(workspace_id,job_id,binding_id,external_event_id,event_kind,
  provider_message_id,recipient_or_sender_sha256,body_sha256,payload_sha256,safe_code,provider_occurred_at)
 VALUES(ws,NULL,p_binding_id,p_external_event_id,p_status,p_provider_message_id,p_recipient_sha256,NULL,p_payload_sha256,'mhp_wa_direct_status',p_occurred_at);
 RETURN 'applied';
END $f$;
REVOKE ALL ON FUNCTION app_private.record_whatsapp_live_status(uuid,uuid,text,text,bytea,text,bytea,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.record_whatsapp_live_status(uuid,uuid,text,text,bytea,text,bytea,timestamptz) TO r72_whatsapp_live_webhook_command;
RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_whatsapp_live_definer,r72_security_definer;
