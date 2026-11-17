-- Applied transactionally to Growth HQ production EU on 2026-11-17.
-- Do not re-run: policies and trigger already exist. Preserve as release repair record.
-- Book signups belong in the existing MHP contacts workspace as well as registrants.
-- Contact existence does not grant verified-email or outbound-send permission.
SET LOCAL ROLE r72_owner;
GRANT SELECT, INSERT ON app.contacts TO r72_mhp_prospect_definer;
GRANT INSERT ON app.contact_points TO r72_mhp_prospect_definer;
CREATE POLICY mhp_book_contact_read ON app.contacts FOR SELECT TO r72_mhp_prospect_definer
 USING(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b');
CREATE POLICY mhp_book_contact_insert ON app.contacts FOR INSERT TO r72_mhp_prospect_definer
 WITH CHECK(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND source='mhp:book-before-you-buy' AND owner_user_id IS NULL AND lifecycle_status='lead' AND deleted_at IS NULL);
CREATE POLICY mhp_book_point_read ON app.contact_points FOR SELECT TO r72_mhp_prospect_definer
 USING(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND kind='email');
CREATE POLICY mhp_book_point_insert ON app.contact_points FOR INSERT TO r72_mhp_prospect_definer
 WITH CHECK(workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND kind='email' AND NOT is_verified AND NOT is_primary AND consent_status='unknown' AND dedupe_state='normal' AND deleted_at IS NULL);
GRANT CREATE ON SCHEMA app_private TO r72_mhp_prospect_definer;
SET LOCAL ROLE r72_mhp_prospect_definer;
CREATE FUNCTION app_private.mhp_book_contact_after_signup() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE p app_private.mhp_prospects%ROWTYPE; contact uuid; matches integer;
BEGIN
 IF NEW.module IS DISTINCT FROM 'book-before-you-buy' OR NEW.label IS DISTINCT FROM 'Before You Buy — book interest' OR NEW.kind<>'waitlist' THEN RETURN NEW; END IF;
 SELECT * INTO STRICT p FROM app_private.mhp_prospects WHERE id=NEW.prospect_id;
 IF p.email::text LIKE '%.invalid' THEN RETURN NEW; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('mhp:book-contact:'||p.email::text,121));
 SELECT count(*),min(cp.contact_id::text)::uuid INTO matches,contact FROM app.contact_points cp
 WHERE cp.workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND cp.kind='email' AND lower(cp.normalized_value)=p.email::text AND cp.deleted_at IS NULL;
 -- Do not merge shared, quarantined or archived records, or recreate deleted contacts.
 IF matches>0 THEN RETURN NEW; END IF;
 contact:=gen_random_uuid();
 INSERT INTO app.contacts(id,workspace_id,display_name,source,custom_fields)
 VALUES(contact,'2789228d-55a6-4688-b1e8-2f70abca990b',coalesce(p.first_name,p.email::text),'mhp:book-before-you-buy',jsonb_build_object('bookInterest','Before You Buy','mhpProspectId',p.id::text));
 INSERT INTO app.contact_points(workspace_id,contact_id,kind,value,normalized_value,is_verified,consent_status)
 VALUES('2789228d-55a6-4688-b1e8-2f70abca990b',contact,'email',p.email::text,p.email::text,false,'unknown');
 RETURN NEW;
END $f$;
REVOKE ALL ON FUNCTION app_private.mhp_book_contact_after_signup() FROM PUBLIC;
RESET ROLE;
SET LOCAL ROLE r72_owner;
CREATE TRIGGER mhp_book_contact_after_signup AFTER INSERT ON app_private.mhp_prospect_signups FOR EACH ROW EXECUTE FUNCTION app_private.mhp_book_contact_after_signup();
REVOKE CREATE ON SCHEMA app_private FROM r72_mhp_prospect_definer;
RESET ROLE;

-- Verification: duplicate-signup fixture created one unverified CRM email endpoint;
-- fixture subtransaction rolled back. No email sends queued by this trigger.
