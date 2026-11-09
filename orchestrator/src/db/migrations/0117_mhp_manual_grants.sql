-- MHP-OWNER-STAFF-01: no-checkout owner/staff access with immutable grant evidence.
SET LOCAL ROLE r72_owner;
GRANT CREATE ON SCHEMA app_private TO r72_mhp_member_definer,r72_mhp_commerce_definer,r72_mhp_auth_definer;

CREATE TABLE app_private.mhp_manual_grants (
 entitlement_id uuid PRIMARY KEY REFERENCES app.entitlements(id) ON DELETE RESTRICT,
 organization_id uuid NOT NULL DEFAULT 'ba41b1a4-9752-4dbf-8312-d04a0f03d0b8' CHECK(organization_id='ba41b1a4-9752-4dbf-8312-d04a0f03d0b8'),
 command_id uuid NOT NULL UNIQUE,
 account_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
 product_id uuid NOT NULL REFERENCES app.products(id) ON DELETE RESTRICT,
 target_email text NOT NULL,
 target_name text NOT NULL,
 starts_at timestamptz NOT NULL,
 ends_at timestamptz,
 note text NOT NULL CHECK(length(btrim(note)) BETWEEN 1 AND 2000),
 grant_kind text NOT NULL CHECK(grant_kind IN('owner_seed','owner_action')),
 granted_by_user_id uuid REFERENCES app.users(id) ON DELETE RESTRICT,
 granted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 request_payload jsonb NOT NULL CHECK(jsonb_typeof(request_payload)='object'),
 CHECK(ends_at IS NULL OR ends_at>starts_at),
 CHECK((grant_kind='owner_action')=(granted_by_user_id IS NOT NULL))
);
CREATE UNIQUE INDEX mhp_owner_product_seed ON app_private.mhp_manual_grants(account_id,product_id) WHERE grant_kind='owner_seed';
ALTER TABLE app_private.mhp_manual_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.mhp_manual_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY mhp_manual_grants_owner ON app_private.mhp_manual_grants TO r72_owner USING(true) WITH CHECK(true);
CREATE POLICY mhp_manual_grants_member ON app_private.mhp_manual_grants TO r72_mhp_member_definer USING(true) WITH CHECK(true);
CREATE POLICY mhp_manual_grants_commerce ON app_private.mhp_manual_grants FOR SELECT TO r72_mhp_commerce_definer USING(true);
REVOKE ALL ON app_private.mhp_manual_grants FROM PUBLIC;
GRANT SELECT,INSERT ON app_private.mhp_manual_grants TO r72_mhp_member_definer;
GRANT SELECT ON app_private.mhp_manual_grants TO r72_mhp_commerce_definer;
CREATE FUNCTION app_private.mhp_manual_grants_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $f$
BEGIN RAISE EXCEPTION 'Manual grant evidence is immutable' USING ERRCODE='42501'; END $f$;
REVOKE ALL ON FUNCTION app_private.mhp_manual_grants_immutable() FROM PUBLIC;
CREATE TRIGGER mhp_manual_grants_immutable BEFORE UPDATE OR DELETE ON app_private.mhp_manual_grants
FOR EACH ROW EXECUTE FUNCTION app_private.mhp_manual_grants_immutable();

GRANT SELECT ON app.products TO r72_mhp_member_definer;
GRANT SELECT,INSERT ON app.entitlements TO r72_mhp_member_definer;
CREATE POLICY mhp_member_products ON app.products FOR SELECT TO r72_mhp_member_definer USING(organization_id='ba41b1a4-9752-4dbf-8312-d04a0f03d0b8' AND brand='martin_howard_property');
CREATE POLICY mhp_member_entitlements ON app.entitlements TO r72_mhp_member_definer
USING(EXISTS(SELECT 1 FROM app.products p WHERE p.id=product_id AND p.organization_id='ba41b1a4-9752-4dbf-8312-d04a0f03d0b8' AND p.brand='martin_howard_property'))
WITH CHECK(source='manual' AND purchase_id IS NULL AND EXISTS(SELECT 1 FROM app.products p WHERE p.id=product_id AND p.organization_id='ba41b1a4-9752-4dbf-8312-d04a0f03d0b8' AND p.brand='martin_howard_property'));
GRANT INSERT(email,display_name,status) ON app.users TO r72_mhp_member_definer;
CREATE POLICY mhp_member_pending_user ON app.users FOR INSERT TO r72_mhp_member_definer
WITH CHECK(status='pending' AND password_hash IS NULL AND email_verified_at IS NULL);

