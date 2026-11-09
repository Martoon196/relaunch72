-- RL72 Boosters: additive private registry, exact assignments and immutable production evidence.
-- No deployment, provider, pricing, subscription or paid-entitlement change.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
DO $role$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='r72_seo_method_definer') THEN
    CREATE ROLE r72_seo_method_definer NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='r72_seo_method_definer' AND NOT rolcanlogin AND NOT rolinherit
    AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls)
    OR EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname='r72_seo_method_definer') THEN
    RAISE EXCEPTION 'Unsafe method function-owner attributes/membership' USING ERRCODE='42501';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid JOIN pg_roles c ON c.oid=m.member
    WHERE r.rolname='r72_seo_method_definer' AND c.rolname NOT IN ('r72_owner',current_user)) THEN
    RAISE EXCEPTION 'Runtime method-definer membership denied' USING ERRCODE='42501';
  END IF;
  GRANT r72_seo_method_definer TO r72_owner;
END $role$;
SET LOCAL ROLE r72_owner;

CREATE TABLE app.seo_blog_method_releases(
  pack_id text NOT NULL CHECK(pack_id ~ '^[a-z][a-z0-9-]*$'), version text NOT NULL CHECK(version ~ '^[0-9]+[.][0-9]+[.][0-9]+$'),
  canonical_sha256 text NOT NULL CHECK(canonical_sha256 ~ '^[0-9a-f]{64}$'),
  scope text NOT NULL DEFAULT 'private-owned-brands' CHECK(scope='private-owned-brands'),
  private_approval text NOT NULL CHECK(private_approval IN ('pending','approved','rejected')),
  private_evidence text NOT NULL, public_approval text NOT NULL CHECK(public_approval IN ('blocked','pending','approved')),
  public_evidence text NOT NULL, review_evidence text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(pack_id,version), UNIQUE(pack_id,version,canonical_sha256)
);
CREATE TABLE app.seo_blog_method_catalogue(
  id text PRIMARY KEY, proposal jsonb NOT NULL CHECK(jsonb_typeof(proposal)='object'),
  status text NOT NULL DEFAULT 'proposal' CHECK(status='proposal'), created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- Empty until an operator explicitly enrols a verified founder-owned organization.
CREATE TABLE app.seo_blog_method_private_organizations(
  organization_id uuid PRIMARY KEY REFERENCES app.organizations(id),
  evidence text NOT NULL CHECK(length(btrim(evidence))>0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE app.seo_blog_method_private_organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.seo_blog_method_private_organizations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app.seo_blog_method_private_organizations FROM PUBLIC,r72_content_command,r72_web,r72_worker;
CREATE POLICY seo_method_private_org_owner ON app.seo_blog_method_private_organizations FOR ALL TO r72_owner USING(true) WITH CHECK(true);
CREATE POLICY seo_method_private_org_read ON app.seo_blog_method_private_organizations FOR SELECT TO r72_seo_method_definer USING(true);
GRANT SELECT ON app.seo_blog_method_private_organizations TO r72_seo_method_definer;
CREATE TRIGGER seo_method_private_org_immutable BEFORE UPDATE OR DELETE ON app.seo_blog_method_private_organizations
  FOR EACH ROW EXECUTE FUNCTION app_private.seo_blog_append_only();

CREATE TABLE app.seo_blog_method_assignments(
  workspace_id uuid NOT NULL REFERENCES app.seo_blog_brands(workspace_id) ON DELETE RESTRICT,
  revision integer NOT NULL CHECK(revision>0), scope text NOT NULL CHECK(scope='private-owned-brands'),
  pins jsonb NOT NULL CHECK(jsonb_typeof(pins)='array' AND jsonb_array_length(pins)<=12 AND octet_length(pins::text)<=8192),
  actor_user_id uuid NOT NULL REFERENCES app.users(id), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,revision)
);
CREATE TABLE app.seo_blog_method_receipts(
  workspace_id uuid NOT NULL REFERENCES app.seo_blog_brands(workspace_id) ON DELETE RESTRICT,
  id uuid NOT NULL, assignment_revision integer NOT NULL,
  data jsonb NOT NULL CHECK(jsonb_typeof(data)='object' AND octet_length(data::text)<=131072),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(workspace_id,id),
  FOREIGN KEY(workspace_id,assignment_revision) REFERENCES app.seo_blog_method_assignments(workspace_id,revision)
);
CREATE TABLE app.seo_blog_method_bindings(
  workspace_id uuid NOT NULL, receipt_id uuid NOT NULL, asset_kind text NOT NULL CHECK(asset_kind IN ('plan','article','promotion')),
  asset_version_id text NOT NULL CHECK(length(asset_version_id) BETWEEN 1 AND 120),
  approval_state text NOT NULL DEFAULT 'draft' CHECK(approval_state='draft'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,receipt_id,asset_kind,asset_version_id),
  FOREIGN KEY(workspace_id,receipt_id) REFERENCES app.seo_blog_method_receipts(workspace_id,id)
);
DO $tables$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['seo_blog_method_releases','seo_blog_method_catalogue','seo_blog_method_assignments','seo_blog_method_receipts','seo_blog_method_bindings'] LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON app.%I FROM PUBLIC,r72_content_command,r72_web,r72_worker',t);
    EXECUTE format('CREATE POLICY %I ON app.%I FOR ALL TO r72_owner USING(true) WITH CHECK(true)',t||'_owner',t);
    IF t IN ('seo_blog_method_releases','seo_blog_method_catalogue') THEN
      EXECUTE format('CREATE POLICY %I ON app.%I FOR SELECT TO r72_seo_method_definer USING(true)',t||'_read',t);
      EXECUTE format('GRANT SELECT ON app.%I TO r72_seo_method_definer',t);
    ELSE
      EXECUTE format('CREATE POLICY %I ON app.%I FOR ALL TO r72_seo_method_definer USING(workspace_id=app_private.current_workspace_id()) WITH CHECK(workspace_id=app_private.current_workspace_id())',t||'_scope',t);
      EXECUTE format('GRANT SELECT,INSERT ON app.%I TO r72_seo_method_definer',t);
      INSERT INTO app_private.workspace_table_registry(schema_name,table_name,workspace_column) VALUES('app',t,'workspace_id');
    END IF;
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON app.%I FOR EACH ROW EXECUTE FUNCTION app_private.seo_blog_append_only()',t||'_immutable',t);
  END LOOP;
END $tables$;
GRANT USAGE ON SCHEMA app,app_private TO r72_seo_method_definer;
GRANT EXECUTE ON FUNCTION app_private.current_workspace_id(),app_private.current_user_id(),app_private.current_actor_kind(),
  app_private.seo_blog_brand(uuid),app_private.seo_media_private_actor(uuid,bytea),app_private.seo_media_owner(uuid,bytea)
  TO r72_seo_method_definer;
GRANT SELECT ON app.seo_blog_usage,app.seo_blog_brands,app.seo_blog_article_versions,app.seo_blog_records TO r72_seo_method_definer;
CREATE POLICY seo_blog_usage_method_read ON app.seo_blog_usage FOR SELECT TO r72_seo_method_definer USING(workspace_id=app_private.current_workspace_id());
CREATE POLICY seo_blog_brands_method_read ON app.seo_blog_brands FOR SELECT TO r72_seo_method_definer USING(workspace_id=app_private.current_workspace_id());
CREATE POLICY seo_blog_article_versions_method_read ON app.seo_blog_article_versions FOR SELECT TO r72_seo_method_definer USING(workspace_id=app_private.current_workspace_id());
CREATE POLICY seo_blog_records_method_read ON app.seo_blog_records FOR SELECT TO r72_seo_method_definer USING(workspace_id=app_private.current_workspace_id());
GRANT INSERT ON app.seo_blog_usage TO r72_seo_method_definer;
GRANT USAGE ON SEQUENCE app.seo_blog_usage_id_seq TO r72_seo_method_definer;
CREATE POLICY seo_blog_usage_method_insert ON app.seo_blog_usage FOR INSERT TO r72_seo_method_definer WITH CHECK(workspace_id=app_private.current_workspace_id());
GRANT UPDATE(workspace_id) ON app.seo_blog_brands TO r72_seo_method_definer;
CREATE POLICY seo_blog_brands_method_lock ON app.seo_blog_brands FOR UPDATE TO r72_seo_method_definer USING(workspace_id=app_private.current_workspace_id()) WITH CHECK(workspace_id=app_private.current_workspace_id());
GRANT CREATE ON SCHEMA app_private TO r72_seo_method_definer;
SET LOCAL ROLE r72_seo_method_definer;

CREATE FUNCTION app_private.seo_method_snapshot(p_workspace uuid,p_session bytea)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE a app.seo_blog_method_assignments; release_list jsonb; used bigint;
BEGIN
  PERFORM app_private.seo_media_private_actor(p_workspace,p_session);
  IF app_private.seo_blog_brand(p_workspace) IS NULL THEN RAISE EXCEPTION 'Brand unavailable' USING ERRCODE='42501'; END IF;
  SELECT * INTO a FROM app.seo_blog_method_assignments WHERE workspace_id=p_workspace ORDER BY revision DESC LIMIT 1;
  IF a.revision IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app.seo_blog_brands b JOIN app.seo_blog_method_private_organizations o ON o.organization_id=b.organization_id WHERE b.workspace_id=p_workspace) THEN
    RAISE EXCEPTION 'Private methods organization is unavailable' USING ERRCODE='42501';
  END IF;
  SELECT jsonb_agg(jsonb_build_object('packId',pack_id,'version',version,'hash',canonical_sha256,
    'privateApproval',private_approval,'publicApproval',public_approval,'reviewEvidence',review_evidence) ORDER BY pack_id,version)
    INTO release_list FROM app.seo_blog_method_releases;
  SELECT coalesce(sum(amount),0) INTO used FROM app.seo_blog_usage
    WHERE workspace_id=p_workspace AND kind='model_tokens' AND at>=date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  RETURN jsonb_build_object('brandId',p_workspace,'assignment',CASE WHEN a.revision IS NULL THEN NULL ELSE
    jsonb_build_object('revision',a.revision,'scope',a.scope,'pins',a.pins) END,'releases',coalesce(release_list,'[]'::jsonb),'tokensUsed',used);
END $f$;

CREATE FUNCTION app_private.seo_method_receipt(p_workspace uuid,p_session bytea,p_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
  PERFORM app_private.seo_media_private_actor(p_workspace,p_session);
  IF app_private.seo_blog_brand(p_workspace) IS NULL THEN RAISE EXCEPTION 'Brand unavailable' USING ERRCODE='42501'; END IF;
  RETURN(SELECT data FROM app.seo_blog_method_receipts WHERE workspace_id=p_workspace AND id=p_id);
END $f$;

CREATE FUNCTION app_private.seo_method_assign(p_workspace uuid,p_session bytea,p_expected integer,p_pins jsonb)
RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; current_revision integer; pin jsonb;
BEGIN
  actor:=app_private.seo_media_owner(p_workspace,p_session);
  IF app_private.seo_blog_brand(p_workspace) IS NULL THEN RAISE EXCEPTION 'Brand unavailable' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS(SELECT 1 FROM app.seo_blog_brands b JOIN app.seo_blog_method_private_organizations o ON o.organization_id=b.organization_id WHERE b.workspace_id=p_workspace) THEN
    RAISE EXCEPTION 'Private methods require operator enrolment of an owned organization' USING ERRCODE='42501';
  END IF;
  PERFORM workspace_id FROM app.seo_blog_brands WHERE workspace_id=p_workspace FOR UPDATE;
  SELECT coalesce(max(revision),0) INTO current_revision FROM app.seo_blog_method_assignments WHERE workspace_id=p_workspace;
  IF p_expected IS NULL OR current_revision<>p_expected THEN RAISE EXCEPTION 'Method assignment changed' USING ERRCODE='40001'; END IF;
  IF p_pins IS NULL OR jsonb_typeof(p_pins)<>'array' OR jsonb_array_length(p_pins)>12
    OR (SELECT count(*)<>count(DISTINCT x->>'packId') FROM jsonb_array_elements(p_pins) x) THEN
    RAISE EXCEPTION 'Invalid method assignment' USING ERRCODE='22023'; END IF;
  FOR pin IN SELECT value FROM jsonb_array_elements(p_pins) LOOP
    IF NOT EXISTS(SELECT 1 FROM app.seo_blog_method_releases r WHERE r.pack_id=pin->>'packId'
      AND r.version=pin->>'version' AND r.canonical_sha256=pin->>'hash') THEN
      RAISE EXCEPTION 'Unknown exact method release' USING ERRCODE='22023';
    END IF;
  END LOOP;
  INSERT INTO app.seo_blog_method_assignments(workspace_id,revision,scope,pins,actor_user_id)
    VALUES(p_workspace,current_revision+1,'private-owned-brands',p_pins,actor);
  RETURN current_revision+1;
END $f$;

CREATE FUNCTION app_private.seo_method_save_receipt(p_workspace uuid,p_session bytea,p_data jsonb)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE a app.seo_blog_method_assignments; pin jsonb; saved app.seo_blog_method_receipts;
BEGIN
  PERFORM app_private.seo_media_private_actor(p_workspace,p_session);
  IF app_private.seo_blog_brand(p_workspace) IS NULL THEN RAISE EXCEPTION 'Brand unavailable' USING ERRCODE='42501'; END IF;
  IF p_data->>'brandId' IS DISTINCT FROM p_workspace::text OR p_data->>'approvalState' IS DISTINCT FROM 'draft'
    OR p_data->>'outcome' IS NULL OR p_data->>'outcome' NOT IN ('accepted','rejected','unknown')
    OR p_data->>'stage' IS NULL OR p_data->>'stage' NOT IN ('planning','blog','revision','social')
    OR p_data->>'promptHash' IS NULL OR p_data#>>'{usage,tokensIn}' IS NULL OR p_data#>>'{usage,tokensOut}' IS NULL
    OR p_data->>'revisionPasses' IS NULL OR p_data->>'profileVersion' IS NULL OR (p_data->>'profileVersion')::integer<1
    OR (p_data->>'outcome'='accepted' AND (p_data->>'resultHash' IS NULL OR p_data->>'resultHash' !~ '^[0-9a-f]{64}$'))
    OR jsonb_typeof(p_data->'pins') IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_data->'pins') NOT BETWEEN 1 AND 12 OR p_data->>'promptHash' !~ '^[0-9a-f]{64}$'
    OR (p_data#>>'{usage,tokensIn}')::bigint NOT BETWEEN 0 AND 10000000
    OR (p_data#>>'{usage,tokensOut}')::bigint NOT BETWEEN 0 AND 10000000
    OR (p_data->>'revisionPasses')::integer NOT BETWEEN 0 AND 1 THEN
    RAISE EXCEPTION 'Invalid method receipt' USING ERRCODE='22023';
  END IF;
  SELECT * INTO a FROM app.seo_blog_method_assignments WHERE workspace_id=p_workspace
    AND revision=(p_data#>>'{assignment,revision}')::integer;
  IF a.revision IS NULL OR a.scope IS DISTINCT FROM p_data#>>'{assignment,scope}'
    OR a.pins IS DISTINCT FROM p_data#>'{assignment,pins}' THEN RAISE EXCEPTION 'Invalid assignment receipt' USING ERRCODE='42501'; END IF;
  FOR pin IN SELECT value FROM jsonb_array_elements(p_data->'pins') LOOP
    IF NOT a.pins @> jsonb_build_array(pin) OR NOT EXISTS(SELECT 1 FROM app.seo_blog_method_releases r
      WHERE r.pack_id=pin->>'packId' AND r.version=pin->>'version' AND r.canonical_sha256=pin->>'hash' AND r.private_approval='approved')
      THEN RAISE EXCEPTION 'Unapproved receipt method' USING ERRCODE='42501'; END IF;
  END LOOP;
  SELECT * INTO saved FROM app.seo_blog_method_receipts WHERE workspace_id=p_workspace AND id=(p_data->>'id')::uuid;
  IF saved.id IS NOT NULL THEN
    IF saved.data IS DISTINCT FROM p_data THEN RAISE EXCEPTION 'Receipt is immutable' USING ERRCODE='42501'; END IF;
    RETURN;
  END IF;
  INSERT INTO app.seo_blog_method_receipts(workspace_id,id,assignment_revision,data)
    VALUES(p_workspace,(p_data->>'id')::uuid,a.revision,p_data);
  -- Success usage is already recorded by the existing engine. Rejected paid responses need their own idempotent receipt.
  IF p_data->>'outcome'<>'accepted' THEN
    INSERT INTO app.seo_blog_usage(workspace_id,kind,amount,at,reference) VALUES(p_workspace,'model_tokens',
      (p_data#>>'{usage,tokensIn}')::bigint+(p_data#>>'{usage,tokensOut}')::bigint,clock_timestamp(),'method-rejected:'||(p_data->>'id'));
  END IF;
END $f$;

CREATE FUNCTION app_private.seo_method_bind(p_workspace uuid,p_session bytea,p_receipt uuid,p_kind text,p_asset text)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE r app.seo_blog_method_receipts; source_data jsonb;
BEGIN
  PERFORM app_private.seo_media_private_actor(p_workspace,p_session);
  IF app_private.seo_blog_brand(p_workspace) IS NULL THEN RAISE EXCEPTION 'Brand unavailable' USING ERRCODE='42501'; END IF;
  SELECT * INTO r FROM app.seo_blog_method_receipts WHERE workspace_id=p_workspace AND id=p_receipt;
  IF r.id IS NULL OR r.data->>'outcome'<>'accepted' THEN RAISE EXCEPTION 'Receipt unavailable' USING ERRCODE='42501'; END IF;
  IF p_kind='plan' THEN
    SELECT data INTO source_data FROM app.seo_blog_records WHERE workspace_id=p_workspace AND kind='plan' AND id=p_asset;
    IF source_data#>>'{generation,methodReceiptId}' IS DISTINCT FROM p_receipt::text
      OR r.data->>'assetRef' IS DISTINCT FROM 'plan:'||p_asset THEN RAISE EXCEPTION 'Plan receipt mismatch' USING ERRCODE='42501'; END IF;
  ELSE
    SELECT data INTO source_data FROM app.seo_blog_article_versions WHERE workspace_id=p_workspace AND id::text=p_asset;
    IF p_kind='article' THEN
      IF source_data#>>'{generation,methodReceiptId}' IS DISTINCT FROM p_receipt::text
        OR r.data->>'assetRef' IS DISTINCT FROM 'article:'||(source_data->>'articleId') THEN RAISE EXCEPTION 'Article receipt mismatch' USING ERRCODE='42501'; END IF;
    ELSIF p_kind='promotion' THEN
      IF source_data#>>'{promotionPack,generation,methodReceiptId}' IS DISTINCT FROM p_receipt::text
        OR r.data->>'assetRef' IS DISTINCT FROM 'promotion:'||p_asset THEN RAISE EXCEPTION 'Promotion receipt mismatch' USING ERRCODE='42501'; END IF;
    ELSE RAISE EXCEPTION 'Unknown method asset kind' USING ERRCODE='22023'; END IF;
  END IF;
  IF source_data IS NULL THEN RAISE EXCEPTION 'Resulting asset not found' USING ERRCODE='42501'; END IF;
  INSERT INTO app.seo_blog_method_bindings(workspace_id,receipt_id,asset_kind,asset_version_id)
    VALUES(p_workspace,p_receipt,p_kind,p_asset) ON CONFLICT DO NOTHING;
END $f$;

REVOKE ALL ON FUNCTION app_private.seo_method_snapshot(uuid,bytea),app_private.seo_method_receipt(uuid,bytea,uuid),
  app_private.seo_method_assign(uuid,bytea,integer,jsonb),app_private.seo_method_save_receipt(uuid,bytea,jsonb),
  app_private.seo_method_bind(uuid,bytea,uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.seo_method_snapshot(uuid,bytea),app_private.seo_method_receipt(uuid,bytea,uuid),
  app_private.seo_method_assign(uuid,bytea,integer,jsonb),app_private.seo_method_save_receipt(uuid,bytea,jsonb),
  app_private.seo_method_bind(uuid,bytea,uuid,text,text) TO r72_content_command;
RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_seo_method_definer;
-- Release registry and catalogue seeds are appended by the reviewed local preparation script.
INSERT INTO app.seo_blog_method_releases(pack_id,version,canonical_sha256,scope,private_approval,private_evidence,public_approval,public_evidence,review_evidence) VALUES('advocacy-and-referral','0.1.0','3a787710992232325792d6e9899e63e6276e131538b48e8d03fd5ab533727484','private-owned-brands','pending','No owner private-use approval recorded for this unavailable capability.','blocked','OWNER-DECISIONS item 6: commercial-use review not recorded.','docs/relaunch72-rule-packs/REVIEW-LEDGER.json; schema/dependencies/IDs inspected; integration gate required.');
INSERT INTO app.seo_blog_method_releases(pack_id,version,canonical_sha256,scope,private_approval,private_evidence,public_approval,public_evidence,review_evidence) VALUES('audience-resonance','0.1.0','80e3bd3dac1bf6157f5b3f8912b3289d134f96bce7812e2ce6b594e701f1edb9','private-owned-brands','pending','No owner private-use approval recorded for this unavailable capability.','blocked','OWNER-DECISIONS item 6: commercial-use review not recorded.','docs/relaunch72-rule-packs/REVIEW-LEDGER.json; schema/dependencies/IDs inspected; integration gate required.');
INSERT INTO app.seo_blog_method_releases(pack_id,version,canonical_sha256,scope,private_approval,private_evidence,public_approval,public_evidence,review_evidence) VALUES('blog-writing','0.1.0','1083462d573a49153603d258a5e192e8849830fac853c4ae25fcaa3e732d7785','private-owned-brands','approved','Martin, chat 2026-11-04: Approve private use after validation. Six supported packs only; integration gate must pass.','blocked','OWNER-DECISIONS item 6: commercial-use review not recorded.','docs/relaunch72-rule-packs/REVIEW-LEDGER.json; schema/dependencies/IDs inspected; integration gate required.');
INSERT INTO app.seo_blog_method_releases(pack_id,version,canonical_sha256,scope,private_approval,private_evidence,public_approval,public_evidence,review_evidence) VALUES('brand-context-building','0.1.0','2391e900720694d148b49bef4e6681c6d3b3423fa99e420cd11b042988c8a9a8','private-owned-brands','pending','No owner private-use approval recorded for this unavailable capability.','blocked','OWNER-DECISIONS item 6: commercial-use review not recorded.','docs/relaunch72-rule-packs/REVIEW-LEDGER.json; schema/dependencies/IDs inspected; integration gate required.');
INSERT INTO app.seo_blog_method_releases(pack_id,version,canonical_sha256,scope,private_approval,private_evidence,public_approval,public_evidence,review_evidence) VALUES('conversion-copy','0.1.0','d196df4f8c0267337889c92ac9bc7212c623bd6d82abc9c19ac154811cae2a60','private-owned-brands','approved','Martin, chat 2026-11-04: Approve private use after validation. Six supported packs only; integration gate must pass.','blocked','OWNER-DECISIONS item 6: commercial-use review not recorded.','docs/relaunch72-rule-packs/REVIEW-LEDGER.json; schema/dependencies/IDs inspected; integration gate required.');
INSERT INTO app.seo_blog_method_releases(pack_id,version,canonical_sha256,scope,private_approval,private_evidence,public_approval,public_evidence,review_evidence) VALUES('editorial-planning','0.1.0','2ed1aed3fa7cc9c1c07fe16afdb9fa444f6f2c3dcd1c85b33086b1f602128677','private-owned-brands','approved','Martin, chat 2026-11-04: Approve private use after validation. Six supported packs only; integration gate must pass.','blocked','OWNER-DECISIONS item 6: commercial-use review not recorded.','docs/relaunch72-rule-packs/REVIEW-LEDGER.json; schema/dependencies/IDs inspected; integration gate required.');
INSERT INTO app.seo_blog_method_releases(pack_id,version,canonical_sha256,scope,private_approval,private_evidence,public_approval,public_evidence,review_evidence) VALUES('email-writing','0.1.0','4492089e044118590c9a6c633611a5ecc69a735caf002303878281d1a3f79788','private-owned-brands','pending','No owner private-use approval recorded for this unavailable capability.','blocked','OWNER-DECISIONS item 6: commercial-use review not recorded.','docs/relaunch72-rule-packs/REVIEW-LEDGER.json; schema/dependencies/IDs inspected; integration gate required.');
INSERT INTO app.seo_blog_method_releases(pack_id,version,canonical_sha256,scope,private_approval,private_evidence,public_approval,public_evidence,review_evidence) VALUES('journey-review','0.1.0','4dd83f29daff921926de271aa091d5a5fc8e0b56a887d3b92345e69e4b94bc4f','private-owned-brands','pending','No owner private-use approval recorded for this unavailable capability.','blocked','OWNER-DECISIONS item 6: commercial-use review not recorded.','docs/relaunch72-rule-packs/REVIEW-LEDGER.json; schema/dependencies/IDs inspected; integration gate required.');
INSERT INTO app.seo_blog_method_releases(pack_id,version,canonical_sha256,scope,private_approval,private_evidence,public_approval,public_evidence,review_evidence) VALUES('offer-design','0.1.0','93555d10488ec2389c2af8c7b637e49bd2fb320b41c1bdec1ac0b74755dc553e','private-owned-brands','pending','No owner private-use approval recorded for this unavailable capability.','blocked','OWNER-DECISIONS item 6: commercial-use review not recorded.','docs/relaunch72-rule-packs/REVIEW-LEDGER.json; schema/dependencies/IDs inspected; integration gate required.');
INSERT INTO app.seo_blog_method_releases(pack_id,version,canonical_sha256,scope,private_approval,private_evidence,public_approval,public_evidence,review_evidence) VALUES('production-core','0.1.0','d30ce36f00f18b25ed7e32af5d9e531bdf95d3ec3af638e1df8dee7472317b34','private-owned-brands','approved','Martin, chat 2026-11-04: Approve private use after validation. Six supported packs only; integration gate must pass.','blocked','OWNER-DECISIONS item 6: commercial-use review not recorded.','docs/relaunch72-rule-packs/REVIEW-LEDGER.json; schema/dependencies/IDs inspected; integration gate required.');
INSERT INTO app.seo_blog_method_releases(pack_id,version,canonical_sha256,scope,private_approval,private_evidence,public_approval,public_evidence,review_evidence) VALUES('social-repurposing','0.1.0','d2caa4bf20be4f6bf098662cf5bb71d5c3de86cdf5862c61015b4e28b5e4ca91','private-owned-brands','approved','Martin, chat 2026-11-04: Approve private use after validation. Six supported packs only; integration gate must pass.','blocked','OWNER-DECISIONS item 6: commercial-use review not recorded.','docs/relaunch72-rule-packs/REVIEW-LEDGER.json; schema/dependencies/IDs inspected; integration gate required.');
INSERT INTO app.seo_blog_method_releases(pack_id,version,canonical_sha256,scope,private_approval,private_evidence,public_approval,public_evidence,review_evidence) VALUES('visual-briefing','0.1.0','a33b4d10bf2210b1eb922d6ae2a51a5283bbcb6bba6dc38c014185a0136debde','private-owned-brands','approved','Martin, chat 2026-11-04: Approve private use after validation. Six supported packs only; integration gate must pass.','blocked','OWNER-DECISIONS item 6: commercial-use review not recorded.','docs/relaunch72-rule-packs/REVIEW-LEDGER.json; schema/dependencies/IDs inspected; integration gate required.');
INSERT INTO app.seo_blog_method_catalogue(id,proposal) VALUES('rl72-boosters-v0.1.0','{"note": "Proposed Relaunch72-branded names for the upgrade catalogue. Names are the owner''s decision; the method content is independent of naming and pricing (architecture section 1D). Nothing here sets a tier or a price.", "family": {"proposedName": "RL72 Boosters", "alternatives": ["RL72 Super Boosters", "RL72 Expansion Packs", "RL72 Power Packs"], "pattern": "Each upgrade is sold as ''RL72 <Pack Name> Booster''; the base plan is ''RL72 Engine Room'' and is never sold separately."}, "bundles": [{"proposedName": "RL72 Super Booster", "includes": ["conversion-copy", "visual-briefing", "email-writing", "offer-design", "journey-review", "audience-resonance", "advocacy-and-referral"], "benefit": "Every expansion pack in one upgrade.", "placementNote": "Proposal only; include a pack only when its runtime path exists."}, {"proposedName": "RL72 Launch Booster", "includes": ["conversion-copy", "email-writing", "offer-design"], "benefit": "Shape the offer, write the page and the sequence, ask for the sale honestly.", "placementNote": "Proposal only."}, {"proposedName": "RL72 Growth Booster", "includes": ["journey-review", "audience-resonance", "advocacy-and-referral"], "benefit": "Find the gaps, pressure-test the words, turn happy customers into the next ones.", "placementNote": "Proposal only."}], "entries": [{"packId": "production-core", "proposedName": "Engine Room", "productName": "RL72 Engine Room", "alternatives": ["Backbone", "Groundwork"], "benefit": "The discipline every piece of work runs on: who it is for, what it must do, only facts you can back, one next step.", "placementNote": "Included in every plan; not a separately sold upgrade."}, {"packId": "brand-context-building", "proposedName": "Brain Builder", "productName": "RL72 Brain Builder Booster", "alternatives": ["Identity Lab", "Who & Why"], "benefit": "Turns your answers into a confirmed picture of your buyer, their words, their hesitations and your plain statement of value.", "placementNote": "Onboarding; the brand pack it produces is separate from methods."}, {"packId": "editorial-planning", "proposedName": "Editor''s Desk", "productName": "RL72 Editor''s Desk Booster", "alternatives": ["The Planner", "Calendar Brain"], "benefit": "Decides what to say next: real questions, useful formats, grounded angles, a plan that is never a quota.", "placementNote": "Core content planning."}, {"packId": "blog-writing", "proposedName": "Longform Forge", "productName": "RL72 Longform Forge Booster", "alternatives": ["Deep Draft", "The Writer''s Room"], "benefit": "Articles that answer first, explain why things work and cite every figure.", "placementNote": "Core blog production."}, {"packId": "conversion-copy", "proposedName": "Hook & Close", "productName": "RL72 Hook & Close Booster", "alternatives": ["Ask Engine", "Page Turner"], "benefit": "Copy that asks for one action honestly, with test versions that differ in substance.", "placementNote": "Candidate upgrade."}, {"packId": "social-repurposing", "proposedName": "Multiplier", "productName": "RL72 Multiplier Booster", "alternatives": ["Echo", "One-to-Many"], "benefit": "One approved article becomes channel-native posts that stand on their own.", "placementNote": "Core social production; dispatch stays gated separately."}, {"packId": "visual-briefing", "proposedName": "Art Director", "productName": "RL72 Art Director Booster", "alternatives": ["Picture Brief", "Framed"], "benefit": "Image briefs that show the point, keep real evidence separate and never pretend an image exists.", "placementNote": "Candidate upgrade when image paths exist."}, {"packId": "email-writing", "proposedName": "Inbox Engine", "productName": "RL72 Inbox Engine Booster", "alternatives": ["Sequence Studio", "The Mailroom"], "benefit": "Welcome, onboarding and promotion sequences with honest subjects and one job per email.", "placementNote": "Authoring contract until an email path exists."}, {"packId": "offer-design", "proposedName": "Deal Shaper", "productName": "RL72 Deal Shaper Booster", "alternatives": ["Offer Bench", "The Ladder"], "benefit": "Structures offers, free entry offers and the offer ladder as proposals you approve.", "placementNote": "Authoring contract until an offer workflow exists."}, {"packId": "journey-review", "proposedName": "Funnel Scan", "productName": "RL72 Funnel Scan Booster", "alternatives": ["Journey X-Ray", "Gap Finder"], "benefit": "Scores your whole buyer journey and a page on evidence, picks three levers, plans 90 days you can actually do.", "placementNote": "Candidate upgrade."}, {"packId": "audience-resonance", "proposedName": "Focus Room", "productName": "RL72 Focus Room Booster", "alternatives": ["Reader Panel", "Resonance Check"], "benefit": "Your own reader personas pressure-test a draft and hand back exact rewrite directives.", "placementNote": "Candidate upgrade; needs personas in the brand pack."}, {"packId": "advocacy-and-referral", "proposedName": "Word of Mouth Engine", "productName": "RL72 Word of Mouth Engine Booster", "alternatives": ["Advocate Loop", "Pass It On"], "benefit": "Asks happy customers to speak and to refer, with consent recorded and incentives you decide.", "placementNote": "Candidate upgrade; sending and tracking need platform capabilities."}]}'::jsonb);
