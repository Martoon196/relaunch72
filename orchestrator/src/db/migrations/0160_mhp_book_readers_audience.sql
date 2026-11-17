-- 0160: who a follow-up sequence is for, enforced by the database, and the Before You Buy "book readers" audience.
--
-- The audience is the one the owner chose and saved with the sequence version: metadata.mhpSequence.audience
-- = {"schema":"mhp.followup-sequence-audience/v1","kind":"webinar_signups"|"book_readers"|"none_yet","campaign":…}
-- (src/followup-sequences/audience.ts writes exactly that; versions are append-only, so it is immutable with the
-- version). A version saved before audiences existed has no such key and is "none yet": it can be paused and stopped,
-- never started, resumed or switched on automatically.
--
--   column   app_private.mhp_followup_runs.audience ('webinar_signups' default, or 'book_readers') and book_signup_id
--            (the book sign-up a book-readers person entered from); both fixed once written. Existing rows are webinar.
--   reason   'purchased' joins the run reasons (a book reader who buys is stopped with it).
--   tables   app_private.mhp_book_entry_switches (the owner's "send this to each new book sign-up automatically", from
--            the moment it is switched on) and app_private.mhp_book_entry_receipts (one row per book sign-up a switch
--            has looked at, so nobody is entered twice and nobody from before the switch is swept in).
--   reads    mhp_sequence_eligible(bytea,uuid,text): exactly who the version's audience can start now, and who is held
--            back and why. mhp_book_entry_read(bytea): the switches.
--   commands mhp_sequence_start_v2(…,uuid[],…): enrols only the listed people, all of whom must be eligible for the
--            version's saved audience, in one statement; raises if any is not. mhp_sequence_resume_v2(…,uuid[],…):
--            resumes only the listed people of a sequence whose saved audience can start, refusing people held for a
--            newer version or a changed email. mhp_book_entry_command(…): switch on / off.
--   worker   mhp_book_sequence_sweep(integer): stops book readers who bought (reason 'purchased') and enters new book
--            sign-ups for switches that are on.
--   changed  mhp_sequence_run_allowed and mhp_sequence_run_audience gain the book-readers branch (webinar unchanged).
--            mhp_sequence_command now refuses 'enrol' (a start needs the explicit list) and refuses 'resume' unless the
--            saved audience can start; pause, stop and cancel are unchanged. mhp_sequence_entry_command refuses
--            'activate' unless the saved audience is webinar sign-ups of that campaign. The previous bodies stay as
--            *_0128 (not callable by any login) so every caller keeps its name and signature.
--
-- Nothing is started, switched on, scheduled or sent by this migration. No existing row changes except the defaulted
-- new run columns. Idempotent where the repository pattern allows (it is applied once by the runner, in one
-- transaction); short lock timeouts.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

SET LOCAL ROLE r72_owner;
GRANT CREATE ON SCHEMA app_private TO r72_mhp_prospect_definer;
ALTER TABLE app_private.mhp_followup_runs
 ADD COLUMN IF NOT EXISTS audience text NOT NULL DEFAULT 'webinar_signups',
 ADD COLUMN IF NOT EXISTS book_signup_id uuid REFERENCES app_private.mhp_prospect_signups(id) ON DELETE RESTRICT;
ALTER TABLE app_private.mhp_followup_runs DROP CONSTRAINT IF EXISTS mhp_run_audience_shape;
ALTER TABLE app_private.mhp_followup_runs ADD CONSTRAINT mhp_run_audience_shape CHECK(
 (audience='webinar_signups' AND book_signup_id IS NULL) OR (audience='book_readers' AND book_signup_id IS NOT NULL AND entry_rule_id IS NULL));
ALTER TABLE app_private.mhp_followup_runs DROP CONSTRAINT IF EXISTS mhp_followup_runs_reason_check;
ALTER TABLE app_private.mhp_followup_runs ADD CONSTRAINT mhp_followup_runs_reason_check CHECK(reason IS NULL OR reason IN(
 'newer_sequence','content_changed','outcome_unknown','unsubscribed','delivery_expired','delivery_failed','manual','recovery','purchased'));
CREATE INDEX IF NOT EXISTS mhp_book_signups_by_time ON app_private.mhp_prospect_signups(created_at,id)
 WHERE kind='waitlist' AND module='book-before-you-buy';

