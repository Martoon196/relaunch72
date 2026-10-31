-- MHP009C source candidate: connect the separately owned MHP WhatsApp sender,
-- pin one Meta-approved template, and send ONE owner-approved test template to the
-- owner's own number, all in the owner's live session on the unchanged 0053 rail.
-- Two exact repairs of latent 0053 defects (below); otherwise no change to
-- any 0053/0055/0057/0058 table or function. No public route, no
-- worker-created authority, no recipient other than the owner. Inbound WhatsApp
-- STOP is not recorded by the unchanged 0055 projection, so this migration admits
-- no recipient other than the owner; public WhatsApp needs that rail change first.
SET LOCAL ROLE r72_owner;
-- Rail repair: 0053 bounds the template name with {0,511}, but PostgreSQL caps a
-- regex repetition count at 255, so both checks raise 2201B whenever they run and
-- no WhatsApp template can ever be recorded. Same meaning, valid syntax: the exact
-- character class plus an explicit 512-character limit. Nothing else changes.
ALTER TABLE app.property_predator_whatsapp_live_templates DROP CONSTRAINT property_predator_whatsapp_live_te_provider_template_name_check;
ALTER TABLE app.property_predator_whatsapp_live_templates ADD CONSTRAINT property_predator_whatsapp_live_te_provider_template_name_check
 CHECK (provider_template_name ~ '^[a-z][a-z0-9_]*$' AND char_length(provider_template_name) <= 512);
