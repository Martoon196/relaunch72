-- 0154: Martin Howard Property's content tools use its EXISTING workspace. Additive only.
--
-- Owner decision (14 November 2026): the SEO blog, Brand DNA and approvals for Martin Howard Property attach to the
-- live MHP brand workspace (2789228d-55a6-4688-b1e8-2f70abca990b in organisation ba41b1a4-9752-4dbf-8312-d04a0f03d0b8,
-- created by 0124 and holding the CRM, webinars and email), never to a second empty workspace made by "Add a business".
--
-- Two definer functions, owned and granted exactly like seo_blog_create_brand (0131): r72_owner, EXECUTE for
-- r72_content_command only, and each refuses any other session user.
--   * seo_blog_attach_workspace_offer(workspace): whether the signed-in portal user may attach MHP and it is not yet
--     attached. Read only.
--   * seo_blog_attach_workspace(command, workspace, website, settings): inserts the one app.seo_blog_brands row for the
--     MHP workspace (ON CONFLICT (workspace_id) DO NOTHING) and the caller's seo_blog_brand_commands receipt, and says
--     whether it attached now or was already attached. Idempotent per (user, command).
-- Both accept only the pinned MHP workspace in the pinned organisation. The caller must be an active owner of that
-- organisation (the rule seo_blog_create_brand uses) and able to manage that workspace (the rule seo_blog_list_brands
-- uses to show a brand), so the attached row is exactly the one listBrands then returns to them.
--
-- Nothing else: no workspace, organisation or membership is created or changed; no CRM, consent, webinar, email or
-- MHP table is read or written; no table is altered, no row rewritten, no trigger added, no role created. The 0145
-- BEFORE INSERT trigger seo_limits_brand_defaults still fires on this insert, so the attached brand starts with every
-- operator allowance and budget at 0 (and studio images off) whatever settings are passed: nothing can spend until
-- the founder sets limits.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

SET LOCAL ROLE r72_owner;

CREATE FUNCTION app_private.seo_blog_attach_workspace_offer(p_workspace uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid:=app_private.current_user_id();
BEGIN
 IF session_user<>'r72_content_command' THEN RAISE EXCEPTION 'Content command boundary required' USING ERRCODE='42501'; END IF;
 IF app_private.current_actor_kind() IS DISTINCT FROM 'user' OR actor IS NULL
  OR p_workspace IS DISTINCT FROM '2789228d-55a6-4688-b1e8-2f70abca990b'::uuid THEN RETURN false; END IF;
 RETURN EXISTS(SELECT 1 FROM app.workspaces w JOIN app.organizations o ON o.id=w.organization_id
   WHERE w.id='2789228d-55a6-4688-b1e8-2f70abca990b' AND w.organization_id='ba41b1a4-9752-4dbf-8312-d04a0f03d0b8'
    AND w.slug::text='mhp-brand-marketing' AND w.status='active' AND o.status='active')
  AND EXISTS(SELECT 1 FROM app.organization_memberships m
   WHERE m.organization_id='ba41b1a4-9752-4dbf-8312-d04a0f03d0b8' AND m.user_id=actor
    AND m.role='owner' AND m.status='active' AND m.revoked_at IS NULL)
  AND app_private.can_manage_workspace(actor,'2789228d-55a6-4688-b1e8-2f70abca990b')
  AND NOT EXISTS(SELECT 1 FROM app.seo_blog_brands b WHERE b.workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b');
END $f$;

CREATE FUNCTION app_private.seo_blog_attach_workspace(p_command uuid, p_workspace uuid, p_website text, p_settings jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE
 actor uuid:=app_private.current_user_id();
 brand CONSTANT uuid:='2789228d-55a6-4688-b1e8-2f70abca990b';
 org CONSTANT uuid:='ba41b1a4-9752-4dbf-8312-d04a0f03d0b8';
 existing uuid;
 attached boolean;
BEGIN
 IF session_user<>'r72_content_command' THEN RAISE EXCEPTION 'Content command boundary required' USING ERRCODE='42501'; END IF;
 IF app_private.current_actor_kind() IS DISTINCT FROM 'user' OR actor IS NULL OR app_private.current_workspace_id() IS NULL OR p_command IS NULL THEN
  RAISE EXCEPTION 'Owner session required' USING ERRCODE='42501'; END IF;
 IF p_workspace IS DISTINCT FROM brand THEN RAISE EXCEPTION 'Only the Martin Howard Property workspace can be attached' USING ERRCODE='42501'; END IF;
 IF (p_website IS NOT NULL AND (p_website !~ '^https?://[^/?#[:space:]]+$' OR length(p_website)>300))
  OR p_settings IS NULL OR jsonb_typeof(p_settings)<>'object' THEN
  RAISE EXCEPTION 'Invalid brand' USING ERRCODE='22023'; END IF;
 -- The same per-user lock as seo_blog_create_brand, so an attach and an add by one person never interleave.
 PERFORM pg_advisory_xact_lock(hashtextextended('seo-blog-brand:'||actor::text,131));
 SELECT c.workspace_id INTO existing FROM app.seo_blog_brand_commands c WHERE c.user_id=actor AND c.command_id=p_command;
 IF existing IS NOT NULL THEN
  IF existing<>brand THEN RAISE EXCEPTION 'This command was used for another business' USING ERRCODE='22023'; END IF;
  RETURN jsonb_build_object('workspaceId',existing,'attached',false);
 END IF;
 IF NOT EXISTS(SELECT 1 FROM app.workspaces w JOIN app.organizations o ON o.id=w.organization_id
    WHERE w.id=brand AND w.organization_id=org AND w.slug::text='mhp-brand-marketing' AND w.status='active' AND o.status='active')
  OR NOT EXISTS(SELECT 1 FROM app.organization_memberships m
    WHERE m.organization_id=org AND m.user_id=actor AND m.role='owner' AND m.status='active' AND m.revoked_at IS NULL)
  OR NOT app_private.can_manage_workspace(actor,brand) THEN
  RAISE EXCEPTION 'Only the Martin Howard Property owner can use its workspace here' USING ERRCODE='42501';
 END IF;
 INSERT INTO app.seo_blog_brands(workspace_id,organization_id,created_by_user_id,website,settings)
  VALUES(brand,org,actor,p_website,p_settings) ON CONFLICT (workspace_id) DO NOTHING;
 attached:=FOUND;
 INSERT INTO app.seo_blog_brand_commands(user_id,command_id,workspace_id) VALUES(actor,p_command,brand);
 RETURN jsonb_build_object('workspaceId',brand,'attached',attached);
END $f$;

REVOKE ALL ON FUNCTION app_private.seo_blog_attach_workspace_offer(uuid),
 app_private.seo_blog_attach_workspace(uuid,uuid,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.seo_blog_attach_workspace_offer(uuid),
 app_private.seo_blog_attach_workspace(uuid,uuid,text,jsonb) TO r72_content_command;

RESET ROLE;
