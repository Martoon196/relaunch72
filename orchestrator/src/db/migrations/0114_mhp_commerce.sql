-- MHP-DESK-001. Brand-scoped commerce. No provider keys or customer fixtures.
DO $roles$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='r72_mhp_commerce_definer') THEN CREATE ROLE r72_mhp_commerce_definer NOLOGIN NOINHERIT; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='r72_mhp_commerce_definer' AND (rolcanlogin OR rolinherit OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN RAISE EXCEPTION 'Unsafe MHP commerce role'; END IF;
 IF EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname='r72_mhp_commerce_definer') THEN RAISE EXCEPTION 'MHP commerce role must not inherit'; END IF;
 IF EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles p ON p.oid=m.roleid JOIN pg_roles c ON c.oid=m.member WHERE p.rolname='r72_mhp_commerce_definer' AND c.rolname NOT IN ('r72_owner',current_user)) THEN RAISE EXCEPTION 'Unexpected MHP commerce role member'; END IF;
 GRANT r72_mhp_commerce_definer TO r72_owner;
 EXECUTE format('GRANT r72_mhp_commerce_definer TO %I',current_user);
END $roles$;
SET LOCAL ROLE r72_owner;
GRANT USAGE ON SCHEMA app,app_private TO r72_mhp_commerce_definer;

