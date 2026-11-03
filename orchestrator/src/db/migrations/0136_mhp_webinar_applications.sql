-- MHP-WEBINAR-V2-REBASE-20261103: additive current135 contracts, not PR0124.
-- One existing queue; owner/sequence/SMS jobs stay in their existing boundaries.
SET LOCAL ROLE r72_owner;
ALTER TABLE app_private.mhp_prospects ADD COLUMN phone text CHECK(phone IS NULL OR (length(phone) BETWEEN 6 AND 30 AND phone~'^[0-9 +()-]+$'));
ALTER TABLE app_private.mhp_prospect_signups
 DROP CONSTRAINT mhp_prospect_signups_kind_check,
 ADD CONSTRAINT mhp_prospect_signups_kind_check CHECK(kind IN('sheet','webinar','waitlist','application')),
 ADD COLUMN webinar_service_requested boolean NOT NULL DEFAULT false CHECK(NOT webinar_service_requested OR kind='webinar'),
 ADD CONSTRAINT mhp_signup_service_identity UNIQUE(id,prospect_id,entry_campaign);
CREATE TABLE app_private.mhp_applications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 prospect_id uuid NOT NULL REFERENCES app_private.mhp_prospects(id) ON DELETE CASCADE,
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 120 AND name !~ '[[:cntrl:]]'),
 phone text CHECK(phone IS NULL OR (length(phone) BETWEEN 1 AND 30 AND phone ~ '^[0-9 +()-]+$')),
 location text NOT NULL CHECK(length(btrim(location)) BETWEEN 1 AND 120 AND location !~ '[[:cntrl:]]'),
 experience text NOT NULL CHECK(experience IN('None yet','Some reading or courses','Done a deal or two','Active in property')),
 door text NOT NULL CHECK(door IN('Refer','Source','Run','Own','Not sure yet')),
 hours text NOT NULL CHECK(hours IN('Under 5','5 to 10','10 to 15','15 plus')),
 objective text NOT NULL CHECK(length(btrim(objective)) BETWEEN 1 AND 600),
 obstacle text NOT NULL CHECK(obstacle IN('Direction','Skills','Time','Capital','Accountability','Something else')),
 support text NOT NULL CHECK(support IN('Group mentoring','Self-study','Not sure yet')),
 price_understood boolean NOT NULL CHECK(price_understood),
 discuss boolean NOT NULL,
 privacy_consent boolean NOT NULL CHECK(privacy_consent),
 marketing_consent boolean NOT NULL,
 consent_version text NOT NULL CHECK(length(consent_version) BETWEEN 1 AND 40),
 notify_to text NOT NULL CHECK(notify_to=lower(btrim(notify_to)) AND length(notify_to) BETWEEN 3 AND 254 AND notify_to~'^[^[:space:]@<>]+@[^[:space:]@<>]+\.[^[:space:]@<>]+$'),
 status text NOT NULL DEFAULT 'received' CHECK(status IN('received','contacted','booked','accepted','declined','withdrawn')),
 source text NOT NULL DEFAULT 'site' CHECK(source IN('live','replay','site','email')),
 source_hash bytea CHECK(source_hash IS NULL OR octet_length(source_hash)=32),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX mhp_applications_created_idx ON app_private.mhp_applications(created_at DESC);
