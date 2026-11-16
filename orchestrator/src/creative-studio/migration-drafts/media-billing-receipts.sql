-- PRIVATE DRAFT. Owner-selected, operator-priced checkout and signed webhook receipts.
-- Same RL72 workspace/users. No new account database or live Stripe provisioning.
DO $role$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='r72_media_billing_definer') THEN
  CREATE ROLE r72_media_billing_definer NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='r72_media_billing_definer' AND (rolcanlogin OR rolinherit OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls))
 OR EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname='r72_media_billing_definer') THEN RAISE EXCEPTION 'Unsafe media billing role'; END IF;
 GRANT r72_media_billing_definer TO r72_owner;
END $role$;
SET LOCAL ROLE r72_owner;
CREATE TABLE app.creative_media_price_policy (
 tier text PRIMARY KEY CHECK(tier IN('agency_client','affiliate_creator','affiliate_business')),
 price_id text NOT NULL UNIQUE CHECK(price_id~'^price_[A-Za-z0-9]+$'), livemode boolean NOT NULL,
 enabled boolean NOT NULL DEFAULT false, max_job_microusd bigint NOT NULL CHECK(max_job_microusd BETWEEN 0 AND 1000000000000),
 monthly_video_microusd bigint NOT NULL CHECK(monthly_video_microusd BETWEEN max_job_microusd AND 1000000000000)
);
CREATE TABLE app.creative_media_checkout_intents (
 workspace_id uuid NOT NULL REFERENCES app.seo_blog_brands(workspace_id), id uuid NOT NULL,
 tier text NOT NULL, price_id text NOT NULL, livemode boolean NOT NULL, stripe_session_id text UNIQUE,
 created_by uuid NOT NULL REFERENCES app.users(id), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,id), UNIQUE(id)
);
CREATE TABLE app.creative_media_billing_bindings (
 workspace_id uuid NOT NULL REFERENCES app.seo_blog_brands(workspace_id), subscription_id text NOT NULL,
 customer_id text NOT NULL, tier text NOT NULL, livemode boolean NOT NULL, last_event_created bigint NOT NULL DEFAULT 0,
 active boolean NOT NULL DEFAULT false, PRIMARY KEY(workspace_id,subscription_id), UNIQUE(subscription_id,livemode),
 UNIQUE(workspace_id,livemode)
);
CREATE TABLE app.creative_media_billing_events (
 workspace_id uuid NOT NULL, event_id text NOT NULL, input_sha256 text NOT NULL,
 disposition text NOT NULL CHECK(disposition IN('granted','revoked','stale')), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,event_id), UNIQUE(event_id)
);
DO $t$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['creative_media_price_policy','creative_media_checkout_intents','creative_media_billing_bindings','creative_media_billing_events'] LOOP
  EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON app.%I FROM PUBLIC,r72_web,r72_worker,r72_content_command,r72_webhook',t);
  EXECUTE format('CREATE POLICY %I ON app.%I FOR ALL TO r72_owner USING(true) WITH CHECK(true)',t||'_owner',t);
  IF t='creative_media_price_policy' THEN
   EXECUTE format('CREATE POLICY %I ON app.%I FOR SELECT TO r72_creative_studio_definer USING(true)',t||'_studio',t);
  ELSE
   EXECUTE format('CREATE POLICY %I ON app.%I FOR ALL TO r72_creative_studio_definer USING(workspace_id=app_private.current_workspace_id()) WITH CHECK(workspace_id=app_private.current_workspace_id())',t||'_studio',t);
   INSERT INTO app_private.workspace_table_registry(schema_name,table_name,workspace_column) VALUES('app',t,'workspace_id');
  END IF;
  EXECUTE format('CREATE POLICY %I ON app.%I FOR ALL TO r72_media_billing_definer USING(true) WITH CHECK(true)',t||'_billing',t);
  -- Operator price catalogue has no workspace column; its policy is replaced below.
 END LOOP;
