-- 0153: a STOP applies only to its own channel, and a durable email block ledger with true reasons.
-- Additive. No row is deleted or rewritten, no table is altered and no trigger is added.
--
-- A. Owner rule (12 November 2026): "any stop message only applies to that channel". 0151 let a current SMS
--    suppression on the original brand's contact block an owner one-to-one WhatsApp send. From here only a WhatsApp
--    suppression, the contact point's own consent_status='opted_out', a removed picked point, a signed WhatsApp STOP
--    and the MHP number-level blocks stop a WhatsApp send. The function keeps its signature, owner and grants; the
--    worker's read policy narrows to WhatsApp rows. Code released before 0153 calls the same function unchanged.
--
-- B. app_private.email_address_blocks: one row per brand workspace, email source, address and reason (hard bounce,
--    spam complaint, unsubscribe, manual) with its scope (all email, or marketing only), written by the Postmark
--    webhook and the catch-up sweep and read by every send guard; the process memory becomes a cache in front of it.
--    Pinned to the Martin Howard Property and Property Predator workspaces, behind definer functions only. Hard
--    bounces and spam complaints can never be lifted automatically; an unsubscribe is lifted by an explicit
--    provider re-subscribe and stops counting for marketing after a fresh sign-up (MHP) or a newer granted
--    marketing permission on that address (PP).
--    No message body, header or provider payload is stored: address, reason, scope, provider, event id, stream and
--    the two times only.
--
-- C. Property Predator: app_private.pp_followup_block_email records a bounce, complaint or provider unsubscribe in
--    the CRM with its true reason (hard_bounce / spam_complaint purpose-free; recipient_unsubscribe for the two PP
--    marketing purposes), instead of labelling every one 'recipient_unsubscribe'. Historic rows are left as they
--    are: the suppression ledger is append-only and the old bounce rows cannot be told apart from real unsubscribes.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

DO $role$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='r72_email_block_definer') THEN
    CREATE ROLE r72_email_block_definer NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='r72_email_block_definer' AND NOT rolcanlogin AND NOT rolinherit
      AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls)
    OR EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname='r72_email_block_definer') THEN
    RAISE EXCEPTION 'Unsafe email block function-owner attributes' USING ERRCODE='42501';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles p ON p.oid=m.roleid JOIN pg_roles c ON c.oid=m.member
    WHERE p.rolname='r72_email_block_definer' AND c.rolname NOT IN ('r72_owner',current_user)) THEN
    RAISE EXCEPTION 'Runtime membership in email block function owner denied' USING ERRCODE='42501';
  END IF;
  GRANT r72_email_block_definer TO r72_owner;
END $role$;

SET LOCAL ROLE r72_owner;

-- A. The original brand's own record, WhatsApp only. Every phone/WhatsApp point of the original contact that carries
-- the number counts, whether the owner picked the point or typed the number: its opt-out (consent_status), or a
-- current WhatsApp suppression (a WhatsApp STOP), blocks; so does a picked point that has since been removed. An SMS
-- or email suppression never blocks WhatsApp. Read at link, at queue and again at begin-call.
CREATE OR REPLACE FUNCTION app_private.mhp_wa_owner_origin_blocked(p_origin_workspace uuid,p_origin_contact uuid,p_origin_point uuid,p_number text) RETURNS text
LANGUAGE sql STABLE SET search_path=pg_catalog AS $f$
 SELECT CASE
  WHEN p_origin_point IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app.contact_points p WHERE p.workspace_id=p_origin_workspace AND p.id=p_origin_point
   AND p.contact_id=p_origin_contact AND p.deleted_at IS NULL) THEN 'number_not_found'
  WHEN EXISTS(SELECT 1 FROM app.contact_points p WHERE p.workspace_id=p_origin_workspace AND p.contact_id=p_origin_contact AND p.kind IN('whatsapp','phone')
   AND (p.id=p_origin_point OR app_private.mhp_wa_owner_number(p.normalized_value)=p_number OR app_private.mhp_wa_owner_number(p.value)=p_number)
   AND (p.consent_status='opted_out' OR EXISTS(SELECT 1 FROM (SELECT DISTINCT ON (coalesce(s.purpose,'')) s.state
     FROM app.communication_suppression_events s WHERE s.workspace_id=p.workspace_id AND s.contact_point_id=p.id AND s.channel='whatsapp'
     ORDER BY coalesce(s.purpose,''),s.occurred_at DESC,s.recorded_at DESC,s.id DESC) latest WHERE latest.state='suppressed'))) THEN 'opted_out'
 END
