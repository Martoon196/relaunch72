-- PRIVATE DRAFT: fresh programme/site assertions bound to exact product revision.
-- Evidence is owner supplied, not merchant API verification or publication authority.
SET LOCAL ROLE r72_owner;
CREATE TABLE app.creative_media_link_evidence (
 workspace_id uuid NOT NULL, command_id uuid NOT NULL,
 product_id uuid NOT NULL, product_revision integer NOT NULL,
 link_sha256 text NOT NULL CHECK(link_sha256~'^[a-f0-9]{64}$'),
 evidence_sha256 text NOT NULL CHECK(evidence_sha256~'^[a-f0-9]{64}$'),
 registered_site text NOT NULL CHECK(length(registered_site) BETWEEN 12 AND 2048 AND registered_site~'^https://[^[:space:]<>]+$'),
 disclosure_version text NOT NULL CHECK(length(disclosure_version) BETWEEN 1 AND 60),
 input_sha256 text NOT NULL CHECK(input_sha256~'^[a-f0-9]{64}$'),
 created_by uuid NOT NULL REFERENCES app.users(id), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL, PRIMARY KEY(workspace_id,command_id),
 FOREIGN KEY(workspace_id,product_id,product_revision) REFERENCES app.creative_media_products(workspace_id,product_id,revision),
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '30 days')
);
ALTER TABLE app.creative_media_link_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.creative_media_link_evidence FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app.creative_media_link_evidence FROM PUBLIC,r72_web,r72_worker,r72_content_command;
CREATE POLICY creative_media_link_evidence_owner ON app.creative_media_link_evidence FOR ALL TO r72_owner USING(true) WITH CHECK(true);
CREATE POLICY creative_media_link_evidence_scope ON app.creative_media_link_evidence FOR ALL TO r72_creative_studio_definer USING(workspace_id=app_private.current_workspace_id()) WITH CHECK(workspace_id=app_private.current_workspace_id());
GRANT SELECT,INSERT ON app.creative_media_link_evidence TO r72_creative_studio_definer;
CREATE TRIGGER creative_media_link_evidence_immutable BEFORE UPDATE OR DELETE ON app.creative_media_link_evidence FOR EACH ROW EXECUTE FUNCTION app_private.seo_blog_append_only();
INSERT INTO app_private.workspace_table_registry(schema_name,table_name,workspace_column) VALUES('app','creative_media_link_evidence','workspace_id');
GRANT CREATE ON SCHEMA app_private TO r72_creative_studio_definer;
SET LOCAL ROLE r72_creative_studio_definer;
CREATE FUNCTION app_private.creative_media_link_evidence(p_workspace uuid,p_session bytea,p_action text,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; product app.creative_media_products; previous app.creative_media_link_evidence; hash text; at_now timestamptz:=clock_timestamp();
BEGIN
 IF p_session IS NULL OR app_private.current_actor_kind() IS DISTINCT FROM 'user' THEN RAISE EXCEPTION 'Owner session required' USING ERRCODE='42501'; END IF;
 actor:=app_private.seo_media_owner(p_workspace,p_session);
 IF p_action='list' THEN
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('commandId',e.command_id,'productId',e.product_id,'productRevision',e.product_revision,
   'linkSha256',e.link_sha256,'evidenceSha256',e.evidence_sha256,'registeredSite',e.registered_site,'disclosureVersion',e.disclosure_version,
   'expiresAt',e.expires_at,'current',e.expires_at>at_now AND e.product_revision=(SELECT max(revision) FROM app.creative_media_products p WHERE p.workspace_id=e.workspace_id AND p.product_id=e.product_id),
   'status','owner_asserted_private') ORDER BY e.created_at DESC) FROM app.creative_media_link_evidence e WHERE workspace_id=p_workspace),'[]'::jsonb);
 END IF;
 IF p_action IS DISTINCT FROM 'save' OR p_input IS NULL OR jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR octet_length(p_input::text)>3500
  OR coalesce(p_input->>'commandId','')!~'^[a-f0-9-]{36}$' OR coalesce(p_input->>'productId','')!~'^[a-f0-9-]{36}$'
  OR coalesce(p_input->>'productRevision','')!~'^[0-9]{1,4}$' OR coalesce(p_input->>'linkSha256','')!~'^[a-f0-9]{64}$'
  OR coalesce(p_input->>'evidenceSha256','')!~'^[a-f0-9]{64}$' OR p_input->>'programmeConfirmed' IS DISTINCT FROM 'true'
  OR p_input->>'siteConfirmed' IS DISTINCT FROM 'true' OR p_input->>'tagOwnershipConfirmed' IS DISTINCT FROM 'true'
  OR coalesce(p_input->>'registeredSite','')!~'^https://[^[:space:]<>]+$' THEN RAISE EXCEPTION 'Exact programme evidence required' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('media-link:'||p_workspace::text,0));
 hash:=encode(public.digest(p_input::text,'sha256'),'hex');
 SELECT * INTO previous FROM app.creative_media_link_evidence WHERE workspace_id=p_workspace AND command_id=(p_input->>'commandId')::uuid;
 IF previous.command_id IS NOT NULL THEN
  IF previous.input_sha256<>hash THEN RAISE EXCEPTION 'Link evidence replay changed input' USING ERRCODE='40001'; END IF;
  RETURN jsonb_build_object('commandId',previous.command_id,'replayed',true,'status','owner_asserted_private'); END IF;
 SELECT * INTO product FROM app.creative_media_products WHERE workspace_id=p_workspace AND product_id=(p_input->>'productId')::uuid ORDER BY revision DESC LIMIT 1;
 IF product.product_id IS NULL OR product.revision IS DISTINCT FROM (p_input->>'productRevision')::integer
  OR product.proposed_affiliate_url IS NULL OR product.network<>'amazon_associates'
  OR encode(public.digest(product.proposed_affiliate_url,'sha256'),'hex') IS DISTINCT FROM p_input->>'linkSha256'
  OR product.disclosure_version IS DISTINCT FROM p_input->>'disclosureVersion'
  OR NOT product.owner_channel_eligible OR NOT product.owner_product_reviewed THEN RAISE EXCEPTION 'Current exact product proposal required' USING ERRCODE='55000'; END IF;
 INSERT INTO app.creative_media_link_evidence(workspace_id,command_id,product_id,product_revision,link_sha256,evidence_sha256,registered_site,disclosure_version,input_sha256,created_by,created_at,expires_at)
 VALUES(p_workspace,(p_input->>'commandId')::uuid,product.product_id,product.revision,p_input->>'linkSha256',p_input->>'evidenceSha256',p_input->>'registeredSite',product.disclosure_version,hash,actor,at_now,at_now+interval '30 days');
 RETURN jsonb_build_object('commandId',p_input->>'commandId','replayed',false,'status','owner_asserted_private');
END $f$;
REVOKE ALL ON FUNCTION app_private.creative_media_link_evidence(uuid,bytea,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.creative_media_link_evidence(uuid,bytea,text,jsonb) TO r72_content_command;
RESET ROLE;SET LOCAL ROLE r72_owner;REVOKE CREATE ON SCHEMA app_private FROM r72_creative_studio_definer;
