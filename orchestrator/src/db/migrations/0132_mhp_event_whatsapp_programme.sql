-- MHP009C source candidate on the corrected 009B (0131): webinar WhatsApp
-- follow-up with WhatsApp's own possession proof (registrant-sent "JOIN <nonce>"
-- through wa.me, verified by the existing app-secret-HMAC inbound path), signed
-- WhatsApp STOP, a server-side Meta template read as the only template evidence,
-- one owner batch review and a worker-created event authority on the 0053 rail.
-- UNRATIFIED parts (see 009B-009C-DECISION-PROPOSALS-R3.md): WhatsApp STOP
-- projection (proposal 2), Meta template read boundary (proposal 3). Caps are
-- the unchanged 0053 1/day 3/month. An SMS verification never counts here.
SET LOCAL ROLE r72_owner;

-- 0. Two exact repairs of latent 0053 defects (also found by the earlier 009C
-- candidate): the {0,511} template-name repetition exceeds PostgreSQL's 255 cap
-- (every template insert raised 2201B), and claim_whatsapp_live_job's OUT
-- columns collide with three unqualified references (42702 on first claim).
ALTER TABLE app.property_predator_whatsapp_live_templates DROP CONSTRAINT property_predator_whatsapp_live_te_provider_template_name_check;
ALTER TABLE app.property_predator_whatsapp_live_templates ADD CONSTRAINT property_predator_whatsapp_live_te_provider_template_name_check
 CHECK (provider_template_name ~ '^[a-z][a-z0-9_]*$' AND char_length(provider_template_name) <= 512);

-- 1. WhatsApp event intents and proofs (separate from SMS: no shared verification).
CREATE TABLE app_private.mhp_event_whatsapp_intents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL CHECK(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b'),
 prospect_id uuid NOT NULL REFERENCES app_private.mhp_prospects(id) ON DELETE CASCADE,
 signup_id uuid NOT NULL,
 campaign text NOT NULL CHECK(campaign~'^webinar-[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
 programme_version_id uuid NOT NULL,
 parent_access_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>=1),
 previous_intent_id uuid REFERENCES app_private.mhp_event_whatsapp_intents(id) ON DELETE CASCADE,
 state text NOT NULL CHECK(state IN('awaiting_join','verified','superseded','withdrawn','expired','held')),
 command_id uuid NOT NULL,
 request_key_sha256 bytea NOT NULL CHECK(octet_length(request_key_sha256)=32),
 payload_sha256 bytea NOT NULL CHECK(octet_length(payload_sha256)=32),
 source_sha256 bytea NOT NULL CHECK(octet_length(source_sha256)=32),
 phone_e164 text NOT NULL CHECK(phone_e164~'^\+447[0-9]{9}$'),
 phone_identity_sha256 bytea NOT NULL CHECK(octet_length(phone_identity_sha256)=32),
 consent_revision text NOT NULL CHECK(consent_revision='mhp.event-whatsapp/v1'),
 consent_text_sha256 bytea NOT NULL CHECK(octet_length(consent_text_sha256)=32),
 consent_chosen_at timestamptz NOT NULL,
 join_nonce_sha256 bytea NOT NULL CHECK(octet_length(join_nonce_sha256)=32),
 join_expires_at timestamptz NOT NULL,
 join_consumed_at timestamptz,
 consumed_provider_event_id text CHECK(consumed_provider_event_id IS NULL OR length(consumed_provider_event_id) BETWEEN 1 AND 500),
 contact_id uuid, point_id uuid, result_receipt_id uuid,
 hold_reason text CHECK(hold_reason IS NULL OR hold_reason IN('crm_ambiguous','suppressed','programme_changed')),
 created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 UNIQUE(workspace_id,request_key_sha256),
 UNIQUE(id,prospect_id,signup_id,campaign),
 FOREIGN KEY(signup_id,prospect_id) REFERENCES app_private.mhp_prospect_signups(id,prospect_id) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,programme_version_id) REFERENCES app.company_content_versions(workspace_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(parent_access_id,prospect_id,signup_id,campaign) REFERENCES app_private.mhp_event_phone_intents(id,prospect_id,signup_id,campaign) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,point_id,contact_id) REFERENCES app.contact_points(workspace_id,id,contact_id) ON DELETE RESTRICT,
 CHECK(updated_at>=created_at),
 CONSTRAINT mhp_event_whatsapp_intent_shape CHECK(
  (previous_intent_id IS NULL)=(revision=1)
  AND join_expires_at>consent_chosen_at AND join_expires_at<=consent_chosen_at+interval '10 minutes'
  AND (join_consumed_at IS NULL)=(consumed_provider_event_id IS NULL)
  AND (point_id IS NULL)=(contact_id IS NULL) AND (point_id IS NULL)=(result_receipt_id IS NULL)
  AND (point_id IS NULL OR join_consumed_at IS NOT NULL)
  AND (state<>'awaiting_join' OR (join_consumed_at IS NULL AND hold_reason IS NULL))
  AND (state<>'verified' OR (point_id IS NOT NULL AND hold_reason IS NULL))
  AND (state<>'withdrawn' OR point_id IS NOT NULL)
  AND (state='held')=(hold_reason IS NOT NULL) AND (state<>'held' OR point_id IS NULL))
);
CREATE UNIQUE INDEX mhp_event_whatsapp_one_pending ON app_private.mhp_event_whatsapp_intents(campaign,prospect_id) WHERE state='awaiting_join';
CREATE UNIQUE INDEX mhp_event_whatsapp_one_live ON app_private.mhp_event_whatsapp_intents(campaign,prospect_id) WHERE state='verified';
CREATE UNIQUE INDEX mhp_event_whatsapp_revision ON app_private.mhp_event_whatsapp_intents(campaign,prospect_id,revision);
CREATE UNIQUE INDEX mhp_event_whatsapp_join_nonce ON app_private.mhp_event_whatsapp_intents(join_nonce_sha256);
CREATE INDEX mhp_event_whatsapp_phone_rate ON app_private.mhp_event_whatsapp_intents(phone_identity_sha256,created_at);

CREATE TABLE app_private.mhp_event_whatsapp_receipts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL CHECK(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b'),
 intent_id uuid NOT NULL, intent_revision integer NOT NULL CHECK(intent_revision>=1),
 campaign text NOT NULL, prospect_id uuid NOT NULL, signup_id uuid NOT NULL,
 channel text NOT NULL CHECK(channel='whatsapp'),
 purpose text NOT NULL,
 contact_id uuid NOT NULL, contact_point_id uuid NOT NULL,
 endpoint_identity_sha256 bytea NOT NULL CHECK(octet_length(endpoint_identity_sha256)=32),
 phone_identity_sha256 bytea NOT NULL CHECK(octet_length(phone_identity_sha256)=32),
 decision text NOT NULL CHECK(decision IN('granted','withdrawn')),
 consent_revision text NOT NULL CHECK(consent_revision='mhp.event-whatsapp/v1'),
 consent_text_sha256 bytea NOT NULL CHECK(octet_length(consent_text_sha256)=32),
 consent_event_id uuid NOT NULL,
 proof_kind text NOT NULL CHECK(proof_kind IN('signed_meta_join','signed_meta_stop','public_event_withdrawal')),
 whatsapp_binding_id uuid NOT NULL,
 provider_event_id text CHECK(provider_event_id IS NULL OR length(provider_event_id) BETWEEN 1 AND 500),
 provider_message_id text CHECK(provider_message_id IS NULL OR provider_message_id~'^wamid[.][A-Za-z0-9_=-]{1,190}$'),
 payload_sha256 bytea CHECK(payload_sha256 IS NULL OR octet_length(payload_sha256)=32),
 signature_sha256 bytea CHECK(signature_sha256 IS NULL OR octet_length(signature_sha256)=32),
 body_sha256 bytea CHECK(body_sha256 IS NULL OR octet_length(body_sha256)=32),
 event_identity_sha256 bytea CHECK(event_identity_sha256 IS NULL OR octet_length(event_identity_sha256)=32),
 occurred_at timestamptz NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 supersedes_receipt_id uuid REFERENCES app_private.mhp_event_whatsapp_receipts(id) ON DELETE RESTRICT,
 request_sha256 bytea NOT NULL CHECK(octet_length(request_sha256)=32),
 UNIQUE(intent_id,decision,request_sha256),
 UNIQUE(id,intent_id,contact_point_id),
 FOREIGN KEY(intent_id,prospect_id,signup_id,campaign) REFERENCES app_private.mhp_event_whatsapp_intents(id,prospect_id,signup_id,campaign) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,contact_point_id,contact_id) REFERENCES app.contact_points(workspace_id,id,contact_id) ON DELETE RESTRICT,
 FOREIGN KEY(workspace_id,consent_event_id) REFERENCES app.communication_consent_events(workspace_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(workspace_id,whatsapp_binding_id) REFERENCES app.property_predator_whatsapp_live_bindings(workspace_id,id) ON DELETE RESTRICT,
 CHECK(purpose='mhp.webinar.'||substr(campaign,9)),
 CHECK(occurred_at<=recorded_at+interval '5 minutes'),
 CONSTRAINT mhp_event_whatsapp_receipt_proof CHECK(
  (proof_kind IN('signed_meta_join','signed_meta_stop') AND provider_event_id IS NOT NULL AND provider_message_id IS NOT NULL
   AND payload_sha256 IS NOT NULL AND signature_sha256 IS NOT NULL AND body_sha256 IS NOT NULL AND event_identity_sha256 IS NOT NULL)
  OR (proof_kind='public_event_withdrawal' AND provider_event_id IS NULL AND provider_message_id IS NULL AND payload_sha256 IS NULL
   AND signature_sha256 IS NULL AND body_sha256 IS NULL AND event_identity_sha256 IS NULL)),
 CONSTRAINT mhp_event_whatsapp_receipt_decision CHECK(
  (decision='granted' AND proof_kind='signed_meta_join' AND supersedes_receipt_id IS NULL)
  OR (decision='withdrawn' AND proof_kind IN('signed_meta_stop','public_event_withdrawal') AND supersedes_receipt_id IS NOT NULL))
);
CREATE UNIQUE INDEX mhp_event_whatsapp_receipt_event ON app_private.mhp_event_whatsapp_receipts(workspace_id,whatsapp_binding_id,provider_event_id,intent_id)
 WHERE provider_event_id IS NOT NULL;
CREATE UNIQUE INDEX mhp_event_whatsapp_receipt_one_withdrawal ON app_private.mhp_event_whatsapp_receipts(supersedes_receipt_id) WHERE supersedes_receipt_id IS NOT NULL;
CREATE INDEX mhp_event_whatsapp_receipt_current ON app_private.mhp_event_whatsapp_receipts(campaign,prospect_id,occurred_at DESC,recorded_at DESC,id DESC);
ALTER TABLE app_private.mhp_event_whatsapp_intents ADD CONSTRAINT mhp_event_whatsapp_intent_result
 FOREIGN KEY(result_receipt_id,id,point_id) REFERENCES app_private.mhp_event_whatsapp_receipts(id,intent_id,contact_point_id) DEFERRABLE INITIALLY DEFERRED;
CREATE FUNCTION app_private.mhp_event_whatsapp_intent_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $f$
DECLARE mutable constant text[]:=ARRAY['state','join_consumed_at','consumed_provider_event_id','contact_id','point_id','result_receipt_id','hold_reason','updated_at'];
BEGIN
 IF TG_OP='DELETE' THEN
  IF pg_trigger_depth()>1 THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Event WhatsApp intent evidence is immutable' USING ERRCODE='40001';
 END IF;
 IF (to_jsonb(NEW)-mutable) IS DISTINCT FROM (to_jsonb(OLD)-mutable)
  OR (OLD.join_consumed_at IS NOT NULL AND NEW.join_consumed_at IS DISTINCT FROM OLD.join_consumed_at)
  OR (OLD.consumed_provider_event_id IS NOT NULL AND NEW.consumed_provider_event_id IS DISTINCT FROM OLD.consumed_provider_event_id)
  OR (OLD.point_id IS NOT NULL AND (NEW.point_id,NEW.contact_id,NEW.result_receipt_id) IS DISTINCT FROM (OLD.point_id,OLD.contact_id,OLD.result_receipt_id))
  OR NEW.updated_at<OLD.updated_at
  OR NOT ((OLD.state=NEW.state) OR (OLD.state='awaiting_join' AND NEW.state IN('verified','superseded','expired','held'))
   OR (OLD.state='verified' AND NEW.state IN('superseded','withdrawn')))
 THEN RAISE EXCEPTION 'Event WhatsApp intent transition denied' USING ERRCODE='40001'; END IF;
 RETURN NEW;
END $f$;
CREATE TRIGGER mhp_event_whatsapp_intent_guard BEFORE UPDATE OR DELETE ON app_private.mhp_event_whatsapp_intents
 FOR EACH ROW EXECUTE FUNCTION app_private.mhp_event_whatsapp_intent_guard();
CREATE TRIGGER mhp_event_whatsapp_receipt_guard BEFORE UPDATE ON app_private.mhp_event_whatsapp_receipts
 FOR EACH ROW EXECUTE FUNCTION app_private.mhp_event_phone_receipt_guard();
REVOKE ALL ON FUNCTION app_private.mhp_event_whatsapp_intent_guard() FROM PUBLIC;

-- 2. Provider template evidence: only a server-side Meta read writes it.
CREATE TABLE app_private.mhp_whatsapp_template_observations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL CHECK(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b'),
 binding_id uuid NOT NULL,
 meta_template_id text NOT NULL CHECK(meta_template_id~'^[1-9][0-9]{4,29}$'),
 template_name text NOT NULL CHECK(template_name~'^[a-z][a-z0-9_]*$' AND char_length(template_name)<=512),
 language_code text NOT NULL CHECK(language_code~'^[a-z]{2,3}(_[A-Z]{2})?$'),
 category text NOT NULL CHECK(category IN('MARKETING','UTILITY','AUTHENTICATION')),
 provider_status text NOT NULL CHECK(provider_status~'^[A-Z_]{1,40}$'),
 parameter_count smallint NOT NULL CHECK(parameter_count BETWEEN 0 AND 10),
 body_sha256 bytea NOT NULL CHECK(octet_length(body_sha256)=32),
 components_sha256 bytea NOT NULL CHECK(octet_length(components_sha256)=32),
 response_sha256 bytea NOT NULL CHECK(octet_length(response_sha256)=32),
 observed_by_role text NOT NULL CHECK(observed_by_role='r72_whatsapp_live_worker_command'),
 observed_request_id text NOT NULL CHECK(observed_request_id=btrim(observed_request_id) AND length(observed_request_id) BETWEEN 1 AND 128),
 observed_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 expires_at timestamptz NOT NULL,
 FOREIGN KEY(workspace_id,binding_id) REFERENCES app.property_predator_whatsapp_live_bindings(workspace_id,id) ON DELETE RESTRICT,
 CHECK(expires_at>observed_at AND expires_at<=observed_at+interval '15 minutes')
);
CREATE INDEX mhp_whatsapp_template_observation_latest ON app_private.mhp_whatsapp_template_observations(binding_id,meta_template_id,observed_at DESC,id DESC);
CREATE TRIGGER mhp_whatsapp_template_observation_immutable BEFORE UPDATE OR DELETE ON app_private.mhp_whatsapp_template_observations
 FOR EACH ROW EXECUTE FUNCTION app_private.mhp_event_phone_receipt_guard();

