-- F3 named real-role proof on an ISOLATED production134 child after exact0135.
-- Run sections in order, each under the ACTUAL named login (never SET ROLE).
-- Synthetic *.invalid emails and Ofcom mobile range only. No external provider.
-- Root owns branch/ledger guards, credentials, transactions and receipts.

-- F3_OWNER_SEED (r72_owner)
DO $proof$
DECLARE ws constant uuid:='2789228d-55a6-4688-b1e8-2f70abca990b'; owner_id uuid; contact uuid:=gen_random_uuid();
BEGIN
 SELECT v.created_by_user_id INTO owner_id FROM app.company_content_versions v WHERE v.id='bdefff1c-66d4-4c3f-8d84-a82133f92f6e' AND v.workspace_id=ws;
 IF owner_id IS NULL THEN RAISE EXCEPTION 'Verified isolated current Nov4 programme required'; END IF;
 PERFORM set_config('app.workspace_id',ws::text,true); PERFORM set_config('app.user_id',owner_id::text,true);
 PERFORM set_config('app.actor_kind','user',true); PERFORM set_config('app.request_id','f3-135-isolated-owner-fixture',true);
 IF EXISTS(SELECT 1 FROM app_private.mhp_prospects WHERE email::text LIKE 'f3-135-%@example.invalid') THEN RAISE EXCEPTION 'Fresh isolated F3 fixture required'; END IF;
 INSERT INTO app.contacts(id,workspace_id,display_name) VALUES(contact,ws,'Synthetic F3 existing email');
 INSERT INTO app.contact_points(workspace_id,contact_id,kind,value,normalized_value,is_verified,deleted_at,dedupe_state)
 VALUES(ws,contact,'email','f3-135-initial-email@example.invalid','f3-135-initial-email@example.invalid',false,clock_timestamp(),'quarantined');
END $proof$;

-- F3_IDENTITY_CAPTURE (r72_identity_command)
DO $proof$
DECLARE result jsonb; cap jsonb; prior jsonb; p jsonb; label text; n integer:=0; nonce text; chosen jsonb;
 source bytea:=public.digest('f3-135-source','sha256'); capability bytea; denied boolean:=false; signup uuid; prospect uuid;
