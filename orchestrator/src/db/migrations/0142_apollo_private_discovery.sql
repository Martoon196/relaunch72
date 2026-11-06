-- Disabled, private prospect discovery only. No contact import, campaign or sending grants.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
DO $role$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='r72_apollo_definer') THEN
    CREATE ROLE r72_apollo_definer NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='r72_apollo_definer' AND NOT rolcanlogin AND NOT rolinherit
    AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls)
    OR EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname='r72_apollo_definer') THEN
    RAISE EXCEPTION 'Unsafe Apollo function owner' USING ERRCODE='42501';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid JOIN pg_roles c ON c.oid=m.member
    WHERE r.rolname='r72_apollo_definer' AND c.rolname NOT IN ('r72_owner',current_user)) THEN
    RAISE EXCEPTION 'Runtime Apollo definer membership denied' USING ERRCODE='42501';
  END IF;
  GRANT r72_apollo_definer TO r72_owner;
END $role$;
SET LOCAL ROLE r72_owner;
CREATE TABLE app_private.apollo_account_policy(
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), enabled boolean NOT NULL DEFAULT false,
  monthly_limit integer NOT NULL DEFAULT 50 CHECK(monthly_limit BETWEEN 0 AND 100000),
  free_available integer NOT NULL DEFAULT 0 CHECK(free_available>=0),
  confirmed_at timestamptz, resets_at timestamptz, evidence text NOT NULL DEFAULT '',
  CHECK(resets_at IS NULL OR resets_at>confirmed_at)
);
INSERT INTO app_private.apollo_account_policy(singleton) VALUES(true);
-- Explicit operator enrolment is required; brand names or customer-supplied IDs do not grant access.
CREATE TABLE app_private.apollo_brand_policy(
  workspace_id uuid PRIMARY KEY REFERENCES app.seo_blog_brands(workspace_id),
  brand_key text NOT NULL UNIQUE CHECK(brand_key IN ('prop-invest-uk','key-properties-uk')),
  owner_user_id uuid NOT NULL REFERENCES app.users(id), enabled boolean NOT NULL DEFAULT false,
  monthly_limit integer NOT NULL DEFAULT 50 CHECK(monthly_limit BETWEEN 0 AND 100000), evidence text NOT NULL CHECK(length(btrim(evidence))>0)
);
CREATE TABLE app_private.apollo_company_seeds(
  workspace_id uuid NOT NULL REFERENCES app_private.apollo_brand_policy(workspace_id),
  company_number text NOT NULL CHECK(company_number ~ '^[A-Z0-9]{8}$'),
  domain text NOT NULL CHECK(domain=lower(domain) AND domain ~ '^[a-z0-9][a-z0-9.-]+[.][a-z]{2,}$'),
  data jsonb NOT NULL, verified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,company_number,domain)
);
CREATE TABLE app_private.apollo_call_ledger(
  id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES app_private.apollo_brand_policy(workspace_id),
  company_number text NOT NULL, domain text NOT NULL, operation text NOT NULL CHECK(operation IN ('people-search','org-search','enrich')),
  vendor_record_id text, reserved integer NOT NULL CHECK(reserved BETWEEN 0 AND 9), actual integer CHECK(actual BETWEEN 0 AND 100000),
  state text NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','known','unknown')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), settled_at timestamptz,
  FOREIGN KEY(workspace_id,company_number,domain) REFERENCES app_private.apollo_company_seeds(workspace_id,company_number,domain)
);
CREATE INDEX apollo_call_budget ON app_private.apollo_call_ledger(created_at,workspace_id);
CREATE TABLE app_private.apollo_prospects(
  workspace_id uuid NOT NULL REFERENCES app_private.apollo_brand_policy(workspace_id), vendor_record_id text NOT NULL,
  company_number text NOT NULL, domain text NOT NULL, normalized_email text, suppressed boolean NOT NULL DEFAULT false,
  data jsonb NOT NULL, PRIMARY KEY(workspace_id,vendor_record_id)
);
REVOKE ALL ON app_private.apollo_account_policy,app_private.apollo_brand_policy,app_private.apollo_company_seeds,
  app_private.apollo_call_ledger,app_private.apollo_prospects FROM PUBLIC,r72_content_command,r72_web,r72_worker;