GRANT CREATE ON SCHEMA app_private TO r72_whatsapp_live_definer;
SET LOCAL ROLE r72_whatsapp_live_definer;
-- Exact 0053 body; only the template-name predicate differs (see the compat test).
CREATE OR REPLACE FUNCTION app_private.record_whatsapp_live_template(
  p_workspace_id uuid, p_binding_id uuid, p_template_id uuid,
  p_content_item_id uuid, p_content_version_id uuid,
  p_approval_request_id uuid, p_approval_decision_id uuid,
  p_template_name text, p_template_ref_sha256 bytea, p_language_code text,
  p_category text, p_provider_approval_evidence_sha256 bytea,
  p_provider_approved_at timestamptz
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE selected_user uuid; selected_connection uuid; selected_hash bytea;
BEGIN
  IF session_user <> 'r72_whatsapp_live_command'
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'user'
     OR current_setting('app.user_id', true) !~ '^[0-9a-f-]{36}$'
     OR coalesce(current_setting('app.request_id', true), '') = ''
     OR p_template_name !~ '^[a-z][a-z0-9_]*$' OR char_length(p_template_name) > 512
     OR p_language_code !~ '^[a-z]{2,3}(_[A-Z]{2})?$'
     OR p_category NOT IN ('utility', 'marketing')
     OR octet_length(p_template_ref_sha256) <> 32
     OR octet_length(p_provider_approval_evidence_sha256) <> 32
     OR p_provider_approved_at > statement_timestamp() + interval '5 minutes' THEN
    RAISE EXCEPTION 'WhatsApp live template denied' USING ERRCODE = '42501';
  END IF;
  selected_user := current_setting('app.user_id')::uuid;
  SELECT binding.provider_connection_id INTO selected_connection
  FROM app.property_predator_whatsapp_live_bindings AS binding
  JOIN app.provider_connections AS connection
    ON connection.workspace_id = binding.workspace_id
   AND connection.id = binding.provider_connection_id
   AND connection.provider_id = 'meta_whatsapp_cloud'
   AND connection.provider_kind = 'messaging'
   AND connection.environment = 'live' AND connection.status = 'active'
  WHERE binding.workspace_id = p_workspace_id AND binding.id = p_binding_id
    AND binding.status = 'active'
    AND NOT EXISTS (
      SELECT 1 FROM app.property_predator_whatsapp_live_binding_revocations AS revocation
      WHERE revocation.workspace_id = binding.workspace_id
        AND revocation.binding_id = binding.id
    );
  SELECT version.content_sha256 INTO selected_hash
  FROM app.company_content_versions AS version
  JOIN app.company_content_approval_requests AS request
    ON request.workspace_id = version.workspace_id
   AND request.content_item_id = version.content_item_id
   AND request.content_version_id = version.id
   AND request.content_sha256 = version.content_sha256 AND request.id = p_approval_request_id
  JOIN app.company_content_approval_decisions AS decision
    ON decision.workspace_id = request.workspace_id
   AND decision.approval_request_id = request.id AND decision.id = p_approval_decision_id
   AND decision.decision = 'approved'
  WHERE version.workspace_id = p_workspace_id AND version.content_item_id = p_content_item_id
    AND version.id = p_content_version_id AND version.content_kind IN ('other', 'document')
    AND public.digest(version.content_body, 'sha256') = version.content_sha256
    AND NOT EXISTS (
      SELECT 1 FROM app.company_content_versions AS newer
      WHERE newer.workspace_id = version.workspace_id
        AND newer.content_item_id = version.content_item_id
        AND newer.version_number > version.version_number
    );
  IF selected_connection IS NULL OR selected_hash IS NULL OR NOT EXISTS (
    SELECT 1 FROM app.workspace_memberships AS membership
    WHERE membership.workspace_id = p_workspace_id AND membership.user_id = selected_user
      AND membership.status = 'active' AND membership.role IN ('owner', 'admin')
  ) THEN RAISE EXCEPTION 'WhatsApp live template evidence denied' USING ERRCODE = '42501'; END IF;
  INSERT INTO app.property_predator_whatsapp_live_templates (
    id, workspace_id, binding_id, provider_connection_id, content_item_id,
    content_version_id, content_sha256, approval_request_id, approval_decision_id,
    provider_template_name, provider_template_ref_sha256, language_code, category,
    parameter_count, provider_status, provider_approval_evidence_sha256,
    provider_approved_at, created_by_user_id
  ) VALUES (
    p_template_id, p_workspace_id, p_binding_id, selected_connection, p_content_item_id,
    p_content_version_id, selected_hash, p_approval_request_id, p_approval_decision_id,
    p_template_name, p_template_ref_sha256, p_language_code, p_category, 0, 'approved',
    p_provider_approval_evidence_sha256, p_provider_approved_at, selected_user
  );
  RETURN p_template_id;
END
$function$;
-- Rail repair 2 (same as 0130 R8 did for SMS): three unqualified references
-- collide with this function's OUT columns job_id/binding_id and raise 42702 on
-- the first claim, so no WhatsApp job could ever be claimed. Exact 0053 body; only
-- the two conflict targets and one DELETE are disambiguated (see the compat test).
CREATE OR REPLACE FUNCTION app_private.claim_whatsapp_live_job(
  p_workspace_id uuid, p_provider_connection_id uuid,
  p_lease_token bytea, p_lease_seconds integer
) RETURNS TABLE(job_id uuid, binding_id uuid, lease_version bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE selected app.property_predator_whatsapp_live_jobs%ROWTYPE;
  recovered app.property_predator_whatsapp_live_jobs%ROWTYPE; next_version bigint;
BEGIN
  IF session_user <> 'r72_whatsapp_live_worker_command'
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'worker'
     OR coalesce(current_setting('app.user_id', true), '') <> ''
     OR coalesce(current_setting('app.request_id', true), '') = ''
     OR octet_length(p_lease_token) <> 32 OR p_lease_seconds NOT BETWEEN 30 AND 300 THEN
    RAISE EXCEPTION 'WhatsApp live claim denied' USING ERRCODE = '42501';
  END IF;
  FOR recovered IN SELECT job.* FROM app.property_predator_whatsapp_live_jobs AS job
    WHERE job.workspace_id = p_workspace_id AND job.provider_connection_id = p_provider_connection_id
      AND ((job.state IN ('leased', 'calling') AND job.lease_expires_at <= statement_timestamp())
        OR (job.state = 'awaiting_status' AND job.status_deadline <= statement_timestamp()))
    FOR UPDATE SKIP LOCKED
  LOOP
    IF recovered.state IN ('calling', 'awaiting_status') THEN
      INSERT INTO app.property_predator_whatsapp_live_receipts (
        workspace_id, job_id, binding_id, external_event_id, event_kind,
        provider_message_id, recipient_or_sender_sha256, body_sha256,
        payload_sha256, safe_code, provider_occurred_at
      ) VALUES (
        recovered.workspace_id, recovered.id, recovered.binding_id,
        format('worker-timeout:%s:%s', recovered.id, recovered.lease_version),
        'outcome_unknown', recovered.provider_message_id, recovered.recipient_sha256, NULL,
        public.digest(format('worker-timeout:%s:%s', recovered.id, recovered.lease_version), 'sha256'),
        'worker_whatsapp_outcome_unknown', statement_timestamp()
      ) ON CONFLICT ON CONSTRAINT property_predator_whatsapp_li_workspace_id_binding_id_exter_key DO NOTHING;
    END IF;
    UPDATE app.property_predator_whatsapp_live_jobs SET
      state = CASE WHEN recovered.state = 'leased' THEN 'queued' ELSE 'needs_attention' END,
      lease_expires_at = NULL, status_deadline = NULL,
      available_at = CASE WHEN recovered.state = 'leased' THEN statement_timestamp() ELSE available_at END,
      settled_at = CASE WHEN recovered.state = 'leased' THEN settled_at ELSE statement_timestamp() END,
      updated_at = statement_timestamp()
    WHERE workspace_id = recovered.workspace_id AND id = recovered.id;
    DELETE FROM app.property_predator_whatsapp_live_job_leases AS lease
    WHERE lease.workspace_id = recovered.workspace_id AND lease.job_id = recovered.id;
  END LOOP;
  SELECT job.* INTO selected FROM app.property_predator_whatsapp_live_jobs AS job
  WHERE job.workspace_id = p_workspace_id AND job.provider_connection_id = p_provider_connection_id
    AND job.state = 'queued' AND job.available_at <= statement_timestamp()
    AND job.claim_count < 8
    AND app_private.whatsapp_live_authority_is_current(
      job.workspace_id, job.authority_id, job.provider_connection_id
    )
  ORDER BY job.available_at, job.created_at, job.id
  LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN; END IF;
  next_version := selected.lease_version + 1;
  UPDATE app.property_predator_whatsapp_live_jobs SET state = 'leased',
    lease_version = next_version,
    lease_expires_at = statement_timestamp() + make_interval(secs => p_lease_seconds),
    claim_count = claim_count + 1, updated_at = statement_timestamp()
  WHERE workspace_id = p_workspace_id AND id = selected.id;
  INSERT INTO app.property_predator_whatsapp_live_job_leases
    (workspace_id, job_id, lease_version, lease_token_sha256)
  VALUES (p_workspace_id, selected.id, next_version, public.digest(p_lease_token, 'sha256'))
  ON CONFLICT ON CONSTRAINT property_predator_whatsapp_live_job_leases_pkey DO UPDATE SET
    lease_version = EXCLUDED.lease_version,
    lease_token_sha256 = EXCLUDED.lease_token_sha256,
    issued_at = statement_timestamp();
  RETURN QUERY SELECT selected.id, selected.binding_id, next_version;
END
$function$;
SET LOCAL ROLE r72_owner;
GRANT EXECUTE ON FUNCTION app_private.mhp_owner_email_authorize(bytea) TO r72_whatsapp_live_definer;
GRANT EXECUTE ON FUNCTION app_private.current_request_id(),app_private.current_user_id() TO r72_whatsapp_live_definer;
GRANT SELECT,INSERT ON app.command_receipts TO r72_whatsapp_live_definer;
GRANT UPDATE(result,status,response_status,completed_at) ON app.command_receipts TO r72_whatsapp_live_definer;
CREATE POLICY mhp_whatsapp_receipts ON app.command_receipts TO r72_whatsapp_live_definer
 USING(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND command_name IN('mhp.whatsapp.connect','mhp.whatsapp.template','mhp.whatsapp.owned-test')
  AND actor_user_id=nullif(current_setting('app.user_id',true),'')::uuid)
 WITH CHECK(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND command_name IN('mhp.whatsapp.connect','mhp.whatsapp.template','mhp.whatsapp.owned-test')
  AND actor_user_id=nullif(current_setting('app.user_id',true),'')::uuid AND current_setting('app.actor_kind',true)='user' AND session_user='r72_whatsapp_live_command');
-- Connection, sender endpoint and inbox, MHP owner session only.
GRANT INSERT ON app.provider_connections,app.channel_endpoints,app.inboxes TO r72_whatsapp_live_definer;
GRANT SELECT ON app.channel_endpoints TO r72_whatsapp_live_definer;
CREATE POLICY mhp_whatsapp_connection_insert ON app.provider_connections FOR INSERT TO r72_whatsapp_live_definer
 WITH CHECK(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND provider_id='meta_whatsapp_cloud' AND provider_kind='messaging' AND environment='live'
  AND current_setting('app.actor_kind',true)='user' AND session_user='r72_whatsapp_live_command'
  AND created_by_user_id=nullif(current_setting('app.user_id',true),'')::uuid);
CREATE POLICY mhp_whatsapp_endpoint_insert ON app.channel_endpoints FOR INSERT TO r72_whatsapp_live_definer
 WITH CHECK(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND channel='whatsapp' AND environment='live'
  AND current_setting('app.actor_kind',true)='user' AND session_user='r72_whatsapp_live_command');
CREATE POLICY mhp_whatsapp_endpoint_read ON app.channel_endpoints FOR SELECT TO r72_whatsapp_live_definer
 USING(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND channel='whatsapp');
CREATE POLICY mhp_whatsapp_inbox_insert ON app.inboxes FOR INSERT TO r72_whatsapp_live_definer
 WITH CHECK(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND channel='whatsapp' AND environment='live'
  AND current_setting('app.actor_kind',true)='user' AND session_user='r72_whatsapp_live_command');
-- The owner's own WhatsApp point and their one-test permission.
GRANT INSERT ON app.contact_points TO r72_whatsapp_live_definer;
GRANT UPDATE(is_verified,row_version,updated_at) ON app.contact_points TO r72_whatsapp_live_definer;
CREATE POLICY mhp_whatsapp_point_insert ON app.contact_points FOR INSERT TO r72_whatsapp_live_definer
 WITH CHECK(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND kind='whatsapp' AND NOT is_verified AND consent_status='unknown'
  AND dedupe_state='normal' AND deleted_at IS NULL AND current_setting('app.actor_kind',true)='user' AND session_user='r72_whatsapp_live_command');
CREATE POLICY mhp_whatsapp_point_verify ON app.contact_points FOR UPDATE TO r72_whatsapp_live_definer
 USING(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND kind='whatsapp' AND NOT is_verified AND session_user='r72_whatsapp_live_command')
 WITH CHECK(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND kind='whatsapp' AND is_verified);
GRANT INSERT ON app.communication_consent_events TO r72_whatsapp_live_definer;
CREATE POLICY mhp_whatsapp_owned_permission ON app.communication_consent_events FOR INSERT TO r72_whatsapp_live_definer
 WITH CHECK(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND current_setting('app.actor_kind',true)='user'
  AND session_user='r72_whatsapp_live_command' AND channel='whatsapp' AND purpose='marketing' AND state='granted' AND lawful_basis='consent'
  AND source='mhp.owned-whatsapp.self-test' AND policy_version='mhp.owned-whatsapp-self-test/v1'
  AND actor_kind='user' AND actor_user_id=nullif(current_setting('app.user_id',true),'')::uuid);
-- Possession: the owner's existing SMS verification receipt on the same number.
GRANT SELECT ON app_private.sms_phone_verification_receipts TO r72_whatsapp_live_definer;
CREATE POLICY mhp_whatsapp_sms_receipts_read ON app_private.sms_phone_verification_receipts FOR SELECT TO r72_whatsapp_live_definer
 USING(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND session_user='r72_whatsapp_live_command');
-- The per-recipient compliance chain, exactly as 0130 records it for SMS.
GRANT SELECT,INSERT ON app_private.affiliate_compliance_subjects,app_private.affiliate_compliance_policy_pack_versions,
 app_private.affiliate_compliance_policy_review_events,app_private.affiliate_compliance_policy_publication_events,
 app_private.affiliate_compliance_specialist_decision_events,app_private.affiliate_compliance_permission_use_receipts TO r72_whatsapp_live_definer;
DO $policies$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['affiliate_compliance_subjects','affiliate_compliance_policy_pack_versions','affiliate_compliance_policy_review_events',
  'affiliate_compliance_policy_publication_events','affiliate_compliance_specialist_decision_events','affiliate_compliance_permission_use_receipts'] LOOP
  EXECUTE format('CREATE POLICY mhp_whatsapp_operational_review ON app_private.%I TO r72_whatsapp_live_definer
   USING(workspace_id=''2789228d-55a6-4688-b1e8-2f70abca990b'' AND current_setting(''app.actor_kind'',true)=''user'' AND session_user=''r72_whatsapp_live_command'')
   WITH CHECK(workspace_id=''2789228d-55a6-4688-b1e8-2f70abca990b'' AND current_setting(''app.actor_kind'',true)=''user'' AND session_user=''r72_whatsapp_live_command''
    AND recorded_by_user_id=nullif(current_setting(''app.user_id'',true),'''')::uuid AND recorded_request_id=current_setting(''app.request_id'',true))',t);
 END LOOP;
END $policies$;
GRANT CREATE ON SCHEMA app_private TO r72_whatsapp_live_definer,r72_mhp_prospect_definer;

SET LOCAL ROLE r72_mhp_prospect_definer;
-- The exact owner-approved WhatsApp template draft (0129 shape), zero parameters.
CREATE FUNCTION app_private.mhp_owned_whatsapp_content(p_version uuid,p_sha bytea) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE exact jsonb; v app.company_content_versions%ROWTYPE; request uuid; decision uuid;
BEGIN
 exact:=app_private.mhp_owner_channel_exact(p_version,true);
 SELECT * INTO v FROM app.company_content_versions WHERE workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND id=p_version;
 IF exact->>'channel' IS DISTINCT FROM 'whatsapp' OR v.content_sha256 IS DISTINCT FROM p_sha
  OR (exact->'payload'->>'bodyText')~'[{][{][0-9]+[}][}]'
 THEN RAISE EXCEPTION 'Exact parameter-free MHP WhatsApp template required' USING ERRCODE='23514'; END IF;
 SELECT d.id,d.approval_request_id INTO decision,request FROM app.company_content_approval_decisions d
 JOIN app.company_content_approval_requests r ON r.workspace_id=d.workspace_id AND r.id=d.approval_request_id
 WHERE d.workspace_id=v.workspace_id AND d.content_version_id=v.id AND d.content_sha256=v.content_sha256 AND d.decision='approved'
  AND app_private.mhp_marketing_workspace_allowed(d.decided_by_user_id,d.workspace_id)
  AND r.request_number=(SELECT max(n.request_number) FROM app.company_content_approval_requests n WHERE n.workspace_id=v.workspace_id AND n.content_version_id=v.id)
 ORDER BY d.decided_at DESC,d.id DESC LIMIT 1;
 IF decision IS NULL THEN RAISE EXCEPTION 'Current owner WhatsApp template approval required' USING ERRCODE='23514'; END IF;
 RETURN exact||jsonb_build_object('approvalRequestId',request,'approvalDecisionId',decision,'templateName',exact->'payload'->>'templateName',
  'language',exact->'payload'->>'language');
END $f$;
REVOKE ALL ON FUNCTION app_private.mhp_owned_whatsapp_content(uuid,bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.mhp_owned_whatsapp_content(uuid,bytea) TO r72_whatsapp_live_definer;

SET LOCAL ROLE r72_whatsapp_live_definer;
-- Shared owner gate for every function below.
CREATE FUNCTION app_private.mhp_whatsapp_owner(p_session bytea) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; request text:=current_setting('app.request_id',true);
BEGIN
 actor:=app_private.mhp_owner_email_authorize(p_session);
 IF session_user<>'r72_whatsapp_live_command' OR current_setting('app.workspace_id',true) IS DISTINCT FROM '2789228d-55a6-4688-b1e8-2f70abca990b'
  OR current_setting('app.actor_kind',true) IS DISTINCT FROM 'user' OR current_setting('app.user_id',true) IS DISTINCT FROM actor::text
  OR request IS NULL OR length(request) NOT BETWEEN 1 AND 128
 THEN RAISE EXCEPTION 'MHP WhatsApp owner session required' USING ERRCODE='42501'; END IF;
 RETURN actor;
END $f$;

-- Internal: a WhatsApp STOP on any point holding this number, in either stored
-- form (with or without the leading plus), including deleted or quarantined ones.
CREATE FUNCTION app_private.mhp_whatsapp_number_suppressed(p_phone text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT EXISTS(SELECT 1 FROM app.contact_points p
  WHERE p.workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND p.kind='whatsapp' AND p.normalized_value IN(p_phone,substr(p_phone,2))
   AND EXISTS(SELECT 1 FROM (SELECT DISTINCT ON(coalesce(s.purpose,'')) s.state FROM app.communication_suppression_events s
     WHERE s.workspace_id=p.workspace_id AND s.contact_point_id=p.id AND s.channel='whatsapp' AND (s.purpose IS NULL OR s.purpose='marketing')
     ORDER BY coalesce(s.purpose,''),s.occurred_at DESC,s.recorded_at DESC,s.id DESC) l WHERE l.state='suppressed'))
$f$;

CREATE FUNCTION app_private.mhp_whatsapp_snapshot(p_session bytea,p_contact uuid,p_phone text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE ws constant uuid:='2789228d-55a6-4688-b1e8-2f70abca990b'; actor uuid; binding app.property_predator_whatsapp_live_bindings%ROWTYPE;
 templates jsonb; possession boolean:=false; point app.contact_points%ROWTYPE; suppressed boolean:=false; saved jsonb; sender text;
BEGIN
 actor:=app_private.mhp_whatsapp_owner(p_session);
 IF p_contact IS NULL OR p_phone IS NULL OR p_phone!~'^\+44[0-9]{9,10}$' THEN RAISE EXCEPTION 'MHP WhatsApp owner number required' USING ERRCODE='42501'; END IF;
 SELECT b.* INTO binding FROM app.property_predator_whatsapp_live_bindings b WHERE b.workspace_id=ws AND b.status='active'
  AND NOT EXISTS(SELECT 1 FROM app.property_predator_whatsapp_live_binding_revocations r WHERE r.workspace_id=b.workspace_id AND r.binding_id=b.id)
 ORDER BY b.created_at DESC LIMIT 1;
 SELECT e.normalized_address INTO sender FROM app.channel_endpoints e WHERE e.workspace_id=ws AND e.provider_connection_id=binding.provider_connection_id
  AND e.channel='whatsapp' AND e.status='active' ORDER BY e.created_at DESC LIMIT 1;
 SELECT coalesce(jsonb_agg(jsonb_build_object('templateId',t.id,'name',t.provider_template_name,'language',t.language_code,'category',t.category,
   'contentVersionId',t.content_version_id) ORDER BY t.created_at DESC),'[]'::jsonb) INTO templates
 FROM app.property_predator_whatsapp_live_templates t WHERE t.workspace_id=ws AND t.binding_id=binding.id;
 SELECT EXISTS(SELECT 1 FROM app.contact_points p JOIN app_private.sms_phone_verification_receipts r ON r.workspace_id=p.workspace_id AND r.contact_point_id=p.id
   AND r.phone_identity_sha256=public.digest(p.normalized_value,'sha256') AND r.verified_by_user_id=actor
  WHERE p.workspace_id=ws AND p.contact_id=p_contact AND p.kind='phone' AND p.normalized_value=p_phone AND p.is_verified AND p.deleted_at IS NULL) INTO possession;
 -- 0053 matches WhatsApp points on digits only (no leading plus).
 SELECT p.* INTO point FROM app.contact_points p WHERE p.workspace_id=ws AND p.contact_id=p_contact AND p.kind='whatsapp'
  AND p.normalized_value=substr(p_phone,2) AND p.deleted_at IS NULL AND p.dedupe_state='normal';
 suppressed:=app_private.mhp_whatsapp_number_suppressed(p_phone);
 SELECT c.result||jsonb_build_object('state',j.state,'replayed',true) INTO saved FROM app.command_receipts c
 JOIN app.property_predator_whatsapp_live_jobs j ON j.workspace_id=c.workspace_id AND j.id=(c.result->>'jobId')::uuid
 WHERE c.workspace_id=ws AND c.actor_user_id=actor AND c.command_name='mhp.whatsapp.owned-test' AND c.status='succeeded'
 ORDER BY c.completed_at DESC,c.id DESC LIMIT 1;
 RETURN jsonb_build_object('bindingId',binding.id,'connectionId',binding.provider_connection_id,'senderNumber',sender,
  'wabaId',binding.waba_id,'phoneNumberId',binding.phone_number_id,'templates',templates,'possessionProven',possession,
  'whatsappPointId',point.id,'whatsappPointVerified',coalesce(point.is_verified,false),'suppressed',suppressed,'lastResult',saved);
END $f$;

-- Owner step 1: connection, sender endpoint, inbox and the 0053 binding, at once.
-- The sealed envelope is produced off-web by the CLI that holds the worker key.
CREATE FUNCTION app_private.mhp_whatsapp_connect(p_session bytea,p_command uuid,p_connection uuid,p_binding uuid,
 p_app_id text,p_waba_id text,p_phone_number_id text,p_sender_number text,p_key_version text,p_iv bytea,p_ciphertext bytea,
 p_auth_tag bytea,p_aad_sha256 bytea,p_payload_sha256 bytea,p_ownership_evidence text,p_confirmed boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE ws constant uuid:='2789228d-55a6-4688-b1e8-2f70abca990b'; actor uuid; request text:=current_setting('app.request_id',true);
 payload bytea; prior app.command_receipts%ROWTYPE; receipt uuid:=gen_random_uuid(); endpoint uuid:=gen_random_uuid(); outcome jsonb;
BEGIN
 actor:=app_private.mhp_whatsapp_owner(p_session);
 IF p_command IS NULL OR p_connection IS NULL OR p_binding IS NULL OR p_confirmed IS DISTINCT FROM true
  OR p_sender_number IS NULL OR p_sender_number!~'^\+44[0-9]{9,10}$'
  OR p_ownership_evidence IS NULL OR length(btrim(p_ownership_evidence)) NOT BETWEEN 8 AND 500
 THEN RAISE EXCEPTION 'MHP WhatsApp connection denied' USING ERRCODE='42501'; END IF;
 payload:=public.digest(jsonb_build_object('schema','mhp.whatsapp.connect/v1','actor',actor,'connection',p_connection,'binding',p_binding,
  'appId',p_app_id,'wabaId',p_waba_id,'phoneNumberId',p_phone_number_id,'sender',p_sender_number,'payloadSha256',encode(p_payload_sha256,'hex'))::text,'sha256');
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('mhp.whatsapp.connect:'||ws::text,7200132));
 SELECT * INTO prior FROM app.command_receipts c WHERE c.workspace_id=ws AND c.actor_user_id=actor AND c.command_name='mhp.whatsapp.connect' AND c.idempotency_key=p_command::text;
 IF FOUND THEN
  IF prior.payload_hash IS DISTINCT FROM payload OR prior.status<>'succeeded' THEN RAISE EXCEPTION 'WhatsApp connection replay conflicts' USING ERRCODE='40001'; END IF;
  RETURN prior.result||jsonb_build_object('replayed',true);
 END IF;
 IF EXISTS(SELECT 1 FROM app.property_predator_whatsapp_live_bindings b WHERE b.workspace_id=ws
  AND NOT EXISTS(SELECT 1 FROM app.property_predator_whatsapp_live_binding_revocations r WHERE r.workspace_id=b.workspace_id AND r.binding_id=b.id))
 THEN RAISE EXCEPTION 'The MHP WhatsApp sender is already connected' USING ERRCODE='23505'; END IF;
 INSERT INTO app.command_receipts(id,workspace_id,command_name,idempotency_key,request_id,actor_user_id,payload_hash)
 VALUES(receipt,ws,'mhp.whatsapp.connect',p_command::text,request,actor,payload);
 INSERT INTO app.provider_connections(id,workspace_id,provider_id,provider_kind,environment,display_name,created_by_user_id,status,capabilities)
 VALUES(p_connection,ws,'meta_whatsapp_cloud','messaging','live','Martin Howard Property WhatsApp',actor,'active','["whatsapp.send"]');
 INSERT INTO app.channel_endpoints(id,workspace_id,provider_connection_id,channel,environment,direction,address,normalized_address,display_name,status)
 VALUES(endpoint,ws,p_connection,'whatsapp','live','bidirectional',p_sender_number,p_sender_number,'Martin Howard Property WhatsApp','active');
 INSERT INTO app.inboxes(workspace_id,channel_endpoint_id,provider_connection_id,channel,environment,name)
 VALUES(ws,endpoint,p_connection,'whatsapp','live','Martin Howard Property WhatsApp');
 PERFORM app_private.record_whatsapp_live_binding(ws,p_connection,p_binding,p_app_id,p_waba_id,p_phone_number_id,
  public.digest(regexp_replace(p_sender_number,'^\+',''),'sha256'),p_key_version,p_iv,p_ciphertext,p_auth_tag,p_aad_sha256,p_payload_sha256,
  public.digest(btrim(p_ownership_evidence),'sha256'),date_trunc('milliseconds',statement_timestamp()),NULL);
 outcome:=jsonb_build_object('bindingId',p_binding,'connectionId',p_connection,'endpointId',endpoint,'commandId',p_command,'replayed',false,'providerEffects','none');
 UPDATE app.command_receipts SET result=outcome,status='succeeded',response_status=200,completed_at=clock_timestamp() WHERE id=receipt AND workspace_id=ws;
 RETURN outcome;
END $f$;

-- Owner step 2: pin one Meta-approved, parameter-free template to the exact approved draft.
CREATE FUNCTION app_private.mhp_whatsapp_record_template(p_session bytea,p_command uuid,p_binding uuid,p_template uuid,
 p_content_version uuid,p_content_sha256 bytea,p_category text,p_meta_template_id text,p_approval_reference text,p_confirmed boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE ws constant uuid:='2789228d-55a6-4688-b1e8-2f70abca990b'; actor uuid; request text:=current_setting('app.request_id',true);
 payload bytea; prior app.command_receipts%ROWTYPE; receipt uuid:=gen_random_uuid(); exact jsonb; waba text; outcome jsonb;
BEGIN
 actor:=app_private.mhp_whatsapp_owner(p_session);
 IF p_command IS NULL OR p_binding IS NULL OR p_template IS NULL OR p_content_version IS NULL OR p_content_sha256 IS NULL
  OR octet_length(p_content_sha256)<>32 OR p_category IS NULL OR p_category NOT IN('utility','marketing')
  OR p_meta_template_id IS NULL OR p_meta_template_id!~'^[1-9][0-9]{4,29}$'
  OR p_approval_reference IS NULL OR length(btrim(p_approval_reference)) NOT BETWEEN 8 AND 500 OR p_confirmed IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'MHP WhatsApp template denied' USING ERRCODE='42501'; END IF;
 payload:=public.digest(jsonb_build_object('schema','mhp.whatsapp.template/v1','actor',actor,'binding',p_binding,'template',p_template,
  'contentVersion',p_content_version,'contentSha256',encode(p_content_sha256,'hex'),'category',p_category,'metaTemplateId',p_meta_template_id)::text,'sha256');
 SELECT * INTO prior FROM app.command_receipts c WHERE c.workspace_id=ws AND c.actor_user_id=actor AND c.command_name='mhp.whatsapp.template' AND c.idempotency_key=p_command::text;
 IF FOUND THEN
  IF prior.payload_hash IS DISTINCT FROM payload OR prior.status<>'succeeded' THEN RAISE EXCEPTION 'WhatsApp template replay conflicts' USING ERRCODE='40001'; END IF;
  RETURN prior.result||jsonb_build_object('replayed',true);
 END IF;
 exact:=app_private.mhp_owned_whatsapp_content(p_content_version,p_content_sha256);
 SELECT b.waba_id INTO waba FROM app.property_predator_whatsapp_live_bindings b WHERE b.workspace_id=ws AND b.id=p_binding;
 IF waba IS NULL THEN RAISE EXCEPTION 'MHP WhatsApp binding required' USING ERRCODE='42501'; END IF;
 INSERT INTO app.command_receipts(id,workspace_id,command_name,idempotency_key,request_id,actor_user_id,payload_hash)
 VALUES(receipt,ws,'mhp.whatsapp.template',p_command::text,request,actor,payload);
 PERFORM app_private.record_whatsapp_live_template(ws,p_binding,p_template,(exact->>'contentItemId')::uuid,p_content_version,
  (exact->>'approvalRequestId')::uuid,(exact->>'approvalDecisionId')::uuid,exact->>'templateName',
  public.digest('meta-template:'||waba||':'||p_meta_template_id||':'||(exact->>'templateName')||':'||(exact->>'language'),'sha256'),
  exact->>'language',p_category,public.digest(btrim(p_approval_reference),'sha256'),date_trunc('milliseconds',statement_timestamp()));
 outcome:=jsonb_build_object('templateId',p_template,'bindingId',p_binding,'templateName',exact->>'templateName','language',exact->>'language',
  'commandId',p_command,'replayed',false,'providerEffects','none');
 UPDATE app.command_receipts SET result=outcome,status='succeeded',response_status=200,completed_at=clock_timestamp() WHERE id=receipt AND workspace_id=ws;
 RETURN outcome;
END $f$;

-- Owner step 3: ONE test template to the owner's own number. Possession is the
-- owner's existing SMS verification receipt on the same number; consent is the
-- owner's own one-test permission. Unchanged 0053 enqueue and caps (1/day, 3/month).
CREATE FUNCTION app_private.mhp_owned_whatsapp_send(p_session bytea,p_command uuid,p_binding uuid,p_template uuid,p_contact uuid,p_phone text,
 p_confirmed boolean,p_lookup_only boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE
 ws constant uuid:='2789228d-55a6-4688-b1e8-2f70abca990b'; actor uuid; request text:=current_setting('app.request_id',true);
 review_version constant text:='mhp.owned-whatsapp-self-test/v1';
 permission_text constant text:='I agree to receive one Martin Howard Property test WhatsApp message on my own number. This does not subscribe me to future WhatsApp or SMS.';
 review_authority constant text:='mhp.founder-operator-review-not-legal-advice';
 payload bytea; prior app.command_receipts%ROWTYPE; template app.property_predator_whatsapp_live_templates%ROWTYPE; point uuid;
 point_row app.contact_points%ROWTYPE; endpoint_sha bytea; recipient_sha bytea; consent uuid:=gen_random_uuid(); subject uuid:=gen_random_uuid();
 pack uuid:=gen_random_uuid(); legal uuid:=gen_random_uuid(); commercial uuid:=gen_random_uuid(); publication uuid:=gen_random_uuid();
 sender_route uuid:=gen_random_uuid(); instigator_route uuid:=gen_random_uuid(); permission_use uuid:=gen_random_uuid(); operation uuid:=gen_random_uuid();
 receipt uuid:=gen_random_uuid(); prepared timestamptz; expiry timestamptz; facts jsonb; facts_sha bytea; scope bytea; nonce bytea; job uuid;
 current_state text; outcome jsonb; ownership_sha bytea;
BEGIN
 actor:=app_private.mhp_whatsapp_owner(p_session);
 IF p_command IS NULL OR p_binding IS NULL OR p_template IS NULL OR p_contact IS NULL OR p_phone IS NULL OR p_phone!~'^\+44[0-9]{9,10}$'
  OR p_confirmed IS DISTINCT FROM true OR p_lookup_only IS NULL
 THEN RAISE EXCEPTION 'MHP owned WhatsApp action denied' USING ERRCODE='42501'; END IF;
 payload:=public.digest(jsonb_build_object('schema',review_version,'actor',actor,'binding',p_binding,'template',p_template,'contact',p_contact,
  'phoneSha256',encode(public.digest(p_phone,'sha256'),'hex'),'confirmed',p_confirmed)::text,'sha256');
 SELECT * INTO prior FROM app.command_receipts c WHERE c.workspace_id=ws AND c.actor_user_id=actor AND c.command_name='mhp.whatsapp.owned-test' AND c.idempotency_key=p_command::text;
 IF FOUND THEN
  IF prior.payload_hash IS DISTINCT FROM payload OR prior.status<>'succeeded' THEN RAISE EXCEPTION 'Owned WhatsApp replay conflicts' USING ERRCODE='40001'; END IF;
  SELECT j.state INTO current_state FROM app.property_predator_whatsapp_live_jobs j WHERE j.workspace_id=ws AND j.id=(prior.result->>'jobId')::uuid;
  RETURN prior.result||jsonb_build_object('state',current_state,'replayed',true);
 END IF;
 IF p_lookup_only THEN RETURN jsonb_build_object('not_started',true); END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('mhp.whatsapp.owned-test:'||ws::text||':'||actor::text,7200132));
 SELECT * INTO prior FROM app.command_receipts c WHERE c.workspace_id=ws AND c.actor_user_id=actor AND c.command_name='mhp.whatsapp.owned-test' AND c.idempotency_key=p_command::text;
 IF FOUND THEN
  IF prior.payload_hash IS DISTINCT FROM payload OR prior.status<>'succeeded' THEN RAISE EXCEPTION 'Owned WhatsApp replay conflicts' USING ERRCODE='40001'; END IF;
  SELECT j.state INTO current_state FROM app.property_predator_whatsapp_live_jobs j WHERE j.workspace_id=ws AND j.id=(prior.result->>'jobId')::uuid;
  RETURN prior.result||jsonb_build_object('state',current_state,'replayed',true);
 END IF;
 SELECT t.* INTO template FROM app.property_predator_whatsapp_live_templates t WHERE t.workspace_id=ws AND t.id=p_template AND t.binding_id=p_binding;
 IF template.id IS NULL THEN RAISE EXCEPTION 'Pinned MHP WhatsApp template required' USING ERRCODE='42501'; END IF;
 SELECT b.ownership_evidence_sha256 INTO ownership_sha FROM app.property_predator_whatsapp_live_bindings b WHERE b.workspace_id=ws AND b.id=p_binding;
 IF NOT EXISTS(SELECT 1 FROM app.contact_points p JOIN app_private.sms_phone_verification_receipts r ON r.workspace_id=p.workspace_id AND r.contact_point_id=p.id
   AND r.phone_identity_sha256=public.digest(p.normalized_value,'sha256') AND r.verified_by_user_id=actor
  WHERE p.workspace_id=ws AND p.contact_id=p_contact AND p.kind='phone' AND p.normalized_value=p_phone AND p.is_verified AND p.deleted_at IS NULL)
 THEN RAISE EXCEPTION 'Verify your own number first' USING ERRCODE='42501'; END IF;
 -- 0053 matches WhatsApp points on digits only: its '^\\+' never strips a plus
 -- (a latent 0053 defect), while the CRM stores WhatsApp numbers with one. A
 -- plus-form point for this number could carry another contact or an opt-out the
 -- rail would never see, so its existence blocks the test.
 IF EXISTS(SELECT 1 FROM app.contact_points p WHERE p.workspace_id=ws AND p.kind='whatsapp' AND p.normalized_value=p_phone AND p.deleted_at IS NULL)
 THEN RAISE EXCEPTION 'A CRM WhatsApp entry for this number uses a format the rail cannot honour' USING ERRCODE='42501'; END IF;
 IF app_private.mhp_whatsapp_number_suppressed(p_phone) THEN RAISE EXCEPTION 'WhatsApp opt-out is active for this number' USING ERRCODE='42501'; END IF;
 SELECT p.id INTO point FROM app.contact_points p WHERE p.workspace_id=ws AND p.kind='whatsapp' AND p.normalized_value=substr(p_phone,2) AND p.deleted_at IS NULL;
 IF point IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app.contact_points p WHERE p.workspace_id=ws AND p.id=point AND p.dedupe_state='normal')
 THEN RAISE EXCEPTION 'That WhatsApp number is shared or quarantined' USING ERRCODE='42501'; END IF;
 IF point IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app.contact_points p WHERE p.workspace_id=ws AND p.id=point AND p.contact_id=p_contact)
 THEN RAISE EXCEPTION 'That WhatsApp number belongs to another contact' USING ERRCODE='42501'; END IF;
 IF point IS NULL THEN
  INSERT INTO app.contact_points(workspace_id,contact_id,kind,label,value,normalized_value,is_primary,is_verified,consent_status)
  VALUES(ws,p_contact,'whatsapp','Owner WhatsApp',p_phone,substr(p_phone,2),false,false,'unknown') RETURNING id INTO point;
 END IF;
 UPDATE app.contact_points p SET is_verified=true,row_version=p.row_version+1,updated_at=statement_timestamp()
 WHERE p.workspace_id=ws AND p.id=point AND NOT p.is_verified;
 SELECT p.* INTO point_row FROM app.contact_points p WHERE p.workspace_id=ws AND p.id=point AND p.is_verified;
 endpoint_sha:=public.digest(point_row.kind||chr(31)||point_row.value||chr(31)||point_row.normalized_value,'sha256');
 recipient_sha:=public.digest(regexp_replace(point_row.normalized_value,'^\+',''),'sha256');
 prepared:=date_trunc('milliseconds',statement_timestamp()); expiry:=prepared+interval '4 minutes';
 INSERT INTO app.command_receipts(id,workspace_id,command_name,idempotency_key,request_id,actor_user_id,payload_hash)
 VALUES(receipt,ws,'mhp.whatsapp.owned-test',p_command::text,request,actor,payload);
 facts:=jsonb_build_object('schema',review_version,'owner',actor,'request',request,'command',p_command,'binding',p_binding,'template',p_template,
  'templateName',template.provider_template_name,'language',template.language_code,'recipientIdentitySha256',encode(endpoint_sha,'hex'),'contact',p_contact,'point',point,
  'possession','owner SMS verification receipt on the same number','oneMessageOnly',true,'futureWhatsappSubscription',false,'smsSubscription',false,
  'reviewAuthority',review_authority,'permissionText',permission_text,'legalEntity','MH196 Ltd','brand','Martin Howard Property');
 facts_sha:=public.digest(facts::text,'sha256');
 INSERT INTO app.communication_consent_events(id,workspace_id,contact_id,contact_point_id,channel,purpose,state,lawful_basis,source,policy_version,
  policy_text_sha256,source_event_id,actor_kind,actor_user_id,evidence,endpoint_identity_sha256,occurred_at)
 VALUES(consent,ws,p_contact,point,'whatsapp','marketing','granted','consent','mhp.owned-whatsapp.self-test',review_version,
  public.digest(permission_text,'sha256'),p_command::text,'user',actor,facts,endpoint_sha,prepared);
 scope:=public.digest(format('whatsapp:%s:%s:%s:%s:%s:%s',ws,p_binding,p_template,encode(recipient_sha,'hex'),'marketing',consent),'sha256');
 INSERT INTO app_private.affiliate_compliance_subjects(id,workspace_id,source_system,source_subject_key,legal_identity_sha256,recorded_by_user_id,recorded_request_id)
 VALUES(subject,ws,'martin-howard-property','mhp.owned-whatsapp:'||p_command::text,public.digest('MH196 Ltd:Martin Howard Property:'||actor::text,'sha256'),actor,request);
 INSERT INTO app_private.affiliate_compliance_policy_pack_versions(id,workspace_id,pack_key,pack_version,bundle_sha256,document_refs,drafting_status,source_commit,source_commit_meaning,recorded_by_user_id,recorded_request_id)
 VALUES(pack,ws,'mhp_owned_whatsapp_self_test',p_command::text,facts_sha,jsonb_build_array(
  jsonb_build_object('documentType','owner_review','documentId','mhp.owner-review:'||p_command::text,'documentVersion','v1','contentSha256',encode(facts_sha,'hex')),
  jsonb_build_object('documentType','approved_template','documentId','mhp.whatsapp-template:'||p_template::text,'documentVersion','v1','contentSha256',encode(template.content_sha256,'hex')),
  jsonb_build_object('documentType','sender_ownership','documentId','mhp.whatsapp-sender-ownership:'||p_binding::text,'documentVersion','v1','contentSha256',encode(ownership_sha,'hex')),
  jsonb_build_object('documentType','owned_phone_verification','documentId','mhp.owned-phone-verification:'||point::text,'documentVersion','v1',
   'contentSha256',encode(public.digest(jsonb_build_object('point',point,'verifiedBy',actor,'phoneIdentitySha256',encode(public.digest(p_phone,'sha256'),'hex'),
    'proof','owner SMS verification receipt')::text,'sha256'),'hex')),
  jsonb_build_object('documentType','one_test_permission','documentId','mhp.one-test-permission:'||consent::text,'documentVersion','v1','contentSha256',encode(public.digest(permission_text,'sha256'),'hex'))),
  'draft_complete','69652270584f1dc0cf737fe2ff7cd9a19e3a4d28','drafting-provenance-only',actor,request);
 INSERT INTO app_private.affiliate_compliance_policy_review_events(id,workspace_id,policy_pack_id,bundle_sha256,review_dimension,decision,specialist_reference,decision_reference,decision_sha256,occurred_at,recorded_by_user_id,recorded_request_id)
 VALUES(legal,ws,pack,facts_sha,'legal','approved',review_authority,'mhp.owned-whatsapp:'||p_command::text,public.digest(facts_sha||convert_to(':owner-legal-dimension','UTF8'),'sha256'),prepared,actor,request),
  (commercial,ws,pack,facts_sha,'commercial','approved',review_authority,'mhp.owned-whatsapp:'||p_command::text,public.digest(facts_sha||convert_to(':owner-commercial-dimension','UTF8'),'sha256'),prepared,actor,request);
 INSERT INTO app_private.affiliate_compliance_policy_publication_events(id,workspace_id,policy_pack_id,bundle_sha256,publication_state,legal_review_event_id,commercial_review_event_id,effective_at,expires_at,reacceptance_class,publication_reference,recorded_by_user_id,recorded_request_id)
 VALUES(publication,ws,pack,facts_sha,'published',legal,commercial,prepared,expiry,'none','mhp.owned-whatsapp:'||p_command::text,actor,request);
 INSERT INTO app_private.affiliate_compliance_specialist_decision_events(id,workspace_id,subject_id,decision_kind,decision_scope_ref,action_scope_sha256,decision_state,route_classification,
  party_reference,responsibility_reference,specialist_reference,decision_sha256,valid_from,valid_until,recorded_by_user_id,recorded_request_id)
 VALUES(sender_route,ws,subject,'pecr_sender_route','mhp.owned-whatsapp:'||p_command::text,scope,'approved','individual_consent','mhp.sender.MH196Ltd','mhp.instigator.MH196Ltd',review_authority,
   public.digest(facts_sha||convert_to(':sender','UTF8'),'sha256'),prepared,expiry,actor,request),
  (instigator_route,ws,subject,'pecr_instigator_route','mhp.owned-whatsapp:'||p_command::text,scope,'approved','individual_consent','mhp.sender.MH196Ltd','mhp.instigator.MH196Ltd',review_authority,
   public.digest(facts_sha||convert_to(':instigator','UTF8'),'sha256'),prepared,expiry,actor,request);
 nonce:=public.digest('mhp.whatsapp.owned-test:'||ws::text||':'||actor::text||':'||p_command::text,'sha256');
 INSERT INTO app_private.affiliate_compliance_permission_use_receipts(id,workspace_id,subject_id,permission,action_scope_sha256,evidence_snapshot_sha256,decision_nonce_sha256,
  evaluated_at,decision_expires_at,consumed_at,recorded_by_user_id,recorded_request_id)
 VALUES(permission_use,ws,subject,'whatsapp.send',scope,facts_sha,nonce,prepared,expiry,prepared,actor,request);
 job:=app_private.authorize_and_enqueue_whatsapp_live_job(ws,p_binding,p_template,p_contact,point,consent,subject,publication,sender_route,instigator_route,
  permission_use,'marketing',expiry,operation,nonce,public.digest(facts::text||':request','sha256'));
 IF job IS NULL THEN RAISE EXCEPTION 'Owned WhatsApp enqueue returned no job' USING ERRCODE='23514'; END IF;
 IF clock_timestamp()>=expiry THEN RAISE EXCEPTION 'Owned WhatsApp authority expired before completion' USING ERRCODE='23514'; END IF;
 outcome:=jsonb_build_object('jobId',job,'commandId',p_command,'templateId',p_template,'authorityExpiresAt',to_char(expiry AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'state','queued','replayed',false,'consentId',consent,'permissionUseId',permission_use,'reviewAuthority',review_authority,'providerEffects','none');
 UPDATE app.command_receipts SET result=outcome,status='succeeded',response_status=200,completed_at=clock_timestamp() WHERE id=receipt AND workspace_id=ws;
 RETURN outcome;
END $f$;

REVOKE ALL ON FUNCTION app_private.mhp_whatsapp_owner(bytea),app_private.mhp_whatsapp_number_suppressed(text),app_private.mhp_whatsapp_snapshot(bytea,uuid,text),
 app_private.mhp_whatsapp_connect(bytea,uuid,uuid,uuid,text,text,text,text,text,bytea,bytea,bytea,bytea,bytea,text,boolean),
 app_private.mhp_whatsapp_record_template(bytea,uuid,uuid,uuid,uuid,bytea,text,text,text,boolean),
 app_private.mhp_owned_whatsapp_send(bytea,uuid,uuid,uuid,uuid,text,boolean,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.mhp_whatsapp_snapshot(bytea,uuid,text),
 app_private.mhp_whatsapp_connect(bytea,uuid,uuid,uuid,text,text,text,text,text,bytea,bytea,bytea,bytea,bytea,text,boolean),
 app_private.mhp_whatsapp_record_template(bytea,uuid,uuid,uuid,uuid,bytea,text,text,text,boolean),
 app_private.mhp_owned_whatsapp_send(bytea,uuid,uuid,uuid,uuid,text,boolean,boolean) TO r72_whatsapp_live_command;
RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_whatsapp_live_definer,r72_mhp_prospect_definer;