CREATE TABLE IF NOT EXISTS app_private.mhp_book_entry_switches(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL CHECK(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b'),
 sequence_item_id uuid NOT NULL,sequence_version_id uuid NOT NULL,sequence_sha256 bytea NOT NULL CHECK(octet_length(sequence_sha256)=32),
 sequence_approval_id uuid NOT NULL,owner_user_id uuid NOT NULL,campaign text NOT NULL CHECK(campaign~'^[a-z0-9_-]{1,60}$'),
 activated_at timestamptz NOT NULL DEFAULT clock_timestamp(),last_swept_at timestamptz,disabled_at timestamptz,held_at timestamptz,held_reason text,
 CHECK((held_at IS NULL)=(held_reason IS NULL)),CHECK(held_reason IS NULL OR held_reason IN('newer_sequence','content_changed')),
 UNIQUE(workspace_id,id,sequence_version_id),
 FOREIGN KEY(workspace_id,sequence_item_id,sequence_version_id,sequence_sha256) REFERENCES app.company_content_versions(workspace_id,content_item_id,id,content_sha256) ON DELETE RESTRICT,
 FOREIGN KEY(workspace_id,sequence_approval_id) REFERENCES app.company_content_approval_decisions(workspace_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(workspace_id,owner_user_id) REFERENCES app.workspace_memberships(workspace_id,user_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS mhp_book_entry_one_open ON app_private.mhp_book_entry_switches(sequence_item_id) WHERE disabled_at IS NULL;
CREATE TABLE IF NOT EXISTS app_private.mhp_book_entry_receipts(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL CHECK(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b'),
 switch_id uuid NOT NULL REFERENCES app_private.mhp_book_entry_switches(id) ON DELETE RESTRICT,
 signup_id uuid NOT NULL REFERENCES app_private.mhp_prospect_signups(id) ON DELETE RESTRICT,
 prospect_id uuid NOT NULL REFERENCES app_private.mhp_prospects(id) ON DELETE RESTRICT,
 disposition text NOT NULL CHECK(disposition IN('enrolled','skipped')),
 reason text NOT NULL CHECK(reason IN('accepted','already_in','no_consent','unsubscribed','blocked','purchased')),
 run_id uuid REFERENCES app_private.mhp_followup_runs(id) ON DELETE RESTRICT,observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((disposition='enrolled')=(run_id IS NOT NULL) AND (disposition='enrolled')=(reason='accepted')),UNIQUE(switch_id,signup_id)
);
DO $rls$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['mhp_book_entry_switches','mhp_book_entry_receipts'] LOOP
  EXECUTE format('ALTER TABLE app_private.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE app_private.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('DROP POLICY IF EXISTS mhp_book_entry_owner ON app_private.%I',t);
  EXECUTE format('CREATE POLICY mhp_book_entry_owner ON app_private.%I TO r72_owner USING(true) WITH CHECK(true)',t);
  EXECUTE format('DROP POLICY IF EXISTS mhp_book_entry_definer ON app_private.%I',t);
  EXECUTE format('CREATE POLICY mhp_book_entry_definer ON app_private.%I TO r72_mhp_prospect_definer USING(workspace_id=''2789228d-55a6-4688-b1e8-2f70abca990b'') WITH CHECK(workspace_id=''2789228d-55a6-4688-b1e8-2f70abca990b'')',t);
  EXECUTE format('REVOKE ALL ON app_private.%I FROM PUBLIC',t);
  EXECUTE format('GRANT SELECT,INSERT ON app_private.%I TO r72_mhp_prospect_definer',t);
  INSERT INTO app_private.workspace_table_registry(schema_name,table_name,workspace_column) VALUES('app_private',t,'workspace_id') ON CONFLICT DO NOTHING;
 END LOOP;
END $rls$;
GRANT UPDATE(last_swept_at,disabled_at,held_at,held_reason) ON app_private.mhp_book_entry_switches TO r72_mhp_prospect_definer;
-- The book-readers rule reads the durable email block ledger (0153) for MHP, read-only.
DROP POLICY IF EXISTS mhp_book_readers_blocks ON app_private.email_address_blocks;
CREATE POLICY mhp_book_readers_blocks ON app_private.email_address_blocks FOR SELECT TO r72_mhp_prospect_definer
 USING(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b');
GRANT SELECT ON app_private.email_address_blocks TO r72_mhp_prospect_definer;
RESET ROLE;
-- The existing purchase check (0114): a payment recorded for this address.
SET LOCAL ROLE r72_mhp_commerce_definer;
GRANT EXECUTE ON FUNCTION app_private.mhp_has_purchase_email(text) TO r72_mhp_prospect_definer;
RESET ROLE;

SET LOCAL ROLE r72_mhp_prospect_definer;
-- Fixed once written: the people a run belongs to never change after it is made.
CREATE OR REPLACE FUNCTION app_private.mhp_run_audience_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $f$
BEGIN
 IF NEW.audience IS DISTINCT FROM OLD.audience OR NEW.book_signup_id IS DISTINCT FROM OLD.book_signup_id THEN
  RAISE EXCEPTION 'Run audience is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $f$;
CREATE OR REPLACE FUNCTION app_private.mhp_book_switch_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $f$
BEGIN
 IF TG_OP='DELETE' OR (to_jsonb(NEW)-ARRAY['last_swept_at','disabled_at','held_at','held_reason']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['last_swept_at','disabled_at','held_at','held_reason'])
  OR (OLD.disabled_at IS NOT NULL AND NEW.disabled_at IS DISTINCT FROM OLD.disabled_at)
  OR (OLD.held_at IS NOT NULL AND (NEW.held_at IS DISTINCT FROM OLD.held_at OR NEW.held_reason IS DISTINCT FROM OLD.held_reason))
 THEN RAISE EXCEPTION 'Book entry switch identity is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $f$;
CREATE OR REPLACE FUNCTION app_private.mhp_book_receipt_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $f$
BEGIN RAISE EXCEPTION 'Book entry receipt is immutable' USING ERRCODE='23514'; END $f$;
RESET ROLE;
SET LOCAL ROLE r72_owner;
DROP TRIGGER IF EXISTS mhp_run_audience_immutable ON app_private.mhp_followup_runs;
CREATE TRIGGER mhp_run_audience_immutable BEFORE UPDATE ON app_private.mhp_followup_runs FOR EACH ROW EXECUTE FUNCTION app_private.mhp_run_audience_immutable();
DROP TRIGGER IF EXISTS mhp_book_switch_immutable ON app_private.mhp_book_entry_switches;
CREATE TRIGGER mhp_book_switch_immutable BEFORE UPDATE OR DELETE ON app_private.mhp_book_entry_switches FOR EACH ROW EXECUTE FUNCTION app_private.mhp_book_switch_immutable();
DROP TRIGGER IF EXISTS mhp_book_receipt_immutable ON app_private.mhp_book_entry_receipts;
CREATE TRIGGER mhp_book_receipt_immutable BEFORE UPDATE OR DELETE ON app_private.mhp_book_entry_receipts FOR EACH ROW EXECUTE FUNCTION app_private.mhp_book_receipt_immutable();
RESET ROLE;

SET LOCAL ROLE r72_mhp_prospect_definer;
-- The audience saved with a sequence version, exactly as the application validates it; NULL when there is none.
CREATE OR REPLACE FUNCTION app_private.mhp_sequence_version_audience(p_version uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT CASE WHEN jsonb_typeof(a)='object' AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(a) k)=ARRAY['campaign','kind','schema']
   AND a->>'schema'='mhp.followup-sequence-audience/v1'
   AND ((a->>'kind'='webinar_signups' AND jsonb_typeof(a->'campaign')='string' AND a->>'campaign'~'^[a-z0-9_-]{1,60}$')
     OR (a->>'kind' IN('book_readers','none_yet') AND a->'campaign'='null'::jsonb))
  THEN jsonb_build_object('kind',a->>'kind','campaign',a->'campaign') END
 FROM (SELECT v.metadata->'mhpSequence'->'audience' AS a FROM app.company_content_versions v
  WHERE v.id=p_version AND v.workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND v.source_system='mhp.followup-sequence') x
$f$;
-- Whether the version's saved audience is the people a run or start is for.
CREATE OR REPLACE FUNCTION app_private.mhp_sequence_audience_matches(p_version uuid,p_audience text,p_campaign text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT coalesce((SELECT (a->>'kind'='webinar_signups' AND p_audience='webinar_signups' AND a->>'campaign'=p_campaign)
   OR (a->>'kind'='book_readers' AND p_audience='book_readers') FROM (SELECT app_private.mhp_sequence_version_audience(p_version) a) x),false)
$f$;
-- The book sign-up a person's book-readers eligibility rests on: their latest Before You Buy book sign-up.
CREATE OR REPLACE FUNCTION app_private.mhp_book_latest_signup(p_prospect uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT g.id FROM app_private.mhp_prospect_signups g WHERE g.prospect_id=p_prospect AND g.kind='waitlist' AND g.module='book-before-you-buy'
  AND g.label='Before You Buy — book interest' ORDER BY g.created_at DESC,g.id DESC LIMIT 1
$f$;
-- Why a person cannot receive a book-readers sequence now; NULL when they can. Not about any particular sequence.
CREATE OR REPLACE FUNCTION app_private.mhp_book_reader_reason(p_prospect uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT CASE
  WHEN p.id IS NULL OR s.id IS NULL THEN 'not_book'
  WHEN p.unsubscribed_at IS NOT NULL THEN 'unsubscribed'
  WHEN NOT s.consent_given OR NOT p.marketing_consent THEN 'no_consent'
  WHEN EXISTS(SELECT 1 FROM app_private.email_address_blocks b WHERE b.workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b'
    AND b.email=lower(p.email::text) AND b.lifted_at IS NULL) THEN 'blocked'
  WHEN app_private.mhp_has_purchase_email(p.email::text) THEN 'purchased'
 END
 FROM (SELECT p_prospect AS id) want LEFT JOIN app_private.mhp_prospects p ON p.id=want.id
 LEFT JOIN app_private.mhp_prospect_signups s ON s.id=app_private.mhp_book_latest_signup(want.id)
$f$;
RESET ROLE;

-- Keep the 0128 bodies under *_0128 names; callers keep the original names.
DO $rename$ BEGIN
 IF to_regprocedure('app_private.mhp_sequence_run_allowed_0128(uuid)') IS NULL THEN
  SET LOCAL ROLE r72_mhp_prospect_definer;
  ALTER FUNCTION app_private.mhp_sequence_run_allowed(uuid) RENAME TO mhp_sequence_run_allowed_0128;
  ALTER FUNCTION app_private.mhp_sequence_run_audience(uuid) RENAME TO mhp_sequence_run_audience_0128;
  ALTER FUNCTION app_private.mhp_sequence_command(bytea,text,uuid,uuid,text,uuid,uuid,text) RENAME TO mhp_sequence_command_0128;
  ALTER FUNCTION app_private.mhp_sequence_entry_command(bytea,text,uuid,uuid,text,uuid,timestamptz,text) RENAME TO mhp_sequence_entry_command_0128;
  RESET ROLE;
 END IF;
END $rename$;
SET LOCAL ROLE r72_mhp_prospect_definer;
REVOKE ALL ON FUNCTION app_private.mhp_sequence_run_allowed_0128(uuid),app_private.mhp_sequence_run_audience_0128(uuid),
 app_private.mhp_sequence_command_0128(bytea,text,uuid,uuid,text,uuid,uuid,text),
 app_private.mhp_sequence_entry_command_0128(bytea,text,uuid,uuid,text,uuid,timestamptz,text) FROM PUBLIC,r72_web,r72_identity_command;

CREATE OR REPLACE FUNCTION app_private.mhp_sequence_run_allowed(p_run uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT CASE WHEN r.audience='book_readers' THEN app_private.mhp_book_reader_reason(r.prospect_id) IS NULL
   ELSE app_private.mhp_sequence_run_allowed_0128(p_run) END
 FROM (SELECT p_run AS id) want LEFT JOIN app_private.mhp_followup_runs r ON r.id=want.id
$f$;
CREATE OR REPLACE FUNCTION app_private.mhp_sequence_run_audience(p_run uuid) RETURNS TABLE(label text,link text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT s.label,s.link FROM app_private.mhp_followup_runs r JOIN app_private.mhp_prospect_signups s ON s.id=r.book_signup_id
  WHERE r.id=p_run AND r.audience='book_readers' AND app_private.mhp_sequence_run_allowed(r.id)
 UNION ALL SELECT a.label,a.link FROM app_private.mhp_followup_runs r CROSS JOIN LATERAL app_private.mhp_sequence_run_audience_0128(r.id) a
  WHERE r.id=p_run AND r.audience='webinar_signups'
$f$;

-- 'enrol' needs the explicit list (mhp_sequence_start_v2); 'resume' needs a saved audience that can start.
CREATE OR REPLACE FUNCTION app_private.mhp_sequence_command(p_session bytea,p_action text,p_command uuid,p_version uuid,p_campaign text,p_run uuid,p_ack_proof uuid,p_request text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE item uuid; bad integer;
BEGIN
 IF p_action='enrol' THEN RAISE EXCEPTION 'A start needs the confirmed list of people' USING ERRCODE='23514'; END IF;
 IF p_action='resume' THEN
  SELECT content_item_id INTO item FROM app.company_content_versions WHERE workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND id=p_version AND source_system='mhp.followup-sequence';
  SELECT count(*) INTO bad FROM app_private.mhp_followup_runs r WHERE r.sequence_item_id=item AND r.campaign=p_campaign AND (p_run IS NULL OR r.id=p_run)
   AND r.state IN('paused','held') AND NOT app_private.mhp_sequence_audience_matches(r.sequence_version_id,r.audience,r.campaign);
  IF bad>0 THEN RAISE EXCEPTION 'This sequence has no audience that can be resumed' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN app_private.mhp_sequence_command_0128(p_session,p_action,p_command,p_version,p_campaign,p_run,p_ack_proof,p_request);
END $f$;
CREATE OR REPLACE FUNCTION app_private.mhp_sequence_entry_command(p_session bytea,p_action text,p_command uuid,p_version uuid,p_campaign text,p_rule uuid,p_expires timestamptz,p_request text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 IF p_action='activate' AND NOT app_private.mhp_sequence_audience_matches(p_version,'webinar_signups',p_campaign) THEN
  RAISE EXCEPTION 'Automatic entry needs a sequence saved for webinar sign-ups' USING ERRCODE='23514'; END IF;
 RETURN app_private.mhp_sequence_entry_command_0128(p_session,p_action,p_command,p_version,p_campaign,p_rule,p_expires,p_request);
END $f$;

-- Who the version's saved audience can start now (not already in), and who is held back and why. Owner read.
CREATE OR REPLACE FUNCTION app_private.mhp_sequence_eligible(p_session bytea,p_version uuid,p_campaign text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; item uuid; audience jsonb; kind text; eligible jsonb; held jsonb; already jsonb; total integer;
BEGIN
 actor:=app_private.mhp_owner_email_authorize(p_session);
 IF p_version IS NULL OR p_campaign IS NULL OR p_campaign!~'^[a-z0-9_-]{1,60}$' THEN RAISE EXCEPTION 'Invalid audience read' USING ERRCODE='22023'; END IF;
 SELECT content_item_id INTO item FROM app.company_content_versions WHERE workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND id=p_version AND source_system='mhp.followup-sequence';
 IF item IS NULL THEN RAISE EXCEPTION 'Sequence unavailable' USING ERRCODE='23514'; END IF;
 audience:=app_private.mhp_sequence_version_audience(p_version); kind:=coalesce(audience->>'kind','none_yet');
 IF kind='webinar_signups' AND audience->>'campaign'=p_campaign THEN
  WITH anchors AS(SELECT s.prospect_id,min(s.created_at) AS captured_at FROM app_private.mhp_marketing_sends s
    WHERE s.owner_content_version_id IS NULL AND s.campaign_key=p_campaign AND s.template_key IN('webinar_confirm','webinar_24h','webinar_1h','webinar_replay','webinar_followup') GROUP BY s.prospect_id),
   people AS(SELECT p.id,p.email::text AS email,p.first_name,p.unsubscribed_at IS NOT NULL AS unsubscribed,(a2.prospect_id IS NOT NULL) AS ok,sg.label,sg.created_at AS signed_up
    FROM anchors a JOIN app_private.mhp_prospects p ON p.id=a.prospect_id
    LEFT JOIN LATERAL(SELECT x.label,x.created_at FROM app_private.mhp_prospect_signups x WHERE x.prospect_id=p.id AND x.kind='webinar' AND x.created_at<=a.captured_at ORDER BY x.created_at DESC,x.id DESC LIMIT 1) sg ON true
    LEFT JOIN app_private.mhp_owner_email_audience(p_campaign) a2 ON a2.prospect_id=p.id),
   classified AS(SELECT q.*,CASE WHEN q.unsubscribed THEN 'unsubscribed' WHEN NOT q.ok THEN 'no_consent'
     WHEN EXISTS(SELECT 1 FROM app_private.mhp_followup_runs r WHERE r.sequence_version_id=p_version AND r.prospect_id=q.id AND r.campaign=p_campaign) THEN 'already_in'
     WHEN EXISTS(SELECT 1 FROM app_private.mhp_followup_runs r WHERE r.sequence_item_id=item AND r.prospect_id=q.id AND r.campaign=p_campaign AND r.state IN('active','paused','held')) THEN 'earlier_version' END AS reason FROM people q)
  SELECT (SELECT coalesce(jsonb_agg(jsonb_build_object('prospectId',c.id,'email',c.email,'firstName',c.first_name,'label',c.label,'signedUpAt',c.signed_up) ORDER BY c.id),'[]') FROM (SELECT * FROM classified WHERE reason IS NULL ORDER BY id LIMIT 2000) c),
   (SELECT count(*) FROM classified WHERE reason IS NULL),
   (SELECT jsonb_build_object('noConsent',count(*) FILTER(WHERE reason='no_consent'),'unsubscribed',count(*) FILTER(WHERE reason='unsubscribed'),'blocked',0,'purchased',0,
     'alreadyIn',count(*) FILTER(WHERE reason='already_in'),'earlierVersion',count(*) FILTER(WHERE reason='earlier_version')) FROM classified),
   '[]'::jsonb INTO eligible,total,held,already;
 ELSIF kind='book_readers' THEN
  WITH people AS(SELECT p.id,p.email::text AS email,p.first_name,g.id AS signup_id,g.label,g.created_at AS signed_up,app_private.mhp_book_reader_reason(p.id) AS why,
     (SELECT r.state FROM app_private.mhp_followup_runs r WHERE r.sequence_item_id=item AND r.prospect_id=p.id ORDER BY r.created_at DESC,r.id DESC LIMIT 1) AS in_state
    FROM app_private.mhp_prospects p JOIN app_private.mhp_prospect_signups g ON g.id=app_private.mhp_book_latest_signup(p.id)
    WHERE EXISTS(SELECT 1 FROM app_private.mhp_prospect_signups b WHERE b.prospect_id=p.id AND b.kind='waitlist' AND b.module='book-before-you-buy' AND b.label='Before You Buy — book interest')),
   classified AS(SELECT q.*,CASE WHEN q.in_state IS NOT NULL THEN 'already_in' ELSE q.why END AS reason FROM people q)
  SELECT (SELECT coalesce(jsonb_agg(jsonb_build_object('prospectId',c.id,'email',c.email,'firstName',c.first_name,'label',c.label,'signedUpAt',c.signed_up,'signupId',c.signup_id) ORDER BY c.id),'[]') FROM (SELECT * FROM classified WHERE reason IS NULL ORDER BY id LIMIT 2000) c),
   (SELECT count(*) FROM classified WHERE reason IS NULL),
   (SELECT jsonb_build_object('noConsent',count(*) FILTER(WHERE reason='no_consent'),'unsubscribed',count(*) FILTER(WHERE reason='unsubscribed'),'blocked',count(*) FILTER(WHERE reason='blocked'),
     'purchased',count(*) FILTER(WHERE reason='purchased'),'alreadyIn',count(*) FILTER(WHERE reason='already_in'),'earlierVersion',0) FROM classified),
   (SELECT coalesce(jsonb_agg(jsonb_build_object('prospectId',c.id,'email',c.email,'firstName',c.first_name,'state',c.in_state) ORDER BY c.first_name NULLS LAST,c.email),'[]') FROM (SELECT * FROM classified WHERE reason='already_in' ORDER BY id LIMIT 200) c)
  INTO eligible,total,held,already;
 ELSE
  eligible:='[]'; total:=0; held:=jsonb_build_object('noConsent',0,'unsubscribed',0,'blocked',0,'purchased',0,'alreadyIn',0,'earlierVersion',0); already:='[]';
 END IF;
 RETURN jsonb_build_object('audience',kind,'campaign',p_campaign,'contentVersionId',p_version,'eligible',eligible,'eligibleTotal',total,'heldBack',held,'alreadyIn',already);
END $f$;

-- The only start: exactly the listed people, every one eligible for the version's saved audience, in one statement.
CREATE OR REPLACE FUNCTION app_private.mhp_sequence_start_v2(p_session bytea,p_command uuid,p_version uuid,p_campaign text,p_recipients uuid[],p_request text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; item uuid; exact jsonb; audience jsonb; kind text; next jsonb; receipt jsonb; bad integer; changed integer; outcome jsonb; listed uuid[];
BEGIN
 actor:=app_private.mhp_owner_email_authorize(p_session);
 IF NOT app_private.lock_active_portal_session(p_session,actor,'2789228d-55a6-4688-b1e8-2f70abca990b') THEN RAISE EXCEPTION 'Owner session changed' USING ERRCODE='42501'; END IF;
 IF p_command IS NULL OR p_version IS NULL OR p_campaign IS NULL OR p_campaign!~'^[a-z0-9_-]{1,60}$' OR p_recipients IS NULL
  OR cardinality(p_recipients) NOT BETWEEN 1 AND 500 OR array_position(p_recipients,NULL) IS NOT NULL
  OR (SELECT count(DISTINCT x) FROM unnest(p_recipients) x)<>cardinality(p_recipients)
 THEN RAISE EXCEPTION 'Invalid sequence start' USING ERRCODE='22023'; END IF;
 SELECT content_item_id INTO item FROM app.company_content_versions WHERE workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND id=p_version AND source_system='mhp.followup-sequence';
 IF item IS NULL THEN RAISE EXCEPTION 'Sequence unavailable' USING ERRCODE='23514'; END IF;
 SELECT array_agg(x ORDER BY x) INTO listed FROM unnest(p_recipients) x;
 receipt:=app_private.mhp_sequence_action_receipt(actor,'enrol',p_command,jsonb_build_object('version',p_version,'campaign',p_campaign,'recipients',to_jsonb(listed),'v',2),p_request);
 IF (receipt->>'replayed')::boolean THEN RETURN (receipt->'result')||jsonb_build_object('replayed',true); END IF;
 PERFORM app_private.mhp_sequence_lock_items(p_version,false);
 exact:=app_private.mhp_sequence_exact(p_version,true,true);
 IF exact->>'campaign' IS DISTINCT FROM p_campaign THEN RAISE EXCEPTION 'Sequence audience changed' USING ERRCODE='23514'; END IF;
 audience:=app_private.mhp_sequence_version_audience(p_version); kind:=audience->>'kind';
 IF kind IS NULL OR NOT ((kind='webinar_signups' AND audience->>'campaign'=p_campaign) OR kind='book_readers')
 THEN RAISE EXCEPTION 'This sequence has no audience that can be started' USING ERRCODE='23514'; END IF;
 IF kind='webinar_signups' THEN
  SELECT count(*) INTO bad FROM unnest(listed) x WHERE NOT EXISTS(SELECT 1 FROM app_private.mhp_owner_email_audience(p_campaign) a WHERE a.prospect_id=x)
   OR EXISTS(SELECT 1 FROM app_private.mhp_followup_runs r WHERE r.sequence_version_id=p_version AND r.prospect_id=x AND r.campaign=p_campaign)
   OR EXISTS(SELECT 1 FROM app_private.mhp_followup_runs r WHERE r.sequence_item_id=item AND r.prospect_id=x AND r.campaign=p_campaign AND r.state IN('active','paused','held'));
 ELSE
  SELECT count(*) INTO bad FROM unnest(listed) x WHERE app_private.mhp_book_reader_reason(x) IS NOT NULL
   OR EXISTS(SELECT 1 FROM app_private.mhp_followup_runs r WHERE r.sequence_item_id=item AND r.prospect_id=x);
 END IF;
 IF bad>0 THEN RAISE EXCEPTION 'Someone on the list can no longer receive this sequence' USING ERRCODE='23514'; END IF;
 next:=app_private.mhp_sequence_next(exact->'definition',-1,clock_timestamp());
 INSERT INTO app_private.mhp_followup_runs(workspace_id,sequence_item_id,sequence_version_id,sequence_sha256,sequence_approval_id,owner_user_id,prospect_id,campaign,
  enrolment_command_id,state,position,due_at,audience,book_signup_id)
 SELECT '2789228d-55a6-4688-b1e8-2f70abca990b',item,p_version,decode(exact->>'contentSha256','hex'),(exact->>'approvalDecisionId')::uuid,actor,x,p_campaign,p_command,'active',
  (next->>'position')::integer,(next->>'dueAt')::timestamptz,kind,CASE WHEN kind='book_readers' THEN app_private.mhp_book_latest_signup(x) END
 FROM unnest(listed) x;
 GET DIAGNOSTICS changed=ROW_COUNT;
 outcome:=jsonb_build_object('action','enrol','contentItemId',item,'contentVersionId',p_version,'changed',changed,'remaining',0,'blocked',0,'inFlight',0,'replayed',false,'audience',kind);
 UPDATE app.command_receipts SET result=outcome,status='succeeded',response_status=200,completed_at=clock_timestamp() WHERE id=(receipt->>'receiptId')::uuid;
 RETURN outcome;
END $f$;

-- Resume exactly the listed people of one sequence. Refused when its saved audience cannot start, or for anyone held
-- because a newer version exists or an email changed (the database would not send to them anyway).
CREATE OR REPLACE FUNCTION app_private.mhp_sequence_resume_v2(p_session bytea,p_command uuid,p_version uuid,p_campaign text,p_runs uuid[],p_request text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; item uuid; run_id uuid; result jsonb; changed integer:=0; blocked integer:=0; flying integer:=0; bad integer;
BEGIN
 actor:=app_private.mhp_owner_email_authorize(p_session);
 IF p_command IS NULL OR p_version IS NULL OR p_campaign IS NULL OR p_campaign!~'^[a-z0-9_-]{1,60}$' OR p_runs IS NULL
  OR cardinality(p_runs) NOT BETWEEN 1 AND 500 OR array_position(p_runs,NULL) IS NOT NULL OR (SELECT count(DISTINCT x) FROM unnest(p_runs) x)<>cardinality(p_runs)
 THEN RAISE EXCEPTION 'Invalid resume' USING ERRCODE='22023'; END IF;
 SELECT content_item_id INTO item FROM app.company_content_versions WHERE workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND id=p_version AND source_system='mhp.followup-sequence';
 IF item IS NULL THEN RAISE EXCEPTION 'Sequence unavailable' USING ERRCODE='23514'; END IF;
 SELECT count(*) INTO bad FROM unnest(p_runs) x LEFT JOIN app_private.mhp_followup_runs r ON r.id=x
  WHERE r.id IS NULL OR r.sequence_item_id<>item OR r.campaign<>p_campaign
   OR NOT app_private.mhp_sequence_audience_matches(r.sequence_version_id,r.audience,r.campaign)
   OR r.reason IN('newer_sequence','content_changed');
 IF bad>0 THEN RAISE EXCEPTION 'Someone on the list cannot be resumed' USING ERRCODE='23514'; END IF;
 FOR run_id IN SELECT x FROM unnest(p_runs) x ORDER BY x LOOP
  result:=app_private.mhp_sequence_command_0128(p_session,'resume',(md5(p_command::text||':'||run_id::text))::uuid,p_version,p_campaign,run_id,NULL,p_request);
  changed:=changed+(result->>'changed')::integer; blocked:=blocked+(result->>'blocked')::integer; flying:=flying+(result->>'inFlight')::integer;
 END LOOP;
 RETURN jsonb_build_object('action','resume','contentItemId',item,'contentVersionId',p_version,'changed',changed,'remaining',0,'blocked',blocked,'inFlight',flying,'replayed',false);
END $f$;

-- "Send this to each new book sign-up automatically": on (from this moment) or off.
CREATE OR REPLACE FUNCTION app_private.mhp_book_entry_command(p_session bytea,p_action text,p_version uuid,p_campaign text,p_switch uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; item uuid; exact jsonb; sw app_private.mhp_book_entry_switches%ROWTYPE; replayed boolean:=false;
BEGIN
 actor:=app_private.mhp_owner_email_authorize(p_session);
 IF NOT app_private.lock_active_portal_session(p_session,actor,'2789228d-55a6-4688-b1e8-2f70abca990b') THEN RAISE EXCEPTION 'Owner session changed' USING ERRCODE='42501'; END IF;
 IF p_action IS NULL OR p_action NOT IN('on','off') OR p_version IS NULL OR p_campaign IS NULL OR p_campaign!~'^[a-z0-9_-]{1,60}$'
  OR (p_action='on' AND p_switch IS NOT NULL) OR (p_action='off' AND p_switch IS NULL) THEN RAISE EXCEPTION 'Invalid book entry command' USING ERRCODE='22023'; END IF;
 SELECT content_item_id INTO item FROM app.company_content_versions WHERE workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND id=p_version AND source_system='mhp.followup-sequence';
 IF item IS NULL THEN RAISE EXCEPTION 'Sequence unavailable' USING ERRCODE='23514'; END IF;
 PERFORM app_private.mhp_sequence_lock_items(p_version,false);
 IF p_action='on' THEN
  exact:=app_private.mhp_sequence_exact(p_version,true,true);
  IF exact->>'campaign' IS DISTINCT FROM p_campaign OR NOT app_private.mhp_sequence_audience_matches(p_version,'book_readers',p_campaign)
  THEN RAISE EXCEPTION 'Automatic book entry needs a published sequence saved for book readers' USING ERRCODE='23514'; END IF;
  SELECT * INTO sw FROM app_private.mhp_book_entry_switches WHERE sequence_item_id=item AND disabled_at IS NULL AND held_at IS NULL AND sequence_version_id=p_version;
  IF FOUND THEN replayed:=true;
  ELSE
   UPDATE app_private.mhp_book_entry_switches SET disabled_at=clock_timestamp() WHERE sequence_item_id=item AND disabled_at IS NULL;
   INSERT INTO app_private.mhp_book_entry_switches(workspace_id,sequence_item_id,sequence_version_id,sequence_sha256,sequence_approval_id,owner_user_id,campaign)
   VALUES('2789228d-55a6-4688-b1e8-2f70abca990b',item,p_version,decode(exact->>'contentSha256','hex'),(exact->>'approvalDecisionId')::uuid,actor,p_campaign) RETURNING * INTO sw;
  END IF;
 ELSE
  SELECT * INTO sw FROM app_private.mhp_book_entry_switches WHERE id=p_switch AND sequence_item_id=item FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Book entry switch changed' USING ERRCODE='23514'; END IF;
  replayed:=sw.disabled_at IS NOT NULL;
  UPDATE app_private.mhp_book_entry_switches SET disabled_at=coalesce(disabled_at,clock_timestamp()) WHERE id=sw.id RETURNING * INTO sw;
 END IF;
 RETURN jsonb_build_object('action',p_action,'contentItemId',item,'contentVersionId',p_version,'switchId',sw.id,'state',CASE WHEN sw.disabled_at IS NULL THEN 'on' ELSE 'off' END,
  'activatedAt',sw.activated_at,'replayed',replayed);
END $f$;
CREATE OR REPLACE FUNCTION app_private.mhp_book_entry_read(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 PERFORM app_private.mhp_owner_email_authorize(p_session);
 RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('id',w.id,'contentItemId',w.sequence_item_id,'contentVersionId',w.sequence_version_id,
   'state',CASE WHEN w.disabled_at IS NOT NULL THEN 'off' WHEN w.held_at IS NOT NULL THEN 'held' ELSE 'on' END,'activatedAt',w.activated_at,'disabledAt',w.disabled_at,
   'heldReason',w.held_reason,'lastSweptAt',w.last_swept_at,
   'enrolled',(SELECT count(*) FROM app_private.mhp_book_entry_receipts x WHERE x.switch_id=w.id AND x.disposition='enrolled'),
   'skipped',(SELECT count(*) FROM app_private.mhp_book_entry_receipts x WHERE x.switch_id=w.id AND x.disposition='skipped')) ORDER BY w.activated_at DESC,w.id)
  FROM (SELECT * FROM app_private.mhp_book_entry_switches ORDER BY activated_at DESC,id LIMIT 50) w),'[]'::jsonb);
END $f$;

-- Worker: stop book readers who bought, then enter new book sign-ups for switches that are on (oldest swept first).
CREATE OR REPLACE FUNCTION app_private.mhp_book_sequence_sweep(p_limit integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE r app_private.mhp_followup_runs%ROWTYPE; sw app_private.mhp_book_entry_switches%ROWTYPE; s record; exact jsonb; why text; next jsonb; run_id uuid;
 stopped integer:=0; processed integer:=0; enrolled integer:=0; skipped integer:=0; held integer:=0;
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'Invalid book sweep' USING ERRCODE='22023'; END IF;
 FOR r IN SELECT x.* FROM app_private.mhp_followup_runs x JOIN app_private.mhp_prospects p ON p.id=x.prospect_id
  WHERE x.audience='book_readers' AND x.state IN('active','paused','held') AND app_private.mhp_has_purchase_email(p.email::text) ORDER BY x.id LIMIT 500 FOR UPDATE OF x SKIP LOCKED LOOP
  UPDATE app_private.mhp_followup_runs SET state='stopped',reason='purchased',updated_at=clock_timestamp() WHERE id=r.id;
  UPDATE app_private.mhp_marketing_sends SET cancelled_at=clock_timestamp() WHERE sequence_run_id=r.id AND sent_at IS NULL AND cancelled_at IS NULL AND failed_at IS NULL
   AND (lease_until IS NULL OR lease_until<=clock_timestamp());
  stopped:=stopped+1;
 END LOOP;
 FOR sw IN SELECT * FROM app_private.mhp_book_entry_switches WHERE disabled_at IS NULL AND held_at IS NULL ORDER BY last_swept_at NULLS FIRST,id LIMIT 50 LOOP
  EXIT WHEN processed>=p_limit;
  IF NOT app_private.mhp_sequence_lock_items(sw.sequence_version_id,true) THEN CONTINUE; END IF;
  SELECT * INTO sw FROM app_private.mhp_book_entry_switches WHERE id=sw.id FOR UPDATE;
  IF sw.disabled_at IS NOT NULL OR sw.held_at IS NOT NULL THEN CONTINUE; END IF;
  BEGIN
   exact:=app_private.mhp_sequence_exact(sw.sequence_version_id,true,true);
   IF decode(exact->>'contentSha256','hex')<>sw.sequence_sha256 OR (exact->>'approvalDecisionId')::uuid<>sw.sequence_approval_id
    OR NOT app_private.mhp_sequence_audience_matches(sw.sequence_version_id,'book_readers',sw.campaign)
    OR NOT app_private.mhp_marketing_workspace_allowed(sw.owner_user_id,sw.workspace_id) THEN RAISE EXCEPTION 'Switch authority changed' USING ERRCODE='23514'; END IF;
  EXCEPTION WHEN check_violation OR insufficient_privilege THEN
   UPDATE app_private.mhp_book_entry_switches SET held_at=clock_timestamp(),held_reason=CASE WHEN EXISTS(SELECT 1 FROM app.company_content_versions newer
     JOIN app.company_content_versions cur ON cur.id=sw.sequence_version_id WHERE newer.workspace_id=cur.workspace_id AND newer.content_item_id=cur.content_item_id
     AND newer.version_number>cur.version_number) THEN 'newer_sequence' ELSE 'content_changed' END WHERE id=sw.id;
   held:=held+1; CONTINUE;
  END;
  FOR s IN SELECT g.id,g.prospect_id,g.consent_given FROM app_private.mhp_prospect_signups g
   WHERE g.kind='waitlist' AND g.module='book-before-you-buy' AND g.label='Before You Buy — book interest' AND g.created_at>=sw.activated_at
    AND NOT EXISTS(SELECT 1 FROM app_private.mhp_book_entry_receipts x WHERE x.switch_id=sw.id AND x.signup_id=g.id)
   ORDER BY g.created_at,g.id LIMIT greatest(p_limit-processed,0) LOOP
   processed:=processed+1;
   why:=CASE WHEN EXISTS(SELECT 1 FROM app_private.mhp_followup_runs x WHERE x.sequence_item_id=sw.sequence_item_id AND x.prospect_id=s.prospect_id) THEN 'already_in'
    WHEN NOT s.consent_given THEN 'no_consent' ELSE app_private.mhp_book_reader_reason(s.prospect_id) END;
   IF why IS NULL THEN
    next:=app_private.mhp_sequence_next(exact->'definition',-1,clock_timestamp());
    INSERT INTO app_private.mhp_followup_runs(workspace_id,sequence_item_id,sequence_version_id,sequence_sha256,sequence_approval_id,owner_user_id,prospect_id,campaign,
     enrolment_command_id,state,position,due_at,audience,book_signup_id)
    VALUES(sw.workspace_id,sw.sequence_item_id,sw.sequence_version_id,sw.sequence_sha256,sw.sequence_approval_id,sw.owner_user_id,s.prospect_id,sw.campaign,sw.id,'active',
     (next->>'position')::integer,(next->>'dueAt')::timestamptz,'book_readers',s.id) RETURNING id INTO run_id;
    INSERT INTO app_private.mhp_book_entry_receipts(workspace_id,switch_id,signup_id,prospect_id,disposition,reason,run_id)
    VALUES(sw.workspace_id,sw.id,s.id,s.prospect_id,'enrolled','accepted',run_id);
    enrolled:=enrolled+1;
   ELSE
    INSERT INTO app_private.mhp_book_entry_receipts(workspace_id,switch_id,signup_id,prospect_id,disposition,reason)
    VALUES(sw.workspace_id,sw.id,s.id,s.prospect_id,'skipped',CASE WHEN why='not_book' THEN 'no_consent' ELSE why END);
    skipped:=skipped+1;
   END IF;
  END LOOP;
  UPDATE app_private.mhp_book_entry_switches SET last_swept_at=clock_timestamp() WHERE id=sw.id;
 END LOOP;
 RETURN jsonb_build_object('stoppedPurchased',stopped,'processed',processed,'enrolled',enrolled,'skipped',skipped,'heldSwitches',held);
END $f$;

REVOKE ALL ON FUNCTION app_private.mhp_sequence_version_audience(uuid),app_private.mhp_sequence_audience_matches(uuid,text,text),
 app_private.mhp_book_latest_signup(uuid),app_private.mhp_book_reader_reason(uuid),app_private.mhp_run_audience_immutable(),
 app_private.mhp_book_switch_immutable(),app_private.mhp_book_receipt_immutable(),
 app_private.mhp_sequence_run_allowed(uuid),app_private.mhp_sequence_run_audience(uuid),
 app_private.mhp_sequence_command(bytea,text,uuid,uuid,text,uuid,uuid,text),
 app_private.mhp_sequence_entry_command(bytea,text,uuid,uuid,text,uuid,timestamptz,text),
 app_private.mhp_sequence_eligible(bytea,uuid,text),app_private.mhp_sequence_start_v2(bytea,uuid,uuid,text,uuid[],text),
 app_private.mhp_sequence_resume_v2(bytea,uuid,uuid,text,uuid[],text),app_private.mhp_book_entry_command(bytea,text,uuid,text,uuid),
 app_private.mhp_book_entry_read(bytea),app_private.mhp_book_sequence_sweep(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.mhp_sequence_command(bytea,text,uuid,uuid,text,uuid,uuid,text),
 app_private.mhp_sequence_entry_command(bytea,text,uuid,uuid,text,uuid,timestamptz,text),
 app_private.mhp_sequence_start_v2(bytea,uuid,uuid,text,uuid[],text),app_private.mhp_sequence_resume_v2(bytea,uuid,uuid,text,uuid[],text),
 app_private.mhp_book_entry_command(bytea,text,uuid,text,uuid),app_private.mhp_book_sequence_sweep(integer) TO r72_identity_command;
GRANT EXECUTE ON FUNCTION app_private.mhp_sequence_eligible(bytea,uuid,text),app_private.mhp_book_entry_read(bytea) TO r72_web;
RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_mhp_prospect_definer;
RESET ROLE;

DO $verify$
DECLARE f text;
BEGIN
 FOREACH f IN ARRAY ARRAY['app_private.mhp_sequence_version_audience(uuid)','app_private.mhp_sequence_audience_matches(uuid,text,text)',
  'app_private.mhp_book_latest_signup(uuid)','app_private.mhp_book_reader_reason(uuid)','app_private.mhp_sequence_run_allowed(uuid)',
  'app_private.mhp_sequence_run_audience(uuid)','app_private.mhp_sequence_command(bytea,text,uuid,uuid,text,uuid,uuid,text)',
  'app_private.mhp_sequence_entry_command(bytea,text,uuid,uuid,text,uuid,timestamptz,text)','app_private.mhp_sequence_eligible(bytea,uuid,text)',
  'app_private.mhp_sequence_start_v2(bytea,uuid,uuid,text,uuid[],text)','app_private.mhp_sequence_resume_v2(bytea,uuid,uuid,text,uuid[],text)',
  'app_private.mhp_book_entry_command(bytea,text,uuid,text,uuid)','app_private.mhp_book_entry_read(bytea)','app_private.mhp_book_sequence_sweep(integer)',
  'app_private.mhp_sequence_run_allowed_0128(uuid)','app_private.mhp_sequence_run_audience_0128(uuid)',
  'app_private.mhp_sequence_command_0128(bytea,text,uuid,uuid,text,uuid,uuid,text)','app_private.mhp_sequence_entry_command_0128(bytea,text,uuid,uuid,text,uuid,timestamptz,text)'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure(f) AND pg_catalog.pg_get_userbyid(p.proowner)='r72_mhp_prospect_definer'
     AND p.prosecdef AND p.proconfig=ARRAY['search_path=pg_catalog']::text[])
   OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=to_regprocedure(f) AND a.grantee=0 AND a.privilege_type='EXECUTE')
  THEN RAISE EXCEPTION '0160: % is not exactly as intended',f USING ERRCODE='55000'; END IF;
 END LOOP;
 IF has_function_privilege('r72_identity_command','app_private.mhp_sequence_command_0128(bytea,text,uuid,uuid,text,uuid,uuid,text)','EXECUTE')
  OR has_function_privilege('r72_web','app_private.mhp_sequence_start_v2(bytea,uuid,uuid,text,uuid[],text)','EXECUTE')
  OR has_function_privilege('r72_web','app_private.mhp_book_sequence_sweep(integer)','EXECUTE')
  OR has_function_privilege('r72_identity_command','app_private.mhp_sequence_eligible(bytea,uuid,text)','EXECUTE')
  OR NOT has_function_privilege('r72_identity_command','app_private.mhp_sequence_command(bytea,text,uuid,uuid,text,uuid,uuid,text)','EXECUTE')
  OR NOT has_function_privilege('r72_identity_command','app_private.mhp_book_sequence_sweep(integer)','EXECUTE')
  OR NOT has_function_privilege('r72_web','app_private.mhp_sequence_eligible(bytea,uuid,text)','EXECUTE')
  OR has_schema_privilege('r72_mhp_prospect_definer','app_private','CREATE')
  OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE oid='app_private.mhp_book_entry_switches'::regclass AND relrowsecurity AND relforcerowsecurity)
  OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE oid='app_private.mhp_book_entry_receipts'::regclass AND relrowsecurity AND relforcerowsecurity)
 THEN RAISE EXCEPTION '0160: grants or row security are not exactly as intended' USING ERRCODE='55000'; END IF;
END $verify$;
