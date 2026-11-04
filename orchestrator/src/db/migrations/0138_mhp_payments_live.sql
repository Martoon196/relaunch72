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
  AND p.price_pence=v.amount AND p.instalments IS NOT DISTINCT FROM v.payments;
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
   VALUES(e,u.id,p.id,p.grants,stamp,'manual','mhp-owner-seed-0138');
   INSERT INTO app_private.mhp_manual_grants(entitlement_id,command_id,account_id,product_id,target_email,target_name,starts_at,note,grant_kind,request_payload)
   VALUES(e,gen_random_uuid(),u.id,p.id,lower(u.email),u.name,stamp,'Founder-authorised permanent owner access: MHP payments go-live','owner_seed',jsonb_build_object('migration','0138','owner',lower(u.email),'product',p.id));
  END LOOP;
 END LOOP;
END $seed$;
RESET ROLE;
