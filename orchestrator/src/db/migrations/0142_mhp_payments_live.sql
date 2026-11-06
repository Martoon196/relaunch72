-- MHP-PAYMENTS-LIVE-20261104: founder-approved go-live catalogue. No Stripe effects.
-- Opens the webinar course price and founding mentoring for their server-enforced
-- journeys (window cut-over and founding eligibility are enforced in the app),
-- adds One Lane Private (in full, or 12 monthly payments) and sets public names.
-- Additive: no purchase, entitlement or payment row is changed.
SET LOCAL ROLE r72_owner;

DO $instalments$
DECLARE c text;
BEGIN
 SELECT conname INTO c FROM pg_constraint
 WHERE conrelid='app.products'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%instalments = ANY (ARRAY[3, 6])%';
 IF c IS NULL THEN RAISE EXCEPTION 'MHP instalment constraint not found'; END IF;
 EXECUTE format('ALTER TABLE app.products DROP CONSTRAINT %I', c);
END $instalments$;
ALTER TABLE app.products ADD CONSTRAINT products_instalments_check CHECK(instalments IN(3,6,12));

DO $catalogue$
DECLARE n integer;
BEGIN
 UPDATE app.products p SET name=v.name, active=true
 FROM (VALUES
  ('mhp_course','Property Done Properly',149700,NULL::integer),
  ('mhp_course_3x','Property Done Properly, 3 monthly payments',52500,3),
  ('mhp_course_web','Property Done Properly, webinar price',99700,NULL),
  ('mhp_course_web_3x','Property Done Properly, webinar price, 3 monthly payments',34900,3),
  ('mhp_mentoring','One Lane Mentoring',399700,NULL),
  ('mhp_mentoring_6x','One Lane Mentoring, 6 monthly payments',69900,6),
  ('mhp_mentoring_early','One Lane Mentoring, founding price',299700,NULL),
  ('mhp_mentoring_early_6x','One Lane Mentoring, founding price, 6 monthly payments',52500,6)
 ) AS v(sku,name,amount,payments)
 WHERE p.sku=v.sku AND p.brand='martin_howard_property' AND p.organization_id='ba41b1a4-9752-4dbf-8312-d04a0f03d0b8'
  AND p.refund_days=30 AND p.price_pence=v.amount AND p.instalments IS NOT DISTINCT FROM v.payments;
 GET DIAGNOSTICS n = ROW_COUNT;
 IF n<>8 THEN RAISE EXCEPTION 'MHP catalogue prices differ from the approved go-live catalogue'; END IF;

 INSERT INTO app.products(organization_id,brand,sku,name,type,price_pence,refund_days,recurring_interval,instalments,grants,active)
 SELECT m.organization_id,m.brand,v.sku,v.name,'cohort',v.amount,0,v.recurrence,v.payments,m.grants,true
 FROM app.products m,(VALUES
  ('mhp_private','One Lane Private',2500000,NULL::text,NULL::integer),
  ('mhp_private_12x','One Lane Private, 12 monthly payments',225000,'month',12)
 ) AS v(sku,name,amount,recurrence,payments)
 WHERE m.sku='mhp_mentoring' AND m.brand='martin_howard_property' AND m.organization_id='ba41b1a4-9752-4dbf-8312-d04a0f03d0b8'
 ON CONFLICT(sku) DO NOTHING;
 SELECT count(*) INTO n FROM app.products
 WHERE brand='martin_howard_property' AND active AND type='cohort' AND refund_days=0
  AND ((sku='mhp_private' AND price_pence=2500000 AND recurring_interval IS NULL AND instalments IS NULL)
   OR (sku='mhp_private_12x' AND price_pence=225000 AND recurring_interval='month' AND instalments=12));
 IF n<>2 THEN RAISE EXCEPTION 'One Lane Private products do not match the approved terms'; END IF;
END $catalogue$;