-- Existing canonical people retain passwords, verification and suspension state.
INSERT INTO app.users(email,display_name,status) VALUES
 ('martin.howard1984@gmail.com','Martin Howard','pending'),
 ('office@propertypredator.com','Property Predator Office','pending') ON CONFLICT(email) DO NOTHING;
INSERT INTO app.organization_memberships(organization_id,user_id,role,status)
SELECT 'ba41b1a4-9752-4dbf-8312-d04a0f03d0b8',id,'owner','active' FROM app.users
WHERE lower(email::text) IN('martin.howard1984@gmail.com','office@propertypredator.com')
ON CONFLICT(organization_id,user_id) DO UPDATE SET role='owner',updated_at=clock_timestamp()
WHERE app.organization_memberships.status='active';
DO $seed$
DECLARE u record;p record;e uuid;stamp timestamptz:=clock_timestamp();
BEGIN
 FOR u IN SELECT id,email::text AS email,COALESCE(display_name,email::text) AS name FROM app.users
 WHERE lower(email::text) IN('martin.howard1984@gmail.com','office@propertypredator.com') LOOP
  FOR p IN SELECT * FROM app.products WHERE organization_id='ba41b1a4-9752-4dbf-8312-d04a0f03d0b8' AND brand='martin_howard_property' LOOP
   IF EXISTS(SELECT 1 FROM app_private.mhp_manual_grants WHERE account_id=u.id AND product_id=p.id AND grant_kind='owner_seed') THEN CONTINUE; END IF;
   e:=gen_random_uuid();
   INSERT INTO app.entitlements(id,account_id,product_id,grants,starts_at,source,source_reference)
   VALUES(e,u.id,p.id,p.grants,stamp,'manual','mhp-owner-seed-0117');
   INSERT INTO app_private.mhp_manual_grants(entitlement_id,command_id,account_id,product_id,target_email,target_name,starts_at,note,grant_kind,request_payload)
   VALUES(e,gen_random_uuid(),u.id,p.id,lower(u.email),u.name,stamp,'Founder-authorised permanent owner access: MHP-OWNER-STAFF-01','owner_seed',jsonb_build_object('migration','0117','owner',lower(u.email),'product',p.id));
  END LOOP;
 END LOOP;
END $seed$;

SET LOCAL ROLE r72_mhp_commerce_definer;
-- Historical manual grantees may still open their account after expiry, just as
-- former buyers can. Actual Desk features always use current entitlement dates.
CREATE FUNCTION app_private.mhp_has_eligible_email(p_email text) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT app_private.mhp_has_purchase_email(p_email) OR EXISTS(
  SELECT 1 FROM app.users u JOIN app.entitlements e ON e.account_id=u.id JOIN app.products p ON p.id=e.product_id
  WHERE lower(u.email::text)=lower(btrim(p_email)) AND e.source IN('manual','bonus','cohort')
  AND p.organization_id='ba41b1a4-9752-4dbf-8312-d04a0f03d0b8' AND p.brand='martin_howard_property')
