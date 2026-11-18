-- 0159: Before You Buy book sign-ups into the MHP brand CRM. Two parts, one transaction (the runner wraps the file).
--
-- Part 1. Retire the 17 Nov 2026 hand-applied "book sign-up into the CRM" trigger. Book sign-ups are now copied into
-- the MHP brand CRM by the application, through the CRM's own command (crm.createLead), after the sign-up is committed
-- (src/mhp/book-leads-service.ts). The hand-applied pieces are recorded in docs/ops/mhp-book-contact-sync-20261117.sql
-- and docs/ops/mhp-book-pipeline-sync-20261117.sql; part 1 removes them, each only if present:
--   trigger  mhp_book_contact_after_signup ON app_private.mhp_prospect_signups
--   function app_private.mhp_book_contact_after_signup()
--   policies mhp_book_* for r72_mhp_prospect_definer on app.contacts, app.contact_points, app.pipelines,
--            app.pipeline_stages, app.opportunities, app.opportunity_stage_history, app.tasks (the ten named in the two
--            files, and any other policy of that name prefix on those tables for that role)
--   grants   to r72_mhp_prospect_definer, exactly the ones the two files added and no earlier migration gives it:
--            SELECT, INSERT on app.contacts; INSERT on app.contact_points; SELECT on app.pipelines, app.pipeline_stages;
--            SELECT, INSERT on app.opportunities; INSERT on app.opportunity_stage_history, app.tasks; CREATE on schema
--            app_private (already revoked by the files themselves).
-- Kept: SELECT on app.contact_points (granted by 0134 for the webinar text-reminder hand-off) and every policy of 0134
-- and 0135 on that table; every other privilege of r72_mhp_prospect_definer. Every CRM row the trigger made stays.
--
-- Part 2. Keep a book sign-up's mobile durably, on that sign-up (not on app_private.mhp_prospects.phone, which the
-- webinar text-reminder programme of 0134/0135 reads and which must never hold a book-given number):
--   column   app_private.mhp_prospect_signups.phone (nullable; the same check as mhp_prospects.phone); no existing row,
--            function or schedule changes (capture functions are untouched and never write it)
--   function app_private.mhp_book_signup_keep_phone(uuid,uuid,text): the capture login only; sets the phone on exactly
--            that book sign-up of that prospect, made in the last 10 minutes, if it has none yet; nothing else
--   function app_private.mhp_book_signups(bytea): the owner's read (same authorisation as mhp_list_registrants): per
--            prospect with a book sign-up, its latest book sign-up's evidence and the latest mobile given on one
-- Both functions belong to r72_mhp_prospect_definer, SECURITY DEFINER, search_path=pg_catalog, not executable by PUBLIC.
--
-- Converges both starting states to the same end state: production-shaped (0001-0158 plus the two docs/ops files) and
-- fresh (0001-0158 only; part 1 is then a no-op). No existing row is read, inserted, updated or deleted. Idempotent,
-- transactional, safe to retry; short lock timeouts. The file was 0159_mhp_book_crm_retire_trigger.sql until part 2 was
-- added (never applied anywhere under either name).
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

SET LOCAL ROLE r72_owner;
DROP TRIGGER IF EXISTS mhp_book_contact_after_signup ON app_private.mhp_prospect_signups;
RESET ROLE;

-- The function belongs to r72_mhp_prospect_definer (the files created it under that role).
SET LOCAL ROLE r72_mhp_prospect_definer;
DROP FUNCTION IF EXISTS app_private.mhp_book_contact_after_signup();
RESET ROLE;

SET LOCAL ROLE r72_owner;
DROP POLICY IF EXISTS mhp_book_contact_read ON app.contacts;
DROP POLICY IF EXISTS mhp_book_contact_insert ON app.contacts;
DROP POLICY IF EXISTS mhp_book_point_read ON app.contact_points;
DROP POLICY IF EXISTS mhp_book_point_insert ON app.contact_points;
DROP POLICY IF EXISTS mhp_book_pipeline_read ON app.pipelines;
DROP POLICY IF EXISTS mhp_book_stage_read ON app.pipeline_stages;
DROP POLICY IF EXISTS mhp_book_opportunity_read ON app.opportunities;
DROP POLICY IF EXISTS mhp_book_opportunity_insert ON app.opportunities;
DROP POLICY IF EXISTS mhp_book_history_insert ON app.opportunity_stage_history;
DROP POLICY IF EXISTS mhp_book_task_insert ON app.tasks;
DO $policies$
DECLARE p record;
BEGIN
  -- Any further hand-made policy of the same family on the same seven tables for the same role.
  FOR p IN SELECT pol.polname, cls.relname FROM pg_catalog.pg_policy pol
      JOIN pg_catalog.pg_class cls ON cls.oid=pol.polrelid
      JOIN pg_catalog.pg_namespace nsp ON nsp.oid=cls.relnamespace
    WHERE nsp.nspname='app' AND pol.polname LIKE 'mhp\_book\_%'
      AND cls.relname IN ('contacts','contact_points','pipelines','pipeline_stages','opportunities','opportunity_stage_history','tasks')
      AND (SELECT oid FROM pg_catalog.pg_roles WHERE rolname='r72_mhp_prospect_definer')=ANY(pol.polroles)
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON app.%I', p.polname, p.relname);
  END LOOP;
