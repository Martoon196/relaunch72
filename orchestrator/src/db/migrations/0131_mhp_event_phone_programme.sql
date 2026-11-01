-- MHP009B: public webinar SMS permission, owner exact batch and scheduled send.
-- Agreed SQL design docs/design/mhp-webinar-multichannel-20261031/009B-SQL-DESIGN.md
-- (sha256 30486ff74217acadc59b4b06dd2a5bab9d96e0f248941356180a5ba0dfdcbc7c).
-- Email proof: single-use link -> bounded capability. Phone proof: the
-- registrant's own signed inbound "JOIN <nonce>". Permission is purpose
-- mhp.webinar.<date>, never general marketing. One real owner activation
-- pre-materialises the exact approved message, delivery and reserved provider
-- operation; the due worker creates only a fresh event authority and one job.
-- No provider call, no new login role, no change to the active email programme.
SET LOCAL ROLE r72_owner;

-- 1. Exact registrant identity for composite keys.
ALTER TABLE app_private.mhp_prospect_signups ADD CONSTRAINT mhp_signup_prospect_identity UNIQUE(id,prospect_id);

-- 2. Private intent and proof relations.
CREATE TABLE app_private.mhp_event_phone_intents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL CHECK(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b'),
 prospect_id uuid NOT NULL REFERENCES app_private.mhp_prospects(id) ON DELETE CASCADE,
 signup_id uuid NOT NULL,
 campaign text NOT NULL CHECK(campaign~'^webinar-[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
 programme_version_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN('access','sms')),
 parent_access_id uuid,
 revision integer NOT NULL CHECK(revision>=1),
 previous_intent_id uuid,
 state text NOT NULL CHECK(state IN('issued','open','awaiting_join','verified','superseded','withdrawn','expired','held')),
 command_id uuid NOT NULL,
 request_key_sha256 bytea NOT NULL CHECK(octet_length(request_key_sha256)=32),
 payload_sha256 bytea NOT NULL CHECK(octet_length(payload_sha256)=32),
 source_sha256 bytea NOT NULL CHECK(octet_length(source_sha256)=32),
 email_identity_sha256 bytea NOT NULL CHECK(octet_length(email_identity_sha256)=32),
 access_token_sha256 bytea CHECK(access_token_sha256 IS NULL OR octet_length(access_token_sha256)=32),
 access_expires_at timestamptz,
 access_consumed_at timestamptz,
 capability_sha256 bytea CHECK(capability_sha256 IS NULL OR octet_length(capability_sha256)=32),
 capability_expires_at timestamptz,
 phone_e164 text CHECK(phone_e164 IS NULL OR phone_e164~'^\+447[0-9]{9}$'),
 phone_identity_sha256 bytea CHECK(phone_identity_sha256 IS NULL OR octet_length(phone_identity_sha256)=32),
 channel text CHECK(channel IS NULL OR channel='sms'),
 consent_revision text CHECK(consent_revision IS NULL OR consent_revision='mhp.event-phone-sms/v1'),
 consent_text_sha256 bytea CHECK(consent_text_sha256 IS NULL OR octet_length(consent_text_sha256)=32),
 consent_chosen_at timestamptz,
 join_nonce_sha256 bytea CHECK(join_nonce_sha256 IS NULL OR octet_length(join_nonce_sha256)=32),
 join_expires_at timestamptz,
 join_consumed_at timestamptz,
 consumed_provider_event_id text CHECK(consumed_provider_event_id IS NULL OR consumed_provider_event_id~'^inbound:(SM|MM)[0-9a-f]{32}$'),
 contact_id uuid,
 point_id uuid,
 result_receipt_id uuid,
 hold_reason text CHECK(hold_reason IS NULL OR hold_reason IN('crm_ambiguous','suppressed','programme_changed')),
 created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 UNIQUE(workspace_id,request_key_sha256),
 UNIQUE(id,prospect_id,signup_id,campaign),
 FOREIGN KEY(signup_id,prospect_id) REFERENCES app_private.mhp_prospect_signups(id,prospect_id) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,programme_version_id) REFERENCES app.company_content_versions(workspace_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(parent_access_id,prospect_id,signup_id,campaign) REFERENCES app_private.mhp_event_phone_intents(id,prospect_id,signup_id,campaign) ON DELETE CASCADE,
 FOREIGN KEY(previous_intent_id) REFERENCES app_private.mhp_event_phone_intents(id) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,point_id,contact_id) REFERENCES app.contact_points(workspace_id,id,contact_id) ON DELETE RESTRICT,
 CHECK(updated_at>=created_at),
 CONSTRAINT mhp_event_phone_intent_shape CHECK(
  (kind='access' AND parent_access_id IS NULL AND previous_intent_id IS NULL AND revision=1
   AND state IN('issued','open','superseded','expired')
   AND access_token_sha256 IS NOT NULL AND access_expires_at IS NOT NULL
   AND access_expires_at>created_at AND access_expires_at<=created_at+interval '15 minutes'
   AND (access_consumed_at IS NULL)=(capability_sha256 IS NULL) AND (capability_sha256 IS NULL)=(capability_expires_at IS NULL)
   AND (state<>'open' OR capability_sha256 IS NOT NULL) AND (state<>'issued' OR access_consumed_at IS NULL)
   AND (access_consumed_at IS NULL OR (access_consumed_at>=created_at AND access_consumed_at<access_expires_at))
   AND (capability_expires_at IS NULL OR (capability_expires_at>access_consumed_at AND capability_expires_at<=access_consumed_at+interval '15 minutes'))
   AND phone_e164 IS NULL AND phone_identity_sha256 IS NULL AND channel IS NULL AND consent_revision IS NULL AND consent_text_sha256 IS NULL
   AND consent_chosen_at IS NULL AND join_nonce_sha256 IS NULL AND join_expires_at IS NULL AND join_consumed_at IS NULL
   AND consumed_provider_event_id IS NULL AND contact_id IS NULL AND point_id IS NULL AND result_receipt_id IS NULL AND hold_reason IS NULL)
  OR
  (kind='sms' AND parent_access_id IS NOT NULL AND (previous_intent_id IS NULL)=(revision=1)
   AND state IN('awaiting_join','verified','superseded','withdrawn','expired','held')
   AND access_token_sha256 IS NULL AND access_expires_at IS NULL AND access_consumed_at IS NULL AND capability_sha256 IS NULL AND capability_expires_at IS NULL
   AND channel='sms' AND phone_e164 IS NOT NULL AND phone_identity_sha256 IS NOT NULL AND consent_revision IS NOT NULL AND consent_text_sha256 IS NOT NULL
   AND consent_chosen_at IS NOT NULL AND join_nonce_sha256 IS NOT NULL AND join_expires_at IS NOT NULL
   AND join_expires_at>consent_chosen_at AND join_expires_at<=consent_chosen_at+interval '10 minutes'
   AND (join_consumed_at IS NULL)=(consumed_provider_event_id IS NULL)
   AND (point_id IS NULL)=(contact_id IS NULL) AND (point_id IS NULL)=(result_receipt_id IS NULL)
   AND (point_id IS NULL OR join_consumed_at IS NOT NULL)
   AND (join_consumed_at IS NULL OR join_consumed_at>=consent_chosen_at)
   AND (state<>'awaiting_join' OR (join_consumed_at IS NULL AND hold_reason IS NULL))
   AND (state<>'verified' OR (point_id IS NOT NULL AND hold_reason IS NULL))
   AND (state<>'withdrawn' OR point_id IS NOT NULL)
   AND (state='held')=(hold_reason IS NOT NULL) AND (state<>'held' OR point_id IS NULL))
 )
);
CREATE UNIQUE INDEX mhp_event_phone_one_pending_sms ON app_private.mhp_event_phone_intents(campaign,prospect_id)
 WHERE kind='sms' AND state='awaiting_join';
CREATE UNIQUE INDEX mhp_event_phone_one_live_grant ON app_private.mhp_event_phone_intents(campaign,prospect_id)
 WHERE kind='sms' AND state='verified';
CREATE UNIQUE INDEX mhp_event_phone_sms_revision ON app_private.mhp_event_phone_intents(campaign,prospect_id,revision) WHERE kind='sms';
CREATE UNIQUE INDEX mhp_event_phone_access_token ON app_private.mhp_event_phone_intents(access_token_sha256) WHERE access_token_sha256 IS NOT NULL;
CREATE UNIQUE INDEX mhp_event_phone_capability ON app_private.mhp_event_phone_intents(capability_sha256) WHERE capability_sha256 IS NOT NULL;
CREATE UNIQUE INDEX mhp_event_phone_join_nonce ON app_private.mhp_event_phone_intents(join_nonce_sha256) WHERE join_nonce_sha256 IS NOT NULL;
CREATE INDEX mhp_event_phone_email_rate ON app_private.mhp_event_phone_intents(email_identity_sha256,created_at);
CREATE INDEX mhp_event_phone_source_rate ON app_private.mhp_event_phone_intents(source_sha256,created_at);
CREATE INDEX mhp_event_phone_phone_rate ON app_private.mhp_event_phone_intents(phone_identity_sha256,created_at) WHERE phone_identity_sha256 IS NOT NULL;

CREATE TABLE app_private.mhp_event_phone_receipts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL CHECK(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b'),
 intent_id uuid NOT NULL,
 intent_revision integer NOT NULL CHECK(intent_revision>=1),
 campaign text NOT NULL,
 prospect_id uuid NOT NULL,
 signup_id uuid NOT NULL,
 channel text NOT NULL CHECK(channel='sms'),
 purpose text NOT NULL,
 contact_id uuid NOT NULL,
 contact_point_id uuid NOT NULL,
 endpoint_identity_sha256 bytea NOT NULL CHECK(octet_length(endpoint_identity_sha256)=32),
 phone_identity_sha256 bytea NOT NULL CHECK(octet_length(phone_identity_sha256)=32),
 decision text NOT NULL CHECK(decision IN('granted','withdrawn')),
 consent_revision text NOT NULL CHECK(consent_revision='mhp.event-phone-sms/v1'),
 consent_text_sha256 bytea NOT NULL CHECK(octet_length(consent_text_sha256)=32),
 consent_event_id uuid NOT NULL,
 proof_kind text NOT NULL CHECK(proof_kind IN('signed_twilio_join','signed_twilio_stop','public_event_withdrawal')),
 provider_connection_id uuid NOT NULL,
 sender_binding_id uuid NOT NULL,
 channel_endpoint_id uuid NOT NULL,
 provider_account_sid_sha256 bytea NOT NULL CHECK(octet_length(provider_account_sid_sha256)=32),
 provider_service_sid_sha256 bytea NOT NULL CHECK(octet_length(provider_service_sid_sha256)=32),
 destination_e164 text NOT NULL CHECK(destination_e164~'^\+44[0-9]{9,10}$'),
 provider_event_id text CHECK(provider_event_id IS NULL OR provider_event_id~'^inbound:(SM|MM)[0-9a-f]{32}$'),
 provider_message_sid text CHECK(provider_message_sid IS NULL OR provider_message_sid~'^(SM|MM)[0-9a-f]{32}$'),
 payload_sha256 bytea CHECK(payload_sha256 IS NULL OR octet_length(payload_sha256)=32),
 signature_sha256 bytea CHECK(signature_sha256 IS NULL OR octet_length(signature_sha256)=32),
 body_sha256 bytea CHECK(body_sha256 IS NULL OR octet_length(body_sha256)=32),
 event_identity_sha256 bytea CHECK(event_identity_sha256 IS NULL OR octet_length(event_identity_sha256)=32),
 occurred_at timestamptz NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 supersedes_receipt_id uuid REFERENCES app_private.mhp_event_phone_receipts(id) ON DELETE RESTRICT,
 request_sha256 bytea NOT NULL CHECK(octet_length(request_sha256)=32),
 UNIQUE(intent_id,decision,request_sha256),
 UNIQUE(id,intent_id,contact_point_id),
 FOREIGN KEY(intent_id,prospect_id,signup_id,campaign) REFERENCES app_private.mhp_event_phone_intents(id,prospect_id,signup_id,campaign) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,contact_point_id,contact_id) REFERENCES app.contact_points(workspace_id,id,contact_id) ON DELETE RESTRICT,
 FOREIGN KEY(workspace_id,consent_event_id) REFERENCES app.communication_consent_events(workspace_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(workspace_id,provider_connection_id) REFERENCES app.provider_connections(workspace_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(workspace_id,channel_endpoint_id) REFERENCES app.channel_endpoints(workspace_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(sender_binding_id) REFERENCES app.property_predator_sms_bindings(id) ON DELETE RESTRICT,
 CHECK(purpose='mhp.webinar.'||substr(campaign,9)),
 CHECK(occurred_at<=recorded_at+interval '5 minutes'),
 CONSTRAINT mhp_event_phone_receipt_proof CHECK(
  (proof_kind IN('signed_twilio_join','signed_twilio_stop') AND provider_event_id IS NOT NULL AND provider_message_sid IS NOT NULL
   AND provider_event_id='inbound:'||provider_message_sid AND payload_sha256 IS NOT NULL AND signature_sha256 IS NOT NULL
   AND body_sha256 IS NOT NULL AND event_identity_sha256 IS NOT NULL)
  OR (proof_kind='public_event_withdrawal' AND provider_event_id IS NULL AND provider_message_sid IS NULL AND payload_sha256 IS NULL
   AND signature_sha256 IS NULL AND body_sha256 IS NULL AND event_identity_sha256 IS NULL)),
 CONSTRAINT mhp_event_phone_receipt_decision CHECK(
  (decision='granted' AND proof_kind='signed_twilio_join' AND supersedes_receipt_id IS NULL)
  OR (decision='withdrawn' AND proof_kind IN('signed_twilio_stop','public_event_withdrawal') AND supersedes_receipt_id IS NOT NULL))
);
CREATE UNIQUE INDEX mhp_event_phone_receipt_provider_event ON app_private.mhp_event_phone_receipts(workspace_id,provider_connection_id,provider_event_id,intent_id)
 WHERE provider_event_id IS NOT NULL;
CREATE UNIQUE INDEX mhp_event_phone_receipt_one_withdrawal ON app_private.mhp_event_phone_receipts(supersedes_receipt_id) WHERE supersedes_receipt_id IS NOT NULL;
CREATE INDEX mhp_event_phone_receipt_current ON app_private.mhp_event_phone_receipts(campaign,prospect_id,occurred_at DESC,recorded_at DESC,id DESC);
CREATE INDEX mhp_event_phone_receipt_point ON app_private.mhp_event_phone_receipts(contact_point_id,campaign);
ALTER TABLE app_private.mhp_event_phone_intents ADD CONSTRAINT mhp_event_phone_intent_result
 FOREIGN KEY(result_receipt_id,id,point_id) REFERENCES app_private.mhp_event_phone_receipts(id,intent_id,contact_point_id) DEFERRABLE INITIALLY DEFERRED;

-- Immutable identity; only named lifecycle fields move, once, forward.
CREATE FUNCTION app_private.mhp_event_phone_intent_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $f$
BEGIN
 IF TG_OP='DELETE' THEN
  -- Only the registrant's own erasure cascade (prospect -> intents) may remove rows.
  IF pg_trigger_depth()>1 THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Event phone intent evidence is immutable' USING ERRCODE='40001';
 END IF;
 IF (to_jsonb(NEW)-ARRAY['state','access_consumed_at','capability_sha256','capability_expires_at','join_consumed_at','consumed_provider_event_id',
   'contact_id','point_id','result_receipt_id','hold_reason','updated_at'])
  IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','access_consumed_at','capability_sha256','capability_expires_at','join_consumed_at','consumed_provider_event_id',
   'contact_id','point_id','result_receipt_id','hold_reason','updated_at'])
  OR (OLD.access_consumed_at IS NOT NULL AND NEW.access_consumed_at IS DISTINCT FROM OLD.access_consumed_at)
  OR (OLD.capability_sha256 IS NOT NULL AND NEW.capability_sha256 IS DISTINCT FROM OLD.capability_sha256)
  OR (OLD.capability_expires_at IS NOT NULL AND NEW.capability_expires_at IS DISTINCT FROM OLD.capability_expires_at)
  OR (OLD.join_consumed_at IS NOT NULL AND NEW.join_consumed_at IS DISTINCT FROM OLD.join_consumed_at)
  OR (OLD.consumed_provider_event_id IS NOT NULL AND NEW.consumed_provider_event_id IS DISTINCT FROM OLD.consumed_provider_event_id)
  OR (OLD.point_id IS NOT NULL AND (NEW.point_id IS DISTINCT FROM OLD.point_id OR NEW.contact_id IS DISTINCT FROM OLD.contact_id
   OR NEW.result_receipt_id IS DISTINCT FROM OLD.result_receipt_id))
  OR NEW.updated_at<OLD.updated_at
  OR NOT ((OLD.state=NEW.state)
   OR (OLD.state='issued' AND NEW.state IN('open','superseded','expired'))
   OR (OLD.state='open' AND NEW.state IN('superseded','expired'))
   OR (OLD.state='awaiting_join' AND NEW.state IN('verified','superseded','expired','held'))
   OR (OLD.state='verified' AND NEW.state IN('superseded','withdrawn')))
 THEN RAISE EXCEPTION 'Event phone intent transition denied' USING ERRCODE='40001'; END IF;
 RETURN NEW;
END $f$;
CREATE TRIGGER mhp_event_phone_intent_guard BEFORE UPDATE OR DELETE ON app_private.mhp_event_phone_intents
 FOR EACH ROW EXECUTE FUNCTION app_private.mhp_event_phone_intent_guard();
CREATE FUNCTION app_private.mhp_event_phone_receipt_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $f$
BEGIN RAISE EXCEPTION 'Event phone proof is append-only' USING ERRCODE='40001'; END $f$;
CREATE TRIGGER mhp_event_phone_receipt_guard BEFORE UPDATE ON app_private.mhp_event_phone_receipts
 FOR EACH ROW EXECUTE FUNCTION app_private.mhp_event_phone_receipt_guard();
REVOKE ALL ON FUNCTION app_private.mhp_event_phone_intent_guard(),app_private.mhp_event_phone_receipt_guard() FROM PUBLIC;

-- 3. Existing absolute calendar gains an exclusive SMS event shape.
ALTER TABLE app_private.mhp_marketing_sends
 ADD COLUMN delivery_channel text NOT NULL DEFAULT 'email' CONSTRAINT mhp_send_delivery_channel CHECK(delivery_channel IN('email','sms')),
 ADD COLUMN event_workspace_id uuid,
 ADD COLUMN event_starts_at timestamptz,
 ADD COLUMN event_programme_item_id uuid,
 ADD COLUMN event_programme_version_id uuid,
 ADD COLUMN event_programme_sha256 bytea,
 ADD COLUMN event_programme_approval_id uuid,
 ADD COLUMN event_source_item_id uuid,
 ADD COLUMN event_source_version_id uuid,
 ADD COLUMN event_source_sha256 bytea,
 ADD COLUMN event_receipt_id uuid,
 ADD COLUMN event_receipt_revision integer,
 ADD COLUMN event_signup_id uuid,
 ADD COLUMN event_contact_id uuid,
 ADD COLUMN event_point_id uuid,
 ADD COLUMN event_endpoint_identity_sha256 bytea,
 ADD COLUMN event_consent_event_id uuid,
 ADD COLUMN event_binding_id uuid,
 ADD COLUMN event_provider_connection_id uuid,
 ADD COLUMN event_channel_endpoint_id uuid,
 ADD COLUMN event_sender_number text,
 ADD COLUMN event_purpose text,
 ADD COLUMN event_step_key text,
 ADD COLUMN event_segment_count integer,
 ADD COLUMN event_body_sha256 bytea,
 ADD COLUMN event_activation_actor_user_id uuid,
 ADD COLUMN event_activation_request_id text,
 ADD COLUMN event_activation_command_id uuid,
 ADD COLUMN event_activation_payload_sha256 bytea,
 ADD COLUMN event_message_id uuid,
 ADD COLUMN event_message_version_id uuid,
 ADD COLUMN event_approval_request_id uuid,
 ADD COLUMN event_approval_decision_id uuid,
 ADD COLUMN event_delivery_id uuid,
 ADD COLUMN event_provider_operation_id uuid,
 ADD COLUMN event_idempotency_key_sha256 bytea,
 ADD COLUMN event_compliance_subject_id uuid,
 ADD COLUMN event_policy_publication_id uuid,
 ADD COLUMN event_pecr_sender_decision_id uuid,
 ADD COLUMN event_pecr_instigator_decision_id uuid,
 ADD COLUMN event_provider_deadline timestamptz,
 ADD COLUMN event_held_at timestamptz,
 ADD COLUMN event_hold_reason text,
 ADD COLUMN event_prepared_at timestamptz,
 ADD COLUMN event_authority_expires_at timestamptz,
 ADD COLUMN event_authority_id uuid,
 ADD COLUMN event_job_id uuid,
 ADD COLUMN event_preparation_request_id text,
 ADD COLUMN event_decision_sha256 bytea,
 ADD COLUMN event_source_check_sha256 bytea;
