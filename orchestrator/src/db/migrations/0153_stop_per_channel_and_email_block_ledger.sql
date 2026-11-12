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
--    Pinned to the Martin Howard Property and Property Predator workspaces, behind definer functions only. Nothing
--    lifts a hard bounce or a spam complaint automatically. The brand owner may lift a hard bounce for one address
--    with recorded evidence (who, when, why); a spam complaint has no owner lift (manual SQL runbook in the docs).
--    An unsubscribe is lifted by an explicit provider re-subscribe (compared by event time, so a late older
--    unsubscribe cannot undo a newer re-subscribe) and stops counting for marketing after a fresh sign-up (MHP) or a
--    newer granted marketing permission on that address (PP). A later genuine bounce re-arms a lifted hard bounce.
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
 lifted_by_user_id uuid,
 lift_note text CHECK(lift_note IS NULL OR (length(btrim(lift_note)) BETWEEN 3 AND 300 AND lift_note!~'[[:cntrl:]]')),
 UNIQUE(workspace_id,source_key,email,reason),
 -- A hard bounce or spam complaint stops all email; an unsubscribe stops marketing only.
 CHECK(scope=CASE reason WHEN 'unsubscribe' THEN 'marketing' ELSE 'all' END),
 -- A spam complaint is never lifted. A hard bounce is lifted only by a named owner with a reason (no provider event).
 CHECK(lifted_at IS NULL OR reason IN('unsubscribe','manual')
  OR (reason='hard_bounce' AND lifted_by_user_id IS NOT NULL AND lift_note IS NOT NULL AND lifted_event_id IS NULL)),
 CHECK(lifted_event_id IS NULL OR lifted_at IS NOT NULL),
 CHECK((lifted_by_user_id IS NULL)=(lift_note IS NULL) AND (lifted_by_user_id IS NULL OR lifted_at IS NOT NULL))
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
GRANT UPDATE(occurred_at,provider_event_id,stream,updated_at,lifted_at,lifted_event_id,lifted_by_user_id,lift_note) ON app_private.email_address_blocks TO r72_email_block_definer;
-- The owner lift authenticates the owner's own portal session, exactly as the owner pages do.
GRANT EXECUTE ON FUNCTION app_private.resolve_session(bytea),app_private.mhp_marketing_workspace_allowed(uuid,uuid),
 app_private.can_manage_workspace(uuid,uuid) TO r72_email_block_definer;

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
-- The owner's "this address works now" for a hard bounce: one purpose-free release by the named owner, nothing else.
CREATE POLICY pp_followup_bounce_release ON app.communication_suppression_events FOR INSERT TO r72_pp_followup_definer
 WITH CHECK(workspace_id='d975ff66-336a-46c2-b36b-d7095a11af97' AND channel='email' AND state='released' AND purpose IS NULL
  AND reason='owner_confirmed_working' AND source='pp.owner.email_health' AND actor_kind='user' AND actor_user_id IS NOT NULL);

GRANT CREATE ON SCHEMA app_private TO r72_email_block_definer,r72_pp_followup_definer;
SET LOCAL ROLE r72_email_block_definer;