-- 3. WhatsApp follow-up calendar (separate relation: no ratified 009C design
-- asks to widen the email/SMS calendar again; no legacy function can see it).
CREATE TABLE app_private.mhp_event_whatsapp_sends (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL CHECK(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b'),
 prospect_id uuid NOT NULL REFERENCES app_private.mhp_prospects(id) ON DELETE RESTRICT,
 campaign text NOT NULL CHECK(campaign~'^webinar-[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
 step_key text NOT NULL CHECK(step_key~'^event_wa_[a-z0-9]{1,20}$'),
 purpose text NOT NULL,
 starts_at timestamptz NOT NULL,
 due_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 programme_item_id uuid NOT NULL, programme_version_id uuid NOT NULL, programme_sha256 bytea NOT NULL CHECK(octet_length(programme_sha256)=32),
 programme_approval_id uuid NOT NULL,
 source_item_id uuid NOT NULL, source_version_id uuid NOT NULL, source_sha256 bytea NOT NULL CHECK(octet_length(source_sha256)=32),
 binding_id uuid NOT NULL, provider_connection_id uuid NOT NULL, template_id uuid NOT NULL,
 meta_template_id text NOT NULL CHECK(meta_template_id~'^[1-9][0-9]{4,29}$'),
 template_observation_id uuid NOT NULL REFERENCES app_private.mhp_whatsapp_template_observations(id) ON DELETE RESTRICT,
 receipt_id uuid NOT NULL REFERENCES app_private.mhp_event_whatsapp_receipts(id) ON DELETE RESTRICT,
 receipt_revision integer NOT NULL CHECK(receipt_revision>=1),
 signup_id uuid NOT NULL, contact_id uuid NOT NULL, point_id uuid NOT NULL,
 recipient_sha256 bytea NOT NULL CHECK(octet_length(recipient_sha256)=32),
 endpoint_identity_sha256 bytea NOT NULL CHECK(octet_length(endpoint_identity_sha256)=32),
 consent_event_id uuid NOT NULL,
 compliance_subject_id uuid NOT NULL, policy_publication_id uuid NOT NULL,
 pecr_sender_decision_id uuid NOT NULL, pecr_instigator_decision_id uuid NOT NULL,
 operation_id uuid NOT NULL, idempotency_key_sha256 bytea NOT NULL CHECK(octet_length(idempotency_key_sha256)=32),
 activation_actor_user_id uuid NOT NULL,
 activation_request_id text NOT NULL CHECK(activation_request_id=btrim(activation_request_id) AND length(activation_request_id) BETWEEN 1 AND 128),
 activation_command_id uuid NOT NULL,
 activation_payload_sha256 bytea NOT NULL CHECK(octet_length(activation_payload_sha256)=32),
 cancelled_at timestamptz, held_at timestamptz,
 hold_reason text CHECK(hold_reason IS NULL OR hold_reason IN('owner_hold','newer_draft','receipt_changed','not_eligible','cap_reached','expired','recovery','template_not_approved')),
 prepared_at timestamptz, authority_expires_at timestamptz, authority_id uuid, job_id uuid, preparation_request_id text,
 decision_sha256 bytea CHECK(decision_sha256 IS NULL OR octet_length(decision_sha256)=32),
 prepared_observation_id uuid REFERENCES app_private.mhp_whatsapp_template_observations(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 UNIQUE(prospect_id,campaign,step_key),
 UNIQUE(workspace_id,campaign,step_key,point_id),
 UNIQUE(workspace_id,idempotency_key_sha256),
 UNIQUE(id,binding_id,template_id,recipient_sha256),
 FOREIGN KEY(signup_id,prospect_id) REFERENCES app_private.mhp_prospect_signups(id,prospect_id) ON DELETE RESTRICT,
 FOREIGN KEY(workspace_id,programme_item_id,programme_version_id,programme_sha256) REFERENCES app.company_content_versions(workspace_id,content_item_id,id,content_sha256) ON DELETE RESTRICT,
 FOREIGN KEY(workspace_id,programme_approval_id) REFERENCES app.company_content_approval_decisions(workspace_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(workspace_id,source_item_id,source_version_id,source_sha256) REFERENCES app.company_content_versions(workspace_id,content_item_id,id,content_sha256) ON DELETE RESTRICT,
 FOREIGN KEY(workspace_id,template_id,binding_id,provider_connection_id) REFERENCES app.property_predator_whatsapp_live_templates(workspace_id,id,binding_id,provider_connection_id) ON DELETE RESTRICT,
 FOREIGN KEY(workspace_id,point_id,contact_id) REFERENCES app.contact_points(workspace_id,id,contact_id) ON DELETE RESTRICT,
 FOREIGN KEY(workspace_id,consent_event_id) REFERENCES app.communication_consent_events(workspace_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(workspace_id,compliance_subject_id) REFERENCES app_private.affiliate_compliance_subjects(workspace_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(workspace_id,policy_publication_id) REFERENCES app_private.affiliate_compliance_policy_publication_events(workspace_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(workspace_id,pecr_sender_decision_id) REFERENCES app_private.affiliate_compliance_specialist_decision_events(workspace_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(workspace_id,pecr_instigator_decision_id) REFERENCES app_private.affiliate_compliance_specialist_decision_events(workspace_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(workspace_id,activation_actor_user_id) REFERENCES app.workspace_memberships(workspace_id,user_id) ON DELETE RESTRICT,
 CHECK(purpose='mhp.webinar.'||substr(campaign,9)),
 CHECK(due_at<expires_at AND due_at>=starts_at AND expires_at<=due_at+interval '24 hours'),
 CHECK((held_at IS NULL)=(hold_reason IS NULL)),
 CONSTRAINT mhp_event_whatsapp_send_preparation CHECK(
  (prepared_at IS NULL AND authority_expires_at IS NULL AND authority_id IS NULL AND job_id IS NULL AND preparation_request_id IS NULL
   AND decision_sha256 IS NULL AND prepared_observation_id IS NULL)
  OR (prepared_at IS NOT NULL AND authority_expires_at IS NOT NULL AND authority_id IS NOT NULL AND job_id IS NOT NULL
   AND preparation_request_id IS NOT NULL AND decision_sha256 IS NOT NULL AND prepared_observation_id IS NOT NULL
   AND prepared_at>=due_at AND authority_expires_at>prepared_at AND authority_expires_at<=prepared_at+interval '4 minutes'
   AND authority_expires_at<=expires_at))
);
CREATE INDEX mhp_event_whatsapp_send_due ON app_private.mhp_event_whatsapp_sends(provider_connection_id,due_at)
 WHERE job_id IS NULL AND cancelled_at IS NULL AND held_at IS NULL;
CREATE FUNCTION app_private.mhp_event_whatsapp_send_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $f$
DECLARE mutable constant text[]:=ARRAY['cancelled_at','held_at','hold_reason','prepared_at','authority_expires_at','authority_id','job_id',
 'preparation_request_id','decision_sha256','prepared_observation_id'];
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Event WhatsApp calendar evidence is immutable' USING ERRCODE='40001'; END IF;
 IF (to_jsonb(NEW)-mutable) IS DISTINCT FROM (to_jsonb(OLD)-mutable)
  OR (OLD.cancelled_at IS NOT NULL AND NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at)
  OR (OLD.held_at IS NOT NULL AND (NEW.held_at,NEW.hold_reason) IS DISTINCT FROM (OLD.held_at,OLD.hold_reason))
  OR (OLD.job_id IS NOT NULL AND (NEW.prepared_at,NEW.authority_expires_at,NEW.authority_id,NEW.job_id,NEW.preparation_request_id,NEW.decision_sha256,NEW.prepared_observation_id)
   IS DISTINCT FROM (OLD.prepared_at,OLD.authority_expires_at,OLD.authority_id,OLD.job_id,OLD.preparation_request_id,OLD.decision_sha256,OLD.prepared_observation_id))
 THEN RAISE EXCEPTION 'Event WhatsApp calendar evidence is immutable' USING ERRCODE='40001'; END IF;
 RETURN NEW;
END $f$;
REVOKE ALL ON FUNCTION app_private.mhp_event_whatsapp_send_guard() FROM PUBLIC;
CREATE TRIGGER mhp_event_whatsapp_send_guard BEFORE UPDATE OR DELETE ON app_private.mhp_event_whatsapp_sends
 FOR EACH ROW EXECUTE FUNCTION app_private.mhp_event_whatsapp_send_guard();

-- 4. 0053 authority/job provenance branch (mirror of 0131 section 7).
ALTER TABLE app.property_predator_whatsapp_live_authorities
 ADD COLUMN authority_kind text NOT NULL DEFAULT 'owner_action',
 ADD COLUMN event_send_id uuid,
 ADD COLUMN event_receipt_id uuid,
 ADD COLUMN event_template_observation_id uuid,
 ADD COLUMN evaluated_by_role text,
 ADD COLUMN evaluated_request_id text,
 ADD COLUMN event_eligibility_sha256 bytea,
 ALTER COLUMN operator_user_id DROP NOT NULL,
 ALTER COLUMN operator_request_id DROP NOT NULL,
 ALTER COLUMN permission_use_receipt_id DROP NOT NULL;
ALTER TABLE app.property_predator_whatsapp_live_authorities
 ADD CONSTRAINT whatsapp_authority_kind_shape CHECK(
  (authority_kind='owner_action' AND operator_user_id IS NOT NULL AND operator_request_id IS NOT NULL AND permission_use_receipt_id IS NOT NULL
   AND event_send_id IS NULL AND event_receipt_id IS NULL AND event_template_observation_id IS NULL AND evaluated_by_role IS NULL
   AND evaluated_request_id IS NULL AND event_eligibility_sha256 IS NULL)
  OR (authority_kind='mhp_event' AND workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND purpose~'^mhp\.webinar\.[0-9]{4}-[0-9]{2}-[0-9]{2}$'
   AND operator_user_id IS NULL AND operator_request_id IS NULL AND permission_use_receipt_id IS NULL
   AND event_send_id IS NOT NULL AND event_receipt_id IS NOT NULL AND event_template_observation_id IS NOT NULL
   AND evaluated_by_role='r72_whatsapp_live_worker_command' AND evaluated_request_id IS NOT NULL
   AND evaluated_request_id=btrim(evaluated_request_id) AND length(evaluated_request_id) BETWEEN 1 AND 128
   AND octet_length(event_eligibility_sha256)=32 AND valid_until<=evaluated_at+interval '4 minutes')),
 ADD CONSTRAINT whatsapp_authority_kind_identity UNIQUE(workspace_id,id,authority_kind),
 ADD CONSTRAINT whatsapp_authority_event_identity UNIQUE(workspace_id,id,event_send_id),
 ADD CONSTRAINT whatsapp_authority_event_send_fk FOREIGN KEY(event_send_id,binding_id,template_id,recipient_sha256)
  REFERENCES app_private.mhp_event_whatsapp_sends(id,binding_id,template_id,recipient_sha256) ON DELETE RESTRICT,
 ADD CONSTRAINT whatsapp_authority_event_receipt_fk FOREIGN KEY(event_receipt_id) REFERENCES app_private.mhp_event_whatsapp_receipts(id) ON DELETE RESTRICT,
 ADD CONSTRAINT whatsapp_authority_event_observation_fk FOREIGN KEY(event_template_observation_id) REFERENCES app_private.mhp_whatsapp_template_observations(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX whatsapp_authority_one_per_send ON app.property_predator_whatsapp_live_authorities(event_send_id) WHERE event_send_id IS NOT NULL;
ALTER TABLE app.property_predator_whatsapp_live_jobs
 ADD COLUMN authority_kind text NOT NULL DEFAULT 'owner_action',
 ADD COLUMN event_send_id uuid,
 ADD COLUMN created_by_actor_kind text NOT NULL DEFAULT 'user',
 ALTER COLUMN created_by_user_id DROP NOT NULL;
ALTER TABLE app.property_predator_whatsapp_live_jobs
 ADD CONSTRAINT whatsapp_job_kind_shape CHECK(
  (authority_kind='owner_action' AND created_by_actor_kind='user' AND created_by_user_id IS NOT NULL AND event_send_id IS NULL)
  OR (authority_kind='mhp_event' AND created_by_actor_kind='worker' AND created_by_user_id IS NULL
   AND workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND event_send_id IS NOT NULL)),
 ADD CONSTRAINT whatsapp_job_authority_kind_fk FOREIGN KEY(workspace_id,authority_id,authority_kind)
  REFERENCES app.property_predator_whatsapp_live_authorities(workspace_id,id,authority_kind) ON DELETE RESTRICT,
 ADD CONSTRAINT whatsapp_job_authority_event_fk FOREIGN KEY(workspace_id,authority_id,event_send_id)
  REFERENCES app.property_predator_whatsapp_live_authorities(workspace_id,id,event_send_id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX whatsapp_job_one_per_send ON app.property_predator_whatsapp_live_jobs(event_send_id) WHERE event_send_id IS NOT NULL;
ALTER TABLE app_private.mhp_event_whatsapp_sends
 ADD CONSTRAINT mhp_event_whatsapp_send_authority_fk FOREIGN KEY(workspace_id,authority_id,id)
  REFERENCES app.property_predator_whatsapp_live_authorities(workspace_id,id,event_send_id) ON DELETE RESTRICT,
 ADD CONSTRAINT mhp_event_whatsapp_send_job_fk FOREIGN KEY(workspace_id,job_id) REFERENCES app.property_predator_whatsapp_live_jobs(workspace_id,id) ON DELETE RESTRICT;

-- 5. Forced RLS and closed definers (no runtime table access).
ALTER TABLE app_private.mhp_event_whatsapp_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.mhp_event_whatsapp_intents FORCE ROW LEVEL SECURITY;
ALTER TABLE app_private.mhp_event_whatsapp_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.mhp_event_whatsapp_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE app_private.mhp_whatsapp_template_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.mhp_whatsapp_template_observations FORCE ROW LEVEL SECURITY;
ALTER TABLE app_private.mhp_event_whatsapp_sends ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.mhp_event_whatsapp_sends FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.mhp_event_whatsapp_intents,app_private.mhp_event_whatsapp_receipts,
 app_private.mhp_whatsapp_template_observations,app_private.mhp_event_whatsapp_sends FROM PUBLIC;
DO $owner$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['mhp_event_whatsapp_intents','mhp_event_whatsapp_receipts','mhp_whatsapp_template_observations','mhp_event_whatsapp_sends'] LOOP
  EXECUTE format('CREATE POLICY %I ON app_private.%I TO r72_owner USING(true) WITH CHECK(true)',t||'_owner',t);
 END LOOP;
END $owner$;
-- Public registrant boundary (prospect definer, identity command session only).
GRANT SELECT,INSERT,UPDATE ON app_private.mhp_event_whatsapp_intents TO r72_mhp_prospect_definer,r72_whatsapp_live_definer;
GRANT SELECT,INSERT ON app_private.mhp_event_whatsapp_receipts TO r72_mhp_prospect_definer,r72_whatsapp_live_definer;
CREATE POLICY mhp_event_whatsapp_intents_public ON app_private.mhp_event_whatsapp_intents TO r72_mhp_prospect_definer
 USING(session_user='r72_identity_command') WITH CHECK(session_user='r72_identity_command');
CREATE POLICY mhp_event_whatsapp_receipts_public ON app_private.mhp_event_whatsapp_receipts TO r72_mhp_prospect_definer
 USING(session_user='r72_identity_command')
 WITH CHECK(session_user='r72_identity_command' AND decision='withdrawn' AND proof_kind='public_event_withdrawal');
GRANT SELECT,UPDATE ON app_private.mhp_event_whatsapp_sends TO r72_mhp_prospect_definer;
-- Public withdrawal and the content new-version trigger hold steps; the immutable guard limits them to hold fields.
CREATE POLICY mhp_event_whatsapp_sends_prospect_hold ON app_private.mhp_event_whatsapp_sends TO r72_mhp_prospect_definer
 USING(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b') WITH CHECK(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b');
CREATE POLICY mhp_event_whatsapp_consent_public ON app.communication_consent_events FOR INSERT TO r72_mhp_prospect_definer
 WITH CHECK(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND session_user='r72_identity_command'
  AND channel='whatsapp' AND purpose~'^mhp\.webinar\.[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND state='withdrawn'
  AND source='mhp.event-whatsapp.withdraw' AND actor_kind='system' AND actor_user_id IS NULL);
CREATE POLICY mhp_event_whatsapp_programme_items_read ON app.company_content_items FOR SELECT TO r72_mhp_prospect_definer
 USING(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND source_system='mhp.event-whatsapp');
CREATE POLICY mhp_event_whatsapp_programme_versions_read ON app.company_content_versions FOR SELECT TO r72_mhp_prospect_definer
 USING(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND source_system='mhp.event-whatsapp');
DO $policies$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['company_content_source_attestations','company_content_approval_requests','company_content_approval_decisions'] LOOP
  EXECUTE format('CREATE POLICY mhp_event_whatsapp_programme_local_read ON app.%I FOR SELECT TO r72_mhp_prospect_definer USING (
   workspace_id=''2789228d-55a6-4688-b1e8-2f70abca990b'' AND EXISTS(SELECT 1 FROM app.company_content_versions v
    WHERE v.workspace_id=%I.workspace_id AND v.id=%I.content_version_id AND v.source_system=''mhp.event-whatsapp''))',t,t,t);
 END LOOP;
END $policies$;
-- WhatsApp definer: webhook (JOIN/STOP), owner (review/activate), worker (observe/prepare).
CREATE POLICY mhp_event_whatsapp_intents_wa ON app_private.mhp_event_whatsapp_intents TO r72_whatsapp_live_definer
 USING(session_user IN('r72_whatsapp_live_webhook_command','r72_whatsapp_live_command','r72_whatsapp_live_worker_command')
  AND current_setting('app.workspace_id',true)='2789228d-55a6-4688-b1e8-2f70abca990b')
 WITH CHECK(session_user='r72_whatsapp_live_webhook_command' AND current_setting('app.actor_kind',true)='webhook');
CREATE POLICY mhp_event_whatsapp_receipts_wa_read ON app_private.mhp_event_whatsapp_receipts FOR SELECT TO r72_whatsapp_live_definer
 USING(session_user IN('r72_whatsapp_live_webhook_command','r72_whatsapp_live_command','r72_whatsapp_live_worker_command')
  AND current_setting('app.workspace_id',true)='2789228d-55a6-4688-b1e8-2f70abca990b');
CREATE POLICY mhp_event_whatsapp_receipts_wa_signed ON app_private.mhp_event_whatsapp_receipts FOR INSERT TO r72_whatsapp_live_definer
 WITH CHECK(session_user='r72_whatsapp_live_webhook_command' AND current_setting('app.actor_kind',true)='webhook'
  AND proof_kind IN('signed_meta_join','signed_meta_stop'));
GRANT SELECT,INSERT ON app_private.mhp_whatsapp_template_observations TO r72_whatsapp_live_definer;
CREATE POLICY mhp_whatsapp_template_observations_read ON app_private.mhp_whatsapp_template_observations FOR SELECT TO r72_whatsapp_live_definer
 USING(session_user IN('r72_whatsapp_live_command','r72_whatsapp_live_worker_command')
  AND current_setting('app.workspace_id',true)='2789228d-55a6-4688-b1e8-2f70abca990b');
CREATE POLICY mhp_whatsapp_template_observations_worker ON app_private.mhp_whatsapp_template_observations FOR INSERT TO r72_whatsapp_live_definer
 WITH CHECK(session_user='r72_whatsapp_live_worker_command' AND current_setting('app.actor_kind',true)='worker'
  AND observed_by_role='r72_whatsapp_live_worker_command' AND observed_request_id=current_setting('app.request_id',true));
GRANT SELECT,INSERT,UPDATE ON app_private.mhp_event_whatsapp_sends TO r72_whatsapp_live_definer;
CREATE POLICY mhp_event_whatsapp_sends_wa_read ON app_private.mhp_event_whatsapp_sends FOR SELECT TO r72_whatsapp_live_definer
 USING(current_setting('app.workspace_id',true)='2789228d-55a6-4688-b1e8-2f70abca990b');
CREATE POLICY mhp_event_whatsapp_sends_wa_insert ON app_private.mhp_event_whatsapp_sends FOR INSERT TO r72_whatsapp_live_definer
 WITH CHECK(session_user='r72_whatsapp_live_command' AND current_setting('app.actor_kind',true)='user'
  AND activation_actor_user_id=nullif(current_setting('app.user_id',true),'')::uuid AND activation_request_id=current_setting('app.request_id',true));
CREATE POLICY mhp_event_whatsapp_sends_wa_update ON app_private.mhp_event_whatsapp_sends FOR UPDATE TO r72_whatsapp_live_definer
 USING(session_user IN('r72_whatsapp_live_command','r72_whatsapp_live_worker_command','r72_whatsapp_live_webhook_command')) WITH CHECK(true);
GRANT SELECT ON app_private.mhp_prospects,app_private.mhp_prospect_signups,app_private.mhp_event_phone_intents TO r72_whatsapp_live_definer;
CREATE POLICY mhp_event_whatsapp_prospects_read ON app_private.mhp_prospects FOR SELECT TO r72_whatsapp_live_definer
 USING(current_setting('app.workspace_id',true)='2789228d-55a6-4688-b1e8-2f70abca990b');
CREATE POLICY mhp_event_whatsapp_signups_read ON app_private.mhp_prospect_signups FOR SELECT TO r72_whatsapp_live_definer
 USING(current_setting('app.workspace_id',true)='2789228d-55a6-4688-b1e8-2f70abca990b');
CREATE POLICY mhp_event_whatsapp_access_read ON app_private.mhp_event_phone_intents FOR SELECT TO r72_whatsapp_live_definer
 USING(current_setting('app.workspace_id',true)='2789228d-55a6-4688-b1e8-2f70abca990b' AND kind='access');
-- Signed JOIN may create the one proved contact and its proved points; STOP appends suppression.
GRANT INSERT ON app.contacts TO r72_whatsapp_live_definer;
CREATE POLICY mhp_event_whatsapp_contact_insert ON app.contacts FOR INSERT TO r72_whatsapp_live_definer
 WITH CHECK(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND session_user='r72_whatsapp_live_webhook_command'
  AND current_setting('app.actor_kind',true)='webhook' AND owner_user_id IS NULL AND lifecycle_status='lead'
  AND source~'^mhp:event-whatsapp:webinar-[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND deleted_at IS NULL);
GRANT INSERT ON app.contact_points TO r72_whatsapp_live_definer;
GRANT UPDATE(is_verified,row_version,updated_at) ON app.contact_points TO r72_whatsapp_live_definer;
CREATE POLICY mhp_event_whatsapp_point_insert ON app.contact_points FOR INSERT TO r72_whatsapp_live_definer
 WITH CHECK(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND session_user='r72_whatsapp_live_webhook_command'
  AND current_setting('app.actor_kind',true)='webhook' AND kind IN('whatsapp','email') AND consent_status='unknown'
  AND dedupe_state='normal' AND deleted_at IS NULL AND NOT is_primary AND (kind='email' OR NOT is_verified));
CREATE POLICY mhp_event_whatsapp_point_verify ON app.contact_points FOR UPDATE TO r72_whatsapp_live_definer
 USING(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND kind='whatsapp' AND NOT is_verified AND session_user='r72_whatsapp_live_webhook_command')
 WITH CHECK(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND kind='whatsapp' AND is_verified);
GRANT INSERT ON app.communication_consent_events,app.communication_suppression_events TO r72_whatsapp_live_definer;
CREATE POLICY mhp_event_whatsapp_consent_signed ON app.communication_consent_events FOR INSERT TO r72_whatsapp_live_definer
 WITH CHECK(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND session_user='r72_whatsapp_live_webhook_command'
  AND current_setting('app.actor_kind',true)='webhook' AND channel='whatsapp' AND purpose~'^mhp\.webinar\.[0-9]{4}-[0-9]{2}-[0-9]{2}$'
  AND ((state='granted' AND lawful_basis='consent' AND source='mhp.event-whatsapp.join' AND policy_version='mhp.event-whatsapp/v1')
   OR (state='withdrawn' AND source='mhp.event-whatsapp.stop')) AND actor_kind='webhook' AND actor_user_id IS NULL);
CREATE POLICY mhp_event_whatsapp_stop_suppression ON app.communication_suppression_events FOR INSERT TO r72_whatsapp_live_definer
 WITH CHECK(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND session_user='r72_whatsapp_live_webhook_command'
  AND current_setting('app.actor_kind',true)='webhook' AND channel='whatsapp' AND purpose IS NULL AND state='suppressed'
  AND reason='whatsapp_stop' AND source='meta.whatsapp.webhook' AND actor_kind='webhook' AND actor_user_id IS NULL);
-- Owner activation: command receipts and the per-recipient operational review chain.
GRANT SELECT,INSERT ON app.command_receipts TO r72_whatsapp_live_definer;
GRANT UPDATE(result,status,response_status,completed_at) ON app.command_receipts TO r72_whatsapp_live_definer;
CREATE POLICY mhp_event_whatsapp_command_receipts ON app.command_receipts TO r72_whatsapp_live_definer
 USING(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND command_name IN('mhp.event-whatsapp.activate','mhp.event-whatsapp.control')
  AND actor_user_id=nullif(current_setting('app.user_id',true),'')::uuid)
 WITH CHECK(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND command_name IN('mhp.event-whatsapp.activate','mhp.event-whatsapp.control')
  AND actor_user_id=nullif(current_setting('app.user_id',true),'')::uuid AND current_setting('app.actor_kind',true)='user' AND session_user='r72_whatsapp_live_command');
GRANT SELECT,INSERT ON app_private.affiliate_compliance_subjects,app_private.affiliate_compliance_policy_pack_versions,
 app_private.affiliate_compliance_policy_review_events,app_private.affiliate_compliance_policy_publication_events,
 app_private.affiliate_compliance_specialist_decision_events TO r72_whatsapp_live_definer;
DO $policies$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['affiliate_compliance_subjects','affiliate_compliance_policy_pack_versions','affiliate_compliance_policy_review_events',
  'affiliate_compliance_policy_publication_events','affiliate_compliance_specialist_decision_events'] LOOP
  EXECUTE format('CREATE POLICY mhp_event_whatsapp_operational_review ON app_private.%I FOR INSERT TO r72_whatsapp_live_definer
   WITH CHECK(workspace_id=''2789228d-55a6-4688-b1e8-2f70abca990b'' AND current_setting(''app.actor_kind'',true)=''user'' AND session_user=''r72_whatsapp_live_command''
    AND recorded_by_user_id=nullif(current_setting(''app.user_id'',true),'''')::uuid AND recorded_request_id=current_setting(''app.request_id'',true))',t);
 END LOOP;
END $policies$;
CREATE POLICY mhp_event_whatsapp_subjects_read ON app_private.affiliate_compliance_subjects FOR SELECT TO r72_whatsapp_live_definer
 USING(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b');
CREATE POLICY mhp_event_whatsapp_packs_read ON app_private.affiliate_compliance_policy_pack_versions FOR SELECT TO r72_whatsapp_live_definer
 USING(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b');
CREATE POLICY mhp_event_whatsapp_contacts_read ON app.contacts FOR SELECT TO r72_whatsapp_live_definer
 USING(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND session_user IN('r72_whatsapp_live_webhook_command','r72_whatsapp_live_command','r72_whatsapp_live_worker_command'));
GRANT EXECUTE ON FUNCTION app_private.mhp_owner_email_authorize(bytea) TO r72_whatsapp_live_definer;
GRANT EXECUTE ON FUNCTION app_private.mhp_event_phone_lock(text[]),app_private.mhp_event_phone_mask(text) TO r72_whatsapp_live_definer;
GRANT CREATE ON SCHEMA app_private TO r72_whatsapp_live_definer,r72_mhp_prospect_definer;

-- 6. WhatsApp programme, consent text and public registrant functions.
SET LOCAL ROLE r72_mhp_prospect_definer;
CREATE FUNCTION app_private.mhp_event_whatsapp_consent_text(p_revision text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $f$
 SELECT CASE p_revision WHEN 'mhp.event-whatsapp/v1' THEN
  'Send me a WhatsApp follow-up about this Martin Howard Property webinar at this number. These messages are only about this webinar, not other marketing. Reply STOP to opt out.'
 END
$f$;

CREATE FUNCTION app_private.mhp_event_whatsapp_programme_exact(p_version uuid,p_latest boolean) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE v app.company_content_versions%ROWTYPE; d jsonb; local jsonb; manifest jsonb; brand jsonb; keys text[]; event text;
 starts timestamptz; due timestamptz; admission timestamptz; deadline timestamptz; source jsonb; approval uuid; body text;
BEGIN
 SELECT * INTO v FROM app.company_content_versions WHERE workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND id=p_version
  AND source_system='mhp.event-whatsapp';
 IF NOT FOUND OR v.content_kind<>'other' OR v.content_mime_type<>'application/vnd.growthhq.event-whatsapp+json'
  OR v.source_item_id!~'^event-whatsapp:webinar-[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR v.source_version!~'^edit:[0-9a-f-]{36}$'
 THEN RAISE EXCEPTION 'Event WhatsApp programme unavailable' USING ERRCODE='23514'; END IF;
 event:=substr(v.source_item_id,16);
 d:=v.content_body::jsonb; local:=v.metadata->'mhpEventWhatsApp'; brand:=app_private.mhp_owner_email_brand();
 SELECT array_agg(k ORDER BY k) INTO keys FROM jsonb_object_keys(d) k;
 IF keys IS DISTINCT FROM ARRAY['admissionUntil','channel','consentRevision','consentTextSha256','dueAt','event','metaTemplateId','providerDeadline',
   'schema','sourceContentItemId','sourceContentSha256','sourceContentVersionId','startsAt','stepKey','whatsappBindingId']
  OR d->>'schema' IS DISTINCT FROM 'mhp.event-whatsapp/v1' OR d->>'event' IS DISTINCT FROM event OR d->>'channel' IS DISTINCT FROM 'whatsapp'
  OR jsonb_typeof(d->'stepKey') IS DISTINCT FROM 'string' OR d->>'stepKey'!~'^event_wa_[a-z0-9]{1,20}$'
  OR d->>'consentRevision' IS DISTINCT FROM 'mhp.event-whatsapp/v1'
  OR d->>'consentTextSha256' IS DISTINCT FROM encode(public.digest(app_private.mhp_event_whatsapp_consent_text('mhp.event-whatsapp/v1'),'sha256'),'hex')
  OR jsonb_typeof(d->'whatsappBindingId') IS DISTINCT FROM 'string' OR d->>'whatsappBindingId'!~'^[0-9a-f-]{36}$'
  OR jsonb_typeof(d->'metaTemplateId') IS DISTINCT FROM 'string' OR d->>'metaTemplateId'!~'^[1-9][0-9]{4,29}$'
  OR jsonb_typeof(d->'sourceContentItemId') IS DISTINCT FROM 'string' OR d->>'sourceContentItemId'!~'^[0-9a-f-]{36}$'
  OR jsonb_typeof(d->'sourceContentVersionId') IS DISTINCT FROM 'string' OR d->>'sourceContentVersionId'!~'^[0-9a-f-]{36}$'
  OR jsonb_typeof(d->'sourceContentSha256') IS DISTINCT FROM 'string' OR d->>'sourceContentSha256'!~'^[0-9a-f]{64}$'
  OR app_private.mhp_sequence_canonical(d) IS DISTINCT FROM v.content_body OR public.digest(v.content_body,'sha256') IS DISTINCT FROM v.content_sha256
  OR v.blob_sha256 IS DISTINCT FROM v.content_sha256 OR v.blob_storage_key IS DISTINCT FROM 'inline:mhp.event-whatsapp:'||encode(v.content_sha256,'hex')
  OR local->>'schema' IS DISTINCT FROM 'mhp.event-whatsapp-local/v1' OR local->>'authoredBy' IS DISTINCT FROM 'native-owner'
  OR local->>'brandCanonical' IS DISTINCT FROM brand->>'canonical' OR v.brand_snapshot_ref IS DISTINCT FROM brand->>'ref'
  OR encode(v.brand_sha256,'hex') IS DISTINCT FROM brand->>'sha256'
 THEN RAISE EXCEPTION 'Event WhatsApp programme bytes or brand changed' USING ERRCODE='23514'; END IF;
 manifest:=(local->>'manifestCanonical')::jsonb;
 IF app_private.mhp_sequence_canonical(manifest) IS DISTINCT FROM local->>'manifestCanonical'
  OR manifest IS DISTINCT FROM jsonb_build_object('schema','mhp.event-whatsapp-source/v1','workspaceId',v.workspace_id::text,
   'sourceSystem',v.source_system,'sourceItemId',v.source_item_id,'sourceVersion',v.source_version,'contentSha256',encode(v.content_sha256,'hex'),
   'blobStorageKey',v.blob_storage_key,'blobSha256',encode(v.blob_sha256,'hex'),'brandSnapshotRef',v.brand_snapshot_ref,'brandSha256',encode(v.brand_sha256,'hex'))
  OR local->>'manifestSha256' IS DISTINCT FROM encode(public.digest(local->>'manifestCanonical','sha256'),'hex')
 THEN RAISE EXCEPTION 'Event WhatsApp programme manifest mismatch' USING ERRCODE='23514'; END IF;
 starts:=app_private.mhp_event_phone_time(d,'startsAt'); due:=app_private.mhp_event_phone_time(d,'dueAt');
 admission:=app_private.mhp_event_phone_time(d,'admissionUntil'); deadline:=app_private.mhp_event_phone_time(d,'providerDeadline');
 IF to_char(starts AT TIME ZONE 'UTC','YYYY-MM-DD')<>substr(event,9) OR NOT(starts<=due AND due<deadline AND deadline<=due+interval '24 hours'
  AND admission<=due AND due-starts<=interval '7 days')
 THEN RAISE EXCEPTION 'Event WhatsApp programme window is invalid' USING ERRCODE='23514'; END IF;
 IF p_latest AND EXISTS(SELECT 1 FROM app.company_content_versions n WHERE n.workspace_id=v.workspace_id AND n.content_item_id=v.content_item_id
  AND n.version_number>v.version_number) THEN RAISE EXCEPTION 'A newer event WhatsApp programme draft exists' USING ERRCODE='23514'; END IF;
 IF NOT app_private.mhp_marketing_workspace_allowed(v.created_by_user_id,v.workspace_id)
 THEN RAISE EXCEPTION 'Event WhatsApp programme author permission changed' USING ERRCODE='42501'; END IF;
 SELECT dd.id INTO approval FROM app.company_content_approval_decisions dd
 JOIN app.company_content_approval_requests r ON r.workspace_id=dd.workspace_id AND r.id=dd.approval_request_id
 WHERE dd.workspace_id=v.workspace_id AND dd.content_version_id=v.id AND dd.content_sha256=v.content_sha256 AND dd.decision='approved'
  AND app_private.mhp_marketing_workspace_allowed(dd.decided_by_user_id,dd.workspace_id)
  AND r.request_number=(SELECT max(n.request_number) FROM app.company_content_approval_requests n WHERE n.workspace_id=v.workspace_id AND n.content_version_id=v.id)
 ORDER BY dd.decided_at DESC,dd.id DESC LIMIT 1;
 source:=app_private.mhp_owner_channel_exact((d->>'sourceContentVersionId')::uuid,p_latest);
 body:=source->'payload'->>'bodyText';
 IF source->>'channel' IS DISTINCT FROM 'whatsapp' OR source->>'contentItemId' IS DISTINCT FROM d->>'sourceContentItemId'
  OR source->>'contentSha256' IS DISTINCT FROM d->>'sourceContentSha256' OR body~'\{\{[0-9]+\}\}'
 THEN RAISE EXCEPTION 'Event WhatsApp template draft changed or has parameters' USING ERRCODE='23514'; END IF;
 RETURN jsonb_build_object('programmeItemId',v.content_item_id,'programmeVersionId',v.id,'programmeSha256',encode(v.content_sha256,'hex'),
  'approvalId',approval,'event',event,'purpose','mhp.webinar.'||substr(event,9),'stepKey',d->>'stepKey',
  'startsAt',d->>'startsAt','dueAt',d->>'dueAt','admissionUntil',d->>'admissionUntil','providerDeadline',d->>'providerDeadline',
  'consentRevision',d->>'consentRevision','consentTextSha256',d->>'consentTextSha256','whatsappBindingId',d->>'whatsappBindingId',
  'metaTemplateId',d->>'metaTemplateId','sourceContentItemId',d->>'sourceContentItemId','sourceContentVersionId',d->>'sourceContentVersionId',
  'sourceContentSha256',d->>'sourceContentSha256','templateName',source->'payload'->>'templateName','language',source->'payload'->>'language',
  'bodyText',body,'bodySha256',encode(public.digest(body,'sha256'),'hex'));
END $f$;

CREATE FUNCTION app_private.mhp_event_whatsapp_current_programme() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE candidate uuid; exact jsonb;
BEGIN
 FOR candidate IN SELECT v.id FROM app.company_content_versions v WHERE v.workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b'
  AND v.source_system='mhp.event-whatsapp' AND NOT EXISTS(SELECT 1 FROM app.company_content_versions n WHERE n.workspace_id=v.workspace_id
   AND n.content_item_id=v.content_item_id AND n.version_number>v.version_number) ORDER BY v.source_item_id,v.id LOOP
  BEGIN exact:=app_private.mhp_event_whatsapp_programme_exact(candidate,true);
  EXCEPTION WHEN sqlstate '23514' OR sqlstate '42501' OR sqlstate '22P02' THEN exact:=NULL; END;
  IF exact IS NOT NULL AND exact->>'approvalId' IS NOT NULL AND (exact->>'admissionUntil')::timestamptz>statement_timestamp() THEN RETURN exact; END IF;
 END LOOP;
 RETURN NULL;
END $f$;

CREATE FUNCTION app_private.mhp_event_whatsapp_current_receipt(p_prospect uuid,p_campaign text) RETURNS uuid
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $f$
 SELECT r.id FROM (SELECT x.* FROM app_private.mhp_event_whatsapp_receipts x WHERE x.prospect_id=p_prospect AND x.campaign=p_campaign
   ORDER BY x.occurred_at DESC,x.recorded_at DESC,x.id DESC LIMIT 1) r
 JOIN app_private.mhp_event_whatsapp_intents i ON i.id=r.intent_id AND i.revision=r.intent_revision AND i.state='verified'
  AND i.result_receipt_id=r.id AND i.point_id=r.contact_point_id
 WHERE r.decision='granted' AND i.revision=(SELECT max(n.revision) FROM app_private.mhp_event_whatsapp_intents n
   WHERE n.prospect_id=p_prospect AND n.campaign=p_campaign)
$f$;
REVOKE ALL ON FUNCTION app_private.mhp_event_whatsapp_consent_text(text),app_private.mhp_event_whatsapp_programme_exact(uuid,boolean),
 app_private.mhp_event_whatsapp_current_programme(),app_private.mhp_event_whatsapp_current_receipt(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.mhp_event_whatsapp_consent_text(text),app_private.mhp_event_whatsapp_programme_exact(uuid,boolean),
 app_private.mhp_event_whatsapp_current_programme(),app_private.mhp_event_whatsapp_current_receipt(uuid,text),
 app_private.mhp_event_phone_signup(uuid,text) TO r72_whatsapp_live_definer;

CREATE FUNCTION app_private.mhp_event_whatsapp_status(p_capability_sha bytea) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE access app_private.mhp_event_phone_intents%ROWTYPE; programme jsonb; latest app_private.mhp_event_whatsapp_intents%ROWTYPE;
BEGIN
 IF session_user<>'r72_identity_command' OR octet_length(p_capability_sha) IS DISTINCT FROM 32
 THEN RAISE EXCEPTION 'Invalid event reminder session' USING ERRCODE='22023'; END IF;
 access:=app_private.mhp_event_phone_access(p_capability_sha,false);
 IF access.id IS NULL THEN RETURN jsonb_build_object('ok',false); END IF;
 programme:=app_private.mhp_event_whatsapp_current_programme();
 SELECT * INTO latest FROM app_private.mhp_event_whatsapp_intents i WHERE i.prospect_id=access.prospect_id AND i.campaign=access.campaign
 ORDER BY i.revision DESC LIMIT 1;
 RETURN jsonb_build_object('ok',true,'campaign',access.campaign,
  'open',programme IS NOT NULL AND programme->>'event'=access.campaign,
  'consentRevision',programme->>'consentRevision','consentText',app_private.mhp_event_whatsapp_consent_text(programme->>'consentRevision'),
  'whatsapp',CASE WHEN latest.id IS NULL THEN NULL ELSE jsonb_build_object('state',latest.state,'revision',latest.revision,
   'phoneMasked',app_private.mhp_event_phone_mask(latest.phone_e164),
   'joinExpiresAt',to_char(latest.join_expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
   'grantReceiptId',app_private.mhp_event_whatsapp_current_receipt(access.prospect_id,access.campaign)) END);
END $f$;

CREATE FUNCTION app_private.mhp_event_whatsapp_choose(p_capability_sha bytea,p_command uuid,p_phone text,p_consent_revision text,p_consent_text_sha bytea,
 p_join_nonce_sha bytea,p_payload_sha bytea,p_source_sha bytea) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE access app_private.mhp_event_phone_intents%ROWTYPE; programme jsonb; key_sha bytea; existing app_private.mhp_event_whatsapp_intents%ROWTYPE;
 previous app_private.mhp_event_whatsapp_intents%ROWTYPE; granted app_private.mhp_event_whatsapp_receipts%ROWTYPE; phone_sha bytea; created uuid;
 join_expiry timestamptz; withdrawal_consent uuid:=gen_random_uuid(); now_at timestamptz:=statement_timestamp();
BEGIN
 IF session_user<>'r72_identity_command' OR octet_length(p_capability_sha) IS DISTINCT FROM 32 OR p_command IS NULL
  OR p_phone IS NULL OR p_phone!~'^\+447[0-9]{9}$' OR p_consent_revision IS NULL OR octet_length(p_consent_text_sha) IS DISTINCT FROM 32
  OR octet_length(p_join_nonce_sha) IS DISTINCT FROM 32 OR octet_length(p_payload_sha) IS DISTINCT FROM 32 OR octet_length(p_source_sha) IS DISTINCT FROM 32
 THEN RAISE EXCEPTION 'Invalid event WhatsApp choice' USING ERRCODE='22023'; END IF;
 key_sha:=public.digest('mhp.event-whatsapp.choose:'||p_command::text,'sha256');
 SELECT * INTO existing FROM app_private.mhp_event_whatsapp_intents i WHERE i.workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND i.request_key_sha256=key_sha;
 IF FOUND THEN
  IF existing.payload_sha256 IS DISTINCT FROM p_payload_sha THEN RAISE EXCEPTION 'Event WhatsApp choice conflicts' USING ERRCODE='40001'; END IF;
  RETURN jsonb_build_object('ok',true,'replayed',true,'intentId',existing.id,'revision',existing.revision,
   'joinExpiresAt',to_char(existing.join_expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'));
 END IF;
 access:=app_private.mhp_event_phone_access(p_capability_sha,true);
 IF access.id IS NULL THEN RETURN jsonb_build_object('ok',false,'reason','session'); END IF;
 programme:=app_private.mhp_event_whatsapp_current_programme();
 IF programme IS NULL OR programme->>'event' IS DISTINCT FROM access.campaign THEN RETURN jsonb_build_object('ok',false,'reason','closed'); END IF;
 IF p_consent_revision IS DISTINCT FROM programme->>'consentRevision' OR encode(p_consent_text_sha,'hex') IS DISTINCT FROM programme->>'consentTextSha256'
 THEN RAISE EXCEPTION 'Event WhatsApp wording changed' USING ERRCODE='40001'; END IF;
 phone_sha:=public.digest(p_phone,'sha256');
 PERFORM app_private.mhp_event_phone_lock(ARRAY['mhp.event-whatsapp.prospect:'||access.campaign||':'||access.prospect_id::text,'mhp.event-whatsapp.phone:'||p_phone]);
 IF EXISTS(SELECT 1 FROM app_private.mhp_event_whatsapp_intents i WHERE i.workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND i.request_key_sha256=key_sha)
 THEN RAISE EXCEPTION 'Event WhatsApp choice raced' USING ERRCODE='40001'; END IF;
 IF (SELECT count(*) FROM app_private.mhp_event_whatsapp_intents i WHERE i.phone_identity_sha256=phone_sha AND i.created_at>now_at-interval '1 hour')>=3
  OR EXISTS(SELECT 1 FROM app_private.mhp_event_whatsapp_intents i WHERE i.prospect_id=access.prospect_id AND i.campaign=access.campaign
   AND i.created_at>now_at-interval '60 seconds')
 THEN RAISE EXCEPTION 'Event WhatsApp choice limit' USING ERRCODE='54000'; END IF;
 IF EXISTS(SELECT 1 FROM app_private.mhp_event_whatsapp_intents i WHERE i.campaign=access.campaign AND i.phone_e164=p_phone
  AND i.prospect_id<>access.prospect_id AND i.state IN('awaiting_join','verified','held'))
 THEN RETURN jsonb_build_object('ok',false,'reason','number_unavailable'); END IF;
 SELECT * INTO previous FROM app_private.mhp_event_whatsapp_intents i WHERE i.prospect_id=access.prospect_id AND i.campaign=access.campaign
 ORDER BY i.revision DESC LIMIT 1 FOR UPDATE;
 IF previous.state='verified' AND previous.phone_e164=p_phone THEN
  RETURN jsonb_build_object('ok',true,'replayed',false,'alreadyVerified',true,'intentId',previous.id,'revision',previous.revision);
 END IF;
 IF previous.state='awaiting_join' THEN
  UPDATE app_private.mhp_event_whatsapp_intents SET state='superseded',updated_at=now_at WHERE id=previous.id;
 ELSIF previous.state='verified' THEN
  SELECT * INTO granted FROM app_private.mhp_event_whatsapp_receipts r WHERE r.id=previous.result_receipt_id;
  INSERT INTO app.communication_consent_events(id,workspace_id,contact_id,contact_point_id,channel,purpose,state,lawful_basis,source,policy_version,
   policy_text_sha256,source_event_id,actor_kind,actor_user_id,evidence,endpoint_identity_sha256,occurred_at)
  VALUES(withdrawal_consent,granted.workspace_id,granted.contact_id,granted.contact_point_id,'whatsapp',granted.purpose,'withdrawn',NULL,'mhp.event-whatsapp.withdraw',
   granted.consent_revision,granted.consent_text_sha256,'mhp.event-whatsapp.number-change:'||p_command::text,'system',NULL,
   jsonb_build_object('reason','number_changed','receiptId',granted.id),granted.endpoint_identity_sha256,now_at);
  INSERT INTO app_private.mhp_event_whatsapp_receipts(workspace_id,intent_id,intent_revision,campaign,prospect_id,signup_id,channel,purpose,contact_id,
   contact_point_id,endpoint_identity_sha256,phone_identity_sha256,decision,consent_revision,consent_text_sha256,consent_event_id,proof_kind,
   whatsapp_binding_id,occurred_at,supersedes_receipt_id,request_sha256)
  VALUES(granted.workspace_id,granted.intent_id,granted.intent_revision,granted.campaign,granted.prospect_id,granted.signup_id,'whatsapp',granted.purpose,
   granted.contact_id,granted.contact_point_id,granted.endpoint_identity_sha256,granted.phone_identity_sha256,'withdrawn',granted.consent_revision,
   granted.consent_text_sha256,withdrawal_consent,'public_event_withdrawal',granted.whatsapp_binding_id,now_at,granted.id,key_sha);
  UPDATE app_private.mhp_event_whatsapp_intents SET state='superseded',updated_at=now_at WHERE id=previous.id;
  UPDATE app_private.mhp_event_whatsapp_sends SET held_at=now_at,hold_reason='receipt_changed'
  WHERE receipt_id=granted.id AND cancelled_at IS NULL AND held_at IS NULL;
 END IF;
 join_expiry:=least(now_at+interval '10 minutes',(programme->>'admissionUntil')::timestamptz);
 IF join_expiry<=now_at THEN RETURN jsonb_build_object('ok',false,'reason','closed'); END IF;
 INSERT INTO app_private.mhp_event_whatsapp_intents(workspace_id,prospect_id,signup_id,campaign,programme_version_id,parent_access_id,revision,
  previous_intent_id,state,command_id,request_key_sha256,payload_sha256,source_sha256,phone_e164,phone_identity_sha256,consent_revision,
  consent_text_sha256,consent_chosen_at,join_nonce_sha256,join_expires_at)
 VALUES(access.workspace_id,access.prospect_id,access.signup_id,access.campaign,(programme->>'programmeVersionId')::uuid,access.id,
  coalesce(previous.revision,0)+1,previous.id,'awaiting_join',p_command,key_sha,p_payload_sha,p_source_sha,p_phone,phone_sha,
  p_consent_revision,p_consent_text_sha,now_at,p_join_nonce_sha,join_expiry) RETURNING id INTO created;
 RETURN jsonb_build_object('ok',true,'replayed',false,'intentId',created,'revision',coalesce(previous.revision,0)+1,
  'joinExpiresAt',to_char(join_expiry AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'));
END $f$;

CREATE FUNCTION app_private.mhp_event_whatsapp_withdraw(p_capability_sha bytea,p_command uuid,p_receipt uuid,p_payload_sha bytea) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE access app_private.mhp_event_phone_intents%ROWTYPE; granted app_private.mhp_event_whatsapp_receipts%ROWTYPE; request_sha bytea;
 consent uuid:=gen_random_uuid(); now_at timestamptz:=statement_timestamp();
BEGIN
 IF session_user<>'r72_identity_command' OR octet_length(p_capability_sha) IS DISTINCT FROM 32 OR p_command IS NULL OR p_receipt IS NULL
  OR octet_length(p_payload_sha) IS DISTINCT FROM 32 THEN RAISE EXCEPTION 'Invalid event WhatsApp withdrawal' USING ERRCODE='22023'; END IF;
 request_sha:=public.digest('mhp.event-whatsapp.withdraw:'||p_command::text||':'||encode(p_payload_sha,'hex'),'sha256');
 access:=app_private.mhp_event_phone_access(p_capability_sha,true);
 IF access.id IS NULL THEN RETURN jsonb_build_object('ok',false,'reason','session'); END IF;
 IF EXISTS(SELECT 1 FROM app_private.mhp_event_whatsapp_receipts r WHERE r.supersedes_receipt_id=p_receipt AND r.request_sha256=request_sha
  AND r.prospect_id=access.prospect_id) THEN RETURN jsonb_build_object('ok',true,'replayed',true); END IF;
 PERFORM app_private.mhp_event_phone_lock(ARRAY['mhp.event-whatsapp.prospect:'||access.campaign||':'||access.prospect_id::text]);
 IF app_private.mhp_event_whatsapp_current_receipt(access.prospect_id,access.campaign) IS DISTINCT FROM p_receipt
 THEN RETURN jsonb_build_object('ok',false,'reason','not_current'); END IF;
 SELECT * INTO granted FROM app_private.mhp_event_whatsapp_receipts r WHERE r.id=p_receipt;
 INSERT INTO app.communication_consent_events(id,workspace_id,contact_id,contact_point_id,channel,purpose,state,lawful_basis,source,policy_version,
  policy_text_sha256,source_event_id,actor_kind,actor_user_id,evidence,endpoint_identity_sha256,occurred_at)
 VALUES(consent,granted.workspace_id,granted.contact_id,granted.contact_point_id,'whatsapp',granted.purpose,'withdrawn',NULL,'mhp.event-whatsapp.withdraw',
  granted.consent_revision,granted.consent_text_sha256,'mhp.event-whatsapp.withdraw:'||p_command::text,'system',NULL,
  jsonb_build_object('reason','registrant_withdrew','receiptId',granted.id),granted.endpoint_identity_sha256,now_at);
 INSERT INTO app_private.mhp_event_whatsapp_receipts(workspace_id,intent_id,intent_revision,campaign,prospect_id,signup_id,channel,purpose,contact_id,
  contact_point_id,endpoint_identity_sha256,phone_identity_sha256,decision,consent_revision,consent_text_sha256,consent_event_id,proof_kind,
  whatsapp_binding_id,occurred_at,supersedes_receipt_id,request_sha256)
 VALUES(granted.workspace_id,granted.intent_id,granted.intent_revision,granted.campaign,granted.prospect_id,granted.signup_id,'whatsapp',granted.purpose,
  granted.contact_id,granted.contact_point_id,granted.endpoint_identity_sha256,granted.phone_identity_sha256,'withdrawn',granted.consent_revision,
  granted.consent_text_sha256,consent,'public_event_withdrawal',granted.whatsapp_binding_id,now_at,granted.id,request_sha);
 UPDATE app_private.mhp_event_whatsapp_intents SET state='withdrawn',updated_at=now_at WHERE id=granted.intent_id AND state='verified';
 UPDATE app_private.mhp_event_whatsapp_sends SET held_at=now_at,hold_reason='receipt_changed' WHERE receipt_id=granted.id AND cancelled_at IS NULL AND held_at IS NULL;
 RETURN jsonb_build_object('ok',true,'replayed',false);
END $f$;
REVOKE ALL ON FUNCTION app_private.mhp_event_whatsapp_status(bytea),app_private.mhp_event_whatsapp_choose(bytea,uuid,text,text,bytea,bytea,bytea,bytea),
 app_private.mhp_event_whatsapp_withdraw(bytea,uuid,uuid,bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.mhp_event_whatsapp_status(bytea),app_private.mhp_event_whatsapp_choose(bytea,uuid,text,text,bytea,bytea,bytea,bytea),
 app_private.mhp_event_whatsapp_withdraw(bytea,uuid,uuid,bytea) TO r72_identity_command;
RESET ROLE;
SET LOCAL ROLE r72_owner;

-- 6b. The email proof also opens for a WhatsApp-only follow-up programme. Exact
-- 0131 body; only the current-programme source is widened (compat test).
SET LOCAL ROLE r72_mhp_prospect_definer;
CREATE OR REPLACE FUNCTION app_private.mhp_event_phone_request_link(p_email text,p_command uuid,p_token_sha bytea,p_payload_sha bytea,p_source_sha bytea) RETURNS jsonb
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
 programme:=coalesce(app_private.mhp_event_phone_current_programme(),app_private.mhp_event_whatsapp_current_programme());
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
RESET ROLE;
SET LOCAL ROLE r72_owner;

-- 7. Signed WhatsApp inbound wrapper (r72_whatsapp_live_webhook_command). The
-- app-secret HMAC, WABA, phone-number id and sender are verified by the existing
-- 0053/0055 verifier BEFORE this call. 0055 bytes are unchanged; this wrapper
-- delegates to record_whatsapp_live_inbound_projection in the same transaction.
SET LOCAL ROLE r72_whatsapp_live_definer;
CREATE FUNCTION app_private.mhp_event_whatsapp_project(p_workspace uuid,p_binding uuid,p_external_event text,p_message_id text,p_sender text,
 p_body text,p_sender_sha bytea,p_body_sha bytea,p_payload_sha bytea,p_signature_sha bytea,p_event_identity_sha bytea,p_occurred timestamptz,
 p_tolerate_unknown boolean) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $f$
DECLARE outcome text;
BEGIN
 BEGIN
  SELECT p.disposition INTO outcome FROM app_private.record_whatsapp_live_inbound_projection(p_workspace,p_binding,p_external_event,p_message_id,
   p_sender,p_body,p_sender_sha,p_body_sha,p_payload_sha,p_signature_sha,p_event_identity_sha,p_occurred) p;
 EXCEPTION WHEN sqlstate '23503' THEN
  IF NOT p_tolerate_unknown THEN RAISE; END IF;
  outcome:='unprojected';
 END;
 RETURN outcome;
END $f$;
REVOKE ALL ON FUNCTION app_private.mhp_event_whatsapp_project(uuid,uuid,text,text,text,text,bytea,bytea,bytea,bytea,bytea,timestamptz,boolean) FROM PUBLIC;

CREATE FUNCTION app_private.mhp_record_event_whatsapp_inbound(p_workspace uuid,p_binding uuid,p_external_event text,p_message_id text,
 p_sender text,p_body text,p_sender_sha bytea,p_body_sha bytea,p_payload_sha bytea,p_signature_sha bytea,p_event_identity_sha bytea,
 p_occurred timestamptz) RETURNS TABLE(disposition text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE ws constant uuid:='2789228d-55a6-4688-b1e8-2f70abca990b'; nonce text; intent app_private.mhp_event_whatsapp_intents%ROWTYPE; programme jsonb;
 prospect app_private.mhp_prospects%ROWTYPE; phone text; wa_point app.contact_points%ROWTYPE; email_point app.contact_points%ROWTYPE;
 ambiguous boolean:=false; contact uuid; point uuid; endpoint_sha bytea; consent uuid:=gen_random_uuid(); receipt uuid:=gen_random_uuid();
 outcome text; now_at timestamptz:=statement_timestamp(); grant_row record; stop_point app.contact_points%ROWTYPE; withdrawn_consent uuid; is_stop boolean;
BEGIN
 IF session_user<>'r72_whatsapp_live_webhook_command' OR p_workspace IS DISTINCT FROM ws OR current_setting('app.workspace_id',true) IS DISTINCT FROM ws::text
  OR current_setting('app.actor_kind',true) IS DISTINCT FROM 'webhook' OR coalesce(current_setting('app.user_id',true),'')<>''
  OR p_binding IS NULL OR p_external_event IS NULL OR p_message_id IS NULL OR p_message_id!~'^wamid[.][A-Za-z0-9_=-]{1,190}$'
  OR p_sender IS NULL OR p_sender!~'^44[0-9]{9,10}$' OR p_body IS NULL
  OR p_sender_sha IS DISTINCT FROM public.digest(p_sender,'sha256') OR p_body_sha IS DISTINCT FROM public.digest(p_body,'sha256')
  OR octet_length(p_payload_sha) IS DISTINCT FROM 32 OR octet_length(p_signature_sha) IS DISTINCT FROM 32
  OR octet_length(p_event_identity_sha) IS DISTINCT FROM 32 OR p_occurred IS NULL
 THEN RAISE EXCEPTION 'MHP event WhatsApp inbound evidence is invalid' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT 1 FROM app.property_predator_whatsapp_live_bindings b WHERE b.workspace_id=ws AND b.id=p_binding AND b.status='active'
  AND NOT EXISTS(SELECT 1 FROM app.property_predator_whatsapp_live_binding_revocations r WHERE r.workspace_id=b.workspace_id AND r.binding_id=b.id))
 THEN RAISE EXCEPTION 'MHP event WhatsApp binding denied' USING ERRCODE='42501'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(format('mhp-wa-inbox:%s:%s:%s',p_workspace,p_binding,p_external_event),7200132));
 IF EXISTS(SELECT 1 FROM app_private.mhp_event_whatsapp_receipts r WHERE r.whatsapp_binding_id=p_binding AND r.provider_event_id=p_external_event)
  OR EXISTS(SELECT 1 FROM app_private.mhp_event_whatsapp_intents i WHERE i.consumed_provider_event_id=p_external_event) THEN
  outcome:=app_private.mhp_event_whatsapp_project(p_workspace,p_binding,p_external_event,p_message_id,p_sender,p_body,p_sender_sha,p_body_sha,
   p_payload_sha,p_signature_sha,p_event_identity_sha,p_occurred,true);
  RETURN QUERY SELECT CASE WHEN outcome='conflict' THEN 'conflict' ELSE 'replayed' END; RETURN;
 END IF;
 phone:='+'||p_sender;
 is_stop:=upper(btrim(p_body)) IN('STOP','STOPALL','UNSUBSCRIBE','CANCEL','END','QUIT','OPTOUT','OPT OUT');
 nonce:=lower(substring(p_body FROM '^[[:space:]]*[Jj][Oo][Ii][Nn][[:space:]]+([A-Za-z2-7]{26})[[:space:]]*$'));
 IF nonce IS NOT NULL THEN
  SELECT * INTO intent FROM app_private.mhp_event_whatsapp_intents i WHERE i.join_nonce_sha256=public.digest('mhp.event-whatsapp.join/v1:'||nonce,'sha256');
  IF intent.id IS NOT NULL THEN
   PERFORM app_private.mhp_event_phone_lock(ARRAY['mhp.event-whatsapp.prospect:'||intent.campaign||':'||intent.prospect_id::text,'mhp.event-whatsapp.phone:'||phone]);
   SELECT * INTO intent FROM app_private.mhp_event_whatsapp_intents i WHERE i.id=intent.id FOR UPDATE;
  END IF;
 END IF;
 IF intent.id IS NULL OR intent.state<>'awaiting_join' OR intent.phone_e164 IS DISTINCT FROM phone THEN
  outcome:=app_private.mhp_event_whatsapp_project(p_workspace,p_binding,p_external_event,p_message_id,p_sender,p_body,p_sender_sha,p_body_sha,
   p_payload_sha,p_signature_sha,p_event_identity_sha,p_occurred,false);
  IF outcome='applied' AND is_stop THEN
   -- Proposal 2 (unratified): WhatsApp STOP suppresses WhatsApp only, never SMS.
   SELECT p.* INTO stop_point FROM app.contact_points p WHERE p.workspace_id=ws AND p.kind='whatsapp' AND p.deleted_at IS NULL AND p.is_verified
    AND p.dedupe_state='normal' AND p.normalized_value=p_sender;
   INSERT INTO app.communication_suppression_events(workspace_id,contact_id,contact_point_id,channel,purpose,state,reason,source,source_event_id,
    actor_kind,actor_user_id,endpoint_identity_sha256,occurred_at)
   VALUES(ws,stop_point.contact_id,stop_point.id,'whatsapp',NULL,'suppressed','whatsapp_stop','meta.whatsapp.webhook',p_external_event,'webhook',NULL,
    public.digest(stop_point.kind||chr(31)||stop_point.value||chr(31)||stop_point.normalized_value,'sha256'),p_occurred);
   PERFORM app_private.mhp_event_phone_lock(coalesce((SELECT array_agg('mhp.event-whatsapp.prospect:'||i.campaign||':'||i.prospect_id::text)
    FROM app_private.mhp_event_whatsapp_intents i WHERE i.state='verified' AND i.point_id=stop_point.id),'{}'::text[]));
   FOR grant_row IN SELECT i.id AS intent_id,r.* FROM app_private.mhp_event_whatsapp_intents i
    JOIN app_private.mhp_event_whatsapp_receipts r ON r.id=i.result_receipt_id
    WHERE i.state='verified' AND i.point_id=stop_point.id ORDER BY i.campaign,i.prospect_id FOR UPDATE OF i LOOP
    IF app_private.mhp_event_whatsapp_current_receipt(grant_row.prospect_id,grant_row.campaign) IS DISTINCT FROM grant_row.id THEN CONTINUE; END IF;
    withdrawn_consent:=gen_random_uuid();
    INSERT INTO app.communication_consent_events(id,workspace_id,contact_id,contact_point_id,channel,purpose,state,lawful_basis,source,policy_version,
     policy_text_sha256,source_event_id,actor_kind,actor_user_id,evidence,endpoint_identity_sha256,occurred_at)
    VALUES(withdrawn_consent,ws,grant_row.contact_id,grant_row.contact_point_id,'whatsapp',grant_row.purpose,'withdrawn',NULL,'mhp.event-whatsapp.stop',
     grant_row.consent_revision,grant_row.consent_text_sha256,p_external_event,'webhook',NULL,
     jsonb_build_object('reason','signed_whatsapp_stop','receiptId',grant_row.id),grant_row.endpoint_identity_sha256,p_occurred);
    INSERT INTO app_private.mhp_event_whatsapp_receipts(workspace_id,intent_id,intent_revision,campaign,prospect_id,signup_id,channel,purpose,contact_id,
     contact_point_id,endpoint_identity_sha256,phone_identity_sha256,decision,consent_revision,consent_text_sha256,consent_event_id,proof_kind,
     whatsapp_binding_id,provider_event_id,provider_message_id,payload_sha256,signature_sha256,body_sha256,event_identity_sha256,occurred_at,
     supersedes_receipt_id,request_sha256)
    VALUES(ws,grant_row.intent_id,grant_row.intent_revision,grant_row.campaign,grant_row.prospect_id,grant_row.signup_id,'whatsapp',grant_row.purpose,
     grant_row.contact_id,grant_row.contact_point_id,grant_row.endpoint_identity_sha256,grant_row.phone_identity_sha256,'withdrawn',
     grant_row.consent_revision,grant_row.consent_text_sha256,withdrawn_consent,'signed_meta_stop',p_binding,p_external_event,p_message_id,
     p_payload_sha,p_signature_sha,p_body_sha,p_event_identity_sha,p_occurred,grant_row.id,p_event_identity_sha);
    UPDATE app_private.mhp_event_whatsapp_intents SET state='withdrawn',updated_at=now_at WHERE id=grant_row.intent_id;
    UPDATE app_private.mhp_event_whatsapp_sends SET held_at=now_at,hold_reason='receipt_changed' WHERE receipt_id=grant_row.id AND cancelled_at IS NULL AND held_at IS NULL;
   END LOOP;
  END IF;
  RETURN QUERY SELECT outcome; RETURN;
 END IF;
 IF intent.join_expires_at<=now_at THEN
  UPDATE app_private.mhp_event_whatsapp_intents SET state='expired',updated_at=now_at WHERE id=intent.id;
  PERFORM app_private.mhp_event_whatsapp_project(p_workspace,p_binding,p_external_event,p_message_id,p_sender,p_body,p_sender_sha,p_body_sha,
   p_payload_sha,p_signature_sha,p_event_identity_sha,p_occurred,true);
  RETURN QUERY SELECT 'event_join_expired'::text; RETURN;
 END IF;
 programme:=app_private.mhp_event_whatsapp_current_programme();
 IF programme IS NULL OR programme->>'event' IS DISTINCT FROM intent.campaign OR programme->>'consentRevision' IS DISTINCT FROM intent.consent_revision
  OR programme->>'consentTextSha256' IS DISTINCT FROM encode(intent.consent_text_sha256,'hex') OR programme->>'whatsappBindingId' IS DISTINCT FROM p_binding::text THEN
  UPDATE app_private.mhp_event_whatsapp_intents SET state='held',hold_reason='programme_changed',join_consumed_at=now_at,
   consumed_provider_event_id=p_external_event,updated_at=now_at WHERE id=intent.id;
  PERFORM app_private.mhp_event_whatsapp_project(p_workspace,p_binding,p_external_event,p_message_id,p_sender,p_body,p_sender_sha,p_body_sha,
   p_payload_sha,p_signature_sha,p_event_identity_sha,p_occurred,true);
  RETURN QUERY SELECT 'event_held'::text; RETURN;
 END IF;
 SELECT * INTO prospect FROM app_private.mhp_prospects p WHERE p.id=intent.prospect_id;
 -- WhatsApp points are stored digits-only (0053/0055 sender form); never merged with SMS points.
 IF (SELECT count(*) FROM app.contact_points p WHERE p.workspace_id=ws AND p.kind='whatsapp' AND p.normalized_value=p_sender AND p.deleted_at IS NULL)>1
  OR EXISTS(SELECT 1 FROM app.contact_points p WHERE p.workspace_id=ws AND p.kind='whatsapp' AND p.normalized_value=p_sender AND p.deleted_at IS NULL AND p.dedupe_state<>'normal')
  OR (SELECT count(*) FROM app.contact_points p WHERE p.workspace_id=ws AND p.kind='email' AND p.normalized_value=prospect.email::text AND p.deleted_at IS NULL)>1
  OR EXISTS(SELECT 1 FROM app.contact_points p WHERE p.workspace_id=ws AND p.kind='email' AND p.normalized_value=prospect.email::text AND p.deleted_at IS NULL AND p.dedupe_state<>'normal')
 THEN ambiguous:=true; END IF;
 SELECT p.* INTO wa_point FROM app.contact_points p WHERE p.workspace_id=ws AND p.kind='whatsapp' AND p.normalized_value=p_sender AND p.deleted_at IS NULL AND p.dedupe_state='normal';
 SELECT p.* INTO email_point FROM app.contact_points p WHERE p.workspace_id=ws AND p.kind='email' AND p.normalized_value=prospect.email::text AND p.deleted_at IS NULL AND p.dedupe_state='normal';
 IF wa_point.id IS NOT NULL AND email_point.id IS NOT NULL AND wa_point.contact_id<>email_point.contact_id THEN ambiguous:=true; END IF;
 contact:=coalesce(wa_point.contact_id,email_point.contact_id);
 IF contact IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app.contacts c WHERE c.workspace_id=ws AND c.id=contact AND c.deleted_at IS NULL) THEN ambiguous:=true; END IF;
 IF NOT ambiguous AND wa_point.id IS NOT NULL AND EXISTS(SELECT 1 FROM(SELECT DISTINCT ON(coalesce(s.purpose,'')) s.state FROM app.communication_suppression_events s
   WHERE s.workspace_id=ws AND s.contact_point_id=wa_point.id AND s.channel='whatsapp' AND(s.purpose IS NULL OR s.purpose=programme->>'purpose')
   ORDER BY coalesce(s.purpose,''),s.occurred_at DESC,s.recorded_at DESC,s.id DESC) latest WHERE latest.state='suppressed') THEN
  UPDATE app_private.mhp_event_whatsapp_intents SET state='held',hold_reason='suppressed',join_consumed_at=now_at,consumed_provider_event_id=p_external_event,updated_at=now_at WHERE id=intent.id;
  PERFORM app_private.mhp_event_whatsapp_project(p_workspace,p_binding,p_external_event,p_message_id,p_sender,p_body,p_sender_sha,p_body_sha,
   p_payload_sha,p_signature_sha,p_event_identity_sha,p_occurred,true);
  RETURN QUERY SELECT 'event_held'::text; RETURN;
 END IF;
 IF ambiguous THEN
  UPDATE app_private.mhp_event_whatsapp_intents SET state='held',hold_reason='crm_ambiguous',join_consumed_at=now_at,consumed_provider_event_id=p_external_event,updated_at=now_at WHERE id=intent.id;
  PERFORM app_private.mhp_event_whatsapp_project(p_workspace,p_binding,p_external_event,p_message_id,p_sender,p_body,p_sender_sha,p_body_sha,
   p_payload_sha,p_signature_sha,p_event_identity_sha,p_occurred,true);
  RETURN QUERY SELECT 'event_held'::text; RETURN;
 END IF;
 IF contact IS NULL THEN
  contact:=gen_random_uuid();
  INSERT INTO app.contacts(id,workspace_id,display_name,lifecycle_status,owner_user_id,source)
  VALUES(contact,ws,left(coalesce(nullif(btrim(prospect.first_name),''),prospect.email::text),200),'lead',NULL,'mhp:event-whatsapp:'||intent.campaign);
 END IF;
 IF email_point.id IS NULL THEN
  INSERT INTO app.contact_points(workspace_id,contact_id,kind,value,normalized_value,is_verified,consent_status,dedupe_state)
  VALUES(ws,contact,'email',prospect.email::text,prospect.email::text,true,'unknown','normal');
 END IF;
 IF wa_point.id IS NULL THEN
  point:=gen_random_uuid();
  INSERT INTO app.contact_points(id,workspace_id,contact_id,kind,value,normalized_value,is_verified,consent_status,dedupe_state)
  VALUES(point,ws,contact,'whatsapp',phone,p_sender,false,'unknown','normal');
  SELECT p.* INTO wa_point FROM app.contact_points p WHERE p.workspace_id=ws AND p.id=point;
 END IF;
 IF NOT wa_point.is_verified THEN
  UPDATE app.contact_points SET is_verified=true,row_version=row_version+1,updated_at=statement_timestamp() WHERE workspace_id=ws AND id=wa_point.id AND NOT is_verified;
 END IF;
 endpoint_sha:=public.digest(wa_point.kind||chr(31)||wa_point.value||chr(31)||wa_point.normalized_value,'sha256');
 INSERT INTO app.communication_consent_events(id,workspace_id,contact_id,contact_point_id,channel,purpose,state,lawful_basis,source,policy_version,
  policy_text_sha256,source_event_id,actor_kind,actor_user_id,evidence,endpoint_identity_sha256,occurred_at)
 VALUES(consent,ws,contact,wa_point.id,'whatsapp',programme->>'purpose','granted','consent','mhp.event-whatsapp.join',intent.consent_revision,
  intent.consent_text_sha256,p_external_event,'webhook',NULL,jsonb_build_object('schema','mhp.event-whatsapp-grant/v1','intentId',intent.id,
   'revision',intent.revision,'receiptId',receipt,'campaign',intent.campaign,'emailProof','single-use-link','whatsappProof','signed-meta-join',
   'smsVerificationUsed',false,'generalMarketing',false),endpoint_sha,p_occurred);
 INSERT INTO app_private.mhp_event_whatsapp_receipts(id,workspace_id,intent_id,intent_revision,campaign,prospect_id,signup_id,channel,purpose,contact_id,
  contact_point_id,endpoint_identity_sha256,phone_identity_sha256,decision,consent_revision,consent_text_sha256,consent_event_id,proof_kind,
  whatsapp_binding_id,provider_event_id,provider_message_id,payload_sha256,signature_sha256,body_sha256,event_identity_sha256,occurred_at,request_sha256)
 VALUES(receipt,ws,intent.id,intent.revision,intent.campaign,intent.prospect_id,intent.signup_id,'whatsapp',programme->>'purpose',contact,wa_point.id,
  endpoint_sha,intent.phone_identity_sha256,'granted',intent.consent_revision,intent.consent_text_sha256,consent,'signed_meta_join',p_binding,
  p_external_event,p_message_id,p_payload_sha,p_signature_sha,p_body_sha,p_event_identity_sha,p_occurred,p_event_identity_sha);
 UPDATE app_private.mhp_event_whatsapp_intents SET state='verified',join_consumed_at=now_at,consumed_provider_event_id=p_external_event,
  contact_id=contact,point_id=wa_point.id,result_receipt_id=receipt,updated_at=now_at WHERE id=intent.id;
 outcome:=app_private.mhp_event_whatsapp_project(p_workspace,p_binding,p_external_event,p_message_id,p_sender,p_body,p_sender_sha,p_body_sha,
  p_payload_sha,p_signature_sha,p_event_identity_sha,p_occurred,false);
 IF outcome IS DISTINCT FROM 'applied' THEN RAISE EXCEPTION 'MHP event WhatsApp JOIN projection did not apply' USING ERRCODE='40001'; END IF;
 RETURN QUERY SELECT 'event_joined'::text;
END $f$;
REVOKE ALL ON FUNCTION app_private.mhp_record_event_whatsapp_inbound(uuid,uuid,text,text,text,text,bytea,bytea,bytea,bytea,bytea,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.mhp_record_event_whatsapp_inbound(uuid,uuid,text,text,text,text,bytea,bytea,bytea,bytea,bytea,timestamptz) TO r72_whatsapp_live_webhook_command;

-- 8. Owner connection (from the earlier reviewed 009C candidate; the SMS-receipt
-- possession shortcut and the owned test are NOT carried over).
RESET ROLE;
SET LOCAL ROLE r72_owner;
GRANT EXECUTE ON FUNCTION app_private.current_request_id(),app_private.current_user_id() TO r72_whatsapp_live_definer;
CREATE POLICY mhp_whatsapp_connect_receipts ON app.command_receipts TO r72_whatsapp_live_definer
 USING(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND command_name='mhp.whatsapp.connect'
  AND actor_user_id=nullif(current_setting('app.user_id',true),'')::uuid)
 WITH CHECK(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND command_name='mhp.whatsapp.connect'
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
RESET ROLE;
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


-- 9. Provider template evidence (worker-only; proposal 3, unratified boundary).
CREATE FUNCTION app_private.record_mhp_whatsapp_template_observation(p_workspace uuid,p_binding uuid,p_meta_template_id text,p_name text,p_language text,
 p_category text,p_status text,p_parameter_count integer,p_body_sha bytea,p_components_sha bytea,p_response_sha bytea) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE created uuid;
BEGIN
 IF session_user<>'r72_whatsapp_live_worker_command' OR p_workspace IS DISTINCT FROM '2789228d-55a6-4688-b1e8-2f70abca990b'
  OR current_setting('app.workspace_id',true) IS DISTINCT FROM p_workspace::text OR current_setting('app.actor_kind',true) IS DISTINCT FROM 'worker'
  OR coalesce(current_setting('app.user_id',true),'')<>'' OR coalesce(current_setting('app.request_id',true),'')=''
  OR NOT EXISTS(SELECT 1 FROM app.property_predator_whatsapp_live_bindings b WHERE b.workspace_id=p_workspace AND b.id=p_binding AND b.status='active'
   AND NOT EXISTS(SELECT 1 FROM app.property_predator_whatsapp_live_binding_revocations r WHERE r.workspace_id=b.workspace_id AND r.binding_id=b.id))
 THEN RAISE EXCEPTION 'MHP WhatsApp template observation denied' USING ERRCODE='42501'; END IF;
 INSERT INTO app_private.mhp_whatsapp_template_observations(workspace_id,binding_id,meta_template_id,template_name,language_code,category,provider_status,
  parameter_count,body_sha256,components_sha256,response_sha256,observed_by_role,observed_request_id,expires_at)
 VALUES(p_workspace,p_binding,p_meta_template_id,p_name,p_language,p_category,p_status,p_parameter_count,p_body_sha,p_components_sha,p_response_sha,
  'r72_whatsapp_live_worker_command',current_setting('app.request_id',true),statement_timestamp()+interval '15 minutes') RETURNING id INTO created;
 RETURN created;
END $f$;
REVOKE ALL ON FUNCTION app_private.record_mhp_whatsapp_template_observation(uuid,uuid,text,text,text,text,text,integer,bytea,bytea,bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.record_mhp_whatsapp_template_observation(uuid,uuid,text,text,text,text,text,integer,bytea,bytea,bytea) TO r72_whatsapp_live_worker_command;

-- Latest Meta read for this exact template is APPROVED, unexpired, zero-parameter and byte-equal to the approved draft.
CREATE FUNCTION app_private.mhp_whatsapp_template_current(p_binding uuid,p_meta_id text,p_name text,p_language text,p_body_sha bytea) RETURNS uuid
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $f$
 SELECT o.id FROM (SELECT x.* FROM app_private.mhp_whatsapp_template_observations x WHERE x.binding_id=p_binding AND x.meta_template_id=p_meta_id
   ORDER BY x.observed_at DESC,x.id DESC LIMIT 1) o
 WHERE o.provider_status='APPROVED' AND o.expires_at>statement_timestamp() AND o.template_name=p_name AND o.language_code=p_language
  AND o.parameter_count=0 AND o.body_sha256=p_body_sha AND o.category IN('MARKETING','UTILITY')
$f$;
REVOKE ALL ON FUNCTION app_private.mhp_whatsapp_template_current(uuid,text,text,text,bytea) FROM PUBLIC;

CREATE FUNCTION app_private.mhp_event_whatsapp_grant_tuple(p_receipt uuid) RETURNS TABLE(receipt_id uuid,intent_revision integer,prospect_id uuid,
 signup_id uuid,campaign text,purpose text,contact_id uuid,point_id uuid,endpoint_sha256 bytea,recipient_sha256 bytea,consent_event_id uuid,phone text)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $f$
 SELECT r.id,r.intent_revision,r.prospect_id,r.signup_id,r.campaign,r.purpose,r.contact_id,r.contact_point_id,r.endpoint_identity_sha256,
  public.digest(regexp_replace(p.normalized_value,'^\\+',''),'sha256'),r.consent_event_id,p.value
 FROM app_private.mhp_event_whatsapp_receipts r
 JOIN app.contact_points p ON p.workspace_id=r.workspace_id AND p.id=r.contact_point_id AND p.contact_id=r.contact_id AND p.kind='whatsapp'
  AND p.deleted_at IS NULL AND p.is_verified AND p.dedupe_state='normal' AND p.normalized_value~'^447[0-9]{9}$'
  AND public.digest(p.kind||chr(31)||p.value||chr(31)||p.normalized_value,'sha256')=r.endpoint_identity_sha256
 JOIN app.contacts c ON c.workspace_id=p.workspace_id AND c.id=p.contact_id AND c.deleted_at IS NULL
 WHERE r.id=p_receipt AND r.decision='granted'
  AND app_private.mhp_event_whatsapp_current_receipt(r.prospect_id,r.campaign)=r.id
  AND r.consent_event_id=(SELECT l.id FROM app.communication_consent_events l WHERE l.workspace_id=r.workspace_id AND l.contact_point_id=r.contact_point_id
   AND l.channel='whatsapp' AND l.purpose=r.purpose ORDER BY l.occurred_at DESC,l.recorded_at DESC,l.id DESC LIMIT 1)
  AND EXISTS(SELECT 1 FROM app.communication_consent_events g WHERE g.workspace_id=r.workspace_id AND g.id=r.consent_event_id AND g.state='granted'
   AND g.lawful_basis='consent' AND g.endpoint_identity_sha256=r.endpoint_identity_sha256)
  AND NOT EXISTS(SELECT 1 FROM(SELECT DISTINCT ON(coalesce(s.purpose,'')) s.state FROM app.communication_suppression_events s
   WHERE s.workspace_id=r.workspace_id AND s.contact_point_id=r.contact_point_id AND s.channel='whatsapp' AND(s.purpose IS NULL OR s.purpose=r.purpose)
   ORDER BY coalesce(s.purpose,''),s.occurred_at DESC,s.recorded_at DESC,s.id DESC) latest WHERE latest.state='suppressed')
$f$;
REVOKE ALL ON FUNCTION app_private.mhp_event_whatsapp_grant_tuple(uuid) FROM PUBLIC;

CREATE FUNCTION app_private.mhp_event_whatsapp_binding(p_binding uuid) RETURNS app.property_predator_whatsapp_live_bindings
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $f$
 SELECT b.* FROM app.property_predator_whatsapp_live_bindings b JOIN app.provider_connections c ON c.workspace_id=b.workspace_id AND c.id=b.provider_connection_id
  AND c.provider_id='meta_whatsapp_cloud' AND c.provider_kind='messaging' AND c.environment='live' AND c.status='active'
 WHERE b.workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND b.id=p_binding AND b.status='active'
  AND NOT EXISTS(SELECT 1 FROM app.property_predator_whatsapp_live_binding_revocations r WHERE r.workspace_id=b.workspace_id AND r.binding_id=b.id)
$f$;
REVOKE ALL ON FUNCTION app_private.mhp_event_whatsapp_binding(uuid) FROM PUBLIC;

-- WhatsApp sends per due UTC day/month on the binding: existing jobs plus scheduled unprepared steps (unchanged 0053 caps 1/3).
CREATE FUNCTION app_private.mhp_event_whatsapp_budget(p_binding uuid,p_due timestamptz) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $f$
 WITH d AS (SELECT (p_due AT TIME ZONE 'UTC')::date AS day,date_trunc('month',p_due AT TIME ZONE 'UTC')::date AS month),
 jobs AS (SELECT count(*) FILTER (WHERE j.utc_day=d.day)::integer AS day_used,count(*)::integer AS month_used FROM d
  LEFT JOIN app.property_predator_whatsapp_live_jobs j ON j.binding_id=p_binding AND j.utc_month=d.month AND j.state<>'cancelled' GROUP BY d.day),
 reserved AS (SELECT count(*) FILTER (WHERE (s.due_at AT TIME ZONE 'UTC')::date=d.day)::integer AS day_reserved,count(s.id)::integer AS month_reserved FROM d
  LEFT JOIN app_private.mhp_event_whatsapp_sends s ON s.binding_id=p_binding AND date_trunc('month',s.due_at AT TIME ZONE 'UTC')::date=d.month
   AND s.cancelled_at IS NULL AND s.held_at IS NULL AND s.job_id IS NULL GROUP BY d.day)
 SELECT jsonb_build_object('utcDay',d.day,'dayAvailable',greatest(1-coalesce(jobs.day_used,0)-coalesce(reserved.day_reserved,0),0),
  'monthAvailable',greatest(3-coalesce(jobs.month_used,0)-coalesce(reserved.month_reserved,0),0),'dailyCap',1,'monthlyCap',3)
 FROM d LEFT JOIN jobs ON true LEFT JOIN reserved ON true
$f$;
REVOKE ALL ON FUNCTION app_private.mhp_event_whatsapp_budget(uuid,timestamptz) FROM PUBLIC;

CREATE FUNCTION app_private.mhp_event_whatsapp_review_doc(p_programme jsonb,p_binding uuid,p_observation uuid,p_receipts uuid[]) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $f$
 SELECT jsonb_build_object('schema','mhp.event-whatsapp-activation/v1','workspaceId','2789228d-55a6-4688-b1e8-2f70abca990b',
  'policyRevision','mhp.event-whatsapp-operational-review/v1','reviewAuthority','mhp.founder-operator-review-not-legal-advice',
  'programmeVersionId',p_programme->>'programmeVersionId','programmeSha256',p_programme->>'programmeSha256','programmeApprovalId',p_programme->>'approvalId',
  'event',p_programme->>'event','stepKey',p_programme->>'stepKey','dueAt',p_programme->>'dueAt','providerDeadline',p_programme->>'providerDeadline',
  'sourceContentVersionId',p_programme->>'sourceContentVersionId','bodySha256',p_programme->>'bodySha256','templateName',p_programme->>'templateName',
  'language',p_programme->>'language','metaTemplateId',p_programme->>'metaTemplateId','bindingId',p_binding,'templateObservationId',p_observation,
  'recipients',coalesce((SELECT jsonb_agg(jsonb_build_object('receiptId',t.receipt_id,'revision',t.intent_revision,'pointId',t.point_id,
    'endpointSha256',encode(t.endpoint_sha256,'hex'),'consentEventId',t.consent_event_id) ORDER BY t.receipt_id)
   FROM unnest(p_receipts) x(id) CROSS JOIN LATERAL app_private.mhp_event_whatsapp_grant_tuple(x.id) t),'[]'::jsonb))
$f$;
REVOKE ALL ON FUNCTION app_private.mhp_event_whatsapp_review_doc(jsonb,uuid,uuid,uuid[]) FROM PUBLIC;

CREATE FUNCTION app_private.mhp_event_whatsapp_review(p_session bytea,p_programme_version uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; programme jsonb; binding app.property_predator_whatsapp_live_bindings%ROWTYPE; observation uuid; latest app_private.mhp_whatsapp_template_observations%ROWTYPE;
 budget jsonb; eligible uuid[]; selected uuid[]; max_batch integer; doc jsonb; recipients jsonb; schedule jsonb;
BEGIN
 actor:=app_private.mhp_whatsapp_owner(p_session);
 programme:=app_private.mhp_event_whatsapp_programme_exact(p_programme_version,true);
 IF programme->>'approvalId' IS NULL THEN RAISE EXCEPTION 'Approve the WhatsApp programme first' USING ERRCODE='23514'; END IF;
 binding:=app_private.mhp_event_whatsapp_binding((programme->>'whatsappBindingId')::uuid);
 IF binding.id IS NULL THEN RAISE EXCEPTION 'Actual MHP WhatsApp binding required' USING ERRCODE='42501'; END IF;
 SELECT * INTO latest FROM app_private.mhp_whatsapp_template_observations o WHERE o.binding_id=binding.id AND o.meta_template_id=programme->>'metaTemplateId'
 ORDER BY o.observed_at DESC,o.id DESC LIMIT 1;
 observation:=app_private.mhp_whatsapp_template_current(binding.id,programme->>'metaTemplateId',programme->>'templateName',programme->>'language',
  decode(programme->>'bodySha256','hex'));
 budget:=app_private.mhp_event_whatsapp_budget(binding.id,(programme->>'dueAt')::timestamptz);
 max_batch:=least((budget->>'dayAvailable')::integer,(budget->>'monthAvailable')::integer);
 SELECT array_agg(r.id ORDER BY r.id) INTO eligible FROM app_private.mhp_event_whatsapp_receipts r
 WHERE r.campaign=programme->>'event' AND r.decision='granted' AND EXISTS(SELECT 1 FROM app_private.mhp_event_whatsapp_grant_tuple(r.id))
  AND NOT EXISTS(SELECT 1 FROM app_private.mhp_event_whatsapp_sends s WHERE s.prospect_id=r.prospect_id AND s.campaign=r.campaign AND s.step_key=programme->>'stepKey')
  AND NOT EXISTS(SELECT 1 FROM app_private.mhp_event_whatsapp_sends s WHERE s.campaign=r.campaign AND s.step_key=programme->>'stepKey' AND s.point_id=r.contact_point_id);
 selected:=CASE WHEN observation IS NULL THEN '{}'::uuid[] ELSE coalesce(eligible[1:greatest(max_batch,0)],'{}'::uuid[]) END;
 doc:=app_private.mhp_event_whatsapp_review_doc(programme,binding.id,observation,selected);
 SELECT coalesce(jsonb_agg(jsonb_build_object('receiptId',t.receipt_id,'revision',t.intent_revision,'phoneMasked',app_private.mhp_event_phone_mask(t.phone),
   'firstName',p.first_name,'selected',t.receipt_id=ANY(selected)) ORDER BY t.receipt_id),'[]'::jsonb) INTO recipients
 FROM unnest(coalesce(eligible,'{}'::uuid[])) x(id) CROSS JOIN LATERAL app_private.mhp_event_whatsapp_grant_tuple(x.id) t JOIN app_private.mhp_prospects p ON p.id=t.prospect_id;
 SELECT coalesce(jsonb_agg(jsonb_build_object('sendId',s.id,'dueAt',s.due_at,'cancelled',s.cancelled_at IS NOT NULL,'held',s.hold_reason,
   'prepared',s.job_id IS NOT NULL,'jobState',j.state) ORDER BY s.due_at,s.id),'[]'::jsonb) INTO schedule
 FROM app_private.mhp_event_whatsapp_sends s LEFT JOIN app.property_predator_whatsapp_live_jobs j ON j.workspace_id=s.workspace_id AND j.id=s.job_id
 WHERE s.campaign=programme->>'event';
 RETURN jsonb_build_object('programme',programme-'bodyText','bodyText',programme->>'bodyText','bindingId',binding.id,'budget',budget,
  'templateObservation',jsonb_build_object('id',latest.id,'status',latest.provider_status,'observedAt',latest.observed_at,'expiresAt',latest.expires_at,
   'current',observation IS NOT NULL),'maxBatch',greatest(max_batch,0),'recipients',recipients,'selectedReceiptIds',to_jsonb(selected),
  'selectedRevisions',coalesce((SELECT jsonb_object_agg(e->>'receiptId',(e->>'revision')::integer) FROM jsonb_array_elements(doc->'recipients') e),'{}'::jsonb),
  'reviewSha256',encode(public.digest(doc::text,'sha256'),'hex'),'schedule',schedule,
  'awaitingOwnerReview',jsonb_array_length(recipients)-cardinality(selected));
END $f$;

CREATE FUNCTION app_private.mhp_event_whatsapp_activate(p_session bytea,p_command uuid,p_programme_version uuid,p_programme_sha bytea,
 p_sorted_receipts uuid[],p_exact_receipt_revisions jsonb,p_review_sha bytea,p_request_id text,p_agreed boolean,p_lookup_only boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE ws constant uuid:='2789228d-55a6-4688-b1e8-2f70abca990b'; actor uuid; request text:=current_setting('app.request_id',true);
 review_authority constant text:='mhp.founder-operator-review-not-legal-advice';
 payload bytea; prior app.command_receipts%ROWTYPE; programme jsonb; binding app.property_predator_whatsapp_live_bindings%ROWTYPE; observation uuid;
 obs app_private.mhp_whatsapp_template_observations%ROWTYPE; doc jsonb; budget jsonb; template uuid; draft jsonb; keys text[]; i integer; t record;
 created jsonb:='[]'::jsonb; command_receipt uuid:=gen_random_uuid(); prepared timestamptz; due timestamptz; deadline timestamptz;
 send uuid; subject uuid; pack uuid; legal uuid; commercial uuid; publication uuid; sender_route uuid; instigator_route uuid; operation uuid; idem bytea; scope bytea;
 facts jsonb; facts_sha bytea; outcome jsonb;
BEGIN
 actor:=app_private.mhp_whatsapp_owner(p_session);
 IF p_command IS NULL OR p_programme_version IS NULL OR octet_length(p_programme_sha) IS DISTINCT FROM 32 OR octet_length(p_review_sha) IS DISTINCT FROM 32
  OR p_request_id IS DISTINCT FROM request OR p_agreed IS DISTINCT FROM true OR p_lookup_only IS NULL
  OR p_sorted_receipts IS NULL OR cardinality(p_sorted_receipts) NOT BETWEEN 1 AND 3 OR array_position(p_sorted_receipts,NULL) IS NOT NULL
  OR p_sorted_receipts IS DISTINCT FROM (SELECT array_agg(DISTINCT x ORDER BY x) FROM unnest(p_sorted_receipts) x)
  OR jsonb_typeof(p_exact_receipt_revisions) IS DISTINCT FROM 'object'
  OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_exact_receipt_revisions) k) IS DISTINCT FROM (SELECT array_agg(x::text ORDER BY x::text) FROM unnest(p_sorted_receipts) x)
  OR EXISTS(SELECT 1 FROM jsonb_each(p_exact_receipt_revisions) e WHERE jsonb_typeof(e.value)<>'number' OR e.value::text!~'^[1-9][0-9]{0,8}$')
 THEN RAISE EXCEPTION 'MHP event WhatsApp activation denied' USING ERRCODE='42501'; END IF;
 payload:=public.digest(jsonb_build_object('schema','mhp.event-whatsapp.activate/v1','workspace',ws,'actor',actor,'programmeVersion',p_programme_version,
  'programmeSha256',encode(p_programme_sha,'hex'),'receipts',to_jsonb(p_sorted_receipts),'revisions',p_exact_receipt_revisions,
  'reviewSha256',encode(p_review_sha,'hex'),'agreed',p_agreed)::text,'sha256');
 SELECT * INTO prior FROM app.command_receipts r WHERE r.workspace_id=ws AND r.actor_user_id=actor AND r.command_name='mhp.event-whatsapp.activate' AND r.idempotency_key=p_command::text;
 IF FOUND THEN
  IF prior.payload_hash IS DISTINCT FROM payload OR prior.status<>'succeeded' THEN RAISE EXCEPTION 'Event WhatsApp activation replay conflicts' USING ERRCODE='40001'; END IF;
  RETURN prior.result||jsonb_build_object('replayed',true);
 END IF;
 IF p_lookup_only THEN RETURN jsonb_build_object('not_started',true); END IF;
 IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN RAISE EXCEPTION 'Event WhatsApp activation requires read committed' USING ERRCODE='25000'; END IF;
 programme:=app_private.mhp_event_whatsapp_programme_exact(p_programme_version,true);
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('company-content:'||ws::text||':'||(programme->>'programmeItemId'),7200021));
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('company-content:'||ws::text||':'||(programme->>'sourceContentItemId'),7200021));
 SELECT array_agg('mhp.event-whatsapp.prospect:'||r.campaign||':'||r.prospect_id::text) INTO keys FROM app_private.mhp_event_whatsapp_receipts r WHERE r.id=ANY(p_sorted_receipts);
 PERFORM app_private.mhp_event_phone_lock(coalesce(keys,'{}'::text[]));
 binding:=app_private.mhp_event_whatsapp_binding((programme->>'whatsappBindingId')::uuid);
 IF binding.id IS NULL THEN RAISE EXCEPTION 'Actual MHP WhatsApp binding required' USING ERRCODE='42501'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(format('pp-whatsapp-live:%s:%s',ws,binding.id),0));
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('mhp.event-whatsapp.activate:'||ws::text||':'||actor::text||':'||p_command::text,7200132));
 SELECT * INTO prior FROM app.command_receipts r WHERE r.workspace_id=ws AND r.actor_user_id=actor AND r.command_name='mhp.event-whatsapp.activate' AND r.idempotency_key=p_command::text;
 IF FOUND THEN
  IF prior.payload_hash IS DISTINCT FROM payload OR prior.status<>'succeeded' THEN RAISE EXCEPTION 'Event WhatsApp activation replay conflicts' USING ERRCODE='40001'; END IF;
  RETURN prior.result||jsonb_build_object('replayed',true);
 END IF;
 programme:=app_private.mhp_event_whatsapp_programme_exact(p_programme_version,true);
 draft:=app_private.mhp_owned_whatsapp_content((programme->>'sourceContentVersionId')::uuid,decode(programme->>'sourceContentSha256','hex'));
 IF programme->>'approvalId' IS NULL OR programme->>'programmeSha256' IS DISTINCT FROM encode(p_programme_sha,'hex')
 THEN RAISE EXCEPTION 'Event WhatsApp programme changed; refresh the review' USING ERRCODE='40001'; END IF;
 -- The only template evidence is the worker's current Meta read; never an owner-typed approval.
 observation:=app_private.mhp_whatsapp_template_current(binding.id,programme->>'metaTemplateId',programme->>'templateName',programme->>'language',
  decode(programme->>'bodySha256','hex'));
 IF observation IS NULL THEN RAISE EXCEPTION 'Meta has not returned this template as APPROVED in the last 15 minutes' USING ERRCODE='23514'; END IF;
 SELECT * INTO obs FROM app_private.mhp_whatsapp_template_observations o WHERE o.id=observation;
 due:=(programme->>'dueAt')::timestamptz; deadline:=(programme->>'providerDeadline')::timestamptz;
 IF deadline<=statement_timestamp()+interval '5 minutes' THEN RAISE EXCEPTION 'Event WhatsApp window has passed' USING ERRCODE='23514'; END IF;
 FOR i IN 1..cardinality(p_sorted_receipts) LOOP
  IF NOT EXISTS(SELECT 1 FROM app_private.mhp_event_whatsapp_grant_tuple(p_sorted_receipts[i]) g WHERE g.campaign=programme->>'event'
    AND g.intent_revision=(p_exact_receipt_revisions->>(p_sorted_receipts[i]::text))::integer)
   OR EXISTS(SELECT 1 FROM app_private.mhp_event_whatsapp_receipts r JOIN app_private.mhp_event_whatsapp_sends s ON s.prospect_id=r.prospect_id
    AND s.campaign=r.campaign AND s.step_key=programme->>'stepKey' WHERE r.id=p_sorted_receipts[i])
  THEN RAISE EXCEPTION 'A selected recipient changed; refresh the review' USING ERRCODE='40001'; END IF;
 END LOOP;
 doc:=app_private.mhp_event_whatsapp_review_doc(programme,binding.id,observation,p_sorted_receipts);
 IF jsonb_array_length(doc->'recipients')<>cardinality(p_sorted_receipts) OR public.digest(doc::text,'sha256') IS DISTINCT FROM p_review_sha
 THEN RAISE EXCEPTION 'Owner review no longer matches; refresh the review' USING ERRCODE='40001'; END IF;
 budget:=app_private.mhp_event_whatsapp_budget(binding.id,due);
 IF cardinality(p_sorted_receipts)>(budget->>'dayAvailable')::integer OR cardinality(p_sorted_receipts)>(budget->>'monthAvailable')::integer
 THEN RAISE EXCEPTION 'Event WhatsApp batch exceeds the WhatsApp caps' USING ERRCODE='54000'; END IF;
 prepared:=date_trunc('milliseconds',statement_timestamp());
 INSERT INTO app.command_receipts(id,workspace_id,command_name,idempotency_key,request_id,actor_user_id,payload_hash)
 VALUES(command_receipt,ws,'mhp.event-whatsapp.activate',p_command::text,request,actor,payload);
 -- Pin the template row once, evidenced by the Meta observation (not a typed reference).
 SELECT t2.id INTO template FROM app.property_predator_whatsapp_live_templates t2 WHERE t2.workspace_id=ws AND t2.binding_id=binding.id
  AND t2.provider_template_name=programme->>'templateName' AND t2.language_code=programme->>'language';
 IF template IS NULL THEN
  template:=gen_random_uuid();
  PERFORM app_private.record_whatsapp_live_template(ws,binding.id,template,(programme->>'sourceContentItemId')::uuid,(programme->>'sourceContentVersionId')::uuid,
   (draft->>'approvalRequestId')::uuid,(draft->>'approvalDecisionId')::uuid,programme->>'templateName',public.digest('meta-template:'||(programme->>'metaTemplateId'),'sha256'),
   programme->>'language',lower(obs.category),obs.response_sha256,obs.observed_at);
 ELSIF NOT EXISTS(SELECT 1 FROM app.property_predator_whatsapp_live_templates t2 WHERE t2.id=template AND t2.content_version_id=(programme->>'sourceContentVersionId')::uuid) THEN
  RAISE EXCEPTION 'This template name is pinned to another draft; use a new template name' USING ERRCODE='23514';
 END IF;
 FOR t IN SELECT g.* FROM unnest(p_sorted_receipts) WITH ORDINALITY x(id,n) CROSS JOIN LATERAL app_private.mhp_event_whatsapp_grant_tuple(x.id) g ORDER BY x.n LOOP
  send:=gen_random_uuid(); subject:=gen_random_uuid(); pack:=gen_random_uuid(); legal:=gen_random_uuid(); commercial:=gen_random_uuid();
  publication:=gen_random_uuid(); sender_route:=gen_random_uuid(); instigator_route:=gen_random_uuid(); operation:=gen_random_uuid();
  idem:=public.digest('mhp.event-whatsapp.send:'||send::text,'sha256');
  scope:=public.digest(format('whatsapp:%s:%s:%s:%s:%s:%s',ws,binding.id,template,encode(t.recipient_sha256,'hex'),t.purpose,t.consent_event_id),'sha256');
  facts:=jsonb_build_object('schema','mhp.event-whatsapp-operational-review/v1','owner',actor,'request',request,'command',p_command,'send',send,
   'reviewSha256',encode(p_review_sha,'hex'),'programmeVersionId',programme->>'programmeVersionId','event',programme->>'event','purpose',t.purpose,
   'dueAt',programme->>'dueAt','providerDeadline',programme->>'providerDeadline','binding',binding.id,'template',template,'templateObservation',observation,
   'receipt',t.receipt_id,'revision',t.intent_revision,'point',t.point_id,'consent',t.consent_event_id,'generalMarketing',false,
   'reviewAuthority',review_authority,'legalEntity','MH196 Ltd','brand','Martin Howard Property');
  facts_sha:=public.digest(facts::text,'sha256');
  INSERT INTO app_private.affiliate_compliance_subjects(id,workspace_id,source_system,source_subject_key,legal_identity_sha256,recorded_by_user_id,recorded_request_id)
  VALUES(subject,ws,'martin-howard-property','mhp.event-whatsapp:'||send::text,public.digest('MH196 Ltd:Martin Howard Property:'||actor::text,'sha256'),actor,request);
  INSERT INTO app_private.affiliate_compliance_policy_pack_versions(id,workspace_id,pack_key,pack_version,bundle_sha256,document_refs,drafting_status,source_commit,source_commit_meaning,recorded_by_user_id,recorded_request_id)
  VALUES(pack,ws,'mhp_event_whatsapp_followup',send::text,facts_sha,jsonb_build_array(
   jsonb_build_object('documentType','owner_review','documentId','mhp.event-wa-owner-review:'||send::text,'documentVersion','v1','contentSha256',encode(facts_sha,'hex')),
   jsonb_build_object('documentType','sender_ownership','documentId','mhp.wa-sender-ownership:'||binding.id::text,'documentVersion','v1','contentSha256',encode(binding.ownership_evidence_sha256,'hex')),
   jsonb_build_object('documentType','event_whatsapp_proof','documentId','mhp.event-wa-receipt:'||t.receipt_id::text,'documentVersion','v'||t.intent_revision::text,'contentSha256',encode(t.endpoint_sha256,'hex')),
   jsonb_build_object('documentType','meta_template_read','documentId','mhp.meta-template-observation:'||observation::text,'documentVersion','v1','contentSha256',encode(obs.response_sha256,'hex')),
   jsonb_build_object('documentType','event_permission','documentId','mhp.event-wa-permission:'||t.consent_event_id::text,'documentVersion','v1',
    'contentSha256',encode(public.digest(app_private.mhp_event_whatsapp_consent_text('mhp.event-whatsapp/v1'),'sha256'),'hex')),
   jsonb_build_object('documentType','event_programme','documentId','mhp.event-wa-programme:'||(programme->>'programmeVersionId'),'documentVersion','v1','contentSha256',programme->>'programmeSha256')),
   'draft_complete','69652270584f1dc0cf737fe2ff7cd9a19e3a4d28','drafting-provenance-only',actor,request);
  INSERT INTO app_private.affiliate_compliance_policy_review_events(id,workspace_id,policy_pack_id,bundle_sha256,review_dimension,decision,specialist_reference,decision_reference,decision_sha256,occurred_at,recorded_by_user_id,recorded_request_id)
  VALUES(legal,ws,pack,facts_sha,'legal','approved',review_authority,'mhp.event-whatsapp:'||send::text,public.digest(facts_sha||convert_to(':owner-legal-dimension','UTF8'),'sha256'),prepared,actor,request),
   (commercial,ws,pack,facts_sha,'commercial','approved',review_authority,'mhp.event-whatsapp:'||send::text,public.digest(facts_sha||convert_to(':owner-commercial-dimension','UTF8'),'sha256'),prepared,actor,request);
  INSERT INTO app_private.affiliate_compliance_policy_publication_events(id,workspace_id,policy_pack_id,bundle_sha256,publication_state,legal_review_event_id,commercial_review_event_id,effective_at,expires_at,reacceptance_class,publication_reference,recorded_by_user_id,recorded_request_id)
  VALUES(publication,ws,pack,facts_sha,'published',legal,commercial,prepared,deadline,'none','mhp.event-whatsapp:'||send::text,actor,request);
  INSERT INTO app_private.affiliate_compliance_specialist_decision_events(id,workspace_id,subject_id,decision_kind,decision_scope_ref,action_scope_sha256,decision_state,route_classification,
   party_reference,responsibility_reference,specialist_reference,decision_sha256,valid_from,valid_until,recorded_by_user_id,recorded_request_id)
  VALUES(sender_route,ws,subject,'pecr_sender_route','mhp.event-whatsapp:'||send::text,scope,'approved','individual_consent','mhp.sender.MH196Ltd','mhp.instigator.MH196Ltd',review_authority,
    public.digest(facts_sha||convert_to(':sender','UTF8'),'sha256'),prepared,deadline,actor,request),
   (instigator_route,ws,subject,'pecr_instigator_route','mhp.event-whatsapp:'||send::text,scope,'approved','individual_consent','mhp.sender.MH196Ltd','mhp.instigator.MH196Ltd',review_authority,
    public.digest(facts_sha||convert_to(':instigator','UTF8'),'sha256'),prepared,deadline,actor,request);
  INSERT INTO app_private.mhp_event_whatsapp_sends(id,workspace_id,prospect_id,campaign,step_key,purpose,starts_at,due_at,expires_at,programme_item_id,
   programme_version_id,programme_sha256,programme_approval_id,source_item_id,source_version_id,source_sha256,binding_id,provider_connection_id,template_id,
   meta_template_id,template_observation_id,receipt_id,receipt_revision,signup_id,contact_id,point_id,recipient_sha256,endpoint_identity_sha256,consent_event_id,
   compliance_subject_id,policy_publication_id,pecr_sender_decision_id,pecr_instigator_decision_id,operation_id,idempotency_key_sha256,
   activation_actor_user_id,activation_request_id,activation_command_id,activation_payload_sha256)
  VALUES(send,ws,t.prospect_id,programme->>'event',programme->>'stepKey',t.purpose,(programme->>'startsAt')::timestamptz,due,deadline,
   (programme->>'programmeItemId')::uuid,(programme->>'programmeVersionId')::uuid,decode(programme->>'programmeSha256','hex'),(programme->>'approvalId')::uuid,
   (programme->>'sourceContentItemId')::uuid,(programme->>'sourceContentVersionId')::uuid,decode(programme->>'sourceContentSha256','hex'),binding.id,
   binding.provider_connection_id,template,programme->>'metaTemplateId',observation,t.receipt_id,t.intent_revision,t.signup_id,t.contact_id,t.point_id,
   t.recipient_sha256,t.endpoint_sha256,t.consent_event_id,subject,publication,sender_route,instigator_route,operation,idem,actor,request,p_command,payload);
  created:=created||jsonb_build_array(jsonb_build_object('sendId',send,'receiptId',t.receipt_id));
 END LOOP;
 IF jsonb_array_length(created)<>cardinality(p_sorted_receipts) THEN RAISE EXCEPTION 'Event WhatsApp batch changed during activation' USING ERRCODE='40001'; END IF;
 outcome:=jsonb_build_object('commandId',p_command,'scheduled',created,'count',jsonb_array_length(created),'dueAt',programme->>'dueAt',
  'templateObservationId',observation,'authorityCreated',false,'jobsCreated',0,'providerEffects','none','reviewAuthority',review_authority,'replayed',false);
 UPDATE app.command_receipts SET result=outcome,status='succeeded',response_status=200,completed_at=clock_timestamp() WHERE id=command_receipt AND workspace_id=ws;
 RETURN outcome;
END $f$;

CREATE FUNCTION app_private.mhp_event_whatsapp_control(p_session bytea,p_command uuid,p_action text,p_send uuid,p_payload_sha bytea,p_request_id text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE ws constant uuid:='2789228d-55a6-4688-b1e8-2f70abca990b'; actor uuid; request text:=current_setting('app.request_id',true); payload bytea;
 prior app.command_receipts%ROWTYPE; row app_private.mhp_event_whatsapp_sends%ROWTYPE; job_state text; outcome jsonb; command_receipt uuid:=gen_random_uuid();
BEGIN
 actor:=app_private.mhp_whatsapp_owner(p_session);
 IF p_command IS NULL OR p_action IS NULL OR p_action NOT IN('hold','cancel') OR p_send IS NULL OR octet_length(p_payload_sha) IS DISTINCT FROM 32
  OR p_request_id IS DISTINCT FROM request THEN RAISE EXCEPTION 'MHP event WhatsApp control denied' USING ERRCODE='42501'; END IF;
 payload:=public.digest(jsonb_build_object('schema','mhp.event-whatsapp.control/v1','actor',actor,'action',p_action,'send',p_send,'payloadSha256',encode(p_payload_sha,'hex'))::text,'sha256');
 SELECT * INTO prior FROM app.command_receipts r WHERE r.workspace_id=ws AND r.actor_user_id=actor AND r.command_name='mhp.event-whatsapp.control' AND r.idempotency_key=p_command::text;
 IF FOUND THEN
  IF prior.payload_hash IS DISTINCT FROM payload OR prior.status<>'succeeded' THEN RAISE EXCEPTION 'Event WhatsApp control replay conflicts' USING ERRCODE='40001'; END IF;
  RETURN prior.result||jsonb_build_object('replayed',true);
 END IF;
 SELECT * INTO row FROM app_private.mhp_event_whatsapp_sends s WHERE s.id=p_send;
 IF NOT FOUND THEN RAISE EXCEPTION 'Event WhatsApp step not found' USING ERRCODE='42501'; END IF;
 IF row.job_id IS NOT NULL THEN SELECT j.state INTO job_state FROM app.property_predator_whatsapp_live_jobs j WHERE j.workspace_id=ws AND j.id=row.job_id FOR UPDATE; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(format('pp-whatsapp-live:%s:%s',ws,row.binding_id),0));
 SELECT * INTO row FROM app_private.mhp_event_whatsapp_sends s WHERE s.id=p_send FOR UPDATE;
 INSERT INTO app.command_receipts(id,workspace_id,command_name,idempotency_key,request_id,actor_user_id,payload_hash)
 VALUES(command_receipt,ws,'mhp.event-whatsapp.control',p_command::text,request,actor,payload);
 IF job_state='queued' THEN
  UPDATE app.property_predator_whatsapp_live_jobs SET state='cancelled',settled_at=statement_timestamp(),updated_at=statement_timestamp()
  WHERE workspace_id=ws AND id=row.job_id AND state='queued';
  job_state:='cancelled';
 END IF;
 IF row.held_at IS NULL AND row.cancelled_at IS NULL THEN UPDATE app_private.mhp_event_whatsapp_sends SET held_at=statement_timestamp(),hold_reason='owner_hold' WHERE id=row.id; END IF;
 IF p_action='cancel' AND row.cancelled_at IS NULL AND (row.job_id IS NULL OR job_state='cancelled') THEN
  UPDATE app_private.mhp_event_whatsapp_sends SET cancelled_at=statement_timestamp() WHERE id=row.id;
 END IF;
 SELECT jsonb_build_object('sendId',s.id,'action',p_action,'held',s.held_at IS NOT NULL,'cancelled',s.cancelled_at IS NOT NULL,'jobState',job_state,
  'inFlight',job_state IN('leased','calling','awaiting_status','needs_attention','succeeded','failed'),'replayed',false) INTO outcome
 FROM app_private.mhp_event_whatsapp_sends s WHERE s.id=row.id;
 UPDATE app.command_receipts SET result=outcome,status='succeeded',response_status=200,completed_at=clock_timestamp() WHERE id=command_receipt AND workspace_id=ws;
 RETURN outcome;
END $f$;
REVOKE ALL ON FUNCTION app_private.mhp_event_whatsapp_review(bytea,uuid),
 app_private.mhp_event_whatsapp_activate(bytea,uuid,uuid,bytea,uuid[],jsonb,bytea,text,boolean,boolean),
 app_private.mhp_event_whatsapp_control(bytea,uuid,text,uuid,bytea,text),app_private.mhp_whatsapp_connect(bytea,uuid,uuid,uuid,text,text,text,text,text,bytea,bytea,bytea,bytea,bytea,text,boolean),
 app_private.mhp_whatsapp_owner(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.mhp_event_whatsapp_review(bytea,uuid),
 app_private.mhp_event_whatsapp_activate(bytea,uuid,uuid,bytea,uuid[],jsonb,bytea,text,boolean,boolean),
 app_private.mhp_event_whatsapp_control(bytea,uuid,text,uuid,bytea,text),app_private.mhp_whatsapp_connect(bytea,uuid,uuid,uuid,text,text,text,text,text,bytea,bytea,bytea,bytea,bytea,text,boolean)
 TO r72_whatsapp_live_command;

-- 10. Legacy 0053 repairs and exclusions. Each body is the exact 0053 definition
-- plus only the named change (proved by mhp-event-whatsapp-legacy-compat test).
RESET ROLE;
SET LOCAL ROLE r72_whatsapp_live_definer;
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
      AND job.authority_kind = 'owner_action'
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
    AND job.authority_kind = 'owner_action'
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
RESET ROLE;
SET LOCAL ROLE r72_owner;
CREATE OR REPLACE FUNCTION app_private.whatsapp_live_job_identity_guard()
RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog AS $function$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.binding_id IS DISTINCT FROM OLD.binding_id
     OR NEW.template_id IS DISTINCT FROM OLD.template_id
     OR NEW.authority_id IS DISTINCT FROM OLD.authority_id
     OR NEW.provider_connection_id IS DISTINCT FROM OLD.provider_connection_id
     OR NEW.recipient_sha256 IS DISTINCT FROM OLD.recipient_sha256
     OR NEW.operation_id IS DISTINCT FROM OLD.operation_id
     OR NEW.idempotency_key_sha256 IS DISTINCT FROM OLD.idempotency_key_sha256
     OR NEW.request_sha256 IS DISTINCT FROM OLD.request_sha256
     OR NEW.utc_day IS DISTINCT FROM OLD.utc_day OR NEW.utc_month IS DISTINCT FROM OLD.utc_month
     OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
     OR NEW.authority_kind IS DISTINCT FROM OLD.authority_kind
     OR NEW.event_send_id IS DISTINCT FROM OLD.event_send_id
     OR NEW.created_by_actor_kind IS DISTINCT FROM OLD.created_by_actor_kind
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Meta WhatsApp job identity evidence is immutable' USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END
$function$;

-- 11. Due worker on the 0053 rail: fresh event authority + one worker job; every
-- current gate (event grant, STOP, programme/draft, Meta template read, policy,
-- caps 1/day 3/month) is re-proved at prepare and again at begin.
RESET ROLE;
SET LOCAL ROLE r72_whatsapp_live_definer;
CREATE FUNCTION app_private.mhp_event_whatsapp_worker_context(p_workspace uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $f$
BEGIN
 IF session_user<>'r72_whatsapp_live_worker_command' OR p_workspace IS DISTINCT FROM '2789228d-55a6-4688-b1e8-2f70abca990b'
  OR current_setting('app.workspace_id',true) IS DISTINCT FROM p_workspace::text OR current_setting('app.actor_kind',true) IS DISTINCT FROM 'worker'
  OR coalesce(current_setting('app.user_id',true),'')<>'' OR coalesce(current_setting('app.request_id',true),'')=''
  OR length(current_setting('app.request_id',true))>128
 THEN RAISE EXCEPTION 'MHP event WhatsApp worker context denied' USING ERRCODE='42501'; END IF;
END $f$;
REVOKE ALL ON FUNCTION app_private.mhp_event_whatsapp_worker_context(uuid) FROM PUBLIC;

CREATE FUNCTION app_private.mhp_event_whatsapp_eligible(p_send uuid,p_require_due boolean) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $f$
DECLARE s app_private.mhp_event_whatsapp_sends%ROWTYPE; programme jsonb; observation uuid; scope bytea; now_at timestamptz:=statement_timestamp();
BEGIN
 SELECT * INTO s FROM app_private.mhp_event_whatsapp_sends x WHERE x.id=p_send;
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','not_eligible'); END IF;
 IF s.cancelled_at IS NOT NULL OR s.held_at IS NOT NULL THEN RETURN jsonb_build_object('ok',false,'reason','held'); END IF;
 IF now_at>=s.expires_at THEN RETURN jsonb_build_object('ok',false,'reason','expired'); END IF;
 IF p_require_due AND s.due_at>now_at THEN RETURN jsonb_build_object('ok',false,'reason','not_due'); END IF;
 IF NOT EXISTS(SELECT 1 FROM app_private.mhp_event_whatsapp_grant_tuple(s.receipt_id) g WHERE g.intent_revision=s.receipt_revision
   AND g.prospect_id=s.prospect_id AND g.campaign=s.campaign AND g.purpose=s.purpose AND g.contact_id=s.contact_id AND g.point_id=s.point_id
   AND g.endpoint_sha256=s.endpoint_identity_sha256 AND g.recipient_sha256=s.recipient_sha256 AND g.consent_event_id=s.consent_event_id)
 THEN RETURN jsonb_build_object('ok',false,'reason','receipt_changed'); END IF;
 IF (app_private.mhp_event_whatsapp_binding(s.binding_id)).provider_connection_id IS DISTINCT FROM s.provider_connection_id
  OR NOT EXISTS(SELECT 1 FROM app.property_predator_whatsapp_live_templates t WHERE t.workspace_id=s.workspace_id AND t.id=s.template_id
   AND t.binding_id=s.binding_id AND t.provider_status='approved' AND t.parameter_count=0 AND t.content_version_id=s.source_version_id)
  OR NOT EXISTS(SELECT 1 FROM app.workspace_memberships m WHERE m.workspace_id=s.workspace_id AND m.user_id=s.activation_actor_user_id
   AND m.status='active' AND m.role IN('owner','admin'))
 THEN RETURN jsonb_build_object('ok',false,'reason','not_eligible'); END IF;
 BEGIN programme:=app_private.mhp_event_whatsapp_programme_exact(s.programme_version_id,true);
 EXCEPTION WHEN sqlstate '23514' OR sqlstate '42501' THEN RETURN jsonb_build_object('ok',false,'reason','newer_draft'); END;
 IF programme->>'approvalId' IS NULL OR programme->>'programmeSha256' IS DISTINCT FROM encode(s.programme_sha256,'hex')
  OR programme->>'sourceContentSha256' IS DISTINCT FROM encode(s.source_sha256,'hex') THEN RETURN jsonb_build_object('ok',false,'reason','newer_draft'); END IF;
 observation:=app_private.mhp_whatsapp_template_current(s.binding_id,s.meta_template_id,programme->>'templateName',programme->>'language',
  decode(programme->>'bodySha256','hex'));
 IF observation IS NULL THEN RETURN jsonb_build_object('ok',false,'reason','template_not_approved'); END IF;
 scope:=public.digest(format('whatsapp:%s:%s:%s:%s:%s:%s',s.workspace_id,s.binding_id,s.template_id,encode(s.recipient_sha256,'hex'),s.purpose,s.consent_event_id),'sha256');
 IF NOT EXISTS(
   SELECT 1 FROM app_private.affiliate_compliance_policy_publication_events pub
   JOIN app_private.affiliate_compliance_policy_review_events legal ON legal.workspace_id=pub.workspace_id AND legal.id=pub.legal_review_event_id
    AND legal.policy_pack_id=pub.policy_pack_id AND legal.bundle_sha256=pub.bundle_sha256 AND legal.review_dimension='legal' AND legal.decision='approved'
   JOIN app_private.affiliate_compliance_policy_review_events commercial ON commercial.workspace_id=pub.workspace_id AND commercial.id=pub.commercial_review_event_id
    AND commercial.policy_pack_id=pub.policy_pack_id AND commercial.bundle_sha256=pub.bundle_sha256 AND commercial.review_dimension='commercial' AND commercial.decision='approved'
   JOIN app_private.affiliate_compliance_specialist_decision_events sr ON sr.workspace_id=pub.workspace_id AND sr.id=s.pecr_sender_decision_id
    AND sr.subject_id=s.compliance_subject_id AND sr.decision_kind='pecr_sender_route' AND sr.decision_state='approved' AND sr.action_scope_sha256=scope
   JOIN app_private.affiliate_compliance_specialist_decision_events ir ON ir.workspace_id=pub.workspace_id AND ir.id=s.pecr_instigator_decision_id
    AND ir.subject_id=s.compliance_subject_id AND ir.decision_kind='pecr_instigator_route' AND ir.decision_state='approved' AND ir.action_scope_sha256=scope
   WHERE pub.workspace_id=s.workspace_id AND pub.id=s.policy_publication_id AND pub.publication_state='published'
    AND pub.effective_at<=now_at AND (pub.expires_at IS NULL OR pub.expires_at>now_at)
    AND sr.valid_from<=now_at AND (sr.valid_until IS NULL OR sr.valid_until>now_at) AND ir.valid_from<=now_at AND (ir.valid_until IS NULL OR ir.valid_until>now_at)
    AND NOT EXISTS(SELECT 1 FROM app_private.affiliate_compliance_policy_publication_events n WHERE n.workspace_id=pub.workspace_id AND n.policy_pack_id=pub.policy_pack_id AND n.supersedes_event_id=pub.id)
    AND NOT EXISTS(SELECT 1 FROM app_private.affiliate_compliance_policy_review_events n WHERE n.workspace_id=legal.workspace_id AND n.policy_pack_id=legal.policy_pack_id
     AND n.supersedes_event_id IN(legal.id,commercial.id))
    AND NOT EXISTS(SELECT 1 FROM app_private.affiliate_compliance_specialist_decision_events n WHERE n.workspace_id=sr.workspace_id AND n.subject_id=sr.subject_id
     AND n.supersedes_event_id IN(sr.id,ir.id))
    AND NOT EXISTS(SELECT 1 FROM app_private.affiliate_compliance_permission_fact_events b WHERE b.workspace_id=s.workspace_id
     AND b.subject_id=s.compliance_subject_id AND b.permission='whatsapp.send' AND b.action_scope_sha256=scope
     AND b.permission_state IN('blocked','revoked','expired') AND b.valid_from<=now_at AND (b.valid_until IS NULL OR b.valid_until>now_at)
     AND NOT EXISTS(SELECT 1 FROM app_private.affiliate_compliance_permission_fact_events n WHERE n.workspace_id=b.workspace_id AND n.subject_id=b.subject_id
      AND n.permission=b.permission AND n.action_scope_sha256=b.action_scope_sha256 AND n.supersedes_event_id=b.id)))
 THEN RETURN jsonb_build_object('ok',false,'reason','not_eligible'); END IF;
 RETURN jsonb_build_object('ok',true,'observationId',observation,'actionScopeSha256',encode(scope,'hex'),
  'evaluatedAt',to_char(now_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'receiptId',s.receipt_id,'revision',s.receipt_revision);
END $f$;
REVOKE ALL ON FUNCTION app_private.mhp_event_whatsapp_eligible(uuid,boolean) FROM PUBLIC;

CREATE FUNCTION app_private.mhp_prepare_event_whatsapp(p_workspace uuid,p_connection uuid,p_limit integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE ws constant uuid:='2789228d-55a6-4688-b1e8-2f70abca990b'; candidate uuid; s app_private.mhp_event_whatsapp_sends%ROWTYPE; elig jsonb;
 prepared timestamptz; expiry timestamptz; authority uuid; job uuid; request text:=current_setting('app.request_id',true); decision_sha bytea; request_sha bytea;
 sender_sha bytea; instigator_sha bytea; day_jobs integer; month_jobs integer; done jsonb:='[]'::jsonb; held jsonb:='[]'::jsonb; reason text;
BEGIN
 PERFORM app_private.mhp_event_whatsapp_worker_context(p_workspace);
 IF p_connection IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 3 THEN RAISE EXCEPTION 'MHP event WhatsApp prepare denied' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN RAISE EXCEPTION 'MHP event WhatsApp prepare requires read committed' USING ERRCODE='25000'; END IF;
 FOR candidate IN SELECT x.id FROM app_private.mhp_event_whatsapp_sends x WHERE x.provider_connection_id=p_connection AND x.due_at<=statement_timestamp()
  AND x.cancelled_at IS NULL AND x.held_at IS NULL AND x.job_id IS NULL ORDER BY x.due_at,x.id LIMIT p_limit LOOP
  SELECT * INTO s FROM app_private.mhp_event_whatsapp_sends x WHERE x.id=candidate;
  IF NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('company-content:'||ws::text||':'||s.programme_item_id::text,7200021))
   OR NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('company-content:'||ws::text||':'||s.source_item_id::text,7200021))
   OR NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('mhp.event-whatsapp.prospect:'||s.campaign||':'||s.prospect_id::text,7200131))
  THEN CONTINUE; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(format('pp-whatsapp-live:%s:%s',ws,s.binding_id),0));
  SELECT * INTO s FROM app_private.mhp_event_whatsapp_sends x WHERE x.id=candidate FOR UPDATE SKIP LOCKED;
  IF NOT FOUND OR s.job_id IS NOT NULL OR s.cancelled_at IS NOT NULL OR s.held_at IS NOT NULL THEN CONTINUE; END IF;
  BEGIN
   elig:=app_private.mhp_event_whatsapp_eligible(s.id,true);
   IF (elig->>'ok')::boolean IS NOT TRUE THEN
    reason:=CASE elig->>'reason' WHEN 'not_due' THEN NULL WHEN 'held' THEN NULL ELSE elig->>'reason' END;
    IF reason='template_not_approved' AND s.expires_at>statement_timestamp() THEN reason:=NULL; END IF; -- retry until a fresh APPROVED read or expiry
    IF reason IS NOT NULL THEN
     UPDATE app_private.mhp_event_whatsapp_sends SET held_at=statement_timestamp(),hold_reason=reason WHERE id=s.id;
     held:=held||jsonb_build_array(jsonb_build_object('sendId',s.id,'reason',reason));
    END IF;
    CONTINUE;
   END IF;
   prepared:=date_trunc('milliseconds',statement_timestamp()); expiry:=least(prepared+interval '4 minutes',s.expires_at);
   SELECT count(*) FILTER (WHERE j.utc_day=(prepared AT TIME ZONE 'UTC')::date)::integer,count(*)::integer INTO day_jobs,month_jobs
   FROM app.property_predator_whatsapp_live_jobs j WHERE j.workspace_id=ws AND j.binding_id=s.binding_id
    AND j.utc_month=date_trunc('month',prepared AT TIME ZONE 'UTC')::date AND j.state<>'cancelled';
   IF day_jobs>=1 OR month_jobs>=3 THEN
    UPDATE app_private.mhp_event_whatsapp_sends SET held_at=statement_timestamp(),hold_reason='cap_reached' WHERE id=s.id;
    held:=held||jsonb_build_array(jsonb_build_object('sendId',s.id,'reason','cap_reached'));
    CONTINUE;
   END IF;
   SELECT sr.decision_sha256,ir.decision_sha256 INTO sender_sha,instigator_sha FROM app_private.affiliate_compliance_specialist_decision_events sr,
    app_private.affiliate_compliance_specialist_decision_events ir WHERE sr.workspace_id=ws AND sr.id=s.pecr_sender_decision_id AND ir.workspace_id=ws AND ir.id=s.pecr_instigator_decision_id;
   decision_sha:=public.digest((elig||jsonb_build_object('evaluatedByRole','r72_whatsapp_live_worker_command','evaluatedRequestId',request,
    'authorityExpiresAt',to_char(expiry AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'dayJobsBefore',day_jobs,'monthJobsBefore',month_jobs))::text,'sha256');
   authority:=gen_random_uuid(); job:=gen_random_uuid();
   request_sha:=public.digest(pg_catalog.concat_ws(pg_catalog.chr(31),'mhp.event-whatsapp-live/v1',ws::text,s.binding_id::text,s.template_id::text,
    encode(s.recipient_sha256,'hex'),s.purpose,s.consent_event_id::text,s.id::text,s.receipt_id::text,elig->>'observationId',
    to_char(expiry AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),s.operation_id::text,encode(s.idempotency_key_sha256,'hex'),
    elig->>'actionScopeSha256','worker','r72_whatsapp_live_worker_command',request),'sha256');
   INSERT INTO app.property_predator_whatsapp_live_authorities(id,workspace_id,binding_id,template_id,provider_connection_id,contact_id,contact_point_id,
    recipient_sha256,purpose,consent_event_id,compliance_subject_id,policy_publication_event_id,pecr_sender_decision_event_id,pecr_instigator_decision_event_id,
    permission_use_receipt_id,pecr_decision,pecr_evidence_sha256,operator_instigator_decision,operator_instigator_sha256,action_scope_sha256,operator_user_id,
    operator_request_id,evaluated_at,valid_until,authority_kind,event_send_id,event_receipt_id,event_template_observation_id,evaluated_by_role,
    evaluated_request_id,event_eligibility_sha256)
   VALUES(authority,ws,s.binding_id,s.template_id,s.provider_connection_id,s.contact_id,s.point_id,s.recipient_sha256,s.purpose,s.consent_event_id,
    s.compliance_subject_id,s.policy_publication_id,s.pecr_sender_decision_id,s.pecr_instigator_decision_id,NULL,'eligible',sender_sha,'eligible',
    instigator_sha,decode(elig->>'actionScopeSha256','hex'),NULL,NULL,prepared,expiry,'mhp_event',s.id,s.receipt_id,(elig->>'observationId')::uuid,
    'r72_whatsapp_live_worker_command',request,decision_sha);
   INSERT INTO app.property_predator_whatsapp_live_jobs(id,workspace_id,binding_id,template_id,authority_id,provider_connection_id,recipient_sha256,operation_id,
    idempotency_key_sha256,request_sha256,utc_day,utc_month,created_by_user_id,authority_kind,event_send_id,created_by_actor_kind)
   VALUES(job,ws,s.binding_id,s.template_id,authority,s.provider_connection_id,s.recipient_sha256,s.operation_id,s.idempotency_key_sha256,request_sha,
    (prepared AT TIME ZONE 'UTC')::date,date_trunc('month',prepared AT TIME ZONE 'UTC')::date,NULL,'mhp_event',s.id,'worker');
   UPDATE app_private.mhp_event_whatsapp_sends SET prepared_at=prepared,authority_expires_at=expiry,authority_id=authority,job_id=job,
    preparation_request_id=request,decision_sha256=decision_sha,prepared_observation_id=(elig->>'observationId')::uuid WHERE id=s.id;
   IF clock_timestamp()>=expiry THEN RAISE EXCEPTION 'MHP event WhatsApp preparation expired while waiting' USING ERRCODE='40001'; END IF;
   done:=done||jsonb_build_array(jsonb_build_object('sendId',s.id,'jobId',job,'authorityId',authority,'replayed',false));
  EXCEPTION
   WHEN sqlstate '40001' OR sqlstate '40P01' OR sqlstate '55P03' OR sqlstate '23505' THEN NULL;
   WHEN OTHERS THEN
    UPDATE app_private.mhp_event_whatsapp_sends SET held_at=statement_timestamp(),hold_reason='not_eligible'
    WHERE id=s.id AND held_at IS NULL AND cancelled_at IS NULL AND job_id IS NULL;
    held:=held||jsonb_build_array(jsonb_build_object('sendId',s.id,'reason','prepare_failed'));
  END;
 END LOOP;
 RETURN jsonb_build_object('prepared',done,'held',held,'providerEffects','none');
END $f$;

CREATE FUNCTION app_private.claim_event_whatsapp_job(p_workspace_id uuid,p_provider_connection_id uuid,p_lease_token bytea,p_lease_seconds integer)
RETURNS TABLE(job_id uuid,binding_id uuid,lease_version bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE selected app.property_predator_whatsapp_live_jobs%ROWTYPE; recovered app.property_predator_whatsapp_live_jobs%ROWTYPE; next_version bigint;
BEGIN
 PERFORM app_private.mhp_event_whatsapp_worker_context(p_workspace_id);
 IF octet_length(p_lease_token) IS DISTINCT FROM 32 OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 300
 THEN RAISE EXCEPTION 'MHP event WhatsApp claim denied' USING ERRCODE='42501'; END IF;
 -- Same recovery semantics as 0053 for event jobs only; calling/awaiting is never retried.
 FOR recovered IN SELECT job.* FROM app.property_predator_whatsapp_live_jobs AS job
  WHERE job.workspace_id=p_workspace_id AND job.provider_connection_id=p_provider_connection_id AND job.authority_kind='mhp_event'
   AND ((job.state IN('leased','calling') AND job.lease_expires_at<=statement_timestamp()) OR (job.state='awaiting_status' AND job.status_deadline<=statement_timestamp()))
  FOR UPDATE SKIP LOCKED LOOP
  IF recovered.state IN('calling','awaiting_status') THEN
   INSERT INTO app.property_predator_whatsapp_live_receipts(workspace_id,job_id,binding_id,external_event_id,event_kind,provider_message_id,
    recipient_or_sender_sha256,body_sha256,payload_sha256,safe_code,provider_occurred_at)
   VALUES(recovered.workspace_id,recovered.id,recovered.binding_id,format('worker-timeout:%s:%s',recovered.id,recovered.lease_version),'outcome_unknown',
    recovered.provider_message_id,recovered.recipient_sha256,NULL,public.digest(format('worker-timeout:%s:%s',recovered.id,recovered.lease_version),'sha256'),
    'worker_whatsapp_outcome_unknown',statement_timestamp())
   ON CONFLICT ON CONSTRAINT property_predator_whatsapp_li_workspace_id_binding_id_exter_key DO NOTHING;
  END IF;
  UPDATE app.property_predator_whatsapp_live_jobs AS j SET state=CASE WHEN recovered.state='leased' THEN 'queued' ELSE 'needs_attention' END,
   lease_expires_at=NULL,status_deadline=NULL,available_at=CASE WHEN recovered.state='leased' THEN statement_timestamp() ELSE j.available_at END,
   settled_at=CASE WHEN recovered.state='leased' THEN j.settled_at ELSE statement_timestamp() END,updated_at=statement_timestamp()
  WHERE j.workspace_id=recovered.workspace_id AND j.id=recovered.id;
  DELETE FROM app.property_predator_whatsapp_live_job_leases AS lease WHERE lease.workspace_id=recovered.workspace_id AND lease.job_id=recovered.id;
 END LOOP;
 -- Queued event jobs that were held/cancelled or whose authority lapsed were never handed over.
 WITH stale AS (
  UPDATE app.property_predator_whatsapp_live_jobs AS j SET state='cancelled',settled_at=statement_timestamp(),updated_at=statement_timestamp()
  FROM app_private.mhp_event_whatsapp_sends AS s, app.property_predator_whatsapp_live_authorities AS a
  WHERE j.workspace_id=p_workspace_id AND j.provider_connection_id=p_provider_connection_id AND j.authority_kind='mhp_event' AND j.state='queued'
   AND s.id=j.event_send_id AND a.workspace_id=j.workspace_id AND a.id=j.authority_id
   AND (s.held_at IS NOT NULL OR s.cancelled_at IS NOT NULL OR a.valid_until<=statement_timestamp())
  RETURNING j.event_send_id)
 UPDATE app_private.mhp_event_whatsapp_sends AS s SET held_at=statement_timestamp(),hold_reason='expired'
 FROM stale WHERE s.id=stale.event_send_id AND s.held_at IS NULL AND s.cancelled_at IS NULL;
 SELECT job.* INTO selected FROM app.property_predator_whatsapp_live_jobs AS job
 JOIN app.property_predator_whatsapp_live_authorities AS a ON a.workspace_id=job.workspace_id AND a.id=job.authority_id AND a.authority_kind='mhp_event'
  AND a.event_send_id=job.event_send_id AND a.valid_until>statement_timestamp()
 JOIN app_private.mhp_event_whatsapp_sends AS s ON s.id=job.event_send_id AND s.job_id=job.id AND s.cancelled_at IS NULL AND s.held_at IS NULL
 WHERE job.workspace_id=p_workspace_id AND job.provider_connection_id=p_provider_connection_id AND job.authority_kind='mhp_event'
  AND job.state='queued' AND job.available_at<=statement_timestamp() AND job.claim_count<8
 ORDER BY job.available_at,job.created_at,job.id LIMIT 1 FOR UPDATE OF job SKIP LOCKED;
 IF NOT FOUND THEN RETURN; END IF;
 next_version:=selected.lease_version+1;
 UPDATE app.property_predator_whatsapp_live_jobs AS j SET state='leased',lease_version=next_version,
  lease_expires_at=statement_timestamp()+make_interval(secs=>p_lease_seconds),claim_count=j.claim_count+1,updated_at=statement_timestamp()
 WHERE j.workspace_id=p_workspace_id AND j.id=selected.id;
 INSERT INTO app.property_predator_whatsapp_live_job_leases(workspace_id,job_id,lease_version,lease_token_sha256)
 VALUES(p_workspace_id,selected.id,next_version,public.digest(p_lease_token,'sha256'))
 ON CONFLICT ON CONSTRAINT property_predator_whatsapp_live_job_leases_pkey DO UPDATE SET lease_version=EXCLUDED.lease_version,
  lease_token_sha256=EXCLUDED.lease_token_sha256,issued_at=statement_timestamp();
 RETURN QUERY SELECT selected.id,selected.binding_id,next_version;
END $f$;

CREATE FUNCTION app_private.load_event_whatsapp_job(p_workspace_id uuid,p_job_id uuid,p_lease_version bigint,p_lease_token bytea)
RETURNS TABLE(provider_connection_id uuid,binding_id uuid,app_id text,waba_id text,phone_number_id text,graph_api_version text,secret_key_version text,
 secret_iv bytea,secret_ciphertext bytea,secret_auth_tag bytea,secret_aad_sha256 bytea,secret_payload_sha256 bytea,recipient text,template_name text,
 language_code text,operation_id uuid,request_sha256 bytea,meta_template_id text,send_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE elig jsonb; send uuid;
BEGIN
 PERFORM app_private.mhp_event_whatsapp_worker_context(p_workspace_id);
 SELECT job.event_send_id INTO send FROM app.property_predator_whatsapp_live_jobs AS job
 JOIN app.property_predator_whatsapp_live_job_leases AS lease ON lease.workspace_id=job.workspace_id AND lease.job_id=job.id
  AND lease.lease_version=job.lease_version AND lease.lease_token_sha256=public.digest(p_lease_token,'sha256')
 WHERE job.workspace_id=p_workspace_id AND job.id=p_job_id AND job.authority_kind='mhp_event' AND job.state='leased'
  AND job.lease_version=p_lease_version AND job.lease_expires_at>statement_timestamp();
 IF send IS NULL THEN RETURN; END IF;
 elig:=app_private.mhp_event_whatsapp_eligible(send,true);
 IF (elig->>'ok')::boolean IS NOT TRUE THEN RETURN; END IF;
 RETURN QUERY SELECT job.provider_connection_id,job.binding_id,b.app_id,b.waba_id,b.phone_number_id,b.graph_api_version,b.secret_key_version,
  b.secret_iv,b.secret_ciphertext,b.secret_auth_tag,b.secret_aad_sha256,b.secret_payload_sha256,p.normalized_value,t.provider_template_name,
  t.language_code,job.operation_id,job.request_sha256,s.meta_template_id,s.id
 FROM app.property_predator_whatsapp_live_jobs AS job
 JOIN app.property_predator_whatsapp_live_authorities AS a ON a.workspace_id=job.workspace_id AND a.id=job.authority_id AND a.authority_kind='mhp_event'
  AND a.event_send_id=job.event_send_id AND a.valid_until>statement_timestamp() AND a.recipient_sha256=job.recipient_sha256
 JOIN app_private.mhp_event_whatsapp_sends AS s ON s.id=job.event_send_id AND s.job_id=job.id AND s.authority_id=a.id
 JOIN app.property_predator_whatsapp_live_bindings AS b ON b.workspace_id=job.workspace_id AND b.id=job.binding_id AND b.status='active'
 JOIN app.property_predator_whatsapp_live_templates AS t ON t.workspace_id=job.workspace_id AND t.id=job.template_id AND t.provider_status='approved'
 JOIN app.contact_points AS p ON p.workspace_id=a.workspace_id AND p.id=a.contact_point_id AND p.kind='whatsapp' AND p.is_verified AND p.deleted_at IS NULL
  AND public.digest(regexp_replace(p.normalized_value,'^\\+',''),'sha256')=job.recipient_sha256
 WHERE job.workspace_id=p_workspace_id AND job.id=p_job_id;
END $f$;

CREATE FUNCTION app_private.begin_event_whatsapp_call(p_workspace_id uuid,p_job_id uuid,p_lease_version bigint,p_lease_token bytea,
 p_provider_effects_enabled boolean,p_emergency_paused boolean) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE selected app.property_predator_whatsapp_live_jobs%ROWTYPE; elig jsonb; ok boolean;
BEGIN
 PERFORM app_private.mhp_event_whatsapp_worker_context(p_workspace_id);
 IF p_provider_effects_enabled IS NOT TRUE OR p_emergency_paused IS NOT FALSE OR octet_length(p_lease_token) IS DISTINCT FROM 32
 THEN RAISE EXCEPTION 'MHP event WhatsApp begin-call denied' USING ERRCODE='42501'; END IF;
 SELECT job.* INTO selected FROM app.property_predator_whatsapp_live_jobs AS job
 JOIN app.property_predator_whatsapp_live_job_leases AS lease ON lease.workspace_id=job.workspace_id AND lease.job_id=job.id
  AND lease.lease_version=job.lease_version AND lease.lease_token_sha256=public.digest(p_lease_token,'sha256')
 WHERE job.workspace_id=p_workspace_id AND job.id=p_job_id AND job.authority_kind='mhp_event' AND job.state='leased'
  AND job.lease_version=p_lease_version AND job.lease_expires_at>statement_timestamp() FOR UPDATE OF job;
 IF NOT FOUND THEN RETURN false; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(format('pp-whatsapp-call-fence:%s:%s',p_workspace_id,selected.binding_id),0));
 -- Fresh committed reads: a STOP, withdrawal, new draft or non-APPROVED Meta read that committed first denies.
 elig:=app_private.mhp_event_whatsapp_eligible(selected.event_send_id,true);
 SELECT (elig->>'ok')::boolean IS TRUE AND EXISTS(SELECT 1 FROM app.property_predator_whatsapp_live_authorities a
   JOIN app_private.mhp_event_whatsapp_sends s ON s.id=a.event_send_id AND s.job_id=selected.id AND s.authority_id=a.id
  WHERE a.workspace_id=selected.workspace_id AND a.id=selected.authority_id AND a.authority_kind='mhp_event' AND a.event_send_id=selected.event_send_id
   AND a.binding_id=selected.binding_id AND a.template_id=selected.template_id AND a.recipient_sha256=selected.recipient_sha256
   AND a.valid_until>statement_timestamp() AND a.action_scope_sha256=decode(elig->>'actionScopeSha256','hex'))
  AND (SELECT count(*) FROM app.property_predator_whatsapp_live_jobs j WHERE j.workspace_id=p_workspace_id AND j.binding_id=selected.binding_id
   AND j.utc_month=date_trunc('month',statement_timestamp() AT TIME ZONE 'UTC')::date AND j.state<>'cancelled')<=3
  AND selected.utc_day=(statement_timestamp() AT TIME ZONE 'UTC')::date INTO ok;
 IF NOT ok THEN
  UPDATE app.property_predator_whatsapp_live_jobs SET state='needs_attention',lease_expires_at=NULL,settled_at=statement_timestamp(),updated_at=statement_timestamp()
  WHERE workspace_id=p_workspace_id AND id=p_job_id;
  DELETE FROM app.property_predator_whatsapp_live_job_leases AS lease WHERE lease.workspace_id=p_workspace_id AND lease.job_id=p_job_id;
  RETURN false;
 END IF;
 UPDATE app.property_predator_whatsapp_live_jobs SET state='calling',calling_at=statement_timestamp(),updated_at=statement_timestamp()
 WHERE workspace_id=p_workspace_id AND id=p_job_id AND state='leased';
 RETURN FOUND;
END $f$;

CREATE FUNCTION app_private.mhp_hold_event_whatsapp() RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE ws constant uuid:='2789228d-55a6-4688-b1e8-2f70abca990b'; held integer; cancelled integer; report jsonb;
BEGIN
 PERFORM app_private.mhp_event_whatsapp_worker_context(ws);
 UPDATE app.property_predator_whatsapp_live_jobs SET state='cancelled',settled_at=statement_timestamp(),updated_at=statement_timestamp()
 WHERE workspace_id=ws AND authority_kind='mhp_event' AND state='queued';
 GET DIAGNOSTICS cancelled=ROW_COUNT;
 UPDATE app_private.mhp_event_whatsapp_sends s SET held_at=statement_timestamp(),hold_reason='recovery'
 WHERE s.cancelled_at IS NULL AND s.held_at IS NULL
  AND (s.job_id IS NULL OR EXISTS(SELECT 1 FROM app.property_predator_whatsapp_live_jobs j WHERE j.workspace_id=ws AND j.id=s.job_id AND j.state='cancelled'));
 GET DIAGNOSTICS held=ROW_COUNT;
 SELECT jsonb_build_object('held',held,'queuedJobsCancelled',cancelled,'inFlight',count(*) FILTER (WHERE j.state IN('leased','calling')),
  'awaitingStatus',count(*) FILTER (WHERE j.state='awaiting_status'),'needsAttention',count(*) FILTER (WHERE j.state='needs_attention'),'providerEffects','none')
 INTO report FROM app.property_predator_whatsapp_live_jobs j WHERE j.workspace_id=ws AND j.authority_kind='mhp_event';
 RETURN report;
END $f$;
REVOKE ALL ON FUNCTION app_private.mhp_prepare_event_whatsapp(uuid,uuid,integer),app_private.claim_event_whatsapp_job(uuid,uuid,bytea,integer),
 app_private.load_event_whatsapp_job(uuid,uuid,bigint,bytea),app_private.begin_event_whatsapp_call(uuid,uuid,bigint,bytea,boolean,boolean),
 app_private.mhp_hold_event_whatsapp() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.mhp_prepare_event_whatsapp(uuid,uuid,integer),app_private.claim_event_whatsapp_job(uuid,uuid,bytea,integer),
 app_private.load_event_whatsapp_job(uuid,uuid,bigint,bytea),app_private.begin_event_whatsapp_call(uuid,uuid,bigint,bytea,boolean,boolean),
 app_private.mhp_hold_event_whatsapp() TO r72_whatsapp_live_worker_command;

-- 12. A new WhatsApp programme or draft version holds unprepared follow-ups.
RESET ROLE;
SET LOCAL ROLE r72_mhp_prospect_definer;
CREATE FUNCTION app_private.mhp_event_whatsapp_new_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 IF NEW.workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND NEW.source_system IN('mhp.event-whatsapp','mhp.owner-whatsapp') THEN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('company-content:'||NEW.workspace_id::text||':'||NEW.content_item_id::text,7200021));
  UPDATE app_private.mhp_event_whatsapp_sends s SET held_at=clock_timestamp(),hold_reason='newer_draft'
  WHERE (s.programme_item_id=NEW.content_item_id OR s.source_item_id=NEW.content_item_id) AND s.programme_version_id<>NEW.id AND s.source_version_id<>NEW.id
   AND s.cancelled_at IS NULL AND s.held_at IS NULL AND s.job_id IS NULL;
 END IF;
 RETURN NEW;
END $f$;
REVOKE ALL ON FUNCTION app_private.mhp_event_whatsapp_new_version() FROM PUBLIC;
RESET ROLE;
SET LOCAL ROLE r72_owner;
CREATE TRIGGER mhp_event_whatsapp_new_version AFTER INSERT ON app.company_content_versions FOR EACH ROW EXECUTE FUNCTION app_private.mhp_event_whatsapp_new_version();
RESET ROLE;
REVOKE CREATE ON SCHEMA app_private FROM r72_whatsapp_live_definer,r72_mhp_prospect_definer;