-- Permanent no-checkout owner entitlements for the two new products, as 0118 did for v3.
DO $seed$
DECLARE u record;p record;e uuid;stamp timestamptz:=clock_timestamp();
BEGIN
 FOR u IN SELECT id,email::text AS email,COALESCE(display_name,email::text) AS name FROM app.users
 WHERE lower(email::text) IN('martin.howard1984@gmail.com','office@propertypredator.com') LOOP
  FOR p IN SELECT * FROM app.products WHERE organization_id='ba41b1a4-9752-4dbf-8312-d04a0f03d0b8' AND brand='martin_howard_property' AND sku IN('mhp_private','mhp_private_12x') LOOP
   IF EXISTS(SELECT 1 FROM app_private.mhp_manual_grants WHERE account_id=u.id AND product_id=p.id AND grant_kind='owner_seed') THEN CONTINUE; END IF;
   e:=gen_random_uuid();
   INSERT INTO app.entitlements(id,account_id,product_id,grants,starts_at,source,source_reference)
   VALUES(e,u.id,p.id,p.grants,stamp,'manual','mhp-owner-seed-0142');
   INSERT INTO app_private.mhp_manual_grants(entitlement_id,command_id,account_id,product_id,target_email,target_name,starts_at,note,grant_kind,request_payload)
   VALUES(e,gen_random_uuid(),u.id,p.id,lower(u.email),u.name,stamp,'Founder-authorised permanent owner access: MHP payments go-live','owner_seed',jsonb_build_object('migration','0142','owner',lower(u.email),'product',p.id));
  END LOOP;
 END LOOP;
END $seed$;

-- One transactional welcome per purchase, created atomically with the first
-- qualifying receipt. No marketing consent, historical backfill or provider IO.
CREATE TABLE app_private.mhp_purchase_welcomes (
 purchase_id uuid PRIMARY KEY REFERENCES app.purchases(id),
 state text NOT NULL DEFAULT 'queued' CHECK(state IN('queued','leased','calling','sent','unknown','cancelled','failed')),
 lease_id uuid, lease_until timestamptz, attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
 available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), settled_at timestamptz,
 CHECK((state IN('leased','calling'))=(lease_id IS NOT NULL AND lease_until IS NOT NULL))
);
ALTER TABLE app_private.mhp_purchase_welcomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.mhp_purchase_welcomes FORCE ROW LEVEL SECURITY;
CREATE POLICY mhp_welcome_owner ON app_private.mhp_purchase_welcomes TO r72_owner USING(true) WITH CHECK(true);
CREATE POLICY mhp_welcome_definer ON app_private.mhp_purchase_welcomes TO r72_mhp_commerce_definer USING(true) WITH CHECK(true);
REVOKE ALL ON app_private.mhp_purchase_welcomes FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON app_private.mhp_purchase_welcomes TO r72_mhp_commerce_definer;
GRANT CREATE ON SCHEMA app_private TO r72_mhp_commerce_definer;
SET LOCAL ROLE r72_mhp_commerce_definer;

CREATE FUNCTION app_private.mhp_queue_purchase_welcome() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 IF NEW.event_type IN('checkout.session.completed','invoice.paid') THEN
  INSERT INTO app_private.mhp_purchase_welcomes(purchase_id)
  SELECT b.id FROM app.purchases b JOIN app.products p ON p.id=b.product_id
  WHERE b.id=NEW.purchase_id AND b.status='paid' AND p.brand='martin_howard_property'
   AND p.type IN('course','cohort')
  ON CONFLICT(purchase_id) DO NOTHING;
 END IF;
 RETURN NEW;
END $f$;
REVOKE ALL ON FUNCTION app_private.mhp_queue_purchase_welcome() FROM PUBLIC;
RESET ROLE;
SET LOCAL ROLE r72_owner;
CREATE TRIGGER mhp_purchase_welcome_receipt AFTER INSERT ON app_private.mhp_stripe_events
 FOR EACH ROW EXECUTE FUNCTION app_private.mhp_queue_purchase_welcome();
SET LOCAL ROLE r72_mhp_commerce_definer;

