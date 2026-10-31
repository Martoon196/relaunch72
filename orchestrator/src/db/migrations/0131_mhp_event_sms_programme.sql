-- MHP009B source candidate: public webinar phone opt-in, then ONE owner review of
-- the exact current verified batch, enqueued through the unchanged 0056 rail.
-- Built without the ratified 009B SQL design file; see docs/mhp-event-sms-programme.md.
-- No change to message, approval, delivery, job, authority or compliance tables.
-- No owner context is created by any public or worker function.
SET LOCAL ROLE r72_owner;

CREATE TABLE app_private.mhp_event_sms_optins (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 -- NULL only for a decoy: a stored, never-texted row for an unknown or
 -- unsubscribed email, so every request is answered identically.
 prospect_id uuid REFERENCES app_private.mhp_prospects(id) ON DELETE CASCADE,
 signup_id uuid REFERENCES app_private.mhp_prospect_signups(id) ON DELETE CASCADE,
 email_sha256 bytea NOT NULL CHECK(octet_length(email_sha256)=32),
 campaign_key text NOT NULL CHECK(campaign_key ~ '^[a-z0-9_-]{1,60}$'),
 phone_e164 text NOT NULL CHECK(phone_e164 ~ '^\+447[0-9]{9}$'),
 consent_version text NOT NULL CHECK(consent_version='mhp.event-sms/v1'),
 consent_text_sha256 bytea NOT NULL CHECK(octet_length(consent_text_sha256)=32),
 source_hash bytea NOT NULL CHECK(octet_length(source_hash)=32),
 request_key_sha256 bytea NOT NULL UNIQUE CHECK(octet_length(request_key_sha256)=32),
 state text NOT NULL DEFAULT 'pending'
  CHECK(state IN('decoy','pending','claimed','armed','sent','verified','failed','needs_attention')),
 code_hash text,
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
 provider_message_sid text CHECK(provider_message_sid IS NULL OR provider_message_sid ~ '^SM[0-9a-f]{32}$'),
 created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 expires_at timestamptz NOT NULL DEFAULT statement_timestamp()+interval '15 minutes',
 claimed_at timestamptz,
 armed_at timestamptz,
 sent_at timestamptz,
 verified_at timestamptz,
 CHECK((state='decoy')=(prospect_id IS NULL)),
 CHECK((prospect_id IS NULL)=(signup_id IS NULL)),
 CHECK((state='verified')=(verified_at IS NOT NULL)),
 CHECK(state<>'verified' OR (provider_message_sid IS NOT NULL AND sent_at IS NOT NULL)),
 CHECK(state NOT IN('armed','sent','verified') OR code_hash IS NOT NULL)
);
CREATE INDEX mhp_event_sms_optins_pending ON app_private.mhp_event_sms_optins(created_at,id) WHERE state='pending';
CREATE INDEX mhp_event_sms_optins_verified ON app_private.mhp_event_sms_optins(campaign_key,prospect_id,verified_at DESC) WHERE state='verified';
CREATE INDEX mhp_event_sms_optins_phone ON app_private.mhp_event_sms_optins(phone_e164,created_at DESC);
CREATE INDEX mhp_event_sms_optins_person ON app_private.mhp_event_sms_optins(phone_e164,campaign_key,email_sha256,created_at DESC);
CREATE INDEX mhp_event_sms_optins_source ON app_private.mhp_event_sms_optins(source_hash,created_at DESC);
CREATE INDEX mhp_event_sms_optins_claimed ON app_private.mhp_event_sms_optins(claimed_at) WHERE claimed_at IS NOT NULL;

