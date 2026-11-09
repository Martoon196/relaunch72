-- INV-CRM-001. Separate dispatch of an already human-approved exact message.
-- 0110's approval command has no queue/provider effect, proved independently.
SET LOCAL ROLE r72_owner;
GRANT CREATE ON SCHEMA app_private TO r72_investor_email_definer;
SET LOCAL ROLE r72_investor_email_definer;
CREATE FUNCTION app_private.guard_investor_email_delivery()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $f$
DECLARE permission jsonb;
BEGIN
 IF current_user<>'r72_investor_email_definer' OR NEW.environment<>'live' OR NEW.conversation_channel<>'email' OR NEW.consent_channel<>'email'
 OR NEW.purpose<>'investor_relationships' OR NEW.status<>'queued' OR NEW.idempotency_key<>'investor-email:'||NEW.message_id::text THEN RAISE EXCEPTION 'Invalid investor email delivery' USING ERRCODE='42501';END IF;
 IF NOT EXISTS(SELECT 1 FROM app.investor_email_messages x
 JOIN app.messages m ON m.workspace_id=x.workspace_id AND m.id=x.message_id
 JOIN app.conversations c ON c.workspace_id=m.workspace_id AND c.id=m.conversation_id
 JOIN app.inboxes i ON i.workspace_id=c.workspace_id AND i.id=c.inbox_id
 JOIN app.channel_endpoints e ON e.workspace_id=i.workspace_id AND e.id=i.channel_endpoint_id
 JOIN app.provider_connections pc ON pc.workspace_id=e.workspace_id AND pc.id=e.provider_connection_id
 JOIN app_private.investor_mail_accounts a ON a.workspace_id=x.workspace_id AND a.row_version=x.account_version AND a.address=x.mailbox_address
 JOIN app.contact_points p ON p.workspace_id=m.workspace_id AND p.id=m.contact_point_id
 JOIN app.message_approval_decisions d ON d.workspace_id=m.workspace_id AND d.id=NEW.approval_decision_id
 JOIN app.provider_operations op ON op.workspace_id=m.workspace_id AND op.id=NEW.provider_operation_id
 WHERE x.workspace_id=NEW.workspace_id AND x.message_id=NEW.message_id AND m.lifecycle='approved' AND m.direction='outbound' AND m.current_version_id=NEW.message_version_id
 AND m.current_body_sha256=NEW.body_sha256 AND m.contact_id=NEW.contact_id AND m.contact_point_id=NEW.contact_point_id AND m.conversation_id=NEW.conversation_id
 AND d.message_id=m.id AND d.message_version_id=m.current_version_id AND d.body_sha256=m.current_body_sha256 AND d.decision='approved'
 AND a.status='verified' AND e.id=NEW.channel_endpoint_id AND e.normalized_address=a.address AND e.status='active' AND i.status='active'
 AND pc.id=NEW.provider_connection_id AND pc.provider_id='investor_'||a.provider AND pc.status='active' AND pc.environment='live'
 AND p.normalized_value=x.recipient AND p.deleted_at IS NULL AND op.state='queued' AND op.message_delivery_id=NEW.id AND op.idempotency_key=NEW.idempotency_key)
 THEN RAISE EXCEPTION 'Investor delivery lost its exact binding' USING ERRCODE='42501'; END IF;
 permission:=app_private.investor_email_permission(NEW.workspace_id,NEW.contact_point_id);
 IF (permission->>'consentId')::uuid<>NEW.consent_event_id OR decode(permission->>'identityHash','hex')<>NEW.endpoint_identity_sha256 THEN RAISE EXCEPTION 'Investor permission changed' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $f$;
REVOKE ALL ON FUNCTION app_private.guard_investor_email_delivery() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.guard_investor_email_delivery() TO r72_owner;
RESET ROLE;
SET LOCAL ROLE r72_owner;
-- Existing callers retain the installed Property Predator guard unchanged.
CREATE OR REPLACE TRIGGER message_deliveries_live_pilot_guard_insert BEFORE INSERT ON app.message_deliveries
 FOR EACH ROW WHEN(NEW.environment<>'test' AND current_user<>'r72_investor_email_definer') EXECUTE FUNCTION app_private.guard_property_predator_email_live_delivery();
