DO $role$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='r72_media_click_command') THEN CREATE ROLE r72_media_click_command NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END $role$;
-- PRIVATE DRAFT: owner-authorized product pages and signed observed-click receipts.
-- Amazon links remain direct. No redirect, invented purchase or per-person tracking.
DO $role$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='r72_media_public_definer') THEN CREATE ROLE r72_media_public_definer NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='r72_media_public_definer' AND (rolcanlogin OR rolinherit OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) OR EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname='r72_media_public_definer') THEN RAISE EXCEPTION 'Unsafe media public role'; END IF;
 GRANT r72_media_public_definer TO r72_owner;
END $role$;
SET LOCAL ROLE r72_owner;
CREATE TABLE app_private.creative_media_link_public_policy(id integer PRIMARY KEY CHECK(id=1),enabled boolean NOT NULL DEFAULT false,origin text,signing_key_sha256 bytea CHECK(signing_key_sha256 IS NULL OR octet_length(signing_key_sha256)=32),CHECK(NOT enabled OR (origin IS NOT NULL AND origin~'^https://[a-z0-9.-]+$' AND signing_key_sha256 IS NOT NULL)));
INSERT INTO app_private.creative_media_link_public_policy VALUES(1,false,NULL,NULL);
ALTER TABLE app_private.creative_media_link_public_policy ENABLE ROW LEVEL SECURITY;ALTER TABLE app_private.creative_media_link_public_policy FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.creative_media_link_public_policy FROM PUBLIC,r72_public,r72_web,r72_content_command;
CREATE POLICY creative_media_link_public_policy_owner ON app_private.creative_media_link_public_policy FOR ALL TO r72_owner USING(true) WITH CHECK(true);
CREATE POLICY creative_media_link_public_policy_reader ON app_private.creative_media_link_public_policy FOR SELECT TO r72_media_public_definer,r72_creative_studio_definer USING(true);
GRANT SELECT ON app_private.creative_media_link_public_policy TO r72_media_public_definer,r72_creative_studio_definer;
CREATE TABLE app.creative_media_affiliate_publications (
 workspace_id uuid NOT NULL,id uuid NOT NULL,product_id uuid NOT NULL,product_revision integer NOT NULL,evidence_command_id uuid NOT NULL,
 link_sha256 text NOT NULL,command_id uuid NOT NULL,created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,id),UNIQUE(id),UNIQUE(workspace_id,command_id),
 FOREIGN KEY(workspace_id,product_id,product_revision) REFERENCES app.creative_media_products(workspace_id,product_id,revision),
 FOREIGN KEY(workspace_id,evidence_command_id) REFERENCES app.creative_media_link_evidence(workspace_id,command_id)
);
CREATE TABLE app.creative_media_affiliate_withdrawals (
 workspace_id uuid NOT NULL,publication_id uuid NOT NULL,command_id uuid NOT NULL,created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,publication_id),UNIQUE(workspace_id,command_id),FOREIGN KEY(workspace_id,publication_id) REFERENCES app.creative_media_affiliate_publications(workspace_id,id)
);
CREATE TABLE app.creative_media_affiliate_clicks (
 workspace_id uuid NOT NULL,publication_id uuid NOT NULL,nonce uuid NOT NULL,occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,publication_id,nonce),FOREIGN KEY(workspace_id,publication_id) REFERENCES app.creative_media_affiliate_publications(workspace_id,id)
);
CREATE INDEX creative_media_click_cap ON app.creative_media_affiliate_clicks(publication_id,occurred_at);
DO $t$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['creative_media_affiliate_publications','creative_media_affiliate_withdrawals','creative_media_affiliate_clicks'] LOOP
  EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON app.%I FROM PUBLIC,r72_public,r72_web,r72_content_command,r72_worker',t);
  EXECUTE format('CREATE POLICY %I ON app.%I FOR ALL TO r72_owner USING(true) WITH CHECK(true)',t||'_owner',t);
  EXECUTE format('CREATE POLICY %I ON app.%I FOR ALL TO r72_creative_studio_definer USING(workspace_id=app_private.current_workspace_id()) WITH CHECK(workspace_id=app_private.current_workspace_id())',t||'_studio',t);
  EXECUTE format('CREATE POLICY %I ON app.%I FOR ALL TO r72_media_public_definer USING(true) WITH CHECK(true)',t||'_public_capability',t);
  EXECUTE format('GRANT SELECT ON app.%I TO r72_creative_studio_definer,r72_media_public_definer',t);
  IF t<>'creative_media_affiliate_clicks' THEN EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON app.%I FOR EACH ROW EXECUTE FUNCTION app_private.seo_blog_append_only()',t||'_immutable',t); END IF;
  INSERT INTO app_private.workspace_table_registry(schema_name,table_name,workspace_column) VALUES('app',t,'workspace_id');
 END LOOP;
 FOREACH t IN ARRAY ARRAY['creative_media_products','creative_media_link_evidence'] LOOP
  EXECUTE format('CREATE POLICY %I ON app.%I FOR SELECT TO r72_media_public_definer USING(true)',t||'_publication_capability',t);EXECUTE format('GRANT SELECT ON app.%I TO r72_media_public_definer',t);
 END LOOP;