CREATE INDEX mhp_applications_prospect_idx ON app_private.mhp_applications(prospect_id,created_at);
-- Funnel counters: a day, an allow-listed event name and a site path. No
-- identifiers, addresses, cookies or source hashes are stored.
CREATE TABLE app_private.mhp_event_counts (
 day date NOT NULL,
 name text NOT NULL CHECK(name IN('webinar_page_viewed','live_page_opened','replay_page_opened','diagnostic_started','diagnostic_completed','offer_viewed','application_started')),
 path text NOT NULL CHECK(length(path) BETWEEN 1 AND 120 AND path ~ '^/[A-Za-z0-9/_.-]*$'),
 count integer NOT NULL DEFAULT 0 CHECK(count>=0),
 PRIMARY KEY(day,name,path)
);
ALTER TABLE app_private.mhp_applications ADD CONSTRAINT mhp_application_prospect_identity UNIQUE(id,prospect_id);
ALTER TABLE app_private.mhp_marketing_sends
 ADD COLUMN builtin_purpose text NOT NULL DEFAULT 'legacy' CHECK(builtin_purpose IN('legacy','webinar_service','webinar_marketing','application_received','application_notify')),
 ADD COLUMN service_signup_id uuid,
 ADD COLUMN application_id uuid,
 ADD CONSTRAINT mhp_builtin_service_fk FOREIGN KEY(service_signup_id,prospect_id,campaign_key)
  REFERENCES app_private.mhp_prospect_signups(id,prospect_id,entry_campaign) ON DELETE CASCADE,
 ADD CONSTRAINT mhp_builtin_application_fk FOREIGN KEY(application_id,prospect_id)
  REFERENCES app_private.mhp_applications(id,prospect_id) ON DELETE CASCADE,
 ADD CONSTRAINT mhp_builtin_purpose_shape CHECK(
  (builtin_purpose='legacy' AND service_signup_id IS NULL AND application_id IS NULL)
  OR (delivery_channel='email' AND owner_content_version_id IS NULL AND sequence_run_id IS NULL AND
   ((builtin_purpose='webinar_service' AND service_signup_id IS NOT NULL AND application_id IS NULL
     AND template_key IN('webinar_confirm','webinar_24h','webinar_1h','webinar_replay_plain'))
    OR(builtin_purpose='webinar_marketing' AND service_signup_id IS NOT NULL AND application_id IS NULL
     AND template_key IN('webinar_confirm','webinar_replay','webinar_followup','webinar_90days','webinar_casestudy'))
    OR(builtin_purpose IN('application_received','application_notify') AND service_signup_id IS NULL AND application_id IS NOT NULL
     AND template_key=builtin_purpose AND campaign_key='application-'||application_id::text)))
 );
DO $security$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['mhp_applications','mhp_event_counts'] LOOP
  EXECUTE format('ALTER TABLE app_private.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE app_private.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY mhp_webinar_owner ON app_private.%I TO r72_owner USING(true) WITH CHECK(true)',t);
  EXECUTE format('CREATE POLICY mhp_webinar_read ON app_private.%I FOR SELECT TO r72_mhp_prospect_definer USING(session_user IN(''r72_identity_command'',''r72_web''))',t);
  EXECUTE format('CREATE POLICY mhp_webinar_insert ON app_private.%I FOR INSERT TO r72_mhp_prospect_definer WITH CHECK(session_user=''r72_identity_command'')',t);
  EXECUTE format('REVOKE ALL ON app_private.%I FROM PUBLIC',t);
  EXECUTE format('GRANT SELECT,INSERT ON app_private.%I TO r72_mhp_prospect_definer',t);
 END LOOP;
END $security$;
GRANT UPDATE ON app_private.mhp_event_counts TO r72_mhp_prospect_definer;
CREATE POLICY mhp_webinar_counter_update ON app_private.mhp_event_counts FOR UPDATE TO r72_mhp_prospect_definer
 USING(session_user='r72_identity_command') WITH CHECK(session_user='r72_identity_command');
GRANT CREATE ON SCHEMA app_private TO r72_mhp_prospect_definer;
SET LOCAL ROLE r72_mhp_prospect_definer;