GRANT USAGE ON SCHEMA app,app_private TO r72_apollo_definer;
GRANT SELECT,UPDATE ON app_private.apollo_account_policy TO r72_apollo_definer;
GRANT SELECT ON app_private.apollo_brand_policy TO r72_apollo_definer;
GRANT SELECT,INSERT,UPDATE ON app_private.apollo_company_seeds,app_private.apollo_call_ledger,app_private.apollo_prospects TO r72_apollo_definer;
GRANT EXECUTE ON FUNCTION app_private.seo_media_owner(uuid,bytea),app_private.current_workspace_id(),app_private.current_user_id() TO r72_apollo_definer;
GRANT SELECT ON app.seo_blog_brands,app.seo_blog_method_private_organizations,app.contacts,app.contact_points TO r72_apollo_definer;
CREATE POLICY apollo_brands_read ON app.seo_blog_brands FOR SELECT TO r72_apollo_definer USING(workspace_id=app_private.current_workspace_id());
CREATE POLICY apollo_private_org_read ON app.seo_blog_method_private_organizations FOR SELECT TO r72_apollo_definer USING(true);
CREATE POLICY apollo_contact_read ON app.contacts FOR SELECT TO r72_apollo_definer USING(workspace_id=app_private.current_workspace_id());
CREATE POLICY apollo_contact_point_read ON app.contact_points FOR SELECT TO r72_apollo_definer USING(workspace_id=app_private.current_workspace_id());
GRANT CREATE ON SCHEMA app_private TO r72_apollo_definer;
SET LOCAL ROLE r72_apollo_definer;
CREATE FUNCTION app_private.apollo_command(p_workspace uuid,p_session bytea,p_action text,p jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; b app_private.apollo_brand_policy; a app_private.apollo_account_policy;
  seed app_private.apollo_company_seeds; call app_private.apollo_call_ledger; existing app_private.apollo_prospects;
  global_used bigint; brand_used bigint; cycle_used bigint; cost integer; charge integer; v jsonb; t timestamptz:=clock_timestamp();
BEGIN
  actor:=app_private.seo_media_owner(p_workspace,p_session);
  SELECT * INTO b FROM app_private.apollo_brand_policy WHERE workspace_id=p_workspace;
  IF b.owner_user_id IS DISTINCT FROM actor OR NOT EXISTS(SELECT 1 FROM app.seo_blog_brands x
    JOIN app.seo_blog_method_private_organizations o ON o.organization_id=x.organization_id WHERE x.workspace_id=p_workspace) THEN
    RAISE EXCEPTION 'Apollo is private to explicitly enrolled owned brands' USING ERRCODE='42501';
  END IF;
  -- One global lock serializes cross-brand reservations, including dedupe-before-spend.
  SELECT * INTO a FROM app_private.apollo_account_policy WHERE singleton FOR UPDATE;
  SELECT coalesce(sum(coalesce(actual,reserved)),0),coalesce(sum(coalesce(actual,reserved)) FILTER(WHERE workspace_id=p_workspace),0)
    INTO global_used,brand_used FROM app_private.apollo_call_ledger
    WHERE created_at>=date_trunc('month',t AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  SELECT coalesce(sum(coalesce(actual,reserved)),0) INTO cycle_used FROM app_private.apollo_call_ledger
    WHERE created_at>=a.confirmed_at OR (state<>'known' AND reserved>0);
  IF p_action='usage' THEN
    RETURN jsonb_build_object('enabled',a.enabled AND b.enabled,'brandLimit',b.monthly_limit,'globalLimit',a.monthly_limit,
      'brandUsedOrReserved',brand_used,'globalUsedOrReserved',global_used,
      'remaining',greatest(0,least(b.monthly_limit-brand_used,a.monthly_limit-global_used,a.free_available-cycle_used)),
      'freeAllowanceConfirmed',a.confirmed_at IS NOT NULL AND a.resets_at>t,'resetAt',a.resets_at);
  END IF;
  -- Settling a started call remains possible after a stop switch or month/reset change.
  IF p_action='settle' THEN
    SELECT * INTO call FROM app_private.apollo_call_ledger WHERE id=(p->>'id')::uuid AND workspace_id=p_workspace FOR UPDATE;
    IF call.id IS NULL THEN RAISE EXCEPTION 'Unknown Apollo attempt'; END IF;
    IF call.state<>'reserved' THEN RETURN jsonb_build_object('actual',call.actual,'reserved',call.reserved); END IF;
    charge:=(p->>'actual')::integer;
    IF charge IS NOT NULL AND (charge<0 OR charge>100000) THEN RAISE EXCEPTION 'Invalid charge'; END IF;
    UPDATE app_private.apollo_call_ledger SET actual=charge,state=CASE WHEN charge IS NULL THEN 'unknown' ELSE 'known' END,
      settled_at=t WHERE id=call.id;
    IF charge>call.reserved OR (charge IS NULL AND call.reserved>0) OR coalesce((p->>'blocked')::boolean,false) THEN
      UPDATE app_private.apollo_account_policy SET enabled=false WHERE singleton;
    END IF;
    RETURN jsonb_build_object('actual',charge,'reserved',call.reserved);
  END IF;
  IF p_action='save' THEN
    SELECT * INTO call FROM app_private.apollo_call_ledger WHERE id=(p->>'callId')::uuid AND workspace_id=p_workspace;
    IF call.id IS NULL OR call.operation NOT IN ('people-search','enrich') OR call.state='reserved' THEN RAISE EXCEPTION 'Missing settled pull'; END IF;
    v:=p->'record';
    IF v->>'vendor_record_id' IS NULL OR v->>'source_vendor'<>'apollo' OR v->>'licence_ref'<>'apollo-free-internal'
      OR v->>'company_number' IS DISTINCT FROM call.company_number OR v->>'domain' IS DISTINCT FROM call.domain
      OR v->>'subscriber_class' IS DISTINCT FROM 'corporate' OR v->>'retrieved_at' IS NULL THEN RAISE EXCEPTION 'Invalid Apollo provenance'; END IF;
    -- Immutable first retrieval: later responses never clear an existing suppression.
    INSERT INTO app_private.apollo_prospects(workspace_id,vendor_record_id,company_number,domain,normalized_email,data)
      VALUES(p_workspace,v->>'vendor_record_id',call.company_number,call.domain,lower(nullif(btrim(v->>'email'),'')),
        v||jsonb_build_object('credits_spent',call.actual,'credits_reserved',call.reserved))
      ON CONFLICT(workspace_id,vendor_record_id) DO UPDATE SET
        normalized_email=coalesce(app_private.apollo_prospects.normalized_email,excluded.normalized_email),
        data=excluded.data||jsonb_build_object('first_retrieved_at',coalesce(app_private.apollo_prospects.data->>'first_retrieved_at',app_private.apollo_prospects.data->>'retrieved_at'))
      WHERE app_private.apollo_prospects.company_number=excluded.company_number AND app_private.apollo_prospects.domain=excluded.domain
        AND NOT app_private.apollo_prospects.suppressed;
    RETURN '{}'::jsonb;
  END IF;
  IF NOT a.enabled OR NOT b.enabled THEN RAISE EXCEPTION 'Apollo disabled' USING ERRCODE='42501'; END IF;
  IF p_action='seed' THEN
    IF p->>'subscriber_class' IS DISTINCT FROM 'corporate' OR p->>'company_status' IS DISTINCT FROM 'active'
      OR p->>'company_type' IS NULL OR p->>'company_type' NOT IN ('ltd','plc','llp','limited-liability-partnership')
      OR p->>'domain_source' IS DISTINCT FROM 'owner-approved-company-seed' THEN RAISE EXCEPTION 'Corporate verification required' USING ERRCODE='42501'; END IF;
    INSERT INTO app_private.apollo_company_seeds(workspace_id,company_number,domain,data)
      VALUES(p_workspace,p->>'company_number',p->>'domain',p)
      ON CONFLICT(workspace_id,company_number,domain) DO UPDATE SET data=excluded.data,verified_at=t;
    RETURN p;
  END IF;
  SELECT * INTO seed FROM app_private.apollo_company_seeds WHERE workspace_id=p_workspace AND company_number=p->>'company_number' AND domain=p->>'domain';
  IF seed.company_number IS NULL OR seed.verified_at<t-interval '24 hours' THEN RAISE EXCEPTION 'Fresh corporate verification required' USING ERRCODE='42501'; END IF;
  IF p_action='reserve' THEN
    cost:=CASE p->>'operation' WHEN 'people-search' THEN 0 WHEN 'org-search' THEN 1 WHEN 'enrich' THEN 1 ELSE NULL END;
    IF cost IS NULL THEN RAISE EXCEPTION 'Unsupported Apollo operation'; END IF;
    IF p->>'operation'='enrich' THEN
      SELECT * INTO existing FROM app_private.apollo_prospects WHERE workspace_id=p_workspace AND vendor_record_id=p->>'vendor_record_id';
      IF existing.vendor_record_id IS NULL OR existing.company_number<>seed.company_number OR existing.domain<>seed.domain THEN
        RAISE EXCEPTION 'Enrichment requires a previously pulled corporate preview'; END IF;
      IF existing.normalized_email IS NOT NULL OR existing.suppressed
        OR EXISTS(SELECT 1 FROM app_private.apollo_call_ledger WHERE operation='enrich' AND vendor_record_id=existing.vendor_record_id AND coalesce(actual,reserved)>0)
        OR EXISTS(SELECT 1 FROM app.contacts c LEFT JOIN app.contact_points cp ON cp.workspace_id=c.workspace_id AND cp.contact_id=c.id
          WHERE c.workspace_id=p_workspace AND (c.custom_fields->>'company_number'=seed.company_number
            OR lower(c.custom_fields->>'company_domain')=seed.domain
            OR (cp.kind='email' AND split_part(lower(cp.normalized_value),'@',2)=seed.domain)
            OR (existing.normalized_email IS NOT NULL AND lower(cp.normalized_value)=existing.normalized_email))) THEN
        RAISE EXCEPTION 'Already held or suppressed; no enrichment spend' USING ERRCODE='23505';
      END IF;
    END IF;
    IF cost>0 AND (a.confirmed_at IS NULL OR a.resets_at<=t OR a.free_available-cycle_used<cost
      OR a.monthly_limit-global_used<cost OR b.monthly_limit-brand_used<cost) THEN RAISE EXCEPTION 'Apollo credit budget held' USING ERRCODE='54000'; END IF;
    INSERT INTO app_private.apollo_call_ledger(id,workspace_id,company_number,domain,operation,vendor_record_id,reserved)
      VALUES((p->>'id')::uuid,p_workspace,seed.company_number,seed.domain,p->>'operation',p->>'vendor_record_id',cost);
    RETURN jsonb_build_object('reserved',cost);
  END IF;
  RAISE EXCEPTION 'Unknown Apollo command';
END $f$;
REVOKE ALL ON FUNCTION app_private.apollo_command(uuid,bytea,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.apollo_command(uuid,bytea,text,jsonb) TO r72_content_command;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_apollo_definer;