$f$;
REVOKE ALL ON FUNCTION app_private.mhp_has_eligible_email(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.mhp_has_eligible_email(text) TO r72_mhp_member_definer,r72_mhp_auth_definer;

-- Programme tier changes affect only the programme's own grants. They cannot
-- end a permanent owner grant or an independently audited /hq staff grant.
CREATE OR REPLACE FUNCTION app_private.mhp_set_manual_access(p_user uuid,p_enabled boolean,p_tier text,p_reference text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE p app.products%ROWTYPE;
BEGIN
 IF p_enabled IS NULL OR p_tier NOT IN('course','mentoring','partnership') OR (p_enabled AND (p_reference IS NULL OR length(btrim(p_reference)) NOT BETWEEN 1 AND 200)) THEN RAISE EXCEPTION 'Invalid manual grant' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_user::text,114));
 IF p_enabled THEN
  SELECT * INTO p FROM app.products WHERE sku=CASE WHEN p_tier='course' THEN 'mhp_course' ELSE 'mhp_mentoring' END AND organization_id='ba41b1a4-9752-4dbf-8312-d04a0f03d0b8' AND brand='martin_howard_property';
  IF EXISTS(SELECT 1 FROM app.entitlements e WHERE account_id=p_user AND source='manual' AND product_id=p.id AND source_reference=p_reference AND ends_at IS NULL
   AND NOT EXISTS(SELECT 1 FROM app_private.mhp_manual_grants g WHERE g.entitlement_id=e.id)) THEN RETURN; END IF;
 END IF;
 UPDATE app.entitlements e SET ends_at=GREATEST(starts_at,clock_timestamp()),read_only_until=NULL
 WHERE account_id=p_user AND source='manual' AND (ends_at IS NULL OR ends_at>clock_timestamp())
 AND NOT EXISTS(SELECT 1 FROM app_private.mhp_manual_grants g WHERE g.entitlement_id=e.id);
 IF p_enabled THEN INSERT INTO app.entitlements(account_id,product_id,grants,starts_at,source,source_reference) VALUES(p_user,p.id,p.grants,statement_timestamp(),'manual',p_reference); END IF;
END $f$;

SET LOCAL ROLE r72_mhp_auth_definer;
CREATE OR REPLACE FUNCTION app_private.mhp_auth_eligible(p_email text)
RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT p_email IN('office@propertypredator.com','martin.howard1984@gmail.com')
 OR app_private.mhp_has_eligible_email(p_email)
 OR EXISTS(SELECT 1 FROM app_private.mhp_members m WHERE lower(m.owner_email::text)=p_email AND (m.user_id IS NOT NULL OR m.manual_active))
$f$;

SET LOCAL ROLE r72_mhp_member_definer;
CREATE FUNCTION app_private.mhp_is_owner(p_session bytea) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT EXISTS(SELECT 1 FROM app_private.resolve_session(p_session) r
 JOIN app.user_sessions s ON s.id=r.session_id AND s.product_audience='martin_howard_property'
 JOIN app.users u ON u.id=r.user_id AND u.status='active' AND u.email_verified_at IS NOT NULL
 JOIN app.organization_memberships om ON om.user_id=u.id AND om.organization_id='ba41b1a4-9752-4dbf-8312-d04a0f03d0b8' AND om.role='owner' AND om.status='active' AND om.revoked_at IS NULL
 JOIN app_private.mhp_members m ON m.workspace_id=r.selected_workspace_id)
$f$;