-- A real new capture, keeping the immutable mhp.capture/v2 event protocol.
CREATE FUNCTION app_private.mhp_capture_signup_v3(p_email text,p_first_name text,p_level text,p_consent boolean,p_consent_version text,
 p_kind text,p_label text,p_module text,p_link text,p_source_hash bytea,p_schedule jsonb,p_campaign text,p_phone text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE outcome jsonb; ordinal bigint; signup uuid; prospect uuid; item jsonb; purpose text; queued integer:=0; expires timestamptz; due timestamptz;
 replay_busy boolean; prior app_private.mhp_marketing_sends%ROWTYPE; body_context jsonb;
BEGIN
 IF session_user<>'r72_identity_command' OR p_kind IS NULL OR p_schedule IS NULL OR jsonb_typeof(p_schedule)<>'array' OR jsonb_array_length(p_schedule)>8
 THEN RAISE EXCEPTION 'Invalid capture boundary' USING ERRCODE='22023'; END IF;
 IF p_kind<>'webinar' THEN
  IF p_campaign IS NOT NULL THEN RAISE EXCEPTION 'Campaign is only for webinar capture' USING ERRCODE='22023'; END IF;
  outcome:=app_private.mhp_capture_signup(p_email,p_first_name,p_level,p_consent,p_consent_version,p_kind,p_label,p_module,p_link,p_source_hash,p_schedule);
  RETURN outcome||jsonb_build_object('campaign',NULL,'entryEventSequence',NULL);
 END IF;
 IF p_campaign IS NULL OR p_campaign!~'^[a-z0-9_-]{1,60}$'
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_schedule) x WHERE x->>'campaign' IS DISTINCT FROM p_campaign
   OR x->>'template' IS NULL OR x->>'template' NOT IN('webinar_confirm','webinar_24h','webinar_1h','webinar_replay','webinar_replay_plain','webinar_followup','webinar_90days','webinar_casestudy'))
 THEN RAISE EXCEPTION 'Invalid trusted webinar schedule' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('mhp-capture-campaign:'||p_campaign,7200128));
 -- Existing prospect update retains explicit-checkbox-only marketing reactivation.
 outcome:=app_private.mhp_capture_signup(p_email,p_first_name,p_level,p_consent,p_consent_version,p_kind,p_label,p_module,p_link,p_source_hash,'[]'::jsonb);
 signup:=(outcome->>'signupId')::uuid; prospect:=(outcome->>'prospectId')::uuid;
 ordinal:=nextval('app_private.mhp_capture_event_sequence');
 UPDATE app_private.mhp_prospect_signups SET webinar_service_requested=true,entry_campaign=p_campaign,entry_source='mhp.capture/v2',entry_event_sequence=ordinal
 WHERE id=signup AND prospect_id=prospect AND kind='webinar' AND entry_campaign IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'Actual capture identity unavailable' USING ERRCODE='23514'; END IF;
 -- Informational only: no contact point, verification, consent or SMS authority is written.
 IF p_phone IS NOT NULL AND length(p_phone) BETWEEN 6 AND 30 AND p_phone~'^[0-9 +()-]+$' THEN
  UPDATE app_private.mhp_prospects SET phone=p_phone,updated_at=clock_timestamp() WHERE id=prospect;
 END IF;
 body_context:=jsonb_build_object('label',p_label,'module',coalesce(p_module,''),'link',coalesce(p_link,''));
 FOR item IN SELECT value FROM jsonb_array_elements(p_schedule) LOOP
  purpose:=CASE WHEN item->>'template' IN('webinar_replay','webinar_followup','webinar_90days','webinar_casestudy') OR (item->>'template'='webinar_confirm' AND p_consent) THEN 'webinar_marketing' ELSE 'webinar_service' END;
  IF purpose='webinar_marketing' AND NOT p_consent THEN RAISE EXCEPTION 'Marketing opt-in is required for this template' USING ERRCODE='23514'; END IF;
  due:=(item->>'dueAt')::timestamptz; expires:=(item->>'expiresAt')::timestamptz;
  IF due IS NULL OR expires IS NULL OR expires<=due THEN RAISE EXCEPTION 'Invalid webinar time window' USING ERRCODE='22023'; END IF;
  IF item->>'template' IN('webinar_replay','webinar_replay_plain') THEN
   -- Both variants occupy one logical replay slot, including legacy queued/sent rows.
   replay_busy:=false;
   FOR prior IN SELECT * FROM app_private.mhp_marketing_sends s WHERE s.prospect_id=prospect AND s.campaign_key=p_campaign
    AND s.delivery_channel='email' AND s.owner_content_version_id IS NULL AND s.template_key IN('webinar_replay','webinar_replay_plain')
    ORDER BY s.id FOR UPDATE LOOP
    IF prior.sent_at IS NOT NULL OR prior.lease_until>clock_timestamp() THEN replay_busy:=true; END IF;
   END LOOP;
   IF replay_busy THEN CONTINUE; END IF;
   UPDATE app_private.mhp_marketing_sends SET cancelled_at=clock_timestamp()
   WHERE prospect_id=prospect AND campaign_key=p_campaign AND delivery_channel='email' AND owner_content_version_id IS NULL
    AND template_key IN('webinar_replay','webinar_replay_plain') AND template_key<>item->>'template'
    AND sent_at IS NULL AND cancelled_at IS NULL AND (lease_until IS NULL OR lease_until<=clock_timestamp());
  END IF;
  INSERT INTO app_private.mhp_marketing_sends(prospect_id,template_key,campaign_key,context,due_at,expires_at,builtin_purpose,service_signup_id)
  VALUES(prospect,item->>'template',p_campaign,body_context,due,expires,purpose,signup)
  ON CONFLICT(prospect_id,template_key,campaign_key) DO UPDATE SET
   cancelled_at=NULL,failed_at=NULL,attempts=0,lease_until=NULL,due_at=EXCLUDED.due_at,expires_at=EXCLUDED.expires_at,context=EXCLUDED.context,
   builtin_purpose=EXCLUDED.builtin_purpose,service_signup_id=EXCLUDED.service_signup_id
  WHERE app_private.mhp_marketing_sends.sent_at IS NULL AND app_private.mhp_marketing_sends.cancelled_at IS NOT NULL
   AND app_private.mhp_marketing_sends.delivery_channel='email' AND app_private.mhp_marketing_sends.owner_content_version_id IS NULL
   AND (app_private.mhp_marketing_sends.lease_until IS NULL OR app_private.mhp_marketing_sends.lease_until<=clock_timestamp());
  IF FOUND THEN queued:=queued+1; END IF;
 END LOOP;
 RETURN outcome||jsonb_build_object('queued',queued,'campaign',p_campaign,'entryEventSequence',ordinal::text);