CREATE TABLE app.products (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES app.organizations(id),
 brand text NOT NULL CHECK(brand='martin_howard_property'),
 sku text NOT NULL UNIQUE,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
 type text NOT NULL CHECK(type IN('kit','course','membership','cohort','partnership')),
 price_pence integer NOT NULL CHECK(price_pence>0),
 currency text NOT NULL DEFAULT 'gbp' CHECK(currency='gbp'),
 refund_days integer NOT NULL CHECK(refund_days BETWEEN 0 AND 365),
 recurring_interval text CHECK(recurring_interval IN('month','year')),
 instalments integer CHECK(instalments IN(3,6)),
 grants jsonb NOT NULL CHECK(jsonb_typeof(grants)='object'),
 active boolean NOT NULL DEFAULT true,
 CHECK(instalments IS NULL OR recurring_interval='month')
);
CREATE TABLE app.purchases (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES app.organizations(id),
 account_id uuid REFERENCES app.users(id),
 product_id uuid NOT NULL REFERENCES app.products(id),
 stripe_account_id text NOT NULL CHECK(stripe_account_id ~ '^acct_[A-Za-z0-9]+$'),
 stripe_session_id text NOT NULL CHECK(stripe_session_id ~ '^cs_[A-Za-z0-9_]+$'),
 stripe_customer_id text NOT NULL CHECK(stripe_customer_id ~ '^cus_[A-Za-z0-9]+$'),
 stripe_subscription_id text CHECK(stripe_subscription_id ~ '^sub_[A-Za-z0-9]+$'),
 stripe_schedule_id text CHECK(stripe_schedule_id ~ '^sub_sched_[A-Za-z0-9]+$'),
 buyer_email text NOT NULL CHECK(length(buyer_email)<=320 AND buyer_email=lower(btrim(buyer_email)) AND buyer_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
 livemode boolean NOT NULL,
 status text NOT NULL CHECK(status IN('paid','cancelled','refunded')),
 first_paid_at timestamptz NOT NULL,
 period_end timestamptz,
 refunded_at timestamptz,
 last_snapshot_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(stripe_account_id,stripe_session_id),
 UNIQUE(stripe_account_id,stripe_subscription_id)
);
CREATE TABLE app.entitlements (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 account_id uuid NOT NULL REFERENCES app.users(id),
 product_id uuid NOT NULL REFERENCES app.products(id),
 purchase_id uuid UNIQUE REFERENCES app.purchases(id),
 grants jsonb NOT NULL CHECK(jsonb_typeof(grants)='object'),
 starts_at timestamptz NOT NULL,
 ends_at timestamptz,
 read_only_until timestamptz,
 source text NOT NULL CHECK(source IN('purchase','bonus','manual','cohort')),
 source_reference text CHECK(length(source_reference) BETWEEN 1 AND 200),
 CHECK(ends_at IS NULL OR ends_at>=starts_at),
 CHECK(read_only_until IS NULL OR (ends_at IS NOT NULL AND read_only_until>=ends_at)),
 CHECK((source='purchase')=(purchase_id IS NOT NULL))
);
CREATE INDEX mhp_entitlements_account_idx ON app.entitlements(account_id,ends_at);
CREATE TABLE app_private.mhp_purchase_payments (
 purchase_id uuid NOT NULL REFERENCES app.purchases(id),
 provider_payment_id text NOT NULL,
 payment_intent_id text NOT NULL CHECK(payment_intent_id ~ '^pi_[A-Za-z0-9]+$'),
 charge_id text NOT NULL CHECK(charge_id ~ '^ch_[A-Za-z0-9]+$'),
 amount_pence integer NOT NULL CHECK(amount_pence>0),
 refunded_pence integer NOT NULL DEFAULT 0 CHECK(refunded_pence BETWEEN 0 AND amount_pence),
 paid_at timestamptz NOT NULL,
 PRIMARY KEY(purchase_id,provider_payment_id),
 UNIQUE(payment_intent_id), UNIQUE(charge_id)
);
CREATE TABLE app_private.mhp_stripe_events (
 stripe_account_id text NOT NULL,
 event_id text NOT NULL,
 event_type text NOT NULL,
 payload_sha256 bytea NOT NULL CHECK(octet_length(payload_sha256)=32),
 purchase_id uuid NOT NULL REFERENCES app.purchases(id),
 processed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(stripe_account_id,event_id)
);
CREATE TABLE app_private.mhp_refund_requests (
 purchase_id uuid PRIMARY KEY REFERENCES app.purchases(id),
 actor_id uuid NOT NULL REFERENCES app.users(id),
 requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 status text NOT NULL DEFAULT 'requested' CHECK(status IN('requested','submitted')),
 submitted_at timestamptz
);

DO $security$
DECLARE t text; s text;
BEGIN
 FOREACH t IN ARRAY ARRAY['products','purchases','entitlements','mhp_purchase_payments','mhp_stripe_events','mhp_refund_requests'] LOOP
  s:=CASE WHEN t LIKE 'mhp_%' THEN 'app_private' ELSE 'app' END;
  EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY',s,t);
  EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY',s,t);
  EXECUTE format('CREATE POLICY mhp_commerce_owner ON %I.%I TO r72_owner USING(true) WITH CHECK(true)',s,t);
  EXECUTE format('CREATE POLICY mhp_commerce_definer ON %I.%I TO r72_mhp_commerce_definer USING(true) WITH CHECK(true)',s,t);
  EXECUTE format('REVOKE ALL ON %I.%I FROM PUBLIC',s,t);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I.%I TO r72_mhp_commerce_definer',s,t);
 END LOOP;
END $security$;
GRANT SELECT ON app.users TO r72_mhp_commerce_definer;
CREATE POLICY mhp_commerce_users ON app.users FOR SELECT TO r72_mhp_commerce_definer USING(true);

INSERT INTO app.products(organization_id,brand,sku,name,type,price_pence,refund_days,recurring_interval,instalments,grants)
SELECT 'ba41b1a4-9752-4dbf-8312-d04a0f03d0b8'::uuid,'martin_howard_property',sku,name,kind,amount,30,recurrence,count,
 jsonb_build_object('crm',crm,'enquirySite',crm,'emailWorkflow',advanced,'leadrelay',advanced)
FROM(VALUES
 ('mhp_kit','Property Investor Kit','kit',9700,NULL::text,NULL::integer,false,false),
 ('mhp_course','Property Investor Course','course',99700,NULL,NULL,true,false),
 ('mhp_course_3x','Property Investor Course - 3 monthly payments','course',34900,'month',3,true,false),
 ('mhp_room_monthly','Members Room - monthly','membership',4700,'month',NULL,true,false),
 ('mhp_room_annual','Members Room - annual','membership',47000,'year',NULL,true,false),
 ('mhp_mentoring','Property Mentoring','cohort',299700,NULL,NULL,true,true),
 ('mhp_mentoring_6x','Property Mentoring - 6 monthly payments','cohort',52500,'month',6,true,true)
) AS p(sku,name,kind,amount,recurrence,count,crm,advanced);

-- Preserve the earlier payment-only product constraints while admitting the
-- explicitly named MHP products. Existing PP functions still accept only PP.
ALTER TABLE app_private.checkout_intents DROP CONSTRAINT checkout_intents_product_key_check;
ALTER TABLE app_private.checkout_intents ADD CONSTRAINT checkout_intents_product_key_check CHECK(product_key IN('autopsy','core','core_bump','pro','mhp_kit','mhp_course','mhp_course_3x','mhp_room_monthly','mhp_room_annual','mhp_mentoring','mhp_mentoring_6x'));
ALTER TABLE app_private.checkout_intents DROP CONSTRAINT checkout_intents_expected_mode_check;
ALTER TABLE app_private.checkout_intents ADD CONSTRAINT checkout_intents_expected_mode_check CHECK(expected_mode IN('payment','subscription'));
-- Find the combined legacy tier/stage CHECK by its definition; do not guess a generated suffix.
DO $constraint$
DECLARE c record;
BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='app_private.checkout_intents'::regclass AND contype='c'
 AND pg_get_constraintdef(oid) LIKE '%product_key%' AND pg_get_constraintdef(oid) LIKE '%through_stage%' LOOP
 EXECUTE format('ALTER TABLE app_private.checkout_intents DROP CONSTRAINT %I',c.conname);
 END LOOP;
END $constraint$;
ALTER TABLE app_private.checkout_intents ADD CONSTRAINT checkout_intents_product_stage_check CHECK(
 (product_key='autopsy' AND through_stage='S1' AND NOT portal_access AND expected_mode='payment') OR
 (product_key IN('core','core_bump','pro') AND through_stage='S9' AND portal_access AND expected_mode='payment') OR
 (product_key IN('mhp_kit','mhp_course','mhp_course_3x','mhp_room_monthly','mhp_room_annual','mhp_mentoring','mhp_mentoring_6x') AND through_stage='S9')
);

GRANT CREATE ON SCHEMA app_private TO r72_mhp_commerce_definer;
SET LOCAL ROLE r72_mhp_commerce_definer;

CREATE FUNCTION app_private.mhp_has_purchase_email(p_email text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT EXISTS(SELECT 1 FROM app.purchases WHERE buyer_email=lower(btrim(p_email)));
$f$;

CREATE FUNCTION app_private.mhp_account_access(p_user uuid) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 WITH live AS(SELECT e.*,(e.ends_at IS NULL OR e.ends_at>clock_timestamp()) AS writable
 FROM app.entitlements e JOIN app.products p ON p.id=e.product_id
 WHERE e.account_id=p_user AND p.brand='martin_howard_property' AND e.starts_at<=clock_timestamp()
 AND (e.ends_at IS NULL OR e.ends_at>clock_timestamp() OR e.read_only_until>clock_timestamp()))
 SELECT jsonb_build_object('crm',COALESCE(bool_or((grants->>'crm')::boolean),false),
 'enquirySite',COALESCE(bool_or((grants->>'enquirySite')::boolean AND writable),false),
 'emailWorkflow',COALESCE(bool_or((grants->>'emailWorkflow')::boolean),false),
 'emailWritable',COALESCE(bool_or((grants->>'emailWorkflow')::boolean AND writable),false),
 'leadrelay',COALESCE(bool_or((grants->>'leadrelay')::boolean AND writable),false),
 'readOnly',COALESCE(bool_or((grants->>'crm')::boolean),false) AND NOT COALESCE(bool_or((grants->>'crm')::boolean AND writable),false),
 'endsAt',CASE WHEN bool_or(ends_at IS NULL) THEN NULL ELSE max(COALESCE(read_only_until,ends_at)) END) FROM live;
$f$;

CREATE FUNCTION app_private.mhp_refresh_entitlement(p_purchase uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE b app.purchases%ROWTYPE; p app.products%ROWTYPE; paid_count integer; ending timestamptz; grace timestamptz;
BEGIN
 SELECT * INTO b FROM app.purchases WHERE id=p_purchase;
 IF b.account_id IS NULL THEN RETURN; END IF;
 SELECT * INTO p FROM app.products WHERE id=b.product_id;
 SELECT count(*) INTO paid_count FROM app_private.mhp_purchase_payments WHERE purchase_id=b.id;
 IF b.status='refunded' THEN ending:=b.refunded_at; grace:=ending+interval '7 days';
 ELSIF p.instalments IS NOT NULL AND paid_count>=p.instalments THEN ending:=NULL;
 ELSIF b.status='cancelled' THEN ending:=GREATEST(b.first_paid_at,LEAST(COALESCE(b.period_end,clock_timestamp()),clock_timestamp()));
 ELSIF p.recurring_interval IS NOT NULL THEN ending:=b.period_end;
 ELSE ending:=NULL; END IF;
 INSERT INTO app.entitlements(account_id,product_id,purchase_id,grants,starts_at,ends_at,read_only_until,source)
 VALUES(b.account_id,b.product_id,b.id,p.grants,b.first_paid_at,ending,grace,'purchase')
 ON CONFLICT(purchase_id) DO UPDATE SET ends_at=excluded.ends_at,read_only_until=excluded.read_only_until;
END $f$;

CREATE FUNCTION app_private.mhp_bind_verified_purchases(p_user uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE email text; b record;
BEGIN
 -- Caller is the auth definer, after a consumed mailbox proof or verified password login.
 SELECT u.email::text INTO email FROM app.users u WHERE u.id=p_user AND u.status='active' AND u.email_verified_at IS NOT NULL;
 IF email IS NULL THEN RAISE EXCEPTION 'Account unavailable' USING ERRCODE='42501'; END IF;
 FOR b IN UPDATE app.purchases SET account_id=p_user WHERE buyer_email=lower(email) AND account_id IS NULL RETURNING id LOOP
  PERFORM app_private.mhp_refresh_entitlement(b.id);
 END LOOP;
END $f$;

CREATE FUNCTION app_private.mhp_set_manual_access(p_user uuid,p_enabled boolean,p_tier text,p_reference text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE p app.products%ROWTYPE;
BEGIN
 IF p_enabled IS NULL OR p_tier NOT IN('course','mentoring','partnership') OR (p_enabled AND (p_reference IS NULL OR length(btrim(p_reference)) NOT BETWEEN 1 AND 200)) THEN RAISE EXCEPTION 'Invalid manual grant' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_user::text,114));
 IF p_enabled THEN
  SELECT * INTO p FROM app.products WHERE sku=CASE WHEN p_tier='course' THEN 'mhp_course' ELSE 'mhp_mentoring' END;
  IF EXISTS(SELECT 1 FROM app.entitlements WHERE account_id=p_user AND source='manual' AND product_id=p.id AND source_reference=p_reference AND ends_at IS NULL) THEN RETURN; END IF;
 END IF;
 UPDATE app.entitlements SET ends_at=GREATEST(starts_at,clock_timestamp()),read_only_until=NULL WHERE account_id=p_user AND source='manual' AND (ends_at IS NULL OR ends_at>clock_timestamp());
 IF p_enabled THEN INSERT INTO app.entitlements(account_id,product_id,grants,starts_at,source,source_reference) VALUES(p_user,p.id,p.grants,statement_timestamp(),'manual',p_reference); END IF;
END $f$;

CREATE FUNCTION app_private.record_mhp_commerce_event(p_account text,p_event text,p_type text,p_hash bytea,p_snapshot jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE old app_private.mhp_stripe_events%ROWTYPE; b app.purchases%ROWTYPE; p app.products%ROWTYPE; x jsonb; total integer; refunded integer;
BEGIN
 IF p_account !~ '^acct_[A-Za-z0-9]+$' OR p_event !~ '^evt_[A-Za-z0-9]+$' OR octet_length(p_hash)<>32
 OR p_type NOT IN('checkout.session.completed','invoice.paid','invoice.payment_failed','customer.subscription.updated','customer.subscription.deleted','charge.refunded')
 OR jsonb_typeof(p_snapshot->'payments')<>'array' OR jsonb_array_length(p_snapshot->'payments')=0 THEN RAISE EXCEPTION 'Invalid MHP receipt' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_account||':'||(p_snapshot->>'sessionId'),114));
 SELECT * INTO old FROM app_private.mhp_stripe_events WHERE stripe_account_id=p_account AND event_id=p_event;
 IF FOUND THEN
  IF old.payload_sha256<>p_hash OR old.event_type<>p_type THEN RAISE EXCEPTION 'Provider event conflict' USING ERRCODE='40001'; END IF;
  RETURN old.purchase_id;
 END IF;
 SELECT * INTO p FROM app.products WHERE sku=p_snapshot->>'sku' AND brand='martin_howard_property' AND active;
 IF NOT FOUND THEN RAISE EXCEPTION 'Unknown product' USING ERRCODE='22023'; END IF;
 IF p.recurring_interval IS NOT NULL AND ((p_snapshot->>'periodEnd') IS NULL OR (p_snapshot->>'subscriptionId') IS NULL)
 OR p.instalments IS NOT NULL AND p_snapshot->>'scheduleId' IS NULL THEN RAISE EXCEPTION 'Recurring purchase evidence missing' USING ERRCODE='22023'; END IF;
 INSERT INTO app.purchases(organization_id,product_id,stripe_account_id,stripe_session_id,stripe_customer_id,stripe_subscription_id,stripe_schedule_id,buyer_email,livemode,status,first_paid_at,period_end,last_snapshot_at)
 VALUES(p.organization_id,p.id,p_account,p_snapshot->>'sessionId',p_snapshot->>'customerId',p_snapshot->>'subscriptionId',p_snapshot->>'scheduleId',lower(p_snapshot->>'email'),(p_snapshot->>'live')::boolean,
 CASE WHEN p_snapshot->>'cancelled'='true' THEN 'cancelled' ELSE 'paid' END,(p_snapshot->>'firstPaidAt')::timestamptz,(p_snapshot->>'periodEnd')::timestamptz,(p_snapshot->>'observedAt')::timestamptz)
 ON CONFLICT(stripe_account_id,stripe_session_id) DO NOTHING;
 SELECT * INTO b FROM app.purchases WHERE stripe_account_id=p_account AND stripe_session_id=p_snapshot->>'sessionId' FOR UPDATE;
 IF b.product_id<>p.id OR b.stripe_customer_id<>p_snapshot->>'customerId' OR b.livemode<>(p_snapshot->>'live')::boolean
 OR b.stripe_subscription_id IS DISTINCT FROM p_snapshot->>'subscriptionId' OR b.buyer_email<>lower(p_snapshot->>'email') THEN RAISE EXCEPTION 'Purchase evidence changed' USING ERRCODE='40001'; END IF;
 FOR x IN SELECT value FROM jsonb_array_elements(p_snapshot->'payments') LOOP
  IF (x->>'amount')::integer<>p.price_pence OR (x->>'refunded')::integer NOT BETWEEN 0 AND p.price_pence THEN RAISE EXCEPTION 'Payment amount mismatch' USING ERRCODE='22023'; END IF;
  INSERT INTO app_private.mhp_purchase_payments(purchase_id,provider_payment_id,payment_intent_id,charge_id,amount_pence,refunded_pence,paid_at)
  VALUES(b.id,x->>'id',x->>'paymentIntentId',x->>'chargeId',(x->>'amount')::integer,(x->>'refunded')::integer,(x->>'paidAt')::timestamptz)
  ON CONFLICT(purchase_id,provider_payment_id) DO UPDATE SET refunded_pence=GREATEST(app_private.mhp_purchase_payments.refunded_pence,excluded.refunded_pence);
 END LOOP;
 SELECT sum(amount_pence),sum(refunded_pence) INTO total,refunded FROM app_private.mhp_purchase_payments WHERE purchase_id=b.id;
 IF total>0 AND total=refunded THEN
  UPDATE app.purchases SET status='refunded',refunded_at=COALESCE(refunded_at,clock_timestamp()) WHERE id=b.id;
 ELSIF b.status<>'refunded' AND (p_snapshot->>'observedAt')::timestamptz>=b.last_snapshot_at THEN
  UPDATE app.purchases SET status=CASE WHEN p_snapshot->>'cancelled'='true' THEN 'cancelled' ELSE 'paid' END,
   period_end=(p_snapshot->>'periodEnd')::timestamptz,stripe_schedule_id=p_snapshot->>'scheduleId',last_snapshot_at=(p_snapshot->>'observedAt')::timestamptz WHERE id=b.id;
 END IF;
 PERFORM app_private.mhp_refresh_entitlement(b.id);
 INSERT INTO app_private.mhp_stripe_events(stripe_account_id,event_id,event_type,payload_sha256,purchase_id) VALUES(p_account,p_event,p_type,p_hash,b.id);
 RETURN b.id;
END $f$;

CREATE FUNCTION app_private.mhp_purchase_for_provider(p_account text,p_charge text,p_subscription text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT b.stripe_session_id FROM app.purchases b WHERE b.stripe_account_id=p_account AND
 ((p_subscription IS NOT NULL AND b.stripe_subscription_id=p_subscription) OR EXISTS(SELECT 1 FROM app_private.mhp_purchase_payments x WHERE x.purchase_id=b.id AND x.charge_id=p_charge)) LIMIT 1;
$f$;

CREATE FUNCTION app_private.mhp_purchase_schedule(p_account text,p_session text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT stripe_schedule_id FROM app.purchases WHERE stripe_account_id=p_account AND stripe_session_id=p_session;
$f$;

CREATE FUNCTION app_private.mhp_account_snapshot(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid;
BEGIN
 SELECT user_id INTO actor FROM app_private.resolve_mhp_session(p_session);
 IF actor IS NULL THEN RAISE EXCEPTION 'MHP account required' USING ERRCODE='42501'; END IF;
 RETURN jsonb_build_object('access',app_private.mhp_account_access(actor),'purchases',COALESCE((SELECT jsonb_agg(jsonb_build_object(
  'id',b.id,'sku',p.sku,'name',p.name,'status',b.status,'firstPaidAt',b.first_paid_at,'refundUntil',b.first_paid_at+make_interval(days=>p.refund_days),
  'canRefund',b.status<>'refunded' AND (clock_timestamp()<b.first_paid_at+make_interval(days=>p.refund_days) OR r.purchase_id IS NOT NULL),
  'refundPending',r.purchase_id IS NOT NULL AND b.status<>'refunded','customerId',b.stripe_customer_id,'subscriptionId',b.stripe_subscription_id,
  'paidPence',(SELECT COALESCE(sum(amount_pence),0) FROM app_private.mhp_purchase_payments WHERE purchase_id=b.id)) ORDER BY b.created_at DESC)
 FROM app.purchases b JOIN app.products p ON p.id=b.product_id LEFT JOIN app_private.mhp_refund_requests r ON r.purchase_id=b.id WHERE b.account_id=actor),'[]'::jsonb));
END $f$;

CREATE FUNCTION app_private.mhp_begin_refund(p_session bytea,p_purchase uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; b app.purchases%ROWTYPE; days integer;
BEGIN
 SELECT user_id INTO actor FROM app_private.resolve_mhp_session(p_session);
 IF actor IS NULL THEN RAISE EXCEPTION 'MHP account required' USING ERRCODE='42501'; END IF;
 SELECT * INTO b FROM app.purchases WHERE id=p_purchase AND account_id=actor FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Purchase unavailable' USING ERRCODE='42501'; END IF;
 SELECT refund_days INTO days FROM app.products WHERE id=b.product_id;
 IF NOT EXISTS(SELECT 1 FROM app_private.mhp_refund_requests WHERE purchase_id=b.id) AND clock_timestamp()>=b.first_paid_at+make_interval(days=>days) THEN RAISE EXCEPTION 'Refund window ended' USING ERRCODE='22023'; END IF;
 INSERT INTO app_private.mhp_refund_requests(purchase_id,actor_id) VALUES(b.id,actor) ON CONFLICT DO NOTHING;
 RETURN jsonb_build_object('purchaseId',b.id,'accountId',b.stripe_account_id,'live',b.livemode,'sessionId',b.stripe_session_id,'customerId',b.stripe_customer_id,'sku',(SELECT sku FROM app.products WHERE id=b.product_id),'subscriptionId',b.stripe_subscription_id,'scheduleId',b.stripe_schedule_id,'refunded',b.status='refunded',
 'payments',(SELECT jsonb_agg(jsonb_build_object('chargeId',charge_id,'amount',amount_pence,'refunded',refunded_pence)) FROM app_private.mhp_purchase_payments WHERE purchase_id=b.id));
END $f$;

CREATE FUNCTION app_private.mhp_refund_submitted(p_session bytea,p_purchase uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid;
BEGIN
 SELECT user_id INTO actor FROM app_private.resolve_mhp_session(p_session);
 IF actor IS NULL THEN RAISE EXCEPTION 'MHP account required' USING ERRCODE='42501'; END IF;
 UPDATE app_private.mhp_refund_requests SET status='submitted',submitted_at=COALESCE(submitted_at,clock_timestamp()) WHERE purchase_id=p_purchase AND actor_id=actor;
 IF NOT FOUND THEN RAISE EXCEPTION 'Refund request unavailable' USING ERRCODE='42501'; END IF;
END $f$;

REVOKE ALL ON FUNCTION app_private.mhp_has_purchase_email(text),app_private.mhp_account_access(uuid),app_private.mhp_refresh_entitlement(uuid),app_private.mhp_bind_verified_purchases(uuid),app_private.mhp_set_manual_access(uuid,boolean,text,text),app_private.record_mhp_commerce_event(text,text,text,bytea,jsonb),app_private.mhp_purchase_for_provider(text,text,text),app_private.mhp_purchase_schedule(text,text),app_private.mhp_account_snapshot(bytea),app_private.mhp_begin_refund(bytea,uuid),app_private.mhp_refund_submitted(bytea,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.record_mhp_commerce_event(text,text,text,bytea,jsonb),app_private.mhp_purchase_for_provider(text,text,text),app_private.mhp_purchase_schedule(text,text) TO r72_webhook;
GRANT EXECUTE ON FUNCTION app_private.mhp_account_snapshot(bytea) TO r72_web;
GRANT EXECUTE ON FUNCTION app_private.mhp_begin_refund(bytea,uuid),app_private.mhp_refund_submitted(bytea,uuid) TO r72_identity_command;
RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_mhp_commerce_definer;
RESET ROLE;
