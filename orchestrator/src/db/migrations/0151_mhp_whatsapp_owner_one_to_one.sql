-- MHP-WA-121-001: one-to-one owner WhatsApp from the shared Martin Howard Property (MHP) sender
-- for a CRM contact of any group brand (pp, mhp, kp, piuk, ...). Additive on 0053/0141/0143.
--
-- What this adds, and what it does not change:
-- * The send is authorised and executed in the MHP workspace, where the 0053 binding lives. The
--   original brand contact is linked (never moved): the one existing MHP contact with the same number
--   or e-mail is reused, a person MHP has never seen is mirrored, and a person who matches more than
--   one MHP contact is refused (never duplicated). Every outcome is written as an activity on BOTH the
--   original brand contact and the MHP contact.
-- * A business-initiated message is an approved Meta template only, read server-side from Meta by the
--   worker (no owner-typed approval), with body variables (named or positional) validated against the
--   template's real placeholders. Free text is only the 0143 in-window reply (mhp_wa_direct_queue).
-- * Template sends ride the 0053 rail with a third authority kind, 'mhp_owner_direct', exactly as
--   0141 added 'mhp_event': one authority + one job per send, consent event, compliance subject,
--   published owner review and PECR sender/instigator route records. The 0053 enqueue, the legacy
--   owner-action caps and the 0141 event rail are unchanged. The rail's 0053 template row is its own,
--   per Meta template id under a reserved name, so it never takes the name a webinar programme pins.
-- * Permission is the existing 0063 founder rail (record_contact_permission_decision) for channel
--   whatsapp and purpose 'mhp.owner-one-to-one'. A later withdrawal, denial, suppression, opt-out or
--   signed WhatsApp STOP blocks the send, at queue time and again at begin-call; so does an opt-out or
--   STOP on any point of the original brand contact that carries the number. Begin-call also re-proves
--   that the template Meta holds still renders exactly the message the owner previewed.
-- * UNRATIFIED (see docs/design/mhp-whatsapp-owner-121-20261112/MHP-WA-121-DECISION-PROPOSALS.md): owner-attested number
--   state (proposal 1), evidence kinds and PECR route mapping (proposal 2), daily cap and recipient
--   pacing (proposal 3), provider-restriction holds (proposal 4). An owner attestation never sets
--   contact_points.is_verified and only satisfies this one purpose.
-- This migration takes brief exclusive locks on shared tables (contacts, contact points, activities,
-- the 0053 jobs and authorities). Fail cleanly after five seconds instead of queueing behind live
-- traffic; a failed attempt changes nothing and can simply be run again.
SET LOCAL lock_timeout='5s';
SET LOCAL ROLE r72_owner;

-- 1. Links between an original brand contact and the MHP contact/point that carries the send.
CREATE TABLE app_private.mhp_wa_owner_links (
 id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL CHECK(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b'),
 origin_workspace_id uuid NOT NULL,
 origin_brand text NOT NULL CHECK(origin_brand IN('pp','mhp','kp','piuk','hnh','ordris','group')),
 origin_contact_id uuid NOT NULL,
 origin_point_id uuid,
 number_source text NOT NULL CHECK(number_source IN('crm_point','owner_entered')),
 mhp_contact_id uuid NOT NULL,
 mhp_point_id uuid NOT NULL,
 number text NOT NULL CHECK(number~'^[1-9][0-9]{6,14}$'),
 created_by_user_id uuid NOT NULL,
 created_request_id text NOT NULL CHECK(created_request_id=btrim(created_request_id) AND length(created_request_id) BETWEEN 1 AND 128),
 created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 UNIQUE(origin_workspace_id,origin_contact_id,number),
 FOREIGN KEY(origin_workspace_id,origin_contact_id) REFERENCES app.contacts(workspace_id,id) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,mhp_point_id,mhp_contact_id) REFERENCES app.contact_points(workspace_id,id,contact_id) ON DELETE CASCADE,
 CHECK((number_source='crm_point')=(origin_point_id IS NOT NULL))
);
CREATE INDEX mhp_wa_owner_links_mhp ON app_private.mhp_wa_owner_links(mhp_contact_id);

-- 2. Owner-attested number state (proposal 1). Append-only; the latest row for a point wins.
CREATE TABLE app_private.mhp_wa_owner_attestations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL CHECK(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b'),
 link_id uuid NOT NULL REFERENCES app_private.mhp_wa_owner_links(id) ON DELETE CASCADE,
 mhp_point_id uuid NOT NULL,
 endpoint_identity_sha256 bytea NOT NULL CHECK(octet_length(endpoint_identity_sha256)=32),
 purpose text NOT NULL CHECK(purpose='mhp.owner-one-to-one'),
 state text NOT NULL CHECK(state IN('owner_attested','withdrawn')),
 evidence_kind text CHECK(evidence_kind IS NULL OR evidence_kind IN('asked_to_be_contacted','written_consent','business_introduction','existing_client')),
 evidence_note text CHECK(evidence_note IS NULL OR (length(btrim(evidence_note)) BETWEEN 8 AND 500 AND evidence_note!~'[[:cntrl:]]')),
 command_key_sha256 bytea NOT NULL CHECK(octet_length(command_key_sha256)=32),
 actor_user_id uuid NOT NULL,
 request_id text NOT NULL CHECK(request_id=btrim(request_id) AND length(request_id) BETWEEN 1 AND 128),
 recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 UNIQUE(workspace_id,command_key_sha256),
 CHECK((state='owner_attested')=(evidence_kind IS NOT NULL AND evidence_note IS NOT NULL))
);
CREATE INDEX mhp_wa_owner_attestations_latest ON app_private.mhp_wa_owner_attestations(mhp_point_id,recorded_at DESC,id DESC);