BEGIN
 IF session_user<>'r72_identity_command' OR current_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Actual identity login required'; END IF;
 BEGIN PERFORM 1 FROM app.contact_points LIMIT 1; EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'Identity role unexpectedly has direct CRM table access'; END IF;
 p:=app_private.mhp_event_phone_from_signup(gen_random_uuid(),gen_random_uuid(),'webinar-2026-11-04',public.digest('unknown','sha256'),source);
 IF p->>'ok'<>'false' THEN RAISE EXCEPTION 'Unknown signup accepted'; END IF;
 FOREACH label IN ARRAY ARRAY['initial-email','clean','late-email','late-phone','legacy','expiry','stale'] LOOP
  n:=n+1;
  result:=app_private.mhp_capture_signup_v2('f3-135-'||label||'@example.invalid','Synthetic F3',NULL,true,'f3-isolated-test','webinar','Webinar',NULL,
   'https://martinhowardproperty.co.uk/webinar/',source,'[]'::jsonb,'webinar-2026-11-04');
  IF result->>'created'<>'true' THEN RAISE EXCEPTION 'Synthetic prospect was not freshly captured'; END IF;
  signup:=(result->>'signupId')::uuid; prospect:=(result->>'prospectId')::uuid;
  capability:=public.digest('f3-135-cap-'||label,'sha256');
  IF label IN('expiry','stale') THEN CONTINUE; END IF;
  IF label='legacy' THEN
   p:=app_private.mhp_event_phone_request_link('f3-135-legacy@example.invalid',gen_random_uuid(),public.digest('f3-135-legacy-email-token','sha256'),public.digest('legacy-payload','sha256'),source);
   IF p->>'send'<>'true' THEN RAISE EXCEPTION 'Legacy email-link eligibility changed'; END IF;
   p:=app_private.mhp_event_phone_open(public.digest('f3-135-legacy-email-token','sha256'),capability,gen_random_uuid(),public.digest('open-payload','sha256'),source);
   IF p->>'ok'<>'true' THEN RAISE EXCEPTION 'Legacy link failed'; END IF;
  ELSE
   cap:=app_private.mhp_event_phone_from_signup(signup,prospect,'webinar-2026-11-04',capability,source);
   IF label='initial-email' THEN
    IF cap->>'ok'<>'false' THEN RAISE EXCEPTION 'Restricted email-collision SELECT policy did not see real existing identity'; END IF;
    CONTINUE;
   END IF;
   IF cap->>'ok'<>'true' THEN RAISE EXCEPTION 'Fresh same-browser handoff refused'; END IF;
   prior:=app_private.mhp_event_phone_from_signup(signup,prospect,'webinar-2026-11-04',capability,source);
   IF prior->>'ok'<>'true' OR prior->>'replayed'<>'true' OR prior->>'expiresAt' IS DISTINCT FROM cap->>'expiresAt' THEN RAISE EXCEPTION 'Exact replay renewed or changed authority'; END IF;
   denied:=false;
   BEGIN PERFORM app_private.mhp_event_phone_from_signup(signup,prospect,'webinar-2026-11-04',public.digest('changed-cap','sha256'),source);
   EXCEPTION WHEN serialization_failure THEN denied:=true; END;
   IF NOT denied THEN RAISE EXCEPTION 'Changed capability did not conflict'; END IF;
  END IF;
  nonce:=repeat('a',25)||chr(97+n);
  chosen:=app_private.mhp_event_phone_choose(capability,gen_random_uuid(),'+447700900'||lpad((900+n)::text,3,'0'),
   'mhp.event-phone-sms/v1',public.digest('Text me a reminder about this Martin Howard Property webinar at this mobile number. These texts are only about this webinar, not other marketing. Reply STOP to opt out.','sha256'),
   public.digest('mhp.event-phone.join/v1:'||nonce,'sha256'),public.digest('choose-'||label,'sha256'),source);
  IF chosen->>'ok'<>'true' THEN RAISE EXCEPTION 'Explicit consent and JOIN nonce choice failed'; END IF;
 END LOOP;
 -- Returning capture has a new signupId, but must retain the email-link fallback.
 result:=app_private.mhp_capture_signup_v2('f3-135-clean@example.invalid','Synthetic F3',NULL,true,'f3-isolated-test','webinar','Webinar',NULL,
  'https://martinhowardproperty.co.uk/webinar/',source,'[]'::jsonb,'webinar-2026-11-04');
 p:=app_private.mhp_event_phone_from_signup((result->>'signupId')::uuid,(result->>'prospectId')::uuid,'webinar-2026-11-04',public.digest('returning','sha256'),source);
 IF p->>'ok'<>'false' THEN RAISE EXCEPTION 'Returning registrant gained direct capability'; END IF;
END $proof$;

-- F3_OWNER_LATE_COLLISION_AND_EXPIRY (r72_owner)
DO $proof$
DECLARE ws constant uuid:='2789228d-55a6-4688-b1e8-2f70abca990b'; label text; contact uuid; s app_private.mhp_prospect_signups%ROWTYPE;
 parent app_private.mhp_event_phone_intents%ROWTYPE; old_stamp timestamptz:=clock_timestamp()-interval '20 minutes';
