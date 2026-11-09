-- MHP-DEALDESK-001. Purchase-only credit and held D4 handoff; no email sender.
SET LOCAL ROLE r72_owner;
CREATE TABLE app_private.mhp_course_credits (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 purchase_id uuid NOT NULL UNIQUE REFERENCES app.purchases(id),
 amount_pence integer NOT NULL DEFAULT 4700 CHECK(amount_pence=4700),
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz,
 redeemed_purchase_id uuid UNIQUE REFERENCES app.purchases(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE app_private.mhp_credit_checkouts (
 id uuid PRIMARY KEY,
 credit_id uuid NOT NULL REFERENCES app_private.mhp_course_credits(id),
 actor_id uuid NOT NULL REFERENCES app.users(id),
 stripe_account_id text NOT NULL,
 livemode boolean NOT NULL,
 stripe_customer_id text NOT NULL,
 buyer_email text NOT NULL,
 catalogue_price_id text NOT NULL CHECK(catalogue_price_id ~ '^price_[A-Za-z0-9_]+$'),
 stripe_product_id text NOT NULL CHECK(length(stripe_product_id) BETWEEN 1 AND 200),
 amount_pence integer NOT NULL DEFAULT 145000 CHECK(amount_pence=145000),
 reserved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 stripe_session_id text UNIQUE CHECK(stripe_session_id ~ '^cs_[A-Za-z0-9_]+$'),
 checkout_url text CHECK(checkout_url ~ '^https://checkout[.]stripe[.]com/'),
 status text NOT NULL DEFAULT 'creating' CHECK(status IN('creating','open','complete','expired')),
 CHECK(expires_at>reserved_at AND expires_at<=reserved_at+interval '31 minutes')
);
CREATE UNIQUE INDEX mhp_credit_one_live_checkout ON app_private.mhp_credit_checkouts(credit_id) WHERE status IN('creating','open','complete');
CREATE TABLE app_private.mhp_purchase_contact_attributes (
 purchase_id uuid PRIMARY KEY REFERENCES app.purchases(id),
 buyer_email text NOT NULL,
 attributes jsonb NOT NULL CHECK(jsonb_typeof(attributes)='object'),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE app_private.mhp_email_handoffs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 purchase_id uuid NOT NULL REFERENCES app.purchases(id),
 sequence_key text NOT NULL CHECK(sequence_key='D4'),
 template_id integer NOT NULL CHECK(template_id IN(27,28,29)),
 recipient_email text NOT NULL,
 due_at timestamptz NOT NULL,
 attributes jsonb NOT NULL CHECK(jsonb_typeof(attributes)='object'),
 status text NOT NULL DEFAULT 'held' CHECK(status IN('held','cancelled')),
 hold_reason text NOT NULL DEFAULT 'Approved template content and marketing delivery are not connected',
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(purchase_id,sequence_key,template_id)
);
DO $security$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['mhp_course_credits','mhp_credit_checkouts','mhp_purchase_contact_attributes','mhp_email_handoffs'] LOOP
  EXECUTE format('ALTER TABLE app_private.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE app_private.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY mhp_credit_owner ON app_private.%I TO r72_owner USING(true) WITH CHECK(true)',t);
  EXECUTE format('CREATE POLICY mhp_credit_definer ON app_private.%I TO r72_mhp_commerce_definer USING(true) WITH CHECK(true)',t);
  EXECUTE format('REVOKE ALL ON app_private.%I FROM PUBLIC',t);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON app_private.%I TO r72_mhp_commerce_definer',t);
 END LOOP;
END $security$;
GRANT SELECT ON app.mhp_verdict_requests TO r72_mhp_commerce_definer;
CREATE POLICY mhp_credit_verdict_read ON app.mhp_verdict_requests FOR SELECT TO r72_mhp_commerce_definer USING(true);
GRANT CREATE ON SCHEMA app_private TO r72_mhp_commerce_definer;
SET LOCAL ROLE r72_mhp_commerce_definer;

CREATE FUNCTION app_private.mhp_project_deal_desk_commerce(p_purchase uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE b app.purchases%ROWTYPE; sku text; attrs jsonb;
BEGIN
 SELECT * INTO b FROM app.purchases WHERE id=p_purchase;
 SELECT p.sku INTO sku FROM app.products p WHERE p.id=b.product_id AND p.brand='martin_howard_property';
 IF sku='mhp_deal_desk' THEN
  IF b.status='paid' THEN
   INSERT INTO app_private.mhp_course_credits(purchase_id,expires_at) VALUES(b.id,b.first_paid_at+interval '30 days') ON CONFLICT(purchase_id) DO NOTHING;
   attrs:=jsonb_build_object('DESK_BUYER',true,'DESK_PURCHASE_DATE',to_char(b.first_paid_at AT TIME ZONE 'Europe/London','YYYY-MM-DD'),
     'DESK_CREDIT_END',to_char((b.first_paid_at+interval '30 days') AT TIME ZONE 'Europe/London','FMDD FMMonth YYYY'),
     'VERDICT_FORM_SENT',EXISTS(SELECT 1 FROM app.mhp_verdict_requests WHERE purchase_id=b.id AND answers IS NOT NULL));
   INSERT INTO app_private.mhp_purchase_contact_attributes(purchase_id,buyer_email,attributes) VALUES(b.id,b.buyer_email,attrs)
   ON CONFLICT(purchase_id) DO UPDATE SET attributes=excluded.attributes,updated_at=clock_timestamp();
   INSERT INTO app_private.mhp_email_handoffs(purchase_id,sequence_key,template_id,recipient_email,due_at,attributes)
   SELECT b.id,'D4',template,b.buyer_email,b.first_paid_at+make_interval(days=>delay),attrs FROM(VALUES(27,0),(28,1),(29,4)) t(template,delay)
   ON CONFLICT(purchase_id,sequence_key,template_id) DO NOTHING;
  ELSIF b.status='refunded' THEN
   UPDATE app_private.mhp_course_credits SET revoked_at=COALESCE(revoked_at,b.refunded_at,clock_timestamp()) WHERE purchase_id=b.id;
   UPDATE app_private.mhp_email_handoffs SET status='cancelled',hold_reason='Deal Desk purchase refunded' WHERE purchase_id=b.id;
  END IF;
 END IF;
 -- A real course purchase exits D4. A manual grant is not a purchase event.
 UPDATE app_private.mhp_email_handoffs h SET status='cancelled',hold_reason='Course purchase recorded'
 WHERE h.recipient_email=b.buyer_email AND EXISTS(SELECT 1 FROM app.purchases cp JOIN app.products p ON p.id=cp.product_id
  WHERE cp.buyer_email=b.buyer_email AND p.brand='martin_howard_property' AND p.type='course' AND cp.status='paid');
END $f$;

CREATE FUNCTION app_private.mhp_credit_checkout_plan(p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT jsonb_build_object('id',a.id,'creditId',a.credit_id,'actorId',a.actor_id,'sourcePurchaseId',c.purchase_id,
  'accountId',a.stripe_account_id,'live',a.livemode,'customerId',a.stripe_customer_id,'email',a.buyer_email,
  'cataloguePriceId',a.catalogue_price_id,'productId',a.stripe_product_id,'amountPence',a.amount_pence,
  'expiresAt',a.expires_at,'sessionId',a.stripe_session_id,'url',a.checkout_url,'status',a.status)
 FROM app_private.mhp_credit_checkouts a JOIN app_private.mhp_course_credits c ON c.id=a.credit_id WHERE a.id=p_id;
$f$;

CREATE FUNCTION app_private.mhp_course_credit_snapshot(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; c app_private.mhp_course_credits%ROWTYPE; a app_private.mhp_credit_checkouts%ROWTYPE;
BEGIN
 SELECT user_id INTO actor FROM app_private.resolve_mhp_session(p_session);
 IF actor IS NULL THEN RAISE EXCEPTION 'MHP account required' USING ERRCODE='42501'; END IF;
 SELECT x.* INTO c FROM app_private.mhp_course_credits x JOIN app.purchases b ON b.id=x.purchase_id WHERE b.account_id=actor
 ORDER BY (x.revoked_at IS NULL AND x.redeemed_purchase_id IS NULL AND x.expires_at>clock_timestamp()) DESC,x.expires_at DESC LIMIT 1;
 IF NOT FOUND THEN RETURN jsonb_build_object('availablePence',0,'expiresAt',NULL,'status','unavailable','checkoutExpiresAt',NULL); END IF;
 SELECT * INTO a FROM app_private.mhp_credit_checkouts WHERE credit_id=c.id AND status IN('creating','open','complete') ORDER BY reserved_at DESC LIMIT 1;
 RETURN jsonb_build_object('availablePence',CASE WHEN c.revoked_at IS NULL AND c.redeemed_purchase_id IS NULL AND c.expires_at>clock_timestamp() AND (a.id IS NULL OR a.status<>'complete') THEN 4700 ELSE 0 END,
  'expiresAt',c.expires_at,'status',CASE WHEN c.redeemed_purchase_id IS NOT NULL OR a.status='complete' THEN 'used' WHEN c.revoked_at IS NOT NULL THEN 'unavailable'
   WHEN a.id IS NOT NULL THEN 'reserved' WHEN c.expires_at<=clock_timestamp() THEN 'expired' ELSE 'available' END,'checkoutExpiresAt',a.expires_at);
END $f$;

CREATE FUNCTION app_private.mhp_begin_course_checkout(p_session bytea,p_command uuid,p_price text,p_product text,p_expiry timestamptz) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE actor uuid; c app_private.mhp_course_credits%ROWTYPE; b app.purchases%ROWTYPE; a app_private.mhp_credit_checkouts%ROWTYPE;
BEGIN
 SELECT user_id INTO actor FROM app_private.resolve_mhp_session(p_session);
 IF actor IS NULL THEN RAISE EXCEPTION 'MHP account required' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(actor::text,120));
 SELECT * INTO a FROM app_private.mhp_credit_checkouts WHERE id=p_command;
 IF FOUND THEN
  IF a.actor_id<>actor THEN RAISE EXCEPTION 'Checkout command conflict' USING ERRCODE='42501'; END IF;
  IF EXISTS(SELECT 1 FROM app_private.mhp_course_credits x JOIN app_private.mhp_refund_requests r ON r.purchase_id=x.purchase_id WHERE x.id=a.credit_id) OR EXISTS(SELECT 1 FROM app_private.mhp_course_credits x WHERE x.id=a.credit_id AND x.revoked_at IS NOT NULL) THEN RAISE EXCEPTION 'Course credit unavailable' USING ERRCODE='22023'; END IF;
  RETURN app_private.mhp_credit_checkout_plan(a.id);
 END IF;
 SELECT x.* INTO a FROM app_private.mhp_credit_checkouts x WHERE x.actor_id=actor AND x.status IN('creating','open') ORDER BY x.reserved_at LIMIT 1;
 IF FOUND THEN
  IF EXISTS(SELECT 1 FROM app_private.mhp_course_credits x JOIN app_private.mhp_refund_requests r ON r.purchase_id=x.purchase_id WHERE x.id=a.credit_id) OR EXISTS(SELECT 1 FROM app_private.mhp_course_credits x WHERE x.id=a.credit_id AND x.revoked_at IS NOT NULL) THEN RAISE EXCEPTION 'Course credit unavailable' USING ERRCODE='22023'; END IF;
  RETURN app_private.mhp_credit_checkout_plan(a.id);
 END IF;
 SELECT x.* INTO c FROM app_private.mhp_course_credits x JOIN app.purchases p ON p.id=x.purchase_id WHERE p.account_id=actor
  AND p.status='paid' AND x.revoked_at IS NULL AND x.redeemed_purchase_id IS NULL AND x.expires_at>clock_timestamp()
  AND NOT EXISTS(SELECT 1 FROM app_private.mhp_refund_requests r WHERE r.purchase_id=p.id)
 ORDER BY x.expires_at,x.id LIMIT 1;
 IF NOT FOUND THEN RAISE EXCEPTION 'Course credit is unavailable or has expired' USING ERRCODE='22023'; END IF;
 SELECT * INTO b FROM app.purchases WHERE id=c.purchase_id FOR UPDATE;
 SELECT * INTO c FROM app_private.mhp_course_credits WHERE id=c.id FOR UPDATE;
 IF c.revoked_at IS NOT NULL OR c.redeemed_purchase_id IS NOT NULL OR c.expires_at<=clock_timestamp() OR b.status<>'paid' OR EXISTS(SELECT 1 FROM app_private.mhp_refund_requests WHERE purchase_id=b.id) THEN RAISE EXCEPTION 'Course credit unavailable' USING ERRCODE='22023'; END IF;
 IF p_command IS NULL OR p_price !~ '^price_[A-Za-z0-9_]+$' OR length(p_product) NOT BETWEEN 1 AND 200
  OR p_expiry<=clock_timestamp() OR p_expiry>clock_timestamp()+interval '31 minutes' THEN RAISE EXCEPTION 'Invalid checkout reservation' USING ERRCODE='22023'; END IF;
 INSERT INTO app_private.mhp_credit_checkouts(id,credit_id,actor_id,stripe_account_id,livemode,stripe_customer_id,buyer_email,catalogue_price_id,stripe_product_id,expires_at)
 VALUES(p_command,c.id,actor,b.stripe_account_id,b.livemode,b.stripe_customer_id,b.buyer_email,p_price,p_product,p_expiry);
 RETURN app_private.mhp_credit_checkout_plan(p_command);
END $f$;

CREATE FUNCTION app_private.mhp_record_credit_checkout(p_id uuid,p_account text,p_session text,p_url text,p_status text,p_expiry timestamptz) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE a app_private.mhp_credit_checkouts%ROWTYPE;
BEGIN
 SELECT * INTO a FROM app_private.mhp_credit_checkouts WHERE id=p_id FOR UPDATE;
 IF NOT FOUND OR p_account IS NULL OR p_session IS NULL OR p_status IS NULL OR p_expiry IS NULL OR a.stripe_account_id<>p_account OR p_session !~ '^cs_[A-Za-z0-9_]+$' OR p_status NOT IN('open','complete','expired')
  OR a.stripe_session_id IS NOT NULL AND a.stripe_session_id<>p_session OR a.expires_at<>p_expiry THEN RAISE EXCEPTION 'Checkout evidence conflict' USING ERRCODE='40001'; END IF;
 IF a.status='complete' AND p_status<>'complete' OR a.status='expired' AND p_status<>'expired' THEN RAISE EXCEPTION 'Checkout state conflict' USING ERRCODE='40001'; END IF;
 UPDATE app_private.mhp_credit_checkouts SET stripe_session_id=p_session,checkout_url=p_url,status=p_status WHERE id=a.id;
END $f$;

CREATE FUNCTION app_private.mhp_credit_evidence(p_account text,p_session text,p_attempt uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT app_private.mhp_credit_checkout_plan(a.id) FROM app_private.mhp_credit_checkouts a
 WHERE a.id=p_attempt AND a.stripe_account_id=p_account AND (a.stripe_session_id IS NULL OR a.stripe_session_id=p_session) AND a.status<>'expired';
$f$;

CREATE FUNCTION app_private.mhp_credit_refund_checkouts(p_account text,p_purchase_session text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT COALESCE(jsonb_agg(app_private.mhp_credit_checkout_plan(a.id)),'[]'::jsonb)
 FROM app_private.mhp_credit_checkouts a JOIN app_private.mhp_course_credits c ON c.id=a.credit_id JOIN app.purchases b ON b.id=c.purchase_id
 WHERE b.stripe_account_id=p_account AND b.stripe_session_id=p_purchase_session AND a.status IN('creating','open');
$f$;

CREATE FUNCTION app_private.mhp_verdict_handoff_flag() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 IF NEW.purchase_id IS NOT NULL AND NEW.answers IS NOT NULL THEN
  UPDATE app_private.mhp_purchase_contact_attributes SET attributes=jsonb_set(attributes,'{VERDICT_FORM_SENT}','true'::jsonb),updated_at=clock_timestamp() WHERE purchase_id=NEW.purchase_id;
  UPDATE app_private.mhp_email_handoffs SET attributes=jsonb_set(attributes,'{VERDICT_FORM_SENT}','true'::jsonb) WHERE purchase_id=NEW.purchase_id;
 END IF;
 RETURN NEW;
END $f$;

REVOKE ALL ON FUNCTION app_private.mhp_project_deal_desk_commerce(uuid),app_private.mhp_credit_checkout_plan(uuid),app_private.mhp_course_credit_snapshot(bytea),app_private.mhp_begin_course_checkout(bytea,uuid,text,text,timestamptz),app_private.mhp_record_credit_checkout(uuid,text,text,text,text,timestamptz),app_private.mhp_credit_evidence(text,text,uuid),app_private.mhp_credit_refund_checkouts(text,text),app_private.mhp_verdict_handoff_flag() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.mhp_course_credit_snapshot(bytea) TO r72_web;
GRANT EXECUTE ON FUNCTION app_private.mhp_begin_course_checkout(bytea,uuid,text,text,timestamptz),app_private.mhp_record_credit_checkout(uuid,text,text,text,text,timestamptz),app_private.mhp_credit_refund_checkouts(text,text) TO r72_identity_command;
GRANT EXECUTE ON FUNCTION app_private.mhp_credit_evidence(text,text,uuid),app_private.mhp_credit_refund_checkouts(text,text),app_private.mhp_record_credit_checkout(uuid,text,text,text,text,timestamptz) TO r72_webhook;
RESET ROLE;
SET LOCAL ROLE r72_owner;
CREATE TRIGGER mhp_verdict_handoff_flag AFTER INSERT OR UPDATE OF answers ON app.mhp_verdict_requests FOR EACH ROW EXECUTE FUNCTION app_private.mhp_verdict_handoff_flag();
REVOKE CREATE ON SCHEMA app_private FROM r72_mhp_commerce_definer;
RESET ROLE;

SET LOCAL ROLE r72_owner;
GRANT CREATE ON SCHEMA app_private TO r72_mhp_commerce_definer;
SET LOCAL ROLE r72_mhp_commerce_definer;
CREATE OR REPLACE FUNCTION app_private.record_mhp_commerce_event(p_account text,p_event text,p_type text,p_hash bytea,p_snapshot jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE old app_private.mhp_stripe_events%ROWTYPE; b app.purchases%ROWTYPE; p app.products%ROWTYPE; x jsonb; total integer; refunded integer; expected integer; a app_private.mhp_credit_checkouts%ROWTYPE;
BEGIN
 IF p_account !~ '^acct_[A-Za-z0-9]+$' OR p_event !~ '^evt_[A-Za-z0-9]+$' OR octet_length(p_hash)<>32
 OR p_type NOT IN('checkout.session.completed','invoice.paid','invoice.payment_failed','customer.subscription.updated','customer.subscription.deleted','charge.refunded')
 OR jsonb_typeof(p_snapshot->'payments')<>'array' OR jsonb_array_length(p_snapshot->'payments')=0 THEN RAISE EXCEPTION 'Invalid MHP receipt' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_account||':'||(p_snapshot->>'sessionId'),114));
 SELECT * INTO old FROM app_private.mhp_stripe_events WHERE stripe_account_id=p_account AND event_id=p_event;
 IF FOUND THEN
  IF old.payload_sha256<>p_hash OR old.event_type<>p_type THEN RAISE EXCEPTION 'Provider event conflict' USING ERRCODE='40001'; END IF;
  PERFORM app_private.mhp_project_deal_desk_commerce(old.purchase_id);
  RETURN old.purchase_id;
 END IF;
 SELECT * INTO p FROM app.products WHERE sku=p_snapshot->>'sku' AND brand='martin_howard_property' AND active;
 IF NOT FOUND THEN RAISE EXCEPTION 'Unknown product' USING ERRCODE='22023'; END IF;
 expected:=p.price_pence;
 IF p_snapshot->>'creditAttemptId' IS NOT NULL THEN
  SELECT * INTO a FROM app_private.mhp_credit_checkouts WHERE id=(p_snapshot->>'creditAttemptId')::uuid FOR UPDATE;
  IF NOT FOUND OR p.sku<>'mhp_course' OR a.status='expired' OR a.stripe_account_id<>p_account
   OR a.stripe_customer_id<>p_snapshot->>'customerId' OR a.buyer_email<>lower(p_snapshot->>'email') OR a.livemode<>(p_snapshot->>'live')::boolean
   OR a.stripe_session_id IS NOT NULL AND a.stripe_session_id<>p_snapshot->>'sessionId'
   OR (p_snapshot->>'firstPaidAt')::timestamptz>a.expires_at
   OR (p_snapshot->>'firstPaidAt')::timestamptz<a.reserved_at-interval '5 seconds'
   OR p_snapshot->>'subscriptionId' IS NOT NULL OR jsonb_array_length(p_snapshot->'payments')<>1 THEN
   RAISE EXCEPTION 'Course credit evidence mismatch' USING ERRCODE='22023'; END IF;
  expected:=a.amount_pence;
 END IF;
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
  IF (x->>'amount')::integer<>expected OR (x->>'refunded')::integer NOT BETWEEN 0 AND expected THEN RAISE EXCEPTION 'Payment amount mismatch' USING ERRCODE='22023'; END IF;
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
 IF a.id IS NOT NULL THEN
  IF b.account_id IS NOT NULL AND b.account_id<>a.actor_id THEN RAISE EXCEPTION 'Credit account binding conflict' USING ERRCODE='40001'; END IF;
  UPDATE app.purchases SET account_id=a.actor_id WHERE id=b.id;
  UPDATE app_private.mhp_course_credits SET redeemed_purchase_id=b.id WHERE id=a.credit_id AND (redeemed_purchase_id IS NULL OR redeemed_purchase_id=b.id);
  IF NOT FOUND THEN RAISE EXCEPTION 'Course credit already redeemed' USING ERRCODE='40001'; END IF;
  UPDATE app_private.mhp_credit_checkouts SET stripe_session_id=b.stripe_session_id,status='complete',checkout_url=NULL WHERE id=a.id;
 END IF;
 PERFORM app_private.mhp_refresh_entitlement(b.id);
 PERFORM app_private.mhp_project_deal_desk_commerce(b.id);
 INSERT INTO app_private.mhp_stripe_events(stripe_account_id,event_id,event_type,payload_sha256,purchase_id) VALUES(p_account,p_event,p_type,p_hash,b.id);
 RETURN b.id;
END $f$;


RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_mhp_commerce_definer;
RESET ROLE;

SET LOCAL ROLE r72_owner;
GRANT CREATE ON SCHEMA app_private TO r72_mhp_commerce_definer;
SET LOCAL ROLE r72_mhp_commerce_definer;
CREATE FUNCTION app_private.mhp_abandon_credit_checkout(p_attempt uuid,p_account text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 UPDATE app_private.mhp_credit_checkouts SET status='expired' WHERE id=p_attempt AND stripe_account_id=p_account AND status='creating' AND stripe_session_id IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'Checkout has provider evidence; cannot abandon' USING ERRCODE='40001'; END IF;
END $f$;
REVOKE ALL ON FUNCTION app_private.mhp_abandon_credit_checkout(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.mhp_abandon_credit_checkout(uuid,text) TO r72_identity_command,r72_webhook;
RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_mhp_commerce_definer;
RESET ROLE;

SET LOCAL ROLE r72_owner;
GRANT CREATE ON SCHEMA app_private TO r72_mhp_commerce_definer;
SET LOCAL ROLE r72_mhp_commerce_definer;
CREATE FUNCTION app_private.mhp_freeze_course_credit(p_account text,p_session text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE purchase uuid;
BEGIN
 SELECT b.id INTO purchase FROM app.purchases b JOIN app.products p ON p.id=b.product_id
 WHERE b.stripe_account_id=p_account AND b.stripe_session_id=p_session AND p.sku='mhp_deal_desk' FOR UPDATE OF b;
 IF purchase IS NOT NULL THEN UPDATE app_private.mhp_course_credits SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE purchase_id=purchase; END IF;
END $f$;
REVOKE ALL ON FUNCTION app_private.mhp_freeze_course_credit(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.mhp_freeze_course_credit(text,text) TO r72_webhook;
RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_mhp_commerce_definer;
RESET ROLE;