-- 3. Server-side Meta template catalogue for the MHP number (worker-only evidence, 15-minute life).
-- One row per distinct content Meta returned: a later read of exactly the same template refreshes
-- observed_at/expires_at on that row (first_observed_at keeps the first read); any change is a new row.
CREATE TABLE app_private.mhp_wa_owner_templates (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL CHECK(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b'),
 binding_id uuid NOT NULL,
 meta_template_id text NOT NULL CHECK(meta_template_id~'^[1-9][0-9]{4,29}$'),
 template_name text NOT NULL CHECK(template_name~'^[a-z][a-z0-9_]*$' AND char_length(template_name)<=512),
 language_code text NOT NULL CHECK(language_code~'^[a-z]{2,3}(_[A-Z]{2})?$'),
 category text NOT NULL CHECK(category IN('MARKETING','UTILITY','AUTHENTICATION')),
 provider_status text NOT NULL CHECK(provider_status~'^[A-Z_]{1,40}$'),
 parameter_format text NOT NULL CHECK(parameter_format IN('NONE','POSITIONAL','NAMED')),
 parameter_names text[] NOT NULL CHECK(cardinality(parameter_names) BETWEEN 0 AND 20),
 body_text text NOT NULL CHECK(char_length(body_text) BETWEEN 1 AND 1024),
 preview_text text NOT NULL CHECK(char_length(preview_text) BETWEEN 1 AND 2048),
 body_sha256 bytea NOT NULL CHECK(octet_length(body_sha256)=32),
 components_sha256 bytea NOT NULL CHECK(octet_length(components_sha256)=32),
 sendable boolean NOT NULL,
 unsupported_reason text CHECK(unsupported_reason IS NULL OR unsupported_reason~'^[a-z][a-z0-9_]{0,63}$'),
 observed_by_role text NOT NULL CHECK(observed_by_role='r72_whatsapp_live_worker_command'),
 observed_request_id text NOT NULL CHECK(observed_request_id=btrim(observed_request_id) AND length(observed_request_id) BETWEEN 1 AND 128),
 first_observed_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 observed_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 expires_at timestamptz NOT NULL,
 FOREIGN KEY(workspace_id,binding_id) REFERENCES app.property_predator_whatsapp_live_bindings(workspace_id,id) ON DELETE RESTRICT,
 CHECK(expires_at>observed_at AND expires_at<=observed_at+interval '15 minutes'),
 CHECK(first_observed_at<=observed_at),
 CHECK(sendable=(unsupported_reason IS NULL)),
 CHECK((parameter_format='NONE')=(cardinality(parameter_names)=0))
);
CREATE INDEX mhp_wa_owner_templates_latest ON app_private.mhp_wa_owner_templates(binding_id,meta_template_id,observed_at DESC,id DESC);

-- 4. One row per owner send (template or in-window text). The id is the caller's idempotency key.
CREATE TABLE app_private.mhp_wa_owner_sends (
 id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL CHECK(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b'),
 link_id uuid NOT NULL REFERENCES app_private.mhp_wa_owner_links(id) ON DELETE RESTRICT,
 binding_id uuid NOT NULL,
 actor_user_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN('template','text')),
 recipient_sha256 bytea NOT NULL CHECK(octet_length(recipient_sha256)=32),
 template_observation_id uuid REFERENCES app_private.mhp_wa_owner_templates(id) ON DELETE RESTRICT,
 meta_template_id text, template_name text, language_code text, category text,
 parameter_format text CHECK(parameter_format IS NULL OR parameter_format IN('NONE','POSITIONAL','NAMED')),
 parameters jsonb CHECK(parameters IS NULL OR jsonb_typeof(parameters)='array'),
 body_sha256 bytea CHECK(body_sha256 IS NULL OR octet_length(body_sha256)=32),
 rendered_text text NOT NULL CHECK(char_length(rendered_text) BETWEEN 1 AND 4096),
 rendered_sha256 bytea NOT NULL CHECK(octet_length(rendered_sha256)=32),
 request_sha256 bytea NOT NULL CHECK(octet_length(request_sha256)=32),
 consent_event_id uuid,
 attestation_id uuid REFERENCES app_private.mhp_wa_owner_attestations(id) ON DELETE RESTRICT,
 verification text NOT NULL CHECK(verification IN('meta_verified','owner_attested','inbound_window')),
 authority_id uuid, job_id uuid UNIQUE,
 direct_reply_id uuid UNIQUE REFERENCES app_private.mhp_wa_direct_replies(id) ON DELETE RESTRICT,
 state text NOT NULL CHECK(state IN('queued','calling','accepted','sent','delivered','read','failed','outcome_unknown','expired','blocked')),
 state_reason text CHECK(state_reason IS NULL OR state_reason~'^[a-z][a-z0-9_]{0,63}$'),
 provider_message_id text CHECK(provider_message_id IS NULL OR provider_message_id~'^wamid[.][A-Za-z0-9_=-]{1,190}$'),
 error_code integer CHECK(error_code IS NULL OR error_code BETWEEN 0 AND 999999999),
 utc_day date NOT NULL,
 request_id text NOT NULL CHECK(request_id=btrim(request_id) AND length(request_id) BETWEEN 1 AND 128),
 created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 FOREIGN KEY(workspace_id,binding_id) REFERENCES app.property_predator_whatsapp_live_bindings(workspace_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(workspace_id,consent_event_id) REFERENCES app.communication_consent_events(workspace_id,id) ON DELETE RESTRICT,
 CONSTRAINT mhp_wa_owner_send_shape CHECK(
  (kind='template' AND template_observation_id IS NOT NULL AND meta_template_id IS NOT NULL AND template_name IS NOT NULL
   AND language_code IS NOT NULL AND category IN('MARKETING','UTILITY') AND parameter_format IS NOT NULL AND parameters IS NOT NULL
   AND body_sha256 IS NOT NULL AND consent_event_id IS NOT NULL AND verification IN('meta_verified','owner_attested')
   AND (verification='owner_attested')=(attestation_id IS NOT NULL) AND authority_id IS NOT NULL AND job_id IS NOT NULL AND direct_reply_id IS NULL)
  OR (kind='text' AND template_observation_id IS NULL AND meta_template_id IS NULL AND parameters IS NULL AND verification='inbound_window'
   AND attestation_id IS NULL AND authority_id IS NULL AND job_id IS NULL AND direct_reply_id IS NOT NULL)),
 CHECK(updated_at>=created_at)
);
CREATE INDEX mhp_wa_owner_sends_day ON app_private.mhp_wa_owner_sends(binding_id,utc_day) WHERE kind='template';
CREATE INDEX mhp_wa_owner_sends_recipient ON app_private.mhp_wa_owner_sends(recipient_sha256,created_at DESC);
CREATE INDEX mhp_wa_owner_sends_link ON app_private.mhp_wa_owner_sends(link_id,created_at DESC);
CREATE INDEX mhp_wa_owner_sends_wamid ON app_private.mhp_wa_owner_sends(provider_message_id) WHERE provider_message_id IS NOT NULL;

-- 5. Provider restriction holds (proposal 4). Append-only; a hold ends only when its time passes.
CREATE TABLE app_private.mhp_wa_owner_holds (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL CHECK(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b'),
 binding_id uuid NOT NULL,
 scope text NOT NULL CHECK(scope IN('account','recipient')),
 recipient_sha256 bytea CHECK(recipient_sha256 IS NULL OR octet_length(recipient_sha256)=32),
 error_code integer NOT NULL CHECK(error_code BETWEEN 0 AND 999999999),
 reason text NOT NULL CHECK(reason~'^[a-z][a-z0-9_]{0,63}$'),
 source_send_id uuid NOT NULL REFERENCES app_private.mhp_wa_owner_sends(id) ON DELETE RESTRICT,
 held_until timestamptz NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 FOREIGN KEY(workspace_id,binding_id) REFERENCES app.property_predator_whatsapp_live_bindings(workspace_id,id) ON DELETE RESTRICT,
 CHECK((scope='recipient')=(recipient_sha256 IS NOT NULL)),
 CHECK(held_until>recorded_at),
 UNIQUE(source_send_id,error_code)
);
CREATE INDEX mhp_wa_owner_holds_active ON app_private.mhp_wa_owner_holds(binding_id,held_until DESC);

CREATE FUNCTION app_private.mhp_wa_owner_send_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $f$
DECLARE mutable constant text[]:=ARRAY['state','state_reason','provider_message_id','error_code','updated_at'];
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'MHP owner WhatsApp send evidence is immutable' USING ERRCODE='40001'; END IF;
 IF (to_jsonb(NEW)-mutable) IS DISTINCT FROM (to_jsonb(OLD)-mutable)
  OR (OLD.provider_message_id IS NOT NULL AND NEW.provider_message_id IS DISTINCT FROM OLD.provider_message_id)
  OR NEW.updated_at<OLD.updated_at
 THEN RAISE EXCEPTION 'MHP owner WhatsApp send evidence is immutable' USING ERRCODE='40001'; END IF;
 RETURN NEW;
END $f$;
REVOKE ALL ON FUNCTION app_private.mhp_wa_owner_send_guard() FROM PUBLIC;
CREATE TRIGGER mhp_wa_owner_send_guard BEFORE UPDATE OR DELETE ON app_private.mhp_wa_owner_sends
 FOR EACH ROW EXECUTE FUNCTION app_private.mhp_wa_owner_send_guard();
-- Evidence rows are append-only (0141 guard: immutable unless cascaded).
CREATE TRIGGER mhp_wa_owner_links_immutable BEFORE UPDATE ON app_private.mhp_wa_owner_links
 FOR EACH ROW EXECUTE FUNCTION app_private.mhp_event_phone_receipt_guard();
CREATE TRIGGER mhp_wa_owner_attestations_immutable BEFORE UPDATE ON app_private.mhp_wa_owner_attestations
 FOR EACH ROW EXECUTE FUNCTION app_private.mhp_event_phone_receipt_guard();
CREATE FUNCTION app_private.mhp_wa_owner_template_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $f$
DECLARE refresh constant text[]:=ARRAY['observed_at','expires_at','observed_request_id'];
BEGIN
 -- Only "Meta still returns exactly this" may be recorded on an existing row; the content never changes.
 IF TG_OP='DELETE' OR (to_jsonb(NEW)-refresh) IS DISTINCT FROM (to_jsonb(OLD)-refresh) OR NEW.observed_at<OLD.observed_at
 THEN RAISE EXCEPTION 'MHP owner WhatsApp template evidence is immutable' USING ERRCODE='40001'; END IF;
 RETURN NEW;
END $f$;
REVOKE ALL ON FUNCTION app_private.mhp_wa_owner_template_guard() FROM PUBLIC;
CREATE TRIGGER mhp_wa_owner_templates_immutable BEFORE UPDATE OR DELETE ON app_private.mhp_wa_owner_templates
 FOR EACH ROW EXECUTE FUNCTION app_private.mhp_wa_owner_template_guard();
CREATE TRIGGER mhp_wa_owner_holds_immutable BEFORE UPDATE OR DELETE ON app_private.mhp_wa_owner_holds
 FOR EACH ROW EXECUTE FUNCTION app_private.mhp_event_phone_receipt_guard();

-- 6. 0053 authority/job provenance: a third kind beside 'owner_action' and 'mhp_event'.
ALTER TABLE app.property_predator_whatsapp_live_authorities ADD COLUMN owner_send_id uuid;
ALTER TABLE app.property_predator_whatsapp_live_authorities DROP CONSTRAINT whatsapp_authority_kind_shape;
ALTER TABLE app.property_predator_whatsapp_live_authorities
 ADD CONSTRAINT whatsapp_authority_kind_shape CHECK(
  (authority_kind='owner_action' AND operator_user_id IS NOT NULL AND operator_request_id IS NOT NULL AND permission_use_receipt_id IS NOT NULL
   AND event_send_id IS NULL AND event_receipt_id IS NULL AND event_template_observation_id IS NULL AND evaluated_by_role IS NULL
   AND evaluated_request_id IS NULL AND event_eligibility_sha256 IS NULL AND owner_send_id IS NULL)
  OR (authority_kind='mhp_event' AND workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND purpose~'^mhp\.webinar\.[0-9]{4}-[0-9]{2}-[0-9]{2}$'
   AND operator_user_id IS NULL AND operator_request_id IS NULL AND permission_use_receipt_id IS NULL
   AND event_send_id IS NOT NULL AND event_receipt_id IS NOT NULL AND event_template_observation_id IS NOT NULL
   AND evaluated_by_role='r72_whatsapp_live_worker_command' AND evaluated_request_id IS NOT NULL
   AND evaluated_request_id=btrim(evaluated_request_id) AND length(evaluated_request_id) BETWEEN 1 AND 128
   AND octet_length(event_eligibility_sha256)=32 AND valid_until<=evaluated_at+interval '4 minutes' AND owner_send_id IS NULL)
  OR (authority_kind='mhp_owner_direct' AND workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND purpose='mhp.owner-one-to-one'
   AND operator_user_id IS NOT NULL AND operator_request_id IS NOT NULL AND permission_use_receipt_id IS NULL
   AND event_send_id IS NULL AND event_receipt_id IS NULL AND event_template_observation_id IS NULL AND evaluated_by_role IS NULL
   AND evaluated_request_id IS NULL AND event_eligibility_sha256 IS NULL AND owner_send_id IS NOT NULL
   AND valid_until<=evaluated_at+interval '10 minutes')),
 ADD CONSTRAINT whatsapp_authority_owner_identity UNIQUE(workspace_id,id,owner_send_id),
 ADD CONSTRAINT whatsapp_authority_owner_send_fk FOREIGN KEY(owner_send_id) REFERENCES app_private.mhp_wa_owner_sends(id) DEFERRABLE INITIALLY DEFERRED;
CREATE UNIQUE INDEX whatsapp_authority_one_per_owner_send ON app.property_predator_whatsapp_live_authorities(owner_send_id) WHERE owner_send_id IS NOT NULL;
ALTER TABLE app.property_predator_whatsapp_live_jobs ADD COLUMN owner_send_id uuid;
ALTER TABLE app.property_predator_whatsapp_live_jobs DROP CONSTRAINT whatsapp_job_kind_shape;
ALTER TABLE app.property_predator_whatsapp_live_jobs
 ADD CONSTRAINT whatsapp_job_kind_shape CHECK(
  (authority_kind='owner_action' AND created_by_actor_kind='user' AND created_by_user_id IS NOT NULL AND event_send_id IS NULL AND owner_send_id IS NULL)
  OR (authority_kind='mhp_event' AND created_by_actor_kind='worker' AND created_by_user_id IS NULL
   AND workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND event_send_id IS NOT NULL AND owner_send_id IS NULL)
  OR (authority_kind='mhp_owner_direct' AND created_by_actor_kind='user' AND created_by_user_id IS NOT NULL
   AND workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND event_send_id IS NULL AND owner_send_id IS NOT NULL)),
 ADD CONSTRAINT whatsapp_job_authority_owner_fk FOREIGN KEY(workspace_id,authority_id,owner_send_id)
  REFERENCES app.property_predator_whatsapp_live_authorities(workspace_id,id,owner_send_id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX whatsapp_job_one_per_owner_send ON app.property_predator_whatsapp_live_jobs(owner_send_id) WHERE owner_send_id IS NOT NULL;
-- The legacy sender-wide pilot index still covers every legacy job; owner one-to-one sends have their own cap (proposal 3).
DROP INDEX app.property_predator_whatsapp_live_jobs_daily_cap_uq;
CREATE UNIQUE INDEX property_predator_whatsapp_live_jobs_daily_cap_uq
 ON app.property_predator_whatsapp_live_jobs(workspace_id,binding_id,utc_day)
 WHERE state<>'cancelled' AND NOT(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND authority_kind IN('mhp_event','mhp_owner_direct'));
ALTER TABLE app_private.mhp_wa_owner_sends
 ADD CONSTRAINT mhp_wa_owner_send_job_fk FOREIGN KEY(workspace_id,job_id) REFERENCES app.property_predator_whatsapp_live_jobs(workspace_id,id) DEFERRABLE INITIALLY DEFERRED,
 ADD CONSTRAINT mhp_wa_owner_send_authority_fk FOREIGN KEY(workspace_id,authority_id,id)
  REFERENCES app.property_predator_whatsapp_live_authorities(workspace_id,id,owner_send_id) DEFERRABLE INITIALLY DEFERRED;
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
     OR NEW.owner_send_id IS DISTINCT FROM OLD.owner_send_id
     OR NEW.created_by_actor_kind IS DISTINCT FROM OLD.created_by_actor_kind
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Meta WhatsApp job identity evidence is immutable' USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END
$function$;

-- 7. Forced RLS. Only the WhatsApp definer touches the new tables, and only in the MHP context.
DO $rls$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['mhp_wa_owner_links','mhp_wa_owner_attestations','mhp_wa_owner_templates','mhp_wa_owner_sends','mhp_wa_owner_holds'] LOOP
  EXECUTE format('ALTER TABLE app_private.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE app_private.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON app_private.%I FROM PUBLIC',t);
  EXECUTE format('CREATE POLICY %I ON app_private.%I TO r72_owner USING(true) WITH CHECK(true)',t||'_owner',t);
  EXECUTE format('CREATE POLICY %I ON app_private.%I TO r72_whatsapp_live_definer
   USING(current_setting(''app.workspace_id'',true)=''2789228d-55a6-4688-b1e8-2f70abca990b'')
   WITH CHECK(current_setting(''app.workspace_id'',true)=''2789228d-55a6-4688-b1e8-2f70abca990b'')',t||'_mhp',t);
 END LOOP;
END $rls$;
GRANT SELECT,INSERT ON app_private.mhp_wa_owner_links,app_private.mhp_wa_owner_attestations,app_private.mhp_wa_owner_templates,
 app_private.mhp_wa_owner_holds TO r72_whatsapp_live_definer;
GRANT SELECT,INSERT ON app_private.mhp_wa_owner_sends TO r72_whatsapp_live_definer;
GRANT UPDATE(state,state_reason,provider_message_id,error_code,updated_at) ON app_private.mhp_wa_owner_sends TO r72_whatsapp_live_definer;
GRANT UPDATE(observed_at,expires_at,observed_request_id) ON app_private.mhp_wa_owner_templates TO r72_whatsapp_live_definer;

-- The owner may see (never change) the original brand contact and its points, in a workspace the
-- same owner can manage, only through these definer functions called on the Growth HQ command role.
GRANT SELECT ON app.contacts,app.contact_points,app.communication_suppression_events TO r72_whatsapp_live_definer;
GRANT EXECUTE ON FUNCTION app_private.can_manage_workspace(uuid,uuid) TO r72_whatsapp_live_definer;
CREATE POLICY mhp_wa_owner_origin_contacts ON app.contacts FOR SELECT TO r72_whatsapp_live_definer
 USING(session_user='r72_crm_command' AND current_setting('app.workspace_id',true)='2789228d-55a6-4688-b1e8-2f70abca990b'
  AND current_setting('app.actor_kind',true)='user'
  AND app_private.can_manage_workspace(nullif(current_setting('app.user_id',true),'')::uuid,workspace_id));
CREATE POLICY mhp_wa_owner_origin_points ON app.contact_points FOR SELECT TO r72_whatsapp_live_definer
 USING(session_user='r72_crm_command' AND current_setting('app.workspace_id',true)='2789228d-55a6-4688-b1e8-2f70abca990b'
  AND current_setting('app.actor_kind',true)='user'
  AND app_private.can_manage_workspace(nullif(current_setting('app.user_id',true),'')::uuid,workspace_id));
CREATE POLICY mhp_wa_owner_origin_suppressions ON app.communication_suppression_events FOR SELECT TO r72_whatsapp_live_definer
 USING(session_user='r72_crm_command' AND current_setting('app.workspace_id',true)='2789228d-55a6-4688-b1e8-2f70abca990b'
  AND current_setting('app.actor_kind',true)='user'
  AND app_private.can_manage_workspace(nullif(current_setting('app.user_id',true),'')::uuid,workspace_id));
-- Begin-call re-reads the original brand's own opt-out: the worker may see only the points and
-- WhatsApp/SMS suppressions of an original contact the owner has linked, nothing else outside MHP.
CREATE POLICY mhp_wa_owner_origin_points_worker ON app.contact_points FOR SELECT TO r72_whatsapp_live_definer
 USING(session_user='r72_whatsapp_live_worker_command' AND current_setting('app.workspace_id',true)='2789228d-55a6-4688-b1e8-2f70abca990b'
  AND current_setting('app.actor_kind',true)='worker'
  AND EXISTS(SELECT 1 FROM app_private.mhp_wa_owner_links l WHERE l.origin_workspace_id=contact_points.workspace_id AND l.origin_contact_id=contact_points.contact_id));
CREATE POLICY mhp_wa_owner_origin_suppressions_worker ON app.communication_suppression_events FOR SELECT TO r72_whatsapp_live_definer
 USING(session_user='r72_whatsapp_live_worker_command' AND current_setting('app.workspace_id',true)='2789228d-55a6-4688-b1e8-2f70abca990b'
  AND current_setting('app.actor_kind',true)='worker' AND channel IN('whatsapp','sms')
  AND EXISTS(SELECT 1 FROM app_private.mhp_wa_owner_links l WHERE l.origin_workspace_id=communication_suppression_events.workspace_id
   AND l.origin_contact_id=communication_suppression_events.contact_id));
-- Worker/webhook reads of MHP contacts for the begin-call gate (MHP workspace only).
CREATE POLICY mhp_wa_owner_mhp_contacts ON app.contacts FOR SELECT TO r72_whatsapp_live_definer
 USING(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND current_setting('app.workspace_id',true)='2789228d-55a6-4688-b1e8-2f70abca990b');
-- Mirror: a new MHP contact and an unverified, consent-unknown WhatsApp point, owner command only.
CREATE POLICY mhp_wa_owner_mirror_contact ON app.contacts FOR INSERT TO r72_whatsapp_live_definer
 WITH CHECK(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND session_user='r72_crm_command'
  AND current_setting('app.actor_kind',true)='user' AND owner_user_id IS NULL AND lifecycle_status='lead'
  AND source~'^mhp:owner-one-to-one:(pp|mhp|kp|piuk|hnh|ordris|group)$' AND deleted_at IS NULL);
CREATE POLICY mhp_wa_owner_mirror_point ON app.contact_points FOR INSERT TO r72_whatsapp_live_definer
 WITH CHECK(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND session_user='r72_crm_command'
  AND current_setting('app.actor_kind',true)='user' AND kind='whatsapp' AND NOT is_verified AND NOT is_primary
  AND consent_status='unknown' AND dedupe_state='normal' AND deleted_at IS NULL);
-- Outcome activities on the linked original contact and on the MHP contact, nowhere else.
GRANT INSERT ON app.activities TO r72_whatsapp_live_definer;
CREATE POLICY mhp_wa_owner_activities ON app.activities FOR INSERT TO r72_whatsapp_live_definer
 WITH CHECK(activity_type~'^whatsapp\.mhp_sender\.[a-z_]{1,40}$' AND channel='whatsapp'
  AND current_setting('app.workspace_id',true)='2789228d-55a6-4688-b1e8-2f70abca990b'
  AND EXISTS(SELECT 1 FROM app_private.mhp_wa_owner_links l WHERE (l.origin_workspace_id=activities.workspace_id AND l.origin_contact_id=activities.contact_id)
   OR (l.workspace_id=activities.workspace_id AND l.mhp_contact_id=activities.contact_id))
  AND ((session_user='r72_crm_command' AND actor_kind='user' AND actor_user_id=nullif(current_setting('app.user_id',true),'')::uuid)
   OR (session_user='r72_whatsapp_live_worker_command' AND actor_kind='worker' AND actor_user_id IS NULL)
   OR (session_user='r72_whatsapp_live_webhook_command' AND actor_kind='webhook' AND actor_user_id IS NULL)));
-- Owner one-to-one review chain (the 0141 operational-review pattern, on the Growth HQ command role).
DO $policies$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['affiliate_compliance_subjects','affiliate_compliance_policy_pack_versions','affiliate_compliance_policy_review_events',
  'affiliate_compliance_policy_publication_events','affiliate_compliance_specialist_decision_events'] LOOP
  EXECUTE format('CREATE POLICY mhp_wa_owner_review ON app_private.%I FOR INSERT TO r72_whatsapp_live_definer
   WITH CHECK(workspace_id=''2789228d-55a6-4688-b1e8-2f70abca990b'' AND current_setting(''app.actor_kind'',true)=''user'' AND session_user=''r72_crm_command''
    AND recorded_by_user_id=nullif(current_setting(''app.user_id'',true),'''')::uuid AND recorded_request_id=current_setting(''app.request_id'',true))',t);
 END LOOP;
END $policies$;
-- The founder permission rail (0063) is called from inside the owner function, still on r72_crm_command.
GRANT EXECUTE ON FUNCTION app_private.record_contact_permission_decision(uuid,uuid,uuid,text,text,text,text,text,text,bytea,text,bytea,timestamptz)
 TO r72_whatsapp_live_definer;
GRANT CREATE ON SCHEMA app_private TO r72_whatsapp_live_definer;

-- 8. Functions (definer-owned; every entry point re-proves its role, workspace and actor).
RESET ROLE;
SET LOCAL ROLE r72_whatsapp_live_definer;

-- International digits without '+'. A UK 07 mobile becomes 447...; anything ambiguous is NULL.
-- The optional trunk zero people write after a country code ("+44 (0)7700 900126") is dropped, and a
-- UK number that still carries it ("+4407700...") is refused rather than stored as a number nobody has.
CREATE FUNCTION app_private.mhp_wa_owner_number(p_value text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $f$
 SELECT CASE WHEN d~'^440' THEN NULL ELSE d END
 FROM (SELECT CASE WHEN n~'^\+[1-9][0-9]{6,14}$' THEN substr(n,2) WHEN n~'^00[1-9][0-9]{6,14}$' THEN substr(n,3)
   WHEN n~'^07[0-9]{9}$' THEN '44'||substr(n,2) WHEN n~'^447[0-9]{9}$' THEN n END AS d
  FROM (SELECT regexp_replace(regexp_replace(coalesce(p_value,''),
    '^([[:space:]]*(\+|00)[[:space:]]*[1-9][0-9[:space:].-]*)\(0\)','\1'),'[[:space:]().-]','','g') AS n) x) y
$f$;
REVOKE ALL ON FUNCTION app_private.mhp_wa_owner_number(text) FROM PUBLIC;

CREATE FUNCTION app_private.mhp_wa_owner_mask(p_number text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $f$ SELECT '+'||left(p_number,2)||' ••• '||right(p_number,4) $f$;
REVOKE ALL ON FUNCTION app_private.mhp_wa_owner_mask(text) FROM PUBLIC;

-- The Growth HQ command gate: exact role, MHP context and an active MHP owner (0143 predicate).
CREATE FUNCTION app_private.mhp_wa_owner_actor() RETURNS uuid
LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $f$
DECLARE actor uuid; request text:=current_setting('app.request_id',true);
BEGIN
 BEGIN actor:=nullif(current_setting('app.user_id',true),'')::uuid; EXCEPTION WHEN invalid_text_representation THEN actor:=NULL; END;
 IF session_user<>'r72_crm_command' OR current_setting('app.workspace_id',true) IS DISTINCT FROM '2789228d-55a6-4688-b1e8-2f70abca990b'
  OR current_setting('app.actor_kind',true) IS DISTINCT FROM 'user' OR actor IS NULL OR request IS NULL
  OR request<>btrim(request) OR length(request) NOT BETWEEN 1 AND 128 OR NOT app_private.mhp_wa_direct_owner(actor)
 THEN RAISE EXCEPTION 'MHP owner WhatsApp session required' USING ERRCODE='42501'; END IF;
 RETURN actor;
END $f$;
REVOKE ALL ON FUNCTION app_private.mhp_wa_owner_actor() FROM PUBLIC;

CREATE FUNCTION app_private.mhp_wa_owner_current_binding() RETURNS app.property_predator_whatsapp_live_bindings
LANGUAGE sql STABLE SET search_path=pg_catalog AS $f$
 SELECT b.* FROM app.property_predator_whatsapp_live_bindings b
 WHERE (app_private.mhp_event_whatsapp_binding(b.id)).id=b.id ORDER BY b.created_at DESC,b.id DESC LIMIT 1
$f$;
REVOKE ALL ON FUNCTION app_private.mhp_wa_owner_current_binding() FROM PUBLIC;

CREATE FUNCTION app_private.mhp_wa_owner_daily_cap() RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $f$ SELECT 20 $f$;
REVOKE ALL ON FUNCTION app_private.mhp_wa_owner_daily_cap() FROM PUBLIC;

-- Meta error codes that pause sending (proposal 4): scope and how long.
CREATE FUNCTION app_private.mhp_wa_owner_hold_policy(p_code integer) RETURNS TABLE(scope text,reason text,duration interval)
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $f$
 SELECT v.scope,v.reason,v.duration FROM (VALUES
  (368,'account','policy_restriction',interval '24 hours'),
  (131048,'account','spam_rate_limit',interval '24 hours'),
  (131031,'account','account_locked',interval '24 hours'),
  (190,'account','credential_problem',interval '24 hours'),
  (80007,'account','account_rate_limit',interval '1 hour'),
  (130429,'account','throughput_limit',interval '15 minutes'),
  (131056,'recipient','pair_rate_limit',interval '1 hour'),
  (131049,'recipient','marketing_limit',interval '24 hours'),
  (131050,'recipient','user_stopped_marketing',interval '365 days')
 ) v(code,scope,reason,duration) WHERE v.code=p_code
$f$;
REVOKE ALL ON FUNCTION app_private.mhp_wa_owner_hold_policy(integer) FROM PUBLIC;

CREATE FUNCTION app_private.mhp_wa_owner_active_hold(p_binding uuid,p_recipient bytea) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog AS $f$
 SELECT jsonb_build_object('scope',h.scope,'reason',h.reason,'errorCode',h.error_code,'until',h.held_until)
 FROM app_private.mhp_wa_owner_holds h WHERE h.binding_id=p_binding AND h.held_until>statement_timestamp()
  AND (h.scope='account' OR h.recipient_sha256=p_recipient)
 ORDER BY (h.scope='account') DESC,h.held_until DESC LIMIT 1
$f$;
REVOKE ALL ON FUNCTION app_private.mhp_wa_owner_active_hold(uuid,bytea) FROM PUBLIC;

-- Number-level blocks in MHP: any point with this number opted out or suppressed, or a signed STOP.
CREATE FUNCTION app_private.mhp_wa_owner_number_blocked(p_number text) RETURNS text
LANGUAGE sql STABLE SET search_path=pg_catalog AS $f$
 SELECT CASE
  WHEN app_private.mhp_unlinked_opt_latest('whatsapp',public.digest('+'||p_number,'sha256')) IS NOT DISTINCT FROM 'stop' THEN 'whatsapp_stop'
  WHEN EXISTS(SELECT 1 FROM app.contact_points p WHERE p.workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND p.kind IN('whatsapp','phone')
   AND p.deleted_at IS NULL AND (ltrim(p.normalized_value,'+')=p_number OR app_private.mhp_wa_owner_number(p.normalized_value)=p_number)
   AND p.consent_status='opted_out') THEN 'opted_out'
  WHEN EXISTS(SELECT 1 FROM app.contact_points p WHERE p.workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND p.kind='whatsapp'
   AND p.deleted_at IS NULL AND ltrim(p.normalized_value,'+')=p_number
   AND EXISTS(SELECT 1 FROM (SELECT DISTINCT ON (coalesce(s.purpose,'')) s.state FROM app.communication_suppression_events s
    WHERE s.workspace_id=p.workspace_id AND s.contact_point_id=p.id AND s.channel='whatsapp' AND (s.purpose IS NULL OR s.purpose='mhp.owner-one-to-one')
    ORDER BY coalesce(s.purpose,''),s.occurred_at DESC,s.recorded_at DESC,s.id DESC) latest WHERE latest.state='suppressed')) THEN 'suppressed'
 END
$f$;
REVOKE ALL ON FUNCTION app_private.mhp_wa_owner_number_blocked(text) FROM PUBLIC;

-- The original brand's own record can still say no. Every phone/WhatsApp point of the original
-- contact that carries this number counts, whether the owner picked the point or typed the number:
-- an opt-out, or a current WhatsApp or SMS suppression (a STOP), on any of them blocks; so does a
-- picked point that has since been removed. Read at link, at queue and again at begin-call.
CREATE FUNCTION app_private.mhp_wa_owner_origin_blocked(p_origin_workspace uuid,p_origin_contact uuid,p_origin_point uuid,p_number text) RETURNS text
LANGUAGE sql STABLE SET search_path=pg_catalog AS $f$
 SELECT CASE
  WHEN p_origin_point IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app.contact_points p WHERE p.workspace_id=p_origin_workspace AND p.id=p_origin_point
   AND p.contact_id=p_origin_contact AND p.deleted_at IS NULL) THEN 'number_not_found'
  WHEN EXISTS(SELECT 1 FROM app.contact_points p WHERE p.workspace_id=p_origin_workspace AND p.contact_id=p_origin_contact AND p.kind IN('whatsapp','phone')
   AND (p.id=p_origin_point OR app_private.mhp_wa_owner_number(p.normalized_value)=p_number OR app_private.mhp_wa_owner_number(p.value)=p_number)
   AND (p.consent_status='opted_out' OR EXISTS(SELECT 1 FROM (SELECT DISTINCT ON (s.channel,coalesce(s.purpose,'')) s.state
     FROM app.communication_suppression_events s WHERE s.workspace_id=p.workspace_id AND s.contact_point_id=p.id AND s.channel IN('whatsapp','sms')
     ORDER BY s.channel,coalesce(s.purpose,''),s.occurred_at DESC,s.recorded_at DESC,s.id DESC) latest WHERE latest.state='suppressed'))) THEN 'opted_out'
 END
$f$;
REVOKE ALL ON FUNCTION app_private.mhp_wa_owner_origin_blocked(uuid,uuid,uuid,text) FROM PUBLIC;

-- Current verification and permission for one link. Pure read; every send gate calls it.
CREATE FUNCTION app_private.mhp_wa_owner_point_state(p_link uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $f$
DECLARE l app_private.mhp_wa_owner_links%ROWTYPE; p app.contact_points%ROWTYPE; endpoint bytea; att app_private.mhp_wa_owner_attestations%ROWTYPE;
 consent app.communication_consent_events%ROWTYPE; verification text; permission text; blocked text;
BEGIN
 SELECT * INTO l FROM app_private.mhp_wa_owner_links x WHERE x.id=p_link;
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','link_not_found'); END IF;
 SELECT * INTO p FROM app.contact_points x WHERE x.workspace_id=l.workspace_id AND x.id=l.mhp_point_id AND x.contact_id=l.mhp_contact_id
  AND x.kind='whatsapp' AND x.deleted_at IS NULL AND x.dedupe_state='normal' AND ltrim(x.normalized_value,'+')=l.number;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM app.contacts c WHERE c.workspace_id=l.workspace_id AND c.id=l.mhp_contact_id AND c.deleted_at IS NULL)
 THEN RETURN jsonb_build_object('ok',false,'reason','mhp_contact_unavailable'); END IF;
 endpoint:=public.digest(p.kind||chr(31)||p.value||chr(31)||p.normalized_value,'sha256');
 SELECT * INTO att FROM app_private.mhp_wa_owner_attestations a WHERE a.mhp_point_id=p.id ORDER BY a.recorded_at DESC,a.id DESC LIMIT 1;
 verification:=CASE WHEN p.is_verified THEN 'meta_verified'
  WHEN att.state='owner_attested' AND att.endpoint_identity_sha256=endpoint THEN 'owner_attested' ELSE 'unverified' END;
 SELECT * INTO consent FROM app.communication_consent_events c WHERE c.workspace_id=l.workspace_id AND c.contact_point_id=p.id
  AND c.channel='whatsapp' AND c.purpose='mhp.owner-one-to-one' ORDER BY c.occurred_at DESC,c.recorded_at DESC,c.id DESC LIMIT 1;
 permission:=CASE WHEN consent.id IS NULL THEN 'none'
  WHEN consent.state='granted' AND consent.endpoint_identity_sha256 IS DISTINCT FROM endpoint THEN 'stale'
  WHEN consent.state='granted' AND consent.lawful_basis NOT IN('consent','legitimate_interests') THEN 'basis_not_allowed'
  ELSE consent.state END;
 blocked:=coalesce(app_private.mhp_wa_owner_number_blocked(l.number),
  app_private.mhp_wa_owner_origin_blocked(l.origin_workspace_id,l.origin_contact_id,l.origin_point_id,l.number));
 RETURN jsonb_build_object('ok',true,'linkId',l.id,'pointId',p.id,'contactId',p.contact_id,'number',l.number,
  'recipientSha256',encode(public.digest(l.number,'sha256'),'hex'),'endpointSha256',encode(endpoint,'hex'),
  'verification',verification,'attestationId',CASE WHEN verification='owner_attested' THEN att.id END,
  'permission',permission,'consentEventId',CASE WHEN permission='granted' THEN consent.id END,
  'lawfulBasis',consent.lawful_basis,'evidenceSource',consent.source,'permissionRecordedAt',consent.recorded_at,'blocked',blocked);
END $f$;
REVOKE ALL ON FUNCTION app_private.mhp_wa_owner_point_state(uuid) FROM PUBLIC;

-- A link is only usable from the original contact it was made for, by an owner who manages that workspace.
CREATE FUNCTION app_private.mhp_wa_owner_link_of(p_link uuid,p_origin_workspace uuid,p_origin_contact uuid,p_actor uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $f$
 SELECT p_link IS NOT NULL AND app_private.can_manage_workspace(p_actor,p_origin_workspace) AND EXISTS(SELECT 1 FROM app_private.mhp_wa_owner_links l
  WHERE l.id=p_link AND l.origin_workspace_id=p_origin_workspace AND l.origin_contact_id=p_origin_contact)
$f$;
REVOKE ALL ON FUNCTION app_private.mhp_wa_owner_link_of(uuid,uuid,uuid,uuid) FROM PUBLIC;

-- The 24-hour customer-service window (0143): the open direct thread for this number, if any.
CREATE FUNCTION app_private.mhp_wa_owner_window(p_binding uuid,p_number text) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog AS $f$
 SELECT coalesce((SELECT jsonb_build_object('open',app_private.mhp_wa_direct_window(t.id),'threadId',t.id,'inboxId',t.inbox_id,
   'closesAt',(SELECT max(r.occurred_at)+interval '24 hours' FROM app_private.mhp_wa_direct_received r WHERE r.thread_id=t.id
     AND r.occurred_at<=statement_timestamp()))
  FROM app_private.mhp_wa_direct_threads t WHERE t.binding_id=p_binding AND t.sender=p_number),jsonb_build_object('open',false))
$f$;
REVOKE ALL ON FUNCTION app_private.mhp_wa_owner_window(uuid,text) FROM PUBLIC;

-- Latest Meta read of one template for this binding, if it is APPROVED, sendable and unexpired.
CREATE FUNCTION app_private.mhp_wa_owner_template_current(p_binding uuid,p_meta_id text) RETURNS app_private.mhp_wa_owner_templates
LANGUAGE sql STABLE SET search_path=pg_catalog AS $f$
 SELECT o.* FROM (SELECT x.* FROM app_private.mhp_wa_owner_templates x WHERE x.binding_id=p_binding AND x.meta_template_id=p_meta_id
   ORDER BY x.observed_at DESC,x.id DESC LIMIT 1) o
 WHERE o.provider_status='APPROVED' AND o.sendable AND o.expires_at>statement_timestamp() AND o.category IN('MARKETING','UTILITY')
$f$;
REVOKE ALL ON FUNCTION app_private.mhp_wa_owner_template_current(uuid,text) FROM PUBLIC;

-- Fill the template's real placeholders. Values must match the placeholder set exactly and follow
-- Meta's text-parameter rules; a value can never introduce a new placeholder.
CREATE FUNCTION app_private.mhp_wa_owner_render(p_observation uuid,p_variables jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $f$
DECLARE o app_private.mhp_wa_owner_templates%ROWTYPE; params jsonb:='[]'::jsonb; out_text text; i integer:=0; n text; v jsonb; val text;
BEGIN
 SELECT * INTO o FROM app_private.mhp_wa_owner_templates x WHERE x.id=p_observation;
 IF NOT FOUND THEN RAISE EXCEPTION 'Template unavailable' USING ERRCODE='22023'; END IF;
 IF o.parameter_format='NAMED' THEN
  IF jsonb_typeof(p_variables) IS DISTINCT FROM 'object'
   OR (SELECT coalesce(array_agg(k ORDER BY k),'{}') FROM jsonb_object_keys(p_variables) k)
    IS DISTINCT FROM (SELECT coalesce(array_agg(x ORDER BY x),'{}') FROM unnest(o.parameter_names) x)
  THEN RAISE EXCEPTION 'Template variables do not match the template' USING ERRCODE='22023'; END IF;
 ELSIF o.parameter_format='POSITIONAL' THEN
  IF jsonb_typeof(p_variables) IS DISTINCT FROM 'array' OR jsonb_array_length(p_variables)<>cardinality(o.parameter_names)
  THEN RAISE EXCEPTION 'Template variables do not match the template' USING ERRCODE='22023'; END IF;
 ELSIF p_variables IS NOT NULL AND p_variables NOT IN('[]'::jsonb,'{}'::jsonb) THEN
  RAISE EXCEPTION 'This template takes no variables' USING ERRCODE='22023';
 END IF;
 out_text:=o.preview_text;
 FOREACH n IN ARRAY o.parameter_names LOOP
  i:=i+1;
  v:=CASE o.parameter_format WHEN 'NAMED' THEN p_variables->n ELSE p_variables->(i-1) END;
  IF jsonb_typeof(v) IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'Template variable % must be text',n USING ERRCODE='22023'; END IF;
  val:=v#>>'{}';
  IF char_length(val) NOT BETWEEN 1 AND 500 OR btrim(val)='' OR val~'[[:cntrl:]]' OR val~' {5,}' OR position('{{' IN val)>0 OR position('}}' IN val)>0
  THEN RAISE EXCEPTION 'Template variable % is not allowed by WhatsApp',n USING ERRCODE='22023'; END IF;
  params:=params||jsonb_build_array(jsonb_build_object('name',n,'value',val));
  out_text:=replace(out_text,'{{'||n||'}}',val);
 END LOOP;
 IF char_length(out_text)>4096 THEN RAISE EXCEPTION 'Rendered template is too long' USING ERRCODE='22023'; END IF;
 RETURN jsonb_build_object('text',out_text,'sha256',encode(public.digest(out_text,'sha256'),'hex'),'parameters',params,
  'parameterFormat',o.parameter_format,'observationId',o.id,'metaTemplateId',o.meta_template_id,'templateName',o.template_name,
  'language',o.language_code,'category',o.category);
END $f$;
REVOKE ALL ON FUNCTION app_private.mhp_wa_owner_render(uuid,jsonb) FROM PUBLIC;

-- A replayed key must carry exactly the variables stored with the first request (same names, same values, nothing extra).
CREATE FUNCTION app_private.mhp_wa_owner_same_variables(p_stored jsonb,p_variables jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $f$
 SELECT coalesce(CASE
  WHEN jsonb_array_length(p_stored)=0 THEN p_variables IS NULL OR p_variables IN('[]'::jsonb,'{}'::jsonb)
  WHEN jsonb_typeof(p_variables)='array' THEN jsonb_array_length(p_variables)=jsonb_array_length(p_stored)
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_stored) e(p) WHERE (p->>'name')!~'^[0-9]+$'
    OR p_variables->((p->>'name')::integer-1) IS DISTINCT FROM p->'value')
  WHEN jsonb_typeof(p_variables)='object' THEN (SELECT count(*) FROM jsonb_object_keys(p_variables))=jsonb_array_length(p_stored)
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_stored) e(p) WHERE p_variables->(p->>'name') IS DISTINCT FROM p->'value')
  ELSE false END,false)
$f$;
REVOKE ALL ON FUNCTION app_private.mhp_wa_owner_same_variables(jsonb,jsonb) FROM PUBLIC;

-- Write one outcome activity on the original brand contact and (when distinct) on the MHP contact.
CREATE FUNCTION app_private.mhp_wa_owner_note(p_link uuid,p_kind text,p_subject text,p_body text,p_metadata jsonb,p_occurred timestamptz) RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog AS $f$
DECLARE l app_private.mhp_wa_owner_links%ROWTYPE; who text; actor uuid; at timestamptz:=least(coalesce(p_occurred,clock_timestamp()),clock_timestamp());
 meta jsonb; request text:=left(nullif(current_setting('app.request_id',true),''),128);
BEGIN
 SELECT * INTO STRICT l FROM app_private.mhp_wa_owner_links x WHERE x.id=p_link;
 who:=CASE session_user WHEN 'r72_crm_command' THEN 'user' WHEN 'r72_whatsapp_live_worker_command' THEN 'worker'
  WHEN 'r72_whatsapp_live_webhook_command' THEN 'webhook' END;
 IF who IS NULL THEN RAISE EXCEPTION 'MHP owner WhatsApp activity denied' USING ERRCODE='42501'; END IF;
 IF who='user' THEN actor:=nullif(current_setting('app.user_id',true),'')::uuid; END IF;
 meta:=coalesce(p_metadata,'{}'::jsonb)||jsonb_build_object('source','mhp_whatsapp_owner_one_to_one','linkId',l.id,'originBrand',l.origin_brand,
  'originWorkspaceId',l.origin_workspace_id,'originContactId',l.origin_contact_id,'mhpWorkspaceId',l.workspace_id,'mhpContactId',l.mhp_contact_id,
  'sender','Martin Howard Property','number',app_private.mhp_wa_owner_mask(l.number));
 INSERT INTO app.activities(id,workspace_id,contact_id,activity_type,channel,actor_kind,actor_user_id,subject,body,metadata,request_id,occurred_at,created_at)
 VALUES(gen_random_uuid(),l.origin_workspace_id,l.origin_contact_id,'whatsapp.mhp_sender.'||p_kind,'whatsapp',who,actor,left(p_subject,500),p_body,meta,request,at,clock_timestamp());
 IF l.origin_workspace_id<>l.workspace_id OR l.origin_contact_id<>l.mhp_contact_id THEN
  INSERT INTO app.activities(id,workspace_id,contact_id,activity_type,channel,actor_kind,actor_user_id,subject,body,metadata,request_id,occurred_at,created_at)
  VALUES(gen_random_uuid(),l.workspace_id,l.mhp_contact_id,'whatsapp.mhp_sender.'||p_kind,'whatsapp',who,actor,left(p_subject,500),p_body,meta,request,at,clock_timestamp());
 END IF;
END $f$;
REVOKE ALL ON FUNCTION app_private.mhp_wa_owner_note(uuid,text,text,text,jsonb,timestamptz) FROM PUBLIC;

-- The reserved 0053 template name this rail uses for one Meta template id (never a real Meta name).
CREATE FUNCTION app_private.mhp_wa_owner_template_pin(p_meta_template_id text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $f$ SELECT 'mhp_owner_121__'||p_meta_template_id $f$;
REVOKE ALL ON FUNCTION app_private.mhp_wa_owner_template_pin(text) FROM PUBLIC;

-- What a send really is right now. A queued template whose ten-minute authority has lapsed can never be
-- handed to Meta (claim and begin-call both require a current authority), so it reads as expired and
-- stops counting even before a worker or the next queue attempt records that.
CREATE FUNCTION app_private.mhp_wa_owner_effective_state(p_send uuid) RETURNS text
LANGUAGE sql STABLE SET search_path=pg_catalog AS $f$
 SELECT CASE WHEN s.kind='template' AND s.state='queued' AND NOT EXISTS(SELECT 1 FROM app.property_predator_whatsapp_live_authorities a
   WHERE a.workspace_id=s.workspace_id AND a.id=s.authority_id AND a.owner_send_id=s.id AND a.valid_until>statement_timestamp()) THEN 'expired' ELSE s.state END
 FROM app_private.mhp_wa_owner_sends s WHERE s.id=p_send
$f$;
REVOKE ALL ON FUNCTION app_private.mhp_wa_owner_effective_state(uuid) FROM PUBLIC;

-- 8a. Link an original brand contact's number to the MHP sender (reuse or mirror; never move, never duplicate).
CREATE FUNCTION app_private.mhp_wa_owner_link(p_origin_workspace uuid,p_origin_brand text,p_origin_contact uuid,p_origin_point uuid,p_number text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE ws constant uuid:='2789228d-55a6-4688-b1e8-2f70abca990b'; actor uuid; request text:=current_setting('app.request_id',true);
 v_origin app.contacts%ROWTYPE; v_point app.contact_points%ROWTYPE; v_number text; v_source text; existing app_private.mhp_wa_owner_links%ROWTYPE;
 v_blocked text; matched uuid[]; mhp_contact uuid; mhp_point uuid; link uuid:=gen_random_uuid(); created boolean:=false; mirrored boolean:=false;
BEGIN
 actor:=app_private.mhp_wa_owner_actor();
 IF p_origin_workspace IS NULL OR p_origin_contact IS NULL OR p_origin_brand IS NULL
  OR p_origin_brand NOT IN('pp','mhp','kp','piuk','hnh','ordris','group') OR (p_origin_point IS NULL)=(p_number IS NULL)
  OR (p_origin_brand='mhp')<>(p_origin_workspace=ws) OR NOT app_private.can_manage_workspace(actor,p_origin_workspace)
 THEN RAISE EXCEPTION 'MHP owner WhatsApp link denied' USING ERRCODE='42501'; END IF;
 SELECT * INTO v_origin FROM app.contacts c WHERE c.workspace_id=p_origin_workspace AND c.id=p_origin_contact AND c.deleted_at IS NULL AND c.lifecycle_status<>'archived';
 IF NOT FOUND THEN RETURN jsonb_build_object('state','refused','reason','contact_not_found'); END IF;
 IF p_origin_point IS NOT NULL THEN
  SELECT * INTO v_point FROM app.contact_points p WHERE p.workspace_id=p_origin_workspace AND p.id=p_origin_point AND p.contact_id=p_origin_contact
   AND p.kind IN('whatsapp','phone') AND p.deleted_at IS NULL;
  IF NOT FOUND THEN RETURN jsonb_build_object('state','refused','reason','number_not_found'); END IF;
  v_number:=coalesce(app_private.mhp_wa_owner_number(v_point.normalized_value),app_private.mhp_wa_owner_number(v_point.value)); v_source:='crm_point';
 ELSE
  v_number:=app_private.mhp_wa_owner_number(p_number); v_source:='owner_entered';
 END IF;
 -- The picked point's own opt-out refuses even when its number cannot be read; then every point with this number.
 v_blocked:=app_private.mhp_wa_owner_origin_blocked(p_origin_workspace,p_origin_contact,p_origin_point,coalesce(v_number,''));
 IF v_blocked IS NOT NULL THEN RETURN jsonb_build_object('state','refused','reason',v_blocked); END IF;
 IF v_number IS NULL THEN RETURN jsonb_build_object('state','refused','reason','number_not_international'); END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('mhp.wa.owner.number:'||v_number,151));
 SELECT * INTO existing FROM app_private.mhp_wa_owner_links x WHERE x.origin_workspace_id=p_origin_workspace AND x.origin_contact_id=p_origin_contact AND x.number=v_number;
 IF FOUND THEN
  RETURN jsonb_build_object('state','linked','linkId',existing.id,'mhpContactId',existing.mhp_contact_id,'number',app_private.mhp_wa_owner_mask(v_number),'created',false);
 END IF;
 -- Who is this person in MHP already? Every live MHP contact that carries this number (as a WhatsApp or
 -- phone point) or one of the original contact's e-mail addresses, plus the original contact itself
 -- when it is an MHP contact. Exactly one: reuse it. More than one: refuse, never guess and never add
 -- a duplicate (a duplicate is what would later hold that person's webinar JOIN as ambiguous).
 SELECT coalesce(array_agg(DISTINCT m.contact_id),'{}') INTO matched FROM (
  SELECT p.contact_id FROM app.contact_points p JOIN app.contacts c ON c.workspace_id=p.workspace_id AND c.id=p.contact_id AND c.deleted_at IS NULL
  WHERE p.workspace_id=ws AND p.deleted_at IS NULL AND p.dedupe_state='normal' AND (
   (p.kind IN('whatsapp','phone') AND (ltrim(p.normalized_value,'+')=v_number OR app_private.mhp_wa_owner_number(p.normalized_value)=v_number
     OR app_private.mhp_wa_owner_number(p.value)=v_number))
   OR (p_origin_workspace<>ws AND p.kind='email' AND p.normalized_value IN (SELECT e.normalized_value FROM app.contact_points e
     WHERE e.workspace_id=p_origin_workspace AND e.contact_id=p_origin_contact AND e.kind='email' AND e.deleted_at IS NULL AND e.dedupe_state='normal')))
  UNION ALL SELECT p_origin_contact WHERE p_origin_workspace=ws) m;
 -- A shared or quarantined WhatsApp point for this number is never guessed around either.
 IF cardinality(matched)>1 OR EXISTS(SELECT 1 FROM app.contact_points p WHERE p.workspace_id=ws AND p.kind='whatsapp' AND p.deleted_at IS NULL
   AND p.dedupe_state<>'normal' AND ltrim(p.normalized_value,'+')=v_number)
 THEN RETURN jsonb_build_object('state','refused','reason','mhp_contact_ambiguous'); END IF;
 -- The number's live WhatsApp point belongs to an MHP contact that has been removed: say so, add nothing.
 IF EXISTS(SELECT 1 FROM app.contact_points p WHERE p.workspace_id=ws AND p.kind='whatsapp' AND p.deleted_at IS NULL AND p.dedupe_state='normal'
   AND ltrim(p.normalized_value,'+')=v_number AND NOT (p.contact_id=ANY(matched)))
 THEN RETURN jsonb_build_object('state','refused','reason','mhp_contact_unavailable'); END IF;
 IF cardinality(matched)=1 THEN
  mhp_contact:=matched[1];
  SELECT p.id INTO mhp_point FROM app.contact_points p WHERE p.workspace_id=ws AND p.contact_id=mhp_contact AND p.kind='whatsapp' AND p.deleted_at IS NULL
   AND p.dedupe_state='normal' AND ltrim(p.normalized_value,'+')=v_number;
 ELSE
  -- MHP has never seen this person: mirror the original contact (name and company only).
  mhp_contact:=gen_random_uuid(); mirrored:=true;
  INSERT INTO app.contacts(id,workspace_id,display_name,company_name,lifecycle_status,owner_user_id,source)
  VALUES(mhp_contact,ws,v_origin.display_name,v_origin.company_name,'lead',NULL,'mhp:owner-one-to-one:'||p_origin_brand);
 END IF;
 IF mhp_point IS NULL THEN
  -- The number is carried as its own unverified, consent-unknown WhatsApp point on that one contact.
  mhp_point:=gen_random_uuid(); created:=true;
  INSERT INTO app.contact_points(id,workspace_id,contact_id,kind,label,value,normalized_value,is_primary,is_verified,consent_status)
  VALUES(mhp_point,ws,mhp_contact,'whatsapp','WhatsApp','+'||v_number,v_number,false,false,'unknown');
 END IF;
 INSERT INTO app_private.mhp_wa_owner_links(id,workspace_id,origin_workspace_id,origin_brand,origin_contact_id,origin_point_id,number_source,
  mhp_contact_id,mhp_point_id,number,created_by_user_id,created_request_id)
 VALUES(link,ws,p_origin_workspace,p_origin_brand,p_origin_contact,p_origin_point,v_source,mhp_contact,mhp_point,v_number,actor,request);
 PERFORM app_private.mhp_wa_owner_note(link,'linked','WhatsApp number linked to the Martin Howard Property sender',NULL,
  jsonb_build_object('numberSource',v_source,'mirrorCreated',mirrored,'whatsappPointCreated',created),NULL);
 RETURN jsonb_build_object('state','linked','linkId',link,'mhpContactId',mhp_contact,'number',app_private.mhp_wa_owner_mask(v_number),'created',true,
  'mirrorCreated',mirrored,'whatsappPointCreated',created);
END $f$;

-- 8b. Record or withdraw permission through the 0063 founder rail, with the owner-attested number
-- state (proposal 1) when the number has not been proven by the person messaging it.
CREATE FUNCTION app_private.mhp_wa_owner_set_permission(p_origin_workspace uuid,p_origin_contact uuid,p_link uuid,p_command uuid,p_decision text,p_lawful_basis text,p_evidence_kind text,
 p_note text,p_attest_number boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE ws constant uuid:='2789228d-55a6-4688-b1e8-2f70abca990b'; actor uuid; request text:=current_setting('app.request_id',true);
 state jsonb; key bytea; prior app_private.mhp_wa_owner_attestations%ROWTYPE; disposition text; consent uuid; receipt uuid; route text;
 attestation uuid; note text:=btrim(p_note);
BEGIN
 actor:=app_private.mhp_wa_owner_actor();
 IF p_link IS NULL OR p_command IS NULL OR p_decision IS NULL OR p_decision NOT IN('granted','withdrawn') OR p_attest_number IS NULL
  OR (p_decision='granted' AND (p_lawful_basis IS NULL OR p_evidence_kind IS NULL OR note IS NULL))
  OR (p_decision='withdrawn' AND (p_lawful_basis IS NOT NULL OR p_attest_number))
 THEN RAISE EXCEPTION 'MHP owner WhatsApp permission request is invalid' USING ERRCODE='22023'; END IF;
 IF NOT app_private.mhp_wa_owner_link_of(p_link,p_origin_workspace,p_origin_contact,actor) THEN RETURN jsonb_build_object('state','refused','reason','link_not_found'); END IF;
 IF p_decision='granted' AND NOT (
   (p_lawful_basis='consent' AND p_evidence_kind IN('asked_to_be_contacted','written_consent'))
   OR (p_lawful_basis='legitimate_interests' AND p_evidence_kind IN('asked_to_be_contacted','business_introduction','existing_client')))
 THEN RETURN jsonb_build_object('state','refused','reason','basis_not_allowed'); END IF;
 IF note IS NOT NULL AND (char_length(note) NOT BETWEEN 8 AND 500 OR note~'[[:cntrl:]]') THEN
  RETURN jsonb_build_object('state','refused','reason','evidence_note_invalid'); END IF;
 key:=public.digest('mhp.owner-one-to-one.permission:'||p_command::text,'sha256');
 state:=app_private.mhp_wa_owner_point_state(p_link);
 IF (state->>'ok')::boolean IS NOT TRUE THEN RETURN jsonb_build_object('state','refused','reason',state->>'reason'); END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('mhp.wa.owner.number:'||(state->>'number'),151));
 SELECT * INTO prior FROM app_private.mhp_wa_owner_attestations a WHERE a.workspace_id=ws AND a.command_key_sha256=key;
 IF p_decision='granted' AND state->>'verification'='unverified' AND NOT p_attest_number AND prior.id IS NULL THEN
  RETURN jsonb_build_object('state','refused','reason','number_unverified'); END IF;
 IF prior.id IS NOT NULL AND (prior.link_id<>p_link OR prior.state<>CASE p_decision WHEN 'granted' THEN 'owner_attested' ELSE 'withdrawn' END
   OR prior.evidence_kind IS DISTINCT FROM p_evidence_kind OR prior.evidence_note IS DISTINCT FROM note) THEN
  RAISE EXCEPTION 'Permission command key conflict' USING ERRCODE='23505'; END IF;
 IF prior.id IS NULL AND ((p_decision='granted' AND p_attest_number AND state->>'verification'<>'meta_verified')
   OR (p_decision='withdrawn' AND state->>'verification'='owner_attested')) THEN
  attestation:=gen_random_uuid();
  INSERT INTO app_private.mhp_wa_owner_attestations(id,workspace_id,link_id,mhp_point_id,endpoint_identity_sha256,purpose,state,evidence_kind,evidence_note,
   command_key_sha256,actor_user_id,request_id)
  VALUES(attestation,ws,p_link,(state->>'pointId')::uuid,decode(state->>'endpointSha256','hex'),'mhp.owner-one-to-one',
   CASE p_decision WHEN 'granted' THEN 'owner_attested' ELSE 'withdrawn' END,
   CASE p_decision WHEN 'granted' THEN p_evidence_kind END,CASE p_decision WHEN 'granted' THEN note END,key,actor,request);
 END IF;
 SELECT d.disposition,d.consent_event_id,d.receipt_id INTO disposition,consent,receipt
 FROM app_private.record_contact_permission_decision(ws,(state->>'contactId')::uuid,(state->>'pointId')::uuid,'whatsapp','mhp.owner-one-to-one',
  p_decision,p_lawful_basis,CASE WHEN p_decision='granted' THEN 'owner.one-to-one:'||p_evidence_kind ELSE 'owner.one-to-one:withdrawn' END,
  'mhp.owner-one-to-one/v1',CASE WHEN note IS NOT NULL THEN public.digest(note,'sha256') END,'mhp-wa-owner-link:'||p_link::text,key,statement_timestamp()) d;
 IF disposition='applied' THEN
  PERFORM app_private.mhp_wa_owner_note(p_link,CASE p_decision WHEN 'granted' THEN 'permission_granted' ELSE 'permission_withdrawn' END,
   CASE p_decision WHEN 'granted' THEN 'WhatsApp permission recorded for the Martin Howard Property sender ('||replace(p_lawful_basis,'_',' ')||')'
    ELSE 'WhatsApp permission withdrawn for the Martin Howard Property sender' END,
   CASE p_decision WHEN 'granted' THEN note END,
   jsonb_build_object('consentEventId',consent,'lawfulBasis',p_lawful_basis,'evidenceKind',p_evidence_kind,
    'numberAttestedByOwner',attestation IS NOT NULL AND p_decision='granted'),NULL);
 END IF;
 RETURN jsonb_build_object('state',p_decision,'consentEventId',consent,'disposition',disposition,
  'verification',(app_private.mhp_wa_owner_point_state(p_link))->>'verification');
END $f$;

-- 8c. Read the MHP number's current approved templates (Meta-observed, never typed).
CREATE FUNCTION app_private.mhp_wa_owner_templates_list() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE binding app.property_predator_whatsapp_live_bindings%ROWTYPE;
BEGIN
 PERFORM app_private.mhp_wa_owner_actor();
 binding:=app_private.mhp_wa_owner_current_binding();
 IF binding.id IS NULL THEN RETURN jsonb_build_object('connected',false,'templates','[]'::jsonb); END IF;
 RETURN jsonb_build_object('connected',true,'bindingId',binding.id,'templates',coalesce((SELECT jsonb_agg(jsonb_build_object(
   'metaTemplateId',o.meta_template_id,'name',o.template_name,'language',o.language_code,'category',o.category,'status',o.provider_status,
   'parameterFormat',o.parameter_format,'parameterNames',to_jsonb(o.parameter_names),'bodyText',o.body_text,'previewText',o.preview_text,
   'sendable',o.sendable AND o.category IN('MARKETING','UTILITY'),'unsupportedReason',CASE WHEN o.category='AUTHENTICATION' THEN 'authentication_template'
    ELSE o.unsupported_reason END,'observedAt',o.observed_at) ORDER BY o.template_name,o.language_code)
  FROM (SELECT DISTINCT ON (x.meta_template_id) x.* FROM app_private.mhp_wa_owner_templates x WHERE x.binding_id=binding.id
    ORDER BY x.meta_template_id,x.observed_at DESC,x.id DESC) o
  WHERE o.provider_status='APPROVED' AND o.expires_at>statement_timestamp()),'[]'::jsonb));
END $f$;

CREATE FUNCTION app_private.mhp_wa_owner_preview(p_meta_template_id text,p_variables jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE binding app.property_predator_whatsapp_live_bindings%ROWTYPE; o app_private.mhp_wa_owner_templates%ROWTYPE;
BEGIN
 PERFORM app_private.mhp_wa_owner_actor();
 binding:=app_private.mhp_wa_owner_current_binding();
 IF binding.id IS NULL THEN RETURN jsonb_build_object('state','refused','reason','sender_not_connected'); END IF;
 o:=app_private.mhp_wa_owner_template_current(binding.id,p_meta_template_id);
 IF o.id IS NULL THEN RETURN jsonb_build_object('state','refused','reason','template_not_approved'); END IF;
 BEGIN
  RETURN jsonb_build_object('state','ok')||app_private.mhp_wa_owner_render(o.id,p_variables);
 EXCEPTION WHEN sqlstate '22023' THEN RETURN jsonb_build_object('state','refused','reason','variables_invalid','detail',SQLERRM); END;
END $f$;

-- Shared send gate. Called by the owner at queue time and by the worker at load and begin-call.
CREATE FUNCTION app_private.mhp_wa_owner_gate(p_link uuid,p_binding uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $f$
DECLARE state jsonb; hold jsonb;
BEGIN
 IF (app_private.mhp_event_whatsapp_binding(p_binding)).id IS NULL THEN RETURN jsonb_build_object('ok',false,'reason','sender_not_connected'); END IF;
 state:=app_private.mhp_wa_owner_point_state(p_link);
 IF (state->>'ok')::boolean IS NOT TRUE THEN RETURN state; END IF;
 IF state->>'blocked' IS NOT NULL THEN RETURN state||jsonb_build_object('ok',false,'reason',state->>'blocked'); END IF;
 IF state->>'verification'='unverified' THEN RETURN state||jsonb_build_object('ok',false,'reason','number_unverified'); END IF;
 IF state->>'permission'<>'granted' THEN RETURN state||jsonb_build_object('ok',false,'reason',CASE state->>'permission'
   WHEN 'none' THEN 'no_permission' WHEN 'withdrawn' THEN 'permission_withdrawn' WHEN 'denied' THEN 'permission_denied'
   WHEN 'stale' THEN 'permission_stale' ELSE 'basis_not_allowed' END); END IF;
 hold:=app_private.mhp_wa_owner_active_hold(p_binding,decode(state->>'recipientSha256','hex'));
 IF hold IS NOT NULL THEN RETURN state||jsonb_build_object('ok',false,'reason',CASE hold->>'scope' WHEN 'account' THEN 'account_restricted'
   ELSE 'recipient_paused' END,'hold',hold); END IF;
 RETURN state;
END $f$;
REVOKE ALL ON FUNCTION app_private.mhp_wa_owner_gate(uuid,uuid) FROM PUBLIC;

-- 8d. Queue one approved template to one person: every gate, the review chain, one authority and one job.
CREATE FUNCTION app_private.mhp_wa_owner_queue_template(p_origin_workspace uuid,p_origin_contact uuid,p_send uuid,p_link uuid,p_meta_template_id text,p_variables jsonb,p_preview_sha bytea)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE ws constant uuid:='2789228d-55a6-4688-b1e8-2f70abca990b'; actor uuid; request text:=current_setting('app.request_id',true);
 review_authority constant text:='mhp.founder-operator-review-not-legal-advice';
 binding app.property_predator_whatsapp_live_bindings%ROWTYPE; l app_private.mhp_wa_owner_links%ROWTYPE; o app_private.mhp_wa_owner_templates%ROWTYPE;
 prior app_private.mhp_wa_owner_sends%ROWTYPE; gate jsonb; rendered jsonb; request_sha bytea; recipient bytea; used integer; template uuid;
 subject uuid:=gen_random_uuid(); pack uuid:=gen_random_uuid(); legal uuid:=gen_random_uuid(); commercial uuid:=gen_random_uuid();
 publication uuid:=gen_random_uuid(); sender_route uuid:=gen_random_uuid(); instigator_route uuid:=gen_random_uuid();
 authority uuid:=gen_random_uuid(); job uuid:=gen_random_uuid(); scope bytea; facts jsonb; facts_sha bytea; now_at timestamptz; expiry timestamptz;
 route text; consent app.communication_consent_events%ROWTYPE; pin text;
BEGIN
 actor:=app_private.mhp_wa_owner_actor();
 IF p_send IS NULL OR p_link IS NULL OR p_meta_template_id IS NULL OR p_meta_template_id!~'^[1-9][0-9]{4,29}$' OR octet_length(p_preview_sha) IS DISTINCT FROM 32
 THEN RAISE EXCEPTION 'MHP owner WhatsApp send request is invalid' USING ERRCODE='22023'; END IF;
 IF NOT app_private.mhp_wa_owner_link_of(p_link,p_origin_workspace,p_origin_contact,actor) THEN RETURN jsonb_build_object('state','refused','reason','link_not_found'); END IF;
 SELECT * INTO l FROM app_private.mhp_wa_owner_links x WHERE x.id=p_link;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('mhp.wa.owner.send:'||p_send::text,151));
 binding:=app_private.mhp_wa_owner_current_binding();
 IF binding.id IS NULL THEN RETURN jsonb_build_object('state','refused','reason','sender_not_connected'); END IF;
 -- One lock per binding serialises the cap, pacing and idempotency decisions (as 0053/0141 do).
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(format('pp-whatsapp-live:%s:%s',ws,binding.id),0));
 -- Sends that can no longer go out (never picked up in time, or left mid-call) are settled first, whether
 -- or not a worker is running, so they stop counting against today's limit and the person's pacing.
 PERFORM app_private.mhp_wa_owner_sweep(ws,binding.provider_connection_id);
 SELECT * INTO prior FROM app_private.mhp_wa_owner_sends s WHERE s.id=p_send;
 o:=app_private.mhp_wa_owner_template_current(binding.id,p_meta_template_id);
 IF prior.id IS NOT NULL THEN
  -- Replay: the same key must carry the same person, template and exact text; it never sends twice.
  IF prior.kind<>'template' OR prior.link_id<>p_link OR prior.actor_user_id<>actor OR prior.meta_template_id<>p_meta_template_id
   OR prior.rendered_sha256<>p_preview_sha OR NOT app_private.mhp_wa_owner_same_variables(prior.parameters,p_variables)
  THEN RETURN jsonb_build_object('state','conflict','sendId',p_send); END IF;
  RETURN jsonb_build_object('state',prior.state,'sendId',prior.id,'replayed',true,'providerMessageId',prior.provider_message_id);
 END IF;
 IF o.id IS NULL THEN RETURN jsonb_build_object('state','refused','reason','template_not_approved'); END IF;
 BEGIN rendered:=app_private.mhp_wa_owner_render(o.id,p_variables);
 EXCEPTION WHEN sqlstate '22023' THEN RETURN jsonb_build_object('state','refused','reason','variables_invalid','detail',SQLERRM); END;
 IF rendered->>'sha256'<>encode(p_preview_sha,'hex') THEN RETURN jsonb_build_object('state','refused','reason','preview_changed'); END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('mhp.wa.owner.number:'||l.number,151));
 gate:=app_private.mhp_wa_owner_gate(p_link,binding.id);
 -- The gate includes the original brand's own opt-out for every point that carries this number.
 IF (gate->>'ok')::boolean IS NOT TRUE THEN RETURN jsonb_build_object('state','refused','reason',gate->>'reason','hold',gate->'hold'); END IF;
 recipient:=decode(gate->>'recipientSha256','hex');
 now_at:=date_trunc('milliseconds',statement_timestamp());
 SELECT count(*) INTO used FROM app_private.mhp_wa_owner_sends s WHERE s.binding_id=binding.id AND s.kind='template'
  AND s.utc_day=(now_at AT TIME ZONE 'UTC')::date AND s.state NOT IN('expired','blocked');
 IF used>=app_private.mhp_wa_owner_daily_cap() THEN RETURN jsonb_build_object('state','refused','reason','daily_cap_reached','limit',app_private.mhp_wa_owner_daily_cap()); END IF;
 IF EXISTS(SELECT 1 FROM app_private.mhp_wa_owner_sends s WHERE s.recipient_sha256=recipient AND s.kind='template'
   AND s.created_at>now_at-interval '24 hours' AND s.state NOT IN('expired','blocked','failed'))
 THEN RETURN jsonb_build_object('state','refused','reason','recipient_recently_messaged'); END IF;
 SELECT * INTO consent FROM app.communication_consent_events c WHERE c.workspace_id=ws AND c.id=(gate->>'consentEventId')::uuid;
 route:=CASE WHEN consent.source='owner.one-to-one:asked_to_be_contacted' THEN 'solicited_request'
  WHEN consent.source='owner.one-to-one:written_consent' THEN 'individual_consent'
  WHEN consent.source='owner.one-to-one:existing_client' THEN 'individual_soft_opt_in'
  WHEN consent.source='owner.one-to-one:business_introduction' THEN 'corporate_subscriber_reg23' END;
 IF route IS NULL THEN RETURN jsonb_build_object('state','refused','reason','basis_not_allowed'); END IF;
 -- The 0053 rail needs one template row per job. This rail keeps its own row per Meta template id under
 -- a reserved name, so it never takes the real name/language that a webinar programme pins (0141).
 pin:=app_private.mhp_wa_owner_template_pin(o.meta_template_id);
 IF left(o.template_name,length('mhp_owner_121__'))='mhp_owner_121__' THEN RETURN jsonb_build_object('state','refused','reason','template_not_registered'); END IF;
 SELECT t.id INTO template FROM app.property_predator_whatsapp_live_templates t WHERE t.workspace_id=ws AND t.binding_id=binding.id
  AND t.provider_template_name=pin AND t.language_code=o.language_code;
 IF template IS NULL THEN template:=app_private.mhp_wa_owner_register_template(ws,binding.id,o.id); END IF;
 expiry:=now_at+interval '10 minutes';
 request_sha:=public.digest(concat_ws(chr(31),'mhp.owner-one-to-one.send/v1',p_send::text,l.id::text,l.origin_workspace_id::text,l.origin_contact_id::text,
  gate->>'pointId',o.meta_template_id,o.template_name,o.language_code,encode(o.body_sha256,'hex'),rendered->>'sha256',(rendered->'parameters')::text,actor::text),'sha256');
 scope:=public.digest(format('whatsapp:%s:%s:%s:%s:%s:%s',ws,binding.id,template,encode(recipient,'hex'),'mhp.owner-one-to-one',consent.id),'sha256');
 facts:=jsonb_build_object('schema','mhp.owner-one-to-one-review/v1','owner',actor,'request',request,'send',p_send,'link',l.id,
  'originBrand',l.origin_brand,'originWorkspace',l.origin_workspace_id,'originContact',l.origin_contact_id,'binding',binding.id,'template',template,
  'metaTemplateId',o.meta_template_id,'templateObservation',o.id,'renderedSha256',rendered->>'sha256','consent',consent.id,'lawfulBasis',consent.lawful_basis,
  'evidence',consent.source,'verification',gate->>'verification','attestation',gate->>'attestationId','route',route,'generalMarketing',false,
  'reviewAuthority',review_authority,'legalEntity','MH196 Ltd','brand','Martin Howard Property');
 facts_sha:=public.digest(facts::text,'sha256');
 INSERT INTO app_private.mhp_wa_owner_sends(id,workspace_id,link_id,binding_id,actor_user_id,kind,recipient_sha256,template_observation_id,meta_template_id,
  template_name,language_code,category,parameter_format,parameters,body_sha256,rendered_text,rendered_sha256,request_sha256,consent_event_id,attestation_id,
  verification,authority_id,job_id,state,utc_day,request_id)
 VALUES(p_send,ws,l.id,binding.id,actor,'template',recipient,o.id,o.meta_template_id,o.template_name,o.language_code,o.category,o.parameter_format,
  rendered->'parameters',o.body_sha256,rendered->>'text',decode(rendered->>'sha256','hex'),request_sha,consent.id,(gate->>'attestationId')::uuid,
  gate->>'verification',authority,job,'queued',(now_at AT TIME ZONE 'UTC')::date,request);
 INSERT INTO app_private.affiliate_compliance_subjects(id,workspace_id,source_system,source_subject_key,legal_identity_sha256,recorded_by_user_id,recorded_request_id)
 VALUES(subject,ws,'martin-howard-property','mhp.owner-one-to-one:'||p_send::text,public.digest('MH196 Ltd:Martin Howard Property:'||actor::text,'sha256'),actor,request);
 INSERT INTO app_private.affiliate_compliance_policy_pack_versions(id,workspace_id,pack_key,pack_version,bundle_sha256,document_refs,drafting_status,source_commit,
  source_commit_meaning,recorded_by_user_id,recorded_request_id)
 VALUES(pack,ws,'mhp_owner_one_to_one_whatsapp',p_send::text,facts_sha,jsonb_build_array(
  jsonb_build_object('documentType','owner_review','documentId','mhp.owner-121-review:'||p_send::text,'documentVersion','v1','contentSha256',encode(facts_sha,'hex')),
  jsonb_build_object('documentType','sender_ownership','documentId','mhp.wa-sender-ownership:'||binding.id::text,'documentVersion','v1','contentSha256',encode(binding.ownership_evidence_sha256,'hex')),
  jsonb_build_object('documentType','owner_permission','documentId','mhp.owner-121-permission:'||consent.id::text,'documentVersion','v1','contentSha256',encode(consent.endpoint_identity_sha256,'hex')),
  jsonb_build_object('documentType','meta_template_read','documentId','mhp.owner-121-template:'||o.id::text,'documentVersion','v1','contentSha256',encode(o.components_sha256,'hex')),
  jsonb_build_object('documentType','exact_message','documentId','mhp.owner-121-message:'||p_send::text,'documentVersion','v1','contentSha256',rendered->>'sha256')),
  'draft_complete','69652270584f1dc0cf737fe2ff7cd9a19e3a4d28','drafting-provenance-only',actor,request);
 INSERT INTO app_private.affiliate_compliance_policy_review_events(id,workspace_id,policy_pack_id,bundle_sha256,review_dimension,decision,specialist_reference,
  decision_reference,decision_sha256,occurred_at,recorded_by_user_id,recorded_request_id)
 VALUES(legal,ws,pack,facts_sha,'legal','approved',review_authority,'mhp.owner-one-to-one:'||p_send::text,public.digest(facts_sha||convert_to(':owner-legal-dimension','UTF8'),'sha256'),now_at,actor,request),
  (commercial,ws,pack,facts_sha,'commercial','approved',review_authority,'mhp.owner-one-to-one:'||p_send::text,public.digest(facts_sha||convert_to(':owner-commercial-dimension','UTF8'),'sha256'),now_at,actor,request);
 INSERT INTO app_private.affiliate_compliance_policy_publication_events(id,workspace_id,policy_pack_id,bundle_sha256,publication_state,legal_review_event_id,
  commercial_review_event_id,effective_at,expires_at,reacceptance_class,publication_reference,recorded_by_user_id,recorded_request_id)
 VALUES(publication,ws,pack,facts_sha,'published',legal,commercial,now_at,expiry,'none','mhp.owner-one-to-one:'||p_send::text,actor,request);
 INSERT INTO app_private.affiliate_compliance_specialist_decision_events(id,workspace_id,subject_id,decision_kind,decision_scope_ref,action_scope_sha256,decision_state,
  route_classification,party_reference,responsibility_reference,specialist_reference,decision_sha256,valid_from,valid_until,recorded_by_user_id,recorded_request_id)
 VALUES(sender_route,ws,subject,'pecr_sender_route','mhp.owner-one-to-one:'||p_send::text,scope,'approved',route,'mhp.sender.MH196Ltd','mhp.instigator.MH196Ltd',
   review_authority,public.digest(facts_sha||convert_to(':sender','UTF8'),'sha256'),now_at,expiry,actor,request),
  (instigator_route,ws,subject,'pecr_instigator_route','mhp.owner-one-to-one:'||p_send::text,scope,'approved',route,'mhp.sender.MH196Ltd','mhp.instigator.MH196Ltd',
   review_authority,public.digest(facts_sha||convert_to(':instigator','UTF8'),'sha256'),now_at,expiry,actor,request);
 INSERT INTO app.property_predator_whatsapp_live_authorities(id,workspace_id,binding_id,template_id,provider_connection_id,contact_id,contact_point_id,
  recipient_sha256,purpose,consent_event_id,compliance_subject_id,policy_publication_event_id,pecr_sender_decision_event_id,pecr_instigator_decision_event_id,
  permission_use_receipt_id,pecr_decision,pecr_evidence_sha256,operator_instigator_decision,operator_instigator_sha256,action_scope_sha256,operator_user_id,
  operator_request_id,evaluated_at,valid_until,authority_kind,owner_send_id)
 VALUES(authority,ws,binding.id,template,binding.provider_connection_id,(gate->>'contactId')::uuid,(gate->>'pointId')::uuid,recipient,'mhp.owner-one-to-one',
  consent.id,subject,publication,sender_route,instigator_route,NULL,'eligible',public.digest(facts_sha||convert_to(':sender','UTF8'),'sha256'),'eligible',
  public.digest(facts_sha||convert_to(':instigator','UTF8'),'sha256'),scope,actor,request,now_at,expiry,'mhp_owner_direct',p_send);
 INSERT INTO app.property_predator_whatsapp_live_jobs(id,workspace_id,binding_id,template_id,authority_id,provider_connection_id,recipient_sha256,operation_id,
  idempotency_key_sha256,request_sha256,utc_day,utc_month,created_by_user_id,authority_kind,owner_send_id,created_by_actor_kind)
 VALUES(job,ws,binding.id,template,authority,binding.provider_connection_id,recipient,gen_random_uuid(),public.digest('mhp.owner-one-to-one.send:'||p_send::text,'sha256'),
  request_sha,(now_at AT TIME ZONE 'UTC')::date,date_trunc('month',now_at AT TIME ZONE 'UTC')::date,actor,'mhp_owner_direct',p_send,'user');
 PERFORM app_private.mhp_wa_owner_note(l.id,'queued','WhatsApp template queued from Martin Howard Property ('||o.template_name||')',rendered->>'text',
  jsonb_build_object('sendId',p_send,'kind','template','templateName',o.template_name,'language',o.language_code,'metaTemplateId',o.meta_template_id,
   'verification',gate->>'verification','consentEventId',consent.id,'lawfulBasis',consent.lawful_basis),now_at);
 RETURN jsonb_build_object('state','queued','sendId',p_send,'jobId',job,'replayed',false,'dailyRemaining',app_private.mhp_wa_owner_daily_cap()-used-1);
END $f$;

-- 8e. Free text, only as the 0143 in-window reply (the person messaged the MHP number in the last 24 hours).
CREATE FUNCTION app_private.mhp_wa_owner_queue_text(p_origin_workspace uuid,p_origin_contact uuid,p_send uuid,p_link uuid,p_body text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE ws constant uuid:='2789228d-55a6-4688-b1e8-2f70abca990b'; actor uuid; request text:=current_setting('app.request_id',true);
 l app_private.mhp_wa_owner_links%ROWTYPE; binding app.property_predator_whatsapp_live_bindings%ROWTYPE; prior app_private.mhp_wa_owner_sends%ROWTYPE;
 win jsonb; result text; hold jsonb; request_sha bytea; blocked text;
BEGIN
 actor:=app_private.mhp_wa_owner_actor();
 IF p_send IS NULL OR p_link IS NULL OR p_body IS NULL OR length(btrim(p_body))=0 OR octet_length(p_body)>4096
 THEN RAISE EXCEPTION 'MHP owner WhatsApp reply request is invalid' USING ERRCODE='22023'; END IF;
 IF NOT app_private.mhp_wa_owner_link_of(p_link,p_origin_workspace,p_origin_contact,actor) THEN RETURN jsonb_build_object('state','refused','reason','link_not_found'); END IF;
 SELECT * INTO l FROM app_private.mhp_wa_owner_links x WHERE x.id=p_link;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('mhp.wa.owner.send:'||p_send::text,151));
 request_sha:=public.digest(concat_ws(chr(31),'mhp.owner-one-to-one.text/v1',p_send::text,l.id::text,p_body,actor::text),'sha256');
 SELECT * INTO prior FROM app_private.mhp_wa_owner_sends s WHERE s.id=p_send;
 IF prior.id IS NOT NULL THEN
  IF prior.request_sha256<>request_sha THEN RETURN jsonb_build_object('state','conflict','sendId',p_send); END IF;
  RETURN jsonb_build_object('state',prior.state,'sendId',prior.id,'replayed',true,'providerMessageId',prior.provider_message_id);
 END IF;
 binding:=app_private.mhp_wa_owner_current_binding();
 IF binding.id IS NULL THEN RETURN jsonb_build_object('state','refused','reason','sender_not_connected'); END IF;
 blocked:=coalesce(app_private.mhp_wa_owner_number_blocked(l.number),
  app_private.mhp_wa_owner_origin_blocked(l.origin_workspace_id,l.origin_contact_id,l.origin_point_id,l.number));
 IF blocked IS NOT NULL THEN RETURN jsonb_build_object('state','refused','reason',blocked); END IF;
 hold:=app_private.mhp_wa_owner_active_hold(binding.id,public.digest(l.number,'sha256'));
 IF hold IS NOT NULL THEN RETURN jsonb_build_object('state','refused','reason',CASE hold->>'scope' WHEN 'account' THEN 'account_restricted' ELSE 'recipient_paused' END,'hold',hold); END IF;
 win:=app_private.mhp_wa_owner_window(binding.id,l.number);
 IF (win->>'open')::boolean IS NOT TRUE THEN RETURN jsonb_build_object('state','refused','reason','window_closed'); END IF;
 result:=app_private.mhp_wa_direct_queue(p_send,(win->>'inboxId')::uuid,(win->>'threadId')::uuid,p_body);
 IF result IS DISTINCT FROM 'queued' THEN RETURN jsonb_build_object('state','refused','reason',CASE result WHEN 'conflict' THEN 'request_conflict' ELSE 'window_closed' END); END IF;
 INSERT INTO app_private.mhp_wa_owner_sends(id,workspace_id,link_id,binding_id,actor_user_id,kind,recipient_sha256,rendered_text,rendered_sha256,request_sha256,
  verification,direct_reply_id,state,utc_day,request_id)
 VALUES(p_send,ws,l.id,binding.id,actor,'text',public.digest(l.number,'sha256'),p_body,public.digest(p_body,'sha256'),request_sha,'inbound_window',p_send,'queued',
  (statement_timestamp() AT TIME ZONE 'UTC')::date,request);
 PERFORM app_private.mhp_wa_owner_note(l.id,'queued','WhatsApp reply queued from Martin Howard Property',p_body,
  jsonb_build_object('sendId',p_send,'kind','text','windowClosesAt',win->>'closesAt'),NULL);
 RETURN jsonb_build_object('state','queued','sendId',p_send,'replayed',false);
END $f$;

-- 8f. Everything the CRM contact view shows, for one original brand contact.
CREATE FUNCTION app_private.mhp_wa_owner_contact_state(p_origin_workspace uuid,p_origin_contact uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; binding app.property_predator_whatsapp_live_bindings%ROWTYPE; used integer:=0; links jsonb; sends jsonb; candidates jsonb;
BEGIN
 actor:=app_private.mhp_wa_owner_actor();
 IF p_origin_workspace IS NULL OR p_origin_contact IS NULL OR NOT app_private.can_manage_workspace(actor,p_origin_workspace)
 THEN RAISE EXCEPTION 'MHP owner WhatsApp read denied' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT 1 FROM app.contacts c WHERE c.workspace_id=p_origin_workspace AND c.id=p_origin_contact AND c.deleted_at IS NULL)
 THEN RETURN jsonb_build_object('state','refused','reason','contact_not_found'); END IF;
 binding:=app_private.mhp_wa_owner_current_binding();
 IF binding.id IS NOT NULL THEN
  SELECT count(*) INTO used FROM app_private.mhp_wa_owner_sends s WHERE s.binding_id=binding.id AND s.kind='template'
   AND s.utc_day=(statement_timestamp() AT TIME ZONE 'UTC')::date AND app_private.mhp_wa_owner_effective_state(s.id) NOT IN('expired','blocked');
 END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('linkId',l.id,'number',app_private.mhp_wa_owner_mask(l.number),'numberSource',l.number_source,
   'originPointId',l.origin_point_id,'mhpContactId',l.mhp_contact_id,'verification',st->>'verification','permission',st->>'permission',
   'lawfulBasis',st->>'lawfulBasis','evidence',st->>'evidenceSource','permissionRecordedAt',st->>'permissionRecordedAt','blocked',st->>'blocked',
   'available',st->>'ok','unavailableReason',CASE WHEN (st->>'ok')::boolean IS NOT TRUE THEN st->>'reason' END,
   'window',CASE WHEN binding.id IS NULL THEN jsonb_build_object('open',false) ELSE app_private.mhp_wa_owner_window(binding.id,l.number)-'threadId'-'inboxId' END,
   'gate',CASE WHEN binding.id IS NULL THEN jsonb_build_object('ok',false,'reason','sender_not_connected')
    ELSE (SELECT jsonb_build_object('ok',g->'ok','reason',g->'reason','hold',g->'hold') FROM app_private.mhp_wa_owner_gate(l.id,binding.id) g) END)
  ORDER BY l.created_at,l.id),'[]'::jsonb) INTO links
 FROM app_private.mhp_wa_owner_links l CROSS JOIN LATERAL app_private.mhp_wa_owner_point_state(l.id) st
 WHERE l.origin_workspace_id=p_origin_workspace AND l.origin_contact_id=p_origin_contact;
 SELECT coalesce(jsonb_agg(x ORDER BY x->>'createdAt' DESC),'[]'::jsonb) INTO sends FROM (
  SELECT jsonb_build_object('sendId',s.id,'kind',s.kind,'state',app_private.mhp_wa_owner_effective_state(s.id),
   'stateReason',CASE WHEN app_private.mhp_wa_owner_effective_state(s.id)<>s.state THEN 'authority_expired' ELSE s.state_reason END,
   'templateName',s.template_name,'language',s.language_code,
   'text',s.rendered_text,'providerMessageId',s.provider_message_id,'errorCode',s.error_code,'createdAt',s.created_at,'updatedAt',s.updated_at,
   'number',app_private.mhp_wa_owner_mask(l.number),
   'receipts',coalesce((SELECT jsonb_agg(jsonb_build_object('event',r.event_kind,'at',r.provider_occurred_at,'code',r.safe_code) ORDER BY r.provider_occurred_at,r.recorded_at,r.id)
     FROM app.property_predator_whatsapp_live_receipts r WHERE r.workspace_id=s.workspace_id AND r.binding_id=s.binding_id
      AND ((s.job_id IS NOT NULL AND r.job_id=s.job_id) OR (s.job_id IS NULL AND s.provider_message_id IS NOT NULL AND r.job_id IS NULL
       AND r.provider_message_id=s.provider_message_id AND r.recipient_or_sender_sha256=s.recipient_sha256))),'[]'::jsonb)) AS x
  FROM app_private.mhp_wa_owner_sends s JOIN app_private.mhp_wa_owner_links l ON l.id=s.link_id
  WHERE l.origin_workspace_id=p_origin_workspace AND l.origin_contact_id=p_origin_contact ORDER BY s.created_at DESC,s.id DESC LIMIT 20) q;
 SELECT coalesce(jsonb_agg(jsonb_build_object('pointId',p.id,'kind',p.kind,'number',CASE WHEN app_private.mhp_wa_owner_number(p.normalized_value) IS NULL
   THEN NULL ELSE app_private.mhp_wa_owner_mask(app_private.mhp_wa_owner_number(p.normalized_value)) END,
   'usable',app_private.mhp_wa_owner_number(p.normalized_value) IS NOT NULL,'linked',EXISTS(SELECT 1 FROM app_private.mhp_wa_owner_links l
    WHERE l.origin_workspace_id=p.workspace_id AND l.origin_contact_id=p.contact_id AND l.number=app_private.mhp_wa_owner_number(p.normalized_value)))
   ORDER BY p.is_primary DESC,p.created_at,p.id),'[]'::jsonb) INTO candidates
 FROM app.contact_points p WHERE p.workspace_id=p_origin_workspace AND p.contact_id=p_origin_contact AND p.kind IN('whatsapp','phone') AND p.deleted_at IS NULL;
 RETURN jsonb_build_object('state','ok','sender',jsonb_build_object('connected',binding.id IS NOT NULL,'name','Martin Howard Property'),
  'dailyCap',jsonb_build_object('limit',app_private.mhp_wa_owner_daily_cap(),'used',used,'remaining',greatest(app_private.mhp_wa_owner_daily_cap()-used,0)),
  'accountHold',CASE WHEN binding.id IS NOT NULL THEN (SELECT jsonb_build_object('reason',h.reason,'errorCode',h.error_code,'until',h.held_until)
    FROM app_private.mhp_wa_owner_holds h WHERE h.binding_id=binding.id AND h.scope='account' AND h.held_until>statement_timestamp()
    ORDER BY h.held_until DESC LIMIT 1) END,
  'numbers',links,'candidates',candidates,'sends',sends);
END $f$;

-- 8g. One send's current state and receipts (owner read; used after a submit).
CREATE FUNCTION app_private.mhp_wa_owner_send_status(p_send uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE s app_private.mhp_wa_owner_sends%ROWTYPE; l app_private.mhp_wa_owner_links%ROWTYPE; actor uuid;
BEGIN
 actor:=app_private.mhp_wa_owner_actor();
 SELECT * INTO s FROM app_private.mhp_wa_owner_sends x WHERE x.id=p_send;
 IF NOT FOUND THEN RETURN jsonb_build_object('state','not_found'); END IF;
 SELECT * INTO l FROM app_private.mhp_wa_owner_links x WHERE x.id=s.link_id;
 IF NOT app_private.can_manage_workspace(actor,l.origin_workspace_id) THEN RETURN jsonb_build_object('state','not_found'); END IF;
 RETURN jsonb_build_object('sendId',s.id,'kind',s.kind,'state',app_private.mhp_wa_owner_effective_state(s.id),
  'stateReason',CASE WHEN app_private.mhp_wa_owner_effective_state(s.id)<>s.state THEN 'authority_expired' ELSE s.state_reason END,
  'providerMessageId',s.provider_message_id,
  'errorCode',s.error_code,'templateName',s.template_name,'text',s.rendered_text,'createdAt',s.created_at,'updatedAt',s.updated_at,
  'originWorkspaceId',l.origin_workspace_id,'originContactId',l.origin_contact_id,
  'receipts',coalesce((SELECT jsonb_agg(jsonb_build_object('event',r.event_kind,'at',r.provider_occurred_at,'code',r.safe_code) ORDER BY r.provider_occurred_at,r.recorded_at,r.id)
   FROM app.property_predator_whatsapp_live_receipts r WHERE r.workspace_id=s.workspace_id AND r.binding_id=s.binding_id
    AND ((s.job_id IS NOT NULL AND r.job_id=s.job_id) OR (s.job_id IS NULL AND s.provider_message_id IS NOT NULL AND r.job_id IS NULL
     AND r.provider_message_id=s.provider_message_id AND r.recipient_or_sender_sha256=s.recipient_sha256))),'[]'::jsonb));
END $f$;

REVOKE ALL ON FUNCTION app_private.mhp_wa_owner_link(uuid,text,uuid,uuid,text),
 app_private.mhp_wa_owner_set_permission(uuid,uuid,uuid,uuid,text,text,text,text,boolean),app_private.mhp_wa_owner_templates_list(),
 app_private.mhp_wa_owner_preview(text,jsonb),app_private.mhp_wa_owner_queue_template(uuid,uuid,uuid,uuid,text,jsonb,bytea),
 app_private.mhp_wa_owner_queue_text(uuid,uuid,uuid,uuid,text),app_private.mhp_wa_owner_contact_state(uuid,uuid),app_private.mhp_wa_owner_send_status(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.mhp_wa_owner_link(uuid,text,uuid,uuid,text),
 app_private.mhp_wa_owner_set_permission(uuid,uuid,uuid,uuid,text,text,text,text,boolean),app_private.mhp_wa_owner_templates_list(),
 app_private.mhp_wa_owner_preview(text,jsonb),app_private.mhp_wa_owner_queue_template(uuid,uuid,uuid,uuid,text,jsonb,bytea),
 app_private.mhp_wa_owner_queue_text(uuid,uuid,uuid,uuid,text),app_private.mhp_wa_owner_contact_state(uuid,uuid),app_private.mhp_wa_owner_send_status(uuid)
 TO r72_crm_command;

-- 9. Worker: the Meta template catalogue, and the owner job claim/load/begin on the 0053 rail.
CREATE FUNCTION app_private.mhp_wa_owner_catalogue_target(p_workspace uuid,p_binding uuid)
RETURNS TABLE(binding_id uuid,provider_connection_id uuid,app_id text,waba_id text,phone_number_id text,graph_api_version text,secret_key_version text,
 secret_iv bytea,secret_ciphertext bytea,secret_auth_tag bytea,secret_aad_sha256 bytea,secret_payload_sha256 bytea)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE b app.property_predator_whatsapp_live_bindings%ROWTYPE;
BEGIN
 PERFORM app_private.mhp_event_whatsapp_worker_context(p_workspace);
 b:=app_private.mhp_event_whatsapp_binding(p_binding);
 IF b.id IS NULL THEN RETURN; END IF;
 RETURN QUERY SELECT b.id,b.provider_connection_id,b.app_id,b.waba_id,b.phone_number_id,b.graph_api_version,b.secret_key_version,b.secret_iv,
  b.secret_ciphertext,b.secret_auth_tag,b.secret_aad_sha256,b.secret_payload_sha256;
END $f$;

-- The worker's parse is re-proved here: the placeholder set is recomputed from the body Meta returned.
CREATE FUNCTION app_private.record_mhp_wa_owner_template(p_workspace uuid,p_binding uuid,p_meta_template_id text,p_name text,p_language text,p_category text,
 p_status text,p_parameter_format text,p_parameter_names text[],p_body text,p_preview text,p_components_sha bytea,p_sendable boolean,p_unsupported_reason text)
RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE created uuid; found_names text[]; numeric_names boolean; latest app_private.mhp_wa_owner_templates%ROWTYPE;
BEGIN
 PERFORM app_private.mhp_event_whatsapp_worker_context(p_workspace);
 IF (app_private.mhp_event_whatsapp_binding(p_binding)).id IS NULL THEN RAISE EXCEPTION 'MHP owner template observation denied' USING ERRCODE='42501'; END IF;
 SELECT coalesce(array_agg(n ORDER BY first_at),'{}') INTO found_names FROM (SELECT m[1] AS n,min(ord) AS first_at
  FROM regexp_matches(coalesce(p_body,''),'\{\{([^{}]{1,64})\}\}','g') WITH ORDINALITY AS r(m,ord) GROUP BY m[1]) x;
 numeric_names:=cardinality(found_names)>0 AND NOT EXISTS(SELECT 1 FROM unnest(found_names) n WHERE n!~'^[1-9][0-9]?$');
 IF (p_parameter_format='NONE' AND cardinality(found_names)<>0)
  OR (p_parameter_format='POSITIONAL' AND (NOT numeric_names
   OR (SELECT array_agg(n::integer ORDER BY n::integer) FROM unnest(found_names) n)<>(SELECT array_agg(i) FROM generate_series(1,cardinality(found_names)) i)
   OR p_parameter_names IS DISTINCT FROM (SELECT array_agg(i::text ORDER BY i) FROM generate_series(1,cardinality(found_names)) i)))
  OR (p_parameter_format='NAMED' AND (EXISTS(SELECT 1 FROM unnest(found_names) n WHERE n!~'^[a-z_][a-z0-9_]*$') OR p_parameter_names IS DISTINCT FROM found_names))
  OR p_parameter_format NOT IN('NONE','POSITIONAL','NAMED')
  OR position(p_body IN coalesce(p_preview,''))=0
 THEN RAISE EXCEPTION 'MHP owner template evidence is inconsistent' USING ERRCODE='22023'; END IF;
 -- Meta still returning exactly the same template refreshes the latest row; only a change adds one.
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('mhp.wa.owner.template:'||p_binding::text||':'||coalesce(p_meta_template_id,''),151));
 SELECT * INTO latest FROM app_private.mhp_wa_owner_templates x WHERE x.binding_id=p_binding AND x.meta_template_id=p_meta_template_id
  ORDER BY x.observed_at DESC,x.id DESC LIMIT 1;
 IF latest.id IS NOT NULL AND latest.workspace_id=p_workspace AND latest.template_name=p_name AND latest.language_code=p_language AND latest.category=p_category
  AND latest.provider_status=p_status AND latest.parameter_format=p_parameter_format AND latest.parameter_names=coalesce(p_parameter_names,'{}')
  AND latest.body_text=p_body AND latest.preview_text=p_preview AND latest.components_sha256=p_components_sha AND latest.sendable=p_sendable
  AND latest.unsupported_reason IS NOT DISTINCT FROM p_unsupported_reason THEN
  UPDATE app_private.mhp_wa_owner_templates SET observed_at=greatest(statement_timestamp(),latest.observed_at),
   expires_at=greatest(statement_timestamp(),latest.observed_at)+interval '15 minutes',observed_request_id=current_setting('app.request_id',true)
  WHERE id=latest.id;
  RETURN latest.id;
 END IF;
 INSERT INTO app_private.mhp_wa_owner_templates(workspace_id,binding_id,meta_template_id,template_name,language_code,category,provider_status,parameter_format,
  parameter_names,body_text,preview_text,body_sha256,components_sha256,sendable,unsupported_reason,observed_by_role,observed_request_id,expires_at)
 VALUES(p_workspace,p_binding,p_meta_template_id,p_name,p_language,p_category,p_status,p_parameter_format,coalesce(p_parameter_names,'{}'),p_body,p_preview,
  public.digest(p_body,'sha256'),p_components_sha,p_sendable,p_unsupported_reason,'r72_whatsapp_live_worker_command',current_setting('app.request_id',true),
  statement_timestamp()+interval '15 minutes') RETURNING id INTO created;
 RETURN created;
END $f$;

-- The 0053 rail names one template row per name/language, pinned to an approved company-content
-- version, and a webinar programme (0141) refuses a name/language already pinned to other content.
-- So this rail never takes the real name: its row is keyed by the Meta template id under the reserved
-- name mhp_owner_121__<id>, and a webinar programme can still pin the real name afterwards. The exact
-- template (real name, language, body, variables, rendered text) is carried by mhp_wa_owner_sends and
-- re-proved against the latest Meta read at begin-call. No other rail can send through the reserved
-- row: Meta has no template of that name.
CREATE FUNCTION app_private.mhp_wa_owner_register_template(p_workspace uuid,p_binding uuid,p_observation uuid) RETURNS uuid
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog AS $f$
DECLARE o app_private.mhp_wa_owner_templates%ROWTYPE; b app.property_predator_whatsapp_live_bindings%ROWTYPE; item uuid:=gen_random_uuid();
 version uuid:=gen_random_uuid(); req uuid:=gen_random_uuid(); decision uuid:=gen_random_uuid(); template uuid:=gen_random_uuid(); body text; sha bytea;
 key text; actor uuid:=nullif(current_setting('app.user_id',true),'')::uuid; request text:=current_setting('app.request_id',true);
BEGIN
 SELECT * INTO STRICT o FROM app_private.mhp_wa_owner_templates x WHERE x.id=p_observation AND x.binding_id=p_binding;
 b:=app_private.mhp_event_whatsapp_binding(p_binding);
 IF b.id IS NULL OR session_user<>'r72_crm_command' OR actor IS NULL THEN RAISE EXCEPTION 'MHP owner template registration denied' USING ERRCODE='42501'; END IF;
 key:='meta-template:'||o.meta_template_id;
 body:=jsonb_build_object('schema','mhp.owner-121-meta-template/v1','metaTemplateId',o.meta_template_id,'templateName',o.template_name,
  'language',o.language_code,'category',o.category,'bodyText',o.body_text,'componentsSha256',encode(o.components_sha256,'hex'))::text;
 sha:=public.digest(body,'sha256');
 INSERT INTO app.company_content_items(id,workspace_id,source_system,source_item_id,created_by_user_id,created_request_id)
 VALUES(item,p_workspace,'mhp.owner-121-meta',key,actor,request);
 INSERT INTO app.company_content_versions(id,workspace_id,content_item_id,version_number,origin,content_kind,title,source_system,source_item_id,source_version,
  content_mime_type,content_body,blob_storage_key,blob_sha256,brand_snapshot_ref,brand_sha256,created_by_user_id,created_request_id,metadata)
 VALUES(version,p_workspace,item,1,'imported','other',left(o.template_name,300),'mhp.owner-121-meta',key,'meta-read:'||o.id::text,
  'application/json',body,'inline:mhp.owner-121-meta:'||encode(sha,'hex'),sha,'mhp.owner-121-meta',sha,actor,request,
  jsonb_build_object('evidence','server-side Meta template read, APPROVED; chosen and confirmed by the owner','observationId',o.id));
 INSERT INTO app.company_content_approval_requests(id,workspace_id,content_item_id,content_version_id,content_sha256,request_number,requested_by_user_id,requested_request_id)
 VALUES(req,p_workspace,item,version,sha,1,actor,request);
 INSERT INTO app.company_content_approval_decisions(id,workspace_id,content_item_id,content_version_id,approval_request_id,content_sha256,decision,decided_by_user_id,decided_request_id)
 VALUES(decision,p_workspace,item,version,req,sha,'approved',actor,request);
 INSERT INTO app.property_predator_whatsapp_live_templates(id,workspace_id,binding_id,provider_connection_id,content_item_id,content_version_id,content_sha256,
  approval_request_id,approval_decision_id,provider_template_name,provider_template_ref_sha256,language_code,category,parameter_count,provider_status,
  provider_approval_evidence_sha256,provider_approved_at,created_by_user_id)
 VALUES(template,p_workspace,p_binding,b.provider_connection_id,item,version,sha,req,decision,app_private.mhp_wa_owner_template_pin(o.meta_template_id),
  public.digest('meta-template:'||o.meta_template_id,'sha256'),
  o.language_code,lower(o.category),0,'approved',o.components_sha256,o.observed_at,actor);
 RETURN template;
END $f$;
REVOKE ALL ON FUNCTION app_private.mhp_wa_owner_register_template(uuid,uuid,uuid) FROM PUBLIC;

-- Settle owner jobs that can no longer be sent. Called by the worker's claim and by the owner's next
-- queue attempt, so it also runs while the worker's owner switch is off. 0053 recovery semantics for
-- owner jobs only: a begun call is never retried (it becomes 'outcome unknown', which keeps counting);
-- a queued job whose authority lapsed was never handed to Meta and is recorded as expired.
CREATE FUNCTION app_private.mhp_wa_owner_sweep(p_workspace_id uuid,p_provider_connection_id uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog AS $f$
DECLARE recovered app.property_predator_whatsapp_live_jobs%ROWTYPE; stale record; expired_link uuid;
BEGIN
 FOR recovered IN SELECT job.* FROM app.property_predator_whatsapp_live_jobs AS job
  WHERE job.workspace_id=p_workspace_id AND job.provider_connection_id=p_provider_connection_id AND job.authority_kind='mhp_owner_direct'
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
 FOR stale IN UPDATE app.property_predator_whatsapp_live_jobs AS j SET state='cancelled',settled_at=statement_timestamp(),updated_at=statement_timestamp()
  FROM app.property_predator_whatsapp_live_authorities AS a
  WHERE j.workspace_id=p_workspace_id AND j.provider_connection_id=p_provider_connection_id AND j.authority_kind='mhp_owner_direct' AND j.state='queued'
   AND a.workspace_id=j.workspace_id AND a.id=j.authority_id AND a.valid_until<=statement_timestamp()
  RETURNING j.owner_send_id LOOP
  UPDATE app_private.mhp_wa_owner_sends AS s SET state='expired',state_reason='authority_expired',updated_at=greatest(statement_timestamp(),s.updated_at)
  WHERE s.id=stale.owner_send_id AND s.state='queued' RETURNING s.link_id INTO expired_link;
  IF FOUND THEN
   PERFORM app_private.mhp_wa_owner_note(expired_link,'expired','WhatsApp not sent: it expired before the sender picked it up',NULL,
    jsonb_build_object('sendId',stale.owner_send_id,'reason','authority_expired'),NULL);
  END IF;
 END LOOP;
END $f$;
REVOKE ALL ON FUNCTION app_private.mhp_wa_owner_sweep(uuid,uuid) FROM PUBLIC;

CREATE FUNCTION app_private.claim_owner_whatsapp_job(p_workspace_id uuid,p_provider_connection_id uuid,p_lease_token bytea,p_lease_seconds integer)
RETURNS TABLE(job_id uuid,binding_id uuid,lease_version bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE selected app.property_predator_whatsapp_live_jobs%ROWTYPE; next_version bigint;
BEGIN
 PERFORM app_private.mhp_event_whatsapp_worker_context(p_workspace_id);
 IF octet_length(p_lease_token) IS DISTINCT FROM 32 OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 300
 THEN RAISE EXCEPTION 'MHP owner WhatsApp claim denied' USING ERRCODE='42501'; END IF;
 PERFORM app_private.mhp_wa_owner_sweep(p_workspace_id,p_provider_connection_id);
 SELECT job.* INTO selected FROM app.property_predator_whatsapp_live_jobs AS job
 JOIN app.property_predator_whatsapp_live_authorities AS a ON a.workspace_id=job.workspace_id AND a.id=job.authority_id AND a.authority_kind='mhp_owner_direct'
  AND a.owner_send_id=job.owner_send_id AND a.valid_until>statement_timestamp()
 JOIN app_private.mhp_wa_owner_sends AS s ON s.id=job.owner_send_id AND s.job_id=job.id AND s.state='queued'
 WHERE job.workspace_id=p_workspace_id AND job.provider_connection_id=p_provider_connection_id AND job.authority_kind='mhp_owner_direct'
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

-- Every gate again, against the exact send: the authority, the person, the permission and the template.
CREATE FUNCTION app_private.mhp_wa_owner_eligible(p_job uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $f$
DECLARE job app.property_predator_whatsapp_live_jobs%ROWTYPE; s app_private.mhp_wa_owner_sends%ROWTYPE; a app.property_predator_whatsapp_live_authorities%ROWTYPE;
 gate jsonb; o app_private.mhp_wa_owner_templates%ROWTYPE; rendered jsonb;
BEGIN
 SELECT * INTO job FROM app.property_predator_whatsapp_live_jobs j WHERE j.id=p_job AND j.authority_kind='mhp_owner_direct';
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','not_eligible'); END IF;
 SELECT * INTO s FROM app_private.mhp_wa_owner_sends x WHERE x.id=job.owner_send_id AND x.job_id=job.id;
 SELECT * INTO a FROM app.property_predator_whatsapp_live_authorities x WHERE x.workspace_id=job.workspace_id AND x.id=job.authority_id AND x.owner_send_id=s.id;
 IF s.id IS NULL OR a.id IS NULL OR a.valid_until<=statement_timestamp() THEN RETURN jsonb_build_object('ok',false,'reason','authority_expired'); END IF;
 IF NOT app_private.mhp_wa_direct_owner(s.actor_user_id) THEN RETURN jsonb_build_object('ok',false,'reason','not_owner'); END IF;
 gate:=app_private.mhp_wa_owner_gate(s.link_id,s.binding_id);
 IF (gate->>'ok')::boolean IS NOT TRUE THEN RETURN gate; END IF;
 IF (gate->>'consentEventId')::uuid IS DISTINCT FROM s.consent_event_id OR (gate->>'consentEventId')::uuid IS DISTINCT FROM a.consent_event_id
  OR decode(gate->>'recipientSha256','hex') IS DISTINCT FROM s.recipient_sha256 OR (gate->>'pointId')::uuid IS DISTINCT FROM a.contact_point_id
  OR gate->>'verification' IS DISTINCT FROM s.verification OR (gate->>'attestationId')::uuid IS DISTINCT FROM s.attestation_id
 THEN RETURN jsonb_build_object('ok',false,'reason','permission_changed'); END IF;
 o:=app_private.mhp_wa_owner_template_current(s.binding_id,s.meta_template_id);
 IF o.id IS NULL OR o.template_name<>s.template_name OR o.language_code<>s.language_code
 THEN RETURN jsonb_build_object('ok',false,'reason','template_not_approved'); END IF;
 -- What Meta will send must still be exactly what the owner previewed: every component Meta returned
 -- (header, body, footer, buttons) is unchanged, and the text rendered now from the stored variables
 -- has the previewed SHA-256.
 IF o.body_sha256<>s.body_sha256 OR o.parameter_format<>s.parameter_format OR o.components_sha256 IS DISTINCT FROM
   (SELECT q.components_sha256 FROM app_private.mhp_wa_owner_templates q WHERE q.id=s.template_observation_id)
 THEN RETURN jsonb_build_object('ok',false,'reason','preview_changed'); END IF;
 BEGIN
  rendered:=app_private.mhp_wa_owner_render(o.id,CASE s.parameter_format
   WHEN 'NAMED' THEN (SELECT coalesce(jsonb_object_agg(e->>'name',e->'value'),'{}'::jsonb) FROM jsonb_array_elements(s.parameters) e)
   WHEN 'POSITIONAL' THEN (SELECT coalesce(jsonb_agg(e->'value' ORDER BY n),'[]'::jsonb) FROM jsonb_array_elements(s.parameters) WITH ORDINALITY x(e,n))
   ELSE '[]'::jsonb END);
 EXCEPTION WHEN sqlstate '22023' THEN RETURN jsonb_build_object('ok',false,'reason','preview_changed'); END;
 IF decode(rendered->>'sha256','hex') IS DISTINCT FROM s.rendered_sha256 OR rendered->'parameters' IS DISTINCT FROM s.parameters
 THEN RETURN jsonb_build_object('ok',false,'reason','preview_changed'); END IF;
 RETURN jsonb_build_object('ok',true,'observationId',o.id);
END $f$;
REVOKE ALL ON FUNCTION app_private.mhp_wa_owner_eligible(uuid) FROM PUBLIC;

CREATE FUNCTION app_private.load_owner_whatsapp_job(p_workspace_id uuid,p_job_id uuid,p_lease_version bigint,p_lease_token bytea)
RETURNS TABLE(provider_connection_id uuid,binding_id uuid,app_id text,waba_id text,phone_number_id text,graph_api_version text,secret_key_version text,
 secret_iv bytea,secret_ciphertext bytea,secret_auth_tag bytea,secret_aad_sha256 bytea,secret_payload_sha256 bytea,recipient text,template_name text,
 language_code text,operation_id uuid,request_sha256 bytea,meta_template_id text,send_id uuid,parameter_format text,parameters jsonb,eligible boolean,reason text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE elig jsonb; held boolean;
BEGIN
 PERFORM app_private.mhp_event_whatsapp_worker_context(p_workspace_id);
 SELECT EXISTS(SELECT 1 FROM app.property_predator_whatsapp_live_jobs AS job
 JOIN app.property_predator_whatsapp_live_job_leases AS lease ON lease.workspace_id=job.workspace_id AND lease.job_id=job.id
  AND lease.lease_version=job.lease_version AND lease.lease_token_sha256=public.digest(p_lease_token,'sha256')
 WHERE job.workspace_id=p_workspace_id AND job.id=p_job_id AND job.authority_kind='mhp_owner_direct' AND job.state='leased'
  AND job.lease_version=p_lease_version AND job.lease_expires_at>statement_timestamp()) INTO held;
 IF NOT held THEN RETURN; END IF;
 elig:=app_private.mhp_wa_owner_eligible(p_job_id);
 RETURN QUERY SELECT job.provider_connection_id,job.binding_id,b.app_id,b.waba_id,b.phone_number_id,b.graph_api_version,b.secret_key_version,
  b.secret_iv,b.secret_ciphertext,b.secret_auth_tag,b.secret_aad_sha256,b.secret_payload_sha256,l.number,s.template_name,
  s.language_code,job.operation_id,job.request_sha256,s.meta_template_id,s.id,s.parameter_format,s.parameters,(elig->>'ok')::boolean,elig->>'reason'
 FROM app.property_predator_whatsapp_live_jobs AS job
 JOIN app_private.mhp_wa_owner_sends AS s ON s.id=job.owner_send_id AND s.job_id=job.id
 JOIN app_private.mhp_wa_owner_links AS l ON l.id=s.link_id AND public.digest(l.number,'sha256')=job.recipient_sha256
 JOIN app.property_predator_whatsapp_live_bindings AS b ON b.workspace_id=job.workspace_id AND b.id=job.binding_id AND b.status='active'
 WHERE job.workspace_id=p_workspace_id AND job.id=p_job_id;
END $f$;

-- Begin-call: fresh committed reads; a STOP, withdrawal, hold or non-APPROVED read that committed first denies.
CREATE FUNCTION app_private.begin_owner_whatsapp_call(p_workspace_id uuid,p_job_id uuid,p_lease_version bigint,p_lease_token bytea,
 p_provider_effects_enabled boolean,p_emergency_paused boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE selected app.property_predator_whatsapp_live_jobs%ROWTYPE; elig jsonb; s app_private.mhp_wa_owner_sends%ROWTYPE;
BEGIN
 PERFORM app_private.mhp_event_whatsapp_worker_context(p_workspace_id);
 IF p_provider_effects_enabled IS NOT TRUE OR p_emergency_paused IS NOT FALSE OR octet_length(p_lease_token) IS DISTINCT FROM 32
 THEN RAISE EXCEPTION 'MHP owner WhatsApp begin-call denied' USING ERRCODE='42501'; END IF;
 SELECT job.* INTO selected FROM app.property_predator_whatsapp_live_jobs AS job
 JOIN app.property_predator_whatsapp_live_job_leases AS lease ON lease.workspace_id=job.workspace_id AND lease.job_id=job.id
  AND lease.lease_version=job.lease_version AND lease.lease_token_sha256=public.digest(p_lease_token,'sha256')
 WHERE job.workspace_id=p_workspace_id AND job.id=p_job_id AND job.authority_kind='mhp_owner_direct' AND job.state='leased'
  AND job.lease_version=p_lease_version AND job.lease_expires_at>statement_timestamp() FOR UPDATE OF job;
 IF NOT FOUND THEN RETURN jsonb_build_object('begun',false,'reason','lease_lost'); END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(format('pp-whatsapp-call-fence:%s:%s',p_workspace_id,selected.binding_id),0));
 elig:=app_private.mhp_wa_owner_eligible(selected.id);
 SELECT * INTO s FROM app_private.mhp_wa_owner_sends x WHERE x.id=selected.owner_send_id FOR UPDATE;
 IF (elig->>'ok')::boolean IS NOT TRUE OR s.state<>'queued' THEN
  -- Never handed to Meta: the job is cancelled and the send says why, in plain terms.
  UPDATE app.property_predator_whatsapp_live_jobs SET state='cancelled',lease_expires_at=NULL,settled_at=statement_timestamp(),updated_at=statement_timestamp()
  WHERE workspace_id=p_workspace_id AND id=p_job_id;
  DELETE FROM app.property_predator_whatsapp_live_job_leases AS lease WHERE lease.workspace_id=p_workspace_id AND lease.job_id=p_job_id;
  UPDATE app_private.mhp_wa_owner_sends SET state='blocked',state_reason=coalesce(elig->>'reason','not_eligible'),updated_at=statement_timestamp()
  WHERE id=s.id AND state='queued';
  IF FOUND THEN
   PERFORM app_private.mhp_wa_owner_note(s.link_id,'blocked','WhatsApp not sent: checks failed just before sending',NULL,
    jsonb_build_object('sendId',s.id,'reason',coalesce(elig->>'reason','not_eligible')),NULL);
  END IF;
  RETURN jsonb_build_object('begun',false,'reason',coalesce(elig->>'reason','not_eligible'));
 END IF;
 UPDATE app.property_predator_whatsapp_live_jobs SET state='calling',calling_at=statement_timestamp(),updated_at=statement_timestamp()
 WHERE workspace_id=p_workspace_id AND id=p_job_id AND state='leased';
 IF NOT FOUND THEN RETURN jsonb_build_object('begun',false,'reason','lease_lost'); END IF;
 UPDATE app_private.mhp_wa_owner_sends SET state='calling',updated_at=statement_timestamp() WHERE id=s.id;
 RETURN jsonb_build_object('begun',true);
END $f$;
REVOKE ALL ON FUNCTION app_private.mhp_wa_owner_catalogue_target(uuid,uuid),
 app_private.record_mhp_wa_owner_template(uuid,uuid,text,text,text,text,text,text,text[],text,text,bytea,boolean,text),
 app_private.claim_owner_whatsapp_job(uuid,uuid,bytea,integer),app_private.load_owner_whatsapp_job(uuid,uuid,bigint,bytea),
 app_private.begin_owner_whatsapp_call(uuid,uuid,bigint,bytea,boolean,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.mhp_wa_owner_catalogue_target(uuid,uuid),
 app_private.record_mhp_wa_owner_template(uuid,uuid,text,text,text,text,text,text,text[],text,text,bytea,boolean,text),
 app_private.claim_owner_whatsapp_job(uuid,uuid,bytea,integer),app_private.load_owner_whatsapp_job(uuid,uuid,bigint,bytea),
 app_private.begin_owner_whatsapp_call(uuid,uuid,bigint,bytea,boolean,boolean) TO r72_whatsapp_live_worker_command;

-- 10. Outcomes: every receipt on an owner job (worker settle, recovery, signed status), and every
-- state change of an owner in-window reply, updates the send, records restriction holds and writes
-- the activity on the original brand contact. A message is only ever 'accepted' on Meta's own answer.
CREATE FUNCTION app_private.mhp_wa_owner_apply(p_send uuid,p_event text,p_message_id text,p_code integer,p_occurred timestamptz) RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog AS $f$
DECLARE s app_private.mhp_wa_owner_sends%ROWTYPE; next text; rank_old integer; rank_new integer; policy record; subject text;
BEGIN
 SELECT * INTO s FROM app_private.mhp_wa_owner_sends x WHERE x.id=p_send FOR UPDATE;
 IF NOT FOUND THEN RETURN; END IF;
 rank_old:=CASE s.state WHEN 'queued' THEN 0 WHEN 'calling' THEN 1 WHEN 'outcome_unknown' THEN 2 WHEN 'accepted' THEN 3 WHEN 'sent' THEN 4
  WHEN 'delivered' THEN 5 WHEN 'read' THEN 6 ELSE 9 END;
 rank_new:=CASE p_event WHEN 'calling' THEN 1 WHEN 'outcome_unknown' THEN 2 WHEN 'accepted' THEN 3 WHEN 'sent' THEN 4 WHEN 'delivered' THEN 5 WHEN 'read' THEN 6
  WHEN 'failed' THEN 8 WHEN 'expired' THEN 8 ELSE NULL END;
 IF rank_new IS NULL THEN RETURN; END IF;
 next:=CASE WHEN p_event IN('failed','expired') AND s.state NOT IN('delivered','read','failed','expired','blocked') THEN p_event
  WHEN p_event NOT IN('failed','expired') AND rank_new>rank_old AND rank_old<9 THEN p_event ELSE s.state END;
 UPDATE app_private.mhp_wa_owner_sends SET state=next,provider_message_id=coalesce(s.provider_message_id,p_message_id),
  error_code=coalesce(p_code,s.error_code),updated_at=greatest(statement_timestamp(),s.updated_at) WHERE id=s.id;
 IF p_code IS NOT NULL THEN
  FOR policy IN SELECT * FROM app_private.mhp_wa_owner_hold_policy(p_code) LOOP
   INSERT INTO app_private.mhp_wa_owner_holds(workspace_id,binding_id,scope,recipient_sha256,error_code,reason,source_send_id,held_until)
   VALUES(s.workspace_id,s.binding_id,policy.scope,CASE policy.scope WHEN 'recipient' THEN s.recipient_sha256 END,p_code,policy.reason,s.id,
    statement_timestamp()+policy.duration) ON CONFLICT (source_send_id,error_code) DO NOTHING;
  END LOOP;
 END IF;
 -- 'calling' is not history; a late 'outcome_unknown' (status wait timed out) after Meta's acceptance changes nothing.
 IF p_event='calling' OR (p_event='outcome_unknown' AND rank_old BETWEEN 3 AND 6) THEN RETURN; END IF;
 subject:=CASE p_event WHEN 'accepted' THEN 'WhatsApp accepted by Meta (Martin Howard Property sender)'
  WHEN 'sent' THEN 'WhatsApp sent' WHEN 'delivered' THEN 'WhatsApp delivered' WHEN 'read' THEN 'WhatsApp read'
  WHEN 'failed' THEN 'WhatsApp failed'||coalesce(' (Meta error '||p_code::text||')','')
  WHEN 'outcome_unknown' THEN 'WhatsApp outcome unknown: not confirmed by Meta'
  WHEN 'expired' THEN 'WhatsApp not sent: it expired before the sender picked it up' END;
 PERFORM app_private.mhp_wa_owner_note(s.link_id,p_event,subject,NULL,jsonb_build_object('sendId',s.id,'kind',s.kind,'providerMessageId',coalesce(s.provider_message_id,p_message_id),
  'errorCode',p_code,'event',p_event),p_occurred);
END $f$;
REVOKE ALL ON FUNCTION app_private.mhp_wa_owner_apply(uuid,text,text,integer,timestamptz) FROM PUBLIC;

CREATE FUNCTION app_private.mhp_wa_owner_receipt_projection() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE send uuid;
BEGIN
 IF NEW.workspace_id<>'2789228d-55a6-4688-b1e8-2f70abca990b' OR NEW.event_kind='inbound_received' THEN RETURN NULL; END IF;
 IF NEW.job_id IS NOT NULL THEN
  SELECT j.owner_send_id INTO send FROM app.property_predator_whatsapp_live_jobs j WHERE j.workspace_id=NEW.workspace_id AND j.id=NEW.job_id AND j.authority_kind='mhp_owner_direct';
 ELSIF NEW.safe_code='mhp_wa_direct_status' AND NEW.provider_message_id IS NOT NULL THEN
  SELECT s.id INTO send FROM app_private.mhp_wa_owner_sends s WHERE s.kind='text' AND s.binding_id=NEW.binding_id
   AND s.provider_message_id=NEW.provider_message_id AND s.recipient_sha256=NEW.recipient_or_sender_sha256;
 END IF;
 IF send IS NULL THEN RETURN NULL; END IF;
 PERFORM app_private.mhp_wa_owner_apply(send,NEW.event_kind,NEW.provider_message_id,
  substring(NEW.safe_code FROM '^meta_error:([0-9]{1,9})$')::integer,NEW.provider_occurred_at);
 RETURN NULL;
END $f$;
REVOKE ALL ON FUNCTION app_private.mhp_wa_owner_receipt_projection() FROM PUBLIC;

CREATE FUNCTION app_private.mhp_wa_owner_reply_projection() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE send uuid;
BEGIN
 SELECT s.id INTO send FROM app_private.mhp_wa_owner_sends s WHERE s.direct_reply_id=NEW.id;
 IF send IS NULL THEN RETURN NULL; END IF;
 PERFORM app_private.mhp_wa_owner_apply(send,NEW.state,NEW.provider_id,NULL,coalesce(NEW.settled_at,NEW.began_at));
 RETURN NULL;
END $f$;
REVOKE ALL ON FUNCTION app_private.mhp_wa_owner_reply_projection() FROM PUBLIC;

-- Webhook: a signed 'failed' status may carry Meta's error code; record it (and any hold) on the send.
CREATE FUNCTION app_private.mhp_wa_owner_status_error(p_workspace_id uuid,p_binding_id uuid,p_provider_message_id text,p_recipient_sha256 bytea,p_error_code integer)
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE send uuid;
BEGIN
 IF session_user<>'r72_whatsapp_live_webhook_command' OR p_workspace_id IS DISTINCT FROM '2789228d-55a6-4688-b1e8-2f70abca990b'
  OR current_setting('app.workspace_id',true) IS DISTINCT FROM p_workspace_id::text OR current_setting('app.actor_kind',true) IS DISTINCT FROM 'webhook'
  OR coalesce(current_setting('app.user_id',true),'')<>'' OR p_provider_message_id IS NULL OR p_provider_message_id!~'^wamid[.][A-Za-z0-9_=-]{1,190}$'
  OR octet_length(p_recipient_sha256) IS DISTINCT FROM 32 OR p_error_code IS NULL OR p_error_code NOT BETWEEN 0 AND 999999999
 THEN RAISE EXCEPTION 'MHP owner WhatsApp status error denied' USING ERRCODE='42501'; END IF;
 SELECT s.id INTO send FROM app_private.mhp_wa_owner_sends s WHERE s.binding_id=p_binding_id AND s.provider_message_id=p_provider_message_id
  AND s.recipient_sha256=p_recipient_sha256 FOR UPDATE;
 IF send IS NULL THEN RETURN 'not_owner_send'; END IF;
 UPDATE app_private.mhp_wa_owner_sends SET error_code=p_error_code,updated_at=greatest(statement_timestamp(),updated_at) WHERE id=send;
 INSERT INTO app_private.mhp_wa_owner_holds(workspace_id,binding_id,scope,recipient_sha256,error_code,reason,source_send_id,held_until)
 SELECT p_workspace_id,s.binding_id,h.scope,CASE h.scope WHEN 'recipient' THEN s.recipient_sha256 END,p_error_code,h.reason,s.id,statement_timestamp()+h.duration
 FROM app_private.mhp_wa_owner_sends s CROSS JOIN app_private.mhp_wa_owner_hold_policy(p_error_code) h WHERE s.id=send
 ON CONFLICT (source_send_id,error_code) DO NOTHING;
 RETURN 'applied';
END $f$;
REVOKE ALL ON FUNCTION app_private.mhp_wa_owner_status_error(uuid,uuid,text,bytea,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.mhp_wa_owner_status_error(uuid,uuid,text,bytea,integer) TO r72_whatsapp_live_webhook_command;
RESET ROLE;

-- 11. Company-content provenance for the 0053 template row, and the outcome triggers.
SET LOCAL ROLE r72_owner;
GRANT INSERT ON app.company_content_items,app.company_content_versions,app.company_content_approval_requests,app.company_content_approval_decisions
 TO r72_whatsapp_live_definer;
DO $content$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['company_content_items','company_content_versions','company_content_approval_requests','company_content_approval_decisions'] LOOP
  EXECUTE format('CREATE POLICY mhp_wa_owner_meta_template ON app.%I FOR INSERT TO r72_whatsapp_live_definer
   WITH CHECK(workspace_id=''2789228d-55a6-4688-b1e8-2f70abca990b'' AND session_user=''r72_crm_command''
    AND current_setting(''app.actor_kind'',true)=''user'')',t);
 END LOOP;
END $content$;
CREATE TRIGGER mhp_wa_owner_receipt_projection AFTER INSERT ON app.property_predator_whatsapp_live_receipts
 FOR EACH ROW EXECUTE FUNCTION app_private.mhp_wa_owner_receipt_projection();
CREATE TRIGGER mhp_wa_owner_reply_projection AFTER UPDATE OF state ON app_private.mhp_wa_direct_replies
 FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state) EXECUTE FUNCTION app_private.mhp_wa_owner_reply_projection();
RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_whatsapp_live_definer;