$f$;
REVOKE ALL ON FUNCTION app_private.mhp_wa_owner_origin_blocked(uuid,uuid,uuid,text) FROM PUBLIC;
-- Begin-call re-reads the original brand's own opt-out: the worker may see only the points and WhatsApp suppressions
-- of an original contact the owner has linked, nothing else outside MHP.
ALTER POLICY mhp_wa_owner_origin_suppressions_worker ON app.communication_suppression_events
 USING(session_user='r72_whatsapp_live_worker_command' AND current_setting('app.workspace_id',true)='2789228d-55a6-4688-b1e8-2f70abca990b'
  AND current_setting('app.actor_kind',true)='worker' AND channel='whatsapp'
  AND EXISTS(SELECT 1 FROM app_private.mhp_wa_owner_links l WHERE l.origin_workspace_id=communication_suppression_events.workspace_id
   AND l.origin_contact_id=communication_suppression_events.contact_id));

-- B. The durable email block ledger.
CREATE TABLE app_private.email_address_blocks(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL CHECK(workspace_id IN('2789228d-55a6-4688-b1e8-2f70abca990b','d975ff66-336a-46c2-b36b-d7095a11af97')),
 source_key text NOT NULL CHECK(source_key~'^[a-z0-9][a-z0-9-]{0,39}$'),
 email text NOT NULL CHECK(email=lower(btrim(email)) AND length(email) BETWEEN 3 AND 320 AND email~'^[^[:space:]@<>]+@[^[:space:]@<>]+\.[^[:space:]@<>]+$'),
 reason text NOT NULL CHECK(reason IN('hard_bounce','spam_complaint','unsubscribe','manual')),
 scope text NOT NULL CHECK(scope IN('all','marketing')),
 provider text NOT NULL CHECK(provider IN('postmark','owner')),
 provider_event_id text CHECK(provider_event_id IS NULL OR provider_event_id~'^[!-~]{1,200}$'),
 stream text CHECK(stream IS NULL OR stream~'^[a-z0-9-]{1,60}$'),
 occurred_at timestamptz NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 lifted_at timestamptz,
 lifted_event_id text CHECK(lifted_event_id IS NULL OR lifted_event_id~'^[!-~]{1,200}$'),
 UNIQUE(workspace_id,source_key,email,reason),
 -- A hard bounce or spam complaint stops all email; an unsubscribe stops marketing only.
 CHECK(scope=CASE reason WHEN 'unsubscribe' THEN 'marketing' ELSE 'all' END),
 -- Nothing lifts a hard bounce or a spam complaint automatically.
 CHECK(lifted_at IS NULL OR reason IN('unsubscribe','manual')),
 CHECK(lifted_event_id IS NULL OR lifted_at IS NOT NULL)
);
CREATE INDEX email_address_blocks_address ON app_private.email_address_blocks(workspace_id,email);
CREATE INDEX email_address_blocks_recent ON app_private.email_address_blocks(workspace_id,occurred_at DESC,id) WHERE lifted_at IS NULL;
ALTER TABLE app_private.email_address_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.email_address_blocks FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.email_address_blocks FROM PUBLIC;
CREATE POLICY email_address_blocks_owner ON app_private.email_address_blocks TO r72_owner USING(true) WITH CHECK(true);
CREATE POLICY email_address_blocks_definer ON app_private.email_address_blocks TO r72_email_block_definer
 USING(session_user='r72_identity_command' AND workspace_id IN('2789228d-55a6-4688-b1e8-2f70abca990b','d975ff66-336a-46c2-b36b-d7095a11af97'))
 WITH CHECK(session_user='r72_identity_command' AND workspace_id IN('2789228d-55a6-4688-b1e8-2f70abca990b','d975ff66-336a-46c2-b36b-d7095a11af97'));