END $f$;

CREATE FUNCTION app_private.mhp_record_application(p_email text,p_name text,p_phone text,p_location text,p_experience text,p_door text,
 p_hours text,p_objective text,p_obstacle text,p_support text,p_price_understood boolean,p_discuss boolean,p_opt_in boolean,
 p_consent_version text,p_source text,p_source_hash bytea,p_notify_to text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE prospect app_private.mhp_prospects%ROWTYPE; application uuid; first_word text;
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Application capture denied' USING ERRCODE='42501'; END IF;
 IF p_email IS NULL OR p_email<>lower(btrim(p_email)) OR length(p_email)>320 OR p_email!~'^[^[:space:]@<>]+@[^[:space:]@<>]+\.[^[:space:]@<>]+$'
  OR p_notify_to IS NULL OR p_notify_to<>lower(btrim(p_notify_to)) OR length(p_notify_to)>320 OR p_notify_to!~'^[^[:space:]@<>]+@[^[:space:]@<>]+\.[^[:space:]@<>]+$'
  OR p_opt_in IS NULL OR p_discuss IS NULL OR p_price_understood IS NOT TRUE
  OR p_consent_version IS NULL OR length(p_consent_version) NOT BETWEEN 1 AND 40 OR p_name IS NULL THEN
  RAISE EXCEPTION 'Invalid application' USING ERRCODE='22023';
 END IF;
 first_word:=NULLIF(left(split_part(btrim(p_name),' ',1),100),'');
 PERFORM pg_advisory_xact_lock(hashtextextended(p_email,121));
 SELECT * INTO prospect FROM app_private.mhp_prospects WHERE email::text=p_email FOR UPDATE;
 IF NOT FOUND THEN
  INSERT INTO app_private.mhp_prospects(email,first_name,marketing_consent,consent_version,consent_at)
  VALUES(p_email,first_word,p_opt_in,CASE WHEN p_opt_in THEN p_consent_version END,CASE WHEN p_opt_in THEN clock_timestamp() END)
  RETURNING * INTO prospect;
 ELSE
  UPDATE app_private.mhp_prospects SET
   first_name=COALESCE(first_name,first_word),
   marketing_consent=marketing_consent OR p_opt_in,
   consent_version=CASE WHEN p_opt_in THEN p_consent_version ELSE consent_version END,
   consent_at=CASE WHEN p_opt_in THEN clock_timestamp() ELSE consent_at END,
   unsubscribed_at=CASE WHEN p_opt_in THEN NULL ELSE unsubscribed_at END,
   updated_at=clock_timestamp()
  WHERE id=prospect.id RETURNING * INTO prospect;
 END IF;
 INSERT INTO app_private.mhp_prospect_signups(prospect_id,kind,label,module,link,consent_given,consent_version,source_hash)
 VALUES(prospect.id,'application','One Lane Mentoring application',NULL,NULL,p_opt_in,p_consent_version,p_source_hash);
 INSERT INTO app_private.mhp_applications(prospect_id,name,phone,location,experience,door,hours,objective,obstacle,support,
  price_understood,discuss,privacy_consent,marketing_consent,consent_version,source,source_hash,notify_to)
 VALUES(prospect.id,btrim(p_name),NULLIF(btrim(p_phone),''),btrim(p_location),p_experience,p_door,p_hours,btrim(p_objective),p_obstacle,p_support,
  p_price_understood,p_discuss,true,p_opt_in,p_consent_version,COALESCE(p_source,'site'),p_source_hash,p_notify_to)
 RETURNING id INTO application;
 -- They have applied: stop the webinar sales sequence for them.
 UPDATE app_private.mhp_marketing_sends SET cancelled_at=clock_timestamp()
 WHERE prospect_id=prospect.id AND delivery_channel='email' AND owner_content_version_id IS NULL AND sent_at IS NULL AND cancelled_at IS NULL AND failed_at IS NULL
  AND template_key IN('webinar_followup','webinar_90days','webinar_casestudy');
 INSERT INTO app_private.mhp_marketing_sends(prospect_id,template_key,campaign_key,context,due_at,expires_at,builtin_purpose,application_id)
 VALUES(prospect.id,'application_received','application-'||application::text,jsonb_build_object('applicationId',application),
   clock_timestamp(),clock_timestamp()+interval '7 days','application_received',application),
  (prospect.id,'application_notify','application-'||application::text,jsonb_build_object('applicationId',application,'notifyTo',p_notify_to),
   clock_timestamp(),clock_timestamp()+interval '30 days','application_notify',application);
 RETURN jsonb_build_object('applicationId',application,'prospectId',prospect.id);
END $f$;


CREATE FUNCTION app_private.mhp_list_applications(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid;
BEGIN
 IF session_user<>'r72_web' THEN RAISE EXCEPTION 'MHP owner read boundary required' USING ERRCODE='42501'; END IF;
 SELECT s.user_id INTO actor FROM app_private.resolve_session(p_session) s JOIN app.user_sessions us ON us.id=s.session_id
 WHERE us.product_audience='martin_howard_property';
 IF actor IS NULL OR NOT app_private.mhp_is_programme_admin(actor) THEN RAISE EXCEPTION 'MHP administration required' USING ERRCODE='42501'; END IF;
 RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('id',a.id,'name',a.name,'email',p.email::text,'phone',a.phone,'location',a.location,
   'experience',a.experience,'door',a.door,'hours',a.hours,'objective',a.objective,'obstacle',a.obstacle,'support',a.support,
   'discuss',a.discuss,'marketingConsent',a.marketing_consent,'source',a.source,'status',a.status,'createdAt',a.created_at) ORDER BY a.created_at DESC,a.id)
  FROM (SELECT * FROM app_private.mhp_applications ORDER BY created_at DESC,id LIMIT 200) a JOIN app_private.mhp_prospects p ON p.id=a.prospect_id),'[]'::jsonb);