BEGIN
 PERFORM set_config('app.workspace_id',ws::text,true); PERFORM set_config('app.actor_kind','user',true);
 PERFORM set_config('app.user_id',(SELECT created_by_user_id::text FROM app.company_content_versions WHERE id='bdefff1c-66d4-4c3f-8d84-a82133f92f6e'),true);
 PERFORM set_config('app.request_id','f3-135-isolated-owner-fixture',true);
 FOREACH label IN ARRAY ARRAY['late-email','late-phone'] LOOP
  contact:=gen_random_uuid(); INSERT INTO app.contacts(id,workspace_id,display_name) VALUES(contact,ws,'Synthetic F3 late collision');
  IF label='late-email' THEN
   INSERT INTO app.contact_points(workspace_id,contact_id,kind,value,normalized_value,is_verified)
   VALUES(ws,contact,'email','f3-135-late-email@example.invalid','f3-135-late-email@example.invalid',false);
  ELSE
   INSERT INTO app.contact_points(workspace_id,contact_id,kind,value,normalized_value,is_verified)
   VALUES(ws,contact,'phone','+447700900904','+447700900904',false);
  END IF;
 END LOOP;
 SELECT i.* INTO parent FROM app_private.mhp_event_phone_intents i JOIN app_private.mhp_prospects p ON p.id=i.prospect_id
 WHERE p.email::text='f3-135-clean@example.invalid' AND i.kind='access' AND i.access_authority='signup_post';
 SELECT s0.* INTO s FROM app_private.mhp_prospect_signups s0 JOIN app_private.mhp_prospects p ON p.id=s0.prospect_id WHERE p.email::text='f3-135-expiry@example.invalid';
 INSERT INTO app_private.mhp_event_phone_intents(workspace_id,prospect_id,signup_id,campaign,programme_version_id,kind,revision,state,command_id,
  request_key_sha256,payload_sha256,source_sha256,email_identity_sha256,access_token_sha256,access_expires_at,access_consumed_at,capability_sha256,
  capability_expires_at,access_authority,created_at,updated_at)
 VALUES(ws,s.prospect_id,s.id,s.entry_campaign,parent.programme_version_id,'access',1,'open',gen_random_uuid(),
  public.digest('mhp.event-phone.signup:'||s.id::text,'sha256'),
  public.digest('mhp.event-phone.signup-payload/v1:'||s.id::text||':'||s.prospect_id::text||':'||s.entry_campaign||':'||encode(public.digest('f3-135-cap-expiry','sha256'),'hex')||':'||encode(s.source_hash,'hex'),'sha256'),
  s.source_hash,public.digest('mhp.event-phone.email:f3-135-expiry@example.invalid','sha256'),public.digest('unused-expiry','sha256'),old_stamp+interval '15 minutes',
  old_stamp,public.digest('f3-135-cap-expiry','sha256'),old_stamp+interval '15 minutes','signup_post',old_stamp,old_stamp);
 -- Independent stale NEW capture tuple: fixture INSERT, no immutable-row update or time override.
 INSERT INTO app_private.mhp_prospect_signups(prospect_id,kind,label,consent_given,consent_version,source_hash,created_at,entry_campaign,entry_source,entry_event_sequence)
 SELECT p.id,'webinar','Synthetic old capture',true,'f3-isolated-test',public.digest('f3-135-stale-source','sha256'),clock_timestamp()-interval '3 minutes',
  'webinar-2026-11-04','mhp.capture/v2',nextval('app_private.mhp_capture_event_sequence') FROM app_private.mhp_prospects p WHERE p.email::text='f3-135-stale@example.invalid';
END $proof$;

-- F3_IDENTITY_EXPIRY (r72_identity_command)
DO $proof$
DECLARE r jsonb; s uuid; p uuid; denied boolean:=false;
BEGIN
 -- IDs are selected through the *returned* capture tuple contract in the fixture;
 -- identity role deliberately cannot query private signup tables. Root supplies
 -- this block after extracting synthetic expiry/stale tuple as owner if needed.
 -- Expiry is also directly exercised through capability status, no metadata exposure.
 r:=app_private.mhp_event_phone_status(public.digest('f3-135-cap-expiry','sha256'));
 IF r->>'ok'<>'false' THEN RAISE EXCEPTION 'Expired capability remained usable'; END IF;
END $proof$;

-- F3_WEBHOOK_JOIN (r72_sms_webhook_command): trusted-boundary synthetic input,
-- NOT an assertion that Twilio signature verification or a physical send ran.
DO $proof$
DECLARE ws constant uuid:='2789228d-55a6-4688-b1e8-2f70abca990b'; conn uuid; n integer; label text; sid text; body text; sender text; result text;
 point uuid; evidence jsonb;
BEGIN
 IF session_user<>'r72_sms_webhook_command' OR current_user<>'r72_sms_webhook_command' THEN RAISE EXCEPTION 'Actual webhook login required'; END IF;
 PERFORM set_config('app.workspace_id',ws::text,true); PERFORM set_config('app.actor_kind','webhook',true); PERFORM set_config('app.user_id','',true);
 PERFORM set_config('app.request_id','f3-135-isolated-webhook-fixture',true);
 conn:='f1cfe230-103f-4360-8394-3a89e9b1918e'; -- Root verified actual binding43932644; no LOGIN table read.
 FOR n IN 2..5 LOOP
  label:=CASE n WHEN 2 THEN 'clean' WHEN 3 THEN 'late-email' WHEN 4 THEN 'late-phone' ELSE 'legacy' END;
  sid:='SM'||lpad(n::text,32,'0'); sender:='447700900'||lpad((900+n)::text,3,'0'); body:='JOIN '||repeat('a',25)||chr(97+n);
  SELECT disposition INTO result FROM app_private.mhp_record_event_sms_inbound(ws,conn,'inbound:'||sid,sid,sender,'',body,
   public.digest(sender,'sha256'),public.digest(body,'sha256'),public.digest('f3-payload-'||label,'sha256'),public.digest('f3-signature-'||label,'sha256'),public.digest('f3-event-'||label,'sha256'),clock_timestamp());
  IF result IS DISTINCT FROM (CASE WHEN n IN(2,5) THEN 'event_joined' ELSE 'event_held' END) THEN RAISE EXCEPTION 'Unexpected JOIN mode outcome %',result; END IF;
 END LOOP;