CREATE TABLE app_private.mhp_event_sms_batches (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL CHECK(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b'),
 command_receipt_id uuid NOT NULL UNIQUE,
 campaign_key text NOT NULL CHECK(campaign_key ~ '^[a-z0-9_-]{1,60}$'),
 content_version_id uuid NOT NULL,
 content_sha256 bytea NOT NULL CHECK(octet_length(content_sha256)=32),
 batch_sha256 bytea NOT NULL CHECK(octet_length(batch_sha256)=32),
 recipient_count integer NOT NULL CHECK(recipient_count BETWEEN 1 AND 10),
 segments_total integer NOT NULL CHECK(segments_total BETWEEN 1 AND 10),
 reviewed_by_user_id uuid NOT NULL,
 request_id text NOT NULL CHECK(length(request_id) BETWEEN 1 AND 128),
 created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 UNIQUE(workspace_id,id),
 FOREIGN KEY(workspace_id,command_receipt_id) REFERENCES app.command_receipts(workspace_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(workspace_id,reviewed_by_user_id) REFERENCES app.workspace_memberships(workspace_id,user_id) ON DELETE RESTRICT
);
CREATE TABLE app_private.mhp_event_sms_batch_recipients (
 batch_id uuid NOT NULL REFERENCES app_private.mhp_event_sms_batches(id) ON DELETE RESTRICT,
 optin_id uuid NOT NULL REFERENCES app_private.mhp_event_sms_optins(id) ON DELETE CASCADE,
 workspace_id uuid NOT NULL CHECK(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b'),
 content_version_id uuid NOT NULL,
 contact_id uuid NOT NULL,
 contact_point_id uuid NOT NULL,
 consent_event_id uuid NOT NULL,
 message_version_id uuid NOT NULL,
 job_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 PRIMARY KEY(batch_id,optin_id),
 UNIQUE(optin_id,content_version_id),
 FOREIGN KEY(workspace_id,contact_point_id,contact_id) REFERENCES app.contact_points(workspace_id,id,contact_id) ON DELETE RESTRICT,
 FOREIGN KEY(workspace_id,consent_event_id) REFERENCES app.communication_consent_events(workspace_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(workspace_id,job_id) REFERENCES app.property_predator_sms_jobs(workspace_id,id) ON DELETE RESTRICT
);
CREATE INDEX mhp_event_sms_batch_recipients_job ON app_private.mhp_event_sms_batch_recipients(workspace_id,job_id);

-- Batch evidence is append-only. Deletion stays possible only through the
-- opt-in's own erasure cascade, so a prospect erasure is never blocked.
CREATE FUNCTION app_private.mhp_event_sms_reject_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN RAISE EXCEPTION 'MHP event SMS batch evidence is append-only' USING ERRCODE='42501'; END $f$;
REVOKE ALL ON FUNCTION app_private.mhp_event_sms_reject_update() FROM PUBLIC;
CREATE TRIGGER mhp_event_sms_batches_immutable BEFORE UPDATE OR DELETE ON app_private.mhp_event_sms_batches
 FOR EACH ROW EXECUTE FUNCTION app_private.mhp_event_sms_reject_update();
CREATE TRIGGER mhp_event_sms_batch_recipients_immutable BEFORE UPDATE ON app_private.mhp_event_sms_batch_recipients
 FOR EACH ROW EXECUTE FUNCTION app_private.mhp_event_sms_reject_update();

DO $security$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['mhp_event_sms_optins','mhp_event_sms_batches','mhp_event_sms_batch_recipients'] LOOP
  EXECUTE format('ALTER TABLE app_private.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE app_private.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON app_private.%I FROM PUBLIC',t);
  EXECUTE format('CREATE POLICY mhp_event_sms_owner ON app_private.%I TO r72_owner USING(true) WITH CHECK(true)',t);
 END LOOP;
END $security$;
-- Public capture definer: opt-in rows only.
GRANT SELECT,INSERT,UPDATE ON app_private.mhp_event_sms_optins TO r72_mhp_prospect_definer;
CREATE POLICY mhp_event_sms_optins_prospect ON app_private.mhp_event_sms_optins TO r72_mhp_prospect_definer USING(true) WITH CHECK(true);
-- SMS definer: code worker state changes and batch evidence, MHP workspace only.
GRANT SELECT,UPDATE(state,code_hash,claimed_at,armed_at,sent_at,expires_at,provider_message_sid) ON app_private.mhp_event_sms_optins TO r72_sms_definer;
CREATE POLICY mhp_event_sms_optins_sms_read ON app_private.mhp_event_sms_optins FOR SELECT TO r72_sms_definer
 USING(current_setting('app.workspace_id',true)='2789228d-55a6-4688-b1e8-2f70abca990b');
CREATE POLICY mhp_event_sms_optins_sms_worker ON app_private.mhp_event_sms_optins FOR UPDATE TO r72_sms_definer
 USING(current_setting('app.workspace_id',true)='2789228d-55a6-4688-b1e8-2f70abca990b' AND current_setting('app.actor_kind',true)='worker' AND session_user='r72_sms_worker_command' AND state IN('pending','claimed','armed'))
 WITH CHECK(current_setting('app.workspace_id',true)='2789228d-55a6-4688-b1e8-2f70abca990b' AND state IN('claimed','armed','sent','failed','needs_attention'));
GRANT SELECT,INSERT ON app_private.mhp_event_sms_batches,app_private.mhp_event_sms_batch_recipients TO r72_sms_definer;
CREATE POLICY mhp_event_sms_batches_sms ON app_private.mhp_event_sms_batches TO r72_sms_definer
 USING(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND current_setting('app.actor_kind',true)='user' AND session_user='r72_sms_command')
 WITH CHECK(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND current_setting('app.actor_kind',true)='user' AND session_user='r72_sms_command'
  AND reviewed_by_user_id=nullif(current_setting('app.user_id',true),'')::uuid AND request_id=current_setting('app.request_id',true));
CREATE POLICY mhp_event_sms_batch_recipients_sms ON app_private.mhp_event_sms_batch_recipients TO r72_sms_definer
 USING(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND current_setting('app.actor_kind',true)='user' AND session_user='r72_sms_command')
 WITH CHECK(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND current_setting('app.actor_kind',true)='user' AND session_user='r72_sms_command');

-- Owner batch command receipts, mirroring the 0130 owned-test receipt policy.
CREATE POLICY mhp_event_sms_receipts ON app.command_receipts TO r72_sms_definer
 USING(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND command_name='mhp.sms.event-batch'
  AND actor_user_id=nullif(current_setting('app.user_id',true),'')::uuid)
 WITH CHECK(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND command_name='mhp.sms.event-batch'
  AND actor_user_id=nullif(current_setting('app.user_id',true),'')::uuid AND current_setting('app.actor_kind',true)='user' AND session_user='r72_sms_command');
-- The registrant's own consent, materialised during the owner's review. It is
-- recorded as a system record of the public opt-in, never as the owner's consent.
CREATE POLICY mhp_event_sms_public_consent ON app.communication_consent_events FOR INSERT TO r72_sms_definer
 WITH CHECK(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND current_setting('app.actor_kind',true)='user'
  AND session_user='r72_sms_command' AND channel='sms' AND purpose='marketing' AND state='granted' AND lawful_basis='consent'
  AND source='mhp.event-sms.public-optin' AND policy_version='mhp.event-sms/v1' AND actor_kind='system' AND actor_user_id IS NULL
  AND source_event_id ~ '^optin:[0-9a-f-]{36}$');

GRANT CREATE ON SCHEMA app_private TO r72_sms_definer,r72_mhp_prospect_definer;

SET LOCAL ROLE r72_mhp_prospect_definer;
-- Public step 1. Every request is stored and answered the same way, so the page
-- never reveals whether an email is registered: an unknown, unsubscribed or
-- clashing request becomes a 'decoy' row that is never texted and never verifies.
CREATE FUNCTION app_private.mhp_event_sms_optin_request(p_email text,p_phone text,p_campaign text,p_consent_version text,
 p_consent_text_sha256 bytea,p_source_hash bytea,p_request_key text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE
 consent_text constant text:='Yes, text me reminders about this Martin Howard Property webinar on this mobile. Only about this webinar. Reply STOP to any text to opt out.';
 key_sha bytea; email_sha bytea; existing app_private.mhp_event_sms_optins%ROWTYPE; prospect app_private.mhp_prospects%ROWTYPE;
 signup uuid; created uuid;
BEGIN
 IF session_user<>'r72_identity_command' OR p_email IS NULL OR p_email<>lower(btrim(p_email)) OR length(p_email) NOT BETWEEN 3 AND 320
  OR p_email!~'^[^[:space:]@<>]+@[^[:space:]@<>]+\.[^[:space:]@<>]+$'
  OR p_phone IS NULL OR p_phone!~'^\+447[0-9]{9}$' OR p_campaign IS NULL OR p_campaign!~'^[a-z0-9_-]{1,60}$'
  OR p_consent_version IS DISTINCT FROM 'mhp.event-sms/v1'
  OR p_consent_text_sha256 IS DISTINCT FROM public.digest(consent_text,'sha256')
  OR p_source_hash IS NULL OR octet_length(p_source_hash)<>32
  OR p_request_key IS NULL OR p_request_key!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 THEN RAISE EXCEPTION 'Invalid webinar text opt-in' USING ERRCODE='22023'; END IF;
 key_sha:=public.digest('mhp.event-sms.request:'||p_request_key,'sha256');
 email_sha:=public.digest('mhp.event-sms.email:'||p_email,'sha256');
 SELECT * INTO existing FROM app_private.mhp_event_sms_optins o WHERE o.request_key_sha256=key_sha;
 IF FOUND THEN RETURN jsonb_build_object('optinId',existing.id); END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('mhp.event-sms.phone:'||p_phone,7200131));
 SELECT * INTO existing FROM app_private.mhp_event_sms_optins o WHERE o.request_key_sha256=key_sha;
 IF FOUND THEN RETURN jsonb_build_object('optinId',existing.id); END IF;
 -- Limits count every stored row, decoys included, so they trip identically.
 IF (SELECT count(*) FROM app_private.mhp_event_sms_optins o WHERE o.phone_e164=p_phone AND o.created_at>statement_timestamp()-interval '24 hours')>=3
  OR (SELECT count(*) FROM app_private.mhp_event_sms_optins o WHERE o.source_hash=p_source_hash AND o.created_at>statement_timestamp()-interval '24 hours')>=5
  OR (SELECT count(*) FROM app_private.mhp_event_sms_optins o WHERE o.campaign_key=p_campaign AND o.created_at>statement_timestamp()-interval '24 hours')>=200
 THEN RAISE EXCEPTION 'Webinar text opt-in rate limit' USING ERRCODE='54000'; END IF;
 -- The same person and phone get the same row back, whether it is real or a decoy.
 SELECT * INTO existing FROM app_private.mhp_event_sms_optins o WHERE o.phone_e164=p_phone AND o.campaign_key=p_campaign AND o.email_sha256=email_sha
  AND (o.state='verified' OR o.expires_at>statement_timestamp())
 ORDER BY o.created_at DESC,o.id DESC LIMIT 1;
 IF FOUND THEN RETURN jsonb_build_object('optinId',existing.id); END IF;
 SELECT * INTO prospect FROM app_private.mhp_prospects p WHERE p.email::text=p_email AND p.unsubscribed_at IS NULL;
 IF FOUND THEN
  -- Same chronological campaign anchor as 0125 mhp_webinar_lead_candidates.
  SELECT s.id INTO signup FROM app_private.mhp_prospect_signups s
  WHERE s.prospect_id=prospect.id AND s.kind='webinar' AND s.created_at<=(
   SELECT min(m.created_at) FROM app_private.mhp_marketing_sends m WHERE m.prospect_id=prospect.id AND m.campaign_key=p_campaign
    AND m.template_key IN('webinar_confirm','webinar_24h','webinar_1h','webinar_replay','webinar_followup'))
  ORDER BY s.created_at DESC,s.id DESC LIMIT 1;
 END IF;
 -- A phone another registrant already holds (live or verified) is never texted again.
 IF signup IS NOT NULL AND EXISTS(SELECT 1 FROM app_private.mhp_event_sms_optins o WHERE o.phone_e164=p_phone AND o.campaign_key=p_campaign
   AND o.prospect_id IS DISTINCT FROM prospect.id AND o.state<>'decoy' AND (o.state='verified' OR o.expires_at>statement_timestamp()))
 THEN signup:=NULL; END IF;
 INSERT INTO app_private.mhp_event_sms_optins(prospect_id,signup_id,email_sha256,campaign_key,phone_e164,consent_version,consent_text_sha256,
  source_hash,request_key_sha256,state)
 VALUES(CASE WHEN signup IS NOT NULL THEN prospect.id END,signup,email_sha,p_campaign,p_phone,p_consent_version,p_consent_text_sha256,
  p_source_hash,key_sha,CASE WHEN signup IS NULL THEN 'decoy' ELSE 'pending' END) RETURNING id INTO created;
 RETURN jsonb_build_object('optinId',created);
END $f$;

-- Public step 2. Five attempts per row; a code is valid until 15 minutes after the
-- request. Real and decoy rows answer identically until a correct code is entered.
CREATE FUNCTION app_private.mhp_event_sms_optin_confirm(p_optin uuid,p_code text) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE o app_private.mhp_event_sms_optins%ROWTYPE; matched boolean;
BEGIN
 IF session_user<>'r72_identity_command' OR p_optin IS NULL OR p_code IS NULL OR p_code!~'^[0-9]{6}$'
 THEN RAISE EXCEPTION 'Invalid webinar text confirmation' USING ERRCODE='22023'; END IF;
 SELECT * INTO o FROM app_private.mhp_event_sms_optins x WHERE x.id=p_optin FOR UPDATE;
 IF NOT FOUND OR o.attempts>=5 OR (o.state<>'verified' AND o.expires_at<=statement_timestamp()) THEN RETURN 'unavailable'; END IF;
 matched:=o.state IN('sent','verified') AND public.crypt(p_code,o.code_hash)=o.code_hash;
 IF NOT matched THEN
  UPDATE app_private.mhp_event_sms_optins x SET attempts=x.attempts+1 WHERE x.id=o.id;
  RETURN CASE WHEN o.attempts+1>=5 THEN 'unavailable' ELSE 'retry' END;
 END IF;
 IF o.state='verified' THEN RETURN 'already'; END IF;
 UPDATE app_private.mhp_event_sms_optins x SET state='verified',verified_at=statement_timestamp() WHERE x.id=o.id;
 RETURN 'verified';
END $f$;

-- Internal: the latest verified opt-in per registrant for one campaign, with the
-- email the owner import used and how many distinct numbers they verified.
CREATE FUNCTION app_private.mhp_event_sms_verified_optins(p_campaign text)
RETURNS TABLE(optin_id uuid,prospect_id uuid,email text,first_name text,unsubscribed boolean,phone_e164 text,
 verified_at timestamptz,consent_text_sha256 bytea,provider_message_sid text,signup_id uuid,numbers integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT DISTINCT ON(o.prospect_id) o.id,o.prospect_id,p.email::text,p.first_name,p.unsubscribed_at IS NOT NULL,o.phone_e164,
  o.verified_at,o.consent_text_sha256,o.provider_message_sid,o.signup_id,
  (SELECT count(DISTINCT x.phone_e164)::integer FROM app_private.mhp_event_sms_optins x WHERE x.prospect_id=o.prospect_id
    AND x.campaign_key=o.campaign_key AND x.state='verified')
 FROM app_private.mhp_event_sms_optins o JOIN app_private.mhp_prospects p ON p.id=o.prospect_id
 WHERE o.campaign_key=p_campaign AND o.state='verified' AND session_user='r72_sms_command'
 ORDER BY o.prospect_id,o.verified_at DESC,o.id DESC
$f$;
REVOKE ALL ON FUNCTION app_private.mhp_event_sms_optin_request(text,text,text,text,bytea,bytea,text),
 app_private.mhp_event_sms_optin_confirm(uuid,text),app_private.mhp_event_sms_verified_optins(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.mhp_event_sms_optin_request(text,text,text,text,bytea,bytea,text),
 app_private.mhp_event_sms_optin_confirm(uuid,text) TO r72_identity_command;
GRANT EXECUTE ON FUNCTION app_private.mhp_event_sms_verified_optins(text) TO r72_sms_definer;

SET LOCAL ROLE r72_sms_definer;
-- Internal: a STOP on ANY contact point holding this number, including deleted,
-- shared or quarantined ones, suppresses it here forever.
CREATE FUNCTION app_private.mhp_event_sms_phone_suppressed(p_phone text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT EXISTS(SELECT 1 FROM app.contact_points p
  WHERE p.workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND p.kind='phone' AND p.normalized_value=p_phone
   AND EXISTS(SELECT 1 FROM (SELECT DISTINCT ON(coalesce(s.purpose,'')) s.state FROM app.communication_suppression_events s
     WHERE s.workspace_id=p.workspace_id AND s.contact_point_id=p.id AND s.channel='sms' AND (s.purpose IS NULL OR s.purpose='marketing')
     ORDER BY coalesce(s.purpose,''),s.occurred_at DESC,s.recorded_at DESC,s.id DESC) l WHERE l.state='suppressed'))
$f$;

-- Internal: segments used on the connection today and this month, counting both
-- rail jobs and verification codes, so the founder's 10/day and 50/month caps
-- cover every text on the number.
CREATE FUNCTION app_private.mhp_event_sms_usage(p_connection uuid)
RETURNS TABLE(day_used integer,month_used integer,codes_today integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 WITH day AS (SELECT (statement_timestamp() AT TIME ZONE 'UTC')::date AS d,
  date_trunc('month',statement_timestamp() AT TIME ZONE 'UTC')::date AS m),
 jobs AS (SELECT coalesce(sum(j.segment_count) FILTER(WHERE j.utc_day=day.d),0)::integer AS d,coalesce(sum(j.segment_count),0)::integer AS m
  FROM day LEFT JOIN app.property_predator_sms_jobs j ON j.workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b'
   AND j.provider_connection_id=p_connection AND j.utc_month=day.m AND j.state<>'cancelled'),
 codes AS (SELECT count(*) FILTER(WHERE (o.claimed_at AT TIME ZONE 'UTC')::date=day.d)::integer AS d,count(o.id)::integer AS m
  FROM day LEFT JOIN app_private.mhp_event_sms_optins o ON o.claimed_at IS NOT NULL
   AND date_trunc('month',o.claimed_at AT TIME ZONE 'UTC')::date=day.m)
 SELECT jobs.d+codes.d,jobs.m+codes.m,codes.d FROM jobs,codes
$f$;

-- Worker: claim one pending code. Codes share the rail's per-connection lock and
-- caps, have their own budget of 5 per UTC day, 3 per phone and 3 per person per
-- day, never go to a suppressed number, and stale claims fail closed.
CREATE FUNCTION app_private.mhp_event_sms_code_claim(p_workspace uuid,p_connection uuid)
RETURNS TABLE(optin_id uuid,phone_e164 text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE selected app_private.mhp_event_sms_optins%ROWTYPE; day_start timestamptz; used record;
BEGIN
 IF session_user<>'r72_sms_worker_command' OR p_workspace IS DISTINCT FROM '2789228d-55a6-4688-b1e8-2f70abca990b'
  OR current_setting('app.workspace_id',true) IS DISTINCT FROM p_workspace::text
  OR current_setting('app.actor_kind',true) IS DISTINCT FROM 'worker' OR coalesce(current_setting('app.user_id',true),'')<>''
  OR NOT EXISTS(SELECT 1 FROM app.provider_connections pc WHERE pc.workspace_id=p_workspace AND pc.id=p_connection
   AND pc.provider_id='twilio_messaging' AND pc.provider_kind='sms' AND pc.environment='live' AND pc.status='active')
 THEN RAISE EXCEPTION 'MHP event SMS code claim denied' USING ERRCODE='42501'; END IF;
 -- The same lock 0056 takes for idempotency and caps on this exact connection.
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(format('pp-sms:%s:%s',p_workspace,p_connection),0));
 UPDATE app_private.mhp_event_sms_optins o SET state='failed'
 WHERE o.state='claimed' AND o.claimed_at<=statement_timestamp()-interval '2 minutes';
 UPDATE app_private.mhp_event_sms_optins o SET state='needs_attention'
 WHERE o.state='armed' AND o.armed_at<=statement_timestamp()-interval '2 minutes';
 UPDATE app_private.mhp_event_sms_optins o SET state='failed'
 WHERE o.state='pending' AND app_private.mhp_event_sms_phone_suppressed(o.phone_e164);
 SELECT * INTO used FROM app_private.mhp_event_sms_usage(p_connection);
 IF used.codes_today>=5 OR used.day_used>=10 OR used.month_used>=50 THEN RETURN; END IF;
 day_start:=date_trunc('day',statement_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
 SELECT o.* INTO selected FROM app_private.mhp_event_sms_optins o
 WHERE o.state='pending' AND o.expires_at>statement_timestamp()+interval '1 minute'
  AND (SELECT count(*) FROM app_private.mhp_event_sms_optins s WHERE s.phone_e164=o.phone_e164 AND s.claimed_at>=day_start)<3
  AND (SELECT count(*) FROM app_private.mhp_event_sms_optins s WHERE s.prospect_id=o.prospect_id AND s.claimed_at>=day_start)<3
 ORDER BY o.created_at,o.id LIMIT 1 FOR UPDATE SKIP LOCKED;
 IF NOT FOUND THEN RETURN; END IF;
 UPDATE app_private.mhp_event_sms_optins o SET state='claimed',claimed_at=statement_timestamp() WHERE o.id=selected.id;
 RETURN QUERY SELECT selected.id,selected.phone_e164;
END $f$;

CREATE FUNCTION app_private.mhp_event_sms_code_arm(p_workspace uuid,p_optin uuid,p_code text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE changed integer;
BEGIN
 IF session_user<>'r72_sms_worker_command' OR p_workspace IS DISTINCT FROM '2789228d-55a6-4688-b1e8-2f70abca990b'
  OR current_setting('app.workspace_id',true) IS DISTINCT FROM p_workspace::text
  OR current_setting('app.actor_kind',true) IS DISTINCT FROM 'worker' OR p_code IS NULL OR p_code!~'^[0-9]{6}$'
 THEN RAISE EXCEPTION 'MHP event SMS code arm denied' USING ERRCODE='42501'; END IF;
 -- Expiry stays fixed at request time so real and decoy rows expire alike.
 UPDATE app_private.mhp_event_sms_optins o SET code_hash=public.crypt(p_code,public.gen_salt('bf',12)),state='armed',armed_at=statement_timestamp()
 WHERE o.id=p_optin AND o.state='claimed' AND o.claimed_at>statement_timestamp()-interval '1 minute' AND o.expires_at>statement_timestamp();
 GET DIAGNOSTICS changed=ROW_COUNT; RETURN changed=1;
END $f$;

CREATE FUNCTION app_private.mhp_event_sms_code_settle(p_workspace uuid,p_optin uuid,p_state text,p_provider_sid text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE changed integer;
BEGIN
 IF session_user<>'r72_sms_worker_command' OR p_workspace IS DISTINCT FROM '2789228d-55a6-4688-b1e8-2f70abca990b'
  OR current_setting('app.workspace_id',true) IS DISTINCT FROM p_workspace::text
  OR current_setting('app.actor_kind',true) IS DISTINCT FROM 'worker'
  OR p_state IS NULL OR p_state NOT IN('sent','failed','needs_attention')
  OR (p_state='sent' AND (p_provider_sid IS NULL OR p_provider_sid!~'^SM[0-9a-f]{32}$'))
  OR (p_state<>'sent' AND p_provider_sid IS NOT NULL)
 THEN RAISE EXCEPTION 'MHP event SMS code settle denied' USING ERRCODE='42501'; END IF;
 UPDATE app_private.mhp_event_sms_optins o SET state=p_state,provider_message_sid=p_provider_sid,
  sent_at=CASE WHEN p_state='sent' THEN statement_timestamp() ELSE NULL END
 WHERE o.id=p_optin AND o.state='armed';
 GET DIAGNOSTICS changed=ROW_COUNT; RETURN changed=1;
END $f$;

-- Internal: one status per registrant. Only 'ready' rows can ever be sent.
CREATE FUNCTION app_private.mhp_event_sms_batch_candidates(p_campaign text,p_content_version uuid)
RETURNS TABLE(optin_id uuid,prospect_id uuid,email text,first_name text,phone_e164 text,verified_at timestamptz,
 consent_text_sha256 bytea,provider_message_sid text,contact_id uuid,point_id uuid,point_verified boolean,status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 WITH v AS (SELECT * FROM app_private.mhp_event_sms_verified_optins(p_campaign)),
 shared AS (SELECT v.phone_e164 FROM v GROUP BY v.phone_e164 HAVING count(*)>1),
 c AS (
  SELECT v.*,contact.ids,contact.n,point.id AS pid,point.contact_id AS pcontact,point.is_verified AS pverified,
   EXISTS(SELECT 1 FROM app.contact_points q WHERE q.workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND q.kind='phone'
    AND q.normalized_value=v.phone_e164 AND q.deleted_at IS NULL AND q.dedupe_state<>'normal') AS irregular
  FROM v
  CROSS JOIN LATERAL (SELECT array_agg(DISTINCT e.contact_id) AS ids,count(DISTINCT e.contact_id) AS n
   FROM app.contact_points e JOIN app.contacts k ON k.workspace_id=e.workspace_id AND k.id=e.contact_id AND k.deleted_at IS NULL
   WHERE e.workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND e.kind='email' AND lower(e.normalized_value)=v.email
    AND e.deleted_at IS NULL AND e.dedupe_state='normal') contact
  LEFT JOIN app.contact_points point ON point.workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND point.kind='phone'
   AND point.normalized_value=v.phone_e164 AND point.deleted_at IS NULL AND point.dedupe_state='normal'
 )
 SELECT c.optin_id,c.prospect_id,c.email,c.first_name,c.phone_e164,c.verified_at,c.consent_text_sha256,c.provider_message_sid,
  CASE WHEN c.n=1 THEN c.ids[1] END,c.pid,coalesce(c.pverified,false),
  CASE
   WHEN app_private.mhp_event_sms_phone_suppressed(c.phone_e164) THEN 'opted_out'
   WHEN c.unsubscribed THEN 'email_unsubscribed'
   WHEN EXISTS(SELECT 1 FROM app_private.mhp_event_sms_batch_recipients r JOIN app_private.mhp_event_sms_optins o ON o.id=r.optin_id
     WHERE o.prospect_id=c.prospect_id AND r.content_version_id=p_content_version) THEN 'already_sent'
   WHEN c.numbers>1 THEN 'multiple_numbers'
   WHEN c.phone_e164 IN(SELECT s.phone_e164 FROM shared s) OR c.irregular THEN 'phone_shared'
   WHEN c.n=0 THEN 'needs_import'
   WHEN c.n>1 THEN 'contact_ambiguous'
   WHEN c.pid IS NOT NULL AND c.pcontact<>c.ids[1] THEN 'phone_shared'
   WHEN c.pid IS NOT NULL AND EXISTS(SELECT 1 FROM (SELECT e.source,e.source_event_id,e.occurred_at FROM app.communication_consent_events e
     WHERE e.workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND e.contact_point_id=c.pid AND e.channel='sms' AND e.purpose='marketing'
     ORDER BY e.occurred_at DESC,e.recorded_at DESC,e.id DESC LIMIT 1) l
     WHERE NOT(l.source='mhp.event-sms.public-optin' AND l.source_event_id='optin:'||c.optin_id::text) AND l.occurred_at>=c.verified_at) THEN 'consent_changed'
   ELSE 'ready' END
 FROM c
$f$;

-- Internal: the exact ready set, captured once and used for both the hash and
-- the send, so the owner's review binds the set and not merely its size.
CREATE FUNCTION app_private.mhp_event_sms_ready_set(p_campaign text,p_content_version uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT coalesce(jsonb_agg(jsonb_build_object('optinId',c.optin_id,'contactId',c.contact_id,'pointId',c.point_id,'pointVerified',c.point_verified,
   'phone',c.phone_e164,'verifiedAt',c.verified_at,'consentTextSha256',pg_catalog.encode(c.consent_text_sha256,'hex'),
   'codeMessageSid',c.provider_message_sid) ORDER BY c.optin_id),'[]'::jsonb)
 FROM app_private.mhp_event_sms_batch_candidates(p_campaign,p_content_version) c WHERE c.status='ready'
$f$;
CREATE FUNCTION app_private.mhp_event_sms_digest_of(p_campaign text,p_content_version uuid,p_content_sha bytea,p_ready jsonb) RETURNS bytea
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT public.digest(pg_catalog.concat_ws(pg_catalog.chr(31),'mhp.event-sms.batch/v1',p_campaign,p_content_version::text,
  pg_catalog.encode(p_content_sha,'hex'),coalesce((SELECT string_agg((r->>'optinId')||':'||(r->>'contactId')||':'
   ||pg_catalog.encode(public.digest(r->>'phone','sha256'),'hex'),',' ORDER BY r->>'optinId') FROM jsonb_array_elements(p_ready) r),'')),'sha256')
$f$;

CREATE FUNCTION app_private.mhp_event_sms_batch_snapshot(p_session bytea,p_campaign text,p_content_version uuid,p_content_sha bytea) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE ws constant uuid:='2789228d-55a6-4688-b1e8-2f70abca990b'; actor uuid; binding app.property_predator_sms_bindings%ROWTYPE;
 recipients jsonb; ready jsonb; day_used integer:=0; month_used integer:=0; batches jsonb;
BEGIN
 actor:=app_private.mhp_owner_email_authorize(p_session);
 IF session_user<>'r72_sms_command' OR current_setting('app.workspace_id',true) IS DISTINCT FROM ws::text
  OR current_setting('app.actor_kind',true) IS DISTINCT FROM 'user' OR current_setting('app.user_id',true) IS DISTINCT FROM actor::text
  OR p_campaign IS NULL OR p_campaign!~'^[a-z0-9_-]{1,60}$' OR (p_content_version IS NULL)<>(p_content_sha IS NULL)
  OR (p_content_sha IS NOT NULL AND octet_length(p_content_sha)<>32)
 THEN RAISE EXCEPTION 'MHP event SMS owner session required' USING ERRCODE='42501'; END IF;
 SELECT b.* INTO binding FROM app.property_predator_sms_bindings b WHERE b.workspace_id=ws AND b.status='active'
  AND b.sender_number='+447861935832'
  AND NOT EXISTS(SELECT 1 FROM app.property_predator_sms_binding_revocations r WHERE r.workspace_id=b.workspace_id AND r.binding_id=b.id)
 ORDER BY b.created_at DESC LIMIT 1;
 IF binding.id IS NOT NULL THEN
  SELECT u.day_used,u.month_used INTO day_used,month_used FROM app_private.mhp_event_sms_usage(binding.provider_connection_id) u;
 END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('optinId',c.optin_id,'email',c.email,'firstName',c.first_name,
   'phoneLast4',right(c.phone_e164,4),'verifiedAt',to_char(c.verified_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
   'status',c.status) ORDER BY c.status<>'ready',c.verified_at,c.optin_id),'[]'::jsonb) INTO recipients
 FROM app_private.mhp_event_sms_batch_candidates(p_campaign,p_content_version) c;
 ready:=app_private.mhp_event_sms_ready_set(p_campaign,p_content_version);
 SELECT coalesce(jsonb_agg(x.item ORDER BY x.created_at DESC),'[]'::jsonb) INTO batches FROM (
  SELECT b.created_at,jsonb_build_object('batchId',b.id,'contentVersionId',b.content_version_id,'recipientCount',b.recipient_count,
   'createdAt',to_char(b.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
   'jobStates',(SELECT coalesce(jsonb_object_agg(s.state,s.n),'{}'::jsonb) FROM (SELECT j.state,count(*) AS n
     FROM app_private.mhp_event_sms_batch_recipients r JOIN app.property_predator_sms_jobs j ON j.workspace_id=r.workspace_id AND j.id=r.job_id
     WHERE r.batch_id=b.id GROUP BY j.state) s)) AS item
  FROM app_private.mhp_event_sms_batches b WHERE b.workspace_id=ws AND b.campaign_key=p_campaign ORDER BY b.created_at DESC LIMIT 5) x;
 RETURN jsonb_build_object('campaign',p_campaign,'bindingReady',binding.id IS NOT NULL,'recipients',recipients,'readyCount',jsonb_array_length(ready),
  'batchSha256',CASE WHEN p_content_version IS NOT NULL AND jsonb_array_length(ready)>0
   THEN pg_catalog.encode(app_private.mhp_event_sms_digest_of(p_campaign,p_content_version,p_content_sha,ready),'hex') END,
  'daySegmentsUsed',day_used,'monthSegmentsUsed',month_used,'batches',batches);
END $f$;

-- The owner's ONE review action over the exact current ready set. Everything
-- below runs in the owner's live session; each recipient follows the ratified
-- 0130 owned-send chain and the unchanged 0056 enqueue.
CREATE FUNCTION app_private.mhp_event_sms_batch_send(p_session bytea,p_command uuid,p_campaign text,p_content_version uuid,
 p_content_sha256 bytea,p_batch_sha256 bytea,p_confirmed boolean,p_lookup_only boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE
 ws constant uuid:='2789228d-55a6-4688-b1e8-2f70abca990b'; actor uuid; request text:=current_setting('app.request_id',true);
 review_version constant text:='mhp.event-sms-batch/v1';
 review_authority constant text:='mhp.founder-operator-review-not-legal-advice';
 payload bytea; prior app.command_receipts%ROWTYPE; exact jsonb; binding app.property_predator_sms_bindings%ROWTYPE;
 body text; body_sha bytea; segments integer; recipients integer; used record; ready jsonb;
 prepared timestamptz; expiry timestamptz; inbox uuid; batch uuid:=gen_random_uuid(); command_receipt uuid:=gen_random_uuid();
 r record; point uuid; consent uuid; consent_sha bytea; endpoint_sha bytea; point_row app.contact_points%ROWTYPE; latest uuid;
 conversation uuid; message uuid; version uuid; approval_request uuid; approval uuid;
 subject uuid; pack uuid; legal uuid; commercial uuid; publication uuid; sender_route uuid; instigator_route uuid; permission_use uuid;
 operation uuid; delivery uuid; correlation uuid; facts jsonb; facts_sha bytea; scope bytea; nonce bytea; request_sha bytea;
 queued record; jobs jsonb:='[]'::jsonb; outcome jsonb;
BEGIN
 actor:=app_private.mhp_owner_email_authorize(p_session);
 IF session_user<>'r72_sms_command' OR current_setting('app.workspace_id',true) IS DISTINCT FROM ws::text
  OR current_setting('app.actor_kind',true) IS DISTINCT FROM 'user' OR current_setting('app.user_id',true) IS DISTINCT FROM actor::text
  OR request IS NULL OR length(request) NOT BETWEEN 1 AND 128 OR p_command IS NULL
  OR p_campaign IS NULL OR p_campaign!~'^[a-z0-9_-]{1,60}$' OR p_content_version IS NULL
  OR p_content_sha256 IS NULL OR octet_length(p_content_sha256)<>32 OR p_batch_sha256 IS NULL OR octet_length(p_batch_sha256)<>32
  OR p_confirmed IS DISTINCT FROM true OR p_lookup_only IS NULL
 THEN RAISE EXCEPTION 'MHP event SMS batch denied' USING ERRCODE='42501'; END IF;
 payload:=public.digest(jsonb_build_object('schema',review_version,'workspace',ws,'actor',actor,'campaign',p_campaign,
  'contentVersion',p_content_version,'contentSha256',encode(p_content_sha256,'hex'),'batchSha256',encode(p_batch_sha256,'hex'),
  'confirmed',p_confirmed)::text,'sha256');
 SELECT * INTO prior FROM app.command_receipts c WHERE c.workspace_id=ws AND c.actor_user_id=actor AND c.command_name='mhp.sms.event-batch' AND c.idempotency_key=p_command::text;
 IF FOUND THEN
  IF prior.payload_hash IS DISTINCT FROM payload OR prior.status<>'succeeded' THEN RAISE EXCEPTION 'Event SMS batch replay conflicts' USING ERRCODE='40001'; END IF;
  RETURN prior.result||jsonb_build_object('replayed',true);
 END IF;
 IF p_lookup_only THEN RETURN jsonb_build_object('not_started',true); END IF;
 IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed'
 THEN RAISE EXCEPTION 'New event SMS batch requires read committed' USING ERRCODE='25000'; END IF;
 exact:=app_private.mhp_owned_sms_content(p_content_version,p_content_sha256);
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('company-content:'||ws::text||':'||(exact->>'contentItemId'),7200021));
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('mhp.sms.event-batch:'||ws::text||':'||p_campaign,7200131));
 SELECT * INTO prior FROM app.command_receipts c WHERE c.workspace_id=ws AND c.actor_user_id=actor AND c.command_name='mhp.sms.event-batch' AND c.idempotency_key=p_command::text;
 IF FOUND THEN
  IF prior.payload_hash IS DISTINCT FROM payload OR prior.status<>'succeeded' THEN RAISE EXCEPTION 'Event SMS batch replay conflicts' USING ERRCODE='40001'; END IF;
  RETURN prior.result||jsonb_build_object('replayed',true);
 END IF;
 exact:=app_private.mhp_owned_sms_content(p_content_version,p_content_sha256);
 body:=exact->>'bodyText';
 IF position('STOP' IN body)=0 THEN RAISE EXCEPTION 'Event SMS text must tell recipients to reply STOP' USING ERRCODE='23514'; END IF;
 SELECT b.* INTO binding FROM app.property_predator_sms_bindings b JOIN app.provider_connections pc ON pc.workspace_id=b.workspace_id AND pc.id=b.provider_connection_id
 JOIN app.channel_endpoints ce ON ce.workspace_id=b.workspace_id AND ce.id=b.channel_endpoint_id AND ce.provider_connection_id=pc.id
 WHERE b.workspace_id=ws AND b.status='active' AND b.sender_number='+447861935832'
  AND pc.provider_id='twilio_messaging' AND pc.provider_kind='sms' AND pc.environment='live' AND pc.status='active'
  AND ce.channel='sms' AND ce.environment='live' AND ce.status='active' AND ce.normalized_address=b.sender_number
  AND NOT EXISTS(SELECT 1 FROM app.property_predator_sms_binding_revocations x WHERE x.workspace_id=b.workspace_id AND x.binding_id=b.id)
 ORDER BY b.created_at DESC LIMIT 1;
 IF binding.id IS NULL THEN RAISE EXCEPTION 'Actual MHP SMS binding required' USING ERRCODE='42501'; END IF;
 -- Serialise with code claims and every 0056 enqueue on this exact connection,
 -- then capture the ready set ONCE: the hash check and the loop use this value.
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(format('pp-sms:%s:%s',ws,binding.provider_connection_id),0));
 ready:=app_private.mhp_event_sms_ready_set(p_campaign,p_content_version);
 IF app_private.mhp_event_sms_digest_of(p_campaign,p_content_version,p_content_sha256,ready) IS DISTINCT FROM p_batch_sha256
 THEN RAISE EXCEPTION 'The reviewed batch changed' USING ERRCODE='40001'; END IF;
 recipients:=jsonb_array_length(ready);
 IF recipients=0 THEN RAISE EXCEPTION 'No ready recipients' USING ERRCODE='23514'; END IF;
 segments:=CASE WHEN char_length(body)<=160 THEN 1 ELSE ceil(char_length(body)/153.0)::integer END;
 SELECT * INTO used FROM app_private.mhp_event_sms_usage(binding.provider_connection_id);
 IF recipients*segments>10 OR used.day_used+recipients*segments>10 OR used.month_used+recipients*segments>50
 THEN RAISE EXCEPTION 'Event SMS batch exceeds the remaining segment allowance' USING ERRCODE='54000'; END IF;
 prepared:=date_trunc('milliseconds',statement_timestamp()); expiry:=prepared+interval '4 minutes'; body_sha:=public.digest(body,'sha256');
 INSERT INTO app.command_receipts(id,workspace_id,command_name,idempotency_key,request_id,actor_user_id,payload_hash)
 VALUES(command_receipt,ws,'mhp.sms.event-batch',p_command::text,request,actor,payload);
 INSERT INTO app_private.mhp_event_sms_batches(id,workspace_id,command_receipt_id,campaign_key,content_version_id,content_sha256,batch_sha256,
  recipient_count,segments_total,reviewed_by_user_id,request_id)
 VALUES(batch,ws,command_receipt,p_campaign,p_content_version,p_content_sha256,p_batch_sha256,recipients,recipients*segments,actor,request);
 INSERT INTO app.inboxes(workspace_id,channel_endpoint_id,provider_connection_id,channel,environment,name)
 VALUES(ws,binding.channel_endpoint_id,binding.provider_connection_id,'sms','live','Martin Howard Property texts')
 ON CONFLICT(workspace_id,channel_endpoint_id) DO NOTHING;
 SELECT i.id INTO inbox FROM app.inboxes i WHERE i.workspace_id=ws AND i.channel_endpoint_id=binding.channel_endpoint_id AND i.status='active';
 IF inbox IS NULL THEN RAISE EXCEPTION 'MHP SMS inbox unavailable' USING ERRCODE='23514'; END IF;

 FOR r IN SELECT * FROM jsonb_to_recordset(ready) AS x("optinId" uuid,"contactId" uuid,"pointId" uuid,"pointVerified" boolean,
   phone text,"verifiedAt" timestamptz,"consentTextSha256" text,"codeMessageSid" text) LOOP
  IF app_private.mhp_event_sms_phone_suppressed(r.phone) THEN RAISE EXCEPTION 'An opt-out arrived during review' USING ERRCODE='40001'; END IF;
  consent_sha:=decode(r."consentTextSha256",'hex');
  point:=r."pointId";
  IF point IS NULL THEN
   INSERT INTO app.contact_points(workspace_id,contact_id,kind,label,value,normalized_value,is_primary,is_verified,consent_status)
   VALUES(ws,r."contactId",'phone','MHP webinar texts',r.phone,r.phone,false,false,'unknown') RETURNING id INTO point;
  END IF;
  IF NOT r."pointVerified" THEN
   UPDATE app.contact_points p SET is_verified=true,row_version=p.row_version+1,updated_at=statement_timestamp()
   WHERE p.workspace_id=ws AND p.id=point AND p.contact_id=r."contactId" AND p.kind='phone' AND p.normalized_value=r.phone AND NOT p.is_verified;
  END IF;
  point_row:=NULL;
  SELECT p.* INTO point_row FROM app.contact_points p WHERE p.workspace_id=ws AND p.id=point AND p.contact_id=r."contactId"
   AND p.kind='phone' AND p.is_verified AND p.deleted_at IS NULL AND p.dedupe_state='normal' AND p.normalized_value=r.phone;
  IF point_row.id IS NULL THEN RAISE EXCEPTION 'Event SMS phone point changed' USING ERRCODE='40001'; END IF;
  endpoint_sha:=public.digest(point_row.kind||chr(31)||point_row.value||chr(31)||point_row.normalized_value,'sha256');
  consent:=NULL;
  SELECT e.id INTO consent FROM app.communication_consent_events e WHERE e.workspace_id=ws AND e.contact_point_id=point
   AND e.source='mhp.event-sms.public-optin' AND e.source_event_id='optin:'||r."optinId"::text AND e.channel='sms' AND e.purpose='marketing';
  IF consent IS NULL THEN
   consent:=gen_random_uuid();
   INSERT INTO app.communication_consent_events(id,workspace_id,contact_id,contact_point_id,channel,purpose,state,lawful_basis,source,policy_version,
    policy_text_sha256,source_event_id,actor_kind,actor_user_id,evidence,endpoint_identity_sha256,occurred_at)
   VALUES(consent,ws,r."contactId",point,'sms','marketing','granted','consent','mhp.event-sms.public-optin','mhp.event-sms/v1',
    consent_sha,'optin:'||r."optinId"::text,'system',NULL,jsonb_build_object('schema','mhp.event-sms.optin-evidence/v1',
     'optinId',r."optinId",'campaign',p_campaign,'consentGivenBy','registrant','possessionVerified',true,'emailOwnershipProven',false,
     'codeMessageSid',r."codeMessageSid",'verifiedAt',r."verifiedAt",'scope','this webinar only',
     'recordedDuringOwnerReview',jsonb_build_object('owner',actor,'request',request,'batch',batch)),endpoint_sha,r."verifiedAt");
  END IF;
  SELECT e.id INTO latest FROM app.communication_consent_events e WHERE e.workspace_id=ws AND e.contact_point_id=point AND e.channel='sms' AND e.purpose='marketing'
  ORDER BY e.occurred_at DESC,e.recorded_at DESC,e.id DESC LIMIT 1;
  IF latest IS DISTINCT FROM consent THEN RAISE EXCEPTION 'Event SMS consent changed' USING ERRCODE='40001'; END IF;
  conversation:=NULL;
  INSERT INTO app.conversations(workspace_id,inbox_id,channel,environment,contact_id,assigned_user_id,subject)
  VALUES(ws,inbox,'sms','live',r."contactId",actor,'Martin Howard Property webinar texts')
  ON CONFLICT(workspace_id,inbox_id,contact_id) WHERE contact_id IS NOT NULL AND state IN('open','snoozed') DO NOTHING;
  SELECT c.id INTO conversation FROM app.conversations c WHERE c.workspace_id=ws AND c.inbox_id=inbox AND c.contact_id=r."contactId" AND c.state IN('open','snoozed');
  message:=gen_random_uuid(); version:=gen_random_uuid(); approval_request:=gen_random_uuid(); approval:=gen_random_uuid();
  subject:=gen_random_uuid(); pack:=gen_random_uuid(); legal:=gen_random_uuid(); commercial:=gen_random_uuid(); publication:=gen_random_uuid();
  sender_route:=gen_random_uuid(); instigator_route:=gen_random_uuid(); permission_use:=gen_random_uuid();
  operation:=gen_random_uuid(); delivery:=gen_random_uuid(); correlation:=gen_random_uuid();
  INSERT INTO app.messages(id,workspace_id,conversation_id,contact_id,contact_point_id,channel,environment,direction,lifecycle,source_kind,
   current_version_id,current_version_number,current_body_sha256,created_by_actor_kind,created_by_user_id,occurred_at)
  VALUES(message,ws,conversation,r."contactId",point,'sms','live','outbound','draft','user',version,1,body_sha,'user',actor,prepared);
  INSERT INTO app.message_versions(id,workspace_id,conversation_id,message_id,channel,environment,version_number,body_text,
   source_content_version_ref,source_content_sha256,source_content_approval_ref,created_by_actor_kind,created_by_user_id,created_request_id)
  VALUES(version,ws,conversation,message,'sms','live',1,body,p_content_version::text,p_content_sha256,exact->>'approvalId','user',actor,request);
  IF NOT EXISTS(SELECT 1 FROM app.message_versions v WHERE v.workspace_id=ws AND v.id=version AND v.body_sha256=body_sha)
  THEN RAISE EXCEPTION 'Generated SMS body digest mismatch' USING ERRCODE='23514'; END IF;
  INSERT INTO app.message_approval_requests(id,workspace_id,conversation_id,message_id,message_version_id,version_number,body_sha256,request_number,review_note,requested_by_user_id,requested_request_id)
  VALUES(approval_request,ws,conversation,message,version,1,body_sha,1,'Owner reviewed one exact MHP webinar text batch '||batch::text||'.',actor,request);
  UPDATE app.messages SET lifecycle='approval_pending',row_version=row_version+1,updated_at=statement_timestamp() WHERE workspace_id=ws AND id=message;
  INSERT INTO app.message_approval_decisions(id,workspace_id,conversation_id,message_id,message_version_id,approval_request_id,version_number,body_sha256,decision,decision_note,decided_by_user_id,decided_request_id)
  VALUES(approval,ws,conversation,message,version,approval_request,1,body_sha,'approved','Actual owner exact-batch review, not external legal advice.',actor,request);
  UPDATE app.messages SET lifecycle='approved',row_version=row_version+1,updated_at=statement_timestamp() WHERE workspace_id=ws AND id=message;
  facts:=jsonb_build_object('schema',review_version,'owner',actor,'request',request,'command',p_command,'batch',batch,'batchSha256',encode(p_batch_sha256,'hex'),
   'campaign',p_campaign,'binding',binding.id,'sender',binding.sender_number,'recipientIdentitySha256',encode(endpoint_sha,'hex'),
   'contact',r."contactId",'point',point,'optin',r."optinId",'consent',consent,'contentVersion',p_content_version,'contentSha256',encode(p_content_sha256,'hex'),
   'messageVersion',version,'messageBodySha256',encode(body_sha,'hex'),'reviewAuthority',review_authority,
   'legalEntity','MH196 Ltd','brand','Martin Howard Property');
  facts_sha:=public.digest(facts::text,'sha256');
  scope:=public.digest(format('sms:%s:%s:%s:%s:%s:%s:%s',ws,binding.provider_connection_id,binding.sender_number,version,encode(endpoint_sha,'hex'),'marketing',consent),'sha256');
  INSERT INTO app_private.affiliate_compliance_subjects(id,workspace_id,source_system,source_subject_key,legal_identity_sha256,recorded_by_user_id,recorded_request_id)
  VALUES(subject,ws,'martin-howard-property','mhp.event-sms:'||p_command::text||':'||r."optinId"::text,public.digest('MH196 Ltd:Martin Howard Property:'||actor::text,'sha256'),actor,request);
  INSERT INTO app_private.affiliate_compliance_policy_pack_versions(id,workspace_id,pack_key,pack_version,bundle_sha256,document_refs,drafting_status,source_commit,source_commit_meaning,recorded_by_user_id,recorded_request_id)
  VALUES(pack,ws,'mhp_event_sms_batch',p_command::text||':'||r."optinId"::text,facts_sha,jsonb_build_array(
   jsonb_build_object('documentType','owner_review','documentId','mhp.event-batch-review:'||batch::text,'documentVersion','v1','contentSha256',encode(facts_sha,'hex')),
   jsonb_build_object('documentType','sender_ownership','documentId','mhp.sender-ownership:'||binding.id::text,'documentVersion','v1','contentSha256',encode(binding.ownership_evidence_sha256,'hex')),
   jsonb_build_object('documentType','registrant_phone_possession','documentId','mhp.event-sms-optin:'||r."optinId"::text,'documentVersion','v1',
    'contentSha256',encode(public.digest(jsonb_build_object('optin',r."optinId",'phoneIdentitySha256',encode(public.digest(r.phone,'sha256'),'hex'),'codeMessageSid',r."codeMessageSid")::text,'sha256'),'hex')),
   jsonb_build_object('documentType','exact_message','documentId','mhp.exact-message:'||version::text,'documentVersion','v1','contentSha256',encode(body_sha,'hex')),
   jsonb_build_object('documentType','registrant_consent','documentId','mhp.event-sms-consent:'||consent::text,'documentVersion','v1','contentSha256',encode(consent_sha,'hex'))),
   'draft_complete','69652270584f1dc0cf737fe2ff7cd9a19e3a4d28','drafting-provenance-only',actor,request);
  INSERT INTO app_private.affiliate_compliance_policy_review_events(id,workspace_id,policy_pack_id,bundle_sha256,review_dimension,decision,specialist_reference,decision_reference,decision_sha256,occurred_at,recorded_by_user_id,recorded_request_id)
  VALUES(legal,ws,pack,facts_sha,'legal','approved',review_authority,'mhp.event-batch:'||batch::text,public.digest(facts_sha||convert_to(':owner-legal-dimension','UTF8'),'sha256'),prepared,actor,request),
   (commercial,ws,pack,facts_sha,'commercial','approved',review_authority,'mhp.event-batch:'||batch::text,public.digest(facts_sha||convert_to(':owner-commercial-dimension','UTF8'),'sha256'),prepared,actor,request);
  INSERT INTO app_private.affiliate_compliance_policy_publication_events(id,workspace_id,policy_pack_id,bundle_sha256,publication_state,legal_review_event_id,commercial_review_event_id,effective_at,expires_at,reacceptance_class,publication_reference,recorded_by_user_id,recorded_request_id)
  VALUES(publication,ws,pack,facts_sha,'published',legal,commercial,prepared,expiry,'none','mhp.event-batch:'||batch::text,actor,request);
  INSERT INTO app_private.affiliate_compliance_specialist_decision_events(id,workspace_id,subject_id,decision_kind,decision_scope_ref,action_scope_sha256,decision_state,route_classification,
   party_reference,responsibility_reference,specialist_reference,decision_sha256,valid_from,valid_until,recorded_by_user_id,recorded_request_id)
  VALUES(sender_route,ws,subject,'pecr_sender_route','mhp.event-batch:'||batch::text,scope,'approved','individual_consent','mhp.sender.MH196Ltd','mhp.instigator.MH196Ltd',review_authority,
    public.digest(facts_sha||convert_to(':sender','UTF8'),'sha256'),prepared,expiry,actor,request),
   (instigator_route,ws,subject,'pecr_instigator_route','mhp.event-batch:'||batch::text,scope,'approved','individual_consent','mhp.sender.MH196Ltd','mhp.instigator.MH196Ltd',review_authority,
    public.digest(facts_sha||convert_to(':instigator','UTF8'),'sha256'),prepared,expiry,actor,request);
  nonce:=public.digest('mhp.sms.event-batch:'||ws::text||':'||actor::text||':'||p_command::text||':'||r."optinId"::text,'sha256');
  INSERT INTO app_private.affiliate_compliance_permission_use_receipts(id,workspace_id,subject_id,permission,action_scope_sha256,evidence_snapshot_sha256,decision_nonce_sha256,
   evaluated_at,decision_expires_at,consumed_at,recorded_by_user_id,recorded_request_id)
  VALUES(permission_use,ws,subject,'sms.send',scope,facts_sha,nonce,prepared,expiry,prepared,actor,request);
  request_sha:=app_private.derive_sms_live_request_digest(ws,binding.provider_connection_id,version,approval_request,approval,binding.channel_endpoint_id,consent,subject,
   publication,sender_route,instigator_route,permission_use,expiry,operation,delivery,correlation,nonce);
  SELECT * INTO queued FROM app_private.authorize_and_enqueue_sms_live_job(ws,binding.provider_connection_id,version,approval_request,approval,binding.channel_endpoint_id,consent,subject,
   publication,sender_route,instigator_route,permission_use,expiry,operation,delivery,correlation,nonce,request_sha,segments);
  IF queued.job_id IS NULL OR queued.disposition<>'queued' THEN RAISE EXCEPTION 'Event SMS enqueue returned no new job' USING ERRCODE='23514'; END IF;
  INSERT INTO app_private.mhp_event_sms_batch_recipients(batch_id,optin_id,workspace_id,content_version_id,contact_id,contact_point_id,consent_event_id,message_version_id,job_id)
  VALUES(batch,r."optinId",ws,p_content_version,r."contactId",point,consent,version,queued.job_id);
  jobs:=jobs||jsonb_build_array(queued.job_id);
 END LOOP;
 IF jsonb_array_length(jobs)<>recipients THEN RAISE EXCEPTION 'The reviewed batch changed during sending' USING ERRCODE='40001'; END IF;
 IF clock_timestamp()>=expiry THEN RAISE EXCEPTION 'Event SMS authority expired before completion' USING ERRCODE='23514'; END IF;
 outcome:=jsonb_build_object('batchId',batch,'commandId',p_command,'campaign',p_campaign,'contentVersionId',p_content_version,
  'recipientCount',recipients,'segmentsTotal',recipients*segments,'jobIds',jobs,
  'authorityExpiresAt',to_char(expiry AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'replayed',false,
  'reviewAuthority',review_authority,'providerEffects','none');
 UPDATE app.command_receipts SET result=outcome,status='succeeded',response_status=200,completed_at=clock_timestamp() WHERE id=command_receipt AND workspace_id=ws;
 RETURN outcome;
END $f$;

REVOKE ALL ON FUNCTION app_private.mhp_event_sms_phone_suppressed(text),app_private.mhp_event_sms_usage(uuid),
 app_private.mhp_event_sms_code_claim(uuid,uuid),app_private.mhp_event_sms_code_arm(uuid,uuid,text),
 app_private.mhp_event_sms_code_settle(uuid,uuid,text,text),app_private.mhp_event_sms_batch_candidates(text,uuid),
 app_private.mhp_event_sms_ready_set(text,uuid),app_private.mhp_event_sms_digest_of(text,uuid,bytea,jsonb),
 app_private.mhp_event_sms_batch_snapshot(bytea,text,uuid,bytea),
 app_private.mhp_event_sms_batch_send(bytea,uuid,text,uuid,bytea,bytea,boolean,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.mhp_event_sms_code_claim(uuid,uuid),app_private.mhp_event_sms_code_arm(uuid,uuid,text),
 app_private.mhp_event_sms_code_settle(uuid,uuid,text,text) TO r72_sms_worker_command;
GRANT EXECUTE ON FUNCTION app_private.mhp_event_sms_batch_snapshot(bytea,text,uuid,bytea),
 app_private.mhp_event_sms_batch_send(bytea,uuid,text,uuid,bytea,bytea,boolean,boolean) TO r72_sms_command;
RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_sms_definer,r72_mhp_prospect_definer;