END $f$;

-- Owner-only list of the latest 2000 people who signed up, newest first, with what
-- they signed up for and whether they have applied. For contacting registrants
-- about what they asked for; marketing only where marketingConsent is true.
CREATE FUNCTION app_private.mhp_list_registrants(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid;
BEGIN
 IF session_user<>'r72_web' THEN RAISE EXCEPTION 'MHP owner read boundary required' USING ERRCODE='42501'; END IF;
 SELECT s.user_id INTO actor FROM app_private.resolve_session(p_session) s JOIN app.user_sessions us ON us.id=s.session_id
 WHERE us.product_audience='martin_howard_property';
 IF actor IS NULL OR NOT app_private.mhp_is_programme_admin(actor) THEN RAISE EXCEPTION 'MHP administration required' USING ERRCODE='42501'; END IF;
 RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('id',p.id,'firstName',p.first_name,'email',p.email::text,'phone',p.phone,'level',p.level,
   'marketingConsent',p.marketing_consent,'unsubscribed',p.unsubscribed_at IS NOT NULL,'firstSeenAt',p.created_at,
   'lastSignupAt',x.last_at,'signups',x.labels,
   'webinar',x.webinar,'applied',EXISTS(SELECT 1 FROM app_private.mhp_applications a WHERE a.prospect_id=p.id)) ORDER BY x.last_at DESC,p.id)
  FROM app_private.mhp_prospects p
  JOIN LATERAL (SELECT max(g.created_at) AS last_at, bool_or(g.kind='webinar') AS webinar,
                       jsonb_agg(DISTINCT g.label) AS labels
                FROM app_private.mhp_prospect_signups g WHERE g.prospect_id=p.id) x ON x.last_at IS NOT NULL
  WHERE p.id IN (SELECT g2.prospect_id FROM app_private.mhp_prospect_signups g2 GROUP BY g2.prospect_id ORDER BY max(g2.created_at) DESC LIMIT 2000)),'[]'::jsonb);