INSERT INTO app_private.workspace_table_registry(schema_name,table_name,workspace_column) VALUES('app_private','email_address_blocks','workspace_id');
GRANT SELECT,INSERT ON app_private.email_address_blocks TO r72_email_block_definer;
GRANT UPDATE(occurred_at,provider_event_id,stream,updated_at,lifted_at,lifted_event_id) ON app_private.email_address_blocks TO r72_email_block_definer;

-- "Signed up since" reads, nothing else: MHP sign-ups by address, and PP email permission grants by address.
GRANT USAGE ON SCHEMA app,app_private TO r72_email_block_definer;
GRANT SELECT ON app_private.mhp_prospects,app_private.mhp_prospect_signups TO r72_email_block_definer;
CREATE POLICY email_block_mhp_prospects_read ON app_private.mhp_prospects FOR SELECT TO r72_email_block_definer
 USING(session_user='r72_identity_command');
CREATE POLICY email_block_mhp_signups_read ON app_private.mhp_prospect_signups FOR SELECT TO r72_email_block_definer
 USING(session_user='r72_identity_command');
GRANT SELECT ON app.contact_points,app.communication_consent_events TO r72_email_block_definer;
CREATE POLICY email_block_pp_points_read ON app.contact_points FOR SELECT TO r72_email_block_definer
 USING(session_user='r72_identity_command' AND workspace_id='d975ff66-336a-46c2-b36b-d7095a11af97' AND kind='email');
CREATE POLICY email_block_pp_consent_read ON app.communication_consent_events FOR SELECT TO r72_email_block_definer
 USING(session_user='r72_identity_command' AND workspace_id='d975ff66-336a-46c2-b36b-d7095a11af97' AND channel='email');

-- C. Property Predator's true-reason CRM stop: purpose-free for a dead address or a spam report (all PP email),
-- the two PP marketing purposes for a provider unsubscribe. System actor only, email only.
CREATE POLICY pp_followup_bounce_suppression ON app.communication_suppression_events FOR INSERT TO r72_pp_followup_definer
 WITH CHECK(workspace_id='d975ff66-336a-46c2-b36b-d7095a11af97' AND channel='email' AND state='suppressed' AND source='pp.postmark.bounce'
  AND actor_kind='system' AND actor_user_id IS NULL
  AND ((reason IN('hard_bounce','spam_complaint') AND purpose IS NULL)
   OR (reason='recipient_unsubscribe' AND purpose IN('marketing','property_predator_marketing'))));

GRANT CREATE ON SCHEMA app_private TO r72_email_block_definer,r72_pp_followup_definer;
SET LOCAL ROLE r72_email_block_definer;

-- Inner write shared by the webhook and the sweep. Idempotent on (workspace, source, address, reason): a replayed
-- event changes nothing; a newer unsubscribe moves the row forward (and re-blocks after a lift); a hard bounce or
-- spam complaint keeps its first time.
CREATE FUNCTION app_private.email_block_put(p_workspace uuid,p_source text,p_email text,p_reason text,p_provider text,p_event text,p_stream text,p_at timestamptz)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE b app_private.email_address_blocks%ROWTYPE; v_email text:=lower(btrim(p_email));
BEGIN
 IF p_workspace IS NULL OR p_workspace NOT IN('2789228d-55a6-4688-b1e8-2f70abca990b','d975ff66-336a-46c2-b36b-d7095a11af97')
  OR p_source IS NULL OR p_source!~'^[a-z0-9][a-z0-9-]{0,39}$' OR p_reason IS NULL OR p_reason NOT IN('hard_bounce','spam_complaint','unsubscribe')
  OR p_provider IS DISTINCT FROM 'postmark' OR p_at IS NULL OR p_at>statement_timestamp()+interval '1 day'
  OR v_email IS NULL OR length(v_email) NOT BETWEEN 3 AND 320 OR v_email!~'^[^[:space:]@<>]+@[^[:space:]@<>]+\.[^[:space:]@<>]+$'
  OR (p_event IS NOT NULL AND p_event!~'^[!-~]{1,200}$') OR (p_stream IS NOT NULL AND p_stream!~'^[a-z0-9-]{1,60}$')
 THEN RAISE EXCEPTION 'Invalid email block' USING ERRCODE='22023'; END IF;
 INSERT INTO app_private.email_address_blocks(workspace_id,source_key,email,reason,scope,provider,provider_event_id,stream,occurred_at)
 VALUES(p_workspace,p_source,v_email,p_reason,CASE p_reason WHEN 'unsubscribe' THEN 'marketing' ELSE 'all' END,p_provider,p_event,p_stream,p_at)
 ON CONFLICT(workspace_id,source_key,email,reason) DO NOTHING;
 IF FOUND THEN RETURN 'recorded'; END IF;
 SELECT * INTO b FROM app_private.email_address_blocks x WHERE x.workspace_id=p_workspace AND x.source_key=p_source AND x.email=v_email AND x.reason=p_reason FOR UPDATE;
 IF b.reason='unsubscribe' AND p_at>b.occurred_at AND (b.lifted_at IS NULL OR p_at>b.lifted_at)
  AND (p_event IS NULL OR p_event IS DISTINCT FROM b.provider_event_id) THEN
  UPDATE app_private.email_address_blocks SET occurred_at=p_at,provider_event_id=p_event,stream=coalesce(p_stream,stream),
   lifted_at=NULL,lifted_event_id=NULL,updated_at=clock_timestamp() WHERE id=b.id;
  RETURN 'renewed';
 END IF;
 RETURN 'exists';