CREATE FUNCTION app_private.mhp_claim_purchase_welcome(p_account text,p_live boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE claimed app_private.mhp_purchase_welcomes%ROWTYPE; purchase app.purchases%ROWTYPE; product app.products%ROWTYPE;
BEGIN
 IF p_account IS NULL OR p_account !~ '^acct_[A-Za-z0-9]+$' OR p_live IS NULL THEN RAISE EXCEPTION 'Invalid MHP sender'; END IF;
 -- A crash after begin cannot be retried automatically: Postmark might have sent it.
 UPDATE app_private.mhp_purchase_welcomes w SET state='unknown',lease_id=NULL,lease_until=NULL,settled_at=clock_timestamp()
 FROM app.purchases b WHERE b.id=w.purchase_id AND b.stripe_account_id=p_account AND b.livemode=p_live
  AND w.state='calling' AND w.lease_until<clock_timestamp();
 UPDATE app_private.mhp_purchase_welcomes w SET state='queued',lease_id=NULL,lease_until=NULL
 FROM app.purchases b WHERE b.id=w.purchase_id AND b.stripe_account_id=p_account AND b.livemode=p_live
  AND w.state='leased' AND w.lease_until<clock_timestamp();
 UPDATE app_private.mhp_purchase_welcomes w SET state='cancelled',lease_id=NULL,lease_until=NULL,settled_at=clock_timestamp()
 FROM app.purchases b WHERE b.id=w.purchase_id AND b.stripe_account_id=p_account AND b.livemode=p_live
  AND w.state IN('queued','leased') AND b.status<>'paid';
 SELECT w0.* INTO claimed FROM app_private.mhp_purchase_welcomes w0 JOIN app.purchases b0 ON b0.id=w0.purchase_id
 WHERE b0.stripe_account_id=p_account AND b0.livemode=p_live AND b0.status='paid'
  AND w0.state='queued' AND w0.attempts<5 AND w0.available_at<=clock_timestamp()
 ORDER BY w0.created_at,w0.purchase_id LIMIT 1 FOR UPDATE OF w0 SKIP LOCKED;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT * INTO STRICT purchase FROM app.purchases WHERE id=claimed.purchase_id;
 SELECT * INTO STRICT product FROM app.products WHERE id=purchase.product_id;
 UPDATE app_private.mhp_purchase_welcomes SET state='leased',lease_id=gen_random_uuid(),lease_until=clock_timestamp()+interval '2 minutes'
 WHERE purchase_id=claimed.purchase_id RETURNING * INTO claimed;
 RETURN jsonb_build_object('id',claimed.purchase_id,'lease',claimed.lease_id,'email',purchase.buyer_email,
  'name',split_part(purchase.buyer_email,'@',1),'productName',product.name,'kind',CASE WHEN product.type='course' THEN 'course' ELSE 'mentoring' END);
END $f$;

CREATE FUNCTION app_private.mhp_begin_purchase_welcome(p_id uuid,p_lease uuid,p_account text,p_live boolean) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE b app.purchases%ROWTYPE;
BEGIN
 SELECT * INTO b FROM app.purchases WHERE id=p_id AND stripe_account_id=p_account AND livemode=p_live FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 IF b.status<>'paid' THEN
  UPDATE app_private.mhp_purchase_welcomes SET state='cancelled',lease_id=NULL,lease_until=NULL,settled_at=clock_timestamp()
  WHERE purchase_id=p_id AND lease_id=p_lease AND state='leased';
  RETURN false;
 END IF;
 UPDATE app_private.mhp_purchase_welcomes SET state='calling',attempts=attempts+1,lease_until=clock_timestamp()+interval '2 minutes'
 WHERE purchase_id=p_id AND lease_id=p_lease AND state='leased' AND lease_until>clock_timestamp() AND attempts<5;
 RETURN FOUND;
END $f$;

CREATE FUNCTION app_private.mhp_settle_purchase_welcome(p_id uuid,p_lease uuid,p_account text,p_live boolean,p_result text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 IF p_result IS NULL OR p_result NOT IN('sent','rejected','unknown') THEN RAISE EXCEPTION 'Invalid MHP welcome outcome'; END IF;
 UPDATE app_private.mhp_purchase_welcomes w SET state=CASE WHEN p_result='rejected' THEN CASE WHEN attempts<5 THEN 'queued' ELSE 'failed' END ELSE p_result END,
  lease_id=NULL,lease_until=NULL,available_at=clock_timestamp()+interval '5 minutes',settled_at=clock_timestamp()
 FROM app.purchases b WHERE b.id=w.purchase_id AND b.id=p_id AND b.stripe_account_id=p_account AND b.livemode=p_live
  AND w.lease_id=p_lease AND w.state='calling';
 IF NOT FOUND THEN RAISE EXCEPTION 'MHP welcome lease changed' USING ERRCODE='40001'; END IF;
END $f$;
REVOKE ALL ON FUNCTION app_private.mhp_claim_purchase_welcome(text,boolean),
 app_private.mhp_begin_purchase_welcome(uuid,uuid,text,boolean),app_private.mhp_settle_purchase_welcome(uuid,uuid,text,boolean,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.mhp_claim_purchase_welcome(text,boolean),
 app_private.mhp_begin_purchase_welcome(uuid,uuid,text,boolean),app_private.mhp_settle_purchase_welcome(uuid,uuid,text,boolean,text) TO r72_webhook;
RESET ROLE;
SET LOCAL ROLE r72_owner;
REVOKE CREATE ON SCHEMA app_private FROM r72_mhp_commerce_definer;
RESET ROLE;