-- Inner write shared by the webhook and the sweep. Idempotent on (workspace, source, address, reason): a replayed
-- event changes nothing; a newer unsubscribe moves the row forward (and re-blocks after a lift); a hard bounce or
-- spam complaint keeps its first time, except that a hard bounce the owner lifted is re-armed by a bounce that
-- happened after the lift. Times are event times, never arrival order. p_at NULL (a provider list row with no time)
-- records the first time it is seen and never moves a row forward.
CREATE FUNCTION app_private.email_block_put(p_workspace uuid,p_source text,p_email text,p_reason text,p_provider text,p_event text,p_stream text,p_at timestamptz)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE b app_private.email_address_blocks%ROWTYPE; v_email text:=lower(btrim(p_email));
BEGIN
 IF p_workspace IS NULL OR p_workspace NOT IN('2789228d-55a6-4688-b1e8-2f70abca990b','d975ff66-336a-46c2-b36b-d7095a11af97')
  OR p_source IS NULL OR p_source!~'^[a-z0-9][a-z0-9-]{0,39}$' OR p_reason IS NULL OR p_reason NOT IN('hard_bounce','spam_complaint','unsubscribe')
  OR p_provider IS DISTINCT FROM 'postmark' OR p_at>statement_timestamp()+interval '1 day'
  OR v_email IS NULL OR length(v_email) NOT BETWEEN 3 AND 320 OR v_email!~'^[^[:space:]@<>]+@[^[:space:]@<>]+\.[^[:space:]@<>]+$'
  OR (p_event IS NOT NULL AND p_event!~'^[!-~]{1,200}$') OR (p_stream IS NOT NULL AND p_stream!~'^[a-z0-9-]{1,60}$')
 THEN RAISE EXCEPTION 'Invalid email block' USING ERRCODE='22023'; END IF;
 INSERT INTO app_private.email_address_blocks(workspace_id,source_key,email,reason,scope,provider,provider_event_id,stream,occurred_at)
 VALUES(p_workspace,p_source,v_email,p_reason,CASE p_reason WHEN 'unsubscribe' THEN 'marketing' ELSE 'all' END,p_provider,p_event,p_stream,
  coalesce(p_at,statement_timestamp()))
 ON CONFLICT(workspace_id,source_key,email,reason) DO NOTHING;
 IF FOUND THEN RETURN 'recorded'; END IF;
 IF p_at IS NULL THEN RETURN 'exists'; END IF;
 SELECT * INTO b FROM app_private.email_address_blocks x WHERE x.workspace_id=p_workspace AND x.source_key=p_source AND x.email=v_email AND x.reason=p_reason FOR UPDATE;
 IF (b.reason='unsubscribe' AND p_at>b.occurred_at AND (b.lifted_at IS NULL OR p_at>b.lifted_at))
  OR (b.reason='hard_bounce' AND b.lifted_at IS NOT NULL AND p_at>b.lifted_at) THEN
  IF p_event IS NOT NULL AND p_event IS NOT DISTINCT FROM b.provider_event_id THEN RETURN 'exists'; END IF;
  UPDATE app_private.email_address_blocks SET occurred_at=p_at,provider_event_id=p_event,stream=coalesce(p_stream,stream),
   lifted_at=NULL,lifted_event_id=NULL,lifted_by_user_id=NULL,lift_note=NULL,updated_at=clock_timestamp() WHERE id=b.id;
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