END $f$;

-- One provider event (webhook): 'recorded', 'renewed' or 'exists'.
CREATE FUNCTION app_private.email_block_record(p_workspace uuid,p_source text,p_email text,p_reason text,p_event text,p_stream text,p_at timestamptz)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Email block boundary required' USING ERRCODE='42501'; END IF;
 RETURN app_private.email_block_put(p_workspace,p_source,p_email,p_reason,'postmark',p_event,p_stream,p_at);
END $f$;

-- One stream's provider suppression list (sweep), at most 1000 rows a call: [{email, reason, at}]. Returns how many
-- rows were new. A listed address whose unsubscribe was lifted after the listing time stays lifted.
CREATE FUNCTION app_private.email_block_record_list(p_workspace uuid,p_source text,p_stream text,p_rows jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE item jsonb; added integer:=0;
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Email block boundary required' USING ERRCODE='42501'; END IF;
 IF p_rows IS NULL OR jsonb_typeof(p_rows)<>'array' OR jsonb_array_length(p_rows)>1000 THEN RAISE EXCEPTION 'Invalid email block list' USING ERRCODE='22023'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
  IF jsonb_typeof(item)<>'object' OR jsonb_typeof(item->'email')<>'string' OR jsonb_typeof(item->'reason')<>'string' OR jsonb_typeof(item->'at')<>'string'
  THEN RAISE EXCEPTION 'Invalid email block list' USING ERRCODE='22023'; END IF;
  IF app_private.email_block_put(p_workspace,p_source,item->>'email',item->>'reason','postmark',NULL,p_stream,(item->>'at')::timestamptz)='recorded'
  THEN added:=added+1; END IF;
 END LOOP;
 RETURN added;
END $f$;

-- An explicit provider re-subscribe lifts an unsubscribe from that source, and nothing else.
CREATE FUNCTION app_private.email_block_lift(p_workspace uuid,p_source text,p_email text,p_event text,p_at timestamptz)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE lifted integer;
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Email block boundary required' USING ERRCODE='42501'; END IF;
 IF p_at IS NULL OR p_email IS NULL OR (p_event IS NOT NULL AND p_event!~'^[!-~]{1,200}$') THEN RAISE EXCEPTION 'Invalid email block lift' USING ERRCODE='22023'; END IF;
 UPDATE app_private.email_address_blocks SET lifted_at=p_at,lifted_event_id=p_event,updated_at=clock_timestamp()
 WHERE workspace_id=p_workspace AND source_key=p_source AND email=lower(btrim(p_email)) AND reason='unsubscribe' AND lifted_at IS NULL AND occurred_at<p_at;
 GET DIAGNOSTICS lifted=ROW_COUNT;
 RETURN lifted;
END $f$;

-- True when the person signed up again, or gave marketing permission again, after p_since (the unsubscribe).
CREATE FUNCTION app_private.email_block_signed_up_since(p_workspace uuid,p_email text,p_since timestamptz)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT CASE p_workspace
  WHEN '2789228d-55a6-4688-b1e8-2f70abca990b' THEN EXISTS(SELECT 1 FROM app_private.mhp_prospects p JOIN app_private.mhp_prospect_signups g ON g.prospect_id=p.id
   WHERE p.email::text=p_email AND g.created_at>p_since)
  WHEN 'd975ff66-336a-46c2-b36b-d7095a11af97' THEN EXISTS(SELECT 1 FROM app.contact_points p JOIN app.communication_consent_events c
    ON c.workspace_id=p.workspace_id AND c.contact_point_id=p.id
   WHERE p.workspace_id='d975ff66-336a-46c2-b36b-d7095a11af97' AND p.kind='email' AND p.deleted_at IS NULL AND lower(p.normalized_value)=p_email
    AND c.channel='email' AND c.purpose IN('marketing','property_predator_marketing') AND c.state='granted' AND c.occurred_at>p_since)
  ELSE false END
$f$;

-- What a send guard asks: may this brand email this address for this purpose? Pure read.
-- {blocked, reason, scope, since, reallowed}: reallowed is true when an unsubscribe exists but a sign-up since lets
-- marketing go again (the process cache then ignores its own copy of that unsubscribe).
CREATE FUNCTION app_private.email_block_decide(p_workspace uuid,p_email text,p_purpose text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE v_email text:=lower(btrim(p_email)); b app_private.email_address_blocks%ROWTYPE; reallowed boolean:=false;
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Email block boundary required' USING ERRCODE='42501'; END IF;
 IF p_purpose IS NULL OR p_purpose NOT IN('marketing','service') THEN RAISE EXCEPTION 'Invalid email purpose' USING ERRCODE='22023'; END IF;
 IF p_workspace IS NULL OR v_email IS NULL THEN RETURN jsonb_build_object('blocked',false,'reallowed',false); END IF;
 SELECT * INTO b FROM app_private.email_address_blocks x WHERE x.workspace_id=p_workspace AND x.email=v_email AND x.lifted_at IS NULL AND x.scope='all'
 ORDER BY CASE x.reason WHEN 'hard_bounce' THEN 0 WHEN 'spam_complaint' THEN 1 ELSE 2 END,x.occurred_at,x.id LIMIT 1;
 IF FOUND THEN RETURN jsonb_build_object('blocked',true,'reason',b.reason,'scope',b.scope,'since',b.occurred_at,'reallowed',false); END IF;
 IF p_purpose='marketing' THEN
  FOR b IN SELECT * FROM app_private.email_address_blocks x WHERE x.workspace_id=p_workspace AND x.email=v_email AND x.lifted_at IS NULL AND x.scope='marketing'
   ORDER BY x.occurred_at DESC,x.id LOOP
   IF NOT app_private.email_block_signed_up_since(p_workspace,v_email,b.occurred_at) THEN
    RETURN jsonb_build_object('blocked',true,'reason',b.reason,'scope',b.scope,'since',b.occurred_at,'reallowed',false);
   END IF;
   reallowed:=true;
  END LOOP;
 END IF;
 RETURN jsonb_build_object('blocked',false,'reallowed',reallowed);
END $f$;

-- The owner page and the process cache: current (unlifted) rows for one brand, newest first, at most p_limit.
CREATE FUNCTION app_private.email_block_rows(p_workspace uuid,p_limit integer)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Email block boundary required' USING ERRCODE='42501'; END IF;
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 20000 THEN RAISE EXCEPTION 'Invalid email block limit' USING ERRCODE='22023'; END IF;
 RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('email',r.email,'reason',r.reason,'scope',r.scope,'source',r.source_key,'stream',r.stream,
   'since',r.occurred_at,'reallowed',r.scope='marketing' AND app_private.email_block_signed_up_since(p_workspace,r.email,r.occurred_at)) ORDER BY r.occurred_at DESC,r.id)
  FROM (SELECT * FROM app_private.email_address_blocks x WHERE x.workspace_id=p_workspace AND x.lifted_at IS NULL ORDER BY x.occurred_at DESC,x.id LIMIT p_limit) r),'[]'::jsonb);