CREATE TRIGGER message_deliveries_investor_guard_insert BEFORE INSERT ON app.message_deliveries
 FOR EACH ROW WHEN(current_user='r72_investor_email_definer') EXECUTE FUNCTION app_private.guard_investor_email_delivery();
SET LOCAL ROLE r72_investor_email_definer;

CREATE FUNCTION app_private.claim_investor_email(p_session bytea,p_message uuid,p_version bigint,p_body_hash bytea,p_lease bytea,p_confirmation text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE ws uuid;actor uuid;m app.messages%ROWTYPE;x app.investor_email_messages%ROWTYPE;a record;i record;permission jsonb;approval uuid;decision uuid;operation uuid:=gen_random_uuid();delivery uuid:=gen_random_uuid();body text;
BEGIN
 ws:=app_private.investor_mail_workspace(p_session,true);SELECT user_id INTO actor FROM app_private.resolve_session(p_session);
 IF p_confirmation IS DISTINCT FROM 'send_approved_message' OR p_lease IS NULL OR octet_length(p_lease)<>32 THEN RAISE EXCEPTION 'Separate send confirmation required' USING ERRCODE='42501'; END IF;
 SELECT * INTO m FROM app.messages WHERE workspace_id=ws AND id=p_message FOR UPDATE;
 -- Dispatch never creates an approval. An unapproved draft is always rejected.
 IF NOT FOUND OR m.lifecycle<>'approved' OR m.row_version<>p_version OR m.current_body_sha256 IS DISTINCT FROM p_body_hash THEN RAISE EXCEPTION 'A current human-approved message is required' USING ERRCODE='40001'; END IF;
 SELECT d.id,d.approval_request_id INTO decision,approval FROM app.message_approval_decisions d WHERE d.workspace_id=ws AND d.message_id=m.id AND d.message_version_id=m.current_version_id AND d.body_sha256=m.current_body_sha256 AND d.decision='approved';
 IF decision IS NULL THEN RAISE EXCEPTION 'Saved human approval required' USING ERRCODE='42501'; END IF;
 SELECT * INTO x FROM app.investor_email_messages WHERE workspace_id=ws AND message_id=p_message;
 SELECT address,row_version INTO a FROM app_private.investor_mail_accounts WHERE workspace_id=ws AND status='verified' FOR UPDATE;
 IF a.address IS DISTINCT FROM x.mailbox_address OR a.row_version IS DISTINCT FROM x.account_version THEN RAISE EXCEPTION 'Mailbox changed; create and review a new draft' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM app.contact_points WHERE workspace_id=ws AND id=m.contact_point_id AND normalized_value=x.recipient FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Investor address changed' USING ERRCODE='42501'; END IF;
 permission:=app_private.investor_email_permission(ws,m.contact_point_id);
 SELECT inbox.* INTO i FROM app.inboxes inbox JOIN app.conversations c ON c.workspace_id=inbox.workspace_id AND c.inbox_id=inbox.id WHERE c.workspace_id=ws AND c.id=m.conversation_id;
 INSERT INTO app.provider_operations(id,workspace_id,provider_connection_id,message_delivery_id,operation_kind,environment,idempotency_key,correlation_id,max_attempts,created_by_actor_kind,created_by_user_id)
 VALUES(operation,ws,i.provider_connection_id,delivery,'conversation.send','live','investor-email:'||m.id::text,operation,1,'user',actor);
 INSERT INTO app.message_deliveries(id,workspace_id,conversation_id,message_id,message_version_id,version_number,body_sha256,approval_request_id,approval_decision_id,provider_operation_id,provider_connection_id,channel_endpoint_id,contact_id,contact_point_id,conversation_channel,consent_channel,purpose,consent_event_id,endpoint_identity_sha256,environment,idempotency_key,created_by_user_id)
 VALUES(delivery,ws,m.conversation_id,m.id,m.current_version_id,m.current_version_number,m.current_body_sha256,approval,decision,operation,i.provider_connection_id,i.channel_endpoint_id,m.contact_id,m.contact_point_id,'email','email','investor_relationships',(permission->>'consentId')::uuid,decode(permission->>'identityHash','hex'),'live','investor-email:'||m.id::text,actor);
 UPDATE app.messages SET lifecycle='committed',row_version=row_version+1 WHERE workspace_id=ws AND id=m.id;
 UPDATE app.provider_operations SET state='calling',lease_token_hash=p_lease,lease_version=1,lease_expires_at=clock_timestamp()+interval '2 minutes',attempt_count=1,row_version=row_version+1,updated_at=clock_timestamp() WHERE workspace_id=ws AND id=operation;
 UPDATE app.message_deliveries SET status='sending',updated_at=clock_timestamp() WHERE workspace_id=ws AND id=delivery;
 INSERT INTO app.provider_operation_attempts(workspace_id,provider_operation_id,attempt_number,worker_id,lease_version,attempt_kind,state) VALUES(ws,operation,1,gen_random_uuid(),1,'dispatch','calling');
 SELECT body_text INTO body FROM app.message_versions WHERE workspace_id=ws AND id=m.current_version_id;
 RETURN jsonb_build_object('operationId',operation,'workspaceId',ws,'accountVersion',a.row_version,'address',a.address,'messageId',x.internet_message_id,'to',x.recipient,'subject',x.subject,'text',body,'inReplyTo',x.in_reply_to);
END $f$;

CREATE FUNCTION app_private.settle_investor_email(p_session bytea,p_operation uuid,p_lease bytea,p_accepted boolean,p_reference text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE ws uuid;actor uuid;op app.provider_operations%ROWTYPE;reference text;
BEGIN
 ws:=app_private.investor_mail_workspace(p_session,true);SELECT user_id INTO actor FROM app_private.resolve_session(p_session);
 SELECT * INTO op FROM app.provider_operations WHERE workspace_id=ws AND id=p_operation AND idempotency_key LIKE 'investor-email:%' FOR UPDATE;
 IF NOT FOUND OR op.state<>'calling' OR op.lease_token_hash IS DISTINCT FROM p_lease THEN RAISE EXCEPTION 'Dispatch fence unavailable' USING ERRCODE='40001'; END IF;
 IF p_accepted THEN
  reference:=COALESCE(NULLIF(left(p_reference,450),''),'accepted:'||p_operation::text);
  UPDATE app.provider_operations SET state='accepted',provider_reference=reference,lease_token_hash=NULL,lease_expires_at=NULL,completed_at=clock_timestamp(),row_version=row_version+1,updated_at=clock_timestamp() WHERE workspace_id=ws AND id=p_operation;
  UPDATE app.message_deliveries SET status='accepted',accepted_at=clock_timestamp(),updated_at=clock_timestamp() WHERE workspace_id=ws AND id=op.message_delivery_id;
  INSERT INTO app.provider_operation_receipts(workspace_id,provider_operation_id,message_delivery_id,source_kind,external_event_id,payload_sha256,delivery_status,actor_kind,actor_user_id,occurred_at)
  VALUES(ws,op.id,op.message_delivery_id,'worker_reconcile','investor-accepted:'||op.id::text,public.digest(reference,'sha256'),'accepted','user',actor,statement_timestamp());
 ELSE
  UPDATE app.provider_operations SET state='reconciliation_required',lease_token_hash=NULL,lease_expires_at=NULL,last_error_code='outcome_unknown',row_version=row_version+1,updated_at=clock_timestamp() WHERE workspace_id=ws AND id=p_operation;
  UPDATE app.message_deliveries SET status='reconciliation_required',updated_at=clock_timestamp() WHERE workspace_id=ws AND id=op.message_delivery_id;
 END IF;
 UPDATE app.provider_operation_attempts SET state=CASE WHEN p_accepted THEN 'accepted' ELSE 'needs_attention' END,retryable=false,completed_at=clock_timestamp() WHERE workspace_id=ws AND provider_operation_id=p_operation AND attempt_number=1;
END $f$;
REVOKE ALL ON FUNCTION app_private.claim_investor_email(bytea,uuid,bigint,bytea,bytea,text),app_private.settle_investor_email(bytea,uuid,bytea,boolean,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.claim_investor_email(bytea,uuid,bigint,bytea,bytea,text),app_private.settle_investor_email(bytea,uuid,bytea,boolean,text) TO r72_identity_command;
RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_investor_email_definer;
RESET ROLE;