END $f$;


CREATE FUNCTION app_private.mhp_record_event(p_name text,p_path text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Event capture denied' USING ERRCODE='42501'; END IF;
 IF p_name IS NULL OR p_name NOT IN('webinar_page_viewed','live_page_opened','replay_page_opened','diagnostic_started','diagnostic_completed','offer_viewed','application_started')
  OR p_path IS NULL OR length(p_path) NOT BETWEEN 1 AND 120 OR p_path!~'^/[A-Za-z0-9/_.-]*$' THEN RETURN false; END IF;
 INSERT INTO app_private.mhp_event_counts(day,name,path,count) VALUES((clock_timestamp() AT TIME ZONE 'UTC')::date,p_name,p_path,1)
 ON CONFLICT(day,name,path) DO UPDATE SET count=app_private.mhp_event_counts.count+1;
 RETURN true;
END $f$;


CREATE FUNCTION app_private.mhp_builtin_send_eligible(p_send uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT coalesce((SELECT CASE
  WHEN s.builtin_purpose='legacy' THEN p.unsubscribed_at IS NULL
  WHEN s.builtin_purpose='webinar_service' THEN g.id IS NOT NULL AND g.kind='webinar' AND g.webinar_service_requested
   AND g.entry_campaign=s.campaign_key AND (p.unsubscribed_at IS NULL OR g.created_at>p.unsubscribed_at)
  WHEN s.builtin_purpose='webinar_marketing' THEN g.id IS NOT NULL AND g.kind='webinar' AND g.consent_given AND g.entry_campaign=s.campaign_key
   AND p.marketing_consent AND p.unsubscribed_at IS NULL
  WHEN s.builtin_purpose IN('application_received','application_notify') THEN a.id IS NOT NULL AND a.privacy_consent
  ELSE false END
 FROM app_private.mhp_marketing_sends s JOIN app_private.mhp_prospects p ON p.id=s.prospect_id
 LEFT JOIN app_private.mhp_prospect_signups g ON g.id=s.service_signup_id AND g.prospect_id=s.prospect_id AND g.entry_campaign=s.campaign_key
 LEFT JOIN app_private.mhp_applications a ON a.id=s.application_id AND a.prospect_id=s.prospect_id
 WHERE s.id=p_send AND s.delivery_channel='email' AND s.owner_content_version_id IS NULL),false)
$f$;
REVOKE ALL ON FUNCTION app_private.mhp_builtin_send_eligible(uuid) FROM PUBLIC;

-- One queue/claim implementation. The old wrapper cannot touch any136 row.
CREATE FUNCTION app_private.mhp_claim_builtin_sends_internal(p_limit integer,p_lease_seconds integer,p_only_emails text[],p_include_v2 boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE claimed jsonb;
BEGIN
 IF session_user<>'r72_identity_command' OR p_include_v2 IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50
  OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 900 THEN RAISE EXCEPTION 'Invalid claim' USING ERRCODE='22023'; END IF;
 IF p_only_emails IS NOT NULL AND cardinality(p_only_emails) NOT BETWEEN 1 AND 20 THEN RAISE EXCEPTION 'Invalid claim' USING ERRCODE='22023'; END IF;
 UPDATE app_private.mhp_marketing_sends s SET cancelled_at=clock_timestamp()
 WHERE s.delivery_channel='email' AND s.owner_content_version_id IS NULL AND (p_include_v2 OR s.builtin_purpose='legacy')
  AND s.sent_at IS NULL AND s.cancelled_at IS NULL AND s.failed_at IS NULL AND s.expires_at<=clock_timestamp()
  AND (s.lease_until IS NULL OR s.lease_until<clock_timestamp());
 UPDATE app_private.mhp_marketing_sends s SET failed_at=clock_timestamp()
 WHERE s.delivery_channel='email' AND s.owner_content_version_id IS NULL AND (p_include_v2 OR s.builtin_purpose='legacy')
  AND s.sent_at IS NULL AND s.cancelled_at IS NULL AND s.failed_at IS NULL AND s.attempts>=5 AND (s.lease_until IS NULL OR s.lease_until<clock_timestamp());
 UPDATE app_private.mhp_marketing_sends s SET cancelled_at=clock_timestamp()
 WHERE s.delivery_channel='email' AND s.owner_content_version_id IS NULL AND (p_include_v2 OR s.builtin_purpose='legacy')
  AND NOT app_private.mhp_builtin_send_eligible(s.id) AND s.sent_at IS NULL AND s.cancelled_at IS NULL AND s.failed_at IS NULL;
 WITH due AS(
  SELECT s.id FROM app_private.mhp_marketing_sends s JOIN app_private.mhp_prospects p ON p.id=s.prospect_id
  LEFT JOIN app_private.mhp_applications a ON a.id=s.application_id AND a.prospect_id=s.prospect_id
  WHERE s.delivery_channel='email' AND s.owner_content_version_id IS NULL AND (p_include_v2 OR s.builtin_purpose='legacy')
   AND app_private.mhp_builtin_send_eligible(s.id) AND s.sent_at IS NULL AND s.cancelled_at IS NULL AND s.failed_at IS NULL AND s.due_at<=clock_timestamp()
   AND s.expires_at>clock_timestamp() AND (s.lease_until IS NULL OR s.lease_until<clock_timestamp())
   AND (p_only_emails IS NULL OR (CASE WHEN s.builtin_purpose='application_notify' THEN a.notify_to ELSE p.email::text END)=ANY(p_only_emails))
  ORDER BY s.due_at,s.id LIMIT p_limit FOR UPDATE OF s SKIP LOCKED
 ), leased AS(
  UPDATE app_private.mhp_marketing_sends s SET lease_until=clock_timestamp()+make_interval(secs=>p_lease_seconds),attempts=s.attempts+1
  FROM due WHERE s.id=due.id RETURNING s.*
 )
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',l.id,'prospectId',p.id,'template',l.template_key,'campaign',l.campaign_key,
  'context',l.context||jsonb_build_object('emailPurpose',l.builtin_purpose),
  'email',CASE WHEN l.builtin_purpose='application_notify' THEN a.notify_to ELSE p.email::text END,
  'firstName',p.first_name,'level',p.level,'attempts',l.attempts,'expiresAt',l.expires_at,
  'application',CASE WHEN l.builtin_purpose<>'application_notify' THEN NULL ELSE jsonb_build_object('id',a.id,'name',a.name,'email',p.email::text,'phone',a.phone,
   'location',a.location,'experience',a.experience,'door',a.door,'hours',a.hours,'objective',a.objective,'obstacle',a.obstacle,'support',a.support,
   'discuss',a.discuss,'marketingConsent',a.marketing_consent,'source',a.source,'status',a.status,'createdAt',a.created_at) END) ORDER BY l.due_at),'[]'::jsonb)
 INTO claimed FROM leased l JOIN app_private.mhp_prospects p ON p.id=l.prospect_id
 LEFT JOIN app_private.mhp_applications a ON a.id=l.application_id AND a.prospect_id=l.prospect_id;
 RETURN claimed;
