-- INV-CRM-001: branded site drafts and explicitly published public enquiry forms.
SET LOCAL ROLE r72_owner;
GRANT CREATE ON SCHEMA app_private TO r72_investor_programme_definer;
GRANT SELECT,INSERT ON app.contacts,app.contact_points,app.activities TO r72_investor_programme_definer;
CREATE POLICY investor_site_definer ON app.contacts TO r72_investor_programme_definer USING(true) WITH CHECK(true);
CREATE POLICY investor_site_definer ON app.contact_points TO r72_investor_programme_definer USING(true) WITH CHECK(true);
CREATE POLICY investor_site_definer ON app.activities TO r72_investor_programme_definer USING(true) WITH CHECK(true);
CREATE TABLE app.investor_sites (
 workspace_id uuid PRIMARY KEY REFERENCES app.investor_businesses(workspace_id),
 slug text UNIQUE NOT NULL CHECK(slug ~ '^[a-z0-9][a-z0-9-]{2,59}$'),
 headline text NOT NULL CHECK(length(btrim(headline)) BETWEEN 1 AND 140),
 introduction text NOT NULL CHECK(length(btrim(introduction)) BETWEEN 1 AND 1500),
 locations text NOT NULL DEFAULT '' CHECK(length(locations)<=300),
 contact_email text NOT NULL CHECK(length(contact_email)<=254 AND contact_email ~ '^[^[:space:]<>@]+@[^[:space:]<>@]+\.[^[:space:]<>@]+$'),
 privacy_url text NOT NULL CHECK(length(privacy_url)<=2000 AND (privacy_url='' OR privacy_url ~ '^https://[^[:space:]]+$')),
 requested_domain text NOT NULL DEFAULT '' CHECK(length(requested_domain)<=253),
 published boolean NOT NULL DEFAULT false,
 row_version bigint NOT NULL DEFAULT 1,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(NOT published OR privacy_url<>'')
);
ALTER TABLE app.investor_sites ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.investor_sites FORCE ROW LEVEL SECURITY;
CREATE POLICY investor_site_owner ON app.investor_sites TO r72_owner USING(true) WITH CHECK(true);
CREATE POLICY investor_site_commands ON app.investor_sites TO r72_investor_programme_definer USING(true) WITH CHECK(true);
REVOKE ALL ON app.investor_sites FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON app.investor_sites TO r72_investor_programme_definer;
INSERT INTO app_private.workspace_table_registry(schema_name,table_name,workspace_column) VALUES('app','investor_sites','workspace_id');

CREATE TABLE app_private.investor_site_submissions (
 workspace_id uuid NOT NULL REFERENCES app.investor_businesses(workspace_id),
 nonce_hash bytea NOT NULL CHECK(octet_length(nonce_hash)=32),
 submitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,nonce_hash)
);
ALTER TABLE app_private.investor_site_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.investor_site_submissions FORCE ROW LEVEL SECURITY;
CREATE POLICY investor_submission_owner ON app_private.investor_site_submissions TO r72_owner USING(true) WITH CHECK(true);
CREATE POLICY investor_submission_commands ON app_private.investor_site_submissions TO r72_investor_programme_definer USING(true) WITH CHECK(true);
REVOKE ALL ON app_private.investor_site_submissions FROM PUBLIC;
GRANT SELECT,INSERT ON app_private.investor_site_submissions TO r72_investor_programme_definer;
SET LOCAL ROLE r72_investor_programme_definer;

CREATE FUNCTION app_private.investor_site_settings(p_session bytea)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; ws uuid;
BEGIN
 SELECT user_id,selected_workspace_id INTO actor,ws FROM app_private.resolve_session(p_session);
 IF actor IS NULL OR NOT EXISTS(SELECT 1 FROM app.investor_businesses WHERE workspace_id=ws) THEN RAISE EXCEPTION 'Business unavailable' USING ERRCODE='42501'; END IF;
 RETURN (SELECT to_jsonb(s)-'workspace_id' FROM app.investor_sites s WHERE workspace_id=ws);
END $f$;