-- One stream's provider suppression list (sweep), at most 1000 rows a call: [{email, reason, at}] where at may be
-- null (the provider gave no time). Returns {added, skipped}: a row that cannot be recorded is skipped and counted,
-- never failing the rows around it. A listed address whose unsubscribe was lifted after the listing time stays lifted.
CREATE FUNCTION app_private.email_block_record_list(p_workspace uuid,p_source text,p_stream text,p_rows jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE item jsonb; added integer:=0; skipped integer:=0;
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Email block boundary required' USING ERRCODE='42501'; END IF;
 IF p_rows IS NULL OR jsonb_typeof(p_rows)<>'array' OR jsonb_array_length(p_rows)>1000 THEN RAISE EXCEPTION 'Invalid email block list' USING ERRCODE='22023'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
  BEGIN
   IF jsonb_typeof(item)<>'object' OR jsonb_typeof(item->'email')<>'string' OR jsonb_typeof(item->'reason')<>'string'
    OR jsonb_typeof(item->'at') NOT IN('string','null') THEN RAISE EXCEPTION 'Invalid email block row' USING ERRCODE='22023'; END IF;
   IF app_private.email_block_put(p_workspace,p_source,item->>'email',item->>'reason','postmark',NULL,p_stream,(item->>'at')::timestamptz)='recorded'
   THEN added:=added+1; END IF;
  EXCEPTION WHEN data_exception OR integrity_constraint_violation THEN skipped:=skipped+1;
  END;
 END LOOP;
 RETURN jsonb_build_object('added',added,'skipped',skipped);
END $f$;

-- An explicit provider re-subscribe lifts an unsubscribe from that source, and nothing else. When no unsubscribe is
-- known yet (the re-subscribe overtook a retried, older unsubscribe), a lifted tombstone is written at the
-- re-subscribe's own time, so the late older unsubscribe finds it and does not block. Compared by event time only.
CREATE FUNCTION app_private.email_block_lift(p_workspace uuid,p_source text,p_email text,p_event text,p_at timestamptz)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE lifted integer; v_email text:=lower(btrim(p_email));
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Email block boundary required' USING ERRCODE='42501'; END IF;
 IF p_at IS NULL OR p_at>statement_timestamp()+interval '1 day' OR (p_event IS NOT NULL AND p_event!~'^[!-~]{1,200}$') THEN
  RAISE EXCEPTION 'Invalid email block lift' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('email-block:'||p_workspace::text||':'||coalesce(v_email,''),153));
 UPDATE app_private.email_address_blocks SET lifted_at=p_at,lifted_event_id=p_event,updated_at=clock_timestamp()
 WHERE workspace_id=p_workspace AND source_key=p_source AND email=v_email AND reason='unsubscribe'
  AND occurred_at<p_at AND (lifted_at IS NULL OR lifted_at<p_at);
 GET DIAGNOSTICS lifted=ROW_COUNT;
 IF lifted=0 AND NOT EXISTS(SELECT 1 FROM app_private.email_address_blocks WHERE workspace_id=p_workspace AND source_key=p_source
   AND email=v_email AND reason='unsubscribe') THEN
  -- Validated by the same rules as any other write; the tombstone blocks nothing.
  PERFORM app_private.email_block_put(p_workspace,p_source,v_email,'unsubscribe','postmark',NULL,NULL,p_at);
  UPDATE app_private.email_address_blocks SET lifted_at=p_at,lifted_event_id=p_event,updated_at=clock_timestamp()
  WHERE workspace_id=p_workspace AND source_key=p_source AND email=v_email AND reason='unsubscribe';
 END IF;
 RETURN lifted;
END $f$;

-- The brand owner says a hard-bounced address works now. The owner's own portal session is checked here: the MHP
-- marketing owner in the MHP brand workspace, or a manager of the Property Predator workspace with it selected.
-- Lifts every hard-bounce row for that address in that brand with who, when and why; a spam complaint is never
-- lifted. For Property Predator the CRM stop written by that bounce is released too, so PP sends can go again.
CREATE FUNCTION app_private.email_block_owner_lift(p_session bytea,p_workspace uuid,p_email text,p_note text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; selected uuid; allowed boolean; v_email text:=lower(btrim(p_email)); lifted integer; released integer:=0; spam boolean;
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Email block boundary required' USING ERRCODE='42501'; END IF;
 IF p_session IS NULL OR octet_length(p_session)<>32 OR p_workspace IS NULL OR v_email IS NULL OR length(v_email) NOT BETWEEN 3 AND 320
  OR p_note IS NULL OR length(btrim(p_note)) NOT BETWEEN 3 AND 300 OR p_note~'[[:cntrl:]]' THEN
  RAISE EXCEPTION 'Invalid email block lift' USING ERRCODE='22023'; END IF;
 SELECT r.user_id,r.selected_workspace_id INTO actor,selected FROM app_private.resolve_session(p_session) r;
 allowed:=actor IS NOT NULL AND selected IS NOT DISTINCT FROM p_workspace AND coalesce(CASE p_workspace
   WHEN '2789228d-55a6-4688-b1e8-2f70abca990b' THEN app_private.mhp_marketing_workspace_allowed(actor,p_workspace)
   WHEN 'd975ff66-336a-46c2-b36b-d7095a11af97' THEN app_private.can_manage_workspace(actor,p_workspace)
   ELSE false END,false);
 IF NOT allowed THEN RAISE EXCEPTION 'Brand owner required' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('email-block:'||p_workspace::text||':'||v_email,153));
 UPDATE app_private.email_address_blocks SET lifted_at=statement_timestamp(),lifted_by_user_id=actor,lift_note=btrim(p_note),updated_at=clock_timestamp()
 WHERE workspace_id=p_workspace AND email=v_email AND reason='hard_bounce' AND lifted_at IS NULL;
 GET DIAGNOSTICS lifted=ROW_COUNT;
 IF lifted>0 AND p_workspace='d975ff66-336a-46c2-b36b-d7095a11af97' THEN
  released:=app_private.pp_followup_release_bounce(v_email,actor,btrim(p_note));
 END IF;
 spam:=EXISTS(SELECT 1 FROM app_private.email_address_blocks WHERE workspace_id=p_workspace AND email=v_email AND reason='spam_complaint' AND lifted_at IS NULL);
 RETURN jsonb_build_object('lifted',lifted,'released',released,'spamComplaint',spam,'liftedAt',statement_timestamp());