END $t$;
GRANT INSERT ON app.creative_media_affiliate_publications,app.creative_media_affiliate_withdrawals TO r72_creative_studio_definer;
GRANT INSERT ON app.creative_media_affiliate_clicks TO r72_media_public_definer;
GRANT USAGE ON SCHEMA app,app_private,public TO r72_media_public_definer;
GRANT CREATE ON SCHEMA app_private TO r72_creative_studio_definer;
SET LOCAL ROLE r72_creative_studio_definer;
CREATE FUNCTION app_private.creative_media_affiliate_publication_owner(p_workspace uuid,p_session bytea,p_action text,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid;p app.creative_media_products;e app.creative_media_link_evidence;policy app_private.creative_media_link_public_policy;publication uuid;cmd uuid;previous app.creative_media_affiliate_publications;url text;
BEGIN
 IF p_session IS NULL OR app_private.current_actor_kind() IS DISTINCT FROM 'user' THEN RAISE EXCEPTION 'Owner session required' USING ERRCODE='42501'; END IF;
 actor:=app_private.seo_media_owner(p_workspace,p_session);
 IF p_action='list' THEN
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('publicationId',a.id,'productId',a.product_id,'productRevision',a.product_revision,'withdrawn',EXISTS(SELECT 1 FROM app.creative_media_affiliate_withdrawals w WHERE w.workspace_id=p_workspace AND w.publication_id=a.id),
    'observedClicks',(SELECT count(*) FROM app.creative_media_affiliate_clicks c WHERE c.workspace_id=p_workspace AND c.publication_id=a.id),'orders',NULL,'commission',NULL) ORDER BY a.created_at DESC) FROM app.creative_media_affiliate_publications a WHERE a.workspace_id=p_workspace),'[]'::jsonb); END IF;
 IF p_input IS NULL OR jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR octet_length(p_input::text)>2000 OR p_input->>'consent' IS DISTINCT FROM 'true' OR coalesce(p_action,'') NOT IN('publish','withdraw') THEN RAISE EXCEPTION 'Exact product-page publication consent required' USING ERRCODE='22023'; END IF;
 publication:=(p_input->>'publicationId')::uuid;cmd:=(p_input->>'commandId')::uuid;
 IF publication IS NULL OR cmd IS NULL THEN RAISE EXCEPTION 'Publication identity required' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('media-affiliate-page:'||p_workspace::text,0));
 IF p_action='withdraw' THEN
  INSERT INTO app.creative_media_affiliate_withdrawals(workspace_id,publication_id,command_id,created_by) VALUES(p_workspace,publication,cmd,actor) ON CONFLICT (workspace_id,publication_id) DO NOTHING;
  RETURN jsonb_build_object('state','withdrawn'); END IF;
 SELECT * INTO policy FROM app_private.creative_media_link_public_policy WHERE id=1 AND enabled;
 IF policy.id IS NULL THEN RAISE EXCEPTION 'Affiliate site publication disabled' USING ERRCODE='55000'; END IF;
 SELECT * INTO p FROM app.creative_media_products WHERE workspace_id=p_workspace AND product_id=(p_input->>'productId')::uuid ORDER BY revision DESC LIMIT 1;
 SELECT * INTO e FROM app.creative_media_link_evidence WHERE workspace_id=p_workspace AND command_id=(p_input->>'evidenceCommandId')::uuid;
 url:=policy.origin||'/affiliate-studio/p/'||publication::text;
 IF p.product_id IS NULL OR e.product_id IS DISTINCT FROM p.product_id OR e.product_revision IS DISTINCT FROM p.revision OR e.expires_at<=clock_timestamp()
  OR e.link_sha256 IS DISTINCT FROM encode(public.digest(p.proposed_affiliate_url,'sha256'),'hex') OR e.disclosure_version IS DISTINCT FROM p.disclosure_version
  OR p.revision IS DISTINCT FROM (p_input->>'productRevision')::integer OR p.network<>'amazon_associates'
  OR p.proposed_affiliate_url IS DISTINCT FROM p_input->>'exactLink' OR e.registered_site IS DISTINCT FROM p_input->>'registeredSite'
  OR (e.registered_site<>policy.origin||'/' AND left(url,length(e.registered_site))<>e.registered_site)
  OR e.registered_site!~('^'||replace(policy.origin,'.','[.]')||'(/|$)') THEN RAISE EXCEPTION 'Current exact product evidence and registered destination site required' USING ERRCODE='55000'; END IF;
 SELECT * INTO previous FROM app.creative_media_affiliate_publications WHERE workspace_id=p_workspace AND command_id=cmd;
 IF previous.command_id IS NOT NULL AND (previous.id<>publication OR previous.product_id<>p.product_id OR previous.product_revision<>p.revision OR previous.evidence_command_id<>e.command_id) THEN RAISE EXCEPTION 'Publication command changed content' USING ERRCODE='40001'; END IF;
 INSERT INTO app.creative_media_affiliate_publications(workspace_id,id,product_id,product_revision,evidence_command_id,link_sha256,command_id,created_by) VALUES(p_workspace,publication,p.product_id,p.revision,e.command_id,e.link_sha256,cmd,actor) ON CONFLICT (workspace_id,id) DO NOTHING;
 SELECT * INTO previous FROM app.creative_media_affiliate_publications WHERE workspace_id=p_workspace AND id=publication;
 IF previous.product_id<>p.product_id OR previous.product_revision<>p.revision OR previous.evidence_command_id<>e.command_id THEN RAISE EXCEPTION 'Publication identity changed content' USING ERRCODE='40001'; END IF;
 IF EXISTS(SELECT 1 FROM app.creative_media_affiliate_withdrawals WHERE workspace_id=p_workspace AND publication_id=publication) THEN RAISE EXCEPTION 'Withdrawn page requires new publication identity' USING ERRCODE='55000'; END IF;
 RETURN jsonb_build_object('publicationId',publication,'url',url,'state','owner_authorized');