END $proof$;

-- F3_OWNER_ASSERT (r72_owner)
DO $proof$
DECLARE ws constant uuid:='2789228d-55a6-4688-b1e8-2f70abca990b'; evidence jsonb;
BEGIN
 IF EXISTS(SELECT 1 FROM app.contact_points WHERE workspace_id=ws AND kind='email' AND normalized_value='f3-135-clean@example.invalid')
 THEN RAISE EXCEPTION 'Same-browser JOIN created an email identity or verification'; END IF;
 SELECT c.evidence INTO evidence FROM app.communication_consent_events c JOIN app_private.mhp_event_phone_receipts r ON r.consent_event_id=c.id
 JOIN app_private.mhp_prospects p ON p.id=r.prospect_id WHERE p.email::text='f3-135-clean@example.invalid' AND r.decision='granted';
 IF evidence->>'registrationProof' IS DISTINCT FROM 'same-browser-signup-post' OR evidence->'emailProof' IS DISTINCT FROM 'null'::jsonb
 THEN RAISE EXCEPTION 'Same-browser registration falsely claimed email proof'; END IF;
 IF NOT EXISTS(SELECT 1 FROM app.contact_points WHERE workspace_id=ws AND kind='phone' AND normalized_value='+447700900902' AND is_verified)
 THEN RAISE EXCEPTION 'Signed JOIN did not verify only the owned phone'; END IF;
 IF NOT EXISTS(SELECT 1 FROM app.contact_points WHERE workspace_id=ws AND kind='email' AND normalized_value='f3-135-legacy@example.invalid' AND is_verified)
 THEN RAISE EXCEPTION 'Legacy single-use-email verification regressed'; END IF;
 IF EXISTS(SELECT 1 FROM app_private.mhp_event_phone_receipts r JOIN app_private.mhp_prospects p ON p.id=r.prospect_id
 WHERE p.email::text IN('f3-135-late-email@example.invalid','f3-135-late-phone@example.invalid') AND r.decision='granted')
 THEN RAISE EXCEPTION 'Existing identity collision acquired SMS permission'; END IF;
END $proof$;



-- F3_OWNER_EXPIRED_TUPLES (r72_owner): pass these synthetic-only returned UUIDs
-- to the parameterised identity statements below; never grant public table read.
SELECT s.id AS signup_id,s.prospect_id,s.entry_campaign,encode(s.source_hash,'hex') AS source_sha
FROM app_private.mhp_prospect_signups s JOIN app_private.mhp_prospects p ON p.id=s.prospect_id
WHERE (p.email::text='f3-135-expiry@example.invalid' OR (p.email::text='f3-135-stale@example.invalid' AND s.source_hash=public.digest('f3-135-stale-source','sha256')));
-- F3_IDENTITY_EXPIRED_REPLAY (r72_identity_command; $1/$2 from expiry row)
-- SELECT app_private.mhp_event_phone_from_signup($1::uuid,$2::uuid,'webinar-2026-11-04',public.digest('f3-135-cap-expiry','sha256'),public.digest('f3-135-source','sha256'));
-- Assert ok=false/replayed=true and exact prior expiresAt (no renewal).
-- F3_IDENTITY_STALE_CAPTURE (r72_identity_command; $1/$2 from stale row)
-- SELECT app_private.mhp_event_phone_from_signup($1::uuid,$2::uuid,'webinar-2026-11-04',public.digest('f3-135-cap-stale','sha256'),public.digest('f3-135-stale-source','sha256'));
-- Assert ok=false and zero access rows for this signup, inspected as owner.