ALTER TABLE app_private.mhp_marketing_sends ADD CONSTRAINT mhp_event_send_shape CHECK(
 (delivery_channel='email' AND event_workspace_id IS NULL AND event_starts_at IS NULL AND event_programme_item_id IS NULL AND event_programme_version_id IS NULL
  AND event_programme_sha256 IS NULL AND event_programme_approval_id IS NULL AND event_source_item_id IS NULL AND event_source_version_id IS NULL
  AND event_source_sha256 IS NULL AND event_receipt_id IS NULL AND event_receipt_revision IS NULL AND event_signup_id IS NULL AND event_contact_id IS NULL
  AND event_point_id IS NULL AND event_endpoint_identity_sha256 IS NULL AND event_consent_event_id IS NULL AND event_binding_id IS NULL
  AND event_provider_connection_id IS NULL AND event_channel_endpoint_id IS NULL AND event_sender_number IS NULL AND event_purpose IS NULL
  AND event_step_key IS NULL AND event_segment_count IS NULL AND event_body_sha256 IS NULL AND event_activation_actor_user_id IS NULL
  AND event_activation_request_id IS NULL AND event_activation_command_id IS NULL AND event_activation_payload_sha256 IS NULL AND event_message_id IS NULL
  AND event_message_version_id IS NULL AND event_approval_request_id IS NULL AND event_approval_decision_id IS NULL AND event_delivery_id IS NULL
  AND event_provider_operation_id IS NULL AND event_idempotency_key_sha256 IS NULL AND event_compliance_subject_id IS NULL
  AND event_policy_publication_id IS NULL AND event_pecr_sender_decision_id IS NULL AND event_pecr_instigator_decision_id IS NULL
  AND event_provider_deadline IS NULL AND event_held_at IS NULL AND event_hold_reason IS NULL AND event_prepared_at IS NULL
  AND event_authority_expires_at IS NULL AND event_authority_id IS NULL AND event_job_id IS NULL AND event_preparation_request_id IS NULL
  AND event_decision_sha256 IS NULL AND event_source_check_sha256 IS NULL)
 OR
 (delivery_channel='sms' AND event_workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b'
  AND owner_workspace_id IS NULL AND owner_content_item_id IS NULL AND owner_content_version_id IS NULL AND owner_content_sha256 IS NULL
  AND owner_approval_decision_id IS NULL AND owner_user_id IS NULL AND owner_audience_campaign IS NULL AND owner_lease_id IS NULL
  AND owner_held_at IS NULL AND owner_hold_reason IS NULL AND owner_last_failure IS NULL AND sequence_run_id IS NULL AND sequence_step IS NULL
  AND context='{}'::jsonb AND lease_until IS NULL AND attempts=0 AND sent_at IS NULL AND provider_reference IS NULL AND failed_at IS NULL
  AND campaign_key~'^webinar-[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND event_purpose='mhp.webinar.'||substr(campaign_key,9)
  AND template_key=event_step_key AND event_step_key~'^event_sms_[a-z0-9]{1,20}$'
  AND event_starts_at IS NOT NULL AND event_programme_item_id IS NOT NULL AND event_programme_version_id IS NOT NULL
  AND octet_length(event_programme_sha256)=32 AND event_programme_approval_id IS NOT NULL AND event_source_item_id IS NOT NULL
  AND event_source_version_id IS NOT NULL AND octet_length(event_source_sha256)=32 AND event_receipt_id IS NOT NULL
  AND event_receipt_revision>=1 AND event_signup_id IS NOT NULL AND event_contact_id IS NOT NULL AND event_point_id IS NOT NULL
  AND octet_length(event_endpoint_identity_sha256)=32 AND event_consent_event_id IS NOT NULL AND event_binding_id IS NOT NULL
  AND event_provider_connection_id IS NOT NULL AND event_channel_endpoint_id IS NOT NULL AND event_sender_number~'^\+44[0-9]{9,10}$'
  AND event_segment_count BETWEEN 1 AND 10 AND octet_length(event_body_sha256)=32
  AND event_activation_actor_user_id IS NOT NULL AND event_activation_request_id IS NOT NULL
  AND event_activation_request_id=btrim(event_activation_request_id) AND length(event_activation_request_id) BETWEEN 1 AND 128
  AND event_activation_command_id IS NOT NULL AND octet_length(event_activation_payload_sha256)=32
  AND event_message_id IS NOT NULL AND event_message_version_id IS NOT NULL AND event_approval_request_id IS NOT NULL
  AND event_approval_decision_id IS NOT NULL AND event_delivery_id IS NOT NULL AND event_provider_operation_id IS NOT NULL
  AND octet_length(event_idempotency_key_sha256)=32 AND event_compliance_subject_id IS NOT NULL AND event_policy_publication_id IS NOT NULL
  AND event_pecr_sender_decision_id IS NOT NULL AND event_pecr_instigator_decision_id IS NOT NULL AND event_provider_deadline IS NOT NULL
  AND due_at<expires_at AND expires_at<=event_provider_deadline AND event_provider_deadline<=event_starts_at
  AND (event_held_at IS NULL)=(event_hold_reason IS NULL)
  AND (event_hold_reason IS NULL OR event_hold_reason IN('owner_hold','newer_draft','receipt_changed','not_eligible','cap_reached','expired','recovery','prepare_failed'))
  AND ((event_prepared_at IS NULL AND event_authority_expires_at IS NULL AND event_authority_id IS NULL AND event_job_id IS NULL
    AND event_preparation_request_id IS NULL AND event_decision_sha256 IS NULL AND event_source_check_sha256 IS NULL)
   OR (event_prepared_at IS NOT NULL AND event_authority_expires_at IS NOT NULL AND event_authority_id IS NOT NULL AND event_job_id IS NOT NULL
    AND event_preparation_request_id IS NOT NULL AND octet_length(event_decision_sha256)=32 AND octet_length(event_source_check_sha256)=32
    AND event_prepared_at>=due_at AND event_authority_expires_at>event_prepared_at
    AND event_authority_expires_at<=event_prepared_at+interval '4 minutes' AND event_authority_expires_at<=expires_at
    AND event_authority_expires_at<=event_provider_deadline)))
);
ALTER TABLE app_private.mhp_marketing_sends
 ADD CONSTRAINT mhp_event_send_identity UNIQUE(id,event_provider_connection_id,event_delivery_id),
 ADD CONSTRAINT mhp_event_send_programme_fk FOREIGN KEY(event_workspace_id,event_programme_item_id,event_programme_version_id,event_programme_sha256)
  REFERENCES app.company_content_versions(workspace_id,content_item_id,id,content_sha256) ON DELETE RESTRICT,
 ADD CONSTRAINT mhp_event_send_programme_approval_fk FOREIGN KEY(event_workspace_id,event_programme_approval_id)
  REFERENCES app.company_content_approval_decisions(workspace_id,id) ON DELETE RESTRICT,
 ADD CONSTRAINT mhp_event_send_source_fk FOREIGN KEY(event_workspace_id,event_source_item_id,event_source_version_id,event_source_sha256)
  REFERENCES app.company_content_versions(workspace_id,content_item_id,id,content_sha256) ON DELETE RESTRICT,
 ADD CONSTRAINT mhp_event_send_receipt_fk FOREIGN KEY(event_receipt_id) REFERENCES app_private.mhp_event_phone_receipts(id) ON DELETE RESTRICT,
 ADD CONSTRAINT mhp_event_send_signup_fk FOREIGN KEY(event_signup_id,prospect_id) REFERENCES app_private.mhp_prospect_signups(id,prospect_id) ON DELETE RESTRICT,
 ADD CONSTRAINT mhp_event_send_point_fk FOREIGN KEY(event_workspace_id,event_point_id,event_contact_id) REFERENCES app.contact_points(workspace_id,id,contact_id) ON DELETE RESTRICT,
 ADD CONSTRAINT mhp_event_send_consent_fk FOREIGN KEY(event_workspace_id,event_consent_event_id) REFERENCES app.communication_consent_events(workspace_id,id) ON DELETE RESTRICT,
 ADD CONSTRAINT mhp_event_send_binding_fk FOREIGN KEY(event_binding_id) REFERENCES app.property_predator_sms_bindings(id) ON DELETE RESTRICT,
 ADD CONSTRAINT mhp_event_send_connection_fk FOREIGN KEY(event_workspace_id,event_provider_connection_id) REFERENCES app.provider_connections(workspace_id,id) ON DELETE RESTRICT,
 ADD CONSTRAINT mhp_event_send_endpoint_fk FOREIGN KEY(event_workspace_id,event_channel_endpoint_id) REFERENCES app.channel_endpoints(workspace_id,id) ON DELETE RESTRICT,
 ADD CONSTRAINT mhp_event_send_actor_fk FOREIGN KEY(event_workspace_id,event_activation_actor_user_id) REFERENCES app.workspace_memberships(workspace_id,user_id) ON DELETE RESTRICT,
 ADD CONSTRAINT mhp_event_send_version_fk FOREIGN KEY(event_workspace_id,event_message_version_id) REFERENCES app.message_versions(workspace_id,id) ON DELETE RESTRICT,
 ADD CONSTRAINT mhp_event_send_request_fk FOREIGN KEY(event_workspace_id,event_approval_request_id) REFERENCES app.message_approval_requests(workspace_id,id) ON DELETE RESTRICT,
 ADD CONSTRAINT mhp_event_send_decision_fk FOREIGN KEY(event_workspace_id,event_approval_decision_id) REFERENCES app.message_approval_decisions(workspace_id,id) ON DELETE RESTRICT,
 ADD CONSTRAINT mhp_event_send_delivery_fk FOREIGN KEY(event_workspace_id,event_provider_operation_id,event_delivery_id)
  REFERENCES app.message_deliveries(workspace_id,provider_operation_id,id) ON DELETE RESTRICT,
 ADD CONSTRAINT mhp_event_send_subject_fk FOREIGN KEY(event_workspace_id,event_compliance_subject_id)
  REFERENCES app_private.affiliate_compliance_subjects(workspace_id,id) ON DELETE RESTRICT,
 ADD CONSTRAINT mhp_event_send_publication_fk FOREIGN KEY(event_workspace_id,event_policy_publication_id)
  REFERENCES app_private.affiliate_compliance_policy_publication_events(workspace_id,id) ON DELETE RESTRICT,
 ADD CONSTRAINT mhp_event_send_sender_fk FOREIGN KEY(event_workspace_id,event_pecr_sender_decision_id)
  REFERENCES app_private.affiliate_compliance_specialist_decision_events(workspace_id,id) ON DELETE RESTRICT,
 ADD CONSTRAINT mhp_event_send_instigator_fk FOREIGN KEY(event_workspace_id,event_pecr_instigator_decision_id)
  REFERENCES app_private.affiliate_compliance_specialist_decision_events(workspace_id,id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX mhp_event_send_one_point ON app_private.mhp_marketing_sends(event_workspace_id,campaign_key,event_step_key,event_point_id)
 WHERE delivery_channel='sms';
CREATE UNIQUE INDEX mhp_event_send_one_delivery ON app_private.mhp_marketing_sends(event_delivery_id) WHERE delivery_channel='sms';
CREATE UNIQUE INDEX mhp_event_send_one_idempotency ON app_private.mhp_marketing_sends(event_idempotency_key_sha256) WHERE delivery_channel='sms';
CREATE INDEX mhp_event_send_due ON app_private.mhp_marketing_sends(event_provider_connection_id,due_at)
 WHERE delivery_channel='sms' AND event_job_id IS NULL AND cancelled_at IS NULL AND event_held_at IS NULL;

CREATE FUNCTION app_private.mhp_event_send_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $f$
DECLARE mutable constant text[]:=ARRAY['cancelled_at','event_held_at','event_hold_reason','event_prepared_at','event_authority_expires_at',
 'event_authority_id','event_job_id','event_preparation_request_id','event_decision_sha256','event_source_check_sha256'];
BEGIN
 IF TG_OP='UPDATE' AND OLD.delivery_channel='email' AND NEW.delivery_channel='email' THEN RETURN NEW; END IF;
 IF TG_OP='DELETE' THEN
  IF OLD.delivery_channel='email' OR pg_trigger_depth()>1 THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Event SMS calendar evidence is immutable' USING ERRCODE='40001';
 END IF;
 IF NEW.delivery_channel IS DISTINCT FROM OLD.delivery_channel OR (to_jsonb(NEW)-mutable) IS DISTINCT FROM (to_jsonb(OLD)-mutable)
  OR (OLD.cancelled_at IS NOT NULL AND NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at)
  OR (OLD.event_job_id IS NOT NULL AND (NEW.event_prepared_at,NEW.event_authority_expires_at,NEW.event_authority_id,NEW.event_job_id,
   NEW.event_preparation_request_id,NEW.event_decision_sha256,NEW.event_source_check_sha256) IS DISTINCT FROM
   (OLD.event_prepared_at,OLD.event_authority_expires_at,OLD.event_authority_id,OLD.event_job_id,
   OLD.event_preparation_request_id,OLD.event_decision_sha256,OLD.event_source_check_sha256))
  OR (OLD.event_held_at IS NOT NULL AND (NEW.event_held_at,NEW.event_hold_reason) IS DISTINCT FROM (OLD.event_held_at,OLD.event_hold_reason))
 THEN RAISE EXCEPTION 'Event SMS calendar evidence is immutable' USING ERRCODE='40001'; END IF;
 RETURN NEW;
END $f$;
REVOKE ALL ON FUNCTION app_private.mhp_event_send_guard() FROM PUBLIC;
CREATE TRIGGER mhp_event_send_guard BEFORE UPDATE OR DELETE ON app_private.mhp_marketing_sends
 FOR EACH ROW EXECUTE FUNCTION app_private.mhp_event_send_guard();

-- 4. Minimal authority and job provenance branch.
ALTER TABLE app.property_predator_sms_authorities
 ADD COLUMN authority_kind text NOT NULL DEFAULT 'owner_action',
 ADD COLUMN event_calendar_id uuid,
 ADD COLUMN event_activation_sha256 bytea,
 ADD COLUMN event_receipt_id uuid,
 ADD COLUMN evaluated_by_role text,
 ADD COLUMN evaluated_request_id text,
 ADD COLUMN event_eligibility_sha256 bytea,
 ADD COLUMN source_checked_at timestamptz,
 ADD COLUMN source_check_sha256 bytea,
 ALTER COLUMN operator_user_id DROP NOT NULL,
 ALTER COLUMN operator_request_id DROP NOT NULL,
 ALTER COLUMN permission_use_receipt_id DROP NOT NULL,
 DROP CONSTRAINT property_predator_sms_authorities_purpose_check;
ALTER TABLE app.property_predator_sms_authorities
 ADD CONSTRAINT sms_authority_kind_shape CHECK(
  (authority_kind='owner_action' AND purpose='marketing' AND operator_user_id IS NOT NULL AND operator_request_id IS NOT NULL
   AND permission_use_receipt_id IS NOT NULL AND event_calendar_id IS NULL AND event_activation_sha256 IS NULL AND event_receipt_id IS NULL
   AND evaluated_by_role IS NULL AND evaluated_request_id IS NULL AND event_eligibility_sha256 IS NULL AND source_checked_at IS NULL
   AND source_check_sha256 IS NULL)
  OR
  (authority_kind='mhp_event' AND workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND purpose~'^mhp\.webinar\.[0-9]{4}-[0-9]{2}-[0-9]{2}$'
   AND lawful_basis='consent' AND operator_user_id IS NULL AND operator_request_id IS NULL AND permission_use_receipt_id IS NULL
   AND event_calendar_id IS NOT NULL AND octet_length(event_activation_sha256)=32 AND event_receipt_id IS NOT NULL
   AND evaluated_by_role='r72_sms_worker_command' AND evaluated_request_id IS NOT NULL
   AND evaluated_request_id=btrim(evaluated_request_id) AND length(evaluated_request_id) BETWEEN 1 AND 128
   AND octet_length(event_eligibility_sha256)=32 AND source_checked_at IS NOT NULL AND octet_length(source_check_sha256)=32
   AND source_checked_at<=evaluated_at AND valid_until<=evaluated_at+interval '4 minutes')),
 ADD CONSTRAINT sms_authority_kind_identity UNIQUE(workspace_id,id,authority_kind),
 ADD CONSTRAINT sms_authority_event_identity UNIQUE(workspace_id,id,event_calendar_id),
 ADD CONSTRAINT sms_authority_event_calendar_fk FOREIGN KEY(event_calendar_id,provider_connection_id,message_delivery_id)
  REFERENCES app_private.mhp_marketing_sends(id,event_provider_connection_id,event_delivery_id) ON DELETE RESTRICT,
 ADD CONSTRAINT sms_authority_event_receipt_fk FOREIGN KEY(event_receipt_id) REFERENCES app_private.mhp_event_phone_receipts(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX sms_authority_one_per_calendar ON app.property_predator_sms_authorities(event_calendar_id) WHERE event_calendar_id IS NOT NULL;

ALTER TABLE app.property_predator_sms_jobs
 ADD COLUMN authority_kind text NOT NULL DEFAULT 'owner_action',
 ADD COLUMN event_calendar_id uuid,
 ADD COLUMN created_by_actor_kind text NOT NULL DEFAULT 'user',
 ALTER COLUMN created_by_user_id DROP NOT NULL;
ALTER TABLE app.property_predator_sms_jobs
 ADD CONSTRAINT sms_job_kind_shape CHECK(
  (authority_kind='owner_action' AND created_by_actor_kind='user' AND created_by_user_id IS NOT NULL AND event_calendar_id IS NULL)
  OR (authority_kind='mhp_event' AND created_by_actor_kind='worker' AND created_by_user_id IS NULL
   AND workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND event_calendar_id IS NOT NULL)),
 ADD CONSTRAINT sms_job_authority_kind_fk FOREIGN KEY(workspace_id,authority_id,authority_kind)
  REFERENCES app.property_predator_sms_authorities(workspace_id,id,authority_kind) ON DELETE RESTRICT,
 ADD CONSTRAINT sms_job_authority_event_fk FOREIGN KEY(workspace_id,authority_id,event_calendar_id)
  REFERENCES app.property_predator_sms_authorities(workspace_id,id,event_calendar_id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX sms_job_one_per_calendar ON app.property_predator_sms_jobs(event_calendar_id) WHERE event_calendar_id IS NOT NULL;
ALTER TABLE app_private.mhp_marketing_sends
 ADD CONSTRAINT mhp_event_send_authority_fk FOREIGN KEY(event_workspace_id,event_authority_id,id)
  REFERENCES app.property_predator_sms_authorities(workspace_id,id,event_calendar_id) ON DELETE RESTRICT,
 ADD CONSTRAINT mhp_event_send_job_fk FOREIGN KEY(event_workspace_id,event_job_id) REFERENCES app.property_predator_sms_jobs(workspace_id,id) ON DELETE RESTRICT;

-- 5. Forced RLS, closed definers, no runtime table access.
ALTER TABLE app_private.mhp_event_phone_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.mhp_event_phone_intents FORCE ROW LEVEL SECURITY;
ALTER TABLE app_private.mhp_event_phone_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.mhp_event_phone_receipts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.mhp_event_phone_intents,app_private.mhp_event_phone_receipts FROM PUBLIC;
CREATE POLICY mhp_event_phone_intents_owner ON app_private.mhp_event_phone_intents TO r72_owner USING(true) WITH CHECK(true);
CREATE POLICY mhp_event_phone_receipts_owner ON app_private.mhp_event_phone_receipts TO r72_owner USING(true) WITH CHECK(true);
GRANT SELECT,INSERT,UPDATE ON app_private.mhp_event_phone_intents TO r72_mhp_prospect_definer,r72_sms_definer;
GRANT SELECT,INSERT ON app_private.mhp_event_phone_receipts TO r72_mhp_prospect_definer,r72_sms_definer;
CREATE POLICY mhp_event_phone_intents_public ON app_private.mhp_event_phone_intents TO r72_mhp_prospect_definer
 USING(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND session_user='r72_identity_command')
 WITH CHECK(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND session_user='r72_identity_command');
CREATE POLICY mhp_event_phone_receipts_public ON app_private.mhp_event_phone_receipts TO r72_mhp_prospect_definer
 USING(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND session_user='r72_identity_command')
 WITH CHECK(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND session_user='r72_identity_command'
  AND decision='withdrawn' AND proof_kind='public_event_withdrawal');
CREATE POLICY mhp_event_phone_intents_sms ON app_private.mhp_event_phone_intents TO r72_sms_definer
 USING(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND session_user IN('r72_sms_webhook_command','r72_sms_command','r72_sms_worker_command')
  AND current_setting('app.workspace_id',true)='2789228d-55a6-4688-b1e8-2f70abca990b')
 WITH CHECK(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND session_user='r72_sms_webhook_command'
  AND current_setting('app.actor_kind',true)='webhook');
CREATE POLICY mhp_event_phone_receipts_sms_read ON app_private.mhp_event_phone_receipts FOR SELECT TO r72_sms_definer
 USING(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND session_user IN('r72_sms_webhook_command','r72_sms_command','r72_sms_worker_command')
  AND current_setting('app.workspace_id',true)='2789228d-55a6-4688-b1e8-2f70abca990b');
CREATE POLICY mhp_event_phone_receipts_sms_signed ON app_private.mhp_event_phone_receipts FOR INSERT TO r72_sms_definer
 WITH CHECK(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND session_user='r72_sms_webhook_command'
  AND current_setting('app.actor_kind',true)='webhook' AND proof_kind IN('signed_twilio_join','signed_twilio_stop'));
-- The SMS definer reads and writes only the SMS event shape of the calendar.
GRANT SELECT,INSERT,UPDATE ON app_private.mhp_marketing_sends TO r72_sms_definer;
CREATE POLICY mhp_event_send_sms_read ON app_private.mhp_marketing_sends FOR SELECT TO r72_sms_definer
 USING(delivery_channel='sms' AND event_workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b'
  AND current_setting('app.workspace_id',true)='2789228d-55a6-4688-b1e8-2f70abca990b');
CREATE POLICY mhp_event_send_sms_insert ON app_private.mhp_marketing_sends FOR INSERT TO r72_sms_definer
 WITH CHECK(delivery_channel='sms' AND event_workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND session_user='r72_sms_command'
  AND current_setting('app.actor_kind',true)='user' AND event_activation_actor_user_id=nullif(current_setting('app.user_id',true),'')::uuid
  AND event_activation_request_id=current_setting('app.request_id',true));
CREATE POLICY mhp_event_send_sms_update ON app_private.mhp_marketing_sends FOR UPDATE TO r72_sms_definer
 USING(delivery_channel='sms' AND event_workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b'
  AND session_user IN('r72_sms_command','r72_sms_worker_command','r72_sms_webhook_command'))
 WITH CHECK(delivery_channel='sms' AND event_workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b');
GRANT SELECT ON app_private.mhp_prospects,app_private.mhp_prospect_signups TO r72_sms_definer;
CREATE POLICY mhp_event_prospects_sms_read ON app_private.mhp_prospects FOR SELECT TO r72_sms_definer
 USING(session_user IN('r72_sms_webhook_command','r72_sms_command','r72_sms_worker_command')
  AND current_setting('app.workspace_id',true)='2789228d-55a6-4688-b1e8-2f70abca990b');
CREATE POLICY mhp_event_signups_sms_read ON app_private.mhp_prospect_signups FOR SELECT TO r72_sms_definer
 USING(session_user IN('r72_sms_webhook_command','r72_sms_command','r72_sms_worker_command')
  AND current_setting('app.workspace_id',true)='2789228d-55a6-4688-b1e8-2f70abca990b');
-- Signed JOIN may create the one proved MHP contact and its proved points.
GRANT INSERT ON app.contacts TO r72_sms_definer;
CREATE POLICY mhp_event_phone_contact_insert ON app.contacts FOR INSERT TO r72_sms_definer
 WITH CHECK(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND session_user='r72_sms_webhook_command'
  AND current_setting('app.actor_kind',true)='webhook' AND owner_user_id IS NULL AND lifecycle_status='lead'
  AND source~'^mhp:event-phone:webinar-[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND deleted_at IS NULL);
CREATE POLICY mhp_event_phone_contact_read ON app.contacts FOR SELECT TO r72_sms_definer
 USING(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND session_user='r72_sms_webhook_command'
  AND current_setting('app.actor_kind',true)='webhook');
CREATE POLICY mhp_event_phone_email_point_insert ON app.contact_points FOR INSERT TO r72_sms_definer
 WITH CHECK(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND session_user='r72_sms_webhook_command'
  AND current_setting('app.actor_kind',true)='webhook' AND kind='email' AND is_verified AND consent_status='unknown'
  AND dedupe_state='normal' AND deleted_at IS NULL AND NOT is_primary);
-- Event consent is appended only by the signed JOIN/STOP wrapper or the
-- registrant's own bounded withdrawal; never generic marketing.
CREATE POLICY mhp_event_phone_consent_signed ON app.communication_consent_events FOR INSERT TO r72_sms_definer
 WITH CHECK(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND session_user='r72_sms_webhook_command'
  AND current_setting('app.actor_kind',true)='webhook' AND channel='sms' AND purpose~'^mhp\.webinar\.[0-9]{4}-[0-9]{2}-[0-9]{2}$'
  AND ((state='granted' AND lawful_basis='consent' AND source='mhp.event-phone.join' AND policy_version='mhp.event-phone-sms/v1')
   OR (state='withdrawn' AND source='mhp.event-phone.stop'))
  AND actor_kind='webhook' AND actor_user_id IS NULL);
GRANT INSERT ON app.communication_consent_events TO r72_mhp_prospect_definer;
GRANT SELECT ON app.contact_points TO r72_mhp_prospect_definer;
CREATE POLICY mhp_event_phone_consent_public ON app.communication_consent_events FOR INSERT TO r72_mhp_prospect_definer
 WITH CHECK(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND session_user='r72_identity_command'
  AND channel='sms' AND purpose~'^mhp\.webinar\.[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND state='withdrawn'
  AND source='mhp.event-phone.withdraw' AND actor_kind='system' AND actor_user_id IS NULL);
CREATE POLICY mhp_event_phone_consent_public_read ON app.communication_consent_events FOR SELECT TO r72_mhp_prospect_definer
 USING(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND session_user='r72_identity_command' AND channel='sms'
  AND purpose~'^mhp\.webinar\.');
CREATE POLICY mhp_event_phone_points_public_read ON app.contact_points FOR SELECT TO r72_mhp_prospect_definer
 USING(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND session_user='r72_identity_command' AND kind='phone');
-- Owner activation and control receipts.
CREATE POLICY mhp_event_phone_command_receipts ON app.command_receipts TO r72_sms_definer
 USING(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND command_name IN('mhp.event-phone.activate','mhp.event-phone.control')
  AND actor_user_id=nullif(current_setting('app.user_id',true),'')::uuid)
 WITH CHECK(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND command_name IN('mhp.event-phone.activate','mhp.event-phone.control')
  AND actor_user_id=nullif(current_setting('app.user_id',true),'')::uuid AND current_setting('app.actor_kind',true)='user' AND session_user='r72_sms_command');
-- Owner pre-materialisation reads the exact current event consent fact it binds.
CREATE POLICY mhp_event_phone_owner_contacts_read ON app.contacts FOR SELECT TO r72_sms_definer
 USING(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND session_user='r72_sms_worker_command'
  AND current_setting('app.actor_kind',true)='worker');
-- Programme content is readable to the prospect definer that validates it.
CREATE POLICY mhp_event_programme_items_read ON app.company_content_items FOR SELECT TO r72_mhp_prospect_definer
 USING(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND source_system='mhp.event-phone');
CREATE POLICY mhp_event_programme_versions_read ON app.company_content_versions FOR SELECT TO r72_mhp_prospect_definer
 USING(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND source_system='mhp.event-phone');
DO $policies$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['company_content_source_attestations','company_content_approval_requests','company_content_approval_decisions'] LOOP
  EXECUTE format('CREATE POLICY mhp_event_programme_local_read ON app.%I FOR SELECT TO r72_mhp_prospect_definer USING (
   workspace_id=''2789228d-55a6-4688-b1e8-2f70abca990b'' AND EXISTS(SELECT 1 FROM app.company_content_versions v
    WHERE v.workspace_id=%I.workspace_id AND v.id=%I.content_version_id AND v.source_system=''mhp.event-phone''))',t,t,t);
 END LOOP;
END $policies$;
GRANT EXECUTE ON FUNCTION app_private.current_request_id(),app_private.current_user_id() TO r72_sms_definer;
GRANT CREATE ON SCHEMA app_private TO r72_sms_definer,r72_mhp_prospect_definer;

-- 6. Signed opt-out evidence from a number that has no contact point yet
-- (Astra review, 1 November 2026, item 1). Keyed by channel and phone digest
-- only: no contact, no point, no message body, nothing to erase. A later JOIN,
-- the owner review and every scheduled send honour the latest event through
-- the grant tuple. SMS and WhatsApp rows never cross: each channel's definer
-- can only see and write its own channel.
CREATE TABLE app_private.mhp_unlinked_opt_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL CHECK(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b'),
 channel text NOT NULL CHECK(channel IN('sms','whatsapp')),
 provider_connection_id uuid,
 whatsapp_binding_id uuid,
 provider_event_id text NOT NULL CHECK(length(provider_event_id) BETWEEN 1 AND 500),
 provider_message_id text NOT NULL CHECK(length(provider_message_id) BETWEEN 1 AND 500),
 phone_identity_sha256 bytea NOT NULL CHECK(octet_length(phone_identity_sha256)=32),
 opt_evidence text NOT NULL CHECK(opt_evidence IN('stop','start')),
 body_sha256 bytea NOT NULL CHECK(octet_length(body_sha256)=32),
 payload_sha256 bytea NOT NULL CHECK(octet_length(payload_sha256)=32),
 signature_sha256 bytea NOT NULL CHECK(octet_length(signature_sha256)=32),
 event_identity_sha256 bytea NOT NULL CHECK(octet_length(event_identity_sha256)=32),
 recorded_by_role text NOT NULL CHECK(recorded_by_role IN('r72_sms_webhook_command','r72_whatsapp_live_webhook_command')),
 occurred_at timestamptz NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 UNIQUE(workspace_id,channel,provider_event_id),
 CONSTRAINT mhp_unlinked_opt_channel CHECK(
  (channel='sms' AND provider_connection_id IS NOT NULL AND whatsapp_binding_id IS NULL AND recorded_by_role='r72_sms_webhook_command'
   AND provider_event_id~'^inbound:(SM|MM)[0-9a-f]{32}$' AND provider_message_id~'^(SM|MM)[0-9a-f]{32}$')
  OR (channel='whatsapp' AND whatsapp_binding_id IS NOT NULL AND provider_connection_id IS NULL AND recorded_by_role='r72_whatsapp_live_webhook_command'
   AND provider_message_id~'^wamid[.][A-Za-z0-9_=-]{1,190}$' AND opt_evidence='stop'))
);
CREATE INDEX mhp_unlinked_opt_latest ON app_private.mhp_unlinked_opt_events(channel,phone_identity_sha256,occurred_at DESC,recorded_at DESC,id DESC);
CREATE TRIGGER mhp_unlinked_opt_immutable BEFORE UPDATE OR DELETE ON app_private.mhp_unlinked_opt_events
 FOR EACH ROW EXECUTE FUNCTION app_private.mhp_event_phone_receipt_guard();
-- The latest signed unlinked event for one channel and one number: 'stop', 'start' or NULL.
CREATE FUNCTION app_private.mhp_unlinked_opt_latest(p_channel text,p_phone_sha bytea) RETURNS text
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $f$
 SELECT e.opt_evidence FROM app_private.mhp_unlinked_opt_events e WHERE e.channel=p_channel AND e.phone_identity_sha256=p_phone_sha
 ORDER BY e.occurred_at DESC,e.recorded_at DESC,e.id DESC LIMIT 1
$f$;
REVOKE ALL ON FUNCTION app_private.mhp_unlinked_opt_latest(text,bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.mhp_unlinked_opt_latest(text,bytea) TO r72_sms_definer;
ALTER TABLE app_private.mhp_unlinked_opt_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.mhp_unlinked_opt_events FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.mhp_unlinked_opt_events FROM PUBLIC;
CREATE POLICY mhp_unlinked_opt_owner ON app_private.mhp_unlinked_opt_events TO r72_owner USING(true) WITH CHECK(true);
GRANT SELECT,INSERT ON app_private.mhp_unlinked_opt_events TO r72_sms_definer;
CREATE POLICY mhp_unlinked_opt_sms_read ON app_private.mhp_unlinked_opt_events FOR SELECT TO r72_sms_definer
 USING(channel='sms' AND session_user IN('r72_sms_webhook_command','r72_sms_command','r72_sms_worker_command')
  AND current_setting('app.workspace_id',true)='2789228d-55a6-4688-b1e8-2f70abca990b');
CREATE POLICY mhp_unlinked_opt_sms_signed ON app_private.mhp_unlinked_opt_events FOR INSERT TO r72_sms_definer
 WITH CHECK(channel='sms' AND session_user='r72_sms_webhook_command' AND current_setting('app.actor_kind',true)='webhook'
  AND recorded_by_role='r72_sms_webhook_command');

-- 6. Closed programme/source/identity helpers (prospect definer, no login EXECUTE).
SET LOCAL ROLE r72_mhp_prospect_definer;
CREATE FUNCTION app_private.mhp_event_phone_consent_text(p_revision text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $f$
 SELECT CASE p_revision WHEN 'mhp.event-phone-sms/v1' THEN
  'Text me a reminder about this Martin Howard Property webinar at this mobile number. These texts are only about this webinar, not other marketing. Reply STOP to opt out.'
 END
$f$;

CREATE FUNCTION app_private.mhp_event_phone_time(p jsonb,p_key text) RETURNS timestamptz
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $f$
DECLARE t timestamptz;
BEGIN
 IF jsonb_typeof(p->p_key) IS DISTINCT FROM 'string' OR p->>p_key!~'^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:00Z$'
 THEN RAISE EXCEPTION 'Invalid event programme time' USING ERRCODE='23514'; END IF;
 t:=(p->>p_key)::timestamptz;
 IF to_char(t AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')<>p->>p_key THEN RAISE EXCEPTION 'Invalid event programme time' USING ERRCODE='23514'; END IF;
 RETURN t;
END $f$;

-- Exact owner programme: canonical bytes, brand, latest, genuine owner approval,
-- and the exact approved placeholder-free local SMS source it names.
CREATE FUNCTION app_private.mhp_event_phone_programme_exact(p_version uuid,p_latest boolean) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE v app.company_content_versions%ROWTYPE; d jsonb; local jsonb; manifest jsonb; brand jsonb; keys text[]; event text;
 starts timestamptz; due timestamptz; admission timestamptz; deadline timestamptz; source jsonb; approval uuid; body text;
BEGIN
 SELECT * INTO v FROM app.company_content_versions WHERE workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND id=p_version
  AND source_system='mhp.event-phone';
 IF NOT FOUND OR v.content_kind<>'other' OR v.content_mime_type<>'application/vnd.growthhq.event-phone+json'
  OR v.source_item_id!~'^event-phone:webinar-[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR v.source_version!~'^edit:[0-9a-f-]{36}$'
 THEN RAISE EXCEPTION 'Event programme unavailable' USING ERRCODE='23514'; END IF;
 event:=substr(v.source_item_id,13);
 d:=v.content_body::jsonb; local:=v.metadata->'mhpEventPhone'; brand:=app_private.mhp_owner_email_brand();
 SELECT array_agg(k ORDER BY k) INTO keys FROM jsonb_object_keys(d) k;
 IF keys IS DISTINCT FROM ARRAY['admissionUntil','channel','consentRevision','consentTextSha256','dueAt','event','providerDeadline',
   'schema','senderBindingId','sourceContentItemId','sourceContentSha256','sourceContentVersionId','startsAt','stepKey']
  OR d->>'schema' IS DISTINCT FROM 'mhp.event-phone/v1' OR d->>'event' IS DISTINCT FROM event OR d->>'channel' IS DISTINCT FROM 'sms'
  OR jsonb_typeof(d->'stepKey') IS DISTINCT FROM 'string' OR d->>'stepKey'!~'^event_sms_[a-z0-9]{1,20}$'
  OR d->>'consentRevision' IS DISTINCT FROM 'mhp.event-phone-sms/v1'
  OR d->>'consentTextSha256' IS DISTINCT FROM encode(public.digest(app_private.mhp_event_phone_consent_text('mhp.event-phone-sms/v1'),'sha256'),'hex')
  OR jsonb_typeof(d->'senderBindingId') IS DISTINCT FROM 'string' OR d->>'senderBindingId'!~'^[0-9a-f-]{36}$'
  OR jsonb_typeof(d->'sourceContentItemId') IS DISTINCT FROM 'string' OR d->>'sourceContentItemId'!~'^[0-9a-f-]{36}$'
  OR jsonb_typeof(d->'sourceContentVersionId') IS DISTINCT FROM 'string' OR d->>'sourceContentVersionId'!~'^[0-9a-f-]{36}$'
  OR jsonb_typeof(d->'sourceContentSha256') IS DISTINCT FROM 'string' OR d->>'sourceContentSha256'!~'^[0-9a-f]{64}$'
  OR app_private.mhp_sequence_canonical(d) IS DISTINCT FROM v.content_body OR public.digest(v.content_body,'sha256') IS DISTINCT FROM v.content_sha256
  OR v.blob_sha256 IS DISTINCT FROM v.content_sha256 OR v.blob_storage_key IS DISTINCT FROM 'inline:mhp.event-phone:'||encode(v.content_sha256,'hex')
  OR local->>'schema' IS DISTINCT FROM 'mhp.event-phone-local/v1' OR local->>'authoredBy' IS DISTINCT FROM 'native-owner'
  OR local->>'brandCanonical' IS DISTINCT FROM brand->>'canonical' OR v.brand_snapshot_ref IS DISTINCT FROM brand->>'ref'
  OR encode(v.brand_sha256,'hex') IS DISTINCT FROM brand->>'sha256'
 THEN RAISE EXCEPTION 'Event programme bytes or brand changed' USING ERRCODE='23514'; END IF;
 manifest:=(local->>'manifestCanonical')::jsonb;
 IF app_private.mhp_sequence_canonical(manifest) IS DISTINCT FROM local->>'manifestCanonical'
  OR manifest IS DISTINCT FROM jsonb_build_object('schema','mhp.event-phone-source/v1','workspaceId',v.workspace_id::text,
   'sourceSystem',v.source_system,'sourceItemId',v.source_item_id,'sourceVersion',v.source_version,'contentSha256',encode(v.content_sha256,'hex'),
   'blobStorageKey',v.blob_storage_key,'blobSha256',encode(v.blob_sha256,'hex'),'brandSnapshotRef',v.brand_snapshot_ref,'brandSha256',encode(v.brand_sha256,'hex'))
  OR local->>'manifestSha256' IS DISTINCT FROM encode(public.digest(local->>'manifestCanonical','sha256'),'hex')
 THEN RAISE EXCEPTION 'Event programme manifest mismatch' USING ERRCODE='23514'; END IF;
 starts:=app_private.mhp_event_phone_time(d,'startsAt'); due:=app_private.mhp_event_phone_time(d,'dueAt');
 admission:=app_private.mhp_event_phone_time(d,'admissionUntil'); deadline:=app_private.mhp_event_phone_time(d,'providerDeadline');
 IF to_char(starts AT TIME ZONE 'UTC','YYYY-MM-DD')<>substr(event,9) OR NOT(due<deadline AND deadline<=starts AND admission<=starts
  AND admission>due-interval '30 days' AND deadline-due<=interval '10 hours' AND starts-due<=interval '7 days')
 THEN RAISE EXCEPTION 'Event programme window is invalid' USING ERRCODE='23514'; END IF;
 IF p_latest AND EXISTS(SELECT 1 FROM app.company_content_versions n WHERE n.workspace_id=v.workspace_id AND n.content_item_id=v.content_item_id
  AND n.version_number>v.version_number) THEN RAISE EXCEPTION 'A newer event programme draft exists' USING ERRCODE='23514'; END IF;
 IF NOT app_private.mhp_marketing_workspace_allowed(v.created_by_user_id,v.workspace_id)
 THEN RAISE EXCEPTION 'Event programme author permission changed' USING ERRCODE='42501'; END IF;
 SELECT dd.id INTO approval FROM app.company_content_approval_decisions dd
 JOIN app.company_content_approval_requests r ON r.workspace_id=dd.workspace_id AND r.id=dd.approval_request_id
 WHERE dd.workspace_id=v.workspace_id AND dd.content_version_id=v.id AND dd.content_sha256=v.content_sha256 AND dd.decision='approved'
  AND app_private.mhp_marketing_workspace_allowed(dd.decided_by_user_id,dd.workspace_id)
  AND r.request_number=(SELECT max(n.request_number) FROM app.company_content_approval_requests n WHERE n.workspace_id=v.workspace_id AND n.content_version_id=v.id)
 ORDER BY dd.decided_at DESC,dd.id DESC LIMIT 1;
 source:=app_private.mhp_owner_channel_exact((d->>'sourceContentVersionId')::uuid,p_latest);
 body:=source->'payload'->>'bodyText';
 IF source->>'channel' IS DISTINCT FROM 'sms' OR source->>'contentItemId' IS DISTINCT FROM d->>'sourceContentItemId'
  OR source->>'contentSha256' IS DISTINCT FROM d->>'sourceContentSha256'
  OR body!~'^[\r\n\x20-\x5a\x5f\x61-\x7a]+$' OR position('{{' IN body)>0 OR position('}}' IN body)>0
 THEN RAISE EXCEPTION 'Event programme SMS source changed' USING ERRCODE='23514'; END IF;
 RETURN jsonb_build_object('programmeItemId',v.content_item_id,'programmeVersionId',v.id,'programmeSha256',encode(v.content_sha256,'hex'),
  'approvalId',approval,'event',event,'purpose','mhp.webinar.'||substr(event,9),'stepKey',d->>'stepKey',
  'startsAt',d->>'startsAt','dueAt',d->>'dueAt','admissionUntil',d->>'admissionUntil','providerDeadline',d->>'providerDeadline',
  'consentRevision',d->>'consentRevision','consentTextSha256',d->>'consentTextSha256','senderBindingId',d->>'senderBindingId',
  'sourceContentItemId',d->>'sourceContentItemId','sourceContentVersionId',d->>'sourceContentVersionId','sourceContentSha256',d->>'sourceContentSha256',
  'bodyText',body,'bodySha256',encode(public.digest(body,'sha256'),'hex'),
  'segments',CASE WHEN char_length(body)<=160 THEN 1 ELSE ceil(char_length(body)/153.0)::integer END);
END $f$;

-- The one public programme now admitting entrants: latest approved version of
-- each event item, soonest event first. No approval means no public offer.
CREATE FUNCTION app_private.mhp_event_phone_current_programme() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE candidate uuid; exact jsonb;
BEGIN
 FOR candidate IN SELECT v.id FROM app.company_content_versions v WHERE v.workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b'
  AND v.source_system='mhp.event-phone' AND NOT EXISTS(SELECT 1 FROM app.company_content_versions n WHERE n.workspace_id=v.workspace_id
   AND n.content_item_id=v.content_item_id AND n.version_number>v.version_number)
  ORDER BY v.source_item_id,v.id LOOP
  BEGIN exact:=app_private.mhp_event_phone_programme_exact(candidate,true);
  EXCEPTION WHEN sqlstate '23514' OR sqlstate '42501' OR sqlstate '22P02' THEN exact:=NULL; END;
  IF exact IS NOT NULL AND exact->>'approvalId' IS NOT NULL AND (exact->>'admissionUntil')::timestamptz>statement_timestamp() THEN RETURN exact; END IF;
 END LOOP;
 RETURN NULL;
END $f$;

-- Actual event registration: v2 capture anchor first, else the exact 0125
-- chronological anchor. Never a label/email guess, never a new signup.
CREATE FUNCTION app_private.mhp_event_phone_signup(p_prospect uuid,p_campaign text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT coalesce(
  (SELECT s.id FROM app_private.mhp_prospect_signups s WHERE s.prospect_id=p_prospect AND s.kind='webinar' AND s.entry_campaign=p_campaign
   ORDER BY s.created_at DESC,s.id DESC LIMIT 1),
  (SELECT s.id FROM app_private.mhp_prospect_signups s WHERE s.prospect_id=p_prospect AND s.kind='webinar' AND s.created_at<=(
    SELECT min(m.created_at) FROM app_private.mhp_marketing_sends m WHERE m.prospect_id=p_prospect AND m.campaign_key=p_campaign
     AND m.delivery_channel='email' AND m.owner_content_version_id IS NULL
     AND m.template_key IN('webinar_confirm','webinar_24h','webinar_1h','webinar_replay','webinar_followup'))
   ORDER BY s.created_at DESC,s.id DESC LIMIT 1))
$f$;

-- Worker-local source observation: the due worker never writes a fictitious
-- owner attestation. It re-derives the local bytes/brand/latest/approval and
-- refuses any newer negative or mismatching owner observation.
CREATE FUNCTION app_private.mhp_event_sms_source_check(p_programme uuid,p_programme_sha bytea,p_source uuid,p_source_sha bytea) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE exact jsonb; v app.company_content_versions%ROWTYPE; observation app.company_content_source_attestations%ROWTYPE; approval uuid; checked timestamptz;
BEGIN
 exact:=app_private.mhp_event_phone_programme_exact(p_programme,true);
 SELECT * INTO v FROM app.company_content_versions WHERE workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND id=p_source;
 IF exact->>'approvalId' IS NULL OR exact->>'programmeSha256' IS DISTINCT FROM encode(p_programme_sha,'hex')
  OR exact->>'sourceContentVersionId' IS DISTINCT FROM p_source::text OR v.content_sha256 IS DISTINCT FROM p_source_sha
 THEN RAISE EXCEPTION 'Event SMS source changed' USING ERRCODE='23514'; END IF;
 SELECT * INTO observation FROM app.company_content_source_attestations a WHERE a.workspace_id=v.workspace_id
  AND a.content_item_id=v.content_item_id AND a.content_version_id=v.id ORDER BY a.checked_at DESC,a.id DESC LIMIT 1;
 IF observation.id IS NULL OR observation.source_catalog_sha256 IS DISTINCT FROM decode(v.metadata->'mhpChannelDraft'->>'manifestSha256','hex')
  OR observation.content_sha256 IS DISTINCT FROM v.content_sha256 OR observation.blob_sha256 IS DISTINCT FROM v.blob_sha256
  OR observation.brand_sha256 IS DISTINCT FROM v.brand_sha256 OR observation.checked_at>statement_timestamp()
 THEN RAISE EXCEPTION 'Event SMS source observation mismatch' USING ERRCODE='23514'; END IF;
 SELECT d.id INTO approval FROM app.company_content_approval_decisions d
 JOIN app.company_content_approval_requests r ON r.workspace_id=d.workspace_id AND r.id=d.approval_request_id
 WHERE d.workspace_id=v.workspace_id AND d.content_version_id=v.id AND d.content_sha256=v.content_sha256 AND d.decision='approved'
  AND app_private.mhp_marketing_workspace_allowed(d.decided_by_user_id,d.workspace_id)
  AND r.request_number=(SELECT max(n.request_number) FROM app.company_content_approval_requests n WHERE n.workspace_id=v.workspace_id AND n.content_version_id=v.id)
 ORDER BY d.decided_at DESC,d.id DESC LIMIT 1;
 IF approval IS NULL THEN RAISE EXCEPTION 'Event SMS source approval changed' USING ERRCODE='23514'; END IF;
 checked:=date_trunc('milliseconds',statement_timestamp());
 RETURN jsonb_build_object('checkedAt',to_char(checked AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'sourceCheckSha256',encode(public.digest(jsonb_build_object('schema','mhp.event-sms-source-check/v1','programme',exact,
   'sourceApprovalId',approval,'observationId',observation.id,'brandSha256',encode(v.brand_sha256,'hex'),'checkedBy','r72_sms_worker_command',
   'checkedAt',to_char(checked AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))::text,'sha256'),'hex'),
  'programmeApprovalId',exact->>'approvalId','sourceApprovalId',approval);
END $f$;
REVOKE ALL ON FUNCTION app_private.mhp_event_phone_consent_text(text),app_private.mhp_event_phone_time(jsonb,text),
 app_private.mhp_event_phone_programme_exact(uuid,boolean),app_private.mhp_event_phone_current_programme(),
 app_private.mhp_event_phone_signup(uuid,text),app_private.mhp_event_sms_source_check(uuid,bytea,uuid,bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.mhp_event_phone_consent_text(text),app_private.mhp_event_phone_programme_exact(uuid,boolean),
 app_private.mhp_event_phone_current_programme(),app_private.mhp_event_phone_signup(uuid,text),
 app_private.mhp_event_sms_source_check(uuid,bytea,uuid,bytea) TO r72_sms_definer;

-- 7. Current event grant: latest append for the registrant's event wins; the
-- grant must also be the current verified intent revision. Invoker rights so
-- each closed definer reads it under its own exact policies.
CREATE FUNCTION app_private.mhp_event_phone_current_receipt(p_prospect uuid,p_campaign text) RETURNS uuid
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $f$
 SELECT r.id FROM (SELECT x.* FROM app_private.mhp_event_phone_receipts x WHERE x.prospect_id=p_prospect AND x.campaign=p_campaign
   ORDER BY x.occurred_at DESC,x.recorded_at DESC,x.id DESC LIMIT 1) r
 JOIN app_private.mhp_event_phone_intents i ON i.id=r.intent_id AND i.revision=r.intent_revision AND i.state='verified'
  AND i.result_receipt_id=r.id AND i.point_id=r.contact_point_id
 WHERE r.decision='granted' AND i.revision=(SELECT max(n.revision) FROM app_private.mhp_event_phone_intents n
   WHERE n.prospect_id=p_prospect AND n.campaign=p_campaign AND n.kind='sms')
$f$;
REVOKE ALL ON FUNCTION app_private.mhp_event_phone_current_receipt(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.mhp_event_phone_current_receipt(uuid,text) TO r72_sms_definer;

CREATE FUNCTION app_private.mhp_event_phone_lock(p_keys text[]) RETURNS void
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $f$
 SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(k,7200131)) FROM (SELECT DISTINCT unnest(p_keys) k ORDER BY 1) s
$f$;
REVOKE ALL ON FUNCTION app_private.mhp_event_phone_lock(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.mhp_event_phone_lock(text[]) TO r72_sms_definer;

CREATE FUNCTION app_private.mhp_event_phone_mask(p_phone text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $f$
 SELECT CASE WHEN p_phone IS NULL THEN NULL ELSE '07••• •••'||right(p_phone,3) END
$f$;
REVOKE ALL ON FUNCTION app_private.mhp_event_phone_mask(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.mhp_event_phone_mask(text) TO r72_sms_definer;

-- 8. Public functions: r72_identity_command only, no session, no account.
CREATE FUNCTION app_private.mhp_event_phone_request_link(p_email text,p_command uuid,p_token_sha bytea,p_payload_sha bytea,p_source_sha bytea) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE programme jsonb; key_sha bytea; email_sha bytea; existing app_private.mhp_event_phone_intents%ROWTYPE;
 prospect app_private.mhp_prospects%ROWTYPE; signup uuid; created uuid; expiry timestamptz;
BEGIN
 IF session_user<>'r72_identity_command' OR p_email IS NULL OR p_email<>lower(btrim(p_email)) OR length(p_email) NOT BETWEEN 3 AND 320
  OR p_email!~'^[^[:space:]@<>]+@[^[:space:]@<>]+\.[^[:space:]@<>]+$' OR p_command IS NULL
  OR octet_length(p_token_sha) IS DISTINCT FROM 32 OR octet_length(p_payload_sha) IS DISTINCT FROM 32 OR octet_length(p_source_sha) IS DISTINCT FROM 32
 THEN RAISE EXCEPTION 'Invalid event reminder request' USING ERRCODE='22023'; END IF;
 key_sha:=public.digest('mhp.event-phone.request:'||p_command::text,'sha256');
 email_sha:=public.digest('mhp.event-phone.email:'||p_email,'sha256');
 PERFORM app_private.mhp_event_phone_lock(ARRAY['mhp.event-phone.email:'||encode(email_sha,'hex')]);
 SELECT * INTO existing FROM app_private.mhp_event_phone_intents i WHERE i.workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND i.request_key_sha256=key_sha;
 IF FOUND THEN
  IF existing.payload_sha256 IS DISTINCT FROM p_payload_sha THEN RAISE EXCEPTION 'Event reminder request conflicts' USING ERRCODE='40001'; END IF;
  RETURN jsonb_build_object('send',false,'replayed',true);
 END IF;
 programme:=app_private.mhp_event_phone_current_programme();
 IF programme IS NULL THEN RETURN jsonb_build_object('send',false,'available',false); END IF;
 IF EXISTS(SELECT 1 FROM app_private.mhp_event_phone_intents i WHERE i.email_identity_sha256=email_sha AND i.created_at>statement_timestamp()-interval '60 seconds')
  OR (SELECT count(*) FROM app_private.mhp_event_phone_intents i WHERE i.email_identity_sha256=email_sha AND i.campaign=programme->>'event'
   AND i.kind='access' AND i.created_at>statement_timestamp()-interval '1 hour')>=3
  OR (SELECT count(*) FROM app_private.mhp_event_phone_intents i WHERE i.source_sha256=p_source_sha AND i.kind='access'
   AND i.created_at>statement_timestamp()-interval '1 hour')>=3
 THEN RETURN jsonb_build_object('send',false); END IF;  -- uniform: never reveals registration
 SELECT * INTO prospect FROM app_private.mhp_prospects p WHERE p.email::text=p_email;
 IF NOT FOUND THEN RETURN jsonb_build_object('send',false); END IF;
 signup:=app_private.mhp_event_phone_signup(prospect.id,programme->>'event');
 IF signup IS NULL THEN RETURN jsonb_build_object('send',false); END IF;
 PERFORM app_private.mhp_event_phone_lock(ARRAY['mhp.event-phone.prospect:'||(programme->>'event')||':'||prospect.id::text]);
 UPDATE app_private.mhp_event_phone_intents SET state='superseded',updated_at=statement_timestamp()
 WHERE prospect_id=prospect.id AND campaign=programme->>'event' AND kind='access' AND state IN('issued','open');
 expiry:=statement_timestamp()+interval '15 minutes';
 INSERT INTO app_private.mhp_event_phone_intents(workspace_id,prospect_id,signup_id,campaign,programme_version_id,kind,revision,state,
  command_id,request_key_sha256,payload_sha256,source_sha256,email_identity_sha256,access_token_sha256,access_expires_at)
 VALUES('2789228d-55a6-4688-b1e8-2f70abca990b',prospect.id,signup,programme->>'event',(programme->>'programmeVersionId')::uuid,'access',1,'issued',
  p_command,key_sha,p_payload_sha,p_source_sha,email_sha,p_token_sha,expiry) RETURNING id INTO created;
 RETURN jsonb_build_object('send',true,'intentId',created,'email',prospect.email::text,'firstName',prospect.first_name,
  'campaign',programme->>'event','startsAt',programme->>'startsAt',
  'expiresAt',to_char(expiry AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'));
END $f$;

CREATE FUNCTION app_private.mhp_event_phone_open(p_token_sha bytea,p_capability_sha bytea,p_command uuid,p_payload_sha bytea,p_source_sha bytea) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE access app_private.mhp_event_phone_intents%ROWTYPE; capability_expiry timestamptz;
BEGIN
 IF session_user<>'r72_identity_command' OR octet_length(p_token_sha) IS DISTINCT FROM 32 OR octet_length(p_capability_sha) IS DISTINCT FROM 32
  OR p_command IS NULL OR octet_length(p_payload_sha) IS DISTINCT FROM 32 OR octet_length(p_source_sha) IS DISTINCT FROM 32
 THEN RAISE EXCEPTION 'Invalid event reminder link' USING ERRCODE='22023'; END IF;
 SELECT * INTO access FROM app_private.mhp_event_phone_intents i WHERE i.access_token_sha256=p_token_sha AND i.kind='access' FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','invalid'); END IF;
 IF access.state='open' AND access.capability_sha256=p_capability_sha AND access.capability_expires_at>statement_timestamp() THEN
  RETURN jsonb_build_object('ok',true,'replayed',true,'campaign',access.campaign,
   'capabilityExpiresAt',to_char(access.capability_expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'));
 END IF;
 IF access.state<>'issued' THEN RETURN jsonb_build_object('ok',false,'reason','used'); END IF;
 IF access.access_expires_at<=statement_timestamp() THEN
  UPDATE app_private.mhp_event_phone_intents SET state='expired',updated_at=statement_timestamp() WHERE id=access.id;
  RETURN jsonb_build_object('ok',false,'reason','expired');
 END IF;
 capability_expiry:=statement_timestamp()+interval '15 minutes';
 UPDATE app_private.mhp_event_phone_intents SET state='open',access_consumed_at=statement_timestamp(),capability_sha256=p_capability_sha,
  capability_expires_at=capability_expiry,updated_at=statement_timestamp() WHERE id=access.id;
 RETURN jsonb_build_object('ok',true,'replayed',false,'campaign',access.campaign,
  'capabilityExpiresAt',to_char(capability_expiry AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'));
END $f$;

CREATE FUNCTION app_private.mhp_event_phone_access(p_capability_sha bytea,p_lock boolean) RETURNS app_private.mhp_event_phone_intents
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $f$
DECLARE access app_private.mhp_event_phone_intents%ROWTYPE;
BEGIN
 IF p_lock THEN
  SELECT * INTO access FROM app_private.mhp_event_phone_intents i WHERE i.capability_sha256=p_capability_sha AND i.kind='access'
   AND i.state='open' AND i.capability_expires_at>statement_timestamp() FOR UPDATE;
 ELSE
  SELECT * INTO access FROM app_private.mhp_event_phone_intents i WHERE i.capability_sha256=p_capability_sha AND i.kind='access'
   AND i.state='open' AND i.capability_expires_at>statement_timestamp();
 END IF;
 RETURN access;
END $f$;
REVOKE ALL ON FUNCTION app_private.mhp_event_phone_access(bytea,boolean) FROM PUBLIC;

CREATE FUNCTION app_private.mhp_event_phone_status(p_capability_sha bytea) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE access app_private.mhp_event_phone_intents%ROWTYPE; programme jsonb; latest app_private.mhp_event_phone_intents%ROWTYPE;
 current_receipt uuid; first_name text;
BEGIN
 IF session_user<>'r72_identity_command' OR octet_length(p_capability_sha) IS DISTINCT FROM 32
 THEN RAISE EXCEPTION 'Invalid event reminder session' USING ERRCODE='22023'; END IF;
 access:=app_private.mhp_event_phone_access(p_capability_sha,false);
 IF access.id IS NULL THEN RETURN jsonb_build_object('ok',false); END IF;
 programme:=app_private.mhp_event_phone_current_programme();
 SELECT p.first_name INTO first_name FROM app_private.mhp_prospects p WHERE p.id=access.prospect_id;
 SELECT * INTO latest FROM app_private.mhp_event_phone_intents i WHERE i.prospect_id=access.prospect_id AND i.campaign=access.campaign AND i.kind='sms'
 ORDER BY i.revision DESC LIMIT 1;
 current_receipt:=app_private.mhp_event_phone_current_receipt(access.prospect_id,access.campaign);
 RETURN jsonb_build_object('ok',true,'campaign',access.campaign,'firstName',first_name,
  'open',programme IS NOT NULL AND programme->>'event'=access.campaign AND (programme->>'dueAt')::timestamptz>statement_timestamp()+interval '1 minute',
  'startsAt',CASE WHEN programme->>'event'=access.campaign THEN programme->>'startsAt' END,
  'consentRevision',programme->>'consentRevision','consentText',app_private.mhp_event_phone_consent_text(programme->>'consentRevision'),
  'capabilityExpiresAt',to_char(access.capability_expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  'sms',CASE WHEN latest.id IS NULL THEN NULL ELSE jsonb_build_object('state',latest.state,'revision',latest.revision,
   'phoneMasked',app_private.mhp_event_phone_mask(latest.phone_e164),
   'joinExpiresAt',to_char(latest.join_expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
   'grantReceiptId',current_receipt) END);
END $f$;

CREATE FUNCTION app_private.mhp_event_phone_choose(p_capability_sha bytea,p_command uuid,p_phone text,p_consent_revision text,p_consent_text_sha bytea,
 p_join_nonce_sha bytea,p_payload_sha bytea,p_source_sha bytea) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE access app_private.mhp_event_phone_intents%ROWTYPE; programme jsonb; key_sha bytea; existing app_private.mhp_event_phone_intents%ROWTYPE;
 previous app_private.mhp_event_phone_intents%ROWTYPE; granted app_private.mhp_event_phone_receipts%ROWTYPE; phone_sha bytea; created uuid;
 join_expiry timestamptz; withdrawal_consent uuid:=gen_random_uuid(); now_at timestamptz:=statement_timestamp();
BEGIN
 IF session_user<>'r72_identity_command' OR octet_length(p_capability_sha) IS DISTINCT FROM 32 OR p_command IS NULL
  OR p_phone IS NULL OR p_phone!~'^\+447[0-9]{9}$' OR p_consent_revision IS NULL OR octet_length(p_consent_text_sha) IS DISTINCT FROM 32
  OR octet_length(p_join_nonce_sha) IS DISTINCT FROM 32 OR octet_length(p_payload_sha) IS DISTINCT FROM 32 OR octet_length(p_source_sha) IS DISTINCT FROM 32
 THEN RAISE EXCEPTION 'Invalid event reminder choice' USING ERRCODE='22023'; END IF;
 key_sha:=public.digest('mhp.event-phone.choose:'||p_command::text,'sha256');
 SELECT * INTO existing FROM app_private.mhp_event_phone_intents i WHERE i.workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND i.request_key_sha256=key_sha;
 IF FOUND THEN
  IF existing.payload_sha256 IS DISTINCT FROM p_payload_sha THEN RAISE EXCEPTION 'Event reminder choice conflicts' USING ERRCODE='40001'; END IF;
  RETURN jsonb_build_object('ok',true,'replayed',true,'intentId',existing.id,'revision',existing.revision,
   'joinExpiresAt',to_char(existing.join_expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'));
 END IF;
 access:=app_private.mhp_event_phone_access(p_capability_sha,true);
 IF access.id IS NULL THEN RETURN jsonb_build_object('ok',false,'reason','session'); END IF;
 programme:=app_private.mhp_event_phone_current_programme();
 IF programme IS NULL OR programme->>'event' IS DISTINCT FROM access.campaign OR (programme->>'dueAt')::timestamptz<=now_at+interval '1 minute'
 THEN RETURN jsonb_build_object('ok',false,'reason','closed'); END IF;
 IF p_consent_revision IS DISTINCT FROM programme->>'consentRevision' OR encode(p_consent_text_sha,'hex') IS DISTINCT FROM programme->>'consentTextSha256'
 THEN RAISE EXCEPTION 'Event reminder wording changed' USING ERRCODE='40001'; END IF;
 phone_sha:=public.digest(p_phone,'sha256');
 PERFORM app_private.mhp_event_phone_lock(ARRAY['mhp.event-phone.prospect:'||access.campaign||':'||access.prospect_id::text,'mhp.event-phone.phone:'||p_phone]);
 SELECT * INTO existing FROM app_private.mhp_event_phone_intents i WHERE i.workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND i.request_key_sha256=key_sha;
 IF FOUND THEN RAISE EXCEPTION 'Event reminder choice raced' USING ERRCODE='40001'; END IF;
 IF (SELECT count(*) FROM app_private.mhp_event_phone_intents i WHERE i.phone_identity_sha256=phone_sha AND i.created_at>now_at-interval '1 hour')>=3
  OR EXISTS(SELECT 1 FROM app_private.mhp_event_phone_intents i WHERE i.prospect_id=access.prospect_id AND i.campaign=access.campaign
   AND i.kind='sms' AND i.created_at>now_at-interval '60 seconds')
 THEN RAISE EXCEPTION 'Event reminder choice limit' USING ERRCODE='54000'; END IF;
 UPDATE app_private.mhp_event_phone_intents SET state='expired',updated_at=now_at
 WHERE kind='sms' AND state='awaiting_join' AND join_expires_at<=now_at AND phone_e164=p_phone AND campaign=access.campaign;
 IF EXISTS(SELECT 1 FROM app_private.mhp_event_phone_intents i WHERE i.campaign=access.campaign AND i.kind='sms' AND i.phone_e164=p_phone
  AND i.prospect_id<>access.prospect_id AND i.state IN('awaiting_join','verified','held'))
 THEN RETURN jsonb_build_object('ok',false,'reason','number_unavailable'); END IF;
 SELECT * INTO previous FROM app_private.mhp_event_phone_intents i WHERE i.prospect_id=access.prospect_id AND i.campaign=access.campaign AND i.kind='sms'
 ORDER BY i.revision DESC LIMIT 1 FOR UPDATE;
 IF previous.state='verified' AND previous.phone_e164=p_phone THEN
  RETURN jsonb_build_object('ok',true,'replayed',false,'alreadyVerified',true,'intentId',previous.id,'revision',previous.revision);
 END IF;
 IF previous.state='awaiting_join' THEN
  UPDATE app_private.mhp_event_phone_intents SET state='superseded',updated_at=now_at WHERE id=previous.id;
 ELSIF previous.state='verified' THEN
  -- A new number explicitly withdraws the old event grant; approved work stays pinned and holds.
  SELECT * INTO granted FROM app_private.mhp_event_phone_receipts r WHERE r.id=previous.result_receipt_id;
  INSERT INTO app.communication_consent_events(id,workspace_id,contact_id,contact_point_id,channel,purpose,state,lawful_basis,source,policy_version,
   policy_text_sha256,source_event_id,actor_kind,actor_user_id,evidence,endpoint_identity_sha256,occurred_at)
  VALUES(withdrawal_consent,granted.workspace_id,granted.contact_id,granted.contact_point_id,'sms',granted.purpose,'withdrawn',NULL,'mhp.event-phone.withdraw',
   granted.consent_revision,granted.consent_text_sha256,'mhp.event-phone.number-change:'||p_command::text,'system',NULL,
   jsonb_build_object('reason','number_changed','receiptId',granted.id,'intentId',previous.id),granted.endpoint_identity_sha256,now_at);
  INSERT INTO app_private.mhp_event_phone_receipts(workspace_id,intent_id,intent_revision,campaign,prospect_id,signup_id,channel,purpose,contact_id,
   contact_point_id,endpoint_identity_sha256,phone_identity_sha256,decision,consent_revision,consent_text_sha256,consent_event_id,proof_kind,
   provider_connection_id,sender_binding_id,channel_endpoint_id,provider_account_sid_sha256,provider_service_sid_sha256,destination_e164,occurred_at,supersedes_receipt_id,request_sha256)
  VALUES(granted.workspace_id,granted.intent_id,granted.intent_revision,granted.campaign,granted.prospect_id,granted.signup_id,'sms',granted.purpose,
   granted.contact_id,granted.contact_point_id,granted.endpoint_identity_sha256,granted.phone_identity_sha256,'withdrawn',granted.consent_revision,
   granted.consent_text_sha256,withdrawal_consent,'public_event_withdrawal',granted.provider_connection_id,granted.sender_binding_id,
   granted.channel_endpoint_id,granted.provider_account_sid_sha256,granted.provider_service_sid_sha256,granted.destination_e164,now_at,granted.id,key_sha);
  UPDATE app_private.mhp_event_phone_intents SET state='superseded',updated_at=now_at WHERE id=previous.id;
  UPDATE app_private.mhp_marketing_sends SET event_held_at=now_at,event_hold_reason='receipt_changed'
  WHERE delivery_channel='sms' AND event_receipt_id=granted.id AND cancelled_at IS NULL AND event_held_at IS NULL;
 END IF;
 join_expiry:=least(now_at+interval '10 minutes',(programme->>'dueAt')::timestamptz);
 INSERT INTO app_private.mhp_event_phone_intents(workspace_id,prospect_id,signup_id,campaign,programme_version_id,kind,parent_access_id,revision,
  previous_intent_id,state,command_id,request_key_sha256,payload_sha256,source_sha256,email_identity_sha256,phone_e164,phone_identity_sha256,channel,
  consent_revision,consent_text_sha256,consent_chosen_at,join_nonce_sha256,join_expires_at)
 VALUES(access.workspace_id,access.prospect_id,access.signup_id,access.campaign,(programme->>'programmeVersionId')::uuid,'sms',access.id,
  coalesce(previous.revision,0)+1,previous.id,'awaiting_join',p_command,key_sha,p_payload_sha,p_source_sha,access.email_identity_sha256,
  p_phone,phone_sha,'sms',p_consent_revision,p_consent_text_sha,now_at,p_join_nonce_sha,join_expiry) RETURNING id INTO created;
 RETURN jsonb_build_object('ok',true,'replayed',false,'intentId',created,'revision',coalesce(previous.revision,0)+1,
  'joinExpiresAt',to_char(join_expiry AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'));
END $f$;

CREATE FUNCTION app_private.mhp_event_phone_withdraw(p_capability_sha bytea,p_command uuid,p_receipt uuid,p_payload_sha bytea) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE access app_private.mhp_event_phone_intents%ROWTYPE; granted app_private.mhp_event_phone_receipts%ROWTYPE; request_sha bytea;
 consent uuid:=gen_random_uuid(); now_at timestamptz:=statement_timestamp();
BEGIN
 IF session_user<>'r72_identity_command' OR octet_length(p_capability_sha) IS DISTINCT FROM 32 OR p_command IS NULL OR p_receipt IS NULL
  OR octet_length(p_payload_sha) IS DISTINCT FROM 32
 THEN RAISE EXCEPTION 'Invalid event reminder withdrawal' USING ERRCODE='22023'; END IF;
 request_sha:=public.digest('mhp.event-phone.withdraw:'||p_command::text||':'||encode(p_payload_sha,'hex'),'sha256');
 access:=app_private.mhp_event_phone_access(p_capability_sha,true);
 IF access.id IS NULL THEN RETURN jsonb_build_object('ok',false,'reason','session'); END IF;
 IF EXISTS(SELECT 1 FROM app_private.mhp_event_phone_receipts r WHERE r.supersedes_receipt_id=p_receipt AND r.request_sha256=request_sha
  AND r.prospect_id=access.prospect_id) THEN RETURN jsonb_build_object('ok',true,'replayed',true); END IF;
 PERFORM app_private.mhp_event_phone_lock(ARRAY['mhp.event-phone.prospect:'||access.campaign||':'||access.prospect_id::text]);
 IF app_private.mhp_event_phone_current_receipt(access.prospect_id,access.campaign) IS DISTINCT FROM p_receipt
 THEN RETURN jsonb_build_object('ok',false,'reason','not_current'); END IF;
 SELECT * INTO granted FROM app_private.mhp_event_phone_receipts r WHERE r.id=p_receipt;
 INSERT INTO app.communication_consent_events(id,workspace_id,contact_id,contact_point_id,channel,purpose,state,lawful_basis,source,policy_version,
  policy_text_sha256,source_event_id,actor_kind,actor_user_id,evidence,endpoint_identity_sha256,occurred_at)
 VALUES(consent,granted.workspace_id,granted.contact_id,granted.contact_point_id,'sms',granted.purpose,'withdrawn',NULL,'mhp.event-phone.withdraw',
  granted.consent_revision,granted.consent_text_sha256,'mhp.event-phone.withdraw:'||p_command::text,'system',NULL,
  jsonb_build_object('reason','registrant_withdrew','receiptId',granted.id),granted.endpoint_identity_sha256,now_at);
 INSERT INTO app_private.mhp_event_phone_receipts(workspace_id,intent_id,intent_revision,campaign,prospect_id,signup_id,channel,purpose,contact_id,
  contact_point_id,endpoint_identity_sha256,phone_identity_sha256,decision,consent_revision,consent_text_sha256,consent_event_id,proof_kind,
  provider_connection_id,sender_binding_id,channel_endpoint_id,provider_account_sid_sha256,provider_service_sid_sha256,destination_e164,occurred_at,supersedes_receipt_id,request_sha256)
 VALUES(granted.workspace_id,granted.intent_id,granted.intent_revision,granted.campaign,granted.prospect_id,granted.signup_id,'sms',granted.purpose,
  granted.contact_id,granted.contact_point_id,granted.endpoint_identity_sha256,granted.phone_identity_sha256,'withdrawn',granted.consent_revision,
  granted.consent_text_sha256,consent,'public_event_withdrawal',granted.provider_connection_id,granted.sender_binding_id,
  granted.channel_endpoint_id,granted.provider_account_sid_sha256,granted.provider_service_sid_sha256,granted.destination_e164,now_at,granted.id,request_sha);
 UPDATE app_private.mhp_event_phone_intents SET state='withdrawn',updated_at=now_at WHERE id=granted.intent_id AND state='verified';
 UPDATE app_private.mhp_marketing_sends SET event_held_at=now_at,event_hold_reason='receipt_changed'
 WHERE delivery_channel='sms' AND event_receipt_id=granted.id AND cancelled_at IS NULL AND event_held_at IS NULL;
 RETURN jsonb_build_object('ok',true,'replayed',false);
END $f$;
REVOKE ALL ON FUNCTION app_private.mhp_event_phone_request_link(text,uuid,bytea,bytea,bytea),
 app_private.mhp_event_phone_open(bytea,bytea,uuid,bytea,bytea),app_private.mhp_event_phone_status(bytea),
 app_private.mhp_event_phone_choose(bytea,uuid,text,text,bytea,bytea,bytea,bytea),
 app_private.mhp_event_phone_withdraw(bytea,uuid,uuid,bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.mhp_event_phone_request_link(text,uuid,bytea,bytea,bytea),
 app_private.mhp_event_phone_open(bytea,bytea,uuid,bytea,bytea),app_private.mhp_event_phone_status(bytea),
 app_private.mhp_event_phone_choose(bytea,uuid,text,text,bytea,bytea,bytea,bytea),
 app_private.mhp_event_phone_withdraw(bytea,uuid,uuid,bytea) TO r72_identity_command;
RESET ROLE;
SET LOCAL ROLE r72_owner;

-- 9. Signed inbound wrapper (r72_sms_webhook_command). The Twilio signature,
-- account, service and destination are verified by the existing verifier
-- BEFORE this call; the existing projection is reused in the same transaction.
GRANT CREATE ON SCHEMA app_private TO r72_sms_definer;
SET LOCAL ROLE r72_sms_definer;
CREATE FUNCTION app_private.mhp_event_sms_project(p_workspace uuid,p_connection uuid,p_external_event text,p_message_sid text,p_normalized_sender text,
 p_opt_evidence text,p_body text,p_sender_sha bytea,p_body_sha bytea,p_payload_sha bytea,p_signature_sha bytea,p_event_identity_sha bytea,p_occurred timestamptz,
 p_tolerate_unknown boolean) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $f$
DECLARE outcome text;
BEGIN
 BEGIN
  SELECT p.disposition INTO outcome FROM app_private.record_sms_live_inbound_projection(p_workspace,p_connection,p_external_event,p_message_sid,
   p_normalized_sender,p_opt_evidence,p_body,p_sender_sha,p_body_sha,p_payload_sha,p_signature_sha,p_event_identity_sha,p_occurred) p;
 EXCEPTION WHEN sqlstate '23503' THEN
  IF NOT p_tolerate_unknown THEN RAISE; END IF;
  outcome:='unprojected';
 END;
 RETURN outcome;
END $f$;
REVOKE ALL ON FUNCTION app_private.mhp_event_sms_project(uuid,uuid,text,text,text,text,text,bytea,bytea,bytea,bytea,bytea,timestamptz,boolean) FROM PUBLIC;

CREATE FUNCTION app_private.mhp_record_event_sms_inbound(p_workspace uuid,p_connection uuid,p_external_event text,p_message_sid text,
 p_normalized_sender text,p_opt_evidence text,p_body text,p_sender_sha bytea,p_body_sha bytea,p_payload_sha bytea,p_signature_sha bytea,
 p_event_identity_sha bytea,p_occurred timestamptz) RETURNS TABLE(disposition text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE ws constant uuid:='2789228d-55a6-4688-b1e8-2f70abca990b'; nonce text; intent app_private.mhp_event_phone_intents%ROWTYPE;
 programme jsonb; binding app.property_predator_sms_bindings%ROWTYPE; prospect app_private.mhp_prospects%ROWTYPE; phone text;
 phone_point app.contact_points%ROWTYPE; email_point app.contact_points%ROWTYPE; ambiguous boolean:=false; contact uuid; point uuid;
 endpoint_sha bytea; consent uuid:=gen_random_uuid(); receipt uuid:=gen_random_uuid(); outcome text; now_at timestamptz:=statement_timestamp();
 grant_row record; stop_point app.contact_points%ROWTYPE; withdrawn_consent uuid; phone_sha bytea; unlinked app_private.mhp_unlinked_opt_events%ROWTYPE;
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
 SELECT * INTO unlinked FROM app_private.mhp_unlinked_opt_events e WHERE e.channel='sms' AND e.provider_event_id=p_external_event;
 IF FOUND THEN
  -- An unlinked opt event replays effect-free only when every piece of evidence is identical; changed
  -- evidence under the same provider id is a conflict. The projection is never re-run for it.
  IF (unlinked.provider_message_id,unlinked.phone_identity_sha256,unlinked.opt_evidence,unlinked.body_sha256,unlinked.payload_sha256,
      unlinked.signature_sha256,unlinked.event_identity_sha256)
   IS DISTINCT FROM (p_message_sid,public.digest('+'||p_normalized_sender,'sha256'),p_opt_evidence,p_body_sha,p_payload_sha,p_signature_sha,p_event_identity_sha)
  THEN RETURN QUERY SELECT 'conflict'::text; RETURN; END IF;
  RETURN QUERY SELECT 'replayed'::text; RETURN;
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
 -- §4 CRM projection without impersonation: reuse one unambiguous contact or hold.
 IF (SELECT count(*) FROM app.contact_points p WHERE p.workspace_id=ws AND p.kind='phone' AND p.normalized_value=phone AND p.deleted_at IS NULL)>1
  OR EXISTS(SELECT 1 FROM app.contact_points p WHERE p.workspace_id=ws AND p.kind='phone' AND p.normalized_value=phone AND p.deleted_at IS NULL AND p.dedupe_state<>'normal')
  OR (SELECT count(*) FROM app.contact_points p WHERE p.workspace_id=ws AND p.kind='email' AND p.normalized_value=prospect.email::text AND p.deleted_at IS NULL)>1
  OR EXISTS(SELECT 1 FROM app.contact_points p WHERE p.workspace_id=ws AND p.kind='email' AND p.normalized_value=prospect.email::text AND p.deleted_at IS NULL AND p.dedupe_state<>'normal')
 THEN ambiguous:=true; END IF;
 SELECT p.* INTO phone_point FROM app.contact_points p WHERE p.workspace_id=ws AND p.kind='phone' AND p.normalized_value=phone AND p.deleted_at IS NULL AND p.dedupe_state='normal';
 SELECT p.* INTO email_point FROM app.contact_points p WHERE p.workspace_id=ws AND p.kind='email' AND p.normalized_value=prospect.email::text AND p.deleted_at IS NULL AND p.dedupe_state='normal';
 IF phone_point.id IS NOT NULL AND email_point.id IS NOT NULL AND phone_point.contact_id<>email_point.contact_id THEN ambiguous:=true; END IF;
 contact:=coalesce(phone_point.contact_id,email_point.contact_id);
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
 IF email_point.id IS NULL THEN
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
   'revision',intent.revision,'receiptId',receipt,'campaign',intent.campaign,'emailProof','single-use-link','phoneProof','signed-inbound-join',
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
REVOKE ALL ON FUNCTION app_private.mhp_record_event_sms_inbound(uuid,uuid,text,text,text,text,text,bytea,bytea,bytea,bytea,bytea,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.mhp_record_event_sms_inbound(uuid,uuid,text,text,text,text,text,bytea,bytea,bytea,bytea,bytea,timestamptz) TO r72_sms_webhook_command;

-- 10. Owner batch: one real review, exact recipients, atomic pre-materialisation.
CREATE FUNCTION app_private.mhp_event_phone_binding(p_binding uuid) RETURNS app.property_predator_sms_bindings
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $f$
 SELECT b.* FROM app.property_predator_sms_bindings b JOIN app.provider_connections pc ON pc.workspace_id=b.workspace_id AND pc.id=b.provider_connection_id
 JOIN app.channel_endpoints ce ON ce.workspace_id=b.workspace_id AND ce.id=b.channel_endpoint_id AND ce.provider_connection_id=pc.id
 WHERE b.workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND b.id=p_binding AND b.status='active' AND b.sender_number='+447861935832'
  AND pc.provider_id='twilio_messaging' AND pc.provider_kind='sms' AND pc.environment='live' AND pc.status='active'
  AND pc.capabilities @> '["sms.send"]'::jsonb AND ce.channel='sms' AND ce.environment='live' AND ce.status='active'
  AND ce.direction IN('outbound','bidirectional') AND ce.normalized_address=b.sender_number AND ce.address=b.sender_number
  AND NOT EXISTS(SELECT 1 FROM app.property_predator_sms_binding_revocations r WHERE r.workspace_id=b.workspace_id AND r.binding_id=b.id)
$f$;
REVOKE ALL ON FUNCTION app_private.mhp_event_phone_binding(uuid) FROM PUBLIC;

-- Current verified, unsuppressed event grant tuple for one receipt, or nothing.
CREATE FUNCTION app_private.mhp_event_phone_grant_tuple(p_receipt uuid) RETURNS TABLE(receipt_id uuid,intent_revision integer,prospect_id uuid,
 signup_id uuid,campaign text,purpose text,contact_id uuid,point_id uuid,endpoint_sha256 bytea,consent_event_id uuid,phone text)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $f$
 SELECT r.id,r.intent_revision,r.prospect_id,r.signup_id,r.campaign,r.purpose,r.contact_id,r.contact_point_id,r.endpoint_identity_sha256,
  r.consent_event_id,p.normalized_value
 FROM app_private.mhp_event_phone_receipts r
 JOIN app.contact_points p ON p.workspace_id=r.workspace_id AND p.id=r.contact_point_id AND p.contact_id=r.contact_id AND p.kind='phone'
  AND p.deleted_at IS NULL AND p.is_verified AND p.dedupe_state='normal' AND p.normalized_value~'^\+447[0-9]{9}$'
  AND public.digest(p.kind||chr(31)||p.value||chr(31)||p.normalized_value,'sha256')=r.endpoint_identity_sha256
  AND public.digest(p.normalized_value,'sha256')=r.phone_identity_sha256
 JOIN app.contacts c ON c.workspace_id=p.workspace_id AND c.id=p.contact_id AND c.deleted_at IS NULL
 JOIN app_private.mhp_prospects pr ON pr.id=r.prospect_id
 WHERE r.id=p_receipt AND r.decision='granted'
  -- A signed STOP from this number before it had a point is honoured until a signed START (Astra item 1).
  AND app_private.mhp_unlinked_opt_latest('sms',r.phone_identity_sha256) IS DISTINCT FROM 'stop'
  AND app_private.mhp_event_phone_current_receipt(r.prospect_id,r.campaign)=r.id
  AND r.consent_event_id=(SELECT l.id FROM app.communication_consent_events l WHERE l.workspace_id=r.workspace_id AND l.contact_point_id=r.contact_point_id
   AND l.channel='sms' AND l.purpose=r.purpose ORDER BY l.occurred_at DESC,l.recorded_at DESC,l.id DESC LIMIT 1)
  AND EXISTS(SELECT 1 FROM app.communication_consent_events g WHERE g.workspace_id=r.workspace_id AND g.id=r.consent_event_id AND g.state='granted'
   AND g.lawful_basis='consent' AND g.endpoint_identity_sha256=r.endpoint_identity_sha256)
  AND NOT EXISTS(SELECT 1 FROM(SELECT DISTINCT ON(coalesce(s.purpose,'')) s.state FROM app.communication_suppression_events s
   WHERE s.workspace_id=r.workspace_id AND s.contact_point_id=r.contact_point_id AND s.channel='sms' AND(s.purpose IS NULL OR s.purpose=r.purpose)
   ORDER BY coalesce(s.purpose,''),s.occurred_at DESC,s.recorded_at DESC,s.id DESC) latest WHERE latest.state='suppressed')
$f$;
REVOKE ALL ON FUNCTION app_private.mhp_event_phone_grant_tuple(uuid) FROM PUBLIC;

CREATE FUNCTION app_private.mhp_event_phone_owner_context(p_session bytea) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $f$
DECLARE actor uuid;
BEGIN
 actor:=app_private.mhp_owner_email_authorize(p_session);
 IF session_user<>'r72_sms_command' OR current_setting('app.workspace_id',true) IS DISTINCT FROM '2789228d-55a6-4688-b1e8-2f70abca990b'
  OR current_setting('app.actor_kind',true) IS DISTINCT FROM 'user' OR current_setting('app.user_id',true) IS DISTINCT FROM actor::text
  OR coalesce(current_setting('app.request_id',true),'')='' OR length(current_setting('app.request_id',true)) NOT BETWEEN 1 AND 128
  OR NOT EXISTS(SELECT 1 FROM app.workspace_memberships m WHERE m.workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND m.user_id=actor
   AND m.status='active' AND m.role IN('owner','admin'))
 THEN RAISE EXCEPTION 'MHP event reminder owner session required' USING ERRCODE='42501'; END IF;
 RETURN actor;
END $f$;
REVOKE ALL ON FUNCTION app_private.mhp_event_phone_owner_context(bytea) FROM PUBLIC;

-- Review document: everything the one owner click authorises, canonically.
CREATE FUNCTION app_private.mhp_event_phone_review_doc(p_programme jsonb,p_binding app.property_predator_sms_bindings,p_receipts uuid[]) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $f$
 SELECT jsonb_build_object('schema','mhp.event-phone-activation/v1','workspaceId','2789228d-55a6-4688-b1e8-2f70abca990b',
  'policyRevision','mhp.event-phone-operational-review/v1','reviewAuthority','mhp.founder-operator-review-not-legal-advice',
  'programmeVersionId',p_programme->>'programmeVersionId','programmeSha256',p_programme->>'programmeSha256','programmeApprovalId',p_programme->>'approvalId',
  'event',p_programme->>'event','purpose',p_programme->>'purpose','stepKey',p_programme->>'stepKey','startsAt',p_programme->>'startsAt',
  'dueAt',p_programme->>'dueAt','providerDeadline',p_programme->>'providerDeadline',
  'sourceContentVersionId',p_programme->>'sourceContentVersionId','sourceContentSha256',p_programme->>'sourceContentSha256',
  'bodySha256',p_programme->>'bodySha256','segments',(p_programme->>'segments')::integer,
  'bindingId',p_binding.id,'providerConnectionId',p_binding.provider_connection_id,'senderNumber',p_binding.sender_number,
  'recipients',coalesce((SELECT jsonb_agg(jsonb_build_object('receiptId',t.receipt_id,'revision',t.intent_revision,'pointId',t.point_id,
    'endpointSha256',encode(t.endpoint_sha256,'hex'),'consentEventId',t.consent_event_id) ORDER BY t.receipt_id)
   FROM unnest(p_receipts) x(id) CROSS JOIN LATERAL app_private.mhp_event_phone_grant_tuple(x.id) t),'[]'::jsonb))
$f$;
REVOKE ALL ON FUNCTION app_private.mhp_event_phone_review_doc(jsonb,app.property_predator_sms_bindings,uuid[]) FROM PUBLIC;

CREATE FUNCTION app_private.mhp_event_phone_budget(p_connection uuid,p_due timestamptz) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $f$
 WITH d AS (SELECT (p_due AT TIME ZONE 'UTC')::date AS day,date_trunc('month',p_due AT TIME ZONE 'UTC')::date AS month),
 jobs AS (SELECT coalesce(sum(j.segment_count) FILTER (WHERE j.utc_day=d.day),0)::integer AS day_used,coalesce(sum(j.segment_count),0)::integer AS month_used
  FROM d LEFT JOIN app.property_predator_sms_jobs j ON j.workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND j.provider_connection_id=p_connection
   AND j.utc_month=d.month AND j.state<>'cancelled'),
 reserved AS (SELECT coalesce(sum(s.event_segment_count) FILTER (WHERE (s.due_at AT TIME ZONE 'UTC')::date=d.day),0)::integer AS day_reserved,
   coalesce(sum(s.event_segment_count),0)::integer AS month_reserved
  FROM d LEFT JOIN app_private.mhp_marketing_sends s ON s.delivery_channel='sms' AND s.event_provider_connection_id=p_connection
   AND date_trunc('month',s.due_at AT TIME ZONE 'UTC')::date=d.month AND s.cancelled_at IS NULL AND s.event_held_at IS NULL AND s.event_job_id IS NULL)
 SELECT jsonb_build_object('utcDay',d.day,'utcMonth',d.month,'dayUsed',jobs.day_used,'monthUsed',jobs.month_used,
  'dayReserved',reserved.day_reserved,'monthReserved',reserved.month_reserved,
  'dayAvailable',greatest(10-jobs.day_used-reserved.day_reserved,0),'monthAvailable',greatest(50-jobs.month_used-reserved.month_reserved,0),
  'dailyCap',10,'monthlyCap',50) FROM d,jobs,reserved
$f$;
REVOKE ALL ON FUNCTION app_private.mhp_event_phone_budget(uuid,timestamptz) FROM PUBLIC;

CREATE FUNCTION app_private.mhp_event_phone_review(p_session bytea,p_programme_version uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; programme jsonb; binding app.property_predator_sms_bindings%ROWTYPE; budget jsonb; eligible uuid[]; selected uuid[];
 max_batch integer; segments integer; doc jsonb; recipients jsonb; excluded jsonb; schedule jsonb; awaiting integer;
BEGIN
 actor:=app_private.mhp_event_phone_owner_context(p_session);
 programme:=app_private.mhp_event_phone_programme_exact(p_programme_version,true);
 IF programme->>'approvalId' IS NULL THEN RAISE EXCEPTION 'Approve the event programme first' USING ERRCODE='23514'; END IF;
 binding:=app_private.mhp_event_phone_binding((programme->>'senderBindingId')::uuid);
 IF binding.id IS NULL THEN RAISE EXCEPTION 'Actual MHP SMS binding required' USING ERRCODE='42501'; END IF;
 segments:=(programme->>'segments')::integer;
 budget:=app_private.mhp_event_phone_budget(binding.provider_connection_id,(programme->>'dueAt')::timestamptz);
 max_batch:=least(10,((budget->>'dayAvailable')::integer)/segments,((budget->>'monthAvailable')::integer)/segments);
 SELECT array_agg(r.id ORDER BY r.id) INTO eligible FROM app_private.mhp_event_phone_receipts r
 WHERE r.campaign=programme->>'event' AND r.decision='granted'
  AND EXISTS(SELECT 1 FROM app_private.mhp_event_phone_grant_tuple(r.id))
  AND NOT EXISTS(SELECT 1 FROM app_private.mhp_marketing_sends s WHERE s.prospect_id=r.prospect_id AND s.campaign_key=r.campaign AND s.template_key=programme->>'stepKey')
  AND NOT EXISTS(SELECT 1 FROM app_private.mhp_marketing_sends s WHERE s.delivery_channel='sms' AND s.campaign_key=r.campaign
   AND s.event_step_key=programme->>'stepKey' AND s.event_point_id=r.contact_point_id);
 selected:=coalesce(eligible[1:greatest(max_batch,0)],'{}'::uuid[]);
 doc:=app_private.mhp_event_phone_review_doc(programme,binding,selected);
 SELECT coalesce(jsonb_agg(jsonb_build_object('receiptId',t.receipt_id,'revision',t.intent_revision,'phoneMasked',app_private.mhp_event_phone_mask(t.phone),
   'firstName',p.first_name,'selected',t.receipt_id=ANY(selected)) ORDER BY t.receipt_id),'[]'::jsonb) INTO recipients
 FROM unnest(coalesce(eligible,'{}'::uuid[])) x(id) CROSS JOIN LATERAL app_private.mhp_event_phone_grant_tuple(x.id) t JOIN app_private.mhp_prospects p ON p.id=t.prospect_id;
 SELECT jsonb_build_object('held',count(*) FILTER (WHERE i.state='held'),'awaitingJoin',count(*) FILTER (WHERE i.state='awaiting_join' AND i.join_expires_at>statement_timestamp()),
  'withdrawn',count(*) FILTER (WHERE i.state='withdrawn'),
  'notEligible',count(*) FILTER (WHERE i.state='verified' AND NOT EXISTS(SELECT 1 FROM app_private.mhp_event_phone_grant_tuple(i.result_receipt_id))))
 INTO excluded FROM app_private.mhp_event_phone_intents i WHERE i.campaign=programme->>'event' AND i.kind='sms';
 SELECT coalesce(jsonb_agg(jsonb_build_object('calendarId',s.id,'receiptId',s.event_receipt_id,'dueAt',s.due_at,'cancelled',s.cancelled_at IS NOT NULL,
   'held',s.event_hold_reason,'prepared',s.event_job_id IS NOT NULL,'jobState',j.state,'deliveryStatus',md.status,
   'phoneMasked',app_private.mhp_event_phone_mask(cp.normalized_value)) ORDER BY s.due_at,s.id),'[]'::jsonb) INTO schedule
 FROM app_private.mhp_marketing_sends s LEFT JOIN app.property_predator_sms_jobs j ON j.workspace_id=s.event_workspace_id AND j.id=s.event_job_id
 LEFT JOIN app.message_deliveries md ON md.workspace_id=s.event_workspace_id AND md.id=s.event_delivery_id
 LEFT JOIN app.contact_points cp ON cp.workspace_id=s.event_workspace_id AND cp.id=s.event_point_id
 WHERE s.delivery_channel='sms' AND s.campaign_key=programme->>'event';
 RETURN jsonb_build_object('programme',programme-'bodyText','bodyText',programme->>'bodyText','senderNumber',binding.sender_number,
  'bindingId',binding.id,'budget',budget,'maxBatch',greatest(max_batch,0),'recipients',recipients,'selectedReceiptIds',to_jsonb(selected),
  'selectedRevisions',coalesce((SELECT jsonb_object_agg(e->>'receiptId',(e->>'revision')::integer) FROM jsonb_array_elements(doc->'recipients') e),'{}'::jsonb),
  'reviewSha256',encode(public.digest(doc::text,'sha256'),'hex'),'excluded',excluded,'schedule',schedule,
  'awaitingOwnerReview',jsonb_array_length(recipients)-cardinality(selected));
END $f$;

CREATE FUNCTION app_private.mhp_event_phone_activate(p_session bytea,p_command uuid,p_programme_version uuid,p_programme_sha bytea,
 p_sorted_receipts uuid[],p_exact_receipt_revisions jsonb,p_review_sha bytea,p_request_id text,p_agreed boolean,p_lookup_only boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE
 ws constant uuid:='2789228d-55a6-4688-b1e8-2f70abca990b'; actor uuid; request text:=current_setting('app.request_id',true);
 review_authority constant text:='mhp.founder-operator-review-not-legal-advice';
 payload bytea; prior app.command_receipts%ROWTYPE; programme jsonb; binding app.property_predator_sms_bindings%ROWTYPE; doc jsonb;
 budget jsonb; segments integer; body text; body_sha bytea; prepared timestamptz; deadline timestamptz; due timestamptz; starts timestamptz;
 command_receipt uuid:=gen_random_uuid(); inbox uuid; conversation uuid; t record; keys text[]; k text; created jsonb:='[]'::jsonb;
 calendar uuid; message uuid; version uuid; approval_request uuid; approval uuid; subject uuid; pack uuid; legal uuid; commercial uuid;
 publication uuid; sender_route uuid; instigator_route uuid; operation uuid; delivery uuid; correlation uuid; idem bytea; scope bytea;
 facts jsonb; facts_sha bytea; outcome jsonb; i integer;
BEGIN
 actor:=app_private.mhp_event_phone_owner_context(p_session);
 IF p_command IS NULL OR p_programme_version IS NULL OR octet_length(p_programme_sha) IS DISTINCT FROM 32 OR octet_length(p_review_sha) IS DISTINCT FROM 32
  OR p_request_id IS DISTINCT FROM request OR p_agreed IS DISTINCT FROM true OR p_lookup_only IS NULL
  OR p_sorted_receipts IS NULL OR cardinality(p_sorted_receipts) NOT BETWEEN 1 AND 10 OR array_position(p_sorted_receipts,NULL) IS NOT NULL
  OR p_sorted_receipts IS DISTINCT FROM (SELECT array_agg(DISTINCT x ORDER BY x) FROM unnest(p_sorted_receipts) x)
  OR jsonb_typeof(p_exact_receipt_revisions) IS DISTINCT FROM 'object'
  OR (SELECT array_agg(k2 ORDER BY k2) FROM jsonb_object_keys(p_exact_receipt_revisions) k2) IS DISTINCT FROM (SELECT array_agg(x::text ORDER BY x::text) FROM unnest(p_sorted_receipts) x)
  OR EXISTS(SELECT 1 FROM jsonb_each(p_exact_receipt_revisions) e WHERE jsonb_typeof(e.value)<>'number' OR e.value::text!~'^[1-9][0-9]{0,8}$')
 THEN RAISE EXCEPTION 'MHP event reminder activation denied' USING ERRCODE='42501'; END IF;
 payload:=public.digest(jsonb_build_object('schema','mhp.event-phone.activate/v1','workspace',ws,'actor',actor,'programmeVersion',p_programme_version,
  'programmeSha256',encode(p_programme_sha,'hex'),'receipts',to_jsonb(p_sorted_receipts),'revisions',p_exact_receipt_revisions,
  'reviewSha256',encode(p_review_sha,'hex'),'agreed',p_agreed)::text,'sha256');
 SELECT * INTO prior FROM app.command_receipts r WHERE r.workspace_id=ws AND r.actor_user_id=actor AND r.command_name='mhp.event-phone.activate' AND r.idempotency_key=p_command::text;
 IF FOUND THEN
  IF prior.payload_hash IS DISTINCT FROM payload OR prior.status<>'succeeded' THEN RAISE EXCEPTION 'Event reminder activation replay conflicts' USING ERRCODE='40001'; END IF;
  RETURN prior.result||jsonb_build_object('replayed',true);
 END IF;
 IF p_lookup_only THEN RETURN jsonb_build_object('not_started',true); END IF;
 IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed'
 THEN RAISE EXCEPTION 'Event reminder activation requires read committed' USING ERRCODE='25000'; END IF;
 programme:=app_private.mhp_event_phone_programme_exact(p_programme_version,true);
 -- Lock order: programme item, source item, recipients, connection cap, command.
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('company-content:'||ws::text||':'||(programme->>'programmeItemId'),7200021));
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('company-content:'||ws::text||':'||(programme->>'sourceContentItemId'),7200021));
 SELECT array_agg('mhp.event-phone.prospect:'||r.campaign||':'||r.prospect_id::text) INTO keys FROM app_private.mhp_event_phone_receipts r WHERE r.id=ANY(p_sorted_receipts);
 PERFORM app_private.mhp_event_phone_lock(coalesce(keys,'{}'::text[]));
 binding:=app_private.mhp_event_phone_binding((programme->>'senderBindingId')::uuid);
 IF binding.id IS NULL THEN RAISE EXCEPTION 'Actual MHP SMS binding required' USING ERRCODE='42501'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(format('pp-sms:%s:%s',ws,binding.provider_connection_id),0));
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('mhp.event-phone.activate:'||ws::text||':'||actor::text||':'||p_command::text,7200131));
 SELECT * INTO prior FROM app.command_receipts r WHERE r.workspace_id=ws AND r.actor_user_id=actor AND r.command_name='mhp.event-phone.activate' AND r.idempotency_key=p_command::text;
 IF FOUND THEN
  IF prior.payload_hash IS DISTINCT FROM payload OR prior.status<>'succeeded' THEN RAISE EXCEPTION 'Event reminder activation replay conflicts' USING ERRCODE='40001'; END IF;
  RETURN prior.result||jsonb_build_object('replayed',true);
 END IF;
 -- Re-read every current fact after the locks; one stale recipient refuses the whole batch.
 programme:=app_private.mhp_event_phone_programme_exact(p_programme_version,true);
 PERFORM app_private.mhp_owned_sms_content((programme->>'sourceContentVersionId')::uuid,decode(programme->>'sourceContentSha256','hex'));
 IF programme->>'approvalId' IS NULL OR programme->>'programmeSha256' IS DISTINCT FROM encode(p_programme_sha,'hex')
 THEN RAISE EXCEPTION 'Event programme changed; refresh the review' USING ERRCODE='40001'; END IF;
 due:=(programme->>'dueAt')::timestamptz; deadline:=(programme->>'providerDeadline')::timestamptz; starts:=(programme->>'startsAt')::timestamptz;
 IF deadline<=statement_timestamp()+interval '5 minutes' THEN RAISE EXCEPTION 'Event reminder window has passed' USING ERRCODE='23514'; END IF;
 FOR i IN 1..cardinality(p_sorted_receipts) LOOP
  IF NOT EXISTS(SELECT 1 FROM app_private.mhp_event_phone_grant_tuple(p_sorted_receipts[i]) g WHERE g.campaign=programme->>'event'
    AND g.intent_revision=(p_exact_receipt_revisions->>(p_sorted_receipts[i]::text))::integer)
   OR EXISTS(SELECT 1 FROM app_private.mhp_event_phone_receipts r JOIN app_private.mhp_marketing_sends s ON s.prospect_id=r.prospect_id
    AND s.campaign_key=r.campaign AND s.template_key=programme->>'stepKey' WHERE r.id=p_sorted_receipts[i])
   OR EXISTS(SELECT 1 FROM app_private.mhp_event_phone_receipts r JOIN app_private.mhp_marketing_sends s ON s.delivery_channel='sms'
    AND s.campaign_key=r.campaign AND s.event_step_key=programme->>'stepKey' AND s.event_point_id=r.contact_point_id WHERE r.id=p_sorted_receipts[i])
  THEN RAISE EXCEPTION 'A selected recipient changed; refresh the review' USING ERRCODE='40001'; END IF;
 END LOOP;
 doc:=app_private.mhp_event_phone_review_doc(programme,binding,p_sorted_receipts);
 IF jsonb_array_length(doc->'recipients')<>cardinality(p_sorted_receipts) OR public.digest(doc::text,'sha256') IS DISTINCT FROM p_review_sha
 THEN RAISE EXCEPTION 'Owner review no longer matches; refresh the review' USING ERRCODE='40001'; END IF;
 segments:=(programme->>'segments')::integer;
 budget:=app_private.mhp_event_phone_budget(binding.provider_connection_id,due);
 IF cardinality(p_sorted_receipts)*segments>(budget->>'dayAvailable')::integer OR cardinality(p_sorted_receipts)*segments>(budget->>'monthAvailable')::integer
 THEN RAISE EXCEPTION 'Event reminder batch exceeds the SMS caps' USING ERRCODE='54000'; END IF;
 body:=programme->>'bodyText'; body_sha:=public.digest(body,'sha256'); prepared:=date_trunc('milliseconds',statement_timestamp());
 INSERT INTO app.command_receipts(id,workspace_id,command_name,idempotency_key,request_id,actor_user_id,payload_hash)
 VALUES(command_receipt,ws,'mhp.event-phone.activate',p_command::text,request,actor,payload);
 INSERT INTO app.inboxes(workspace_id,channel_endpoint_id,provider_connection_id,channel,environment,name)
 VALUES(ws,binding.channel_endpoint_id,binding.provider_connection_id,'sms','live','Martin Howard Property texts')
 ON CONFLICT(workspace_id,channel_endpoint_id) DO NOTHING;
 SELECT ib.id INTO inbox FROM app.inboxes ib WHERE ib.workspace_id=ws AND ib.channel_endpoint_id=binding.channel_endpoint_id AND ib.status='active';
 IF inbox IS NULL THEN RAISE EXCEPTION 'MHP SMS inbox unavailable' USING ERRCODE='23514'; END IF;
 FOR t IN SELECT g.* FROM unnest(p_sorted_receipts) WITH ORDINALITY x(id,n) CROSS JOIN LATERAL app_private.mhp_event_phone_grant_tuple(x.id) g ORDER BY x.n LOOP
  calendar:=gen_random_uuid(); message:=gen_random_uuid(); version:=gen_random_uuid(); approval_request:=gen_random_uuid(); approval:=gen_random_uuid();
  subject:=gen_random_uuid(); pack:=gen_random_uuid(); legal:=gen_random_uuid(); commercial:=gen_random_uuid(); publication:=gen_random_uuid();
  sender_route:=gen_random_uuid(); instigator_route:=gen_random_uuid(); operation:=gen_random_uuid(); delivery:=gen_random_uuid(); correlation:=gen_random_uuid();
  idem:=public.digest('mhp.event-phone.delivery:'||calendar::text,'sha256');
  INSERT INTO app.conversations(workspace_id,inbox_id,channel,environment,contact_id,assigned_user_id,subject)
  VALUES(ws,inbox,'sms','live',t.contact_id,actor,'Martin Howard Property webinar reminder')
  ON CONFLICT(workspace_id,inbox_id,contact_id) WHERE contact_id IS NOT NULL AND state IN('open','snoozed') DO NOTHING;
  SELECT c.id INTO conversation FROM app.conversations c WHERE c.workspace_id=ws AND c.inbox_id=inbox AND c.contact_id=t.contact_id AND c.state IN('open','snoozed');
  INSERT INTO app.messages(id,workspace_id,conversation_id,contact_id,contact_point_id,channel,environment,direction,lifecycle,source_kind,
   current_version_id,current_version_number,current_body_sha256,created_by_actor_kind,created_by_user_id,occurred_at)
  VALUES(message,ws,conversation,t.contact_id,t.point_id,'sms','live','outbound','draft','user',version,1,body_sha,'user',actor,prepared);
  INSERT INTO app.message_versions(id,workspace_id,conversation_id,message_id,channel,environment,version_number,body_text,
   source_content_version_ref,source_content_sha256,source_content_approval_ref,created_by_actor_kind,created_by_user_id,created_request_id)
  VALUES(version,ws,conversation,message,'sms','live',1,body,programme->>'sourceContentVersionId',decode(programme->>'sourceContentSha256','hex'),
   programme->>'approvalId','user',actor,request);
  IF NOT EXISTS(SELECT 1 FROM app.message_versions v WHERE v.workspace_id=ws AND v.id=version AND v.body_sha256=body_sha)
  THEN RAISE EXCEPTION 'Generated SMS body digest mismatch' USING ERRCODE='23514'; END IF;
  INSERT INTO app.message_approval_requests(id,workspace_id,conversation_id,message_id,message_version_id,version_number,body_sha256,request_number,review_note,requested_by_user_id,requested_request_id)
  VALUES(approval_request,ws,conversation,message,version,1,body_sha,1,'Owner reviewed this exact webinar reminder batch: recipient, text and scheduled time.',actor,request);
  UPDATE app.messages SET lifecycle='approval_pending',row_version=row_version+1,updated_at=statement_timestamp() WHERE workspace_id=ws AND id=message;
  INSERT INTO app.message_approval_decisions(id,workspace_id,conversation_id,message_id,message_version_id,approval_request_id,version_number,body_sha256,decision,decision_note,decided_by_user_id,decided_request_id)
  VALUES(approval,ws,conversation,message,version,approval_request,1,body_sha,'approved','Actual owner operational review of a scheduled event reminder, not external legal advice.',actor,request);
  UPDATE app.messages SET lifecycle='approved',row_version=row_version+1,updated_at=statement_timestamp() WHERE workspace_id=ws AND id=message;
  scope:=public.digest(format('sms:%s:%s:%s:%s:%s:%s:%s',ws,binding.provider_connection_id,binding.sender_number,version,encode(t.endpoint_sha256,'hex'),t.purpose,t.consent_event_id),'sha256');
  facts:=jsonb_build_object('schema','mhp.event-phone-operational-review/v1','owner',actor,'request',request,'command',p_command,'calendar',calendar,
   'reviewSha256',encode(p_review_sha,'hex'),'programmeVersionId',programme->>'programmeVersionId','event',programme->>'event','purpose',t.purpose,
   'dueAt',programme->>'dueAt','providerDeadline',programme->>'providerDeadline','binding',binding.id,'sender',binding.sender_number,
   'receipt',t.receipt_id,'revision',t.intent_revision,'point',t.point_id,'endpointSha256',encode(t.endpoint_sha256,'hex'),'consent',t.consent_event_id,
   'messageVersion',version,'messageBodySha256',encode(body_sha,'hex'),'generalMarketing',false,'reviewAuthority',review_authority,
   'legalEntity','MH196 Ltd','brand','Martin Howard Property');
  facts_sha:=public.digest(facts::text,'sha256');
  INSERT INTO app_private.affiliate_compliance_subjects(id,workspace_id,source_system,source_subject_key,legal_identity_sha256,recorded_by_user_id,recorded_request_id)
  VALUES(subject,ws,'martin-howard-property','mhp.event-phone:'||calendar::text,public.digest('MH196 Ltd:Martin Howard Property:'||actor::text,'sha256'),actor,request);
  INSERT INTO app_private.affiliate_compliance_policy_pack_versions(id,workspace_id,pack_key,pack_version,bundle_sha256,document_refs,drafting_status,source_commit,source_commit_meaning,recorded_by_user_id,recorded_request_id)
  VALUES(pack,ws,'mhp_event_phone_reminder',calendar::text,facts_sha,jsonb_build_array(
   jsonb_build_object('documentType','owner_review','documentId','mhp.event-owner-review:'||calendar::text,'documentVersion','v1','contentSha256',encode(facts_sha,'hex')),
   jsonb_build_object('documentType','sender_ownership','documentId','mhp.sender-ownership:'||binding.id::text,'documentVersion','v1','contentSha256',encode(binding.ownership_evidence_sha256,'hex')),
   jsonb_build_object('documentType','event_phone_proof','documentId','mhp.event-phone-receipt:'||t.receipt_id::text,'documentVersion','v'||t.intent_revision::text,'contentSha256',encode(t.endpoint_sha256,'hex')),
   jsonb_build_object('documentType','exact_message','documentId','mhp.exact-message:'||version::text,'documentVersion','v1','contentSha256',encode(body_sha,'hex')),
   jsonb_build_object('documentType','event_permission','documentId','mhp.event-permission:'||t.consent_event_id::text,'documentVersion','v1',
    'contentSha256',encode(public.digest(app_private.mhp_event_phone_consent_text('mhp.event-phone-sms/v1'),'sha256'),'hex')),
   jsonb_build_object('documentType','event_programme','documentId','mhp.event-programme:'||(programme->>'programmeVersionId'),'documentVersion','v1','contentSha256',programme->>'programmeSha256')),
   'draft_complete','69652270584f1dc0cf737fe2ff7cd9a19e3a4d28','drafting-provenance-only',actor,request);
  INSERT INTO app_private.affiliate_compliance_policy_review_events(id,workspace_id,policy_pack_id,bundle_sha256,review_dimension,decision,specialist_reference,decision_reference,decision_sha256,occurred_at,recorded_by_user_id,recorded_request_id)
  VALUES(legal,ws,pack,facts_sha,'legal','approved',review_authority,'mhp.event-phone:'||calendar::text,public.digest(facts_sha||convert_to(':owner-legal-dimension','UTF8'),'sha256'),prepared,actor,request),
   (commercial,ws,pack,facts_sha,'commercial','approved',review_authority,'mhp.event-phone:'||calendar::text,public.digest(facts_sha||convert_to(':owner-commercial-dimension','UTF8'),'sha256'),prepared,actor,request);
  INSERT INTO app_private.affiliate_compliance_policy_publication_events(id,workspace_id,policy_pack_id,bundle_sha256,publication_state,legal_review_event_id,commercial_review_event_id,effective_at,expires_at,reacceptance_class,publication_reference,recorded_by_user_id,recorded_request_id)
  VALUES(publication,ws,pack,facts_sha,'published',legal,commercial,prepared,deadline,'none','mhp.event-phone:'||calendar::text,actor,request);
  INSERT INTO app_private.affiliate_compliance_specialist_decision_events(id,workspace_id,subject_id,decision_kind,decision_scope_ref,action_scope_sha256,decision_state,route_classification,
   party_reference,responsibility_reference,specialist_reference,decision_sha256,valid_from,valid_until,recorded_by_user_id,recorded_request_id)
  VALUES(sender_route,ws,subject,'pecr_sender_route','mhp.event-phone:'||calendar::text,scope,'approved','individual_consent','mhp.sender.MH196Ltd','mhp.instigator.MH196Ltd',review_authority,
    public.digest(facts_sha||convert_to(':sender','UTF8'),'sha256'),prepared,deadline,actor,request),
   (instigator_route,ws,subject,'pecr_instigator_route','mhp.event-phone:'||calendar::text,scope,'approved','individual_consent','mhp.sender.MH196Ltd','mhp.instigator.MH196Ltd',review_authority,
    public.digest(facts_sha||convert_to(':instigator','UTF8'),'sha256'),prepared,deadline,actor,request);
  -- Existing 0056 insertion order, without any authority or job.
  INSERT INTO app.provider_operations(id,workspace_id,provider_connection_id,message_delivery_id,operation_kind,environment,state,idempotency_key,
   correlation_id,attempt_count,max_attempts,created_by_actor_kind,created_by_user_id)
  VALUES(operation,ws,binding.provider_connection_id,delivery,'conversation.send','live','queued','twilio-sms-live:'||encode(idem,'hex'),
   correlation,0,1,'user',actor);
  INSERT INTO app.message_deliveries(id,workspace_id,conversation_id,message_id,message_version_id,version_number,body_sha256,approval_request_id,
   approval_decision_id,provider_operation_id,provider_connection_id,channel_endpoint_id,contact_id,contact_point_id,conversation_channel,consent_channel,
   purpose,consent_event_id,endpoint_identity_sha256,environment,status,idempotency_key,created_by_user_id)
  VALUES(delivery,ws,conversation,message,version,1,body_sha,approval_request,approval,operation,binding.provider_connection_id,binding.channel_endpoint_id,
   t.contact_id,t.point_id,'sms','sms',t.purpose,t.consent_event_id,t.endpoint_sha256,'live','queued','twilio-sms-live:'||encode(idem,'hex'),actor);
  UPDATE app.provider_operations SET state='reconciliation_required',next_attempt_at='infinity'::timestamptz,lease_token_hash=NULL,lease_expires_at=NULL,
   last_error_code='twilio_sms_live_reserved',last_summary='Reserved for the scheduled MHP event SMS worker',row_version=row_version+1,
   updated_at=statement_timestamp(),completed_at=NULL
  WHERE workspace_id=ws AND id=operation AND message_delivery_id=delivery AND provider_connection_id=binding.provider_connection_id
   AND state='queued' AND provider_reference IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Event SMS provider operation reservation lost' USING ERRCODE='40001'; END IF;
  UPDATE app.messages SET lifecycle='committed',row_version=row_version+1,updated_at=statement_timestamp()
  WHERE workspace_id=ws AND id=message AND current_version_id=version AND current_body_sha256=body_sha AND lifecycle='approved';
  IF NOT FOUND THEN RAISE EXCEPTION 'Event SMS approved message commit lost' USING ERRCODE='40001'; END IF;
  INSERT INTO app_private.mhp_marketing_sends(id,prospect_id,template_key,campaign_key,context,due_at,expires_at,delivery_channel,event_workspace_id,
   event_starts_at,event_programme_item_id,event_programme_version_id,event_programme_sha256,event_programme_approval_id,event_source_item_id,
   event_source_version_id,event_source_sha256,event_receipt_id,event_receipt_revision,event_signup_id,event_contact_id,event_point_id,
   event_endpoint_identity_sha256,event_consent_event_id,event_binding_id,event_provider_connection_id,event_channel_endpoint_id,event_sender_number,
   event_purpose,event_step_key,event_segment_count,event_body_sha256,event_activation_actor_user_id,event_activation_request_id,event_activation_command_id,
   event_activation_payload_sha256,event_message_id,event_message_version_id,event_approval_request_id,event_approval_decision_id,event_delivery_id,
   event_provider_operation_id,event_idempotency_key_sha256,event_compliance_subject_id,event_policy_publication_id,event_pecr_sender_decision_id,
   event_pecr_instigator_decision_id,event_provider_deadline)
  VALUES(calendar,t.prospect_id,programme->>'stepKey',programme->>'event','{}'::jsonb,due,deadline,'sms',ws,starts,
   (programme->>'programmeItemId')::uuid,(programme->>'programmeVersionId')::uuid,decode(programme->>'programmeSha256','hex'),(programme->>'approvalId')::uuid,
   (programme->>'sourceContentItemId')::uuid,(programme->>'sourceContentVersionId')::uuid,decode(programme->>'sourceContentSha256','hex'),
   t.receipt_id,t.intent_revision,t.signup_id,t.contact_id,t.point_id,t.endpoint_sha256,t.consent_event_id,binding.id,binding.provider_connection_id,
   binding.channel_endpoint_id,binding.sender_number,t.purpose,programme->>'stepKey',segments,body_sha,actor,request,p_command,payload,
   message,version,approval_request,approval,delivery,operation,idem,subject,publication,sender_route,instigator_route,deadline);
  created:=created||jsonb_build_array(jsonb_build_object('calendarId',calendar,'receiptId',t.receipt_id,'messageVersionId',version,'deliveryId',delivery));
 END LOOP;
 IF jsonb_array_length(created)<>cardinality(p_sorted_receipts) THEN RAISE EXCEPTION 'Event reminder batch changed during activation' USING ERRCODE='40001'; END IF;
 outcome:=jsonb_build_object('commandId',p_command,'scheduled',created,'count',jsonb_array_length(created),'dueAt',programme->>'dueAt',
  'providerDeadline',programme->>'providerDeadline','reviewSha256',encode(p_review_sha,'hex'),'authorityCreated',false,'jobsCreated',0,
  'providerEffects','none','reviewAuthority',review_authority,'replayed',false);
 UPDATE app.command_receipts SET result=outcome,status='succeeded',response_status=200,completed_at=clock_timestamp() WHERE id=command_receipt AND workspace_id=ws;
 RETURN outcome;
END $f$;

CREATE FUNCTION app_private.mhp_event_phone_control(p_session bytea,p_command uuid,p_action text,p_calendar_id uuid,p_payload_sha bytea,p_request_id text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE ws constant uuid:='2789228d-55a6-4688-b1e8-2f70abca990b'; actor uuid; request text:=current_setting('app.request_id',true); payload bytea;
 prior app.command_receipts%ROWTYPE; row app_private.mhp_marketing_sends%ROWTYPE; job_state text; outcome jsonb; command_receipt uuid:=gen_random_uuid();
BEGIN
 actor:=app_private.mhp_event_phone_owner_context(p_session);
 IF p_command IS NULL OR p_action IS NULL OR p_action NOT IN('hold','cancel') OR p_calendar_id IS NULL OR octet_length(p_payload_sha) IS DISTINCT FROM 32
  OR p_request_id IS DISTINCT FROM request THEN RAISE EXCEPTION 'MHP event reminder control denied' USING ERRCODE='42501'; END IF;
 payload:=public.digest(jsonb_build_object('schema','mhp.event-phone.control/v1','actor',actor,'action',p_action,'calendar',p_calendar_id,
  'payloadSha256',encode(p_payload_sha,'hex'))::text,'sha256');
 SELECT * INTO prior FROM app.command_receipts r WHERE r.workspace_id=ws AND r.actor_user_id=actor AND r.command_name='mhp.event-phone.control' AND r.idempotency_key=p_command::text;
 IF FOUND THEN
  IF prior.payload_hash IS DISTINCT FROM payload OR prior.status<>'succeeded' THEN RAISE EXCEPTION 'Event reminder control replay conflicts' USING ERRCODE='40001'; END IF;
  RETURN prior.result||jsonb_build_object('replayed',true);
 END IF;
 SELECT * INTO row FROM app_private.mhp_marketing_sends s WHERE s.id=p_calendar_id AND s.delivery_channel='sms';
 IF NOT FOUND THEN RAISE EXCEPTION 'Event reminder not found' USING ERRCODE='42501'; END IF;
 -- Lock order shared with begin (job, cap) and prepare (cap, calendar).
 IF row.event_job_id IS NOT NULL THEN PERFORM 1 FROM app.property_predator_sms_jobs j WHERE j.workspace_id=ws AND j.id=row.event_job_id FOR UPDATE; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(format('pp-sms:%s:%s',ws,row.event_provider_connection_id),0));
 SELECT * INTO row FROM app_private.mhp_marketing_sends s WHERE s.id=p_calendar_id AND s.delivery_channel='sms' FOR UPDATE;
 IF row.event_job_id IS NOT NULL THEN PERFORM 1 FROM app.property_predator_sms_jobs j WHERE j.workspace_id=ws AND j.id=row.event_job_id FOR UPDATE; END IF;
 INSERT INTO app.command_receipts(id,workspace_id,command_name,idempotency_key,request_id,actor_user_id,payload_hash)
 VALUES(command_receipt,ws,'mhp.event-phone.control',p_command::text,request,actor,payload);
 IF row.event_job_id IS NOT NULL THEN
  SELECT j.state INTO job_state FROM app.property_predator_sms_jobs j WHERE j.workspace_id=ws AND j.id=row.event_job_id FOR UPDATE;
  IF job_state='queued' THEN
   UPDATE app.property_predator_sms_jobs SET state='cancelled',settled_at=statement_timestamp(),updated_at=statement_timestamp()
   WHERE workspace_id=ws AND id=row.event_job_id AND state='queued';
   job_state:='cancelled';
  END IF;
 END IF;
 IF row.event_held_at IS NULL AND row.cancelled_at IS NULL THEN
  UPDATE app_private.mhp_marketing_sends SET event_held_at=statement_timestamp(),event_hold_reason='owner_hold' WHERE id=row.id;
 END IF;
 IF p_action='cancel' AND row.cancelled_at IS NULL AND (row.event_job_id IS NULL OR job_state='cancelled') THEN
  UPDATE app_private.mhp_marketing_sends SET cancelled_at=statement_timestamp() WHERE id=row.id;
 END IF;
 SELECT jsonb_build_object('calendarId',s.id,'action',p_action,'held',s.event_held_at IS NOT NULL,'cancelled',s.cancelled_at IS NOT NULL,
  'jobState',job_state,'inFlight',job_state IN('leased','calling','awaiting_receipt','needs_attention','succeeded','failed'),'replayed',false)
 INTO outcome FROM app_private.mhp_marketing_sends s WHERE s.id=row.id;
 UPDATE app.command_receipts SET result=outcome,status='succeeded',response_status=200,completed_at=clock_timestamp() WHERE id=command_receipt AND workspace_id=ws;
 RETURN outcome;
END $f$;
REVOKE ALL ON FUNCTION app_private.mhp_event_phone_review(bytea,uuid),
 app_private.mhp_event_phone_activate(bytea,uuid,uuid,bytea,uuid[],jsonb,bytea,text,boolean,boolean),
 app_private.mhp_event_phone_control(bytea,uuid,text,uuid,bytea,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.mhp_event_phone_review(bytea,uuid),
 app_private.mhp_event_phone_activate(bytea,uuid,uuid,bytea,uuid[],jsonb,bytea,text,boolean,boolean),
 app_private.mhp_event_phone_control(bytea,uuid,text,uuid,bytea,text) TO r72_sms_command;

-- 11. Due worker: fresh event authority + one job at the absolute due time.
CREATE FUNCTION app_private.mhp_event_sms_action_sha(p_calendar_id uuid) RETURNS bytea
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $f$
 SELECT public.digest((to_jsonb(s)-ARRAY['cancelled_at','event_held_at','event_hold_reason','event_prepared_at','event_authority_expires_at',
  'event_authority_id','event_job_id','event_preparation_request_id','event_decision_sha256','event_source_check_sha256',
  'lease_until','attempts','sent_at','provider_reference','failed_at'])::text,'sha256')
 FROM app_private.mhp_marketing_sends s WHERE s.id=p_calendar_id AND s.delivery_channel='sms'
$f$;
REVOKE ALL ON FUNCTION app_private.mhp_event_sms_action_sha(uuid) FROM PUBLIC;

-- Immutable approved tuple plus every CURRENT gate. No owner session, no
-- permission-use receipt: current permission is the live event grant.
CREATE FUNCTION app_private.mhp_event_sms_eligible(p_calendar_id uuid,p_require_due boolean) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $f$
DECLARE s app_private.mhp_marketing_sends%ROWTYPE; binding app.property_predator_sms_bindings%ROWTYPE; source jsonb; reason text; now_at timestamptz:=statement_timestamp();
 scope bytea;
BEGIN
 SELECT * INTO s FROM app_private.mhp_marketing_sends x WHERE x.id=p_calendar_id AND x.delivery_channel='sms';
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','not_eligible'); END IF;
 IF s.cancelled_at IS NOT NULL OR s.event_held_at IS NOT NULL THEN RETURN jsonb_build_object('ok',false,'reason','held'); END IF;
 IF now_at>=s.expires_at OR now_at>=s.event_provider_deadline THEN RETURN jsonb_build_object('ok',false,'reason','expired'); END IF;
 IF p_require_due AND s.due_at>now_at THEN RETURN jsonb_build_object('ok',false,'reason','not_due'); END IF;
 IF NOT EXISTS(SELECT 1 FROM app_private.mhp_event_phone_grant_tuple(s.event_receipt_id) g WHERE g.intent_revision=s.event_receipt_revision
   AND g.prospect_id=s.prospect_id AND g.signup_id=s.event_signup_id AND g.campaign=s.campaign_key AND g.purpose=s.event_purpose
   AND g.contact_id=s.event_contact_id AND g.point_id=s.event_point_id AND g.endpoint_sha256=s.event_endpoint_identity_sha256
   AND g.consent_event_id=s.event_consent_event_id)
 THEN RETURN jsonb_build_object('ok',false,'reason','receipt_changed'); END IF;
 binding:=app_private.mhp_event_phone_binding(s.event_binding_id);
 IF binding.id IS NULL OR binding.provider_connection_id<>s.event_provider_connection_id OR binding.channel_endpoint_id<>s.event_channel_endpoint_id
  OR binding.sender_number<>s.event_sender_number THEN RETURN jsonb_build_object('ok',false,'reason','not_eligible'); END IF;
 IF NOT EXISTS(SELECT 1 FROM app.workspace_memberships m WHERE m.workspace_id=s.event_workspace_id AND m.user_id=s.event_activation_actor_user_id
  AND m.status='active' AND m.role IN('owner','admin')) THEN RETURN jsonb_build_object('ok',false,'reason','not_eligible'); END IF;
 scope:=public.digest(format('sms:%s:%s:%s:%s:%s:%s:%s',s.event_workspace_id,s.event_provider_connection_id,s.event_sender_number,
  s.event_message_version_id,encode(s.event_endpoint_identity_sha256,'hex'),s.event_purpose,s.event_consent_event_id),'sha256');
 IF NOT EXISTS(
   SELECT 1 FROM app_private.affiliate_compliance_policy_publication_events pub
   JOIN app_private.affiliate_compliance_policy_review_events legal ON legal.workspace_id=pub.workspace_id AND legal.id=pub.legal_review_event_id
    AND legal.policy_pack_id=pub.policy_pack_id AND legal.bundle_sha256=pub.bundle_sha256 AND legal.review_dimension='legal' AND legal.decision='approved'
   JOIN app_private.affiliate_compliance_policy_review_events commercial ON commercial.workspace_id=pub.workspace_id AND commercial.id=pub.commercial_review_event_id
    AND commercial.policy_pack_id=pub.policy_pack_id AND commercial.bundle_sha256=pub.bundle_sha256 AND commercial.review_dimension='commercial' AND commercial.decision='approved'
   JOIN app_private.affiliate_compliance_specialist_decision_events sr ON sr.workspace_id=pub.workspace_id AND sr.id=s.event_pecr_sender_decision_id
    AND sr.subject_id=s.event_compliance_subject_id AND sr.decision_kind='pecr_sender_route' AND sr.decision_state='approved' AND sr.action_scope_sha256=scope
   JOIN app_private.affiliate_compliance_specialist_decision_events ir ON ir.workspace_id=pub.workspace_id AND ir.id=s.event_pecr_instigator_decision_id
    AND ir.subject_id=s.event_compliance_subject_id AND ir.decision_kind='pecr_instigator_route' AND ir.decision_state='approved' AND ir.action_scope_sha256=scope
   WHERE pub.workspace_id=s.event_workspace_id AND pub.id=s.event_policy_publication_id AND pub.publication_state='published'
    AND pub.effective_at<=now_at AND (pub.expires_at IS NULL OR pub.expires_at>now_at)
    AND sr.valid_from<=now_at AND (sr.valid_until IS NULL OR sr.valid_until>now_at) AND ir.valid_from<=now_at AND (ir.valid_until IS NULL OR ir.valid_until>now_at)
    AND NOT EXISTS(SELECT 1 FROM app_private.affiliate_compliance_policy_publication_events n WHERE n.workspace_id=pub.workspace_id AND n.policy_pack_id=pub.policy_pack_id AND n.supersedes_event_id=pub.id)
    AND NOT EXISTS(SELECT 1 FROM app_private.affiliate_compliance_policy_review_events n WHERE n.workspace_id=legal.workspace_id AND n.policy_pack_id=legal.policy_pack_id
     AND n.review_dimension=legal.review_dimension AND n.supersedes_event_id IN(legal.id,commercial.id))
    AND NOT EXISTS(SELECT 1 FROM app_private.affiliate_compliance_specialist_decision_events n WHERE n.workspace_id=sr.workspace_id AND n.subject_id=sr.subject_id
     AND n.supersedes_event_id IN(sr.id,ir.id))
    AND NOT EXISTS(SELECT 1 FROM app_private.affiliate_compliance_permission_fact_events b WHERE b.workspace_id=s.event_workspace_id
     AND b.subject_id=s.event_compliance_subject_id AND b.permission='sms.send' AND b.action_scope_sha256=scope
     AND b.permission_state IN('blocked','revoked','expired') AND b.valid_from<=now_at AND (b.valid_until IS NULL OR b.valid_until>now_at)
     AND NOT EXISTS(SELECT 1 FROM app_private.affiliate_compliance_permission_fact_events n WHERE n.workspace_id=b.workspace_id AND n.subject_id=b.subject_id
      AND n.permission=b.permission AND n.action_scope_sha256=b.action_scope_sha256 AND n.supersedes_event_id=b.id)))
 THEN RETURN jsonb_build_object('ok',false,'reason','not_eligible'); END IF;
 IF NOT EXISTS(SELECT 1 FROM app.message_deliveries d
   JOIN app.provider_operations op ON op.workspace_id=d.workspace_id AND op.id=d.provider_operation_id AND op.message_delivery_id=d.id
    AND op.provider_connection_id=d.provider_connection_id AND op.environment='live' AND op.operation_kind='conversation.send'
    AND op.idempotency_key='twilio-sms-live:'||encode(s.event_idempotency_key_sha256,'hex') AND op.idempotency_key=d.idempotency_key
   JOIN app.message_versions v ON v.workspace_id=d.workspace_id AND v.id=d.message_version_id AND v.body_sha256=d.body_sha256
   JOIN app.messages m ON m.workspace_id=v.workspace_id AND m.id=v.message_id AND m.current_version_id=v.id AND m.lifecycle='committed'
   WHERE d.workspace_id=s.event_workspace_id AND d.id=s.event_delivery_id AND d.provider_operation_id=s.event_provider_operation_id
    AND d.message_version_id=s.event_message_version_id AND d.approval_request_id=s.event_approval_request_id
    AND d.approval_decision_id=s.event_approval_decision_id AND d.contact_point_id=s.event_point_id AND d.contact_id=s.event_contact_id
    AND d.consent_event_id=s.event_consent_event_id AND d.purpose=s.event_purpose AND d.body_sha256=s.event_body_sha256
    AND d.provider_connection_id=s.event_provider_connection_id AND d.channel_endpoint_id=s.event_channel_endpoint_id
    AND d.endpoint_identity_sha256=s.event_endpoint_identity_sha256 AND d.environment='live' AND d.conversation_channel='sms'
    AND d.status='queued' AND op.state='reconciliation_required' AND op.provider_reference IS NULL
    AND op.last_error_code='twilio_sms_live_reserved')
 THEN RETURN jsonb_build_object('ok',false,'reason','not_eligible'); END IF;
 BEGIN
  source:=app_private.mhp_event_sms_source_check(s.event_programme_version_id,s.event_programme_sha256,s.event_source_version_id,s.event_source_sha256);
 EXCEPTION WHEN sqlstate '23514' OR sqlstate '42501' THEN RETURN jsonb_build_object('ok',false,'reason','newer_draft'); END;
 RETURN jsonb_build_object('ok',true,'reason',NULL,'source',source,'actionSha256',encode(app_private.mhp_event_sms_action_sha(s.id),'hex'),
  'actionScopeSha256',encode(scope,'hex'),'receiptId',s.event_receipt_id,'revision',s.event_receipt_revision,
  'consentEventId',s.event_consent_event_id,'pointId',s.event_point_id,'bindingId',binding.id,'evaluatedAt',
  to_char(now_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
END $f$;
REVOKE ALL ON FUNCTION app_private.mhp_event_sms_eligible(uuid,boolean) FROM PUBLIC;

CREATE FUNCTION app_private.mhp_event_sms_worker_context(p_workspace uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $f$
BEGIN
 IF session_user<>'r72_sms_worker_command' OR p_workspace IS DISTINCT FROM '2789228d-55a6-4688-b1e8-2f70abca990b'
  OR current_setting('app.workspace_id',true) IS DISTINCT FROM p_workspace::text OR current_setting('app.actor_kind',true) IS DISTINCT FROM 'worker'
  OR coalesce(current_setting('app.user_id',true),'')<>'' OR coalesce(current_setting('app.request_id',true),'')=''
  OR length(current_setting('app.request_id',true))>128 OR current_setting('app.request_id',true)<>btrim(current_setting('app.request_id',true))
 THEN RAISE EXCEPTION 'MHP event SMS worker context denied' USING ERRCODE='42501'; END IF;
END $f$;
REVOKE ALL ON FUNCTION app_private.mhp_event_sms_worker_context(uuid) FROM PUBLIC;

CREATE FUNCTION app_private.mhp_prepare_event_sms(p_workspace uuid,p_connection uuid,p_limit integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE ws constant uuid:='2789228d-55a6-4688-b1e8-2f70abca990b'; candidate uuid; s app_private.mhp_marketing_sends%ROWTYPE; elig jsonb;
 prepared timestamptz; expiry timestamptz; authority uuid; job uuid; correlation uuid; request text:=current_setting('app.request_id',true);
 day_segments integer; month_segments integer; decision_sha bytea; request_sha bytea; recipient_sha bytea; scope bytea;
 sender_sha bytea; instigator_sha bytea; done jsonb:='[]'::jsonb; held jsonb:='[]'::jsonb; reason text;
BEGIN
 PERFORM app_private.mhp_event_sms_worker_context(p_workspace);
 IF p_connection IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 10 THEN RAISE EXCEPTION 'MHP event SMS prepare denied' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed'
 THEN RAISE EXCEPTION 'MHP event SMS prepare requires read committed' USING ERRCODE='25000'; END IF;
 FOR candidate IN SELECT x.id FROM app_private.mhp_marketing_sends x WHERE x.delivery_channel='sms' AND x.event_provider_connection_id=p_connection
  AND x.due_at<=statement_timestamp() AND x.cancelled_at IS NULL AND x.event_held_at IS NULL AND x.event_job_id IS NULL
  ORDER BY x.due_at,x.id LIMIT p_limit LOOP
  SELECT * INTO s FROM app_private.mhp_marketing_sends x WHERE x.id=candidate;
  -- item -> recipient -> connection cap -> calendar; skip under contention.
  IF NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('company-content:'||ws::text||':'||s.event_programme_item_id::text,7200021))
   OR NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('company-content:'||ws::text||':'||s.event_source_item_id::text,7200021))
   OR NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('mhp.event-phone.prospect:'||s.campaign_key||':'||s.prospect_id::text,7200131))
  THEN CONTINUE; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(format('pp-sms:%s:%s',ws,p_connection),0));
  SELECT * INTO s FROM app_private.mhp_marketing_sends x WHERE x.id=candidate AND x.delivery_channel='sms' FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN CONTINUE; END IF;
  IF s.event_job_id IS NOT NULL THEN
   done:=done||jsonb_build_array(jsonb_build_object('calendarId',s.id,'jobId',s.event_job_id,'authorityId',s.event_authority_id,
    'authorityExpiresAt',s.event_authority_expires_at,'replayed',true));
   CONTINUE;
  END IF;
  IF s.cancelled_at IS NOT NULL OR s.event_held_at IS NOT NULL THEN CONTINUE; END IF;
  BEGIN elig:=app_private.mhp_event_sms_eligible(s.id,true);
  EXCEPTION WHEN sqlstate '40001' OR sqlstate '40P01' THEN CONTINUE; WHEN OTHERS THEN elig:=jsonb_build_object('ok',false,'reason','not_eligible'); END;
  IF (elig->>'ok')::boolean IS NOT TRUE THEN
   reason:=CASE elig->>'reason' WHEN 'expired' THEN 'expired' WHEN 'receipt_changed' THEN 'receipt_changed' WHEN 'newer_draft' THEN 'newer_draft'
    WHEN 'not_due' THEN NULL WHEN 'held' THEN NULL ELSE 'not_eligible' END;
   IF reason IS NOT NULL THEN
    UPDATE app_private.mhp_marketing_sends SET event_held_at=statement_timestamp(),event_hold_reason=reason WHERE id=s.id;
    held:=held||jsonb_build_array(jsonb_build_object('calendarId',s.id,'reason',reason));
   END IF;
   CONTINUE;
  END IF;
  BEGIN
  prepared:=date_trunc('milliseconds',statement_timestamp());
  expiry:=least(prepared+interval '4 minutes',s.expires_at,s.event_provider_deadline);
  SELECT coalesce(sum(j.segment_count) FILTER (WHERE j.utc_day=(prepared AT TIME ZONE 'UTC')::date),0)::integer,coalesce(sum(j.segment_count),0)::integer
  INTO day_segments,month_segments FROM app.property_predator_sms_jobs j WHERE j.workspace_id=ws AND j.provider_connection_id=p_connection
   AND j.utc_month=date_trunc('month',prepared AT TIME ZONE 'UTC')::date AND j.state<>'cancelled';
  IF day_segments+s.event_segment_count>10 OR month_segments+s.event_segment_count>50 THEN
   UPDATE app_private.mhp_marketing_sends SET event_held_at=statement_timestamp(),event_hold_reason='cap_reached' WHERE id=s.id;
   held:=held||jsonb_build_array(jsonb_build_object('calendarId',s.id,'reason','cap_reached'));
   CONTINUE;
  END IF;
  SELECT op.correlation_id INTO correlation FROM app.provider_operations op WHERE op.workspace_id=ws AND op.id=s.event_provider_operation_id;
  SELECT sr.decision_sha256,ir.decision_sha256 INTO sender_sha,instigator_sha FROM app_private.affiliate_compliance_specialist_decision_events sr,
   app_private.affiliate_compliance_specialist_decision_events ir WHERE sr.workspace_id=ws AND sr.id=s.event_pecr_sender_decision_id
   AND ir.workspace_id=ws AND ir.id=s.event_pecr_instigator_decision_id;
  SELECT public.digest(p.normalized_value,'sha256') INTO recipient_sha FROM app.contact_points p WHERE p.workspace_id=ws AND p.id=s.event_point_id;
  scope:=decode(elig->>'actionScopeSha256','hex');
  decision_sha:=public.digest((elig||jsonb_build_object('evaluatedByRole','r72_sms_worker_command','evaluatedRequestId',request,
   'preparedAt',to_char(prepared AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
   'authorityExpiresAt',to_char(expiry AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
   'daySegmentsBefore',day_segments,'monthSegmentsBefore',month_segments))::text,'sha256');
  authority:=gen_random_uuid(); job:=gen_random_uuid();
  request_sha:=public.digest(pg_catalog.concat_ws(pg_catalog.chr(31),'mhp.event-sms-live/v1',ws::text,p_connection::text,s.event_sender_number,
   s.event_message_version_id::text,encode(s.event_body_sha256,'hex'),s.event_approval_request_id::text,s.event_approval_decision_id::text,
   s.event_channel_endpoint_id::text,s.event_consent_event_id::text,s.event_compliance_subject_id::text,s.event_policy_publication_id::text,
   s.event_pecr_sender_decision_id::text,s.event_pecr_instigator_decision_id::text,s.id::text,s.event_receipt_id::text,
   to_char(expiry AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
   to_char(s.event_provider_deadline AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
   s.event_provider_operation_id::text,s.event_delivery_id::text,correlation::text,encode(s.event_idempotency_key_sha256,'hex'),
   s.event_contact_id::text,s.event_point_id::text,encode(recipient_sha,'hex'),encode(s.event_endpoint_identity_sha256,'hex'),
   s.event_purpose,s.event_segment_count::text,encode(scope,'hex'),'worker','r72_sms_worker_command',request),'sha256');
  INSERT INTO app.property_predator_sms_authorities(id,workspace_id,provider_connection_id,message_delivery_id,provider_operation_id,message_version_id,
   message_approval_request_id,message_approval_decision_id,message_body_sha256,contact_id,contact_point_id,channel_endpoint_id,sender_number,
   recipient_sha256,endpoint_identity_sha256,consent_event_id,purpose,lawful_basis,segment_count,compliance_subject_id,policy_publication_event_id,
   pecr_sender_decision_event_id,pecr_instigator_decision_event_id,permission_use_receipt_id,pecr_decision,pecr_evidence_sha256,
   operator_instigator_decision,operator_instigator_sha256,action_scope_sha256,operator_user_id,operator_request_id,evaluated_at,valid_until,
   authority_kind,event_calendar_id,event_activation_sha256,event_receipt_id,evaluated_by_role,evaluated_request_id,event_eligibility_sha256,
   source_checked_at,source_check_sha256)
  VALUES(authority,ws,p_connection,s.event_delivery_id,s.event_provider_operation_id,s.event_message_version_id,s.event_approval_request_id,
   s.event_approval_decision_id,s.event_body_sha256,s.event_contact_id,s.event_point_id,s.event_channel_endpoint_id,s.event_sender_number,
   recipient_sha,s.event_endpoint_identity_sha256,s.event_consent_event_id,s.event_purpose,'consent',s.event_segment_count,s.event_compliance_subject_id,
   s.event_policy_publication_id,s.event_pecr_sender_decision_id,s.event_pecr_instigator_decision_id,NULL,'eligible',sender_sha,'eligible',
   instigator_sha,scope,NULL,NULL,prepared,expiry,'mhp_event',s.id,decode(elig->>'actionSha256','hex'),s.event_receipt_id,
   'r72_sms_worker_command',request,decision_sha,(elig->'source'->>'checkedAt')::timestamptz,decode(elig->'source'->>'sourceCheckSha256','hex'));
  INSERT INTO app.property_predator_sms_jobs(id,workspace_id,authority_id,provider_connection_id,message_delivery_id,recipient_sha256,operation_id,
   correlation_id,idempotency_key_sha256,request_sha256,segment_count,utc_day,utc_month,created_by_user_id,authority_kind,event_calendar_id,created_by_actor_kind)
  VALUES(job,ws,authority,p_connection,s.event_delivery_id,recipient_sha,s.event_provider_operation_id,correlation,s.event_idempotency_key_sha256,
   request_sha,s.event_segment_count,(prepared AT TIME ZONE 'UTC')::date,date_trunc('month',prepared AT TIME ZONE 'UTC')::date,NULL,'mhp_event',s.id,'worker');
  UPDATE app_private.mhp_marketing_sends SET event_prepared_at=prepared,event_authority_expires_at=expiry,event_authority_id=authority,event_job_id=job,
   event_preparation_request_id=request,event_decision_sha256=decision_sha,event_source_check_sha256=decode(elig->'source'->>'sourceCheckSha256','hex')
  WHERE id=s.id;
  IF clock_timestamp()>=expiry THEN RAISE EXCEPTION 'MHP event SMS preparation expired while waiting' USING ERRCODE='40001'; END IF;
  done:=done||jsonb_build_array(jsonb_build_object('calendarId',s.id,'jobId',job,'authorityId',authority,
   'authorityExpiresAt',to_char(expiry AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'replayed',false));
  EXCEPTION
   -- Transient (race, deadlock, wall-clock expiry): this row only rolls back and is retried next cycle.
   WHEN sqlstate '40001' OR sqlstate '40P01' OR sqlstate '55P03' THEN NULL;
   -- Anything else is never retried blindly: the step is held for the owner.
   WHEN OTHERS THEN
    UPDATE app_private.mhp_marketing_sends SET event_held_at=statement_timestamp(),event_hold_reason='prepare_failed'
    WHERE id=s.id AND event_held_at IS NULL AND cancelled_at IS NULL AND event_job_id IS NULL;
    held:=held||jsonb_build_array(jsonb_build_object('calendarId',s.id,'reason','prepare_failed'));
  END;
 END LOOP;
 RETURN jsonb_build_object('prepared',done,'held',held,'providerEffects','none');
END $f$;

CREATE FUNCTION app_private.claim_event_sms_job(p_workspace_id uuid,p_provider_connection_id uuid,p_lease_token bytea,p_lease_seconds integer)
RETURNS TABLE(job_id uuid,lease_version bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE selected record; recovered app.property_predator_sms_jobs%ROWTYPE; timeout_event_id text; timeout_safe_code text;
BEGIN
 PERFORM app_private.mhp_event_sms_worker_context(p_workspace_id);
 IF octet_length(p_lease_token) IS DISTINCT FROM 32 OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 300
 THEN RAISE EXCEPTION 'MHP event SMS claim denied' USING ERRCODE='42501'; END IF;
 -- Mirrors the 0056 recovery semantics for event jobs only: a lost lease
 -- before calling requeues; after calling it is unknown and is never retried.
 FOR recovered IN SELECT job.* FROM app.property_predator_sms_jobs AS job
  WHERE job.workspace_id=p_workspace_id AND job.provider_connection_id=p_provider_connection_id AND job.authority_kind='mhp_event'
   AND ((job.state IN('leased','calling') AND job.lease_expires_at<=statement_timestamp())
    OR (job.state='awaiting_receipt' AND job.receipt_deadline<=statement_timestamp()))
  FOR UPDATE SKIP LOCKED LOOP
  IF recovered.state IN('calling','awaiting_receipt') THEN
   timeout_event_id:=CASE WHEN recovered.state='calling' THEN format('worker-timeout:%s:%s',recovered.id,recovered.lease_version)
    ELSE format('receipt-timeout:%s',recovered.id) END;
   timeout_safe_code:=CASE WHEN recovered.state='calling' THEN 'twilio_sms_call_outcome_unknown' ELSE 'twilio_sms_receipt_outcome_unknown' END;
   INSERT INTO app.property_predator_sms_receipts(workspace_id,job_id,provider_connection_id,external_event_id,event_kind,provider_message_id,
    recipient_or_sender_sha256,body_sha256,payload_sha256,safe_code,provider_occurred_at)
   VALUES(recovered.workspace_id,recovered.id,recovered.provider_connection_id,timeout_event_id,'outcome_unknown',recovered.provider_external_id,
    recovered.recipient_sha256,NULL,public.digest(timeout_event_id,'sha256'),timeout_safe_code,statement_timestamp())
   ON CONFLICT(workspace_id,provider_connection_id,external_event_id) DO NOTHING;
   UPDATE app.message_deliveries SET status='reconciliation_required',updated_at=statement_timestamp()
   WHERE workspace_id=recovered.workspace_id AND id=recovered.message_delivery_id AND status IN('sending','accepted');
   UPDATE app.provider_operations AS operation SET state='reconciliation_required',next_attempt_at='infinity'::timestamptz,lease_token_hash=NULL,
    lease_expires_at=NULL,last_error_code=timeout_safe_code,last_summary='Twilio SMS provider outcome is unknown; manual reconciliation required',
    row_version=operation.row_version+1,updated_at=statement_timestamp(),completed_at=NULL
   WHERE operation.workspace_id=recovered.workspace_id AND operation.id=recovered.operation_id AND operation.message_delivery_id=recovered.message_delivery_id
    AND operation.provider_connection_id=recovered.provider_connection_id AND operation.idempotency_key~'^twilio-sms-live:[0-9a-f]{64}$';
  END IF;
  UPDATE app.property_predator_sms_jobs SET
   state=CASE WHEN recovered.state='leased' AND recovered.claim_count<8 THEN 'queued' ELSE 'needs_attention' END,
   available_at=CASE WHEN recovered.state='leased' AND recovered.claim_count<8 THEN statement_timestamp() ELSE recovered.available_at END,
   lease_expires_at=NULL,receipt_deadline=NULL,
   settled_at=CASE WHEN recovered.state='leased' AND recovered.claim_count<8 THEN recovered.settled_at ELSE statement_timestamp() END,
   updated_at=statement_timestamp()
  WHERE workspace_id=recovered.workspace_id AND id=recovered.id;
  DELETE FROM app.property_predator_sms_job_leases WHERE workspace_id=recovered.workspace_id AND property_predator_sms_job_leases.job_id=recovered.id;
 END LOOP;
 -- A queued event job whose calendar step was held or cancelled (STOP,
 -- withdrawal, owner hold, new draft) was never handed to the provider.
 UPDATE app.property_predator_sms_jobs AS job SET state='cancelled',settled_at=statement_timestamp(),updated_at=statement_timestamp()
 FROM app_private.mhp_marketing_sends AS calendar
 WHERE job.workspace_id=p_workspace_id AND job.provider_connection_id=p_provider_connection_id AND job.authority_kind='mhp_event'
  AND job.state='queued' AND calendar.id=job.event_calendar_id AND (calendar.event_held_at IS NOT NULL OR calendar.cancelled_at IS NOT NULL);
 -- A queued job whose four-minute authority lapsed was never handed over: it is
 -- cancelled (freeing the cap) and its step held as expired, never re-armed.
 WITH lapsed AS (
  UPDATE app.property_predator_sms_jobs AS job SET state='cancelled',settled_at=statement_timestamp(),updated_at=statement_timestamp()
  FROM app.property_predator_sms_authorities AS authority
  WHERE job.workspace_id=p_workspace_id AND job.provider_connection_id=p_provider_connection_id AND job.authority_kind='mhp_event'
   AND job.state='queued' AND authority.workspace_id=job.workspace_id AND authority.id=job.authority_id AND authority.valid_until<=statement_timestamp()
  RETURNING job.event_calendar_id)
 UPDATE app_private.mhp_marketing_sends AS calendar SET event_held_at=statement_timestamp(),event_hold_reason='expired'
 FROM lapsed WHERE calendar.id=lapsed.event_calendar_id AND calendar.event_held_at IS NULL AND calendar.cancelled_at IS NULL;
 SELECT job.id,job.lease_version INTO selected FROM app.property_predator_sms_jobs AS job
 JOIN app.property_predator_sms_authorities AS authority ON authority.workspace_id=job.workspace_id AND authority.id=job.authority_id
  AND authority.provider_connection_id=job.provider_connection_id AND authority.message_delivery_id=job.message_delivery_id
  AND authority.recipient_sha256=job.recipient_sha256 AND authority.authority_kind='mhp_event' AND authority.event_calendar_id=job.event_calendar_id
 JOIN app_private.mhp_marketing_sends AS calendar ON calendar.id=job.event_calendar_id AND calendar.delivery_channel='sms'
  AND calendar.event_job_id=job.id AND calendar.cancelled_at IS NULL AND calendar.event_held_at IS NULL
 WHERE job.workspace_id=p_workspace_id AND job.provider_connection_id=p_provider_connection_id AND job.authority_kind='mhp_event'
  AND job.state='queued' AND job.available_at<=statement_timestamp() AND authority.valid_until>statement_timestamp()
  AND calendar.event_provider_deadline>statement_timestamp()
 ORDER BY job.available_at,job.created_at,job.id LIMIT 1 FOR UPDATE OF job SKIP LOCKED;
 IF selected.id IS NULL THEN RETURN; END IF;
 UPDATE app.property_predator_sms_jobs AS j SET state='leased',lease_version=j.lease_version+1,
  lease_expires_at=statement_timestamp()+make_interval(secs=>p_lease_seconds),claim_count=j.claim_count+1,updated_at=statement_timestamp()
 WHERE j.workspace_id=p_workspace_id AND j.id=selected.id RETURNING j.lease_version INTO selected.lease_version;
 INSERT INTO app.property_predator_sms_job_leases AS l(workspace_id,job_id,lease_version,lease_token_sha256)
 VALUES(p_workspace_id,selected.id,selected.lease_version,public.digest(p_lease_token,'sha256'))
 ON CONFLICT ON CONSTRAINT property_predator_sms_job_leases_pkey DO UPDATE SET lease_version=EXCLUDED.lease_version,
  lease_token_sha256=EXCLUDED.lease_token_sha256,issued_at=statement_timestamp();
 RETURN QUERY SELECT selected.id,selected.lease_version;
END $f$;

CREATE FUNCTION app_private.load_event_sms_job(p_workspace_id uuid,p_job_id uuid,p_lease_version bigint,p_lease_token bytea) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE material jsonb;
BEGIN
 PERFORM app_private.mhp_event_sms_worker_context(p_workspace_id);
 SELECT jsonb_build_object('providerConnectionId',job.provider_connection_id,'senderNumber',authority.sender_number,'operationId',job.operation_id,
  'correlationId',job.correlation_id,'requestSha256',encode(job.request_sha256,'hex'),'recipient',point.normalized_value,'body',version.body_text,
  'segmentCount',job.segment_count,'calendarId',calendar.id,
  'providerExpiresAt',to_char(calendar.event_provider_deadline AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
 INTO material
 FROM app.property_predator_sms_jobs AS job
 JOIN app.property_predator_sms_job_leases AS lease ON lease.workspace_id=job.workspace_id AND lease.job_id=job.id
  AND lease.lease_version=job.lease_version AND lease.lease_token_sha256=public.digest(p_lease_token,'sha256')
 JOIN app.property_predator_sms_authorities AS authority ON authority.workspace_id=job.workspace_id AND authority.id=job.authority_id
  AND authority.message_delivery_id=job.message_delivery_id AND authority.recipient_sha256=job.recipient_sha256
  AND authority.segment_count=job.segment_count AND authority.authority_kind='mhp_event' AND authority.event_calendar_id=job.event_calendar_id
 JOIN app_private.mhp_marketing_sends AS calendar ON calendar.id=job.event_calendar_id AND calendar.delivery_channel='sms' AND calendar.event_job_id=job.id
  AND calendar.event_authority_id=authority.id AND calendar.cancelled_at IS NULL AND calendar.event_held_at IS NULL
 JOIN app.message_deliveries AS delivery ON delivery.workspace_id=authority.workspace_id AND delivery.id=authority.message_delivery_id
  AND delivery.message_version_id=authority.message_version_id AND delivery.provider_connection_id=authority.provider_connection_id
  AND delivery.contact_id=authority.contact_id AND delivery.contact_point_id=authority.contact_point_id
  AND delivery.channel_endpoint_id=authority.channel_endpoint_id AND delivery.status='queued' AND delivery.environment='live'
 JOIN app.channel_endpoints AS endpoint ON endpoint.workspace_id=delivery.workspace_id AND endpoint.id=delivery.channel_endpoint_id
  AND endpoint.provider_connection_id=delivery.provider_connection_id AND endpoint.channel='sms' AND endpoint.environment='live'
  AND endpoint.direction IN('outbound','bidirectional') AND endpoint.status='active'
  AND endpoint.address=authority.sender_number AND endpoint.normalized_address=authority.sender_number
 JOIN app.message_versions AS version ON version.workspace_id=delivery.workspace_id AND version.id=delivery.message_version_id
  AND version.body_sha256=delivery.body_sha256 AND version.body_sha256=calendar.event_body_sha256 AND version.channel='sms' AND version.environment='live'
  AND version.body_text~'^[\r\n\x20-\x5a\x5f\x61-\x7a]+$' AND char_length(version.body_text) BETWEEN 1 AND 1530
  AND job.segment_count=CASE WHEN char_length(version.body_text)<=160 THEN 1 ELSE ceil(char_length(version.body_text)/153.0)::integer END
 JOIN app.messages AS message ON message.workspace_id=version.workspace_id AND message.id=version.message_id
  AND message.current_version_id=version.id AND message.lifecycle='committed' AND message.direction='outbound'
 JOIN app.contact_points AS point ON point.workspace_id=authority.workspace_id AND point.id=authority.contact_point_id
  AND point.contact_id=authority.contact_id AND point.kind='phone' AND point.deleted_at IS NULL AND point.is_verified
  AND point.dedupe_state='normal' AND point.normalized_value~'^\+44[0-9]{9,10}$'
  AND public.digest(point.normalized_value,'sha256')=job.recipient_sha256
 WHERE job.workspace_id=p_workspace_id AND job.id=p_job_id AND job.authority_kind='mhp_event' AND job.state='leased'
  AND job.lease_version=p_lease_version AND job.lease_expires_at>statement_timestamp() AND authority.valid_until>statement_timestamp()
  AND calendar.event_provider_deadline>statement_timestamp();
 RETURN material;
END $f$;

CREATE FUNCTION app_private.begin_event_sms_call(p_workspace_id uuid,p_job_id uuid,p_lease_version bigint,p_lease_token bytea,
 p_provider_effects_enabled boolean,p_sms_delivery_enabled boolean,p_emergency_paused boolean) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE selected app.property_predator_sms_jobs%ROWTYPE; eligible boolean:=false; day_segments integer; month_segments integer; elig jsonb;
BEGIN
 PERFORM app_private.mhp_event_sms_worker_context(p_workspace_id);
 IF p_provider_effects_enabled IS NOT TRUE OR p_sms_delivery_enabled IS NOT TRUE OR p_emergency_paused IS NOT FALSE OR octet_length(p_lease_token) IS DISTINCT FROM 32
 THEN RAISE EXCEPTION 'MHP event SMS begin-call denied' USING ERRCODE='42501'; END IF;
 SELECT job.* INTO selected FROM app.property_predator_sms_jobs AS job
 JOIN app.property_predator_sms_job_leases AS lease ON lease.workspace_id=job.workspace_id AND lease.job_id=job.id
  AND lease.lease_version=job.lease_version AND lease.lease_token_sha256=public.digest(p_lease_token,'sha256')
 WHERE job.workspace_id=p_workspace_id AND job.id=p_job_id AND job.authority_kind='mhp_event' AND job.state='leased'
  AND job.lease_version=p_lease_version AND job.lease_expires_at>statement_timestamp()
 FOR UPDATE OF job;
 IF NOT FOUND THEN RETURN false; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(format('pp-sms:%s:%s',p_workspace_id,selected.provider_connection_id),0));
 SELECT coalesce(sum(job.segment_count),0)::integer INTO day_segments FROM app.property_predator_sms_jobs AS job
 WHERE job.workspace_id=p_workspace_id AND job.provider_connection_id=selected.provider_connection_id
  AND job.utc_day=(statement_timestamp() AT TIME ZONE 'UTC')::date AND job.state<>'cancelled';
 SELECT coalesce(sum(job.segment_count),0)::integer INTO month_segments FROM app.property_predator_sms_jobs AS job
 WHERE job.workspace_id=p_workspace_id AND job.provider_connection_id=selected.provider_connection_id
  AND job.utc_month=date_trunc('month',statement_timestamp() AT TIME ZONE 'UTC')::date AND job.state<>'cancelled';
 -- Fresh, locked, committed reads: STOP, a new draft or a revoked grant that
 -- committed before this point denies; there is no "approved once" bypass.
 elig:=app_private.mhp_event_sms_eligible(selected.event_calendar_id,true);
 SELECT EXISTS(SELECT 1 FROM app.property_predator_sms_authorities AS authority
  JOIN app_private.mhp_marketing_sends AS calendar ON calendar.id=authority.event_calendar_id AND calendar.event_job_id=selected.id
   AND calendar.event_authority_id=authority.id AND calendar.event_provider_connection_id=authority.provider_connection_id
   AND calendar.event_delivery_id=authority.message_delivery_id AND calendar.event_provider_operation_id=authority.provider_operation_id
   AND calendar.event_message_version_id=authority.message_version_id AND calendar.event_approval_request_id=authority.message_approval_request_id
   AND calendar.event_approval_decision_id=authority.message_approval_decision_id AND calendar.event_body_sha256=authority.message_body_sha256
   AND calendar.event_point_id=authority.contact_point_id AND calendar.event_contact_id=authority.contact_id
   AND calendar.event_consent_event_id=authority.consent_event_id AND calendar.event_purpose=authority.purpose
   AND calendar.event_receipt_id=authority.event_receipt_id AND calendar.event_sender_number=authority.sender_number
   AND calendar.event_compliance_subject_id=authority.compliance_subject_id AND calendar.event_policy_publication_id=authority.policy_publication_event_id
   AND calendar.event_pecr_sender_decision_id=authority.pecr_sender_decision_event_id
   AND calendar.event_pecr_instigator_decision_id=authority.pecr_instigator_decision_event_id
   AND calendar.event_provider_deadline>statement_timestamp()
  JOIN app.contact_points AS point ON point.workspace_id=authority.workspace_id AND point.id=authority.contact_point_id
   AND public.digest(point.normalized_value,'sha256')=authority.recipient_sha256
   AND public.digest(point.kind||chr(31)||point.value||chr(31)||point.normalized_value,'sha256')=authority.endpoint_identity_sha256
  WHERE authority.workspace_id=selected.workspace_id AND authority.id=selected.authority_id AND authority.authority_kind='mhp_event'
   AND authority.event_calendar_id=selected.event_calendar_id AND authority.provider_connection_id=selected.provider_connection_id
   AND authority.message_delivery_id=selected.message_delivery_id AND authority.recipient_sha256=selected.recipient_sha256
   AND authority.segment_count=selected.segment_count AND authority.valid_until>statement_timestamp()
   AND authority.action_scope_sha256=decode(elig->>'actionScopeSha256','hex')
   AND authority.event_activation_sha256=decode(elig->>'actionSha256','hex')) INTO eligible;
 eligible:=eligible AND (elig->>'ok')::boolean IS TRUE
  AND selected.utc_day=(statement_timestamp() AT TIME ZONE 'UTC')::date
  AND selected.utc_month=date_trunc('month',statement_timestamp() AT TIME ZONE 'UTC')::date
  AND day_segments BETWEEN selected.segment_count AND 10 AND month_segments BETWEEN selected.segment_count AND 50;
 IF NOT eligible THEN
  UPDATE app.property_predator_sms_jobs SET state='needs_attention',lease_expires_at=NULL,settled_at=statement_timestamp(),updated_at=statement_timestamp()
  WHERE workspace_id=p_workspace_id AND id=p_job_id;
  DELETE FROM app.property_predator_sms_job_leases WHERE workspace_id=p_workspace_id AND job_id=p_job_id;
  RETURN false;
 END IF;
 UPDATE app.property_predator_sms_jobs SET state='calling',calling_at=statement_timestamp(),updated_at=statement_timestamp()
 WHERE workspace_id=p_workspace_id AND id=p_job_id;
 UPDATE app.provider_operations AS provider_operation SET provider_reference='twilio-sms-pending:'||selected.id,
  row_version=provider_operation.row_version+1,updated_at=statement_timestamp()
 FROM app.property_predator_sms_authorities AS authority
 WHERE authority.workspace_id=selected.workspace_id AND authority.id=selected.authority_id
  AND provider_operation.workspace_id=authority.workspace_id AND provider_operation.id=authority.provider_operation_id
  AND provider_operation.message_delivery_id=selected.message_delivery_id AND provider_operation.provider_connection_id=selected.provider_connection_id
  AND provider_operation.state='reconciliation_required' AND provider_operation.provider_reference IS NULL
  AND provider_operation.last_error_code='twilio_sms_live_reserved';
 IF NOT FOUND THEN RAISE EXCEPTION 'Twilio SMS provider reference fence lost' USING ERRCODE='40001'; END IF;
 UPDATE app.message_deliveries SET status='sending',updated_at=statement_timestamp()
 WHERE workspace_id=p_workspace_id AND id=selected.message_delivery_id AND status='queued';
 IF NOT FOUND THEN RAISE EXCEPTION 'Twilio SMS delivery fence lost' USING ERRCODE='40001'; END IF;
 RETURN true;
END $f$;

CREATE FUNCTION app_private.mhp_hold_event_sms() RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE ws constant uuid:='2789228d-55a6-4688-b1e8-2f70abca990b'; held integer; cancelled integer; report jsonb;
BEGIN
 PERFORM app_private.mhp_event_sms_worker_context(ws);
 UPDATE app.property_predator_sms_jobs SET state='cancelled',settled_at=statement_timestamp(),updated_at=statement_timestamp()
 WHERE workspace_id=ws AND authority_kind='mhp_event' AND state='queued';
 GET DIAGNOSTICS cancelled=ROW_COUNT;
 UPDATE app_private.mhp_marketing_sends SET event_held_at=statement_timestamp(),event_hold_reason='recovery'
 WHERE delivery_channel='sms' AND cancelled_at IS NULL AND event_held_at IS NULL
  AND (event_job_id IS NULL OR EXISTS(SELECT 1 FROM app.property_predator_sms_jobs j WHERE j.workspace_id=ws AND j.id=event_job_id AND j.state='cancelled'));
 GET DIAGNOSTICS held=ROW_COUNT;
 SELECT jsonb_build_object('held',held,'queuedJobsCancelled',cancelled,
  'inFlight',count(*) FILTER (WHERE j.state IN('leased','calling')),'awaitingReceipt',count(*) FILTER (WHERE j.state='awaiting_receipt'),
  'needsAttention',count(*) FILTER (WHERE j.state='needs_attention'),'providerEffects','none') INTO report
 FROM app.property_predator_sms_jobs j WHERE j.workspace_id=ws AND j.authority_kind='mhp_event';
 RETURN report;
END $f$;
REVOKE ALL ON FUNCTION app_private.mhp_prepare_event_sms(uuid,uuid,integer),app_private.claim_event_sms_job(uuid,uuid,bytea,integer),
 app_private.load_event_sms_job(uuid,uuid,bigint,bytea),app_private.begin_event_sms_call(uuid,uuid,bigint,bytea,boolean,boolean,boolean),
 app_private.mhp_hold_event_sms() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.mhp_prepare_event_sms(uuid,uuid,integer),app_private.claim_event_sms_job(uuid,uuid,bytea,integer),
 app_private.load_event_sms_job(uuid,uuid,bigint,bytea),app_private.begin_event_sms_call(uuid,uuid,bigint,bytea,boolean,boolean,boolean),
 app_private.mhp_hold_event_sms() TO r72_sms_worker_command;

-- 12. Legacy exclusions. Each body below is the exact latest definition with
-- only the named predicate added (proved byte-for-byte by the compatibility test).
RESET ROLE;
SET LOCAL ROLE r72_mhp_prospect_definer;
CREATE OR REPLACE FUNCTION app_private.mhp_claim_marketing_sends(p_limit integer,p_lease_seconds integer,p_only_emails text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE claimed jsonb;
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 900 THEN
  RAISE EXCEPTION 'Invalid claim' USING ERRCODE='22023'; END IF;
 IF p_only_emails IS NOT NULL AND (cardinality(p_only_emails) NOT BETWEEN 1 AND 20) THEN RAISE EXCEPTION 'Invalid claim' USING ERRCODE='22023'; END IF;
 UPDATE app_private.mhp_marketing_sends s SET cancelled_at=clock_timestamp()
 WHERE s.delivery_channel='email' AND s.owner_content_version_id IS NULL AND s.sent_at IS NULL AND s.cancelled_at IS NULL AND s.failed_at IS NULL AND s.expires_at<=clock_timestamp()
  AND (s.lease_until IS NULL OR s.lease_until<clock_timestamp());
 UPDATE app_private.mhp_marketing_sends s SET failed_at=clock_timestamp()
 WHERE s.delivery_channel='email' AND s.owner_content_version_id IS NULL AND s.sent_at IS NULL AND s.cancelled_at IS NULL AND s.failed_at IS NULL AND s.attempts>=5 AND (s.lease_until IS NULL OR s.lease_until<clock_timestamp());
 UPDATE app_private.mhp_marketing_sends s SET cancelled_at=clock_timestamp()
 FROM app_private.mhp_prospects p
 WHERE s.delivery_channel='email' AND s.owner_content_version_id IS NULL AND p.id=s.prospect_id AND p.unsubscribed_at IS NOT NULL AND s.sent_at IS NULL AND s.cancelled_at IS NULL AND s.failed_at IS NULL;
 WITH due AS(
  SELECT s.id FROM app_private.mhp_marketing_sends s JOIN app_private.mhp_prospects p ON p.id=s.prospect_id
  WHERE s.delivery_channel='email' AND s.owner_content_version_id IS NULL AND s.sent_at IS NULL AND s.cancelled_at IS NULL AND s.failed_at IS NULL AND s.due_at<=clock_timestamp()
   AND s.expires_at>clock_timestamp() AND (s.lease_until IS NULL OR s.lease_until<clock_timestamp())
   AND (p_only_emails IS NULL OR p.email::text=ANY(p_only_emails))
  ORDER BY s.due_at,s.id LIMIT p_limit FOR UPDATE OF s SKIP LOCKED
 ), leased AS(
  UPDATE app_private.mhp_marketing_sends s SET lease_until=clock_timestamp()+make_interval(secs=>p_lease_seconds),attempts=s.attempts+1
  FROM due WHERE s.id=due.id RETURNING s.*
 )
 SELECT COALESCE(jsonb_agg(jsonb_build_object('id',l.id,'prospectId',p.id,'template',l.template_key,'campaign',l.campaign_key,
  'context',l.context,'email',p.email::text,'firstName',p.first_name,'level',p.level,'attempts',l.attempts,'expiresAt',l.expires_at) ORDER BY l.due_at),'[]'::jsonb)
 INTO claimed FROM leased l JOIN app_private.mhp_prospects p ON p.id=l.prospect_id;
 RETURN claimed;
END $f$;
CREATE OR REPLACE FUNCTION app_private.mhp_settle_marketing_send(p_send uuid,p_accepted boolean,p_reference text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 IF p_send IS NULL OR p_accepted IS NULL OR (p_accepted AND (p_reference IS NULL OR length(p_reference) NOT BETWEEN 1 AND 200)) THEN
  RAISE EXCEPTION 'Invalid settlement' USING ERRCODE='22023'; END IF;
 IF p_accepted THEN
  UPDATE app_private.mhp_marketing_sends SET sent_at=clock_timestamp(),provider_reference=p_reference,lease_until=NULL
  WHERE id=p_send AND sent_at IS NULL AND owner_content_version_id IS NULL AND delivery_channel='email';
 ELSE
  UPDATE app_private.mhp_marketing_sends SET lease_until=clock_timestamp()+make_interval(mins=>5*attempts)
  WHERE id=p_send AND sent_at IS NULL AND owner_content_version_id IS NULL AND delivery_channel='email';
 END IF;
END $f$;
CREATE OR REPLACE FUNCTION app_private.mhp_unsubscribe_prospect(p_prospect uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 UPDATE app_private.mhp_prospects SET unsubscribed_at=COALESCE(unsubscribed_at,clock_timestamp()),marketing_consent=false,updated_at=clock_timestamp()
 WHERE id=p_prospect;
 IF NOT FOUND THEN RETURN false; END IF;
 UPDATE app_private.mhp_marketing_sends SET cancelled_at=clock_timestamp()
 WHERE prospect_id=p_prospect AND delivery_channel='email' AND sent_at IS NULL AND cancelled_at IS NULL AND failed_at IS NULL;
 RETURN true;
END $f$;
CREATE OR REPLACE FUNCTION app_private.mhp_growth_summary(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid;
BEGIN
 SELECT s.user_id INTO actor FROM app_private.resolve_session(p_session) s JOIN app.user_sessions us ON us.id=s.session_id
 WHERE us.product_audience='martin_howard_property';
 IF actor IS NULL OR NOT app_private.mhp_is_programme_admin(actor) THEN RAISE EXCEPTION 'MHP administration required' USING ERRCODE='42501'; END IF;
 RETURN jsonb_build_object(
  'prospects',(SELECT count(*) FROM app_private.mhp_prospects),
  'unsubscribed',(SELECT count(*) FROM app_private.mhp_prospects WHERE unsubscribed_at IS NOT NULL),
  'signupsToday',(SELECT count(*) FROM app_private.mhp_prospect_signups WHERE created_at>=date_trunc('day',clock_timestamp())),
  'byKind',COALESCE((SELECT jsonb_object_agg(kind,n) FROM(SELECT kind,count(DISTINCT prospect_id) n FROM app_private.mhp_prospect_signups GROUP BY kind) k),'{}'::jsonb),
  'byLabel',COALESCE((SELECT jsonb_agg(jsonb_build_object('label',label,'count',n) ORDER BY n DESC) FROM(SELECT label,count(DISTINCT prospect_id) n FROM app_private.mhp_prospect_signups GROUP BY label ORDER BY n DESC LIMIT 30) l),'[]'::jsonb),
  'byLevel',COALESCE((SELECT jsonb_object_agg(COALESCE(level,'unknown'),n) FROM(SELECT level,count(*) n FROM app_private.mhp_prospects GROUP BY level) v),'{}'::jsonb),
  'sends',jsonb_build_object(
    'sent',(SELECT count(*) FROM app_private.mhp_marketing_sends WHERE delivery_channel='email' AND sent_at IS NOT NULL),
    'pending',(SELECT count(*) FROM app_private.mhp_marketing_sends WHERE delivery_channel='email' AND sent_at IS NULL AND cancelled_at IS NULL AND failed_at IS NULL),
    'failed',(SELECT count(*) FROM app_private.mhp_marketing_sends WHERE delivery_channel='email' AND failed_at IS NOT NULL)),
  'stories',(SELECT count(*) FROM app_private.mhp_member_stories),
  'storiesWaiting',(SELECT count(*) FROM app_private.mhp_member_stories WHERE status='received'),
  'course',jsonb_build_object('modules',(SELECT count(*) FROM app_private.mhp_course_modules),'lessons',(SELECT count(*) FROM app_private.mhp_course_lessons),
    'loadedAt',(SELECT max(loaded_at) FROM app_private.mhp_course_modules)),
  'learners',(SELECT count(DISTINCT user_id) FROM app_private.mhp_lesson_progress),
  'lessonsCompleted',(SELECT count(*) FROM app_private.mhp_lesson_progress WHERE completed_at IS NOT NULL));
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
  FROM app_private.mhp_marketing_sends s WHERE s.delivery_channel='email' AND s.owner_content_version_id IS NULL AND s.campaign_key=p_campaign
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
RESET ROLE;
SET LOCAL ROLE r72_sms_definer;
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
      AND job.authority_kind = 'owner_action'
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
   AND authority.authority_kind = 'owner_action'
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
    AND job.authority_kind = 'owner_action'
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
CREATE OR REPLACE FUNCTION app_private.load_sms_live_job(
  p_workspace_id uuid, p_job_id uuid, p_lease_version bigint, p_lease_token bytea
) RETURNS TABLE (
  provider_connection_id uuid, sender_number text,
  operation_id uuid, correlation_id uuid,
  request_sha256 bytea, recipient text, body text, segment_count integer
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $function$
  SELECT job.provider_connection_id, authority.sender_number,
    job.operation_id, job.correlation_id,
    job.request_sha256, point.normalized_value, version.body_text,
    job.segment_count
  FROM app.property_predator_sms_jobs AS job
  JOIN app.property_predator_sms_job_leases AS lease
    ON lease.workspace_id = job.workspace_id AND lease.job_id = job.id
   AND lease.lease_version = job.lease_version
   AND lease.lease_token_sha256 = public.digest(p_lease_token, 'sha256')
  JOIN app.property_predator_sms_authorities AS authority
    ON authority.workspace_id = job.workspace_id AND authority.id = job.authority_id
   AND authority.message_delivery_id = job.message_delivery_id
   AND authority.recipient_sha256 = job.recipient_sha256
   AND authority.segment_count = job.segment_count
  JOIN app.message_deliveries AS delivery
    ON delivery.workspace_id = authority.workspace_id
   AND delivery.id = authority.message_delivery_id
   AND delivery.message_version_id = authority.message_version_id
   AND delivery.provider_connection_id = authority.provider_connection_id
   AND delivery.contact_id = authority.contact_id
   AND delivery.contact_point_id = authority.contact_point_id
   AND delivery.channel_endpoint_id = authority.channel_endpoint_id
   AND delivery.status = 'queued' AND delivery.environment = 'live'
  JOIN app.channel_endpoints AS endpoint
    ON endpoint.workspace_id = delivery.workspace_id
   AND endpoint.id = delivery.channel_endpoint_id
   AND endpoint.provider_connection_id = delivery.provider_connection_id
   AND endpoint.channel = 'sms' AND endpoint.environment = 'live'
   AND endpoint.direction IN ('outbound', 'bidirectional')
   AND endpoint.status = 'active'
   AND endpoint.address = authority.sender_number
   AND endpoint.normalized_address = authority.sender_number
  JOIN app.message_versions AS version
    ON version.workspace_id = delivery.workspace_id
   AND version.id = delivery.message_version_id
   AND version.body_sha256 = delivery.body_sha256
   AND version.channel = 'sms' AND version.environment = 'live'
   AND version.body_text ~ '^[\r\n\x20-\x5a\x5f\x61-\x7a]+$'
   AND char_length(version.body_text) BETWEEN 1 AND 1530
   AND job.segment_count = CASE WHEN char_length(version.body_text) <= 160 THEN 1
     ELSE ceil(char_length(version.body_text) / 153.0)::integer END
  JOIN app.messages AS message
    ON message.workspace_id = version.workspace_id AND message.id = version.message_id
   AND message.current_version_id = version.id
   AND message.lifecycle = 'committed' AND message.direction = 'outbound'
  JOIN app.contact_points AS point
    ON point.workspace_id = authority.workspace_id
   AND point.id = authority.contact_point_id AND point.contact_id = authority.contact_id
   AND point.kind = 'phone' AND point.deleted_at IS NULL
   AND point.is_verified AND point.dedupe_state = 'normal'
   AND point.normalized_value ~ '^\+44[0-9]{9,10}$'
   AND public.digest(point.normalized_value, 'sha256') = job.recipient_sha256
  WHERE session_user = 'r72_sms_worker_command'
    AND current_setting('app.workspace_id', true) = p_workspace_id::text
    AND current_setting('app.actor_kind', true) = 'worker'
    AND coalesce(current_setting('app.user_id', true), '') = ''
    AND coalesce(current_setting('app.request_id', true), '') <> ''
    AND job.workspace_id = p_workspace_id AND job.id = p_job_id
    AND job.state = 'leased' AND job.lease_version = p_lease_version
    AND job.lease_expires_at > statement_timestamp()
    AND job.authority_kind = 'owner_action' AND authority.authority_kind = 'owner_action'
    AND authority.valid_until > statement_timestamp()
    AND authority.action_scope_sha256 = public.digest(format(
      'sms:%s:%s:%s:%s:%s:%s:%s', authority.workspace_id,
      authority.provider_connection_id, authority.sender_number,
      authority.message_version_id,
      pg_catalog.encode(authority.endpoint_identity_sha256, 'hex'),
      authority.purpose, authority.consent_event_id
    ), 'sha256');
$function$;
CREATE OR REPLACE FUNCTION app_private.begin_sms_live_call(
  p_workspace_id uuid, p_job_id uuid, p_lease_version bigint,
  p_lease_token bytea, p_provider_effects_enabled boolean,
  p_sms_delivery_enabled boolean, p_emergency_paused boolean
) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE selected app.property_predator_sms_jobs%ROWTYPE;
  eligible boolean := false; day_segments integer; month_segments integer;
BEGIN
  IF session_user <> 'r72_sms_worker_command'
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id::text
     OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'worker'
     OR coalesce(current_setting('app.user_id', true), '') <> ''
     OR coalesce(current_setting('app.request_id', true), '') = ''
     OR NOT p_provider_effects_enabled OR NOT p_sms_delivery_enabled
     OR p_emergency_paused OR octet_length(p_lease_token) <> 32 THEN
    RAISE EXCEPTION 'Twilio SMS begin-call denied' USING ERRCODE = '42501';
  END IF;
  SELECT job.* INTO selected
  FROM app.property_predator_sms_jobs AS job
  JOIN app.property_predator_sms_job_leases AS lease
    ON lease.workspace_id = job.workspace_id AND lease.job_id = job.id
   AND lease.lease_version = job.lease_version
   AND lease.lease_token_sha256 = public.digest(p_lease_token, 'sha256')
  WHERE job.workspace_id = p_workspace_id AND job.id = p_job_id
    AND job.state = 'leased' AND job.lease_version = p_lease_version
    AND job.lease_expires_at > statement_timestamp()
    AND job.authority_kind = 'owner_action'
  FOR UPDATE OF job;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    format('pp-sms:%s:%s', p_workspace_id, selected.provider_connection_id), 0
  ));
  SELECT coalesce(sum(job.segment_count), 0)::integer INTO day_segments
  FROM app.property_predator_sms_jobs AS job
  WHERE job.workspace_id = p_workspace_id
    AND job.provider_connection_id = selected.provider_connection_id
    AND job.utc_day = (statement_timestamp() AT TIME ZONE 'UTC')::date
    AND job.state <> 'cancelled';
  SELECT coalesce(sum(job.segment_count), 0)::integer INTO month_segments
  FROM app.property_predator_sms_jobs AS job
  WHERE job.workspace_id = p_workspace_id
    AND job.provider_connection_id = selected.provider_connection_id
    AND job.utc_month = date_trunc('month', statement_timestamp() AT TIME ZONE 'UTC')::date
    AND job.state <> 'cancelled';

  SELECT EXISTS (
    SELECT 1
    FROM app.property_predator_sms_authorities AS authority
    JOIN app.provider_connections AS connection
      ON connection.workspace_id = authority.workspace_id
     AND connection.id = authority.provider_connection_id
     AND connection.provider_id = 'twilio_messaging' AND connection.provider_kind = 'sms'
     AND connection.environment = 'live' AND connection.status = 'active'
     AND connection.capabilities @> '["sms.send"]'::jsonb
    JOIN app.message_deliveries AS delivery
      ON delivery.workspace_id = authority.workspace_id
     AND delivery.id = authority.message_delivery_id
     AND delivery.message_version_id = authority.message_version_id
     AND delivery.approval_request_id = authority.message_approval_request_id
     AND delivery.approval_decision_id = authority.message_approval_decision_id
     AND delivery.provider_connection_id = authority.provider_connection_id
     AND delivery.contact_id = authority.contact_id
     AND delivery.contact_point_id = authority.contact_point_id
     AND delivery.channel_endpoint_id = authority.channel_endpoint_id
     AND delivery.status = 'queued' AND delivery.environment = 'live'
     AND delivery.conversation_channel = 'sms' AND delivery.purpose = authority.purpose
    JOIN app.provider_operations AS provider_operation
      ON provider_operation.workspace_id = delivery.workspace_id
     AND provider_operation.id = authority.provider_operation_id
     AND provider_operation.message_delivery_id = delivery.id
     AND provider_operation.provider_connection_id = authority.provider_connection_id
     AND provider_operation.operation_kind = 'conversation.send'
     AND provider_operation.environment = 'live'
     AND provider_operation.state = 'reconciliation_required'
     AND provider_operation.provider_reference IS NULL
     AND provider_operation.last_error_code = 'twilio_sms_live_reserved'
    JOIN app.message_versions AS message_version
      ON message_version.workspace_id = delivery.workspace_id
     AND message_version.id = delivery.message_version_id
     AND message_version.body_sha256 = delivery.body_sha256
    JOIN app.messages AS message
      ON message.workspace_id = message_version.workspace_id
     AND message.id = message_version.message_id
     AND message.current_version_id = message_version.id
     AND message.current_body_sha256 = message_version.body_sha256
     AND message.lifecycle = 'committed' AND message.direction = 'outbound'
    JOIN app.channel_endpoints AS endpoint
      ON endpoint.workspace_id = delivery.workspace_id
     AND endpoint.id = delivery.channel_endpoint_id
     AND endpoint.provider_connection_id = delivery.provider_connection_id
     AND endpoint.channel = 'sms' AND endpoint.environment = 'live'
     AND endpoint.status = 'active' AND endpoint.direction IN ('outbound', 'bidirectional')
     AND endpoint.address = authority.sender_number
     AND endpoint.normalized_address = authority.sender_number
    JOIN app.contact_points AS point
      ON point.workspace_id = authority.workspace_id
     AND point.id = authority.contact_point_id AND point.contact_id = authority.contact_id
     AND point.kind = 'phone' AND point.deleted_at IS NULL
     AND point.is_verified AND point.dedupe_state = 'normal'
     AND point.normalized_value ~ '^\+44[0-9]{9,10}$'
     AND public.digest(point.normalized_value, 'sha256') = authority.recipient_sha256
     AND public.digest(point.kind || pg_catalog.chr(31) || point.value
       || pg_catalog.chr(31) || point.normalized_value, 'sha256')
       = authority.endpoint_identity_sha256
    JOIN app.communication_consent_events AS consent
      ON consent.workspace_id = authority.workspace_id
     AND consent.id = authority.consent_event_id
     AND consent.contact_id = authority.contact_id
     AND consent.contact_point_id = authority.contact_point_id
     AND consent.channel = 'sms' AND consent.purpose = authority.purpose
     AND consent.state = 'granted' AND consent.lawful_basis = authority.lawful_basis
     AND consent.endpoint_identity_sha256 = authority.endpoint_identity_sha256
    JOIN app_private.affiliate_compliance_permission_use_receipts AS permission_use
      ON permission_use.workspace_id = authority.workspace_id
     AND permission_use.subject_id = authority.compliance_subject_id
     AND permission_use.id = authority.permission_use_receipt_id
     AND permission_use.permission = 'sms.send'
     AND permission_use.action_scope_sha256 = authority.action_scope_sha256
     AND permission_use.eligibility_decision = 'allow'
     AND permission_use.use_state = 'consumed'
     AND permission_use.provider_effects IS FALSE
     AND permission_use.recorded_by_user_id = authority.operator_user_id
     AND permission_use.recorded_request_id = authority.operator_request_id
    JOIN app.workspace_memberships AS operator_membership
      ON operator_membership.workspace_id = authority.workspace_id
     AND operator_membership.user_id = authority.operator_user_id
     AND operator_membership.status = 'active'
     AND operator_membership.role IN ('owner', 'admin')
    WHERE authority.workspace_id = selected.workspace_id
      AND authority.id = selected.authority_id
      AND authority.authority_kind = 'owner_action'
      AND authority.provider_connection_id = selected.provider_connection_id
      AND authority.message_delivery_id = selected.message_delivery_id
      AND authority.recipient_sha256 = selected.recipient_sha256
      AND authority.segment_count = selected.segment_count
      AND authority.valid_until > statement_timestamp()
      AND authority.action_scope_sha256 = public.digest(format(
        'sms:%s:%s:%s:%s:%s:%s:%s', authority.workspace_id,
        authority.provider_connection_id, authority.sender_number,
        authority.message_version_id,
        pg_catalog.encode(authority.endpoint_identity_sha256, 'hex'),
        authority.purpose, authority.consent_event_id
      ), 'sha256')
      AND permission_use.consumed_at <= statement_timestamp()
      AND permission_use.decision_expires_at > statement_timestamp()
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
      AND NOT EXISTS (
        SELECT 1 FROM app_private.affiliate_compliance_permission_fact_events AS block
        WHERE block.workspace_id = permission_use.workspace_id
          AND block.subject_id = permission_use.subject_id
          AND block.permission = 'sms.send'
          AND block.action_scope_sha256 = authority.action_scope_sha256
          AND block.permission_state IN ('blocked', 'revoked', 'expired')
          AND block.valid_from <= statement_timestamp()
          AND (block.valid_until IS NULL OR block.valid_until > statement_timestamp())
          AND NOT EXISTS (
            SELECT 1 FROM app_private.affiliate_compliance_permission_fact_events AS successor
            WHERE successor.workspace_id = block.workspace_id
              AND successor.subject_id = block.subject_id
              AND successor.permission = block.permission
              AND successor.action_scope_sha256 = block.action_scope_sha256
              AND successor.supersedes_event_id = block.id
          )
      )
  ) INTO eligible;
  eligible := eligible AND selected.utc_day = (statement_timestamp() AT TIME ZONE 'UTC')::date
    AND selected.utc_month = date_trunc('month', statement_timestamp() AT TIME ZONE 'UTC')::date
    AND day_segments BETWEEN selected.segment_count AND 10
    AND month_segments BETWEEN selected.segment_count AND 50;
  IF NOT eligible THEN
    UPDATE app.property_predator_sms_jobs SET state = 'needs_attention',
      lease_expires_at = NULL, settled_at = statement_timestamp(),
      updated_at = statement_timestamp()
    WHERE workspace_id = p_workspace_id AND id = p_job_id;
    DELETE FROM app.property_predator_sms_job_leases
    WHERE workspace_id = p_workspace_id AND job_id = p_job_id;
    RETURN false;
  END IF;
  UPDATE app.property_predator_sms_jobs SET state = 'calling',
    calling_at = statement_timestamp(), updated_at = statement_timestamp()
  WHERE workspace_id = p_workspace_id AND id = p_job_id;
  UPDATE app.provider_operations AS provider_operation SET
    provider_reference = 'twilio-sms-pending:' || selected.id,
    row_version = provider_operation.row_version + 1,
    updated_at = statement_timestamp()
  FROM app.property_predator_sms_authorities AS authority
  WHERE authority.workspace_id = selected.workspace_id
    AND authority.id = selected.authority_id
    AND provider_operation.workspace_id = authority.workspace_id
    AND provider_operation.id = authority.provider_operation_id
    AND provider_operation.message_delivery_id = selected.message_delivery_id
    AND provider_operation.provider_connection_id = selected.provider_connection_id
    AND provider_operation.state = 'reconciliation_required'
    AND provider_operation.provider_reference IS NULL
    AND provider_operation.last_error_code = 'twilio_sms_live_reserved';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Twilio SMS provider reference fence lost' USING ERRCODE = '40001';
  END IF;
  UPDATE app.message_deliveries SET status = 'sending', updated_at = statement_timestamp()
  WHERE workspace_id = p_workspace_id AND id = selected.message_delivery_id
    AND status = 'queued';
  IF NOT FOUND THEN RAISE EXCEPTION 'Twilio SMS delivery fence lost' USING ERRCODE = '40001'; END IF;
  RETURN true;
END
$function$;
RESET ROLE;
SET LOCAL ROLE r72_owner;
CREATE OR REPLACE FUNCTION app_private.sms_live_job_identity_guard()
RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog AS $function$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.authority_id IS DISTINCT FROM OLD.authority_id
     OR NEW.provider_connection_id IS DISTINCT FROM OLD.provider_connection_id
     OR NEW.message_delivery_id IS DISTINCT FROM OLD.message_delivery_id
     OR NEW.recipient_sha256 IS DISTINCT FROM OLD.recipient_sha256
     OR NEW.operation_id IS DISTINCT FROM OLD.operation_id
     OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
     OR NEW.idempotency_key_sha256 IS DISTINCT FROM OLD.idempotency_key_sha256
     OR NEW.request_sha256 IS DISTINCT FROM OLD.request_sha256
     OR NEW.segment_count IS DISTINCT FROM OLD.segment_count
     OR NEW.utc_day IS DISTINCT FROM OLD.utc_day OR NEW.utc_month IS DISTINCT FROM OLD.utc_month
     OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
     OR NEW.authority_kind IS DISTINCT FROM OLD.authority_kind
     OR NEW.event_calendar_id IS DISTINCT FROM OLD.event_calendar_id
     OR NEW.created_by_actor_kind IS DISTINCT FROM OLD.created_by_actor_kind
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Twilio SMS job identity evidence is immutable' USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END
$function$;

-- 13. A new programme or source draft holds unprepared scheduled phone work;
-- already prepared work is denied at begin by the current-version check.
RESET ROLE;
SET LOCAL ROLE r72_mhp_prospect_definer;
CREATE FUNCTION app_private.mhp_event_phone_new_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 IF NEW.workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND NEW.source_system IN('mhp.event-phone','mhp.owner-sms') THEN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('company-content:'||NEW.workspace_id::text||':'||NEW.content_item_id::text,7200021));
  UPDATE app_private.mhp_marketing_sends s SET event_held_at=clock_timestamp(),event_hold_reason='newer_draft'
  WHERE s.delivery_channel='sms' AND (s.event_programme_item_id=NEW.content_item_id OR s.event_source_item_id=NEW.content_item_id)
   AND s.event_programme_version_id<>NEW.id AND s.event_source_version_id<>NEW.id
   AND s.cancelled_at IS NULL AND s.event_held_at IS NULL AND s.event_job_id IS NULL;
 END IF;
 RETURN NEW;
END $f$;
REVOKE ALL ON FUNCTION app_private.mhp_event_phone_new_version() FROM PUBLIC;
RESET ROLE;
SET LOCAL ROLE r72_owner;
CREATE TRIGGER mhp_event_phone_new_version AFTER INSERT ON app.company_content_versions FOR EACH ROW EXECUTE FUNCTION app_private.mhp_event_phone_new_version();
RESET ROLE;
REVOKE CREATE ON SCHEMA app_private FROM r72_sms_definer,r72_mhp_prospect_definer;