END $f$;

-- True when the person signed up again, or gave marketing permission again, after p_since (the unsubscribe).
CREATE FUNCTION app_private.email_block_signed_up_since(p_workspace uuid,p_email text,p_since timestamptz)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT CASE p_workspace
  WHEN '2789228d-55a6-4688-b1e8-2f70abca990b' THEN EXISTS(SELECT 1 FROM app_private.mhp_prospects p JOIN app_private.mhp_prospect_signups g ON g.prospect_id=p.id
   WHERE p.email::text=p_email AND g.created_at>p_since)
  WHEN 'd975ff66-336a-46c2-b36b-d7095a11af97' THEN EXISTS(SELECT 1 FROM app.contact_points p JOIN app.communication_consent_events c
    ON c.workspace_id=p.workspace_id AND c.contact_point_id=p.id
   WHERE p.workspace_id='d975ff66-336a-46c2-b36b-d7095a11af97' AND p.kind='email' AND p.deleted_at IS NULL AND p.normalized_value=p_email
    AND c.channel='email' AND c.purpose IN('marketing','property_predator_marketing') AND c.state='granted' AND c.occurred_at>p_since)
  ELSE false END
$f$;

-- What a send guard asks: may this brand email this address for this purpose? Pure read.
-- {blocked, reason, scope, since, reallowed, clearedAt}: reallowed is true when an unsubscribe exists but a sign-up
-- since lets marketing go again. clearedAt is the latest event time up to which this ledger has cleared the address
-- (a lift, or the time of a re-allowed unsubscribe): the process cache ignores its own copies of blocks at or before
-- it, and still counts a block that happened after it.
CREATE FUNCTION app_private.email_block_decide(p_workspace uuid,p_email text,p_purpose text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE v_email text:=lower(btrim(p_email)); b app_private.email_address_blocks%ROWTYPE; reallowed boolean:=false; cleared timestamptz;
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Email block boundary required' USING ERRCODE='42501'; END IF;
 IF p_purpose IS NULL OR p_purpose NOT IN('marketing','service') THEN RAISE EXCEPTION 'Invalid email purpose' USING ERRCODE='22023'; END IF;
 IF p_workspace IS NULL OR v_email IS NULL THEN RETURN jsonb_build_object('blocked',false,'reallowed',false,'clearedAt',NULL); END IF;
 SELECT max(x.lifted_at) INTO cleared FROM app_private.email_address_blocks x WHERE x.workspace_id=p_workspace AND x.email=v_email AND x.lifted_at IS NOT NULL;
 SELECT * INTO b FROM app_private.email_address_blocks x WHERE x.workspace_id=p_workspace AND x.email=v_email AND x.lifted_at IS NULL AND x.scope='all'
 ORDER BY CASE x.reason WHEN 'hard_bounce' THEN 0 WHEN 'spam_complaint' THEN 1 ELSE 2 END,x.occurred_at,x.id LIMIT 1;
 IF FOUND THEN RETURN jsonb_build_object('blocked',true,'reason',b.reason,'scope',b.scope,'since',b.occurred_at,'reallowed',false,'clearedAt',cleared); END IF;
 IF p_purpose='marketing' THEN
  FOR b IN SELECT * FROM app_private.email_address_blocks x WHERE x.workspace_id=p_workspace AND x.email=v_email AND x.lifted_at IS NULL AND x.scope='marketing'
   ORDER BY x.occurred_at DESC,x.id LOOP
   IF NOT app_private.email_block_signed_up_since(p_workspace,v_email,b.occurred_at) THEN
    RETURN jsonb_build_object('blocked',true,'reason',b.reason,'scope',b.scope,'since',b.occurred_at,'reallowed',false,'clearedAt',cleared);
   END IF;
   reallowed:=true; cleared:=greatest(cleared,b.occurred_at);
  END LOOP;
 END IF;
 RETURN jsonb_build_object('blocked',false,'reallowed',reallowed,'clearedAt',cleared);
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
 app_private.email_block_decide(uuid,text,text),app_private.email_block_rows(uuid,integer),
 app_private.email_block_owner_lift(bytea,uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.email_block_record(uuid,text,text,text,text,text,timestamptz),app_private.email_block_record_list(uuid,text,text,jsonb),
 app_private.email_block_lift(uuid,text,text,text,timestamptz),app_private.email_block_decide(uuid,text,text),app_private.email_block_rows(uuid,integer),
 app_private.email_block_owner_lift(bytea,uuid,text,text) TO r72_identity_command;

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

-- The owner lifted a hard bounce (email_block_owner_lift, which checked the owner's session): append a purpose-free
-- 'released' event on every PP email point with that address whose current purpose-free stop is a hard bounce, so the
-- PP send gate allows it again. A stop for any other reason (a spam report, a manual stop) is left alone. Only the
-- email block definer may call this.
CREATE FUNCTION app_private.pp_followup_release_bounce(p_email text,p_actor uuid,p_note text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE p record; latest record; released integer:=0;
BEGIN
 IF p_email IS NULL OR p_actor IS NULL OR p_note IS NULL THEN RAISE EXCEPTION 'Invalid email release' USING ERRCODE='22023'; END IF;
 FOR p IN SELECT x.id,x.contact_id,public.digest(x.kind||chr(31)||x.value||chr(31)||x.normalized_value,'sha256') AS identity
  FROM app.contact_points x WHERE x.workspace_id='d975ff66-336a-46c2-b36b-d7095a11af97' AND x.kind='email' AND x.normalized_value=p_email
  ORDER BY x.id LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended('pp-followup-unsubscribe:'||p.id::text,7200152));
  SELECT s.state,s.reason INTO latest FROM app.communication_suppression_events s WHERE s.workspace_id='d975ff66-336a-46c2-b36b-d7095a11af97'
   AND s.contact_point_id=p.id AND s.channel='email' AND s.purpose IS NULL AND s.endpoint_identity_sha256=p.identity
  ORDER BY s.occurred_at DESC,s.recorded_at DESC,s.id DESC LIMIT 1;
  IF latest.state='suppressed' AND latest.reason='hard_bounce' THEN
   INSERT INTO app.communication_suppression_events(workspace_id,contact_id,contact_point_id,channel,purpose,state,reason,source,actor_kind,actor_user_id,evidence,occurred_at)
   VALUES('d975ff66-336a-46c2-b36b-d7095a11af97',p.contact_id,p.id,'email',NULL,'released','owner_confirmed_working','pp.owner.email_health','user',p_actor,
    jsonb_build_object('route','owner_email_health','note',p_note),statement_timestamp());
   released:=released+1;
  END IF;
 END LOOP;
 RETURN released;
END $f$;
REVOKE ALL ON FUNCTION app_private.pp_followup_release_bounce(text,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.pp_followup_release_bounce(text,uuid,text) TO r72_email_block_definer;

RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_email_block_definer,r72_pp_followup_definer;
RESET ROLE;