END $policies$;

REVOKE SELECT, INSERT ON app.contacts FROM r72_mhp_prospect_definer;
REVOKE INSERT ON app.contact_points FROM r72_mhp_prospect_definer;
REVOKE SELECT ON app.pipelines, app.pipeline_stages FROM r72_mhp_prospect_definer;
REVOKE SELECT, INSERT ON app.opportunities FROM r72_mhp_prospect_definer;
REVOKE INSERT ON app.opportunity_stage_history, app.tasks FROM r72_mhp_prospect_definer;
REVOKE CREATE ON SCHEMA app_private FROM r72_mhp_prospect_definer;
RESET ROLE;

-- Part 2: the durable book mobile.
SET LOCAL ROLE r72_owner;
ALTER TABLE app_private.mhp_prospect_signups ADD COLUMN IF NOT EXISTS phone text
 CONSTRAINT mhp_prospect_signups_phone_check CHECK(phone IS NULL OR (length(phone) BETWEEN 6 AND 30 AND phone~'^[0-9 +()-]+$'));
GRANT CREATE ON SCHEMA app_private TO r72_mhp_prospect_definer;
SET LOCAL ROLE r72_mhp_prospect_definer;

-- The capture login, right after mhp_capture_signup_v3 committed a book sign-up: the mobile the visitor typed, on that
-- sign-up only. It creates no contact point, verification, consent, SMS or WhatsApp authority.
CREATE OR REPLACE FUNCTION app_private.mhp_book_signup_keep_phone(p_signup uuid,p_prospect uuid,p_phone text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE written integer;
BEGIN
 IF session_user<>'r72_identity_command' THEN RAISE EXCEPTION 'Invalid capture boundary' USING ERRCODE='42501'; END IF;
 IF p_signup IS NULL OR p_prospect IS NULL OR p_phone IS NULL OR length(p_phone) NOT BETWEEN 6 AND 30 OR p_phone!~'^[0-9 +()-]+$' THEN RETURN false; END IF;
 UPDATE app_private.mhp_prospect_signups s SET phone=p_phone
  WHERE s.id=p_signup AND s.prospect_id=p_prospect AND s.kind='waitlist' AND s.module='book-before-you-buy'
   AND s.phone IS NULL AND s.entry_event_sequence IS NULL AND s.created_at>=clock_timestamp()-interval '10 minutes';
 GET DIAGNOSTICS written=ROW_COUNT;
 RETURN written=1;
END $f$;

-- The owner's read of book sign-ups (same authorisation as mhp_list_registrants): newest first, at most 2,000 people.
CREATE OR REPLACE FUNCTION app_private.mhp_book_signups(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid;
BEGIN
 IF session_user<>'r72_web' THEN RAISE EXCEPTION 'MHP owner read boundary required' USING ERRCODE='42501'; END IF;
 SELECT s.user_id INTO actor FROM app_private.resolve_session(p_session) s JOIN app.user_sessions us ON us.id=s.session_id
 WHERE us.product_audience='martin_howard_property';
 IF actor IS NULL OR NOT app_private.mhp_is_programme_admin(actor) THEN RAISE EXCEPTION 'MHP administration required' USING ERRCODE='42501'; END IF;
 RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('prospectId',b.prospect_id,'signupId',b.id,'signedUpAt',b.created_at,
   'consentGiven',b.consent_given,'consentVersion',b.consent_version,'phone',b.phone,'link',b.link,
   'lastPhone',m.phone,'lastPhoneSignupId',m.id,'lastPhoneConsentVersion',m.consent_version,
   'firstName',p.first_name,'email',p.email::text,'marketingConsent',p.marketing_consent,'unsubscribed',p.unsubscribed_at IS NOT NULL)
   ORDER BY b.created_at DESC,b.prospect_id)
  FROM (SELECT * FROM (SELECT DISTINCT ON (g.prospect_id) g.prospect_id,g.id,g.created_at,g.consent_given,g.consent_version,g.phone,g.link
     FROM app_private.mhp_prospect_signups g WHERE g.kind='waitlist' AND g.module='book-before-you-buy' AND g.label='Before You Buy — book interest'
     ORDER BY g.prospect_id,g.created_at DESC,g.id DESC) latest ORDER BY latest.created_at DESC,latest.prospect_id LIMIT 2000) b
  JOIN app_private.mhp_prospects p ON p.id=b.prospect_id
  LEFT JOIN LATERAL (SELECT g.id,g.phone,g.consent_version FROM app_private.mhp_prospect_signups g
     WHERE g.prospect_id=b.prospect_id AND g.kind='waitlist' AND g.module='book-before-you-buy' AND g.label='Before You Buy — book interest'
      AND g.phone IS NOT NULL ORDER BY g.created_at DESC,g.id DESC LIMIT 1) m ON true),'[]'::jsonb);