CREATE FUNCTION app_private.save_investor_site(p_session bytea,p_version bigint,p_slug text,p_headline text,p_intro text,p_locations text,p_email text,p_privacy text,p_domain text,p_publish boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; ws uuid; previous bigint;
BEGIN
 SELECT user_id,selected_workspace_id INTO actor,ws FROM app_private.resolve_session(p_session);
 IF actor IS NULL OR NOT app_private.lock_active_portal_session(p_session,actor,ws) OR NOT app_private.can_manage_workspace(actor,ws) THEN RAISE EXCEPTION 'Business administration required' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM app.investor_businesses WHERE workspace_id=ws AND access_state IN('test','active') FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Business unavailable' USING ERRCODE='42501'; END IF;
 SELECT row_version INTO previous FROM app.investor_sites WHERE workspace_id=ws FOR UPDATE;
 IF COALESCE(previous,0)<>p_version THEN RAISE EXCEPTION 'Website changed' USING ERRCODE='40001'; END IF;
 INSERT INTO app.investor_sites(workspace_id,slug,headline,introduction,locations,contact_email,privacy_url,requested_domain,published)
 VALUES(ws,p_slug,p_headline,p_intro,p_locations,p_email,p_privacy,p_domain,p_publish)
 ON CONFLICT(workspace_id) DO UPDATE SET slug=EXCLUDED.slug,headline=EXCLUDED.headline,introduction=EXCLUDED.introduction,locations=EXCLUDED.locations,
 contact_email=EXCLUDED.contact_email,privacy_url=EXCLUDED.privacy_url,requested_domain=EXCLUDED.requested_domain,published=EXCLUDED.published,row_version=app.investor_sites.row_version+1,updated_at=clock_timestamp();
END $f$;

CREATE FUNCTION app_private.public_investor_site(p_slug text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT jsonb_build_object('slug',s.slug,'headline',s.headline,'introduction',s.introduction,'locations',s.locations,'contactEmail',s.contact_email,
 'privacyUrl',s.privacy_url,'brandName',b.brand_name,'accentColor',b.accent_color)
 FROM app.investor_sites s JOIN app.investor_businesses b USING(workspace_id)
 WHERE s.slug=p_slug AND s.published AND b.access_state IN('test','active')
$f$;

CREATE FUNCTION app_private.capture_investor_site_enquiry(p_slug text,p_nonce bytea,p_name text,p_email text,p_message text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE ws uuid; cid uuid;
BEGIN
 IF p_nonce IS NULL OR octet_length(p_nonce)<>32 OR p_name IS NULL OR length(btrim(p_name)) NOT BETWEEN 1 AND 200 OR p_email IS NULL OR length(p_email)>254 OR p_email !~ '^[^[:space:]<>@]+@[^[:space:]<>@]+\.[^[:space:]<>@]+$'
  OR p_message IS NULL OR length(btrim(p_message)) NOT BETWEEN 1 AND 4000 THEN RAISE EXCEPTION 'Invalid enquiry' USING ERRCODE='22023'; END IF;
 SELECT s.workspace_id INTO ws FROM app.investor_sites s JOIN app.investor_businesses b USING(workspace_id)
 WHERE s.slug=p_slug AND s.published AND b.access_state IN('test','active') FOR UPDATE OF s;
 IF ws IS NULL THEN RAISE EXCEPTION 'Site unavailable' USING ERRCODE='42501'; END IF;
 IF EXISTS(SELECT 1 FROM app_private.investor_site_submissions WHERE workspace_id=ws AND nonce_hash=p_nonce) THEN RETURN; END IF;
 IF (SELECT count(*) FROM app_private.investor_site_submissions WHERE workspace_id=ws AND submitted_at>clock_timestamp()-interval '1 hour')>=50 THEN RAISE EXCEPTION 'Enquiry limit reached' USING ERRCODE='54000'; END IF;
 INSERT INTO app_private.investor_site_submissions(workspace_id,nonce_hash) VALUES(ws,p_nonce);
 SELECT contact_id INTO cid FROM app.contact_points WHERE workspace_id=ws AND kind='email' AND normalized_value=lower(p_email) AND deleted_at IS NULL AND dedupe_state='normal';
 IF cid IS NULL THEN
  INSERT INTO app.contacts(workspace_id,display_name,source) VALUES(ws,p_name,'investor_site') RETURNING id INTO cid;
  INSERT INTO app.contact_points(workspace_id,contact_id,kind,value,normalized_value,is_primary) VALUES(ws,cid,'email',lower(p_email),lower(p_email),true);
 END IF;
 -- Enquiry is a contact request. It does not verify an email or grant marketing consent.
 INSERT INTO app.activities(workspace_id,contact_id,activity_type,channel,actor_kind,subject,body,metadata,request_id,occurred_at)
 VALUES(ws,cid,'investor.site.enquiry','crm','system','New investor website enquiry',p_message,jsonb_build_object('site',p_slug,'nameAsSubmitted',p_name),'investor-site:'||encode(p_nonce,'hex'),statement_timestamp());
END $f$;
REVOKE ALL ON FUNCTION app_private.investor_site_settings(bytea),app_private.save_investor_site(bytea,bigint,text,text,text,text,text,text,text,boolean),app_private.public_investor_site(text),app_private.capture_investor_site_enquiry(text,bytea,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.investor_site_settings(bytea),app_private.public_investor_site(text) TO r72_web;
GRANT EXECUTE ON FUNCTION app_private.save_investor_site(bytea,bigint,text,text,text,text,text,text,text,boolean),app_private.capture_investor_site_enquiry(text,bytea,text,text,text) TO r72_identity_command;
RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_investor_programme_definer;
RESET ROLE;
