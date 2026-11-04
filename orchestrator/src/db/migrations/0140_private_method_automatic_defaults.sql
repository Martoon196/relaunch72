-- Explicit owner-authorised automatic defaults for enrolled private organisations.
-- Existing explicit assignments, including an empty off revision, always win.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
SET LOCAL ROLE r72_owner;
ALTER TABLE app.seo_blog_method_private_organizations
  ADD COLUMN automatic_defaults boolean NOT NULL DEFAULT false,
  ADD COLUMN default_owner_user_id uuid REFERENCES app.users(id),
  ADD CONSTRAINT seo_method_default_owner_required CHECK(NOT automatic_defaults OR default_owner_user_id IS NOT NULL);
ALTER TABLE app.seo_blog_method_assignments ADD COLUMN origin text NOT NULL DEFAULT 'owner' CHECK(origin IN ('owner','private-default'));
GRANT EXECUTE ON FUNCTION app_private.can_manage_workspace(uuid,uuid) TO r72_seo_method_definer;
GRANT CREATE ON SCHEMA app_private TO r72_seo_method_definer;
SET LOCAL ROLE r72_seo_method_definer;

CREATE FUNCTION app_private.seo_method_ensure_defaults(p_workspace uuid)
RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE b app.seo_blog_brands; policy app.seo_blog_method_private_organizations; pins jsonb; revision_now integer;
BEGIN
  IF p_workspace IS DISTINCT FROM app_private.current_workspace_id() THEN RAISE EXCEPTION 'Default method workspace mismatch' USING ERRCODE='42501'; END IF;
  SELECT * INTO b FROM app.seo_blog_brands WHERE workspace_id=p_workspace;
  IF b.workspace_id IS NULL THEN RETURN 0; END IF;
  SELECT * INTO policy FROM app.seo_blog_method_private_organizations WHERE organization_id=b.organization_id AND automatic_defaults;
  IF policy.organization_id IS NULL THEN RETURN 0; END IF;
  PERFORM workspace_id FROM app.seo_blog_brands WHERE workspace_id=p_workspace FOR UPDATE;
  SELECT max(revision) INTO revision_now FROM app.seo_blog_method_assignments WHERE workspace_id=p_workspace;
  IF revision_now IS NOT NULL THEN RETURN revision_now; END IF;
  IF NOT app_private.can_manage_workspace(policy.default_owner_user_id,p_workspace) THEN
    RAISE EXCEPTION 'The configured private owner no longer manages this brand' USING ERRCODE='42501'; END IF;
  SELECT jsonb_agg(jsonb_build_object('packId',pack_id,'version',version,'hash',canonical_sha256) ORDER BY pack_id) INTO pins
  FROM app.seo_blog_method_releases WHERE version='0.1.1' AND private_approval='approved' AND length(review_evidence)>0
    AND pack_id IN ('production-core','editorial-planning','blog-writing','conversion-copy','social-repurposing','visual-briefing','email-writing','advocacy-and-referral');
  IF jsonb_array_length(pins) IS DISTINCT FROM 8 THEN RAISE EXCEPTION 'The complete reviewed private release is unavailable' USING ERRCODE='55000'; END IF;
  INSERT INTO app.seo_blog_method_assignments(workspace_id,revision,scope,pins,actor_user_id,origin)
    VALUES(p_workspace,1,'private-owned-brands',pins,policy.default_owner_user_id,'private-default');
  RETURN 1;
END $f$;
REVOKE ALL ON FUNCTION app_private.seo_method_ensure_defaults(uuid) FROM PUBLIC,r72_content_command,r72_web,r72_worker;

CREATE OR REPLACE FUNCTION app_private.seo_method_snapshot(p_workspace uuid,p_session bytea)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE a app.seo_blog_method_assignments; release_list jsonb; used bigint;
BEGIN
  PERFORM app_private.seo_media_private_actor(p_workspace,p_session);
  IF app_private.seo_blog_brand(p_workspace) IS NULL THEN RAISE EXCEPTION 'Brand unavailable' USING ERRCODE='42501'; END IF;
  PERFORM app_private.seo_method_ensure_defaults(p_workspace);
  SELECT * INTO a FROM app.seo_blog_method_assignments WHERE workspace_id=p_workspace ORDER BY revision DESC LIMIT 1;
  IF a.revision IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app.seo_blog_brands b JOIN app.seo_blog_method_private_organizations o ON o.organization_id=b.organization_id WHERE b.workspace_id=p_workspace) THEN
    RAISE EXCEPTION 'Private methods organization is unavailable' USING ERRCODE='42501'; END IF;
  SELECT jsonb_agg(jsonb_build_object('packId',pack_id,'version',version,'hash',canonical_sha256,
    'privateApproval',private_approval,'publicApproval',public_approval,'reviewEvidence',review_evidence) ORDER BY pack_id,version)
    INTO release_list FROM app.seo_blog_method_releases;
  SELECT coalesce(sum(amount),0) INTO used FROM app.seo_blog_usage
    WHERE workspace_id=p_workspace AND kind='model_tokens' AND at>=date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  RETURN jsonb_build_object('brandId',p_workspace,'assignment',CASE WHEN a.revision IS NULL THEN NULL ELSE
    jsonb_build_object('revision',a.revision,'scope',a.scope,'pins',a.pins,'origin',a.origin) END,'releases',coalesce(release_list,'[]'::jsonb),'tokensUsed',used);
END $f$;
RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_seo_method_definer;