END $f$;

REVOKE ALL ON FUNCTION app_private.email_block_put(uuid,text,text,text,text,text,text,timestamptz),
 app_private.email_block_record(uuid,text,text,text,text,text,timestamptz),app_private.email_block_record_list(uuid,text,text,jsonb),
 app_private.email_block_lift(uuid,text,text,text,timestamptz),app_private.email_block_signed_up_since(uuid,text,timestamptz),
 app_private.email_block_decide(uuid,text,text),app_private.email_block_rows(uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.email_block_record(uuid,text,text,text,text,text,timestamptz),app_private.email_block_record_list(uuid,text,text,jsonb),
 app_private.email_block_lift(uuid,text,text,text,timestamptz),app_private.email_block_decide(uuid,text,text),app_private.email_block_rows(uuid,integer)
 TO r72_identity_command;

RESET ROLE;
SET LOCAL ROLE r72_pp_followup_definer;

-- C. A bounce, spam report or provider unsubscribe reported for a Property Predator email we sent (the contact point
-- travels in the message metadata): append the CRM email suppression with its true reason and stop the address's open
-- follow-up runs. Same locking, endpoint identity and idempotency as pp_followup_unsubscribe (0152), which is unchanged.
CREATE FUNCTION app_private.pp_followup_block_email(p_point uuid,p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE endpoint record; scope text; scopes text[]; label text; latest text; recorded boolean:=false; stopped integer:=0; r record;
BEGIN
 IF p_point IS NULL OR p_reason IS NULL OR p_reason NOT IN('hard_bounce','spam_complaint','unsubscribe') THEN
  RAISE EXCEPTION 'Invalid email block' USING ERRCODE='22023'; END IF;
 SELECT p.contact_id,public.digest(p.kind||chr(31)||p.value||chr(31)||p.normalized_value,'sha256') AS identity INTO endpoint
 FROM app.contact_points p WHERE p.workspace_id='d975ff66-336a-46c2-b36b-d7095a11af97' AND p.id=p_point AND p.kind='email';
 IF endpoint.contact_id IS NULL THEN RETURN jsonb_build_object('known',false,'recorded',false,'stopped',0); END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('pp-followup-unsubscribe:'||p_point::text,7200152));
 label:=CASE p_reason WHEN 'unsubscribe' THEN 'recipient_unsubscribe' ELSE p_reason END;
 scopes:=CASE p_reason WHEN 'unsubscribe' THEN ARRAY['marketing','property_predator_marketing'] ELSE ARRAY[NULL::text] END;
 FOREACH scope IN ARRAY scopes LOOP
  latest:=NULL;
  SELECT s.state INTO latest FROM app.communication_suppression_events s WHERE s.workspace_id='d975ff66-336a-46c2-b36b-d7095a11af97'
   AND s.contact_point_id=p_point AND s.channel='email' AND s.purpose IS NOT DISTINCT FROM scope AND s.endpoint_identity_sha256=endpoint.identity
  ORDER BY s.occurred_at DESC,s.recorded_at DESC,s.id DESC LIMIT 1;
  IF latest IS DISTINCT FROM 'suppressed' THEN
   INSERT INTO app.communication_suppression_events(workspace_id,contact_id,contact_point_id,channel,purpose,state,reason,source,actor_kind,evidence,occurred_at)
   VALUES('d975ff66-336a-46c2-b36b-d7095a11af97',endpoint.contact_id,p_point,'email',scope,'suppressed',label,'pp.postmark.bounce','system',
    jsonb_build_object('route','postmark_webhook'),statement_timestamp());
   recorded:=true;
  END IF;
 END LOOP;
 FOR r IN SELECT id FROM app_private.pp_followup_runs WHERE contact_point_id=p_point AND state IN('active','paused','held') ORDER BY id FOR UPDATE LOOP
  PERFORM app_private.pp_followup_end_run(r.id,'stopped',CASE p_reason WHEN 'hard_bounce' THEN 'delivery_failed' ELSE 'unsubscribed' END); stopped:=stopped+1;
 END LOOP;
 RETURN jsonb_build_object('known',true,'recorded',recorded,'stopped',stopped,'reason',label);
END $f$;
REVOKE ALL ON FUNCTION app_private.pp_followup_block_email(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.pp_followup_block_email(uuid,text) TO r72_identity_command;

RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_email_block_definer,r72_pp_followup_definer;
RESET ROLE;