END $f$;
REVOKE ALL ON FUNCTION app_private.creative_media_affiliate_publication_owner(uuid,bytea,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.creative_media_affiliate_publication_owner(uuid,bytea,text,jsonb) TO r72_content_command;
RESET ROLE;SET LOCAL ROLE r72_owner;REVOKE CREATE ON SCHEMA app_private FROM r72_creative_studio_definer;
GRANT CREATE ON SCHEMA app_private TO r72_media_public_definer;
SET LOCAL ROLE r72_media_public_definer;
CREATE FUNCTION app_private.creative_media_affiliate_page(p_publication uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 RETURN (SELECT jsonb_build_object('publicationId',a.id,'productRevision',p.revision,'productName',p.product_name,'merchantName',p.merchant_name,'productUrl',p.product_url,'affiliateUrl',p.proposed_affiliate_url,'network',p.network,'disclosureVersion',p.disclosure_version,'registeredSite',e.registered_site,'origin',policy.origin,'signingKeySha256',encode(policy.signing_key_sha256,'hex'))
 FROM app.creative_media_affiliate_publications a JOIN app.creative_media_products p ON p.workspace_id=a.workspace_id AND p.product_id=a.product_id AND p.revision=a.product_revision
 JOIN app.creative_media_link_evidence e ON e.workspace_id=a.workspace_id AND e.command_id=a.evidence_command_id
 JOIN app_private.creative_media_link_public_policy policy ON policy.id=1 AND policy.enabled
 WHERE a.id=p_publication AND e.expires_at>clock_timestamp() AND e.product_revision=p.revision AND e.link_sha256=a.link_sha256 AND e.disclosure_version=p.disclosure_version
  AND p.owner_channel_eligible AND p.owner_product_reviewed AND p.network='amazon_associates' AND a.link_sha256=encode(public.digest(p.proposed_affiliate_url,'sha256'),'hex')
  AND NOT EXISTS(SELECT 1 FROM app.creative_media_products newer WHERE newer.workspace_id=p.workspace_id AND newer.product_id=p.product_id AND newer.revision>p.revision)
  AND NOT EXISTS(SELECT 1 FROM app.creative_media_affiliate_withdrawals w WHERE w.workspace_id=a.workspace_id AND w.publication_id=a.id));
END $f$;
CREATE FUNCTION app_private.creative_media_affiliate_click(p_token text)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE policy app_private.creative_media_link_public_policy;parts text[];payload text;page jsonb;ws uuid;added integer;
BEGIN
 IF p_token IS NULL OR length(p_token)>300 OR p_token!~'^[a-f0-9-]{36}[.][a-f0-9-]{36}[.][0-9]{10}[.][0-9]{1,4}[.][a-f0-9]{64}$' THEN RETURN false; END IF;
 SELECT * INTO policy FROM app_private.creative_media_link_public_policy WHERE id=1 AND enabled;
 IF policy.id IS NULL THEN RETURN false; END IF;
 parts:=string_to_array(p_token,'.');payload:=parts[1]||'.'||parts[2]||'.'||parts[3]||'.'||parts[4];
 -- Only the dedicated backend capability may call this after constant-time HMAC verification.
 IF parts[3]::bigint<extract(epoch from clock_timestamp()) OR parts[3]::bigint>extract(epoch from clock_timestamp())+600 THEN RETURN false; END IF;
 page:=app_private.creative_media_affiliate_page(parts[1]::uuid);
 IF page IS NULL OR page->>'productRevision' IS DISTINCT FROM parts[4] THEN RETURN false; END IF;
 SELECT workspace_id INTO ws FROM app.creative_media_affiliate_publications WHERE id=parts[1]::uuid;
 PERFORM pg_advisory_xact_lock(hashtextextended('affiliate-click:'||parts[1],0));
 IF (SELECT count(*) FROM app.creative_media_affiliate_clicks WHERE publication_id=parts[1]::uuid AND occurred_at>clock_timestamp()-interval '1 day')>=10000 THEN RETURN false; END IF;
 INSERT INTO app.creative_media_affiliate_clicks(workspace_id,publication_id,nonce) VALUES(ws,parts[1]::uuid,parts[2]::uuid) ON CONFLICT DO NOTHING;
 GET DIAGNOSTICS added=ROW_COUNT;RETURN added=1;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END $f$;
REVOKE ALL ON FUNCTION app_private.creative_media_affiliate_page(uuid),app_private.creative_media_affiliate_click(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.creative_media_affiliate_page(uuid) TO r72_public;
RESET ROLE;SET LOCAL ROLE r72_owner;REVOKE CREATE ON SCHEMA app_private FROM r72_media_public_definer;

SET LOCAL ROLE r72_owner;
GRANT USAGE ON SCHEMA app_private TO r72_media_click_command;
SET LOCAL ROLE r72_media_public_definer;
GRANT EXECUTE ON FUNCTION app_private.creative_media_affiliate_click(text) TO r72_media_click_command;
RESET ROLE;SET LOCAL ROLE r72_owner;
GRANT DELETE ON app.creative_media_affiliate_clicks TO r72_media_public_definer;
GRANT CREATE ON SCHEMA app_private TO r72_media_public_definer;
SET LOCAL ROLE r72_media_public_definer;
CREATE FUNCTION app_private.creative_media_click_retention() RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE n integer;
BEGIN
 DELETE FROM app.creative_media_affiliate_clicks WHERE (workspace_id,publication_id,nonce) IN
 (SELECT workspace_id,publication_id,nonce FROM app.creative_media_affiliate_clicks WHERE occurred_at<clock_timestamp()-interval '30 days' ORDER BY occurred_at LIMIT 1000 FOR UPDATE SKIP LOCKED);
 GET DIAGNOSTICS n=ROW_COUNT;RETURN n;
END $f$;
REVOKE ALL ON FUNCTION app_private.creative_media_click_retention() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.creative_media_click_retention() TO r72_worker;
RESET ROLE;SET LOCAL ROLE r72_owner;REVOKE CREATE ON SCHEMA app_private FROM r72_media_public_definer;