CREATE FUNCTION app_private.mhp_hq_snapshot(p_session bytea,p_search text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE q text:=NULLIF(lower(btrim(p_search)),'');
BEGIN
 IF NOT app_private.mhp_is_owner(p_session) THEN RAISE EXCEPTION 'MHP owner access required' USING ERRCODE='42501'; END IF;
 IF length(q)>200 THEN RAISE EXCEPTION 'Search is too long' USING ERRCODE='22023'; END IF;
 RETURN jsonb_build_object(
 'people',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'name',name,'email',email) ORDER BY email) FROM(
  SELECT u.id,COALESCE(u.display_name,u.email::text) AS name,u.email::text AS email FROM app.users u
  WHERE (q IS NULL OR position(q in lower(u.email::text))>0 OR position(q in lower(COALESCE(u.display_name,'')))>0)
  AND (EXISTS(SELECT 1 FROM app_private.mhp_members m WHERE m.user_id=u.id)
   OR EXISTS(SELECT 1 FROM app.entitlements e JOIN app.products p ON p.id=e.product_id WHERE e.account_id=u.id AND p.brand='martin_howard_property' AND p.organization_id='ba41b1a4-9752-4dbf-8312-d04a0f03d0b8')
   OR EXISTS(SELECT 1 FROM app.organization_memberships om WHERE om.user_id=u.id AND om.organization_id='ba41b1a4-9752-4dbf-8312-d04a0f03d0b8'))
  ORDER BY lower(u.email::text),u.id LIMIT 100) people),'[]'::jsonb),
 'products',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'sku',sku,'name',name) ORDER BY sku) FROM(
  SELECT id,sku,name FROM app.products WHERE organization_id='ba41b1a4-9752-4dbf-8312-d04a0f03d0b8' AND brand='martin_howard_property' AND active ORDER BY sku LIMIT 100) products),'[]'::jsonb),
 'grants',COALESCE((SELECT jsonb_agg(item ORDER BY granted_at DESC,entitlement_id) FROM(
  SELECT g.entitlement_id,g.granted_at,jsonb_build_object('id',g.entitlement_id,'accountId',g.account_id,'name',g.target_name,'email',g.target_email,'productName',p.name,
  'startsAt',g.starts_at,'endsAt',g.ends_at,'note',g.note,'grantedBy',COALESCE(actor.display_name,actor.email::text,'Founder-authorised release seed'),'grantedAt',g.granted_at) item
  FROM app_private.mhp_manual_grants g JOIN app.products p ON p.id=g.product_id LEFT JOIN app.users actor ON actor.id=g.granted_by_user_id
  WHERE g.organization_id='ba41b1a4-9752-4dbf-8312-d04a0f03d0b8' AND (q IS NULL OR position(q in g.target_email)>0 OR position(q in lower(g.target_name))>0)
  ORDER BY g.granted_at DESC,g.entitlement_id LIMIT 200) grants),'[]'::jsonb));
END $f$;

CREATE FUNCTION app_private.mhp_grant_manual_access(p_session bytea,p_command uuid,p_target_email text,p_target_name text,p_product uuid,p_ends_at timestamptz,p_note text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid;v_email text:=lower(btrim(p_target_email));v_name text:=NULLIF(btrim(p_target_name),'');v_note text:=btrim(p_note);effective_name text;
 person app.users%ROWTYPE;product app.products%ROWTYPE;prior app_private.mhp_manual_grants%ROWTYPE;payload jsonb;e uuid;stamp timestamptz;
BEGIN
 IF NOT app_private.mhp_is_owner(p_session) THEN RAISE EXCEPTION 'MHP owner access required' USING ERRCODE='42501'; END IF;
 SELECT user_id INTO actor FROM app_private.resolve_session(p_session);
 IF NOT app_private.lock_active_portal_session(p_session,actor,(SELECT selected_workspace_id FROM app_private.resolve_session(p_session))) THEN RAISE EXCEPTION 'Session unavailable' USING ERRCODE='42501'; END IF;
 IF p_command IS NULL OR p_product IS NULL OR v_email IS NULL OR length(v_email) NOT BETWEEN 3 AND 320 OR v_email !~ '^[^[:space:]<>@]+@[^[:space:]<>@]+\.[^[:space:]<>@]+$'
 OR (v_name IS NOT NULL AND (length(v_name)>200 OR v_name ~ '[[:cntrl:]]')) OR v_note IS NULL OR length(v_note) NOT BETWEEN 1 AND 2000 THEN RAISE EXCEPTION 'Check the person, product and reason' USING ERRCODE='22023'; END IF;
 payload:=jsonb_build_object('actor',actor,'email',v_email,'name',v_name,'product',p_product,'endsAt',p_ends_at,'note',v_note);
 PERFORM pg_advisory_xact_lock(hashtextextended(p_command::text,117));
 SELECT * INTO prior FROM app_private.mhp_manual_grants WHERE command_id=p_command;
 IF FOUND THEN
  IF prior.request_payload<>payload THEN RAISE EXCEPTION 'Grant command changed' USING ERRCODE='40001'; END IF;
  RETURN prior.entitlement_id;
 END IF;
 stamp:=clock_timestamp();
 IF p_ends_at IS NOT NULL AND (NOT isfinite(p_ends_at) OR p_ends_at<=stamp) THEN RAISE EXCEPTION 'Expiry must be in the future' USING ERRCODE='22023'; END IF;
 SELECT * INTO product FROM app.products WHERE id=p_product AND organization_id='ba41b1a4-9752-4dbf-8312-d04a0f03d0b8' AND brand='martin_howard_property' AND active;
 IF NOT FOUND THEN RAISE EXCEPTION 'MHP product unavailable' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(v_email,115));
 INSERT INTO app.users(email,display_name,status) VALUES(v_email,COALESCE(v_name,left(split_part(v_email,'@',1),200)),'pending') ON CONFLICT(email) DO NOTHING;
 SELECT * INTO person FROM app.users u WHERE lower(u.email::text)=v_email;
 IF person.status NOT IN('pending','active') THEN RAISE EXCEPTION 'Account unavailable' USING ERRCODE='42501'; END IF;
 effective_name:=COALESCE(person.display_name,v_name,left(split_part(v_email,'@',1),200));
 e:=gen_random_uuid();
 INSERT INTO app.entitlements(id,account_id,product_id,grants,starts_at,ends_at,source,source_reference)
 VALUES(e,person.id,product.id,product.grants,stamp,p_ends_at,'manual','mhp-hq:'||p_command::text);
 INSERT INTO app_private.mhp_manual_grants(entitlement_id,command_id,account_id,product_id,target_email,target_name,starts_at,ends_at,note,grant_kind,granted_by_user_id,granted_at,request_payload)
 VALUES(e,p_command,person.id,product.id,v_email,effective_name,stamp,p_ends_at,v_note,'owner_action',actor,stamp,payload);
 RETURN e;