END $f$;
REVOKE ALL ON FUNCTION app_private.mhp_book_signup_keep_phone(uuid,uuid,text),app_private.mhp_book_signups(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.mhp_book_signup_keep_phone(uuid,uuid,text) TO r72_identity_command;
GRANT EXECUTE ON FUNCTION app_private.mhp_book_signups(bytea) TO r72_web;
RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_mhp_prospect_definer;
RESET ROLE;

DO $verify$
BEGIN
  IF to_regprocedure('app_private.mhp_book_contact_after_signup()') IS NOT NULL
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE tgname='mhp_book_contact_after_signup')
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_policies WHERE schemaname='app' AND policyname LIKE 'mhp\_book\_%'
      AND tablename IN ('contacts','contact_points','pipelines','pipeline_stages','opportunities','opportunity_stage_history','tasks'))
    OR has_table_privilege('r72_mhp_prospect_definer','app.contacts','SELECT')
    OR has_table_privilege('r72_mhp_prospect_definer','app.contacts','INSERT')
    OR has_table_privilege('r72_mhp_prospect_definer','app.contact_points','INSERT')
    OR has_table_privilege('r72_mhp_prospect_definer','app.pipelines','SELECT')
    OR has_table_privilege('r72_mhp_prospect_definer','app.pipeline_stages','SELECT')
    OR has_table_privilege('r72_mhp_prospect_definer','app.opportunities','SELECT')
    OR has_table_privilege('r72_mhp_prospect_definer','app.opportunities','INSERT')
    OR has_table_privilege('r72_mhp_prospect_definer','app.opportunity_stage_history','INSERT')
    OR has_table_privilege('r72_mhp_prospect_definer','app.tasks','INSERT')
    OR has_schema_privilege('r72_mhp_prospect_definer','app_private','CREATE')
    OR NOT has_table_privilege('r72_mhp_prospect_definer','app.contact_points','SELECT') THEN
    RAISE EXCEPTION '0159: the book sign-up trigger, its policies or its grants are still present' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid='app_private.mhp_prospect_signups'::regclass AND a.attname='phone'
      AND NOT a.attisdropped AND a.atttypid='text'::regtype AND NOT a.attnotnull)
    OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.conrelid='app_private.mhp_prospect_signups'::regclass AND c.conname='mhp_prospect_signups_phone_check')
    OR (SELECT count(*) FROM pg_catalog.pg_proc p WHERE p.oid IN (to_regprocedure('app_private.mhp_book_signup_keep_phone(uuid,uuid,text)'),
        to_regprocedure('app_private.mhp_book_signups(bytea)')) AND pg_catalog.pg_get_userbyid(p.proowner)='r72_mhp_prospect_definer'
        AND p.prosecdef AND p.proconfig=ARRAY['search_path=pg_catalog']::text[])<>2
    OR NOT has_function_privilege('r72_identity_command','app_private.mhp_book_signup_keep_phone(uuid,uuid,text)','EXECUTE')
    OR NOT has_function_privilege('r72_web','app_private.mhp_book_signups(bytea)','EXECUTE')
    OR has_function_privilege('r72_web','app_private.mhp_book_signup_keep_phone(uuid,uuid,text)','EXECUTE')
    OR has_function_privilege('r72_identity_command','app_private.mhp_book_signups(bytea)','EXECUTE')
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a WHERE p.oid IN
        (to_regprocedure('app_private.mhp_book_signup_keep_phone(uuid,uuid,text)'),to_regprocedure('app_private.mhp_book_signups(bytea)'))
        AND a.grantee=0) THEN
    RAISE EXCEPTION '0159: the book sign-up phone column or its two functions are not exactly as intended' USING ERRCODE='55000';
  END IF;
END $verify$;