END $t$;
GRANT SELECT ON app.creative_media_price_policy TO r72_creative_studio_definer;
GRANT SELECT,INSERT,UPDATE ON app.creative_media_checkout_intents TO r72_creative_studio_definer;
GRANT SELECT ON app.creative_media_checkout_intents,app.creative_media_price_policy TO r72_media_billing_definer;
GRANT SELECT,INSERT,UPDATE ON app.creative_media_billing_bindings TO r72_media_billing_definer;
GRANT SELECT ON app.creative_media_billing_bindings TO r72_creative_studio_definer;
GRANT SELECT,INSERT ON app.creative_media_billing_events TO r72_media_billing_definer;
CREATE POLICY creative_media_access_billing ON app.creative_media_access_grants FOR INSERT TO r72_media_billing_definer WITH CHECK(workspace_id=app_private.current_workspace_id());
GRANT INSERT ON app.creative_media_access_grants TO r72_media_billing_definer;
GRANT USAGE ON SCHEMA app,app_private,public TO r72_media_billing_definer;
GRANT EXECUTE ON FUNCTION app_private.current_actor_kind(),app_private.current_workspace_id() TO r72_media_billing_definer;
GRANT CREATE ON SCHEMA app_private TO r72_creative_studio_definer;
SET LOCAL ROLE r72_creative_studio_definer;
CREATE FUNCTION app_private.creative_media_checkout_intent(p_workspace uuid,p_session bytea,p_id uuid,p_tier text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; policy app.creative_media_price_policy; previous app.creative_media_checkout_intents;
BEGIN
 IF p_session IS NULL OR p_id IS NULL OR app_private.current_actor_kind() IS DISTINCT FROM 'user' THEN RAISE EXCEPTION 'Owner checkout session required' USING ERRCODE='42501'; END IF;
 actor:=app_private.seo_media_owner(p_workspace,p_session);
 SELECT * INTO policy FROM app.creative_media_price_policy WHERE tier=p_tier AND enabled;
 IF policy.tier IS NULL THEN RAISE EXCEPTION 'Reviewed media price not enabled' USING ERRCODE='55000'; END IF;
 INSERT INTO app.creative_media_checkout_intents(workspace_id,id,tier,price_id,livemode,created_by)
 VALUES(p_workspace,p_id,p_tier,policy.price_id,policy.livemode,actor) ON CONFLICT DO NOTHING;
 SELECT * INTO previous FROM app.creative_media_checkout_intents WHERE workspace_id=p_workspace AND id=p_id;
 IF previous.tier IS DISTINCT FROM p_tier OR previous.price_id IS DISTINCT FROM policy.price_id OR previous.livemode IS DISTINCT FROM policy.livemode
  OR previous.created_at<clock_timestamp()-interval '23 hours' THEN RAISE EXCEPTION 'Checkout intent changed or expired' USING ERRCODE='40001'; END IF;
 RETURN jsonb_build_object('intentId',p_id,'workspaceId',p_workspace,'tier',policy.tier,'priceId',policy.price_id,'livemode',policy.livemode);
END $f$;
CREATE FUNCTION app_private.creative_media_checkout_options(p_workspace uuid,p_session bytea,p_live boolean)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 IF p_session IS NULL OR app_private.current_actor_kind() IS DISTINCT FROM 'user' THEN RAISE EXCEPTION 'Owner session required' USING ERRCODE='42501'; END IF;
 PERFORM app_private.seo_media_owner(p_workspace,p_session);
 RETURN jsonb_build_object('customerId',(SELECT customer_id FROM app.creative_media_billing_bindings WHERE workspace_id=p_workspace AND livemode=p_live),
  'plans',coalesce((SELECT jsonb_agg(jsonb_build_object('tier',tier,'priceId',price_id,'livemode',livemode) ORDER BY tier) FROM app.creative_media_price_policy WHERE enabled AND livemode=p_live),'[]'::jsonb));
END $f$;
REVOKE ALL ON FUNCTION app_private.creative_media_checkout_options(uuid,bytea,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.creative_media_checkout_options(uuid,bytea,boolean) TO r72_content_command;
CREATE FUNCTION app_private.creative_media_checkout_bind(p_workspace uuid,p_session bytea,p_id uuid,p_stripe text)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 IF p_session IS NULL OR app_private.current_actor_kind() IS DISTINCT FROM 'user' THEN RAISE EXCEPTION 'Owner session required' USING ERRCODE='42501'; END IF;
 PERFORM app_private.seo_media_owner(p_workspace,p_session);
 IF coalesce(p_stripe,'')!~'^cs_[A-Za-z0-9_]+$' THEN RAISE EXCEPTION 'Stripe session required' USING ERRCODE='22023'; END IF;
 UPDATE app.creative_media_checkout_intents SET stripe_session_id=p_stripe WHERE workspace_id=p_workspace AND id=p_id
  AND (stripe_session_id IS NULL OR stripe_session_id=p_stripe);
 IF NOT FOUND THEN RAISE EXCEPTION 'Checkout session changed' USING ERRCODE='40001'; END IF;
END $f$;
REVOKE ALL ON FUNCTION app_private.creative_media_checkout_bind(uuid,bytea,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.creative_media_checkout_bind(uuid,bytea,uuid,text) TO r72_content_command;
REVOKE ALL ON FUNCTION app_private.creative_media_checkout_intent(uuid,bytea,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.creative_media_checkout_intent(uuid,bytea,uuid,text) TO r72_content_command;
RESET ROLE;SET LOCAL ROLE r72_owner;REVOKE CREATE ON SCHEMA app_private FROM r72_creative_studio_definer;
GRANT CREATE ON SCHEMA app_private TO r72_media_billing_definer;
SET LOCAL ROLE r72_media_billing_definer;
CREATE FUNCTION app_private.creative_media_billing_workspace(p_subscription text,p_intent uuid,p_live boolean)
RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE ws uuid;
BEGIN
 IF app_private.current_actor_kind() IS DISTINCT FROM 'webhook' THEN RAISE EXCEPTION 'Billing webhook required' USING ERRCODE='42501'; END IF;
 IF p_intent IS NOT NULL THEN
  SELECT workspace_id INTO ws FROM app.creative_media_checkout_intents WHERE id=p_intent AND livemode=p_live;
 ELSE SELECT workspace_id INTO ws FROM app.creative_media_billing_bindings WHERE subscription_id=p_subscription AND livemode=p_live; END IF;
 RETURN ws;
END $f$;
CREATE FUNCTION app_private.creative_media_billing_receipt(p_workspace uuid,p_event jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE binding app.creative_media_billing_bindings; intent app.creative_media_checkout_intents; policy app.creative_media_price_policy;
 prior app.creative_media_billing_events; digest text; created bigint; v_active boolean; until_at timestamptz; result text;
BEGIN
 IF app_private.current_actor_kind() IS DISTINCT FROM 'webhook' OR app_private.current_workspace_id() IS DISTINCT FROM p_workspace THEN RAISE EXCEPTION 'Scoped billing webhook required' USING ERRCODE='42501'; END IF;
 IF p_event IS NULL OR jsonb_typeof(p_event) IS DISTINCT FROM 'object' OR octet_length(p_event::text)>3000
  OR coalesce(p_event->>'eventSha256','')!~'^[a-f0-9]{64}$'
  OR coalesce(p_event->>'eventId','')!~'^evt_[A-Za-z0-9]+$' OR coalesce(p_event->>'subscriptionId','')!~'^sub_[A-Za-z0-9]+$'
  OR coalesce(p_event->>'customerId','')!~'^cus_[A-Za-z0-9]+$' OR coalesce(p_event->>'priceId','')!~'^price_[A-Za-z0-9]+$'
  OR coalesce(p_event->>'eventCreated','')!~'^[0-9]{10}$' OR jsonb_typeof(p_event->'activePaid') IS DISTINCT FROM 'boolean'
  OR jsonb_typeof(p_event->'livemode') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'Invalid verified billing receipt' USING ERRCODE='22023'; END IF;
 digest:=p_event->>'eventSha256';created:=(p_event->>'eventCreated')::bigint;
 PERFORM pg_advisory_xact_lock(hashtextextended('media-billing:'||p_workspace::text,0));
 SELECT * INTO prior FROM app.creative_media_billing_events WHERE workspace_id=p_workspace AND event_id=p_event->>'eventId';
 IF prior.event_id IS NOT NULL THEN
  IF prior.input_sha256<>digest THEN RAISE EXCEPTION 'Billing replay changed receipt' USING ERRCODE='40001'; END IF;
  RETURN jsonb_build_object('disposition',prior.disposition,'replayed',true); END IF;
 SELECT * INTO binding FROM app.creative_media_billing_bindings WHERE workspace_id=p_workspace AND subscription_id=p_event->>'subscriptionId';
 IF binding.subscription_id IS NULL THEN
  SELECT * INTO intent FROM app.creative_media_checkout_intents WHERE workspace_id=p_workspace AND id=(p_event->>'intentId')::uuid;
  IF intent.id IS NULL OR intent.price_id IS DISTINCT FROM p_event->>'priceId' OR intent.livemode IS DISTINCT FROM (p_event->>'livemode')::boolean
   OR intent.created_at<clock_timestamp()-interval '24 hours' OR p_event->>'checkoutVerified' IS DISTINCT FROM 'true' OR intent.stripe_session_id IS NULL OR intent.stripe_session_id IS DISTINCT FROM p_event->>'checkoutSessionId' THEN
   RAISE EXCEPTION 'Owner-bound verified checkout required' USING ERRCODE='42501'; END IF;
  INSERT INTO app.creative_media_billing_bindings(workspace_id,subscription_id,customer_id,tier,livemode)
   VALUES(p_workspace,p_event->>'subscriptionId',p_event->>'customerId',intent.tier,(p_event->>'livemode')::boolean)
   ON CONFLICT (workspace_id,livemode) DO UPDATE SET subscription_id=EXCLUDED.subscription_id,customer_id=EXCLUDED.customer_id,tier=EXCLUDED.tier,last_event_created=0,active=false
    WHERE NOT app.creative_media_billing_bindings.active RETURNING * INTO binding;
  IF binding.subscription_id IS NULL THEN RAISE EXCEPTION 'Existing active subscription must be managed first' USING ERRCODE='55000'; END IF;
 END IF;
 IF binding.customer_id IS DISTINCT FROM p_event->>'customerId' OR binding.livemode IS DISTINCT FROM (p_event->>'livemode')::boolean THEN RAISE EXCEPTION 'Billing identity mismatch' USING ERRCODE='42501'; END IF;
 v_active:=(p_event->>'activePaid')::boolean;
 IF created<binding.last_event_created OR (created=binding.last_event_created AND v_active AND NOT binding.active) THEN result:='stale';
 ELSE
  SELECT * INTO policy FROM app.creative_media_price_policy WHERE price_id=p_event->>'priceId' AND livemode=binding.livemode;
  IF policy.tier IS NULL THEN
   v_active:=false;
   SELECT * INTO policy FROM app.creative_media_price_policy WHERE tier=binding.tier AND livemode=binding.livemode;
  END IF;
  IF policy.tier IS NULL THEN RAISE EXCEPTION 'Reviewed subscription policy unavailable' USING ERRCODE='55000'; END IF;
  IF NOT policy.enabled THEN v_active:=false; END IF;
  until_at:=(p_event->>'periodEnd')::timestamptz;
  IF until_at IS NULL OR until_at<=clock_timestamp() OR until_at>clock_timestamp()+interval '2 years' THEN v_active:=false; END IF;
  INSERT INTO app.creative_media_access_grants(workspace_id,tier,source,receipt_id,valid_from,valid_until,max_job_microusd,monthly_video_microusd)
   VALUES(p_workspace,policy.tier,'billing_verified',p_event->>'eventId',now(),
    CASE WHEN v_active THEN until_at ELSE now()+interval '2 years' END,
    CASE WHEN v_active THEN policy.max_job_microusd ELSE 0 END,CASE WHEN v_active THEN policy.monthly_video_microusd ELSE 0 END);
  UPDATE app.creative_media_billing_bindings SET active=v_active,tier=policy.tier,last_event_created=created WHERE workspace_id=p_workspace AND subscription_id=binding.subscription_id;
  result:=CASE WHEN v_active THEN 'granted' ELSE 'revoked' END;
 END IF;
 INSERT INTO app.creative_media_billing_events(workspace_id,event_id,input_sha256,disposition) VALUES(p_workspace,p_event->>'eventId',digest,result);
 RETURN jsonb_build_object('disposition',result,'replayed',false);
END $f$;
REVOKE ALL ON FUNCTION app_private.creative_media_billing_workspace(text,uuid,boolean),app_private.creative_media_billing_receipt(uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.creative_media_billing_workspace(text,uuid,boolean),app_private.creative_media_billing_receipt(uuid,jsonb) TO r72_webhook;
RESET ROLE;SET LOCAL ROLE r72_owner;REVOKE CREATE ON SCHEMA app_private FROM r72_media_billing_definer;