END $f$;
REVOKE ALL ON FUNCTION app_private.mhp_is_owner(bytea),app_private.mhp_hq_snapshot(bytea,text),app_private.mhp_grant_manual_access(bytea,uuid,text,text,uuid,timestamptz,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.mhp_is_owner(bytea),app_private.mhp_hq_snapshot(bytea,text) TO r72_web;
GRANT EXECUTE ON FUNCTION app_private.mhp_grant_manual_access(bytea,uuid,text,text,uuid,timestamptz,text) TO r72_identity_command;

-- The verified first-login helper is replaced below with only its eligibility
-- predicate widened to the canonical purchase-or-manual-grant helper.

CREATE OR REPLACE FUNCTION app_private.ensure_mhp_member_workspace(p_user uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE person app.users%ROWTYPE; m app_private.mhp_members%ROWTYPE; ws uuid; org uuid; founder boolean; a jsonb; admin_id uuid; label text;
BEGIN
 SELECT * INTO person FROM app.users WHERE id=p_user AND status='active' AND email_verified_at IS NOT NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'Verified MHP identity required' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(lower(person.email::text),113));
 founder:=lower(person.email::text) IN('office@propertypredator.com','martin.howard1984@gmail.com');
 IF founder THEN INSERT INTO app_private.investor_programme_admins(user_id) VALUES(p_user) ON CONFLICT DO NOTHING; END IF;
 SELECT * INTO m FROM app_private.mhp_members WHERE owner_email=person.email FOR UPDATE;
 IF m.user_id IS NOT NULL AND m.user_id<>p_user THEN RAISE EXCEPTION 'MHP identity binding conflict' USING ERRCODE='42501'; END IF;
 IF NOT founder AND NOT app_private.mhp_has_eligible_email(lower(person.email::text)) AND NOT COALESCE(m.manual_active,false) THEN
  RAISE EXCEPTION 'MHP membership unavailable' USING ERRCODE='42501'; END IF;
 IF m.workspace_id IS NULL THEN
  org:=gen_random_uuid(); ws:=gen_random_uuid(); label:=left(COALESCE(NULLIF(person.display_name,''),split_part(person.email::text,'@',1))||' · Your Desk',100);
  INSERT INTO app.organizations(id,name,slug,kind) VALUES(org,label,'mhp-'||org::text,'direct_customer');
  INSERT INTO app.workspaces(id,organization_id,name,slug) VALUES(ws,org,label,'mhp-'||ws::text);
  INSERT INTO app_private.mhp_members(workspace_id,user_id,owner_email) VALUES(ws,p_user,lower(person.email::text));
 ELSE
  ws:=m.workspace_id;
  SELECT organization_id INTO org FROM app.workspaces WHERE id=ws;
  UPDATE app_private.mhp_members SET user_id=p_user WHERE workspace_id=ws;
 END IF;
 INSERT INTO app.organization_memberships(organization_id,user_id,role,status) VALUES(org,p_user,'owner','active') ON CONFLICT DO NOTHING;
 INSERT INTO app.workspace_memberships(workspace_id,organization_id,user_id,role,status) VALUES(ws,org,p_user,'owner','active') ON CONFLICT DO NOTHING;
 -- Both verified founder identities get oversight of MHP workspaces only.
 INSERT INTO app.organization_memberships(organization_id,user_id,role,status)
 SELECT org,u.id,'admin','active' FROM app.users u WHERE app_private.mhp_is_programme_admin(u.id) ON CONFLICT DO NOTHING;
 INSERT INTO app.workspace_memberships(workspace_id,organization_id,user_id,role,status)
 SELECT ws,org,u.id,'admin','active' FROM app.users u WHERE app_private.mhp_is_programme_admin(u.id) ON CONFLICT DO NOTHING;
 IF founder THEN
  INSERT INTO app.organization_memberships(organization_id,user_id,role,status)
  SELECT w.organization_id,p_user,'admin','active' FROM app_private.mhp_members mm JOIN app.workspaces w ON w.id=mm.workspace_id ON CONFLICT DO NOTHING;
  INSERT INTO app.workspace_memberships(workspace_id,organization_id,user_id,role,status)
  SELECT w.id,w.organization_id,p_user,'admin','active' FROM app_private.mhp_members mm JOIN app.workspaces w ON w.id=mm.workspace_id ON CONFLICT DO NOTHING;
 END IF;
 IF m.manual_active THEN PERFORM app_private.mhp_set_manual_access(p_user,true,m.manual_tier,m.manual_reference); END IF;
 UPDATE app.investor_businesses SET owner_user_id=p_user,row_version=row_version+1 WHERE workspace_id=ws AND owner_user_id IS DISTINCT FROM p_user;
 a:=app_private.mhp_account_access(p_user);
 IF (founder OR COALESCE((a->>'crm')::boolean,false)) AND NOT EXISTS(SELECT 1 FROM app.investor_businesses WHERE workspace_id=ws) THEN
  SELECT u.id INTO admin_id FROM app.users u WHERE app_private.mhp_is_programme_admin(u.id) ORDER BY CASE WHEN lower(u.email::text)='martin.howard1984@gmail.com' THEN 0 ELSE 1 END,u.id LIMIT 1;
  -- Ownership remains the verified member even before the mentor first signs in.
  admin_id:=COALESCE(admin_id,p_user);
  SELECT name INTO label FROM app.workspaces WHERE id=ws;
  PERFORM app_private.mhp_add_business(ws,admin_id,p_user,lower(person.email::text),COALESCE(person.display_name,split_part(person.email::text,'@',1)),label,
    CASE WHEN founder THEN 'test' ELSE 'active' END,gen_random_uuid(),decode(repeat('00',32),'hex'),CASE WHEN founder THEN NULL ELSE 'mhp-entitlement' END);
 END IF;
 RETURN ws;
END $f$;

RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_mhp_member_definer,r72_mhp_commerce_definer,r72_mhp_auth_definer;
RESET ROLE;