END $f$;
REVOKE ALL ON FUNCTION app_private.mhp_claim_builtin_sends_internal(integer,integer,text[],boolean) FROM PUBLIC;
CREATE OR REPLACE FUNCTION app_private.mhp_claim_marketing_sends(p_limit integer,p_lease_seconds integer,p_only_emails text[]) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT app_private.mhp_claim_builtin_sends_internal(p_limit,p_lease_seconds,p_only_emails,false)
$f$;
CREATE FUNCTION app_private.mhp_claim_marketing_sends_v2(p_limit integer,p_lease_seconds integer,p_only_emails text[]) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT app_private.mhp_claim_builtin_sends_internal(p_limit,p_lease_seconds,p_only_emails,true)
$f$;

CREATE FUNCTION app_private.mhp_growth_summary_v2(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE current_summary jsonb;
BEGIN
 IF session_user<>'r72_web' THEN RAISE EXCEPTION 'MHP owner read boundary required' USING ERRCODE='42501'; END IF;
 -- Current135 function performs exact MHP native-session/owner check and retains all current counters.
 current_summary:=app_private.mhp_growth_summary(p_session);
 RETURN current_summary||jsonb_build_object(
  'applications',jsonb_build_object('total',(SELECT count(*) FROM app_private.mhp_applications),'today',(SELECT count(*) FROM app_private.mhp_applications WHERE created_at>=date_trunc('day',clock_timestamp()))),
  'applicationsByDoor',coalesce((SELECT jsonb_object_agg(door,n) FROM(SELECT door,count(*) n FROM app_private.mhp_applications GROUP BY door)d),'{}'::jsonb),
  'events',coalesce((SELECT jsonb_object_agg(name,n) FROM(SELECT name,sum(count) n FROM app_private.mhp_event_counts WHERE day>(clock_timestamp() AT TIME ZONE 'UTC')::date-30 GROUP BY name)e),'{}'::jsonb));
END $f$;

CREATE OR REPLACE FUNCTION app_private.mhp_unsubscribe_prospect(p_prospect uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 UPDATE app_private.mhp_prospects SET unsubscribed_at=coalesce(unsubscribed_at,clock_timestamp()),marketing_consent=false,updated_at=clock_timestamp() WHERE id=p_prospect;
 IF NOT FOUND THEN RETURN false; END IF;
 UPDATE app_private.mhp_marketing_sends s SET cancelled_at=clock_timestamp()
 WHERE s.prospect_id=p_prospect AND s.delivery_channel='email' AND s.sent_at IS NULL AND s.cancelled_at IS NULL AND s.failed_at IS NULL
  AND NOT(s.builtin_purpose IN('application_received','application_notify') AND EXISTS(SELECT 1 FROM app_private.mhp_applications a WHERE a.id=s.application_id AND a.prospect_id=s.prospect_id));
 RETURN true;
END $f$;

-- Same browser request does not require the separate marketing checkbox. All135 proof/JOIN gates remain.
CREATE OR REPLACE FUNCTION app_private.mhp_event_phone_from_signup(p_signup uuid,p_prospect uuid,p_campaign text,p_capability_sha bytea,p_source_sha bytea) RETURNS jsonb
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
  AND s.kind='webinar' AND (s.consent_given OR s.webinar_service_requested) AND s.source_hash=p_source_sha;
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
REVOKE ALL ON FUNCTION app_private.mhp_capture_signup_v3(text,text,text,boolean,text,text,text,text,text,bytea,jsonb,text,text),
 app_private.mhp_record_application(text,text,text,text,text,text,text,text,text,text,boolean,boolean,boolean,text,text,bytea,text),
 app_private.mhp_record_event(text,text),app_private.mhp_list_applications(bytea),app_private.mhp_list_registrants(bytea),
 app_private.mhp_growth_summary_v2(bytea),app_private.mhp_claim_marketing_sends_v2(integer,integer,text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.mhp_capture_signup_v3(text,text,text,boolean,text,text,text,text,text,bytea,jsonb,text,text),
 app_private.mhp_record_application(text,text,text,text,text,text,text,text,text,text,boolean,boolean,boolean,text,text,bytea,text),
 app_private.mhp_record_event(text,text),app_private.mhp_claim_marketing_sends_v2(integer,integer,text[]) TO r72_identity_command;
GRANT EXECUTE ON FUNCTION app_private.mhp_list_applications(bytea),app_private.mhp_list_registrants(bytea),app_private.mhp_growth_summary_v2(bytea) TO r72_web;
RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_mhp_prospect_definer;
RESET ROLE;
